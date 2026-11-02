// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { root, extensionId } from './platform.mjs';
import { startFixtures } from './fixtures.mjs';

const browserName = process.argv.includes('--chrome') ? 'Chrome' : 'Edge';
const executable = process.env.WEBMCP_TEST_BROWSER ?? (browserName === 'Chrome'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
if (!existsSync(executable)) throw new Error('Set WEBMCP_TEST_BROWSER to an installed browser executable.');
const directory = await mkdtemp(join(tmpdir(), 'webmcp-agent-browser-'));
const profile = join(directory, 'profile');
await mkdir(profile);
// Persist the same testing-flag preference that the user enables at about:flags.
await writeFile(join(profile, 'Local State'), JSON.stringify({ browser: { enabled_labs_experiments: ['enable-webmcp-testing@1'] } }));
const fixtures = await startFixtures();
const extensionPath = join(root, 'extension', 'dist');
let browser;
let socket;
const pending = new Map();
let sequence = 0;
const diagnostics = [];
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function evaluate(sessionId, expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(operation, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out: ${label}. ${diagnostics.slice(-6).join('\n')}`);
}
async function createPage(url, initialScript) {
  const { targetId } = await send('Target.createTarget', { url: initialScript ? 'about:blank' : url });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  if (initialScript) {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: initialScript }, sessionId);
    await send('Page.navigate', { url }, sessionId);
  }
  try {
    await waitFor(() => evaluate(sessionId, `document.readyState === 'complete' && location.href === ${JSON.stringify(url)}`), `page load ${url}`);
  } catch (error) {
    console.error('Page diagnostic:', await evaluate(sessionId, 'JSON.stringify({url:location.href,title:document.title,text:document.body?.innerText.slice(0,1000)})'));
    throw error;
  }
  return { targetId, sessionId };
}
try {
  browser = spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`, ...(browserName === 'Edge' ? [`--load-extension=${extensionPath}`, `--disable-extensions-except=${extensionPath}`] : []),
    '--enable-blink-features=WebMCP,WebMCPTesting', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, WEBMCP_AGENT_DATA_DIR: join(directory, 'agent-data') } });
  browser.stderr.on('data', chunk => diagnostics.push(chunk.toString().slice(-1000)));
  const portFile = join(profile, 'DevToolsActivePort');
  const [port, websocketPath] = await waitFor(async () => {
    try {
      const lines = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
      return /^\d+$/.test(lines[0]) && lines[1]?.startsWith('/devtools/browser/') ? lines : undefined;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EBUSY') return undefined;
      throw error;
    }
  }, 'browser debugger startup');
  socket = new WebSocket(`ws://127.0.0.1:${port}${websocketPath}`);
  await once(socket, 'open');
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) {
      if (message.method === 'Runtime.exceptionThrown') diagnostics.push(JSON.stringify(message.params.exceptionDetails));
      return;
    }
    pending.delete(message.id);
    clearTimeout(request.timeout);
    message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
  });
  const version = await send('Browser.getVersion');
  console.log(`${browserName}: ${version.product}`);
  // Official Chrome builds may ignore --load-extension; the debugging API is
  // explicitly restricted to this isolated profile and unpacked directory.
  let targets = await send('Target.getTargets');
  if (browserName === 'Chrome' || !targets.targetInfos.some(target => target.url.startsWith(`chrome-extension://${extensionId}/`))) {
    console.log('Debug extension load:', await send('Extensions.loadUnpacked', { path: extensionPath, enableInIncognito: false }));
    if (browserName === 'Chrome') {
      const debug = await createPage('chrome://extensions/');
      console.log('Extension state:', await evaluate(debug.sessionId, `(async () => {
        const extensions = await chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true});
        const item = extensions.find(item => item.id === ${JSON.stringify(extensionId)});
        return item ? {state:item.state,disableReasons:item.disableReasons,manifestErrors:item.manifestErrors,installWarnings:item.installWarnings} : extensions.map(item => ({id:item.id,state:item.state}));
      })()`));
      await send('Target.closeTarget', { targetId: debug.targetId });
    }
  }
  const fixture = await createPage(`${fixtures.origins[0]}/hints.html`);
  assert(await evaluate(fixture.sessionId, '!!document.modelContext'), 'Current document.modelContext is unavailable');
  const panel = await createPage(`chrome-extension://${extensionId}/sidepanel.html`, `
    globalThis.testMessages=[];
    const connect=chrome.runtime.connect.bind(chrome.runtime);
    chrome.runtime.connect=(...args)=>{
      const port=connect(...args);
      if(args[0]?.name?.startsWith('panel:')){
        globalThis.testPort=port;
        port.onMessage.addListener(message=>testMessages.push(message));
      }
      return port;
    };
  `);
  await waitFor(() => evaluate(panel.sessionId, "document.querySelector('.app-header') !== null && !!globalThis.testPort"), 'React panel connection');
  await evaluate(panel.sessionId, `(async () => {
    const fixture = (await chrome.tabs.query({})).find(tab => tab.url === ${JSON.stringify(fixtures.origins[0] + '/hints.html')});
    await chrome.tabs.update(fixture.id, {active:true});
    globalThis.fixtureTabId = fixture.id;
  })()`);
  const get = expression => evaluate(panel.sessionId, expression);
  await waitFor(() => get("testMessages.some(message => message.type === 'ready' && message.signedIn)"), 'native host handshake', 60000);
  await waitFor(() => get("testMessages.some(message => message.type === 'chat_opened')"), 'chat session');
  let page = await waitFor(() => get("testMessages.filter(message => message.type === 'page' && message.tools.length === 5).at(-1)"), 'five fixture tools');
  assert.equal(page.tools.filter(tool => tool.annotations.debugging).length, 1);
  console.log('PASS: content discovery, annotations, native handshake, SDK chat open.');
  if (process.argv.includes('--history')) {
    async function waitForOpened(expectedId) {
      await waitFor(() => get(`testMessages.some(message=>message.type==='history' && message.done${expectedId ? ` && message.chatId===${JSON.stringify(expectedId)}` : ''}) ||
        testMessages.some(message=>message.type==='error')`), 'SDK history switch', 60000);
      const error = await get("testMessages.find(message=>message.type==='error')");
      assert(!error, JSON.stringify(error));
      const opened = await get("testMessages.find(message=>message.type==='chat_opened')");
      assert(opened && (!expectedId || opened.chatId === expectedId), 'Wrong chat opened');
      await waitFor(() => get("!document.querySelector('.composer textarea').disabled"), 'composer re-enabled');
      return opened.chatId;
    }
    async function newChat() {
      await waitFor(() => get("!document.querySelector('button[aria-label=\"New chat\"]').disabled"), 'New chat ready');
      await get("testMessages.length=0; document.querySelector('button[aria-label=\"New chat\"]').click()");
      const id = await waitForOpened();
      await waitFor(() => get(`testMessages.some(message=>message.type==='chats' && message.chats.some(chat=>chat.chatId===${JSON.stringify(id)}))`), 'automatic Saved chats refresh');
      return id;
    }
    async function resumeChat(id) {
      await get("document.querySelector('nav [aria-label=\"History\"]').click()");
      await waitFor(() => get(`testMessages.some(message=>message.type==='chats' && message.chats.some(chat=>chat.chatId===${JSON.stringify(id)})) &&
        document.querySelectorAll('.history').length === testMessages.filter(message=>message.type==='chats').at(-1).chats.length`), 'rendered SDK history list');
      await get(`(() => {
        const index=testMessages.filter(message=>message.type==='chats').at(-1).chats.findIndex(chat=>chat.chatId===${JSON.stringify(id)});
        const button=document.querySelectorAll('.history')[index].querySelector('button');
        if(button.disabled)throw new Error('History selection is unexpectedly disabled');
        testMessages.length=0;
        button.click();
      })()`);
      return waitForOpened(id);
    }
    const first = await get("testMessages.find(message=>message.type==='chat_opened').chatId");
    const second = await newChat();
    assert.notEqual(first, second);
    await resumeChat(second);
    await resumeChat(first);
    await resumeChat(second);
    const third = await newChat();
    await resumeChat(third);
    await resumeChat(first);
    await resumeChat(third);
    console.log('PASS: New chat, current-history selection, and repeated SDK close/resume switches keep the panel usable.');
  }
  if (process.argv.includes('--restricted-page')) {
    const url = browserName === 'Edge' ? 'edge://extensions/' : 'chrome://extensions/';
    console.log('Browser URL origin behavior:', await get(`JSON.stringify({
      internal:new URL(${JSON.stringify(url)}).origin,
      extension:new URL(chrome.runtime.getURL('sidepanel.html')).origin
    })`));
    const restricted = await createPage(url);
    await get(`(async () => {
      const tab=(await chrome.tabs.query({})).find(tab=>tab.url===${JSON.stringify(url)});
      await chrome.tabs.update(tab.id,{active:true});
      testMessages.length=0;
      testPort.postMessage({type:'new_chat'});
    })()`);
    await waitFor(() => get("testMessages.some(message=>message.type==='history' && message.done) || document.body.innerText.includes('Invalid message received')"), 'restricted-page chat');
    assert(!await get("document.body.innerText.includes('Invalid message received')"), 'Restricted page caused the panel protocol error');
    assert(await get("testMessages.some(message=>message.type==='history' && message.done)"), 'Chat did not open without page tools');
    await send('Target.closeTarget', { targetId: restricted.targetId });
    await get("chrome.tabs.update(fixtureTabId,{active:true})");
    await waitFor(() => get("testMessages.some(message=>message.type==='page' && message.tools.length===5)"), 'restored fixture');
    console.log('PASS: restricted browser page opens a chat without page tools or protocol errors.');
  }
  await get(`testPort.postMessage({type:'inspect_run',key:'0:search',args:{}})`);
  const manual = await waitFor(() => get("testMessages.find(message => message.type === 'inspect_result')"), 'manual tool run');
  assert(manual.ok && manual.result.includes('FIXTURE-42'));
  console.log('PASS: inspector runs a genuine browser tool and returns the raw result.');
  // Exercise actual React inspector rendering, not only the messaging harness.
  await get("document.querySelector('nav [aria-label=\"Tools\"]').click()");
  await waitFor(() => get("document.body.innerText.includes('Hidden from agent') && document.body.innerText.includes('debug_state')"), 'debug tool visibility');
  await send('Page.navigate', { url: `${fixtures.origins[0]}/iframes.html` }, fixture.sessionId);
  page = await waitFor(() => get("testMessages.filter(message => message.type === 'page' && message.tools.length === 2 && message.page.url.endsWith('/iframes.html')).at(-1)"), 'iframe tools');
  assert.equal(new Set(page.tools.map(tool => tool.origin)).size, 2);
  for (const tool of page.tools) {
    await get('testMessages.length = 0');
    await get(`testPort.postMessage({type:'inspect_run',key:${JSON.stringify(tool.key)},args:{}})`);
    const result = await waitFor(() => get(`testMessages.filter(message => message.type === 'inspect_result' && message.key === ${JSON.stringify(tool.key)}).at(-1)`), 'iframe execution');
    assert(result.ok && result.result.includes(tool.isTopFrame ? '"top"' : '"embedded"'), JSON.stringify(result));
  }
  console.log('PASS: same-named tools from two origins execute in their owning frames.');
  await send('Page.navigate', { url: `${fixtures.origins[0]}/dynamic.html` }, fixture.sessionId);
  await waitFor(() => get("testMessages.some(message => message.type === 'page' && message.page.url.endsWith('/dynamic.html') && message.tools.length === 1)"), 'dynamic base tool');
  await evaluate(fixture.sessionId, "document.getElementById('toggle').click()");
  await waitFor(() => get("testMessages.some(message => message.type === 'page' && message.page.url.endsWith('/dynamic.html') && message.tools.length === 2)"), 'toolchange add');
  await get('testMessages.length = 0');
  await evaluate(fixture.sessionId, "document.getElementById('toggle').click()");
  await waitFor(() => get("testMessages.some(message => message.type === 'page' && message.page.url.endsWith('/dynamic.html') && message.tools.length === 1)"), 'toolchange removal');
  console.log('PASS: dynamic tool snapshots update on registration and removal.');

  if (process.argv.includes('--composer') || process.argv.includes('--markdown')) {
    // Test rendering with SDK-shaped events without spending model quota or
    // modifying production SDK sessions. Only this preview document's port is mocked.
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      globalThis.previewRequests=[];
      const listeners=[];
      globalThis.previewDeliver=message=>listeners.forEach(listener=>listener(message));
      chrome.runtime.connect=()=>({
        postMessage:message=>previewRequests.push(message),
        onMessage:{addListener:listener=>{listeners.push(listener);globalThis.previewConnected=true;}},
        onDisconnect:{addListener:()=>{}},
        disconnect:()=>{}
      });
    ` }, sessionId);
    await send('Page.navigate', { url: `chrome-extension://${extensionId}/sidepanel.html` }, sessionId);
    const preview = expression => evaluate(sessionId, expression);
    await waitFor(() => preview("document.querySelector('.app-header') && globalThis.previewConnected"), 'composer preview');
    await preview(`(() => {
      previewDeliver({type:'connection',status:'Connected'});
      previewDeliver({type:'models',models:[{id:'auto',name:'Auto'},{id:'sdk-model',name:'SDK model with a deliberately long display name',multiplier:2}]});
      previewDeliver({type:'chat_opened',chatId:'webmcp-agent-preview',title:'WebMCP Agent'});
      previewDeliver({type:'page',page:{tabId:1,url:'https://fixture.example/',title:'WebMCP fixture',origin:'https://fixture.example'},tools:[],available:true});
      previewDeliver({type:'history',chatId:'webmcp-agent-preview',items:[],done:true});
      previewDeliver({type:'chat_loading',loading:false});
    })()`);
    await waitFor(() => preview("document.querySelector('.composer .model-chip select') && !document.querySelector('.composer textarea').disabled"), 'initial model chip');
    assert(!await preview("!!document.querySelector('.app-header select')"));
    assert(await preview("document.querySelector('button[aria-label=\"New chat\"]').title==='New chat'"));
    await preview(`(() => {
      const select=document.querySelector('.composer select');
      select.value='sdk-model';select.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await waitFor(() => preview("previewRequests.some(message=>message.type==='set_model' && message.model==='sdk-model')"), 'unchanged SDK model identity');
    await preview("previewDeliver({type:'notice',text:'Synthetic notice'})");
    assert(await preview("!!document.querySelector('.composer .model-chip')"), 'Notices must not count as conversation history');
    await preview(`(() => {
      const input=document.querySelector('.composer textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Synthetic first message');
      input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await waitFor(() => preview("!document.querySelector('.composer button[type=submit]').disabled"), 'Fluent composer input');
    await preview("document.querySelector('.composer button[type=submit]').click()");
    assert(await preview("previewRequests.some(message=>message.type==='send' && message.text==='Synthetic first message')"), 'Composer must forward the user message without a second agent loop');
    await preview("previewDeliver({type:'user',text:'Synthetic first message'});previewDeliver({type:'status',chatId:'webmcp-agent-preview',state:'running'})");
    await waitFor(() => preview("!document.querySelector('.composer .model-chip')"), 'model chip hidden after first message');
    await preview("[...document.querySelectorAll('.composer button')].find(button=>button.textContent==='Stop').click()");
    assert(await preview("previewRequests.some(message=>message.type==='stop')"));
    await preview("previewDeliver({type:'status',chatId:'webmcp-agent-preview',state:'idle'});[...document.querySelectorAll('.header-actions button')].find(button=>button.textContent==='Settings').click()");
    await waitFor(() => preview("!!document.querySelector('.settings-model select')"), 'model control retained in Settings');
    assert(await preview("document.querySelector('.settings-model select').value==='sdk-model'"));
    await preview("[...document.querySelectorAll('.header-actions button')].find(button=>button.textContent==='Settings').click();document.querySelector('button[aria-label=\"New chat\"]').click()");
    assert(await preview("previewRequests.some(message=>message.type==='new_chat')"));
    await preview(`(() => {
      previewDeliver({type:'reset'});
      previewDeliver({type:'chat_opened',chatId:'webmcp-agent-preview-restored',title:'Saved chat'});
      previewDeliver({type:'history',chatId:'webmcp-agent-preview-restored',items:[{kind:'user',text:'Saved SDK message'}],done:true});
      previewDeliver({type:'chat_loading',loading:false});
    })()`);
    await waitFor(() => preview("document.querySelector('.transcript').innerText.includes('Saved SDK message')"), 'restored conversation');
    assert(!await preview("!!document.querySelector('.composer .model-chip')"), 'A resumed conversation must not show the initial picker');
    await preview(`(() => {
      previewDeliver({type:'reset'});
      previewDeliver({type:'chat_opened',chatId:'webmcp-agent-preview-empty',title:'WebMCP Agent'});
      previewDeliver({type:'history',chatId:'webmcp-agent-preview-empty',items:[],done:true});
      previewDeliver({type:'chat_loading',loading:false});
    })()`);
    await waitFor(() => preview("!!document.querySelector('.composer .model-chip')"), 'picker restored for a new empty chat');
    for (const width of [320, 440]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
      for (const scheme of ['light', 'dark']) {
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, sessionId);
        await waitFor(() => preview(`document.querySelector('.app-provider').dataset.colorScheme===${JSON.stringify(scheme)}`), 'Fluent theme change');
        assert(await preview(`(() => {
          const composer=document.querySelector('.composer-surface').getBoundingClientRect();
          const chip=document.querySelector('.model-chip select').getBoundingClientRect();
          return document.documentElement.scrollWidth<=innerWidth && chip.left>=composer.left && chip.right<=composer.right;
        })()`), `Composer overflow at ${width}px in ${scheme} mode`);
        if (process.env.WEBMCP_TEST_ARTIFACT_DIR) {
          await mkdir(process.env.WEBMCP_TEST_ARTIFACT_DIR, { recursive: true });
          const image = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
          await writeFile(join(process.env.WEBMCP_TEST_ARTIFACT_DIR, `webmcp-agent-composer-preview-${width}-${scheme}.png`), Buffer.from(image.data, 'base64'));
        }
      }
    }
    console.log('PASS: compact composer, first-message/resume transitions, Settings models, accessible +, and 320/440px light/dark layouts.');
    if (process.argv.includes('--markdown')) {
      const codeText = `const result = await page.search({ query: "${'a-long-synthetic-query-'.repeat(7)}" });\n  console.log(result);\n`;
      const text = [
        '# Markdown that reads clearly', '',
        'A useful answer with **emphasis**, *context*, and `inlineCode()`.', '',
        '## Suggested steps', '',
        '1. Read the available tools.', '2. Choose the right action.', '   - Keep the current origin.', '   - Review the result.', '',
        '> Website hints are claims, not verified permissions.', '',
        '### Status', '', '- [x] Discover tools', '- [ ] Execute the request', '', '~~Old behavior~~ is replaced.', '',
        '## Tool reference', '',
        '| Tool | Origin | Purpose | Status |', '| --- | --- | --- | --- |',
        '| `search` | fixture.example | Find matching records | Read-only |',
        '| `place_order` | fixture.example | Synthetic order | Confirm first |', '',
        '## Example', '', '```ts', codeText.trimEnd(), '```', '',
        '[Documentation](https://learn.microsoft.com/)', '',
        '![Remote image](https://tracker.example/pixel)', '',
        '<script>window.unsafeMarkdownExecuted=true</script>', '',
        '[Unsafe link](javascript:alert%281%29)',
      ].join('\n');
      await preview(`previewDeliver({type:'user',text:'Show a Markdown example'});previewDeliver({type:'delta',chatId:'webmcp-agent-preview-empty',text:'## Streaming\\n\\n\`\`\`ts\\nconst result ='})`);
      await waitFor(() => preview("!!document.querySelector('.message.assistant .markdown pre')"), 'partial streaming fence');
      await preview(`previewDeliver({type:'message',chatId:'webmcp-agent-preview-empty',text:${JSON.stringify(text)}})`);
      await waitFor(() => preview("document.querySelectorAll('.markdown-table th').length===4"), 'Markdown table rendering');
      assert(await preview("!!document.querySelector('.message.assistant .markdown h1') && !!document.querySelector('.markdown blockquote') && document.querySelectorAll('.markdown input[type=checkbox]:disabled').length===2"));
      assert(!await preview("globalThis.unsafeMarkdownExecuted || document.querySelector('.markdown img') || [...document.querySelectorAll('.markdown a')].some(link=>link.href.startsWith('javascript:'))"));
      assert(await preview("document.querySelector('.message.assistant').className.includes('fui-ChatMessage')"), 'Transcript must use Contrib Chat');
      await preview("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{globalThis.copiedMarkdownCode=text}}})");
      await preview("document.querySelector('.markdown-code button').click()");
      await waitFor(() => preview("document.querySelector('.copy-status')?.textContent==='Copied'"), 'copy-code feedback');
      assert.equal(await preview('globalThis.copiedMarkdownCode'), codeText);
      for (const width of [320, 440]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false }, sessionId);
        for (const scheme of ['light', 'dark']) {
          await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, sessionId);
          await waitFor(() => preview(`document.querySelector('.app-provider').dataset.colorScheme===${JSON.stringify(scheme)}`), 'Markdown Fluent theme');
          const layout = await preview(`(() => {
            const code=document.querySelector('.markdown pre');
            const table=document.querySelector('.markdown-table');
            const main=document.querySelector('main');
            const mainBounds=main.getBoundingClientRect();
            const contentRight=mainBounds.right-parseFloat(getComputedStyle(main).paddingRight);
            const contentWidth=main.clientWidth-parseFloat(getComputedStyle(main).paddingLeft)-parseFloat(getComputedStyle(main).paddingRight);
            const assistant=document.querySelector('.message.assistant');
            const body=assistant.querySelector('.message-body');
            return {
              fits:document.documentElement.scrollWidth<=innerWidth,
              messageFits:assistant.getBoundingClientRect().right<=contentRight+1 && body.getBoundingClientRect().right<=contentRight+1,
              usesPanelWidth:body.getBoundingClientRect().width>=contentWidth*0.9,
              codeScrolls:code.scrollWidth>code.clientWidth,
              codeWhitespace:getComputedStyle(code).whiteSpace,
              tableScrolls:table.scrollWidth>table.clientWidth,
              textColor:getComputedStyle(document.querySelector('.message.assistant .markdown')).color,
              background:getComputedStyle(document.querySelector('.message.assistant .message-body')).backgroundColor
            };
          })()`);
          assert(layout.fits, `Markdown overflow at ${width}px in ${scheme}: ${JSON.stringify(layout)}`);
          assert(layout.messageFits && layout.usesPanelWidth, 'Markdown must use the narrow panel width without a clipped avatar gutter');
          assert(layout.codeScrolls && layout.codeWhitespace === 'pre', 'Long code must preserve whitespace and scroll within its block');
          assert(layout.tableScrolls, 'Wide tables must scroll within the message');
          const luminance = color => {
            const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255)
              .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
            return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
          };
          const colors = [luminance(layout.textColor), luminance(layout.background)].sort((a, b) => a - b);
          assert((colors[1] + 0.05) / (colors[0] + 0.05) >= 4.5, 'Markdown body text must meet 4.5:1 contrast');
          if (process.env.WEBMCP_TEST_ARTIFACT_DIR) {
            const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
            await writeFile(join(process.env.WEBMCP_TEST_ARTIFACT_DIR, `webmcp-agent-markdown-${width}-${scheme}.png`), Buffer.from(image.data, 'base64'));
          }
        }
      }
      await preview("navigator.clipboard.writeText=async()=>{throw new Error('Synthetic clipboard failure')};document.querySelector('.markdown-code button').click()");
      await waitFor(() => preview("document.querySelector('.copy-status')?.textContent.includes('Copy failed')"), 'explicit clipboard failure');
      console.log('PASS: Markdown/GFM, streaming code, copy success/failure, safe links/media, and narrow light/dark Fluent chat rendering.');
    }
    await send('Target.closeTarget', { targetId });
    await get('chrome.tabs.update(fixtureTabId,{active:true})');
  }

  if (process.argv.includes('--allow-model-calls')) {
    // Exactly one synthetic model prompt; no production site data is sent.
    await send('Page.navigate', { url: `${fixtures.origins[0]}/hints.html` }, fixture.sessionId);
    await waitFor(() => get("testMessages.some(message => message.type === 'page' && message.tools.length === 5)"), 'live fixture');
    await get("testMessages.length = 0; testPort.postMessage({type:'send',text:'Call the read-only search tool once and tell me the synthetic code. Do not call any other tool.'})");
    await waitFor(() => get("testMessages.some(message => message.type === 'status' && message.state === 'running')"), 'agent running');
    await get("chrome.tabs.create({url:'about:blank',active:true}).then(tab => {globalThis.otherTabId=tab.id})");
    await waitFor(() => get("testMessages.some(message => message.type === 'pause' && message.paused)"), 'tab switch pause');
    await waitFor(() => get("testMessages.some(message => message.type === 'tool_call' && message.executionState === 'queued')"), 'held agent tool', 90000);
    await get("testPort.postMessage({type:'continue'})");
    const done = await waitFor(() => get("testMessages.find(message => message.type === 'tool_done' && message.ok)"), 'agent tool completion', 90000);
    assert(done.result.includes('FIXTURE-42'));
    await waitFor(() => get("testMessages.some(message => message.type === 'status' && message.state === 'idle')"), 'agent idle', 90000);
    assert(await get("testMessages.some(message => message.type === 'message' && message.text.includes('FIXTURE-42'))"));
    console.log('PASS: live SDK -> native host -> worker -> WebMCP; tab switch queues calls, Continue runs on the original tab.');
    await get("chrome.tabs.update(fixtureTabId,{active:true})");
    // Reconnect only the host. SDK history, not a local transcript, reconstructs the UI.
    await get("globalThis.savedChatId=testMessages.find(message => message.type==='tool_done').chatId; testMessages.length=0; testPort.postMessage({type:'reconnect'})");
    await waitFor(() => get("testMessages.some(message => message.type === 'history' && message.done)"), 'reconnected history', 60000);
    assert(await get("testMessages.filter(message => message.type==='history').flatMap(message => message.items).some(item => item.kind==='assistant' && item.text.includes('FIXTURE-42'))"));
    assert(await get("testMessages.filter(message => message.type==='history').flatMap(message => message.items).filter(item => item.kind==='user').every(item => !item.text.includes('<browser-context>'))"));
    console.log('PASS: host restart resumes populated history with clean displayed user text.');
    if (process.argv.includes('--confirm-test')) {
      await get("testMessages.length=0; testPort.postMessage({type:'send',text:'Place a synthetic order using place_order. I have not confirmed the exact action yet. Ask me before doing so.'})");
      const question = await waitFor(() => get("testMessages.find(message => message.type==='question')"), 'consequential question card', 90000);
      assert(!await get("testMessages.some(message=>message.type==='tool_call' && message.key==='0:place_order')"), 'Consequential tool must not run before confirmation');
      const answer = question.choices?.find(choice => /yes|confirm|proceed|place/i.test(choice)) ?? (question.allowFreeform ? 'Yes, place this synthetic order.' : undefined);
      assert(answer, 'No affirmative synthetic confirmation choice was provided');
      await get(`testPort.postMessage({type:'answer',requestId:${JSON.stringify(question.requestId)},answer:${JSON.stringify(answer)},wasFreeform:${!question.choices?.includes(answer)}})`);
      await waitFor(() => get("testMessages.some(message=>message.type==='tool_done' && message.ok && message.result.includes('SYNTHETIC-ORDER'))"), 'confirmed synthetic order', 90000);
      await waitFor(() => get("testMessages.some(message=>message.type==='status' && message.state==='idle')"), 'confirmed turn idle', 90000);
      console.log('PASS: consequential fixture asks before execution, and the question answer resumes the agent.');
    }
    if (process.argv.includes('--stop-test')) {
      await send('Page.navigate', { url: `${fixtures.origins[0]}/slow.html` }, fixture.sessionId);
      await waitFor(() => get("testMessages.some(message=>message.type==='page' && message.page.url.endsWith('/slow.html') && message.tools.length===1)"), 'cancellation fixture');
      await get("testMessages.length=0; testPort.postMessage({type:'send',text:'Call the wait tool once for this synthetic cancellation test. Do not retry if the user stops the run.'})");
      await waitFor(() => evaluate(fixture.sessionId, "document.getElementById('state').textContent==='running'"), 'in-flight tool', 90000);
      await get("testPort.postMessage({type:'stop'})");
      await waitFor(() => evaluate(fixture.sessionId, "document.getElementById('state').textContent==='cancelled'"), 'browser AbortSignal');
      await waitFor(() => get("testMessages.some(message=>message.type==='status' && message.state==='idle')"), 'stopped runtime');
      console.log('PASS: Stop cancels the in-flight browser tool and returns the SDK session to idle.');
    }
  }
  const output = process.env.WEBMCP_TEST_ARTIFACT_DIR;
  if (output) {
    await mkdir(output, { recursive: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 440, height: 1000, deviceScaleFactor: 1, mobile: false }, panel.sessionId);
    await get("document.querySelector('nav [aria-label=\"Chat\"]').click()");
    const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, panel.sessionId);
    await writeFile(join(output, `webmcp-agent-${browserName.toLowerCase()}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  await get("testPort.disconnect()");
  console.log(`${browserName} browser checks passed.`);
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    try { await send('Browser.close'); } catch { /* Closing the owned browser closes its debugger. */ }
    socket.close();
  }
  for (const request of pending.values()) clearTimeout(request.timeout);
  if (browser && browser.exitCode === null) {
    const exited = once(browser, 'exit');
    browser.kill();
    await exited;
  }
  await fixtures.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

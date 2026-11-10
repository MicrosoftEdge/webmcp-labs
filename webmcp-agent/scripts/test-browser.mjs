// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { root, extensionId } from './platform.mjs';
import { startFixtures } from './fixtures.mjs';

const requestedArguments = new Set(process.argv.slice(2));
const supportedArguments = new Set([
  '--chrome', '--headed', '--history', '--restricted-page',
  '--allow-model-calls', '--confirm-test', '--stop-test',
]);
for (const argument of requestedArguments) {
  if (!supportedArguments.has(argument)) {
    throw new Error(`Unknown browser-integration argument: ${argument}. UI presentation checks now use npm run test:ui.`);
  }
}
if ((requestedArguments.has('--confirm-test') || requestedArguments.has('--stop-test')) && !requestedArguments.has('--allow-model-calls')) {
  throw new Error('--confirm-test and --stop-test require explicit --allow-model-calls opt-in.');
}
const browserName = requestedArguments.has('--chrome') ? 'Chrome' : 'Edge';
const executable = process.env.WEBMCP_TEST_BROWSER ?? (browserName === 'Chrome'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
if (!existsSync(executable)) throw new Error('Set WEBMCP_TEST_BROWSER to an installed browser executable.');
const directory = await mkdtemp(join(tmpdir(), 'webmcp-agent-browser-'));
const profile = join(directory, 'profile');
await mkdir(profile);
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
  await send('Page.bringToFront', {}, sessionId);
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
    ...(requestedArguments.has('--headed') ? [] : ['--headless=new', '--disable-gpu']),
    '--no-first-run', '--no-default-browser-check',
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
  // Official Chrome may ignore --load-extension; debugging is confined to this owned profile.
  const targets = await send('Target.getTargets');
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
  if (requestedArguments.has('--history')) {
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
      try {
        await waitFor(() => get(`testMessages.some(message=>message.type==='chats' && message.chats.some(chat=>chat.chatId===${JSON.stringify(id)}))`), 'automatic Saved chats refresh');
      } catch (error) {
        console.error('Saved chats refresh diagnostic:', JSON.stringify(await get(`({
          expectedChatId:${JSON.stringify(id)},
          messages:testMessages.filter(message=>['chat_opened','chats','error','connection'].includes(message.type)),
          notices:document.querySelector('.transcript')?.innerText
        })`), null, 2));
        await get("globalThis.chatListsBefore=testMessages.filter(message=>message.type==='chats').length;testPort.postMessage({type:'list_chats'})");
        await waitFor(() => get("testMessages.filter(message=>message.type==='chats').length>chatListsBefore"), 'diagnostic SDK session list');
        console.error('Later SDK session list:', JSON.stringify(await get("testMessages.filter(message=>message.type==='chats').at(-1)"), null, 2));
        throw error;
      }
      return id;
    }
    async function resumeChat(id) {
      await get("document.querySelector('nav [aria-label=\"History\"]').click()");
      await waitFor(() => get(`testMessages.some(message=>message.type==='chats' && message.chats.some(chat=>chat.chatId===${JSON.stringify(id)})) &&
        document.querySelectorAll('.history-row').length === testMessages.filter(message=>message.type==='chats').at(-1).chats.length`), 'rendered SDK history list');
      await get(`(() => {
        const index=testMessages.filter(message=>message.type==='chats').at(-1).chats.findIndex(chat=>chat.chatId===${JSON.stringify(id)});
        const button=document.querySelectorAll('.history-row')[index].querySelector('.history-open');
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
  if (requestedArguments.has('--restricted-page')) {
    const url = browserName === 'Edge' ? 'edge://extensions/' : 'chrome://extensions/';
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
  await get("document.querySelector('nav [aria-label=\"Tools\"]').click()");
  await waitFor(() => get("document.querySelectorAll('.tool-row').length===5 && document.body.innerText.includes('debug_state') && document.body.innerText.includes('Hidden')"), 'content tools reach the rendered inspector');
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

  await send('Page.navigate', { url: `${fixtures.origins[0]}/pizza-order/` }, fixture.sessionId);
  const beforeOrder = await waitFor(() => get("testMessages.filter(message=>message.type==='page' && message.page.url.includes('/pizza-order/') && message.tools.some(tool=>tool.name==='create-order')).at(-1)"), 'real Contoso page tools');
  assert(!beforeOrder.tools.some(tool => tool.name === 'checkout'), 'Checkout should not be exposed before a cart exists.');
  await get(`testMessages.length=0;testPort.postMessage({
    type:'inspect_run',key:'0:create-order',args:{orderType:'carryout',items:[{productId:'pepperoni',quantity:1}]}
  })`);
  const created = await waitFor(() => get("testMessages.find(message=>message.type==='inspect_result' && message.key==='0:create-order')"), 'real Contoso create-order result');
  assert(created.ok && created.result.includes('Order Created'), 'The synthetic carryout cart was not created.');
  const ordering = await get(`({
    resultIndex:testMessages.findIndex(message=>message.type==='inspect_result' && message.key==='0:create-order'),
    toolsIndex:testMessages.findIndex(message=>message.type==='page' && message.page.url.includes('step=checkout') && message.tools.some(tool=>tool.name==='checkout')),
    page:testMessages.filter(message=>message.type==='page').at(-1)
  })`);
  assert(ordering.toolsIndex>=0 && ordering.toolsIndex<ordering.resultIndex,
    `New Contoso checkout tools must be discovered before returning create-order: ${JSON.stringify(ordering)}`);
  assert.equal(ordering.page.page.documentId,beforeOrder.page.documentId,'Contoso changes steps within the same document.');
  assert(ordering.page.tools.some(tool=>tool.name==='update-order'));
  console.log('PASS: actual Contoso create-order exposes checkout/update-order before returning its result, without a model prompt or checkout execution.');
  await send('Page.navigate', { url: `${fixtures.origins[0]}/hints.html` }, fixture.sessionId);
  const afterNavigation = await waitFor(() => get(`testMessages.filter(message=>message.type==='page' &&
    message.page.url.endsWith('/hints.html') && message.page.documentId!==${JSON.stringify(beforeOrder.page.documentId)} &&
    message.tools.length===5).at(-1)`), 'replacement document tool snapshot');
  assert(!afterNavigation.tools.some(tool=>tool.name==='checkout'),'A completed navigation must not restore tools from the previous page.');
  console.log('PASS: hard navigation replaces the document identity and removes the previous checkout tool.');

  if (requestedArguments.has('--allow-model-calls')) {
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
    // Resume SDK-owned history, not a local transcript.
    await get("globalThis.savedChatId=testMessages.find(message => message.type==='tool_done').chatId; testMessages.length=0; testPort.postMessage({type:'reconnect'})");
    await waitFor(() => get("testMessages.some(message => message.type === 'history' && message.done)"), 'reconnected history', 60000);
    assert(await get("testMessages.filter(message => message.type==='history').flatMap(message => message.items).some(item => item.kind==='assistant' && item.text.includes('FIXTURE-42'))"));
    assert(await get("testMessages.filter(message => message.type==='history').flatMap(message => message.items).filter(item => item.kind==='user').every(item => !item.text.includes('<browser-context>'))"));
    console.log('PASS: host restart resumes populated history with clean displayed user text.');
    if (requestedArguments.has('--confirm-test')) {
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
    if (requestedArguments.has('--stop-test')) {
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
    await send('Page.bringToFront', {}, panel.sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: 440, height: 1000, deviceScaleFactor: 1, mobile: false }, panel.sessionId);
    await get("document.querySelector('nav [aria-label=\"Chat\"]').click()");
    await waitFor(() => get("!!document.querySelector('.transcript')"), 'final Chat screenshot');
    const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, panel.sessionId);
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

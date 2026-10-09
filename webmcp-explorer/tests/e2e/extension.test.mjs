// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

let browser;
let connection;
let server;
let context;
let demo;
let panel;
let origin;
let nativeModelReady = false;
const pageErrors = [];

async function selectTab(name) {
  const button = panel.getByRole('tab', { name, exact: true });
  assert.ok(await button.isVisible());
  await button.click();
  assert.equal(await button.getAttribute('aria-selected'), 'true');
}

async function executeTool(name, args) {
  const values = await panel.locator('#tool-select option').evaluateAll(options => options.map(option => option.value));
  const value = values.find(value => value.endsWith(`\n${name}`));
  assert.ok(value, `${name} was discovered through the actual content script`);
  await panel.locator('#tool-select').selectOption(value);
  const argumentsText = JSON.stringify(args);
  await panel.locator('#tool-args').fill(argumentsText);
  assert.equal(await panel.locator('#tool-args').inputValue(), argumentsText);
  assert.ok(await panel.locator('#tool-execute').isEnabled());
  await panel.locator('#tool-execute').click();
  await panel.waitForFunction(() => !document.querySelector('#tool-execute').disabled);
}

before(async () => {
  assert.ok(process.env.WEBRUN_BROWSER && isAbsolute(process.env.WEBRUN_BROWSER),
    'Set WEBRUN_BROWSER to a Chrome for Testing executable that supports loading unpacked extensions.');
  const assets = new Map([
    ['/idea-board/', [new URL('../../../demos/idea-board/index.html', import.meta.url), 'text/html']],
    ['/idea-board/styles.css', [new URL('../../../demos/idea-board/styles.css', import.meta.url), 'text/css']],
  ]);
  server = createServer(async (request, response) => {
    const asset = assets.get(new URL(request.url, 'http://localhost').pathname);
    if (!asset) {
      response.writeHead(404).end('Not found');
      return;
    }
    try {
      response.writeHead(200, { 'Content-Type': asset[1] }).end(await readFile(asset[0]));
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const reservation = createSocketServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const debugPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));

  // This is Playwright 1.64.0's disabled-feature argument. OptimizationHints must
  // remain enabled for Chrome's real on-device model service.
  const disabledFeatures = '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,NetworkTimeServiceQuerying,AimEnabled,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion';
  const features = [
    'AIPromptAPI', 'AIPromptAPIToolUse', 'OnDeviceModelConversationBackend',
    'AIApiFoundationalModel:model_version/v4', 'OptimizationGuideManifestBroker',
    ...(process.env.WEBRUN_ENABLE_FEATURES?.split(',').filter(Boolean) ?? []),
  ];
  browser = await chromium.launch({
    executablePath: process.env.WEBRUN_BROWSER,
    headless: false,
    ignoreDefaultArgs: [
      '--disable-extensions', '--disable-component-update', '--disable-background-networking',
      '--disable-component-extensions-with-background-pages', disabledFeatures,
    ],
    args: [
      `--remote-debugging-port=${debugPort}`,
      `--load-extension=${fileURLToPath(new URL('../../dist/', import.meta.url))}`,
      `--enable-features=${features.join(',')}`,
      '--enable-blink-features=WebMCP,WebMCPTesting',
    ],
  });
  const preflight = await browser.newPage();
  console.log(`Actual-extension browser: ${browser.version()}`);
  await preflight.close();

  // Attach to the same browser's normal temporary profile; newContext() would
  // use incognito, where the model service and extension are not available.
  connection = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  context = connection.contexts()[0];
  demo = await context.newPage();
  demo.on('pageerror', error => pageErrors.push(error.message));
  await demo.goto(`${origin}/idea-board/`);
  assert.equal(await demo.title(), 'Idea Board');
  assert.equal(await demo.evaluate(() => typeof document.modelContext?.getTools), 'function');
  let worker = context.serviceWorkers().find(worker => worker.url().endsWith('/service-worker.js'));
  worker ??= await context.waitForEvent('serviceworker', {
    predicate: worker => worker.url().endsWith('/service-worker.js'),
  });
  const extensionId = new URL(worker.url()).host;
  const bootstrap = await context.newPage();
  await bootstrap.goto(`chrome-extension://${extensionId}/sidepanel/index.html`);
  const demoTab = await bootstrap.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.index === 0));
  assert.ok(demoTab && !demoTab.incognito);
  await bootstrap.evaluate(tabId => chrome.tabs.update(tabId, { active: true }), demoTab.id);
  const bootstrapSession = await context.newCDPSession(bootstrap);
  const result = await bootstrapSession.send('Runtime.evaluate', {
    expression: `chrome.sidePanel.open({tabId:${demoTab.id}})`,
    awaitPromise: true, userGesture: true,
  });
  assert.equal(result.exceptionDetails, undefined, 'Actual side panel opens');
  await bootstrap.close();
  const targets = await browser.newBrowserCDPSession();
  await demo.waitForFunction(() => document.readyState === 'complete');
  let panelTarget;
  for (let attempt = 0; attempt < 50 && !panelTarget; attempt++) {
    panelTarget = (await targets.send('Target.getTargets')).targetInfos.find(target => target.url.endsWith('/sidepanel/index.html'));
    if (!panelTarget) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(panelTarget, 'Side-panel browser target exists');
  await connection.close();
  connection = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  context = connection.contexts()[0];
  demo = context.pages().find(page => page.url() === `${origin}/idea-board/`);
  panel = context.pages().find(page => page.url().endsWith('/sidepanel/index.html'));
  assert.ok(demo && panel);
  demo.on('pageerror', error => pageErrors.push(error.message));
  panel.setDefaultTimeout(10_000);
  panel.on('pageerror', error => pageErrors.push(error.message));
  await panel.waitForFunction(() => document.querySelector('#tools-badge').textContent === '2');
});

after(async () => {
  await connection?.close();
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  assert.deepEqual(pageErrors, [], 'No uncaught errors in the real extension or demo');
});

test('actual side panel executes native WebMCP tools and tracks dynamic registrations', async () => {
  assert.equal(await panel.locator('.tool-list-item').count(), 2);
  await executeTool('add-sticky', { text: 'Native bridge E2E', color: 'yellow' });
  await demo.getByText('Native bridge E2E', { exact: true }).waitFor();
  await panel.waitForFunction(() => document.querySelector('#tools-badge').textContent === '4');
  await executeTool('list-stickies', {});
  await panel.waitForFunction(() => document.querySelector('#tool-result').textContent.includes('Native bridge E2E'));
  await executeTool('edit-sticky', { id: '1', text: 'Edited through extension', color: 'green' });
  await demo.getByText('Edited through extension', { exact: true }).waitFor();
  await executeTool('add-sticky', { text: 'Second E2E note', color: 'blue' });
  await demo.getByText('Second E2E note', { exact: true }).waitFor();
  await executeTool('add-sticky', { text: 'Third E2E note', color: 'pink' });
  await panel.waitForFunction(() => document.querySelector('#tools-badge').textContent === '5');
  await executeTool('group-stickies', { label: 'E2E Group', stickyIds: ['1', '2', '3'] });
  await demo.getByText('E2E Group', { exact: true }).waitFor();
  await panel.locator('#tool-args').fill('{invalid-json');
  await panel.locator('#tool-execute').click();
  await panel.waitForFunction(() => document.querySelector('#tool-result').textContent.includes('valid JSON'));
  assert.equal(await demo.locator('#board-grid .sticky').count(), 3);
  await executeTool('clear-board', {});
  await demo.locator('#board-empty').waitFor({ state: 'visible' });
  await panel.waitForFunction(() => document.querySelector('#tools-badge').textContent === '2');
});

test('real Config storage persists the credential-free provider across panel reloads', async () => {
  await selectTab('Config');
  await panel.locator('#provider-select').selectOption('prompt-api');
  assert.equal(await panel.locator('#provider-fields input').count(), 0);
  await panel.locator('#config-save').click();
  await panel.waitForFunction(() => document.querySelector('#config-message').textContent.includes('saved'));
  const stored = await panel.evaluate(() => chrome.storage.local.get('webmcp-explorer-config'));
  assert.equal(stored['webmcp-explorer-config'].provider.provider, 'prompt-api');
  await panel.reload();
  await selectTab('Config');
  assert.equal(await panel.locator('#provider-select').inputValue(), 'prompt-api');
});

test('real Agent step mode can pause and stop without changing the page', async () => {
  await selectTab('Agent');
  await panel.locator('#agent-goal').fill('Add a yellow note with text paused E2E.');
  await panel.locator('#agent-step').click();
  await panel.waitForFunction(() => document.querySelector('#agent-status').textContent === 'Paused. Step to call model.');
  assert.ok(await demo.locator('#board-empty').isVisible());
  await panel.locator('#agent-stop').click();
  await panel.waitForFunction(() => !document.querySelector('#agent-run').disabled);
  assert.equal(await panel.locator('#agent-status').innerText(), 'Stopped by user.');
  await panel.locator('#agent-reset').click();
});

test('real Config completes native model tool-call/result/final-answer round trip', { timeout: 600_000 }, async () => {
  await selectTab('Config');
  const globals = await panel.evaluate(() => ['LanguageModel', 'LanguageModelToolCall', 'LanguageModelToolSuccess', 'LanguageModelToolError']
    .map(name => [name, typeof globalThis[name]]));
  assert.ok(globals.every(([, type]) => type === 'function'), JSON.stringify(globals));
  await panel.locator('#config-test').click();
  await panel.waitForFunction(() => !document.querySelector('#config-test').disabled, null, { timeout: 590_000 });
  const message = await panel.locator('#config-message').innerText();
  nativeModelReady = message === 'Connection successful!';
  if (!nativeModelReady) {
    const diagnostics = await context.newPage();
    try {
      await diagnostics.goto('chrome://chrome-urls/');
      const enableDebugPages = diagnostics.getByRole('button', { name: /Enable.*debug/i });
      if (await enableDebugPages.count()) await enableDebugPages.click();
      await diagnostics.goto('chrome://on-device-internals/');
      await diagnostics.getByRole('tab', { name: 'Broker State', exact: true }).click();
      console.log('Native model broker:', await diagnostics.locator('on-device-internals-broker-state')
        .evaluate(element => element.shadowRoot.textContent.replace(/\s+/g, ' ').trim()));
    } finally {
      await diagnostics.close();
    }
  }
  assert.ok(nativeModelReady, `Native model prerequisite failed: ${message}`);
});

test('real Chat creates a note and consumes the native tool result', { timeout: 180_000 }, async context => {
  if (!nativeModelReady) return context.skip('Blocked by failed real native model prerequisite; not a passing model test.');
  await selectTab('Chat');
  await panel.locator('#chat-input').fill('Call add-sticky exactly once with text "Native Chat E2E" and color "yellow". After the tool result, confirm the created note.');
  await panel.locator('#chat-send').click();
  await panel.waitForFunction(() => !document.querySelector('#chat-send').disabled, null, { timeout: 170_000 });
  assert.ok(await demo.getByText('Native Chat E2E', { exact: true }).isVisible());
  assert.ok((await panel.locator('#chat-messages').innerText()).includes('Created yellow sticky'));
  assert.equal(await panel.locator('.chat-bubble-error').count(), 0);
  assert.equal(await panel.locator('#chat-messages > :last-child').getAttribute('class'), 'chat-bubble chat-bubble-assistant');
});

test('real Agent completes a native page-tool goal', { timeout: 180_000 }, async context => {
  if (!nativeModelReady) return context.skip('Blocked by failed real native model prerequisite; not a passing model test.');
  await selectTab('Agent');
  await panel.locator('#agent-goal').fill('Call add-sticky exactly once with text "Native Agent E2E" and color "green". Then call task_complete with a summary.');
  await panel.locator('#agent-run').click();
  await panel.waitForFunction(() => !document.querySelector('#agent-run').disabled, null, { timeout: 170_000 });
  assert.ok(await demo.getByText('Native Agent E2E', { exact: true }).isVisible());
  assert.equal(await panel.locator('#agent-status').innerText(), 'Goal achieved.');
});

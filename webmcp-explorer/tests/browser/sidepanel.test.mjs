// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { before, after, beforeEach, afterEach, test } from 'node:test';
import { chromium } from 'playwright';

let browser;
let context;
let page;
let pageErrors;
const origin = 'http://localhost:4179';
const assets = new Map([
  ['/sidepanel/index.html', ['../../dist/sidepanel/index.html', 'text/html']],
  ['/sidepanel.js', ['../../dist/sidepanel.js', 'text/javascript']],
  ['/assets/sidepanel.css', ['../../dist/assets/sidepanel.css', 'text/css']],
]);

function installFixtures() {
  const fixture = globalThis.fixture = {
    sessions: [], executions: [], responses: [], holds: {}, releases: {},
    storage: {
      'webmcp-explorer-config': {
        provider: { provider: 'prompt-api' }, providerConfigs: {},
        maxIterations: 5, maxChatMessages: 3,
      },
    },
    toolError: false,
  };
  const wait = async name => {
    if (fixture.holds[name]) await new Promise(resolve => { (fixture.releases[name] ??= []).push(resolve); });
  };
  fixture.release = name => {
    fixture.holds[name] = false;
    for (const resolve of fixture.releases[name] ?? []) resolve();
    fixture.releases[name] = [];
  };
  Object.assign(globalThis.chrome, {
    storage: { local: {
      async get() { await wait('storage'); return structuredClone(fixture.storage); },
      async set(value) { Object.assign(fixture.storage, structuredClone(value)); },
    } },
    runtime: { onMessage: { addListener() {} } },
    tabs: {
      async query() { return [{ id: 1 }]; },
      onUpdated: { addListener() {} }, onActivated: { addListener() {} },
      async sendMessage(_tabId, message) {
        if (message.type === 'listTools') return { type: 'listTools', tools: [{
          name: 'lookup', description: 'Look up a value', origin: 'https://example.test',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
        }] };
        fixture.executions.push(message);
        await wait('tool');
        return fixture.toolError ? { type: 'error', message: 'Lookup failed' } : { type: 'executeTool', result: 'found' };
      },
    },
  });
  for (const name of ['LanguageModelToolCall', 'LanguageModelToolSuccess', 'LanguageModelToolError']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: class {
      constructor(options) { Object.assign(this, options); }
    } });
  }
  Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, value: {
    async availability() { await wait('availability'); return 'available'; },
    async create(options) {
      const record = { options, prompts: [], destroyed: 0 };
      fixture.sessions.push(record);
      await wait('create');
      return {
        async prompt(messages) {
          record.prompts.push(messages);
          await wait('prompt');
          if (options.signal?.aborted) throw options.signal.reason;
          if (!fixture.responses.length) throw new Error('Test fixture has no queued response');
          return fixture.responses.shift();
        },
        destroy() { record.destroyed++; },
      };
    },
  } });
}

const answer = value => [{ type: 'text', value }];
const call = (name = 'lookup', argumentsObject = { value: 'hello' }, callId = 'native-1') =>
  [{ type: 'tool-call', value: { callId, name, arguments: argumentsObject } }];

async function tab(name) {
  const button = page.getByRole('tab', { name, exact: true });
  assert.ok(await button.isVisible());
  await button.click();
  assert.equal(await button.getAttribute('aria-selected'), 'true');
}

async function click(selector) {
  const button = page.locator(selector);
  assert.ok(await button.isVisible(), `${selector} is visible`);
  assert.ok(await button.isEnabled(), `${selector} is enabled`);
  await button.click();
}

async function textIncludes(selector, text) {
  await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent.includes(text), { selector, text });
  assert.ok((await page.locator(selector).textContent()).includes(text));
}

async function queue(...responses) {
  await page.evaluate(responses => fixture.responses.push(...responses), responses);
}

async function sendChat(text = 'Look up hello') {
  await tab('Chat');
  await page.locator('#chat-input').fill(text);
  assert.equal(await page.locator('#chat-input').inputValue(), text);
  await click('#chat-send');
}

before(async () => {
  assert.ok(process.env.WEBRUN_BROWSER && isAbsolute(process.env.WEBRUN_BROWSER),
    'Set WEBRUN_BROWSER to the absolute path of the Chromium browser to test.');
  browser = await chromium.launch({ executablePath: process.env.WEBRUN_BROWSER, headless: true });
  const preflight = await browser.newPage();
  console.log(`Browser preflight: ${browser.version()}, ${preflight.url()}`);
  await preflight.close();
});
after(async () => { await browser?.close(); });

beforeEach(async () => {
  context = await browser.newContext();
  // Serve only built local assets; never reach the network or a real WebMCP page.
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const asset = url.origin === origin ? assets.get(url.pathname) : undefined;
    if (!asset) return route.abort();
    const [path, contentType] = asset;
    await route.fulfill({ body: await readFile(new URL(path, import.meta.url)), contentType });
  });
  page = await context.newPage();
  page.setDefaultTimeout(5000);
  pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
});
afterEach(async () => {
  await context.close();
  assert.deepEqual(pageErrors, [], 'No uncaught errors in the built sidepanel');
});

async function loadFixtures() {
  await page.addInitScript(installFixtures);
  await page.goto(`${origin}/sidepanel/index.html`);
  await page.waitForFunction(() => document.querySelector('#provider-select').value === 'prompt-api');
}

test('reports real browser API exposure separately from mocked integration', async () => {
  // No fixtures: do not load the app, which requires extension APIs.
  await context.route(`${origin}/capabilities`, route => route.fulfill({
    contentType: 'text/html', body: '<title>Native API capability check</title>',
  }));
  await page.goto(`${origin}/capabilities`);
  const capabilities = await page.evaluate(() => ({
    secureContext: isSecureContext,
    LanguageModel: typeof globalThis.LanguageModel,
    LanguageModelToolCall: typeof globalThis.LanguageModelToolCall,
    LanguageModelToolSuccess: typeof globalThis.LanguageModelToolSuccess,
    LanguageModelToolError: typeof globalThis.LanguageModelToolError,
  }));
  assert.equal(capabilities.secureContext, true);
  console.log(`Real browser APIs (isolated, default flags): ${JSON.stringify(capabilities)}`);
});

test('Config saves a zero-field provider and verifies native tool replay', async () => {
  await loadFixtures();
  await tab('Config');
  assert.equal(await page.locator('#provider-fields input').count(), 0);
  await click('#config-save');
  await textIncludes('#config-message', 'saved');
  assert.equal(await page.evaluate(() => fixture.sessions.length), 0);
  await queue(call('test_tool'), answer('prompt-api-test-ok'));
  await click('#config-test');
  await textIncludes('#config-message', 'Connection successful!');
  const records = await page.evaluate(() => fixture.sessions);
  assert.equal(records.length, 2);
  assert.equal(records[1].prompts[0][2].content[0].type, 'tool-response');
  assert.ok(records.every(record => record.destroyed === 1));
  assert.equal(await page.evaluate(() => fixture.executions.length), 0);
  assert.ok(await page.locator('#config-test').isEnabled());
});

test('missing native API displays errors in Config, Chat, and Agent without fallback', async () => {
  await loadFixtures();
  await page.evaluate(() => { delete globalThis.LanguageModelToolCall; });
  await tab('Config');
  await click('#config-test');
  await textIncludes('#config-message', 'native tool calling is not available');
  await sendChat();
  await textIncludes('#chat-messages', 'native tool calling is not available');
  await tab('Agent');
  await page.locator('#agent-goal').fill('Look up hello');
  await click('#agent-run');
  await textIncludes('#agent-status', 'Agent failed.');
  await textIncludes('#agent-detail', 'native tool calling is not available');
  assert.equal(await page.evaluate(() => fixture.sessions.length), 0);
});

test('Chat Stop recovers while native availability is still pending', async () => {
  await loadFixtures();
  await page.evaluate(() => { fixture.holds.availability = true; });
  await sendChat();
  await textIncludes('#chat-messages', 'Checking built-in model availability...');
  await click('#chat-stop');
  await page.waitForFunction(() => !document.querySelector('#chat-send').disabled);
  assert.ok(await page.locator('#chat-stop').isDisabled());
  await page.evaluate(() => fixture.release('availability'));
  assert.equal(await page.evaluate(() => fixture.sessions.length), 0);
});

test('Chat executes through the bridge and feeds native success and error results back', async () => {
  await loadFixtures();
  await queue(call(), answer('First lookup complete'));
  await sendChat();
  await textIncludes('#chat-messages', 'First lookup complete');
  await page.evaluate(() => { fixture.toolError = true; });
  await queue(call('lookup', { value: 'second' }, 'native-2'), answer('Second lookup failed'));
  await sendChat('Look up second');
  await textIncludes('#chat-messages', 'Second lookup failed');
  const state = await page.evaluate(() => ({ sessions: fixture.sessions, executions: fixture.executions }));
  assert.equal(state.executions.length, 2);
  assert.equal(state.executions[0].origin, 'https://example.test');
  assert.deepEqual(JSON.parse(state.executions[0].args), { value: 'hello' });
  const lastPrompt = state.sessions.at(-1).prompts[0];
  assert.equal(lastPrompt.at(-1).content[0].value.errorMessage, 'Error: Lookup failed');
  assert.ok(state.sessions.every(session => session.destroyed === 1));
});

test('Reset during model creation discards the old request and allows a new chat', async () => {
  await loadFixtures();
  await page.evaluate(() => { fixture.holds.create = true; });
  await sendChat();
  await page.waitForFunction(() => fixture.sessions.length === 1);
  await textIncludes('#chat-messages', 'Loading the built-in model');
  await click('#chat-reset');
  await page.evaluate(() => fixture.release('create'));
  await page.waitForFunction(() => fixture.sessions[0].destroyed === 1);
  assert.equal(await page.locator('#chat-messages').textContent(), '');
  await queue(answer('Fresh chat'));
  await sendChat('New request');
  await textIncludes('#chat-messages', 'Fresh chat');
});

test('stopping a page tool keeps a replayable interrupted result', async () => {
  await loadFixtures();
  await page.evaluate(() => { fixture.holds.tool = true; });
  await queue(call());
  await sendChat();
  await page.waitForFunction(() => fixture.executions.length === 1);
  await click('#chat-stop');
  await page.evaluate(() => fixture.release('tool'));
  await textIncludes('#chat-messages', 'Stopped.');
  await queue(answer('Can continue'));
  await sendChat('Continue');
  await textIncludes('#chat-messages', 'Can continue');
  const prompts = await page.evaluate(() => fixture.sessions.at(-1).prompts[0]);
  // A small cap may drop the old exchange, but must never keep an orphan result.
  assert.ok(prompts.every((message, index) =>
    !Array.isArray(message.content) || !message.content.some(block => block.type === 'tool-response') ||
    prompts[index - 1].role === 'assistant'));
});

test('Agent step mode pauses before tool execution and permits Stop', async () => {
  await loadFixtures();
  await tab('Agent');
  await page.locator('#agent-goal').fill('Look up hello');
  await queue(call());
  await click('#agent-step');
  await textIncludes('#agent-status', 'Paused. Step to call model.');
  assert.equal(await page.evaluate(() => fixture.sessions.length), 0);
  await click('#agent-step');
  await textIncludes('#agent-status', 'Paused. Execute step or resume.');
  assert.equal(await page.evaluate(() => fixture.executions.length), 0);
  await click('#agent-stop');
  await textIncludes('#agent-status', 'Stopped by user.');
  assert.ok(await page.locator('#agent-goal').isEnabled());
});

test('Agent ask_user can be stopped while awaiting a reply', async () => {
  await loadFixtures();
  await tab('Agent');
  await page.locator('#agent-goal').fill('Ask me first');
  await queue(call('ask_user', { question: 'Which value?' }));
  await click('#agent-run');
  await textIncludes('#agent-status', 'Waiting for your reply');
  await click('#agent-stop');
  await textIncludes('#agent-status', 'Stopped by user.');
  assert.ok(await page.locator('#agent-run').isEnabled());
});

test('Agent step mode executes only on approval and replays the result before completion', async () => {
  await loadFixtures();
  await tab('Agent');
  await page.locator('#agent-goal').fill('Look up hello');
  await queue(call(), call('task_complete', { summary: 'Lookup completed' }, 'complete-1'));
  await click('#agent-step');
  await textIncludes('#agent-status', 'Paused. Step to call model.');
  await click('#agent-step');
  await textIncludes('#agent-status', 'Paused. Execute step or resume.');
  assert.equal(await page.evaluate(() => fixture.executions.length), 0);
  await click('#detail-execute-step');
  await textIncludes('#agent-status', 'Paused. Step to call model.');
  assert.equal(await page.evaluate(() => fixture.executions.length), 1);
  await click('#agent-step');
  await textIncludes('#agent-status', 'Goal achieved.');
  await textIncludes('#agent-detail', 'Lookup completed');
  const sessions = await page.evaluate(() => fixture.sessions);
  assert.equal(sessions[1].prompts[0].at(-1).content[0].value.result[0].value, 'found');
  assert.ok(sessions.every(session => session.destroyed === 1));
});

test('Agent replays ask_user replies without dispatching built-in tools to the page', async () => {
  await loadFixtures();
  await tab('Agent');
  await page.locator('#agent-goal').fill('Ask me first');
  await queue(call('ask_user', { question: 'Which value?' }), call('task_complete', { summary: 'Got hello' }, 'complete-1'));
  await click('#agent-run');
  await textIncludes('#agent-status', 'Waiting for your reply');
  await page.locator('#detail-ask-input').fill('hello');
  assert.equal(await page.locator('#detail-ask-input').inputValue(), 'hello');
  await click('#detail-ask-reply');
  await textIncludes('#agent-status', 'Goal achieved.');
  const state = await page.evaluate(() => ({ sessions: fixture.sessions, executions: fixture.executions }));
  assert.equal(state.executions.length, 0);
  assert.equal(state.sessions[1].prompts[0].at(-1).content[0].value.result[0].value, 'hello');
});

test('Config rejects text masquerading as tool calls and recovers for a subsequent test', async () => {
  await loadFixtures();
  await tab('Config');
  await queue('{"toolCalls":[{"name":"test_tool","arguments":{"value":"hello"}}]}');
  await click('#config-test');
  await textIncludes('#config-message', 'no fallback');
  assert.ok(await page.locator('#config-test').isEnabled());
  assert.equal(await page.evaluate(() => fixture.executions.length), 0);
  await queue(call('test_tool'), answer('prompt-api-test-ok'));
  await click('#config-test');
  await textIncludes('#config-message', 'Connection successful!');
  assert.ok(await page.evaluate(() => fixture.sessions.every(session => session.destroyed === 1)));
});

test('Reset during inference cannot inject an old answer into the new chat', async () => {
  await loadFixtures();
  await page.evaluate(() => { fixture.holds.prompt = true; });
  await sendChat('Old request');
  await page.waitForFunction(() => fixture.sessions[0]?.prompts.length === 1);
  await click('#chat-reset');
  await queue(answer('Only the new answer'));
  await sendChat('New request');
  await page.waitForFunction(() => fixture.sessions[1]?.prompts.length === 1);
  await page.evaluate(() => fixture.release('prompt'));
  await textIncludes('#chat-messages', 'Only the new answer');
  assert.ok(!(await page.locator('#chat-messages').textContent()).includes('Old request'));
  const state = await page.evaluate(() => fixture.sessions);
  assert.ok(state.every(session => session.destroyed === 1));
  assert.equal(state[1].prompts[0].length, 1);
  assert.equal(state[1].prompts[0][0].content, 'New request');
});

for (const pane of ['Chat', 'Agent']) {
  test(`${pane} Reset during async setup prevents a delayed model call`, async () => {
    await loadFixtures();
    await tab(pane);
    const prefix = pane.toLowerCase();
    await page.locator(pane === 'Chat' ? '#chat-input' : '#agent-goal').fill('Old request');
    await page.evaluate(() => { fixture.holds.storage = true; });
    await click(pane === 'Chat' ? '#chat-send' : '#agent-run');
    await page.waitForFunction(() => fixture.releases.storage?.length === 1);
    assert.ok(await page.locator(pane === 'Chat' ? '#chat-send' : '#agent-run').isDisabled());
    await click(`#${prefix}-reset`);
    await queue(answer('This must never appear'));
    await page.evaluate(() => fixture.release('storage'));
    // Drain storage continuations and UI work before checking absence.
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    assert.equal(await page.evaluate(() => fixture.sessions.length), 0);
    assert.equal(await page.locator(`#${prefix === 'chat' ? 'chat-messages' : 'agent-steps'}`).textContent(), '');
  });
}

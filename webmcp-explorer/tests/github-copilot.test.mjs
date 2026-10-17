// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const outputDirectory = await mkdtemp(join(tmpdir(), 'webmcp-copilot-tests-'));
after(() => rm(outputDirectory, { recursive: true, force: true }));
try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: outputDirectory,
      lib: {
        entry: Object.fromEntries([
          ['auth', 'github-copilot-auth'], ['provider', 'github-copilot'], ['chat', 'chat-completions'],
        ].map(([name, file]) => [name, fileURLToPath(new URL(`../src/lib/llm/${file}.ts`, import.meta.url))])),
        formats: ['es'],
      },
      rollupOptions: { output: { entryFileNames: '[name].mjs', chunkFileNames: '[name]-[hash].mjs' } },
    },
  });
} catch (error) {
  await rm(outputDirectory, { recursive: true, force: true });
  throw error;
}
const originalFetch = globalThis.fetch;
let mockFetch;
globalThis.fetch = (...argumentsValue) => mockFetch(...argumentsValue);
const auth = await import(pathToFileURL(join(outputDirectory, 'auth.mjs')).href);
const { GitHubCopilotProvider, providerMetadata } = await import(pathToFileURL(join(outputDirectory, 'provider.mjs')).href);
const { ChatCompletionsProvider } = await import(pathToFileURL(join(outputDirectory, 'chat.mjs')).href);
after(() => { globalThis.fetch = originalFetch; });
const originalChrome = globalThis.chrome;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalSetTimeout = globalThis.setTimeout;
const credentialsKey = auth.COPILOT_CREDENTIALS_KEY;
const sessionKey = 'webmcp-explorer-copilot-session';
const clientId = auth.DEFAULT_COPILOT_CLIENT_ID;
const config = { provider: 'github-copilot', model: 'gpt-4.1', clientId };
let sessionStorage;
let localStorage;
let requests;
let responses;
let pollingDelays;
let listeners;
let accessLevels;

function storageArea(area, values) {
  return {
    async get(key) { return { [key]: structuredClone(values[key]) }; },
    async set(items) {
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: structuredClone(values[key]), newValue: structuredClone(value) };
        values[key] = structuredClone(value);
      }
      for (const listener of [...listeners]) listener(changes, area);
    },
    async remove(keys) {
      const changes = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (values[key] !== undefined) {
          changes[key] = { oldValue: structuredClone(values[key]) };
          delete values[key];
        }
      }
      for (const listener of [...listeners]) listener(changes, area);
    },
    async setAccessLevel(options) { accessLevels[area] = options.accessLevel; },
  };
}

beforeEach(() => {
  sessionStorage = {};
  localStorage = {};
  requests = [];
  responses = [];
  pollingDelays = [];
  listeners = new Set();
  accessLevels = {};
  globalThis.chrome = {
    runtime: { getManifest: () => ({ version: '0.1.0' }) },
    storage: {
      session: storageArea('session', sessionStorage), local: storageArea('local', localStorage),
      onChanged: {
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener),
      },
    },
  };
  const locks = new Map();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      locks: {
        async request(name, options, callback) {
          if (typeof options === 'function') { callback = options; options = {}; }
          if (options.ifAvailable && locks.has(name)) return callback(null);
          options.signal?.throwIfAborted();
          const previous = locks.get(name) ?? Promise.resolve();
          let release;
          const held = new Promise((resolve) => { release = resolve; });
          const tail = previous.then(() => held);
          locks.set(name, tail);
          await previous;
          try {
            options.signal?.throwIfAborted();
            return await callback({ name });
          } finally {
            release();
            if (locks.get(name) === tail) locks.delete(name);
          }
        },
      },
    },
  });
  globalThis.setTimeout = (callback, milliseconds, ...argumentsValue) => {
    if (milliseconds >= 1000) {
      pollingDelays.push(milliseconds);
      return originalSetTimeout(callback, 0, ...argumentsValue);
    }
    return originalSetTimeout(callback, milliseconds, ...argumentsValue);
  };
  mockFetch = async (input, options = {}) => {
    options.signal?.throwIfAborted();
    const url = input instanceof Request ? input.url : String(input);
    const request = { url, options };
    requests.push(request);
    assert.ok(responses.length, `Unexpected request: ${url}`);
    const next = responses.shift();
    if (typeof next === 'function') return next(request);
    return Response.json(next.body ?? next, { status: next.status ?? 200 });
  };
});

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.chrome = originalChrome;
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else delete globalThis.navigator;
});

function credentials(overrides = {}) {
  return { clientId, signInId: 'sign-in-identity', accessToken: 'github-access-token', ...overrides };
}
function seedCredentials(overrides = {}) { sessionStorage[credentialsKey] = credentials(overrides); }
function seedSession(overrides = {}) {
  sessionStorage[sessionKey] = {
    clientId, token: 'copilot-session-token', expiresAt: Date.now() + 3600_000,
    baseUrl: 'https://api.individual.githubcopilot.com', ...overrides,
  };
}
function device(overrides = {}) {
  return {
    device_code: 'private-device-code', user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5, ...overrides,
  };
}
function exchange(overrides = {}) {
  return {
    token: 'copilot-session-token', expires_at: Math.floor(Date.now() / 1000) + 3600,
    endpoints: { api: 'https://api.individual.githubcopilot.com' }, ...overrides,
  };
}
function completion(overrides = {}) {
  return { choices: [{ message: { content: 'ok', ...overrides } }] };
}
const send = (provider, messages = [{ role: 'user', content: 'Hello' }], tools = [], options) =>
  provider.sendMessage('System', messages, tools, options);

test('exposes browser-only subscription settings and rejects invalid client IDs', () => {
  assert.equal(providerMetadata.label, 'GitHub Copilot (subscription)');
  assert.deepEqual(providerMetadata.fields.map((field) => field.configKey), ['model', 'clientId']);
  const clientField = providerMetadata.fields.find((field) => field.configKey === 'clientId');
  assert.match(clientField.label, /advanced override/);
  assert.match(clientField.description, /not your account or Copilot subscription/);
  assert.match(clientField.description, /not an API key or secret/);
  assert.match(clientField.description, /Normally leave the default unchanged/);
  assert.equal(clientField.documentationUrl, 'https://github.com/microsoft/AzureStorageExplorer/issues/8995');
  assert.match(providerMetadata.description, /Experimental, unofficial/);
  assert.ok(providerMetadata.hostPermissions.every((origin) => origin.startsWith('https://')));
  assert.ok(providerMetadata.hostPermissions.every((origin) => !origin.includes('*.')));
  assert.equal(auth.copilotClientId(''), clientId);
  assert.throws(() => new GitHubCopilotProvider({ ...config, model: '' }), /required/);
  assert.throws(() => auth.copilotClientId('invalid\nclient'), /Invalid/);
});

test('restricts storage, removes legacy persistent credentials, and detects malformed credentials', async () => {
  localStorage[credentialsKey] = { accessToken: 'legacy-persistent-secret' };
  assert.equal(await auth.isCopilotSignedIn(clientId), false);
  assert.equal(localStorage[credentialsKey], undefined);
  assert.deepEqual(accessLevels, { session: 'TRUSTED_CONTEXTS', local: 'TRUSTED_CONTEXTS' });
  sessionStorage[credentialsKey] = { accessToken: 'missing-client-and-identity' };
  await assert.rejects(auth.isCopilotSignedIn(clientId), /invalid/);
});

test('device sign-in honors pending and slow_down and stores credentials only in session memory', async () => {
  responses.push(device(), { error: 'authorization_pending' }, { error: 'slow_down' }, {
    access_token: 'github-device-token', token_type: 'bearer',
  });
  const codes = [];
  await auth.signInToCopilot(clientId, (...value) => codes.push(value), new AbortController().signal);
  assert.deepEqual(codes, [['ABCD-1234', 'https://github.com/login/device']]);
  assert.deepEqual(pollingDelays, [5000, 5000, 10000]);
  assert.equal(await auth.isCopilotSignedIn(clientId), true);
  assert.equal(await auth.isCopilotSignedIn('another-client'), false);
  assert.equal(sessionStorage[credentialsKey].accessToken, 'github-device-token');
  assert.deepEqual(localStorage, {});
  const form = new URLSearchParams(requests[0].options.body);
  assert.equal(form.get('client_id'), clientId);
  assert.equal(form.get('scope'), 'read:user');
  for (const request of requests) {
    assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.redirect, 'error');
    assert.equal(request.options.cache, 'no-store');
    assert.equal(request.options.referrerPolicy, 'no-referrer');
  }
});

test('rejects unexpected verification URLs before displaying a device code', async () => {
  for (const verification_uri of [
    'https://github.com.attacker.example/login/device', 'http://github.com/login/device',
    'https://user:password@github.com/login/device', 'https://github.com/login/device?redirect=evil',
  ]) {
    responses.push(device({ verification_uri }));
    let displayed = false;
    await assert.rejects(auth.signInToCopilot(clientId, () => { displayed = true; }, new AbortController().signal), /verification URL/);
    assert.equal(displayed, false);
    assert.equal(sessionStorage[credentialsKey], undefined);
  }
});

test('surfaces device denial, expiry, and malformed token responses without storing them', async () => {
  for (const result of [
    { error: 'access_denied' }, { error: 'expired_token' },
    { access_token: 'token', expires_in: -1 }, { access_token: 'token', token_type: 'unexpected' },
  ]) {
    responses.push(device(), result);
    await assert.rejects(auth.signInToCopilot(clientId, () => {}, new AbortController().signal));
    assert.equal(sessionStorage[credentialsKey], undefined);
  }
});

test('rejects invalid device lifetimes and intervals', async () => {
  for (const invalid of [{ expires_in: 0 }, { expires_in: 3601 }, { interval: 0 }, { interval: 1.5 }]) {
    responses.push(device(invalid));
    await assert.rejects(auth.signInToCopilot(clientId, () => {}, new AbortController().signal), /lifetime|interval/);
  }
});

test('cancels device polling without saving credentials', async () => {
  responses.push(device());
  const controller = new AbortController();
  await assert.rejects(auth.signInToCopilot(clientId, () => controller.abort(new Error('Cancelled')), controller.signal), /Cancelled/);
  assert.equal(requests.length, 1);
  assert.equal(sessionStorage[credentialsKey], undefined);
});

test('rolls back a credential write if sign-in is cancelled while storage is committing', async () => {
  responses.push(device(), { access_token: 'cancelled-token' });
  const controller = new AbortController();
  const set = chrome.storage.session.set;
  chrome.storage.session.set = async (items) => {
    await set(items);
    if (items[credentialsKey]) controller.abort(new Error('Cancelled during commit'));
  };
  await assert.rejects(auth.signInToCopilot(clientId, () => {}, controller.signal), /Cancelled during commit/);
  assert.equal(sessionStorage[credentialsKey], undefined);
});

test('rejects invalid slow_down intervals rather than polling at a clamped timer rate', async () => {
  responses.push(device(), { error: 'slow_down', interval: 2 ** 32 });
  await assert.rejects(auth.signInToCopilot(clientId, () => {}, new AbortController().signal), /invalid polling interval/);
  assert.equal(requests.length, 2);
});

test('does not persist an authorization completed after sign-out in another panel', async () => {
  seedCredentials();
  responses.push(device(), async () => {
    await auth.signOutOfCopilot();
    return Response.json({ access_token: 'late-token' });
  });
  await assert.rejects(auth.signInToCopilot(clientId, () => {}, new AbortController().signal), /superseded/);
  assert.equal(sessionStorage[credentialsKey], undefined);
});

test('rejects concurrent device flows rather than queueing a second hidden sign-in', async () => {
  const controller = new AbortController();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  responses.push(({ options }) => new Promise((_resolve, reject) => {
    started();
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  const first = auth.signInToCopilot(clientId, () => {}, controller.signal);
  await ready;
  await assert.rejects(auth.signInToCopilot(clientId, () => {}, new AbortController().signal), /another panel/);
  controller.abort(new Error('Cancelled'));
  await assert.rejects(first, /Cancelled/);
});

test('sign-out clears credentials and cache locally without revoking a shared app remotely', async () => {
  seedCredentials();
  seedSession();
  localStorage[credentialsKey] = { accessToken: 'legacy' };
  await auth.signOutOfCopilot();
  assert.equal(sessionStorage[credentialsKey], undefined);
  assert.equal(sessionStorage[sessionKey], undefined);
  assert.equal(localStorage[credentialsKey], undefined);
  assert.equal(requests.length, 0);
});

test('exchanges and caches short-lived tokens with serialized concurrent refresh', async () => {
  seedCredentials();
  responses.push(exchange());
  const sessions = await Promise.all([
    auth.getCopilotSession(clientId), auth.getCopilotSession(clientId),
  ]);
  assert.equal(requests.length, 1);
  assert.deepEqual(sessions[0], sessions[1]);
  assert.equal(new Headers(requests[0].options.headers).get('Authorization'), 'token github-access-token');
  assert.equal(requests[0].url, 'https://api.github.com/copilot_internal/v2/token');
});

test('renews expiring GitHub tokens and preserves the sign-in identity', async () => {
  seedCredentials({ expiresAt: Date.now() + 1000, refreshToken: 'refresh-token' });
  seedSession();
  responses.push({
    access_token: 'renewed-token', expires_in: 3600, refresh_token: 'rotated-refresh', refresh_token_expires_in: 7200,
  }, exchange());
  await auth.getCopilotSession(clientId);
  assert.equal(new URLSearchParams(requests[0].options.body).get('grant_type'), 'refresh_token');
  assert.equal(sessionStorage[credentialsKey].signInId, 'sign-in-identity');
  assert.equal(sessionStorage[credentialsKey].accessToken, 'renewed-token');
  assert.equal(new Headers(requests[1].options.headers).get('Authorization'), 'token renewed-token');
});

test('expired refresh credentials require sign-in and rejected renewal clears credentials', async () => {
  seedCredentials({ expiresAt: Date.now() - 1000, refreshToken: 'expired', refreshExpiresAt: Date.now() - 1 });
  await assert.rejects(auth.getCopilotSession(clientId), /expired/);
  assert.equal(requests.length, 0);
  seedCredentials({ expiresAt: Date.now() - 1, refreshToken: 'revoked' });
  responses.push({ error: 'bad_refresh_token' });
  await assert.rejects(auth.getCopilotSession(clientId), /renewal failed/);
  assert.equal(sessionStorage[credentialsKey], undefined);
});

test('accepts only explicit Copilot HTTPS origins, without a personal-account fallback', async () => {
  seedCredentials();
  for (const api of [
    'https://attacker.example', 'http://api.githubcopilot.com', 'https://other.githubcopilot.com',
    'https://api.githubcopilot.com/path', 'https://user:password@api.githubcopilot.com',
  ]) {
    responses.push(exchange({ endpoints: { api } }));
    await assert.rejects(auth.getCopilotSession(clientId), /unsupported/);
  }
  responses.push(exchange({ endpoints: undefined }));
  await assert.rejects(auth.getCopilotSession(clientId), /did not return/);
  responses.push(exchange({ endpoints: { api: 123 } }));
  await assert.rejects(auth.getCopilotSession(clientId), /invalid/);
  for (const baseUrl of ['https://api.business.githubcopilot.com', 'https://api.enterprise.githubcopilot.com']) {
    responses.push(exchange({ endpoints: { api: baseUrl } }));
    assert.equal((await auth.getCopilotSession(clientId)).baseUrl, baseUrl);
    delete sessionStorage[sessionKey];
  }
  responses.push(exchange({ endpoints: undefined, token: 'token;proxy-ep=proxy.individual.githubcopilot.com' }));
  assert.equal((await auth.getCopilotSession(clientId)).baseUrl, 'https://api.individual.githubcopilot.com');
});

test('revoked GitHub credentials are removed on HTTP 401', async () => {
  seedCredentials();
  responses.push({ status: 401, body: { error: 'revoked' } });
  await assert.rejects(auth.getCopilotSession(clientId), /revoked/);
  assert.equal(sessionStorage[credentialsKey], undefined);
});

test('invalidates only the rejected cached session, not a newer concurrent session', async () => {
  seedSession({ token: 'new-token' });
  await auth.invalidateCopilotSession('old-token');
  assert.equal(sessionStorage[sessionKey].token, 'new-token');
  await auth.invalidateCopilotSession('new-token');
  assert.equal(sessionStorage[sessionKey], undefined);
});

test('rejects a tampered cached endpoint before making any network request', async () => {
  seedCredentials();
  seedSession({ baseUrl: 'https://attacker.example' });
  await assert.rejects(send(new GitHubCopilotProvider(config)), /unsupported Copilot API endpoint/);
  assert.equal(requests.length, 0);
});

test('uses only the short-lived token for inference and preserves tool calls and history', async () => {
  seedCredentials();
  seedSession();
  responses.push(completion({ tool_calls: [{ id: 'call', type: 'function', function: { name: 'page_tool', arguments: '{"value":"hello"}' } }] }));
  const result = await send(new GitHubCopilotProvider(config), [
    { role: 'user', content: 'Call the tool' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'prior', name: 'page_tool', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'prior', content: 'Previous result' },
  ], [{ name: 'page_tool', description: 'Page tool', parameters: { type: 'object' } }]);
  assert.deepEqual(result.toolCalls, [{ id: 'call', name: 'page_tool', arguments: '{"value":"hello"}' }]);
  const headers = new Headers(requests[0].options.headers);
  assert.equal(headers.get('Authorization'), 'Bearer copilot-session-token');
  assert.equal(headers.get('X-Initiator'), 'agent');
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[3].tool_call_id, 'prior');
  assert.equal(body.tools[0].function.name, 'page_tool');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(listeners.size, 0);
});

test('refreshing credentials during inference does not abort its own request', async () => {
  seedCredentials({ expiresAt: Date.now() + 1000, refreshToken: 'refresh' });
  responses.push({ access_token: 'refreshed', expires_in: 3600 }, exchange(), completion());
  assert.equal((await send(new GitHubCopilotProvider(config))).text, 'ok');
  assert.equal(requests.length, 3);
});

test('rejects inference HTTP errors without retrying or exposing raw response bodies', async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    seedCredentials();
    seedSession();
    responses.push({ status, body: { error: { message: 'RAW_RESPONSE_SECRET' } } });
    const previousRequests = requests.length;
    await assert.rejects(send(new GitHubCopilotProvider(config)), (error) =>
      !error.message.includes('RAW_RESPONSE_SECRET') && /Copilot/.test(error.message));
    assert.equal(requests.length, previousRequests + 1);
    if (status === 401) assert.equal(sessionStorage[sessionKey], undefined);
  }
});

test('sign-out aborts active inference and detaches the credential listener', async () => {
  seedCredentials();
  seedSession();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  responses.push(({ options }) => new Promise((_resolve, reject) => {
    started();
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }));
  const pending = send(new GitHubCopilotProvider(config));
  await ready;
  await auth.signOutOfCopilot();
  await assert.rejects(pending, /sign-in changed|sign in again/i);
  assert.equal(listeners.size, 0);
});

test('propagates caller cancellation before issuing any network request', async () => {
  seedCredentials();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(send(new GitHubCopilotProvider(config), undefined, [], { signal: controller.signal }));
  assert.equal(requests.length, 0);
  assert.equal(listeners.size, 0);
});

test('does not change the existing generic Chat Completions provider transport', async () => {
  responses.push(completion());
  const provider = new ChatCompletionsProvider({
    provider: 'chat-completions', baseUrl: 'http://localhost:11434/v1', model: 'local-model', apiKey: 'local-key',
  });
  assert.equal((await send(provider)).text, 'ok');
  assert.equal(requests[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(new Headers(requests[0].options.headers).get('Authorization'), 'Bearer local-key');
});

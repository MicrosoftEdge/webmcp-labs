// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { get as httpGet } from 'node:http';
import { CopilotBridge, type RuntimeClient, type RuntimeEvent, type RuntimeSession } from '../copilot-service/bridge';
import { createCompanionServer } from '../copilot-service/server';
import { GitHubCopilotProvider } from '../src/lib/llm/github-copilot';
import { parseServiceResponse, parseStartRequest, parseToolResults, type CopilotStartRequest } from '../src/lib/llm/copilot-protocol';
import { loadConfig } from '../src/lib/storage';
import { createRuntimeSessionOptions, resolveCompanionCliPath } from '../copilot-service/runtime-config';

const TOKEN = 'mock_companion_pairing_token_' + 'x'.repeat(32);
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const config = { provider: 'github-copilot-service', baseUrl: 'http://127.0.0.1:8787', serviceToken: TOKEN, model: 'model' };
const request: CopilotStartRequest = {
  model: 'model', systemPrompt: 'Only use page tools.',
  messages: [{ role: 'user', content: 'Order a pizza.' }],
  tools: [{ name: 'order', description: 'Order pizza', parameters: { type: 'object', properties: {} } }],
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
const finalResponse = { sessionId: null, text: 'done', toolCalls: [] };
const toolResponse = {
  sessionId: SESSION_ID, text: null,
  toolCalls: [{ id: 'call_1', name: 'order', arguments: '{"pizza":"pepperoni"}' }],
};

class FakeSession implements RuntimeSession {
  handler?: (event: RuntimeEvent) => void;
  closed = false;
  prompt = '';
  results: string[] = [];
  errors: unknown[] = [];
  constructor(
    readonly mode: 'text' | 'tool' | 'parallel' | 'hang' | 'error',
    private readonly invoke: (index: number, args: unknown, id: string) => Promise<string>,
  ) {}
  onEvent(handler: (event: RuntimeEvent) => void) { this.handler = handler; return () => { this.handler = undefined; }; }
  async send(prompt: string) {
    this.prompt = prompt;
    if (this.mode === 'hang') return;
    if (this.mode === 'error') { this.handler?.({ type: 'error', error: new Error('private-runtime-details') }); return; }
    this.handler?.({ type: 'text', text: 'thinking' });
    if (this.mode === 'tool' || this.mode === 'parallel') {
      const tasks = [this.invoke(0, { pizza: 'pepperoni' }, 'call_1')];
      if (this.mode === 'parallel') tasks.push(this.invoke(0, { pizza: 'cheese' }, 'call_2'));
      void Promise.all(tasks).then((results) => {
        this.results = results;
        this.handler?.({ type: 'text', text: 'done' });
        this.handler?.({ type: 'idle' });
      }).catch((error: unknown) => { this.errors.push(error); });
    } else this.handler?.({ type: 'idle' });
  }
  async close() { this.closed = true; }
}

class FakeRuntime implements RuntimeClient {
  sessions: FakeSession[] = [];
  constructor(readonly mode: FakeSession['mode'] = 'text') {}
  async listModels() { return [{ id: 'model', name: 'Mock model' }]; }
  async createSession(_id: string, _request: CopilotStartRequest, invoke: (index: number, args: unknown, id: string) => Promise<string>) {
    const session = new FakeSession(this.mode, invoke);
    this.sessions.push(session);
    return session;
  }
}

describe('Companion CLI selection', () => {
  it('uses the SDK default when no CLI override is configured', () => {
    assert.equal(resolveCompanionCliPath([]), undefined);
    assert.equal(resolveCompanionCliPath([], ''), undefined);
  });

  it('preserves the environment variable fallback', () => {
    assert.equal(resolveCompanionCliPath([], 'installed-cli.js'), 'installed-cli.js');
  });

  it('prefers the command-line path and preserves spaces in either argument form', () => {
    const cliPath = 'C:\\Program Files\\Copilot\\copilot.exe';
    assert.equal(resolveCompanionCliPath(['--cli-path', cliPath], 'other-cli.js'), cliPath);
    assert.equal(resolveCompanionCliPath([`--cli-path=${cliPath}`]), cliPath);
  });

  it('rejects missing or blank paths instead of using another CLI', () => {
    assert.throws(() => resolveCompanionCliPath(['--cli-path']));
    assert.throws(() => resolveCompanionCliPath(['--cli-path='], 'other-cli.js'), /non-empty path/);
    assert.throws(() => resolveCompanionCliPath(['--cli-path', '   ']), /non-empty path/);
    assert.throws(() => resolveCompanionCliPath([], '   '), /non-empty path/);
  });

  it('rejects unknown options and positional arguments', () => {
    assert.throws(() => resolveCompanionCliPath(['--cli-pth', 'installed-cli.js']));
    assert.throws(() => resolveCompanionCliPath(['installed-cli.js']));
  });
});

describe('Companion tool bridge', () => {
  it('returns text and cleans the SDK session after completion', async () => {
    const runtime = new FakeRuntime();
    const result = await new CopilotBridge(runtime).start(request, new AbortController().signal);
    assert.deepEqual(result, { sessionId: null, text: 'thinking', toolCalls: [] });
    assert.equal(runtime.sessions[0].closed, true);
    assert.ok(runtime.sessions[0].prompt.includes(JSON.stringify(request.messages)));
  });

  it('waits for browser execution instead of executing or fabricating page-tool results', async () => {
    const runtime = new FakeRuntime('tool');
    const bridge = new CopilotBridge(runtime);
    const result = await bridge.start(request, new AbortController().signal);
    assert.equal(result.toolCalls[0].name, 'order');
    assert.deepEqual(runtime.sessions[0].results, []);
    const done = await bridge.reply(result.sessionId!, [{ id: 'call_1', content: 'pizza ordered' }], new AbortController().signal);
    assert.deepEqual(runtime.sessions[0].results, ['pizza ordered']);
    assert.deepEqual(done, finalResponse);
    assert.equal(runtime.sessions[0].closed, true);
  });

  it('preserves parallel tool requests without deadlock or replaying results', async () => {
    const runtime = new FakeRuntime('parallel');
    const bridge = new CopilotBridge(runtime);
    const first = await bridge.start(request, new AbortController().signal);
    const second = await bridge.reply(first.sessionId!, [{ id: first.toolCalls[0].id, content: 'first' }], new AbortController().signal);
    assert.equal(second.toolCalls[0].id, 'call_2');
    const done = await bridge.reply(second.sessionId!, [{ id: 'call_2', content: 'second' }], new AbortController().signal);
    assert.equal(done.sessionId, null);
    assert.deepEqual(runtime.sessions[0].results, ['first', 'second']);
  });

  it('rejects unknown tool results and expires abandoned sessions', async () => {
    const runtime = new FakeRuntime('tool');
    const bridge = new CopilotBridge(runtime);
    const result = await bridge.start(request, new AbortController().signal);
    await assert.rejects(bridge.reply(result.sessionId!, [{ id: 'unknown', content: 'fake' }], new AbortController().signal), /Unknown/);
    await bridge.expire(Date.now() + 16 * 60_000);
    assert.equal(runtime.sessions[0].closed, true);
    await assert.rejects(bridge.reply(result.sessionId!, [{ id: 'call_1', content: 'late' }], new AbortController().signal), /expired/);
  });

  it('closes a runtime session when its waiting HTTP request is cancelled', async () => {
    const runtime = new FakeRuntime('hang');
    const bridge = new CopilotBridge(runtime);
    const controller = new AbortController();
    const result = bridge.start(request, controller.signal);
    controller.abort();
    await assert.rejects(result, { name: 'AbortError' });
    assert.equal(runtime.sessions[0].closed, true);
  });

  it('limits concurrent sessions and releases them on shutdown', async () => {
    const runtime = new FakeRuntime('tool');
    const bridge = new CopilotBridge(runtime);
    for (let i = 0; i < 16; i++) await bridge.start(request, new AbortController().signal);
    await assert.rejects(bridge.start(request, new AbortController().signal), /Too many/);
    await bridge.stop();
    assert.ok(runtime.sessions.every((session) => session.closed));
  });
});

describe('Companion HTTP boundary', () => {
  async function withServer(run: (url: string, runtime: FakeRuntime) => Promise<void>, mode: FakeSession['mode'] = 'text') {
    const runtime = new FakeRuntime(mode);
    const bridge = new CopilotBridge(runtime);
    const server = createCompanionServer(bridge, TOKEN);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    try { await run(`http://127.0.0.1:${address.port}`, runtime); }
    finally {
      await bridge.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  it('requires pairing even for model discovery', async () => withServer(async (url) => {
    assert.equal((await fetch(`${url}/models`)).status, 401);
    const result = await fetch(`${url}/models`, { headers });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await result.json(), { models: [{ id: 'model', name: 'Mock model' }] });
  }));

  it('allows extension preflight but denies web origins, null origins, and spoofed Host', async () => withServer(async (url) => {
    const origin = `chrome-extension://${'a'.repeat(32)}`;
    const allowed = await fetch(`${url}/models`, { method: 'OPTIONS', headers: { Origin: origin } });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get('access-control-allow-origin'), origin);
    for (const denied of ['https://evil.example', 'null', 'http://127.0.0.1:4173']) {
      assert.equal((await fetch(`${url}/models`, { headers: { ...headers, Origin: denied } })).status, 403, `Origin ${denied}`);
    }
    const status = await new Promise<number | undefined>((resolve, reject) => {
      httpGet(`${url}/models`, { headers: { ...headers, Host: 'evil.example' } }, (result) => {
        result.resume();
        resolve(result.statusCode);
      }).on('error', reject);
    });
    assert.equal(status, 403, 'Spoofed Host');
  }));

  it('enforces content type, JSON shape and the body limit', async () => withServer(async (url) => {
    assert.equal((await fetch(`${url}/sessions`, { method: 'POST', headers: { Authorization: headers.Authorization }, body: '{}' })).status, 415);
    assert.equal((await fetch(`${url}/sessions`, { method: 'POST', headers, body: '{' })).status, 400);
    assert.equal((await fetch(`${url}/sessions`, { method: 'POST', headers, body: '{}' })).status, 400);
    assert.equal((await fetch(`${url}/sessions`, { method: 'POST', headers, body: JSON.stringify({ data: 'x'.repeat(1024 * 1024) }) })).status, 413);
  }));

  it('returns only safe diagnostics when the SDK fails', async () => withServer(async (url) => {
    const result = await fetch(`${url}/sessions`, { method: 'POST', headers, body: JSON.stringify(request) });
    assert.equal(result.status, 503);
    const body = await result.text();
    assert.match(body, /CLI request failed/);
    assert.ok(!body.includes('private-runtime-details'));
  }, 'error'));

  it('supports a complete browser-provider/page-tool round trip over real loopback HTTP', async () => withServer(async (url, runtime) => {
    const provider = new GitHubCopilotProvider({ ...config, baseUrl: url });
    assert.deepEqual(await provider.listModels(), [{ value: 'model', label: 'Mock model' }]);
    const first = await provider.sendMessage(request.systemPrompt, request.messages, request.tools);
    const done = await provider.sendMessage(request.systemPrompt, [
      ...request.messages,
      { role: 'assistant', content: first.text ?? '', toolCalls: first.toolCalls },
      { role: 'tool', toolCallId: first.toolCalls[0].id, content: 'real browser result' },
    ], request.tools);
    assert.deepEqual(done, { text: 'done', toolCalls: [] });
    assert.deepEqual(runtime.sessions[0].results, ['real browser result']);
    await provider.dispose();
  }, 'tool'));

  it('cancels an in-flight HTTP turn and releases the runtime', async () => withServer(async (url, runtime) => {
    const provider = new GitHubCopilotProvider({ ...config, baseUrl: url });
    const controller = new AbortController();
    const pending = provider.sendMessage(request.systemPrompt, request.messages, request.tools, { signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    for (let i = 0; !runtime.sessions.length && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runtime.sessions.length, 1);
    controller.abort();
    await rejected;
    for (let i = 0; !runtime.sessions[0].closed && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runtime.sessions[0].closed, true);
  }, 'hang'));

  it('stops a session while the browser is waiting to execute a returned tool', async () => withServer(async (url, runtime) => {
    const provider = new GitHubCopilotProvider({ ...config, baseUrl: url });
    const controller = new AbortController();
    await provider.sendMessage(request.systemPrompt, request.messages, request.tools, { signal: controller.signal });
    controller.abort();
    for (let i = 0; !runtime.sessions[0].closed && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runtime.sessions[0].closed, true);
    assert.deepEqual(runtime.sessions[0].results, []);
  }, 'tool'));
});

describe('SDK runtime restrictions (configuration contract, not a live SDK test)', () => {
  it('allows only explicitly registered prefixed page tools and rejects ambient permissions', async () => {
    const invocations: unknown[][] = [];
    const options = createRuntimeSessionOptions(SESSION_ID, request,
      async (...args) => { invocations.push(args); return 'page result'; });
    assert.deepEqual(options.availableTools, ['webmcp_tool_0']);
    assert.deepEqual(options.onPermissionRequest(), { kind: 'reject' });
    for (const name of ['bash', 'powershell', 'read_file', 'write_file', 'task', 'web_fetch']) {
      assert.equal(options.hooks.onPreToolUse({ toolName: name }).permissionDecision, 'deny');
    }
    assert.equal(options.hooks.onPreToolUse({ toolName: 'webmcp_tool_0' }).permissionDecision, 'allow');
    assert.equal(await options.tools[0].handler({ pizza: 'cheese' }, { toolCallId: 'tool_id' }), 'page result');
    assert.deepEqual(invocations, [[0, { pizza: 'cheese' }, 'tool_id']]);
    assert.equal(options.enableConfigDiscovery, false);
    assert.deepEqual(options.mcpServers, {});
    assert.deepEqual(options.customAgents, []);
    assert.deepEqual(options.infiniteSessions, { enabled: false });
    assert.equal(Object.hasOwn(options, 'configDir'), false);
  });

  it('has no allowed tools for plain chat, even if the runtime has built-ins', () => {
    const options = createRuntimeSessionOptions(SESSION_ID, { ...request, tools: [] },
      async () => { assert.fail('Must not invoke tools'); });
    assert.deepEqual(options.availableTools, []);
    assert.equal(options.hooks.onPreToolUse({ toolName: 'bash' }).permissionDecision, 'deny');
  });
});

describe('Browser provider validation and lifecycle', () => {
  for (const baseUrl of ['https://example.com', 'http://localhost:8787', 'http://127.0.0.1:8787/proxy', 'http://user:pass@127.0.0.1:8787', 'http://127.0.0.1:8787/?token=x']) {
    it(`rejects unsupported service address ${baseUrl}`, () => {
      assert.throws(() => new GitHubCopilotProvider({ ...config, baseUrl }), /loopback/);
    });
  }
  it('rejects short pairing tokens and GitHub credentials', () => {
    for (const token of ['', 'weak', 'gho_' + 'x'.repeat(50), 'github_pat_' + 'x'.repeat(50)]) {
      assert.throws(() => new GitHubCopilotProvider({ ...config, serviceToken: token }), /pairing token/);
    }
  });

  it('passes only browser results for pending tools and closes an unfinished session', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const queued = [response(toolResponse), new Response(null, { status: 204 })];
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      const result = queued.shift();
      assert.ok(result);
      return result;
    });
    try {
      const provider = new GitHubCopilotProvider(config);
      await provider.sendMessage(request.systemPrompt, request.messages, request.tools);
      await provider.dispose();
      assert.equal(requests[1].init?.method, 'DELETE');
      assert.equal(requests[1].url, `${config.baseUrl}/sessions/${SESSION_ID}`);
      assert.equal(requests[0].init?.redirect, 'error');
      assert.equal(new Headers(requests[0].init?.headers).get('Authorization'), `Bearer ${TOKEN}`);
    } finally { mock.restoreAll(); }
  });

  it('rejects malformed model lists and reports companion authentication errors', async () => {
    const provider = new GitHubCopilotProvider(config);
    const queued = [response({ models: [] }), response({ error: 'Invalid companion pairing token.' }, 401)];
    mock.method(globalThis, 'fetch', async () => queued.shift()!);
    try {
      await assert.rejects(provider.listModels(), /invalid model list/);
      await assert.rejects(provider.listModels(), /Invalid companion pairing token/);
    } finally { mock.restoreAll(); }
  });

  it('waits for cancellation cleanup when dispose is called again', async () => {
    let finish!: (response: Response) => void;
    mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Promise<Response>((resolve) => { finish = resolve; });
      return response(toolResponse);
    });
    try {
      const provider = new GitHubCopilotProvider(config);
      const controller = new AbortController();
      await provider.sendMessage(request.systemPrompt, request.messages, request.tools, { signal: controller.signal });
      controller.abort();
      let closed = false;
      const cleanup = provider.dispose().then(() => { closed = true; });
      await Promise.resolve();
      assert.equal(closed, false);
      finish(new Response(null, { status: 204 }));
      await cleanup;
      assert.equal(closed, true);
    } finally { mock.restoreAll(); }
  });

  it('validates transcripts, results, and session identifiers at the boundary', () => {
    assert.throws(() => parseStartRequest({ ...request, tools: [request.tools[0], request.tools[0]] }), /Invalid/);
    assert.throws(() => parseToolResults({ results: [{ id: 'id', content: 'x' }, { id: 'id', content: 'y' }] }), /Invalid/);
    assert.throws(() => parseServiceResponse({ ...toolResponse, sessionId: '../../not-a-session' }), /invalid response/);
    assert.throws(() => parseServiceResponse({ ...finalResponse, sessionId: SESSION_ID }), /invalid response/);
  });
});

describe('Legacy credential migration', () => {
  it('removes the previous direct-endpoint provider and GitHub token, preserving unrelated settings', async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    const legacy = { provider: 'github-copilot', apiKey: 'gho_legacySecret', model: 'old' };
    const stored = {
      provider: legacy,
      providerConfigs: { 'github-copilot': legacy, openai: { provider: 'openai', apiKey: 'keep', model: 'keep' } },
      maxIterations: 17, maxChatMessages: 41,
    };
    let saved: unknown;
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { storage: { local: {
      get: async () => ({ 'webmcp-explorer-config': structuredClone(stored) }),
      set: async (value: unknown) => { saved = value; },
    } } } });
    try {
      const result = await loadConfig();
      assert.equal(result.provider, null);
      assert.equal(result.providerConfigs['github-copilot'], undefined);
      assert.equal(result.providerConfigs.openai.apiKey, 'keep');
      assert.equal(result.maxIterations, 17);
      assert.ok(!JSON.stringify(saved).includes('gho_legacySecret'));
      assert.ok(saved);
    } finally {
      if (previous) Object.defineProperty(globalThis, 'chrome', previous);
      else Reflect.deleteProperty(globalThis, 'chrome');
    }
  });
});

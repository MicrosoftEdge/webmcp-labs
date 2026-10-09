// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { PromptApiProvider, providerMetadata } from '../src/lib/llm/prompt-api.ts';

class LanguageModelToolCall {
  constructor(options) { Object.assign(this, { arguments: null }, options); }
}
class LanguageModelToolSuccess {
  constructor(options) { Object.assign(this, options); }
}
class LanguageModelToolError {
  constructor(options) { Object.assign(this, options); }
}

const tool = {
  name: 'lookup',
  description: 'Look up a value',
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
};
const userMessage = { role: 'user', content: 'Look up hello' };
const assistantMessage = {
  role: 'assistant', content: 'Looking it up',
  toolCalls: [{ id: 'call-1', name: 'lookup', arguments: '{"value":"hello"}' }],
};
const toolMessage = { role: 'tool', toolCallId: 'call-1', content: 'found' };
const textResponse = [{ type: 'text', value: 'Done' }];
const globalNames = ['LanguageModel', 'LanguageModelToolCall', 'LanguageModelToolSuccess', 'LanguageModelToolError'];
const originalGlobals = new Map(globalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let availabilityOptions;
let sessions;
let response;
let provider;

beforeEach(() => {
  availabilityOptions = [];
  sessions = [];
  response = textResponse;
  provider = new PromptApiProvider();
  Object.assign(globalThis, {
    LanguageModel: {
      async availability(options) {
        availabilityOptions.push(options);
        return 'available';
      },
      async create(options) {
        const session = {
          options,
          prompts: [],
          destroyed: 0,
          async prompt(messages, promptOptions) {
            this.prompts.push({ messages, options: promptOptions });
            return response;
          },
          destroy() { this.destroyed++; },
        };
        sessions.push(session);
        return session;
      },
    },
    LanguageModelToolCall, LanguageModelToolSuccess, LanguageModelToolError,
  });
});

afterEach(() => {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

function send(messages = [userMessage], tools = [tool], options) {
  return provider.sendMessage('System instructions', messages, tools, options);
}

test('factory is lightweight: saving configuration does not load or download a model', async () => {
  delete globalThis.LanguageModel;
  const instance = await providerMetadata.createProvider({ provider: 'prompt-api' });
  assert.ok(instance instanceof PromptApiProvider);
  assert.deepEqual(providerMetadata.fields, []);
  assert.equal(sessions.length, 0);
});

test('accepts text-only answers in native content arrays', async () => {
  const controller = new AbortController();
  const result = await send([userMessage], [], { signal: controller.signal });
  assert.deepEqual(result, { text: 'Done', toolCalls: [] });
  const [session] = sessions;
  assert.deepEqual(session.options.initialPrompts, [{ role: 'system', content: 'System instructions' }]);
  assert.deepEqual(session.options.tools, []);
  assert.deepEqual(session.options.expectedInputs, [{ type: 'text' }, { type: 'tool-call' }, { type: 'tool-response' }]);
  assert.deepEqual(session.options.expectedOutputs, [{ type: 'text' }, { type: 'tool-call' }]);
  assert.deepEqual(session.prompts[0].messages, [userMessage]);
  assert.equal(session.options.signal, controller.signal);
  assert.equal(session.prompts[0].options.signal, controller.signal);
  assert.equal(session.destroyed, 1);
  assert.deepEqual(availabilityOptions[0].tools, session.options.tools);
});

for (const text of ['Done', '{"toolCalls":[{"name":"lookup","arguments":{}}]}']) {
  test(`treats string response as text only, never as tool calls: ${text}`, async () => {
    response = text;
    assert.deepEqual(await send(), { text, toolCalls: [] });
    assert.equal(sessions[0].destroyed, 1);
  });
}

test('reads native tool-call getter properties even when JSON serialization is empty', async () => {
  const nativeCall = Object.create({
    get callId() { return 'native-getter-id'; },
    get name() { return 'lookup'; },
    get arguments() { return { value: 'hello' }; },
  });
  assert.equal(JSON.stringify(nativeCall), '{}');
  response = [{ type: 'tool-call', value: nativeCall }];
  assert.deepEqual(await send(), {
    text: null,
    toolCalls: [{ id: 'native-getter-id', name: 'lookup', arguments: '{"value":"hello"}' }],
  });
});

test('maps native text and multiple tool calls without executing them', async () => {
  response = [
    { type: 'text', value: 'Looking ' },
    { type: 'text', value: 'up' },
    { type: 'tool-call', value: new LanguageModelToolCall({ callId: 'a', name: 'lookup', arguments: { value: 'hello' } }) },
    { type: 'tool-call', value: new LanguageModelToolCall({ callId: 'b', name: 'lookup' }) },
  ];
  assert.deepEqual(await send(), {
    text: 'Looking up',
    toolCalls: [
      { id: 'a', name: 'lookup', arguments: '{"value":"hello"}' },
      { id: 'b', name: 'lookup', arguments: '{}' },
    ],
  });
  assert.deepEqual(sessions[0].options.tools, [{ name: tool.name, description: tool.description, inputSchema: tool.parameters }]);
});

test('maps missing parameter schemas to an empty object schema', async () => {
  await send([userMessage], [{ name: 'no_arguments', description: 'No arguments' }]);
  assert.deepEqual(sessions[0].options.tools[0].inputSchema, { type: 'object', properties: {} });
});

test('replays assistant calls and groups success/error results with matching IDs and names', async () => {
  const messages = [
    userMessage,
    { ...assistantMessage, toolCalls: [
      ...assistantMessage.toolCalls,
      { id: 'call-2', name: 'lookup', arguments: '{"value":"world"}' },
    ] },
    { ...toolMessage, content: 'Error: this is literal successful output' },
    { role: 'tool', toolCallId: 'call-2', content: 'Failed to look up', isError: true },
  ];
  await send(messages);
  const prompts = sessions[0].prompts[0].messages;
  assert.equal(prompts.length, 3);
  assert.equal(prompts[1].role, 'assistant');
  assert.equal(prompts[1].content[0].value, 'Looking it up');
  assert.ok(prompts[1].content[1].value instanceof LanguageModelToolCall);
  assert.deepEqual(prompts[1].content[1].value.arguments, { value: 'hello' });
  assert.equal(prompts[2].role, 'user');
  assert.equal(prompts[2].content.length, 2);
  assert.ok(prompts[2].content[0].value instanceof LanguageModelToolSuccess);
  assert.deepEqual(prompts[2].content[0].value, new LanguageModelToolSuccess({
    callId: 'call-1', name: 'lookup', result: [{ type: 'text', value: 'Error: this is literal successful output' }],
  }));
  assert.ok(prompts[2].content[1].value instanceof LanguageModelToolError);
  assert.deepEqual(prompts[2].content[1].value, new LanguageModelToolError({
    callId: 'call-2', name: 'lookup', errorMessage: 'Failed to look up',
  }));
});

test('uses a fresh session and current tool definitions for every round', async () => {
  await send();
  await send([userMessage, assistantMessage, toolMessage], [{ ...tool, description: 'Updated description' }]);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].prompts.length, 1);
  assert.equal(sessions[1].prompts.length, 1);
  assert.equal(sessions[1].options.tools[0].description, 'Updated description');
  assert.ok(sessions.every(session => session.destroyed === 1));
});

test('completes a native tool request, application result, and final-answer round trip', async () => {
  response = [{
    type: 'tool-call',
    value: new LanguageModelToolCall({ callId: 'opaque-native-id', name: 'lookup', arguments: { value: 'hello' } }),
  }];
  const request = await send();
  assert.equal(request.text, null);
  const [call] = request.toolCalls;
  assert.deepEqual(JSON.parse(call.arguments), { value: 'hello' });
  response = [{ type: 'text', value: 'The result was found.' }];
  const completion = await send([
    userMessage,
    { role: 'assistant', content: request.text ?? '', toolCalls: request.toolCalls },
    { role: 'tool', toolCallId: call.id, content: 'found' },
  ]);
  const replay = sessions[1].prompts[0].messages;
  assert.equal(replay[1].content[0].value.callId, 'opaque-native-id');
  assert.deepEqual(replay[2].content[0].value, new LanguageModelToolSuccess({
    callId: 'opaque-native-id', name: 'lookup', result: [{ type: 'text', value: 'found' }],
  }));
  assert.deepEqual(completion, { text: 'The result was found.', toolCalls: [] });
  assert.ok(sessions.every(session => session.destroyed === 1));
});

test('completes the Edge native-call then plain-string final-answer round trip', async () => {
  response = [{
    type: 'tool-call',
    value: new LanguageModelToolCall({ callId: 'edge-native-id', name: 'lookup', arguments: { value: 'hello' } }),
  }];
  const request = await send();
  response = 'The test_tool function was called with "hello" and returned a success response: **prompt-api-test-ok**.';
  const completion = await send([
    userMessage,
    { role: 'assistant', content: '', toolCalls: request.toolCalls },
    { role: 'tool', toolCallId: 'edge-native-id', content: 'prompt-api-test-ok' },
  ]);
  assert.deepEqual(completion, { text: response, toolCalls: [] });
  const nativeResult = sessions[1].prompts[0].messages.at(-1).content[0].value;
  assert.ok(nativeResult instanceof LanguageModelToolSuccess);
  assert.equal(nativeResult.callId, 'edge-native-id');
  assert.deepEqual(nativeResult.result, [{ type: 'text', value: 'prompt-api-test-ok' }]);
  assert.ok(sessions.every(session => session.destroyed === 1));
});

for (const missingGlobal of globalNames) {
  test(`missing ${missingGlobal} produces an explicit error without creating a session`, async () => {
    delete globalThis[missingGlobal];
    await assert.rejects(send(), /Prompt API.*not available/);
    assert.equal(sessions.length, 0);
  });
}

test('unavailable native capabilities do not create a session', async () => {
  globalThis.LanguageModel.availability = async () => 'unavailable';
  await assert.rejects(send(), /native tool calling is unavailable/);
  assert.equal(sessions.length, 0);
});

test('unsupported modalities give an actionable error with no fallback', async () => {
  globalThis.LanguageModel.availability = async () => { throw new DOMException('tool-call unsupported', 'NotSupportedError'); };
  await assert.rejects(send(), /native tool calling.*no fallback.*tool-call unsupported/is);
  assert.equal(sessions.length, 0);
});

test('session creation refusing native tools does not retry with reduced capabilities', async () => {
  let createCalls = 0;
  globalThis.LanguageModel.create = async () => {
    createCalls++;
    throw new DOMException('Native tools unsupported', 'NotSupportedError');
  };
  await assert.rejects(send(), /native tool calling.*no fallback/is);
  assert.equal(createCalls, 1);
});

test('download/permission failures explain how to prepare the model', async () => {
  globalThis.LanguageModel.create = async () => { throw new DOMException('Activation needed', 'NotAllowedError'); };
  await assert.rejects(send(), /Click Test Connection in Config/);
});

test('model download status and normalized progress reach the caller', async () => {
  globalThis.LanguageModel.availability = async () => 'downloadable';
  const create = globalThis.LanguageModel.create;
  globalThis.LanguageModel.create = async options => {
    options.monitor({
      addEventListener(type, listener) {
        assert.equal(type, 'downloadprogress');
        listener({ loaded: 0.25 });
        listener({ loaded: 1 });
      },
    });
    return create(options);
  };
  const statuses = [];
  await send([userMessage], [tool], { onStatus: status => statuses.push(status) });
  assert.deepEqual(statuses, [
    'Checking built-in model availability...',
    'Downloading the built-in model. This may take a few minutes...',
    'Downloading the built-in model: 25%',
    'Downloading the built-in model: 100%',
    'Generating response...',
  ]);
});

test('already-aborted requests do not query availability', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(send([userMessage], [tool], { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(availabilityOptions.length, 0);
});

test('abort during availability prevents session creation', async () => {
  const controller = new AbortController();
  globalThis.LanguageModel.availability = async () => {
    controller.abort();
    return 'available';
  };
  await assert.rejects(send([userMessage], [tool], { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(sessions.length, 0);
});

test('Stop rejects pending availability immediately and ignores its late result', async () => {
  const controller = new AbortController();
  let resolveAvailability;
  globalThis.LanguageModel.availability = () => new Promise(resolve => { resolveAvailability = resolve; });
  const pending = send([userMessage], [tool], { signal: controller.signal });
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await rejection;
  resolveAvailability('available');
  await Promise.resolve();
  assert.equal(sessions.length, 0);
});

test('availability times out at 30 seconds without loading a model afterward', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveAvailability;
  globalThis.LanguageModel.availability = () => new Promise(resolve => { resolveAvailability = resolve; });
  let settled = false;
  const pending = send().finally(() => { settled = true; });
  const rejection = assert.rejects(pending, /availability check timed out after 30 seconds.*retry Test Connection/);
  context.mock.timers.tick(29_999);
  await Promise.resolve();
  assert.equal(settled, false);
  context.mock.timers.tick(1);
  await rejection;
  resolveAvailability('available');
  await Promise.resolve();
  assert.equal(sessions.length, 0);
});

test('a late availability rejection after Stop is handled', async () => {
  const controller = new AbortController();
  let rejectAvailability;
  globalThis.LanguageModel.availability = () => new Promise((_resolve, reject) => { rejectAvailability = reject; });
  const pending = send([userMessage], [tool], { signal: controller.signal });
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await rejection;
  rejectAvailability(new Error('Model service disconnected'));
  await Promise.resolve();
  assert.equal(sessions.length, 0);
});

test('a session returned after cancellation is destroyed without inference', async () => {
  const controller = new AbortController();
  const create = globalThis.LanguageModel.create;
  globalThis.LanguageModel.create = async options => {
    const session = await create(options);
    controller.abort();
    return session;
  };
  await assert.rejects(send([userMessage], [tool], { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(sessions[0].prompts.length, 0);
  assert.equal(sessions[0].destroyed, 1);
});

test('cancellation during inference destroys the session and discards its answer', async () => {
  const controller = new AbortController();
  const create = globalThis.LanguageModel.create;
  globalThis.LanguageModel.create = async options => {
    const session = await create(options);
    session.prompt = async () => {
      controller.abort();
      return textResponse;
    };
    return session;
  };
  await assert.rejects(send([userMessage], [tool], { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(sessions[0].destroyed, 1);
});

test('inference failures propagate and release the session', async () => {
  const failure = new DOMException('Context is too large', 'QuotaExceededError');
  const create = globalThis.LanguageModel.create;
  globalThis.LanguageModel.create = async options => {
    const session = await create(options);
    session.prompt = async () => { throw failure; };
    return session;
  };
  await assert.rejects(send(), error => error === failure);
  assert.equal(sessions[0].destroyed, 1);
});

for (const [name, invalidResponse] of [
  ['empty string', ''],
  ['whitespace string', ' \n\t '],
  ['unexpected response object', { toolCalls: [] }],
  ['empty content', []],
  ['null content', [null]],
  ['unsupported content', [{ type: 'image', value: 'image' }]],
  ['unknown tool', [{ type: 'tool-call', value: { callId: 'a', name: 'unknown', arguments: {} } }]],
  ['array arguments', [{ type: 'tool-call', value: { callId: 'a', name: 'lookup', arguments: [] } }]],
  ['missing call ID', [{ type: 'tool-call', value: { name: 'lookup', arguments: {} } }]],
  ['duplicate call IDs', [
    { type: 'tool-call', value: { callId: 'a', name: 'lookup', arguments: {} } },
    { type: 'tool-call', value: { callId: 'a', name: 'lookup', arguments: {} } },
  ]],
]) {
  test(`rejects ${name} rather than silently returning a successful response`, async () => {
    response = invalidResponse;
    await assert.rejects(send(), /Prompt API/);
    assert.equal(sessions[0].destroyed, 1);
  });
}

for (const [name, messages] of [
  ['orphan result', [userMessage, toolMessage]],
  ['unanswered call', [userMessage, assistantMessage]],
  ['unanswered call before another user message', [userMessage, assistantMessage, userMessage]],
  ['invalid argument JSON', [userMessage, { ...assistantMessage, toolCalls: [{ id: 'a', name: 'lookup', arguments: 'bad json' }] }]],
  ['non-object arguments', [userMessage, { ...assistantMessage, toolCalls: [{ id: 'a', name: 'lookup', arguments: '[]' }] }]],
]) {
  test(`rejects history with ${name} before starting inference`, async () => {
    await assert.rejects(send(messages));
    assert.equal(sessions.length, 0);
  });
}

test('rejects duplicate tools and non-object schemas before starting inference', async () => {
  await assert.rejects(send([userMessage], [tool, tool]), /unique name/);
  await assert.rejects(send([userMessage], [{ ...tool, parameters: { type: 'array' } }]), /object input schema/);
  assert.equal(sessions.length, 0);
});

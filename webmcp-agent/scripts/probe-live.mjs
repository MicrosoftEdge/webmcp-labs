// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
// Explicit opt-in: synthetic data only; at most three model prompts per run.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compatibilitySessionConfig, createIsolatedClient } from '../host/dist/copilot.js';

if (!process.argv.includes('--allow-model-calls')) throw new Error('Pass --allow-model-calls to consume model quota.');
const directory = await mkdtemp(join(tmpdir(), 'webmcp-agent-live-'));
const workspace = join(directory, 'workspace');
await mkdir(workspace);
const client = createIsolatedClient(join(directory, 'copilot-home'), workspace);
let session;
let sessionId;
let calls = 0;
let questions = 0;
const errors = [];
const watchdog = setTimeout(() => {
  console.error('Live probe timed out.');
  void client.forceStop().finally(() => process.exit(1));
}, 180000);
try {
  await client.start();
  assert((await client.getAuthStatus()).isAuthenticated, 'Not signed in');
  const models = await client.listModels();
  const model = models.find(model => model.id === 'gpt-4.1')?.id ??
    models.find(model => model.id === 'gpt-5-mini')?.id ?? models[0]?.id;
  assert(model, 'No models available');
  console.log('Probe model:', model);
  const config = { ...compatibilitySessionConfig(), model, availableTools: ['custom:*', 'builtin:ask_user'] };
  config.tools[0].description = 'Returns the synthetic test code. Call this tool to obtain the code; do not guess.';
  config.onUserInputRequest = request => {
    questions++;
    console.log('Question callback received; answering synthetic choice.');
    return { answer: request.choices?.[0] ?? 'Blue', wasFreeform: !request.choices?.length };
  };
  const subscribe = () => session.on(event => {
    if (event.agentId) return;
    if (event.type === 'session.error') errors.push(event.data);
    if (event.type === 'external_tool.requested') {
      calls++;
      void session.rpc.tools.handlePendingToolCall({
        requestId: event.data.requestId,
        result: { textResultForLlm: 'SYNTHETIC-CODE-8472', resultType: 'success' },
      }).catch(error => errors.push(String(error)));
    }
  });
  session = await client.createSession(config);
  sessionId = session.sessionId;
  let unsubscribe = subscribe();
  await session.sendAndWait({
    prompt: 'Synthetic compatibility check. Call webmcp_probe exactly once and tell me its code. Do not use any other tool.',
    displayPrompt: 'Run the synthetic tool check.',
  }, 60000);
  assert.equal(calls, 1, JSON.stringify(errors));
  console.log('PASS: external_tool.requested and handlePendingToolCall round trip.');
  await session.sendAndWait({
    prompt: 'Use ask_user to ask which synthetic color I prefer, Blue or Green. Do not guess or answer without invoking ask_user.',
  }, 60000);
  console.log('Question callback count with explicit ask_user exception:', questions);
  assert(questions > 0, 'ask_user callback was not received');
  await session.setModel(model);
  const events = await session.getEvents();
  assert(events.some(event => event.type === 'assistant.message'));
  assert(events.some(event => event.type === 'user.message'));
  unsubscribe();
  await session.disconnect();
  const { sessionId: ignored, ...resumeConfig } = config;
  session = await client.resumeSession(sessionId, resumeConfig);
  unsubscribe = subscribe();
  await session.sendAndWait({ prompt: 'What synthetic code did the tool return earlier? Reply with only the code, without calling tools.' }, 60000);
  const restored = await session.getEvents();
  assert(restored.some(event => event.type === 'assistant.message' && event.data.content.includes('SYNTHETIC-CODE-8472')));
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log('PASS: questions, setModel, populated history, resume and code recall.');
  unsubscribe();
} finally {
  clearTimeout(watchdog);
  try {
    if (session) await session.disconnect();
    if (sessionId) await client.deleteSession(sessionId);
  } finally {
    await client.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

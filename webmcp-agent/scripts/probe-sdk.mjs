// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compatibilitySessionConfig, createIsolatedClient, SDK_VERSION } from '../host/dist/copilot.js';

const directory = await mkdtemp(join(tmpdir(), 'webmcp-agent-probe-'));
const home = join(directory, 'copilot-home');
const workspace = join(directory, 'workspace');
await mkdir(home);
await mkdir(workspace);
const client = createIsolatedClient(home, workspace);
let session;
let sessionId;
const timeout = setTimeout(() => {
  console.error('SDK probe exceeded 60 seconds; terminating its owned runtime.');
  void client.forceStop().finally(() => process.exit(1));
}, 60_000);

try {
  console.log(`Checking SDK ${SDK_VERSION} with a temporary, isolated home. No model prompt is sent.`);
  await client.start();
  const status = await client.getStatus();
  console.log(`Runtime started: ${status.version}; protocol ${status.protocolVersion}.`);
  const authentication = await client.getAuthStatus();
  console.log(`Authentication available: ${authentication.isAuthenticated}; source: ${authentication.authType ?? 'none'}.`);
  const configuration = compatibilitySessionConfig();
  session = await client.createSession(configuration);
  sessionId = session.sessionId;
  assert(sessionId.startsWith('webmcp-agent-'));
  console.log('Created an empty-mode session with page tools, the ask_user exception, and customize-mode prompt sections.');
  await session.setTools(configuration.tools ?? []);
  await session.setTools([]);
  await session.setTools(configuration.tools ?? []);
  console.log('setTools() accepted replacement, removal, and restoration.');
  const events = await session.getEvents();
  console.log(`getEvents() returned ${events.length} events without a model call.`);
  await session.log('WebMCP Agent metadata persistence probe');
  assert((await session.getEvents()).some(event => event.type === 'session.info' && event.data.message === 'WebMCP Agent metadata persistence probe'));
  console.log('SDK-owned metadata log persistence verified.');
  assert.equal(typeof session.rpc.tools.handlePendingToolCall, 'function');
  assert.equal(typeof session.setModel, 'function');
  assert.equal(typeof session.abort, 'function');
  await session.disconnect();
  session = undefined;
  const { sessionId: unusedSessionId, ...resumeConfiguration } = configuration;
  session = await client.resumeSession(sessionId, resumeConfiguration);
  assert.equal(session.sessionId, sessionId);
  console.log('Disconnected and resumed the session, supplying tools and handlers again.');
  const sessions = await client.listSessions();
  assert(sessions.some(entry => entry.sessionId === sessionId));
  const saved = await readdir(join(home, 'session-state'));
  assert(saved.includes(sessionId), 'Session must be stored under the isolated home');
  console.log('Session listing and persistence under the isolated home verified.');
  console.log('This no-model probe does not exercise live tool/question calls or browser integration; see README for those verification results.');
} catch (error) {
  console.error('SDK compatibility probe failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  try {
    if (session) await session.disconnect();
    if (sessionId) await client.deleteSession(sessionId);
  } catch (error) {
    console.error('Probe session cleanup failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  try {
    const errors = await client.stop();
    if (errors.length) throw new AggregateError(errors, 'Runtime shutdown failed');
  } catch (error) {
    console.error('Probe runtime cleanup failed:', error instanceof Error ? error.message : String(error));
    await client.forceStop();
    process.exitCode = 1;
  }
  await rm(directory, { recursive: true, force: true });
}

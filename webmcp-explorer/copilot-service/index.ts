// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotBridge } from './bridge.js';
import { createCompanionServer } from './server.js';
import { resolveCompanionCliPath } from './runtime-config.js';

async function main() {
  const cliPath = resolveCompanionCliPath(process.argv.slice(2), process.env.WEBMCP_COPILOT_CLI_PATH);
  const port = Number(process.env.WEBMCP_COPILOT_PORT ?? '8787');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WEBMCP_COPILOT_PORT must be between 1 and 65535.');
  const token = process.env.WEBMCP_COPILOT_SERVICE_TOKEN ?? randomBytes(32).toString('base64url');
  const workspace = await mkdtemp(join(tmpdir(), 'webmcp-copilot-'));
  const removeWorkspace = () => rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  let runtime: import('./runtime.js').CopilotRuntime | undefined;
  try {
    const { CopilotRuntime } = await import('./runtime.js');
    runtime = new CopilotRuntime(workspace, cliPath);
    await runtime.start();
    const bridge = new CopilotBridge(runtime);
    const server = createCompanionServer(bridge, token);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const timer = setInterval(() => {
      void bridge.expire().catch((error) => console.error('Copilot session expiry cleanup failed:', error));
    }, 60_000);
    timer.unref();
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(timer);
      const errors: unknown[] = [];
      const closing = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const cleanup of [
        () => bridge.stop(),
        () => runtime!.stop(),
        removeWorkspace,
      ]) {
        try { await cleanup(); } catch (error) { errors.push(error); }
      }
      server.closeAllConnections();
      await closing;
      if (errors.length) throw new AggregateError(errors, 'Companion shutdown failed.');
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void shutdown().catch((error) => { console.error(error); process.exitCode = 1; });
      });
    }
    server.on('error', (error) => {
      console.error('Copilot companion HTTP server failed:', error.message);
      void shutdown().catch((cleanupError) => console.error('Companion shutdown failed:', cleanupError));
      process.exitCode = 1;
    });
    console.log(`Copilot companion listening at http://127.0.0.1:${port}`);
    console.log(`Service pairing token: ${token}`);
    console.log('Keep this token private. GitHub sign-in is managed by the official Copilot CLI.');
  } catch (error) {
    for (const cleanup of [() => runtime?.stop(), removeWorkspace]) {
      try { await cleanup(); }
      catch (cleanupError) { console.error('Companion startup cleanup failed:', cleanupError); }
    }
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error('Could not start the Copilot companion. Run npm install and npm run build in copilot-service, and sign in using the official Copilot CLI.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

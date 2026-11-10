// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createIsolatedClient, compatibilitySessionConfig } from '../host/dist/copilot.js';
import { dataDirectory } from '../host/dist/paths.js';

const directory = dataDirectory();
const workspace = join(directory, 'workspace');
mkdirSync(workspace, { recursive: true });
const client = createIsolatedClient(join(directory, 'copilot-home'), workspace);
let session;
let flowId;
const terminal = createInterface({ input: process.stdin, output: process.stdout });
const interrupted = async () => {
  if (flowId && session) await session.rpc.accounts.login.cancel({ flowId });
  terminal.close();
};
process.once('SIGINT', () => { void interrupted().finally(() => { process.exitCode = 1; }); });
try {
  await client.start();
  if ((await client.getAuthStatus()).isAuthenticated) {
    console.log("WebMCP Agent is signed in. Existing GitHub CLI credentials can be used without another login.");
  } else {
    console.log("Signing in to WebMCP Agent's separate home. Normal Copilot CLI sessions are not used.");
    session = await client.createSession({ ...compatibilitySessionConfig(), tools: [], availableTools: [] });
    const begun = await session.rpc.accounts.login.begin({ kind: 'githubDotCom' });
    flowId = begun.flowId;
    let step = begun.step;
    for (let count = 0; count < 300; count++) {
      if (step.kind === 'error') throw new Error(step.message);
      if (step.kind === 'completed') {
        if (step.result.status !== 'completed') throw new Error(`Sign-in needs additional account or secure-storage setup (${step.result.status}). No plaintext token consent was granted. Use gh auth login or configure a secure credential store.`);
        console.log('WebMCP Agent sign-in completed.');
        flowId = undefined;
        break;
      }
      if (step.kind === 'open-url') console.log(`Open this sign-in URL in your browser:\n${step.url}`);
      if (step.kind === 'needs-interaction') console.log('Complete the sign-in in the browser or account dialog.');
      const input = step.kind === 'input-required' ? await terminal.question(step.prompt + ' ') : undefined;
      if (step.kind === 'awaiting') await new Promise(resolve => setTimeout(resolve, 1000));
      step = await session.rpc.accounts.login.advance({ flowId, ...(input === undefined ? {} : { input }) });
    }
    if (flowId) throw new Error('Sign-in timed out. Run npm run login to try again.');
  }
} finally {
  if (flowId && session) await session.rpc.accounts.login.cancel({ flowId });
  if (session) { await session.disconnect(); await client.deleteSession(session.sessionId); }
  terminal.close();
  await client.stop();
}

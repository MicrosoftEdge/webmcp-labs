// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CopilotClient } from '@github/copilot-sdk';
import type { CopilotStartRequest } from '../src/lib/llm/copilot-protocol.js';
import type { RuntimeClient, RuntimeEvent } from './bridge.js';
import { createRuntimeSessionOptions } from './runtime-config.js';

export class CopilotRuntime implements RuntimeClient {
  private readonly client: CopilotClient;
  constructor(workspace: string, cliPath?: string) {
    this.client = new CopilotClient({
      cwd: workspace,
      useLoggedInUser: true,
      ...(cliPath ? { cliPath } : {}),
    });
  }

  async start() {
    await this.client.start();
    if (!(await this.client.getAuthStatus()).isAuthenticated) {
      throw new Error('The Copilot CLI selected by this service is not signed in. If copilot login already succeeded, pass --cli-path <path> (or set WEBMCP_COPILOT_CLI_PATH) to select that same installation\'s executable or JavaScript entry point, then restart the service.');
    }
  }

  async listModels() {
    return (await this.client.listModels()).filter((model) => !model.policy || model.policy.state === 'enabled')
      .map((model) => ({ id: model.id, name: model.name }));
  }

  async createSession(
    id: string,
    request: CopilotStartRequest,
    invokeTool: (index: number, args: unknown, callId: string) => Promise<string>,
  ) {
    const session = await this.client.createSession(createRuntimeSessionOptions(id, request, invokeTool));
    return {
      onEvent: (handler: (event: RuntimeEvent) => void) => session.on((event) => {
        if (event.type === 'assistant.message') handler({ type: 'text', text: event.data.content });
        else if (event.type === 'session.idle') handler({ type: 'idle' });
        else if (event.type === 'session.error') handler({ type: 'error', error: new Error(event.data.message) });
      }),
      send: async (prompt: string) => { await session.send({ prompt }); },
      close: async () => {
        const errors: unknown[] = [];
        for (const cleanup of [
          () => session.abort(),
          () => session.disconnect(),
          () => this.client.deleteSession(session.sessionId),
        ]) {
          try { await cleanup(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'Could not fully clean up the Copilot runtime session.');
      },
    };
  }

  async stop() {
    const errors = await this.client.stop();
    if (Array.isArray(errors) && errors.length) throw new AggregateError(errors, 'Copilot runtime shutdown failed.');
  }
}

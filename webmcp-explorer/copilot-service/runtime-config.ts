// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { parseArgs } from 'node:util';
import type { CopilotStartRequest } from '../src/lib/llm/copilot-protocol.js';

export function resolveCompanionCliPath(argumentsList: string[], environmentCliPath?: string): string | undefined {
  const { values } = parseArgs({
    args: argumentsList,
    options: { 'cli-path': { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  const cliPath = values['cli-path'] ?? (environmentCliPath || undefined);
  if (cliPath !== undefined && !cliPath.trim()) {
    throw new Error('--cli-path (or WEBMCP_COPILOT_CLI_PATH) must be a non-empty path.');
  }
  return cliPath;
}

export function createRuntimeSessionOptions(
  id: string,
  request: CopilotStartRequest,
  invokeTool: (index: number, args: unknown, callId: string) => Promise<string>,
) {
  const tools = request.tools.map((tool, index) => ({
    name: `webmcp_tool_${index}`,
    description: `${tool.name}: ${tool.description}`,
    parameters: tool.parameters ?? { type: 'object', properties: {} },
    skipPermission: true,
    handler: (args: unknown, invocation: { toolCallId: string }) => invokeTool(index, args, invocation.toolCallId),
  }));
  const allowedTools = new Set(tools.map((tool) => tool.name));
  // SDK deleteSession uses the CLI's configured store, so do not override configDir.
  return {
    sessionId: id,
    clientName: 'webmcp-explorer',
    model: request.model,
    systemMessage: {
      mode: 'replace' as const,
      content: request.systemPrompt + '\nTool aliases (invoke the SDK name when instructions mention an original name): ' +
        JSON.stringify(request.tools.map((tool, index) => ({ original: tool.name, sdk: `webmcp_tool_${index}` }))),
    },
    tools,
    availableTools: [...allowedTools],
    onPermissionRequest: () => ({ kind: 'reject' as const }),
    hooks: {
      onPreToolUse: (input: { toolName: string }) => ({
        permissionDecision: allowedTools.has(input.toolName) ? 'allow' as const : 'deny' as const,
        permissionDecisionReason: 'Only explicitly registered WebMCP page tools may run.',
      }),
    },
    enableConfigDiscovery: false,
    mcpServers: {},
    skillDirectories: [],
    customAgents: [],
    infiniteSessions: { enabled: false },
  };
}

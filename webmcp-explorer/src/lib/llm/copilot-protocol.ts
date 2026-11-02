// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { LLMResponse, Message, ToolCall, ToolDefinition } from './provider.js';

export interface CopilotStartRequest {
  model: string;
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinition[];
}

export interface CopilotServiceResponse extends LLMResponse {
  sessionId: string | null;
}

export interface CopilotToolResult {
  id: string;
  content: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPairingToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(value) && !/^(gh[opu]_|github_pat_)/.test(value);
}

function isToolCall(value: unknown): value is ToolCall {
  return isRecord(value) && typeof value.id === 'string' && !!value.id &&
    typeof value.name === 'string' && !!value.name && typeof value.arguments === 'string';
}

function isMessage(value: unknown): value is Message {
  if (!isRecord(value) || typeof value.content !== 'string') return false;
  return value.role === 'user' ||
    (value.role === 'tool' && typeof value.toolCallId === 'string') ||
    (value.role === 'assistant' &&
      (value.toolCalls === undefined || (Array.isArray(value.toolCalls) && value.toolCalls.every(isToolCall))));
}

function isTool(value: unknown): value is ToolDefinition {
  return isRecord(value) && typeof value.name === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.name) &&
    typeof value.description === 'string' && (value.parameters === undefined || isRecord(value.parameters));
}

export function parseStartRequest(value: unknown): CopilotStartRequest {
  if (!isRecord(value) || typeof value.model !== 'string' || !value.model || value.model.length > 200 ||
      typeof value.systemPrompt !== 'string' || !Array.isArray(value.messages) || !value.messages.length ||
      value.messages.length > 1000 || !value.messages.every(isMessage) ||
      !Array.isArray(value.tools) || value.tools.length > 128 || !value.tools.every(isTool) ||
      new Set(value.tools.map((tool) => tool.name)).size !== value.tools.length) {
    throw new Error('Invalid Copilot conversation or tool definitions.');
  }
  return { model: value.model, systemPrompt: value.systemPrompt, messages: value.messages, tools: value.tools };
}

export function parseToolResults(value: unknown): CopilotToolResult[] {
  if (!isRecord(value) || !Array.isArray(value.results) || !value.results.length ||
      !value.results.every((item): item is CopilotToolResult =>
        isRecord(item) && typeof item.id === 'string' && !!item.id && typeof item.content === 'string') ||
      new Set(value.results.map((item) => item.id)).size !== value.results.length) {
    throw new Error('Invalid Copilot tool results.');
  }
  return value.results;
}

export function parseServiceResponse(value: unknown): CopilotServiceResponse {
  if (!isRecord(value) || (value.text !== null && typeof value.text !== 'string') ||
      (value.sessionId !== null && typeof value.sessionId !== 'string') ||
      !Array.isArray(value.toolCalls) || !value.toolCalls.every(isToolCall) ||
      (value.toolCalls.length ? typeof value.sessionId !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(value.sessionId) : value.sessionId !== null)) {
    throw new Error('The Copilot companion returned an invalid response.');
  }
  return { sessionId: value.sessionId, text: value.text, toolCalls: value.toolCalls };
}

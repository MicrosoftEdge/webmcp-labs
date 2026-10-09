// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Message } from './provider';

/** Keep the initial request and recent history without splitting a tool exchange. */
export function trimMessages(messages: Message[], maxMessages: number): Message[] {
  if (messages.length <= maxMessages || messages.length <= 1) return messages;
  let start = Math.max(1, messages.length - Math.max(1, maxMessages - 1));
  while (start > 1 && messages[start].role === 'tool') start--;
  // The latest exchange may exceed the cap; dropping part of it would make replay invalid.
  return [messages[0], ...messages.slice(start)];
}

/** Record interrupted calls explicitly so the next request can replay a complete exchange. */
export function finishInterruptedToolCalls(messages: Message[]): void {
  const pendingCalls = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) pendingCalls.add(call.id);
    } else if (message.role === 'tool') {
      pendingCalls.delete(message.toolCallId);
    }
  }
  for (const toolCallId of pendingCalls) {
    messages.push({
      role: 'tool',
      toolCallId,
      content: 'Tool execution was interrupted before a result was recorded. Do not assume it succeeded.',
      isError: true,
    });
  }
}

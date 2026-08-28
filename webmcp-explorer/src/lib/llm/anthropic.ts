// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMProvider,
  Message,
  ToolDefinition,
  ToolCall,
  LLMResponse,
  ProviderConfig,
  ProviderMetadata,
} from './provider';

/**
 * AnthropicProvider — uses the Anthropic Messages API internally.
 */
export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(config: ProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      dangerouslyAllowBrowser: true,
    });
    this.model = config.model;
  }

  async sendMessage(
    systemPrompt: string,
    messages: Message[],
    tools: ToolDefinition[],
    options?: { signal?: AbortSignal }
  ): Promise<LLMResponse> {
    const anthropicMessages = messagesToAnthropicMessages(messages);
    const anthropicTools = tools.length > 0
      ? tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: (t.parameters ?? { type: 'object', properties: {} }) as Anthropic.Tool.InputSchema,
        }))
      : undefined;

    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: anthropicMessages,
        ...(anthropicTools ? { tools: anthropicTools } : {}),
      },
      { signal: options?.signal ?? null }
    );

    return parseResponse(response);
  }
}

/**
 * Convert generic Message[] to Anthropic message format.
 *
 * Anthropic requires strictly alternating user/assistant roles.
 * Tool results must be sent as `tool_result` content blocks inside a `user` message.
 * Consecutive tool messages are merged into a single user message.
 */
function messagesToAnthropicMessages(
  messages: Message[]
): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: JSON.parse(tc.arguments),
          });
        }
      }
      result.push({ role: 'assistant', content });
    } else if (msg.role === 'tool') {
      const toolResultBlock: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: msg.toolCallId,
        content: msg.content,
      };

      // Merge consecutive tool results into the same user message
      const last = result[result.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        (last.content as Anthropic.ToolResultBlockParam[]).push(toolResultBlock);
      } else {
        result.push({ role: 'user', content: [toolResultBlock] });
      }
    }
  }

  return result;
}

/** Parse an Anthropic Message response into our generic LLMResponse. */
function parseResponse(response: Anthropic.Message): LLMResponse {
  const toolCalls: ToolCall[] = [];
  const textParts: string[] = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
      });
    }
  }

  return {
    text: textParts.length > 0 ? textParts.join('') : null,
    toolCalls,
  };
}

export const providerMetadata: ProviderMetadata = {
  key: 'anthropic',
  label: 'Anthropic',
  fields: [
    { id: 'anthropic-api-key', configKey: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-ant-…' },
    { id: 'anthropic-model', configKey: 'model', label: 'Model', type: 'text', placeholder: 'claude-opus-5' },
  ],
  createProvider: async (config) => new AnthropicProvider(config),
};

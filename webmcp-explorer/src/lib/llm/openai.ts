// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import OpenAI from 'openai';
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
 * OpenAIProvider — uses the OpenAI Responses API internally.
 */
export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(config: ProviderConfig) {
    this.client = new OpenAI({
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
    const input = messagesToInput(messages);
    const apiTools = tools.length > 0
      ? tools.map((t) => ({
          type: 'function' as const,
          name: t.name,
          description: t.description,
          parameters: t.parameters ?? { type: 'object', properties: {} },
          strict: false as const,
        }))
      : undefined;

    const response = await this.client.responses.create(
      {
        model: this.model,
        instructions: systemPrompt,
        input,
        tools: apiTools,
      },
      { signal: options?.signal }
    );

    return parseResponse(response);
  }
}

/** Map generic Message[] to Responses API input items. */
function messagesToInput(messages: Message[]): OpenAI.Responses.ResponseInput {
  const input: OpenAI.Responses.ResponseInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      input.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      // Push the assistant text as a message
      if (msg.content) {
        input.push({ role: 'assistant', content: msg.content });
      }
      // Push any tool calls as function_call items
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          });
        }
      }
    } else if (msg.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.toolCallId,
        output: msg.content,
      });
    }
  }

  return input;
}

/** Parse a Responses API response into our generic LLMResponse. */
function parseResponse(response: OpenAI.Responses.Response): LLMResponse {
  const toolCalls: ToolCall[] = [];

  for (const item of response.output) {
    if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id,
        name: item.name,
        arguments: item.arguments,
      });
    }
  }

  return {
    text: response.output_text || null,
    toolCalls,
  };
}

export const providerMetadata: ProviderMetadata = {
  key: 'openai',
  label: 'OpenAI',
  fields: [
    { id: 'openai-api-key', configKey: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-…' },
    { id: 'openai-model', configKey: 'model', label: 'Model', type: 'text', placeholder: 'gpt-5.3-chat' },
  ],
  createProvider: async (config) => new OpenAIProvider(config),
};

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { AzureOpenAI } from 'openai';
import type OpenAITypes from 'openai';
import type {
  LLMProvider,
  Message,
  ToolDefinition,
  ToolCall,
  LLMResponse,
  ProviderConfig,
  ProviderMetadata,
} from './provider';

/** AzureOpenAIProvider — calls the Azure OpenAI v1 Responses API. */
export class AzureOpenAIProvider implements LLMProvider {
  private client: AzureOpenAI;
  private deployment: string;

  constructor(config: ProviderConfig) {
    this.client = new AzureOpenAI({
      endpoint: validateAzureEndpoint(config.endpoint),
      apiKey: config.apiKey,
      deployment: config.deployment,
      apiVersion: config.apiVersion,
      dangerouslyAllowBrowser: true,
    });
    this.deployment = config.deployment;
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
        model: this.deployment,
        instructions: systemPrompt,
        input,
        tools: apiTools,
      },
      { signal: options?.signal }
    );

    return parseResponse(response);
  }
}

/**
 * Validate that the endpoint is just the Azure resource root
 * (e.g. `https://your-resource.openai.azure.com/`). Throws otherwise — users
 * sometimes paste a full sample URL like `.../openai/v1/responses`, which
 * would cause a doubled path when the SDK appends its own.
 */
function validateAzureEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Azure endpoint must be a full URL like https://your-resource.openai.azure.com/. Got: ${endpoint}`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(
      `Azure endpoint must be just the resource root (no path). Remove "${url.pathname}" from: ${endpoint}`
    );
  }
  return url.origin;
}

/** Map generic Message[] to Responses API input items. */
function messagesToInput(messages: Message[]): OpenAITypes.Responses.ResponseInput {
  const input: OpenAITypes.Responses.ResponseInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      input.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      if (msg.content) {
        input.push({ role: 'assistant', content: msg.content });
      }
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
function parseResponse(response: OpenAITypes.Responses.Response): LLMResponse {
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
  key: 'azure-openai',
  label: 'Azure OpenAI',
  fields: [
    { id: 'azure-endpoint', configKey: 'endpoint', label: 'Endpoint URL', type: 'url', placeholder: 'https://your-resource.openai.azure.com/' },
    { id: 'azure-api-key', configKey: 'apiKey', label: 'API Key', type: 'password' },
    { id: 'azure-deployment', configKey: 'deployment', label: 'Deployment Name', type: 'text', placeholder: 'gpt-5.3-chat' },
    { id: 'azure-api-version', configKey: 'apiVersion', label: 'API Version', type: 'text', defaultValue: '2025-03-01-preview' },
  ],
  createProvider: async (config) => new AzureOpenAIProvider(config),
};

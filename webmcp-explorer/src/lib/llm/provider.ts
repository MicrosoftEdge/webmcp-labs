import type OpenAI from 'openai';

/**
 * Common types used by LLM providers.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatCompletion {
  message: ChatMessage;
  finishReason: string | null;
}

/**
 * LLMProvider — common interface for all LLM backends.
 */
export interface LLMProvider {
  chatCompletion(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: { signal?: AbortSignal }
  ): Promise<ChatCompletion>;
}

/**
 * Provider configuration stored in chrome.storage.local
 */
export interface OpenAIConfig {
  provider: 'openai';
  apiKey: string;
  model: string;
}

export interface AzureOpenAIConfig {
  provider: 'azure-openai';
  apiKey: string;
  endpoint: string;
  deployment: string;
  apiVersion: string;
}

export type ProviderConfig = OpenAIConfig | AzureOpenAIConfig;

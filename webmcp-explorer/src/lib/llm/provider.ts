/**
 * API-agnostic LLM types and interface.
 * No OpenAI/Anthropic-specific concepts — each provider translates internally.
 */

/** A message in the conversation history. */
export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

/** A tool the model can call. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

/** A tool call returned by the model. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** The model's response. */
export interface LLMResponse {
  text: string | null;
  toolCalls: ToolCall[];
}

/**
 * LLMProvider — every LLM backend implements this.
 */
export interface LLMProvider {
  sendMessage(
    systemPrompt: string,
    messages: Message[],
    tools: ToolDefinition[],
    options?: { signal?: AbortSignal }
  ): Promise<LLMResponse>;
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

export interface AnthropicConfig {
  provider: 'anthropic';
  apiKey: string;
  model: string;
}

export type ProviderConfig = OpenAIConfig | AzureOpenAIConfig | AnthropicConfig;

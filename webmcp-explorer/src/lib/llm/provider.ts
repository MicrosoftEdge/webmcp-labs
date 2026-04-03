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

/** Provider configuration stored in chrome.storage.local. */
export interface ProviderConfig {
  provider: string;
  [key: string]: string;
}

/** A form field shown in the config pane for a provider. */
export interface FieldDefinition {
  id: string;
  /** The key on the ProviderConfig object this field maps to. */
  configKey: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'select';
  placeholder?: string;
  defaultValue?: string;
  optional?: boolean;
  options?: { value: string; label: string }[];
}

/** Metadata each provider exports so the UI can render its config dynamically. */
export interface ProviderMetadata {
  key: string;
  label: string;
  fields: FieldDefinition[];
  createProvider: (config: ProviderConfig) => Promise<LLMProvider>;
}

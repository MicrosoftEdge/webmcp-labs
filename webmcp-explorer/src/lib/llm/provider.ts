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

/** A form field shown in the config pane for a provider. */
export interface FieldDefinition {
  id: string;
  /** The key on the ProviderConfig object this field maps to. */
  configKey: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'select';
  placeholder?: string;
  defaultValue?: string;
  options?: { value: string; label: string }[];
}

/** Metadata each provider exports so the UI can render its config dynamically. */
export interface ProviderMetadata {
  key: string;
  label: string;
  fields: FieldDefinition[];
  toConfig: (values: Record<string, string>) => ProviderConfig;
  fromConfig: (config: ProviderConfig) => Record<string, string>;
  createProvider: (config: ProviderConfig) => Promise<LLMProvider>;
}

/**
 * Helper to define a provider's metadata without hand-writing toConfig/fromConfig.
 * The `configKey` on each field drives the automatic mapping.
 */
export function defineProviderMetadata(
  options: Pick<ProviderMetadata, 'key' | 'label' | 'fields' | 'createProvider'>
): ProviderMetadata {
  const { key, label, fields, createProvider } = options;
  return {
    key,
    label,
    fields,
    toConfig(values) {
      const config: Record<string, string> = { provider: key };
      for (const field of fields) {
        config[field.configKey] = values[field.id];
      }
      return config as unknown as ProviderConfig;
    },
    fromConfig(config) {
      if (config.provider !== key) return {};
      const values: Record<string, string> = {};
      for (const field of fields) {
        values[field.id] = (config as unknown as Record<string, string>)[field.configKey];
      }
      return values;
    },
    createProvider,
  };
}

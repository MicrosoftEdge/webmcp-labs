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
 * ChatCompletionsProvider — uses the OpenAI Chat Completions API, compatible with
 * Ollama, LM Studio, llama.cpp, vLLM, and other OpenAI-compatible endpoints.
 */
export class ChatCompletionsProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(config: ProviderConfig) {
    this.client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey || 'unused',
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
    const chatMessages = messagesToChatMessages(systemPrompt, messages);
    const chatTools =
      tools.length > 0
        ? tools.map((t) => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: (t.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
            },
          }))
        : undefined;

    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: chatMessages,
        tools: chatTools,
      },
      { signal: options?.signal }
    );

    return parseResponse(response);
  }
}

/** Map generic Message[] to Chat Completions message format. */
function messagesToChatMessages(
  systemPrompt: string,
  messages: Message[]
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ];

  for (const msg of messages) {
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      const toolCalls = msg.toolCalls?.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      }));
      result.push({
        role: 'assistant',
        content: msg.content || null,
        tool_calls: toolCalls?.length ? toolCalls : undefined,
      });
    } else if (msg.role === 'tool') {
      result.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: msg.content,
      });
    }
  }

  return result;
}

/** Parse a Chat Completions response into our generic LLMResponse. */
function parseResponse(response: OpenAI.Chat.Completions.ChatCompletion): LLMResponse {
  const choice = response.choices[0];
  if (!choice) return { text: null, toolCalls: [] };

  const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: tc.function.arguments,
  }));

  return {
    text: choice.message.content ?? null,
    toolCalls,
  };
}

export const providerMetadata: ProviderMetadata = {
  key: 'chat-completions',
  label: 'Chat Completions API',
  fields: [
    {
      id: 'chat-completions-base-url',
      configKey: 'baseUrl',
      label: 'Base URL',
      type: 'url',
      placeholder: 'http://localhost:11434/v1',
    },
    {
      id: 'chat-completions-api-key',
      configKey: 'apiKey',
      label: 'API Key',
      type: 'password',
      placeholder: 'Leave blank if not required',
      optional: true,
    },
    {
      id: 'chat-completions-model',
      configKey: 'model',
      label: 'Model',
      type: 'text',
      placeholder: 'llama3',
    },
  ],
  createProvider: async (config) => new ChatCompletionsProvider(config),
};

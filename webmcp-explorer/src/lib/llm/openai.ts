import OpenAI from 'openai';
import type {
  LLMProvider,
  ChatMessage,
  ToolDefinition,
  ChatCompletion,
  OpenAIConfig,
} from './provider';

/**
 * OpenAIProvider — LLMProvider backed by the OpenAI API.
 */
export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(config: OpenAIConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      dangerouslyAllowBrowser: true,
    });
    this.model = config.model;
  }

  async chatCompletion(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: { signal?: AbortSignal }
  ): Promise<ChatCompletion> {
    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: messages as OpenAI.ChatCompletionMessageParam[],
        tools: tools.length > 0 ? (tools as OpenAI.ChatCompletionTool[]) : undefined,
      },
      { signal: options?.signal }
    );

    const choice = response.choices[0];
    return {
      message: {
        role: 'assistant',
        content: choice.message.content,
        tool_calls: choice.message.tool_calls?.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })),
      },
      finishReason: choice.finish_reason,
    };
  }
}

import { AzureOpenAI } from 'openai';
import type OpenAITypes from 'openai';
import type {
  LLMProvider,
  ChatMessage,
  ToolDefinition,
  ChatCompletion,
  AzureOpenAIConfig,
} from './provider';

/**
 * AzureOpenAIProvider — LLMProvider backed by the Azure OpenAI Service.
 */
export class AzureOpenAIProvider implements LLMProvider {
  private client: AzureOpenAI;
  private deployment: string;

  constructor(config: AzureOpenAIConfig) {
    this.client = new AzureOpenAI({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      deployment: config.deployment,
      apiVersion: config.apiVersion,
      dangerouslyAllowBrowser: true,
    });
    this.deployment = config.deployment;
  }

  async chatCompletion(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options?: { signal?: AbortSignal }
  ): Promise<ChatCompletion> {
    const response = await this.client.chat.completions.create(
      {
        model: this.deployment,
        messages: messages as OpenAITypes.ChatCompletionMessageParam[],
        tools: tools.length > 0 ? (tools as OpenAITypes.ChatCompletionTool[]) : undefined,
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

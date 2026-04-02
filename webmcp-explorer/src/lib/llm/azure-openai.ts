import { AzureOpenAI } from 'openai';
import type OpenAITypes from 'openai';
import type {
  LLMProvider,
  Message,
  ToolDefinition,
  ToolCall,
  LLMResponse,
  AzureOpenAIConfig,
} from './provider';

/**
 * AzureOpenAIProvider — uses the Azure OpenAI Responses API internally.
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

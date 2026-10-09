// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  LLMProvider, LLMResponse, Message, ProviderMetadata, SendMessageOptions, ToolCall, ToolDefinition,
} from './provider';
import type {
  PromptApiContent, PromptApiCoreOptions, PromptApiGlobals, PromptApiMessage,
} from '../../types/prompt-api';

const NATIVE_SUPPORT_ERROR =
  'Prompt API native tool calling is not available. Use a browser build with LanguageModel, ' +
  'LanguageModelToolCall, LanguageModelToolSuccess, and LanguageModelToolError enabled. ' +
  'There is no fallback to text-based tool calling.';

function getPromptApi() {
  const browser = globalThis as typeof globalThis & PromptApiGlobals;
  const { LanguageModel, LanguageModelToolCall, LanguageModelToolSuccess, LanguageModelToolError } = browser;
  if (!LanguageModel) {
    throw new Error('Prompt API is not available in this browser. Enable the Prompt API in a supported browser build.');
  }
  if (typeof LanguageModel.availability !== 'function' || typeof LanguageModel.create !== 'function' ||
      typeof LanguageModelToolCall !== 'function' || typeof LanguageModelToolSuccess !== 'function' ||
      typeof LanguageModelToolError !== 'function') {
    throw new Error(NATIVE_SUPPORT_ERROR);
  }
  return { LanguageModel, LanguageModelToolCall, LanguageModelToolSuccess, LanguageModelToolError };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function checkAvailability(
  api: ReturnType<typeof getPromptApi>,
  sessionOptions: PromptApiCoreOptions,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    // Native availability() has no AbortSignal and can hang during model provisioning.
    return await Promise.race([
      api.LanguageModel.availability(sessionOptions),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(
          'Prompt API availability check timed out after 30 seconds. Check the browser model download, ' +
          'device support, and flags, then retry Test Connection.',
        )), 30_000);
        abortListener = () => reject(signal?.reason);
        signal?.addEventListener('abort', abortListener, { once: true });
        if (signal?.aborted) abortListener();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    if (abortListener) signal?.removeEventListener('abort', abortListener);
  }
}

function messagesToPrompts(messages: Message[], api: ReturnType<typeof getPromptApi>): PromptApiMessage[] {
  const prompts: PromptApiMessage[] = [];
  const pendingCalls = new Map<string, ToolCall>();
  for (const message of messages) {
    if (message.role === 'tool') {
      const call = pendingCalls.get(message.toolCallId);
      if (!call) throw new Error(`Prompt API history has no matching call for tool result "${message.toolCallId}". Reset the chat.`);
      const value = message.isError
        ? new api.LanguageModelToolError({ callId: call.id, name: call.name, errorMessage: message.content })
        : new api.LanguageModelToolSuccess({
            callId: call.id, name: call.name, result: [{ type: 'text', value: message.content }],
          });
      const content: PromptApiContent = { type: 'tool-response', value };
      const previous = prompts[prompts.length - 1];
      if (previous?.role === 'user' && Array.isArray(previous.content)) {
        previous.content.push(content);
      } else {
        prompts.push({ role: 'user', content: [content] });
      }
      pendingCalls.delete(call.id);
      continue;
    }

    if (pendingCalls.size > 0) throw new Error('Prompt API history contains unanswered tool calls. Reset the chat.');
    if (message.role === 'user') {
      prompts.push({ role: 'user', content: message.content });
      continue;
    }

    const content: PromptApiContent[] = [];
    if (message.content) content.push({ type: 'text', value: message.content });
    for (const call of message.toolCalls ?? []) {
      if (pendingCalls.has(call.id)) throw new Error(`Prompt API history contains duplicate tool call ID "${call.id}".`);
      const argumentsObject: unknown = JSON.parse(call.arguments);
      if (!isObject(argumentsObject)) throw new Error(`Prompt API tool "${call.name}" requires object arguments.`);
      content.push({
        type: 'tool-call',
        value: new api.LanguageModelToolCall({ callId: call.id, name: call.name, arguments: argumentsObject }),
      });
      pendingCalls.set(call.id, call);
    }
    prompts.push({ role: 'assistant', content });
  }
  if (pendingCalls.size > 0) throw new Error('Prompt API history contains unanswered tool calls. Reset the chat.');
  return prompts;
}

function parseResponse(response: unknown, tools: ToolDefinition[]): LLMResponse {
  // With tool-call in expectedOutputs, even a text-only answer must be a content array.
  if (!Array.isArray(response)) throw new Error(NATIVE_SUPPORT_ERROR);
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const callIds = new Set<string>();
  for (const content of response) {
    if (!isObject(content)) throw new Error('Prompt API returned an invalid content block.');
    if (content.type === 'text' && typeof content.value === 'string') {
      textParts.push(content.value);
    } else if (content.type === 'tool-call' && isObject(content.value)) {
      const call = content.value;
      if (typeof call.callId !== 'string' || !call.callId || callIds.has(call.callId) ||
          typeof call.name !== 'string' || !tools.some(tool => tool.name === call.name) ||
          (call.arguments != null && !isObject(call.arguments))) {
        throw new Error('Prompt API returned an invalid tool call, duplicate call ID, or unknown tool.');
      }
      callIds.add(call.callId);
      toolCalls.push({ id: call.callId, name: call.name, arguments: JSON.stringify(call.arguments ?? {}) });
    } else {
      throw new Error('Prompt API returned an unsupported content block.');
    }
  }
  if (!textParts.length && !toolCalls.length) throw new Error('Prompt API returned an empty response.');
  return { text: textParts.length ? textParts.join('') : null, toolCalls };
}

export class PromptApiProvider implements LLMProvider {
  async sendMessage(
    systemPrompt: string,
    messages: Message[],
    tools: ToolDefinition[],
    options?: SendMessageOptions,
  ): Promise<LLMResponse> {
    options?.signal?.throwIfAborted();
    const api = getPromptApi();
    const prompts = messagesToPrompts(messages, api);
    const toolNames = new Set<string>();
    const sessionOptions: PromptApiCoreOptions = {
      tools: tools.map(tool => {
        const inputSchema = tool.parameters ?? { type: 'object', properties: {} };
        if (!tool.name || toolNames.has(tool.name) || inputSchema.type !== 'object') {
          throw new Error(`Prompt API tool "${tool.name}" needs a unique name and an object input schema.`);
        }
        toolNames.add(tool.name);
        return { name: tool.name, description: tool.description, inputSchema };
      }),
      expectedInputs: [{ type: 'text' }, { type: 'tool-call' }, { type: 'tool-response' }],
      expectedOutputs: [{ type: 'text' }, { type: 'tool-call' }],
    };

    try {
      options?.onStatus?.('Checking built-in model availability...');
      const availability = await checkAvailability(api, sessionOptions, options?.signal);
      options?.signal?.throwIfAborted();
      if (availability === 'unavailable') {
        throw new Error('Prompt API native tool calling is unavailable for this browser or device. Check model support and browser flags.');
      }
      options?.onStatus?.(availability === 'available'
        ? 'Loading the built-in model...'
        : 'Downloading the built-in model. This may take a few minutes...');
      const session = await api.LanguageModel.create({
        ...sessionOptions,
        initialPrompts: [{ role: 'system', content: systemPrompt }],
        signal: options?.signal,
        monitor(monitor) {
          monitor.addEventListener('downloadprogress', event => {
            options?.onStatus?.(`Downloading the built-in model: ${Math.round(event.loaded * 100)}%`);
          });
        },
      });
      try {
        options?.signal?.throwIfAborted();
        options?.onStatus?.('Generating response...');
        const response = await session.prompt(prompts, { signal: options?.signal });
        options?.signal?.throwIfAborted();
        return parseResponse(response, tools);
      } finally {
        session.destroy();
      }
    } catch (error) {
      options?.signal?.throwIfAborted();
      if (error instanceof DOMException && error.name === 'NotSupportedError') {
        throw new Error(`${NATIVE_SUPPORT_ERROR} ${error.message}`, { cause: error });
      }
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        throw new Error('Prompt API needs permission or user activation to download the model. Click Test Connection in Config to prepare it.', { cause: error });
      }
      throw error;
    }
  }
}

export const providerMetadata: ProviderMetadata = {
  key: 'prompt-api',
  label: 'Prompt API (built-in, experimental)',
  description: 'Uses the browser-provided model without an API key or endpoint. Requires native Prompt API tool calling. Test Connection prepares the model (which may download) and checks tool use. No fallback is used.',
  fields: [],
  createProvider: async () => new PromptApiProvider(),
};

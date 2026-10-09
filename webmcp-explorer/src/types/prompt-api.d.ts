// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Experimental tool-use surface from https://webmachinelearning.github.io/prompt-api/.
// Keep these module-scoped so they do not conflict with future lib.dom declarations.
export interface PromptApiToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: Record<string, unknown> | null;
}

export interface PromptApiToolSuccess {
  readonly callId: string;
  readonly name: string;
  readonly result: { type: 'text'; value: string }[];
}

export interface PromptApiToolError {
  readonly callId: string;
  readonly name: string;
  readonly errorMessage: string;
}

export type PromptApiContent =
  | { type: 'text'; value: string }
  | { type: 'tool-call'; value: PromptApiToolCall }
  | { type: 'tool-response'; value: PromptApiToolSuccess | PromptApiToolError };

export interface PromptApiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | PromptApiContent[];
}

export interface PromptApiCoreOptions {
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  expectedInputs: { type: 'text' | 'tool-call' | 'tool-response' }[];
  expectedOutputs: { type: 'text' | 'tool-call' }[];
}

export interface PromptApiSession {
  prompt(messages: PromptApiMessage[], options: { signal?: AbortSignal }): Promise<unknown>;
  destroy(): void;
}

export interface PromptApiGlobals {
  LanguageModel?: {
    availability(options: PromptApiCoreOptions): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>;
    create(options: PromptApiCoreOptions & {
      initialPrompts: PromptApiMessage[];
      signal?: AbortSignal;
      monitor: (monitor: {
        addEventListener(type: 'downloadprogress', listener: (event: { loaded: number }) => void): void;
      }) => void;
    }): Promise<PromptApiSession>;
  };
  LanguageModelToolCall?: new (options: {
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
  }) => PromptApiToolCall;
  LanguageModelToolSuccess?: new (options: PromptApiToolSuccess) => PromptApiToolSuccess;
  LanguageModelToolError?: new (options: PromptApiToolError) => PromptApiToolError;
}

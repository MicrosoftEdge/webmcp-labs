// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { LLMProvider, Message, ProviderConfig, ProviderMetadata, ToolDefinition } from './provider';
import { isPairingToken, isRecord, parseServiceResponse } from './copilot-protocol';

export class GitHubCopilotProvider implements LLMProvider {
  private readonly baseUrl: string;
  private readonly token: string;
  private sessionId?: string;
  private closing?: Promise<void>;
  private pendingIds: string[] = [];
  private toolSignature?: string;
  private signal?: AbortSignal;
  private readonly onAbort = () => {
    void this.dispose().catch((error) => console.error('Could not close the Copilot companion session:', error));
  };

  constructor(private readonly config: ProviderConfig) {
    const url = new URL(config.baseUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
        url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
      throw new Error('Copilot Service URL must be an HTTP loopback address, such as http://127.0.0.1:8787.');
    }
    if (!isPairingToken(config.serviceToken)) {
      throw new Error('Paste the pairing token printed by your Copilot companion service, not a GitHub token.');
    }
    this.baseUrl = url.origin;
    this.token = config.serviceToken;
  }

  private async request(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
    });
    if (response.status === 204) return undefined;
    const result: unknown = await response.json();
    if (!response.ok) {
      throw new Error(isRecord(result) && typeof result.error === 'string' ? result.error
        : `Copilot companion request failed (HTTP ${response.status}).`);
    }
    return result;
  }

  async listModels(signal?: AbortSignal): Promise<{ value: string; label: string }[]> {
    const result = await this.request('/models', 'GET', undefined, signal);
    if (!isRecord(result) || !Array.isArray(result.models) || !result.models.length ||
        !result.models.every((model): model is { id: string; name: string } =>
          isRecord(model) && typeof model.id === 'string' && !!model.id && typeof model.name === 'string')) {
      throw new Error('The Copilot companion returned an empty or invalid model list. Check CLI sign-in and account policy.');
    }
    return result.models.map((model) => ({ value: model.id, label: model.name }));
  }

  async sendMessage(systemPrompt: string, messages: Message[], tools: ToolDefinition[], options?: { signal?: AbortSignal }) {
    if (!this.config.model) throw new Error('Refresh models, select a Copilot model, and save.');
    const signature = JSON.stringify({ systemPrompt, tools });
    if (this.toolSignature !== signature || this.signal !== options?.signal) await this.dispose();
    this.toolSignature = signature;
    this.signal = options?.signal;
    this.signal?.throwIfAborted();
    this.signal?.addEventListener('abort', this.onAbort, { once: true });
    try {
      let result: unknown;
      if (this.sessionId) {
        const results = messages.filter((message): message is Extract<Message, { role: 'tool' }> =>
          message.role === 'tool' && this.pendingIds.includes(message.toolCallId))
          .map((message) => ({ id: message.toolCallId, content: message.content }));
        if (results.length !== this.pendingIds.length) throw new Error('Copilot is waiting for all requested page-tool results.');
        result = await this.request(`/sessions/${this.sessionId}/results`, 'POST', { results }, this.signal);
      } else {
        result = await this.request('/sessions', 'POST', { model: this.config.model, systemPrompt, messages, tools }, this.signal);
      }
      const response = parseServiceResponse(result);
      this.sessionId = response.sessionId ?? undefined;
      this.pendingIds = response.toolCalls.map((call) => call.id);
      if (new Set(this.pendingIds).size !== this.pendingIds.length ||
          response.toolCalls.some((call) => !tools.some((tool) => tool.name === call.name))) {
        throw new Error('The Copilot companion requested an unknown or duplicate page tool.');
      }
      if (this.signal?.aborted) {
        await this.dispose();
        this.signal.throwIfAborted();
      }
      return { text: response.text, toolCalls: response.toolCalls };
    } catch (error) {
      await this.dispose().catch((cleanupError) => console.error('Could not close the Copilot companion session:', cleanupError));
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.signal?.removeEventListener('abort', this.onAbort);
    const id = this.sessionId;
    this.sessionId = undefined;
    this.pendingIds = [];
    if (id) {
      this.closing = this.request(`/sessions/${id}`, 'DELETE').then(() => undefined)
        .finally(() => { this.closing = undefined; });
    }
    await this.closing;
  }
}

export const providerMetadata: ProviderMetadata = {
  key: 'github-copilot-service',
  label: 'GitHub Copilot (local service)',
  description: 'Start the local Copilot companion and sign in using the official Copilot CLI. Paste the companion pairing token below. GitHub credentials stay with the CLI; the browser never signs in to GitHub directly.',
  credentialKey: 'serviceToken',
  fields: [
    { id: 'github-copilot-url', configKey: 'baseUrl', label: 'Service URL', type: 'url', defaultValue: 'http://127.0.0.1:8787' },
    { id: 'github-copilot-token', configKey: 'serviceToken', label: 'Service Pairing Token', type: 'password', placeholder: 'Token printed by the companion service' },
    { id: 'github-copilot-model', configKey: 'model', label: 'Model', type: 'select', options: [{ value: '', label: 'Connect and refresh models' }] },
  ],
  loadModels: (config, signal) => new GitHubCopilotProvider(config).listModels(signal),
  createProvider: async (config) => new GitHubCopilotProvider(config),
};

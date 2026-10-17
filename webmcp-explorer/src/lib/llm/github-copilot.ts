// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import OpenAI from 'openai';
import { ChatCompletionsProvider } from './chat-completions';
import {
  COPILOT_CREDENTIALS_KEY, COPILOT_HOST_PERMISSIONS, DEFAULT_COPILOT_CLIENT_ID,
  copilotClientId, copilotHeaders, getCopilotSession, invalidateCopilotSession,
  isCopilotSignedIn, signInToCopilot, signOutOfCopilot,
} from './github-copilot-auth';
import type { LLMProvider, LLMResponse, Message, ProviderConfig, ProviderMetadata, ToolDefinition } from './provider';

export class GitHubCopilotProvider implements LLMProvider {
  private model: string;
  private clientId: string;

  constructor(config: ProviderConfig) {
    if (!config.model?.trim()) throw new Error('A GitHub Copilot model is required.');
    this.model = config.model.trim();
    this.clientId = copilotClientId(config.clientId);
  }

  async sendMessage(
    systemPrompt: string,
    messages: Message[],
    tools: ToolDefinition[],
    options?: { signal?: AbortSignal }
  ): Promise<LLMResponse> {
    const accountChanged = new AbortController();
    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      const change = changes[COPILOT_CREDENTIALS_KEY];
      if (area === 'session' && change?.oldValue
        && change.oldValue.signInId !== change.newValue?.signInId) {
        accountChanged.abort(new Error('GitHub sign-in changed or was removed. Please sign in again in Config.'));
      }
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    const signals = [accountChanged.signal, AbortSignal.timeout(120_000)];
    if (options?.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    let sessionToken: string | undefined;
    try {
      const session = await getCopilotSession(this.clientId, signal);
      sessionToken = session.token;
      const provider = new ChatCompletionsProvider({
        provider: 'github-copilot', baseUrl: session.baseUrl, apiKey: session.token, model: this.model,
      }, {
        headers: {
          ...copilotHeaders(),
          'X-Initiator': messages.at(-1)?.role === 'user' ? 'user' : 'agent',
        },
        maxRetries: 0,
        timeout: 120_000,
        fetch: (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.href !== `${session.baseUrl}/chat/completions`) {
            throw new Error('Refusing to send Copilot credentials to an unexpected URL.');
          }
          return fetch(input, {
            ...init, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
          });
        },
      });
      return await provider.sendMessage(systemPrompt, messages, tools, { signal });
    } catch (error) {
      if (accountChanged.signal.aborted) throw accountChanged.signal.reason;
      if (error instanceof OpenAI.APIError) {
        if (error.status === 401 && sessionToken) {
          await invalidateCopilotSession(sessionToken);
          throw new Error('Copilot rejected the session. Test Connection to renew it, or sign out and sign in again.');
        }
        if (error.status === 403) throw new Error('Copilot denied access. Check your subscription, model access, and organization policies.');
        if (error.status === 429) throw new Error('Copilot usage or rate limit reached. Please try again later.');
        if (error.status !== undefined) {
          throw new Error(`Copilot request failed (HTTP ${error.status}). Check the model ID and tool support, then try again.`);
        }
      }
      throw error;
    } finally {
      chrome.storage.onChanged.removeListener(onStorageChanged);
    }
  }
}

export const providerMetadata: ProviderMetadata = {
  key: 'github-copilot',
  label: 'GitHub Copilot (subscription)',
  description: 'Experimental, unofficial browser-only compatibility integration using undocumented Copilot APIs. '
    + 'The default public OAuth client belongs to Visual Studio Code, so GitHub may identify it as Visual Studio Code. '
    + 'Review the authorization before approving. Tokens are kept in extension session memory, not persistent storage or our servers. '
    + 'Sign in again after restarting the browser.',
  hostPermissions: COPILOT_HOST_PERMISSIONS,
  fields: [
    {
      id: 'github-copilot-model', configKey: 'model', label: 'Model',
      type: 'text', defaultValue: 'gpt-4.1', placeholder: 'A model ID available to your Copilot subscription',
    },
    {
      id: 'github-copilot-client-id', configKey: 'clientId', label: 'OAuth Client ID (advanced override)',
      type: 'text', defaultValue: DEFAULT_COPILOT_CLIENT_ID, optional: true,
      placeholder: 'Public client ID; custom apps may not have Copilot access',
      description: 'Identifies the application requesting GitHub sign-in, not your account or Copilot subscription. '
        + 'This is a public identifier, not an API key or secret. Normally leave the default unchanged; '
        + 'override only for integration testing. Custom IDs do not guarantee Copilot access. '
        + 'Publication of the default ID does not grant permission to reuse its application identity.',
      documentationUrl: 'https://github.com/microsoft/AzureStorageExplorer/issues/8995',
    },
  ],
  authentication: {
    isSignedIn: (config) => isCopilotSignedIn(copilotClientId(config.clientId)),
    signIn: (config, onDeviceCode, signal) => signInToCopilot(copilotClientId(config.clientId), onDeviceCode, signal),
    signOut: signOutOfCopilot,
  },
  createProvider: async (config) => new GitHubCopilotProvider(config),
};

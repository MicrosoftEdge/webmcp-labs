import type { ProviderConfig } from './llm/provider';

const STORAGE_KEY = 'webmcp-explorer-config';

export interface AppConfig {
  provider: ProviderConfig | null;
  providerConfigs: Record<string, ProviderConfig>;
  maxIterations: number;
  maxChatMessages: number;
}

const DEFAULT_CONFIG: AppConfig = {
  provider: null,
  providerConfigs: {},
  maxIterations: 20,
  maxChatMessages: 50,
};

/**
 * Load config from chrome.storage.local.
 */
export async function loadConfig(): Promise<AppConfig> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  if (result[STORAGE_KEY]) {
    const raw = { ...DEFAULT_CONFIG, ...result[STORAGE_KEY] };
    // Migrate: if providerConfigs is missing but provider exists, seed it
    if (!result[STORAGE_KEY].providerConfigs && raw.provider) {
      raw.providerConfigs = { [raw.provider.provider]: raw.provider };
    }
    return raw;
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Save config to chrome.storage.local.
 */
export async function saveConfig(config: AppConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
}

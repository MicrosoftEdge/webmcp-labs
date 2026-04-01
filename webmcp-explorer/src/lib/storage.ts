import type { ProviderConfig } from './llm/provider';

const STORAGE_KEY = 'webmcp-explorer-config';

export interface AppConfig {
  provider: ProviderConfig | null;
  maxIterations: number;
}

const DEFAULT_CONFIG: AppConfig = {
  provider: null,
  maxIterations: 10,
};

/**
 * Load config from chrome.storage.local.
 */
export async function loadConfig(): Promise<AppConfig> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  if (result[STORAGE_KEY]) {
    return { ...DEFAULT_CONFIG, ...result[STORAGE_KEY] };
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Save config to chrome.storage.local.
 */
export async function saveConfig(config: AppConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
}

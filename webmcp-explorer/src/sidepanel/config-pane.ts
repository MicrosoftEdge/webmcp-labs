// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { loadConfig, saveConfig } from '../lib/storage';
import type { ProviderConfig, ProviderMetadata } from '../lib/llm/provider';
import { PROVIDERS } from '../lib/llm/registry';

// --- In-memory cache for per-provider configs ---
let providerConfigs: Record<string, ProviderConfig> = {};

// --- DOM refs ---

const providerSelect = document.getElementById('provider-select') as HTMLSelectElement;
const providerFieldsContainer = document.getElementById('provider-fields')!;
const messageEl = document.getElementById('config-message')!;

// Populate provider dropdown
providerSelect.innerHTML = '<option value="">Select a provider…</option>';
for (const p of PROVIDERS) {
  const opt = document.createElement('option');
  opt.value = p.key;
  opt.textContent = p.label;
  providerSelect.appendChild(opt);
}

function getProviderDef(): ProviderMetadata | null {
  return PROVIDERS.find((p) => p.key === providerSelect.value) ?? null;
}

function renderProviderFields(def: ProviderMetadata | null) {
  // All values come from our own provider metadata constants, so innerHTML is safe here.
  if (!def) { providerFieldsContainer.innerHTML = ''; return; }

  providerFieldsContainer.innerHTML = `
    <div class="stack gap-md">
      ${def.fields.map((field) => `
        <div class="form-group">
          <label class="label" for="${field.id}">${field.label}</label>
          ${field.type === 'select' && field.options
            ? `<select class="select" id="${field.id}">
                ${field.options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
              </select>`
            : `<input class="input" id="${field.id}" type="${field.type}" autocomplete="off"
                ${field.placeholder ? `placeholder="${field.placeholder}"` : ''}
                ${field.defaultValue ? `value="${field.defaultValue}"` : ''}>`}
        </div>
      `).join('')}
    </div>`;
}

let previousProviderKey: string = '';

/** Capture the form values for a given provider key into providerConfigs. */
function captureProvider(key: string) {
  const def = PROVIDERS.find((p) => p.key === key);
  if (!def) return;
  const values: Record<string, string> = {};
  let hasNonDefault = false;
  for (const field of def.fields) {
    const el = document.getElementById(field.id) as HTMLInputElement | HTMLSelectElement | null;
    const val = el?.value.trim() ?? '';
    values[field.id] = val;
    if (val && val !== (field.defaultValue ?? '')) hasNonDefault = true;
  }
  if (hasNonDefault) {
    const config: ProviderConfig = { provider: def.key };
    for (const field of def.fields) config[field.configKey] = values[field.id];
    providerConfigs[def.key] = config;
  }
}

/** Populate fields from the providerConfigs cache for the given provider. */
function populateFromCache(def: ProviderMetadata) {
  const cached = providerConfigs[def.key];
  if (!cached) return;
  for (const field of def.fields) {
    const el = document.getElementById(field.id) as HTMLInputElement | HTMLSelectElement | null;
    if (el) el.value = cached[field.configKey] ?? '';
  }
}

// Switch provider fields on change
providerSelect.addEventListener('change', () => {
  // Capture the previous provider's fields before they are removed from the DOM
  if (previousProviderKey) captureProvider(previousProviderKey);
  previousProviderKey = providerSelect.value;
  const def = getProviderDef();
  renderProviderFields(def);
  if (def) populateFromCache(def);
});

// Load saved config
loadConfig().then((config) => {
  // Hydrate in-memory cache from stored per-provider configs
  providerConfigs = { ...config.providerConfigs };

  if (config.provider) {
    providerSelect.value = config.provider.provider;
    previousProviderKey = config.provider.provider;
    const def = getProviderDef();
    renderProviderFields(def);

    if (def) populateFromCache(def);
  }
  (document.getElementById('max-iterations') as HTMLInputElement).value = String(config.maxIterations);
  (document.getElementById('max-chat-messages') as HTMLInputElement).value = String(config.maxChatMessages);
});

function showMessage(text: string, type: 'success' | 'error' | 'info' | 'warning') {
  messageEl.hidden = false;
  messageEl.className = `message-bar message-bar-${type}`;
  messageEl.textContent = text;
}

function getProviderConfig(): ProviderConfig | null {
  const def = getProviderDef();
  if (!def) {
    showMessage('Please select a provider.', 'error');
    return null;
  }

  const values: Record<string, string> = {};
  for (const field of def.fields) {
    const el = document.getElementById(field.id) as HTMLInputElement | HTMLSelectElement;
    const val = el.value.trim();
    if (!val && !field.optional) {
      showMessage(`${field.label} is required.`, 'error');
      return null;
    }
    values[field.id] = val;
  }

  const config: ProviderConfig = { provider: def.key };
  for (const field of def.fields) config[field.configKey] = values[field.id];
  return config;
}

// Save
document.getElementById('config-save')!.addEventListener('click', async () => {
  const providerConfig = getProviderConfig();
  if (!providerConfig) return;

  const maxIterations = parseInt((document.getElementById('max-iterations') as HTMLInputElement).value, 10) || 10;
  const maxChatMessages = parseInt((document.getElementById('max-chat-messages') as HTMLInputElement).value, 10) || 50;
  // Update the active provider in the cache, then persist everything
  providerConfigs[providerConfig.provider] = providerConfig;
  await saveConfig({ provider: providerConfig, providerConfigs: { ...providerConfigs }, maxIterations, maxChatMessages });
  showMessage('All provider configurations saved.', 'success');
});

// Test connection
document.getElementById('config-test')!.addEventListener('click', async () => {
  const providerConfig = getProviderConfig();
  if (!providerConfig) return;

  showMessage('Testing connection…', 'info');

  try {
    const meta = getProviderDef();
    if (!meta) return;
    const provider = await meta.createProvider(providerConfig);

    await provider.sendMessage(
      'You are a test.',
      [{ role: 'user', content: 'Say ok' }],
      []
    );

    // For local providers, probe whether the model supports tool calling
    if (meta.key === 'chat-completions') {
      const toolProbe = await provider.sendMessage(
        'You are a helpful assistant. You MUST call the provided tool.',
        [{ role: 'user', content: 'Call the test_tool with value "hello"' }],
        [{
          name: 'test_tool',
          description: 'A test tool that accepts a string value',
          parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
        }]
      );
      if (toolProbe.toolCalls.length === 0) {
        showMessage('Connected, but the model did not use tool calling. Tool-based features may not work with this model.', 'warning');
        return;
      }
    }

    showMessage('Connection successful!', 'success');
  } catch (e) {
    showMessage(`Connection failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
});

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
let providerOperation: AbortController | undefined;
messageEl.setAttribute('role', 'status');

function cancelProviderOperation() {
  providerOperation?.abort();
  providerOperation = undefined;
  (document.getElementById('config-save') as HTMLButtonElement).disabled = false;
  (document.getElementById('config-test') as HTMLButtonElement).disabled = false;
}

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
  cancelProviderOperation();
  messageEl.hidden = true;
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
  if (def.description) {
    const description = document.createElement('p');
    description.className = 'text-secondary';
    description.textContent = def.description;
    providerFieldsContainer.prepend(description);
  }
  renderProviderActions(def);
}

function renderProviderActions(def: ProviderMetadata) {
  if (!def.credentialKey && !def.loadModels) return;
  const actions = document.createElement('div');
  actions.className = 'row gap-sm';
  const buttons: HTMLButtonElement[] = [];
  const addButton = (label: string, action: () => void) => {
    const button = document.createElement('button');
    button.className = 'btn btn-neutral';
    button.textContent = label;
    button.addEventListener('click', action);
    actions.appendChild(button);
    buttons.push(button);
    return button;
  };
  const modelField = def.fields.find((field) => field.configKey === 'model');
  const modelSelect = modelField ? document.getElementById(modelField.id) as HTMLSelectElement : null;
  const resetModels = () => modelSelect?.replaceChildren(new Option('Refresh models to select', ''));
  for (const field of def.fields.filter((field) => field.configKey !== 'model')) {
    document.getElementById(field.id)?.addEventListener('input', resetModels);
  }
  const refreshModels = async (signal: AbortSignal) => {
    const config = getProviderConfig(false);
    if (!config || !def.loadModels || !modelSelect) return;
    const models = await def.loadModels(config, signal);
    signal.throwIfAborted();
    resetModels();
    for (const model of models) modelSelect.add(new Option(model.label, model.value));
    modelSelect.value = models.some((model) => model.value === config.model) ? config.model : '';
  };
  const runOperation = async (operation: (signal: AbortSignal) => Promise<string>) => {
    const controller = new AbortController();
    providerOperation = controller;
    const fields = providerFieldsContainer.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select');
    for (const field of fields) field.disabled = true;
    for (const button of buttons) button.disabled = true;
    cancelButton.disabled = false;
    (document.getElementById('config-save') as HTMLButtonElement).disabled = true;
    (document.getElementById('config-test') as HTMLButtonElement).disabled = true;
    showMessage('Waiting for provider...', 'info');
    try {
      const message = await operation(controller.signal);
      if (!controller.signal.aborted) showMessage(message, 'success');
    } catch (error) {
      if (providerOperation === controller) {
        showMessage(controller.signal.aborted ? 'Provider operation cancelled.'
          : error instanceof Error ? error.message : String(error), controller.signal.aborted ? 'info' : 'error');
      }
    } finally {
      if (providerOperation === controller) {
        cancelProviderOperation();
        for (const field of fields) field.disabled = false;
        for (const button of buttons) button.disabled = false;
        cancelButton.disabled = true;
      }
    }
  };
  if (def.credentialKey) {
    addButton('Forget credentials', () => {
      void runOperation(async (signal) => {
        const config = await loadConfig();
        signal.throwIfAborted();
        delete config.providerConfigs[def.key];
        if (config.provider?.provider === def.key) config.provider = null;
        await saveConfig(config);
        delete providerConfigs[def.key];
        for (const field of def.fields) {
          const input = document.getElementById(field.id) as HTMLInputElement | HTMLSelectElement;
          input.value = field.defaultValue ?? field.options?.[0]?.value ?? '';
        }
        resetModels();
        return 'Local connection settings removed. Copilot CLI sign-in is unchanged. Stop any requests already running.';
      });
    });
  }
  if (def.loadModels) {
    addButton('Refresh models', () => {
      void runOperation(async (signal) => {
        await refreshModels(signal);
        return 'Models refreshed. Select a model and click Save.';
      });
    });
  }
  const cancelButton = addButton('Cancel', () => providerOperation?.abort());
  cancelButton.disabled = true;
  providerFieldsContainer.append(actions);
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
    if (el) {
      const value = cached[field.configKey] ?? '';
      if (el instanceof HTMLSelectElement && value && !Array.from(el.options).some((option) => option.value === value)) {
        el.add(new Option(value, value));
      }
      el.value = value;
    }
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
}).catch((error) => showMessage(`Could not load configuration: ${error instanceof Error ? error.message : String(error)}`, 'error'));

function showMessage(text: string, type: 'success' | 'error' | 'info' | 'warning') {
  messageEl.hidden = false;
  messageEl.className = `message-bar message-bar-${type}`;
  messageEl.textContent = text;
}

function getProviderConfig(validate = true): ProviderConfig | null {
  const def = getProviderDef();
  if (!def) {
    showMessage('Please select a provider.', 'error');
    return null;
  }

  const values: Record<string, string> = {};
  for (const field of def.fields) {
    const el = document.getElementById(field.id) as HTMLInputElement | HTMLSelectElement;
    const val = el.value.trim();
    if (validate && !val && !field.optional) {
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

  // Run provider-specific validation by constructing it; surfaces errors
  // thrown from the provider constructor (e.g. malformed Azure endpoint).
  const meta = getProviderDef();
  if (meta) {
    try {
      await meta.createProvider(providerConfig);
    } catch (e) {
      showMessage(e instanceof Error ? e.message : String(e), 'error');
      return;
    }
  }

  const maxIterations = parseInt((document.getElementById('max-iterations') as HTMLInputElement).value, 10) || 10;
  const maxChatMessages = parseInt((document.getElementById('max-chat-messages') as HTMLInputElement).value, 10) || 50;
  // Update the active provider in the cache, then persist everything
  providerConfigs[providerConfig.provider] = providerConfig;
  try {
    await saveConfig({ provider: providerConfig, providerConfigs: { ...providerConfigs }, maxIterations, maxChatMessages });
    showMessage('All provider configurations saved.', 'success');
  } catch (error) {
    showMessage(`Could not save configuration: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
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

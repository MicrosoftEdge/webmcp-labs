import { loadConfig, saveConfig } from '../lib/storage';
import type { ProviderConfig } from '../lib/llm/provider';

// --- Provider registry (add new providers here) ---

interface FieldDef {
  id: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'select';
  placeholder?: string;
  defaultValue?: string;
  options?: { value: string; label: string }[];
}

interface ProviderDef {
  key: string;
  label: string;
  fields: FieldDef[];
  toConfig: (values: Record<string, string>) => ProviderConfig;
  fromConfig: (config: ProviderConfig) => Record<string, string>;
}

const PROVIDERS: ProviderDef[] = [
  {
    key: 'openai',
    label: 'OpenAI',
    fields: [
      { id: 'openai-api-key', label: 'API Key', type: 'password', placeholder: 'sk-…' },
      {
        id: 'openai-model', label: 'Model', type: 'select',
        options: [
          { value: 'gpt-4o', label: 'gpt-4o' },
          { value: 'gpt-4o-mini', label: 'gpt-4o-mini' },
          { value: 'gpt-4.1', label: 'gpt-4.1' },
          { value: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
        ],
      },
    ],
    toConfig: (v) => ({ provider: 'openai', apiKey: v['openai-api-key'], model: v['openai-model'] }),
    fromConfig: (c) => c.provider === 'openai' ? { 'openai-api-key': c.apiKey, 'openai-model': c.model } : ({} as Record<string, string>),
  },
  {
    key: 'azure-openai',
    label: 'Azure OpenAI',
    fields: [
      { id: 'azure-endpoint', label: 'Endpoint URL', type: 'url', placeholder: 'https://your-resource.openai.azure.com/' },
      { id: 'azure-api-key', label: 'API Key', type: 'password' },
      { id: 'azure-deployment', label: 'Deployment Name', type: 'text', placeholder: 'gpt-4o' },
      { id: 'azure-api-version', label: 'API Version', type: 'text', defaultValue: '2024-04-01-preview' },
    ],
    toConfig: (v) => ({
      provider: 'azure-openai',
      endpoint: v['azure-endpoint'],
      apiKey: v['azure-api-key'],
      deployment: v['azure-deployment'],
      apiVersion: v['azure-api-version'],
    }),
    fromConfig: (c) => c.provider === 'azure-openai' ? {
      'azure-endpoint': c.endpoint,
      'azure-api-key': c.apiKey,
      'azure-deployment': c.deployment,
      'azure-api-version': c.apiVersion,
    } : ({} as Record<string, string>),
  },
];

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

function getProviderDef(): ProviderDef | null {
  return PROVIDERS.find((p) => p.key === providerSelect.value) ?? null;
}

function renderProviderFields(def: ProviderDef | null) {
  providerFieldsContainer.innerHTML = '';
  if (!def) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'stack gap-md';

  for (const field of def.fields) {
    const group = document.createElement('div');
    group.className = 'form-group';

    const label = document.createElement('label');
    label.className = 'label';
    label.htmlFor = field.id;
    label.textContent = field.label;
    group.appendChild(label);

    if (field.type === 'select' && field.options) {
      const select = document.createElement('select');
      select.className = 'select';
      select.id = field.id;
      for (const opt of field.options) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        select.appendChild(o);
      }
      group.appendChild(select);
    } else {
      const input = document.createElement('input');
      input.className = 'input';
      input.id = field.id;
      input.type = field.type;
      input.autocomplete = 'off';
      if (field.placeholder) input.placeholder = field.placeholder;
      if (field.defaultValue) input.value = field.defaultValue;
      group.appendChild(input);
    }

    wrapper.appendChild(group);
  }

  providerFieldsContainer.appendChild(wrapper);
}

// Switch provider fields on change
providerSelect.addEventListener('change', () => {
  renderProviderFields(getProviderDef());
});

// Load saved config
loadConfig().then((config) => {
  if (config.provider) {
    providerSelect.value = config.provider.provider;
    const def = getProviderDef();
    renderProviderFields(def);

    if (def) {
      const values = def.fromConfig(config.provider);
      for (const [id, val] of Object.entries(values)) {
        const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
        if (el) el.value = val;
      }
    }
  }
  (document.getElementById('max-iterations') as HTMLInputElement).value = String(config.maxIterations);
});

function showMessage(text: string, type: 'success' | 'error' | 'info') {
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
    if (!val) {
      showMessage(`${field.label} is required.`, 'error');
      return null;
    }
    values[field.id] = val;
  }

  return def.toConfig(values);
}

// Save
document.getElementById('config-save')!.addEventListener('click', async () => {
  const providerConfig = getProviderConfig();
  if (!providerConfig) return;

  const maxIterations = parseInt((document.getElementById('max-iterations') as HTMLInputElement).value, 10) || 10;
  await saveConfig({ provider: providerConfig, maxIterations });
  showMessage('Configuration saved.', 'success');
});

// Test connection
document.getElementById('config-test')!.addEventListener('click', async () => {
  const providerConfig = getProviderConfig();
  if (!providerConfig) return;

  showMessage('Testing connection…', 'info');

  try {
    let provider;
    if (providerConfig.provider === 'openai') {
      const { OpenAIProvider } = await import('../lib/llm/openai');
      provider = new OpenAIProvider(providerConfig);
    } else {
      const { AzureOpenAIProvider } = await import('../lib/llm/azure-openai');
      provider = new AzureOpenAIProvider(providerConfig);
    }

    await provider.chatCompletion(
      [{ role: 'user', content: 'Say "ok"' }],
      []
    );
    showMessage('Connection successful!', 'success');
  } catch (e) {
    showMessage(`Connection failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
  }
});

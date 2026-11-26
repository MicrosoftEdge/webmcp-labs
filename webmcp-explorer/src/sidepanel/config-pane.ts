// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { loadConfig, saveConfig } from '../lib/storage';
import type { ProviderConfig, ProviderMetadata } from '../lib/llm/provider';
import { PROVIDERS } from '../lib/llm/registry';

// --- In-memory cache for per-provider configs ---
let providerConfigs: Record<string, ProviderConfig> = {};
let signInController: AbortController | null = null;
let refreshAuthenticationStatus: (() => Promise<void>) | null = null;

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
  signInController?.abort();
  signInController = null;
  refreshAuthenticationStatus = null;
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
      ${def.authentication ? `
        <div class="stack gap-sm" id="provider-auth">
          <div id="provider-auth-status" role="status">Checking sign-in status...</div>
          <div class="row gap-sm">
            <button class="btn btn-primary" id="provider-sign-in" disabled>Sign in with GitHub</button>
            <button class="btn btn-neutral" id="provider-sign-out" disabled>Sign out</button>
            <button class="btn btn-neutral" id="provider-sign-in-cancel" hidden>Cancel</button>
          </div>
          <div id="provider-device-code" role="status" hidden></div>
        </div>
      ` : ''}
    </div>`;
  for (const field of def.fields) {
    if (!field.description && !field.documentationUrl) continue;
    const control = document.getElementById(field.id)!;
    const help = document.createElement('p');
    help.id = `${field.id}-help`;
    help.className = 'text-secondary';
    help.textContent = field.description ?? '';
    control.setAttribute('aria-describedby', help.id);
    if (field.documentationUrl) {
      const link = document.createElement('a');
      link.href = field.documentationUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Source and documentation';
      help.append(' ', link);
    }
    control.after(help);
  }
  if (def.description) {
    const description = document.createElement('p');
    description.className = 'text-secondary';
    description.textContent = def.description;
    providerFieldsContainer.prepend(description);
  }
  if (def.authentication) wireAuthentication(def, def.authentication);
}

function draftProviderConfig(def: ProviderMetadata): ProviderConfig {
  const config: ProviderConfig = { provider: def.key };
  for (const field of def.fields) {
    const element = document.getElementById(field.id) as HTMLInputElement | HTMLSelectElement;
    config[field.configKey] = element.value.trim();
  }
  return config;
}

async function requestHostPermissions(def: ProviderMetadata): Promise<void> {
  if (def.hostPermissions && !await chrome.permissions.request({ origins: def.hostPermissions })) {
    throw new Error('Permission to connect to GitHub and Copilot is required.');
  }
}

function wireAuthentication(def: ProviderMetadata, authentication: NonNullable<ProviderMetadata['authentication']>) {
  const container = document.getElementById('provider-auth')!;
  const status = document.getElementById('provider-auth-status')!;
  const signIn = document.getElementById('provider-sign-in') as HTMLButtonElement;
  const signOut = document.getElementById('provider-sign-out') as HTMLButtonElement;
  const cancel = document.getElementById('provider-sign-in-cancel') as HTMLButtonElement;
  const deviceCode = document.getElementById('provider-device-code')!;
  let statusRequest = 0;

  async function refreshStatus() {
    if (signInController || !container.isConnected) return;
    const request = ++statusRequest;
    try {
      const signedIn = await authentication.isSignedIn(draftProviderConfig(def));
      if (!container.isConnected || signInController || request !== statusRequest) return;
      status.textContent = signedIn
        ? 'Signed in for this browser session. Test Connection verifies Copilot access.'
        : 'Not signed in for this OAuth client.';
      signIn.disabled = false;
      // Also allow clearing expired or malformed credentials.
      signOut.disabled = false;
    } catch (error) {
      if (!container.isConnected || signInController || request !== statusRequest) return;
      status.textContent = 'Unable to read sign-in status.';
      signIn.disabled = false;
      signOut.disabled = false;
      showMessage(error instanceof Error ? error.message : String(error), 'error');
    }
  }
  refreshAuthenticationStatus = refreshStatus;
  for (const field of def.fields) {
    document.getElementById(field.id)!.addEventListener('change', () => void refreshStatus());
  }
  signIn.addEventListener('click', async () => {
    const controller = new AbortController();
    signInController = controller;
    signIn.disabled = true;
    signOut.disabled = true;
    cancel.hidden = false;
    messageEl.hidden = true;
    status.textContent = 'Starting GitHub sign-in...';
    try {
      await requestHostPermissions(def);
      controller.signal.throwIfAborted();
      await authentication.signIn(draftProviderConfig(def), (code, verificationUrl) => {
        if (!container.isConnected || controller.signal.aborted) return;
        const instructions = document.createElement('p');
        instructions.textContent = 'Enter this code on GitHub: ';
        const codeElement = document.createElement('code');
        codeElement.textContent = code;
        instructions.append(codeElement);
        const link = document.createElement('a');
        link.href = verificationUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Open GitHub to authorize';
        deviceCode.replaceChildren(instructions, link);
        deviceCode.hidden = false;
        status.textContent = 'Waiting for GitHub authorization. Keep this panel open.';
      }, controller.signal);
      if (container.isConnected) showMessage('GitHub sign-in complete. Save your settings, then Test Connection.', 'success');
    } catch (error) {
      if (container.isConnected) {
        const text = controller.signal.aborted ? 'GitHub sign-in cancelled.'
          : error instanceof DOMException && error.name === 'TimeoutError'
            ? 'GitHub sign-in timed out. Please try again.'
            : error instanceof Error ? error.message : String(error);
        showMessage(text, controller.signal.aborted ? 'info' : 'error');
      }
    } finally {
      if (signInController === controller) signInController = null;
      if (container.isConnected) {
        cancel.hidden = true;
        deviceCode.hidden = true;
        deviceCode.replaceChildren();
        await refreshStatus();
      }
    }
  });
  cancel.addEventListener('click', () => signInController?.abort());
  signOut.addEventListener('click', async () => {
    signIn.disabled = true;
    signOut.disabled = true;
    try {
      await authentication.signOut();
      if (container.isConnected) {
        showMessage('GitHub credentials cleared from this extension. This does not revoke the shared OAuth authorization on GitHub.', 'success');
      }
    } catch (error) {
      if (container.isConnected) showMessage(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      await refreshStatus();
    }
  });
  queueMicrotask(() => void refreshStatus());
}

window.addEventListener('pagehide', () => signInController?.abort());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && Object.keys(changes).some((key) => key.startsWith('webmcp-explorer-copilot-'))) {
    void refreshAuthenticationStatus?.();
  }
});

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
    if (el) el.value = cached[field.configKey] ?? field.defaultValue ?? '';
  }
}

// Switch provider fields on change
providerSelect.addEventListener('change', () => {
  messageEl.hidden = true;
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
    await requestHostPermissions(meta);
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

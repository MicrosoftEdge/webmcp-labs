// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { RegisteredTool } from '../types/webmcp.d';

/**
 * Tools Pane — available tools list + execute tool form with dropdown.
 */

const listEl = document.getElementById('tools-list')!;
const emptyEl = document.getElementById('tools-empty')!;
const badge = document.getElementById('tools-badge');

// Execute form elements
const toolSelect = document.getElementById('tool-select')! as HTMLSelectElement;
const toolArgs = document.getElementById('tool-args')! as HTMLTextAreaElement;
const executeBtn = document.getElementById('tool-execute')! as HTMLButtonElement;
const resultEl = document.getElementById('tool-result')!;

let currentTools: RegisteredTool[] = [];

async function getActiveTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

function updateBadge(count: number) {
  if (badge) {
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function tryParseJSON(str: string): Record<string, unknown> | null {
  try { return JSON.parse(str); } catch { return null; }
}

/** Generate a stub JSON object from a JSON Schema's properties. */
function generateStubFromSchema(schema: Record<string, unknown>): Record<string, unknown> | null {
  if (schema.type !== 'object' || !schema.properties) return null;
  const props = schema.properties as Record<string, Record<string, unknown>>;
  const stub: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(props)) {
    if (Array.isArray(prop.enum) && prop.enum.length > 0) {
      stub[key] = prop.enum[0];
    } else {
      switch (prop.type) {
        case 'string':  stub[key] = ''; break;
        case 'number':
        case 'integer': stub[key] = 0; break;
        case 'boolean': stub[key] = false; break;
        case 'array':   stub[key] = []; break;
        case 'object':  stub[key] = {}; break;
        default:        stub[key] = null; break;
      }
    }
  }
  return stub;
}

/** Pre-fill the args textarea with a stub from the selected tool's inputSchema. */
function prefillArgs(toolName: string) {
  const tool = currentTools.find(t => t.name === toolName);
  if (!tool?.inputSchema) { toolArgs.value = ''; return; }
  const schema = tryParseJSON(tool.inputSchema);
  if (!schema) { toolArgs.value = ''; return; }
  const stub = generateStubFromSchema(schema);
  if (stub) {
    toolArgs.value = JSON.stringify(stub, null, 2);
  } else {
    toolArgs.value = '';
  }
}

// When tool selection changes, prefill args
toolSelect.addEventListener('change', () => {
  resultEl.className = '';
  resultEl.innerHTML = '<pre class="code-block"></pre>';
  prefillArgs(toolSelect.value);
});

function renderTools(tools: RegisteredTool[]) {
  currentTools = tools;
  listEl.innerHTML = '';
  emptyEl.hidden = tools.length > 0;
  updateBadge(tools.length);

  // Populate list cards
  for (const tool of tools) {
    const item = document.createElement('div');
    item.className = 'tool-list-item card';
    item.title = tool.description;

    item.innerHTML = `
      <div class="row" style="justify-content: space-between; gap: var(--smtc-gap-between-content-small);">
        <strong class="tool-list-item-name">${escapeHtml(tool.name)}</strong>
        <span class="tool-list-item-desc">${escapeHtml(tool.description)}</span>
      </div>
    `;

    // Clicking a list item selects it in the dropdown
    item.addEventListener('click', () => {
      toolSelect.value = tool.name;
      toolSelect.dispatchEvent(new Event('change'));
    });

    listEl.appendChild(item);
  }

  // Populate dropdown
  const prevSelected = toolSelect.value;
  toolSelect.innerHTML = '';
  for (const tool of tools) {
    const opt = document.createElement('option');
    opt.value = tool.name;
    opt.textContent = tool.name;
    toolSelect.appendChild(opt);
  }

  // Restore previous selection or default to first
  if (tools.find(t => t.name === prevSelected)) {
    toolSelect.value = prevSelected;
  } else if (tools.length > 0) {
    toolSelect.value = tools[0].name;
  }

  // Prefill args from schema and reset result
  prefillArgs(toolSelect.value);
  resultEl.className = '';
  resultEl.innerHTML = '<pre class="code-block"></pre>';
}

function showResult(text: string, isError: boolean) {
  if (isError) {
    resultEl.className = 'message-bar message-bar-error';
    resultEl.textContent = text;
  } else {
    resultEl.className = '';
    resultEl.innerHTML = `<pre class="code-block">${escapeHtml(text)}</pre>`;
  }
}

// Execute button
executeBtn.addEventListener('click', async () => {
  const toolName = toolSelect.value;
  if (!toolName) return;

  const tabId = await getActiveTabId();
  if (tabId == null) { showResult('No active tab.', true); return; }

  const args = toolArgs.value.trim() || '{}';
  executeBtn.disabled = true;
  executeBtn.innerHTML = '<span class="spinner"></span> Running\u2026';

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'executeTool', name: toolName, args,
    });
    if (response.type === 'error') {
      showResult(response.message, true);
    } else {
      showResult(response.result ?? '(null)', false);
    }
  } catch (e) {
    showResult(`Failed: ${e instanceof Error ? e.message : String(e)}`, true);
  } finally {
    executeBtn.disabled = false;
    executeBtn.textContent = 'Execute';
  }
});

async function fetchTools() {
  const tabId = await getActiveTabId();
  if (tabId == null) {
    listEl.innerHTML = '';
    emptyEl.hidden = false;
    emptyEl.textContent = 'No tools available.';
    updateBadge(0);
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'listTools' });
    if (response.type === 'error') {
      listEl.innerHTML = '';
      emptyEl.hidden = false;
      emptyEl.textContent = 'No tools available.';
      updateBadge(0);
    } else {
      renderTools(response.tools);
    }
  } catch {
    listEl.innerHTML = '';
    emptyEl.hidden = false;
    emptyEl.textContent = 'No tools available.';
    updateBadge(0);
  }
}

// Listen for toolchange events
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'toolchange') fetchTools();
});

// Auto-refresh on tab navigation
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === 'complete') fetchTools();
});
chrome.tabs.onActivated.addListener(() => fetchTools());

// Initial fetch
fetchTools();

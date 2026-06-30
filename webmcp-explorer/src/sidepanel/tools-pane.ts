// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { RegisteredTool } from '../types/webmcp.d';
import { coerceSchemaObject } from '../lib/schema';

/**
 * Tools Pane — available tools list + execute tool form with dropdown.
 *
 * Tools are grouped by origin. The "From <origin>" header is shown when
 * either (a) there are multiple origins, or (b) there is a single origin
 * that doesn't match the top frame (e.g. only an iframe registered tools).
 * In the common case where the page you're looking at registered every
 * tool itself, no headers are shown — they'd be noise.
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

/**
 * Composite identity for a tool. Tools are unique by (origin, name), but the
 * dropdown `<option>` value and selection lookups need a single string, so we
 * join the two. Origins and tool names never contain a newline, so it is a
 * safe separator.
 */
function toolKey(t: { origin: string; name: string }): string {
  return `${t.origin}\n${t.name}`;
}

function findToolByKey(key: string): RegisteredTool | undefined {
  return currentTools.find(t => toolKey(t) === key);
}

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

/** Strip http(s):// from an origin for display. Other schemes pass through. */
function formatOrigin(origin: string): string {
  return origin.replace(/^https?:\/\//, '');
}

/**
 * Group tools by their origin, preserving first-seen order both for groups
 * and for tools within a group.
 */
function groupToolsByOrigin(tools: RegisteredTool[]): Map<string, RegisteredTool[]> {
  const groups = new Map<string, RegisteredTool[]>();
  for (const tool of tools) {
    const existing = groups.get(tool.origin);
    if (existing) existing.push(tool);
    else groups.set(tool.origin, [tool]);
  }
  return groups;
}

/**
 * Decide whether to show "From <origin>" headers. We hide them only when
 * every tool comes from the top frame's own origin — anything else
 * (cross-origin iframe, mixed origins) is worth surfacing visually.
 */
function shouldShowGroupHeaders(
  groups: Map<string, RegisteredTool[]>,
  topOrigin: string,
): boolean {
  if (groups.size > 1) return true;
  if (groups.size === 1) {
    const [onlyOrigin] = groups.keys();
    return onlyOrigin !== topOrigin;
  }
  return false;
}

/**
 * Generate a stub JSON object from a tool's raw input schema, where each value
 * is a typed placeholder token (e.g. `<string>`) the user replaces with a real
 * value. Enum fields list their options as `<one of: a | b | c>`.
 *
 * Accepts the schema as an object or a JSON string (via coerceSchemaObject),
 * and tolerates schemas that omit a top-level `type: 'object'` as long as they
 * declare `properties`.
 */
function generateStubFromSchema(rawSchema: unknown): Record<string, unknown> | null {
  const schema = coerceSchemaObject(rawSchema);
  if (!schema) return null;

  const props = schema.properties;
  if (!props || typeof props !== 'object') {
    // An object schema with no declared properties — give the user a valid
    // empty-object starting point rather than a blank box.
    return schema.type === 'object' ? {} : null;
  }

  const stub: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(props as Record<string, Record<string, unknown>>)) {
    if (Array.isArray(prop.enum) && prop.enum.length > 0) {
      stub[key] = `<one of: ${prop.enum.join(' | ')}>`;
    } else {
      const type = Array.isArray(prop.type)
        ? prop.type.join('|')
        : typeof prop.type === 'string'
          ? prop.type
          : 'any';
      stub[key] = `<${type}>`;
    }
  }
  return stub;
}

/** Pre-fill the args textarea with a typed stub from the selected tool's inputSchema. */
function prefillArgs(toolKeyValue: string) {
  const tool = findToolByKey(toolKeyValue);
  const stub = tool ? generateStubFromSchema(tool.inputSchema) : null;
  toolArgs.value = stub ? JSON.stringify(stub, null, 2) : '';
}

// When tool selection changes, prefill args
toolSelect.addEventListener('change', () => {
  resultEl.className = '';
  resultEl.innerHTML = '<pre class="code-block"></pre>';
  prefillArgs(toolSelect.value);
});

/** Build a single card element for a tool. */
function buildToolCard(tool: RegisteredTool): HTMLDivElement {
  const item = document.createElement('div');
  item.className = 'tool-list-item card';
  // Hover tooltip carries the full description (the visible text is clamped
  // to a few lines via CSS) plus origin as a secondary provenance hint.
  const titleParts: string[] = [];
  if (tool.description) titleParts.push(tool.description);
  titleParts.push(`From ${formatOrigin(tool.origin)}`);
  item.title = titleParts.join('\n\n');

  const displayLabel = tool.title && tool.title !== tool.name ? tool.title : tool.name;
  const nameSuffix = tool.title && tool.title !== tool.name
    ? ` <span class="tool-list-item-rawname">${escapeHtml(tool.name)}</span>`
    : '';

  item.innerHTML = `
    <strong class="tool-list-item-name">${escapeHtml(displayLabel)}${nameSuffix}</strong>
    <span class="tool-list-item-desc">${escapeHtml(tool.description ?? '')}</span>
  `;

  // Clicking a list item selects it in the dropdown
  item.addEventListener('click', () => {
    toolSelect.value = toolKey(tool);
    toolSelect.dispatchEvent(new Event('change'));
  });

  return item;
}

function renderTools(tools: RegisteredTool[], topOrigin: string) {
  currentTools = tools;
  listEl.innerHTML = '';
  emptyEl.hidden = tools.length > 0;
  updateBadge(tools.length);

  const groups = groupToolsByOrigin(tools);
  const showHeaders = shouldShowGroupHeaders(groups, topOrigin);

  // Populate list — either flat (when single-origin matches top) or grouped.
  for (const [origin, originTools] of groups) {
    if (showHeaders) {
      const groupEl = document.createElement('div');
      groupEl.className = 'tool-group';

      const headerEl = document.createElement('div');
      headerEl.className = 'tool-group-header';
      headerEl.textContent = formatOrigin(origin);
      headerEl.title = origin;
      groupEl.appendChild(headerEl);

      const cardsEl = document.createElement('div');
      cardsEl.className = 'stack gap-xs';
      for (const tool of originTools) cardsEl.appendChild(buildToolCard(tool));
      groupEl.appendChild(cardsEl);

      listEl.appendChild(groupEl);
    } else {
      for (const tool of originTools) listEl.appendChild(buildToolCard(tool));
    }
  }

  // Populate dropdown — mirror the same grouping rule with <optgroup>.
  const prevSelected = toolSelect.value;
  toolSelect.innerHTML = '';
  for (const [origin, originTools] of groups) {
    const optionParent: HTMLSelectElement | HTMLOptGroupElement = showHeaders
      ? (() => {
          const og = document.createElement('optgroup');
          og.label = formatOrigin(origin);
          toolSelect.appendChild(og);
          return og;
        })()
      : toolSelect;

    for (const tool of originTools) {
      const opt = document.createElement('option');
      opt.value = toolKey(tool);
      opt.textContent = tool.title && tool.title !== tool.name
        ? `${tool.title} (${tool.name})`
        : tool.name;
      optionParent.appendChild(opt);
    }
  }

  // Restore previous selection or default to first
  if (currentTools.some(t => toolKey(t) === prevSelected)) {
    toolSelect.value = prevSelected;
  } else if (tools.length > 0) {
    toolSelect.value = toolKey(tools[0]);
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
  const selectedKey = toolSelect.value;
  if (!selectedKey) return;

  const tool = findToolByKey(selectedKey);
  if (!tool) { showResult('Selected tool is no longer available.', true); return; }

  const tabId = await getActiveTabId();
  if (tabId == null) { showResult('No active tab.', true); return; }

  const args = toolArgs.value.trim() || '{}';
  executeBtn.disabled = true;
  executeBtn.innerHTML = '<span class="spinner"></span> Running\u2026';

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'executeTool', name: tool.name, origin: tool.origin, args,
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
      renderTools(response.tools, response.topOrigin);
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


import type { RegisteredTool } from '../types/webmcp.d';

/**
 * Tools Pane — wires up event listeners on the static HTML.
 * Only the tool card list (#tools-list) is dynamically rendered since the
 * number of tools is unknown at build time.
 */

const listEl = document.getElementById('tools-list')!;
const emptyEl = document.getElementById('tools-empty')!;
const badge = document.getElementById('tools-badge');

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

function renderTools(tools: RegisteredTool[]) {
  listEl.innerHTML = '';
  emptyEl.hidden = tools.length > 0;
  updateBadge(tools.length);

  for (const tool of tools) {
    const card = document.createElement('div');
    card.className = 'card stack gap-sm';

    const parsedSchema = tool.inputSchema ? tryParseJSON(tool.inputSchema) : null;

    card.innerHTML = `
      <div>
        <strong>${escapeHtml(tool.name)}</strong>
        <div class="text-secondary" style="font-size: var(--smtc-text-global-body3-font-size);">
          ${escapeHtml(tool.description)}
        </div>
      </div>
      ${parsedSchema ? `
        <button class="accordion-header" aria-expanded="false">Input Schema</button>
        <div class="accordion-content">
          <pre class="code-block">${escapeHtml(JSON.stringify(parsedSchema, null, 2))}</pre>
        </div>
      ` : ''}
      <div class="stack gap-sm">
        <textarea class="textarea tool-args" rows="3" placeholder='{"key": "value"}'></textarea>
        <div class="row gap-sm">
          <button class="btn btn-primary btn-sm tool-execute">Execute</button>
        </div>
        <div class="tool-result" hidden></div>
      </div>
    `;

    // Accordion toggle
    const accHeader = card.querySelector<HTMLButtonElement>('.accordion-header');
    accHeader?.addEventListener('click', () => {
      const expanded = accHeader.getAttribute('aria-expanded') === 'true';
      accHeader.setAttribute('aria-expanded', String(!expanded));
      accHeader.nextElementSibling?.classList.toggle('open', !expanded);
    });

    // Execute
    const executeBtn = card.querySelector<HTMLButtonElement>('.tool-execute')!;
    const argsTextarea = card.querySelector<HTMLTextAreaElement>('.tool-args')!;
    const resultEl = card.querySelector<HTMLElement>('.tool-result')!;

    executeBtn.addEventListener('click', async () => {
      const tabId = await getActiveTabId();
      if (tabId == null) { showResult(resultEl, 'No active tab.', true); return; }

      const args = argsTextarea.value.trim() || '{}';
      executeBtn.disabled = true;
      executeBtn.innerHTML = '<span class="spinner"></span> Running…';

      try {
        const response = await chrome.tabs.sendMessage(tabId, {
          type: 'executeTool', name: tool.name, args,
        });
        if (response.type === 'error') {
          showResult(resultEl, response.message, true);
        } else {
          showResult(resultEl, response.result ?? '(null)', false);
        }
      } catch (e) {
        showResult(resultEl, `Failed: ${e instanceof Error ? e.message : String(e)}`, true);
      } finally {
        executeBtn.disabled = false;
        executeBtn.textContent = 'Execute';
      }
    });

    listEl.appendChild(card);
  }
}

function showResult(el: HTMLElement, text: string, isError: boolean) {
  el.hidden = false;
  if (isError) {
    el.className = 'message-bar message-bar-error tool-result';
    el.textContent = text;
  } else {
    el.className = 'tool-result';
    el.innerHTML = `<pre class="code-block">${escapeHtml(text)}</pre>`;
  }
}

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

// Refresh button
document.getElementById('tools-refresh')!.addEventListener('click', fetchTools);

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

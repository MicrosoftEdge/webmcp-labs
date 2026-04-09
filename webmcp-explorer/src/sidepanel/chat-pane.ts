// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { marked } from 'marked';
import { loadConfig } from '../lib/storage';
import type { LLMProvider, Message, ToolDefinition, ToolCall } from '../lib/llm/provider';
import { PROVIDERS } from '../lib/llm/registry';

// --- Marked configuration ---
marked.setOptions({ breaks: true, gfm: true });

// --- DOM references ---
const messagesEl = document.getElementById('chat-messages')!;
const emptyEl = document.getElementById('chat-empty')!;
const inputEl = document.getElementById('chat-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('chat-send') as HTMLButtonElement;
const stopBtn = document.getElementById('chat-stop') as HTMLButtonElement;
const resetBtn = document.getElementById('chat-reset') as HTMLButtonElement;

// --- State ---
type ChatState = 'idle' | 'responding';
let state: ChatState = 'idle';
let messages: Message[] = [];
let abortController: AbortController | null = null;

// --- Constants ---
const SYSTEM_PROMPT = `You are a helpful assistant. The user is on a web page that exposes tools you can call.
Use the available tools when they help answer the user's question or accomplish their request.
Respond conversationally. Format your responses in Markdown when it improves readability.`;

// --- Helpers ---
async function getActiveTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function createProvider(): Promise<LLMProvider | null> {
  const config = await loadConfig();
  if (!config.provider) return null;
  const meta = PROVIDERS.find((p) => p.key === config.provider!.provider);
  return meta ? meta.createProvider(config.provider) : null;
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/**
 * Sanitizer for assistant chat messages.
 * Start from default (XSS-safe) and allow markdown-rendered elements.
 */
const chatSanitizer = new Sanitizer();
for (const el of ['ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img', 'hr']) {
  chatSanitizer.allowElement(el);
}
for (const attr of ['class', 'href', 'target', 'rel', 'src', 'alt', 'colspan', 'rowspan']) {
  chatSanitizer.allowAttribute(attr);
}

/**
 * Make all links in rendered HTML open in a new tab safely.
 */
function makeLinksExternal(container: HTMLElement) {
  for (const a of container.querySelectorAll('a')) {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  }
}

function renderMarkdown(text: string): string {
  return marked.parse(text) as string;
}

async function fetchPageTools(tabId: number): Promise<ToolDefinition[]> {
  const response = await chrome.tabs.sendMessage(tabId, { type: 'listTools' });
  if (response.type === 'listTools') {
    return response.tools.map((t: { name: string; description: string; inputSchema?: string }) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema ? JSON.parse(t.inputSchema) : { type: 'object', properties: {} },
    }));
  }
  return [];
}

// --- UI helpers ---
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showMessages() {
  emptyEl.hidden = true;
  messagesEl.hidden = false;
}

function showEmpty() {
  emptyEl.hidden = false;
  messagesEl.hidden = true;
}

function setState(next: ChatState) {
  state = next;
  sendBtn.disabled = next === 'responding';
  stopBtn.disabled = next === 'idle';
  inputEl.disabled = next === 'responding';
}

function appendUserBubble(text: string) {
  showMessages();
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble chat-bubble-user';
  bubble.textContent = text;
  messagesEl.appendChild(bubble);
  scrollToBottom();
}

function appendAssistantBubble(html: string): HTMLElement {
  showMessages();
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble chat-bubble-assistant';
  const content = document.createElement('div');
  content.className = 'chat-message-content';
  content.setHTML(html, { sanitizer: chatSanitizer });
  makeLinksExternal(content);
  bubble.appendChild(content);
  messagesEl.appendChild(bubble);
  scrollToBottom();
  return bubble;
}

function appendErrorBubble(text: string) {
  showMessages();
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble chat-bubble-error';
  bubble.textContent = text;
  messagesEl.appendChild(bubble);
  scrollToBottom();
}

function showTypingIndicator(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'chat-typing';
  el.innerHTML = '<span class="chat-typing-dot"></span><span class="chat-typing-dot"></span><span class="chat-typing-dot"></span>';
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function removeTypingIndicator(el: HTMLElement) {
  el.remove();
}

function appendToolCard(toolCall: ToolCall): { card: HTMLElement; bodyEl: HTMLElement } {
  const card = document.createElement('div');
  card.className = 'chat-tool-card';

  const header = document.createElement('button');
  header.className = 'chat-tool-header';
  header.setAttribute('aria-expanded', 'false');

  const nameSpan = document.createElement('span');
  nameSpan.textContent = toolCall.name;

  header.appendChild(nameSpan);

  const body = document.createElement('div');
  body.className = 'chat-tool-body';

  // Args section
  const argsLabel = document.createElement('span');
  argsLabel.className = 'label';
  argsLabel.textContent = 'Arguments';
  const argsBlock = document.createElement('pre');
  argsBlock.className = 'code-block';
  argsBlock.textContent = prettyJson(toolCall.arguments);
  body.appendChild(argsLabel);
  body.appendChild(argsBlock);

  // Toggle collapse
  header.addEventListener('click', () => {
    const expanded = header.getAttribute('aria-expanded') === 'true';
    header.setAttribute('aria-expanded', String(!expanded));
    body.classList.toggle('open', !expanded);
  });

  card.appendChild(header);
  card.appendChild(body);
  messagesEl.appendChild(card);
  scrollToBottom();

  return { card, bodyEl: body };
}

function updateToolCardResult(bodyEl: HTMLElement, result: string, isError: boolean) {
  const resultLabel = document.createElement('span');
  resultLabel.className = 'label';
  resultLabel.textContent = isError ? 'Error' : 'Result';
  if (isError) resultLabel.style.color = 'var(--smtc-status-danger-tint-foreground)';

  const resultBlock = document.createElement('pre');
  resultBlock.className = 'code-block';
  resultBlock.textContent = result;

  bodyEl.appendChild(resultLabel);
  bodyEl.appendChild(resultBlock);
}

/**
 * Trim messages to stay within the configured cap.
 * Keeps the most recent messages, always preserving the first user message
 * so the conversation makes sense.
 */
function trimMessages(maxMessages: number) {
  if (messages.length <= maxMessages) return;
  // Keep the first message (initial user message) and the most recent messages
  const keep = maxMessages - 1;
  messages = [messages[0], ...messages.slice(-keep)];
}

// --- Main send handler ---
async function handleSend() {
  const text = inputEl.value.trim();
  if (!text || state === 'responding') return;

  const provider = await createProvider();
  if (!provider) {
    appendErrorBubble('Configure an LLM provider first (Config tab).');
    return;
  }

  const tabId = await getActiveTabId();
  if (tabId == null) {
    appendErrorBubble('No active tab.');
    return;
  }

  // Load config for maxChatMessages
  const config = await loadConfig();

  // Show user message
  appendUserBubble(text);
  inputEl.value = '';
  messages.push({ role: 'user', content: text });

  // Trim if over limit
  trimMessages(config.maxChatMessages);

  abortController = new AbortController();
  setState('responding');

  // Agentic loop: keep calling LLM until we get a text-only response (no tool calls)
  const MAX_TOOL_ROUNDS = 20; // safety cap to prevent infinite tool loops
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (abortController.signal.aborted) break;

    // Fetch page tools
    let pageTools: ToolDefinition[] = [];
    try {
      pageTools = await fetchPageTools(tabId);
    } catch { /* page might not have tools — continue without */ }

    const typing = showTypingIndicator();

    let result;
    try {
      result = await provider.sendMessage(SYSTEM_PROMPT, messages, pageTools, { signal: abortController.signal });
    } catch (e) {
      removeTypingIndicator(typing);
      if (!abortController.signal.aborted) {
        appendErrorBubble(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
      break;
    }

    removeTypingIndicator(typing);

    // No tool calls — final text response
    if (result.toolCalls.length === 0) {
      const responseText = result.text ?? '(no response)';
      appendAssistantBubble(renderMarkdown(responseText));
      messages.push({ role: 'assistant', content: responseText });
      break;
    }

    // Has tool calls — record assistant message, execute tools, then loop
    messages.push({ role: 'assistant', content: result.text ?? '', toolCalls: result.toolCalls });

    // Show assistant's thinking text if present
    if (result.text) {
      appendAssistantBubble(renderMarkdown(result.text));
    }

    // Execute each tool call
    for (const tc of result.toolCalls) {
      if (abortController.signal.aborted) break;

      const { bodyEl } = appendToolCard(tc);

      try {
        const response = await chrome.tabs.sendMessage(tabId, {
          type: 'executeTool', name: tc.name, args: tc.arguments,
        });
        const toolResult = response.type === 'error' ? `Error: ${response.message}` : (response.result ?? '(null)');
        const isError = response.type === 'error';
        updateToolCardResult(bodyEl, toolResult, isError);
        messages.push({ role: 'tool', toolCallId: tc.id, content: toolResult });
      } catch (e) {
        console.error(`[chat] tool "${tc.name}" threw:`, e);
        const errMsg = e instanceof Error ? e.message : String(e);
        updateToolCardResult(bodyEl, errMsg, true);
        messages.push({ role: 'tool', toolCallId: tc.id, content: `Error: ${errMsg}` });
      }
    }

    // Trim after tool results are added
    trimMessages(config.maxChatMessages);
  }

  setState('idle');
  if (abortController?.signal.aborted) {
    appendErrorBubble('Stopped.');
  }
  abortController = null;
  inputEl.focus();
}

// --- Button wiring ---
sendBtn.addEventListener('click', handleSend);

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

stopBtn.addEventListener('click', () => {
  abortController?.abort();
});

resetBtn.addEventListener('click', () => {
  abortController?.abort();
  messages = [];
  messagesEl.innerHTML = '';
  showEmpty();
  setState('idle');
  inputEl.value = '';
  inputEl.focus();
});

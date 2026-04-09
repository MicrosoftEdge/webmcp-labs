// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { loadConfig } from '../lib/storage';
import type { LLMProvider, Message, ToolDefinition } from '../lib/llm/provider';
import { PROVIDERS } from '../lib/llm/registry';

// --- DOM references ---
const goalInput = document.getElementById('agent-goal') as HTMLTextAreaElement;
const runBtn = document.getElementById('agent-run') as HTMLButtonElement;
const stepBtn = document.getElementById('agent-step') as HTMLButtonElement;
const stopBtn = document.getElementById('agent-stop') as HTMLButtonElement;
const resetBtn = document.getElementById('agent-reset') as HTMLButtonElement;
const statusEl = document.getElementById('agent-status')!;
const stepsEl = document.getElementById('agent-steps')!;
const detailEl = document.getElementById('agent-detail')!;

// --- Types ---
type AgentState = 'idle' | 'running' | 'stepping' | 'paused' | 'waiting';
type StepStatus = 'success' | 'error' | 'pending' | 'waiting' | 'done';

interface ToolInfo {
  name: string;
  system?: boolean;
}

interface StepData {
  name: string;
  status: StepStatus;
  args?: string;
  result?: string;
  error?: string;
  question?: string;
  thinking?: string;
  tools?: ToolInfo[];
}

// --- State ---
let state: AgentState = 'idle';
let mode: 'run' | 'step' = 'run';
let steps: StepData[] = [];
let selectedIndex: number | null = null;
let abortController: AbortController | null = null;
let messages: Message[] = [];
let stepResolver: (() => void) | null = null;
let askResolver: ((answer: string) => void) | null = null;

// --- Constants ---
const SYSTEM_PROMPT = `You have tools to interact with the current web page. Use them to accomplish the user's goal.

CRITICAL RULES:
- You MUST call a tool in EVERY response. Plain text responses immediately terminate the session.
- When you receive information from the user (via ask_user), use it to call the next appropriate page tool. Do NOT just repeat the information back as text.
- Call task_complete ONLY after you have fully completed the goal using the page tools.
- Call ask_user when you need information from the user. Never ask questions in plain text.
- After receiving a tool result, decide what tool to call next. Keep making progress.`;

const BUILT_IN_TOOLS: ToolDefinition[] = [
  {
    name: 'task_complete',
    description: 'Call when the goal is achieved. Provide a summary.',
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'Summary of what was done' } },
      required: ['summary'],
    },
  },
  {
    name: 'ask_user',
    description: 'Ask the user a clarifying question. The loop pauses until the user responds.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string', description: 'The question to ask' } },
      required: ['question'],
    },
  },
];

const SYSTEM_TOOL_NAMES = new Set(BUILT_IN_TOOLS.map(t => t.name));

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

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function tryParseJSON(str: string): Record<string, unknown> | null {
  try { return JSON.parse(str); } catch { return null; }
}

// --- UI: Controls ---
function setState(next: AgentState) {
  state = next;
  updateControls();
}

function updateControls() {
  const s = state;
  runBtn.disabled = s === 'running' || s === 'waiting';
  stepBtn.disabled = s === 'running' || s === 'waiting';
  stopBtn.disabled = s !== 'running';
  const hasContent = steps.length > 0 || goalInput.value.trim() !== '';
  resetBtn.disabled = s === 'idle' && !hasContent;
  goalInput.disabled = s !== 'idle';

  runBtn.textContent = s === 'paused' ? 'Resume' : 'Run';
}

// --- UI: Status bar ---
function setStatus(text: string, type: 'info' | 'error' | 'success') {
  statusEl.hidden = false;
  statusEl.className = `message-bar message-bar-${type}`;
  statusEl.textContent = text;
}

function clearStatus() {
  statusEl.hidden = true;
}

// --- UI: Step list ---
function addStep(name: string, status: StepStatus, data: Partial<StepData> = {}): number {
  const idx = steps.length;
  steps.push({ name, status, ...data });
  renderStepList();
  selectStep(idx);
  return idx;
}

function updateStep(idx: number, update: Partial<StepData>) {
  if (idx < 0 || idx >= steps.length) return;
  Object.assign(steps[idx], update);
  renderStepList();
  if (selectedIndex === idx) renderDetail(idx);
}

function renderStepList() {
  stepsEl.innerHTML = '';
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const row = document.createElement('div');
    row.className = `step-row${selectedIndex === i ? ' selected' : ''}`;
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');

    const indexSpan = `<span class="step-index">${i + 1}</span>`;
    const isModel = s.name === 'model call';
    const isSystem = SYSTEM_TOOL_NAMES.has(s.name);
    const nameSpan = `<span class="step-name${isModel ? ' step-name-model' : ''}">${escapeHtml(s.name)}${isSystem ? '<span class="tool-chip-label">system</span>' : ''}</span>`;

    let statusHtml = '';
    if (s.status === 'pending') {
      statusHtml = '<span class="step-status">pending</span>';
    } else if (s.status === 'waiting') {
      statusHtml = '<span class="step-status">waiting</span>';
    } else if (s.status === 'error') {
      statusHtml = '<span class="step-status step-status-error">error</span>';
    }

    row.innerHTML = indexSpan + nameSpan + statusHtml;
    row.addEventListener('click', () => selectStep(i));
    stepsEl.appendChild(row);
  }
}

function selectStep(idx: number) {
  selectedIndex = idx;
  // Update selected row highlight
  stepsEl.querySelectorAll('.step-row').forEach((el, i) => {
    el.classList.toggle('selected', i === idx);
  });
  renderDetail(idx);
}

// --- UI: Detail panel ---
function renderDetail(idx: number) {
  const s = steps[idx];
  if (!s) { detailEl.hidden = true; return; }
  detailEl.hidden = false;

  const headerStatus = s.status === 'error' ? ' &middot; error' : '';
  let html = `<div class="detail-header">Step ${idx + 1} &middot; ${escapeHtml(s.name)}${headerStatus}</div>`;

  // Tools available
  if (s.tools && s.tools.length > 0) {
    html += `<div class="detail-section">
      <span class="label">Available tools (${s.tools.length})</span>
      <div class="detail-tools">${s.tools.map(t =>
        `<span class="detail-tool-chip${t.system ? ' detail-tool-chip-system' : ''}">${escapeHtml(t.name)}${t.system ? '<span class="tool-chip-label">system</span>' : ''}</span>`
      ).join('')}</div>
    </div>`;
  }

  // Thinking
  if (s.thinking) {
    html += `<div class="detail-section">
      <span class="label">Thinking</span>
      <div class="detail-thinking">${escapeHtml(s.thinking)}</div>
    </div>`;
  }

  // Args (skip for ask_user when question is shown — it's redundant)
  if (s.args && !(s.question)) {
    html += `<div class="detail-section">
      <span class="label">Args</span>
      <pre class="code-block">${escapeHtml(prettyJson(s.args))}</pre>
    </div>`;
  }

  // Pending — step mode execute button
  if (s.status === 'pending') {
    html += `<div class="detail-section">
      <button class="btn btn-primary btn-sm" id="detail-execute-step">Execute this step</button>
    </div>`;
  }

  // ask_user question (always show if present)
  if (s.question) {
    html += `<div class="detail-section">
      <span class="label">Question</span>
      <div class="ask-user-question">${escapeHtml(s.question)}</div>
    </div>`;
  }

  // Waiting — ask_user inline input
  if (s.status === 'waiting' && s.question) {
    html += `<div class="detail-section">
      <div class="ask-user-row">
        <input class="input" id="detail-ask-input" type="text" placeholder="Your answer…" />
        <button class="btn btn-primary btn-sm" id="detail-ask-reply">Reply</button>
      </div>
    </div>`;
  }

  // Result
  if (s.result != null) {
    html += `<div class="detail-section">
      <span class="label">Result</span>
      <pre class="code-block">${escapeHtml(s.result)}</pre>
    </div>`;
  }

  // Error
  if (s.error != null) {
    html += `<div class="detail-section">
      <span class="label" style="color: var(--smtc-status-danger-tint-foreground)">Error</span>
      <pre class="code-block">${escapeHtml(s.error)}</pre>
    </div>`;
  }

  detailEl.innerHTML = html;

  // Wire up pending execute button
  const execBtn = document.getElementById('detail-execute-step');
  if (execBtn) {
    execBtn.addEventListener('click', () => {
      if (stepResolver) { stepResolver(); stepResolver = null; }
    });
  }

  // Wire up ask_user reply
  const replyBtn = document.getElementById('detail-ask-reply');
  const replyInput = document.getElementById('detail-ask-input') as HTMLInputElement | null;
  if (replyBtn && replyInput) {
    const submit = () => {
      const answer = replyInput.value.trim() || '(no answer)';
      if (askResolver) { askResolver(answer); askResolver = null; }
    };
    replyBtn.addEventListener('click', submit);
    replyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    replyInput.focus();
  }
}

// --- Agent loop ---
async function runAgentLoop(startMode: 'run' | 'step') {
  const goal = goalInput.value.trim();
  if (!goal) { setStatus('Please enter a goal.', 'error'); return; }

  const provider = await createProvider();
  if (!provider) { setStatus('Configure an LLM provider first (Config tab).', 'error'); return; }

  const config = await loadConfig();
  const maxIterations = config.maxIterations;

  const tabId = await getActiveTabId();
  if (tabId == null) { setStatus('No active tab.', 'error'); return; }

  mode = startMode;
  abortController = new AbortController();
  steps = [];
  messages = [{ role: 'user', content: goal }];
  selectedIndex = null;
  stepsEl.innerHTML = '';
  detailEl.hidden = true;
  setState(startMode === 'run' ? 'running' : 'stepping');
  setStatus('Running…', 'info');

  async function fetchPageTools(): Promise<ToolDefinition[]> {
    const response = await chrome.tabs.sendMessage(tabId!, { type: 'listTools' });
    if (response.type === 'listTools') {
      return response.tools.map((t: { name: string; description: string; inputSchema?: string }) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema ? JSON.parse(t.inputSchema) : { type: 'object', properties: {} },
      }));
    }
    return [];
  }

  // Initial tool fetch — verify connectivity
  let pageTools: ToolDefinition[];
  try {
    pageTools = await fetchPageTools();
  } catch {
    setStatus('Could not connect to page.', 'error');
    setState('idle');
    return;
  }

  for (let i = 0; i < maxIterations; i++) {
    if (abortController.signal.aborted) {
      setStatus('Stopped by user.', 'info');
      break;
    }

    // Refresh tools from page before each LLM call
    try {
      pageTools = await fetchPageTools();
    } catch { /* keep previous tools if refresh fails */ }
    const allTools = [...pageTools, ...BUILT_IN_TOOLS];
    const builtInNames = new Set(BUILT_IN_TOOLS.map(t => t.name));
    const toolInfos: ToolInfo[] = allTools.map(t => ({ name: t.name, system: builtInNames.has(t.name) || undefined }));

    // In step mode, show a pending Model call step and pause before calling LLM
    let modelStepIdx: number | null = null;
    if (mode === 'step') {
      modelStepIdx = addStep('model call', 'pending', { tools: toolInfos });
      setState('paused');
      setStatus('Paused. Step to call model.', 'info');
      await new Promise<void>((resolve) => { stepResolver = resolve; });
      if (abortController.signal.aborted) break;
      setState(mode === 'step' ? 'stepping' : 'running');
      setStatus('Calling model…', 'info');
    }

    // Call LLM
    let result;
    try {
      result = await provider.sendMessage(SYSTEM_PROMPT, messages, allTools, { signal: abortController.signal });
    } catch (e) {
      if (abortController.signal.aborted) { setStatus('Stopped by user.', 'info'); break; }
      if (modelStepIdx != null) updateStep(modelStepIdx, { status: 'error', error: e instanceof Error ? e.message : String(e) });
      else addStep('LLM Error', 'error', { error: e instanceof Error ? e.message : String(e) });
      setStatus('Agent failed.', 'error');
      break;
    }

    // No tool calls — final text response
    if (result.toolCalls.length === 0) {
      if (modelStepIdx != null) updateStep(modelStepIdx, { status: 'success', thinking: result.text ?? undefined });
      addStep('model response (no tool called)', 'done', { result: result.text ?? '(no response)' });
      messages.push({ role: 'assistant', content: result.text ?? '' });
      setStatus('Agent finished.', 'success');
      break;
    }

    // Update or add model call step with thinking
    if (modelStepIdx != null) {
      updateStep(modelStepIdx, { status: 'success', thinking: result.text || undefined });
    } else {
      addStep('model call', 'success', { thinking: result.text || undefined, tools: toolInfos });
    }

    // Record assistant message with tool calls
    messages.push({ role: 'assistant', content: result.text ?? '', toolCalls: result.toolCalls });

    // Process each tool call
    for (const tc of result.toolCalls) {
      if (abortController.signal.aborted) break;

      // Built-in: task_complete
      if (tc.name === 'task_complete') {
        const summary = tryParseJSON(tc.arguments)?.summary as string ?? 'Task complete.';
        addStep('task_complete', 'done', { args: tc.arguments, result: summary });
        messages.push({ role: 'tool', toolCallId: tc.id, content: summary });
        setStatus('Goal achieved.', 'success');
        setState('idle');
        return;
      }

      // Built-in: ask_user
      if (tc.name === 'ask_user') {
        const question = tryParseJSON(tc.arguments)?.question as string ?? 'The agent has a question:';
        const stepIdx = addStep('ask_user', 'waiting', { args: tc.arguments, question });
        setState('waiting');
        setStatus('Waiting for your reply…', 'info');

        const answer = await new Promise<string>((resolve) => { askResolver = resolve; });
        if (abortController.signal.aborted) break;

        updateStep(stepIdx, { status: 'success', result: answer });
        messages.push({ role: 'tool', toolCallId: tc.id, content: answer });
        setState(mode === 'step' ? 'stepping' : 'running');
        setStatus('Running…', 'info');
        continue;
      }

      // Page tool — show pending, optionally pause for step
      const stepIdx = addStep(tc.name, mode === 'step' ? 'pending' : 'success', { args: tc.arguments });

      if (mode === 'step') {
        setState('paused');
        setStatus('Paused. Execute step or resume.', 'info');
        await new Promise<void>((resolve) => { stepResolver = resolve; });
        if (abortController.signal.aborted) break;
        // User may have switched to run mode via "Resume" button
        setState(mode === 'step' ? 'stepping' : 'running');
        setStatus('Running…', 'info');
      }

      // Execute tool via content script
      try {
        const response = await chrome.tabs.sendMessage(tabId, {
          type: 'executeTool', name: tc.name, args: tc.arguments,
        });
        const toolResult = response.type === 'error' ? `Error: ${response.message}` : (response.result ?? '(null)');
        messages.push({ role: 'tool', toolCallId: tc.id, content: toolResult });

        if (response.type === 'error') {
          updateStep(stepIdx, { status: 'error', error: response.message });
        } else {
          updateStep(stepIdx, { status: 'success', result: toolResult });
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        messages.push({ role: 'tool', toolCallId: tc.id, content: `Error: ${errMsg}` });
        updateStep(stepIdx, { status: 'error', error: errMsg });
      }
    }

    if (i === maxIterations - 1) {
      setStatus(`Stopped: reached max iterations (${maxIterations}).`, 'info');
    }
  }

  setState('idle');
  abortController = null;
}

// --- Button wiring ---
runBtn.addEventListener('click', () => {
  if (state === 'idle') {
    runAgentLoop('run');
  } else if (state === 'paused') {
    mode = 'run';
    if (stepResolver) { stepResolver(); stepResolver = null; }
  }
});

stepBtn.addEventListener('click', () => {
  if (state === 'idle') {
    runAgentLoop('step');
  } else if (state === 'paused') {
    mode = 'step';
    if (stepResolver) { stepResolver(); stepResolver = null; }
  }
});

stopBtn.addEventListener('click', () => {
  abortController?.abort();
  setState('idle');
  setStatus('Stopped by user.', 'info');
});

resetBtn.addEventListener('click', () => {
  abortController?.abort();
  // Resolve any pending promises so the old loop can exit cleanly
  if (stepResolver) { stepResolver(); stepResolver = null; }
  if (askResolver) { askResolver(''); askResolver = null; }
  steps = [];
  messages = [];
  selectedIndex = null;
  stepsEl.innerHTML = '';
  detailEl.hidden = true;
  detailEl.innerHTML = '';
  goalInput.value = '';
  clearStatus();
  setState('idle');
});

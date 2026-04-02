import { loadConfig } from '../lib/storage';
import type { LLMProvider, Message, ToolDefinition } from '../lib/llm/provider';

const goalInput = document.getElementById('agent-goal') as HTMLTextAreaElement;
const runBtn = document.getElementById('agent-run') as HTMLButtonElement;
const stopBtn = document.getElementById('agent-stop') as HTMLButtonElement;
const statusEl = document.getElementById('agent-status')!;
const traceEl = document.getElementById('agent-trace')!;

let abortController: AbortController | null = null;

const SYSTEM_PROMPT = `You have tools to interact with the current web page. Use them to accomplish the user's goal.
Call task_complete with a summary when the goal is achieved.
Call ask_user if you need clarification from the user.`;

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

async function getActiveTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function createProvider(): Promise<LLMProvider | null> {
  const config = await loadConfig();
  if (!config.provider) return null;

  if (config.provider.provider === 'openai') {
    const { OpenAIProvider } = await import('../lib/llm/openai');
    return new OpenAIProvider(config.provider);
  } else {
    const { AzureOpenAIProvider } = await import('../lib/llm/azure-openai');
    return new AzureOpenAIProvider(config.provider);
  }
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function addTraceStep(title: string, detail: string, type: 'tool' | 'assistant' | 'error' | 'done') {
  const step = document.createElement('div');
  step.className = 'card stack gap-sm';

  const colorClass = type === 'error' ? 'status-danger-foreground'
    : type === 'done' ? 'status-success-foreground' : '';

  step.innerHTML = `
    <button class="accordion-header" aria-expanded="true"
      ${colorClass ? `style="color: var(--smtc-${colorClass})"` : ''}>
      ${escapeHtml(title)}
    </button>
    <div class="accordion-content open">
      <pre class="code-block">${escapeHtml(detail)}</pre>
    </div>
  `;

  step.querySelector('.accordion-header')!.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!expanded));
    btn.nextElementSibling?.classList.toggle('open', !expanded);
  });

  traceEl.appendChild(step);
  step.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setStatus(text: string, type: 'info' | 'error' | 'success') {
  statusEl.hidden = false;
  statusEl.className = `message-bar message-bar-${type}`;
  statusEl.textContent = text;
}

function setRunning(running: boolean) {
  runBtn.disabled = running;
  stopBtn.disabled = !running;
  goalInput.disabled = running;
}

async function runAgentLoop() {
  const goal = goalInput.value.trim();
  if (!goal) { setStatus('Please enter a goal.', 'error'); return; }

  const provider = await createProvider();
  if (!provider) { setStatus('Configure an LLM provider first (Config tab).', 'error'); return; }

  const config = await loadConfig();
  const maxIterations = config.maxIterations;

  const tabId = await getActiveTabId();
  if (tabId == null) { setStatus('No active tab.', 'error'); return; }

  abortController = new AbortController();
  traceEl.innerHTML = '';
  setRunning(true);
  setStatus('Running…', 'info');

  // Get page tools
  let pageTools: ToolDefinition[] = [];
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'listTools' });
    if (response.type === 'listTools') {
      pageTools = response.tools.map((t: { name: string; description: string; inputSchema?: string }) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema ? JSON.parse(t.inputSchema) : { type: 'object', properties: {} },
      }));
    }
  } catch {
    setStatus('Could not connect to page.', 'error');
    setRunning(false);
    return;
  }

  const allTools = [...pageTools, ...BUILT_IN_TOOLS];
  const messages: Message[] = [
    { role: 'user', content: goal },
  ];

  for (let i = 0; i < maxIterations; i++) {
    if (abortController.signal.aborted) {
      setStatus('Stopped by user.', 'info');
      break;
    }

    // Call LLM
    let result;
    try {
      result = await provider.sendMessage(SYSTEM_PROMPT, messages, allTools, { signal: abortController.signal });
    } catch (e) {
      if (abortController.signal.aborted) { setStatus('Stopped by user.', 'info'); break; }
      addTraceStep('LLM Error', e instanceof Error ? e.message : String(e), 'error');
      setStatus('Agent failed.', 'error');
      break;
    }

    // No tool calls — final answer
    if (result.toolCalls.length === 0) {
      addTraceStep('Assistant', result.text ?? '(no response)', 'assistant');
      messages.push({ role: 'assistant', content: result.text ?? '' });
      setStatus('Agent finished.', 'success');
      break;
    }

    // Record the assistant's response with tool calls in history
    messages.push({ role: 'assistant', content: result.text ?? '', toolCalls: result.toolCalls });

    // Process tool calls
    for (const tc of result.toolCalls) {
      addTraceStep(`Tool: ${tc.name}`, tc.arguments, 'tool');

      // Built-in: task_complete
      if (tc.name === 'task_complete') {
        const parsed = JSON.parse(tc.arguments);
        addTraceStep('Done', parsed.summary ?? 'Task complete.', 'done');
        setStatus('Goal achieved.', 'success');
        setRunning(false);
        return;
      }

      // Built-in: ask_user
      if (tc.name === 'ask_user') {
        const parsed = JSON.parse(tc.arguments);
        const answer = prompt(parsed.question ?? 'The agent has a question:');
        messages.push({ role: 'tool', toolCallId: tc.id, content: answer ?? '(no answer)' });
        addTraceStep('User Answer', answer ?? '(no answer)', 'assistant');
        continue;
      }

      // Page tool — execute via content script
      try {
        const response = await chrome.tabs.sendMessage(tabId, {
          type: 'executeTool', name: tc.name, args: tc.arguments,
        });
        const toolResult = response.type === 'error' ? `Error: ${response.message}` : (response.result ?? '(null)');
        messages.push({ role: 'tool', toolCallId: tc.id, content: toolResult });
        addTraceStep(`Result: ${tc.name}`, toolResult, 'tool');
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        messages.push({ role: 'tool', toolCallId: tc.id, content: `Error: ${errMsg}` });
        addTraceStep(`Error: ${tc.name}`, errMsg, 'error');
      }
    }

    // Safety: last iteration
    if (i === maxIterations - 1) {
      setStatus(`Stopped: reached max iterations (${maxIterations}).`, 'info');
    }
  }

  setRunning(false);
  abortController = null;
}

runBtn.addEventListener('click', runAgentLoop);

stopBtn.addEventListener('click', () => {
  abortController?.abort();
  setRunning(false);
  setStatus('Stopped by user.', 'info');
});

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  Accordion, AccordionHeader, AccordionItem, AccordionPanel, Badge, Button,
  Field, Input, Menu, MenuItem, MenuList, MenuPopover,
  MenuTrigger, MessageBar, MessageBarActions, MessageBarBody, MessageBarTitle, Select, Switch,
  Tab, TabList, Textarea, Tooltip,
} from '@fluentui/react-components';
import {
  Add20Regular, ArrowLeft20Regular, ArrowSync16Regular, ChevronRight16Regular, Copy16Regular, Delete20Regular, MoreHorizontal20Regular,
  Play16Regular, Send20Filled, Settings20Regular, Stop16Regular, Stop20Filled, Wrench16Regular,
} from '@fluentui/react-icons';
import { Chat, ChatMessage, ChatMyMessage } from '@fluentui-contrib/react-chat';
import { Markdown } from './Markdown';
import { z } from 'zod';
import {
  toExtensionSchema, historyItemSchema, type HistoryItem, type ModelDisplay,
  type PageTool, type ToExtension,
} from '@webmcp-agent/shared/protocol';
import { namePageTools } from '@webmcp-agent/shared/toolNames';
import {
  defaultSettings, extensionSettingsSchema, pageStateSchema,
  type ExtensionSettings, type PageState, type PanelRequest,
} from '../messages';

type ToolEntry = Extract<HistoryItem, { kind: 'tool' }> & { status?: string };
type Entry = Exclude<HistoryItem, { kind: 'tool' }> | ToolEntry |
  { kind: 'notice'; text: string } | { kind: 'reasoning'; text: string; reasoningId?: string };
type Question = Extract<ToExtension, { type: 'question' }>;
type ModelOption = Extract<ToExtension, { type: 'models' }>['models'][number];
type View = 'chat' | 'tools' | 'history' | 'settings';
const localMessage = z.union([
  pageStateSchema,
  z.strictObject({ type: z.literal('settings'), settings: extensionSettingsSchema }),
  z.strictObject({ type: z.literal('connection'), status: z.string(), error: z.string().optional() }),
  z.strictObject({ type: z.literal('notice'), text: z.string() }),
  z.strictObject({ type: z.literal('pause'), paused: z.boolean(), tabId: z.number() }),
  z.strictObject({ type: z.literal('user'), text: z.string() }),
  z.strictObject({ type: z.literal('reset') }),
  z.strictObject({ type: z.literal('chat_loading'), loading: z.boolean() }),
  z.strictObject({ type: z.literal('inspect_result'), key: z.string(), ok: z.boolean(), result: z.string() }),
]);

function displayOrigin(origin: string): string {
  try { return new URL(origin).host; } catch { return origin; }
}

export function HintChips({ tool, compact = false }: { tool: Pick<PageTool, 'annotations'>; compact?: boolean }) {
  return <span className="chips">
    {!compact && tool.annotations.readOnlyHint && <Badge className="neutral-badge" size="small" appearance="ghost">Read-only</Badge>}
    {tool.annotations.consequentialHint && <Badge size="small" appearance="tint" color="danger">Consequential</Badge>}
    {!compact && tool.annotations.untrustedContentHint && <Badge className="neutral-badge" size="small" appearance="ghost">Untrusted output</Badge>}
    {!compact && tool.annotations.debugging && <Badge className="neutral-badge" size="small" appearance="ghost">Debug</Badge>}
  </span>;
}

export function PauseCard({ onContinue, onStop }: { onContinue: () => void; onStop: () => void }) {
  return <section className="action-card warning-card" aria-label="Tab changed"><strong>Tab changed</strong>
    <p>You switched tabs while WebMCP Agent was working. Continue on the original tab, or stop?</p>
    <div className="actions"><Button size="small" appearance="primary" onClick={onContinue}>Continue there</Button><Button size="small" onClick={onStop}>Stop</Button></div>
  </section>;
}

export function QuestionCard({ question, onAnswer }: { question: Question; onAnswer: (answer: string, wasFreeform: boolean) => void }) {
  const [text, setText] = useState('');
  return <section className="action-card question-card" aria-label="Question" aria-live="polite">
    <p className="question-prompt">{question.question}</p>
    {!!question.choices?.length && <div className="actions question-choices">{question.choices.map(choice =>
      <Button key={choice} appearance="subtle" icon={<ChevronRight16Regular />} iconPosition="after"
        onClick={() => onAnswer(choice, false)}>{choice}</Button>)}</div>}
    {question.allowFreeform && <form className="question-answer" onSubmit={event => { event.preventDefault(); if (text.trim()) onAnswer(text, true); }}>
      <div className="question-answer-control">
        <Input aria-label="Your answer" placeholder={question.choices?.length ? 'Or type your own answer' : 'Type your answer'}
          value={text} onChange={event => setText(event.target.value)} />
        <Button type="submit" appearance="primary" aria-label="Send answer" title="Send answer"
          icon={<Send20Filled />} disabled={!text.trim()} />
      </div>
    </form>}
  </section>;
}

export function ModelPicker({ model, models, disabled, compact = false, onChange }: {
  model: string; models: ModelOption[]; disabled: boolean; compact?: boolean; onChange: (model: string) => void;
}) {
  const options = [{ id: 'auto', name: 'Auto' }, ...models.filter(option => option.id !== 'auto')];
  const selected = model || 'auto';
  const selectedLabel = options.find(option => option.id === selected)?.name ?? selected;
  return <Select className={`model-picker${compact ? ' compact' : ''}`} size={compact ? 'small' : 'medium'}
    aria-label="Model" title={selectedLabel} value={selected} disabled={disabled}
    onChange={event => {
      const value = event.target.value;
      if (value !== selected) onChange(value === 'auto' ? '' : value);
    }}>
    {!options.some(option => option.id === selected) && <option value={selected}>{selectedLabel}</option>}
    {options.map(option => {
      const multiplier = 'multiplier' in option ? option.multiplier : undefined;
      return <option key={option.id} value={option.id}>
        {option.name}{multiplier === undefined ? '' : ` (${multiplier}x)`}
      </option>;
    })}
  </Select>;
}

export function ModelBadge({ model }: { model: ModelDisplay }) {
  const explanation = model.isAuto
    ? `Auto selected ${model.name} for this response`
    : `${model.name} handled this response`;
  return <Tooltip content={explanation} relationship="description">
    <Badge className="response-model" size="small" appearance="ghost">{model.name}</Badge>
  </Tooltip>;
}

export function AbortNotice({ reason }: Pick<Extract<HistoryItem, { kind: 'abort' }>, 'reason'>) {
  return <p className="abort-notice" role="status"><Stop16Regular aria-hidden="true" />
    {reason === 'autopilot_credit_limit' ? 'Response stopped: credit limit reached.' : 'Response stopped'}
  </p>;
}

function ToolActivity({ entry }: { entry: ToolEntry }) {
  const status = entry.status ?? (entry.ok === undefined ? 'Recorded' : entry.ok ? 'Done' : 'Failed');
  const color = status === 'Failed' ? 'danger' : status === 'Done' ? 'success' : status === 'Queued' ? 'warning' : 'informative';
  const title = entry.tool?.title || entry.tool?.name || entry.sdkName;
  return <Accordion className="tool-activity" collapsible>
    <AccordionItem value={entry.callId ?? entry.sdkName}>
      <AccordionHeader expandIconPosition="end">
        <span className="tool-summary"><Wrench16Regular className="tool-icon" />
          <span className="tool-summary-label"><strong>{title}</strong>
            {entry.tool && !entry.tool.isTopFrame && <span title={entry.tool.origin}>Embedded · {displayOrigin(entry.tool.origin)}</span>}
          </span>
          <Badge size="small" appearance="ghost" color={color}>{status}</Badge>
        </span>
      </AccordionHeader>
      <AccordionPanel>
        <div className="tool-details">
          {entry.tool && <><HintChips tool={entry.tool} /><p className="tool-origin">{entry.tool.origin}</p></>}
          <details><summary>Arguments</summary><pre>{JSON.stringify(entry.args, null, 2)}</pre></details>
          {entry.result !== undefined && <details><summary>Result</summary><pre>{entry.result}</pre></details>}
        </div>
      </AccordionPanel>
    </AccordionItem>
  </Accordion>;
}

function initialArguments(tool: PageTool): string {
  const schema = tool.inputSchema;
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return '{}';
  const args = new Map<string, unknown>();
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const [name, definition] of Object.entries(properties)) {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) continue;
    if ('default' in definition) args.set(name, definition.default);
    else if (required.includes(name)) {
      args.set(name, definition.type === 'number' || definition.type === 'integer' ? 0
        : definition.type === 'boolean' ? false : definition.type === 'array' ? [] : definition.type === 'object' ? {} : '');
    }
  }
  return JSON.stringify(Object.fromEntries(args), null, 2);
}

function PageSummary({ page }: { page: PageState }) {
  const embeddedCount = page.tools.filter(tool => !tool.isTopFrame).length;
  return <header className="tools-context">
    <span className="tools-eyebrow">Current page</span>
    <h1>{page.page.title}</h1>
    <p className="tool-origin">{page.page.origin === 'null' ? page.page.url : page.page.origin}</p>
    <p className="tool-count">{page.tools.length} {page.tools.length === 1 ? 'tool' : 'tools'} available
      {embeddedCount > 0 && <> · {embeddedCount} embedded</>}</p>
  </header>;
}

function Inspector({ page, settings, send, result }: {
  page: PageState; settings: ExtensionSettings; send: (message: PanelRequest) => void;
  result: { key: string; result: string; ok: boolean } | undefined;
}) {
  const [names, setNames] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string>();
  const [args, setArgs] = useState('{}');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void namePageTools(page.tools.filter(tool => settings.includeDebug || !tool.annotations.debugging), page.page.origin)
      .then(entries => { if (active) setNames(Object.fromEntries(entries.map(entry => [entry.tool.key, entry.sdkName]))); })
      .catch(error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [page, settings.includeDebug]);
  const grouped = [...new Set([...page.tools].sort((a, b) =>
    Number(b.isTopFrame) - Number(a.isTopFrame)).map(tool => tool.origin))];
  return <section className="view-content tools-view"><PageSummary page={page} />
    {(!page.available || page.error) && <MessageBar intent="warning"><MessageBarBody>
      <MessageBarTitle>Page tools unavailable</MessageBarTitle>
      {page.error ?? 'Enable WebMCP for testing and reload the page.'}
    </MessageBarBody></MessageBar>}
    {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
    {!page.tools.length && <p className="empty-view">No tools available on this page.</p>}
    {grouped.map(origin => {
      const groupTools = page.tools.filter(tool => tool.origin === origin);
      const groupLabel = `${groupTools.some(tool => tool.isTopFrame) ? 'Top page' : 'Embedded'} · ${displayOrigin(origin)}`;
      return <section className="tool-group" key={origin}>{grouped.length > 1 && <h2>{groupLabel}</h2>}
      <Accordion multiple collapsible>{groupTools.map(tool => {
        const hidden = tool.annotations.debugging && !settings.includeDebug;
        return <AccordionItem className="tool-row" key={tool.key} value={tool.key}>
          <AccordionHeader expandIconPosition="end">
            <span className="tool-row-summary"><strong>{tool.title || tool.name}</strong>
              <span>{hidden ? <Badge className="neutral-badge" size="small" appearance="ghost" title="Debugging tool hidden from the agent">Hidden</Badge> : <HintChips tool={tool} compact />}</span>
            </span>
          </AccordionHeader>
          <AccordionPanel>
            <div className="tool-details">
              <p className="tool-description">{tool.description}</p>
              <HintChips tool={tool} />
              <details className="tool-technical"><summary>Technical details</summary>
                <dl className="tool-metadata">
                  <dt>Tool name</dt><dd><code>{tool.name}</code></dd>
                  <dt>Agent name</dt><dd>{hidden ? 'Hidden from agent' : names[tool.key] ? <code>{names[tool.key]}</code> : error ? 'Unavailable' : 'Preparing agent name...'}</dd>
                  <dt>Origin</dt><dd>{tool.origin}</dd>
                </dl>
                <h3>Input schema</h3><pre>{JSON.stringify(tool.inputSchema ?? {}, null, 2)}</pre>
              </details>
              {editing !== tool.key && <Button className="manual-run-trigger" appearance="transparent" size="small" icon={<Play16Regular />}
                onClick={() => { setEditing(tool.key); setArgs(initialArguments(tool)); setError(''); }}>Run manually</Button>}
              {editing === tool.key && <form className="manual-run" onSubmit={event => {
                event.preventDefault();
                const parsed = z.record(z.string(), z.json()).safeParse((() => { try { return JSON.parse(args); } catch { return undefined; } })());
                if (!parsed.success) { setError('Arguments must be a valid JSON object.'); return; }
                setError('');
                send({ type: 'inspect_run', key: tool.key, args: parsed.data });
              }}>
                <Field label="JSON arguments"><Textarea resize="vertical" rows={4} value={args} onChange={event => setArgs(event.target.value)} /></Field>
                <p className="field-description">Runs immediately on the page, without the agent.</p>
                <div className="actions"><Button type="submit" appearance="primary" size="small">Execute tool</Button>
                  <Button type="button" appearance="subtle" size="small" onClick={() => { setEditing(undefined); setError(''); }}>Cancel</Button></div>
              </form>}
              {result?.key === tool.key && <section className="tool-result" aria-label="Tool result" data-status={result.ok ? 'success' : 'error'}>
                <h3>{result.ok ? 'Result' : 'Tool failed'}</h3><pre role={result.ok ? 'status' : 'alert'}>{result.ok ? '' : 'Failed: '}{result.result}</pre>
              </section>}
            </div>
          </AccordionPanel>
        </AccordionItem>;})}</Accordion>
    </section>;})}
  </section>;
}

export function SettingsToggle({ label, description, checked, onChange, sensitive = false }: {
  label: string; description: string; checked: boolean; onChange: (checked: boolean) => void; sensitive?: boolean;
}) {
  const descriptionId = useId();
  return <Switch className="settings-toggle" labelPosition="before" aria-label={label} aria-describedby={descriptionId}
    label={<span className="settings-toggle-copy"><span className="settings-control-title">{label}</span>
      <span id={descriptionId} className={`settings-description${sensitive ? ' warning-text' : ''}`}>{description}</span>
    </span>}
    checked={checked} onChange={(_event, data) => onChange(data.checked)} />;
}

function SettingsView({ settings, models, ready, logs, disabled, enabled, onChange, onModelChange, send, clearChats }: {
  settings: ExtensionSettings; models: ModelOption[];
  ready: Extract<ToExtension, { type: 'ready' }> | undefined; logs: string[];
  disabled: boolean; enabled: boolean; onChange: (settings: ExtensionSettings) => void;
  onModelChange: (model: string) => void;
  send: (message: PanelRequest) => void; clearChats: () => void;
}) {
  const [logCopyFeedback, setLogCopyFeedback] = useState<{ text: string; failed: boolean }>();
  async function copyLogs() {
    try {
      await navigator.clipboard.writeText(logs.join('\n'));
      setLogCopyFeedback({ text: 'Logs copied.', failed: false });
    } catch (error) {
      console.error('WebMCP Agent could not copy host logs', error);
      setLogCopyFeedback({ text: 'Could not copy logs. Select and copy the text above.', failed: true });
    }
  }
  return <section className="view-content settings-view" aria-label="Settings">
    <section className="settings-section"><h2>Conversation</h2>
      <Field className="settings-field" label="Model" hint="Auto chooses a model for you. Changes apply to the next message.">
        <ModelPicker model={settings.model} models={models} disabled={disabled || !enabled}
        onChange={onModelChange} /></Field>
      <SettingsToggle label="Show reasoning" description="Display reasoning when the model provides it." checked={settings.showReasoning}
        onChange={checked => onChange({ ...settings, showReasoning: checked })} />
    </section>
    <section className="settings-section"><h2>Page tools</h2>
      <SettingsToggle label="Include debugging tools" description="Make debugging tools available to the agent." checked={settings.includeDebug}
        onChange={checked => onChange({ ...settings, includeDebug: checked })} />
      <Field className="settings-field" label="Tool result limit" hint="Limit how much result text is sent to the model.">
        <Input type="number" aria-label="Maximum tool-result characters" min={1} max={256000}
          contentAfter={<span className="settings-input-unit" aria-hidden="true">characters</span>}
          value={String(settings.maxToolResultChars)} onChange={event => {
          const value = Number(event.target.value);
          if (Number.isInteger(value) && value >= 1 && value <= 256000) onChange({ ...settings, maxToolResultChars: value });
        }} />
      </Field>
    </section>
    <section className="settings-section"><h2>Diagnostics</h2>
      <SettingsToggle label="Verbose host logs" sensitive checked={settings.verboseLogs}
        description="Includes page arguments and results, which may contain sensitive data."
        onChange={checked => onChange({ ...settings, verboseLogs: checked })} />
      <Accordion className="settings-diagnostics" collapsible><AccordionItem value="diagnostics">
        <AccordionHeader expandIconPosition="end">Host details and logs</AccordionHeader>
        <AccordionPanel>
          <dl className="settings-metadata">
            <dt>Host version</dt><dd>{ready?.hostVersion ?? 'Unavailable'}</dd>
            <dt>Copilot SDK</dt><dd>{ready?.sdkVersion ?? 'Unavailable'}</dd>
            <dt>Account</dt><dd>{ready ? ready.signedIn ? 'Signed in' : 'Signed out' : 'Unavailable'}</dd>
            <dt>Extension ID</dt><dd><code>{chrome.runtime.id}</code></dd>
            <dt>Data location</dt><dd>{ready?.dataPath ?? 'Unavailable'}</dd>
          </dl>
          <h3>Host logs</h3>
          <pre className="settings-log" tabIndex={0} aria-label="Host logs">{logs.length ? logs.join('\n') : 'No host logs yet.'}</pre>
          <div className="actions settings-actions">
            <Button size="small" appearance="subtle" icon={<Copy16Regular />} disabled={!logs.length} onClick={() => { void copyLogs(); }}>Copy logs</Button>
            <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={() => send({ type: 'reconnect' })}>Reconnect host</Button>
          </div>
          {logCopyFeedback && <p className="settings-feedback" role={logCopyFeedback.failed ? 'alert' : 'status'}>{logCopyFeedback.text}</p>}
        </AccordionPanel>
      </AccordionItem></Accordion>
    </section>
    <section className="settings-section settings-danger"><h2>Data and privacy</h2>
      <p className="settings-description">Permanently delete all WebMCP Agent chats from SDK storage. This cannot be undone.</p>
      <Button className="settings-delete" appearance="subtle" size="small" icon={<Delete20Regular />} disabled={disabled} onClick={clearChats}>Clear WebMCP chats</Button>
    </section>
  </section>;
}

function HistoryView({ chats, disabled, open, remove }: {
  chats: Extract<ToExtension, { type: 'chats' }>['chats']; disabled: boolean;
  open: (id: string) => void; remove: (id: string) => void;
}) {
  const [copyFeedback, setCopyFeedback] = useState<{ text: string; failed: boolean }>();
  async function copyChatId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      setCopyFeedback({ text: 'Chat ID copied.', failed: false });
    } catch (error) {
      console.error('WebMCP Agent could not copy the chat ID', error);
      setCopyFeedback({ text: `Could not copy the chat ID. Copy it manually: ${id}`, failed: true });
    }
  }
  return <section className="view-content history-view" aria-label="Saved chats">
    {!chats.length && <p className="empty-view">No saved chats yet.</p>}
    {copyFeedback && <p className={copyFeedback.failed ? 'history-copy-feedback' : 'visually-hidden'}
      role={copyFeedback.failed ? 'alert' : 'status'}>{copyFeedback.text}</p>}
    <div className="history-list">{chats.map(chat => <div className="history-row" key={chat.chatId}>
      <Button className="history-open" appearance="subtle" disabled={disabled} onClick={() => open(chat.chatId)}>
        <span><span className="history-title">{chat.title}</span><small>{new Date(chat.updatedAt).toLocaleString()}</small></span>
      </Button>
      <Menu><MenuTrigger disableButtonEnhancement><Button appearance="subtle" icon={<MoreHorizontal20Regular />}
        aria-label={`More options for ${chat.title}`} /></MenuTrigger>
        <MenuPopover><MenuList>
          <MenuItem icon={<Copy16Regular />} onClick={() => { void copyChatId(chat.chatId); }}>Copy chat ID</MenuItem>
          <MenuItem icon={<Delete20Regular />} disabled={disabled} onClick={() => remove(chat.chatId)}>Delete</MenuItem>
        </MenuList></MenuPopover>
      </Menu>
    </div>)}</div>
  </section>;
}

export function App() {
  const port = useRef<chrome.runtime.Port | undefined>(undefined);
  const pageRef = useRef<PageState | undefined>(undefined);
  const historyFragment = useRef('');
  const pendingModel = useRef<ModelDisplay | undefined>(undefined);
  const composer = useRef<HTMLTextAreaElement>(null);
  const conversationViewport = useRef<HTMLDivElement>(null);
  const followConversation = useRef(true);
  const [page, setPage] = useState<PageState>();
  const [settings, setSettings] = useState(defaultSettings);
  const [view, setView] = useState<View>('chat');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState('');
  const [running, setRunning] = useState(false);
  const [loadingChat, setLoadingChat] = useState(true);
  const [paused, setPaused] = useState(false);
  const [question, setQuestion] = useState<Question>();
  const [connection, setConnection] = useState('Connecting');
  const [connectionError, setConnectionError] = useState('');
  const [chatId, setChatId] = useState('');
  const [models, setModels] = useState<Extract<ToExtension, { type: 'models' }>['models']>([]);
  const [chats, setChats] = useState<Extract<ToExtension, { type: 'chats' }>['chats']>([]);
  const [ready, setReady] = useState<Extract<ToExtension, { type: 'ready' }>>();
  const [logs, setLogs] = useState<string[]>([]);
  const [inspectResult, setInspectResult] = useState<{ key: string; result: string; ok: boolean }>();
  function appendEntries(additions: Entry[]) {
    setEntries(items => {
      const abortIds = new Set<string>();
      return [...items, ...additions].filter(item => {
        if (item.kind !== 'abort') return true;
        if (abortIds.has(item.eventId)) return false;
        abortIds.add(item.eventId);
        return true;
      });
    });
  }
  const send = (message: PanelRequest) => {
    try {
      if (!port.current) throw new Error('Panel is disconnected. Close and reopen it.');
      port.current.postMessage(message);
    } catch (error) {
      console.error('WebMCP Agent panel request failed', error);
      setConnectionError(String(error));
    }
  };
  useEffect(() => {
    let disposed = false;
    void chrome.windows.getCurrent().then(window => {
      if (disposed || window.id === undefined) return;
      const current = chrome.runtime.connect({ name: `panel:${window.id}` });
      port.current = current;
      current.onDisconnect.addListener(() => { setConnection('Offline'); setConnectionError('Extension reloaded. Close and reopen the side panel.'); });
      current.onMessage.addListener((value: unknown) => {
        const parsed = toExtensionSchema.safeParse(value);
        const local = localMessage.safeParse(value);
        if (!parsed.success && !local.success) {
          console.error('WebMCP Agent rejected a worker message', { hostIssues: parsed.error.issues, panelIssues: local.error.issues });
          setConnectionError('Invalid message received. See the panel console for validation errors.');
          return;
        }
        const message = parsed.success ? parsed.data : local.data!;
        switch (message.type) {
          case 'page': pageRef.current = message; setPage(message); return;
          case 'settings': setSettings(message.settings); return;
          case 'connection': setConnection(message.status); setConnectionError(message.error ?? ''); return;
          case 'notice': setEntries(items => [...items, { kind: 'notice', text: message.text }]); return;
          case 'pause': setPaused(message.paused); return;
          case 'chat_loading': setLoadingChat(message.loading); return;
          case 'reset':
            followConversation.current = true;
            setEntries([]); setQuestion(undefined); setChatId('');
            setLoadingChat(true); setConnectionError(''); historyFragment.current = ''; pendingModel.current = undefined; return;
          case 'user':
            followConversation.current = true;
            pendingModel.current = undefined;
            setEntries(items => {
              const messageId = 'messageId' in message && typeof message.messageId === 'string' ? message.messageId : undefined;
              const index = messageId ? items.findIndex(item => item.kind === 'user' && item.messageId === messageId) : -1;
              const entry: Extract<Entry, { kind: 'user' }> = { kind: 'user', text: message.text, ...(messageId ? { messageId } : {}) };
              return index < 0 ? [...items, entry] : items.map((item, itemIndex) => itemIndex === index ? entry : item);
            });
            return;
          case 'ready': setReady(message); return;
          case 'models': setModels(message.models); return;
          case 'chats': setChats(message.chats); return;
          case 'chat_opened': setChatId(message.chatId); return;
          case 'history': appendEntries(message.items); return;
          case 'history_fragment':
            historyFragment.current += message.fragment;
            if (message.complete) {
              try {
                const item = historyItemSchema.parse(JSON.parse(historyFragment.current));
                appendEntries([item]);
              } catch (error) {
                console.error('WebMCP Agent could not decode SDK history', error);
                setConnectionError('A saved history item could not be decoded. Reconnect to reload the chat.');
              }
              historyFragment.current = '';
            }
            return;
          case 'delta':
          case 'message':
            if (message.type === 'delta' && !message.text) return;
            setEntries(items => {
              let index = message.messageId
                ? items.findIndex(item => item.kind === 'assistant' && item.messageId === message.messageId)
                : items.length - 1;
              if (!message.messageId) {
                while (index >= 0 && (items[index]?.kind === 'reasoning' || items[index]?.kind === 'notice')) index--;
              }
              const last = items[index];
              if (message.type === 'message' && !message.text.trim()) {
                return last?.kind === 'assistant' && message.messageId ? items.filter((_item, itemIndex) => itemIndex !== index) : items;
              }
              return last?.kind === 'assistant'
                ? items.map((item, itemIndex) => itemIndex === index
                    ? { ...last, text: message.type === 'delta' ? last.text + message.text : message.text } : item)
                : [...items, { kind: 'assistant', text: message.text,
                    ...(message.messageId ? { messageId: message.messageId } : {}),
                    ...(pendingModel.current ? { model: pendingModel.current } : {}) }];
            });
            return;
          case 'model_used':
            pendingModel.current = message.model;
            setEntries(items => {
              let index = -1;
              for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex--) {
                if (items[itemIndex]?.kind === 'user') break;
                if (items[itemIndex]?.kind === 'assistant') { index = itemIndex; break; }
              }
              return index < 0 ? items : items.map((item, itemIndex) =>
                itemIndex === index && item.kind === 'assistant' ? { ...item, model: message.model } : item);
            });
            return;
          case 'reasoning':
            if (!message.text && !message.complete) return;
            setEntries(items => {
              const index = message.reasoningId
                ? items.findIndex(item => item.kind === 'reasoning' && item.reasoningId === message.reasoningId)
                : items.length - 1;
              const last = items[index];
              if (message.complete && !message.text.trim()) {
                return last?.kind === 'reasoning' ? items.filter((_item, itemIndex) => itemIndex !== index) : items;
              }
              return last?.kind === 'reasoning'
                ? items.map((item, itemIndex) => itemIndex === index
                    ? { ...last, text: message.complete ? message.text : last.text + message.text } : item)
                : [...items, { kind: 'reasoning', text: message.text, ...(message.reasoningId ? { reasoningId: message.reasoningId } : {}) }];
            });
            return;
          case 'tool_call':
            setEntries(items => {
              const status = message.executionState === 'queued' ? 'Queued' : 'Running';
              const tool = message.tool ?? pageRef.current?.tools.find(tool => tool.key === message.key && tool.origin === message.origin);
              return items.some(item => item.kind === 'tool' && item.callId === message.callId)
                ? items.map(item => item.kind === 'tool' && item.callId === message.callId ? { ...item, status } : item)
                : [...items, { kind: 'tool', sdkName: message.sdkName, args: message.args, callId: message.callId, status, ...(tool ? { tool } : {}) }];
            });
            return;
          case 'tool_done':
            setEntries(items => items.map(item => item.kind === 'tool' && item.callId === message.callId
              ? { ...item, ok: message.ok, result: message.result, status: message.ok ? 'Done' : 'Failed' } : item));
            return;
          case 'question': setQuestion(message); return;
          case 'status': setRunning(message.state === 'running'); if (message.state === 'idle') setQuestion(undefined); return;
          case 'abort':
            setQuestion(undefined);
            appendEntries([{ kind: 'abort', eventId: message.eventId, reason: message.reason }]);
            return;
          case 'title': return;
          case 'error':
            console.error('WebMCP Agent host error', { code: message.code, chatId: message.chatId, message: message.message });
            setLoadingChat(false);
            setEntries(items => [...items, { kind: 'notice', text: message.message }]);
            return;
          case 'log': setLogs(lines => [...lines.slice(-299), `${message.time} ${message.level} ${message.text}`]); return;
          case 'inspect_result': setInspectResult(message); return;
        }
      });
    }).catch(error => { console.error('WebMCP Agent panel connection failed', error); setConnectionError(String(error)); });
    return () => { disposed = true; port.current?.disconnect(); };
  }, []);
  useLayoutEffect(() => {
    const viewport = conversationViewport.current;
    if (viewport && followConversation.current) viewport.scrollTop = viewport.scrollHeight;
  }, [entries, question, paused, loadingChat, draft, view]);
  function resizeComposer(textarea: HTMLTextAreaElement) {
    composer.current = textarea;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`;
  }
  function updateSettings(value: ExtensionSettings) { setSettings(value); send({ type: 'settings', settings: value }); }
  function changeModel(model: string) {
    setSettings(value => ({ ...value, model }));
    send({ type: 'set_model', model: model || 'auto' });
  }
  function changeView(next: View) {
    if (next === 'chat') followConversation.current = true;
    if (view === 'settings' && next !== 'settings') send({ type: 'logs', follow: false });
    if (next === 'settings' && view !== 'settings') send({ type: 'logs', follow: true });
    setView(next);
    if (next === 'history') send({ type: 'list_chats' });
  }
  const enabled = connection === 'Connected' && !!chatId && !loadingChat;
  const hasConversation = entries.some(entry => entry.kind !== 'notice');
  const showInitialModel = !loadingChat && !hasConversation;
  const pageWarning = page && (!page.available || page.error);
  return <main>
    <header className={`app-header${view === 'settings' ? ' settings-header' : ''}`}>
      {view === 'settings'
        ? <div className="header-bar"><Tooltip content="Back" relationship="label"><Button aria-label="Back" appearance="subtle"
            icon={<ArrowLeft20Regular />} onClick={() => changeView('chat')} /></Tooltip><strong>Settings</strong></div>
        : <div className="header-bar">
          <nav aria-label="Views"><TabList selectedValue={view} size="small" onTabSelect={(_event, data) => {
            if (data.value === 'chat' || data.value === 'tools' || data.value === 'history') changeView(data.value);
          }}>{(['chat', 'tools', 'history'] as const).map(item =>
            <Tab key={item} value={item} aria-label={item.charAt(0).toUpperCase() + item.slice(1)}>{item.charAt(0).toUpperCase() + item.slice(1)}</Tab>)}
          </TabList></nav>
          <div className="header-actions"><Tooltip content="New chat" relationship="label"><Button appearance="subtle" className="new-chat" aria-label="New chat" icon={<Add20Regular />}
              disabled={running || loadingChat || connection !== 'Connected'} onClick={() => { send({ type: 'new_chat' }); changeView('chat'); }} /></Tooltip>
            <Tooltip content="Settings" relationship="label"><Button appearance="subtle" aria-label="Settings" icon={<Settings20Regular />}
              onClick={() => changeView('settings')} /></Tooltip></div>
        </div>}
    </header>

    {connection === 'Connecting' && <p className="muted" role="status">Connecting...</p>}
    {connectionError && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Connection problem</MessageBarTitle>{connectionError}
      <MessageBarActions><Button onClick={() => send({ type: 'reconnect' })}>Reconnect</Button></MessageBarActions>
    </MessageBarBody></MessageBar>}
    {connection === 'Signed out' && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Sign in required</MessageBarTitle>
      Run <code>npm run login</code>, then reconnect.
      <MessageBarActions><Button onClick={() => send({ type: 'reconnect' })}>Retry</Button></MessageBarActions>
    </MessageBarBody></MessageBar>}

    {view === 'chat' && <>
      {pageWarning && <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Page tools unavailable</MessageBarTitle>
        {page?.error ?? 'Enable WebMCP for testing and reload the page. You can still chat without page tools.'}
      </MessageBarBody></MessageBar>}
      <div className="conversation-scroll" ref={conversationViewport} onScroll={event => {
        const viewport = event.currentTarget;
        followConversation.current = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 48;
      }}>
        <Chat className={`transcript${hasConversation ? '' : ' empty'}`} aria-label="Conversation" aria-live="polite">
          {loadingChat && <p role="status">Opening SDK chat history...</p>}
          {!loadingChat && !hasConversation && <div className="empty-welcome"><h1>What would you like to do?</h1>
            <p className="muted">Ask a question or give this page a task.</p>
            {!!page?.tools.length && <Button className="available-tools" appearance="transparent" size="small" onClick={() => changeView('tools')}>
              {page.tools.length} page {page.tools.length === 1 ? 'tool' : 'tools'} available
            </Button>}
          </div>}
          {entries.map((entry, index) => entry.kind === 'tool' ? <ToolActivity key={entry.callId ?? index} entry={entry} /> :
            entry.kind === 'abort' ? <AbortNotice key={entry.eventId} reason={entry.reason} /> :
            entry.kind === 'reasoning' ? settings.showReasoning && <Accordion key={index} className="reasoning-activity" collapsible>
              <AccordionItem value="reasoning"><AccordionHeader expandIconPosition="end">Reasoning</AccordionHeader>
                <AccordionPanel><Markdown text={entry.text} /></AccordionPanel></AccordionItem>
            </Accordion> :
            entry.kind === 'notice' ? <MessageBar key={index} intent="info"><MessageBarBody><Markdown text={entry.text} /></MessageBarBody></MessageBar> :
            entry.kind === 'user' ? <ChatMyMessage key={index} author="You" root={{ className: 'message user' }} body={{ className: 'message-body' }}><Markdown text={entry.text} /></ChatMyMessage> :
            <ChatMessage key={index} author="WebMCP Agent" details={entry.model ? <ModelBadge model={entry.model} /> : null}
              root={{ className: 'message assistant' }} body={{ className: 'message-body' }}><Markdown text={entry.text} /></ChatMessage>)}
        </Chat>
        {paused && <PauseCard onContinue={() => send({ type: 'continue' })} onStop={() => send({ type: 'stop' })} />}
        {question && <QuestionCard key={question.requestId} question={question} onAnswer={(answer, wasFreeform) => {
          send({ type: 'answer', requestId: question.requestId, answer, wasFreeform }); setQuestion(undefined);
        }} />}
      </div>
      <form className="composer" onSubmit={event => {
        event.preventDefault();
        if (draft.trim() && enabled && !running) {
          send({ type: 'send', text: draft.trim() });
          setDraft('');
          if (composer.current) composer.current.style.height = 'auto';
        }
      }}>
        <label htmlFor="prompt" className="visually-hidden">Message</label>
        <div className="composer-surface">
          <Textarea id="prompt" resize="none" rows={1} value={draft} disabled={!enabled || running}
            placeholder={!enabled ? 'Connect and sign in to send a message' : 'Ask about this page...'}
            onChange={event => { resizeComposer(event.target); setDraft(event.target.value); }} onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault(); event.currentTarget.form?.requestSubmit();
              }
            }} />
          <div className="composer-toolbar">
            {showInitialModel && <div className="model-chip"><ModelPicker compact model={settings.model} models={models} disabled={!enabled || running} onChange={changeModel} /></div>}
            <div className="composer-actions">{running
              ? <Tooltip content="Stop" relationship="label"><Button type="button" aria-label="Stop" icon={<Stop20Filled />} onClick={() => send({ type: 'stop' })} /></Tooltip>
              : <Tooltip content="Send" relationship="label"><Button type="submit" appearance="primary" aria-label="Send" icon={<Send20Filled />} disabled={!enabled || !draft.trim()} /></Tooltip>}</div>
          </div>
        </div>
      </form>
    </>}
    {view === 'tools' && page && <Inspector page={page} settings={settings} send={send} result={inspectResult} />}
    {view === 'history' && <HistoryView chats={chats} disabled={running || loadingChat}
      open={id => { send({ type: 'open_chat', chatId: id }); changeView('chat'); }}
      remove={id => { if (confirm('Delete this WebMCP Agent chat?')) send({ type: 'delete_chat', chatId: id }); }} />}
    {view === 'settings' && <SettingsView settings={settings} models={models} ready={ready} logs={logs}
      disabled={running || loadingChat} enabled={enabled} onChange={updateSettings} onModelChange={changeModel} send={send}
      clearChats={() => { if (confirm('Delete all WebMCP Agent chats? This cannot be undone.')) send({ type: 'clear_chats' }); }} />}
  </main>;
}

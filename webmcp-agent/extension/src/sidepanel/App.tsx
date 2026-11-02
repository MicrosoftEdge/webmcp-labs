// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Checkbox, Input, Select, Tab, TabList, Textarea } from '@fluentui/react-components';
import { Add20Regular, Settings20Regular } from '@fluentui/react-icons';
import { Chat, ChatMessage, ChatMyMessage } from '@fluentui-contrib/react-chat';
import { Markdown } from './Markdown';
import { z } from 'zod';
import { toExtensionSchema, historyItemSchema, type HistoryItem, type PageTool, type ToExtension } from '@webmcp-agent/shared/protocol';
import { namePageTools } from '@webmcp-agent/shared/toolNames';
import {
  defaultSettings, extensionSettingsSchema, pageStateSchema,
  type ExtensionSettings, type PageState, type PanelRequest,
} from '../messages';

type ToolEntry = Extract<HistoryItem, { kind: 'tool' }> & {
  status?: string;
};
type Entry = Exclude<HistoryItem, { kind: 'tool' }> | ToolEntry | { kind: 'notice'; text: string };
type Question = Extract<ToExtension, { type: 'question' }>;
type ModelOption = Extract<ToExtension, { type: 'models' }>['models'][number];
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

export function HintChips({ tool }: { tool: Pick<PageTool, 'annotations'> }) {
  return <span className="chips">
    {tool.annotations.readOnlyHint && <Badge size="small" appearance="tint">Read-only</Badge>}
    {tool.annotations.consequentialHint && <Badge size="small" appearance="tint" color="danger" className="danger">Consequential</Badge>}
    {tool.annotations.untrustedContentHint && <Badge size="small" appearance="tint">Untrusted output</Badge>}
    {tool.annotations.debugging && <Badge size="small" appearance="tint">Debug</Badge>}
  </span>;
}
export function PauseCard({ onContinue, onStop }: { onContinue: () => void; onStop: () => void }) {
  return <aside className="pause"><strong>Tab changed</strong><p>You switched tabs while WebMCP Agent was working. Continue on the original tab, or stop?</p>
    <Button onClick={onContinue}>Continue there</Button> <Button onClick={onStop}>Stop</Button></aside>;
}
export function QuestionCard({ question, onAnswer }: { question: Question; onAnswer: (answer: string, wasFreeform: boolean) => void }) {
  const [text, setText] = useState('');
  return <aside className="question"><strong>Question</strong><p>{question.question}</p>
    <div className="actions">{question.choices?.map(choice => <Button key={choice} onClick={() => onAnswer(choice, false)}>{choice}</Button>)}</div>
    {question.allowFreeform && <form onSubmit={event => { event.preventDefault(); if (text.trim()) onAnswer(text, true); }}>
      <label>Your answer<Input value={text} onChange={event => setText(event.target.value)} /></label>
      <Button type="submit" appearance="primary" disabled={!text.trim()}>Answer</Button>
    </form>}</aside>;
}
export function ModelPicker({ model, models, disabled, onChange }: {
    model: string; models: ModelOption[]; disabled: boolean; onChange: (model: string) => void;
}) {
    return <Select size="small" aria-label="Model" value={model || 'auto'} disabled={disabled}
      onChange={event => onChange(event.target.value === 'auto' ? '' : event.target.value)}>
      <option value="auto">Auto</option>
      {models.filter(option => option.id !== 'auto').map(option =>
        <option key={option.id} value={option.id}>{option.name}{option.multiplier === undefined ? '' : ` (${option.multiplier}x)`}</option>)}
    </Select>;
}
function ToolCard({ entry }: { entry: ToolEntry }) {
  return <Card className="tool-card">
    <header><strong>{entry.tool?.title || entry.tool?.name || entry.sdkName}</strong><span>{entry.status ?? (entry.ok === undefined ? 'Recorded' : entry.ok ? 'Done' : 'Failed')}</span></header>
    {entry.tool && <><span className={`origin ${entry.tool.isTopFrame ? '' : 'embedded'}`}>{entry.tool.origin}</span><HintChips tool={entry.tool} /></>}
    <details><summary>Arguments</summary><pre>{JSON.stringify(entry.args, null, 2)}</pre></details>
    {entry.result !== undefined && <details><summary>Result</summary><pre>{entry.result}</pre></details>}
  </Card>;
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
  const grouped = [...new Set([...page.tools].sort((a, b) => Number(b.isTopFrame) - Number(a.isTopFrame)).map(tool => tool.origin))];
  return <section><h2>Page tools</h2>{error && <p role="alert">{error}</p>}
    {!page.tools.length && <p>No tools available on this page.</p>}
    {grouped.map(origin => <section key={origin}><h3>{origin}</h3>{page.tools.filter(tool => tool.origin === origin).map(tool =>
      <Card className="tool-card" key={tool.key}>
        <strong>{tool.title || tool.name}</strong><div><code>{tool.name}</code></div>
        <p>{tool.description}</p><HintChips tool={tool} />
        <p className="muted">{names[tool.key] ? <>Agent name: <code>{names[tool.key]}</code></> : 'Hidden from agent'}</p>
        <details><summary>Input schema</summary><pre>{JSON.stringify(tool.inputSchema ?? {}, null, 2)}</pre></details>
        <Button onClick={() => { setEditing(tool.key); setArgs(initialArguments(tool)); setError(''); }}>Run manually</Button>
        {editing === tool.key && <form onSubmit={event => {
          event.preventDefault();
          const parsed = z.record(z.string(), z.json()).safeParse((() => { try { return JSON.parse(args); } catch { return undefined; } })());
          if (!parsed.success) { setError('Arguments must be a valid JSON object.'); return; }
          setError('');
          send({ type: 'inspect_run', key: tool.key, args: parsed.data });
        }}>
          <label>JSON arguments<Textarea resize="vertical" rows={6} value={args} onChange={event => setArgs(event.target.value)} /></label>
          <p className="muted">Runs immediately on the page, without the agent.</p><Button type="submit" appearance="primary">Execute tool</Button>
        </form>}
        {result?.key === tool.key && <pre role="status">{result.ok ? '' : 'Failed: '}{result.result}</pre>}
      </Card>)}</section>)}
  </section>;
}

export function App() {
  const port = useRef<chrome.runtime.Port | undefined>(undefined);
  const pageRef = useRef<PageState | undefined>(undefined);
  const historyFragment = useRef('');
  const [page, setPage] = useState<PageState>();
  const [settings, setSettings] = useState(defaultSettings);
  const [view, setView] = useState<'chat' | 'tools' | 'history'>('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState('');
  const [running, setRunning] = useState(false);
  const [loadingChat, setLoadingChat] = useState(true);
  const [paused, setPaused] = useState(false);
  const [question, setQuestion] = useState<Question>();
  const [reasoning, setReasoning] = useState('');
  const [connection, setConnection] = useState('Connecting');
  const [connectionError, setConnectionError] = useState('');
  const [title, setTitle] = useState('WebMCP Agent');
  const [chatId, setChatId] = useState('');
  const [models, setModels] = useState<Extract<ToExtension, { type: 'models' }>['models']>([]);
  const [chats, setChats] = useState<Extract<ToExtension, { type: 'chats' }>['chats']>([]);
  const [ready, setReady] = useState<Extract<ToExtension, { type: 'ready' }>>();
  const [logs, setLogs] = useState<string[]>([]);
  const [inspectResult, setInspectResult] = useState<{ key: string; result: string; ok: boolean }>();
  const send = (message: PanelRequest) => {
    try { if (!port.current) throw new Error('Panel is disconnected. Close and reopen it.'); port.current.postMessage(message); }
    catch (error) { console.error('WebMCP Agent panel request failed', error); setConnectionError(String(error)); }
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
            setEntries([]); setReasoning(''); setQuestion(undefined); setChatId('');
            setLoadingChat(true); setConnectionError(''); historyFragment.current = ''; return;
          case 'user': setEntries(items => [...items, { kind: 'user', text: message.text }]); setReasoning(''); return;
          case 'ready': setReady(message); return;
          case 'models': setModels(message.models); return;
          case 'chats': setChats(message.chats); return;
          case 'chat_opened': setChatId(message.chatId); setTitle(message.title); return;
          case 'history': setEntries(items => [...items, ...message.items]); return;
          case 'history_fragment':
            historyFragment.current += message.fragment;
            if (message.complete) {
              try {
                const item = historyItemSchema.parse(JSON.parse(historyFragment.current));
                setEntries(items => [...items, item]);
              } catch (error) {
                console.error('WebMCP Agent could not decode SDK history', error);
                setConnectionError('A saved history item could not be decoded. Reconnect to reload the chat.');
              }
              historyFragment.current = '';
            }
            return;
          case 'delta':
            if (!message.text) return;
            setEntries(items => {
              const last = items.at(-1);
              return last?.kind === 'assistant' ? [...items.slice(0, -1), { ...last, text: last.text + message.text }] : [...items, { kind: 'assistant', text: message.text }];
            }); return;
          case 'message':
            if (!message.text.trim()) return;
            setEntries(items => items.at(-1)?.kind === 'assistant'
              ? [...items.slice(0, -1), { kind: 'assistant', text: message.text }] : [...items, { kind: 'assistant', text: message.text }]); return;
          case 'reasoning': setReasoning(text => text + message.text); return;
          case 'tool_call':
            setEntries(items => {
              const status = message.executionState === 'queued' ? 'Queued' : 'Running';
              const tool = message.tool ?? pageRef.current?.tools.find(tool => tool.key === message.key && tool.origin === message.origin);
              return items.some(item => item.kind === 'tool' && item.callId === message.callId)
                ? items.map(item => item.kind === 'tool' && item.callId === message.callId ? { ...item, status } : item)
                : [...items, { kind: 'tool', sdkName: message.sdkName, args: message.args, callId: message.callId, status, ...(tool ? { tool } : {}) }];
            }); return;
          case 'tool_done':
            setEntries(items => items.map(item => item.kind === 'tool' && item.callId === message.callId
              ? { ...item, ok: message.ok, result: message.result, status: message.ok ? 'Done' : 'Failed' } : item)); return;
          case 'question': setQuestion(message); return;
          case 'status': setRunning(message.state === 'running'); if (message.state === 'idle') setQuestion(undefined); return;
          case 'title': setTitle(message.title); return;
          case 'error':
            console.error('WebMCP Agent host error', { code: message.code, chatId: message.chatId, message: message.message });
            setLoadingChat(false);
            setEntries(items => [...items, { kind: 'notice', text: message.message }]); return;
          case 'log': setLogs(lines => [...lines.slice(-299), `${message.time} ${message.level} ${message.text}`]); return;
          case 'inspect_result': setInspectResult(message); return;
        }
      });
    }).catch(error => { console.error('WebMCP Agent panel connection failed', error); setConnectionError(String(error)); });
    return () => { disposed = true; port.current?.disconnect(); };
  }, []);
  function updateSettings(value: ExtensionSettings) { setSettings(value); send({ type: 'settings', settings: value }); }
  function changeModel(model: string) {
    updateSettings({ ...settings, model });
    send({ type: 'set_model', model: model || 'auto' });
  }
  const enabled = connection === 'Connected' && !!chatId && !loadingChat;
  const hasConversation = entries.some(entry => entry.kind !== 'notice');
  const showInitialModel = !loadingChat && !hasConversation;
  return <main>
    <header className="app-header">
      <div className="header-bar"><strong>WebMCP Agent</strong>
        <div className="header-actions">
          <Button className="new-chat" aria-label="New chat" title="New chat" icon={<Add20Regular />}
            disabled={running || loadingChat || connection !== 'Connected'}
            onClick={() => { send({ type: 'new_chat' }); setView('chat'); }} />
          <Button icon={<Settings20Regular />} aria-expanded={settingsOpen} onClick={() => { setSettingsOpen(!settingsOpen); send({ type: 'logs', follow: !settingsOpen }); }}>Settings</Button>
        </div>
      </div>
      <div className="chat-meta"><span className="chat-title" title={title}>{title}</span><span className="connection">{connection}</span></div>
    </header>
    {connectionError && <aside role="alert">{connectionError}<p><code>cd webmcp-agent</code><br /><code>npm run setup</code> / <code>npm run doctor</code></p>
      <a href={chrome.runtime.getURL('README.md')} target="_blank" rel="noopener noreferrer">Setup and troubleshooting</a>{' '}
      <Button onClick={() => send({ type: 'reconnect' })}>Reconnect</Button></aside>}
    {connection === 'Signed out' && <aside>Run <code>npm run login</code> in webmcp-agent, then <Button onClick={() => send({ type: 'reconnect' })}>Retry</Button>.</aside>}
    <nav aria-label="Views"><TabList selectedValue={view} size="small" onTabSelect={(_event, data) => {
      if (data.value === 'chat' || data.value === 'tools' || data.value === 'history') {
        setView(data.value);
        if (data.value === 'history') send({ type: 'list_chats' });
      }
    }}>{(['chat', 'tools', 'history'] as const).map(item =>
      <Tab key={item} value={item} aria-label={item.charAt(0).toUpperCase() + item.slice(1)}>{item.charAt(0).toUpperCase() + item.slice(1)}</Tab>)}</TabList></nav>
    {page && <section className="context"><strong>{page.page.title}</strong><span>{page.page.origin === 'null' ? page.page.url : page.page.origin}</span>
      <span>{page.tools.length} tools ({page.tools.filter(tool => !tool.isTopFrame).length} from embedded frames)</span>
      {(!page.available || page.error) && <p role="status">{page.available ? page.error : 'WebMCP is unavailable. Enable WebMCP for testing in edge://flags or chrome://flags and reload the page. Restricted browser pages cannot expose tools. You can still chat without page tools.'}</p>}
    </section>}
    {settingsOpen && <section className="settings"><h2>Settings</h2>
      <label className="settings-model">Model<ModelPicker model={settings.model} models={models} disabled={running || !enabled} onChange={changeModel} /></label>
      <Checkbox label="Include debugging tools" checked={settings.includeDebug} onChange={(_event, data) => updateSettings({ ...settings, includeDebug: data.checked === true })} />
      <Checkbox label="Show reasoning" checked={settings.showReasoning} onChange={(_event, data) => updateSettings({ ...settings, showReasoning: data.checked === true })} />
      <label>Maximum result characters<Input type="number" min={1} max={256000} value={String(settings.maxToolResultChars)} onChange={event => {
        const value = Number(event.target.value);
        if (Number.isInteger(value) && value >= 1 && value <= 256000) updateSettings({ ...settings, maxToolResultChars: value });
      }} /></label>
      <Checkbox label="Verbose host logs (includes page arguments and results)" checked={settings.verboseLogs} onChange={(_event, data) => updateSettings({ ...settings, verboseLogs: data.checked === true })} />
      <details><summary>Diagnostics and host logs</summary><p>Extension: <code>{chrome.runtime.id}</code><br />Host: {ready?.hostVersion ?? 'unavailable'}<br />SDK: {ready?.sdkVersion ?? 'unavailable'}<br />Signed in: {String(ready?.signedIn ?? false)}<br />Data: {ready?.dataPath ?? 'unavailable'}</p>
        <pre>{logs.join('\n')}</pre><Button onClick={() => { void navigator.clipboard.writeText(logs.join('\n')).catch(error => setConnectionError(String(error))); }}>Copy logs</Button>
      </details><Button onClick={() => send({ type: 'reconnect' })}>Reconnect host</Button>
    </section>}
    {view === 'chat' && <>
      <Chat className={`transcript${hasConversation ? '' : ' empty'}`} aria-label="Conversation" aria-live="polite">
        {loadingChat && <p role="status">Opening SDK chat history...</p>}
        {!loadingChat && !hasConversation && <div className="empty-welcome"><h2>What can I help with?</h2><p className="muted">Ask a question or give this page a task.</p></div>}
        {entries.map((entry, index) => entry.kind === 'tool' ? <ToolCard key={index} entry={entry} /> :
          entry.kind === 'notice' ? <aside className="notice" key={index}><Markdown text={entry.text} /></aside> :
          entry.kind === 'user' ? <ChatMyMessage key={index} author="You" root={{ className: 'message user' }} body={{ className: 'message-body' }}><Markdown text={entry.text} /></ChatMyMessage> :
          <ChatMessage key={index} author="WebMCP Agent" root={{ className: 'message assistant' }} body={{ className: 'message-body' }}><Markdown text={entry.text} /></ChatMessage>)}
      </Chat>
      {settings.showReasoning && reasoning && <details><summary>Thinking</summary><Markdown text={reasoning} /></details>}
      {paused && <PauseCard onContinue={() => send({ type: 'continue' })} onStop={() => send({ type: 'stop' })} />}
      {question && <QuestionCard key={question.requestId} question={question} onAnswer={(answer, wasFreeform) => { send({ type: 'answer', requestId: question.requestId, answer, wasFreeform }); setQuestion(undefined); }} />}
      <form className="composer" onSubmit={event => { event.preventDefault(); if (draft.trim() && enabled && !running) { send({ type: 'send', text: draft.trim() }); setDraft(''); } }}>
        <label htmlFor="prompt" className="visually-hidden">Message</label>
        <div className="composer-surface">
          <Textarea id="prompt" resize="vertical" rows={3} value={draft} disabled={!enabled || running} placeholder={!enabled ? 'Connect and sign in to send a message' : 'Ask about this page...'} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
          }} />
          <div className="composer-toolbar">
            {showInitialModel && <div className="model-chip"><ModelPicker model={settings.model} models={models} disabled={!enabled || running} onChange={changeModel} /></div>}
            <div className="composer-actions">{running
              ? <Button type="button" onClick={() => send({ type: 'stop' })}>Stop</Button>
              : <Button type="submit" appearance="primary" disabled={!enabled || !draft.trim()}>Send</Button>}</div>
          </div>
        </div>
      </form>
    </>}
    {view === 'tools' && page && <Inspector page={page} settings={settings} send={send} result={inspectResult} />}
    {view === 'history' && <section><h2>Saved chats</h2>
      <p className="muted">Page content stays in WebMCP Agent's data folder until you delete it.</p>
      {chats.map(chat => <article className="history" key={chat.chatId}><Button disabled={running || loadingChat} onClick={() => { send({ type: 'open_chat', chatId: chat.chatId }); setView('chat'); }}>{chat.title}</Button><small>{new Date(chat.updatedAt).toLocaleString()}</small>
        <Button disabled={running || loadingChat} onClick={() => { if (confirm('Delete this WebMCP Agent chat?')) send({ type: 'delete_chat', chatId: chat.chatId }); }}>Delete</Button></article>)}
      <Button disabled={running || loadingChat} onClick={() => { if (confirm('Delete all WebMCP Agent chats? This cannot be undone.')) send({ type: 'clear_chats' }); }}>Clear WebMCP chats</Button>
    </section>}
  </main>;
}

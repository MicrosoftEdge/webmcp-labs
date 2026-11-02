// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
import { validateToExtension } from '@webmcp-agent/shared/validate';
import { pageOrigin, type ToHost, type ToExtension } from '@webmcp-agent/shared/protocol';
import {
  contentResponseSchema, panelRequestSchema, extensionSettingsSchema, defaultSettings,
  TabBinding, trustedFrameOrigins, type PageState, type PanelRequest, type ExtensionSettings,
} from '../messages';

type ToolCall = Extract<ToExtension, { type: 'tool_call' }>;
interface WindowState {
  ports: Set<chrome.runtime.Port>;
  binding: TabBinding;
  chatId?: string;
  page?: PageState;
  held: ToolCall[];
  calls: Map<string, ToolCall>;
  lastContext?: string;
  loading: boolean;
}
const windows = new Map<number, WindowState>();
const snapshots = new Map<number, PageState>();
const pendingQuestions = new Set<string>();
async function updateBadge(): Promise<void> {
  await chrome.action.setBadgeText({ text: pendingQuestions.size ? '?' : '' });
  if (pendingQuestions.size) await chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
}
let native: chrome.runtime.Port | undefined;
let ready: Extract<ToExtension, { type: 'ready' }> | undefined;
let settings: ExtensionSettings = { ...defaultSettings };
let settingsLoaded = chrome.storage.local.get('settings').then(value => {
  const parsed = extensionSettingsSchema.safeParse(value.settings ?? defaultSettings);
  if (!parsed.success) throw new Error('Stored WebMCP Agent settings are invalid. Reset extension settings.');
  settings = parsed.data;
}).catch(error => { console.error(error); });
const opens: { windowId: number; chatId?: string; model?: string }[] = [];
let opening: { windowId: number; chatId?: string; model?: string } | undefined;
let openTimer: ReturnType<typeof setTimeout> | undefined;
let resetAfterClear = false;

function state(windowId: number): WindowState {
  let value = windows.get(windowId);
  if (!value) {
    value = { ports: new Set(), binding: new TabBinding(), held: [], calls: new Map(), loading: false };
    windows.set(windowId, value);
  }
  return value;
}
function post(windowId: number, message: unknown): void {
  for (const port of state(windowId).ports) {
    try { port.postMessage(message); } catch (error) { console.warn('Panel disconnected', error); }
  }
}
function notice(windowId: number, text: string): void { post(windowId, { type: 'notice', text }); }
function report(windowId: number, error: unknown): void {
  console.error('WebMCP Agent request failed', error);
  notice(windowId, error instanceof Error ? error.message : String(error));
}
function setLoading(windowId: number, loading: boolean): void {
  state(windowId).loading = loading;
  post(windowId, { type: 'chat_loading', loading });
}
function broadcast(message: unknown): void { for (const id of windows.keys()) post(id, message); }
function send(message: ToHost): void {
  if (!native || (!ready && message.type !== 'hello')) throw new Error('WebMCP Agent host is not connected.');
  native.postMessage(message);
}
function agentTools(page: PageState) { return page.tools.filter(tool => settings.includeDebug || !tool.annotations.debugging); }
function pauseState(windowId: number): void {
  const window = state(windowId);
  post(windowId, { type: 'pause', paused: window.binding.paused, tabId: window.binding.boundTabId ?? -1 });
}
function connectionError(message: string): string {
  if (/not found/i.test(message)) return 'Host not installed. Run npm run setup in webmcp-agent, then Reconnect.';
  if (/forbidden|blocked|denied/i.test(message)) return 'Native messaging is blocked by browser policy. Run npm run doctor and check NativeMessagingUserLevelHosts, NativeMessagingAllowlist and NativeMessagingBlocklist.';
  return `Host offline: ${message}. Run npm run doctor, then Reconnect.`;
}
function scheduleDisconnect(): void {
  void chrome.alarms.create('host-idle', { delayInMinutes: 5 });
}
function connect(): void {
  if (native) return;
  broadcast({ type: 'connection', status: 'Connecting' });
  const port = chrome.runtime.connectNative('com.microsoft.webmcp_agent');
  native = port;
  port.onMessage.addListener((value: unknown) => {
    const parsed = validateToExtension(value);
    if (!parsed.success) {
      console.error('WebMCP Agent rejected a host message', parsed.error.issues);
      broadcast({ type: 'notice', text: 'Invalid host message or protocol mismatch. Rerun npm run setup.' });
      return;
    }
    void hostMessage(parsed.data).catch(error => {
      console.error('WebMCP Agent host-message routing failed', error);
      broadcast({ type: 'notice', text: String(error) });
    });
  });
  port.onDisconnect.addListener(() => {
    if (native !== port) return;
    const message = chrome.runtime.lastError?.message ?? 'Connection closed';
    native = undefined;
    ready = undefined;
    pendingQuestions.clear();
    void updateBadge().catch(error => console.warn('Cannot update the question badge', error));
    opening = undefined;
    opens.splice(0);
    clearTimeout(openTimer);
    broadcast({ type: 'connection', status: 'Offline', error: connectionError(message) });
    for (const [id, window] of windows) {
      setLoading(id, false);
      void cancelCalls(window).catch(error => report(id, error));
      window.binding.stop();
      window.held = [];
      pauseState(id);
      if (window.chatId) post(id, { type: 'status', chatId: window.chatId, state: 'idle' });
      notice(id, 'Host disconnected. Your chat remains saved; reconnect to resume it.');
    }
  });
  port.postMessage({ type: 'hello', protocolVersion: 1, extensionVersion: chrome.runtime.getManifest().version } satisfies ToHost);
}
function queueOpen(windowId: number, chatId?: string): void {
  if (chatId && [...windows.entries()].some(([id, window]) => id !== windowId && window.chatId === chatId)) {
    throw new Error('That chat is already open in another window.');
  }
  if (state(windowId).loading || opening?.windowId === windowId || opens.some(entry => entry.windowId === windowId)) return;
  opens.push({ windowId, ...(chatId ? { chatId } : {}), ...(settings.model ? { model: settings.model } : {}) });
  setLoading(windowId, true);
  void nextOpen();
}
async function nextOpen(): Promise<void> {
  if (opening || resetAfterClear || !ready || !native) return;
  opening = opens.shift();
  if (!opening) return;
  const request = opening;
  try {
    const page = await activePage(request.windowId);
    post(request.windowId, { type: 'reset' });
    send({
      type: 'open_chat', page: page.page, tools: agentTools(page),
      ...(request.chatId ? { chatId: request.chatId } : {}), ...(request.model ? { model: request.model } : {}),
    });
    openTimer = setTimeout(() => {
      report(request.windowId, new Error('Opening the chat timed out. Reconnect the host.'));
      native?.disconnect();
    }, 45000);
  } catch (error) {
    opening = undefined;
    setLoading(request.windowId, false);
    report(request.windowId, error);
    void nextOpen();
  }
}
async function hostMessage(message: ToExtension): Promise<void> {
  if (message.type === 'error') {
    console.error('WebMCP Agent host error', {
      code: message.code, chatId: message.chatId, message: message.message,
    });
  }
  if (message.type === 'ready') {
    ready = message;
    broadcast(message);
    broadcast({ type: 'connection', status: message.signedIn ? 'Connected' : 'Signed out' });
    send({ type: 'set_settings', settings: { maxToolResultChars: settings.maxToolResultChars, verboseLogs: settings.verboseLogs } });
    if (message.signedIn) send({ type: 'list_models' });
    for (const [id, window] of windows) if (window.ports.size) queueOpen(id, window.chatId);
    return;
  }
  if (message.type === 'chat_opened' && opening) {
    const id = opening.windowId;
    const created = opening.chatId === undefined;
    state(id).chatId = message.chatId;
    clearTimeout(openTimer);
    post(id, message);
    // History and status follow chat_opened; route by assigned chat id.
    opening = undefined;
    if (created) send({ type: 'list_chats' });
    await chrome.storage.session.set({ windowChats: Object.fromEntries([...windows].filter(([, window]) => window.chatId).map(([id, window]) => [id, window.chatId])) });
    void nextOpen();
    return;
  }
  if (message.type === 'error' && opening && (!message.chatId || message.chatId === opening.chatId)) {
    clearTimeout(openTimer);
    post(opening.windowId, message);
    setLoading(opening.windowId, false);
    opening = undefined;
    void nextOpen();
    return;
  }
  if (!('chatId' in message) || !message.chatId) {
    broadcast(message);
    if (message.type === 'chats' && message.cleared && resetAfterClear) {
      resetAfterClear = false;
      for (const [id, entry] of windows) if (entry.ports.size) queueOpen(id);
    }
    return;
  }
  const owner = [...windows].find(([, window]) => window.chatId === message.chatId);
  if (!owner) { console.warn('Host message has no owning window', message.type); return; }
  const [id, window] = owner;
  if (message.type === 'history' && message.done) setLoading(id, false);
  if (message.type === 'error' && window.loading) setLoading(id, false);
  if (message.type === 'tool_call') {
    if (window.calls.has(message.callId) || window.held.some(call => call.callId === message.callId)) return;
    post(id, { ...message, executionState: window.binding.paused ? 'queued' : 'running' });
    if (window.binding.paused) { window.held.push(message); return; }
    void execute(id, message).catch(error => report(id, error));
    return;
  }
  if (message.type === 'status') {
    if (message.state === 'running') window.binding.running = true;
    else {
      pendingQuestions.delete(message.chatId);
      await updateBadge();
      window.binding.stop();
      window.held = [];
      if (window.calls.size) void cancelCalls(window).catch(error => report(id, error));
      scheduleDisconnect();
    }
    pauseState(id);
  }
  if (message.type === 'question') {
    pendingQuestions.add(message.chatId);
    await updateBadge();
  }
  if (message.type === 'tool_done') window.calls.delete(message.callId);
  post(id, message);
}
async function refresh(tabId: number): Promise<PageState> {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url ?? 'about:blank';
  const page = { tabId, url, title: tab.title ?? url, origin: pageOrigin(url) };
  let snapshot: PageState = { type: 'page', page, tools: [], available: false };
  try {
    const frames = page.origin === 'null' ? [] : await chrome.webNavigation.getAllFrames({ tabId }) ?? [];
    const top = frames.find(frame => frame.frameId === 0);
    const fromOrigins = trustedFrameOrigins(frames, page.origin);
    if (page.origin !== 'null') {
      const response: unknown = await chrome.tabs.sendMessage(tabId, { type: 'webmcp/list', fromOrigins }, { frameId: 0 });
      const parsed = contentResponseSchema.parse(response);
      if (parsed.type !== 'webmcp/snapshot') throw new Error('Unexpected page tool response.');
      snapshot = {
        type: 'page', page: { ...page, ...(top?.documentId ? { documentId: top.documentId } : {}) },
        tools: parsed.tools, available: parsed.available, ...(parsed.error ? { error: parsed.error } : {}),
      };
    }
  } catch (error) {
    snapshot.error = error instanceof Error ? error.message : String(error);
  }
  snapshots.set(tabId, snapshot);
  const window = state(tab.windowId);
  const [active] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
  if (active?.id === tabId) { window.page = snapshot; post(tab.windowId, snapshot); }
  if (window.binding.running && window.binding.boundTabId === tabId && window.chatId && ready) {
    send({ type: 'set_tools', chatId: window.chatId, page: snapshot.page, tools: agentTools(snapshot) });
  }
  return snapshot;
}
async function activePage(windowId: number): Promise<PageState> {
  const [tab] = await chrome.tabs.query({ windowId, active: true });
  if (tab?.id === undefined) throw new Error('No active tab in this window.');
  return refresh(tab.id);
}
async function execute(windowId: number, call: ToolCall): Promise<void> {
  const window = state(windowId);
  const tabId = window.binding.boundTabId;
  window.calls.set(call.callId, call);
  post(windowId, { ...call, executionState: 'running' });
  try {
    if (tabId === undefined || call.tabId !== tabId) throw new Error('Tool call does not belong to the bound tab.');
    const page = snapshots.get(tabId);
    if (!page || call.documentId !== page.page.documentId || !page.tools.some(tool => tool.key === call.key && tool.origin === call.origin)) {
      throw new DOMException('The page navigated or the tool is no longer available.', 'AbortError');
    }
    const options = call.documentId ? { documentId: call.documentId } : { frameId: 0 };
    const response: unknown = await chrome.tabs.sendMessage(tabId, {
      type: 'webmcp/execute', callId: call.callId, key: call.key, args: call.args,
    }, options);
    const parsed = contentResponseSchema.parse(response);
    if (parsed.type !== 'webmcp/result' || parsed.callId !== call.callId) throw new Error('Invalid tool execution response.');
    if (!window.calls.has(call.callId)) return;
    send(parsed.ok
      ? { type: 'tool_result', chatId: call.chatId, callId: call.callId, ok: true, result: parsed.result }
      : { type: 'tool_result', chatId: call.chatId, callId: call.callId, ok: false, error: parsed.error });
  } catch (error) {
    if (!window.calls.has(call.callId)) return;
    send({ type: 'tool_result', chatId: call.chatId, callId: call.callId, ok: false, error: {
      name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error),
    } });
  }
}
async function cancelCalls(window: WindowState): Promise<void> {
  for (const call of window.calls.values()) {
    if (call.tabId !== undefined) {
      try {
        await chrome.tabs.sendMessage(call.tabId, { type: 'webmcp/cancel', callId: call.callId },
          call.documentId ? { documentId: call.documentId } : { frameId: 0 });
      } catch (error) { console.debug('Cancelled call document is unavailable', error); }
    }
  }
  window.calls.clear();
}
async function panelMessage(windowId: number, message: PanelRequest): Promise<void> {
  const window = state(windowId);
  switch (message.type) {
    case 'send': {
      if (!window.chatId) throw new Error('Wait for a chat to open.');
      if (window.loading) throw new Error('Wait for SDK history to finish opening before sending.');
      if (window.binding.running) throw new Error('A turn is already running.');
      const page = await activePage(windowId);
      window.binding.begin(page.page.tabId);
      const tools = agentTools(page);
      const context = JSON.stringify([page.page, tools]);
      try {
        send({ type: 'send', chatId: window.chatId, text: message.text, page: page.page, tools, pageChanged: window.lastContext !== context });
      } catch (error) { window.binding.stop(); throw error; }
      window.lastContext = context;
      post(windowId, { type: 'user', text: message.text });
      return;
    }
    case 'new_chat':
    case 'open_chat': {
      if (window.binding.running) throw new Error('Stop the current turn before changing chats.');
      if (window.loading) throw new Error('A chat is still opening. Wait for its SDK history to finish loading.');
      const target = message.type === 'open_chat' ? message.chatId : undefined;
      if (target && [...windows.entries()].some(([id, entry]) => id !== windowId && entry.chatId === target)) {
        throw new Error('That chat is already open in another window.');
      }
      if (window.chatId !== target) {
        if (window.chatId) send({ type: 'close_chat', chatId: window.chatId });
        delete window.chatId;
      }
      queueOpen(windowId, target);
      return;
    }
    case 'stop':
      window.binding.stop();
      window.held = [];
      await cancelCalls(window);
      if (window.chatId) send({ type: 'stop', chatId: window.chatId });
      pauseState(windowId);
      return;
    case 'continue':
      window.binding.continue();
      pauseState(windowId);
      for (const call of window.held.splice(0)) void execute(windowId, call).catch(error => report(windowId, error));
      return;
    case 'answer':
      if (!window.chatId) throw new Error('No chat is open.');
      send({ ...message, chatId: window.chatId });
      pendingQuestions.delete(window.chatId);
      await updateBadge();
      return;
    case 'set_model':
      if (!window.chatId) throw new Error('No chat is open.');
      send({ ...message, chatId: window.chatId });
      settings.model = message.model;
      await chrome.storage.local.set({ settings });
      return;
    case 'settings':
      settings = message.settings;
      await chrome.storage.local.set({ settings });
      broadcast({ type: 'settings', settings });
      if (ready) send({ type: 'set_settings', settings: { maxToolResultChars: settings.maxToolResultChars, verboseLogs: settings.verboseLogs } });
      for (const [id] of windows) await activePage(id);
      return;
    case 'inspect_run': {
      if (window.binding.running) throw new Error('Stop the agent before running tools manually.');
      const page = await activePage(windowId);
      if (!page.tools.some(tool => tool.key === message.key)) throw new Error('Tool is no longer available.');
      const response: unknown = await chrome.tabs.sendMessage(page.page.tabId, {
        type: 'webmcp/execute', callId: crypto.randomUUID(), key: message.key, args: message.args,
      }, page.page.documentId ? { documentId: page.page.documentId } : { frameId: 0 });
      const result = contentResponseSchema.parse(response);
      if (result.type !== 'webmcp/result') throw new Error('Unexpected manual tool result.');
      post(windowId, { type: 'inspect_result', key: message.key, ...('result' in result ? { result: result.result ?? '' } : { result: `${result.error.name}: ${result.error.message}` }), ok: result.ok });
      return;
    }
    case 'list_chats': case 'logs': send(message); return;
    case 'clear_chats':
      if ([...windows.values()].some(entry => entry.binding.running || entry.loading)) throw new Error('Wait for chats to open and stop all runs before clearing chats.');
      resetAfterClear = true;
      send(message);
      for (const [id, entry] of windows) {
        delete entry.chatId;
        post(id, { type: 'reset' });
      }
      return;
    case 'delete_chat':
      if (window.loading) throw new Error('Wait for the current chat to finish opening.');
      if ([...windows.values()].some(entry => entry.chatId === message.chatId && (entry.binding.running || entry.loading))) throw new Error('Stop the chat before deleting it.');
      send(message);
      if (window.chatId === message.chatId) { delete window.chatId; queueOpen(windowId); }
      return;
    case 'reconnect':
      native?.disconnect();
      native = undefined;
      ready = undefined;
      pendingQuestions.clear();
      await updateBadge();
      opening = undefined;
      opens.splice(0);
      resetAfterClear = false;
      clearTimeout(openTimer);
      for (const [id, entry] of windows) {
        setLoading(id, false);
        await cancelCalls(entry);
        entry.binding.stop();
        entry.held = [];
        pauseState(id);
      }
      connect();
      return;
  }
}
chrome.runtime.onConnect.addListener(port => {
  if (port.sender?.id !== chrome.runtime.id || !port.sender.url?.startsWith(chrome.runtime.getURL('sidepanel.html'))) { port.disconnect(); return; }
  const match = /^panel:(\d+)$/.exec(port.name);
  if (!match) { port.disconnect(); return; }
  const id = Number(match[1]);
  const window = state(id);
  window.ports.add(port);
  void chrome.alarms.clear('host-idle');
  port.onMessage.addListener((value: unknown) => {
    const parsed = panelRequestSchema.safeParse(value);
    if (!parsed.success) { notice(id, 'Rejected an invalid panel request.'); return; }
    void panelMessage(id, parsed.data).catch(error => report(id, error));
  });
  port.onDisconnect.addListener(() => { window.ports.delete(port); scheduleDisconnect(); });
  void (async () => {
    await settingsLoaded;
    const stored = await chrome.storage.session.get('windowChats');
    const saved: unknown = stored.windowChats?.[id];
    if (!window.chatId && typeof saved === 'string') window.chatId = saved;
    post(id, { type: 'settings', settings });
    await activePage(id);
    if (ready) {
      post(id, ready);
      post(id, { type: 'connection', status: ready.signedIn ? 'Connected' : 'Signed out' });
      queueOpen(id, window.chatId);
      if (ready.signedIn) send({ type: 'list_models' });
    } else connect();
    pauseState(id);
  })().catch(error => report(id, error));
});
chrome.runtime.onMessage.addListener((value: unknown, sender) => {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.tab?.id === undefined) return false;
  const parsed = contentResponseSchema.safeParse(value);
  if (!parsed.success) { console.warn('Rejected invalid content-script message'); return false; }
  if (parsed.data.type === 'webmcp/snapshot') void refresh(sender.tab.id).catch(error => console.warn('Tool refresh failed', error));
  if (parsed.data.type === 'webmcp/log' && settings.verboseLogs) broadcast({ type: 'notice', text: `Page event: ${parsed.data.text.slice(0, 100)}` });
  return false;
});
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const window = state(windowId);
  window.binding.activate(tabId);
  pauseState(windowId);
  if (!window.binding.paused && window.held.length) for (const call of window.held.splice(0)) void execute(windowId, call).catch(error => report(windowId, error));
  void refresh(tabId).catch(error => report(windowId, error));
});
chrome.windows.onFocusChanged.addListener(id => {
  if (id < 0 || !windows.has(id)) return;
  void activePage(id).then(page => { state(id).binding.activate(page.page.tabId); pauseState(id); }).catch(error => report(id, error));
});
chrome.tabs.onRemoved.addListener(tabId => {
  snapshots.delete(tabId);
  for (const [id, window] of windows) if (window.binding.running && window.binding.boundTabId === tabId) {
    void panelMessage(id, { type: 'stop' }).catch(error => report(id, error));
    notice(id, 'The bound tab closed. The run was stopped.');
  }
});
chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId === 0) {
    const empty: PageState = {
      type: 'page', page: {
        tabId: details.tabId, url: details.url, title: details.url,
        origin: pageOrigin(details.url), documentId: details.documentId,
      }, tools: [], available: false,
    };
    snapshots.set(details.tabId, empty);
    for (const [id, window] of windows) if (window.binding.running && window.binding.boundTabId === details.tabId) {
      if (window.chatId && ready) send({ type: 'set_tools', chatId: window.chatId, page: empty.page, tools: [] });
      for (const call of window.calls.values()) {
        send({ type: 'tool_result', chatId: call.chatId, callId: call.callId, ok: false, error: { name: 'AbortError', message: 'The bound page navigated.' } });
      }
      window.calls.clear();
      notice(id, 'The page navigated. Refreshing its tool list.');
    }
  }
  void refresh(details.tabId).catch(error => console.debug('Navigation tool refresh unavailable', error));
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url || change.status === 'complete') void refresh(tabId).catch(error => console.debug('Tab tool refresh unavailable', error));
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'host-idle' && ![...windows.values()].some(window => window.ports.size || window.binding.running)) native?.disconnect();
});
chrome.windows.onRemoved.addListener(id => {
  const window = windows.get(id);
  if (window?.chatId) pendingQuestions.delete(window.chatId);
  void updateBadge().catch(error => console.warn('Cannot update the question badge', error));
  if (window?.chatId && native && ready) send({ type: 'close_chat', chatId: window.chatId });
  windows.delete(id);
  scheduleDisconnect();
});
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(error => console.error('Cannot configure side panel', error));

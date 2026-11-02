// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageTool, chatId } from './helpers.js';

class Signal<T extends unknown[]> {
  listeners: ((...args: T) => unknown)[] = [];
  addListener = (listener: (...args: T) => unknown) => { this.listeners.push(listener); };
  emit(...args: T) { for (const listener of this.listeners) listener(...args); }
}
interface Sender { id?: string; url?: string; tab?: { id: number }; frameId?: number; documentId?: string }
function port(sender: Sender, name = '') {
  return {
    name, sender, postMessage: vi.fn(),
    disconnect: vi.fn(), onMessage: new Signal<[unknown]>(), onDisconnect: new Signal<[]>(),
  };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
async function setup() {
  vi.resetModules();
  const native = port({});
  const runtime = {
    id: 'test-extension', onConnect: new Signal<[ReturnType<typeof port>]>(),
    onMessage: new Signal<[unknown, Sender]>(),
    getURL: (path: string) => `chrome-extension://test-extension/${path}`,
    getManifest: () => ({ version: '0.1.0' }),
    connectNative: vi.fn(() => native),
    lastError: undefined as { message: string } | undefined,
  };
  let activeTabId = 7;
  const mock = {
    runtime,
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => ({ id: tabId, windowId: 1, title: 'Test page', url: 'https://pizza.example/menu' })),
      query: vi.fn(async (query: { windowId: number }) => [{ id: query.windowId === 2 ? 22 : activeTabId, windowId: query.windowId }]),
      sendMessage: vi.fn(async (_id: number, message: { type: string }) => message.type === 'webmcp/list'
        ? { type: 'webmcp/snapshot', available: true, tools: [pageTool()] }
        : { type: 'webmcp/result', callId: 'call', ok: true, result: 'Raw result' }),
      onActivated: new Signal<[{ tabId: number; windowId: number }]>(),
      onRemoved: new Signal<[number]>(),
      onUpdated: new Signal<[number, { url?: string; status?: string }]>(),
    },
    webNavigation: {
      getAllFrames: vi.fn(async () => [{ frameId: 0, url: 'https://pizza.example/menu', documentId: 'doc-7' }]),
      onCommitted: new Signal<[{ tabId: number; frameId: number; url: string; documentId: string }]>(),
    },
    windows: { onFocusChanged: new Signal<[number]>(), onRemoved: new Signal<[number]>() },
    alarms: { create: vi.fn(async () => {}), clear: vi.fn(async () => true), onAlarm: new Signal<[{ name: string }]>() },
    sidePanel: { setPanelBehavior: vi.fn(async () => {}) },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
  };
  vi.stubGlobal('chrome', mock);
  await import('../extension/src/background/index.js');
  const panel = port({ id: runtime.id, url: runtime.getURL('sidepanel.html') }, 'panel:1');
  runtime.onConnect.emit(panel);
  await settle();
  native.onMessage.emit({ type: 'ready', protocolVersion: 1, hostVersion: '0.1.0', sdkVersion: '1.0.28', signedIn: true });
  await settle();
  native.onMessage.emit({ type: 'chat_opened', chatId, title: 'Test chat' });
  native.onMessage.emit({ type: 'history', chatId, items: [], done: true });
  await settle();
  const activate = (tabId: number) => { activeTabId = tabId; mock.tabs.onActivated.emit({ tabId, windowId: 1 }); };
  const begin = async () => { panel.onMessage.emit({ type: 'send', text: 'Synthetic task' }); await settle(); };
  const call = () => native.onMessage.emit({
    type: 'tool_call', chatId, callId: 'call', sdkName: 'pizza_search', key: '0:search',
    tabId: 7, origin: 'https://pizza.example', documentId: 'doc-7', args: {},
  });
  return { mock, runtime, native, panel, activate, begin, call };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('worker message routing with mocked Chrome APIs', () => {
  it('connects once, validates content senders, and binds sends to the active tab', async () => {
    const test = await setup();
    expect(test.runtime.connectNative).toHaveBeenCalledTimes(1);
    await test.begin();
    expect(test.native.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'send', chatId, page: expect.objectContaining({ tabId: 7, documentId: 'doc-7' }) }));
    test.mock.tabs.sendMessage.mockClear();
    test.runtime.onMessage.emit({ type: 'webmcp/snapshot', available: true, tools: [] }, { id: 'malicious', tab: { id: 7 }, frameId: 0 });
    await settle();
    expect(test.mock.tabs.sendMessage).not.toHaveBeenCalled();
  });
  it('queues tools on a tab switch and Continue executes only on the original document', async () => {
    const test = await setup();
    await test.begin();
    test.activate(8);
    await settle();
    test.mock.tabs.sendMessage.mockClear();
    test.call();
    await settle();
    expect(test.mock.tabs.sendMessage).not.toHaveBeenCalled();
    expect(test.panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_call', executionState: 'queued' }));
    test.panel.onMessage.emit({ type: 'continue' });
    await settle();
    expect(test.mock.tabs.sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'webmcp/execute' }), { documentId: 'doc-7' });
    expect(test.native.postMessage).toHaveBeenCalledWith({ type: 'tool_result', chatId, callId: 'call', ok: true, result: 'Raw result' });
  });
  it('switching back resumes held calls, but Stop drops them', async () => {
    const test = await setup();
    await test.begin();
    test.activate(8);
    await settle();
    test.call();
    await settle();
    test.panel.onMessage.emit({ type: 'stop' });
    await settle();
    test.mock.tabs.sendMessage.mockClear();
    test.activate(7);
    await settle();
    expect(test.mock.tabs.sendMessage.mock.calls.some(([, request]) => request.type === 'webmcp/execute')).toBe(false);
    expect(test.native.postMessage).toHaveBeenCalledWith({ type: 'stop', chatId });
  });
  it('stops the run when the bound tab closes', async () => {
    const test = await setup();
    await test.begin();
    test.mock.tabs.onRemoved.emit(7);
    await settle();
    expect(test.native.postMessage).toHaveBeenCalledWith({ type: 'stop', chatId });
  });
  it('does not execute a call with a different document identity', async () => {
    const test = await setup();
    await test.begin();
    test.native.onMessage.emit({
      type: 'tool_call', chatId, callId: 'stale', sdkName: 'pizza_search', key: '0:search',
      tabId: 7, origin: 'https://pizza.example', documentId: 'old-document', args: {},
    });
    await settle();
    expect(test.native.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool_result', callId: 'stale', ok: false, error: expect.objectContaining({ name: 'AbortError' }),
    }));
  });
  it('explains native-host disconnection and preserves only chat IDs, not history', async () => {
    const test = await setup();
    test.runtime.lastError = { message: 'Specified native messaging host not found.' };
    test.native.onDisconnect.emit();
    await settle();
    expect(test.panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'connection', error: expect.stringContaining('npm run setup') }));
    expect(test.mock.storage.session.set).toHaveBeenCalledWith({ windowChats: { '1': chatId } });
    expect(test.mock.storage.local.set).not.toHaveBeenCalled();
  });
  it('disconnects on the idle alarm only after panels close and runs finish', async () => {
    const test = await setup();
    test.mock.alarms.onAlarm.emit({ name: 'host-idle' });
    expect(test.native.disconnect).not.toHaveBeenCalled();
    await test.begin();
    test.panel.onDisconnect.emit();
    test.mock.alarms.onAlarm.emit({ name: 'host-idle' });
    expect(test.native.disconnect).not.toHaveBeenCalled();
    test.native.onMessage.emit({ type: 'status', chatId, state: 'idle' });
    await settle();
    test.mock.alarms.onAlarm.emit({ name: 'host-idle' });
    expect(test.native.disconnect).toHaveBeenCalledTimes(1);
  });
  it('waits for the explicit clear acknowledgment before creating replacement chats', async () => {
    const test = await setup();
    test.native.postMessage.mockClear();
    test.panel.onMessage.emit({ type: 'clear_chats' });
    await settle();
    test.native.onMessage.emit({ type: 'chats', chats: [] });
    await settle();
    expect(test.native.postMessage.mock.calls.some(([message]) => message.type === 'open_chat')).toBe(false);
    test.native.onMessage.emit({ type: 'chats', chats: [], cleared: true });
    await settle();
    expect(test.native.postMessage.mock.calls.some(([message]) => message.type === 'open_chat')).toBe(true);
  });
  it('keeps two windows on distinct chats while sharing one native port', async () => {
    const test = await setup();
    const second = port({ id: test.runtime.id, url: test.runtime.getURL('sidepanel.html') }, 'panel:2');
    test.runtime.onConnect.emit(second);
    await settle();
    const secondChat = 'webmcp-agent-window-two';
    test.native.onMessage.emit({ type: 'chat_opened', chatId: secondChat, title: 'Second window' });
    test.native.onMessage.emit({ type: 'history', chatId: secondChat, items: [], done: true });
    await settle();
    second.onMessage.emit({ type: 'send', text: 'Second synthetic task' });
    await settle();
    test.panel.postMessage.mockClear();
    second.postMessage.mockClear();
    test.native.onMessage.emit({ type: 'delta', chatId: secondChat, text: 'Only window two' });
    await settle();
    expect(second.postMessage).toHaveBeenCalledWith({ type: 'delta', chatId: secondChat, text: 'Only window two' });
    expect(test.panel.postMessage).not.toHaveBeenCalled();
    expect(test.runtime.connectNative).toHaveBeenCalledTimes(1);
    expect(test.native.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'send', chatId: secondChat, page: expect.objectContaining({ tabId: 22 }) }));
  });
  it('updates document identity before failing in-flight calls on navigation', async () => {
    const test = await setup();
    await test.begin();
    test.call();
    await settle();
    test.native.postMessage.mockClear();
    test.mock.webNavigation.onCommitted.emit({
      tabId: 7, frameId: 0, url: 'https://pizza.example/new-page', documentId: 'new-document',
    });
    await settle();
    const sent = test.native.postMessage.mock.calls.map(([message]) => message);
    const updateIndex = sent.findIndex(message => message.type === 'set_tools' && message.page.documentId === 'new-document');
    const failureIndex = sent.findIndex(message => message.type === 'tool_result' && !message.ok);
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(failureIndex).toBeGreaterThan(updateIndex);
  });
  it('opens chats on browser pages without trying to discover page tools', async () => {
    const test = await setup();
    test.mock.tabs.get.mockResolvedValue({
      id: 7, windowId: 1, title: 'Extensions', url: 'edge://extensions/',
    });
    test.mock.tabs.sendMessage.mockClear();
    test.native.postMessage.mockClear();
    test.panel.onMessage.emit({ type: 'new_chat' });
    await settle();
    expect(test.mock.tabs.sendMessage).not.toHaveBeenCalled();
    expect(test.panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'page', available: false, tools: [], page: expect.objectContaining({ origin: 'null', url: 'edge://extensions/' }),
    }));
    expect(test.native.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'open_chat', tools: [], page: expect.objectContaining({ origin: 'null' }),
    }));
  });
  it('routes a failed history resume to the requesting panel and releases the pending open', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const test = await setup();
    const failedChat = 'webmcp-agent-failed-resume';
    test.panel.onMessage.emit({ type: 'open_chat', chatId: failedChat });
    await settle();
    test.native.onMessage.emit({ type: 'error', chatId: failedChat, code: 'sdk_error', message: 'Session is disconnected' });
    await settle();
    expect(test.panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', chatId: failedChat, message: 'Session is disconnected',
    }));
    expect(consoleError).toHaveBeenCalledWith('WebMCP Agent host error', {
      code: 'sdk_error', chatId: failedChat, message: 'Session is disconnected',
    });
    test.native.postMessage.mockClear();
    test.panel.onMessage.emit({ type: 'new_chat' });
    await settle();
    expect(test.native.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'open_chat' }));
  });
  it('re-reads the current SDK session without disconnecting it', async () => {
    const test = await setup();
    test.native.postMessage.mockClear();
    test.panel.onMessage.emit({ type: 'open_chat', chatId });
    await settle();
    expect(test.native.postMessage.mock.calls.some(([message]) => message.type === 'close_chat')).toBe(false);
    expect(test.native.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'open_chat', chatId }));
    test.native.onMessage.emit({ type: 'chat_opened', chatId, title: 'Same chat' });
    await settle();
    expect(test.panel.postMessage).toHaveBeenCalledWith({ type: 'chat_loading', loading: true });
    test.native.onMessage.emit({ type: 'history', chatId, items: [], done: true });
    await settle();
    expect(test.panel.postMessage).toHaveBeenLastCalledWith({ type: 'history', chatId, items: [], done: true });
    expect(test.panel.postMessage).toHaveBeenCalledWith({ type: 'chat_loading', loading: false });
  });
  it('refreshes Saved chats from the SDK after creating a session, without a History click', async () => {
    const test = await setup();
    test.panel.onMessage.emit({ type: 'new_chat' });
    await settle();
    test.native.postMessage.mockClear();
    const newChatId = 'webmcp-agent-new-session';
    test.native.onMessage.emit({ type: 'chat_opened', chatId: newChatId, title: 'New SDK chat' });
    await settle();
    expect(test.native.postMessage).toHaveBeenCalledWith({ type: 'list_chats' });
    const response = {
      type: 'chats', chats: [{ chatId: newChatId, title: 'SDK title', updatedAt: '2026-11-02T19:00:00Z' }],
    };
    test.native.onMessage.emit(response);
    await settle();
    expect(test.panel.postMessage).toHaveBeenCalledWith(response);
  });
  it('does not close the active chat or silently replace a selection while another open is pending', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const test = await setup();
    test.panel.onMessage.emit({ type: 'new_chat' });
    await settle();
    test.native.postMessage.mockClear();
    test.panel.onMessage.emit({ type: 'open_chat', chatId });
    await settle();
    expect(test.native.postMessage).not.toHaveBeenCalled();
    expect(test.panel.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'notice', text: expect.stringContaining('still opening'),
    }));
    expect(consoleError).toHaveBeenCalledWith('WebMCP Agent request failed', expect.any(Error));
  });
});

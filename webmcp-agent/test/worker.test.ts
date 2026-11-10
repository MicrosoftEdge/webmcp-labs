// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageTool, chatId } from './helpers.js';

class Signal<T extends unknown[]> {
  listeners: ((...args: T) => unknown)[] = [];
  addListener = (listener: (...args: T) => unknown) => { this.listeners.push(listener); };
  removeListener = (listener: (...args: T) => unknown) => { this.listeners = this.listeners.filter(current => current !== listener); };
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
      onHistoryStateUpdated: new Signal<[{ tabId: number; frameId: number; url: string }]>(),
      onReferenceFragmentUpdated: new Signal<[{ tabId: number; frameId: number; url: string }]>(),
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
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('worker message routing with mocked Chrome APIs', () => {
  it('changes the SDK model once without refreshing page tools or sending other host settings', async () => {
    const test = await setup();
    test.native.postMessage.mockClear();
    test.mock.tabs.sendMessage.mockClear();
    test.panel.onMessage.emit({ type: 'set_model', model: 'sdk-model' });
    await settle();
    expect(test.native.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'set_model', chatId, model: 'sdk-model' });
    expect(test.mock.tabs.sendMessage).not.toHaveBeenCalled();
    expect(test.mock.storage.local.set).toHaveBeenCalledExactlyOnceWith({
      settings: expect.objectContaining({ model: 'sdk-model' }),
    });
    expect(test.panel.postMessage).toHaveBeenCalledWith({
      type: 'settings', settings: expect.objectContaining({ model: 'sdk-model' }),
    });
    test.panel.onMessage.emit({ type: 'set_model', model: 'auto' });
    await settle();
    expect(test.mock.storage.local.set).toHaveBeenLastCalledWith({
      settings: expect.objectContaining({ model: '' }),
    });
  });
  it('rejects model changes while a turn is running without touching stored settings', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const test = await setup();
    await test.begin();
    test.native.postMessage.mockClear();
    test.panel.onMessage.emit({ type: 'set_model', model: 'sdk-model' });
    await settle();
    expect(test.native.postMessage).not.toHaveBeenCalled();
    expect(test.mock.storage.local.set).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith('WebMCP Agent request failed', expect.any(Error));
  });
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
  it('waits for the accepted SDK user event instead of inventing a user transcript entry', async () => {
    const test = await setup();
    test.panel.postMessage.mockClear();
    await test.begin();
    expect(test.panel.postMessage.mock.calls.some(([message]) => message.type === 'user')).toBe(false);
    const accepted = { type: 'user', chatId, messageId: 'sdk-user', text: 'Accepted by the SDK' };
    test.native.onMessage.emit(accepted);
    await settle();
    expect(test.panel.postMessage).toHaveBeenCalledWith(accepted);
  });
  it.each(['pending', 'failed'])('does not block SDK questions, idle or reconnect on a %s badge update', async state => {
    const consoleWarning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const test = await setup();
    if (state === 'pending') test.mock.action.setBadgeText.mockImplementation(() => new Promise<void>(() => {}));
    else test.mock.action.setBadgeText.mockRejectedValue(new Error('Synthetic badge failure'));
    const question = { type: 'question', chatId, requestId: 'question-one', question: 'Continue?', allowFreeform: true };
    test.native.onMessage.emit(question);
    test.native.onMessage.emit({ type: 'status', chatId, state: 'idle' });
    await settle();
    expect(test.panel.postMessage).toHaveBeenCalledWith(question);
    expect(test.panel.postMessage).toHaveBeenCalledWith({ type: 'status', chatId, state: 'idle' });
    if (state === 'failed') expect(consoleWarning).toHaveBeenCalledWith('Cannot update the question badge', expect.any(Error));
    test.panel.onMessage.emit({ type: 'reconnect' });
    await settle();
    expect(test.runtime.connectNative).toHaveBeenCalledTimes(2);
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
  it('forwards SDK cancellation and drops held tools before a tab switch can resume them', async () => {
    const test = await setup();
    await test.begin();
    test.activate(8);
    await settle();
    test.call();
    await settle();
    test.mock.tabs.sendMessage.mockClear();
    const stopped = { type: 'abort', chatId, eventId: 'sdk-abort-one', reason: 'remote_command' };
    test.native.onMessage.emit(stopped);
    await settle();
    expect(test.panel.postMessage).toHaveBeenCalledWith(stopped);
    test.activate(7);
    await settle();
    expect(test.mock.tabs.sendMessage.mock.calls.some(([, request]) => request.type === 'webmcp/execute')).toBe(false);
    expect(test.native.postMessage.mock.calls.some(([request]) => request.type === 'stop')).toBe(false);
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
  it.each(['idle', 'opening', 'clearing'])('reopens on a fresh native port after locally disconnecting a chat in the %s phase', async phase => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const test = await setup();
    const replacement = port({});
    test.runtime.connectNative.mockReturnValue(replacement);
    test.native.disconnect.mockImplementation(() => {
      test.native.postMessage.mockImplementation(() => { throw new Error('Attempting to use a disconnected port object'); });
    });
    if (phase === 'opening') test.panel.onMessage.emit({ type: 'open_chat', chatId });
    if (phase === 'clearing') test.panel.onMessage.emit({ type: 'clear_chats' });
    await settle();
    test.panel.onDisconnect.emit();
    test.mock.alarms.onAlarm.emit({ name: 'host-idle' });
    await settle();
    expect(test.native.disconnect).toHaveBeenCalledTimes(1);
    const reopened = port({ id: test.runtime.id, url: test.runtime.getURL('sidepanel.html') }, 'panel:1');
    test.runtime.onConnect.emit(reopened);
    await settle();
    expect(test.runtime.connectNative).toHaveBeenCalledTimes(2);
    expect(replacement.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: 'hello', protocolVersion: 1, extensionVersion: '0.1.0',
    });
    replacement.onMessage.emit({ type: 'ready', protocolVersion: 1, hostVersion: '0.1.0', sdkVersion: '1.0.28', signedIn: true });
    await settle();
    const openRequests = replacement.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'open_chat');
    expect(openRequests).toHaveLength(1);
    if (phase !== 'clearing') expect(openRequests[0]).toMatchObject({ chatId });
    replacement.onMessage.emit({ type: 'chat_opened', chatId, title: 'Resumed SDK chat' });
    const history = { type: 'history', chatId, items: [{ kind: 'assistant', text: 'Saved by the SDK.' }], done: true };
    replacement.onMessage.emit(history);
    await settle();
    expect(reopened.postMessage).toHaveBeenCalledWith(history);
    expect(reopened.postMessage).toHaveBeenCalledWith({ type: 'chat_loading', loading: false });
    reopened.onMessage.emit({ type: 'send', text: 'After reopening' });
    await settle();
    expect(replacement.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'send', chatId, text: 'After reopening' }));
    expect(consoleError).not.toHaveBeenCalled();
  });
  it('clears a locally disconnected opening timeout before reconnecting', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const test = await setup();
    const replacement = port({});
    test.runtime.connectNative.mockReturnValue(replacement);
    vi.useFakeTimers();
    test.panel.onMessage.emit({ type: 'open_chat', chatId });
    await vi.advanceTimersByTimeAsync(45001);
    expect(test.native.disconnect).toHaveBeenCalledTimes(1);
    expect(test.panel.postMessage).toHaveBeenCalledWith({ type: 'notice', text: 'Opening the chat timed out. Reconnect the host.' });
    expect(consoleError).toHaveBeenCalledExactlyOnceWith('WebMCP Agent request failed', expect.any(Error));
    const reopened = port({ id: test.runtime.id, url: test.runtime.getURL('sidepanel.html') }, 'panel:1');
    test.runtime.onConnect.emit(reopened);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.runtime.connectNative).toHaveBeenCalledTimes(2);
    replacement.onMessage.emit({ type: 'ready', protocolVersion: 1, hostVersion: '0.1.0', sdkVersion: '1.0.28', signedIn: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(replacement.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'open_chat', chatId }));
    replacement.onMessage.emit({ type: 'chat_opened', chatId, title: 'Resumed SDK chat' });
    replacement.onMessage.emit({ type: 'history', chatId, items: [], done: true });
    await vi.advanceTimersByTimeAsync(45001);
    expect(replacement.disconnect).not.toHaveBeenCalled();
  });
  it('ignores late messages and disconnect callbacks from a replaced native port', async () => {
    const test = await setup();
    const replacement = port({});
    test.runtime.connectNative.mockReturnValue(replacement);
    test.panel.onMessage.emit({ type: 'reconnect' });
    await settle();
    replacement.onMessage.emit({ type: 'ready', protocolVersion: 1, hostVersion: '0.1.0', sdkVersion: '1.0.28', signedIn: true });
    await settle();
    replacement.onMessage.emit({ type: 'chat_opened', chatId, title: 'Resumed SDK chat' });
    replacement.onMessage.emit({ type: 'history', chatId, items: [], done: true });
    await settle();
    test.panel.postMessage.mockClear();
    replacement.postMessage.mockClear();
    test.native.onMessage.emit({ type: 'ready', protocolVersion: 1, hostVersion: 'old', sdkVersion: 'old', signedIn: false });
    test.native.onMessage.emit({ type: 'delta', chatId, text: 'Stale response' });
    test.native.onDisconnect.emit();
    await settle();
    expect(test.panel.postMessage).not.toHaveBeenCalled();
    expect(replacement.postMessage).not.toHaveBeenCalled();
    await test.begin();
    expect(replacement.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'send', chatId }));
  });
  it('does not let an old pending discovery reopen or reset a resumed chat', async () => {
    const test = await setup();
    const replacement = port({});
    test.runtime.connectNative.mockReturnValue(replacement);
    let finishDiscovery = () => {};
    test.mock.tabs.sendMessage.mockImplementationOnce(() => new Promise(resolve => {
      finishDiscovery = () => resolve({ type: 'webmcp/snapshot', available: true, tools: [pageTool()] });
    }));
    test.panel.onMessage.emit({ type: 'open_chat', chatId });
    await settle();
    test.panel.onDisconnect.emit();
    test.mock.alarms.onAlarm.emit({ name: 'host-idle' });
    await settle();
    const reopened = port({ id: test.runtime.id, url: test.runtime.getURL('sidepanel.html') }, 'panel:1');
    test.runtime.onConnect.emit(reopened);
    await settle();
    replacement.onMessage.emit({ type: 'ready', protocolVersion: 1, hostVersion: '0.1.0', sdkVersion: '1.0.28', signedIn: true });
    await settle();
    replacement.onMessage.emit({ type: 'chat_opened', chatId, title: 'Resumed SDK chat' });
    replacement.onMessage.emit({ type: 'history', chatId, items: [], done: true });
    await settle();
    reopened.postMessage.mockClear();
    replacement.postMessage.mockClear();
    finishDiscovery();
    await settle();
    expect(reopened.postMessage).not.toHaveBeenCalled();
    expect(replacement.postMessage).not.toHaveBeenCalled();
    reopened.onMessage.emit({ type: 'send', text: 'After delayed discovery' });
    await settle();
    expect(replacement.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'send', chatId, text: 'After delayed discovery',
    }));
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
  it('waits for the new document tools before completing a navigated call and ignores its late old result', async () => {
    const test = await setup();
    await test.begin();
    let finishOldExecution = () => {};
    const checkout = pageTool({ key: '0:checkout', name: 'checkout' });
    let loading = true;
    test.mock.tabs.sendMessage.mockImplementation(async (_tabId, message) => {
      if (message.type === 'webmcp/list') return { type: 'webmcp/snapshot', available: !loading, tools: loading ? [] : [checkout] };
      return new Promise<{ type: string; callId: string; ok: boolean; result: string }>(resolve => {
        finishOldExecution = () => resolve({ type: 'webmcp/result', callId: 'call', ok: true, result: 'Late old-document result' });
      });
    });
    test.call();
    await settle();
    test.mock.tabs.get.mockImplementation(async tabId => ({
      id: tabId, windowId: 1, title: 'Checkout', url: 'https://pizza.example/new-page',
      status: loading ? 'loading' : 'complete',
    }));
    test.mock.webNavigation.getAllFrames.mockResolvedValue([
      { frameId: 0, url: 'https://pizza.example/new-page', documentId: 'new-document' },
    ]);
    test.native.postMessage.mockClear();
    test.panel.postMessage.mockClear();
    test.mock.webNavigation.onCommitted.emit({
      tabId: 7, frameId: 0, url: 'https://pizza.example/new-page', documentId: 'new-document',
    });
    await settle();
    expect(test.native.postMessage.mock.calls.some(([message]) => message.type === 'tool_result')).toBe(false);
    loading = false;
    test.mock.tabs.onUpdated.emit(7, { status: 'complete' });
    await settle();
    const sent = test.native.postMessage.mock.calls.map(([message]) => message);
    const updateIndex = sent.findIndex(message => message.type === 'set_tools' && message.page.documentId === 'new-document' &&
      message.tools.some((tool: { name: string }) => tool.name === 'checkout'));
    const failureIndex = sent.findIndex(message => message.type === 'tool_result' && !message.ok);
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(failureIndex).toBeGreaterThan(updateIndex);
    finishOldExecution();
    await settle();
    expect(test.native.postMessage.mock.calls.filter(([message]) => message.type === 'tool_result')).toHaveLength(1);
    expect(test.panel.postMessage.mock.calls.some(([message]) => message.type === 'notice')).toBe(false);
  });
  it('refreshes newly registered checkout tools before returning a tool result to the SDK', async () => {
    const test = await setup();
    await test.begin();
    const checkout = pageTool({ key: '0:checkout', name: 'checkout' });
    let tools = [pageTool()];
    test.mock.tabs.sendMessage.mockImplementation(async (_tabId, message) => {
      if (message.type === 'webmcp/list') return { type: 'webmcp/snapshot', available: true, tools };
      tools = [pageTool(), checkout];
      return { type: 'webmcp/result', callId: 'call', ok: true, result: 'Cart created' };
    });
    test.native.postMessage.mockClear();
    test.call();
    await settle();
    const sent = test.native.postMessage.mock.calls.map(([message]) => message);
    const updateIndex = sent.findIndex(message => message.type === 'set_tools' && message.tools.some((tool: { name: string }) => tool.name === 'checkout'));
    const resultIndex = sent.findIndex(message => message.type === 'tool_result');
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(updateIndex);
    expect(sent[resultIndex]).toMatchObject({ ok: true, result: 'Cart created' });
  });
  it.each(['onHistoryStateUpdated', 'onReferenceFragmentUpdated'] as const)('refreshes tools on %s and discards older in-flight snapshots', async event => {
    const test = await setup();
    await test.begin();
    let finishOldDiscovery = () => {};
    const checkout = pageTool({ key: '0:checkout', name: 'checkout' });
    let discoveries = 0;
    test.mock.tabs.sendMessage.mockImplementation(async () => {
      if (++discoveries === 1) return new Promise<{ type: string; available: boolean; tools: ReturnType<typeof pageTool>[] }>(resolve => {
        finishOldDiscovery = () => resolve({ type: 'webmcp/snapshot', available: true, tools: [pageTool()] });
      });
      return { type: 'webmcp/snapshot', available: true, tools: [checkout] };
    });
    test.native.postMessage.mockClear();
    test.runtime.onMessage.emit({ type: 'webmcp/snapshot', available: true, tools: [] },
      { id: test.runtime.id, tab: { id: 7 }, frameId: 0, documentId: 'doc-7' });
    await settle();
    test.mock.tabs.get.mockResolvedValue({
      id: 7, windowId: 1, title: 'Checkout', url: 'https://pizza.example/menu?checkout',
    });
    test.mock.webNavigation[event].emit({ tabId: 7, frameId: 0, url: 'https://pizza.example/menu?checkout' });
    await settle();
    finishOldDiscovery();
    await settle();
    const updates = test.native.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'set_tools');
    expect(updates).toHaveLength(1);
    expect(updates[0].tools.map((tool: { name: string }) => tool.name)).toEqual(['checkout']);
    expect(updates[0].page.url).toBe('https://pizza.example/menu?checkout');
    expect(test.mock.tabs.sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'webmcp/list' }), { documentId: 'doc-7' });
  });
  it('does not send a pending navigation result after Stop cancels the bound call', async () => {
    const test = await setup();
    await test.begin();
    test.mock.tabs.get.mockImplementation(async tabId => ({
      id: tabId, windowId: 1, title: 'Loading', url: 'https://pizza.example/menu', status: 'loading',
    }));
    test.call();
    await settle();
    test.native.postMessage.mockClear();
    test.panel.onMessage.emit({ type: 'stop' });
    await settle();
    test.mock.tabs.onUpdated.emit(7, { status: 'complete' });
    await settle();
    expect(test.native.postMessage).toHaveBeenCalledWith({ type: 'stop', chatId });
    expect(test.native.postMessage.mock.calls.some(([message]) => message.type === 'tool_result')).toBe(false);
  });
  it('surfaces a page-load timeout explicitly instead of leaving the SDK call pending forever', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const test = await setup();
    await test.begin();
    test.mock.tabs.get.mockImplementation(async tabId => ({
      id: tabId, windowId: 1, title: 'Loading', url: 'https://pizza.example/menu', status: 'loading',
    }));
    test.native.postMessage.mockClear();
    vi.useFakeTimers();
    test.call();
    await vi.advanceTimersByTimeAsync(29999);
    expect(test.native.postMessage.mock.calls.some(([message]) => message.type === 'tool_result')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(test.native.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool_result', callId: 'call', ok: false,
      error: expect.objectContaining({ name: 'ToolRefreshError', message: expect.stringContaining('did not finish loading') }),
    }));
    expect(consoleError).toHaveBeenCalledWith('WebMCP Agent request failed', expect.any(Error));
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
    expect(test.native.postMessage).not.toHaveBeenCalledWith({ type: 'list_chats' });
    test.native.onMessage.emit({ type: 'history', chatId: newChatId, items: [], done: true });
    await settle();
    expect(test.native.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'list_chats' });
    const response = {
      type: 'chats', chats: [{ chatId: newChatId, title: 'SDK title', updatedAt: '2026-11-02T19:00:00Z' }],
    };
    test.native.onMessage.emit(response);
    await settle();
    expect(test.panel.postMessage).toHaveBeenCalledWith(response);
    test.native.onMessage.emit({ type: 'history', chatId: newChatId, items: [], done: true });
    await settle();
    expect(test.native.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'list_chats' });
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

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentResponseSchema, type ContentRequest } from '../extension/src/messages.js';

async function setup() {
  vi.resetModules();
  const owningWindow = {};
  const tool = (name: string, inputSchema: unknown = null) => ({ name, description: name, inputSchema, origin: 'https://pizza.example', window: owningWindow });
  let tools = [tool('create_order')];
  const context = Object.assign(new EventTarget(), {
    getTools: vi.fn(async () => tools),
    executeTool: vi.fn(async () => 'Synthetic result'),
  });
  const listeners: ((message: unknown, sender: { id: string }, respond: (response: unknown) => void) => unknown)[] = [];
  const runtime = {
    id: 'test-extension',
    sendMessage: vi.fn(async () => {}),
    onMessage: { addListener: (listener: typeof listeners[number]) => listeners.push(listener) },
  };
  vi.stubGlobal('window', owningWindow);
  vi.stubGlobal('document', { modelContext: context });
  vi.stubGlobal('chrome', { runtime });
  await import('../extension/src/content/index.js');
  await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalled());
  const request = async (message: ContentRequest) => contentResponseSchema.parse(await new Promise(resolve => {
    const listener = listeners[0];
    if (!listener) throw new Error('Content request listener is missing.');
    listener(message, { id: runtime.id }, resolve);
  }));
  return { context, request, tool, setTools: (next: typeof tools) => { tools = next; } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('content tool discovery', () => {
  it('keeps tools without input schemas discoverable and executable alongside tools with schemas', async () => {
    const test = await setup();
    const inputSchema = { type: 'object', properties: { query: { type: 'string' } } };
    test.setTools([
      test.tool('no_schema'),
      test.tool('object_schema', inputSchema),
      test.tool('serialized_schema', JSON.stringify(inputSchema)),
    ]);
    const response = await test.request({ type: 'webmcp/list', fromOrigins: [] });
    expect(response).toMatchObject({
      type: 'webmcp/snapshot', available: true,
      tools: [
        expect.objectContaining({ name: 'no_schema' }),
        expect.objectContaining({ name: 'object_schema', inputSchema }),
        expect.objectContaining({ name: 'serialized_schema', inputSchema }),
      ],
    });
    if (response.type !== 'webmcp/snapshot') throw new Error('Expected a tool snapshot.');
    expect(response).not.toHaveProperty('error');
    expect(response.tools[0]).not.toHaveProperty('inputSchema');
    expect(await test.request({ type: 'webmcp/execute', callId: 'no-schema', key: '0:no_schema', args: {} }))
      .toMatchObject({ type: 'webmcp/result', ok: true, result: 'Synthetic result' });
    expect(test.context.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'no_schema', inputSchema: null }), {}, { signal: expect.any(AbortSignal) },
    );
  });
  it('lets next-step tool registrations run before returning the completed page tool', async () => {
    const test = await setup();
    test.context.executeTool.mockImplementationOnce(async () => {
      setTimeout(() => test.setTools([test.tool('checkout')]), 0);
      return 'Cart created';
    });
    expect(await test.request({ type: 'webmcp/execute', callId: 'create', key: '0:create_order', args: {} }))
      .toMatchObject({ type: 'webmcp/result', ok: true, result: 'Cart created' });
    expect(await test.request({ type: 'webmcp/list', fromOrigins: [] }))
      .toMatchObject({ tools: [expect.objectContaining({ name: 'checkout' })] });
  });
  it.each(['outdated result', 'outdated error'])('does not let an %s replace or clear the latest tool snapshot', async outcome => {
    const test = await setup();
    let finishOldDiscovery = () => {};
    test.context.getTools.mockImplementationOnce(() => new Promise((resolve, reject) => {
      finishOldDiscovery = () => outcome === 'outdated result'
        ? resolve([test.tool('create_order')]) : reject(new Error('Outdated discovery failed'));
    }));
    test.context.getTools.mockResolvedValueOnce([test.tool('checkout')]);
    const older = test.request({ type: 'webmcp/list', fromOrigins: [] });
    const newer = await test.request({ type: 'webmcp/list', fromOrigins: [] });
    finishOldDiscovery();
    expect(await older).toEqual(newer);
    expect(await test.request({ type: 'webmcp/execute', callId: 'checkout', key: '0:checkout', args: {} }))
      .toMatchObject({ ok: true, result: 'Synthetic result' });
  });
});

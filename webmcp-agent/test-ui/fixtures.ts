// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
import { test as base, expect, type Page } from '@playwright/test';
import { z } from 'zod';
import { toExtensionSchema, type HistoryItem, type PageTool } from '../shared/src/protocol.js';
import {
  defaultSettings, extensionSettingsSchema, pageStateSchema, panelRequestSchema, type PanelRequest,
} from '../extension/src/messages.js';
import { chatId, page as pageContext, pageTool } from '../test/helpers.js';

const panelEventSchema = z.union([
  toExtensionSchema, pageStateSchema,
  z.strictObject({ type: z.literal('settings'), settings: extensionSettingsSchema }),
  z.strictObject({ type: z.literal('connection'), status: z.string(), error: z.string().optional() }),
  z.strictObject({ type: z.literal('notice'), text: z.string() }),
  z.strictObject({ type: z.literal('pause'), paused: z.boolean(), tabId: z.number() }),
  z.strictObject({ type: z.literal('user'), text: z.string() }),
  z.strictObject({ type: z.literal('reset') }),
  z.strictObject({ type: z.literal('chat_loading'), loading: z.boolean() }),
  z.strictObject({ type: z.literal('inspect_result'), key: z.string(), ok: z.boolean(), result: z.string() }),
]);
type PanelEvent = z.infer<typeof panelEventSchema>;

declare global {
  interface Window {
    agentUiTest: {
      connected: boolean;
      requests: unknown[];
      deliver: (messages: PanelEvent[]) => void;
      disconnect: () => void;
      copiedText: string;
      clipboardFailure: boolean;
      frameViolations: string[];
      monitoringFrames: boolean;
    };
  }
}

export const menuTool = pageTool({
  key: '0:view_menu', name: 'view_menu', title: 'View menu',
  description: 'Browse pizzas, sides, and drinks.',
  annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: false, debugging: false },
  inputSchema: { type: 'object', properties: { category: { type: 'string', default: 'pizza' } } },
});
export const tools: PageTool[] = [
  menuTool,
  pageTool({
    key: '0:place_order', name: 'place_order', title: 'Place an order',
    description: 'Submit the current order for delivery or carryout.',
    annotations: { readOnlyHint: false, consequentialHint: true, untrustedContentHint: false, debugging: false },
  }),
  pageTool({
    key: '0:debug_state', name: 'debug_state', description: 'Inspect debugging state.',
    annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: false, debugging: true },
  }),
  pageTool({
    key: '1:find_address', name: 'find_address', title: 'Find a delivery address',
    description: 'Look up matching delivery addresses.', origin: 'https://delivery.example', isTopFrame: false,
    annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: true, debugging: false },
  }),
];
export const question: Extract<PanelEvent, { type: 'question' }> = {
  type: 'question', chatId, requestId: 'question-test', question: 'How would you like to order?',
  choices: ['Start a delivery order', 'Start a carryout order', 'Show me the menu'], allowFreeform: true,
};
export const conversation: HistoryItem[] = [
  { kind: 'user', text: 'Help me place an order.' },
  { kind: 'assistant', text: 'First, choose how you would like to order.' },
];

export class PanelDriver {
  constructor(readonly page: Page) {}

  async emit(...messages: PanelEvent[]) {
    const validated = messages.map(message => panelEventSchema.parse(message));
    await this.page.evaluate(serialized => window.agentUiTest.deliver(JSON.parse(serialized)), JSON.stringify(validated));
  }

  async requests() {
    const requests = await this.page.evaluate(() => window.agentUiTest.requests);
    return requests.map(request => panelRequestSchema.parse(request));
  }

  async expectRequests(requests: PanelRequest[]) {
    await expect.poll(() => this.requests()).toEqual(requests);
  }

  async history(items: HistoryItem[]) {
    await this.emit(
      { type: 'reset' },
      { type: 'chat_opened', chatId, title: 'Pizza menu' },
      { type: 'history', chatId, items, done: true },
      { type: 'chat_loading', loading: false },
      { type: 'status', chatId, state: 'idle' },
    );
    await expect(this.page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
  }

  async startFrameMonitor() {
    await this.page.evaluate(() => {
      window.agentUiTest.monitoringFrames = true;
      window.agentUiTest.frameViolations = [];
      const sample = () => {
        if (!window.agentUiTest.monitoringFrames) return;
        const header = document.querySelector('.app-header')?.getBoundingClientRect();
        const composer = document.querySelector('.composer')?.getBoundingClientRect();
        if (!header || header.top < 0 || header.bottom > innerHeight ||
            !composer || composer.bottom > innerHeight + 1 || composer.top < header.bottom ||
            Math.abs(scrollY) > 1 || document.documentElement.scrollHeight > innerHeight + 1) {
          window.agentUiTest.frameViolations.push('Navigation/composer left the viewport');
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  }

  async expectStableFrames() {
    const violations = await this.page.evaluate(() => new Promise<string[]>(resolve => {
      let frames = 0;
      const sample = () => {
        if (++frames < 12) { requestAnimationFrame(sample); return; }
        window.agentUiTest.monitoringFrames = false;
        resolve(window.agentUiTest.frameViolations);
      };
      requestAnimationFrame(sample);
    }));
    expect(violations).toEqual([]);
  }
}

export const test = base.extend<{ panel: PanelDriver; consoleErrors: string[] }>({
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await use(errors);
    expect(errors, 'Unexpected browser console errors').toEqual([]);
  },
  panel: async ({ page, context, baseURL, consoleErrors }, use, testInfo) => {
    void consoleErrors;
    if (!baseURL) throw new Error('The UI preview base URL is not configured.');
    const previewOrigin = new URL(baseURL).origin;
    const pageErrors: string[] = [];
    const unexpectedRequests: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === previewOrigin) return route.continue();
      unexpectedRequests.push(route.request().url());
      return route.abort('blockedbyclient');
    });
    await page.addInitScript(() => {
      const listeners: ((message: PanelEvent) => void)[] = [];
      const disconnectListeners: (() => void)[] = [];
      window.agentUiTest = {
        connected: false, requests: [], copiedText: '', clipboardFailure: false,
        frameViolations: [], monitoringFrames: false,
        deliver: messages => messages.forEach(message => listeners.forEach(listener => listener(message))),
        disconnect: () => disconnectListeners.forEach(listener => listener()),
      };
      Object.defineProperty(window, 'chrome', { configurable: true, value: {
        windows: { getCurrent: async () => ({ id: 1 }) },
        runtime: {
          id: 'webmcp-agent-ui-test',
          connect: () => ({
            postMessage: (message: unknown) => window.agentUiTest.requests.push(message),
            onMessage: { addListener: (listener: (message: PanelEvent) => void) => {
              listeners.push(listener); window.agentUiTest.connected = true;
            } },
            onDisconnect: { addListener: (listener: () => void) => disconnectListeners.push(listener) },
            disconnect: () => {},
          }),
        },
      } });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (text: string) => {
          if (window.agentUiTest.clipboardFailure) throw new Error('Synthetic clipboard failure');
          window.agentUiTest.copiedText = text;
        },
      } });
    });
    await page.goto('/sidepanel.html');
    await expect.poll(() => page.evaluate(() => window.agentUiTest?.connected)).toBe(true);
    const panel = new PanelDriver(page);
    await panel.emit(
      { type: 'connection', status: 'Connected' },
      { type: 'settings', settings: defaultSettings },
      { type: 'ready', protocolVersion: 1, hostVersion: 'test', sdkVersion: 'test', signedIn: true },
      { type: 'page', page: pageContext, tools, available: true },
      { type: 'models', models: [
        { id: 'auto', name: 'Auto' }, { id: 'gpt-test', name: 'GPT Test' },
        ...Array.from({ length: 30 }, (_, index) => ({ id: `model-${index}`, name: `Synthetic model ${index}` })),
      ] },
    );
    await panel.history([]);
    await use(panel);
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('panel-requests', { body: JSON.stringify(await panel.requests(), null, 2), contentType: 'application/json' });
    }
    expect(pageErrors, 'Uncaught browser errors').toEqual([]);
    expect(unexpectedRequests, 'UI tests must not use external services').toEqual([]);
  },
});
export { expect, chatId, defaultSettings, pageContext };

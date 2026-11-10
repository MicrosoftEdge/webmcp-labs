// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { z } from 'zod';
import { hostSettingsSchema, pageContextSchema, pageToolSchema } from '@webmcp-agent/shared/protocol';

export const extensionSettingsSchema = hostSettingsSchema.extend({
  model: z.string().default(''),
  includeDebug: z.boolean().default(false),
  showReasoning: z.boolean().default(true),
});
export type ExtensionSettings = z.infer<typeof extensionSettingsSchema>;
export const defaultSettings: ExtensionSettings = {
  model: '', includeDebug: false, showReasoning: true, maxToolResultChars: 16000, verboseLogs: false,
};
const callId = z.string().min(1).max(256);
const failure = z.strictObject({ name: z.string(), message: z.string() });
export const contentRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('webmcp/list'), fromOrigins: z.array(z.string()) }),
  z.strictObject({ type: z.literal('webmcp/execute'), callId, key: z.string(), args: z.record(z.string(), z.json()) }),
  z.strictObject({ type: z.literal('webmcp/cancel'), callId }),
]);
export const contentResponseSchema = z.union([
  z.strictObject({ type: z.literal('webmcp/snapshot'), available: z.boolean(), tools: z.array(pageToolSchema), error: z.string().optional() }),
  z.strictObject({ type: z.literal('webmcp/result'), callId, ok: z.literal(true), result: z.string().nullable() }),
  z.strictObject({ type: z.literal('webmcp/result'), callId, ok: z.literal(false), error: failure }),
  z.strictObject({ type: z.literal('webmcp/log'), text: z.string() }),
]);
export const panelRequestSchema = z.union([
  z.strictObject({ type: z.literal('send'), text: z.string().min(1) }),
  z.strictObject({ type: z.literal('new_chat') }),
  z.strictObject({ type: z.literal('open_chat'), chatId: z.string() }),
  z.strictObject({ type: z.literal('stop') }),
  z.strictObject({ type: z.literal('continue') }),
  z.strictObject({ type: z.literal('answer'), requestId: callId, answer: z.string(), wasFreeform: z.boolean() }),
  z.strictObject({ type: z.literal('set_model'), model: z.string() }),
  z.strictObject({ type: z.literal('settings'), settings: extensionSettingsSchema }),
  z.strictObject({ type: z.literal('inspect_run'), key: z.string(), args: z.record(z.string(), z.json()) }),
  z.strictObject({ type: z.literal('list_chats') }),
  z.strictObject({ type: z.literal('delete_chat'), chatId: z.string() }),
  z.strictObject({ type: z.literal('clear_chats') }),
  z.strictObject({ type: z.literal('reconnect') }),
  z.strictObject({ type: z.literal('logs'), follow: z.boolean() }),
]);
export const pageStateSchema = z.strictObject({
  type: z.literal('page'), page: pageContextSchema, tools: z.array(pageToolSchema),
  available: z.boolean(), error: z.string().optional(),
});
export type ContentRequest = z.infer<typeof contentRequestSchema>;
export type ContentResponse = z.infer<typeof contentResponseSchema>;
export type PanelRequest = z.infer<typeof panelRequestSchema>;
export type PageState = z.infer<typeof pageStateSchema>;

export function trustedFrameOrigins(frames: { url: string }[], topOrigin: string): string[] {
  const origins = new Set<string>();
  for (const frame of frames) {
    try {
      const url = new URL(frame.url);
      if (url.protocol === 'https:' || (url.protocol === 'http:' &&
          (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '127.0.0.1' || url.hostname === '[::1]'))) {
        if (url.origin !== topOrigin) origins.add(url.origin);
      }
    } catch { /* Non-URL browser documents cannot expose page tools. */ }
  }
  return [...origins].sort();
}

export class TabBinding {
  boundTabId: number | undefined;
  running = false;
  paused = false;
  begin(tabId: number): void { this.boundTabId = tabId; this.running = true; this.paused = false; }
  activate(tabId: number): void { this.paused = this.running && this.boundTabId !== tabId; }
  continue(): void { this.paused = false; }
  stop(): void { this.running = false; this.paused = false; }
}

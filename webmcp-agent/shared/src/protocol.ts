// Copyright (c) Microsoft Corporation. Licensed under the MIT License.

import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const CHAT_ID_PREFIX = 'webmcp-agent-';
export const MAX_INBOUND_BYTES = 8 * 1024 * 1024;
export const MAX_OUTBOUND_BYTES = 1024 * 1024;

const identifier = z.string().min(1).max(256);
const chatId = z.string().regex(/^webmcp-agent-[a-zA-Z0-9-]{1,128}$/);
const origin = z.string().refine(value => {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
}, 'Expected a canonical HTTP(S) origin');
const jsonObject = z.record(z.string(), z.json());
const sdkName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export function pageOrigin(url: string): string {
  const parsed = new URL(url);
  // Chromium recognizes browser/extension origins that Node's URL class treats
  // as opaque. Only HTTP(S) pages can supply tools over this protocol.
  return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : 'null';
}

export const pageContextSchema = z.strictObject({
  tabId: z.number().int().nonnegative(),
  url: z.url(),
  title: z.string(),
  origin: z.union([origin, z.literal('null')]),
  documentId: identifier.optional(),
}).refine(page => {
  try {
    return pageOrigin(page.url) === page.origin;
  } catch {
    return false;
  }
}, 'Page URL and origin must agree');

export const toolAnnotationsSchema = z.strictObject({
  readOnlyHint: z.boolean(),
  untrustedContentHint: z.boolean(),
  consequentialHint: z.boolean(),
  debugging: z.boolean(),
});

export const pageToolSchema = z.strictObject({
  key: z.string().regex(/^(0|[1-9]\d*):[A-Za-z0-9_.-]{1,128}$/),
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  title: z.string().optional(),
  description: z.string(),
  inputSchema: jsonObject.optional(),
  origin,
  isTopFrame: z.boolean(),
  annotations: toolAnnotationsSchema,
}).superRefine((tool, context) => {
  const [frameNumber, name] = tool.key.split(':');
  if (name !== tool.name || (frameNumber === '0') !== tool.isTopFrame ||
      !Number.isSafeInteger(Number(frameNumber))) {
    context.addIssue({ code: 'custom', message: 'Tool key must match its name and frame' });
  }
});

const tools = z.array(pageToolSchema).superRefine((entries, context) => {
  const keys = new Set<string>();
  for (const tool of entries) {
    if (keys.has(tool.key)) context.addIssue({ code: 'custom', message: 'Duplicate tool key' });
    keys.add(tool.key);
  }
});

export const hostSettingsSchema = z.strictObject({
  maxToolResultChars: z.number().int().min(1).max(256_000),
  verboseLogs: z.boolean(),
});
export const toolDisplaySchema = z.strictObject({
  name: pageToolSchema.shape.name, title: pageToolSchema.shape.title,
  origin, isTopFrame: z.boolean(), annotations: toolAnnotationsSchema,
});

export const historyItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user'), text: z.string() }),
  z.strictObject({ kind: z.literal('assistant'), text: z.string() }),
  z.strictObject({ kind: z.literal('tool'), sdkName, args: z.json(), ok: z.boolean().optional(), result: z.string().optional(), callId: identifier.optional(), tool: toolDisplaySchema.optional() }),
]);

export const errorCodeSchema = z.enum([
  'not_signed_in', 'model_unavailable', 'chat_not_found',
  'tool_unavailable', 'sdk_error', 'protocol_error',
]);

const error = z.strictObject({ name: identifier, message: z.string() });
export const toHostSchema = z.union([
  z.strictObject({ type: z.literal('hello'), protocolVersion: z.literal(PROTOCOL_VERSION), extensionVersion: identifier }),
  z.strictObject({ type: z.literal('list_models') }),
  z.strictObject({ type: z.literal('list_chats') }),
  z.strictObject({ type: z.literal('open_chat'), chatId: chatId.optional(), model: identifier.optional(), page: pageContextSchema, tools }),
  z.strictObject({ type: z.literal('send'), chatId, text: z.string().min(1), page: pageContextSchema, tools, pageChanged: z.boolean() }),
  z.strictObject({ type: z.literal('set_tools'), chatId, page: pageContextSchema, tools }),
  z.strictObject({ type: z.literal('tool_result'), chatId, callId: identifier, ok: z.literal(true), result: z.string().nullable() }),
  z.strictObject({ type: z.literal('tool_result'), chatId, callId: identifier, ok: z.literal(false), error }),
  z.strictObject({ type: z.literal('answer'), chatId, requestId: identifier, answer: z.string(), wasFreeform: z.boolean() }),
  z.strictObject({ type: z.literal('set_model'), chatId, model: identifier }),
  z.strictObject({ type: z.literal('stop'), chatId }),
  z.strictObject({ type: z.literal('close_chat'), chatId }),
  z.strictObject({ type: z.literal('delete_chat'), chatId }),
  z.strictObject({ type: z.literal('clear_chats') }),
  z.strictObject({ type: z.literal('set_settings'), settings: hostSettingsSchema }),
  z.strictObject({ type: z.literal('logs'), follow: z.boolean() }),
]);

export const toExtensionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready'), protocolVersion: z.literal(PROTOCOL_VERSION), hostVersion: identifier, sdkVersion: identifier, signedIn: z.boolean(), account: z.string().optional(), dataPath: z.string().optional() }),
  z.strictObject({ type: z.literal('models'), models: z.array(z.strictObject({ id: identifier, name: z.string(), multiplier: z.number().finite().nonnegative().optional() })) }),
  z.strictObject({ type: z.literal('chats'), chats: z.array(z.strictObject({ chatId, title: z.string(), updatedAt: z.iso.datetime() })), cleared: z.boolean().optional() }),
  z.strictObject({ type: z.literal('chat_opened'), chatId, title: z.string(), model: identifier.optional() }),
  z.strictObject({ type: z.literal('history'), chatId, items: z.array(historyItemSchema), done: z.boolean() }),
  z.strictObject({ type: z.literal('history_fragment'), chatId, fragment: z.string(), complete: z.boolean() }),
  z.strictObject({ type: z.literal('delta'), chatId, text: z.string() }),
  z.strictObject({ type: z.literal('reasoning'), chatId, text: z.string() }),
  z.strictObject({ type: z.literal('message'), chatId, text: z.string() }),
  z.strictObject({ type: z.literal('tool_call'), chatId, callId: identifier, sdkName, key: pageToolSchema.shape.key, args: z.json(), tabId: z.number().int().nonnegative().optional(), origin: origin.optional(), documentId: identifier.optional(), tool: pageToolSchema.optional(), executionState: z.enum(['queued', 'running']).optional() }),
  z.strictObject({ type: z.literal('tool_done'), chatId, callId: identifier, ok: z.boolean(), result: z.string() }),
  z.strictObject({ type: z.literal('question'), chatId, requestId: identifier, question: z.string(), choices: z.array(z.string()).optional(), allowFreeform: z.boolean() }),
  z.strictObject({ type: z.literal('status'), chatId, state: z.enum(['running', 'idle']) }),
  z.strictObject({ type: z.literal('title'), chatId, title: z.string() }),
  z.strictObject({ type: z.literal('error'), chatId: chatId.optional(), code: errorCodeSchema, message: z.string() }),
  z.strictObject({ type: z.literal('log'), time: z.iso.datetime(), level: z.enum(['debug', 'info', 'warn', 'error']), text: z.string() }),
]);

export type PageContext = z.infer<typeof pageContextSchema>;
export type ToolAnnotations = z.infer<typeof toolAnnotationsSchema>;
export type PageTool = z.infer<typeof pageToolSchema>;
export type ToolDisplay = z.infer<typeof toolDisplaySchema>;
export type HostSettings = z.infer<typeof hostSettingsSchema>;
export type HistoryItem = z.infer<typeof historyItemSchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ToHost = z.infer<typeof toHostSchema>;
export type ToExtension = z.infer<typeof toExtensionSchema>;

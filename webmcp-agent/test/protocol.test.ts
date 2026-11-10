// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from 'vitest';
import { validateToExtension, validateToHost } from '../shared/src/validate.js';
import {
  toExtensionSchema, toHostSchema, pageOrigin, type ToExtension, type ToHost,
} from '../shared/src/protocol.js';
import { chatId, page, pageTool } from './helpers.js';

const toHost = [
  { type: 'hello', protocolVersion: 1, extensionVersion: '0.1.0' },
  { type: 'list_models' },
  { type: 'list_chats' },
  { type: 'open_chat', page, tools: [pageTool()] },
  { type: 'send', chatId, text: 'Find lunch', page, tools: [], pageChanged: true },
  { type: 'set_tools', chatId, page, tools: [] },
  { type: 'tool_result', chatId, callId: 'call-1', ok: true, result: null },
  { type: 'tool_result', chatId, callId: 'call-2', ok: false, error: { name: 'AbortError', message: 'Stopped' } },
  { type: 'answer', chatId, requestId: 'question-1', answer: 'Yes', wasFreeform: false },
  { type: 'set_model', chatId, model: 'test-model' },
  { type: 'stop', chatId },
  { type: 'close_chat', chatId },
  { type: 'delete_chat', chatId },
  { type: 'clear_chats' },
  { type: 'set_settings', settings: { maxToolResultChars: 16000, verboseLogs: false } },
  { type: 'logs', follow: true },
] satisfies ToHost[];

const toExtension = [
  { type: 'ready', protocolVersion: 1, hostVersion: '0.1.0', sdkVersion: '1.0.28', signedIn: false },
  { type: 'models', models: [{ id: 'test-model', name: 'Test model', multiplier: 1 }] },
  { type: 'chats', chats: [{ chatId, title: 'Lunch', updatedAt: '2026-10-30T12:00:00Z' }] },
  { type: 'chat_opened', chatId, title: 'Lunch' },
  { type: 'history', chatId, items: [
    { kind: 'user', text: 'Hello' },
    { kind: 'assistant', text: 'Hi' },
    { kind: 'tool', sdkName: 'search', args: {}, ok: true },
    { kind: 'abort', eventId: 'sdk-abort-event', reason: 'user_initiated' },
  ], done: true },
  { type: 'history_fragment', chatId, fragment: '{"kind":"user","text":"Hello"}', complete: true },
  { type: 'user', chatId, text: 'Hello', messageId: 'user-message' },
  { type: 'delta', chatId, text: 'Hello', messageId: 'assistant-message' },
  { type: 'reasoning', chatId, text: 'Thinking', reasoningId: 'reasoning-block', complete: true },
  { type: 'message', chatId, text: 'Done', messageId: 'assistant-message' },
  { type: 'model_used', chatId, model: { id: 'gpt-test', name: 'GPT Test', isAuto: true } },
  { type: 'tool_call', chatId, callId: 'call-1', sdkName: 'pizza_search', key: '0:search', args: {} },
  { type: 'tool_done', chatId, callId: 'call-1', ok: true, result: 'Raw page result' },
  { type: 'question', chatId, requestId: 'question-1', question: 'Continue?', choices: ['Yes'], allowFreeform: true },
  { type: 'status', chatId, state: 'running' },
  { type: 'abort', chatId, eventId: 'sdk-abort-event', reason: 'user_initiated' },
  { type: 'title', chatId, title: 'New title' },
  { type: 'error', code: 'protocol_error', message: 'Bad message' },
  { type: 'log', time: '2026-10-30T12:00:00Z', level: 'warn', text: 'Metadata only' },
] satisfies ToExtension[];

describe('protocol schemas', () => {
  it('covers every wire message type in both directions', () => {
    const hostTypes = toHostSchema.options.map(schema => schema.shape.type.value);
    const extensionTypes = toExtensionSchema.options.map(schema => schema.shape.type.value);
    expect(new Set(toHost.map(message => message.type))).toEqual(new Set(hostTypes));
    expect(new Set(toExtension.map(message => message.type))).toEqual(new Set(extensionTypes));
  });

  for (const message of toHost) {
    it(`validates to-host ${message.type}${'ok' in message ? `:${message.ok}` : ''}`, () => {
      expect(validateToHost(JSON.parse(JSON.stringify(message))).success).toBe(true);
      expect(validateToHost({ ...message, unexpected: true }).success).toBe(false);
    });
  }
  for (const message of toExtension) {
    it(`validates to-extension ${message.type}`, () => {
      expect(validateToExtension(JSON.parse(JSON.stringify(message))).success).toBe(true);
      expect(validateToExtension({ ...message, unexpected: true }).success).toBe(false);
    });
  }

  it.each([null, [], 1, 'hello', {}, { type: 'unknown' }])('rejects malformed envelopes: %j', value => {
    expect(validateToHost(value).success).toBe(false);
    expect(validateToExtension(value).success).toBe(false);
  });

  it('rejects every message with a required field removed or incorrectly typed', () => {
    for (const [messages, schema] of [[toHost, toHostSchema], [toExtension, toExtensionSchema]] as const) {
      for (const message of messages) {
        const option = schema.options.find(candidate => candidate.safeParse(message).success);
        expect(option).toBeDefined();
        if (!option) throw new Error('Missing schema');
        for (const [key, field] of Object.entries(option.shape)) {
          if (field.isOptional()) continue;
          const missing: Record<string, unknown> = { ...message };
          delete missing[key];
          expect(schema.safeParse(missing).success, `${message.type}.${key} required`).toBe(false);
          if (!field.safeParse(null).success) {
            expect(schema.safeParse({ ...message, [key]: null }).success, `${message.type}.${key} null`).toBe(false);
          }
        }
      }
    }
  });

  it('rejects protocol mismatches and foreign session identifiers', () => {
    expect(validateToHost({ ...toHost[0], protocolVersion: 2 }).success).toBe(false);
    expect(validateToExtension({ ...toExtension[0], protocolVersion: 2 }).success).toBe(false);
    expect(validateToHost({ type: 'delete_chat', chatId: '../other-session' }).success).toBe(false);
  });

  it.each([
    'edge://extensions/', 'edge://newtab/', 'chrome://extensions/',
    'chrome://newtab/', 'chrome-extension://test-extension/sidepanel.html',
    'about:blank', 'file:///C:/test.html',
  ])('normalizes non-web context origins independently of the URL runtime: %s', url => {
    expect(pageOrigin(url)).toBe('null');
    expect(validateToHost({ type: 'open_chat', page: { ...page, url, origin: pageOrigin(url) }, tools: [] }).success).toBe(true);
    expect(validateToHost({ type: 'open_chat', page: { ...page, url, origin: url.replace(/\/$/, '') }, tools: [] }).success).toBe(false);
  });

  it('validates nested tools, identity consistency, origins, and JSON arguments', () => {
    for (const invalidTool of [
      pageTool({ key: '1:search' }),
      pageTool({ name: 'other' }),
      pageTool({ origin: 'https://pizza.example/path' }),
      pageTool({ origin: 'https://user:password@pizza.example' }),
      pageTool({ key: '999999999999999999999999:search', isTopFrame: false }),
      { ...pageTool(), annotations: {} },
    ]) {
      expect(validateToHost({ type: 'open_chat', page, tools: [invalidTool] }).success).toBe(false);
    }
    expect(validateToHost({ type: 'open_chat', page, tools: [pageTool(), pageTool()] }).success).toBe(false);
    expect(validateToHost({ type: 'open_chat', page: { ...page, tabId: -1 }, tools: [] }).success).toBe(false);
    expect(validateToHost({ type: 'open_chat', page: { ...page, url: 'not a URL' }, tools: [] }).success).toBe(false);
    expect(validateToHost({ type: 'open_chat', page: { ...page, origin: 'null', url: 'file:///test.html' }, tools: [] }).success).toBe(true);
    expect(validateToHost({ type: 'open_chat', page: { ...page, origin: 'https://other.example' }, tools: [] }).success).toBe(false);
    expect(validateToExtension({ type: 'tool_call', chatId, callId: 'call', sdkName: 'search', key: '0:search', args: () => {} }).success).toBe(false);
    expect(validateToHost({ type: 'tool_result', chatId, callId: 'call', ok: false, result: 'Wrong variant' }).success).toBe(false);
  });

  it.each([0, -1, 256001, 1.5, Infinity, NaN])('rejects invalid result limits: %s', maxToolResultChars => {
    expect(validateToHost({ type: 'set_settings', settings: { maxToolResultChars, verboseLogs: false } }).success).toBe(false);
  });
});

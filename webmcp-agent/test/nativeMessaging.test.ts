// Copyright (c) Microsoft Corporation. Licensed under the MIT License.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  chunkHistory, encodeNativeMessage, NativeMessageDecoder, writeNativeMessage,
} from '../host/src/nativeMessaging.js';
import {
  MAX_INBOUND_BYTES, MAX_OUTBOUND_BYTES, type HistoryItem, type ToExtension,
} from '../shared/src/protocol.js';
import { validateToExtension } from '../shared/src/validate.js';
import { chatId } from './helpers.js';

async function decode(chunks: Buffer[]) {
  const invalid: string[] = [];
  const decoder = new NativeMessageDecoder(reason => invalid.push(reason));
  const messages: unknown[] = [];
  Readable.from(chunks).pipe(decoder);
  for await (const message of decoder) messages.push(message);
  return { messages, invalid };
}

function rawFrame(body: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

describe('native messaging', () => {
  it('production host rejects foreign callers without writing non-protocol stdout', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webmcp-agent-caller-test-'));
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('../host/dist/main.js', import.meta.url)), 'chrome-extension://not-our-extension/',
    ], { env: { ...process.env, WEBMCP_AGENT_DATA_DIR: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [];
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', () => {});
    try {
      child.stdin.end();
      expect((await once(child, 'exit'))[0]).toBe(1);
      expect(Buffer.concat(output).length).toBe(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('handles every possible two-chunk split of a UTF-8 frame', async () => {
    const message = { type: 'message', chatId, text: 'Hello \u{1f355} \u4f60\u597d' };
    const frame = encodeNativeMessage(message);
    for (let split = 1; split < frame.length; split++) {
      expect(await decode([frame.subarray(0, split), frame.subarray(split)])).toEqual({ messages: [message], invalid: [] });
    }
    expect(await decode([...frame].map(byte => Buffer.from([byte])))).toEqual({ messages: [message], invalid: [] });
  });

  it('decodes several messages from one input chunk', async () => {
    const messages = [{ type: 'list_chats' }, { type: 'list_models' }, { type: 'clear_chats' }];
    expect((await decode([Buffer.concat(messages.map(message => encodeNativeMessage(message)))])).messages).toEqual(messages);
  });

  it('drops invalid JSON, UTF-8, and non-object messages with explicit diagnostics', async () => {
    const input = [
      rawFrame(Buffer.from('{')),
      rawFrame(Buffer.from([0xff])),
      rawFrame(Buffer.from('null')),
      rawFrame(Buffer.from('[]')),
      rawFrame(Buffer.from('"text"')),
      encodeNativeMessage({ type: 'list_chats' }),
    ];
    const result = await decode([Buffer.concat(input)]);
    expect(result.messages).toEqual([{ type: 'list_chats' }]);
    expect(result.invalid).toHaveLength(5);
    expect(result.invalid.every(reason => !reason.includes('"text"'))).toBe(true);
  });

  it.each([0, MAX_INBOUND_BYTES + 1, 0xffffffff])('rejects invalid declared length %s before allocating a body', async length => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(length);
    await expect(decode([header])).rejects.toThrow('Native message length');
  });

  it('accepts an inbound frame at the 8 MiB boundary', async () => {
    const body = Buffer.from('{"text":"' + 'x'.repeat(MAX_INBOUND_BYTES - 11) + '"}');
    expect(body.length).toBe(MAX_INBOUND_BYTES);
    const result = await decode([rawFrame(body)]);
    expect(result.messages).toHaveLength(1);
  });

  it('rejects an incomplete header or body at end of input', async () => {
    const frame = encodeNativeMessage({ type: 'list_chats' });
    await expect(decode([frame.subarray(0, 3)])).rejects.toThrow('partial frame');
    await expect(decode([frame.subarray(0, -1)])).rejects.toThrow('partial frame');
  });

  it('counts UTF-8 bytes and JSON escaping for the outbound limit', () => {
    const message = { text: '\u{1f355}'.repeat(10) + '\n'.repeat(10) };
    const length = Buffer.byteLength(JSON.stringify(message));
    expect(() => encodeNativeMessage(message, length)).toThrow('smaller');
    expect(encodeNativeMessage(message, length + 1).readUInt32LE()).toBe(length);
    expect(() => encodeNativeMessage({ text: 'x'.repeat(MAX_OUTBOUND_BYTES) })).toThrow(RangeError);
  });

  it.each([0, -1, 1.5, NaN, Infinity, MAX_OUTBOUND_BYTES + 1])('rejects invalid outbound limit %s', limit => {
    expect(() => encodeNativeMessage({ type: 'test' }, limit)).toThrow(RangeError);
  });

  it('writes complete frames and surfaces write failures', async () => {
    const buffers: Buffer[] = [];
    const output = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        setTimeout(() => { buffers.push(chunk); callback(); }, 1);
      },
    });
    const message: ToExtension = { type: 'status', chatId, state: 'idle' };
    await writeNativeMessage(output, message);
    expect((await decode(buffers)).messages).toEqual([message]);
    const broken = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('Closed pipe')); } });
    broken.on('error', () => {});
    await expect(writeNativeMessage(broken, message)).rejects.toThrow('Closed pipe');
  });

  it('chunks history without losing or reordering entries', () => {
    const items: HistoryItem[] = Array.from({ length: 60 }, (_, index) => ({
      kind: index % 2 ? 'assistant' : 'user',
      text: `${index}:` + '\u{1f355}\n"'.repeat(20),
    }));
    const chunks = [...chunkHistory(chatId, items, 700)];
    expect(chunks.length).toBeGreaterThan(1);
    const restored: HistoryItem[] = [];
    for (const [index, chunk] of chunks.entries()) {
      expect(validateToExtension(chunk).success).toBe(true);
      expect(encodeNativeMessage(chunk, 700).length).toBeLessThan(704);
      if (chunk.type !== 'history') throw new Error('Expected history');
      expect(chunk.done).toBe(index === chunks.length - 1);
      restored.push(...chunk.items);
    }
    expect(restored).toEqual(items);
  });

  it('sends an empty history completion and fragments oversized individual items without data loss', () => {
    expect([...chunkHistory(chatId, [])]).toEqual([{ type: 'history', chatId, items: [], done: true }]);
    const item: HistoryItem = { kind: 'tool', sdkName: 'search', args: { text: '\u{1f355}"\n'.repeat(1000) } };
    const chunks = [...chunkHistory(chatId, [item], 300)];
    let restored = '';
    let completions = 0;
    for (const chunk of chunks) {
      expect(validateToExtension(chunk).success).toBe(true);
      expect(encodeNativeMessage(chunk, 300).length).toBeLessThan(304);
      if (chunk.type === 'history_fragment') { restored += chunk.fragment; if (chunk.complete) completions++; }
    }
    expect(JSON.parse(restored)).toEqual(item);
    expect(completions).toBe(1);
    expect(chunks.at(-1)).toMatchObject({ type: 'history', done: true });
  });

  it('keeps test-peer stdout exclusively length-prefixed protocol frames', async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/native-peer.mjs', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    const exited = once(child, 'exit');
    const timeout = setTimeout(() => child.kill(), 10000);
    try {
      child.stdin.end(Buffer.concat([
        encodeNativeMessage({ type: 'hello', protocolVersion: 1, extensionVersion: 'test' }),
        encodeNativeMessage({ type: 'invalid' }),
        encodeNativeMessage({ type: 'list_chats' }),
      ]));
      expect((await exited)[0]).toBe(0);
      const { messages, invalid } = await decode([Buffer.concat(stdout)]);
      expect(invalid).toEqual([]);
      expect(messages).toHaveLength(2);
      expect(messages.every(message => validateToExtension(message).success)).toBe(true);
      expect(Buffer.concat(stderr).toString()).toContain('Invalid protocol message');
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill();
    }
  });
});

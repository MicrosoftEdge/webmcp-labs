// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Transform, type TransformCallback, type Writable } from 'node:stream';
import {
  MAX_INBOUND_BYTES, MAX_OUTBOUND_BYTES, type HistoryItem, type ToExtension,
} from '@webmcp-agent/shared/protocol';

export function encodeNativeMessage(message: object, maximumBytes = MAX_OUTBOUND_BYTES): Buffer {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_OUTBOUND_BYTES) {
    throw new RangeError(`Outbound byte limit must be 1 through ${MAX_OUTBOUND_BYTES}`);
  }
  if (message === null || Array.isArray(message)) {
    throw new TypeError('Native message must be a JSON object');
  }
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length >= maximumBytes) {
    throw new RangeError(`Native message must be smaller than ${maximumBytes} bytes`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export function writeNativeMessage(output: Writable, message: ToExtension): Promise<void> {
  const frame = encodeNativeMessage(message);
  return new Promise((resolve, reject) => {
    output.write(frame, error => error ? reject(error) : resolve());
  });
}

export class NativeMessageDecoder extends Transform {
  private readonly header = Buffer.alloc(4);
  private headerLength = 0;
  private body: Buffer | undefined;
  private bodyLength = 0;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });

  constructor(private readonly onInvalid: (reason: string) => void) {
    super({ readableObjectMode: true });
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (!this.body) {
          const copied = chunk.copy(this.header, this.headerLength, offset, offset + 4 - this.headerLength);
          this.headerLength += copied;
          offset += copied;
          if (this.headerLength < 4) continue;
          const length = this.header.readUInt32LE();
          this.headerLength = 0;
          if (length === 0 || length > MAX_INBOUND_BYTES) {
            throw new RangeError(`Native message length must be 1 through ${MAX_INBOUND_BYTES} bytes`);
          }
          this.body = Buffer.allocUnsafe(length);
        }
        const copied = chunk.copy(this.body, this.bodyLength, offset, offset + this.body.length - this.bodyLength);
        this.bodyLength += copied;
        offset += copied;
        if (this.bodyLength !== this.body.length) continue;
        const completeBody = this.body;
        this.body = undefined;
        this.bodyLength = 0;
        let value: unknown;
        try {
          value = JSON.parse(this.decoder.decode(completeBody));
        } catch {
          this.onInvalid('Native message is not valid UTF-8 JSON');
          continue;
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          this.onInvalid('Native message must be a JSON object');
          continue;
        }
        this.push(value);
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _flush(callback: TransformCallback): void {
    callback(this.headerLength || this.body
      ? new Error('Native messaging input ended in a partial frame')
      : undefined);
  }
}

function historyMessage(chatId: string, items: HistoryItem[], done: boolean): ToExtension {
  return { type: 'history', chatId, items, done };
}

export function* chunkHistory(
  chatId: string,
  items: readonly HistoryItem[],
  maximumBytes = MAX_OUTBOUND_BYTES,
): Generator<ToExtension> {
  let chunk: HistoryItem[] = [];
  for (const item of items) {
    const candidate = historyMessage(chatId, [...chunk, item], false);
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') < maximumBytes) {
      chunk.push(item);
      continue;
    }
    if (chunk.length) yield historyMessage(chatId, chunk, false);
    chunk = [];
    if (Buffer.byteLength(JSON.stringify(historyMessage(chatId, [item], false)), 'utf8') < maximumBytes) {
      chunk = [item];
      continue;
    }
    // Fragment an individual JSON item rather than truncating the saved text.
    const serialized = JSON.stringify(item);
    for (let offset = 0; offset < serialized.length;) {
      let lower = 0;
      let upper = Math.min(100000, serialized.length - offset);
      while (lower < upper) {
        const length = Math.ceil((lower + upper) / 2);
        const fragment: ToExtension = {
          type: 'history_fragment', chatId, fragment: serialized.slice(offset, offset + length),
          complete: offset + length === serialized.length,
        };
        if (Buffer.byteLength(JSON.stringify(fragment), 'utf8') < maximumBytes) lower = length;
        else upper = length - 1;
      }
      if (!lower) throw new RangeError('Native message limit is too small for a history fragment');
      yield { type: 'history_fragment', chatId, fragment: serialized.slice(offset, offset + lower), complete: offset + lower === serialized.length };
      offset += lower;
    }
  }
  const finalMessage = historyMessage(chatId, chunk, true);
  encodeNativeMessage(finalMessage, maximumBytes);
  yield finalMessage;
}

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import type { ToExtension } from '@webmcp-agent/shared/protocol';

type LogMessage = Extract<ToExtension, { type: 'log' }>;
export class HostLog {
  private readonly filename: string;
  private follow: ((message: LogMessage) => void) | undefined;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.filename = join(directory, 'host.log');
  }
  write(level: LogMessage['level'], text: string): void {
    const message: LogMessage = { type: 'log', time: new Date().toISOString(), level, text: text.slice(0, 16000) };
    if (existsSync(this.filename) && statSync(this.filename).size >= 5 * 1024 * 1024) {
      const oldest = this.filename + '.2';
      if (existsSync(oldest)) unlinkSync(oldest);
      if (existsSync(this.filename + '.1')) renameSync(this.filename + '.1', oldest);
      renameSync(this.filename, this.filename + '.1');
    }
    appendFileSync(this.filename, JSON.stringify(message) + '\n');
    process.stderr.write(`[${level}] ${message.text}\n`);
    this.follow?.(message);
  }
  subscribe(callback?: (message: LogMessage) => void): void {
    this.follow = callback;
    if (callback && existsSync(this.filename)) {
      for (const line of readFileSync(this.filename, 'utf8').trim().split('\n').slice(-100)) {
        if (line) callback(JSON.parse(line) as LogMessage);
      }
    }
  }
  redirectConsole(): void {
    for (const method of ['log', 'info', 'debug', 'warn', 'error'] as const) {
      console[method] = (...args: unknown[]) => this.write(method === 'log' ? 'info' : method, format(...args));
    }
  }
}

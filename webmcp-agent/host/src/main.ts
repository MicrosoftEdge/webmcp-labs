// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirectory, logDirectory } from './paths.js';
import { HostLog } from './log.js';
import { NativeMessageDecoder, writeNativeMessage } from './nativeMessaging.js';
import { validateToHost } from '@webmcp-agent/shared/validate';
import type { ToExtension } from '@webmcp-agent/shared/protocol';

const log = new HostLog(logDirectory());
log.redirectConsole();
const { AgentHost, createIsolatedClient, SDK_VERSION } = await import('./copilot.js');
const manifest: { key: string } = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));
const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, character => String.fromCharCode(97 + parseInt(character, 16)));
if (process.argv[2] !== `chrome-extension://${extensionId}/`) {
  log.write('error', 'Rejected native host caller');
  process.exit(1);
}
const dataPath = dataDirectory();
const home = join(dataPath, 'copilot-home');
const workspace = join(dataPath, 'workspace');
mkdirSync(home, { recursive: true });
mkdirSync(workspace, { recursive: true });
const client = createIsolatedClient(home, workspace);
let writes = Promise.resolve();
let fatal = false;
function emit(message: ToExtension): void {
  const maximum = 100000;
  if ('text' in message && message.text.length > maximum &&
      ['user', 'delta', 'reasoning', 'message'].includes(message.type)) {
    // Final text can be reconstructed from SDK history; do not emit oversized frames.
    if (message.type === 'user' || message.type === 'message' || (message.type === 'reasoning' && message.complete)) {
      const notice = message.type === 'reasoning'
        ? '\n[Display truncated]'
        : '\n[Display truncated; full message is saved in this chat.]';
      emit({ ...message, text: message.text.slice(0, maximum) + notice });
    } else for (let offset = 0; offset < message.text.length; offset += maximum) emit({ ...message, text: message.text.slice(offset, offset + maximum) });
    return;
  }
  if (message.type === 'tool_done' && message.result.length > maximum) {
    message = { ...message, result: message.result.slice(0, maximum) + '\n[Display truncated]' };
  }
  const outgoing = message;
  writes = writes.then(() => writeNativeMessage(process.stdout, outgoing));
  void writes.catch(error => {
    if (fatal) return;
    fatal = true;
    log.write('error', `Native output failed: ${error instanceof Error ? error.message : String(error)}`);
    process.stdin.destroy();
    process.exitCode = 1;
  });
}
const host = new AgentHost(client, emit, (level, text) => log.write(level, text));
const decoder = new NativeMessageDecoder(reason => log.write('warn', reason));
const failProcess = (error: unknown) => {
  if (fatal) return;
  fatal = true;
  log.write('error', `Unhandled host failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  emit({ type: 'error', code: 'sdk_error', message: 'The host encountered an unexpected error. Reconnect to resume your saved chat.' });
  process.exitCode = 1;
  decoder.destroy(error instanceof Error ? error : new Error(String(error)));
};
process.on('uncaughtException', failProcess);
process.on('unhandledRejection', failProcess);
const operations = new Set<Promise<void>>();
let started = false;
const start = async () => {
  if (started) return;
  await client.start();
  started = true;
};
async function dispatch(value: unknown): Promise<void> {
  const parsed = validateToHost(value);
  if (!parsed.success) {
    log.write('warn', 'Dropped invalid native protocol message');
    if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'hello') {
      emit({ type: 'error', code: 'protocol_error', message: 'Protocol mismatch. Rerun npm run setup.' });
    }
    return;
  }
  const message = parsed.data;
  if (message.type === 'hello') {
    await start();
    const auth = await client.getAuthStatus();
    emit({ type: 'ready', protocolVersion: 1, hostVersion: '0.1.0', sdkVersion: SDK_VERSION, signedIn: auth.isAuthenticated, dataPath });
    return;
  }
  if (!started) throw new Error('Send hello before other messages.');
  if (message.type === 'logs') {
    log.subscribe(message.follow ? emit : undefined);
  } else {
    await host.handle(message);
  }
}
process.stdin.pipe(decoder);
try {
  for await (const value of decoder) {
    const operation = dispatch(value).catch(error => {
      log.write('error', `Host request failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      emit({
        type: 'error',
        ...(typeof value === 'object' && value !== null && 'chatId' in value && typeof value.chatId === 'string' ? { chatId: value.chatId } : {}),
        code: 'sdk_error', message: error instanceof Error ? error.message : String(error),
      });
    });
    operations.add(operation);
    void operation.finally(() => operations.delete(operation));
  }
  await Promise.all(operations);
} catch (error) {
  log.write('error', `Host input failed: ${error instanceof Error ? error.message : String(error)}`);
  emit({ type: 'error', code: 'protocol_error', message: 'Native messaging connection failed.' });
  process.exitCode = 1;
} finally {
  log.subscribe();
  await host.disconnect();
  const errors = await client.stop();
  if (errors.length) {
    log.write('error', 'Runtime shutdown failed');
    await client.forceStop();
    process.exitCode = 1;
  }
  await writes;
}

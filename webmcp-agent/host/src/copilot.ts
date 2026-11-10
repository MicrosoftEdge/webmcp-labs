// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from 'node:crypto';
import {
  CopilotClient, type CopilotClientOptions, type SessionConfig, type ResumeSessionConfig,
  type CopilotSession, type SessionEvent,
} from '@github/copilot-sdk';
import {
  CHAT_ID_PREFIX, type PageContext, type PageTool, type ToHost, type ToExtension,
  type HostSettings, type HistoryItem, toolDisplaySchema, modelDisplaySchema,
} from '@webmcp-agent/shared/protocol';
import { buildSystemMessage, contextFingerprint, withPageContext } from './prompt.js';
import { buildToolRegistry, toolResultForModel, unwrapPageResult } from './tools.js';
import { chunkHistory } from './nativeMessaging.js';

export const SDK_VERSION = '1.0.28';
type UserInputRequest = Parameters<NonNullable<SessionConfig['onUserInputRequest']>>[0];
type UserInputResponse = Awaited<ReturnType<NonNullable<SessionConfig['onUserInputRequest']>>>;

export function isolatedClientOptions(baseDirectory: string, workingDirectory: string): CopilotClientOptions {
  // Do not inherit a developer's runtime override or explicit authentication.
  const environment = { ...process.env };
  for (const key of ['COPILOT_CLI_PATH', 'COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    delete environment[key];
  }
  return {
    mode: 'empty',
    baseDirectory,
    workingDirectory,
    useLoggedInUser: true,
    env: environment,
    clientInfo: {
      applicationName: 'webmcp-agent',
      applicationVersion: '0.1.0',
      integrationName: 'webmcp-agent-extension',
    },
    logLevel: 'error',
  };
}

export function createIsolatedClient(baseDirectory: string, workingDirectory: string) {
  return new CopilotClient(isolatedClientOptions(baseDirectory, workingDirectory));
}

export function compatibilitySessionConfig(): SessionConfig {
  return {
    sessionId: `${CHAT_ID_PREFIX}${randomUUID()}`,
    name: 'WebMCP Agent: compatibility probe',
    streaming: true,
    tools: [{
      name: 'webmcp_probe',
      description: 'A local compatibility probe. It has no side effects.',
      parameters: { type: 'object', properties: {} },
      skipPermission: true,
      defer: 'never',
    }],
    availableTools: ['custom:*', 'builtin:ask_user'],
    toolSearch: { enabled: false },
    enableSessionStore: false,
    enableConfigDiscovery: false,
    mcpServers: {},
    systemMessage: {
      mode: 'customize',
      sections: {
        preamble: { action: 'replace', content: 'You are WebMCP Agent, a browser assistant.' },
        environment_context: { action: 'remove' },
        code_change_rules: { action: 'remove' },
      },
    },
    onPermissionRequest: () => ({ kind: 'reject' }),
    onUserInputRequest: () => ({ answer: 'Compatibility probe only', wasFreeform: true }),
    infiniteSessions: { enabled: true },
  };
}

export type SessionPort = Pick<CopilotSession, 'sessionId' | 'send' | 'abort' | 'disconnect' | 'getEvents' | 'setTools' | 'setModel' | 'log'> & {
  on(handler: (event: SessionEvent) => void): () => void;
  rpc: { tools: Pick<CopilotSession['rpc']['tools'], 'handlePendingToolCall'> };
};
export interface ClientPort {
  createSession(config: SessionConfig): Promise<SessionPort>;
  resumeSession(id: string, config: ResumeSessionConfig): Promise<SessionPort>;
  listSessions: CopilotClient['listSessions'];
  deleteSession: CopilotClient['deleteSession'];
  listModels: CopilotClient['listModels'];
  getAuthStatus: CopilotClient['getAuthStatus'];
}
type Registry = Awaited<ReturnType<typeof buildToolRegistry>>;
type Route = Registry['routes'] extends Map<string, infer Value> ? Value : never;
type PendingCall = { requestId: string; callId: string; sdkName: string; route: Route; page: PageContext; args: unknown };
interface Chat {
  session: SessionPort;
  unsubscribe: () => void;
  page: PageContext;
  tools: PageTool[];
  routes: Map<string, Route>;
  declarations: Registry['declarations'];
  fingerprint?: string;
  running: boolean;
  starting: boolean;
  queue: PendingCall[];
  active?: PendingCall | undefined;
  question?: { message: Extract<ToExtension, { type: 'question' }>; resolve: (answer: UserInputResponse) => void; reject: (error: Error) => void } | undefined;
  events: Promise<void>;
  updates: Promise<void>;
}

export class AgentHost {
  private readonly chats = new Map<string, Chat>();
  private lifecycle = Promise.resolve();
  settings: HostSettings = { maxToolResultChars: 16000, verboseLogs: false };
  constructor(
    private readonly client: ClientPort,
    private readonly emit: (message: ToExtension) => void,
    private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', text: string) => void,
  ) {}

  private chat(id: string): Chat {
    const chat = this.chats.get(id);
    if (!chat) throw new Error('Chat is not open in this host. Open it from History.');
    return chat;
  }

  private failure(id: string, error: unknown): void {
    this.log('error', `SDK operation failed for ${id}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    this.emit({ type: 'error', chatId: id, code: 'sdk_error', message: error instanceof Error ? error.message : String(error) });
    const chat = this.chats.get(id);
    if (chat && (chat.running || chat.starting || chat.active || chat.question)) {
      void this.stop(id).catch(() => this.log('error', `Failed to abort SDK chat ${id}`));
    } else this.emit({ type: 'status', chatId: id, state: 'idle' });
  }

  async listChats(cleared = false): Promise<void> {
    const sessions = await this.client.listSessions();
    this.emit({ type: 'chats', ...(cleared ? { cleared: true } : {}), chats: sessions.filter(item => item.sessionId.startsWith(CHAT_ID_PREFIX)).map(item => ({
      chatId: item.sessionId, title: this.displaySessionTitle(item.summary), updatedAt: item.modifiedTime.toISOString(),
    })) });
  }

  async handle(message: ToHost): Promise<void> {
    // A resumed SDK session must not race an earlier disconnect of that session.
    if (['open_chat', 'close_chat', 'delete_chat', 'clear_chats'].includes(message.type)) {
      const operation = this.lifecycle.then(() => this.dispatchMessage(message));
      this.lifecycle = operation.catch(() => {});
      return operation;
    }
    await this.lifecycle;
    return this.dispatchMessage(message);
  }

  private async dispatchMessage(message: ToHost): Promise<void> {
    switch (message.type) {
      case 'hello': return;
      case 'list_models': {
        const models = await this.client.listModels();
        this.emit({ type: 'models', models: models.filter(model => model.policy?.state !== 'disabled').map(model => ({
          id: model.id, name: model.name, ...(model.billing?.multiplier === undefined ? {} : { multiplier: model.billing.multiplier }),
        })) });
        return;
      }
      case 'list_chats': return this.listChats();
      case 'open_chat': return this.open(message);
      case 'send': {
        const chat = this.chat(message.chatId);
        if (chat.running || chat.starting) throw new Error('A turn is already running. Stop it before sending another.');
        chat.starting = true;
        try {
          if (!(await this.client.getAuthStatus()).isAuthenticated) {
            this.emit({ type: 'error', chatId: message.chatId, code: 'not_signed_in', message: 'Run npm run login in webmcp-agent, then reconnect.' });
            this.emit({ type: 'status', chatId: message.chatId, state: 'idle' });
            return;
          }
          if (!chat.starting) throw new Error('Stopped by the user');
          await this.update(chat, message.page, message.tools);
          await this.waitForToolUpdates(chat);
          if (!chat.starting) throw new Error('Stopped by the user');
          const fingerprint = contextFingerprint(chat.page, chat.tools);
          const prompt = message.pageChanged || chat.fingerprint !== fingerprint
            ? withPageContext(message.text, chat.page, chat.tools) : message.text;
          chat.fingerprint = fingerprint;
          chat.running = true;
          this.emit({ type: 'status', chatId: message.chatId, state: 'running' });
          await chat.session.send({ prompt, displayPrompt: message.text });
        } catch (error) {
          chat.running = false;
          this.emit({ type: 'status', chatId: message.chatId, state: 'idle' });
          throw error;
        } finally { chat.starting = false; }
        return;
      }
      case 'set_tools': return this.update(this.chat(message.chatId), message.page, message.tools);
      case 'tool_result': return this.complete(message);
      case 'answer': {
        const chat = this.chat(message.chatId);
        if (!chat.question || chat.question.message.requestId !== message.requestId) throw new Error('Question is no longer pending.');
        const question = chat.question;
        if (!message.wasFreeform && !question.message.choices?.includes(message.answer)) throw new Error('Answer must match an offered choice.');
        if (message.wasFreeform && !question.message.allowFreeform) throw new Error('This question does not accept a free-form answer.');
        chat.question = undefined;
        question.resolve({ answer: message.answer, wasFreeform: message.wasFreeform });
        return;
      }
      case 'set_model': {
        const chat = this.chat(message.chatId);
        if (chat.running) throw new Error('Stop the current turn before changing models.');
        await chat.session.setModel(message.model);
        return;
      }
      case 'stop': return this.stop(message.chatId);
      case 'close_chat': return this.close(message.chatId);
      case 'delete_chat': {
        if (!message.chatId.startsWith(CHAT_ID_PREFIX)) throw new Error('Not a WebMCP Agent chat.');
        await this.close(message.chatId);
        await this.client.deleteSession(message.chatId);
        return this.listChats();
      }
      case 'clear_chats': {
        for (const session of await this.client.listSessions()) {
          if (!session.sessionId.startsWith(CHAT_ID_PREFIX)) continue;
          await this.close(session.sessionId);
          await this.client.deleteSession(session.sessionId);
        }
        return this.listChats(true);
      }
      case 'set_settings': this.settings = message.settings; return;
      case 'logs': return;
    }
  }

  private title(page: PageContext): string {
    const title = page.title.trim();
    return (title && title !== page.url ? title : 'New chat').replace(/["\r\n]/g, '').slice(0, 100);
  }

  private displaySessionTitle(summary: string | undefined): string {
    const title = summary?.trim();
    if (!title || /^WebMCP Agent:\s*/i.test(title)) return 'New chat';
    return title.slice(0, 100);
  }

  private async open(message: Extract<ToHost, { type: 'open_chat' }>): Promise<void> {
    const id = message.chatId ?? `${CHAT_ID_PREFIX}${randomUUID()}`;
    let chat = this.chats.get(id);
    if (!chat) {
      if (message.chatId && !(await this.client.listSessions()).some(item => item.sessionId === id && id.startsWith(CHAT_ID_PREFIX))) {
        this.emit({ type: 'error', code: 'chat_not_found', message: 'That WebMCP Agent chat no longer exists.' });
        return;
      }
      const registry = await buildToolRegistry(message.page, message.tools);
      const config: SessionConfig = {
        name: this.title(message.page), streaming: true,
        ...(message.model ? { model: message.model } : {}),
        tools: registry.declarations, availableTools: ['custom:*', 'builtin:ask_user'],
        toolSearch: { enabled: false }, enableSessionStore: false, enableConfigDiscovery: false,
        mcpServers: {}, systemMessage: buildSystemMessage(), infiniteSessions: { enabled: true },
        onPermissionRequest: () => ({ kind: 'reject' }),
        onUserInputRequest: request => this.question(id, request),
      };
      const session = message.chatId
        ? await this.client.resumeSession(id, config)
        : await this.client.createSession({ ...config, sessionId: id });
      chat = {
        session, unsubscribe: () => {}, page: message.page, tools: message.tools,
        routes: registry.routes, declarations: registry.declarations,
        running: false, starting: false, queue: [], events: Promise.resolve(), updates: Promise.resolve(),
      };
      this.chats.set(id, chat);
      const current = chat;
      chat.unsubscribe = session.on(event => {
        current.events = current.events.then(() => this.event(id, current, event)).catch(error => this.failure(id, error));
      });
    } else if (!chat.running) await this.update(chat, message.page, message.tools);
    this.emit({ type: 'chat_opened', chatId: id, title: this.title(chat.page), ...(message.model ? { model: message.model } : {}) });
    const history = await chat.session.getEvents();
    for (const chunk of chunkHistory(id, renderHistory(history))) this.emit(chunk);
    this.emit({ type: 'status', chatId: id, state: chat.running ? 'running' : 'idle' });
    if (chat.question) this.emit(chat.question.message);
    if (chat.active) this.emitCall(id, chat.active);
  }

  private async update(chat: Chat, page: PageContext, tools: PageTool[]): Promise<void> {
    const operation = chat.updates.catch(() => {}).then(async () => {
      const registry = await buildToolRegistry(page, tools);
      // Retain unavailable declarations during a turn so old model calls still
      // emit external_tool.requested and can receive an explicit failure.
      if (chat.running) {
        for (const declaration of chat.declarations) {
          if (!registry.routes.has(declaration.name)) registry.declarations.push({ ...declaration, description: 'Unavailable: this tool has been removed. Do not call it.' });
        }
        for (const [name, oldRoute] of chat.routes) {
          const replacement = registry.routes.get(name);
          if (replacement && (replacement.tool.key !== oldRoute.tool.key || replacement.tool.origin !== oldRoute.tool.origin || page.tabId !== chat.page.tabId)) {
            throw new Error('Tool identity changed during a run. Stop and start a new turn.');
          }
        }
      }
      await chat.session.setTools(registry.declarations);
      chat.page = page;
      chat.tools = tools;
      chat.routes = registry.routes;
      chat.declarations = registry.declarations;
      if (tools.length > 128) this.log('warn', `Large tool snapshot: ${tools.length} tools`);
    });
    chat.updates = operation;
    await operation;
  }

  private async waitForToolUpdates(chat: Chat): Promise<void> {
    let update: Promise<void>;
    do {
      update = chat.updates;
      await update;
    } while (update !== chat.updates);
  }

  private question(id: string, request: UserInputRequest): Promise<UserInputResponse> {
    const chat = this.chat(id);
    return new Promise((resolve, reject) => {
      if (chat.question) { reject(new Error('Another question is pending')); return; }
      const message: Extract<ToExtension, { type: 'question' }> = {
        type: 'question', chatId: id, requestId: randomUUID(), question: request.question,
        ...(request.choices ? { choices: request.choices } : {}), allowFreeform: request.allowFreeform ?? true,
      };
      chat.question = { message, resolve, reject };
      this.emit(message);
    });
  }

  private async event(id: string, chat: Chat, event: SessionEvent): Promise<void> {
    if (event.agentId) return;
    this.log('debug', `SDK event ${event.type}`);
    switch (event.type) {
      case 'user.message':
        this.emit({ type: 'user', chatId: id, text: event.data.content, ...(event.data.messageId ? { messageId: event.data.messageId } : {}) });
        break;
      case 'assistant.message_delta':
        this.emit({ type: 'delta', chatId: id, messageId: event.data.messageId, text: event.data.deltaContent });
        break;
      case 'assistant.reasoning_delta':
        this.emit({ type: 'reasoning', chatId: id, reasoningId: event.data.reasoningId, text: event.data.deltaContent });
        break;
      case 'assistant.reasoning':
        this.emit({ type: 'reasoning', chatId: id, reasoningId: event.data.reasoningId, text: event.data.content, complete: true });
        break;
      case 'assistant.message':
        this.emit({ type: 'message', chatId: id, messageId: event.data.messageId, text: event.data.content });
        break;
      case 'assistant.usage': {
        const model = modelDisplaySchema.parse({
          id: event.data.model,
          name: event.data.modelDisplayName ?? event.data.model,
          isAuto: event.data.isAuto ?? false,
        });
        this.emit({ type: 'model_used', chatId: id, model });
        await chat.session.log(JSON.stringify({ kind: 'webmcp-agent-model', model }));
        break;
      }
      case 'session.idle':
        chat.running = false;
        this.emit({ type: 'status', chatId: id, state: 'idle' });
        break;
      case 'abort': {
        const calls = [...(chat.active ? [chat.active] : []), ...chat.queue];
        chat.running = false;
        chat.starting = false;
        chat.active = undefined;
        chat.queue = [];
        chat.question?.reject(new Error('The SDK aborted this turn.'));
        chat.question = undefined;
        for (const call of calls) this.emit({ type: 'tool_done', chatId: id, callId: call.callId, ok: false, result: 'The SDK aborted this turn.' });
        this.emit({ type: 'abort', chatId: id, eventId: event.id, reason: event.data.reason });
        break;
      }
      case 'session.error':
        this.failure(id, new Error(event.data.message));
        break;
      case 'session.title_changed':
        this.emit({ type: 'title', chatId: id, title: event.data.title });
        break;
      case 'external_tool.requested': {
        await this.waitForToolUpdates(chat);
        const route = chat.routes.get(event.data.toolName);
        if (!route || !chat.running) {
          await chat.session.rpc.tools.handlePendingToolCall({ requestId: event.data.requestId, result: {
            resultType: 'failure', textResultForLlm: 'This tool is no longer available on the page. The page tools may have changed.',
          } });
          return;
        }
        // Persist display provenance in the SDK's own event store so old tool
        // cards keep their origin/hints even after the page changes.
        await chat.session.log(JSON.stringify({
          kind: 'webmcp-agent-tool', callId: event.data.toolCallId,
          tool: toolDisplaySchema.parse({
            name: route.tool.name, ...(route.tool.title ? { title: route.tool.title } : {}),
            origin: route.tool.origin, isTopFrame: route.tool.isTopFrame, annotations: route.tool.annotations,
          }),
        }));
        chat.queue.push({
          requestId: event.data.requestId, callId: event.data.toolCallId, sdkName: event.data.toolName,
          args: event.data.arguments ?? {}, route, page: { ...chat.page },
        });
        this.dispatch(id, chat);
        break;
      }
    }
  }

  private emitCall(id: string, call: PendingCall): void {
    this.emit({
      type: 'tool_call', chatId: id, callId: call.callId, sdkName: call.sdkName,
      key: call.route.tool.key, args: call.args as Extract<ToExtension, { type: 'tool_call' }>['args'],
      tabId: call.page.tabId, origin: call.route.tool.origin,
      tool: call.route.tool,
      ...(call.page.documentId ? { documentId: call.page.documentId } : {}),
    });
  }

  private dispatch(id: string, chat: Chat): void {
    if (chat.active || !chat.running) return;
    const next = chat.queue.shift();
    if (!next) return;
    chat.active = next;
    this.emitCall(id, next);
  }

  private async complete(message: Extract<ToHost, { type: 'tool_result' }>): Promise<void> {
    const chat = this.chat(message.chatId);
    await this.waitForToolUpdates(chat);
    const call = chat.active;
    if (!call || call.callId !== message.callId) { this.log('warn', 'Ignored stale tool result'); return; }
    const navigation = chat.page.documentId !== call.page.documentId || chat.page.url !== call.page.url ? chat.page.url : undefined;
    const result = toolResultForModel(message, call.route.tool, call.sdkName, this.settings.maxToolResultChars, navigation);
    if (this.settings.verboseLogs) this.log('debug', JSON.stringify({ args: call.args, result }));
    const handled = await chat.session.rpc.tools.handlePendingToolCall({ requestId: call.requestId, result });
    if (!handled.success) throw new Error('Runtime rejected a pending tool result.');
    this.emit({ type: 'tool_done', chatId: message.chatId, callId: call.callId, ok: message.ok, result: message.ok ? message.result ?? '' : `${message.error.name}: ${message.error.message}` });
    chat.active = undefined;
    this.dispatch(message.chatId, chat);
  }

  async stop(id: string): Promise<void> {
    const chat = this.chat(id);
    chat.running = false;
    chat.starting = false;
    const calls = [...(chat.active ? [chat.active] : []), ...chat.queue];
    chat.active = undefined;
    chat.queue = [];
    chat.question?.reject(new Error('Stopped by the user'));
    chat.question = undefined;
    const failures: unknown[] = [];
    for (const call of calls) {
      try {
        const handled = await chat.session.rpc.tools.handlePendingToolCall({ requestId: call.requestId, result: { resultType: 'failure', textResultForLlm: 'Stopped by the user' } });
        if (!handled.success) throw new Error(`Runtime rejected stopped tool request ${call.requestId}.`);
      } catch (error) {
        failures.push(error);
        this.log('error', `Failed to return stopped tool request ${call.requestId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await chat.session.abort();
    for (const call of calls) this.emit({ type: 'tool_done', chatId: id, callId: call.callId, ok: false, result: 'Stopped by the user' });
    this.emit({ type: 'status', chatId: id, state: 'idle' });
    if (failures.length) throw new AggregateError(failures, 'The SDK was aborted, but some stopped tool results could not be returned.');
  }

  private async close(id: string): Promise<void> {
    const chat = this.chats.get(id);
    if (!chat) return;
    if (chat.running || chat.starting || chat.question || chat.active) await this.stop(id);
    chat.unsubscribe();
    await chat.session.disconnect();
    this.chats.delete(id);
  }

  async disconnect(): Promise<void> {
    await this.lifecycle;
    for (const id of this.chats.keys()) await this.close(id);
  }
}

export function renderHistory(events: SessionEvent[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  const calls = new Map<string, Extract<HistoryItem, { kind: 'tool' }>>();
  let pendingModel: Extract<HistoryItem, { kind: 'assistant' }>['model'];
  for (const event of events) {
    if (event.agentId) continue;
    if (event.type === 'abort') items.push({ kind: 'abort', eventId: event.id, reason: event.data.reason });
    if (event.type === 'user.message') items.push({ kind: 'user', text: event.data.content, ...(event.data.messageId ? { messageId: event.data.messageId } : {}) });
    if (event.type === 'assistant.message' && event.data.content.trim()) {
      items.push({ kind: 'assistant', messageId: event.data.messageId, text: event.data.content, ...(pendingModel ? { model: pendingModel } : {}) });
      pendingModel = undefined;
    }
    if (event.type === 'session.info') {
      try {
        const metadata: unknown = JSON.parse(event.data.message);
        if (typeof metadata === 'object' && metadata !== null && 'kind' in metadata) {
          if (metadata.kind === 'webmcp-agent-tool' && 'callId' in metadata && typeof metadata.callId === 'string' && 'tool' in metadata) {
            const parsed = toolDisplaySchema.safeParse(metadata.tool);
            const item = calls.get(metadata.callId);
            if (parsed.success && item) item.tool = parsed.data;
          }
          if (metadata.kind === 'webmcp-agent-model' && 'model' in metadata) {
            const parsed = modelDisplaySchema.safeParse(metadata.model);
            if (parsed.success) pendingModel = parsed.data;
          }
        }
      } catch { /* Ordinary SDK informational events are not tool metadata. */ }
    }
    if (event.type === 'tool.execution_start') {
      const item: Extract<HistoryItem, { kind: 'tool' }> = {
        kind: 'tool', sdkName: event.data.toolName, callId: event.data.toolCallId, args: event.data.arguments ?? {},
      };
      calls.set(event.data.toolCallId, item);
      items.push(item);
    }
    if (event.type === 'tool.execution_complete') {
      const item = calls.get(event.data.toolCallId);
      if (item) {
        item.ok = event.data.success;
        item.result = unwrapPageResult(event.data.result?.content ?? event.data.error?.message ?? '');
      }
    }
  }
  return items;
}

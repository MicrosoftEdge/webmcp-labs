// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
import { contentRequestSchema, type ContentResponse } from '../messages';
import type { PageTool, ToolAnnotations } from '@webmcp-agent/shared/protocol';

interface LiveTool {
  name: string; title?: string; description: string; inputSchema?: unknown;
  origin: string; window: Window | null; annotations?: Partial<ToolAnnotations> | null;
}
interface ModelContext extends EventTarget {
  getTools(options: { fromOrigins: string[] }): Promise<LiveTool[]>;
  executeTool(tool: LiveTool, args: object, options: { signal: AbortSignal }): Promise<string | null>;
}
declare global { interface Document { modelContext?: ModelContext } }
const frameNumbers = new WeakMap<Window, number>([[window, 0]]);
let nextFrame = 1;
let snapshot = new Map<string, LiveTool>();
let origins: string[] = [];
let listening: ModelContext | undefined;
let revision = 0;
let latestList: Promise<ContentResponse> | undefined;
const calls = new Map<string, { controller: AbortController; tool: LiveTool }>();
const notify = (message: ContentResponse) => chrome.runtime.sendMessage(message).catch(error => {
  console.debug('WebMCP Agent connection unavailable:', error instanceof Error ? error.message : String(error));
});

function list(): Promise<ContentResponse> {
  const operation = collect(++revision);
  latestList = operation;
  return operation;
}
async function collect(currentRevision: number): Promise<ContentResponse> {
  const context = document.modelContext;
  if (!context) { snapshot.clear(); return { type: 'webmcp/snapshot', available: false, tools: [] }; }
  if (listening !== context) {
    listening = context;
    let timer: ReturnType<typeof setTimeout>;
    context.addEventListener('toolchange', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { void list().then(notify); }, 100);
    });
    for (const type of ['toolactivated', 'toolcancel']) context.addEventListener(type, () => { void notify({ type: 'webmcp/log', text: type }); });
  }
  try {
    const tools = await context.getTools({ fromOrigins: origins });
    const latest = new Map<string, LiveTool>();
    const projected: PageTool[] = tools.map(tool => {
      if (!tool.window) throw new Error('A tool has no owning window.');
      let frame = frameNumbers.get(tool.window);
      if (frame === undefined) { frame = nextFrame++; frameNumbers.set(tool.window, frame); }
      const key = `${frame}:${tool.name}`;
      if (latest.has(key)) throw new Error('The browser returned duplicate tool identities.');
      latest.set(key, tool);
      let schema = tool.inputSchema;
      if (typeof schema === 'string') schema = JSON.parse(schema);
      if (schema !== undefined && (schema === null || typeof schema !== 'object' || Array.isArray(schema))) throw new Error('Tool inputSchema must be an object.');
      return {
        key, name: tool.name, ...(tool.title ? { title: tool.title } : {}),
        description: tool.description, origin: tool.origin, isTopFrame: frame === 0,
        ...(schema === undefined ? {} : { inputSchema: schema as PageTool['inputSchema'] }),
        annotations: {
          readOnlyHint: tool.annotations?.readOnlyHint ?? false,
          consequentialHint: tool.annotations?.consequentialHint ?? false,
          untrustedContentHint: tool.annotations?.untrustedContentHint ?? false,
          debugging: tool.annotations?.debugging ?? false,
        },
      };
    });
    if (JSON.stringify(projected).length > 500000) throw new Error('Page tool snapshot is too large to transport.');
    if (currentRevision !== revision && latestList) return latestList;
    snapshot = latest;
    return { type: 'webmcp/snapshot', available: true, tools: projected };
  } catch (error) {
    if (currentRevision !== revision && latestList) return latestList;
    snapshot.clear();
    return { type: 'webmcp/snapshot', available: true, tools: [], error: error instanceof Error ? error.message : String(error) };
  }
}

chrome.runtime.onMessage.addListener((value: unknown, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  const parsed = contentRequestSchema.safeParse(value);
  if (!parsed.success) { console.warn('WebMCP Agent rejected an invalid request'); return false; }
  const request = parsed.data;
  if (request.type === 'webmcp/list') {
    origins = request.fromOrigins;
    void list().then(respond);
    return true;
  }
  if (request.type === 'webmcp/cancel') {
    calls.get(request.callId)?.controller.abort();
    respond({ type: 'webmcp/result', callId: request.callId, ok: false, error: { name: 'AbortError', message: 'Stopped by the user' } });
    return false;
  }
  const tool = snapshot.get(request.key);
  const context = document.modelContext;
  if (!tool || !context) {
    respond({ type: 'webmcp/result', callId: request.callId, ok: false, error: { name: 'NotFoundError', message: 'This tool is no longer available on the page.' } });
    return false;
  }
  if (calls.has(request.callId)) {
    respond({ type: 'webmcp/result', callId: request.callId, ok: false, error: { name: 'InvalidStateError', message: 'This call is already running.' } });
    return false;
  }
  const controller = new AbortController();
  calls.set(request.callId, { controller, tool });
  void context.executeTool(tool, request.args, { signal: controller.signal }).then(async result => {
    if (result !== null && typeof result !== 'string') throw new TypeError('The browser returned a non-string tool result.');
    // Let next-step registrations queued by the page's tool callback run first.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const capped = result !== null && result.length > 500000 ? result.slice(0, 500000) + '\n[Transport result truncated at 500000 characters]' : result;
    respond({ type: 'webmcp/result', callId: request.callId, ok: true, result: capped });
  }).catch((error: unknown) => {
    respond({ type: 'webmcp/result', callId: request.callId, ok: false, error: {
      name: error instanceof Error ? error.name : 'Error', message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    } });
  }).finally(() => calls.delete(request.callId));
  return true;
});
void list().then(notify);

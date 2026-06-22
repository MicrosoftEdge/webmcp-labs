// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Content script — injected into web pages.
 * Bridges document.modelContext to the extension side panel via
 * chrome.runtime messaging.
 *
 * Why we keep a local Map of tools:
 *   document.modelContext.executeTool(tool, args) requires the *full* tool
 *   object, including its live `window` reference. That object can't be
 *   structured-cloned across chrome.runtime, so the side panel can never
 *   hold it. Instead, the side panel dispatches by name and we look the
 *   tool up here just before invoking executeTool.
 *
 * Name collisions:
 *   When two tools share a name (e.g. one from the top frame and one from a
 *   cross-origin iframe via `exposedTo`), we log a console.warn and let
 *   last-write-wins. Acceptable for a dev/debug surface; a real agent would
 *   disambiguate by origin.
 */

import type {
  BridgeRequest,
  BridgeResponse,
  RegisteredTool,
  ToolAnnotations,
} from './types/webmcp.d';

// document.modelContext is exposed on Document by Chromium when the
// WebMCP feature is enabled (chrome://flags/#enable-webmcp-testing).
declare global {
  interface Document {
    modelContext?: ModelContext;
  }

  /** Live tool object returned by document.modelContext.getTools(). */
  interface ModelContextRegisteredTool {
    readonly name: string;
    readonly origin: string;
    readonly description?: string;
    readonly inputSchema?: unknown;
    readonly title?: string;
    readonly window: Window;
    readonly annotations?: ToolAnnotations;
  }

  interface ModelContextGetToolsOptions {
    fromOrigins?: string[];
  }

  interface ModelContextExecuteToolOptions {
    signal?: AbortSignal;
  }

  interface ModelContext extends EventTarget {
    getTools(options?: ModelContextGetToolsOptions): Promise<ModelContextRegisteredTool[]>;
    executeTool(
      tool: ModelContextRegisteredTool,
      inputArguments: string,
      options?: ModelContextExecuteToolOptions
    ): Promise<string | null>;
    ontoolchange: ((this: ModelContext, ev: Event) => void) | null;
  }
}

function getModelContext(): ModelContext | null {
  return document.modelContext ?? null;
}

/**
 * Project a live tool into the structured-cloneable shape we send to the
 * side panel. Drops `window` (non-serializable) and any extension-private
 * fields. Keeps `origin` so the UI can show provenance.
 */
function projectTool(t: ModelContextRegisteredTool): RegisteredTool {
  const out: RegisteredTool = { name: t.name, origin: t.origin };
  if (t.description !== undefined) out.description = t.description;
  if (t.inputSchema !== undefined) out.inputSchema = t.inputSchema;
  if (t.title !== undefined) out.title = t.title;
  if (t.annotations !== undefined) out.annotations = t.annotations;
  return out;
}

/**
 * Fetch the current tool snapshot and deduplicate by name. On collision
 * we keep the last one (matches dispatch behavior) and log a console
 * warning so the developer notices.
 */
async function getDedupedTools(ctx: ModelContext): Promise<ModelContextRegisteredTool[]> {
  const tools = await ctx.getTools();
  const byName = new Map<string, ModelContextRegisteredTool>();
  for (const t of tools) {
    if (byName.has(t.name)) {
      const prev = byName.get(t.name)!;
      console.warn(
        `[WebMCP] Duplicate tool name "${t.name}" from origins ${prev.origin} and ${t.origin}; last one wins.`
      );
    }
    byName.set(t.name, t);
  }
  return Array.from(byName.values());
}

/**
 * Bind the toolchange listener lazily and idempotently. document.modelContext
 * may not exist at document_start, so we re-check on every side-panel
 * request and rebind if the ctx instance was swapped (e.g. SPA navigation
 * that reseats the supplement).
 */
let listenedCtx: ModelContext | null = null;
function ensureToolchangeListener(ctx: ModelContext): void {
  if (listenedCtx === ctx) return;
  listenedCtx = ctx;
  ctx.addEventListener('toolchange', () => {
    chrome.runtime.sendMessage({ type: 'toolchange' } satisfies BridgeResponse).catch(() => {
      // Side panel may not be open — ignore.
    });
  });
}

// Listen for messages from the side panel
chrome.runtime.onMessage.addListener(
  (
    message: BridgeRequest,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: BridgeResponse) => void
  ) => {
    // Ping check — service worker uses this to verify the content script is loaded
    if (message.type === 'ping') {
      sendResponse({ type: 'pong' } as BridgeResponse);
      return true;
    }

    const ctx = getModelContext();

    if (!ctx) {
      sendResponse({
        type: 'error',
        message:
          'document.modelContext not available on this page. Enable chrome://flags/#enable-webmcp-testing and reload.',
      });
      return true;
    }

    ensureToolchangeListener(ctx);

    if (message.type === 'listTools') {
      getDedupedTools(ctx)
        .then((tools) => {
          sendResponse({ type: 'listTools', tools: tools.map(projectTool) });
        })
        .catch((e) => {
          sendResponse({ type: 'error', message: String(e) });
        });
      return true; // async response
    }

    if (message.type === 'executeTool') {
      // Re-fetch on every dispatch so we never hold a stale tool object after
      // the page unregistered/re-registered the same name. getTools() is a
      // cheap local DOM call; correctness beats caching here.
      (async () => {
        try {
          const tools = await getDedupedTools(ctx);
          const tool = tools.find((t) => t.name === message.name);
          if (!tool) {
            sendResponse({
              type: 'error',
              message: `Tool "${message.name}" not found on this page.`,
            });
            return;
          }
          const abortController = new AbortController();
          const options = message.signal ? { signal: abortController.signal } : {};
          const result = await ctx.executeTool(tool, message.args, options);
          sendResponse({ type: 'executeTool', result });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          sendResponse({ type: 'error', message: msg });
        }
      })();
      return true; // keep message channel open for async response
    }

    return false;
  }
);

// Eagerly attach the toolchange listener if the context is already there at
// document_start. If not, ensureToolchangeListener will pick it up on the
// first side-panel request.
const initialCtx = getModelContext();
if (initialCtx) ensureToolchangeListener(initialCtx);

export {};


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

/** Cache of the most recent snapshot, keyed by name. Rebuilt on every fetch. */
const toolsByName = new Map<string, ModelContextRegisteredTool>();

async function refreshToolsByName(ctx: ModelContext): Promise<ModelContextRegisteredTool[]> {
  const tools = await ctx.getTools();
  toolsByName.clear();
  for (const t of tools) {
    if (toolsByName.has(t.name)) {
      const prev = toolsByName.get(t.name)!;
      console.warn(
        `[WebMCP] Duplicate tool name "${t.name}" from origins ${prev.origin} and ${t.origin}; last one wins.`
      );
    }
    toolsByName.set(t.name, t);
  }
  return tools;
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

    if (message.type === 'listTools') {
      refreshToolsByName(ctx)
        .then((tools) => {
          sendResponse({ type: 'listTools', tools: tools.map(projectTool) });
        })
        .catch((e) => {
          sendResponse({ type: 'error', message: String(e) });
        });
      return true; // async response
    }

    if (message.type === 'executeTool') {
      const tool = toolsByName.get(message.name);
      if (!tool) {
        sendResponse({
          type: 'error',
          message: `Tool "${message.name}" not found in the current snapshot. Refresh the tool list and try again.`,
        });
        return true;
      }

      const abortController = new AbortController();
      const options = message.signal ? { signal: abortController.signal } : {};

      ctx
        .executeTool(tool, message.args, options)
        .then((result) => {
          sendResponse({ type: 'executeTool', result });
        })
        .catch((e: DOMException) => {
          sendResponse({ type: 'error', message: e.message });
        });

      return true; // keep message channel open for async response
    }

    return false;
  }
);

// Forward toolchange events to the side panel. The page may not have
// installed document.modelContext yet at document_start, so check.
const ctx = getModelContext();
if (ctx) {
  ctx.addEventListener('toolchange', () => {
    chrome.runtime.sendMessage({ type: 'toolchange' } satisfies BridgeResponse);
  });
}

export {};


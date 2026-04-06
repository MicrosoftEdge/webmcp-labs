// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Content script — injected into web pages.
 * Bridges the ModelContextTesting API to the extension side panel
 * via chrome.runtime messaging.
 */

import type { BridgeRequest, BridgeResponse, RegisteredTool } from './types/webmcp.d';

// ModelContextTesting is exposed on navigator by Chromium
declare global {
  interface Navigator {
    modelContextTesting?: ModelContextTesting;
  }

  interface ModelContextTesting extends EventTarget {
    listTools(): RegisteredTool[];
    executeTool(
      toolName: string,
      inputArguments: string,
      options?: { signal?: AbortSignal }
    ): Promise<string | null>;
    ontoolchange: ((this: ModelContextTesting, ev: Event) => void) | null;
  }
}

function getModelContext(): ModelContextTesting | null {
  return navigator.modelContextTesting ?? null;
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
      sendResponse({ type: 'error', message: 'ModelContextTesting not available on this page' });
      return true;
    }

    if (message.type === 'listTools') {
      try {
        const tools = ctx.listTools();
        sendResponse({ type: 'listTools', tools });
      } catch (e) {
        sendResponse({ type: 'error', message: String(e) });
      }
      return true;
    }

    if (message.type === 'executeTool') {
      const abortController = new AbortController();
      const options = message.signal ? { signal: abortController.signal } : {};

      ctx
        .executeTool(message.name, message.args, options)
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

// Forward toolchange events to the side panel
const ctx = getModelContext();
if (ctx) {
  ctx.addEventListener('toolchange', () => {
    chrome.runtime.sendMessage({ type: 'toolchange' } satisfies BridgeResponse);
  });
}

export {};

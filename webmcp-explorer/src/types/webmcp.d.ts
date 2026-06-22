// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * TypeScript types for the document.modelContext WebIDL interface
 * and the wire protocol between content script and side panel.
 */

/**
 * Optional hints the page can attach to a tool. Mirrors WebIDL ToolAnnotations.
 */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}

/**
 * Tool projection sent over chrome.runtime messaging to the side panel.
 *
 * This is a *subset* of the real WebIDL RegisteredTool: the live `window`
 * reference and the `execute` callback can't be structured-cloned, so we drop
 * them. The content script keeps the full objects in a Map keyed by `name`
 * and looks one up when dispatching executeTool.
 */
export interface RegisteredTool {
  name: string;
  origin: string;
  description?: string;
  /** JSON Schema describing input parameters (object form, not stringified). */
  inputSchema?: unknown;
  title?: string;
  annotations?: ToolAnnotations;
}

export interface ExecuteToolOptions {
  signal?: AbortSignal;
}

/**
 * Messages sent from the side panel to the content script.
 */
export type BridgeRequest =
  | { type: 'ping' }
  | { type: 'listTools' }
  | { type: 'executeTool'; name: string; args: string; signal?: boolean };

/**
 * Messages sent from the content script back to the side panel.
 */
export type BridgeResponse =
  | { type: 'pong' }
  | { type: 'listTools'; tools: RegisteredTool[] }
  | { type: 'executeTool'; result: string | null }
  | { type: 'error'; message: string }
  | { type: 'toolchange' };


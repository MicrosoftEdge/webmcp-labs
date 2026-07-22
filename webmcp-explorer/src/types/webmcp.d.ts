// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * TypeScript types for the document.modelContext WebIDL interface
 * and the wire protocol between content script and side panel.
 */

/**
 * Hints returned for a registered tool. Edge fills omitted members with false
 * when the page supplies an annotations object.
 */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  untrustedContentHint: boolean;
}

/**
 * Tool projection sent over chrome.runtime messaging to the side panel.
 *
 * This is a *subset* of the real WebIDL RegisteredTool: the live `window`
 * reference and the `execute` callback can't be structured-cloned, so we drop
 * them. The content script re-resolves the full live tool by its unique
 * (origin, name) identity when dispatching executeTool.
 */
export interface RegisteredTool {
  name: string;
  origin: string;
  description: string;
  /** JSON-encoded schema describing the tool's input parameters. */
  inputSchema?: string;
  title?: string;
  annotations?: ToolAnnotations;
}

/**
 * Messages sent from the side panel to the content script.
 */
export type BridgeRequest =
  | { type: 'ping' }
  | { type: 'listTools' }
  | { type: 'executeTool'; name: string; origin: string; args: string };

/**
 * Messages sent from the content script back to the side panel.
 */
export type BridgeResponse =
  | { type: 'pong' }
  | { type: 'listTools'; tools: RegisteredTool[]; topOrigin: string }
  | { type: 'executeTool'; result: string | null }
  | { type: 'error'; message: string }
  | { type: 'toolchange' };

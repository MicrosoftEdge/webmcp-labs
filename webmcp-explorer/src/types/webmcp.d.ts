// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * TypeScript types for the document.modelContext WebIDL interface
 * and the wire protocol between content script and side panel.
 */

/**
 * Hints returned for a registered tool. Chromium fills omitted members with false
 * when the page supplies an annotations object.
 */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  untrustedContentHint: boolean;
  consequentialHint: boolean;
  debugging: boolean;
}

/**
 * Tool projection sent over chrome.runtime messaging to the side panel.
 *
 * This is a serializable projection of the browser's Tool object, without
 * its live `window` reference. The content script re-resolves the live tool
 * by its (origin, name) identity when dispatching executeTool.
 */
export interface RegisteredTool {
  name: string;
  origin: string;
  description: string;
  /** JSON-encoded in older Chromium versions; an object in newer versions. */
  inputSchema?: unknown;
  /** Friendly display name, or an empty string when registration omitted it. */
  title: string;
  annotations?: ToolAnnotations | null;
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

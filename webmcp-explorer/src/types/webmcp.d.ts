// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * TypeScript types for the ModelContextTesting WebIDL interface.
 */

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema?: string;
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

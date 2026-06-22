// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Build the LLM-facing tool list from a raw WebMCP tool snapshot.
 *
 * Real WebMCP tool names can contain characters that aren't valid in LLM
 * tool names (OpenAI / Anthropic require `[A-Za-z0-9_-]{1,64}`). We sanitize
 * each name to a `safeName` and keep a small alias map so we can route the
 * LLM's tool_call back to the original WebMCP tool name.
 *
 * Collision handling: if two raw names sanitize to the same `safeName`, we
 * suffix `_2`, `_3`, ... in registration order. This preserves uniqueness
 * without any opaque-id system — a dev-tool simplification that matches the
 * rest of the explorer's last-write-wins approach to name conflicts.
 *
 * Origin and title (when present) are folded into the description so the
 * model has provenance and a friendlier label without taking over the name.
 */

import type { ToolDefinition } from './llm/provider';
import type { RegisteredTool } from '../types/webmcp.d';

const VALID_NAME = /^[A-Za-z0-9_-]+$/;
const MAX_NAME_LEN = 64;

function sanitizeName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, MAX_NAME_LEN);
  // Edge case: if the raw name was entirely invalid chars, fall back to a stub.
  return cleaned.length > 0 ? cleaned : 'tool';
}

function buildDescription(t: RegisteredTool): string {
  const parts: string[] = [];
  if (t.title && t.title !== t.name) parts.push(`(${t.title})`);
  if (t.description) parts.push(t.description);
  parts.push(`[origin: ${t.origin}]`);
  return parts.join(' ');
}

export interface BuiltLlmTools {
  tools: ToolDefinition[];
  /** Maps sanitized name → original WebMCP tool name for dispatch. */
  aliasToName: Map<string, string>;
}

export function buildLlmTools(rawTools: RegisteredTool[]): BuiltLlmTools {
  const tools: ToolDefinition[] = [];
  const aliasToName = new Map<string, string>();
  const used = new Set<string>();

  for (const t of rawTools) {
    let safe = VALID_NAME.test(t.name) && t.name.length <= MAX_NAME_LEN
      ? t.name
      : sanitizeName(t.name);

    if (used.has(safe)) {
      let i = 2;
      // Trim base so suffix fits within MAX_NAME_LEN.
      while (used.has(`${safe.slice(0, MAX_NAME_LEN - `_${i}`.length)}_${i}`)) i++;
      safe = `${safe.slice(0, MAX_NAME_LEN - `_${i}`.length)}_${i}`;
    }
    used.add(safe);
    aliasToName.set(safe, t.name);

    const parameters =
      t.inputSchema && typeof t.inputSchema === 'object'
        ? (t.inputSchema as Record<string, unknown>)
        : { type: 'object', properties: {} };

    tools.push({
      name: safe,
      description: buildDescription(t),
      parameters,
    });
  }

  return { tools, aliasToName };
}

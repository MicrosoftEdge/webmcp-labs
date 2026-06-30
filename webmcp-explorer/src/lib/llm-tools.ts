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
 * Registered tools are unique by (origin, name), but the LLM only sees a flat
 * `name`, which introduces two collision sources that uniqueness doesn't cover:
 * (1) sanitization can map two distinct raw names to the same `safeName`, and
 * (2) a page tool can share a name with a reserved built-in passed in by the
 * caller. In either case we suffix `_2`, `_3`, ... in registration order to
 * keep the flattened names unique.
 *
 * Origin and title (when present) are folded into the description so the
 * model has provenance and a friendlier label without taking over the name.
 */

import type { ToolDefinition } from './llm/provider';
import type { RegisteredTool } from '../types/webmcp.d';
import { coerceSchemaObject } from './schema';

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
  /** Maps sanitized LLM name → the original tool's (origin, name) for dispatch. */
  aliasToTool: Map<string, { name: string; origin: string }>;
}

/**
 * Build the LLM-facing tool list. Pass `reservedNames` to keep certain
 * sanitized names off-limits for page tools — useful when the caller
 * appends built-in tools (e.g. `task_complete`, `ask_user`) after the
 * page tools, so a page registering one of those names is forced to an
 * `_2` suffix instead of shadowing the built-in.
 */
export function buildLlmTools(
  rawTools: RegisteredTool[],
  reservedNames: Iterable<string> = []
): BuiltLlmTools {
  const tools: ToolDefinition[] = [];
  const aliasToTool = new Map<string, { name: string; origin: string }>();
  const used = new Set<string>(reservedNames);

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
    aliasToTool.set(safe, { name: t.name, origin: t.origin });

    // Page tools may expose inputSchema as an object or a JSON string; coerce
    // both so the model sees real parameters instead of an empty schema.
    const parameters =
      coerceSchemaObject(t.inputSchema) ?? { type: 'object', properties: {} };

    tools.push({
      name: safe,
      description: buildDescription(t),
      parameters,
    });
  }

  return { tools, aliasToTool };
}

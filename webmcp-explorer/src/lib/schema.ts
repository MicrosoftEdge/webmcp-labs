// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Coerce a tool's raw `inputSchema` into a usable JSON Schema object.
 *
 * The production `document.modelContext` surface hands back `inputSchema` as a
 * live object, but third-party pages aren't always so tidy: some still provide
 * it as a JSON-encoded string (the common MCP pattern). We accept both so the
 * explorer can introspect any page's tools rather than silently treating a
 * stringified schema as "no schema".
 *
 * Returns the schema object, or `null` when there's nothing usable.
 */
export function coerceSchemaObject(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  return null;
}

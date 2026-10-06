// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Coerce a tool's raw `inputSchema` into a usable JSON Schema object.
 *
 * Current Chromium returns `inputSchema` from `document.modelContext.getTools()`
 * as an object. We also accept JSON-encoded strings for older browser versions
 * and test fixtures.
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

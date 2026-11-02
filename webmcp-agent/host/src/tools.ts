// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
import { randomBytes } from 'node:crypto';
import { namePageTools, type NamedPageTool } from '@webmcp-agent/shared/toolNames';
import type { PageContext, PageTool, ToHost } from '@webmcp-agent/shared/protocol';

interface ToolRegistry {
  routes: Map<string, NamedPageTool & { tabId: number }>;
  declarations: {
    name: string; description: string; parameters: Record<string, unknown>;
    skipPermission: boolean; defer: 'never'; metadata: Record<string, unknown>;
  }[];
}
export async function buildToolRegistry(page: PageContext, tools: PageTool[]): Promise<ToolRegistry> {
  const named = await namePageTools(tools, page.origin);
  return {
    routes: new Map(named.map(entry => [entry.sdkName, { ...entry, tabId: page.tabId }])),
    declarations: named.map(entry => ({
      name: entry.sdkName, description: entry.description,
      parameters: entry.tool.inputSchema ?? { type: 'object', properties: {} },
      skipPermission: true, defer: 'never' as const,
      metadata: { 'webmcp-agent/origin': entry.tool.origin, 'webmcp-agent/annotations': entry.tool.annotations },
    })),
  };
}

type ToolOutcome = Extract<ToHost, { type: 'tool_result' }>;
export function toolResultForModel(outcome: ToolOutcome, tool: PageTool, sdkName: string, limit: number, navigation?: string) {
  if (!outcome.ok) return {
    resultType: 'failure' as const,
    textResultForLlm: `Tool failed: ${outcome.error.name.slice(0, 100)}: ${outcome.error.message.slice(0, 500)}` +
      (navigation ? `\nNote: the page navigated to ${JSON.stringify(navigation)}. The tool list was updated.` : ''),
  };
  let text = outcome.result ?? 'The tool finished with no result. The page may have navigated.';
  if (text.length > limit) text = text.slice(0, limit) + `\n[Result truncated: ${limit} of ${text.length} characters shown]`;
  if (navigation) text += `\nNote: the page navigated to ${JSON.stringify(navigation)}. The tool list was updated.`;
  if (tool.annotations.untrustedContentHint) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const id = [...randomBytes(8)].map(byte => alphabet[byte % 32]).join('');
    text = text.replaceAll(id, '');
    text = `<untrusted-page-data id="${id}" origin="${tool.origin}" tool="${sdkName}">\n${text}\n</untrusted-page-data id="${id}">`;
  }
  return { resultType: 'success' as const, textResultForLlm: text };
}

export function unwrapPageResult(text: string): string {
  return text.replace(/^<untrusted-page-data [^\n]+>\n/, '').replace(/\n<\/untrusted-page-data id="[A-Z2-7]{8}">$/, '');
}

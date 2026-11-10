// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { pageToolSchema, type PageTool } from './protocol.js';

export interface NamedPageTool {
  sdkName: string;
  tool: PageTool;
  description: string;
}

export function sanitizePageText(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/<\/?untrusted-page-data\b[^>]*>/gi, '');
}

async function shortHash(value: string, length: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const hexadecimal = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const hash = BigInt(`0x${hexadecimal}`) % (36n ** BigInt(length));
  return hash.toString(36).padStart(length, '0');
}

export async function originLabel(value: string): Promise<string> {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== value) {
    throw new TypeError('Expected a canonical HTTP(S) origin');
  }
  const hostname = url.hostname.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').slice(0, 20);
  return `${hostname}${url.port ? `_${url.port}` : ''}_${await shortHash(value, 6)}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hintLabels(tool: PageTool): string {
  const hints = [
    tool.annotations.readOnlyHint && 'read-only',
    tool.annotations.consequentialHint && 'consequential',
    tool.annotations.untrustedContentHint && 'returns untrusted content',
    tool.annotations.debugging && 'debug tool',
  ].filter(Boolean);
  return hints.length ? hints.join(', ') : 'none declared';
}

export async function namePageTools(tools: readonly PageTool[], topOrigin: string): Promise<NamedPageTool[]> {
  const keys = new Set<string>();
  const sorted = tools.map(tool => pageToolSchema.parse(tool)).sort((left, right) =>
    Number(right.isTopFrame) - Number(left.isTopFrame) ||
    Number(left.key.split(':')[0]) - Number(right.key.split(':')[0]) ||
    compareText(left.name, right.name));
  const usedNames = new Set<string>();
  const named: NamedPageTool[] = [];

  for (const tool of sorted) {
    if (keys.has(tool.key)) throw new TypeError(`Duplicate tool key: ${tool.key}`);
    keys.add(tool.key);
    if (tool.isTopFrame && tool.origin !== topOrigin) {
      throw new TypeError('Top-frame tool origin does not match the page');
    }
    const prefix = `${await originLabel(tool.origin)}__`;
    const namePart = tool.name.replace(/[^A-Za-z0-9_-]/g, '_');
    const hashSuffix = `_${await shortHash(tool.name, 4)}`;
    const fitName = (suffix: string) => {
      const available = 64 - prefix.length - suffix.length;
      const fitted = namePart.length > available
        ? namePart.slice(0, available - hashSuffix.length) + hashSuffix
        : namePart;
      return prefix + fitted + suffix;
    };
    let sdkName = fitName('');
    let ordinal = 2;
    while (usedNames.has(sdkName)) sdkName = fitName(`_${ordinal++}`);
    usedNames.add(sdkName);
    const location = tool.isTopFrame ? 'top page' : `embedded frame on ${topOrigin}`;
    const description = [
      `[WebMCP tool | origin: ${tool.origin} | ${location} | hints: ${hintLabels(tool)}]`,
      `[title: ${JSON.stringify(sanitizePageText(tool.title ?? ''))} | WebMCP name: ${JSON.stringify(tool.name)}]`,
      sanitizePageText(tool.description).slice(0, 2000),
    ].join('\n');
    named.push({ sdkName, tool, description });
  }
  return named;
}

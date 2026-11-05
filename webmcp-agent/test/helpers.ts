// Copyright (c) Microsoft Corporation. Licensed under the MIT License.

import type { PageContext, PageTool } from '../shared/src/protocol.js';

export const page: PageContext = {
  tabId: 7,
  url: 'https://pizza.example/menu',
  title: 'Pizza menu',
  origin: 'https://pizza.example',
};

export const chatId = 'webmcp-agent-12345678';

export function pageTool(overrides: Partial<PageTool> = {}): PageTool {
  return {
    key: '0:search',
    name: 'search',
    description: 'Search the menu.',
    origin: page.origin,
    isTopFrame: true,
    annotations: {
      readOnlyHint: false,
      untrustedContentHint: false,
      consequentialHint: false,
      debugging: false,
    },
    ...overrides,
  };
}

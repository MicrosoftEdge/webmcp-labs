// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App, HintChips, QuestionCard, PauseCard, ModelPicker } from '../extension/src/sidepanel/App.js';
import { contentRequestSchema, contentResponseSchema, panelRequestSchema, TabBinding, trustedFrameOrigins } from '../extension/src/messages.js';
import { chatId, pageTool } from './helpers.js';

describe('tab binding state machine', () => {
  it('pauses off the bound tab and resumes on switching back without rebinding', () => {
    const binding = new TabBinding();
    binding.begin(7);
    binding.activate(8);
    expect(binding.paused).toBe(true);
    expect(binding.boundTabId).toBe(7);
    binding.activate(7);
    expect(binding.paused).toBe(false);
    binding.activate(8);
    binding.continue();
    expect(binding.paused).toBe(false);
    expect(binding.boundTabId).toBe(7);
    binding.stop();
    binding.activate(9);
    expect(binding.running).toBe(false);
    expect(binding.paused).toBe(false);
  });
  it('filters non-trustworthy frame origins and deduplicates genuine origins', () => {
    expect(trustedFrameOrigins([
      { url: 'http://remote.example/frame' }, { url: 'https://secure.example/a' },
      { url: 'https://secure.example/b' }, { url: 'http://localhost:9000/a' },
      { url: 'http://127.0.0.1:9001/b' }, { url: 'http://localhost.evil/' },
      { url: 'data:text/plain,x' }, { url: 'about:blank' }, { url: 'invalid' },
    ], 'http://localhost:9000')).toEqual(['http://127.0.0.1:9001', 'https://secure.example']);
  });
  it('validates extension messages and rejects primitive execution arguments', () => {
    expect(contentRequestSchema.safeParse({ type: 'webmcp/execute', callId: 'test', key: '0:search', args: {} }).success).toBe(true);
    expect(contentRequestSchema.safeParse({ type: 'webmcp/execute', callId: 'test', key: '0:search', args: 'not-an-object' }).success).toBe(false);
    expect(contentResponseSchema.safeParse({ type: 'webmcp/snapshot', available: true, tools: [pageTool()] }).success).toBe(true);
    expect(panelRequestSchema.safeParse({ type: 'send', text: '', extra: true }).success).toBe(false);
    expect(panelRequestSchema.safeParse({ type: 'executeTool', name: 'search' }).success).toBe(false);
  });
});

describe('panel cards', () => {
  it('uses an accessible plus button and does not render a model picker in the header', () => {
    const markup = renderToStaticMarkup(createElement(App));
    expect(markup).toContain('aria-label="New chat"');
    expect(markup).toContain('title="New chat"');
    expect(markup).toContain('fui-Button__icon');
    expect(markup.match(/<header[\s\S]*?<\/header>/)?.[0]).not.toContain('<select');
  });
  it('shows one Auto model and preserves SDK model names and billing labels', () => {
    const markup = renderToStaticMarkup(createElement(ModelPicker, {
      model: '', models: [{ id: 'auto', name: 'Auto' }, { id: 'sdk-model', name: 'SDK model', multiplier: 2 }],
      disabled: false, onChange: () => {},
    }));
    expect(markup).toContain('aria-label="Model"');
    expect(markup.match(/value="auto"/g)).toHaveLength(1);
    expect(markup).toContain('SDK model (2x)');
    expect(markup).toContain('value="sdk-model"');
  });
  it('renders the four declared annotation chips with a consequential warning class', () => {
    const markup = renderToStaticMarkup(createElement(HintChips, { tool: pageTool({
      annotations: { readOnlyHint: true, consequentialHint: true, untrustedContentHint: true, debugging: true },
    }) }));
    for (const label of ['Read-only', 'Consequential', 'Untrusted output', 'Debug']) expect(markup).toContain(label);
    expect(markup).toMatch(/class="[^"]*\bdanger\b/);
  });
  it('renders only offered choices when free-form answers are disabled', () => {
    const markup = renderToStaticMarkup(createElement(QuestionCard, {
      question: { type: 'question', chatId, requestId: 'test', question: '<script>unsafe</script>', choices: ['Yes'], allowFreeform: false },
      onAnswer: () => {},
    }));
    expect(markup).toContain('Yes');
    expect(markup).not.toContain('<input');
    expect(markup).not.toContain('<script>');
  });
  it('renders a free-form input and two explicit tab-pause actions', () => {
    const question = renderToStaticMarkup(createElement(QuestionCard, {
      question: { type: 'question', chatId, requestId: 'test', question: 'Choose', allowFreeform: true }, onAnswer: () => {},
    }));
    expect(question).toContain('<input');
    const pause = renderToStaticMarkup(createElement(PauseCard, { onContinue: () => {}, onStop: () => {} }));
    expect(pause).toContain('Continue there');
    expect(pause).toContain('Stop');
  });
});

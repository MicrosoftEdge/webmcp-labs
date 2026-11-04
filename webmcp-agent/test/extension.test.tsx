// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SSRProvider } from '@fluentui/react-components';
import { App, HintChips, QuestionCard, PauseCard, ModelBadge, ModelPicker, AbortNotice, SettingsToggle } from '../extension/src/sidepanel/App.js';
import { contentRequestSchema, contentResponseSchema, panelRequestSchema, TabBinding, trustedFrameOrigins } from '../extension/src/messages.js';
import { chatId, pageTool } from './helpers.js';

const renderFluent = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(SSRProvider, null, element));

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
  it('uses the same accessible label/description layout for Settings switches and preserves the sensitive-data warning', () => {
    const markup = renderFluent(createElement(SettingsToggle, {
      label: 'Verbose host logs', description: 'Logs may contain sensitive data.',
      checked: false, sensitive: true, onChange: () => {},
    }));
    expect(markup).toContain('fui-Switch');
    expect(markup).toContain('aria-label="Verbose host logs"');
    expect(markup).toContain('aria-describedby=');
    expect(markup).toContain('settings-control-title');
    expect(markup).toContain('settings-description warning-text');
    expect(markup).toContain('Logs may contain sensitive data.');
    expect(markup).not.toContain('fui-Card');
  });
  it('renders a quiet cancellation notice, not a completed or failed task label', () => {
    const markup = renderFluent(createElement(AbortNotice, { reason: 'user_initiated' }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain('Response stopped');
    expect(markup).not.toContain('fui-MessageBar');
    expect(markup).not.toContain('Done');
    expect(renderFluent(createElement(AbortNotice, { reason: 'autopilot_credit_limit' }))).toContain('credit limit reached');
  });
  it('integrates navigation and accessible icon actions without duplicating the browser title', () => {
    const markup = renderFluent(createElement(App));
    expect(markup).toContain('aria-label="New chat"');
    expect(markup).toContain('fui-Button__icon');
    expect(markup.match(/<header[\s\S]*?<\/header>/)?.[0]).not.toContain('<select');
    expect(markup.match(/<header[\s\S]*?<\/header>/)?.[0]).toContain('aria-label="Views"');
    expect(markup.match(/<header[\s\S]*?<\/header>/)?.[0]).not.toContain('WebMCP Agent');
    expect(markup).not.toContain('aria-label="Settings" role="tab"');
  });
  it('renders one native Auto choice without an editable search field or custom popup', () => {
    const markup = renderFluent(createElement(ModelPicker, {
      model: '', models: [{ id: 'auto', name: 'Auto' }, { id: 'sdk-model', name: 'SDK model', multiplier: 2 }],
      disabled: false, onChange: () => {},
    }));
    expect(markup).toContain('aria-label="Model"');
    expect(markup.match(/value="auto"/g)).toHaveLength(1);
    expect(markup).toContain('<select');
    expect(markup).toContain('SDK model (2x)');
    expect(markup).toContain('value="sdk-model"');
    expect(markup).not.toContain('<input');
    expect(markup).not.toContain('role="listbox"');
  });
  it('preserves long SDK labels and disabled model controls', () => {
    const markup = renderFluent(createElement(ModelPicker, {
      model: 'sdk-model', models: [{ id: 'sdk-model', name: 'SDK model with a long name' }],
      disabled: true, onChange: () => {},
    }));
    expect(markup).toContain('title="SDK model with a long name"');
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain('<input');
  });
  it('retains the selected model ID while the SDK model list is loading', () => {
    const markup = renderFluent(createElement(ModelPicker, {
      model: 'sdk-model', models: [], disabled: false, onChange: () => {},
    }));
    expect(markup).toContain('value="sdk-model" selected=""');
  });
  it('renders only the concrete SDK model in compact response metadata', () => {
    const markup = renderFluent(createElement(ModelBadge, {
      model: { id: 'gpt-test', name: 'GPT Test', isAuto: true },
    }));
    expect(markup).toContain('GPT Test');
    expect(markup).not.toContain('Auto · used');
  });
  it('renders the four declared annotation chips with a consequential warning class', () => {
    const markup = renderFluent(createElement(HintChips, { tool: pageTool({
      annotations: { readOnlyHint: true, consequentialHint: true, untrustedContentHint: true, debugging: true },
    }) }));
    for (const label of ['Read-only', 'Consequential', 'Untrusted output', 'Debug']) expect(markup).toContain(label);
  });
  it('keeps consequential hints visible in compact tool rows without routine badge clutter', () => {
    const markup = renderFluent(createElement(HintChips, { compact: true, tool: pageTool({
      annotations: { readOnlyHint: true, consequentialHint: true, untrustedContentHint: true, debugging: true },
    }) }));
    expect(markup).toContain('Consequential');
    for (const label of ['Read-only', 'Untrusted output', 'Debug']) expect(markup).not.toContain(label);
  });
  it('presents the question itself without a boxed Card or duplicate Question heading', () => {
    const markup = renderFluent(createElement(QuestionCard, {
      question: { type: 'question', chatId, requestId: 'test', question: 'How would you like to order?',
        choices: ['Delivery', 'Carryout'], allowFreeform: true }, onAnswer: () => {},
    }));
    expect(markup).toContain('aria-label="Question"');
    expect(markup).toContain('How would you like to order?');
    expect(markup).not.toContain('>Question<');
    expect(markup).not.toContain('fui-Card');
    expect(markup).toContain('question-choices');
    expect(markup).toContain('placeholder="Or type your own answer"');
    expect(markup).toContain('aria-label="Your answer"');
    expect(markup).toContain('aria-label="Send answer"');
    expect(markup).toContain('disabled=""');
  });
  it('does not render an empty choices group for free-form-only SDK questions', () => {
    const markup = renderFluent(createElement(QuestionCard, {
      question: { type: 'question', chatId, requestId: 'test', question: 'What would you like?',
        choices: [], allowFreeform: true }, onAnswer: () => {},
    }));
    expect(markup).not.toContain('question-choices');
    expect(markup).toContain('placeholder="Type your answer"');
  });
  it('renders only offered choices when free-form answers are disabled', () => {
    const markup = renderFluent(createElement(QuestionCard, {
      question: { type: 'question', chatId, requestId: 'test', question: '<script>unsafe</script>', choices: ['Yes'], allowFreeform: false },
      onAnswer: () => {},
    }));
    expect(markup).toContain('Yes');
    expect(markup).not.toContain('<input');
    expect(markup).not.toContain('<script>');
  });
  it('renders a free-form input and two explicit tab-pause actions', () => {
    const question = renderFluent(createElement(QuestionCard, {
      question: { type: 'question', chatId, requestId: 'test', question: 'Choose', allowFreeform: true }, onAnswer: () => {},
    }));
    expect(question).toContain('<input');
    const pause = renderFluent(createElement(PauseCard, { onContinue: () => {}, onStop: () => {} }));
    expect(pause).toContain('Continue there');
    expect(pause).toContain('Stop');
    expect(pause).not.toContain('fui-Card');
  });
});

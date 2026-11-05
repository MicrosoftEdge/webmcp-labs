// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
import { test, expect, chatId, question } from './fixtures.js';
import type { HistoryItem } from '../shared/src/protocol.js';

test('long conversations stay in their viewport through questions, answers and streaming', async ({ panel, page }) => {
  const history: HistoryItem[] = Array.from({ length: 16 }, (_, index) => [
    { kind: 'user' as const, text: `Message ${index + 1}` },
    { kind: 'assistant' as const, text: `Response ${index + 1}\n\n${'Previous conversation text. '.repeat(16)}` },
  ]).flat();
  await panel.history(history);
  await panel.startFrameMonitor();
  await panel.emit({ type: 'status', chatId, state: 'running' }, question);
  await expect(page.getByRole('region', { name: 'Question', exact: true })).toBeInViewport();
  await page.getByRole('button', { name: 'Show me the menu', exact: true }).click();
  await panel.expectRequests([{ type: 'answer', requestId: question.requestId, answer: 'Show me the menu', wasFreeform: false }]);
  await panel.emit({ ...question, requestId: 'freeform-question' });
  await page.getByRole('textbox', { name: 'Your answer', exact: true }).fill('Carryout, please');
  await page.getByRole('textbox', { name: 'Your answer', exact: true }).press('Enter');
  await panel.expectRequests([
    { type: 'answer', requestId: question.requestId, answer: 'Show me the menu', wasFreeform: false },
    { type: 'answer', requestId: 'freeform-question', answer: 'Carryout, please', wasFreeform: true },
  ]);
  for (let index = 0; index < 8; index++) {
    await panel.emit({ type: 'delta', chatId, text: 'Streaming reply. ' });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  }
  const viewport = page.locator('.conversation-scroll');
  await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
  await viewport.evaluate(element => { element.scrollTop = 0; });
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await panel.emit({ type: 'delta', chatId, text: 'Do not move a reader who scrolled up.' });
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0);
  await panel.emit({ type: 'status', chatId, state: 'idle' });
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Continue');
  await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
  await panel.emit({ type: 'user', text: 'Continue' }, { type: 'status', chatId, state: 'running' });
  await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(2);
  await panel.expectStableFrames();
});

test('composer grows within its limit and retains one shared surface and focus indicator', async ({ panel, page }) => {
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  const picker = page.getByRole('combobox', { name: 'Model' });
  const initialHeight = await input.evaluate(element => element.getBoundingClientRect().height);
  await input.fill(Array.from({ length: 24 }, (_, index) => `Line ${index + 1}`).join('\n'));
  expect(await input.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(initialHeight);
  expect(await input.evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(144);
  await input.fill('');
  await input.focus();
  await input.press('Tab');
  await expect(picker).toBeFocused();
  const surfaces = await page.locator('.composer').evaluate(element => {
    const root = document.querySelector('#root > .app-provider');
    const shell = element.querySelector('.composer-surface');
    if (!root || !shell) throw new Error('Missing composer surfaces');
    return {
      canvas: getComputedStyle(root).backgroundColor,
      footer: getComputedStyle(element).backgroundColor,
      shellOutline: getComputedStyle(shell).outlineStyle,
      shellBorder: getComputedStyle(shell).borderColor,
      shellBackground: getComputedStyle(shell).backgroundColor,
      fields: Array.from(element.querySelectorAll('textarea, select, .fui-Textarea'), field => {
        const style = getComputedStyle(field);
        return { border: style.borderTopWidth, background: style.backgroundColor, outline: style.outlineStyle };
      }),
      indicators: Array.from(element.querySelectorAll('.fui-Textarea, .model-picker'), field =>
        getComputedStyle(field, '::after').display),
    };
  });
  expect(surfaces.footer).toBe(surfaces.canvas);
  expect(surfaces.shellOutline).toBe('none');
  expect(surfaces.shellBorder).not.toBe(surfaces.shellBackground);
  for (const field of surfaces.fields) {
    expect(field).toEqual({ border: '0px', background: 'rgba(0, 0, 0, 0)', outline: 'none' });
  }
  expect(surfaces.indicators).toEqual(['none', 'none']);
  await panel.emit({ type: 'status', chatId, state: 'running' });
  await expect(input).toBeDisabled();
  await expect(picker).toBeDisabled();
  await expect(input).toHaveCSS('border-top-width', '0px');
  await expect(picker).toHaveCSS('border-top-width', '0px');
  await panel.emit({ type: 'status', chatId, state: 'idle' });
  await expect(input).toBeEnabled();
  await page.emulateMedia({ forcedColors: 'active' });
  await input.focus();
  await expect.poll(() => page.locator('.composer-surface').evaluate(element => {
    const style = getComputedStyle(element);
    return style.outlineStyle === 'solid' && parseFloat(style.outlineWidth) > 0;
  })).toBe(true);
});

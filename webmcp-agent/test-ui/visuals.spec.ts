// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
import { test, expect, chatId, conversation, question, menuTool } from './fixtures.js';
import type { Locator } from '@playwright/test';

async function expectFontFamily(locator: Locator, expectedFontFamily: string) {
  const fontFamilies = await locator.evaluateAll(elements =>
    [...new Set(elements.map(element => getComputedStyle(element).fontFamily))]);
  expect(fontFamilies).toEqual([expectedFontFamily]);
}

async function expectReadableText(locator: Locator) {
  const colors = await locator.evaluateAll(elements => elements.map(element => {
    let ancestor: Element | null = element;
    let background = 'rgba(0, 0, 0, 0)';
    while (ancestor && background === 'rgba(0, 0, 0, 0)') {
      background = getComputedStyle(ancestor).backgroundColor;
      ancestor = ancestor.parentElement;
    }
    return { foreground: getComputedStyle(element).color, background };
  }));
  const luminance = (color: string) => {
    const components = color.match(/[\d.]+/g);
    if (!components) throw new Error(`Unexpected computed color: ${color}`);
    const [red, green, blue] = components.slice(0, 3).map(Number).map(value => value / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    if (red === undefined || green === undefined || blue === undefined) throw new Error(`Unexpected computed color: ${color}`);
    return red * 0.2126 + green * 0.7152 + blue * 0.0722;
  };
  expect(colors.length).toBeGreaterThan(0);
  for (const { foreground, background } of colors) {
    const foregroundLuminance = luminance(foreground);
    const backgroundLuminance = luminance(background);
    expect((Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
      (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)).toBeGreaterThanOrEqual(4.5);
  }
}

test('panel surfaces retain their reviewed visual appearance', async ({ panel, page }) => {
  test.skip(process.platform !== 'win32', 'Visual baselines use Windows fonts; interaction tests run on every OS.');
  const fontFamilies = await page.locator('#root > .app-provider').evaluate(provider => {
    const reference = document.createElement('span');
    provider.appendChild(reference);
    reference.style.fontFamily = 'var(--fontFamilyBase)';
    const base = getComputedStyle(reference).fontFamily;
    reference.style.fontFamily = 'var(--fontFamilyMonospace)';
    const monospace = getComputedStyle(reference).fontFamily;
    reference.remove();
    return { base, monospace };
  });
  const fontWeights: Record<string, string> = {};
  const readFontWeight = (locator: Locator) => locator.evaluate(element => getComputedStyle(element).fontWeight);
  fontWeights.welcomeHeading = await readFontWeight(page.locator('.empty-welcome h1'));
  await expectFontFamily(page.locator('.empty-welcome h1, .empty-welcome p, .app-header .fui-Tab, .composer textarea, .model-picker select, .model-picker option'), fontFamilies.base);
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('empty-chat.png');
  await page.getByRole('button', { name: 'New chat' }).hover();
  await expect(page.getByRole('tooltip', { name: 'New chat', exact: true })).toBeVisible();
  await expectFontFamily(page.getByRole('tooltip', { name: 'New chat', exact: true }), fontFamilies.base);
  await expect(page).toHaveScreenshot('tooltip.png');
  await page.mouse.move(0, 0);

  await panel.history(conversation);
  await panel.emit({ type: 'status', chatId, state: 'running' }, question);
  await expect(page.getByRole('region', { name: 'Question', exact: true })).toBeVisible();
  fontWeights.chatBody = await readFontWeight(page.locator('.message.assistant .markdown p'));
  fontWeights.questionHeading = await readFontWeight(page.locator('.question-prompt'));
  fontWeights.questionChoice = await readFontWeight(page.locator('.question-choices button').first());
  await expectFontFamily(page.locator('.message.user .message-body, .message.assistant .markdown p, .fui-ChatMessage__author, .question-prompt, .question-choices button, .question-answer-control input'), fontFamilies.base);
  await page.getByRole('textbox', { name: 'Your answer' }).focus();
  await expect(page).toHaveScreenshot('question.png');

  await page.getByRole('tab', { name: 'Tools', exact: true }).click();
  await expect(page.locator('.tool-row')).toHaveCount(4);
  fontWeights.toolsHeading = await readFontWeight(page.locator('.tools-context h1'));
  fontWeights.toolGroupHeading = await readFontWeight(page.locator('.tool-group h2').first());
  fontWeights.toolTitle = await readFontWeight(page.locator('.tool-row-summary strong').first());
  fontWeights.toolsMetadata = await readFontWeight(page.locator('.tool-origin').first());
  await expectFontFamily(page.locator('.tools-context, .tool-group h2, .tool-row-summary strong, .tools-view .fui-Badge'), fontFamilies.base);
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('tools.png');
  const firstTool = page.locator('.tool-row').first();
  await firstTool.getByRole('button', { name: 'View menu' }).click();
  await expect.poll(() => firstTool.evaluate(element =>
    element.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running'))).toBe(true);
  await firstTool.getByRole('button', { name: 'Run manually' }).click();
  await expect(page.getByRole('textbox', { name: 'JSON arguments' })).toBeVisible();
  fontWeights.toolFieldLabel = await readFontWeight(page.locator('.manual-run .fui-Label'));
  fontWeights.toolFieldValue = await readFontWeight(page.getByRole('textbox', { name: 'JSON arguments' }));
  fontWeights.toolPrimaryAction = await readFontWeight(page.getByRole('button', { name: 'Execute tool' }));
  await panel.emit({ type: 'inspect_result', key: menuTool.key, ok: true, result: '{"items":["Margherita"]}' });
  await expect(page.getByRole('status')).toHaveText('{"items":["Margherita"]}');
  await expectFontFamily(page.locator('.tool-description, .tool-details summary, .manual-run .fui-Label, .manual-run .fui-Button'), fontFamilies.base);
  await expectFontFamily(page.locator('.manual-run textarea, .tool-technical pre, .tool-result pre'), fontFamilies.monospace);
  await expectReadableText(page.locator('.tools-view .neutral-badge'));
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('tool-details.png');

  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await panel.history(conversation);
  await panel.emit({
    type: 'tool_call', chatId, callId: 'menu-activity', sdkName: 'fixture__view_menu',
    key: menuTool.key, args: { category: 'pizza' }, tool: menuTool, origin: menuTool.origin, executionState: 'running',
  }, {
    type: 'tool_done', chatId, callId: 'menu-activity', ok: true, result: 'Margherita, Garden Veggie, Pepperoni',
  }, {
    type: 'message', chatId, text: '## Menu suggestions\n\nTry **Margherita** or *Garden Veggie*.\n\n- Fresh ingredients\n- Carryout available\n\n```ts\nconst category = "pizza";\n```',
  });
  await expect(page.getByRole('heading', { name: 'Menu suggestions' })).toBeVisible();
  fontWeights.toolActivityTitle = await readFontWeight(page.locator('.tool-summary-label strong'));
  fontWeights.markdownHeading = await readFontWeight(page.locator('.markdown h2'));
  fontWeights.markdownStrong = await readFontWeight(page.locator('.markdown strong'));
  await expectFontFamily(page.locator('.tool-summary-label strong, .markdown h2, .markdown p, .code-toolbar, .code-toolbar button'), fontFamilies.base);
  await expectFontFamily(page.locator('.markdown pre, .markdown pre code'), fontFamilies.monospace);
  await expectReadableText(page.locator('.message.assistant .markdown'));
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('tool-activity-markdown.png');

  await panel.emit({
    type: 'ready', protocolVersion: 1, hostVersion: '0.1.0', sdkVersion: '1.0.28', signedIn: true,
    dataPath: 'C:\\Users\\Developer\\AppData\\Local\\WebMCP Agent',
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conversation', exact: true })).toBeVisible();
  fontWeights.settingsHeading = await readFontWeight(page.locator('.settings-header strong'));
  fontWeights.settingsSection = await readFontWeight(page.locator('.settings-section h2').first());
  fontWeights.settingsFieldLabel = await readFontWeight(page.locator('.settings-field .fui-Label').first());
  fontWeights.settingsSwitchLabel = await readFontWeight(page.locator('.settings-control-title').first());
  fontWeights.settingsDescription = await readFontWeight(page.locator('.settings-description').first());
  fontWeights.settingsModelValue = await readFontWeight(page.getByRole('combobox', { name: 'Model' }));
  fontWeights.settingsNumberValue = await readFontWeight(page.getByRole('spinbutton', { name: 'Maximum tool-result characters' }));
  fontWeights.settingsDisclosure = await readFontWeight(page.getByRole('button', { name: 'Host details and logs' }));
  await expectFontFamily(page.locator('.settings-header strong, .settings-section h2, .settings-field .fui-Label, .settings-control-title, .settings-description, .model-picker select, .settings-field input, .settings-diagnostics button'), fontFamilies.base);
  const settingsLayout = await page.locator('.settings-view').evaluate(view => {
    const indicators = Array.from(view.querySelectorAll('.fui-Switch__indicator'), element => element.getBoundingClientRect().right);
    const model = view.querySelector('.model-picker')?.getBoundingClientRect();
    const number = view.querySelector('.fui-Input')?.getBoundingClientRect();
    const select = view.querySelector('select');
    const inputSurface = view.querySelector('.fui-Input');
    return {
      switchesAlign: indicators.length === 3 && Math.max(...indicators) - Math.min(...indicators) < 1,
      fieldsAlign: !!model && !!number && Math.abs(model.left - number.left) < 1 && Math.abs(model.width - number.width) < 1,
      fieldHeightsMatch: !!model && !!number && Math.abs(model.height - number.height) < 1,
      fieldRadiiMatch: !!select && !!inputSurface && getComputedStyle(select).borderRadius === getComputedStyle(inputSurface).borderRadius,
      fits: document.documentElement.scrollWidth <= innerWidth && scrollY === 0,
    };
  });
  expect(settingsLayout).toEqual({ switchesAlign: true, fieldsAlign: true, fieldHeightsMatch: true, fieldRadiiMatch: true, fits: true });
  await expectReadableText(page.locator('.settings-description, .settings-field .fui-Field__hint'));
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('settings.png');

  for (let index = 0; index < 6; index++) {
    await panel.emit({ type: 'log', time: '2026-11-03T12:00:00Z', level: 'info', text: `Synthetic diagnostic event ${index + 1}` });
  }
  await page.getByRole('button', { name: 'Host details and logs' }).click();
  await expect(page.locator('.settings-metadata')).toContainText('Signed in');
  await expect(page.locator('.settings-log')).toContainText('Synthetic diagnostic event 6');
  await expectFontFamily(page.locator('.settings-metadata dt, .settings-metadata dd, .settings-diagnostics h3, .settings-actions button'), fontFamilies.base);
  await expectFontFamily(page.locator('.settings-log, .settings-metadata code'), fontFamilies.monospace);
  await expect.poll(() => page.locator('.settings-diagnostics').evaluate(element =>
    element.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running'))).toBe(true);
  await page.locator('.settings-view').evaluate(view => { view.scrollTop = view.scrollHeight; });
  await expect(page.getByRole('button', { name: 'Clear WebMCP chats' })).toBeInViewport();
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('settings-diagnostics.png');

  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await panel.emit({ type: 'status', chatId, state: 'idle' }, { type: 'chats', chats: [
    { chatId, title: 'Contoso Pizza - Order Online', updatedAt: '2026-11-03T12:00:00Z' },
    { chatId: 'webmcp-agent-saved-second', title: 'Plan a carryout order', updatedAt: '2026-11-02T12:00:00Z' },
  ] });
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await expect(page.locator('.history-row')).toHaveCount(2);
  await expect(page.locator('.history-open').first()).toBeEnabled();
  const historyTitle = page.locator('.history-title').first();
  fontWeights.historyTitle = await readFontWeight(historyTitle);
  await expect(historyTitle).toHaveCSS('font-size', '14px');
  await expect(historyTitle).toHaveCSS('line-height', '20px');
  fontWeights.historyTimestamp = await readFontWeight(page.locator('.history-open small').first());
  await expectFontFamily(page.locator('.history-title, .history-open small'), fontFamilies.base);
  expect(fontWeights).toEqual({
    welcomeHeading: '600', chatBody: '400', questionHeading: '600', questionChoice: '400',
    toolsHeading: '600', toolGroupHeading: '600', toolTitle: '500', toolsMetadata: '400',
    toolFieldLabel: '500', toolFieldValue: '400', toolPrimaryAction: '400',
    toolActivityTitle: '500', markdownHeading: '600', markdownStrong: '700',
    settingsHeading: '600', settingsSection: '600', settingsFieldLabel: '500',
    settingsSwitchLabel: '500', settingsDescription: '400', settingsModelValue: '400',
    settingsNumberValue: '400', settingsDisclosure: '500', historyTitle: '400', historyTimestamp: '400',
  });
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('history.png');
});

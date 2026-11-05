// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
import { test, expect, chatId, conversation, question, menuTool } from './fixtures.js';
import type { Locator } from '@playwright/test';

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
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('empty-chat.png');
  await page.getByRole('button', { name: 'New chat' }).hover();
  await expect(page.getByRole('tooltip', { name: 'New chat', exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot('tooltip.png');
  await page.mouse.move(0, 0);

  await panel.history(conversation);
  await panel.emit({ type: 'status', chatId, state: 'running' }, question);
  await expect(page.getByRole('region', { name: 'Question', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Your answer' }).focus();
  await expect(page).toHaveScreenshot('question.png');

  await page.getByRole('tab', { name: 'Tools', exact: true }).click();
  await expect(page.locator('.tool-row')).toHaveCount(4);
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('tools.png');
  const firstTool = page.locator('.tool-row').first();
  await firstTool.getByRole('button', { name: 'View menu' }).click();
  await expect.poll(() => firstTool.evaluate(element =>
    element.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running'))).toBe(true);
  await firstTool.getByRole('button', { name: 'Run manually' }).click();
  await expect(page.getByRole('textbox', { name: 'JSON arguments' })).toBeVisible();
  await panel.emit({ type: 'inspect_result', key: menuTool.key, ok: true, result: '{"items":["Margherita"]}' });
  await expect(page.getByRole('status')).toHaveText('{"items":["Margherita"]}');
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
  await expectReadableText(page.locator('.message.assistant .markdown'));
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('tool-activity-markdown.png');

  await panel.emit({
    type: 'ready', protocolVersion: 1, hostVersion: '0.1.0', sdkVersion: '1.0.28', signedIn: true,
    dataPath: 'C:\\Users\\Developer\\AppData\\Local\\WebMCP Agent',
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Conversation', exact: true })).toBeVisible();
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
  await expect.poll(() => page.locator('.settings-diagnostics').evaluate(element =>
    element.getAnimations({ subtree: true }).every(animation => animation.playState !== 'running'))).toBe(true);
  await page.locator('.settings-view').evaluate(view => { view.scrollTop = view.scrollHeight; });
  await expect(page.getByRole('button', { name: 'Clear WebMCP chats' })).toBeInViewport();
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot('settings-diagnostics.png');
});

// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { test, expect, chatId, conversation, question, menuTool, pageContext, defaultSettings } from './fixtures.js';

test('composer sends once, respects multiline input, and stops the SDK turn', async ({ panel, page }) => {
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeDisabled();
  await input.fill('Help me');
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('Help me\n');
  await panel.expectRequests([]);
  await input.pressSequentially('choose a pizza');
  await input.press('Enter');
  await panel.expectRequests([{ type: 'send', text: 'Help me\nchoose a pizza' }]);
  await expect(input).toHaveValue('');
  await expect(page.getByRole('combobox', { name: 'Model' })).toBeVisible();
  await panel.startFrameMonitor();
  await panel.emit(
    { type: 'user', text: 'Help me\nchoose a pizza' },
    { type: 'status', chatId, state: 'running' },
  );
  await expect(input).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Model' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New chat' })).toBeDisabled();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await panel.expectRequests([{ type: 'send', text: 'Help me\nchoose a pizza' }, { type: 'stop' }]);
  await panel.emit({ type: 'status', chatId, state: 'idle' });
  await expect(input).toBeEnabled();
  await expect(page.locator('.abort-notice')).toHaveCount(0);
  await panel.expectStableFrames();
});

test('SDK abort shows one stopped notice and retains partial replies and saved history', async ({ panel, page }, testInfo) => {
  await panel.history(conversation);
  await panel.emit(
    { type: 'status', chatId, state: 'running' },
    { type: 'delta', chatId, messageId: 'stopped-reply', text: 'The partial reply is still here.' },
    question,
  );
  await panel.startFrameMonitor();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await panel.expectRequests([{ type: 'stop' }]);
  await expect(page.locator('.abort-notice')).toHaveCount(0);
  const stopped = { type: 'abort' as const, chatId, eventId: 'sdk-abort-one', reason: 'user_initiated' as const };
  await panel.emit(stopped, stopped);
  await expect(page.getByRole('status')).toHaveText('Response stopped');
  await expect(page.getByRole('region', { name: 'Question', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeDisabled();
  await panel.emit({ type: 'status', chatId, state: 'idle' });
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
  await expect(page.getByText('The partial reply is still here.', { exact: true })).toBeVisible();
  await testInfo.attach('stopped-response', { body: await page.screenshot(), contentType: 'image/png' });
  await panel.expectStableFrames();
  const historyNotice = { kind: 'abort' as const, eventId: stopped.eventId, reason: stopped.reason };
  await panel.history([
    ...conversation,
    { kind: 'assistant', messageId: 'stopped-reply', text: 'The partial reply is still here.' },
    historyNotice,
  ]);
  await panel.emit(stopped, { type: 'history', chatId, items: [historyNotice], done: true });
  const serialized = JSON.stringify(historyNotice);
  await panel.emit({ type: 'history_fragment', chatId, fragment: serialized, complete: true });
  await expect(page.locator('.abort-notice')).toHaveCount(1);
  await expect(page.getByText('The partial reply is still here.', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Continue');
  await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
  await panel.expectRequests([{ type: 'stop' }, { type: 'send', text: 'Continue' }]);
});

test('SDK errors and idle do not invent a stopped-response notice', async ({ panel, page, consoleErrors }) => {
  await panel.history(conversation);
  await panel.emit(
    { type: 'error', chatId, code: 'sdk_error', message: 'Synthetic SDK error' },
    { type: 'status', chatId, state: 'idle' },
  );
  await expect(page.getByText('Synthetic SDK error', { exact: true })).toBeVisible();
  await expect(page.locator('.abort-notice')).toHaveCount(0);
  expect(consoleErrors.splice(0)).toEqual([expect.stringContaining('WebMCP Agent host error')]);
});

test('native model picker keeps all choices and does not send on open or dismissal', async ({ panel, page }) => {
  const picker = page.getByRole('combobox', { name: 'Model' });
  await expect(picker).toHaveJSProperty('tagName', 'SELECT');
  await expect(picker.locator('option')).toHaveCount(32);
  const originalLayout = await page.locator('main').boundingBox();
  for (let attempt = 0; attempt < 3; attempt++) {
    await picker.click();
    await picker.press('Escape');
  }
  await panel.expectRequests([]);
  expect(await page.locator('main').boundingBox()).toEqual(originalLayout);
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await picker.selectOption('gpt-test');
  await panel.expectRequests([{ type: 'set_model', model: 'gpt-test' }]);
  await picker.selectOption('gpt-test');
  await panel.expectRequests([{ type: 'set_model', model: 'gpt-test' }]);
  await picker.focus();
  await picker.press('Home');
  await panel.expectRequests([{ type: 'set_model', model: 'gpt-test' }, { type: 'set_model', model: 'auto' }]);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Model' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Views' })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Model' }).selectOption('model-29');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Model' })).toHaveValue('model-29');
  await panel.expectRequests([
    { type: 'set_model', model: 'gpt-test' }, { type: 'set_model', model: 'auto' },
    { type: 'logs', follow: true }, { type: 'set_model', model: 'model-29' }, { type: 'logs', follow: false },
  ]);
});

test('Settings controls share a consistent layout and preserve preferences, diagnostics and confirmation behavior', async ({ panel, page, consoleErrors }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Settings', exact: true })).toBeVisible();
  expect(await page.locator('.settings-section > h2').allTextContents()).toEqual(['Conversation', 'Page tools', 'Diagnostics', 'Data and privacy']);
  await expect(page.getByRole('combobox', { name: 'Model' })).toBeEnabled();
  await expect(page.getByRole('switch', { name: 'Show reasoning', exact: true })).toHaveAccessibleDescription('Display reasoning when the model provides it.');
  await page.getByRole('switch', { name: 'Show reasoning', exact: true }).uncheck();
  await page.getByRole('switch', { name: 'Include debugging tools', exact: true }).check();
  await page.getByRole('spinbutton', { name: 'Maximum tool-result characters' }).fill('24000');
  await page.getByRole('switch', { name: 'Verbose host logs', exact: true }).check();
  const expectedSettings = [
    { ...defaultSettings, showReasoning: false },
    { ...defaultSettings, showReasoning: false, includeDebug: true },
    { ...defaultSettings, showReasoning: false, includeDebug: true, maxToolResultChars: 24000 },
    { ...defaultSettings, showReasoning: false, includeDebug: true, maxToolResultChars: 24000, verboseLogs: true },
  ];
  await panel.expectRequests([{ type: 'logs', follow: true }, ...expectedSettings.map(settings => ({ type: 'settings' as const, settings }))]);
  await page.getByRole('button', { name: 'Host details and logs' }).click();
  await expect(page.getByText('No host logs yet.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy logs' })).toBeDisabled();
  const time = '2026-11-03T12:00:00Z';
  await panel.emit({ type: 'log', time, level: 'info', text: 'Synthetic diagnostic event' });
  await page.getByRole('button', { name: 'Copy logs' }).click();
  await expect(page.getByRole('status')).toHaveText('Logs copied.');
  expect(await page.evaluate(() => window.agentUiTest.copiedText)).toBe(`${time} info Synthetic diagnostic event`);
  await page.evaluate(() => { window.agentUiTest.clipboardFailure = true; });
  await page.getByRole('button', { name: 'Copy logs' }).click();
  await expect(page.getByRole('alert')).toHaveText('Could not copy logs. Select and copy the text above.');
  expect(consoleErrors.splice(0)).toEqual([expect.stringContaining('WebMCP Agent could not copy host logs')]);
  await page.getByRole('button', { name: 'Reconnect host' }).click();
  page.once('dialog', dialog => { void dialog.dismiss(); });
  await page.getByRole('button', { name: 'Clear WebMCP chats' }).click();
  expect((await panel.requests()).filter(request => request.type === 'clear_chats')).toHaveLength(0);
  page.once('dialog', dialog => { void dialog.accept(); });
  await page.getByRole('button', { name: 'Clear WebMCP chats' }).click();
  expect((await panel.requests()).filter(request => request.type === 'clear_chats')).toHaveLength(1);
  await panel.emit({ type: 'status', chatId, state: 'running' });
  await expect(page.getByRole('combobox', { name: 'Model' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Clear WebMCP chats' })).toBeDisabled();
  await expect(page.getByRole('switch', { name: 'Show reasoning', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeDisabled();
  const requests = await panel.requests();
  expect(requests.slice(-3)).toEqual([{ type: 'reconnect' }, { type: 'clear_chats' }, { type: 'logs', follow: false }]);
});

test('Fluent tooltip portals never become full-height opaque overlays', async ({ panel, page }) => {
  await page.getByRole('button', { name: 'New chat' }).hover();
  await expect(page.getByRole('tooltip', { name: 'New chat', exact: true })).toBeVisible();
  const portal = page.locator('[data-portal-node].app-provider');
  await expect(portal).toHaveCount(1);
  await expect(portal).toHaveCSS('min-height', '0px');
  expect(await portal.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(100);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('The panel remains interactive');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await panel.expectRequests([{ type: 'send', text: 'The panel remains interactive' }]);
});

test('question choices and free-form-only answers preserve SDK semantics and keyboard focus', async ({ panel, page }) => {
  await panel.history(conversation);
  await panel.emit({ type: 'status', chatId, state: 'running' }, { ...question, allowFreeform: false });
  const prompt = page.getByRole('region', { name: 'Question', exact: true });
  await expect(prompt.getByRole('textbox')).toHaveCount(0);
  await prompt.getByRole('button', { name: 'Start a delivery order' }).focus();
  await page.keyboard.press('Enter');
  await panel.expectRequests([{ type: 'answer', requestId: question.requestId, answer: 'Start a delivery order', wasFreeform: false }]);
  await panel.emit({ ...question, requestId: 'text-only', choices: [], question: 'What would you like?' });
  await expect(page.locator('.question-choices')).toHaveCount(0);
  const input = page.getByRole('textbox', { name: 'Your answer' });
  const send = page.getByRole('button', { name: 'Send answer' });
  await input.fill('   ');
  await expect(send).toBeDisabled();
  await input.fill('A pizza, please');
  await input.focus();
  await page.emulateMedia({ forcedColors: 'active' });
  await expect.poll(() => page.locator('.question-answer-control').evaluate(element => {
    const style = getComputedStyle(element);
    return style.outlineStyle === 'solid' && parseFloat(style.outlineWidth) > 0;
  })).toBe(true);
  await page.keyboard.press('Tab');
  await expect(send).toBeFocused();
  await page.keyboard.press('Enter');
  await panel.expectRequests([
    { type: 'answer', requestId: question.requestId, answer: 'Start a delivery order', wasFreeform: false },
    { type: 'answer', requestId: 'text-only', answer: 'A pizza, please', wasFreeform: true },
  ]);
});

test('Tools preserve safety/provenance, validate manual arguments and show explicit results', async ({ panel, page }) => {
  await page.getByRole('tab', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('heading', { name: pageContext.title })).toBeVisible();
  await expect(page.getByText('4 tools available', { exact: false })).toBeVisible();
  const rows = page.locator('.tool-row');
  await expect(rows.nth(1)).toContainText('Consequential');
  await expect(rows.nth(2)).toContainText('Hidden');
  await expect(page.getByRole('heading', { name: 'Embedded · delivery.example' })).toBeVisible();
  await rows.first().getByRole('button', { name: 'View menu' }).click();
  await expect(rows.first()).toContainText('Read-only');
  await rows.first().getByText('Technical details', { exact: true }).click();
  await expect(rows.first().locator('.tool-metadata')).toContainText(pageContext.origin);
  await expect(rows.first().locator('.tool-metadata')).toContainText('view_menu');
  await rows.first().getByText('Technical details', { exact: true }).click();
  await rows.first().getByRole('button', { name: 'Run manually' }).click();
  const argumentsInput = page.getByRole('textbox', { name: 'JSON arguments' });
  await expect(argumentsInput).toHaveValue('{\n  "category": "pizza"\n}');
  await argumentsInput.fill('[]');
  await page.getByRole('button', { name: 'Execute tool' }).click();
  await expect(page.getByText('Arguments must be a valid JSON object.')).toBeVisible();
  await panel.expectRequests([]);
  await argumentsInput.fill('{"category":"pizza"}');
  await page.getByRole('button', { name: 'Execute tool' }).click();
  await panel.expectRequests([{ type: 'inspect_run', key: menuTool.key, args: { category: 'pizza' } }]);
  await panel.emit({ type: 'inspect_result', key: menuTool.key, ok: false, result: 'Synthetic tool failure' });
  await expect(page.getByRole('alert')).toHaveText('Failed: Synthetic tool failure');
  await panel.emit({ type: 'inspect_result', key: menuTool.key, ok: true, result: '{"items":["Margherita"]}' });
  await expect(page.getByRole('status')).toHaveText('{"items":["Margherita"]}');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(argumentsInput).toHaveCount(0);
  await panel.expectRequests([{ type: 'inspect_run', key: menuTool.key, args: { category: 'pizza' } }]);
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await panel.emit({
    type: 'tool_call', chatId, callId: 'running-menu', sdkName: 'fixture__view_menu',
    key: menuTool.key, args: {}, tool: menuTool, origin: menuTool.origin, executionState: 'running',
  }, {
    type: 'tool_call', chatId, callId: 'queued-menu', sdkName: 'fixture__embedded_menu',
    key: '1:view_menu', args: {}, origin: 'https://delivery.example', executionState: 'queued',
    tool: { ...menuTool, key: '1:view_menu', origin: 'https://delivery.example', isTopFrame: false },
  });
  const activity = page.locator('.tool-activity');
  await expect(activity.first()).toContainText('Running');
  await expect(activity.first()).not.toContainText(menuTool.origin);
  await expect(activity.nth(1)).toContainText('Queued');
  await expect(activity.nth(1)).toContainText('Embedded · delivery.example');
  await expect(activity.nth(1).locator('.tool-summary-label > span')).toHaveCSS('font-weight', '400');
  await panel.emit({ type: 'tool_done', chatId, callId: 'running-menu', ok: false, result: 'Synthetic tool failure' });
  await expect(activity.first()).toContainText('Failed');
  await activity.first().getByRole('button').click();
  await activity.first().getByText('Result', { exact: true }).click();
  await expect(activity.first().getByText('Synthetic tool failure', { exact: true })).toBeVisible();
});

test('history remains disabled until complete SDK history arrives and fragments decode', async ({ panel, page }) => {
  await panel.emit({ type: 'chats', chats: [{ chatId, title: 'Saved order', updatedAt: '2026-11-02T12:00:00Z' }] });
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: /^Saved order / }).click();
  await panel.expectRequests([{ type: 'list_chats' }, { type: 'open_chat', chatId }]);
  await panel.emit({ type: 'reset' }, { type: 'chat_opened', chatId, title: 'Saved order' });
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeDisabled();
  await expect(page.getByRole('status')).toHaveText('Opening SDK chat history...');
  const serialized = JSON.stringify({ kind: 'user', text: 'Saved SDK message' });
  await panel.emit({ type: 'history_fragment', chatId, fragment: serialized.slice(0, 15), complete: false });
  await expect(page.getByText('Saved SDK message', { exact: true })).toHaveCount(0);
  await panel.emit({ type: 'history_fragment', chatId, fragment: serialized.slice(15), complete: true });
  await expect(page.getByText('Saved SDK message', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeDisabled();
  await panel.emit({ type: 'history', chatId, items: [], done: true }, { type: 'chat_loading', loading: false });
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
  await expect(page.getByRole('combobox', { name: 'Model' })).toHaveCount(0);
  await page.getByRole('button', { name: 'New chat' }).click();
  await panel.history([]);
  await expect(page.getByRole('combobox', { name: 'Model' })).toBeVisible();
  await expect(page.getByText('Saved SDK message', { exact: true })).toHaveCount(0);
});

test('History opens directly to the chat list and deletion stays behind confirmation', async ({ panel, page }) => {
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Saved chats', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Saved chats', exact: true })).toHaveCount(0);
  await expect(page.getByText('No saved chats yet.', { exact: true })).toBeVisible();
  await panel.emit({ type: 'chats', chats: [{ chatId, title: 'Saved order', updatedAt: '2026-11-02T12:00:00Z' }] });
  await expect(page.getByText('No saved chats yet.', { exact: true })).toHaveCount(0);
  await expect(page.locator('.history-view')).not.toContainText('Chats are stored by the Copilot SDK');
  await page.getByRole('button', { name: 'More options for Saved order' }).click();
  page.once('dialog', dialog => { void dialog.dismiss(); });
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await panel.expectRequests([{ type: 'list_chats' }]);
  await page.getByRole('button', { name: 'More options for Saved order' }).click();
  page.once('dialog', dialog => { void dialog.accept(); });
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await panel.expectRequests([{ type: 'list_chats' }, { type: 'delete_chat', chatId }]);
});

test('saved chat IDs copy exactly while running and clipboard failures remain visible', async ({ panel, page, consoleErrors }, testInfo) => {
  const secondChatId = 'webmcp-agent-debug-second';
  await panel.emit(
    { type: 'chats', chats: [
      { chatId, title: 'Saved order', updatedAt: '2026-11-02T12:00:00Z' },
      { chatId: secondChatId, title: 'Another order', updatedAt: '2026-11-03T12:00:00Z' },
    ] },
    { type: 'status', chatId, state: 'running' },
  );
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Saved order / })).toBeDisabled();
  await expect(page.locator('.history-title').first()).toHaveCSS('font-weight', '400');
  const originalListBounds = await page.locator('.history-list').boundingBox();
  await page.getByRole('button', { name: 'More options for Saved order' }).click();
  await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toBeDisabled();
  await testInfo.attach('copy-chat-id-menu', { body: await page.screenshot(), contentType: 'image/png' });
  await page.getByRole('menuitem', { name: 'Copy chat ID', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Chat ID copied.');
  await expect(page.getByRole('status')).toHaveClass('visually-hidden');
  await expect(page.getByRole('status')).toHaveCSS('clip-path', 'inset(50%)');
  expect(await page.locator('.history-list').boundingBox()).toEqual(originalListBounds);
  expect(await page.evaluate(() => window.agentUiTest.copiedText)).toBe(chatId);
  await page.evaluate(() => { window.agentUiTest.clipboardFailure = true; });
  await page.getByRole('button', { name: 'More options for Another order' }).click();
  await page.getByRole('menuitem', { name: 'Copy chat ID', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(`Copy it manually: ${secondChatId}`);
  expect(consoleErrors.splice(0)).toEqual([expect.stringContaining('WebMCP Agent could not copy the chat ID')]);
  await panel.expectRequests([{ type: 'list_chats' }]);
});

test('reasoning remains in conversation order and is not an idle Thinking status', async ({ panel, page }, testInfo) => {
  await panel.emit(
    { type: 'user', text: 'Show the menu' },
    { type: 'status', chatId, state: 'running' },
    { type: 'reasoning', chatId, text: 'Check the ' },
    { type: 'reasoning', chatId, text: 'page tools.' },
    { type: 'delta', chatId, text: 'Here is the ' },
    { type: 'message', chatId, text: 'Here is the menu.' },
    { type: 'status', chatId, state: 'idle' },
  );
  const reasoning = page.locator('.reasoning-activity');
  await expect(reasoning).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Thinking', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
  expect(await page.locator('.transcript').evaluate(element => {
    const reasoning = element.querySelector('.reasoning-activity');
    const response = element.querySelector('.message.assistant');
    return !!reasoning && !!response && !!(reasoning.compareDocumentPosition(response) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  await testInfo.attach('reasoning-order', { body: await page.screenshot(), contentType: 'image/png' });
  await reasoning.getByRole('button', { name: 'Reasoning', exact: true }).click();
  await expect(reasoning.getByRole('button', { name: 'Reasoning', exact: true })).toHaveCSS('font-weight', '500');
  await expect(reasoning.getByText('Check the page tools.', { exact: true })).toBeVisible();
  await expect(reasoning.locator('.markdown p')).toHaveCSS('font-weight', '400');
  await panel.emit(
    { type: 'user', text: 'Continue' },
    { type: 'status', chatId, state: 'running' },
    { type: 'delta', chatId, text: 'Another ' },
    { type: 'reasoning', chatId, text: 'A later SDK reasoning event.' },
    { type: 'delta', chatId, text: 'reply.' },
    { type: 'message', chatId, text: 'Another reply.' },
    { type: 'status', chatId, state: 'idle' },
  );
  await expect(reasoning).toHaveCount(2);
  await expect(page.locator('.message.assistant')).toHaveCount(2);
  await expect(page.locator('.message.assistant').last()).toContainText('Another reply.');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('switch', { name: 'Show reasoning' }).uncheck();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(reasoning).toHaveCount(0);
  await expect(page.locator('.message.assistant')).toHaveCount(2);
  await panel.history([]);
  await expect(page.locator('.message.assistant')).toHaveCount(0);
});

test('SDK identities keep distinct replies and reasoning blocks from overwriting each other', async ({ panel, page }) => {
  await panel.history([
    { kind: 'user', messageId: 'sdk-user', text: 'Accepted by the SDK' },
    { kind: 'assistant', messageId: 'saved-reply', text: 'A saved reply' },
  ]);
  await panel.emit(
    { type: 'user', chatId, messageId: 'sdk-user', text: 'Accepted by the SDK' },
    { type: 'status', chatId, state: 'running' },
    { type: 'reasoning', chatId, reasoningId: 'reason-one', text: 'First reasoning ' },
    { type: 'delta', chatId, messageId: 'reply-one', text: 'First ' },
    { type: 'reasoning', chatId, reasoningId: 'reason-two', text: 'Another reasoning block.' },
    { type: 'delta', chatId, messageId: 'reply-one', text: 'reply.' },
    { type: 'message', chatId, messageId: 'reply-two', text: 'A separate SDK reply.' },
    { type: 'reasoning', chatId, reasoningId: 'reason-one', text: 'completed.' },
    { type: 'reasoning', chatId, reasoningId: 'reason-one', text: 'The complete first reasoning block.', complete: true },
    { type: 'message', chatId, messageId: 'reply-one', text: 'The authoritative first reply.' },
  );
  await expect(page.locator('.message.user')).toHaveCount(1);
  const responses = page.locator('.message.assistant');
  await expect(responses).toHaveCount(3);
  await expect(responses.nth(0)).toContainText('A saved reply');
  await expect(responses.nth(1)).toContainText('The authoritative first reply.');
  await expect(responses.nth(2)).toContainText('A separate SDK reply.');
  const reasoning = page.locator('.reasoning-activity');
  await expect(reasoning).toHaveCount(2);
  await reasoning.first().getByRole('button', { name: 'Reasoning' }).click();
  await expect(reasoning.first().locator('.markdown')).toHaveText('The complete first reasoning block.');
  await panel.emit({ type: 'message', chatId, messageId: 'reply-two', text: '' });
  await expect(responses).toHaveCount(2);
  await expect(responses.last()).toContainText('The authoritative first reply.');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeDisabled();
  await panel.emit({ type: 'status', chatId, state: 'idle' });
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
  await panel.expectRequests([]);
});

test('Markdown renders GFM safely, keeps overflow local and reports copy failures', async ({ panel, page, consoleErrors }) => {
  const code = `const result = "${'long-query-'.repeat(30)}";\n`;
  const markdown = [
    '# Menu **help**', '', 'A **useful** reply with `inline code`.', '',
    '| Tool | Purpose | Status |', '| --- | --- | --- |', '| Search | Find pizza | Ready |', '',
    '- [x] Read menu', '- [ ] Order pizza', '', '> Confirm the exact order.', '',
    '```ts', code.trimEnd(), '```', '',
    '[Documentation](https://learn.microsoft.com/)',
    '![Remote image](https://tracker.example/pixel)',
    '<script>throw new Error("unsafe HTML executed")</script>',
    '[Unsafe](javascript:alert%281%29)',
  ].join('\n');
  await panel.emit(
    { type: 'user', text: 'Help with the menu' },
    { type: 'delta', chatId, text: '```ts\nconst result =' },
  );
  await expect(page.locator('.markdown-code pre')).toContainText('const result =');
  await panel.emit(
    { type: 'message', chatId, text: markdown },
    { type: 'model_used', chatId, model: { id: 'gpt-test', name: 'GPT Test', isAuto: true } },
  );
  await expect(page.getByRole('heading', { name: 'Menu help' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Menu help' })).toHaveCSS('font-weight', '600');
  await expect(page.getByRole('heading', { name: 'Menu help' }).locator('strong')).toHaveCSS('font-weight', '700');
  await expect(page.getByText('useful', { exact: true })).toHaveCSS('font-weight', '700');
  await expect(page.getByRole('table')).toHaveCount(1);
  await expect(page.getByRole('checkbox')).toHaveCount(2);
  await expect(page.locator('.response-model')).toHaveText('GPT Test');
  await expect(page.locator('.markdown img, .markdown script, .markdown a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Documentation' })).toHaveAttribute('rel', 'noopener noreferrer');
  expect(await page.locator('.markdown-code pre').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect(page.locator('.markdown-code pre')).toHaveCSS('white-space', 'pre');
  expect(await page.getByRole('region', { name: 'Message table' }).evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Copy code' }).click();
  await expect(page.getByRole('status')).toHaveText('Copied');
  expect(await page.evaluate(() => window.agentUiTest.copiedText)).toBe(code);
  await page.evaluate(() => { window.agentUiTest.clipboardFailure = true; });
  await page.getByRole('button', { name: 'Copy code' }).click();
  await expect(page.getByRole('status')).toContainText('Copy failed.');
  expect(consoleErrors.splice(0)).toEqual([expect.stringContaining('WebMCP Agent could not copy the code block')]);
});

test('disconnect is explicit and reconnect does not discard the draft or transcript', async ({ panel, page }) => {
  await panel.history(conversation);
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('Keep this draft');
  await page.evaluate(() => window.agentUiTest.disconnect());
  await expect(page.getByText('Connection problem', { exact: true })).toBeVisible();
  await expect(page.locator('.abort-notice')).toHaveCount(0);
  await expect(input).toBeDisabled();
  await expect(input).toHaveValue('Keep this draft');
  await expect(page.getByText('Help me place an order.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await panel.expectRequests([{ type: 'reconnect' }]);
  await panel.emit({ type: 'connection', status: 'Connected' });
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue('Keep this draft');
  await expect(page.getByText('Connection problem', { exact: true })).toHaveCount(0);
});

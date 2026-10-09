// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { finishInterruptedToolCalls, trimMessages } from '../src/lib/llm/history.ts';

const first = { role: 'user', content: 'Initial request' };
const exchange = [
  { role: 'assistant', content: '', toolCalls: [
    { id: 'a', name: 'first', arguments: '{}' },
    { id: 'b', name: 'second', arguments: '{}' },
  ] },
  { role: 'tool', toolCallId: 'a', content: 'first result' },
  { role: 'tool', toolCallId: 'b', content: 'second result' },
];

test('leaves history under the cap unchanged', () => {
  const messages = [first, ...exchange];
  assert.equal(trimMessages(messages, 10), messages);
  assert.deepEqual(trimMessages([], 1), []);
});

test('retains the initial request and recent plain messages', () => {
  const messages = [first, { role: 'assistant', content: 'Old answer' }, { role: 'user', content: 'New question' }];
  assert.deepEqual(trimMessages(messages, 2), [first, messages[2]]);
});

test('keeps the latest tool exchange intact even if it exceeds the cap', () => {
  const messages = [first, { role: 'assistant', content: 'Old answer' }, ...exchange];
  for (const cap of [1, 2, 3, 4]) {
    assert.deepEqual(trimMessages(messages, cap), [first, ...exchange]);
  }
});

test('drops an older exchange without orphaning results in the recent one', () => {
  const messages = [first, ...exchange, { role: 'user', content: 'Again' }, ...exchange];
  assert.deepEqual(trimMessages(messages, 4), [first, ...exchange]);
});

test('retains matched calls and results across every possible trim boundary', () => {
  const messages = [first, ...exchange, { role: 'assistant', content: 'Done' }, { role: 'user', content: 'Again' }, ...exchange];
  for (let cap = 1; cap <= messages.length; cap++) {
    const pendingCalls = new Set();
    for (const message of trimMessages(messages, cap)) {
      if (message.role === 'assistant') {
        for (const call of message.toolCalls ?? []) pendingCalls.add(call.id);
      } else if (message.role === 'tool') {
        assert.ok(pendingCalls.delete(message.toolCallId), `Orphaned result at cap ${cap}`);
      }
    }
    assert.equal(pendingCalls.size, 0);
  }
});

test('marks only unanswered calls as interrupted and does not guess their outcome', () => {
  const messages = [first, exchange[0], exchange[1]];
  finishInterruptedToolCalls(messages);
  assert.deepEqual(messages.slice(0, 3), [first, exchange[0], exchange[1]]);
  assert.equal(messages[3].role, 'tool');
  assert.equal(messages[3].toolCallId, 'b');
  assert.equal(messages[3].isError, true);
  assert.match(messages[3].content, /Do not assume it succeeded/);
  finishInterruptedToolCalls(messages);
  assert.equal(messages.length, 4);
});

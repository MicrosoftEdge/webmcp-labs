/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function readDemoFile(demo, filename) {
  return fs.readFileSync(path.join(__dirname, demo, filename), 'utf8');
}

function createBoardFixture() {
  const registeredTools = new Map();
  const elements = new Map();
  let visibleTools = [];
  const context = vm.createContext({
    AbortController,
    document: {
      modelContext: {
        registerTool(tool, options) {
          registeredTools.set(tool.name, tool);
          options?.signal?.addEventListener('abort', () => registeredTools.delete(tool.name));
        }
      },
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '' });
        return elements.get(id);
      },
      querySelectorAll() { return []; }
    },
    playgroundDocumentation: {
      supported: true,
      recordResult(toolName, inputs, result) { return result; },
      showTools(tools) { visibleTools = tools; }
    }
  });
  const html = readDemoFile('idea-board', 'index.html');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context);
  vm.runInContext('renderBoard = () => {};', context);
  return { context, registeredTools, getVisibleTools: () => visibleTools };
}

test('Markdown guides include every suggested playground prompt', () => {
  for (const demo of ['event-search', 'idea-board']) {
    const html = readDemoFile(demo, 'index.html');
    const markdown = readDemoFile(demo, 'README.md');
    const prompts = [...html.matchAll(/<p id="prompt-(?!status)[^"]+">([^<]+)<\/p>/g)];
    assert.equal(prompts.length, 3, `${demo} should have three lesson prompts`);
    for (const [, prompt] of prompts) assert(markdown.includes(prompt), `${demo}: missing prompt in Markdown`);
    assert(html.includes('rel="alternate" type="text/markdown" href="README.md"'));
  }
});

test('The demo precedes collapsed documentation and the API reference', () => {
  for (const demo of ['event-search', 'idea-board']) {
    const html = readDemoFile(demo, 'index.html');
    const preview = html.indexOf('class="browser-chrome demo-preview"');
    const documentation = html.indexOf('class="playground-documentation"');
    const reference = html.indexOf('class="api-reference"');
    assert(preview > 0 && preview < documentation && documentation < reference);
    assert(html.indexOf('class="code-pane"') > documentation);
    assert(html.indexOf('id="prompt-status"') > documentation);
    assert(html.indexOf('id="playground-tools"') > documentation);
    const sections = [...html.matchAll(/<details class="playground-(setup|guidance|observation)"([^>]*)>/g)];
    assert.equal(sections.length, 3);
    for (const [, , attributes] of sections) assert(!/\bopen\b/.test(attributes));
  }
});

test('Markdown input schemas match the actual tool registrations', () => {
  const { context, registeredTools, getVisibleTools } = createBoardFixture();
  context.addSticky('First');
  context.addSticky('Second');
  context.addSticky('Third');
  const actualSchemas = JSON.parse(JSON.stringify(
    Object.fromEntries([...registeredTools].map(([name, tool]) => [name, tool.inputSchema]))
  ));
  const markdown = readDemoFile('idea-board', 'README.md');
  const documentedSchemas = JSON.parse(markdown.match(/```json\r?\n([\s\S]*?)\r?\n```/)[1]);
  assert.equal(registeredTools.size, 5);
  assert.deepEqual(actualSchemas, documentedSchemas);
  for (const tool of getVisibleTools()) {
    assert.deepEqual(tool.inputSchema, registeredTools.get(tool.name).inputSchema);
  }
});

test('Tool availability and the inspector track board lifecycle', () => {
  const { context, registeredTools, getVisibleTools } = createBoardFixture();
  assert.deepEqual([...registeredTools.keys()], ['add-sticky', 'list-stickies']);
  registeredTools.get('add-sticky').execute({ text: 'First' });
  assert.equal(registeredTools.size, 4);
  assert(!registeredTools.has('group-stickies'));
  registeredTools.get('add-sticky').execute({ text: 'Second' });
  registeredTools.get('add-sticky').execute({ text: 'Third' });
  assert.equal(registeredTools.size, 5);
  assert.deepEqual(Array.from(getVisibleTools(), tool => tool.name), [...registeredTools.keys()]);
  registeredTools.get('clear-board').execute();
  assert.deepEqual([...registeredTools.keys()], ['add-sticky', 'list-stickies']);
  assert.deepEqual(Array.from(getVisibleTools(), tool => tool.name), [...registeredTools.keys()]);
  assert.equal(registeredTools.get('list-stickies').execute(), 'The board is empty.');
});

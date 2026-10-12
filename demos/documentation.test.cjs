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
    }
  });
  const html = readDemoFile('idea-board', 'index.html');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, context);
  vm.runInContext('renderBoard = () => {};', context);
  return { context, registeredTools };
}

test('The demo precedes collapsed documentation and the API reference', () => {
  for (const demo of ['event-search', 'idea-board']) {
    const html = readDemoFile(demo, 'index.html');
    const preview = html.indexOf('class="browser-chrome demo-preview"');
    const documentation = html.indexOf('class="documentation"');
    const reference = html.indexOf('class="api-reference"');
    assert(preview > 0 && preview < documentation && documentation < reference);
    assert(html.indexOf('class="code-pane"') > documentation);
    const sections = [...html.matchAll(/<details class="documentation-examples"([^>]*)>/g)];
    assert.equal(sections.length, 1);
    for (const [, attributes] of sections) assert(!/\bopen\b/.test(attributes));
    assert(html.includes('rel="alternate" type="text/markdown" href="README.md"'));
    assert(!html.includes('playgroundDocumentation'));
  }
});

test('Markdown documents the actual form tool names and required fields', () => {
  const html = readDemoFile('event-search', 'index.html');
  const markdown = readDemoFile('event-search', 'README.md');
  const forms = [...html.matchAll(/<form\b[^>]*toolname="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)];
  assert.equal(forms.length, 3);
  for (const [, toolName, form] of forms) {
    assert(markdown.includes(`\`${toolName}\``));
    const requiredFields = [...form.matchAll(/<(?:input|select)\b[^>]*name="([^"]+)"[^>]*\brequired\b/g)];
    assert.equal(requiredFields.length, 4);
    for (const [, fieldName] of requiredFields) assert(markdown.includes(`| \`${fieldName}\` |`));
  }
});

test('Markdown input schemas match the actual tool registrations', () => {
  const { context, registeredTools } = createBoardFixture();
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
});

test('The documented board tool lifecycle is unchanged', () => {
  const { registeredTools } = createBoardFixture();
  assert.deepEqual([...registeredTools.keys()], ['add-sticky', 'list-stickies']);
  registeredTools.get('add-sticky').execute({ text: 'First' });
  assert.equal(registeredTools.size, 4);
  assert(!registeredTools.has('group-stickies'));
  registeredTools.get('add-sticky').execute({ text: 'Second' });
  registeredTools.get('add-sticky').execute({ text: 'Third' });
  assert.equal(registeredTools.size, 5);
  registeredTools.get('clear-board').execute();
  assert.deepEqual([...registeredTools.keys()], ['add-sticky', 'list-stickies']);
  assert.equal(registeredTools.get('list-stickies').execute(), 'The board is empty.');
});

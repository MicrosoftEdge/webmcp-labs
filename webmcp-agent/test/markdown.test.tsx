// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../extension/src/sidepanel/Markdown.js';

describe('chat Markdown presentation', () => {
  it('renders headings, emphasis, nested lists, blockquotes, and inline code semantically', () => {
    const markup = renderToStaticMarkup(createElement(Markdown, { text: [
      '# Overview', '', '## Details', '', '### Next steps', '',
      '**Strong** and *emphasis* with `search()`.', '',
      '1. First', '2. Second', '   - Nested item', '', '> A useful note.',
    ].join('\n') }));
    for (const fragment of ['<h1>Overview</h1>', '<h2>Details</h2>', '<h3>Next steps</h3>',
      '<strong>Strong</strong>', '<em>emphasis</em>', '<code>search()</code>', '<ol>', '<ul>', '<blockquote>']) {
      expect(markup).toContain(fragment);
    }
  });
  it('supports GFM tables, task lists, strikethrough, and autolinks', () => {
    const markup = renderToStaticMarkup(createElement(Markdown, { text: [
      '| API | Purpose |', '| --- | --- |', '| `search` | Find tools |', '',
      '- [x] Completed', '- [ ] Pending', '', '~~Removed~~', '', 'https://learn.microsoft.com/',
    ].join('\n') }));
    expect(markup).toContain('aria-label="Message table"');
    expect(markup).toContain('<table>');
    expect(markup).toContain('<th>API</th>');
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('<del>Removed</del>');
    expect(markup).toContain('href="https://learn.microsoft.com/"');
  });
  it('preserves fenced code, indentation and language while exposing a copy action', () => {
    const markup = renderToStaticMarkup(createElement(Markdown, { text: '```ts\nfunction search() {\n  return "<script>not executable</script>";\n}\n```' }));
    expect(markup).toContain('aria-label="ts code"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('language-ts');
    expect(markup).toContain('\n  return &quot;&lt;script&gt;not executable&lt;/script&gt;&quot;;\n');
    expect(markup).toContain('Copy code');
    expect(markup).not.toContain('<script>');
  });
  it('renders an incomplete streaming code fence without requiring a second transcript', () => {
    const partial = renderToStaticMarkup(createElement(Markdown, { text: '## Result\n\n```json\n{\n  "status":' }));
    const complete = renderToStaticMarkup(createElement(Markdown, { text: '## Result\n\n```json\n{\n  "status": "ok"\n}\n```' }));
    expect(partial).toContain('aria-label="json code"');
    expect(partial).toContain('&quot;status&quot;:');
    expect(complete).toContain('&quot;status&quot;: &quot;ok&quot;');
  });
  it('keeps raw HTML and remote images disabled and rejects unsafe link protocols', () => {
    const markup = renderToStaticMarkup(createElement(Markdown, { text: [
      '<script>alert("unsafe")</script>', '',
      '<img src="https://tracker.example/raw" onerror="alert(1)">', '',
      '![Tracking pixel](https://tracker.example/pixel)', '',
      '[Unsafe](javascript:alert%281%29)', '',
      '[Safe](https://example.com/docs)',
    ].join('\n') }));
    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('javascript:');
    expect(markup).not.toContain('href=""');
    expect(markup).toContain('[Image omitted: Tracking pixel]');
    expect(markup).toContain('href="https://example.com/docs"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
  });
});

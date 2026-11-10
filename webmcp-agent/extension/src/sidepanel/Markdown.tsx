// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import { useRef, useState, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown, { type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button, Link } from '@fluentui/react-components';
import { Copy16Regular } from '@fluentui/react-icons';

function CodeBlock({ children, node }: ComponentPropsWithoutRef<'pre'> & ExtraProps) {
  const element = useRef<HTMLPreElement>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code');
  const classNames = code?.type === 'element' && Array.isArray(code.properties.className) ? code.properties.className : [];
  const language = classNames.find(value => typeof value === 'string' && value.startsWith('language-'));
  const label = typeof language === 'string' ? language.slice('language-'.length) : 'Code';
  async function copy() {
    try {
      if (!element.current) throw new Error('The code block is not available.');
      await navigator.clipboard.writeText(element.current.textContent ?? '');
      setCopyStatus('Copied');
    } catch (error) {
      console.error('WebMCP Agent could not copy the code block', error);
      setCopyStatus('Copy failed. Select and copy the code manually.');
    }
  }
  return <div className="markdown-code">
    <div className="code-toolbar"><span>{label}</span>
      <Button size="small" appearance="subtle" icon={<Copy16Regular />} onClick={() => { void copy(); }}>Copy code</Button>
    </div>
    <pre ref={element} tabIndex={0} aria-label={`${label} code`}>{children}</pre>
    {copyStatus && <span className="copy-status" role="status">{copyStatus}</span>}
  </div>;
}

export function Markdown({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{
    img: ({ alt }) => <span className="muted">[Image omitted: {alt}]</span>,
    a: ({ children, href }) => href
      ? <Link inline href={href} target="_blank" rel="noopener noreferrer">{children}</Link>
      : <span>{children}</span>,
    pre: CodeBlock,
    table: ({ children }) => <div className="markdown-table" role="region" aria-label="Message table" tabIndex={0}><table>{children}</table></div>,
  }}>{text}</ReactMarkdown></div>;
}

import type { JSONContent } from '@tiptap/core';
import katex from 'katex';
import { parseMarkdown } from './markdown';
import { extractOutline, type OutlineItem } from '../utils/document';
import { getFormulaCacheKey } from './math-render-cache';

interface ParseMarkdownRequest {
  id: number;
  markdown: string;
  includeFormulaHtml?: boolean;
}

interface ParseMarkdownSuccess {
  id: number;
  ok: true;
  content: JSONContent;
  outline: OutlineItem[];
  formulaHtml?: Record<string, string>;
}

interface ParseMarkdownFailure {
  id: number;
  ok: false;
  error: string;
}

type ParseMarkdownResponse = ParseMarkdownSuccess | ParseMarkdownFailure;

function getInlineMathLatex(node: JSONContent): string {
  if (!Array.isArray(node.content)) {
    return '';
  }
  return node.content
    .map((child) => (typeof child.text === 'string' ? child.text : ''))
    .join('');
}

function renderFormulaHtml(content: JSONContent): Record<string, string> {
  const entries: Record<string, string> = {};
  const seen = new Set<string>();

  const visit = (node: JSONContent): void => {
    if (node.type === 'inlineMath') {
      const display = node.attrs?.display === 'yes' ? 'yes' : 'no';
      const latex = getInlineMathLatex(node);
      const key = getFormulaCacheKey(latex, display);
      if (!seen.has(key)) {
        seen.add(key);
        try {
          entries[key] = katex.renderToString(latex, {
            displayMode: display === 'yes',
            throwOnError: false,
            strict: 'ignore',
            output: 'html',
          });
        } catch {
          // Keep the main thread's synchronous render as the fallback.
        }
      }
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        visit(child);
      }
    }
  };

  visit(content);
  return entries;
}

self.onmessage = (event: MessageEvent<ParseMarkdownRequest>) => {
  const { id, markdown, includeFormulaHtml = false } = event.data;

  try {
    const content = parseMarkdown(markdown);
    const outline = extractOutline(markdown);
    let formulaHtml: Record<string, string> | undefined;
    if (includeFormulaHtml) {
      try {
        formulaHtml = renderFormulaHtml(content);
      } catch {
        formulaHtml = {};
      }
    }
    const response: ParseMarkdownResponse = {
      id,
      ok: true,
      content,
      outline,
      ...(includeFormulaHtml ? { formulaHtml } : {}),
    };
    self.postMessage(response);
  } catch (error) {
    const response: ParseMarkdownResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : 'Markdown parse failed',
    };
    self.postMessage(response);
  }
};

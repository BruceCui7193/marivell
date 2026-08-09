import type { JSONContent } from '@tiptap/core';
import katex from 'katex';
import { parseMarkdown } from './markdown';
import { extractOutline, type OutlineItem } from '../utils/document';
import { getFormulaCacheKey } from './math-render-cache';

export interface FormulaIndexEntry {
  key: string;
  latex: string;
  display: 'yes' | 'no';
}

interface ParseMarkdownRequest {
  id: number;
  markdown: string;
  includeFormulaHtml?: boolean;
}

export interface FormulaChunkRequest {
  id: number;
  requestType: 'formula-chunk';
  entries: FormulaIndexEntry[];
}

interface ParseMarkdownSuccess {
  id: number;
  ok: true;
  content: JSONContent;
  outline: OutlineItem[];
  formulaIndex?: FormulaIndexEntry[];
  formulaHtml?: Record<string, string>;
}

interface ParseMarkdownFailure {
  id: number;
  ok: false;
  error: string;
}

type ParseMarkdownResponse = ParseMarkdownSuccess | ParseMarkdownFailure;

export interface FormulaChunkSuccess {
  id: number;
  requestType: 'formula-chunk';
  ok: true;
  formulaHtml: Record<string, string>;
}

export interface FormulaChunkFailure {
  id: number;
  requestType: 'formula-chunk';
  ok: false;
  error: string;
}

export type FormulaChunkResponse = FormulaChunkSuccess | FormulaChunkFailure;

type WorkerRequest = ParseMarkdownRequest | FormulaChunkRequest;

const INITIAL_FORMULA_HTML_CHUNK_SIZE = 200;

function getInlineMathLatex(node: JSONContent): string {
  if (!Array.isArray(node.content)) {
    return '';
  }
  return node.content
    .map((child) => (typeof child.text === 'string' ? child.text : ''))
    .join('');
}

export function collectFormulaIndex(content: JSONContent): FormulaIndexEntry[] {
  const entries: FormulaIndexEntry[] = [];
  const seen = new Set<string>();

  const visit = (node: JSONContent): void => {
    if (node.type === 'inlineMath') {
      const display = node.attrs?.display === 'yes' ? 'yes' : 'no';
      const latex = getInlineMathLatex(node);
      const key = getFormulaCacheKey(latex, display);
      if (!seen.has(key)) {
        seen.add(key);
        entries.push({ key, latex, display });
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

export function renderFormulaChunk(entries: FormulaIndexEntry[]): Record<string, string> {
  const rendered: Record<string, string> = {};

  for (const entry of entries) {
    try {
      rendered[entry.key] = katex.renderToString(entry.latex, {
        displayMode: entry.display === 'yes',
        throwOnError: false,
        strict: 'ignore',
        output: 'html',
      });
    } catch {
      // Keep the main thread's synchronous render as the fallback.
    }
  }

  return rendered;
}

function renderFormulaHtml(entries: FormulaIndexEntry[]): Record<string, string> {
  return renderFormulaChunk(entries.slice(0, INITIAL_FORMULA_HTML_CHUNK_SIZE));
}

if (typeof self !== 'undefined') {
  self.onmessage = (event: MessageEvent<WorkerRequest>) => {
    if ('entries' in event.data) {
      const { id, entries } = event.data as FormulaChunkRequest;
      try {
        const formulaHtml = renderFormulaChunk(entries);
        const response: FormulaChunkSuccess = {
          id,
          requestType: 'formula-chunk',
          ok: true,
          formulaHtml,
        };
        self.postMessage(response);
      } catch (error) {
        const response: FormulaChunkFailure = {
          id,
          requestType: 'formula-chunk',
          ok: false,
          error: error instanceof Error ? error.message : 'Formula chunk render failed',
        };
        self.postMessage(response);
      }
      return;
    }

    const { id, markdown, includeFormulaHtml = false } = event.data as ParseMarkdownRequest;

    try {
      const content = parseMarkdown(markdown);
      const outline = extractOutline(markdown);
      let formulaIndex: FormulaIndexEntry[] | undefined;
      let formulaHtml: Record<string, string> | undefined;
      if (includeFormulaHtml) {
        try {
          formulaIndex = collectFormulaIndex(content);
          formulaHtml = renderFormulaHtml(formulaIndex);
        } catch {
          formulaIndex = [];
          formulaHtml = {};
        }
      }
      const response: ParseMarkdownResponse = {
        id,
        ok: true,
        content,
        outline,
        ...(includeFormulaHtml ? { formulaIndex, formulaHtml } : {}),
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
}

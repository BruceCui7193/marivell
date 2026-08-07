import type { JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode, ResolvedPos } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { CellSelection, TableMap } from 'prosemirror-tables';
import { serializeMarkdownFragment } from './markdown';

/**
 * Contexts where the user is editing "raw" content and expects the clipboard
 * to carry plain text rather than Markdown wrappers (pipes, $, fences, …).
 */
const PLAIN_TEXT_STRUCTURAL_PARENTS = new Set(['tableCell', 'tableHeader']);

/**
 * Nodes where a real whole-node selection should serialize with Markdown
 * wrappers (`$…$`, fenced code, etc.), while any text selection inside them
 * stays raw (LaTeX body, code body).
 */
const WRAPPER_CONTENT_PARENTS = new Set(['inlineMath', 'codeBlock']);

function parentTextblockDepth($pos: ResolvedPos): number | null {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).isTextblock) {
      return depth;
    }
  }
  return null;
}

/** True when the selection is a real NodeSelection (the whole node is selected). */
export function isWholeNodeSelection(
  selection: {
    from: number;
    to: number;
    empty: boolean;
    $from: ResolvedPos;
    $to: ResolvedPos;
    node?: ProseMirrorNode;
  },
  nodeName?: string,
): boolean {
  if (!(selection instanceof NodeSelection)) {
    return false;
  }
  return nodeName ? selection.node.type.name === nodeName : true;
}

/**
 * True when the caret/selection is inside a wrapper node, even when every
 * character inside that node is selected. Only a real NodeSelection counts as
 * "whole node copy"; text selections inside math/code stay raw.
 */
export function isPartialInsideWrapperParent(selection: {
  empty: boolean;
  $from: ResolvedPos;
  $to: ResolvedPos;
}): boolean {
  if (selection.empty) {
    return false;
  }
  if (selection instanceof NodeSelection) {
    return false;
  }

  const { $from, $to } = selection;
  if ($from.parent !== $to.parent) {
    return false;
  }

  const parent = $from.parent;
  if (!WRAPPER_CONTENT_PARENTS.has(parent.type.name)) {
    return false;
  }

  return true;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

function containsNodeType(content: JSONContent[], typeName: string): boolean {
  return content.some(
    (node) =>
      node.type === typeName ||
      (Array.isArray(node.content) && containsNodeType(node.content, typeName)),
  );
}

/** Normalize cell text for spreadsheet paste (Excel/Word). */
export function normalizeCellPlainText(node: ProseMirrorNode): string {
  // Join block children with spaces so multi-paragraph cells stay one cell in TSV.
  const parts: string[] = [];
  node.forEach((child) => {
    if (child.isTextblock) {
      parts.push(child.textContent);
      return;
    }
    if (child.isText) {
      parts.push(child.text ?? '');
      return;
    }
    if (child.type.name === 'hardBreak') {
      parts.push(' ');
      return;
    }
    parts.push(child.textContent);
  });
  return parts
    .join(' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** TSV for Excel / Sheets / Word (tabs = columns, newlines = rows). */
export function tableMatrixToTsv(matrix: string[][]): string {
  return matrix
    .map((row) =>
      row
        .map((cell) => {
          // Excel-compatible quoting when tabs/newlines/quotes appear.
          if (/[\t\n\r"]/.test(cell)) {
            return `"${cell.replace(/"/g, '""')}"`;
          }
          return cell;
        })
        .join('\t'),
    )
    .join('\n');
}

/** HTML table for Word / Excel rich paste. */
export function tableMatrixToHtml(matrix: string[][], headerRow = false): string {
  if (matrix.length === 0) {
    return '';
  }

  const renderRow = (row: string[], tag: 'th' | 'td') =>
    `<tr>${row.map((cell) => `<${tag}>${escapeHtml(cell)}</${tag}>`).join('')}</tr>`;

  const bodyRows = headerRow ? matrix.slice(1) : matrix;
  const head =
    headerRow && matrix[0]
      ? `<thead>${renderRow(matrix[0], 'th')}</thead>`
      : '';
  const body = `<tbody>${bodyRows.map((row) => renderRow(row, 'td')).join('')}</tbody>`;

  // Excel/Word look for a real table in text/html.
  return `<table border="1" cellspacing="0" cellpadding="4">${head}${body}</table>`;
}

/** GitHub-flavored Markdown table for paste-back into Markdown apps. */
export function tableMatrixToMarkdown(matrix: string[][]): string {
  if (matrix.length === 0) {
    return '';
  }
  const colCount = Math.max(...matrix.map((row) => row.length), 1);
  const pad = (row: string[]) =>
    Array.from({ length: colCount }, (_, i) => escapeMarkdownTableCell(row[i] ?? ''));
  const header = pad(matrix[0] ?? []);
  const sep = Array.from({ length: colCount }, () => '---');
  const body = matrix.slice(1).map(pad);
  return [
    `| ${header.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

/**
 * Build a dense row×col matrix from a ProseMirror CellSelection
 * (covers multi-cell rectangular selections).
 */
export function cellSelectionToMatrix(selection: CellSelection): {
  matrix: string[][];
  headerRow: boolean;
} {
  const $anchor = selection.$anchorCell;
  const table = $anchor.node(-1);
  const map = TableMap.get(table);
  const tableStart = $anchor.start(-1);

  type CellInfo = { row: number; col: number; text: string; isHeader: boolean };
  const cells: CellInfo[] = [];

  selection.forEachCell((node, pos) => {
    // pos is before the cell; TableMap positions are relative to table content start.
    const rel = pos - tableStart;
    const rect = map.findCell(rel);
    cells.push({
      row: rect.top,
      col: rect.left,
      text: normalizeCellPlainText(node),
      isHeader: node.type.name === 'tableHeader',
    });
  });

  if (cells.length === 0) {
    return { matrix: [], headerRow: false };
  }

  const minRow = Math.min(...cells.map((c) => c.row));
  const maxRow = Math.max(...cells.map((c) => c.row));
  const minCol = Math.min(...cells.map((c) => c.col));
  const maxCol = Math.max(...cells.map((c) => c.col));
  const rows = maxRow - minRow + 1;
  const cols = maxCol - minCol + 1;

  const matrix: string[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ''),
  );

  for (const cell of cells) {
    matrix[cell.row - minRow]![cell.col - minCol] = cell.text;
  }

  // Treat as header row only when every selected cell on the top row is a header.
  const topRowCells = cells.filter((c) => c.row === minRow);
  const headerRow =
    topRowCells.length > 0 && topRowCells.every((c) => c.isHeader) && minRow === 0;

  return { matrix, headerRow };
}

/**
 * True when the selection lives entirely inside one "plain text" parent
 * (table cell, text inside code/math, or a single paragraph/heading).
 *
 * Whole-node selections return false so the clipboard gets Markdown wrappers
 * (`$…$`, fences). Text selections inside math/code stay raw, even when they
 * cover the full inner content.
 */
export function selectionPrefersPlainText(view: EditorView): boolean {
  const { selection } = view.state;
  if (selection.empty) {
    return true;
  }

  // Multi-cell table selection is never "plain single field".
  if (selection instanceof CellSelection) {
    return false;
  }

  // Whole-node selection (NodeSelection or full content of math/code) → wrappers.
  if (selection instanceof NodeSelection) {
    return false;
  }

  if (isPartialInsideWrapperParent(selection)) {
    return true;
  }

  const { $from, $to } = selection;

  const fromTextblock = parentTextblockDepth($from);
  const toTextblock = parentTextblockDepth($to);
  if (
    fromTextblock !== null &&
    toTextblock !== null &&
    fromTextblock === toTextblock &&
    $from.node(fromTextblock) === $to.node(toTextblock)
  ) {
    const block = $from.node(fromTextblock);
    // Entire code block selected as a textblock → keep fences via Markdown path.
    if (
      block.type.name === 'codeBlock' &&
      $from.parentOffset === 0 &&
      $to.parentOffset === block.content.size
    ) {
      return false;
    }
    return true;
  }

  for (let depth = Math.min($from.depth, $to.depth); depth > 0; depth -= 1) {
    if ($from.node(depth) !== $to.node(depth)) {
      continue;
    }
    if (PLAIN_TEXT_STRUCTURAL_PARENTS.has($from.node(depth).type.name)) {
      return true;
    }
  }

  return false;
}

/**
 * Build clipboard payloads for the current selection.
 * Multi-cell table → TSV + HTML table + Markdown table (Excel/Word friendly).
 */
export function buildClipboardPayload(view: EditorView): {
  plain: string;
  html: string | null;
  markdown: string | null;
} {
  const { selection } = view.state;
  if (selection.empty) {
    return { plain: '', html: null, markdown: null };
  }

  // --- Multi-cell table selection (the common "only first cell copies" bug) ---
  if (selection instanceof CellSelection) {
    const { matrix, headerRow } = cellSelectionToMatrix(selection);
    if (matrix.length === 0) {
      return { plain: '', html: null, markdown: null };
    }
    const plain = tableMatrixToTsv(matrix);
    const html = tableMatrixToHtml(matrix, headerRow);
    const markdown = tableMatrixToMarkdown(matrix);
    return { plain, html, markdown };
  }

  const slice = selection.content();
  const content = slice.content.toJSON() as JSONContent[];
  // Top-level inline nodes (whole formula NodeSelection) are not block roots in
  // our markdown serializer — wrap so `$…$` / `$$…$$` survive on the clipboard.
  const markdownContent =
    content.length === 1 && content[0]?.type === 'inlineMath'
      ? ([{ type: 'paragraph', content: [content[0]] }] as JSONContent[])
      : content;
  const markdown = serializeMarkdownFragment(markdownContent).trimEnd();
  const plainBetween = view.state.doc.textBetween(selection.from, selection.to, '\n', '\n');

  // Full table node selected as a single slice with type table
  if (
    Array.isArray(content) &&
    content.length === 1 &&
    content[0]?.type === 'table'
  ) {
    const matrix = jsonTableToMatrix(content[0]);
    if (matrix.length > 0) {
      return {
        plain: tableMatrixToTsv(matrix),
        html: tableMatrixToHtml(matrix, true),
        markdown: tableMatrixToMarkdown(matrix),
      };
    }
  }

  // Mixed paragraph selections that include math need Markdown delimiters;
  // plain text would silently drop `$…$` and break the formula when pasted.
  const mathNeedsMarkdown =
    containsNodeType(content, 'inlineMath') && !isPartialInsideWrapperParent(selection);
  if (selectionPrefersPlainText(view) && !mathNeedsMarkdown) {
    const plain = plainBetween || extractLeafPlainText(content) || markdown;
    return { plain, html: null, markdown: null };
  }

  // Prefer Markdown for plain when structure matters (whole math/code, mixed
  // selection). textBetween drops `$` / fences for atom-like inline nodes.
  const plain = markdown || plainBetween;
  // Prefer real HTML for tables already serialized as markdown pipes.
  const html = looksLikeMarkdownTable(markdown)
    ? markdownTableToHtml(markdown)
    : markdownToMinimalHtml(markdown);
  return { plain, html, markdown };
}

function jsonTableToMatrix(table: JSONContent): string[][] {
  const rows: string[][] = [];
  for (const row of table.content ?? []) {
    if (row.type !== 'tableRow') continue;
    const cells: string[] = [];
    for (const cell of row.content ?? []) {
      if (cell.type !== 'tableCell' && cell.type !== 'tableHeader') continue;
      cells.push(extractLeafPlainText(cell.content ?? []).replace(/\n+/g, ' ').trim());
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

function looksLikeMarkdownTable(markdown: string): boolean {
  const lines = markdown.trim().split('\n');
  return lines.length >= 2 && lines.every((line) => line.includes('|'));
}

function markdownTableToHtml(markdown: string): string {
  const lines = markdown
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'));
  if (lines.length < 2) {
    return markdownToMinimalHtml(markdown);
  }

  const parseRow = (line: string) =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim().replace(/\\\|/g, '|'));

  // Skip separator row (| --- | --- |)
  const bodyLines = lines.filter((line, index) => {
    if (index === 1 && /^\|?\s*:?-{3,}/.test(line)) {
      return false;
    }
    return !/^\|?\s*[:\-| ]+\|?\s*$/.test(line) || index === 0;
  });

  // Rebuild: first line header if we had a separator
  const hasSep = lines.length >= 2 && /^\|?\s*:?-{3,}/.test(lines[1] ?? '');
  const matrix = (hasSep ? [lines[0]!, ...lines.slice(2)] : lines).map(parseRow);
  return tableMatrixToHtml(matrix, hasSep);
}

function extractLeafPlainText(content: JSONContent[]): string {
  const parts: string[] = [];

  const walk = (nodes: JSONContent[] | undefined) => {
    if (!nodes) {
      return;
    }
    for (const node of nodes) {
      if (node.type === 'text' && node.text) {
        parts.push(node.text);
        continue;
      }
      if (node.type === 'hardBreak') {
        parts.push('\n');
        continue;
      }
      if (node.type === 'inlineMath') {
        const latex =
          node.content?.map((child) => child.text ?? '').join('') ||
          String(node.attrs?.latex ?? node.attrs?.value ?? '');
        parts.push(latex);
        continue;
      }
      if (node.type === 'paragraph' || node.type === 'heading') {
        walk(node.content);
        parts.push('\n');
        continue;
      }
      if (node.content) {
        walk(node.content);
      }
    }
  };

  walk(content);
  return parts.join('').replace(/\n+$/, '');
}

function markdownToMinimalHtml(markdown: string): string {
  const escaped = markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<pre data-markdown-editor-pro="1">${escaped}</pre>`;
}

export function writeClipboardFromSelection(view: EditorView, event: ClipboardEvent): boolean {
  if (!event.clipboardData || view.state.selection.empty) {
    return false;
  }

  const payload = buildClipboardPayload(view);
  if (!payload.plain && !payload.markdown) {
    return false;
  }

  event.clipboardData.setData('text/plain', payload.plain || payload.markdown || '');
  if (payload.markdown) {
    event.clipboardData.setData('text/markdown', payload.markdown);
    event.clipboardData.setData('text/x-markdown', payload.markdown);
  }
  if (payload.html) {
    event.clipboardData.setData('text/html', payload.html);
  }

  event.preventDefault();
  return true;
}

/**
 * Serialize a PM slice the way clipboardTextSerializer expects — used by
 * ProseMirror internal copy when our DOM handler does not run.
 */
export function serializeSliceForClipboard(slice: {
  content: { toJSON: () => unknown };
  openStart?: number;
  openEnd?: number;
}): string {
  const content = slice.content.toJSON() as JSONContent[];

  // Full table fragment → TSV for spreadsheet tools.
  if (Array.isArray(content) && content.length === 1 && content[0]?.type === 'table') {
    const matrix = jsonTableToMatrix(content[0]);
    if (matrix.length > 0) {
      return tableMatrixToTsv(matrix);
    }
  }

  // Table rows only (CellSelection slice often yields table with partial rows)
  if (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((n) => n.type === 'tableRow')
  ) {
    const matrix = jsonTableToMatrix({ type: 'table', content });
    if (matrix.length > 0) {
      return tableMatrixToTsv(matrix);
    }
  }

  // Open slice → partial interior of a parent (e.g. mid-formula). Prefer raw text.
  if ((slice.openStart ?? 0) > 0 || (slice.openEnd ?? 0) > 0) {
    return extractLeafPlainText(content) || serializeMarkdownFragment(content).trimEnd();
  }

  if (Array.isArray(content) && content.length > 1) {
    return serializeMarkdownFragment(content).trimEnd();
  }

  if (Array.isArray(content) && content.length === 1) {
    const only = content[0];
    if (!only) {
      return '';
    }

    // Whole formula / whole code block → keep Markdown wrappers on the clipboard.
    // Top-level inlineMath is not a block in our serializer; wrap in a paragraph.
    if (only.type === 'inlineMath') {
      return serializeMarkdownFragment([
        { type: 'paragraph', content: [only] },
      ]).trimEnd();
    }
    if (only.type === 'codeBlock') {
      return serializeMarkdownFragment(content).trimEnd();
    }

    if (only.type === 'paragraph' || only.type === 'heading') {
      // Single textblock: if it only wraps one full math node, still keep wrappers.
      const kids = only.content ?? [];
      if (kids.length === 1 && kids[0]?.type === 'inlineMath') {
        return serializeMarkdownFragment(content).trimEnd();
      }
      return extractLeafPlainText(content) || serializeMarkdownFragment(content).trimEnd();
    }
  }

  return serializeMarkdownFragment(content).trimEnd();
}

export function isInsideNodeType(view: EditorView, typeNames: string | string[]): boolean {
  const names = Array.isArray(typeNames) ? typeNames : [typeNames];
  const { $from } = view.state.selection;
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    if (names.includes($from.node(depth).type.name)) {
      return true;
    }
  }
  return false;
}

export function isInsideCodeBlock(view: EditorView): boolean {
  return isInsideNodeType(view, 'codeBlock');
}

export function isInsideMath(view: EditorView): boolean {
  return isInsideNodeType(view, 'inlineMath');
}

export function isInsideTableCell(view: EditorView): boolean {
  return isInsideNodeType(view, ['tableCell', 'tableHeader']);
}

/** True when paste should stay as plain characters (no markdown structure). */
export function pasteRequiresPlainText(view: EditorView): boolean {
  return isInsideCodeBlock(view) || isInsideMath(view);
}

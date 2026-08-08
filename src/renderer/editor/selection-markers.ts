import type { JSONContent } from '@tiptap/core';
import { NodeSelection, TextSelection, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Mark as ProseMirrorMark, Node as ProseMirrorNode, Schema } from '@tiptap/pm/model';
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';

const sourceParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath, { singleDollarTextMath: true });

type SourceNode = Record<string, any>;

function findNearestTextOffset(markdown: string, requested: number): number {
  let best = requested;
  let bestDistance = Number.POSITIVE_INFINITY;

  const visit = (node: SourceNode): void => {
    if (
      typeof node.value === 'string' &&
      !Array.isArray(node.children) &&
      node.position?.start?.offset != null &&
      node.position?.end?.offset != null
    ) {
      let start = node.position.start.offset;
      let end = node.position.end.offset;
      if (end - start !== node.value.length) {
        const valueIndex = markdown.indexOf(node.value);
        if (valueIndex >= 0) {
          start = valueIndex;
          end = valueIndex + node.value.length;
        }
      }
      if (end > start) {
        const clamped = Math.min(end, Math.max(start, requested));
        const distance = Math.abs(clamped - requested);
        if (distance < bestDistance || (distance === bestDistance && clamped < best)) {
          best = clamped;
          bestDistance = distance;
        }
      }
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };

  visit(sourceParser.parse(markdown) as SourceNode);
  return best;
}

export const SELECTION_START_MARKER = 'MDEDITORSELECTIONSTARTTOKEN';
export const SELECTION_END_MARKER = 'MDEDITORSELECTIONENDTOKEN';

export interface SourceSearchMatch {
  start: number;
  end: number;
}

function removeSelectionMarkers(value: string): string {
  return value
    .replaceAll(SELECTION_START_MARKER, '')
    .replaceAll(SELECTION_END_MARKER, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanAttrs(
  attrs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!attrs || typeof attrs !== 'object') {
    return attrs;
  }

  const cleaned: Record<string, unknown> = { ...attrs };
  for (const key of Object.keys(cleaned)) {
    const value = cleaned[key];
    if (typeof value === 'string') {
      cleaned[key] = removeSelectionMarkers(value);
    }
  }
  return cleaned;
}

export function cleanSelectionMarkersFromJsonContent(content: JSONContent): JSONContent {
  if (!content || typeof content !== 'object') {
    return content;
  }

  const next: JSONContent = { ...content };
  if (typeof next.text === 'string') {
    next.text = removeSelectionMarkers(next.text);
  }
  next.attrs = cleanAttrs(next.attrs);
  if (Array.isArray(next.marks)) {
    next.marks = next.marks.map((mark) => {
      const nextMark = { ...mark };
      nextMark.attrs = cleanAttrs(nextMark.attrs);
      return nextMark;
    });
  }
  if (Array.isArray(next.content)) {
    next.content = next.content.map((child) => cleanSelectionMarkersFromJsonContent(child));
  }

  return next;
}

export function insertSelectionMarkersIntoMarkdown(
  markdown: string,
  start: number,
  end: number,
): string {
  const clampedStart = Math.max(0, Math.min(start, markdown.length));
  const clampedEnd = Math.max(clampedStart, Math.min(end, markdown.length));

  // Selection markers must live inside parsed text nodes, not inside Markdown
  // syntax. Placing them before a list marker, inside a fence, or after a table
  // row makes the parser absorb them into different structure and can leak
  // extra rows/columns/quotes back out on mode switch.
  const selectionStart = findNearestTextOffset(markdown, clampedStart);
  const selectionEnd = Math.max(
    selectionStart,
    findNearestTextOffset(markdown, clampedEnd),
  );

  // Caret/range at document end after a block whose closing syntax has no text
  // node (for example a code fence) still needs a separate paragraph line so
  // the marker cannot be swallowed by the previous block.
  if (
    selectionEnd === markdown.length &&
    (markdown.endsWith('\r\n') || markdown.endsWith('\n'))
  ) {
    return `${markdown}\n${SELECTION_START_MARKER}${markdown.slice(
      selectionStart,
      selectionEnd,
    )}${SELECTION_END_MARKER}`;
  }

  return `${markdown.slice(0, selectionStart)}${SELECTION_START_MARKER}${markdown.slice(
    selectionStart,
    selectionEnd,
  )}${SELECTION_END_MARKER}${markdown.slice(selectionEnd)}`;
}

export function extractSelectionMarkersFromMarkdown(markdown: string): {
  markdown: string;
  selection: SourceSearchMatch;
} {
  const startIndex = markdown.indexOf(SELECTION_START_MARKER);
  const endIndex = markdown.indexOf(SELECTION_END_MARKER);
  const withoutStart = markdown.replace(SELECTION_START_MARKER, '');
  const normalizedEndIndex =
    endIndex === -1
      ? startIndex === -1
        ? 0
        : startIndex
      : endIndex - (startIndex !== -1 && startIndex < endIndex ? SELECTION_START_MARKER.length : 0);
  const cleanMarkdown = withoutStart.replace(SELECTION_END_MARKER, '');
  const selectionStart = startIndex === -1 ? Math.min(normalizedEndIndex, cleanMarkdown.length) : startIndex;
  const selectionEnd = Math.max(selectionStart, Math.min(normalizedEndIndex, cleanMarkdown.length));

  return {
    markdown: cleanMarkdown,
    selection: {
      start: selectionStart,
      end: selectionEnd,
    },
  };
}

function cleanMarkAttrs(mark: ProseMirrorMark): ProseMirrorMark {
  const attrs = mark.attrs as Record<string, unknown> | undefined;
  const cleaned = cleanAttrs(attrs);
  if (cleaned === attrs) {
    return mark;
  }
  return mark.type.create(cleaned ?? {});
}

function cleanNode(
  node: ProseMirrorNode,
  schema: Schema,
): { node: ProseMirrorNode; foundMarkers: boolean } {
  if (node.isText) {
    const text = node.text ?? '';
    const foundMarkers = text.includes(SELECTION_START_MARKER) || text.includes(SELECTION_END_MARKER);
    if (!foundMarkers) {
      return { node, foundMarkers: false };
    }
    const cleaned = text.replaceAll(SELECTION_START_MARKER, '').replaceAll(SELECTION_END_MARKER, '');
    const marks = node.marks.map(cleanMarkAttrs);
    if (!cleaned) {
      // Empty text nodes are not allowed by ProseMirror; the parent block
      // replacement drops this child instead of creating a TextNode.
      return { node: null as unknown as ProseMirrorNode, foundMarkers: true };
    }
    return { node: schema.text(cleaned, marks), foundMarkers: true };
  }

  const children: ProseMirrorNode[] = [];
  node.content.forEach((child) => children.push(child));
  const cleanedChildren: ProseMirrorNode[] = [];
  let foundMarkers = false;
  for (const child of children) {
    const result = cleanNode(child, schema);
    if (result.foundMarkers) {
      foundMarkers = true;
    }
    if (result.node) {
      cleanedChildren.push(result.node);
    }
  }

  const attrs = node.attrs as Record<string, unknown> | undefined;
  const cleanedAttrs = cleanAttrs(attrs);
  if (JSON.stringify(attrs ?? {}).includes('MDEDITORSELECTION')) {
    foundMarkers = true;
  }
  if (!foundMarkers && cleanedAttrs === attrs) {
    return { node, foundMarkers: false };
  }
  return {
    node: node.type.create(cleanedAttrs ?? {}, cleanedChildren),
    foundMarkers,
  };
}

export function restoreSelectionMarkersFromEditorState(
  state: EditorState,
  view: EditorView,
): boolean {
  const schema = state.schema;
  const sourceState = view.state;
  const blockEntries: Array<{ from: number; to: number; node: ProseMirrorNode | null }> = [];

  let startPos: number | null = null;
  let endPos: number | null = null;
  let mathSelection: { pos: number; start: number; end: number } | null = null;

  const topLevel: ProseMirrorNode[] = [];
  sourceState.doc.content.forEach((child) => topLevel.push(child));

  let blockFrom = 0;
  for (const block of topLevel) {
    const blockStart = blockFrom;
    const blockEnd = blockStart + block.nodeSize;
    blockFrom = blockEnd;

    const cleaned = cleanNode(block, schema);
    if (!cleaned.foundMarkers) {
      continue;
    }

    let replacement: ProseMirrorNode | null;
    if (cleaned.node && cleaned.node.content.size === 0) {
      replacement = block.type.name === 'paragraph' ? null : cleaned.node;
    } else {
      replacement = cleaned.node;
    }
    blockEntries.push({ from: blockStart, to: blockEnd, node: replacement });
  }

  sourceState.doc.descendants((node, pos) => {
    if (!node.isText || !node.text || !node.text.includes('MDEDITORSELECTION')) {
      return true;
    }
    const text = node.text;
    const startIndex = text.indexOf(SELECTION_START_MARKER);
    const endIndex = text.indexOf(SELECTION_END_MARKER);
    if (startIndex !== -1) {
      startPos = pos + startIndex;
    }
    if (endIndex !== -1) {
      startPos = startPos ?? pos + endIndex;
      endPos = pos + endIndex;
    }

    const $pos = sourceState.doc.resolve(pos);
    for (let depth = $pos.depth; depth > 0; depth -= 1) {
      if ($pos.node(depth).type.name === 'inlineMath') {
        const inner = $pos.node(depth).textContent;
        const s = inner.indexOf(SELECTION_START_MARKER);
        const e = inner.indexOf(SELECTION_END_MARKER);
        if (s !== -1 || e !== -1) {
          mathSelection = {
            pos: $pos.before(depth),
            start: s === -1 ? 0 : s,
            end: e === -1 ? inner.length : e,
          };
        }
        break;
      }
    }
    return true;
  });

  if (blockEntries.length === 0 && startPos === null && endPos === null && mathSelection === null) {
    return false;
  }

  blockEntries.sort((left, right) => right.from - left.from);
  let tr = sourceState.tr.setMeta('addToHistory', false);
  for (const entry of blockEntries) {
    const from = tr.mapping.map(entry.from);
    const to = tr.mapping.map(entry.to);
    if (entry.node) {
      tr = tr.replaceWith(from, to, entry.node);
    } else {
      tr = tr.delete(from, to);
    }
  }

  if (mathSelection) {
    const mathSelectionInfo = mathSelection as { pos: number; start: number; end: number };
    const mathPos = tr.mapping.map(mathSelectionInfo.pos);
    try {
      tr = tr.setSelection(NodeSelection.create(tr.doc, mathPos));
    } catch {
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(mathPos)));
    }
    view.dispatch(tr);
    view.focus();
    window.dispatchEvent(
      new CustomEvent('markdown-editor:focus-math-search-match', {
        detail: {
          pos: mathPos,
          start: mathSelectionInfo.start,
          end: mathSelectionInfo.end,
        },
      }),
    );
    return true;
  }

  if (startPos !== null || endPos !== null) {
    try {
      const mappedStart = startPos === null ? null : tr.mapping.map(startPos);
      const mappedEnd = endPos === null ? null : tr.mapping.map(endPos);
      const safeStart = Math.max(
        1,
        Math.min(mappedStart ?? mappedEnd ?? 1, tr.doc.content.size),
      );
      const safeEnd = Math.max(
        safeStart,
        Math.min(mappedEnd ?? mappedStart ?? 1, tr.doc.content.size),
      );
      tr = tr.setSelection(TextSelection.create(tr.doc, safeStart, safeEnd));
    } catch {
      try {
        const mappedStart = startPos === null ? null : tr.mapping.map(startPos);
        const mappedEnd = endPos === null ? null : tr.mapping.map(endPos);
        tr = tr.setSelection(
          TextSelection.near(
            tr.doc.resolve(Math.min(mappedEnd ?? mappedStart ?? 1, tr.doc.content.size)),
          ),
        );
      } catch {
        // Keep the content fix even if selection restore fails.
      }
    }
    view.dispatch(tr);
    view.focus();
    return true;
  }

  view.dispatch(tr);
  return true;
}

import type { JSONContent } from '@tiptap/core';
import { parseMarkdown, parseMarkdownFragment } from './markdown';
import {
  SELECTION_END_MARKER,
  SELECTION_START_MARKER,
  insertSelectionMarkersIntoMarkdown,
} from './selection-markers';

const CONTAINER_NODE_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'taskList',
  'listItem',
  'taskItem',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'codeBlock',
  'footnoteDefinition',
  'inlineMath',
]);

export type SourceBlockKind = 'paragraph' | 'heading' | 'codeBlock' | 'other';

export interface SourceBlockSpan {
  sourceStart: number;
  sourceEnd: number;
  kind: SourceBlockKind;
  text: string;
}

export interface SourceBlockAnchor extends SourceBlockSpan {
  pmStart: number;
  pmEnd: number;
}

interface SourceLine {
  text: string;
  start: number;
  end: number;
}

function findMarkerOffset(value: string): number {
  const startIndex = value.indexOf(SELECTION_START_MARKER);
  const endIndex = value.indexOf(SELECTION_END_MARKER);
  if (startIndex === -1) {
    return endIndex;
  }
  if (endIndex === -1) {
    return startIndex;
  }
  return Math.min(startIndex, endIndex);
}

function estimateNodeSize(node: JSONContent): number {
  if (node.type === 'text') {
    return node.text?.length ?? 0;
  }

  if (Array.isArray(node.content) && node.content.length > 0) {
    let size = 2;
    for (const child of node.content) {
      size += estimateNodeSize(child);
    }
    return size;
  }

  if (node.type != null && CONTAINER_NODE_TYPES.has(node.type)) {
    return 2;
  }

  return 1;
}

function normalizeTopLevelContent(content: JSONContent): JSONContent {
  if (!Array.isArray(content.content)) {
    return content;
  }
  return {
    ...content,
    content: content.content.map((node) =>
      node.type === "inlineMath" && node.attrs?.display === "yes"
        ? { type: "paragraph", content: [node] }
        : node,
    ),
  };
}

function locateMarkerInJson(
  node: JSONContent | null | undefined,
  nodePos: number,
  childrenStartAtZero: boolean,
): number | null {
  if (!node || typeof node !== 'object') {
    return null;
  }

  if (typeof node.text === 'string') {
    const markerOffset = findMarkerOffset(node.text);
    if (markerOffset !== -1) {
      return nodePos + markerOffset;
    }
  }

  if (Array.isArray(node.content)) {
    let childPos = childrenStartAtZero ? 0 : nodePos + 1;
    for (const child of node.content) {
      const markerPos = locateMarkerInJson(child, childPos, false);
      if (markerPos !== null) {
        return markerPos;
      }
      childPos += estimateNodeSize(child);
    }
  }

  return null;
}

function isBlankLine(line: string): boolean {
  return line.trim() === '';
}

function lineKind(line: string): SourceBlockKind | null {
  if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
    return 'codeBlock';
  }
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) {
    return 'heading';
  }
  if (
    /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/.test(line) ||
    /^ {0,3}\|/.test(line) ||
    /^ {0,3}>/.test(line) ||
    /^(?: {4}|\t)/.test(line) ||
    /^</.test(line)
  ) {
    return 'other';
  }
  return 'paragraph';
}

function getFenceInfo(line: string): { char: string; length: number } | null {
  const match = line.match(/^( {0,3})(`{3,}|~{3,})/);
  if (!match) {
    return null;
  }
  const fence = match[2]!;
  return { char: fence[0]!, length: fence.length };
}

function splitSourceLines(source: string): SourceLine[] {
  if (!source) {
    return [];
  }

  const lines: SourceLine[] = [];
  let offset = 0;
  while (offset <= source.length) {
    const newlineIndex = source.indexOf('\n', offset);
    if (newlineIndex === -1) {
      const text = source.slice(offset);
      lines.push({ text, start: offset, end: offset + text.length });
      break;
    }
    const rawText = source.slice(offset, newlineIndex);
    const text = rawText.endsWith('\r') ? rawText.slice(0, -1) : rawText;
    lines.push({ text, start: offset, end: offset + text.length });
    offset = newlineIndex + 1;
  }

  while (
    lines.length > 0 &&
    lines[lines.length - 1]!.text === '' &&
    lines[lines.length - 1]!.start === source.length
  ) {
    lines.pop();
  }
  return lines;
}

export function getSourceBlockSpans(source: string): SourceBlockSpan[] {
  const lines = splitSourceLines(source);
  const spans: SourceBlockSpan[] = [];
  let index = 0;

  while (index < lines.length) {
    while (index < lines.length && isBlankLine(lines[index]!.text)) {
      index += 1;
    }
    if (index >= lines.length) {
      break;
    }

    const startIndex = index;
    const firstFence = getFenceInfo(lines[index]!.text);
    if (firstFence) {
      let endIndex = index;
      let closed = false;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const fence = getFenceInfo(lines[cursor]!.text);
        if (
          fence &&
          fence.char === firstFence.char &&
          fence.length >= firstFence.length
        ) {
          endIndex = cursor;
          closed = true;
          break;
        }
      }
      if (!closed) {
        endIndex = lines.length - 1;
      }
      const start = lines[startIndex]!.start;
      const end = lines[endIndex]!.end;
      spans.push({
        sourceStart: start,
        sourceEnd: end,
        kind: 'codeBlock',
        text: source.slice(start, end),
      });
      index = endIndex + 1;
      continue;
    }

    let kind: SourceBlockKind = 'paragraph';
    while (index < lines.length && !isBlankLine(lines[index]!.text)) {
      const fence = getFenceInfo(lines[index]!.text);
      if (fence) {
        break;
      }
      const lineType = lineKind(lines[index]!.text);
      if (lineType === 'heading') {
        kind = 'heading';
      } else if (lineType === 'other') {
        kind = 'other';
      }
      index += 1;
    }

    const endIndex = index - 1;
    const start = lines[startIndex]!.start;
    const end = lines[endIndex]!.end;
    spans.push({
      sourceStart: start,
      sourceEnd: end,
      kind,
      text: source.slice(start, end),
    });
  }

  return spans;
}

export function findChangedSourceRange(
  oldSource: string,
  newSource: string,
): { start: number; oldEnd: number; newEnd: number } | null {
  const maxLength = Math.max(oldSource.length, newSource.length);
  let prefix = 0;
  while (
    prefix < maxLength &&
    oldSource[prefix] === newSource[prefix]
  ) {
    prefix += 1;
  }
  if (prefix === maxLength && oldSource.length === newSource.length) {
    return null;
  }

  let oldSuffix = oldSource.length;
  let newSuffix = newSource.length;
  while (
    oldSuffix > prefix &&
    newSuffix > prefix &&
    oldSource[oldSuffix - 1] === newSource[newSuffix - 1]
  ) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }
  return {
    start: prefix,
    oldEnd: oldSuffix,
    newEnd: newSuffix,
  };
}

export function buildSourceBlockAnchors(
  source: string,
  topLevelNodeSizes: number[],
): SourceBlockAnchor[] {
  const spans = getSourceBlockSpans(source);
  if (spans.length !== topLevelNodeSizes.length) {
    return [];
  }

  let pmStart = 0;
  return spans.map((span, index) => {
    const nodeSize = topLevelNodeSizes[index] ?? 0;
    const pmEnd = pmStart + nodeSize;
    const anchor: SourceBlockAnchor = {
      ...span,
      pmStart,
      pmEnd,
    };
    pmStart = pmEnd;
    return anchor;
  });
}

export function findSourceBlockAnchor(
  anchors: SourceBlockAnchor[],
  sourceOffset: number,
): SourceBlockAnchor | null {
  if (anchors.length === 0) {
    return null;
  }
  const exact =
    anchors.find(
      (anchor) =>
        sourceOffset >= anchor.sourceStart && sourceOffset <= anchor.sourceEnd,
    ) ?? null;
  if (exact) {
    return exact;
  }
  if (sourceOffset <= anchors[0]!.sourceStart) {
    return anchors[0]!;
  }
  const last = anchors[anchors.length - 1]!;
  if (sourceOffset >= last.sourceEnd) {
    return last;
  }
  return (
    anchors.find((anchor) => sourceOffset < anchor.sourceEnd) ??
    last
  );
}

/**
 * Maps a source offset to a PM position by parsing only the containing block.
 * This keeps mode switches from reparsing the full document when a source edit
 * stayed inside one block or when only the selection changed.
 */
export function sourceOffsetToPmPosWithAnchors(
  source: string,
  anchors: SourceBlockAnchor[],
  sourceOffset: number,
  docSize: number,
): number | null {
  const block = findSourceBlockAnchor(anchors, sourceOffset);
  if (!block) {
    return null;
  }

  const blockText = source.slice(block.sourceStart, block.sourceEnd);
  const relative = Math.max(
    0,
    Math.min(sourceOffset - block.sourceStart, blockText.length),
  );
  const markedBlock = insertSelectionMarkersIntoMarkdown(blockText, relative, relative);
  const fragment = parseMarkdownFragment(markedBlock);
  const miniDoc: JSONContent = {
    type: 'doc',
    content: fragment,
  };
  const markerPos = locateMarkerInJson(miniDoc, 0, true);
  if (markerPos === null) {
    return null;
  }
  return Math.max(0, Math.min(block.pmStart + markerPos, docSize));
}

export function markdownOffsetToPmPos(
  markdown: string,
  content: JSONContent,
  offset: number,
): number | null {
  if (!Number.isFinite(offset)) {
    return null;
  }

  const clampedOffset = Math.max(0, Math.min(offset, markdown.length));
  const markedMarkdown = insertSelectionMarkersIntoMarkdown(
    markdown,
    clampedOffset,
    clampedOffset,
  );
  const markedContent = normalizeTopLevelContent(parseMarkdown(markedMarkdown));
  return locateMarkerInJson(markedContent, 0, true);
}

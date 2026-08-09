import type { JSONContent } from '@tiptap/core';
import { parseMarkdown } from './markdown';
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
  const markedContent = parseMarkdown(markedMarkdown);
  return locateMarkerInJson(markedContent, 0, true);
}

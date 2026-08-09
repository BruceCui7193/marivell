import type { Editor } from '@tiptap/core';
import { coordsAtPos, posAtCoords } from './virtualization/coordinate-service';

export interface ScrollAnchor {
  pmPos: number;
  offsetTop: number;
}

export function captureVisualScrollAnchor(frame: HTMLElement, editor: Editor): ScrollAnchor | null {
  try {
    const frameRect = frame.getBoundingClientRect();
    if (frameRect.width <= 0 || frameRect.height <= 0) {
      return null;
    }

    const point = posAtCoords(
      editor,
      frameRect.left + frameRect.width / 2,
      frameRect.top + Math.min(12, frameRect.height),
    );
    if (!point) {
      return null;
    }

    const coords = coordsAtPos(editor, point.pos);
    if (!coords || (coords.top === 0 && coords.bottom === 0 && coords.left === 0 && coords.right === 0)) {
      return null;
    }

    return {
      pmPos: point.pos,
      offsetTop: coords.top - frameRect.top,
    };
  } catch {
    return null;
  }
}

export function restoreVisualScrollAnchor(
  frame: HTMLElement,
  editor: Editor,
  anchor: ScrollAnchor,
): void {
  try {
    const frameRect = frame.getBoundingClientRect();
    if (frameRect.width <= 0 || frameRect.height <= 0) {
      return;
    }

    const docSize = editor.state.doc.content.size;
    const pos = Math.max(0, Math.min(anchor.pmPos, docSize));
    const coords = coordsAtPos(editor, pos);
    if (!coords) {
      return;
    }
    const delta = anchor.offsetTop - (coords.top - frameRect.top);
    const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
    frame.scrollTop = Math.max(0, Math.min(frame.scrollTop + delta, maxScrollTop));
  } catch {
    // jsdom and transient ProseMirror layouts may not expose usable coordinates.
  }
}

export interface SourceScrollAnchor {
  markdownOffset: number;
  offsetTop: number;
}

export function captureSourceScrollAnchor(textarea: HTMLTextAreaElement): SourceScrollAnchor {
  return {
    markdownOffset: textarea.selectionStart ?? 0,
    offsetTop: textarea.scrollTop,
  };
}

export function restoreSourceScrollAnchor(
  textarea: HTMLTextAreaElement,
  anchor: SourceScrollAnchor,
): void {
  const clampedOffset = Math.max(0, Math.min(anchor.markdownOffset, textarea.value.length));
  textarea.setSelectionRange(clampedOffset, clampedOffset);
  const maxScrollTop = Math.max(textarea.scrollHeight - textarea.clientHeight, 0);
  textarea.scrollTop = Math.max(0, Math.min(anchor.offsetTop, maxScrollTop));
}

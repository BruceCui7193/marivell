import { endFunctionTimer, startFunctionTimer } from './virtualization/function-timers';
import type { Editor } from '@tiptap/core';
import { coordsAtPos, posAtCoords } from './virtualization/coordinate-service';

export interface ScrollAnchor {
  pmPos: number;
  offsetTop: number;
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
}

export function captureVisualScrollAnchor(frame: HTMLElement, editor: Editor): ScrollAnchor | null {
  startFunctionTimer('captureVisualScrollAnchor');
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

    const result = {
      pmPos: point.pos,
      offsetTop: coords.top - frameRect.top,
      scrollTop: frame.scrollTop,
      scrollHeight: frame.scrollHeight,
      clientHeight: frame.clientHeight,
    };
    endFunctionTimer('captureVisualScrollAnchor');
    return result;
  } catch {
    endFunctionTimer('captureVisualScrollAnchor');
    return null;
  }
}

export function restoreVisualScrollAnchor(
  frame: HTMLElement,
  editor: Editor,
  anchor: ScrollAnchor,
): void {
  startFunctionTimer('restoreVisualScrollAnchor');
  try {
    // Fast path: skip the expensive getBoundingClientRect() + coordsAtPos +
    // scrollTop write when the frame state hasn't changed since capture.
    // Order matters: reading scrollTop/scrollHeight/clientHeight skips the
    // forced layout that getBoundingClientRect() would trigger.
    if (
      typeof anchor.scrollTop === 'number' &&
      typeof anchor.scrollHeight === 'number' &&
      typeof anchor.clientHeight === 'number' &&
      frame.scrollTop === anchor.scrollTop &&
      frame.scrollHeight === anchor.scrollHeight &&
      frame.clientHeight === anchor.clientHeight
    ) {
      endFunctionTimer('restoreVisualScrollAnchor');
      return;
    }

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
    endFunctionTimer('restoreVisualScrollAnchor');
  } catch {
    endFunctionTimer('restoreVisualScrollAnchor');
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

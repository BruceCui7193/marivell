import type { EditorView } from '@tiptap/pm/view';
import { forceActivateById } from './activation-controller';
import { hydrateTargetRange } from './activation-controller';
import { hydrateInlineMathGroupsAroundPosition } from './inline-math-group-registry';

export interface CoordinateEditor {
  view: EditorView;
}

type CoordsAtPos = ReturnType<EditorView['coordsAtPos']>;
type DomAtPos = ReturnType<EditorView['domAtPos']>;
type PosAtCoords = ReturnType<EditorView['posAtCoords']>;

function getElementFromDomPosition(node: Node): Element | null {
  const candidate = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return candidate instanceof Element ? candidate : null;
}

export function forceActivateAtPosition(editor: CoordinateEditor, pos: number): void {
  try {
    const domPosition = editor.view.domAtPos(pos);
    let element = getElementFromDomPosition(domPosition.node);

    while (element) {
      const id = element.getAttribute('data-virtual-node-id');
      if (id) {
        forceActivateById(id);
        return;
      }
      element = element.parentElement;
    }
  } catch {
    // Coordinate activation is a best-effort pre-activation step.
  }
}

export function forceActivateAtCoords(editor: CoordinateEditor, left: number, top: number): void {
  try {
    const position = editor.view.posAtCoords({ left, top });
    if (position) {
      forceActivateAtPosition(editor, position.pos);
    }
  } catch {
    // Coordinate activation is a best-effort pre-activation step.
  }
}

export function coordsAtPos(editor: CoordinateEditor, pos: number): CoordsAtPos | null {
  try {
    forceActivateAtPosition(editor, pos);
    return editor.view.coordsAtPos(pos);
  } catch {
    return null;
  }
}

export function posAtCoords(editor: CoordinateEditor, left: number, top: number): PosAtCoords {
  try {
    const initial = editor.view.posAtCoords({ left, top });
    if (!initial) {
      return null;
    }

    forceActivateAtPosition(editor, initial.pos);
    return editor.view.posAtCoords({ left, top });
  } catch {
    return null;
  }
}

export function domAtPos(editor: CoordinateEditor, pos: number): DomAtPos | null {
  try {
    forceActivateAtPosition(editor, pos);
    return editor.view.domAtPos(pos);
  } catch {
    return null;
  }
}

export function scrollPosIntoView(editor: CoordinateEditor, pos: number): boolean {
  try {
    forceActivateAtPosition(editor, pos);
    const clamped = Math.max(0, Math.min(pos, editor.view.state.doc.content.size));
    const domPosition = editor.view.domAtPos(clamped);
    const node = domPosition.node;
    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as HTMLElement;
    element?.scrollIntoView({ block: 'center', behavior: 'auto' });
    return true;
  } catch {
    return false;
  }
}

function nextAnimationFrames(count = 2): Promise<void> {
  if (typeof requestAnimationFrame === 'undefined') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const tick = (remaining: number): void => {
      if (remaining <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(() => tick(remaining - 1));
    };
    tick(count);
  });
}

export async function hydrateAndWaitForPosition(
  editor: CoordinateEditor,
  pos: number,
): Promise<boolean> {
  try {
    const clamped = Math.max(0, Math.min(pos, editor.view.state.doc.content.size));
    forceActivateAtPosition(editor, clamped);
    const frame = editor.view.dom.closest<HTMLElement>('.editor-frame');
    if (frame) {
      const viewportRadius = Math.max(frame.clientHeight || 1, 1);
      hydrateTargetRange(frame, clamped, viewportRadius);
      hydrateInlineMathGroupsAroundPosition(frame, clamped, viewportRadius);
    }
    await nextAnimationFrames();
    forceActivateAtPosition(editor, clamped);
    return true;
  } catch {
    return false;
  }
}

export async function scrollPosIntoViewAfterHydration(
  editor: CoordinateEditor,
  pos: number,
): Promise<boolean> {
  try {
    await hydrateAndWaitForPosition(editor, pos);
    const clamped = Math.max(0, Math.min(pos, editor.view.state.doc.content.size));
    forceActivateAtPosition(editor, clamped);
    const coords = coordsAtPos(editor, clamped);
    const frame = editor.view.dom.closest<HTMLElement>('.editor-frame');
    if (coords && frame) {
      const frameRect = frame.getBoundingClientRect();
      const elementHeight = Math.max(coords.bottom - coords.top, 1);
      const targetTop =
        frame.scrollTop +
        coords.top -
        frameRect.top -
        Math.max((frame.clientHeight - elementHeight) / 2, 0);
      const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
      frame.scrollTop = Math.max(0, Math.min(targetTop, maxScrollTop));
      return true;
    }
    const domPosition = editor.view.domAtPos(clamped);
    const node = domPosition.node;
    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as HTMLElement;
    element?.scrollIntoView({ block: 'center', behavior: 'auto' });
    return true;
  } catch {
    return false;
  }
}

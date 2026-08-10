import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

interface Token {
  from: number;
  to: number;
  class: string;
}

interface MathSyntaxRange {
  from: number;
  to: number;
  reason: 'selection' | 'viewport' | 'editing';
}

interface MathSyntaxState {
  set: DecorationSet;
  ranges: MathSyntaxRange[];
  fullBuildCount: number;
  localBuildCount: number;
  spanCount: number;
}

interface MathSyntaxDiagnostics {
  fullBuildCount: number;
  localBuildCount: number;
  spanCount: number;
  rangeCount: number;
  scrollEventCount: number;
  viewportRafCount: number;
  viewportDispatchCount: number;
  viewportSkippedCount: number;
}

const mathSyntaxKey = new PluginKey<MathSyntaxState>('mathSyntaxHighlight');
// Kept outside PM state so viewport redraws can restore the user's scroll.
let pendingViewportScrollTop: number | null = null;
let lastViewportFrom = -1;
let lastViewportTo = -1;
let lastSelectionChangeAt = -1;
let viewportScrollEventCount = 0;
let viewportRafCount = 0;
let viewportDispatchCount = 0;
let viewportSkippedCount = 0;

function clampDocPos(doc: ProseMirrorNode, pos: number): number {
  return Math.max(0, Math.min(doc.content.size, pos));
}

function setDiagnostics(state: MathSyntaxState): void {
  const diagnostics: MathSyntaxDiagnostics = {
    fullBuildCount: state.fullBuildCount,
    localBuildCount: state.localBuildCount,
    spanCount: state.spanCount,
    rangeCount: state.ranges.length,
    scrollEventCount: viewportScrollEventCount,
    viewportRafCount: viewportRafCount,
    viewportDispatchCount: viewportDispatchCount,
    viewportSkippedCount: viewportSkippedCount,
  };
  (globalThis as unknown as Record<string, unknown>).__marivellMathSyntaxDiagnostics =
    diagnostics;
}

function publishViewportDiagnostics(): void {
  const current = (globalThis as unknown as Record<string, unknown>)
    .__marivellMathSyntaxDiagnostics as MathSyntaxDiagnostics | undefined;
  (globalThis as unknown as Record<string, unknown>).__marivellMathSyntaxDiagnostics = {
    fullBuildCount: current?.fullBuildCount ?? 0,
    localBuildCount: current?.localBuildCount ?? 0,
    spanCount: current?.spanCount ?? 0,
    rangeCount: current?.rangeCount ?? 0,
    scrollEventCount: viewportScrollEventCount,
    viewportRafCount: viewportRafCount,
    viewportDispatchCount: viewportDispatchCount,
    viewportSkippedCount: viewportSkippedCount,
  };
}

function tokenizeLatex(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] === '\\') {
      const start = i;
      i += 1;
      while (i < text.length && /[a-zA-Z]/.test(text[i])) {
        i += 1;
      }
      if (i < text.length && text[i] === '*') {
        i += 1;
      }
      tokens.push({ from: start, to: i, class: 'math-syntax-cmd' });
      continue;
    }

    if (text[i] === '{' || text[i] === '}') {
      tokens.push({ from: i, to: i + 1, class: 'math-syntax-brace' });
      i += 1;
      continue;
    }

    if (text[i] === '_' || text[i] === '^') {
      tokens.push({ from: i, to: i + 1, class: 'math-syntax-special' });
      i += 1;
      continue;
    }

    if (text[i] === '%') {
      const start = i;
      while (i < text.length && text[i] !== '\n') {
        i += 1;
      }
      tokens.push({ from: start, to: i, class: 'math-syntax-comment' });
      continue;
    }

    i += 1;
  }

  return tokens;
}

function expandToInlineMathRange(doc: ProseMirrorNode, pos: number): { from: number; to: number } | null {
  if (pos < 0 || pos > doc.content.size) {
    return null;
  }

  const $pos = doc.resolve(pos);
  if ($pos.parent.type.name === 'inlineMath') {
    return {
      from: $pos.before($pos.depth),
      to: $pos.after($pos.depth),
    };
  }

  const nodeBefore = $pos.nodeBefore;
  if (nodeBefore?.type.name === 'inlineMath') {
    return {
      from: pos - nodeBefore.nodeSize,
      to: pos,
    };
  }

  const nodeAfter = $pos.nodeAfter;
  if (nodeAfter?.type.name === 'inlineMath') {
    return {
      from: pos,
      to: pos + nodeAfter.nodeSize,
    };
  }

  return null;
}

function expandRangeToTouchingInlineMath(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): { from: number; to: number } {
  const start = expandToInlineMathRange(doc, from);
  const end = expandToInlineMathRange(doc, to);

  return {
    from: Math.min(start?.from ?? from, end?.from ?? from),
    to: Math.max(start?.to ?? to, end?.to ?? to),
  };
}

function buildDecorationsForRange(doc: ProseMirrorNode, from: number, to: number): Decoration[] {
  const decorations: Decoration[] = [];

  doc.nodesBetween(from, to, (node: ProseMirrorNode, pos: number) => {
    if (node.type.name !== 'inlineMath') {
      return true;
    }

    const text = node.textContent;
    const base = pos + 1;

    for (const token of tokenizeLatex(text)) {
      const from = base + token.from;
      const to = base + token.to;
      if (from < to) {
        decorations.push(Decoration.inline(from, to, { class: token.class }));
      }
    }

    return false;
  });

  return decorations;
}

function buildDecorationsForRanges(doc: ProseMirrorNode, ranges: MathSyntaxRange[]): Decoration[] {
  const decorations: Decoration[] = [];
  const seen = new Set<string>();

  for (const range of ranges) {
    for (const decoration of buildDecorationsForRange(
      doc,
      clampDocPos(doc, range.from),
      clampDocPos(doc, range.to),
    )) {
      const key = `${decoration.from}:${decoration.to}:${String(decoration.spec.class)}`;
      if (!seen.has(key)) {
        seen.add(key);
        decorations.push(decoration);
      }
    }
  }

  return decorations;
}

function selectionRange(state: EditorState): MathSyntaxRange | null {
  const range = expandRangeToTouchingInlineMath(state.doc, state.selection.from, state.selection.to);
  if (range.from >= range.to) {
    return null;
  }
  return {
    ...range,
    reason: 'selection',
  };
}

function mapRange(
  range: MathSyntaxRange,
  tr: Transaction,
  doc: ProseMirrorNode,
): MathSyntaxRange | null {
  try {
    return {
      ...range,
      from: clampDocPos(doc, tr.mapping.map(range.from)),
      to: clampDocPos(doc, tr.mapping.map(range.to)),
    };
  } catch {
    return null;
  }
}

function buildState(
  doc: ProseMirrorNode,
  ranges: MathSyntaxRange[],
  previous: MathSyntaxState,
): MathSyntaxState {
  const next: MathSyntaxState = {
    set: DecorationSet.empty,
    ranges,
    fullBuildCount: previous.fullBuildCount,
    localBuildCount: previous.localBuildCount,
    spanCount: 0,
  };

  const activeRanges = ranges.filter((range) => range.from < range.to);
  if (activeRanges.length > 0) {
    const decorations = buildDecorationsForRanges(doc, activeRanges);
    next.localBuildCount += 1;
    next.spanCount = decorations.length;
    next.set = DecorationSet.create(doc, decorations);
  }

  setDiagnostics(next);
  return next;
}

function initialState(doc: ProseMirrorNode): MathSyntaxState {
  const state: MathSyntaxState = {
    set: DecorationSet.empty,
    ranges: [],
    fullBuildCount: 0,
    localBuildCount: 0,
    spanCount: 0,
  };
  setDiagnostics(state);
  return state;
}

export const MathSyntaxHighlight = Extension.create({
  name: 'mathSyntaxHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin<MathSyntaxState>({
        key: mathSyntaxKey,
        state: {
          init(_config, state): MathSyntaxState {
            return initialState(state.doc);
          },
          apply(tr, oldState, _oldState, newState): MathSyntaxState {
            const meta = tr.getMeta(mathSyntaxKey) as
              | { type: 'viewport'; range: MathSyntaxRange }
              | undefined;

            if (meta?.type === 'viewport') {
              lastViewportFrom = meta.range.from;
              lastViewportTo = meta.range.to;
              const ranges = [
                ...oldState.ranges.filter((range) => range.reason !== 'viewport'),
                {
                  from: clampDocPos(newState.doc, meta.range.from),
                  to: clampDocPos(newState.doc, meta.range.to),
                  reason: 'viewport' as const,
                },
              ];
              return buildState(newState.doc, ranges, oldState);
            }

            if (!tr.docChanged && !tr.selectionSet) {
              return oldState;
            }
            // Selection jumps clear the pending scroll target so PM can move to
            // the newly selected position instead of restoring a stale scroll.
            pendingViewportScrollTop = null;
            lastViewportFrom = -1;
            lastViewportTo = -1;
            if (tr.selectionSet) lastSelectionChangeAt = Date.now();
            const ranges: MathSyntaxRange[] = [];
            if (tr.docChanged) {
              for (const range of oldState.ranges) {
                if (range.reason === 'selection') continue;
                const mapped = mapRange(range, tr, newState.doc);
                if (mapped) ranges.push(mapped);
              }
            } else {
              ranges.push(...oldState.ranges.filter((range) => range.reason !== 'selection'));
            }

            const selection = selectionRange(newState);
            if (selection) ranges.push(selection);
            return buildState(newState.doc, ranges, oldState);
          },
        },

        view(view: EditorView) {
          let frame: HTMLElement | null = null;
          let rafId: number | null = null;

          const syncFrame = (): void => {
            const next = (view.dom.closest('.editor-frame') ?? view.dom) as HTMLElement;
            if (next !== frame) {
              if (frame) {
                frame.removeEventListener('scroll', scheduleViewportUpdate);
                frame.removeEventListener('scrollend', scheduleViewportUpdate);
              }
              frame = next;
              frame?.addEventListener('scroll', scheduleViewportUpdate, { passive: true });
              frame?.addEventListener('scrollend', scheduleViewportUpdate, { passive: true });
            }
          };

          const scheduleViewportUpdate = (): void => {
            viewportScrollEventCount += 1;
            if (rafId !== null) return;
            pendingViewportScrollTop = ((frame ?? view.dom) as HTMLElement).scrollTop;
            rafId = requestAnimationFrame(() => {
              rafId = null;
              viewportRafCount += 1;
              if (!view.isDestroyed) updateViewport();
              publishViewportDiagnostics();
            });
            syncFrame();
          };

          const updateViewport = (): void => {
            if (!frame || frame.classList.contains('is-source')) return;
            const rect = frame.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;

            try {
              const left = rect.left + rect.width / 2;
              const top = view.posAtCoords({
                left,
                top: rect.top + Math.min(96, rect.height * 0.12),
              });
              const bottom = view.posAtCoords({
                left,
                top: rect.top + rect.height - Math.min(64, rect.height * 0.1),
              });
              if (!top || !bottom) return;

              const range = expandRangeToTouchingInlineMath(
                view.state.doc,
                top.pos,
                bottom.pos,
              );
              if (range.from >= range.to) return;
              if (lastViewportFrom === range.from && lastViewportTo === range.to) {
                viewportSkippedCount += 1;
                return;
              }
              viewportDispatchCount += 1;
              view.dispatch(
                view.state.tr.setMeta(mathSyntaxKey, {
                  type: 'viewport',
                  range: {
                    from: range.from,
                    to: range.to,
                    reason: 'viewport',
                  },
                }),
              );
            } catch {
              // jsdom and headless probes have no usable layout coordinates.
            }
          };

          syncFrame();
          pendingViewportScrollTop = ((frame ?? view.dom) as HTMLElement).scrollTop;
          updateViewport();
          window.addEventListener('resize', scheduleViewportUpdate, { passive: true });

          return {
            update() {
              syncFrame();
            },
            destroy() {
              if (rafId !== null) cancelAnimationFrame(rafId);
              if (frame) {
                frame.removeEventListener('scroll', scheduleViewportUpdate);
                frame.removeEventListener('scrollend', scheduleViewportUpdate);
              }
              window.removeEventListener('resize', scheduleViewportUpdate);
            },
          };
        },

        props: {
          handleScrollToSelection(view: EditorView) {
            const pending = pendingViewportScrollTop;
            if (pending === null) return false;
            // EditorShell may transiently reset scroll to 0 while hydrating a
            // jumped footnote/outline target. In that window let PM finish the
            // jump; ordinary scrolling still restores the user's scrollTop.
            const recentSelectionJump =
              pending === 0 &&
              lastSelectionChangeAt > 0 &&
              Date.now() - lastSelectionChangeAt < 1000 &&
              view.state.selection.from > view.state.doc.content.size * 0.8;
            if (recentSelectionJump) return false;
            const scrollFrame = view.dom.closest<HTMLElement>('.editor-frame') ?? view.dom;
            const maxScrollTop = Math.max(scrollFrame.scrollHeight - scrollFrame.clientHeight, 0);
            scrollFrame.scrollTop = Math.min(pending, maxScrollTop);
            pendingViewportScrollTop = null;
            return true;
          },
          decorations(state) {
            return this.getState(state)?.set ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

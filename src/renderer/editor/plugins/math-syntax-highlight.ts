import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

interface Token {
  from: number;
  to: number;
  class: string;
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

function buildDecorationsForDoc(doc: ProseMirrorNode): DecorationSet {
  return DecorationSet.create(doc, buildDecorationsForRange(doc, 0, doc.content.size));
}

export const MathSyntaxHighlight = Extension.create({
  name: 'mathSyntaxHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        state: {
          init(_config, state): DecorationSet {
            return buildDecorationsForDoc(state.doc);
          },
          apply(tr, oldDecorations, _oldState, newState): DecorationSet {
            if (!tr.docChanged) {
              return tr.mapping.maps.length > 0
                ? oldDecorations.map(tr.mapping, tr.doc)
                : oldDecorations;
            }

            const mapped = oldDecorations.map(tr.mapping, tr.doc);
            const changed = tr.changedRange();
            if (!changed) {
              return mapped;
            }

            const range = expandRangeToTouchingInlineMath(newState.doc, changed.from, changed.to);
            const stale = mapped.find(range.from, range.to);
            const withoutStale = mapped.remove(stale);

            return withoutStale.add(
              newState.doc,
              buildDecorationsForRange(newState.doc, range.from, range.to),
            );
          },
        },

        props: {
          decorations(state) {
            return this.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

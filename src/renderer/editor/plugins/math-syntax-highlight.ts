import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

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

function buildDecorationsForDoc(doc: any): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node: any, pos: number) => {
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

  return decorations.length > 0
    ? DecorationSet.create(doc, decorations)
    : DecorationSet.empty;
}

/**
 * Check whether any step in the transaction touched content inside an
 * inlineMath node — only then do we need to rebuild syntax tokens.
 */
function transactionTouchesMath(tr: any, oldState: any): boolean {
  if (!tr.docChanged) return false;

  for (const step of tr.steps) {
    const map = step.getMap();
    if (!map) continue;

    // `map.ranges` gives the ranges in the old doc that were replaced
    const ranges = map.ranges || [];
    for (const [from, to] of ranges) {
      const resolved = oldState.doc.resolve(from);
      for (let d = resolved.depth; d >= 0; d--) {
        if (resolved.node(d)?.type?.name === 'inlineMath') {
          return true;
        }
      }
    }
  }

  return false;
}

export const MathSyntaxHighlight = Extension.create({
  name: 'mathSyntaxHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        state: {
          init(): DecorationSet {
            return DecorationSet.empty;
          },
          apply(tr, oldDecorations, oldState, newState): DecorationSet {
            if (!tr.docChanged) {
              return oldDecorations.map(tr.mapping, tr.doc);
            }

            // Only rebuild syntax tokens when a math node was actually edited.
            // For all other edits, just map positions through the transaction.
            if (transactionTouchesMath(tr, oldState)) {
              return buildDecorationsForDoc(newState.doc);
            }

            return oldDecorations.map(tr.mapping, tr.doc);
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

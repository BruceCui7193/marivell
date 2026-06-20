import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

interface Token {
  from: number;
  to: number;
  class: string;
}

/**
 * Very simple LaTeX tokenizer for syntax highlighting.
 * Recognizes commands, braces, sub/superscript markers, and comments.
 */
function tokenizeLatex(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < text.length) {
    // Backslash-command: \name or \name{...} — highlight the backslash + name
    if (text[i] === '\\') {
      const start = i;
      i += 1;
      // Consume command name (letters only, e.g. \frac, \alpha)
      while (i < text.length && /[a-zA-Z]/.test(text[i])) {
        i += 1;
      }
      // Also consume a following * (e.g. \begin*)
      if (i < text.length && text[i] === '*') {
        i += 1;
      }
      tokens.push({ from: start, to: i, class: 'math-syntax-cmd' });
      continue;
    }

    // Braces
    if (text[i] === '{' || text[i] === '}') {
      tokens.push({ from: i, to: i + 1, class: 'math-syntax-brace' });
      i += 1;
      continue;
    }

    // Subscript / superscript
    if (text[i] === '_' || text[i] === '^') {
      tokens.push({ from: i, to: i + 1, class: 'math-syntax-special' });
      i += 1;
      continue;
    }

    // Comment: % to end of line
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

function buildDecorations(): DecorationSet {
  // We don't have access to the document here, so we return an empty set.
  // The actual decorations are built in the plugin's state.apply method.
  return DecorationSet.empty;
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
          apply(tr, oldDecorations, _oldState, newState): DecorationSet {
            // Only recompute when the document changed (not on selection changes)
            if (!tr.docChanged) {
              // Map decorations through the transaction to keep positions in sync
              return oldDecorations.map(tr.mapping, tr.doc);
            }

            const decorations: Decoration[] = [];
            const doc = newState.doc;

            doc.descendants((node, pos) => {
              if (node.type.name !== 'inlineMath') {
                return true;
              }

              // The content starts at pos + 1 (after the node opening marker)
              const text = node.textContent;
              const base = pos + 1;

              for (const token of tokenizeLatex(text)) {
                const from = base + token.from;
                const to = base + token.to;
                if (from < to) {
                  decorations.push(
                    Decoration.inline(from, to, { class: token.class }),
                  );
                }
              }

              // Don't descend into inlineMath's content (it only has text)
              return false;
            });

            return DecorationSet.create(doc, decorations);
          },
        },

        props: {
          decorations(state) {
            // Return the current decoration set from the plugin state
            return this.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

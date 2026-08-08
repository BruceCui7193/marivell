import { InputRule, Node, mergeAttributes } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import katex from 'katex';
import { translate } from '../../i18n';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mathInline: {
      insertInlineMath: (value?: string) => ReturnType;
    };
    mathBlock: {
      insertMathBlock: (value?: string) => ReturnType;
    };
  }
}

// Debug flag — toggle via localStorage.setItem('__mathDebug','1') in DevTools.
let __mathDebug = false;
try { __mathDebug = localStorage.getItem('__mathDebug') === '1'; } catch {}
function mathLog(...args: unknown[]): void {
  if (__mathDebug) console.log('[math]', ...args);
}


function findMathCaretPosition(doc: any, from: number, display: string, value: string): number | null {
  let caret: number | null = null;
  doc.descendants((node: any, pos: number) => {
    if (caret !== null) return false;
    if (node.type.name !== 'inlineMath' || node.attrs.display !== display || pos < from) {
      return caret === null;
    }
    const text = node.textContent;
    const matches = value ? text === value : text.trim() === '';
    if (matches) {
      caret = pos + 1 + text.length;
      return false;
    }
    return true;
  });
  return caret;
}

export const MathInline = Node.create({
  name: 'inlineMath',
  group: 'inline',
  inline: true,
  selectable: true,
  atom: false,

  addOptions() {
    return {
      evaluation: false,
    };
  },

  addAttributes() {
    return {
      display: {
        default: 'no', // 'yes' or 'no'
      },
      evaluate: {
        default: 'no',
      },
      // Preserve original delimiter style through parse ↔ serialize round-trips
      // (`$...$`, `\(...\)`, `$$...$$`, `\[...\]`).
      openDelim: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-open-delim'),
        renderHTML: (attributes) =>
          attributes.openDelim ? { 'data-open-delim': attributes.openDelim } : {},
      },
      closeDelim: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-close-delim'),
        renderHTML: (attributes) =>
          attributes.closeDelim ? { 'data-close-delim': attributes.closeDelim } : {},
      },
    };
  },

  content: 'text*',

  parseHTML() {
    return [
      {
        tag: 'span[data-type="inlineMath"]',
        getAttrs: (element) => ({
          display: element.getAttribute('data-display') ?? 'no',
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      node.attrs.display === 'yes' ? 'div' : 'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'inlineMath',
        'data-display': node.attrs.display,
      }),
      0,
    ];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const isBlock = node.attrs.display === 'yes';

      // Create container
      const dom = document.createElement(isBlock ? 'div' : 'span');
      dom.className = isBlock ? 'math-block-node math-node-wrapper' : 'math-inline-node math-node-wrapper';

      // Create editable content element
      const contentDOM = document.createElement('span');
      contentDOM.className = 'math-node-content';
      contentDOM.setAttribute('spellcheck', 'false');

      // Create preview element
      const previewDOM = document.createElement('span');
      previewDOM.className = 'math-node-preview';
      previewDOM.setAttribute('contenteditable', 'false');

      dom.appendChild(contentDOM);
      dom.appendChild(previewDOM);

      // Cache last rendered text to skip redundant KaTeX renders.
      let lastRenderedText: string | null = null;
      let destroyed = false;

      const doRender = (text: string) => {
        if (text === lastRenderedText) return;
        lastRenderedText = text;
        if (!text.trim()) {
          previewDOM.replaceChildren();
          const hint = document.createElement('span');
          hint.className = 'math-node-empty-hint';
          hint.textContent = translate('emptyMath');
          previewDOM.appendChild(hint);
          return;
        }
        try {
          katex.render(text, previewDOM, {
            displayMode: isBlock,
            throwOnError: false,
            strict: 'ignore',
          });
          mathLog('rendered:', text, 'children:', previewDOM.childNodes.length);
        } catch (err) {
          previewDOM.textContent = text;
          mathLog('render error:', err);
        }
      };

      const renderPreview = (text: string) => {
        doRender(text);
      };

      // Handle clicking anywhere on the formula to enter edit mode.
      // The is-editing class is managed by the MathFocusDecoration plugin,
      // so the node view no longer needs to subscribe to editor events.
      dom.addEventListener('click', (event) => {
        if (!editor.isEditable) return;
        if (typeof getPos !== 'function') return;
        if (dom.classList.contains('is-editing')) return;

        const pos = getPos();
        editor.chain().setTextSelection(pos + 1).focus().run();
        event.preventDefault();
        event.stopPropagation();
      });

      mathLog('nodeView created:', node.textContent);
      renderPreview(node.textContent);

      return {
        dom,
        contentDOM,
        update(newNode) {
          if (newNode.type !== node.type) return false;
          if (newNode.attrs.display !== node.attrs.display) return false;
          const textChanged = newNode.textContent !== node.textContent;
          node = newNode;
          if (textChanged) {
            lastRenderedText = ''; // force re-render only when content actually changed
          }
          renderPreview(node.textContent);
          return true;
        },
        selectNode() {},
        deselectNode() {},
        destroy() {
          destroyed = true;
        },
      };
    };
  },

  addCommands() {
    return {
      insertInlineMath:
        (value = '') =>
        ({ state, tr, dispatch }) => {
          const initialValue = value || ' ';
          const mathNode = state.schema.nodes.inlineMath?.create(
            { display: 'no', openDelim: '$', closeDelim: '$' },
            state.schema.text(initialValue)
          );
          if (!mathNode) {
            return false;
          }

          const { from, to } = state.selection;
          tr = tr.replaceWith(from, to, mathNode);
          const caret = value
            ? findMathCaretPosition(tr.doc, from, 'no', value) ?? from + 1 + value.length
            : from + 1;
          tr = tr.setSelection(TextSelection.create(tr.doc, caret));

          if (dispatch) {
            dispatch(tr.scrollIntoView());
          }

          return true;
        },

      insertMathBlock:
        (value = '') =>
        ({ state, tr, dispatch }) => {
          const mathNode = state.schema.nodes.inlineMath?.create(
            { display: 'yes', openDelim: '$$', closeDelim: '$$' },
            value ? state.schema.text(value) : undefined
          );
          if (!mathNode) {
            return false;
          }

          const paragraphNode = state.schema.nodes.paragraph?.create();
          if (!paragraphNode) {
            return false;
          }

          const { from, to } = state.selection;
          tr = tr.replaceWith(from, to, mathNode);

          const paragraphPos = from + mathNode.nodeSize;
          tr = tr.insert(paragraphPos, paragraphNode);
          const caret = findMathCaretPosition(tr.doc, from, 'yes', value) ?? from + 1 + value.length;
          tr = tr.setSelection(TextSelection.create(tr.doc, caret));

          if (dispatch) {
            dispatch(tr.scrollIntoView());
          }

          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        const { state } = this.editor;
        const { selection } = state;
        const { $from, empty } = selection;

        if (!empty) return false;

        if ($from.parent.type.name === 'inlineMath') {
          const isBlock = $from.parent.attrs.display === 'yes';
          const delim = isBlock ? '$$' : '$';

          if ($from.parent.textContent.trim() === '' && $from.parentOffset === 0) {
            return this.editor.commands.command(({ tr, dispatch }) => {
              const pos = $from.before();
              if (dispatch) {
                tr.delete(pos, pos + $from.parent.nodeSize);
                dispatch(tr.scrollIntoView());
              }
              return true;
            });
          }

          if ($from.parentOffset === 0) {
            return this.editor.commands.command(({ tr, dispatch }) => {
              const pos = $from.before();
              const textContent = $from.parent.textContent;
              const replacementText = `${delim}${textContent}${delim}`;
              const textNode = state.schema.text(replacementText);

              if (dispatch) {
                tr.replaceWith(pos, pos + $from.parent.nodeSize, textNode);
                tr.setSelection(TextSelection.create(tr.doc, pos + delim.length));
                dispatch(tr.scrollIntoView());
              }
              return true;
            });
          }
        }
        return false;
      },

      ArrowRight: () => {
        const { state } = this.editor;
        const { selection } = state;
        const { $from, empty } = selection;

        if (!empty) return false;

        const nextNode = $from.nodeAfter;
        if (nextNode && nextNode.type.name === 'inlineMath') {
          return this.editor.commands.command(({ tr, dispatch }) => {
            if (dispatch) {
              tr.setSelection(TextSelection.create(tr.doc, $from.pos + 1));
              dispatch(tr.scrollIntoView());
            }
            return true;
          });
        }
        return false;
      },

      ArrowLeft: () => {
        const { state } = this.editor;
        const { selection } = state;
        const { $from, empty } = selection;

        if (!empty) return false;

        const prevNode = $from.nodeBefore;
        if (prevNode && prevNode.type.name === 'inlineMath') {
          return this.editor.commands.command(({ tr, dispatch }) => {
            if (dispatch) {
              tr.setSelection(TextSelection.create(tr.doc, $from.pos - 1));
              dispatch(tr.scrollIntoView());
            }
            return true;
          });
        }
        return false;
      },

      Enter: () => {
        const { state } = this.editor;
        const { selection } = state;
        const { $from } = selection;

        if (!selection.empty || $from.parent.type.name !== 'paragraph') {
          return false;
        }

        if ($from.parent.textContent.trim() !== '$$') {
          return false;
        }

        const from = $from.before();
        const to = from + $from.parent.nodeSize;

        return this.editor.commands.command(({ tr, dispatch }) => {
          const node = state.schema.nodes.inlineMath?.create(
            { display: 'yes', openDelim: '$$', closeDelim: '$$' }
          );
          if (!node) {
            return false;
          }

          if (dispatch) {
            tr = tr.replaceWith(from, to, node);
            const caret = findMathCaretPosition(tr.doc, from, 'yes', '') ?? from + 1;
            tr = tr.setSelection(TextSelection.create(tr.doc, caret));
            dispatch(tr.scrollIntoView());
          }

          return true;
        });
      },
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: /(?<![\\$])\$([^$\n]+)\$$/,
        handler: ({ chain, range, match }) => {
          const value = String(match[1] ?? '').trim();
          if (!value) return;

          const mathNode = this.editor.state.schema.nodes.inlineMath?.create(
            { display: 'no', openDelim: '$', closeDelim: '$' },
            value ? this.editor.state.schema.text(value) : undefined
          );
          if (!mathNode) return;

          chain()
            .command(({ tr, dispatch }) => {
              const { from, to } = range;
              tr = tr.replaceWith(from, to, mathNode);
              const caret = findMathCaretPosition(tr.doc, from, 'no', value) ?? from + 1 + value.length;
              tr = tr.setSelection(TextSelection.create(tr.doc, caret));
              if (dispatch) {
                dispatch(tr.scrollIntoView());
              }
              return true;
            })
            .run();
        },
      }),
      new InputRule({
        find: /^\$\$([^\n]*)\$\$$/,
        handler: ({ chain, range, match }) => {
          const value = String(match[1] ?? '').trim();

          const mathNode = this.editor.state.schema.nodes.inlineMath?.create(
            { display: 'yes', openDelim: '$$', closeDelim: '$$' },
            value ? this.editor.state.schema.text(value) : undefined
          );
          if (!mathNode) return;

          chain()
            .command(({ tr, dispatch }) => {
              const { from, to } = range;
              tr = tr.replaceWith(from, to, mathNode);
              const caret = findMathCaretPosition(tr.doc, from, 'yes', value) ?? from + 1 + value.length;
              tr = tr.setSelection(TextSelection.create(tr.doc, caret));
              if (dispatch) {
                dispatch(tr.scrollIntoView());
              }
              return true;
            })
            .run();
        },
      }),
    ];
  },
});

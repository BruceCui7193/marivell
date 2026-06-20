import { InputRule, Node, mergeAttributes } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import katex from 'katex';

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

      // Create preview element
      const previewDOM = document.createElement('span');
      previewDOM.className = 'math-node-preview';
      previewDOM.setAttribute('contenteditable', 'false');

      dom.appendChild(contentDOM);
      dom.appendChild(previewDOM);

      const renderPreview = (text: string) => {
        try {
          katex.render(text || '\\text{?}', previewDOM, {
            displayMode: isBlock,
            throwOnError: false,
            strict: 'ignore',
          });
        } catch {
          previewDOM.textContent = text;
        }
      };

      const updateView = () => {
        if (typeof getPos !== 'function') return;

        const pos = getPos();
        const { state } = editor;
        const { from, to } = state.selection;

        const nodeSize = node.nodeSize;
        const isFocused = (from >= pos + 1 && to <= pos + nodeSize - 1) || 
                          (from === pos && to === pos + nodeSize);

        renderPreview(node.textContent);

        if (isFocused && editor.isEditable) {
          dom.classList.add('is-editing');
        } else {
          dom.classList.remove('is-editing');
        }
      };

      // Handle clicking anywhere on the formula to enter edit mode.
      // (previewDOM's click never fires because contentDOM overlays it
      //  with position:absolute + pointer-events:auto when not editing.)
      dom.addEventListener('click', (event) => {
        if (!editor.isEditable) return;
        if (typeof getPos !== 'function') return;
        // Don't interfere with clicks when already editing — the user
        // needs to place the cursor freely inside the contentDOM.
        if (dom.classList.contains('is-editing')) return;

        const pos = getPos();
        editor.chain().setTextSelection(pos + 1).focus().run();
        event.preventDefault();
        event.stopPropagation();
      });

      const onSelectionUpdate = () => {
        updateView();
      };
      editor.on('selectionUpdate', onSelectionUpdate);
      editor.on('transaction', onSelectionUpdate);
      editor.on('focus', onSelectionUpdate);
      editor.on('blur', onSelectionUpdate);

      updateView();

      return {
        dom,
        contentDOM,
        update(newNode) {
          if (newNode.type !== node.type) {
            return false;
          }
          if (newNode.attrs.display !== node.attrs.display) {
            return false;
          }
          node = newNode;
          updateView();
          return true;
        },
        selectNode() {
          updateView();
        },
        deselectNode() {
          updateView();
        },
        destroy() {
          editor.off('selectionUpdate', onSelectionUpdate);
          editor.off('transaction', onSelectionUpdate);
          editor.off('focus', onSelectionUpdate);
          editor.off('blur', onSelectionUpdate);
        },
      };
    };
  },

  addCommands() {
    return {
      insertInlineMath:
        (value = '') =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { display: 'no' },
            content: value ? [{ type: 'text', text: value }] : undefined,
          }),

      insertMathBlock:
        (value = '') =>
        ({ state, tr, dispatch }) => {
          const mathNode = state.schema.nodes.inlineMath?.create(
            { display: 'yes' },
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
          tr = tr.setSelection(TextSelection.create(tr.doc, paragraphPos + 1));

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

          if ($from.parent.textContent === '') {
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
          const node = state.schema.nodes.inlineMath?.create({ display: 'yes' }, state.schema.text(''));
          if (!node) {
            return false;
          }

          if (dispatch) {
            dispatch(tr.replaceWith(from, to, node).scrollIntoView());
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

          chain()
            .deleteRange(range)
            .insertContent({
              type: this.name,
              attrs: { display: 'no' },
              content: [{ type: 'text', text: value }],
            })
            .run();
        },
      }),
      new InputRule({
        find: /^\$\$([^\n]*)\$\$$/,
        handler: ({ chain, range, match }) => {
          const value = String(match[1] ?? '').trim();
          chain()
            .deleteRange(range)
            .insertContent({
              type: this.name,
              attrs: { display: 'yes' },
              content: value ? [{ type: 'text', text: value }] : undefined,
            })
            .run();
        },
      }),
    ];
  },
});

import { Extension } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

function getCurrentParagraphText(editor: { state: { selection: { empty: boolean; $from: { parent: { type: { name: string }; textContent: string; nodeSize: number; isTextblock?: boolean }; before: () => number } } } }): string | null {
  const { selection } = editor.state;
  const { $from } = selection;

  if (!selection.empty || $from.parent.type.name !== 'paragraph') {
    return null;
  }

  return $from.parent.textContent;
}

export const TypingShortcuts = Extension.create({
  name: 'typingShortcuts',

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const paragraphText = getCurrentParagraphText(this.editor);
        if (paragraphText === null) {
          return false;
        }

        const trimmed = paragraphText.trim();
        const { state } = this.editor;
        const { $from } = state.selection;
        const from = $from.before();
        const to = from + $from.parent.nodeSize;

        if (trimmed === '$$' || trimmed === '\\[') {
          return this.editor.commands.command(({ tr, dispatch }) => {
            // Schema uses inlineMath with display="yes" for block formulas.
            const mathType = state.schema.nodes.inlineMath;
            if (!mathType) {
              return false;
            }

            const node = mathType.create({
              display: 'yes',
              openDelim: trimmed === '\\[' ? '\\[' : '$$',
              closeDelim: trimmed === '\\[' ? '\\]' : '$$',
            });

            if (dispatch) {
              tr = tr.replaceWith(from, to, node);
              // Place caret inside the empty math node for immediate editing.
              tr = tr.setSelection(TextSelection.create(tr.doc, from + 1));
              dispatch(tr.scrollIntoView());
            }

            return true;
          });
        }

        const codeFenceMatch = /^(?:```|~~~)([\w-]+)?\s*$/.exec(trimmed);
        if (!codeFenceMatch) {
          return false;
        }

        const language = codeFenceMatch[1] ?? null;

        return this.editor.commands.command(({ tr, dispatch }) => {
          const codeBlockNode =
            language?.toLowerCase() === 'mermaid'
              ? state.schema.nodes.mermaidBlock?.create({ code: '' })
              : state.schema.nodes.codeBlock?.create({ language });

          if (!codeBlockNode) {
            return false;
          }

          tr.replaceWith(from, to, codeBlockNode);

          if (codeBlockNode.type.name === 'codeBlock') {
            tr.setSelection(TextSelection.create(tr.doc, from + 1));
          }

          if (dispatch) {
            dispatch(tr.scrollIntoView());
          }

          return true;
        });
      },
    };
  },
});

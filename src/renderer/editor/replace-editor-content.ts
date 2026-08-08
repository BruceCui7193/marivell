import type { Editor, JSONContent } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';

/**
 * Replace the whole editor document as an external/programmatic action.
 *
 * Building a fresh EditorState keeps the loaded document out of ProseMirror's
 * undo history. Otherwise Ctrl+Z after opening a file can walk back through
 * the load transaction to the previous (often empty) editor state.
 */
export function replaceEditorContent(editor: Editor, content: JSONContent): void {
  // Use Tiptap's normal document creation path first so malformed source
  // (for example an unclosed math delimiter that parses as an inline node)
  // is normalized into a valid ProseMirror document.
  editor.commands.setContent(content, false);

  const doc = editor.state.doc;
  const nextState = EditorState.create({
    schema: editor.schema,
    doc,
    plugins: editor.state.plugins,
  });
  editor.view.updateState(nextState);
}

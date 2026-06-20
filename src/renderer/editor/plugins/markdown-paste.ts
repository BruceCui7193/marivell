import { Extension } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import { DOMParser as ProseMirrorDOMParser, Fragment, Slice } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { convertHtmlToMarkdown, looksLikeStructuredHtml } from '../html-to-markdown';
import { parseMarkdownFragment } from '../markdown';

function hasMarkdownListStructure(text: string): boolean {
  const bulletMatches = text.match(/^(?:[-*+])\s+\S.+$/gm) ?? [];
  if (bulletMatches.length >= 2) {
    return true;
  }

  const orderedMatches = text.match(/^\d+\.\s+\S.+$/gm) ?? [];
  return orderedMatches.length >= 2;
}

function hasExclusiveMarkdownStructure(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  return [
    /^#{1,6}\s+/m,
    /^>\s+/m,
    /^```[\s\S]*```$/m,
    /^~~~[\s\S]*~~~$/m,
    /!\[[^\]]*]\([^)]+\)/,
    /\[[^\]]+]\([^)]+\)/,
    /^\|.+\|$/m,
    /^\[\^[^\]]+]:/m,
  ].some((pattern) => pattern.test(trimmed));
}

function looksLikeMarkdown(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  if (hasExclusiveMarkdownStructure(trimmed) || hasMarkdownListStructure(trimmed)) {
    return true;
  }

  return [/\\\([\s\S]+\\\)/, /\\\[[\s\S]+\\\]/, /\$[^$\n]+\$/].some((pattern) =>
    pattern.test(trimmed),
  );
}

function parseContentFromMarkdown(markdown: string) {
  if (!markdown.trim()) {
    return null;
  }

  try {
    const content = parseMarkdownFragment(markdown);
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

function insertPlainTextFallback(text: string) {
  if (!text) {
    return null;
  }

  try {
    return parseContentFromMarkdown(text.replace(/\r\n/g, '\n'));
  } catch {
    return null;
  }
}

/** Last-resort fallback: insert plain text as a single paragraph, preserving line breaks */
function createPlainTextContent(text: string): JSONContent[] {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.trim()) {
    return [{ type: 'paragraph' }];
  }

  // Split by double-newlines into paragraphs, preserve single newlines as hard breaks
  const paragraphs = normalized.split(/\n{2,}/);
  const content: JSONContent[] = [];

  for (const paragraph of paragraphs) {
    const lines = paragraph.split('\n');
    if (lines.length === 0) continue;

    const inlineContent = lines.flatMap((line, index) => {
      const nodes: JSONContent[] = [];
      if (index > 0) {
        nodes.push({ type: 'hardBreak' });
      }
      if (line) {
        nodes.push({ type: 'text', text: line });
      }
      return nodes;
    });

    content.push({
      type: 'paragraph',
      content: inlineContent.length > 0 ? inlineContent : undefined,
    });
  }

  return content.length > 0 ? content : [{ type: 'paragraph' }];
}

function escapeMarkdownTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

function looksLikeTabularPlainText(text: string): boolean {
  const rows = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((row) => row.trimEnd())
    .filter((row) => row.length > 0);

  return rows.length >= 2 && rows.every((row) => row.includes('\t'));
}

function tabularTextToMarkdown(text: string): string {
  const rows = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((row) => row.trimEnd())
    .filter((row) => row.length > 0)
    .map((row) => row.split('\t').map((cell) => escapeMarkdownTableCell(cell)));

  if (rows.length < 2) {
    return '';
  }

  const columnCount = Math.max(...rows.map((row) => row.length));
  const paddedRows = rows.map((row) => [
    ...row,
    ...Array.from({ length: Math.max(columnCount - row.length, 0) }, () => ''),
  ]);
  const header = paddedRows[0];
  const bodyRows = paddedRows.slice(1);
  const separator = Array.from({ length: columnCount }, () => '---');

  return [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...bodyRows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function extractHtmlTableElement(html: string): HTMLTableElement | null {
  if (!html.trim()) {
    return null;
  }

  const documentFragment = new window.DOMParser().parseFromString(html, 'text/html');
  return documentFragment.querySelector('table');
}

function insertHtmlTable(view: EditorView, tableElement: HTMLTableElement): boolean {
  const wrapper = window.document.createElement('div');
  wrapper.appendChild(tableElement.cloneNode(true));

  const slice = ProseMirrorDOMParser.fromSchema(view.state.schema).parseSlice(wrapper, {
    preserveWhitespace: true,
  });

  if (!slice.content.size) {
    return false;
  }

  view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
  return true;
}

function isInsideCodeBlock(view: EditorView): boolean {
  const { $from } = view.state.selection;

  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    if ($from.node(depth).type.name === 'codeBlock') {
      return true;
    }
  }

  return false;
}

/**
 * Insert parsed markdown content directly via a ProseMirror transaction.
 * Uses tr.replaceSelectionWith a Slice built from the content fragment.
 * This avoids insertContent's special-casing of block-only content
 * (which can interact badly with ProseMirror's view diff when many
 * nodes are inserted at once, causing React NodeViews to not mount).
 */
function insertContentDirect(editor: any, content: JSONContent[]): boolean {
  const { state, view } = editor;
  const fragment = Fragment.from(content.map((node) => state.schema.nodeFromJSON(node)));
  const slice = new Slice(fragment, 0, 0);
  const tr = state.tr.replaceSelection(slice);
  // Move cursor to end of inserted content
  tr.setSelection(state.selection.constructor.near(tr.doc.resolve(tr.selection.to)));
  view.dispatch(tr.scrollIntoView());
  return true;
}

export function createMarkdownPasteExtension() {
  return Extension.create({
    name: 'markdownPaste',

    addProseMirrorPlugins() {
      return [
        new Plugin({
          props: {
            handlePaste: (view, event) => {
              if (isInsideCodeBlock(view)) {
                return false;
              }

              const text = event.clipboardData?.getData('text/plain') ?? '';
              const html = event.clipboardData?.getData('text/html') ?? '';
              const imageFiles = Array.from(event.clipboardData?.files ?? []).filter((file) =>
                file.type.startsWith('image/'),
              );
              const hasStructuredHtml = looksLikeStructuredHtml(html);
              const hasExclusiveMarkdown = hasExclusiveMarkdownStructure(text);
              const htmlTable = extractHtmlTableElement(html);
              const hasTabularText = looksLikeTabularPlainText(text);

              if (imageFiles.length > 0 && !htmlTable && !hasStructuredHtml && !hasTabularText) {
                return false;
              }

              if (htmlTable && !hasExclusiveMarkdown) {
                event.preventDefault();
                return insertHtmlTable(view, htmlTable);
              }

              if (hasStructuredHtml && !hasExclusiveMarkdown) {
                const content =
                  parseContentFromMarkdown(convertHtmlToMarkdown(html)) ??
                  insertPlainTextFallback(text);
                if (content) {
                  event.preventDefault();
                  try { insertContentDirect(this.editor, content); } catch {
                    try { this.editor.chain().insertContent(content).scrollIntoView().run(); } catch { /* fall through */ }
                  }
                  flushNodeViews(this.editor);
                  return true;
                }
              }

              if (hasTabularText) {
                const content = parseContentFromMarkdown(tabularTextToMarkdown(text));
                if (content) {
                  event.preventDefault();
                  try { insertContentDirect(this.editor, content); } catch {
                    try { this.editor.chain().insertContent(content).scrollIntoView().run(); } catch { /* fall through */ }
                  }
                  flushNodeViews(this.editor);
                  return true;
                }
              }

              if (looksLikeMarkdown(text)) {
                const content = parseContentFromMarkdown(text);
                if (content) {
                  event.preventDefault();
                  try {
                    insertContentDirect(this.editor, content);
                    flushNodeViews(this.editor);
                    return true;
                  } catch {
                    // Fall back to insertContent if direct insertion fails
                    try {
                      this.editor.chain().insertContent(content).scrollIntoView().run();
                      flushNodeViews(this.editor);
                      return true;
                    } catch {
                      // insertContent may throw on schema mismatch (e.g. duplicate marks).
                    }
                  }
                }
              }

              if (hasStructuredHtml) {
                const content =
                  parseContentFromMarkdown(convertHtmlToMarkdown(html)) ??
                  insertPlainTextFallback(text);
                if (content) {
                  event.preventDefault();
                  try { insertContentDirect(this.editor, content); } catch {
                    try { this.editor.chain().insertContent(content).scrollIntoView().run(); } catch { /* fall through */ }
                  }
                  flushNodeViews(this.editor);
                  return true;
                }
              }

              // Final fallback: insert plain text so nothing is ever lost
              if (text) {
                event.preventDefault();
                try {
                  insertContentDirect(this.editor, createPlainTextContent(text));
                } catch {
                  try { this.editor.chain().insertContent(createPlainTextContent(text)).scrollIntoView().run(); } catch { /* nothing more we can do */ }
                }
                flushNodeViews(this.editor);
                return true;
              }

              return false;
            },
          },
        }),
      ];
    },
  });
}

/**
 * Work around a Tiptap React timing issue: when block-level nodes with custom
 * React NodeViews (e.g. code blocks) are inserted via insertContent, the
 * contentDOM element may not get attached to the DOM because the NodeViewContent
 * ref callback runs inside a React render that is deferred by the event-loop
 * batching. Re-dispatching the same transaction after a microtask forces
 * ProseMirror to re-evaluate node views and attach contentDOM.
 */
function flushNodeViews(editor: any): void {
  if (editor.isDestroyed) return;
  const { state, view } = editor;
  // A no-op transaction that still triggers view re-sync.
  queueMicrotask(() => {
    if (editor.isDestroyed) return;
    view.dispatch(state.tr.setMeta('pasteFlush', true));
  });
}

import { Extension } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import { DOMParser as ProseMirrorDOMParser, Fragment, Slice } from '@tiptap/pm/model';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { isInsideTableCell, pasteRequiresPlainText } from '../clipboard';
import { convertHtmlToMarkdown, looksLikeStructuredHtml } from '../html-to-markdown';
import { parseMarkdownFragment } from '../markdown';

function hasMarkdownListStructure(text: string): boolean {
  // `\S.*` so single-character items like `- a` still count.
  const bulletMatches = text.match(/^(?:[-*+])\s+\S.*$/gm) ?? [];
  if (bulletMatches.length >= 2) {
    return true;
  }

  const orderedMatches = text.match(/^\d+\.\s+\S.*$/gm) ?? [];
  return orderedMatches.length >= 2;
}

function hasExclusiveMarkdownStructure(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  return [
    /^#{1,6}\s+\S/m,
    /^>\s+\S/m,
    /^```[\s\S]*```$/m,
    /^~~~[\s\S]*~~~$/m,
    /!\[[^\]]*]\([^)]+\)/,
    /\[[^\]]+]\([^)]+\)/,
    /^\|.+\|$/m,
    /^\[\^[^\]]+]:/m,
    /^[-*+]\s+\[[ xX]\]\s+/m,
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

  // Prefer unambiguous math delimiters. Single `$...$` is handled more
  // carefully by the parser; here we only treat it as Markdown when the
  // expression looks LaTeX-like (avoids `$5` currency false positives).
  if (/\\\([\s\S]+?\\\)/.test(trimmed) || /\\\[[\s\S]+?\\\]/.test(trimmed)) {
    return true;
  }

  if (/\$\$[\s\S]+?\$\$/.test(trimmed)) {
    return true;
  }

  const singleDollar = trimmed.match(/(?<![\\$])\$([^$\n]+)\$(?!\$)/g) ?? [];
  return singleDollar.some((match) => {
    const inner = match.slice(1, -1).trim();
    return /[a-zA-Z\\^_{}]/.test(inner) && !/^[\d\s.,]+$/.test(inner);
  });
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

/** Last-resort fallback: insert plain text as paragraphs, preserving line breaks */
function createPlainTextContent(text: string): JSONContent[] {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.trim()) {
    return [{ type: 'paragraph' }];
  }

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

/**
 * Insert JSON content with open slice edges so mid-paragraph paste merges
 * into the surrounding textblock instead of forcing closed block nodes.
 */
function insertContentDirect(editor: any, content: JSONContent[]): boolean {
  const { state, view } = editor;
  const nodes = content.map((node) => state.schema.nodeFromJSON(node));
  const fragment = Fragment.from(nodes);

  if (!fragment.size) {
    return false;
  }

  const $from = state.selection.$from;
  let slice: Slice;

  // Single paragraph/heading pasted into a textblock → open both ends so the
  // inline content joins the surrounding block (Typora-like mid-line paste).
  if (
    fragment.childCount === 1 &&
    fragment.firstChild?.isTextblock &&
    $from.parent.isTextblock &&
    fragment.firstChild.type.name === $from.parent.type.name
  ) {
    slice = new Slice(fragment, 1, 1);
  } else if (
    fragment.childCount === 1 &&
    fragment.firstChild?.isTextblock &&
    $from.parent.isTextblock
  ) {
    // e.g. pasting a heading into a paragraph: still open so text merges when possible.
    slice = new Slice(fragment, 1, 1);
  } else {
    // Multi-block (or block-level) paste: open edges as far as the structure allows.
    slice = Slice.maxOpen(fragment, true);
  }

  const tr = state.tr.replaceSelection(slice);
  tr.setSelection(TextSelection.near(tr.doc.resolve(tr.selection.to)));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Insert plain characters without re-parsing as Markdown. */
function insertPlainText(view: EditorView, text: string): boolean {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized) {
    return false;
  }

  // Inside a single textblock (math, code, paragraph, cell), keep it simple.
  const { state } = view;
  if (state.selection.$from.parent.isTextblock && !normalized.includes('\n\n')) {
    // Single newlines → hard breaks when the parent allows; otherwise keep \n
    // for code blocks which store them as text.
    if (
      state.selection.$from.parent.type.name === 'codeBlock' ||
      state.selection.$from.parent.type.name === 'inlineMath'
    ) {
      view.dispatch(state.tr.insertText(normalized).scrollIntoView());
      return true;
    }

    if (!normalized.includes('\n')) {
      view.dispatch(state.tr.insertText(normalized).scrollIntoView());
      return true;
    }
  }

  // Multi-paragraph plain text → structured paragraphs with open edges.
  try {
    const editor = { state: view.state, view };
    return insertContentDirect(editor, createPlainTextContent(normalized));
  } catch {
    view.dispatch(state.tr.insertText(normalized).scrollIntoView());
    return true;
  }
}

function isOurMarkdownHtml(html: string): boolean {
  return /data-markdown-editor-pro\s*=\s*["']?1["']?/.test(html);
}

function extractMarkdownFromClipboard(event: ClipboardEvent): string {
  const markdown =
    event.clipboardData?.getData('text/markdown') ||
    event.clipboardData?.getData('text/x-markdown') ||
    '';
  return markdown;
}

export function createMarkdownPasteExtension() {
  return Extension.create({
    name: 'markdownPaste',

    addProseMirrorPlugins() {
      return [
        new Plugin({
          props: {
            handlePaste: (view, event) => {
              // Code blocks / math: always paste as raw text.
              if (pasteRequiresPlainText(view)) {
                const text = event.clipboardData?.getData('text/plain') ?? '';
                if (!text) {
                  return false;
                }
                event.preventDefault();
                return insertPlainText(view, text);
              }

              const text = event.clipboardData?.getData('text/plain') ?? '';
              const html = event.clipboardData?.getData('text/html') ?? '';
              const clipboardMarkdown = extractMarkdownFromClipboard(event);
              const imageFiles = Array.from(event.clipboardData?.files ?? []).filter((file) =>
                file.type.startsWith('image/'),
              );
              const hasStructuredHtml = looksLikeStructuredHtml(html) && !isOurMarkdownHtml(html);
              const hasExclusiveMarkdown = hasExclusiveMarkdownStructure(
                clipboardMarkdown || text,
              );
              const htmlTable = extractHtmlTableElement(html);
              const hasTabularText = looksLikeTabularPlainText(text);
              const insideTable = isInsideTableCell(view);

              if (imageFiles.length > 0 && !htmlTable && !hasStructuredHtml && !hasTabularText) {
                return false;
              }

              // Inside a table cell: never paste a whole nested table / block
              // structure — flatten to plain text so the cell content stays usable.
              if (insideTable) {
                if (text) {
                  event.preventDefault();
                  // Collapse multi-line pastes into spaces for a single cell.
                  const cellText = text.replace(/\r\n/g, '\n').replace(/\n+/g, ' ').trim();
                  return insertPlainText(view, cellText || text);
                }
                return false;
              }

              // Prefer first-party Markdown MIME from our own copy handler.
              if (clipboardMarkdown && looksLikeMarkdown(clipboardMarkdown)) {
                const content = parseContentFromMarkdown(clipboardMarkdown);
                if (content) {
                  event.preventDefault();
                  try {
                    insertContentDirect(this.editor, content);
                    flushNodeViews(this.editor);
                    return true;
                  } catch {
                    try {
                      this.editor.chain().insertContent(content).scrollIntoView().run();
                      flushNodeViews(this.editor);
                      return true;
                    } catch {
                      /* fall through */
                    }
                  }
                }
              }

              if (htmlTable && !hasExclusiveMarkdown) {
                event.preventDefault();
                return insertHtmlTable(view, htmlTable);
              }

              if (hasStructuredHtml && !hasExclusiveMarkdown) {
                const content =
                  parseContentFromMarkdown(convertHtmlToMarkdown(html)) ??
                  (text ? createPlainTextContent(text) : null);
                if (content) {
                  event.preventDefault();
                  try {
                    insertContentDirect(this.editor, content);
                  } catch {
                    try {
                      this.editor.chain().insertContent(content).scrollIntoView().run();
                    } catch {
                      /* fall through */
                    }
                  }
                  flushNodeViews(this.editor);
                  return true;
                }
              }

              if (hasTabularText) {
                const content = parseContentFromMarkdown(tabularTextToMarkdown(text));
                if (content) {
                  event.preventDefault();
                  try {
                    insertContentDirect(this.editor, content);
                  } catch {
                    try {
                      this.editor.chain().insertContent(content).scrollIntoView().run();
                    } catch {
                      /* fall through */
                    }
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
                    try {
                      this.editor.chain().insertContent(content).scrollIntoView().run();
                      flushNodeViews(this.editor);
                      return true;
                    } catch {
                      // Schema mismatch — fall through to plain text.
                    }
                  }
                }

                // Markdown was detected but parsing/insert failed: never drop content.
                if (text) {
                  event.preventDefault();
                  insertPlainText(view, text);
                  flushNodeViews(this.editor);
                  return true;
                }
              }

              if (hasStructuredHtml) {
                const content =
                  parseContentFromMarkdown(convertHtmlToMarkdown(html)) ??
                  (text ? createPlainTextContent(text) : null);
                if (content) {
                  event.preventDefault();
                  try {
                    insertContentDirect(this.editor, content);
                  } catch {
                    try {
                      this.editor.chain().insertContent(content).scrollIntoView().run();
                    } catch {
                      /* nothing */
                    }
                  }
                  flushNodeViews(this.editor);
                  return true;
                }
              }

              // Plain text with no Markdown structure: let ProseMirror handle it
              // for correct mid-paragraph insertion. Only force-insert when we
              // already know structured paste failed above.
              if (text && !html) {
                // Explicit plain-only clipboard — PM default is fine.
                return false;
              }

              // HTML that isn't structured (e.g. a single <span>) — prefer plain text.
              if (text) {
                event.preventDefault();
                insertPlainText(view, text);
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
 * batching. Re-dispatching a no-op transaction after a microtask forces
 * ProseMirror to re-evaluate node views and attach contentDOM.
 */
function flushNodeViews(editor: any): void {
  if (editor.isDestroyed) return;
  queueMicrotask(() => {
    if (editor.isDestroyed) return;
    // Use live editor.state — the state captured at paste time is stale.
    editor.view.dispatch(editor.state.tr.setMeta('pasteFlush', true));
  });
}

// Re-export helpers used in tests / diagnostics.
export { looksLikeMarkdown, hasExclusiveMarkdownStructure };

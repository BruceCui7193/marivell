import type { Editor } from '@tiptap/react';
import type { ContextMenuEntry } from '../components/ContextMenu';
import { sep } from '../components/ContextMenu';
import { applyLineIndent } from '../components/SourceEditor';
import { translate } from '../i18n';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl+';

async function readClipboardText(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}

interface ClipboardReadPayload {
  text: string;
  html: string;
  markdown: string;
  files: File[];
}

async function readClipboardPayload(): Promise<ClipboardReadPayload> {
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      let text = '';
      let html = '';
      let markdown = '';
      const files: File[] = [];

      for (const item of items) {
        for (const type of item.types) {
          const blob = await item.getType(type);
          if (type === 'text/plain') {
            text = await blob.text();
          } else if (type === 'text/html') {
            html = await blob.text();
          } else if (type === 'text/markdown' || type === 'text/x-markdown') {
            markdown = await blob.text();
          } else if (blob.type.startsWith('image/')) {
            const ext = blob.type.split('/')[1]?.split(';')[0] || 'png';
            files.push(new File([blob], `clipboard.${ext}`, { type: blob.type }));
          }
        }
      }

      return { text, html, markdown, files };
    }
  } catch {
    // Fall through to readText, which works in narrower clipboard contexts.
  }

  const text = await readClipboardText();
  return { text, html: '', markdown: '', files: [] };
}

function runVisualPaste(editor: Editor, payload: ClipboardReadPayload): void {
  const event = new ClipboardEvent('paste', { clipboardData: new DataTransfer() });
  const data = event.clipboardData;
  if (data) {
    data.setData('text/plain', payload.text);
    if (payload.html) data.setData('text/html', payload.html);
    if (payload.markdown) {
      data.setData('text/markdown', payload.markdown);
      data.setData('text/x-markdown', payload.markdown);
    }
    for (const file of payload.files) {
      data.items.add(file);
    }
  }
  editor.view.pasteText(payload.text, event);
}

async function writeClipboardText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // ignore
  }
}

function sourceHasSelection(textarea: HTMLTextAreaElement): boolean {
  return textarea.selectionStart !== textarea.selectionEnd;
}

function replaceSourceSelection(textarea: HTMLTextAreaElement, replacement: string): void {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  const next = `${value.slice(0, start)}${replacement}${value.slice(end)}`;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  descriptor?.set?.call(textarea, next);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  const caret = start + replacement.length;
  textarea.setSelectionRange(caret, caret);
  textarea.focus();
}

/**
 * Source-mode context menu: clipboard + source-only actions.
 * Formatting lives on the toolbar / keyboard shortcuts — not duplicated here.
 */
export function buildSourceContextMenu(options: {
  textarea: HTMLTextAreaElement;
  onFind: () => void;
  onFindReplace: () => void;
  onGoToLine?: () => void;
  onToggleVisual: () => void;
}): ContextMenuEntry[] {
  const { textarea, onFind, onFindReplace, onGoToLine, onToggleVisual } = options;
  const hasSelection = sourceHasSelection(textarea);

  const items: ContextMenuEntry[] = [
    {
      id: 'cut',
      label: translate('cut'),
      icon: 'cut',
      shortcut: `${mod}X`,
      disabled: !hasSelection,
      onSelect: () => {
        const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
        void writeClipboardText(selected).then(() => replaceSourceSelection(textarea, ''));
      },
    },
    {
      id: 'copy',
      label: translate('copy'),
      icon: 'copy',
      shortcut: `${mod}C`,
      disabled: !hasSelection,
      onSelect: () => {
        const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
        void writeClipboardText(selected);
      },
    },
    {
      id: 'paste',
      label: translate('paste'),
      icon: 'paste',
      shortcut: `${mod}V`,
      onSelect: () => {
        void readClipboardText().then((text) => {
          if (text) replaceSourceSelection(textarea, text);
        });
      },
    },
    {
      id: 'select-all',
      label: translate('selectAll'),
      icon: 'selectAll',
      shortcut: `${mod}A`,
      onSelect: () => {
        textarea.focus();
        textarea.select();
      },
    },
    sep('s1'),
    {
      id: 'indent',
      label: translate('indent'),
      shortcut: `${mod}]`,
      onSelect: () => applyLineIndent(textarea, true),
    },
    {
      id: 'outdent',
      label: translate('outdent'),
      shortcut: `${mod}[`,
      onSelect: () => applyLineIndent(textarea, false),
    },
    sep('s2'),
    {
      id: 'find',
      label: translate('find'),
      icon: 'search',
      shortcut: `${mod}F`,
      onSelect: onFind,
    },
    {
      id: 'replace',
      label: translate('replace'),
      icon: 'search',
      shortcut: `${mod}H`,
      onSelect: onFindReplace,
    },
  ];

  if (onGoToLine) {
    items.push({
      id: 'goto-line',
      label: `${translate('goToLine')}…`,
      shortcut: `${mod}G`,
      onSelect: onGoToLine,
    });
  }

  items.push(
    sep('s3'),
    {
      id: 'visual',
      label: translate('switchVisual'),
      icon: 'source',
      onSelect: onToggleVisual,
    },
  );

  return items;
}

/**
 * Visual-mode context menu: clipboard + navigation only.
 * Bold/heading/list/insert blocks are toolbar concerns — keep this short.
 */
export function buildVisualContextMenu(options: {
  editor: Editor;
  onFind: () => void;
  onFindReplace: () => void;
  onGoToLine?: () => void;
  onInsertImage: () => void;
  onToggleSource: () => void;
}): ContextMenuEntry[] {
  const { editor, onFind, onFindReplace, onGoToLine, onToggleSource } = options;
  const { empty } = editor.state.selection;
  // onInsertImage kept in signature for call-site stability; not shown in menu.
  void options.onInsertImage;

  const items: ContextMenuEntry[] = [
    {
      id: 'cut',
      label: translate('cut'),
      icon: 'cut',
      shortcut: `${mod}X`,
      disabled: empty,
      onSelect: () => {
        document.execCommand('cut');
      },
    },
    {
      id: 'copy',
      label: translate('copy'),
      icon: 'copy',
      shortcut: `${mod}C`,
      disabled: empty,
      onSelect: () => {
        document.execCommand('copy');
      },
    },
    {
      id: 'paste',
      label: translate('paste'),
      icon: 'paste',
      shortcut: `${mod}V`,
      onSelect: () => {
        void readClipboardPayload().then((payload) => {
          if (!payload.text && !payload.html && payload.files.length === 0) return;
          editor.chain().focus().run();
          runVisualPaste(editor, payload);
        });
      },
    },
    {
      id: 'select-all',
      label: translate('selectAll'),
      icon: 'selectAll',
      shortcut: `${mod}A`,
      onSelect: () => {
        editor.chain().focus().selectAll().run();
      },
    },
    sep('s1'),
    {
      id: 'find',
      label: translate('find'),
      icon: 'search',
      shortcut: `${mod}F`,
      onSelect: onFind,
    },
    {
      id: 'replace',
      label: translate('replace'),
      icon: 'search',
      shortcut: `${mod}H`,
      onSelect: onFindReplace,
    },
  ];

  if (onGoToLine) {
    items.push({
      id: 'goto-line',
      label: `${translate('goToLine')}…`,
      shortcut: `${mod}G`,
      onSelect: onGoToLine,
    });
  }

  items.push(
    sep('s2'),
    {
      id: 'source',
      label: translate('switchSource'),
      icon: 'source',
      onSelect: onToggleSource,
    },
  );

  return items;
}

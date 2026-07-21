import type { Editor } from '@tiptap/react';
import type { ContextMenuEntry } from '../components/ContextMenu';
import { sep } from '../components/ContextMenu';
import { applyLineIndent } from '../components/SourceEditor';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl+';

async function readClipboardText(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
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
      label: '剪切',
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
      label: '复制',
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
      label: '粘贴',
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
      label: '全选',
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
      label: '增加缩进',
      shortcut: `${mod}]`,
      onSelect: () => applyLineIndent(textarea, true),
    },
    {
      id: 'outdent',
      label: '减少缩进',
      shortcut: `${mod}[`,
      onSelect: () => applyLineIndent(textarea, false),
    },
    sep('s2'),
    {
      id: 'find',
      label: '查找',
      icon: 'search',
      shortcut: `${mod}F`,
      onSelect: onFind,
    },
    {
      id: 'replace',
      label: '替换',
      icon: 'search',
      shortcut: `${mod}H`,
      onSelect: onFindReplace,
    },
  ];

  if (onGoToLine) {
    items.push({
      id: 'goto-line',
      label: '转到行…',
      shortcut: `${mod}G`,
      onSelect: onGoToLine,
    });
  }

  items.push(
    sep('s3'),
    {
      id: 'visual',
      label: '切换到可视化',
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
      label: '剪切',
      icon: 'cut',
      shortcut: `${mod}X`,
      disabled: empty,
      onSelect: () => {
        document.execCommand('cut');
      },
    },
    {
      id: 'copy',
      label: '复制',
      icon: 'copy',
      shortcut: `${mod}C`,
      disabled: empty,
      onSelect: () => {
        document.execCommand('copy');
      },
    },
    {
      id: 'paste',
      label: '粘贴',
      icon: 'paste',
      shortcut: `${mod}V`,
      onSelect: () => {
        void readClipboardText().then((text) => {
          if (!text) return;
          editor.chain().focus().insertContent(text.replace(/\r\n/g, '\n')).run();
        });
      },
    },
    {
      id: 'select-all',
      label: '全选',
      icon: 'selectAll',
      shortcut: `${mod}A`,
      onSelect: () => {
        editor.chain().focus().selectAll().run();
      },
    },
    sep('s1'),
    {
      id: 'find',
      label: '查找',
      icon: 'search',
      shortcut: `${mod}F`,
      onSelect: onFind,
    },
    {
      id: 'replace',
      label: '替换',
      icon: 'search',
      shortcut: `${mod}H`,
      onSelect: onFindReplace,
    },
  ];

  if (onGoToLine) {
    items.push({
      id: 'goto-line',
      label: '转到行…',
      shortcut: `${mod}G`,
      onSelect: onGoToLine,
    });
  }

  items.push(
    sep('s2'),
    {
      id: 'source',
      label: '切换到源码',
      icon: 'source',
      onSelect: onToggleSource,
    },
  );

  return items;
}

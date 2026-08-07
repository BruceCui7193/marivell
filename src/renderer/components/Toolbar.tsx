import { memo, useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import type { JSONContent } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import type { PandocExportFormat, ThemeMode } from '@shared/contracts';
import { GLASS_EFFECT_OPTIONS, THEME_PALETTE_OPTIONS, type GlassEffect, type ThemePalette } from '../theme';
import { CODE_LANGUAGE_OPTIONS } from '../editor/code-languages';
import Icon from './icons';

interface ToolbarProps {
  editor: Editor | null;
  theme: ThemeMode;
  themePalette: ThemePalette;
  glassEffect: GlassEffect;
  searchVisible: boolean;
  sourceMode: boolean;
  toolbarVisible: boolean;
  sidebarVisible: boolean;
  onOpen: () => void;
  onOpenFolder: () => void;
  onOpenSearch: (showReplace?: boolean) => void;
  onCloseSearch: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onNewWindow: () => void;
  onInsertImage: () => void;
  onSetTheme: (theme: ThemeMode) => void;
  onSetThemePalette: (palette: ThemePalette) => void;
  onSetGlassEffect: (effect: GlassEffect) => void;
  onToggleToolbar: () => void;
  onToggleSidebar: () => void;
  onToggleSourceMode: () => void;
  onExportPdf: () => void;
  onExportImage: () => void;
  onExportPandoc: (format: PandocExportFormat) => void;
}

interface ToolbarButtonProps {
  icon: ComponentProps<typeof Icon>['name'];
  active?: boolean;
  hidden?: boolean;
  onClick: () => void;
  disabled?: boolean;
  panelTrigger?: boolean;
  shortcut?: string;
  title: string;
}

type ToolbarLayoutMode = 'full' | 'dense' | 'compact';
type ToolbarGroupId = 'document' | 'text-style' | 'structure' | 'insert' | 'view';

const PANDOC_EXPORT_OPTIONS: Array<{ id: PandocExportFormat; label: string }> = [
  { id: 'docx', label: 'Word 文档 (DOCX)' },
  { id: 'html', label: 'HTML 网页' },
  { id: 'odt', label: 'OpenDocument (ODT)' },
  { id: 'epub', label: 'EPUB 电子书' },
  { id: 'latex', label: 'LaTeX 源文件' },
  { id: 'rtf', label: 'RTF 富文本' },
  { id: 'pptx', label: 'PowerPoint (PPTX)' },
  { id: 'plain', label: '纯文本' },
  { id: 'gfm', label: 'GitHub Flavored Markdown' },
];

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl+';
const shift = isMac ? '⇧' : 'Shift+';
const alt = isMac ? '⌥' : 'Alt+';

const shortcutLabels = {
  newWindow: `${mod}N`,
  openFile: `${mod}O`,
  openFolder: `${mod}${shift}O`,
  save: `${mod}S`,
  saveAs: `${mod}${shift}S`,
  find: `${mod}F`,
  exportPdf: `${mod}${shift}P`,
  exportImage: `${mod}${shift}I`,
  undo: `${mod}Z`,
  redo: isMac ? `⇧${mod}Z` : `${mod}${shift}Z`,
  cut: `${mod}X`,
  copy: `${mod}C`,
  paste: `${mod}V`,
  selectAll: `${mod}A`,
  heading1: `${mod}${alt}1`,
  heading2: `${mod}${alt}2`,
  bold: `${mod}B`,
  italic: `${mod}I`,
  underline: `${mod}U`,
  strike: `${mod}${shift}S`,
  quote: `${mod}${shift}B`,
  bullet: `${mod}${shift}8`,
  ordered: `${mod}${shift}7`,
  task: `${mod}${shift}9`,
  code: `${mod}${alt}C`,
  hideToolbar: `${mod}${shift}B`,
  hideSidebar: `${mod}\\`,
  sourceMode: `${mod}${shift}E`,
  toggleTheme: `${mod}${shift}L`,
  zoomIn: `${mod}+`,
  zoomOut: `${mod}-`,
  zoomReset: `${mod}0`,
  reload: `${mod}R`,
};

function ToolbarButton({
  icon,
  active = false,
  hidden = false,
  onClick,
  disabled = false,
  panelTrigger = false,
  shortcut,
  title,
}: ToolbarButtonProps) {
  const displayTitle = shortcut ? `${title} (${shortcut})` : title;
  return (
    <button
      aria-hidden={hidden}
      aria-label={displayTitle}
      className={clsx('toolbar-button', active && 'is-active', hidden && 'is-source-hidden')}
      data-panel-trigger={panelTrigger ? '' : undefined}
      data-tooltip={displayTitle}
      disabled={disabled}
      onClick={onClick}
      onMouseDown={(event) => event.preventDefault()}
      tabIndex={hidden ? -1 : 0}
      title={displayTitle}
      type="button"
    >
      <Icon className="toolbar-button__icon" name={icon} />
    </button>
  );
}

function getNextFootnoteLabel(editor: Editor): string {
  let highestNumericLabel = 0;
  let fallbackCount = 0;

  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'footnoteReference' && node.type.name !== 'footnoteDefinition') {
      return true;
    }

    fallbackCount += 1;
    const rawLabel = String(node.attrs.label ?? '').trim();
    if (/^\d+$/.test(rawLabel)) {
      highestNumericLabel = Math.max(highestNumericLabel, Number(rawLabel));
    }

    return true;
  });

  return String(highestNumericLabel > 0 ? highestNumericLabel + 1 : fallbackCount + 1);
}

function getSelectedPlainText(editor: Editor): string {
  const { from, to } = editor.state.selection;
  return editor.state.doc.textBetween(from, to, '\n', '\n');
}

function isInlineJsonNode(node: JSONContent): boolean {
  return ['text', 'hardBreak', 'mathInline', 'footnoteReference'].includes(String(node.type ?? ''));
}

function normalizeFootnoteContent(content: JSONContent[]): JSONContent[] {
  if (!content.length) {
    return [{ type: 'paragraph' }];
  }

  const normalized: JSONContent[] = [];
  let pendingInlineContent: JSONContent[] = [];

  const flushInlineContent = () => {
    if (!pendingInlineContent.length) {
      return;
    }

    normalized.push({
      type: 'paragraph',
      content: pendingInlineContent,
    });
    pendingInlineContent = [];
  };

  content.forEach((node) => {
    if (isInlineJsonNode(node)) {
      pendingInlineContent.push(node);
      return;
    }

    flushInlineContent();
    normalized.push(node);
  });

  flushInlineContent();

  if (!normalized.length) {
    return [{ type: 'paragraph' }];
  }

  return normalized;
}

function Toolbar({
  editor,
  theme,
  themePalette,
  glassEffect,
  searchVisible,
  sourceMode,
  toolbarVisible,
  sidebarVisible,
  onOpen,
  onOpenFolder,
  onOpenSearch,
  onCloseSearch,
  onSave,
  onSaveAs,
  onNewWindow,
  onInsertImage,
  onSetTheme,
  onSetThemePalette,
  onSetGlassEffect,
  onToggleToolbar,
  onToggleSidebar,
  onToggleSourceMode,
  onExportPdf,
  onExportImage,
  onExportPandoc,
}: ToolbarProps) {
  const [themePanelOpen, setThemePanelOpen] = useState(false);
  const [layoutMode, setLayoutMode] = useState<ToolbarLayoutMode>('full');
  const [denseStep, setDenseStep] = useState(0);
  const [compactGroupOpen, setCompactGroupOpen] = useState<ToolbarGroupId | null>(null);
  const [menuOpen, setMenuOpen] = useState<'document' | 'edit' | 'view' | null>(null);
  const [menuRect, setMenuRect] = useState<{ left: number; top: number } | null>(null);
  const [formulaMenuOpen, setFormulaMenuOpen] = useState(false);
  const [linkMenuOpen, setLinkMenuOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState('https://');
  const [codeLanguageDraft, setCodeLanguageDraft] = useState('');
  const [, setEditorRevision] = useState(0);
  const toolbarRef = useRef<HTMLElement | null>(null);
  const linkInputRef = useRef<HTMLInputElement | null>(null);
  const labels = {
    hideToolbar: '隐藏工具栏',
    hideSidebar: '隐藏侧栏',
    showSidebar: '显示侧栏',
    newWindow: '新建窗口',
    openFile: '打开文件',
    openFolder: '打开文件夹',
    save: '保存',
    saveAs: '另存为',
    findReplace: '查找与替换',
    heading1: '一级标题',
    heading2: '二级标题',
    bold: '加粗',
    italic: '斜体',
    underline: '下划线',
    strike: '删除线',
    link: '链接',
    linkApply: '应用链接',
    linkRemove: '移除链接',
    linkPlaceholder: '输入链接地址',
    quote: '引用',
    bullet: '无序列表',
    ordered: '有序列表',
    task: '任务列表',
    table: '插入表格',
    code: '代码块',
    math: '插入公式',
    mathInline: '行内公式 ($)',
    mathBlock: '行间公式 ($$)',
    mermaid: '插入 Mermaid 图表',
    image: '插入图片',
    footnote: '插入脚注',
    sourceOn: '关闭源码模式',
    sourceOff: '打开源码模式',
    themePanel: '主题与配色',
    showToolbar: '显示工具栏',
    appearanceMode: '外观模式',
    paletteScheme: '配色方案',
    glassEffect: '透明效果',
    glassFrosted: '毛玻璃',
    glassLiquid: '液态玻璃',
    glassOff: '关闭透明',
    auto: '自动',
    light: '浅色',
    dark: '深色',
    document: '文档',
    textStyle: '文本',
    structure: '结构',
    insert: '插入',
    view: '视图',
    fileMenu: '文件',
    editMenu: '编辑',
    viewMenu: '视图',
    exportPdf: '导出 PDF…',
    exportImage: '导出长图…',
    pandocExport: '通过 Pandoc 导出',
    quit: '退出',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
    reload: '重新加载',
    toggleTheme: '切换主题',
    zoomIn: '放大',
    zoomOut: '缩小',
    zoomReset: '重置缩放',
  };
  const themeLabel =
    theme === 'system' ? '主题：自动' : theme === 'light' ? '主题：浅色' : '主题：深色';
  const currentPalette = THEME_PALETTE_OPTIONS.find((option) => option.id === themePalette);
  const editingControlsHidden = sourceMode;
  const isLinkActive = editor?.isActive('link') ?? false;
  const isTableActive = editor?.isActive('table') ?? false;
  const isCodeBlockActive = editor?.isActive('codeBlock') ?? false;
  const currentCodeLanguage = String(editor?.getAttributes('codeBlock').language ?? '').trim();
  const hasLinkFloatingPanel = linkMenuOpen && !editingControlsHidden;
  const hasFormulaFloatingPanel = formulaMenuOpen && !editingControlsHidden;

  const closeAllPanels = useCallback(() => {
    setThemePanelOpen(false);
    setCompactGroupOpen(null);
    setMenuOpen(null);
    setMenuRect(null);
    setFormulaMenuOpen(false);
    closeAllPanels();
  }, []);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const rerender = () => setEditorRevision((current) => current + 1);

    editor.on('transaction', rerender);
    editor.on('selectionUpdate', rerender);
    editor.on('focus', rerender);
    editor.on('blur', rerender);

    return () => {
      editor.off('transaction', rerender);
      editor.off('selectionUpdate', rerender);
      editor.off('focus', rerender);
      editor.off('blur', rerender);
    };
  }, [editor]);

  useEffect(() => {
    if (!themePanelOpen && !compactGroupOpen && !menuOpen && !formulaMenuOpen && !linkMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const insideOpenMenu = Boolean(
        target.closest('.toolbar-menu, .toolbar-submenu.is-open, .toolbar-compact-panel, .theme-panel.is-open'),
      );
      const isPanelTrigger = Boolean(
        target.closest('.toolbar-menu-trigger, .toolbar-group-launcher, [data-panel-trigger]'),
      );
      if (!insideOpenMenu && !isPanelTrigger) {
        closeAllPanels();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeAllPanels();
      }
    };

    const handleResize = () => {
      setMenuOpen(null);
      setMenuRect(null);
    };

    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
    };
  }, [closeAllPanels, compactGroupOpen, formulaMenuOpen, linkMenuOpen, menuOpen, themePanelOpen]);

  useEffect(() => {
    if (!toolbarVisible) {
      return;
    }

    const toolbar = toolbarRef.current;
    if (!toolbar) {
      return;
    }

    const updateLayoutMode = () => {
      const width = toolbar.clientWidth;
      if (width <= 700) {
        setLayoutMode((current) => (current === 'compact' ? current : 'compact'));
        setDenseStep(0);
        return;
      }

      if (width <= 1320) {
        setLayoutMode((current) => (current === 'dense' ? current : 'dense'));
        const nextDenseStep =
          width <= 780 ? 5 : width <= 900 ? 4 : width <= 1020 ? 3 : width <= 1140 ? 2 : 1;
        setDenseStep((current) => (current === nextDenseStep ? current : nextDenseStep));
        return;
      }

      setLayoutMode((current) => (current === 'full' ? current : 'full'));
      setDenseStep(0);
    };

    requestAnimationFrame(updateLayoutMode);
    const observer = new ResizeObserver(updateLayoutMode);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [toolbarVisible]);

  useEffect(() => {
    if (layoutMode !== 'compact') {
      setCompactGroupOpen(null);
    }
    setMenuOpen(null);
    setMenuRect(null);
  }, [layoutMode]);

  useEffect(() => {
    if (!sourceMode) {
      return;
    }

    if (
      compactGroupOpen === 'text-style' ||
      compactGroupOpen === 'structure' ||
      compactGroupOpen === 'insert'
    ) {
      setCompactGroupOpen(null);
    }

    setFormulaMenuOpen(false);
    setLinkMenuOpen(false);
    setMenuOpen(null);
    setMenuRect(null);
  }, [compactGroupOpen, sourceMode]);

  useEffect(() => {
    if (toolbarVisible) {
      return;
    }

    setThemePanelOpen(false);
    setCompactGroupOpen(null);
    setMenuOpen(null);
    setMenuRect(null);
    setFormulaMenuOpen(false);
    setLinkMenuOpen(false);
  }, [toolbarVisible]);

  useEffect(() => {
    if (!linkMenuOpen) {
      return;
    }

    requestAnimationFrame(() => {
      linkInputRef.current?.focus();
      linkInputRef.current?.select();
    });
  }, [linkMenuOpen]);

  useEffect(() => {
    if (!isCodeBlockActive) {
      setCodeLanguageDraft('');
      return;
    }

    setCodeLanguageDraft(currentCodeLanguage);
  }, [currentCodeLanguage, isCodeBlockActive]);

  const isDenseSplitGroup = (group: ToolbarGroupId): boolean => {
    if (layoutMode !== 'dense') {
      return false;
    }

    const thresholds: Record<ToolbarGroupId, number> = {
      'text-style': 1,
      structure: 2,
      document: 3,
      insert: 4,
      view: 5,
    };

    return denseStep >= thresholds[group];
  };

  const runCompactAction = (action: () => void) => {
    action();
    setCompactGroupOpen(null);
    setMenuOpen(null);
    setMenuRect(null);
  };

  const runSearchAction = () => {
    if (searchVisible) {
      onCloseSearch();
      return;
    }

    onOpenSearch(true);
  };

  const insertInlineMath = () => {
    if (!editor) {
      return;
    }

    editor.chain().focus().insertInlineMath().run();
  };

  const insertBlockMath = () => {
    if (!editor) {
      return;
    }

    if (editor.state.selection.empty) {
      editor.chain().focus().insertMathBlock().run();
      return;
    }

    const value = getSelectedPlainText(editor);
    editor.chain().focus().insertMathBlock(value).run();
  };

  const openLinkMenu = () => {
    if (!editor || editingControlsHidden) {
      return;
    }

    const currentHref = String(editor.getAttributes('link').href ?? '').trim();
    setLinkDraft(currentHref || 'https://');
    const shouldOpen = !linkMenuOpen;
    closeAllPanels();
    if (shouldOpen) {
      setLinkMenuOpen(true);
    }
  };

  const applyLink = () => {
    if (!editor) {
      return;
    }

    const href = linkDraft.trim();
    if (!href) {
      return;
    }

    if (editor.state.selection.empty) {
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'text',
          text: '链接',
          marks: [
            {
              type: 'link',
              attrs: { href },
            },
          ],
        })
        .run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    }

    closeAllPanels();
  };

  const removeLink = () => {
    if (!editor) {
      return;
    }

    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    closeAllPanels();
  };

  const insertFootnote = () => {
    if (!editor) {
      return;
    }

    const label = getNextFootnoteLabel(editor);
    const selectionEmpty = editor.state.selection.empty;
    const selectedContent = selectionEmpty
      ? [{ type: 'paragraph' }]
      : normalizeFootnoteContent(editor.state.selection.content().content.toJSON() as JSONContent[]);

    editor
      .chain()
      .focus()
      .command(({ dispatch, state, tr }) => {
        const referenceNode = state.schema.nodes.footnoteReference?.create({ label });
        const definitionNode = state.schema.nodes.footnoteDefinition?.create(
          { label },
          selectedContent.length ? selectedContent.map((node) => state.schema.nodeFromJSON(node as any)) : undefined,
        );

        if (!referenceNode || !definitionNode) {
          return false;
        }

        tr = tr.replaceSelectionWith(referenceNode, false);

        if (selectionEmpty) {
          tr = tr.insert(tr.doc.content.size, definitionNode);
        } else {
          const paragraphNode = state.schema.nodes.paragraph?.create();

          if (!paragraphNode) {
            return false;
          }

          const insertAfter = state.selection.$to.after(1);
          tr = tr.insert(tr.mapping.map(insertAfter), [paragraphNode, definitionNode]);
        }

        if (dispatch) {
          dispatch(tr.scrollIntoView());
        }

        return true;
      })
      .run();
  };

  const insertCodeBlock = () => {
    if (!editor) {
      return;
    }

    if (editor.state.selection.empty) {
      editor.chain().focus().toggleCodeBlock().run();
      return;
    }

    const selectedText = getSelectedPlainText(editor);
    editor
      .chain()
      .focus()
      .command(({ dispatch, state, tr }) => {
        const codeBlockNode = state.schema.nodes.codeBlock?.create(
          { language: null },
          selectedText ? [state.schema.text(selectedText)] : undefined,
        );

        if (!codeBlockNode) {
          return false;
        }

        tr = tr.replaceSelectionWith(codeBlockNode, false);

        if (dispatch) {
          dispatch(tr.scrollIntoView());
        }

        return true;
      })
      .run();
  };

  const updateCodeBlockLanguage = (language: string) => {
    if (!editor) {
      return;
    }

    const nextLanguage = language.trim();
    editor
      .chain()
      .focus()
      .updateAttributes('codeBlock', {
        language: nextLanguage || null,
      })
      .run();
  };

  const renderTableActions = () => {
    if (!isTableActive) {
      return null;
    }

    return (
      <>
        <ToolbarButton
          disabled={!editor}
          hidden={editingControlsHidden}
          icon="rowAddBefore"
          onClick={() => runCompactAction(() => editor?.chain().focus().addRowBefore().run())}
          title="在上方插入行"
        />
        <ToolbarButton
          disabled={!editor}
          hidden={editingControlsHidden}
          icon="rowAddAfter"
          onClick={() => runCompactAction(() => editor?.chain().focus().addRowAfter().run())}
          title="在下方插入行"
        />
        <ToolbarButton
          disabled={!editor}
          hidden={editingControlsHidden}
          icon="rowDelete"
          onClick={() => runCompactAction(() => editor?.chain().focus().deleteRow().run())}
          title="删除当前行"
        />
        <ToolbarButton
          disabled={!editor}
          hidden={editingControlsHidden}
          icon="columnAddBefore"
          onClick={() => runCompactAction(() => editor?.chain().focus().addColumnBefore().run())}
          title="在左侧插入列"
        />
        <ToolbarButton
          disabled={!editor}
          hidden={editingControlsHidden}
          icon="columnAddAfter"
          onClick={() => runCompactAction(() => editor?.chain().focus().addColumnAfter().run())}
          title="在右侧插入列"
        />
        <ToolbarButton
          disabled={!editor}
          hidden={editingControlsHidden}
          icon="columnDelete"
          onClick={() => runCompactAction(() => editor?.chain().focus().deleteColumn().run())}
          title="删除当前列"
        />
        <ToolbarButton
          disabled={!editor}
          hidden={editingControlsHidden}
          icon="tableDelete"
          onClick={() => runCompactAction(() => editor?.chain().focus().deleteTable().run())}
          title="删除表格"
        />
      </>
    );
  };

  const runMenuAction = (action: () => void) => {
    action();
    setCompactGroupOpen(null);
    setMenuOpen(null);
    setMenuRect(null);
  };

  const toggleCompactGroup = (group: ToolbarGroupId) => {
    const shouldOpen = compactGroupOpen !== group;
    closeAllPanels();
    if (shouldOpen) {
      setCompactGroupOpen(group);
    }
  };

  const runEditCommand = (command: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') => {
    const sourceInput = document.querySelector<HTMLTextAreaElement>('.source-editor__input');
    if (sourceInput) {
      sourceInput.focus();
      if (command === 'undo' || command === 'redo' || command === 'selectAll') {
        document.execCommand(command);
      } else {
        document.execCommand(command);
      }
      return;
    }

    if (!editor) {
      return;
    }

    if (command === 'undo') {
      editor.chain().focus().undo().run();
      return;
    }
    if (command === 'redo') {
      editor.chain().focus().redo().run();
      return;
    }
    if (command === 'selectAll') {
      editor.chain().focus().selectAll().run();
      return;
    }
    document.execCommand(command);
  };

  const renderToolbarMenu = (menu: 'document' | 'edit' | 'view') => {
    if (menuOpen !== menu) {
      return null;
    }

    const item = (
      key: string,
      label: string,
      onSelect: () => void,
      shortcut?: string,
      disabled = false,
    ) => (
      <button
        key={key}
        className={clsx('toolbar-menu__item', disabled && 'is-disabled')}
        disabled={disabled}
        onClick={() => runMenuAction(onSelect)}
        onMouseDown={(event) => event.preventDefault()}
        role="menuitem"
        type="button"
      >
        <span className="toolbar-menu__label">{label}</span>
        {shortcut ? <span className="toolbar-menu__shortcut">{shortcut}</span> : null}
      </button>
    );

    if (!menuRect) {
      return null;
    }

    const menuOrigin = `${menuRect.top + 300 > window.innerHeight - 8 ? 'bottom' : 'top'} ${menuRect.left > window.innerWidth - 320 ? 'right' : 'left'}`;
    return createPortal(
      <div className="toolbar-menu" role="menu" style={{ left: menuRect.left, top: menuRect.top, transformOrigin: menuOrigin }}>
        {menu === 'document' ? (
          <>
            {item('export-pdf', labels.exportPdf, onExportPdf, shortcutLabels.exportPdf)}
            {item('export-image', labels.exportImage, onExportImage, shortcutLabels.exportImage)}
            <div className="toolbar-menu__separator" role="separator" />
            <div className="toolbar-menu__section-label">{labels.pandocExport}</div>
            {PANDOC_EXPORT_OPTIONS.map((option) =>
              item(`pandoc-${option.id}`, option.label, () => onExportPandoc(option.id)),
            )}
            <div className="toolbar-menu__separator" role="separator" />
            {item('quit', labels.quit, () => window.close())}
          </>
        ) : null}

        {menu === 'edit' ? (
          <>
            {item('undo', labels.undo, () => runEditCommand('undo'), shortcutLabels.undo)}
            {item('redo', labels.redo, () => runEditCommand('redo'), shortcutLabels.redo)}
            <div className="toolbar-menu__separator" role="separator" />
            {item('cut', labels.cut, () => runEditCommand('cut'), shortcutLabels.cut)}
            {item('copy', labels.copy, () => runEditCommand('copy'), shortcutLabels.copy)}
            {item('paste', labels.paste, () => runEditCommand('paste'), shortcutLabels.paste)}
            {item('select-all', labels.selectAll, () => runEditCommand('selectAll'), shortcutLabels.selectAll)}
          </>
        ) : null}

        {menu === 'view' ? (
          <>
            {item('zoom-in', labels.zoomIn, () => void window.markdownEditor.zoomIn(), shortcutLabels.zoomIn)}
            {item('zoom-out', labels.zoomOut, () => void window.markdownEditor.zoomOut(), shortcutLabels.zoomOut)}
            {item('zoom-reset', labels.zoomReset, () => void window.markdownEditor.zoomReset(), shortcutLabels.zoomReset)}
            <div className="toolbar-menu__separator" role="separator" />
            {item('reload', labels.reload, () => window.location.reload(), shortcutLabels.reload)}
          </>
        ) : null}
      </div>,
      document.body,
    );
  };

  const renderMenuTrigger = (menu: 'document' | 'edit' | 'view', label: string) => (
    <div className="toolbar-menu-anchor">
      <button
        aria-expanded={menuOpen === menu}
        aria-label={label}
        className={clsx('toolbar-menu-trigger', menuOpen === menu && 'is-active')}
        onClick={(event) => {
          const shouldOpen = menuOpen !== menu;
          const rect = event.currentTarget.getBoundingClientRect();
          const menuWidth = Math.min(280, window.innerWidth - 16);
          const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth - 8));
          const menuHeight = Math.min(420, window.innerHeight - 24);
          const belowTop = rect.bottom + 8;
          const top = belowTop + menuHeight > window.innerHeight - 8
            ? Math.max(8, rect.top - menuHeight - 8)
            : belowTop;
          closeAllPanels();
          if (shouldOpen) {
            setMenuRect({ left, top });
            setMenuOpen(menu);
          }
        }}
        onMouseDown={(event) => event.preventDefault()}
        title={label}
        type="button"
      >
        <span aria-hidden="true" className="toolbar-menu-trigger__caret" />
      </button>
      {renderToolbarMenu(menu)}
    </div>
  );

  const renderGroupActions = (group: ToolbarGroupId) => {
    if (group === 'document') {
      return (
        <>
          <ToolbarButton
            icon="newWindow"
            onClick={() => runCompactAction(onNewWindow)}
            shortcut={shortcutLabels.newWindow}
            title={labels.newWindow}
          />
          <ToolbarButton
            icon="open"
            onClick={() => runCompactAction(onOpen)}
            shortcut={shortcutLabels.openFile}
            title={labels.openFile}
          />
          <ToolbarButton
            icon="folder"
            onClick={() => runCompactAction(onOpenFolder)}
            shortcut={shortcutLabels.openFolder}
            title={labels.openFolder}
          />
          <ToolbarButton
            icon="save"
            onClick={() => runCompactAction(onSave)}
            shortcut={shortcutLabels.save}
            title={labels.save}
          />
          <ToolbarButton
            icon="saveAs"
            onClick={() => runCompactAction(onSaveAs)}
            shortcut={shortcutLabels.saveAs}
            title={labels.saveAs}
          />
          <ToolbarButton
            active={searchVisible}
            icon="search"
            onClick={() => runCompactAction(runSearchAction)}
            shortcut={shortcutLabels.find}
            title={labels.findReplace}
          />
          {renderMenuTrigger('document', labels.fileMenu)}
        </>
      );
    }

    if (group === 'text-style') {
      return (
        <>
          <ToolbarButton
            active={editor?.isActive('heading', { level: 1 }) ?? false}
            disabled={!editor}
            hidden={editingControlsHidden}
            icon="heading1"
            onClick={() => runCompactAction(() => editor?.chain().focus().toggleHeading({ level: 1 }).run())}
            shortcut={shortcutLabels.heading1}
            title={labels.heading1}
          />
          <ToolbarButton
            active={editor?.isActive('heading', { level: 2 }) ?? false}
            disabled={!editor}
            hidden={editingControlsHidden}
            icon="heading2"
            onClick={() => runCompactAction(() => editor?.chain().focus().toggleHeading({ level: 2 }).run())}
            shortcut={shortcutLabels.heading2}
            title={labels.heading2}
          />
          <ToolbarButton
            active={editor?.isActive('bold') ?? false}
            disabled={!editor}
            hidden={editingControlsHidden}
            icon="bold"
            onClick={() => runCompactAction(() => editor?.chain().focus().toggleBold().run())}
            shortcut={shortcutLabels.bold}
            title={labels.bold}
          />
          <ToolbarButton
            active={editor?.isActive('italic') ?? false}
            disabled={!editor}
            hidden={editingControlsHidden}
            icon="italic"
            onClick={() => runCompactAction(() => editor?.chain().focus().toggleItalic().run())}
            shortcut={shortcutLabels.italic}
            title={labels.italic}
          />
          <ToolbarButton
            active={editor?.isActive('underline') ?? false}
            disabled={!editor}
            hidden={editingControlsHidden}
            icon="underline"
            onClick={() => runCompactAction(() => editor?.chain().focus().toggleUnderline().run())}
            shortcut={shortcutLabels.underline}
            title={labels.underline}
          />
          <ToolbarButton
            active={editor?.isActive('strike') ?? false}
            disabled={!editor}
            hidden={editingControlsHidden}
            icon="strike"
            onClick={() => runCompactAction(() => editor?.chain().focus().toggleStrike().run())}
            shortcut={shortcutLabels.strike}
            title={labels.strike}
          />
          <div
            className={clsx(
              'toolbar-submenu-anchor',
              editingControlsHidden && 'is-source-hidden',
              hasLinkFloatingPanel && 'has-open-panel',
            )}
          >
            <button
              aria-hidden={editingControlsHidden}
              aria-label={labels.link}
              aria-expanded={linkMenuOpen}
              className={clsx('toolbar-button', isLinkActive && 'is-active', linkMenuOpen && 'is-active', editingControlsHidden && 'is-source-hidden')}
              data-panel-trigger
              data-tooltip={labels.link}
              disabled={!editor}
              onClick={openLinkMenu}
              onMouseDown={(event) => event.preventDefault()}
              tabIndex={editingControlsHidden ? -1 : 0}
              type="button"
            >
              <Icon className="toolbar-button__icon" name="link" />
            </button>
            <div
              aria-hidden={!linkMenuOpen}
              className={linkMenuOpen ? 'toolbar-submenu is-open' : 'toolbar-submenu is-closed'}
            >
              <input
                ref={linkInputRef}
                className="toolbar-submenu__input"
                onChange={(event) => setLinkDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    applyLink();
                  }
                }}
                placeholder={labels.linkPlaceholder}
                spellCheck={false}
                type="text"
                value={linkDraft}
              />
              <button
                className="toolbar-submenu__item"
                onClick={applyLink}
                onMouseDown={(event) => event.preventDefault()}
                type="button"
              >
                {labels.linkApply}
              </button>
              <button
                className="toolbar-submenu__item"
                onClick={removeLink}
                onMouseDown={(event) => event.preventDefault()}
                type="button"
              >
                {labels.linkRemove}
              </button>
            </div>
          </div>
          {renderMenuTrigger('edit', labels.editMenu)}
        </>
      );
    }

    if (group === 'structure') {
      return (
        <>
          <ToolbarButton
            active={editor?.isActive('blockquote') ?? false}
            disabled={!editor}
            hidden={editingControlsHidden}
            icon="quote"
            onClick={() => runCompactAction(() => editor?.chain().focus().toggleBlockquote().run())}
            shortcut={shortcutLabels.quote}
            title={labels.quote}
          />
          <ToolbarButton
            active={editor?.isActive('bulletList') ?? false}
            disabled={!editor}
            hidden={editingControlsHidden}
            icon="bullet"
            onClick={() => runCompactAction(() => editor?.chain().focus().toggleBulletList().run())}
            shortcut={shortcutLabels.bullet}
            title={labels.bullet}
          />
          <ToolbarButton
            active={editor?.isActive('orderedList') ?? false}
            disabled={!editor}
            hidden={editingControlsHidden}
            icon="ordered"
            onClick={() => runCompactAction(() => editor?.chain().focus().toggleOrderedList().run())}
            shortcut={shortcutLabels.ordered}
            title={labels.ordered}
          />
          <ToolbarButton
            active={editor?.isActive('taskList') ?? false}
            disabled={!editor}
            hidden={editingControlsHidden}
            icon="task"
            onClick={() => runCompactAction(() => editor?.chain().focus().toggleTaskList().run())}
            shortcut={shortcutLabels.task}
            title={labels.task}
          />
          <ToolbarButton
            active={isTableActive}
            disabled={!editor}
            hidden={editingControlsHidden}
            icon="table"
            onClick={() =>
              runCompactAction(() =>
                editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
              )
            }
            title={labels.table}
          />
          {renderTableActions()}
          <ToolbarButton
            active={editor?.isActive('codeBlock') ?? false}
            disabled={!editor}
            hidden={editingControlsHidden}
            icon="code"
            onClick={() => runCompactAction(insertCodeBlock)}
            shortcut={shortcutLabels.code}
            title={labels.code}
          />
          {isCodeBlockActive ? (
            <div className={clsx('toolbar-language-control', editingControlsHidden && 'is-source-hidden')}>
              <span className="toolbar-language-control__prefix">语言</span>
              <input
                className="toolbar-language-control__input"
                disabled={!editor}
                list="toolbar-code-language-options"
                onBlur={() => updateCodeBlockLanguage(codeLanguageDraft)}
                onChange={(event) => setCodeLanguageDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    updateCodeBlockLanguage(codeLanguageDraft);
                  }
                }}
                placeholder="例如：ts / python / mermaid"
                spellCheck={false}
                title="输入或选择代码块语言"
                type="text"
                value={codeLanguageDraft}
              />
              <datalist id="toolbar-code-language-options">
                {CODE_LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.value || 'plain'} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </datalist>
            </div>
          ) : null}
        </>
      );
    }

    if (group === 'insert') {
      return (
        <>
          <div
            className={clsx(
              'toolbar-submenu-anchor',
              editingControlsHidden && 'is-source-hidden',
              hasFormulaFloatingPanel && 'has-open-panel',
            )}
          >
            <button
              aria-hidden={editingControlsHidden}
              aria-label={labels.math}
              aria-expanded={formulaMenuOpen}
              className={clsx('toolbar-button', formulaMenuOpen && 'is-active', editingControlsHidden && 'is-source-hidden')}
              data-panel-trigger
              data-tooltip={labels.math}
              disabled={!editor}
              onClick={() => {
                const shouldOpen = !formulaMenuOpen;
                closeAllPanels();
                if (shouldOpen) {
                  setFormulaMenuOpen(true);
                }
              }}
              onMouseDown={(event) => event.preventDefault()}
              tabIndex={editingControlsHidden ? -1 : 0}
              type="button"
            >
              <Icon className="toolbar-button__icon" name="math" />
            </button>
            <div
              aria-hidden={!formulaMenuOpen}
              className={formulaMenuOpen ? 'toolbar-submenu is-open' : 'toolbar-submenu is-closed'}
            >
              <button
                className="toolbar-submenu__item"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  runCompactAction(insertInlineMath);
                  setFormulaMenuOpen(false);
                }}
                type="button"
              >
                {labels.mathInline}
              </button>
              <button
                className="toolbar-submenu__item"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  runCompactAction(insertBlockMath);
                  setFormulaMenuOpen(false);
                }}
                type="button"
              >
                {labels.mathBlock}
              </button>
            </div>
          </div>
          <ToolbarButton
            disabled={!editor}
            hidden={editingControlsHidden}
            icon="diagram"
            onClick={() =>
              runCompactAction(() => editor?.chain().focus().insertMermaidBlock('').run())
            }
            title={labels.mermaid}
          />
          <ToolbarButton
            disabled={!editor}
            hidden={editingControlsHidden}
            icon="image"
            onClick={() => runCompactAction(onInsertImage)}
            title={labels.image}
          />
          <ToolbarButton
            disabled={!editor}
            hidden={editingControlsHidden}
            icon="footnote"
            onClick={() => runCompactAction(insertFootnote)}
            title={labels.footnote}
          />
        </>
      );
    }

    return (
      <>
        <ToolbarButton
          icon="menu"
          onClick={() => runCompactAction(onToggleToolbar)}
          shortcut={shortcutLabels.hideToolbar}
          title={toolbarVisible ? labels.hideToolbar : labels.showToolbar}
        />
        <ToolbarButton
          active={sidebarVisible}
          icon="sidebar"
          onClick={() => runCompactAction(onToggleSidebar)}
          shortcut={shortcutLabels.hideSidebar}
          title={sidebarVisible ? labels.hideSidebar : labels.showSidebar}
        />
        <ToolbarButton
          active={sourceMode}
          icon="source"
          onClick={() => runCompactAction(onToggleSourceMode)}
          shortcut={shortcutLabels.sourceMode}
          title={sourceMode ? labels.sourceOn : labels.sourceOff}
        />
        <ToolbarButton
          active={themePanelOpen || theme !== 'system'}
          icon="appearance"
          onClick={() => {
            const shouldOpen = !themePanelOpen;
            closeAllPanels();
            if (shouldOpen) {
              setThemePanelOpen(true);
            }
          }}
          panelTrigger
          shortcut={shortcutLabels.toggleTheme}
          title={`${labels.themePanel} / ${themeLabel} / ${currentPalette?.label ?? labels.auto}`}
        />
        {renderMenuTrigger('view', labels.viewMenu)}
      </>
    );
  };

  return (
    <>
      <header
        aria-hidden={!toolbarVisible}
        className={clsx('toolbar', `toolbar--${layoutMode}`, toolbarVisible ? 'is-visible' : 'is-hidden')}
        ref={toolbarRef}
      >
        <div className="toolbar__row">
          {layoutMode === 'compact' ? (
            <>
              <button
                className={clsx('toolbar-group-launcher', compactGroupOpen === 'document' && 'is-active')}
                onClick={() => toggleCompactGroup('document')}
                type="button"
              >
                <Icon className="toolbar-group-launcher__icon" name="open" />
                <span>{labels.document}</span>
              </button>
              <button
                aria-hidden={editingControlsHidden}
                className={clsx(
                  'toolbar-group-launcher toolbar-group-launcher--collapsible',
                  compactGroupOpen === 'text-style' && 'is-active',
                  editingControlsHidden && 'is-source-hidden',
                )}
                onClick={() => toggleCompactGroup('text-style')}
                tabIndex={editingControlsHidden ? -1 : 0}
                type="button"
              >
                <Icon className="toolbar-group-launcher__icon" name="bold" />
                <span>{labels.textStyle}</span>
              </button>
              <button
                aria-hidden={editingControlsHidden}
                className={clsx(
                  'toolbar-group-launcher toolbar-group-launcher--collapsible',
                  compactGroupOpen === 'structure' && 'is-active',
                  editingControlsHidden && 'is-source-hidden',
                )}
                onClick={() => toggleCompactGroup('structure')}
                tabIndex={editingControlsHidden ? -1 : 0}
                type="button"
              >
                <Icon className="toolbar-group-launcher__icon" name="bullet" />
                <span>{labels.structure}</span>
              </button>
              <button
                aria-hidden={editingControlsHidden}
                className={clsx(
                  'toolbar-group-launcher toolbar-group-launcher--collapsible',
                  compactGroupOpen === 'insert' && 'is-active',
                  editingControlsHidden && 'is-source-hidden',
                )}
                onClick={() => toggleCompactGroup('insert')}
                tabIndex={editingControlsHidden ? -1 : 0}
                type="button"
              >
                <Icon className="toolbar-group-launcher__icon" name="image" />
                <span>{labels.insert}</span>
              </button>
              <button
                className={clsx('toolbar-group-launcher', compactGroupOpen === 'view' && 'is-active')}
                onClick={() => toggleCompactGroup('view')}
                type="button"
              >
                <Icon className="toolbar-group-launcher__icon" name="appearance" />
                <span>{labels.view}</span>
              </button>
            </>
          ) : (
            <>
              <div
                className={clsx('toolbar__group toolbar__group--document', isDenseSplitGroup('document') && 'is-split')}
              >
                {renderGroupActions('document')}
              </div>
              <div
                className={clsx(
                  'toolbar__group toolbar__group--text-style toolbar__group--collapsible',
                  hasLinkFloatingPanel && 'has-floating-panel',
                  isDenseSplitGroup('text-style') && 'is-split',
                  editingControlsHidden && 'is-source-hidden',
                )}
              >
                {renderGroupActions('text-style')}
              </div>
              <div
                className={clsx(
                  'toolbar__group toolbar__group--structure toolbar__group--collapsible',
                  isDenseSplitGroup('structure') && 'is-split',
                  editingControlsHidden && 'is-source-hidden',
                )}
              >
                {renderGroupActions('structure')}
              </div>
              <div
                className={clsx(
                  'toolbar__group toolbar__group--insert toolbar__group--collapsible',
                  hasFormulaFloatingPanel && 'has-floating-panel',
                  isDenseSplitGroup('insert') && 'is-split',
                  editingControlsHidden && 'is-source-hidden',
                )}
              >
                {renderGroupActions('insert')}
              </div>
              <div className={clsx('toolbar__group toolbar__group--view', isDenseSplitGroup('view') && 'is-split')}>
                {renderGroupActions('view')}
              </div>
            </>
          )}
        </div>

        {layoutMode === 'compact' && compactGroupOpen ? (
          <div className="toolbar-compact-panel">
            <div className="toolbar__group toolbar__group--compact">{renderGroupActions(compactGroupOpen)}</div>
          </div>
        ) : null}

        <div
          aria-hidden={!themePanelOpen}
          className={themePanelOpen ? 'theme-panel is-open' : 'theme-panel is-closed'}
        >
          <div className="theme-panel__section">
            <div className="theme-panel__title">{labels.appearanceMode}</div>
            <div className="theme-panel__modes">
              <button
                className={clsx('theme-mode-button', theme === 'system' && 'is-active')}
                onClick={() => {
                  onSetTheme('system');
                  setThemePanelOpen(false);
                }}
                type="button"
              >
                <Icon className="theme-mode-button__icon" name="autoTheme" />
                <span>{labels.auto}</span>
              </button>
              <button
                className={clsx('theme-mode-button', theme === 'light' && 'is-active')}
                onClick={() => {
                  onSetTheme('light');
                  setThemePanelOpen(false);
                }}
                type="button"
              >
                <Icon className="theme-mode-button__icon" name="sun" />
                <span>{labels.light}</span>
              </button>
              <button
                className={clsx('theme-mode-button', theme === 'dark' && 'is-active')}
                onClick={() => {
                  onSetTheme('dark');
                  setThemePanelOpen(false);
                }}
                type="button"
              >
                <Icon className="theme-mode-button__icon" name="moon" />
                <span>{labels.dark}</span>
              </button>
            </div>
          </div>

          <div className="theme-panel__section">
            <div className="theme-panel__title">{labels.glassEffect}</div>
            <div className="theme-panel__glass-options">
              {GLASS_EFFECT_OPTIONS.map((option) => (
                <button
                  className={clsx(
                    'theme-glass-button',
                    glassEffect === option.id && 'is-active',
                  )}
                  key={option.id}
                  onClick={() => {
                    onSetGlassEffect(option.id);
                    setThemePanelOpen(false);
                  }}
                  title={option.description}
                  type="button"
                >
                  <span className={clsx('theme-glass-button__preview', `is-${option.id}`)} />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="theme-panel__section">
            <div className="theme-panel__title">{labels.paletteScheme}</div>
            <div className="theme-panel__palettes">
              {THEME_PALETTE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  className={clsx('theme-palette-button', themePalette === option.id && 'is-active')}
                  onClick={() => {
                    onSetThemePalette(option.id);
                    setThemePanelOpen(false);
                  }}
                  type="button"
                >
                  <span className="theme-palette-button__swatch" style={{ background: option.swatch }} />
                  <span className="theme-palette-button__label">{option.label}</span>
                  <span className="theme-palette-button__description">{option.description}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <button
        aria-hidden={toolbarVisible}
        className={clsx('toolbar-reveal', toolbarVisible ? 'is-hidden' : 'is-visible')}
        data-tooltip={labels.showToolbar}
        onClick={onToggleToolbar}
        tabIndex={toolbarVisible ? -1 : 0}
        type="button"
      >
        <Icon className="toolbar-button__icon" name="menu" />
      </button>
    </>
  );
}

export default memo(Toolbar);

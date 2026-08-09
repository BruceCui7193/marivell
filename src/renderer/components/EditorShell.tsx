import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type RefObject,
  type SyntheticEvent,
} from 'react';
import { EditorContent, useEditor, type Editor as TiptapEditor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { OpenedFolder, SavedDocument, ThemeMode } from '@shared/contracts';
import type { DocumentStats, EditorDocumentState } from '../App';
import type { GlassEffect, ThemePalette } from '../theme';
import Toolbar from './Toolbar';
import StatusBar from './StatusBar';
import Sidebar from './Sidebar';
import SourceEditor, { type SourceCursorInfo } from './SourceEditor';
import ContextMenu, { type ContextMenuState } from './ContextMenu';
import ImageActionMenu from './ImageActionMenu';
import AppDialog, { type AppDialogOptions } from './AppDialog';
import GoToLineDialog from './GoToLineDialog';
import { translate, useAppLanguage } from '../i18n';
import { createEditorExtensions } from '../editor/create-editor-extensions';
import type { PastedImageInfo } from '../editor/plugins/image-drop-paste';
import {
  serializeSliceForClipboard,
  writeClipboardFromSelection,
} from '../editor/clipboard';
import {
  buildSourceContextMenu,
  buildVisualContextMenu,
} from '../editor/context-menu-actions';
import { parseMarkdown, serializeMarkdown } from '../editor/markdown';
import { replaceEditorContent } from '../editor/replace-editor-content';
import {
  SELECTION_END_MARKER,
  SELECTION_START_MARKER,
  extractSelectionMarkersFromMarkdown,
  insertSelectionMarkersIntoMarkdown,
  restoreSelectionMarkersFromEditorState,
} from '../editor/selection-markers';
import {
  findSourceSearchMatches,
  findVisualSearchMatches,
  replaceAllSourceSearchMatches,
  replaceAllVisualSearchMatches,
  replaceSourceSearchMatch,
  replaceVisualSearchMatch,
  selectVisualSearchMatch,
  type SourceSearchMatch,
  type VisualSearchMatch,
} from '../editor/search';
import { setSearchHighlights, clearSearchHighlights } from '../editor/plugins/search-highlight';
import { calculateDocumentStats, fileToBase64 } from '../editor/utils/helpers';
import { extractOutline, type OutlineItem } from '../utils/document';

interface EditorShellProps {
  document: EditorDocumentState;
  folder: OpenedFolder | null;
  theme: ThemeMode;
  themePalette: ThemePalette;
  glassEffect: GlassEffect;
  resolvedTheme: 'light' | 'dark';
  onDocumentChange: (markdown: string, stats: DocumentStats) => void;
  onDocumentMetaChange: (dirty: boolean) => void;
  onOpenDocument: () => void;
  onOpenDocumentPath: (filePath: string) => void | Promise<void>;
  /** Reload from disk without an extra discard prompt (external change flow). */
  onReloadDocumentPath: (filePath: string) => void | Promise<void>;
  onOpenFolder: () => void;
  onSaveDocument: (markdown?: string, stats?: DocumentStats) => Promise<boolean> | boolean;
  onSaveDocumentAs: (markdown?: string, stats?: DocumentStats) => Promise<SavedDocument | null> | SavedDocument | null;
  onCreateDocument: () => void;
  onSetTheme: (theme: ThemeMode) => void;
  onSetThemePalette: (palette: ThemePalette) => void;
  onSetGlassEffect: (effect: GlassEffect) => void;
  onOpenSettings: () => void;
}

function computeSourceStats(markdown: string): DocumentStats {
  return calculateDocumentStats(markdown);
}

interface WorkerParseSuccess {
  id: number;
  ok: true;
  content: JSONContent;
  outline: OutlineItem[];
}

interface WorkerParseFailure {
  id: number;
  ok: false;
  error: string;
}

type WorkerParseResponse = WorkerParseSuccess | WorkerParseFailure;

function createEmptyDocument(): JSONContent {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
      },
    ],
  };
}

function toFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return encodeURI(normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`)
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
}

function getFileNameFromPath(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || 'image.png';
}

function getImageSourcePath(file: unknown): string | null {
  try {
    return window.markdownEditor.getPathForFile?.(file) || (file as any).path || null;
  } catch {
    return (file as any).path || null;
  }
}

function resolveImageSource(source: string, documentPath: string | null): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return '';
  }

  if (/^(https?:|data:|blob:|file:)/i.test(trimmed)) {
    return trimmed;
  }

  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/')) {
    return toFileUrl(trimmed);
  }

  if (!documentPath) {
    return trimmed;
  }

  const baseDirectory = documentPath.replace(/\\/g, '/').replace(/\/[^/]*$/, '/');
  return new URL(trimmed, toFileUrl(baseDirectory)).toString();
}

function getEditorPlainText(editor: TiptapEditor): string {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\n');
}

function extractOutlineFromEditor(editor: TiptapEditor): OutlineItem[] {
  const items: OutlineItem[] = [];
  let blockIndex = 0;

  editor.state.doc.forEach((node) => {
    if (node.type.name === 'heading') {
      const text = node.textContent.trim();
      if (text) {
        items.push({
          id: `heading-pos-${blockIndex}-${items.length}`,
          level: Number(node.attrs.level ?? 1),
          text,
          line: blockIndex,
          start: -1,
        });
      }
    }
    blockIndex += 1;
  });

  // Prefer precise positions for scroll-to-heading when available.
  let itemIdx = 0;
  editor.state.doc.descendants((node, position) => {
    if (node.type.name !== 'heading') {
      return true;
    }
    const text = node.textContent.trim();
    if (!text) {
      return true;
    }
    if (items[itemIdx]) {
      items[itemIdx] = {
        ...items[itemIdx],
        id: `heading-${position}-${itemIdx}`,
        start: position,
      };
      itemIdx += 1;
    }
    return true;
  });

  return items;
}

function areStatsEqual(left: DocumentStats, right: DocumentStats): boolean {
  return (
    left.words === right.words &&
    left.characters === right.characters &&
    left.lines === right.lines
  );
}

function areOutlinesEqual(left: OutlineItem[], right: OutlineItem[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((item, index) => {
    const next = right[index];
    return item.id === next.id && item.level === next.level && item.text === next.text;
  });
}

type IdleHandle = number;

const LARGE_DOCUMENT_THRESHOLD = 200_000;

function scheduleIdleWork(task: () => void, timeout = 1000): IdleHandle {
  return window.setTimeout(task, timeout);
}

function cancelIdleWork(handle: IdleHandle | null): void {
  if (handle === null) {
    return;
  }

  window.clearTimeout(handle);
}

function computeScrollRatio(element: { scrollTop: number; scrollHeight: number; clientHeight: number }): number {
  const maxScrollTop = Math.max(element.scrollHeight - element.clientHeight, 0);
  return maxScrollTop > 0 ? element.scrollTop / maxScrollTop : 0;
}


function clampSourceSelection(selection: SourceSearchMatch, markdown: string): SourceSearchMatch {
  const start = Math.max(0, Math.min(selection.start, markdown.length));
  const end = Math.max(start, Math.min(selection.end, markdown.length));
  return { start, end };
}

function isSameSourceSelection(left: SourceSearchMatch | null, right: SourceSearchMatch | null): boolean {
  return left?.start === right?.start && left?.end === right?.end;
}

function createMarkdownWorker(): Worker {
  return new Worker(new URL('../editor/markdown.worker.ts', import.meta.url), {
    type: 'module',
  });
}

const VISUAL_META_SYNC_DELAY_MS = 260;
const VISUAL_DOCUMENT_SYNC_TIMEOUT_MS = 1400;
const SEARCH_QUERY_PREFILL_MAX_CHARS = 240;
const SEARCH_QUERY_PREFILL_MAX_NEWLINES = 2;

function ensureEditableSelectionAtDocumentStart(editor: TiptapEditor): void {
  const { selection, doc } = editor.state;
  const singleEmptyParagraph =
    doc.childCount === 1 &&
    doc.firstChild?.type.name === 'paragraph' &&
    doc.firstChild.content.size === 0;

  if (!singleEmptyParagraph) {
    return;
  }

  if (selection instanceof TextSelection && selection.$from.parent.isTextblock) {
    return;
  }

  const nextSelection = TextSelection.create(doc, 1, 1);
  editor.view.dispatch(editor.state.tr.setSelection(nextSelection));
}

function focusWritableDocumentEnd(editor: TiptapEditor): void {
  const lastNode = editor.state.doc.lastChild;

  if (!lastNode || lastNode.type.name === 'paragraph') {
    editor.chain().focus('end').run();
    return;
  }

  editor
    .chain()
    .focus()
    .command(({ dispatch, state, tr }) => {
      const paragraphNode = state.schema.nodes.paragraph?.create();
      if (!paragraphNode) {
        return false;
      }

      const insertPos = state.doc.content.size;
      tr = tr.insert(insertPos, paragraphNode);
      tr = tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1));

      if (dispatch) {
        dispatch(tr.scrollIntoView());
      }

      return true;
    })
    .run();
}

function normalizeSearchSeedText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.length > SEARCH_QUERY_PREFILL_MAX_CHARS) {
    return '';
  }

  const lineBreakCount = (trimmed.match(/\n/g) ?? []).length;
  if (lineBreakCount > SEARCH_QUERY_PREFILL_MAX_NEWLINES) {
    return '';
  }

  return trimmed;
}

interface EditorViewportProps {
  editor: TiptapEditor | null;
  editorFrameRef: RefObject<HTMLDivElement>;
  editorHostRef: RefObject<HTMLDivElement>;
  loading: boolean;
  modeSwitching: boolean;
  searchPanel: JSX.Element | null;
  sourceMode: boolean;
  sourceDraft: string;
  sourceTextareaRef: RefObject<HTMLTextAreaElement>;
  onFrameMouseDown: (event: MouseEvent<HTMLDivElement>) => void;
  onSourceChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onSourceSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  onSourceCursorChange: (info: SourceCursorInfo) => void;
  onSourceContextMenu: (event: React.MouseEvent<HTMLTextAreaElement>) => void;
  onVisualContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
}

const EditorViewport = memo(function EditorViewport({
  editor,
  editorFrameRef,
  editorHostRef,
  loading,
  modeSwitching,
  searchPanel,
  sourceMode,
  sourceDraft,
  sourceTextareaRef,
  onFrameMouseDown,
  onSourceChange,
  onSourceSelect,
  onSourceCursorChange,
  onSourceContextMenu,
  onVisualContextMenu,
}: EditorViewportProps) {
  return (
    <div
      ref={editorFrameRef}
      className={sourceMode ? 'editor-frame is-source' : 'editor-frame'}
      onMouseDown={onFrameMouseDown}
      onContextMenu={sourceMode ? undefined : onVisualContextMenu}
    >
      {loading ? <div className="editor-loading">{translate('loadingDocument')}</div> : null}
      {modeSwitching ? (
        <div className="editor-loading editor-loading--mode-switch" role="status" aria-live="polite">
          <span className="editor-loading__spinner" />
          <span>{translate('switchingMode')}</span>
        </div>
      ) : null}
      {searchPanel}
      {sourceMode ? (
        <SourceEditor
          ref={sourceTextareaRef}
          value={sourceDraft}
          onChange={onSourceChange}
          onSelect={onSourceSelect}
          onCursorChange={onSourceCursorChange}
          onContextMenu={onSourceContextMenu}
        />
      ) : (
        <div ref={editorHostRef} onContextMenu={onVisualContextMenu}>
          <EditorContent editor={editor} />
        </div>
      )}
    </div>
  );
});

interface SearchPanelProps {
  caseSensitive: boolean;
  currentMatchLabel: string;
  open: boolean;
  query: string;
  replaceVisible: boolean;
  replacement: string;
  onCaseSensitiveChange: () => void;
  onClose: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onQueryChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onReplaceAll: () => void;
  onReplaceCurrent: () => void;
  onReplacementChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onToggleReplace: () => void;
  queryInputRef: RefObject<HTMLInputElement>;
  replaceInputRef: RefObject<HTMLInputElement>;
}

const SearchPanel = memo(function SearchPanel({
  caseSensitive,
  currentMatchLabel,
  open,
  query,
  replaceVisible,
  replacement,
  onCaseSensitiveChange,
  onClose,
  onNext,
  onPrevious,
  onQueryChange,
  onReplaceAll,
  onReplaceCurrent,
  onReplacementChange,
  onToggleReplace,
  queryInputRef,
  replaceInputRef,
}: SearchPanelProps) {
  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) {
      onPrevious();
      return;
    }

    onNext();
  };

  return (
    <div
      aria-hidden={!open}
      className={open ? 'search-panel is-open' : 'search-panel is-closed'}
      role="dialog"
      aria-label={translate('findReplace')}
    >
      <div className="search-panel__row">
        <input
          ref={queryInputRef}
          className="search-panel__input"
          onChange={onQueryChange}
          onKeyDown={handleInputKeyDown}
          placeholder={translate('searchPlaceholder')}
          spellCheck={false}
          type="text"
          value={query}
        />
        <button
          className={caseSensitive ? 'search-panel__toggle is-active' : 'search-panel__toggle'}
          onClick={onCaseSensitiveChange}
          type="button"
        >
          Aa
        </button>
        <span className="search-panel__count">{currentMatchLabel}</span>
        <button className="search-panel__button" onClick={onPrevious} type="button">
          {translate('previous')}
        </button>
        <button className="search-panel__button" onClick={onNext} type="button">
          {translate('next')}
        </button>
        <button className="search-panel__button" onClick={onToggleReplace} type="button">
          {replaceVisible ? translate('collapseReplace') : translate('expandReplace')}
        </button>
        <button className="search-panel__button" onClick={onClose} type="button">
          {translate('close')}
        </button>
      </div>
      <div className={replaceVisible ? 'search-panel__row search-panel__replace is-open' : 'search-panel__row search-panel__replace is-closed'}>
          <input
            ref={replaceInputRef}
            className="search-panel__input"
            onChange={onReplacementChange}
            onKeyDown={handleInputKeyDown}
            placeholder={translate('replaceWith')}
            spellCheck={false}
            type="text"
            value={replacement}
          />
          <button className="search-panel__button" onClick={onReplaceCurrent} type="button">
            {translate('replaceCurrent')}
          </button>
          <button className="search-panel__button" onClick={onReplaceAll} type="button">
            {translate('replaceAll')}
          </button>
        </div>
    </div>
  );
});

export default function EditorShell({
  document,
  folder,
  theme,
  themePalette,
  glassEffect,
  resolvedTheme,
  onDocumentChange,
  onDocumentMetaChange,
  onOpenDocument,
  onOpenDocumentPath,
  onReloadDocumentPath,
  onOpenFolder,
  onSaveDocument,
  onSaveDocumentAs,
  onCreateDocument,
  onSetTheme,
  onSetThemePalette,
  onSetGlassEffect,
  onOpenSettings,
}: EditorShellProps) {
  useAppLanguage();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const editorFrameRef = useRef<HTMLDivElement | null>(null);
  const sourceTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const markdownWorkerRef = useRef<Worker | null>(null);
  const markdownWorkerRequestRef = useRef(0);
  const latestExternalLoadRef = useRef(0);
  const initialContentRef = useRef<JSONContent>(createEmptyDocument());
  const documentPathRef = useRef(document.path);
  const documentMarkdownRef = useRef(document.markdown);
  const largeDocumentModeRef = useRef(document.markdown.length >= LARGE_DOCUMENT_THRESHOLD);
  const visualMarkdownRef = useRef(document.markdown);
  const visualStatsRef = useRef(document.stats);
  const externalUpdateRef = useRef(false);
  const lastEmittedMarkdownRef = useRef('');
  const windowDirtyRef = useRef(document.dirty);
  const skipNextDocChangeRef = useRef(true);
  const skipNextDocChangeTimerRef = useRef<number | null>(null);
  /** True only after the user actually edits in visual mode (not mode-switch loads). */
  const visualDocEditedRef = useRef(false);
  const pendingVisualMetaSyncRef = useRef<number | null>(null);
  const pendingVisualDocumentSyncRef = useRef<IdleHandle | null>(null);
  const pendingModeSwitchScrollRatioRef = useRef<number | null>(null);
  const pendingSourceSelectionRef = useRef<SourceSearchMatch | null>(null);
  const pendingVisualSelectionRestoreRef = useRef(false);
  const startupCaretPlacedRef = useRef(false);
  const scrollMemoryRef = useRef<Map<string, number>>(new Map());
  const prevDocPathRef = useRef(document.path);
  const pendingScrollRestoreRef = useRef<number | null>(null);
  const modeSwitchOverlayTimerRef = useRef<number | null>(null);
  const sourceSelectionRef = useRef<SourceSearchMatch>({
    start: 0,
    end: 0,
  });
  const sourcePreviewCacheRef = useRef<{
    markdown: string;
    selection: SourceSearchMatch;
    content: JSONContent;
  } | null>(null);
  const sourcePreviewTimerRef = useRef<number | null>(null);
  const sourcePreviewRequestRef = useRef(0);
  const [toolbarVisible, setToolbarVisible] = useState(() => {
    return window.localStorage.getItem('markdown-editor-toolbar') !== 'hidden';
  });
  const [sidebarVisible, setSidebarVisible] = useState(() => {
    return window.localStorage.getItem('markdown-editor-sidebar') !== 'hidden';
  });
  const [sidebarTab, setSidebarTab] = useState<'files' | 'outline'>('files');
  const [sourceMode, setSourceMode] = useState(() => {
    return window.localStorage.getItem('markdown-editor-source-mode') === 'true';
  });
  const [sourceDraft, setSourceDraft] = useState(document.markdown);
  const [liveStats, setLiveStats] = useState(document.stats);
  const [liveDirty, setLiveDirty] = useState(document.dirty);
  const [loadingExternalDocument, setLoadingExternalDocument] = useState(false);
  const [modeSwitching, setModeSwitching] = useState(false);
  const sourceModeRef = useRef(sourceMode);
  const sourceDraftRef = useRef(sourceDraft);
  const searchPanelOpenRef = useRef(false);
  const searchAutoRevealSignatureRef = useRef('');
  const [outline, setOutline] = useState<OutlineItem[]>(() => extractOutline(document.markdown));
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchReplaceVisible, setSearchReplaceVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchReplacement, setSearchReplacement] = useState('');
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchCurrentIndex, setSearchCurrentIndex] = useState(0);
  const [visualSearchRevision, setVisualSearchRevision] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [imageActionMenu, setImageActionMenu] = useState<PastedImageInfo | null>(null);
  const [imageActionMenuPos, setImageActionMenuPos] = useState({ x: 0, y: 0 });
  const [appDialog, setAppDialog] = useState<AppDialogOptions | null>(null);
  const appDialogRef = useRef<AppDialogOptions | null>(null);
  const editorRef = useRef<TiptapEditor | null>(null);
  const onImagePastedRef = useRef<(info: PastedImageInfo) => void>(() => {});
  const [sourceCursor, setSourceCursor] = useState<SourceCursorInfo>({
    line: 1,
    column: 1,
    start: 0,
    end: 0,
  });
  const [gotoLineOpen, setGotoLineOpen] = useState(false);
  const gotoLineDefaultRef = useRef('1');

  const openAppDialog = useCallback((dialog: AppDialogOptions) => {
    appDialogRef.current = dialog;
    setAppDialog(dialog);
  }, []);

  const closeAppDialog = useCallback(() => {
    appDialogRef.current = null;
    setAppDialog(null);
  }, []);

  const resolveAppDialog = useCallback((value: string) => {
    const dialog = appDialogRef.current;
    closeAppDialog();
    dialog?.onResolve(value);
  }, [closeAppDialog]);

  useEffect(() => {
    documentPathRef.current = document.path;
  }, [document.path]);

  useEffect(() => {
    documentMarkdownRef.current = document.markdown;
  }, [document.markdown]);

  useEffect(() => {
    visualMarkdownRef.current = document.markdown;
    visualStatsRef.current = document.stats;
  }, [document.markdown, document.stats]);

  useEffect(() => {
    largeDocumentModeRef.current = document.markdown.length >= LARGE_DOCUMENT_THRESHOLD;
  }, [document.markdown.length]);

  useEffect(() => {
    windowDirtyRef.current = document.dirty;
  }, [document.dirty]);

  useEffect(() => {
    setLiveDirty(document.dirty);
  }, [document.dirty]);

  useEffect(() => {
    setLiveStats((current) => (areStatsEqual(current, document.stats) ? current : document.stats));
  }, [document.stats]);

  useEffect(() => {
    sourceModeRef.current = sourceMode;
  }, [sourceMode]);

  useEffect(() => {
    sourceDraftRef.current = sourceDraft;
  }, [sourceDraft]);

  useEffect(() => {
    searchPanelOpenRef.current = searchOpen;
  }, [searchOpen]);

  const armSkipNextDocChange = useCallback(() => {
    skipNextDocChangeRef.current = true;
    if (skipNextDocChangeTimerRef.current !== null) {
      window.clearTimeout(skipNextDocChangeTimerRef.current);
    }

    skipNextDocChangeTimerRef.current = window.setTimeout(() => {
      skipNextDocChangeRef.current = false;
      skipNextDocChangeTimerRef.current = null;
    }, 0);
  }, []);

  const applySourceMarkdown = useCallback(
    (markdown: string, selection?: SourceSearchMatch) => {
      const nextStats = computeSourceStats(markdown);
      const dirty = markdown !== document.savedMarkdown;
      setSourceDraft(markdown);
      sourceDraftRef.current = markdown;
      setLiveStats((current) => (areStatsEqual(current, nextStats) ? current : nextStats));
      setLiveDirty(dirty);
      onDocumentChange(markdown, nextStats);
      const nextOutline = extractOutline(markdown);
      setOutline((current) => (areOutlinesEqual(current, nextOutline) ? current : nextOutline));
      onDocumentMetaChange(dirty);

      if (selection) {
        requestAnimationFrame(() => {
          const input = sourceTextareaRef.current;
          if (!input) {
            return;
          }

          input.focus();
          input.setSelectionRange(selection.start, selection.end);
        });
      }
    },
    [document.savedMarkdown, onDocumentChange, onDocumentMetaChange],
  );

  const captureModeSwitchScrollRatio = useCallback(() => {
    const activeScrollElement = sourceModeRef.current
      ? sourceTextareaRef.current
      : editorFrameRef.current;
    if (!activeScrollElement) {
      pendingModeSwitchScrollRatioRef.current = null;
      return;
    }

    pendingModeSwitchScrollRatioRef.current = computeScrollRatio(activeScrollElement);
  }, []);

  const buildSourceDraftFromVisualSelection = useCallback(
    (targetEditor: TiptapEditor): { markdown: string; selection: SourceSearchMatch } => {
      const { from, to } = targetEditor.state.selection;
      const transaction = targetEditor.state.tr;
      transaction.insertText(SELECTION_END_MARKER, to);
      transaction.insertText(SELECTION_START_MARKER, from);

      const markedMarkdown = serializeMarkdown(transaction.doc.toJSON());
      return extractSelectionMarkersFromMarkdown(markedMarkdown);
    },
    [],
  );


  const parseMarkdownInWorker = useCallback((markdown: string) => {
    if (!markdownWorkerRef.current) {
      markdownWorkerRef.current = createMarkdownWorker();
    }

    const worker = markdownWorkerRef.current;
    const requestId = ++markdownWorkerRequestRef.current;

    return new Promise<WorkerParseSuccess>((resolve, reject) => {
      const handleMessage = (event: MessageEvent<WorkerParseResponse>) => {
        if (event.data.id !== requestId) {
          return;
        }

        worker.removeEventListener('message', handleMessage);
        worker.removeEventListener('error', handleError);

        if (event.data.ok) {
          resolve(event.data);
          return;
        }

        reject(new Error(event.data.error));
      };

      const handleError = (event: ErrorEvent) => {
        worker.removeEventListener('message', handleMessage);
        worker.removeEventListener('error', handleError);
        reject(event.error instanceof Error ? event.error : new Error(event.message));
      };

      worker.addEventListener('message', handleMessage);
      worker.addEventListener('error', handleError, { once: true });
      worker.postMessage({ id: requestId, markdown });
    });
  }, []);

  const queueSourcePreview = useCallback(
    (markdown: string, selection: SourceSearchMatch) => {
      const normalizedSelection = clampSourceSelection(selection, markdown);
      sourceSelectionRef.current = normalizedSelection;
      sourcePreviewCacheRef.current = null;
      sourcePreviewRequestRef.current += 1;
      const requestId = sourcePreviewRequestRef.current;

      if (sourcePreviewTimerRef.current !== null) {
        window.clearTimeout(sourcePreviewTimerRef.current);
      }

      sourcePreviewTimerRef.current = window.setTimeout(() => {
        sourcePreviewTimerRef.current = null;
        const markedMarkdown = insertSelectionMarkersIntoMarkdown(
          markdown,
          normalizedSelection.start,
          normalizedSelection.end,
        );

        void parseMarkdownInWorker(markedMarkdown)
          .then((result) => {
            if (
              requestId !== sourcePreviewRequestRef.current ||
              !sourceModeRef.current ||
              sourceDraftRef.current !== markdown ||
              !isSameSourceSelection(sourceSelectionRef.current, normalizedSelection)
            ) {
              return;
            }

            sourcePreviewCacheRef.current = {
              markdown,
              selection: normalizedSelection,
              content: result.content,
            };
          })
          .catch(() => {
            if (requestId === sourcePreviewRequestRef.current) {
              sourcePreviewCacheRef.current = null;
            }
          });
      }, markdown.length >= LARGE_DOCUMENT_THRESHOLD ? 180 : 60);
    },
    [parseMarkdownInWorker],
  );

  useEffect(() => {
    return () => {
      markdownWorkerRef.current?.terminate();
      markdownWorkerRef.current = null;
      if (skipNextDocChangeTimerRef.current !== null) {
        window.clearTimeout(skipNextDocChangeTimerRef.current);
        skipNextDocChangeTimerRef.current = null;
      }
      if (sourcePreviewTimerRef.current !== null) {
        window.clearTimeout(sourcePreviewTimerRef.current);
        sourcePreviewTimerRef.current = null;
      }
    };
  }, []);

  // Sync source draft only when the document changes externally (open file /
  // reload). Do NOT reset the caret on every local keystroke — that used to
  // jump the selection to the end of the file while editing in source mode,
  // and also fought with the visual↔source selection restore path.
  useEffect(() => {
    if (!sourceMode) {
      return;
    }

    // Local source edits already keep sourceDraft / document.markdown in sync.
    if (document.markdown === sourceDraftRef.current) {
      setLiveDirty(document.dirty);
      return;
    }

    setSourceDraft(document.markdown);
    sourceDraftRef.current = document.markdown;
    sourceSelectionRef.current = {
      start: document.markdown.length,
      end: document.markdown.length,
    };
    sourcePreviewCacheRef.current = null;
    const nextStats = computeSourceStats(document.markdown);
    setLiveStats((current) => (areStatsEqual(current, nextStats) ? current : nextStats));
    setLiveDirty(document.dirty);
    const nextOutline = extractOutline(document.markdown);
    setOutline((current) => (areOutlinesEqual(current, nextOutline) ? current : nextOutline));
    onDocumentMetaChange(document.dirty);
  }, [document.dirty, document.markdown, onDocumentMetaChange, sourceMode]);

  useEffect(() => {
    window.localStorage.setItem('markdown-editor-toolbar', toolbarVisible ? 'visible' : 'hidden');
  }, [toolbarVisible]);

  useEffect(() => {
    window.localStorage.setItem('markdown-editor-sidebar', sidebarVisible ? 'visible' : 'hidden');
  }, [sidebarVisible]);

  useEffect(() => {
    window.localStorage.setItem('markdown-editor-source-mode', sourceMode ? 'true' : 'false');
  }, [sourceMode]);

  useEffect(() => {
    if (sourceMode) {
      return;
    }

    sourcePreviewCacheRef.current = null;
    sourcePreviewRequestRef.current += 1;
    if (sourcePreviewTimerRef.current !== null) {
      window.clearTimeout(sourcePreviewTimerRef.current);
      sourcePreviewTimerRef.current = null;
    }
  }, [sourceMode]);

  const showImageActionMenu = useCallback((info: PastedImageInfo) => {
    const currentEditor = editorRef.current;
    let x = 16;
    let y = 16;
    if (currentEditor && info.pos != null) {
      try {
        const coords = currentEditor.view.coordsAtPos(info.pos);
        x = coords.left;
        y = coords.bottom + 8;
      } catch {
        // Keep the menu near the viewport if the image position is transient.
      }
    }
    x = Math.max(8, Math.min(x, window.innerWidth - 280));
    y = Math.max(8, Math.min(y, window.innerHeight - 180));
    setImageActionMenuPos({ x, y });
    setImageActionMenu(info);
  }, []);

  useEffect(() => {
    onImagePastedRef.current = showImageActionMenu;
  }, [showImageActionMenu]);

  const closeImageActionMenu = useCallback(() => {
    setImageActionMenu(null);
  }, []);

  const extensions = useMemo(
    () =>
      createEditorExtensions({
        onUploadImage: async (file) => {
          const sourcePath = getImageSourcePath(file);
          const base64 = await fileToBase64(file);
          const saved = await window.markdownEditor.saveImage({
            base64,
            suggestedName: file.name,
            currentPath: documentPathRef.current,
            destination: 'default',
            sourcePath,
          });

          return {
            src: saved.markdownPath,
            absolutePath: saved.absolutePath,
            sourcePath,
          };
        },
        onImagePasted: (info) => onImagePastedRef.current?.(info),
        onResolveImageSource: (source) => resolveImageSource(source, documentPathRef.current),
      }),
    [],
  );

  const handleClipboardTextSerialize = useCallback(
    (slice: { content: { toJSON: () => unknown }; openStart?: number; openEnd?: number }) => {
      return serializeSliceForClipboard(slice);
    },
    [],
  );

  const handleEditorCopy = useCallback((view: TiptapEditor['view'], event: Event) => {
    return writeClipboardFromSelection(view, event as ClipboardEvent);
  }, []);

  const handleEditorCut = useCallback((view: TiptapEditor['view'], event: Event) => {
    const clipboardEvent = event as ClipboardEvent;
    if (view.state.selection.empty || !clipboardEvent.clipboardData) {
      return false;
    }

    const wrote = writeClipboardFromSelection(view, clipboardEvent);
    if (!wrote) {
      return false;
    }

    // Delete the selection after writing the clipboard (cut semantics).
    const { state, dispatch } = view;
    dispatch(state.tr.deleteSelection().scrollIntoView());
    return true;
  }, []);

  const handleEditorClick = useCallback((_view: unknown, _pos: unknown, event: Event) => {
    const target = event.target as HTMLElement;
    const link = target?.closest('a[href]') as HTMLAnchorElement | null;

    if (link && ('metaKey' in event || 'ctrlKey' in event)) {
      const keyboardLikeEvent = event as Event & { metaKey?: boolean; ctrlKey?: boolean };
      if (!(keyboardLikeEvent.metaKey || keyboardLikeEvent.ctrlKey)) {
        return false;
      }

      void window.markdownEditor.openExternal(link.href);
      return true;
    }

    return false;
  }, []);

  const editorProps = useMemo(
    () => ({
      attributes: {
        class: 'editor-surface',
        spellcheck: 'true',
      },
      clipboardTextSerializer: handleClipboardTextSerialize,
      handleDOMEvents: {
        copy: handleEditorCopy,
        cut: handleEditorCut,
      },
      handleClick: handleEditorClick,
    }),
    [handleClipboardTextSerialize, handleEditorClick, handleEditorCopy, handleEditorCut],
  );

  const editor = useEditor({
    extensions,
    content: initialContentRef.current,
    shouldRerenderOnTransaction: false,
    editorProps,
    onCreate: ({ editor: nextEditor }) => {
      const canonicalMarkdown = serializeMarkdown(nextEditor.getJSON());
      const stats = calculateDocumentStats(getEditorPlainText(nextEditor));
      setLiveStats(stats);
      setLiveDirty(false);
      setOutline(extractOutlineFromEditor(nextEditor));
      visualMarkdownRef.current = canonicalMarkdown;
      visualStatsRef.current = stats;
      lastEmittedMarkdownRef.current = canonicalMarkdown;
      setVisualSearchRevision((current) => current + 1);
      armSkipNextDocChange();

      ensureEditableSelectionAtDocumentStart(nextEditor);
      nextEditor.commands.focus('start');
    },
    onSelectionUpdate: ({ editor: nextEditor }) => {
      ensureEditableSelectionAtDocumentStart(nextEditor);
    },
    onFocus: ({ editor: nextEditor }) => {
      ensureEditableSelectionAtDocumentStart(nextEditor);
    },
    onUpdate: ({ editor: nextEditor, transaction }) => {
      if (externalUpdateRef.current || sourceModeRef.current) {
        return;
      }

      if (!transaction.docChanged) {
        return;
      }

      if (skipNextDocChangeRef.current) {
        skipNextDocChangeRef.current = false;
        // Programmatic setContent from mode switch / file load — not a user edit.
        visualDocEditedRef.current = false;
        if (!largeDocumentModeRef.current) {
          // Keep lastEmittedMarkdownRef as the canonical source string when we
          // just loaded from source; do not overwrite it with a re-serialize
          // that may normalize delimiters / spacing and look like "tampering".
          const stats = calculateDocumentStats(getEditorPlainText(nextEditor));
          visualStatsRef.current = stats;
          if (!lastEmittedMarkdownRef.current) {
            const canonicalMarkdown = serializeMarkdown(nextEditor.getJSON());
            visualMarkdownRef.current = canonicalMarkdown;
            lastEmittedMarkdownRef.current = canonicalMarkdown;
          } else {
            visualMarkdownRef.current = lastEmittedMarkdownRef.current;
          }
        }
        setLiveDirty(false);
        if (searchPanelOpenRef.current) {
          setVisualSearchRevision((current) => current + 1);
        }
        return;
      }

      visualDocEditedRef.current = true;

      if (!windowDirtyRef.current) {
        windowDirtyRef.current = true;
        setLiveDirty(true);
        onDocumentMetaChange(true);
        void window.markdownEditor.setWindowDirty(true);
      }

      if (pendingVisualMetaSyncRef.current !== null) {
        window.clearTimeout(pendingVisualMetaSyncRef.current);
      }

      if (largeDocumentModeRef.current) {
        pendingVisualMetaSyncRef.current = window.setTimeout(() => {
          pendingVisualMetaSyncRef.current = null;
        }, 900);

        if (pendingVisualDocumentSyncRef.current !== null) {
          cancelIdleWork(pendingVisualDocumentSyncRef.current);
          pendingVisualDocumentSyncRef.current = null;
        }

        return;
      }

      pendingVisualMetaSyncRef.current = window.setTimeout(() => {
        const stats = calculateDocumentStats(getEditorPlainText(nextEditor));
        setLiveStats((current) => (areStatsEqual(current, stats) ? current : stats));

        if (sidebarVisible && sidebarTab === 'outline') {
          const nextOutline = extractOutlineFromEditor(nextEditor);
          setOutline((current) => (areOutlinesEqual(current, nextOutline) ? current : nextOutline));
        }

        pendingVisualMetaSyncRef.current = null;
      }, VISUAL_META_SYNC_DELAY_MS);

      if (pendingVisualDocumentSyncRef.current !== null) {
        cancelIdleWork(pendingVisualDocumentSyncRef.current);
      }

      pendingVisualDocumentSyncRef.current = scheduleIdleWork(() => {
        const markdown = serializeMarkdown(nextEditor.getJSON());
        const stats = calculateDocumentStats(getEditorPlainText(nextEditor));
        visualMarkdownRef.current = markdown;
        visualStatsRef.current = stats;
        lastEmittedMarkdownRef.current = markdown;
        pendingVisualDocumentSyncRef.current = null;
      }, VISUAL_DOCUMENT_SYNC_TIMEOUT_MS);

      if (searchPanelOpenRef.current) {
        setVisualSearchRevision((current) => current + 1);
      }
    },
  }, []);

  useEffect(() => {
    editorRef.current = editor;
    if (window.markdownEditor.getBenchmarkEnabled?.()) {
      (window as unknown as Record<string, unknown>).__marivellEditor = editor;
    }
  }, [editor]);

  const updateImageSrc = useCallback((oldSrc: string, newSrc: string) => {
    if (!editor) {
      return;
    }

    let targetPos: number | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'image' && node.attrs.src === oldSrc) {
        targetPos = pos;
        return false;
      }
      return true;
    });

    if (targetPos == null) {
      return;
    }

    const targetNode = editor.state.doc.nodeAt(targetPos);
    if (!targetNode) {
      return;
    }

    const transaction = editor.state.tr
      .setNodeMarkup(targetPos, undefined, {
        ...targetNode.attrs,
        src: newSrc,
      })
      .setMeta('addToHistory', false);
    editor.view.dispatch(transaction.scrollIntoView());
  }, [editor]);

  const copyImageToCurrent = useCallback(async () => {
    const target = imageActionMenu;
    if (!target) {
      return;
    }

    let currentPath = documentPathRef.current;
    if (!currentPath) {
      const visualState = sourceModeRef.current ? null : flushVisualSync();
      const saved = await onSaveDocumentAs(
        sourceModeRef.current ? sourceDraftRef.current : visualState?.markdown,
        sourceModeRef.current ? computeSourceStats(sourceDraftRef.current) : visualState?.stats,
      );
      if (!saved?.path) {
        return;
      }

      currentPath = saved.path;
    }

    const savedImage = await window.markdownEditor.saveImage({
      sourcePath: target.absolutePath,
      suggestedName: getFileNameFromPath(target.absolutePath),
      currentPath,
      destination: 'document',
    });
    updateImageSrc(target.src, savedImage.markdownPath);

    const visualState = sourceModeRef.current ? null : flushVisualSync();
    await onSaveDocument(
      sourceModeRef.current ? sourceDraftRef.current : visualState?.markdown,
      sourceModeRef.current ? computeSourceStats(sourceDraftRef.current) : visualState?.stats,
    );
    closeImageActionMenu();
  }, [closeImageActionMenu, imageActionMenu, onSaveDocument, onSaveDocumentAs, updateImageSrc]);

  const keepOriginalPath = useCallback(async () => {
    const target = imageActionMenu;
    if (!target?.sourcePath) {
      return;
    }

    updateImageSrc(target.src, target.sourcePath);
    closeImageActionMenu();
  }, [closeImageActionMenu, imageActionMenu, updateImageSrc]);

  const copyImageToOther = useCallback(async () => {
    const target = imageActionMenu;
    if (!target) {
      return;
    }

    const targetDirectory = await window.markdownEditor.chooseImageDirectory();
    if (!targetDirectory) {
      return;
    }

    const savedImage = await window.markdownEditor.saveImage({
      sourcePath: target.absolutePath,
      suggestedName: getFileNameFromPath(target.absolutePath),
      currentPath: documentPathRef.current,
      destination: 'other',
      targetDirectory,
    });
    updateImageSrc(target.src, savedImage.markdownPath);
    closeImageActionMenu();
  }, [closeImageActionMenu, imageActionMenu, updateImageSrc]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    editor.view.dom.setAttribute(
      'spellcheck',
      largeDocumentModeRef.current ? 'false' : 'true',
    );
  }, [document.markdown.length, editor]);

  function flushVisualSync(targetEditor = editor): { markdown: string; stats: DocumentStats } | null {
    if (!targetEditor) {
      return null;
    }

    if (pendingVisualMetaSyncRef.current !== null) {
      window.clearTimeout(pendingVisualMetaSyncRef.current);
      pendingVisualMetaSyncRef.current = null;
    }

    if (pendingVisualDocumentSyncRef.current !== null) {
      cancelIdleWork(pendingVisualDocumentSyncRef.current);
      pendingVisualDocumentSyncRef.current = null;
    }

    // If the user only toggled modes without editing visually, prefer the
    // last canonical markdown (source or last emitted) over a re-serialize
    // that can rewrite task lists, math delimiters, etc.
    const markdown = visualDocEditedRef.current
      ? serializeMarkdown(targetEditor.getJSON())
      : lastEmittedMarkdownRef.current ||
        visualMarkdownRef.current ||
        serializeMarkdown(targetEditor.getJSON());
    const stats = calculateDocumentStats(getEditorPlainText(targetEditor));
    visualMarkdownRef.current = markdown;
    visualStatsRef.current = stats;
    lastEmittedMarkdownRef.current = markdown;
    setLiveStats((current) => (areStatsEqual(current, stats) ? current : stats));
    setLiveDirty(markdown !== document.savedMarkdown);
    onDocumentChange(markdown, stats);
    const nextOutline = extractOutlineFromEditor(targetEditor);
    setOutline((current) => (areOutlinesEqual(current, nextOutline) ? current : nextOutline));
    return { markdown, stats };
  }

  useEffect(() => {
    return () => {
      if (pendingVisualMetaSyncRef.current !== null) {
        window.clearTimeout(pendingVisualMetaSyncRef.current);
      }

      if (pendingVisualDocumentSyncRef.current !== null) {
        cancelIdleWork(pendingVisualDocumentSyncRef.current);
      }

      if (modeSwitchOverlayTimerRef.current !== null) {
        window.clearTimeout(modeSwitchOverlayTimerRef.current);
      }
    };
  }, []);

  // Save scroll position when switching away from a document, so we can
  // restore it when switching back. Runs before the loading effect so the
  // old scroll position is captured before content is replaced.
  useEffect(() => {
    if (document.path === prevDocPathRef.current) {
      return;
    }

    const scrollEl = sourceModeRef.current
      ? sourceTextareaRef.current
      : editorFrameRef.current;
    const previousPath = prevDocPathRef.current;
    if (scrollEl && previousPath) {
      scrollMemoryRef.current.set(previousPath, computeScrollRatio(scrollEl));
    }
    prevDocPathRef.current = document.path;
  }, [document.path]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    // Never leave the visual editor locked when we are not actively loading into it
    // (source mode, or content already synced). Stuck contenteditable=false is what
    // makes the caret disappear after external reloads.
    const ensureEditable = () => {
      if (editor.isDestroyed) {
        return;
      }
      if (!editor.isEditable) {
        editor.setEditable(true);
      }
    };

    if (sourceMode) {
      ensureEditable();
      setLoadingExternalDocument(false);
      return;
    }

    if (document.markdown === lastEmittedMarkdownRef.current) {
      ensureEditable();
      setLoadingExternalDocument(false);
      return;
    }

    let cancelled = false;
    const loadId = latestExternalLoadRef.current + 1;
    latestExternalLoadRef.current = loadId;
    setLoadingExternalDocument(true);
    startupCaretPlacedRef.current = false;
    editor.setEditable(false);

    // Queue scroll restoration for after the content loads.
    const pathKey = document.path;
    const savedRatio = pathKey ? scrollMemoryRef.current.get(pathKey) : undefined;
    if (savedRatio != null) {
      pendingScrollRestoreRef.current = savedRatio;
    }

    const isActiveLoad = () =>
      !cancelled && latestExternalLoadRef.current === loadId && !editor.isDestroyed;

    const finishLoad = () => {
      if (!isActiveLoad()) {
        return;
      }
      editor.setEditable(true);
      setLoadingExternalDocument(false);
      if (window.markdownEditor.getBenchmarkEnabled?.()) {
        window.markdownEditor.reportBenchmarkMetric('visual-editor-ready', Date.now());
      }
      // A dialog can steal focus; put the caret back after content is ready.
      // startupCaretPlaced effect also runs when loading flips false.
      requestAnimationFrame(() => {
        if (!isActiveLoad() || sourceModeRef.current || !editor.isEditable) {
          return;
        }
        if (!editor.view.hasFocus()) {
          try {
            editor.commands.focus();
          } catch {
            // ignore focus failures on destroyed views
          }
        }
      });
    };

    const applyParsedContent = (content: JSONContent, outlineItems: OutlineItem[] | null) => {
      if (!isActiveLoad() || sourceModeRef.current) {
        return;
      }

      externalUpdateRef.current = true;
      armSkipNextDocChange();
      visualDocEditedRef.current = false;
      replaceEditorContent(editor, content);
      externalUpdateRef.current = false;

      // Keep the file's original markdown as canonical so a load+mode-switch
      // does not rewrite the document via parse/serialize normalization.
      const stats = calculateDocumentStats(getEditorPlainText(editor));
      const nextOutline = outlineItems ?? extractOutline(document.markdown);
      visualMarkdownRef.current = document.markdown;
      visualStatsRef.current = stats;
      lastEmittedMarkdownRef.current = document.markdown;
      setOutline((current) => (areOutlinesEqual(current, nextOutline) ? current : nextOutline));
      setLiveStats((current) => (areStatsEqual(current, stats) ? current : stats));
      setLiveDirty(document.dirty);
      setVisualSearchRevision((current) => current + 1);
    };

    const applyEmptyFallback = () => {
      if (!isActiveLoad()) {
        return;
      }

      const emptyStats = computeSourceStats('');
      externalUpdateRef.current = true;
      armSkipNextDocChange();
      visualDocEditedRef.current = false;
      replaceEditorContent(editor, createEmptyDocument());
      externalUpdateRef.current = false;
      visualMarkdownRef.current = '';
      visualStatsRef.current = emptyStats;
      lastEmittedMarkdownRef.current = '';
      setOutline((current) => (current.length === 0 ? current : []));
      setLiveStats((current) => (areStatsEqual(current, emptyStats) ? current : emptyStats));
      setLiveDirty(document.dirty);
      setVisualSearchRevision((current) => current + 1);
    };

    if (document.markdown.length < LARGE_DOCUMENT_THRESHOLD) {
      void import('../editor/markdown')
        .then(({ parseMarkdown }) => {
          applyParsedContent(parseMarkdown(document.markdown), null);
        })
        .catch(() => {
          applyEmptyFallback();
        })
        .finally(() => {
          finishLoad();
        });
    } else {
      void parseMarkdownInWorker(document.markdown)
        .then((result) => {
          applyParsedContent(result.content, result.outline);
        })
        .catch(async () => {
          try {
            const { parseMarkdown } = await import('../editor/markdown');
            if (!isActiveLoad()) {
              return;
            }
            applyParsedContent(parseMarkdown(document.markdown), null);
          } catch {
            applyEmptyFallback();
          }
        })
        .finally(() => {
          finishLoad();
        });
    }

    return () => {
      cancelled = true;
      // If this load is still the latest owner, unlock so a cancelled/re-run path
      // cannot leave contenteditable=false. A newer load will lock again immediately.
      if (latestExternalLoadRef.current === loadId && !editor.isDestroyed) {
        editor.setEditable(true);
        setLoadingExternalDocument(false);
      }
    };
  }, [document.markdown, document.path, document.dirty, editor, parseMarkdownInWorker, sourceMode]);

  useEffect(() => {
    if (sourceMode) {
      requestAnimationFrame(() => {
        const input = sourceTextareaRef.current;
        if (!input) {
          return;
        }

        input.focus({ preventScroll: true });
        const selection = pendingSourceSelectionRef.current;
        if (selection) {
          input.setSelectionRange(selection.start, selection.end);
          sourceSelectionRef.current = selection;
          queueSourcePreview(sourceDraftRef.current, selection);
          pendingSourceSelectionRef.current = null;
          return;
        }

        const nextSelection = {
          start: input.selectionStart ?? sourceDraftRef.current.length,
          end: input.selectionEnd ?? sourceDraftRef.current.length,
        };
        sourceSelectionRef.current = nextSelection;
        queueSourcePreview(sourceDraftRef.current, nextSelection);
      });
      return;
    }

    requestAnimationFrame(() => {
      if (!editorHostRef.current) {
        return;
      }

      const headings = editorHostRef.current.querySelectorAll('h1, h2, h3, h4, h5, h6');
      headings.forEach((heading, index) => {
        (heading as HTMLElement).dataset.outlineIndex = String(index);
      });
    });
  }, [document.markdown, queueSourcePreview, sourceMode]);

  useEffect(() => {
    const ratio = pendingModeSwitchScrollRatioRef.current;
    if (ratio === null) {
      return;
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const target = sourceMode ? sourceTextareaRef.current : editorFrameRef.current;
        if (!target) {
          pendingModeSwitchScrollRatioRef.current = null;
          return;
        }

        const maxScrollTop = Math.max(target.scrollHeight - target.clientHeight, 0);
        target.scrollTop = maxScrollTop * ratio;
        pendingModeSwitchScrollRatioRef.current = null;
      });
    });
  }, [document.markdown, sourceDraft, sourceMode]);

  useEffect(() => {
    if (sourceMode || !editor || !pendingVisualSelectionRestoreRef.current) {
      return;
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (sourceModeRef.current || !pendingVisualSelectionRestoreRef.current) {
          return;
        }

        pendingVisualSelectionRestoreRef.current = false;
        restoreSelectionMarkersFromEditorState(editor.state, editor.view);
      });
    });
  }, [editor, sourceMode]);

  useEffect(() => {
    if (startupCaretPlacedRef.current || loadingExternalDocument) {
      return;
    }

    requestAnimationFrame(() => {
      if (startupCaretPlacedRef.current) {
        return;
      }

      if (sourceModeRef.current) {
        const input = sourceTextareaRef.current;
        if (!input) {
          return;
        }

        input.focus({ preventScroll: true });
        input.setSelectionRange(0, 0);
        input.scrollTop = 0;
        sourceSelectionRef.current = { start: 0, end: 0 };
        startupCaretPlacedRef.current = true;
        return;
      }

      if (!editor) {
        return;
      }

      editor.chain().focus('start').run();

      // Restore saved scroll position if available; otherwise scroll to top.
      const savedRatio = pendingScrollRestoreRef.current;
      if (savedRatio != null) {
        pendingScrollRestoreRef.current = null;
        const frame = editorFrameRef.current;
        if (frame) {
          const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
          frame.scrollTop = maxScrollTop * savedRatio;
        }
      } else {
        editorFrameRef.current?.scrollTo({ top: 0 });
      }
      startupCaretPlacedRef.current = true;
    });
  }, [editor, loadingExternalDocument, sourceMode]);

  const searchMatches = useMemo<Array<SourceSearchMatch | VisualSearchMatch>>(() => {
    if (!searchOpen || !searchQuery) {
      return [];
    }

    if (sourceMode) {
      return findSourceSearchMatches(sourceDraft, searchQuery, {
        caseSensitive: searchCaseSensitive,
      });
    }

    if (!editor) {
      return [];
    }

    return findVisualSearchMatches(editor, searchQuery, {
      caseSensitive: searchCaseSensitive,
    });
  }, [
    editor,
    searchCaseSensitive,
    searchOpen,
    searchQuery,
    sourceDraft,
    sourceMode,
    visualSearchRevision,
  ]);

  const revealSourceMatch = useCallback((match: SourceSearchMatch, focusEditor = true) => {
    requestAnimationFrame(() => {
      const input = sourceTextareaRef.current;
      if (!input) {
        return;
      }

      // Briefly focus to make the selection visible, then return focus
      // to the search input so the user can keep navigating.
      const returnFocus = !focusEditor && window.document.activeElement !== input;
      if (focusEditor || returnFocus) {
        input.focus();
      }
      input.setSelectionRange(match.start, match.end);

      // Scroll the match into view within the textarea
      const textBefore = input.value.slice(0, match.start);
      const lineHeight = Math.max(parseInt(getComputedStyle(input).lineHeight) || 20, 16);
      const targetLine = textBefore.split('\n').length - 1;
      const visibleLines = Math.floor(input.clientHeight / lineHeight);
      const scrollTarget = Math.max(0, (targetLine - Math.floor(visibleLines / 3)) * lineHeight);
      input.scrollTop = scrollTarget;

      if (returnFocus) {
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
    });
  }, []);

  const applySearchDecorations = useCallback(() => {
    if (!editor || sourceMode || !searchOpen || !searchQuery) {
      if (editor) clearSearchHighlights(editor.view);
      return;
    }

    const visualMatches = searchMatches as VisualSearchMatch[];
    const decorationRanges = visualMatches.map((m) => {
      if (m.kind === 'text') return { from: m.from, to: m.to, isNode: false };
      return { from: m.pos, to: m.pos + m.nodeSize, isNode: true };
    });

    setSearchHighlights(editor.view, {
      matches: decorationRanges,
      currentIndex: searchCurrentIndex,
      query: searchQuery,
    });
  }, [editor, searchMatches, searchCurrentIndex, searchOpen, searchQuery, sourceMode]);

  // Sync decorations whenever matches or current index change
  useEffect(() => {
    applySearchDecorations();
  }, [applySearchDecorations]);

  // Clear decorations when search closes
  useEffect(() => {
    if (!searchOpen && editor) {
      clearSearchHighlights(editor.view);
    }
  }, [searchOpen, editor]);

  const scrollToVisualMatch = useCallback(
    (match: VisualSearchMatch) => {
      if (!editor) return;

      const { state, view } = editor;
      const pos = match.kind === 'text' ? match.from : match.pos;

      // Set the selection (for visual cursor placement)
      let tr = state.tr;
      if (match.kind === 'text') {
        tr = tr.setSelection(TextSelection.create(state.doc, match.from, match.to));
      } else {
        tr = tr.setSelection(NodeSelection.create(state.doc, match.pos));
        window.dispatchEvent(
          new CustomEvent('markdown-editor:focus-math-search-match', {
            detail: { pos: match.pos, start: match.start, end: match.end },
          }),
        );
      }
      view.dispatch(tr);

      // Scroll to the match position using the DOM, which is more reliable
      // than tr.scrollIntoView() when the editor doesn't have focus.
      requestAnimationFrame(() => {
        try {
          const resolved = view.domAtPos(Math.min(pos, state.doc.content.size));
          const node = resolved.node;
          const element = node.nodeType === Node.TEXT_NODE
            ? node.parentElement
            : node as HTMLElement;
          element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch { /* ignore scroll failures */ }
      });
    },
    [editor],
  );

  const revealVisualMatch = useCallback(
    (match: VisualSearchMatch, focusEditor = true) => {
      if (!editor) return;
      if (focusEditor) {
        selectVisualSearchMatch(editor, match, true);
        return;
      }
      // When focusEditor is false, just scroll — decorations handle the highlight
      scrollToVisualMatch(match);
    },
    [editor, scrollToVisualMatch],
  );

  const jumpToSearchMatch = useCallback(
    (nextIndex: number, focusEditor = true) => {
      if (!searchMatches.length) {
        setSearchCurrentIndex(0);
        return;
      }

      const normalized =
        ((nextIndex % searchMatches.length) + searchMatches.length) % searchMatches.length;
      setSearchCurrentIndex(normalized);

      // Immediately update decorations with new current index
      if (!sourceMode && editor) {
        const visualMatches = searchMatches as VisualSearchMatch[];
        const decorationRanges = visualMatches.map((m) => {
          if (m.kind === 'text') return { from: m.from, to: m.to, isNode: false };
          return { from: m.pos, to: m.pos + m.nodeSize, isNode: true };
        });
        setSearchHighlights(editor.view, {
          matches: decorationRanges,
          currentIndex: normalized,
          query: searchQuery,
        });
      }

      const match = searchMatches[normalized];
      if (sourceMode) {
        revealSourceMatch(match as SourceSearchMatch, focusEditor);
      } else {
        revealVisualMatch(match as VisualSearchMatch, focusEditor);
      }
    },
    [revealSourceMatch, revealVisualMatch, searchMatches, searchQuery, sourceMode, editor],
  );

  const getSelectedSearchText = useCallback(() => {
    if (sourceModeRef.current) {
      const input = sourceTextareaRef.current;
      if (!input) {
        return '';
      }

      const selected = input.value.slice(input.selectionStart, input.selectionEnd);
      return normalizeSearchSeedText(selected);
    }

    if (!editor) {
      return '';
    }

    const { from, to, empty } = editor.state.selection;
    if (empty) {
      return '';
    }

    return normalizeSearchSeedText(editor.state.doc.textBetween(from, to, '\n', '\n'));
  }, [editor]);

  const openSearchPanel = useCallback(
    (showReplace = false) => {
      const selectedText = getSelectedSearchText();
      setSearchOpen(true);
      setSearchReplaceVisible((current) => current || showReplace);
      if (selectedText) {
        setSearchQuery(selectedText);
      }

      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    },
    [getSelectedSearchText],
  );

  const closeSearchPanel = useCallback(() => {
    setSearchOpen(false);
    searchAutoRevealSignatureRef.current = '';
  }, []);

  const handleReplaceCurrent = useCallback(() => {
    if (!searchMatches.length || !searchQuery) {
      return;
    }

    const match = searchMatches[searchCurrentIndex];
    if (sourceMode) {
      const result = replaceSourceSearchMatch(
        sourceDraftRef.current,
        match as SourceSearchMatch,
        searchReplacement,
      );
      applySourceMarkdown(result.markdown, result.selection);
      return;
    }

    if (!editor) {
      return;
    }

    const replaced = replaceVisualSearchMatch(editor, match as VisualSearchMatch, searchReplacement);
    if (!replaced) {
      return;
    }

    flushVisualSync(editor);
    setVisualSearchRevision((current) => current + 1);
  }, [
    applySourceMarkdown,
    editor,
    searchCurrentIndex,
    searchMatches,
    searchQuery,
    searchReplacement,
    sourceMode,
  ]);

  const handleReplaceAll = useCallback(() => {
    if (!searchQuery) {
      return;
    }

    if (sourceMode) {
      const result = replaceAllSourceSearchMatches(
        sourceDraftRef.current,
        searchQuery,
        searchReplacement,
        {
          caseSensitive: searchCaseSensitive,
        },
      );

      if (!result.count) {
        return;
      }

      applySourceMarkdown(result.markdown, result.firstSelection ?? undefined);
      return;
    }

    if (!editor) {
      return;
    }

    const replacedCount = replaceAllVisualSearchMatches(editor, searchQuery, searchReplacement, {
      caseSensitive: searchCaseSensitive,
    });
    if (!replacedCount) {
      return;
    }

    flushVisualSync(editor);
    setVisualSearchRevision((current) => current + 1);
  }, [
    applySourceMarkdown,
    editor,
    searchCaseSensitive,
    searchQuery,
    searchReplacement,
    sourceMode,
  ]);

  useEffect(() => {
    if (!searchOpen) {
      return;
    }

    if (!searchMatches.length) {
      setSearchCurrentIndex(0);
      return;
    }

    setSearchCurrentIndex((current) => Math.min(current, searchMatches.length - 1));
  }, [searchMatches.length, searchOpen]);

  useEffect(() => {
    if (!searchOpen || !searchQuery) {
      searchAutoRevealSignatureRef.current = '';
      return;
    }

    const signature = `${sourceMode ? 'source' : 'visual'}:${searchCaseSensitive}:${searchQuery}`;
    if (searchAutoRevealSignatureRef.current === signature) {
      return;
    }

    searchAutoRevealSignatureRef.current = signature;
    // Don't steal focus during incremental search — the user is still typing
    jumpToSearchMatch(0, false);
  }, [jumpToSearchMatch, searchCaseSensitive, searchMatches.length, searchOpen, searchQuery, sourceMode]);

  const searchPanel = (
    <SearchPanel
      caseSensitive={searchCaseSensitive}
      currentMatchLabel={
        searchQuery
          ? `${searchMatches.length ? searchCurrentIndex + 1 : 0}/${searchMatches.length}`
          : translate('inputKeyword')
      }
      onCaseSensitiveChange={() => setSearchCaseSensitive((current) => !current)}
      onClose={closeSearchPanel}
      onNext={() => jumpToSearchMatch(searchCurrentIndex + 1, false)}
      onPrevious={() => jumpToSearchMatch(searchCurrentIndex - 1, false)}
      onQueryChange={(event) => setSearchQuery(event.target.value)}
      onReplaceAll={handleReplaceAll}
      onReplaceCurrent={handleReplaceCurrent}
      onReplacementChange={(event) => setSearchReplacement(event.target.value)}
      onToggleReplace={() => {
        setSearchReplaceVisible((current) => !current);
        requestAnimationFrame(() => {
          if (searchReplaceVisible) {
            searchInputRef.current?.focus();
            return;
          }

          replaceInputRef.current?.focus();
          replaceInputRef.current?.select();
        });
      }}
      open={searchOpen}
      query={searchQuery}
      queryInputRef={searchInputRef}
      replaceInputRef={replaceInputRef}
      replacement={searchReplacement}
      replaceVisible={searchReplaceVisible}
    />
  );

  const toggleSourceModePreservingViewport = useCallback(() => {
    captureModeSwitchScrollRatio();
    setSourceMode((current) => {
      if (!current) {
        pendingVisualSelectionRestoreRef.current = false;
        if (editor) {
          const hadVisualEdits = visualDocEditedRef.current;
          const flushed = flushVisualSync(editor);
          // Marker pass is only used for caret mapping. Content prefers the
          // canonical flushed string so we do not rewrite unedited documents.
          const sourceState = buildSourceDraftFromVisualSelection(editor);
          const markdown = flushed?.markdown ?? sourceState.markdown;
          const selection = clampSourceSelection(
            !hadVisualEdits && sourceState.markdown !== markdown
              ? { start: markdown.length, end: markdown.length }
              : sourceState.selection,
            markdown,
          );
          pendingSourceSelectionRef.current = selection;
          sourceSelectionRef.current = selection;
          setSourceDraft(markdown);
          sourceDraftRef.current = markdown;
          const stats = computeSourceStats(markdown);
          setLiveStats((currentStats) => (areStatsEqual(currentStats, stats) ? currentStats : stats));
          queueSourcePreview(markdown, selection);
          return true;
        }

        const fallbackMarkdown = documentMarkdownRef.current;
        pendingSourceSelectionRef.current = {
          start: fallbackMarkdown.length,
          end: fallbackMarkdown.length,
        };
        sourceSelectionRef.current = pendingSourceSelectionRef.current;
        setSourceDraft(fallbackMarkdown);
        sourceDraftRef.current = fallbackMarkdown;
        const stats = computeSourceStats(fallbackMarkdown);
        setLiveStats((currentStats) => (areStatsEqual(currentStats, stats) ? currentStats : stats));
        return true;
      }

      if (editor) {
        const input = sourceTextareaRef.current;
        const markdown = sourceDraftRef.current;
        const selection = clampSourceSelection(
          {
            start: input?.selectionStart ?? sourceSelectionRef.current.start,
            end: input?.selectionEnd ?? sourceSelectionRef.current.end,
          },
          markdown,
        );
        sourceSelectionRef.current = selection;

        const cachedPreview = sourcePreviewCacheRef.current;
        const cacheHit =
          cachedPreview &&
          cachedPreview.markdown === markdown &&
          isSameSourceSelection(cachedPreview.selection, selection);

        // Always apply content. The previous cache-hit path skipped setContent,
        // leaving the visual editor on stale document content after source edits.
        const markedContent = cacheHit
          ? cachedPreview.content
          : parseMarkdown(
              insertSelectionMarkersIntoMarkdown(markdown, selection.start, selection.end),
            );

        externalUpdateRef.current = true;
        armSkipNextDocChange();
        visualDocEditedRef.current = false;
        replaceEditorContent(editor, markedContent);
        externalUpdateRef.current = false;

        pendingVisualSelectionRestoreRef.current = true;
        const stats = computeSourceStats(markdown);
        onDocumentChange(markdown, stats);
        onDocumentMetaChange(markdown !== document.savedMarkdown);
        visualMarkdownRef.current = markdown;
        visualStatsRef.current = stats;
        lastEmittedMarkdownRef.current = markdown;
        setLiveStats((currentStats) => (areStatsEqual(currentStats, stats) ? currentStats : stats));
        setLiveDirty(markdown !== document.savedMarkdown);
        const nextOutline = extractOutline(markdown);
        setOutline((currentOutline) =>
          areOutlinesEqual(currentOutline, nextOutline) ? currentOutline : nextOutline,
        );
        setVisualSearchRevision((currentRevision) => currentRevision + 1);
      }

      return false;
    });
  }, [
    armSkipNextDocChange,
    buildSourceDraftFromVisualSelection,
    captureModeSwitchScrollRatio,
    document.savedMarkdown,
    editor,
    onDocumentChange,
    onDocumentMetaChange,
    queueSourcePreview,
  ]);

  const toggleSourceModeWithTransition = useCallback(() => {
    if (modeSwitchOverlayTimerRef.current !== null) {
      window.clearTimeout(modeSwitchOverlayTimerRef.current);
      modeSwitchOverlayTimerRef.current = null;
    }

    setModeSwitching(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        toggleSourceModePreservingViewport();
        modeSwitchOverlayTimerRef.current = window.setTimeout(() => {
          setModeSwitching(false);
          modeSwitchOverlayTimerRef.current = null;
        }, 420);
      });
    });
  }, [toggleSourceModePreservingViewport]);

  const jumpSourceToOffset = useCallback((start: number, end = start) => {
    const input = sourceTextareaRef.current;
    const markdown = sourceDraftRef.current;
    const safeStart = Math.max(0, Math.min(start, markdown.length));
    const safeEnd = Math.max(safeStart, Math.min(end, markdown.length));
    sourceSelectionRef.current = { start: safeStart, end: safeEnd };

    requestAnimationFrame(() => {
      if (!input) {
        return;
      }
      input.focus();
      input.setSelectionRange(safeStart, safeEnd);
      const ratio = markdown.length > 0 ? safeStart / markdown.length : 0;
      const maxScroll = Math.max(input.scrollHeight - input.clientHeight, 0);
      input.scrollTop = Math.max(0, maxScroll * ratio - input.clientHeight * 0.25);
    });
  }, []);

  const handleGoToLine = useCallback(() => {
    if (!sourceModeRef.current) {
      return;
    }
    gotoLineDefaultRef.current = sourceModeRef.current ? String(sourceCursor.line || 1) : '1';
    setGotoLineOpen(true);
  }, [sourceCursor.line]);

  const jumpToLineNumber = useCallback((raw: string) => {
    const targetLine = Math.max(1, Number.parseInt(raw, 10) || 1);
    if (!sourceModeRef.current) {
      return;
    }

    const markdown = sourceDraftRef.current;
    let offset = 0;
    let current = 1;
    for (const part of markdown.split('\n')) {
      if (current === targetLine) {
        jumpSourceToOffset(offset, offset + part.length);
        return;
      }
      offset += part.length + 1;
      current += 1;
    }
    jumpSourceToOffset(Math.max(0, markdown.length));
  }, [jumpSourceToOffset]);

  const submitGoToLine = useCallback((line: number) => {
    setGotoLineOpen(false);
    jumpToLineNumber(String(line));
  }, [jumpToLineNumber]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      const activeElement = window.document.activeElement;
      const activeInSearchPanel =
        activeElement instanceof HTMLElement &&
        Boolean(activeElement.closest('.search-panel'));
      const activeInEditorSurface =
        activeElement instanceof HTMLElement &&
        (Boolean(activeElement.closest('.ProseMirror')) ||
          Boolean(activeElement.closest('.editor-source')) ||
          Boolean(activeElement.closest('.source-editor')));
      const activeInEmbeddedInput =
        activeElement instanceof HTMLInputElement ||
        (activeElement instanceof HTMLTextAreaElement &&
          !activeElement.classList.contains('editor-source') &&
          !activeElement.classList.contains('source-editor__input'));

      if (
        searchOpen &&
        event.key === 'Enter' &&
        activeInEditorSurface &&
        !activeInSearchPanel &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        jumpToSearchMatch(searchCurrentIndex + (event.shiftKey ? -1 : 1));
        return;
      }

      if ((event.ctrlKey || event.metaKey) && key === 'f') {
        event.preventDefault();
        openSearchPanel(false);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && key === 'a' && activeInEditorSurface) {
        if (activeInEmbeddedInput) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        if (sourceModeRef.current) {
          const input = sourceTextareaRef.current;
          if (!input) {
            return;
          }

          input.focus();
          input.setSelectionRange(0, input.value.length);
          return;
        }

        editor?.chain().focus().selectAll().run();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && key === 'h') {
        event.preventDefault();
        openSearchPanel(true);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && key === 'g') {
        event.preventDefault();
        handleGoToLine();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.altKey && event.shiftKey && key === 'v') {
        event.preventDefault();
        void window.markdownEditor.exportClipboardDebug().then((exportedPath) => {
          window.alert(
            exportedPath
              ? translate('clipboardDebugExported', { path: exportedPath })
              : translate('noClipboardContent'),
          );
        });
        return;
      }

      if ((event.ctrlKey || event.metaKey) && key === 's') {
        event.preventDefault();
        const visualState = sourceModeRef.current ? null : flushVisualSync();
        if (event.shiftKey) {
          onSaveDocumentAs(
            sourceModeRef.current ? sourceDraftRef.current : visualState?.markdown,
            sourceModeRef.current ? computeSourceStats(sourceDraftRef.current) : visualState?.stats,
          );
        } else {
          onSaveDocument(
            sourceModeRef.current ? sourceDraftRef.current : visualState?.markdown,
            sourceModeRef.current ? computeSourceStats(sourceDraftRef.current) : visualState?.stats,
          );
        }
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'e') {
        event.preventDefault();
        toggleSourceModeWithTransition();
        return;
      }

      if (
        event.key === 'Escape' &&
        searchOpen &&
        activeInSearchPanel
      ) {
        event.preventDefault();
        closeSearchPanel();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'b') {
        event.preventDefault();
        setToolbarVisible((current) => !current);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && key === '\\') {
        event.preventDefault();
        setSidebarVisible((current) => !current);
      }
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [
    closeSearchPanel,
    editor,
    handleGoToLine,
    jumpToSearchMatch,
    onSaveDocument,
    onSaveDocumentAs,
    openSearchPanel,
    searchCurrentIndex,
    searchOpen,
    toggleSourceModeWithTransition,
  ]);

  const externalChangePromptRef = useRef(false);
  const closePromptHandlingRef = useRef(false);

  useEffect(() => {
    return window.markdownEditor.onExternalFileChange((event) => {
      // Single-flight: never stack multiple prompts for the same burst.
      if (
        externalChangePromptRef.current ||
        closePromptHandlingRef.current ||
        appDialogRef.current
      ) {
        void window.markdownEditor.acknowledgeExternalFileChange({
          path: event.path,
          dismissed: true,
        });
        return;
      }

      externalChangePromptRef.current = true;

      if (event.kind === 'deleted') {
        openAppDialog({
          title: translate('fileDeleted'),
          message: translate('fileDeletedMessage', { title: event.title }),
          detail: translate('fileDeletedDetail'),
          buttons: [
            { value: 'save-as', label: translate('saveAs'), variant: 'primary' },
            { value: 'dismiss', label: translate('ignore') },
          ],
          cancelValue: 'dismiss',
          onResolve: (action) => {
            void (async () => {
              try {
                if (action !== 'save-as') {
                  void window.markdownEditor.acknowledgeExternalFileChange({
                    path: event.path,
                    dismissed: true,
                  });
                  return;
                }

                const visualState = sourceModeRef.current ? null : flushVisualSync();
                const saved = await onSaveDocumentAs(
                  sourceModeRef.current ? sourceDraftRef.current : visualState?.markdown,
                  sourceModeRef.current
                    ? computeSourceStats(sourceDraftRef.current)
                    : visualState?.stats,
                );
                void window.markdownEditor.acknowledgeExternalFileChange({
                  path: event.path,
                  dismissed: !saved,
                });
              } finally {
                externalChangePromptRef.current = false;
              }
            })();
          },
        });
        return;
      }

      openAppDialog({
        title: translate('fileModified'),
        message: translate('fileModifiedMessage', { title: event.title }),
        detail: translate('fileModifiedDetail'),
        buttons: [
          { value: 'reload', label: translate('reload'), variant: 'primary' },
          { value: 'dismiss', label: translate('ignore') },
        ],
        cancelValue: 'dismiss',
        onResolve: (action) => {
          void (async () => {
            try {
              if (action !== 'reload') {
                void window.markdownEditor.acknowledgeExternalFileChange({
                  path: event.path,
                  dismissed: true,
                });
                return;
              }

              // Apply the reloaded document into React state (IPC-only open was a no-op).
              await onReloadDocumentPath(event.path);
              void window.markdownEditor.acknowledgeExternalFileChange({
                path: event.path,
                reloaded: true,
              });
            } finally {
              externalChangePromptRef.current = false;
            }
          })();
        },
      });
    });
  }, [onReloadDocumentPath, onSaveDocumentAs, openAppDialog]);

  useEffect(() => {
    return window.markdownEditor.onRequestSaveBeforeClose(() => {
      if (
        appDialogRef.current ||
        externalChangePromptRef.current ||
        closePromptHandlingRef.current
      ) {
        window.markdownEditor.respondSaveBeforeClose(false);
        return;
      }

      closePromptHandlingRef.current = true;
      openAppDialog({
        title: translate('unsavedChanges'),
        message: translate('unsavedMessage'),
        detail: translate('unsavedDetail'),
        buttons: [
          { value: 'save', label: translate('saveAndClose'), variant: 'primary' },
          { value: 'discard', label: translate('discard') },
          { value: 'cancel', label: translate('cancel') },
        ],
        cancelValue: 'cancel',
        onResolve: (action) => {
          void (async () => {
            try {
              if (action === 'cancel') {
                window.markdownEditor.respondSaveBeforeClose(false);
                return;
              }

              if (action === 'discard') {
                window.markdownEditor.respondSaveBeforeClose(true);
                return;
              }

              const visualState = sourceModeRef.current ? null : flushVisualSync();
              const saved = await onSaveDocument(
                sourceModeRef.current ? sourceDraftRef.current : visualState?.markdown,
                sourceModeRef.current
                  ? computeSourceStats(sourceDraftRef.current)
                  : visualState?.stats,
              );
              window.markdownEditor.respondSaveBeforeClose(Boolean(saved));
            } finally {
              closePromptHandlingRef.current = false;
            }
          })();
        },
      });
    });
  }, [onSaveDocument, openAppDialog]);

  const getExportPayload = useCallback(() => {
    const visualState = sourceModeRef.current ? null : flushVisualSync();
    const markdown = sourceModeRef.current
      ? sourceDraftRef.current
      : visualState?.markdown ?? documentMarkdownRef.current;

    return {
      markdown,
      title: document.title,
      documentPath: documentPathRef.current,
    };
  }, [document.title]);

  useEffect(() => {
    const offPandoc = window.markdownEditor.onExportPandocRequest((format, options) => {
      void window.markdownEditor.exportWithPandoc(getExportPayload(), format, options);
    });
    return offPandoc;
  }, [getExportPayload]);

  useEffect(() => {
    const handler = (event: Event) => {
      const menuEvent = event as CustomEvent<
        | 'save-document'
        | 'save-document-as'
        | 'toggle-source-mode'
        | 'toggle-toolbar'
        | 'toggle-sidebar'
        | 'export-pdf'
        | 'export-image'
        | 'export-pandoc'
      >;
      if (menuEvent.detail === 'save-document') {
        const visualState = sourceModeRef.current ? null : flushVisualSync();
        void onSaveDocument(
          sourceModeRef.current ? sourceDraftRef.current : visualState?.markdown,
          sourceModeRef.current ? computeSourceStats(sourceDraftRef.current) : visualState?.stats,
        );
        return;
      }

      if (menuEvent.detail === 'save-document-as') {
        const visualState = sourceModeRef.current ? null : flushVisualSync();
        void onSaveDocumentAs(
          sourceModeRef.current ? sourceDraftRef.current : visualState?.markdown,
          sourceModeRef.current ? computeSourceStats(sourceDraftRef.current) : visualState?.stats,
        );
        return;
      }

      if (menuEvent.detail === 'export-pdf') {
        void window.markdownEditor.exportAsPdf(getExportPayload());
        return;
      }

      if (menuEvent.detail === 'export-image') {
        void window.markdownEditor.exportAsImage(getExportPayload());
        return;
      }

      if (menuEvent.detail === 'toggle-source-mode') {
        toggleSourceModeWithTransition();
        return;
      }

      if (menuEvent.detail === 'toggle-toolbar') {
        setToolbarVisible((current) => !current);
        return;
      }

      if (menuEvent.detail === 'toggle-sidebar') {
        setSidebarVisible((current) => !current);
      }
    };

    window.addEventListener('markdown-editor:menu-action', handler as EventListener);
    return () => {
      window.removeEventListener('markdown-editor:menu-action', handler as EventListener);
    };
  }, [getExportPayload, onSaveDocument, onSaveDocumentAs, toggleSourceModeWithTransition]);

  const handleFrameMouseDown = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (sourceMode) {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          sourceTextareaRef.current?.focus();
          const target = sourceTextareaRef.current;
          if (target) {
            const caret = target.value.length;
            target.setSelectionRange(caret, caret);
          }
        }
        return;
      }

      const editorSurface = editorHostRef.current?.querySelector('.ProseMirror');

      if (
        event.target === event.currentTarget ||
        event.target === editorHostRef.current ||
        event.target === editorSurface
      ) {
        event.preventDefault();
        if (editor) {
          const coords = editor.view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          });
          if (coords) {
            const resolved = editor.state.doc.resolve(coords.pos);
            const selection = resolved.parent.isTextblock
              ? TextSelection.create(editor.state.doc, coords.pos)
              : TextSelection.near(resolved);
            editor.view.dispatch(editor.state.tr.setSelection(selection));
            editor.commands.focus();
          } else {
            const frameRect = editorFrameRef.current?.getBoundingClientRect();
            if (frameRect && event.clientY > frameRect.top + frameRect.height / 2) {
              focusWritableDocumentEnd(editor);
            } else {
              editor.chain().focus('start').run();
            }
          }
        }
      }
    },
    [editor, sourceMode],
  );

  const handleSourceChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const selection = {
        start: event.target.selectionStart ?? event.target.value.length,
        end: event.target.selectionEnd ?? event.target.value.length,
      };
      sourceSelectionRef.current = selection;
      applySourceMarkdown(event.target.value);
      queueSourcePreview(event.target.value, selection);
    },
    [applySourceMarkdown, queueSourcePreview],
  );

  const handleSourceSelect = useCallback(
    (event: SyntheticEvent<HTMLTextAreaElement>) => {
      const target = event.currentTarget;
      const selection = {
        start: target.selectionStart ?? target.value.length,
        end: target.selectionEnd ?? target.value.length,
      };
      sourceSelectionRef.current = selection;
      queueSourcePreview(target.value, selection);
    },
    [queueSourcePreview],
  );

  const handleSourceCursorChange = useCallback((info: SourceCursorInfo) => {
    setSourceCursor((current) =>
      current.line === info.line &&
      current.column === info.column &&
      current.start === info.start &&
      current.end === info.end
        ? current
        : info,
    );
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleToolbarSave = useCallback(() => {
    const visualState = sourceModeRef.current ? null : flushVisualSync();
    void onSaveDocument(
      sourceModeRef.current ? sourceDraftRef.current : visualState?.markdown,
      sourceModeRef.current ? computeSourceStats(sourceDraftRef.current) : visualState?.stats,
    );
  }, [document.savedMarkdown, onSaveDocument, editor]);

  const handleToolbarSaveAs = useCallback(() => {
    const visualState = sourceModeRef.current ? null : flushVisualSync();
    void onSaveDocumentAs(
      sourceModeRef.current ? sourceDraftRef.current : visualState?.markdown,
      sourceModeRef.current ? computeSourceStats(sourceDraftRef.current) : visualState?.stats,
    );
  }, [document.savedMarkdown, onSaveDocumentAs, editor]);

  const handleExportPdf = useCallback(() => {
    void window.markdownEditor.exportAsPdf(getExportPayload());
  }, [getExportPayload]);

  const handleExportImage = useCallback(() => {
    void window.markdownEditor.exportAsImage(getExportPayload());
  }, [getExportPayload]);

  const handleExportPandoc = useCallback(
    (format: Parameters<typeof window.markdownEditor.exportWithPandoc>[1]) => {
      void window.markdownEditor.exportWithPandoc(getExportPayload(), format);
    },
    [getExportPayload],
  );

  const handleInsertImage = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleSourceContextMenu = useCallback(
    (event: React.MouseEvent<HTMLTextAreaElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const textarea = event.currentTarget;
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        items: buildSourceContextMenu({
          textarea,
          onFind: () => openSearchPanel(false),
          onFindReplace: () => openSearchPanel(true),
          onGoToLine: handleGoToLine,
          onToggleVisual: () => toggleSourceModeWithTransition(),
        }),
      });
    },
    [handleGoToLine, openSearchPanel, toggleSourceModeWithTransition],
  );

  const handleVisualContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea:not(.source-editor__input), select, .search-panel, .toolbar, .sidebar')) {
        return;
      }

      if (!editor) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        items: buildVisualContextMenu({
          editor,
          onFind: () => openSearchPanel(false),
          onFindReplace: () => openSearchPanel(true),
          onInsertImage: handleInsertImage,
          onToggleSource: () => toggleSourceModeWithTransition(),
        }),
      });
    },
    [editor, handleInsertImage, openSearchPanel, toggleSourceModeWithTransition],
  );

  const handleToggleSidebar = useCallback(() => {
    setSidebarVisible((current) => !current);
  }, []);

  const handleToggleToolbar = useCallback(() => {
    setToolbarVisible((current) => !current);
  }, []);

  const handleToggleSourceMode = useCallback(() => {
    toggleSourceModeWithTransition();
  }, [toggleSourceModeWithTransition]);

  const handleNavigateOutline = useCallback(
    (index: number) => {
      setSidebarTab('outline');

      if (sourceModeRef.current) {
        const markdown = sourceDraftRef.current;
        const items = extractOutline(markdown);
        const item = items[index];
        if (!item) {
          return;
        }
        // item.start is the absolute start of the heading line (including any
        // CommonMark leading spaces). End at the true line end so we never
        // overshoot into the next line.
        const lineStart = item.start >= 0 ? item.start : 0;
        let lineEnd = lineStart;
        while (lineEnd < markdown.length && markdown[lineEnd] !== '\n' && markdown[lineEnd] !== '\r') {
          lineEnd += 1;
        }
        jumpSourceToOffset(lineStart, lineEnd);
        return;
      }

      const target = editorHostRef.current?.querySelector(
        `[data-outline-index="${index}"]`,
      ) as HTMLElement | null;
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      // Fallback: jump by heading node position from live outline.
      if (editor && outline[index]?.start != null && outline[index].start >= 0) {
        try {
          const pos = outline[index].start;
          const selection = TextSelection.create(editor.state.doc, pos + 1);
          editor.view.dispatch(editor.state.tr.setSelection(selection).scrollIntoView());
          editor.view.focus();
        } catch {
          // ignore invalid positions
        }
      }
    },
    [editor, jumpSourceToOffset, outline],
  );

  return (
    <div className="app-shell" data-theme={resolvedTheme} data-color-scheme={themePalette}>
      <Toolbar
        editor={editor}
        onInsertImage={handleInsertImage}
        onNewWindow={onCreateDocument}
        onOpen={onOpenDocument}
        onOpenFolder={onOpenFolder}
        onOpenSearch={openSearchPanel}
        onCloseSearch={closeSearchPanel}
        onSave={handleToolbarSave}
        onSaveAs={handleToolbarSaveAs}
        searchVisible={searchOpen}
        onToggleSidebar={handleToggleSidebar}
        onToggleSourceMode={handleToggleSourceMode}
        onToggleToolbar={handleToggleToolbar}
        sidebarVisible={sidebarVisible}
        sourceMode={sourceMode}
        theme={theme}
        themePalette={themePalette}
        glassEffect={glassEffect}
        toolbarVisible={toolbarVisible}
        onExportPdf={handleExportPdf}
        onExportImage={handleExportImage}
        onExportPandoc={handleExportPandoc}
        onSetTheme={onSetTheme}
        onSetThemePalette={onSetThemePalette}
        onSetGlassEffect={onSetGlassEffect}
        onOpenSettings={onOpenSettings}
      />

      <main className={sidebarVisible ? 'workspace workspace--with-sidebar' : 'workspace workspace--with-sidebar is-sidebar-collapsed'}>
        <Sidebar
          currentFilePath={document.path}
          folderEntries={folder?.entries ?? []}
          folderPath={folder?.path ?? null}
          onNavigateOutline={handleNavigateOutline}
          onOpenFile={(filePath) => onOpenDocumentPath(filePath)}
          onOpenFolder={onOpenFolder}
          onSelectTab={setSidebarTab}
          outline={outline}
          tab={sidebarTab}
          visible={sidebarVisible}
        />

        <EditorViewport
          editor={editor}
          editorFrameRef={editorFrameRef}
          editorHostRef={editorHostRef}
          loading={loadingExternalDocument}
          modeSwitching={modeSwitching}
          onFrameMouseDown={handleFrameMouseDown}
          onSourceChange={handleSourceChange}
          onSourceSelect={handleSourceSelect}
          onSourceCursorChange={handleSourceCursorChange}
          onSourceContextMenu={handleSourceContextMenu}
          onVisualContextMenu={handleVisualContextMenu}
          searchPanel={searchPanel}
          sourceDraft={sourceDraft}
          sourceMode={sourceMode}
          sourceTextareaRef={sourceTextareaRef}
        />
      </main>

      <StatusBar
        dirty={liveDirty}
        lastSavedAt={document.lastSavedAt}
        stats={liveStats}
        title={document.title}
        sourceMode={sourceMode}
        sourceCursor={sourceMode ? sourceCursor : null}
      />

      <ContextMenu menu={contextMenu} onClose={closeContextMenu} />

      {gotoLineOpen ? (
        <GoToLineDialog
          defaultValue={gotoLineDefaultRef.current}
          onCancel={() => setGotoLineOpen(false)}
          onSubmit={submitGoToLine}
        />
      ) : null}

      {appDialog ? (
        <AppDialog
          buttons={appDialog.buttons}
          cancelValue={appDialog.cancelValue}
          detail={appDialog.detail}
          message={appDialog.message}
          onResolve={resolveAppDialog}
          title={appDialog.title}
        />
      ) : null}

      {imageActionMenu ? (
        <ImageActionMenu
          currentPathAvailable={Boolean(document.path)}
          onClose={closeImageActionMenu}
          onCopyToCurrent={() => void copyImageToCurrent()}
          onCopyToOther={() => void copyImageToOther()}
          onKeepOriginal={() => void keepOriginalPath()}
          originalPathAvailable={Boolean(imageActionMenu.sourcePath)}
          x={imageActionMenuPos.x}
          y={imageActionMenuPos.y}
        />
      ) : null}

      <input
        accept="image/*"
        className="sr-only"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) {
            return;
          }

          const sourcePath = getImageSourcePath(file);
          const base64 = await fileToBase64(file);
          const saved = await window.markdownEditor.saveImage({
            base64,
            suggestedName: file.name,
            currentPath: documentPathRef.current,
            destination: 'default',
            sourcePath,
          });

          if (sourceMode) {
            const insertion = `![${file.name}](${saved.markdownPath})`;
            const currentValue = sourceDraft;
            const input = sourceTextareaRef.current;
            const start = input?.selectionStart ?? currentValue.length;
            const end = input?.selectionEnd ?? currentValue.length;
            const markdown = `${currentValue.slice(0, start)}${insertion}${currentValue.slice(end)}`;
            applySourceMarkdown(markdown, {
              start: start + insertion.length,
              end: start + insertion.length,
            });
            event.target.value = '';
            return;
          }

          if (!editor) {
            return;
          }

          editor.chain().focus().setImage({ src: saved.markdownPath, alt: '', title: undefined }).run();

          let imagePos: number | null = null;
          editor.state.doc.descendants((node, pos) => {
            if (node.type.name === 'image' && node.attrs.src === saved.markdownPath) {
              imagePos = pos;
              return false;
            }
            return true;
          });

          if (imagePos != null) {
            const imageNode = editor.state.doc.nodeAt(imagePos);
            if (imageNode) {
              let after = imagePos + imageNode.nodeSize;
              let transaction = editor.state.tr.setMeta('addToHistory', false);
              let insertedParagraph = false;
              if (after >= editor.state.doc.content.size) {
                const paragraph = editor.state.schema.nodes.paragraph?.create();
                if (paragraph) {
                  transaction = transaction.insert(after, paragraph);
                  insertedParagraph = true;
                }
              }
              const caret = Math.min(
                after + (insertedParagraph ? 1 : 0),
                transaction.doc.content.size,
              );
              transaction.setSelection(TextSelection.near(transaction.doc.resolve(caret)));
              editor.view.dispatch(transaction.scrollIntoView());
              editor.view.focus();
            }
          }

          showImageActionMenu({
            src: saved.markdownPath,
            absolutePath: saved.absolutePath,
            sourcePath,
            pos: imagePos,
          });
          event.target.value = '';
        }}
        ref={fileInputRef}
        type="file"
      />
    </div>
  );
}

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
import type { OpenedFolder, ThemeMode } from '@shared/contracts';
import type { DocumentStats, EditorDocumentState } from '../App';
import type { ThemePalette } from '../theme';
import Toolbar from './Toolbar';
import StatusBar from './StatusBar';
import Sidebar from './Sidebar';
import { createEditorExtensions } from '../editor/create-editor-extensions';
import { parseMarkdown, serializeMarkdown, serializeMarkdownFragment } from '../editor/markdown';
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
import { calculateDocumentStats, fileToBase64 } from '../editor/utils/helpers';
import { extractOutline, type OutlineItem } from '../utils/document';

interface EditorShellProps {
  document: EditorDocumentState;
  folder: OpenedFolder | null;
  theme: ThemeMode;
  themePalette: ThemePalette;
  resolvedTheme: 'light' | 'dark';
  onDocumentChange: (markdown: string, stats: DocumentStats) => void;
  onDocumentMetaChange: (dirty: boolean) => void;
  onOpenDocument: () => void;
  onOpenDocumentPath: (filePath: string) => void;
  onOpenFolder: () => void;
  onSaveDocument: (markdown?: string, stats?: DocumentStats) => Promise<boolean> | boolean;
  onSaveDocumentAs: (markdown?: string, stats?: DocumentStats) => Promise<boolean> | boolean;
  onCreateDocument: () => void;
  onSetTheme: (theme: ThemeMode) => void;
  onSetThemePalette: (palette: ThemePalette) => void;
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

  editor.state.doc.descendants((node, position) => {
    if (node.type.name !== 'heading') {
      return true;
    }

    const text = node.textContent.trim();
    if (!text) {
      return true;
    }

    items.push({
      id: `heading-${position}-${items.length}`,
      level: Number(node.attrs.level ?? 1),
      text,
    });

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

function insertSelectionMarkersIntoMarkdown(markdown: string, start: number, end: number): string {
  const selectionStart = Math.max(0, Math.min(start, markdown.length));
  const selectionEnd = Math.max(selectionStart, Math.min(end, markdown.length));

  return `${markdown.slice(0, selectionStart)}${SELECTION_START_MARKER}${markdown.slice(
    selectionStart,
    selectionEnd,
  )}${SELECTION_END_MARKER}${markdown.slice(selectionEnd)}`;
}

function extractSelectionMarkersFromMarkdown(markdown: string): {
  markdown: string;
  selection: SourceSearchMatch;
} {
  const startIndex = markdown.indexOf(SELECTION_START_MARKER);
  const endIndex = markdown.indexOf(SELECTION_END_MARKER);
  const withoutStart = markdown.replace(SELECTION_START_MARKER, '');
  const normalizedEndIndex =
    endIndex === -1
      ? startIndex === -1
        ? 0
        : startIndex
      : endIndex - (startIndex !== -1 && startIndex < endIndex ? SELECTION_START_MARKER.length : 0);
  const cleanMarkdown = withoutStart.replace(SELECTION_END_MARKER, '');
  const selectionStart = startIndex === -1 ? Math.min(normalizedEndIndex, cleanMarkdown.length) : startIndex;
  const selectionEnd = Math.max(selectionStart, Math.min(normalizedEndIndex, cleanMarkdown.length));

  return {
    markdown: cleanMarkdown,
    selection: {
      start: selectionStart,
      end: selectionEnd,
    },
  };
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
const SELECTION_START_MARKER = 'MDEDITORSELECTIONSTARTTOKEN';
const SELECTION_END_MARKER = 'MDEDITORSELECTIONENDTOKEN';
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
}: EditorViewportProps) {
  return (
    <div
      ref={editorFrameRef}
      className={sourceMode ? 'editor-frame is-source' : 'editor-frame'}
      onMouseDown={onFrameMouseDown}
    >
      {loading ? <div className="editor-loading">正在载入文档...</div> : null}
      {modeSwitching ? (
        <div className="editor-loading editor-loading--mode-switch" role="status" aria-live="polite">
          <span className="editor-loading__spinner" />
          <span>正在切换模式...</span>
        </div>
      ) : null}
      {searchPanel}
      {sourceMode ? (
        <textarea
          ref={sourceTextareaRef}
          className="editor-source"
          onChange={onSourceChange}
          onSelect={onSourceSelect}
          spellCheck={false}
          value={sourceDraft}
        />
      ) : (
        <div ref={editorHostRef}>
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
      aria-label="查找和替换"
    >
      <div className="search-panel__row">
        <input
          ref={queryInputRef}
          className="search-panel__input"
          onChange={onQueryChange}
          onKeyDown={handleInputKeyDown}
          placeholder="查找文本、公式源码、代码块内容"
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
          上一个
        </button>
        <button className="search-panel__button" onClick={onNext} type="button">
          下一个
        </button>
        <button className="search-panel__button" onClick={onToggleReplace} type="button">
          {replaceVisible ? '收起替换' : '展开替换'}
        </button>
        <button className="search-panel__button" onClick={onClose} type="button">
          关闭
        </button>
      </div>
      <div className={replaceVisible ? 'search-panel__row search-panel__replace is-open' : 'search-panel__row search-panel__replace is-closed'}>
          <input
            ref={replaceInputRef}
            className="search-panel__input"
            onChange={onReplacementChange}
            onKeyDown={handleInputKeyDown}
            placeholder="替换为"
            spellCheck={false}
            type="text"
            value={replacement}
          />
          <button className="search-panel__button" onClick={onReplaceCurrent} type="button">
            替换当前
          </button>
          <button className="search-panel__button" onClick={onReplaceAll} type="button">
            全部替换
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
  resolvedTheme,
  onDocumentChange,
  onDocumentMetaChange,
  onOpenDocument,
  onOpenDocumentPath,
  onOpenFolder,
  onSaveDocument,
  onSaveDocumentAs,
  onCreateDocument,
  onSetTheme,
  onSetThemePalette,
}: EditorShellProps) {
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
  const pendingVisualMetaSyncRef = useRef<number | null>(null);
  const pendingVisualDocumentSyncRef = useRef<IdleHandle | null>(null);
  const pendingModeSwitchScrollRatioRef = useRef<number | null>(null);
  const pendingSourceSelectionRef = useRef<SourceSearchMatch | null>(null);
  const pendingVisualSelectionRestoreRef = useRef(false);
  const startupCaretPlacedRef = useRef(false);
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

  const restoreVisualSelectionFromMarkedContent = useCallback((targetEditor: TiptapEditor) => {
    const { state, view } = targetEditor;
    const removalEntries: Array<
      | {
          kind: 'text';
          from: number;
          to: number;
          text: string;
          startPos?: number;
          endPos?: number;
        }
      | {
          kind: 'math';
          pos: number;
          value: string;
          startOffset?: number;
          endOffset?: number;
        }
    > = [];

    state.doc.descendants((node, pos) => {
      if (node.isText && node.text && node.text.includes('MDEDITORSELECTION')) {
        const startIndex = node.text.indexOf(SELECTION_START_MARKER);
        const endIndex = node.text.indexOf(SELECTION_END_MARKER);
        removalEntries.push({
          kind: 'text',
          from: pos,
          to: pos + node.text.length,
          text: node.text
            .replace(SELECTION_START_MARKER, '')
            .replace(SELECTION_END_MARKER, ''),
          startPos: startIndex === -1 ? undefined : pos + startIndex,
          endPos:
            endIndex === -1
              ? undefined
              : pos +
                endIndex -
                (startIndex !== -1 && startIndex < endIndex ? SELECTION_START_MARKER.length : 0),
        });
        return true;
      }

      if (
        (node.type.name === 'mathInline' || node.type.name === 'mathBlock') &&
        String(node.attrs.value ?? '').includes('MDEDITORSELECTION')
      ) {
        const value = String(node.attrs.value ?? '');
        const startIndex = value.indexOf(SELECTION_START_MARKER);
        const endIndex = value.indexOf(SELECTION_END_MARKER);
        removalEntries.push({
          kind: 'math',
          pos,
          value: value.replace(SELECTION_START_MARKER, '').replace(SELECTION_END_MARKER, ''),
          startOffset: startIndex === -1 ? undefined : startIndex,
          endOffset:
            endIndex === -1
              ? undefined
              : endIndex -
                (startIndex !== -1 && startIndex < endIndex ? SELECTION_START_MARKER.length : 0),
        });
        return false;
      }

      return true;
    });

    if (!removalEntries.length) {
      return false;
    }

    const orderedEntries = [...removalEntries].sort((left, right) => {
      const leftPos = left.kind === 'text' ? left.from : left.pos;
      const rightPos = right.kind === 'text' ? right.from : right.pos;
      return rightPos - leftPos;
    });

    let tr = state.tr;
    let startPos: number | null = null;
    let endPos: number | null = null;
    let mathSelection: { pos: number; start: number; end: number } | null = null;

    for (const entry of orderedEntries) {
      if (entry.kind === 'text') {
        if (entry.startPos !== undefined) {
          startPos = entry.startPos;
        }
        if (entry.endPos !== undefined) {
          endPos = entry.endPos;
        }

        tr = tr.insertText(entry.text, entry.from, entry.to);
        continue;
      }

      if (entry.startOffset !== undefined) {
        startPos = entry.pos;
      }
      if (entry.endOffset !== undefined) {
        endPos = entry.pos;
      }

      const node = tr.doc.nodeAt(entry.pos);
      if (!node) {
        continue;
      }

      tr = tr.setNodeMarkup(entry.pos, undefined, {
        ...node.attrs,
        value: entry.value,
      });

      mathSelection = {
        pos: entry.pos,
        start: entry.startOffset ?? 0,
        end: entry.endOffset ?? entry.startOffset ?? 0,
      };
    }

    if (startPos !== null || endPos !== null) {
      const mappedStart = tr.mapping.map(startPos ?? endPos ?? 1, -1);
      const mappedEnd = tr.mapping.map(endPos ?? startPos ?? 1, -1);
      tr = tr.setSelection(TextSelection.create(tr.doc, mappedStart, mappedEnd));
      view.dispatch(tr);
      view.focus();
      return true;
    }

    if (mathSelection) {
      const mappedPos = tr.mapping.map(mathSelection.pos, -1);
      tr = tr.setSelection(NodeSelection.create(tr.doc, mappedPos));
      view.dispatch(tr);
      view.focus();
      window.dispatchEvent(
        new CustomEvent('markdown-editor:focus-math-search-match', {
          detail: {
            pos: mappedPos,
            start: mathSelection.start,
            end: mathSelection.end,
          },
        }),
      );
      return true;
    }

    return false;
  }, []);

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

  useEffect(() => {
    if (sourceMode) {
      setSourceDraft(document.markdown);
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
    }
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

  const extensions = useMemo(
    () =>
      createEditorExtensions({
        onUploadImage: async (file) => {
          const base64 = await fileToBase64(file);
          const saved = await window.markdownEditor.saveImage({
            base64,
            suggestedName: file.name,
            currentPath: documentPathRef.current,
          });

          return saved.markdownPath;
        },
        onResolveImageSource: (source) => resolveImageSource(source, documentPathRef.current),
      }),
    [],
  );

  const handleClipboardTextSerialize = useCallback(
    (slice: { content: { toJSON: () => unknown } }) => {
      const content = slice.content.toJSON() as Parameters<typeof serializeMarkdownFragment>[0];
      return serializeMarkdownFragment(content).trimEnd();
    },
    [],
  );

  const handleEditorCopy = useCallback((view: TiptapEditor['view'], event: Event) => {
    const clipboardEvent = event as ClipboardEvent;
    if (view.state.selection.empty || !clipboardEvent.clipboardData) {
      return false;
    }

    const content = view.state.selection.content().content.toJSON() as Parameters<
      typeof serializeMarkdownFragment
    >[0];
    const markdown = serializeMarkdownFragment(content).trimEnd();
    if (!markdown) {
      return false;
    }

    clipboardEvent.clipboardData.setData('text/plain', markdown);
    clipboardEvent.preventDefault();
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
      },
      handleClick: handleEditorClick,
    }),
    [handleClipboardTextSerialize, handleEditorClick, handleEditorCopy],
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
        if (!largeDocumentModeRef.current) {
          const canonicalMarkdown = serializeMarkdown(nextEditor.getJSON());
          const stats = calculateDocumentStats(getEditorPlainText(nextEditor));
          visualMarkdownRef.current = canonicalMarkdown;
          visualStatsRef.current = stats;
          lastEmittedMarkdownRef.current = canonicalMarkdown;
        }
        setLiveDirty(false);
        if (searchPanelOpenRef.current) {
          setVisualSearchRevision((current) => current + 1);
        }
        return;
      }

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

    const markdown = serializeMarkdown(targetEditor.getJSON());
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

  useEffect(() => {
    if (!editor || sourceMode) {
      return;
    }

    if (document.markdown === lastEmittedMarkdownRef.current) {
      setLoadingExternalDocument(false);
      return;
    }

    const loadId = latestExternalLoadRef.current + 1;
    latestExternalLoadRef.current = loadId;
    setLoadingExternalDocument(true);
    editor.setEditable(false);

    if (document.markdown.length < LARGE_DOCUMENT_THRESHOLD) {
      void import('../editor/markdown')
        .then(({ parseMarkdown }) => {
          if (latestExternalLoadRef.current !== loadId || sourceModeRef.current || !editor) {
            return;
          }

          externalUpdateRef.current = true;
          armSkipNextDocChange();
          editor.commands.setContent(parseMarkdown(document.markdown), false);
          externalUpdateRef.current = false;

          const canonicalMarkdown = serializeMarkdown(editor.getJSON());
          const stats = calculateDocumentStats(getEditorPlainText(editor));
          const nextOutline = extractOutline(document.markdown);
          visualMarkdownRef.current = canonicalMarkdown;
          visualStatsRef.current = stats;
          lastEmittedMarkdownRef.current = canonicalMarkdown;
          setOutline((current) => (areOutlinesEqual(current, nextOutline) ? current : nextOutline));
          setLiveStats((current) => (areStatsEqual(current, stats) ? current : stats));
          setLiveDirty(document.dirty);
          setVisualSearchRevision((current) => current + 1);
        })
        .catch(() => {
          if (latestExternalLoadRef.current !== loadId || !editor) {
            return;
          }

          const emptyStats = computeSourceStats('');
          externalUpdateRef.current = true;
          armSkipNextDocChange();
          editor.commands.setContent(createEmptyDocument(), false);
          externalUpdateRef.current = false;
          visualMarkdownRef.current = '';
          visualStatsRef.current = emptyStats;
          lastEmittedMarkdownRef.current = '';
          setOutline((current) => (current.length === 0 ? current : []));
          setLiveStats((current) => (areStatsEqual(current, emptyStats) ? current : emptyStats));
          setLiveDirty(document.dirty);
          setVisualSearchRevision((current) => current + 1);
        })
        .finally(() => {
          if (latestExternalLoadRef.current === loadId) {
            editor.setEditable(true);
            setLoadingExternalDocument(false);
          }
        });

      return;
    }

    void parseMarkdownInWorker(document.markdown)
      .then((result) => {
        if (latestExternalLoadRef.current !== loadId || sourceModeRef.current || !editor) {
          return;
        }

        externalUpdateRef.current = true;
        armSkipNextDocChange();
        editor.commands.setContent(result.content, false);
        externalUpdateRef.current = false;

        const canonicalMarkdown = serializeMarkdown(editor.getJSON());
        const stats = calculateDocumentStats(getEditorPlainText(editor));
        visualMarkdownRef.current = canonicalMarkdown;
        visualStatsRef.current = stats;
        lastEmittedMarkdownRef.current = canonicalMarkdown;
        setOutline((current) => (areOutlinesEqual(current, result.outline) ? current : result.outline));
        setLiveStats((current) => (areStatsEqual(current, stats) ? current : stats));
        setLiveDirty(document.dirty);
        setVisualSearchRevision((current) => current + 1);
      })
      .catch(async () => {
        if (latestExternalLoadRef.current !== loadId || !editor) {
          return;
        }

        try {
          const { parseMarkdown } = await import('../editor/markdown');
          if (latestExternalLoadRef.current !== loadId || !editor) {
            return;
          }

          externalUpdateRef.current = true;
          armSkipNextDocChange();
          editor.commands.setContent(parseMarkdown(document.markdown), false);
          externalUpdateRef.current = false;

          const canonicalMarkdown = serializeMarkdown(editor.getJSON());
          const stats = calculateDocumentStats(getEditorPlainText(editor));
          const nextOutline = extractOutline(document.markdown);
          visualMarkdownRef.current = canonicalMarkdown;
          visualStatsRef.current = stats;
          lastEmittedMarkdownRef.current = canonicalMarkdown;
          setOutline((current) => (areOutlinesEqual(current, nextOutline) ? current : nextOutline));
          setLiveStats((current) => (areStatsEqual(current, stats) ? current : stats));
          setLiveDirty(document.dirty);
          setVisualSearchRevision((current) => current + 1);
          return;
        } catch {
          if (latestExternalLoadRef.current !== loadId || !editor) {
            return;
          }

          const emptyStats = computeSourceStats('');
          externalUpdateRef.current = true;
          armSkipNextDocChange();
          editor.commands.setContent(createEmptyDocument(), false);
          externalUpdateRef.current = false;
          visualMarkdownRef.current = '';
          visualStatsRef.current = emptyStats;
          lastEmittedMarkdownRef.current = '';
          setOutline((current) => (current.length === 0 ? current : []));
          setLiveStats((current) => (areStatsEqual(current, emptyStats) ? current : emptyStats));
          setLiveDirty(document.dirty);
          setVisualSearchRevision((current) => current + 1);
        }
      })
      .finally(() => {
        if (latestExternalLoadRef.current === loadId) {
          editor.setEditable(true);
          setLoadingExternalDocument(false);
        }
      });
  }, [document.markdown, document.path, editor, parseMarkdownInWorker, sourceMode]);

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
        restoreVisualSelectionFromMarkedContent(editor);
      });
    });
  }, [editor, restoreVisualSelectionFromMarkedContent, sourceMode]);

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
      editorFrameRef.current?.scrollTo({ top: 0 });
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

      if (focusEditor) {
        input.focus();
      }
      input.setSelectionRange(match.start, match.end);
    });
  }, []);

  const revealVisualMatch = useCallback(
    (match: VisualSearchMatch, focusEditor = true) => {
      if (!editor) {
        return;
      }

      selectVisualSearchMatch(editor, match, focusEditor);
      if (match.kind === 'math' && focusEditor) {
        window.dispatchEvent(
          new CustomEvent('markdown-editor:focus-math-search-match', {
            detail: {
              pos: match.pos,
              start: match.start,
              end: match.end,
            },
          }),
        );
      }
    },
    [editor],
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

      const match = searchMatches[normalized];
      if (sourceMode) {
        revealSourceMatch(match as SourceSearchMatch, focusEditor);
      } else {
        revealVisualMatch(match as VisualSearchMatch, focusEditor);
      }
    },
    [revealSourceMatch, revealVisualMatch, searchMatches, sourceMode],
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
      currentMatchLabel={searchQuery ? `${searchMatches.length ? searchCurrentIndex + 1 : 0}/${searchMatches.length}` : '输入关键词'}
      onCaseSensitiveChange={() => setSearchCaseSensitive((current) => !current)}
      onClose={closeSearchPanel}
      onNext={() => {
        jumpToSearchMatch(searchCurrentIndex + 1, true);
        // Wait for the browser to paint the selection highlight, then
        // return focus to search input so user can keep navigating
        setTimeout(() => searchInputRef.current?.focus(), 80);
      }}
      onPrevious={() => {
        jumpToSearchMatch(searchCurrentIndex - 1, true);
        setTimeout(() => searchInputRef.current?.focus(), 80);
      }}
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
          flushVisualSync(editor);
          const sourceState = buildSourceDraftFromVisualSelection(editor);
          pendingSourceSelectionRef.current = sourceState.selection;
          sourceSelectionRef.current = sourceState.selection;
          setSourceDraft(sourceState.markdown);
          queueSourcePreview(sourceState.markdown, sourceState.selection);
          return true;
        }

        const fallbackMarkdown = documentMarkdownRef.current;
        pendingSourceSelectionRef.current = {
          start: fallbackMarkdown.length,
          end: fallbackMarkdown.length,
        };
        sourceSelectionRef.current = pendingSourceSelectionRef.current;
        setSourceDraft(fallbackMarkdown);
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

        if (!cacheHit) {
          const markedContent = parseMarkdown(
            insertSelectionMarkersIntoMarkdown(markdown, selection.start, selection.end),
          );

          externalUpdateRef.current = true;
          armSkipNextDocChange();
          editor.commands.setContent(markedContent, false);
          externalUpdateRef.current = false;
        }

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
    restoreVisualSelectionFromMarkedContent,
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
          Boolean(activeElement.closest('.editor-source')));
      const activeInEmbeddedInput =
        activeElement instanceof HTMLInputElement ||
        (activeElement instanceof HTMLTextAreaElement &&
          !activeElement.classList.contains('editor-source'));

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

      if ((event.ctrlKey || event.metaKey) && event.altKey && event.shiftKey && key === 'v') {
        event.preventDefault();
        void window.markdownEditor.exportClipboardDebug().then((exportedPath) => {
          window.alert(
            exportedPath
              ? `已导出剪贴板调试信息：\n${exportedPath}`
              : '当前剪贴板没有可导出的内容。',
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
    jumpToSearchMatch,
    onSaveDocument,
    onSaveDocumentAs,
    openSearchPanel,
    searchCurrentIndex,
    searchOpen,
    toggleSourceModeWithTransition,
  ]);

  useEffect(() => {
    return window.markdownEditor.onExternalFileChange((event) => {
      if (event.kind === 'deleted') {
        const shouldSave = window.confirm(
          `文档 "${event.title}" 已被外部程序删除。\n\n是否另存为以保留当前内容？`,
        );
        if (shouldSave) {
          const visualState = sourceModeRef.current ? null : flushVisualSync();
          void onSaveDocumentAs(
            sourceModeRef.current ? sourceDraftRef.current : visualState?.markdown,
            sourceModeRef.current
              ? computeSourceStats(sourceDraftRef.current)
              : visualState?.stats,
          );
        }
        return;
      }

      // File changed externally
      const shouldReload = window.confirm(
        `文档 "${event.title}" 已被外部程序修改。\n\n是否重新加载最新内容？\n\n注意：重新加载将丢弃当前未保存的修改。`,
      );
      if (shouldReload) {
        void window.markdownEditor.openDocumentPath(event.path);
      }
    });
  }, [onSaveDocumentAs, editor]);

  useEffect(() => {
    return window.markdownEditor.onRequestSaveBeforeClose(() => {
      void (async () => {
        const visualState = sourceModeRef.current ? null : flushVisualSync();
        const saved = await onSaveDocument(
          sourceModeRef.current ? sourceDraftRef.current : visualState?.markdown,
          sourceModeRef.current ? computeSourceStats(sourceDraftRef.current) : visualState?.stats,
        );
        window.markdownEditor.respondSaveBeforeClose(Boolean(saved));
      })();
    });
  }, [onSaveDocument, editor]);

  useEffect(() => {
    const handler = (event: Event) => {
      const menuEvent = event as CustomEvent<
        'save-document' | 'save-document-as' | 'toggle-source-mode' | 'toggle-toolbar' | 'toggle-sidebar'
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
  }, [toggleSourceModeWithTransition]);

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
          focusWritableDocumentEnd(editor);
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

  const handleInsertImage = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

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
        return;
      }

      const target = editorHostRef.current?.querySelector(
        `[data-outline-index="${index}"]`,
      ) as HTMLElement | null;
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    [],
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
        toolbarVisible={toolbarVisible}
        onSetTheme={onSetTheme}
        onSetThemePalette={onSetThemePalette}
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
      />

      <input
        accept="image/*"
        className="sr-only"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) {
            return;
          }

          const base64 = await fileToBase64(file);
          const saved = await window.markdownEditor.saveImage({
            base64,
            suggestedName: file.name,
            currentPath: documentPathRef.current,
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
          event.target.value = '';
        }}
        ref={fileInputRef}
        type="file"
      />
    </div>
  );
}

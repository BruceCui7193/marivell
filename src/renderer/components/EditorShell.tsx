import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
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
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { ExportDocumentPayload, OpenedFolder, SavedDocument, ThemeMode } from '@shared/contracts';
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
import {
  parseMarkdown,
  parseMarkdownFragment,
  serializeMarkdown,
  serializeMarkdownFragment,
} from '../editor/markdown';
import { buildBlockModelFromEditor } from '../editor/block-model';
import {
  captureSourceScrollAnchor,
  captureVisualScrollAnchor,
  restoreSourceScrollAnchor,
  restoreVisualScrollAnchor,
  type ScrollAnchor,
  type SourceScrollAnchor,
} from '../editor/scroll-anchor';
import {
  forceHydrateAll,
  forceActivateViewport,
  forceDeactivateAllVirtualNodes,
  getIoDiagnosticsForTest,
  hydrateTargetRange,
  resumeScrollAnchorProvider,
  setScrollAnchorProvider,
  suspendScrollAnchorProvider,
} from '../editor/virtualization/activation-controller';
import {
  clearMathSyntaxDecorations,
  requestMathSyntaxViewportRefresh,
} from '../editor/plugins/math-syntax-highlight';
import {
  coordsAtPos,
  forceActivateAtCoords,
  forceActivateAtPosition,
  hydrateAndWaitForPosition,
  posAtCoords,
  scrollPosIntoView,
  scrollPosIntoViewAfterHydration,
} from '../editor/virtualization/coordinate-service';
import {
  clearNodeHeightCache,
  getNodeHeightCacheSizeForTest,
  getNodeHeightCacheStatsForTest,
} from '../editor/virtualization/height-cache';
import {
  getFormulaTemplateCacheStatsForTest,
  resetFormulaTemplateCacheForTest,
  resetFormulaTemplateCacheStatsForTest,
} from '../editor/virtualization/formula-template-cache';
import {
  getEditorWidthBucketDiagnostics,
  resetEditorEnvironmentKeyCache,
  setHeightMeasurementScrollPaused,
  setHeightMeasurementSuspended,
} from '../editor/virtualization/height-measurer';
import {
  clearFormulaHtmlCache,
  getCachedFormulaHtml,
  getFormulaCacheKey,
  seedFormulaHtmlCache,
} from '../editor/math-render-cache';
import {
  activateInlineMathGroupsInViewport,
  clearPendingInlineMathHeightMeasurements,
  countInlineMathPlaceholdersInPositionRange,
  deactivateAllInlineMathGroups,
  getInlineMathHeightPrefetchStatsForTest,
  hydrateInlineMathGroupsAroundPosition,
  isInlineMathSelectionNearby,
  prepareInlineMathForFormulaHtml,
  setInlineMathPrefetchRequester,
  setInlineMathScrollAnchorProvider,
  syncInlineMathSelection,
} from '../editor/virtualization/inline-math-group-registry';
import {
  buildSourceBlockAnchors,
  getSourceBlockSpans,
  sourceOffsetToPmPosWithAnchors,
  type SourceBlockAnchor,
} from '../editor/position-map';
import { replaceEditorContent } from '../editor/replace-editor-content';
import {
  splitFormulaChunks,
  type FormulaChunkResponse,
  type FormulaIndexEntry,
} from '../editor/markdown.worker';
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
  formulaIndex?: FormulaIndexEntry[];
  formulaHtml?: Record<string, string>;
}

interface WorkerParseFailure {
  id: number;
  ok: false;
  error: string;
}

type WorkerParseResponse = WorkerParseSuccess | WorkerParseFailure;

interface VisualSelectionMapping {
  source: SourceSearchMatch;
  visual: { from: number; to: number; kind: 'text' | 'node' };
}

interface ModeSwitchCache {
  sourceText: string;
  canonicalVisualMarkdown?: string;
  pmVersion: number;
  sourceToPmAnchor: Map<string, number>;
  sourceBlocks: SourceBlockAnchor[];
  visualSelectionMapping?: VisualSelectionMapping;
}

const FORMULA_CHUNK_MAX_IN_FLIGHT = 2;
const FORMULA_CHUNK_REQUEST_ID_OFFSET = 0x4000_0000;

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

export function extractOutlineFromEditor(editor: TiptapEditor): OutlineItem[] {
  const items: OutlineItem[] = [];
  const blockModel = buildBlockModelFromEditor(editor);

  for (const block of blockModel) {
    if (block.type !== 'heading') {
      continue;
    }

    const text = block.text.trim();
    if (!text) {
      continue;
    }

    const node = editor.state.doc.nodeAt(block.pmPos);
    if (!node || node.type.name !== 'heading') {
      continue;
    }

    items.push({
      id: block.id,
      level: Number(node.attrs.level ?? 1),
      text,
      line: block.line,
      start: block.pmPos,
    });
  }

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
    return (
      item.id === next.id &&
      item.level === next.level &&
      item.text === next.text &&
      item.start === next.start &&
      item.line === next.line
    );
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

function getOrCreateEditorScrollSpacer(frame: HTMLElement): HTMLElement {
  let spacer = frame.querySelector<HTMLElement>(':scope > .editor-scroll-spacer');
  if (!spacer) {
    spacer = document.createElement('div');
    spacer.className = 'editor-scroll-spacer';
    spacer.setAttribute('aria-hidden', 'true');
    spacer.style.display = 'block';
    spacer.style.height = '0px';
    spacer.style.pointerEvents = 'none';
    frame.appendChild(spacer);
  }
  return spacer;
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

type ModeSwitchMetric =
  | 'source-to-visual-fast'
  | 'source-to-visual-full-parse'
  | 'visual-to-source-full-serialize';

interface ModeSwitchPhaseEntry {
  name: string;
  ms: number;
}

function recordModeSwitchPhase(name: string, ms: number): void {
  try {
    if (!window.markdownEditor.getBenchmarkEnabled?.()) {
      return;
    }
    const target = window as unknown as {
      __marivellModeSwitchPhases?: ModeSwitchPhaseEntry[];
    };
    if (!target.__marivellModeSwitchPhases) {
      target.__marivellModeSwitchPhases = [];
    }
    target.__marivellModeSwitchPhases.push({ name, ms });
  } catch {
    // Benchmark-only instrumentation must never affect editor behavior.
  }
}

function profileModeSwitchPhase<T>(name: string, operation: () => T): T {
  const start = performance.now();
  try {
    return operation();
  } finally {
    recordModeSwitchPhase(name, performance.now() - start);
  }
}

function incrementModeSwitchMetric(metric: ModeSwitchMetric): void {
  try {
    if (!window.markdownEditor.getBenchmarkEnabled?.()) {
      return;
    }
    const target = window as unknown as Record<string, number | undefined>;
    const key =
      metric === 'source-to-visual-fast'
        ? '__marivellModeSwitchFastPath'
        : metric === 'source-to-visual-full-parse'
          ? '__marivellModeSwitchFullParse'
          : '__marivellModeSwitchFullSerialize';
    target[key] = (target[key] ?? 0) + 1;
  } catch {
    // Benchmark instrumentation must never affect editor behavior.
  }
}

function getTopLevelNodeSizes(editor: TiptapEditor): number[] {
  const sizes: number[] = [];
  editor.state.doc.content.forEach((node) => {
    sizes.push(node.nodeSize);
  });
  return sizes;
}

function buildModeSwitchCache(
  sourceText: string,
  editor: TiptapEditor,
): ModeSwitchCache | null {
  const sourceBlocks = buildSourceBlockAnchors(
    sourceText,
    getTopLevelNodeSizes(editor),
  );
  if (sourceBlocks.length === 0) {
    return null;
  }
  const sourceToPmAnchor = new Map<string, number>();
  for (const block of sourceBlocks) {
    sourceToPmAnchor.set(String(block.sourceStart), block.pmStart);
    sourceToPmAnchor.set(String(block.sourceEnd), block.pmEnd);
  }
  return {
    sourceText,
    canonicalVisualMarkdown: sourceText,
    pmVersion:
      (editor.state.doc as unknown as { version?: number }).version ?? 0,
    sourceToPmAnchor,
    sourceBlocks,
  };
}

function findLocalSourceBlockChange(
  cache: ModeSwitchCache,
  newSource: string,
): { index: number; oldAnchor: SourceBlockAnchor; newAnchor: SourceBlockAnchor } | null {
  const newSpans = getSourceBlockSpans(newSource);
  if (
    cache.sourceBlocks.length === 0 ||
    newSpans.length !== cache.sourceBlocks.length
  ) {
    return null;
  }

  const changedIndexes: number[] = [];
  for (let index = 0; index < cache.sourceBlocks.length; index += 1) {
    const oldAnchor = cache.sourceBlocks[index]!;
    const nextSpan = newSpans[index]!;
    if (oldAnchor.text === nextSpan.text) {
      continue;
    }
    changedIndexes.push(index);
  }

  if (changedIndexes.length !== 1) {
    return null;
  }
  const index = changedIndexes[0]!;
  const oldAnchor = cache.sourceBlocks[index]!;
  const nextSpan = newSpans[index]!;
  if (
    oldAnchor.kind !== nextSpan.kind ||
    (oldAnchor.kind !== 'paragraph' && oldAnchor.kind !== 'heading') ||
    oldAnchor.sourceStart !== nextSpan.sourceStart
  ) {
    return null;
  }

  return {
    index,
    oldAnchor,
    newAnchor: {
      ...nextSpan,
      pmStart: oldAnchor.pmStart,
      pmEnd: oldAnchor.pmEnd,
    },
  };
}

function sameVisualSelection(
  mapping: VisualSelectionMapping | undefined,
  selection: { from: number; to: number; kind: 'text' | 'node' },
): boolean {
  return Boolean(
    mapping &&
      mapping.visual.from === selection.from &&
      mapping.visual.to === selection.to &&
      mapping.visual.kind === selection.kind,
  );
}

function pmPosToSourceOffsetWithAnchors(
  editor: TiptapEditor,
  anchors: SourceBlockAnchor[],
  pmPos: number,
): number | null {
  const index = anchors.findIndex(
    (anchor) => pmPos >= anchor.pmStart && pmPos <= anchor.pmEnd,
  );
  if (index === -1) {
    return null;
  }
  const block = anchors[index]!;
  const topLevelNodes: ProseMirrorNode[] = [];
  editor.state.doc.content.forEach((node) => topLevelNodes.push(node));
  const blockNode = topLevelNodes[index];
  if (!blockNode) {
    return null;
  }

  try {
    const miniDoc = editor.schema.node('doc', null, [blockNode]);
    const state = EditorState.create({ schema: editor.schema, doc: miniDoc });
    let tr = state.tr;
    const relative = Math.max(
      0,
      Math.min(pmPos - block.pmStart, block.pmEnd - block.pmStart),
    );
    tr = tr.insertText(SELECTION_END_MARKER, Math.min(relative, tr.doc.content.size));
    tr = tr.insertText(SELECTION_START_MARKER, Math.min(relative, tr.doc.content.size));
    const markedMarkdown = serializeMarkdownFragment(tr.doc.toJSON().content);
    const extracted = extractSelectionMarkersFromMarkdown(markedMarkdown);
    return block.sourceStart + extracted.selection.start;
  } catch {
    return null;
  }
}

function buildSourceSelectionFromVisualEditor(
  editor: TiptapEditor,
  markdown: string,
  cache: ModeSwitchCache | null,
): SourceSearchMatch {
  const selection = editor.state.selection;
  const kind: 'text' | 'node' =
    selection instanceof NodeSelection ? 'node' : 'text';
  const mapping = cache?.visualSelectionMapping;
  if (sameVisualSelection(mapping, { from: selection.from, to: selection.to, kind })) {
    return { start: mapping!.source.start, end: mapping!.source.end };
  }
  if (cache && cache.sourceBlocks.length > 0) {
    const from = pmPosToSourceOffsetWithAnchors(editor, cache.sourceBlocks, selection.from);
    const to = from === null
      ? null
      : pmPosToSourceOffsetWithAnchors(editor, cache.sourceBlocks, selection.to);
    if (from !== null && to !== null) {
      return clampSourceSelection({ start: from, end: to }, markdown);
    }
  }

  // Rare fallback: an edited structural block that cannot be mapped from the
  // block cache. This still serializes with markers so caret mapping stays
  // exact instead of leaking markers into saved markdown.
  const transaction = editor.state.tr;
  transaction.insertText(SELECTION_END_MARKER, selection.to);
  transaction.insertText(SELECTION_START_MARKER, selection.from);
  const markedMarkdown = serializeMarkdown(transaction.doc.toJSON());
  return extractSelectionMarkersFromMarkdown(markedMarkdown).selection;
}

function serializeVisualDocumentLocally(
  editor: TiptapEditor,
  oldSource: string,
  cache: ModeSwitchCache | null,
  editRange: { from: number; to: number } | null,
): { markdown: string; fullPath: boolean } | null {
  if (!cache || cache.sourceText !== oldSource || !editRange) {
    return null;
  }

  const topLevelNodes: ProseMirrorNode[] = [];
  editor.state.doc.content.forEach((node) => topLevelNodes.push(node));
  if (topLevelNodes.length !== cache.sourceBlocks.length) {
    return null;
  }

  const changedIndexes = new Set<number>();
  let pmStart = 0;
  for (let index = 0; index < topLevelNodes.length; index += 1) {
    const node = topLevelNodes[index]!;
    const pmEnd = pmStart + node.nodeSize;
    if (editRange.from < pmEnd && editRange.to > pmStart) {
      changedIndexes.add(index);
    }
    pmStart = pmEnd;
  }
  if (changedIndexes.size === 0) {
    return null;
  }

  const patches: Array<{ start: number; end: number; text: string }> = [];
  for (const index of changedIndexes) {
    const block = cache.sourceBlocks[index];
    const node = topLevelNodes[index];
    if (!block || !node) {
      return null;
    }
    const blockMarkdown = serializeMarkdownFragment([node.toJSON()]).trimEnd();
    patches.push({
      start: block.sourceStart,
      end: block.sourceEnd,
      text: blockMarkdown,
    });
  }

  let markdown = oldSource;
  patches.sort((left, right) => right.start - left.start);
  for (const patch of patches) {
    markdown =
      markdown.slice(0, patch.start) +
      patch.text +
      markdown.slice(patch.end);
  }
  return { markdown, fullPath: false };
}

const VISUAL_META_SYNC_DELAY_MS = 260;
const VISUAL_DOCUMENT_SYNC_TIMEOUT_MS = 1400;
const SEARCH_QUERY_PREFILL_MAX_CHARS = 240;
const SEARCH_QUERY_PREFILL_MAX_NEWLINES = 2;

const EXPORT_PLACEHOLDER_SELECTOR = [
  '.math-inline-node--placeholder',
  '.math-block-node-placeholder',
  '.image-node__placeholder',
  '.mermaid-node__placeholder',
  '.html-block-placeholder',
  '.code-block-node--placeholder',
  '.mermaid-node__empty',
].join(',');

interface ExportTestCaptureCall {
  kind: string;
  payload: ExportDocumentPayload;
  snapshot: string;
  hydrateCalls: number;
  elapsedMs: number;
}

interface ExportTestCapture {
  enabled: boolean;
  calls: ExportTestCaptureCall[];
}

function countExportPlaceholders(frame: HTMLElement): number {
  return frame.querySelectorAll(EXPORT_PLACEHOLDER_SELECTOR).length;
}

async function waitForExportDomStable(frame: HTMLElement): Promise<boolean> {
  const deadline = performance.now() + 6000;
  let stableFrames = 0;
  while (performance.now() < deadline) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    if (!frame.isConnected) {
      return false;
    }
    if (countExportPlaceholders(frame) === 0) {
      stableFrames += 1;
      if (stableFrames >= 2) {
        return true;
      }
    } else {
      stableFrames = 0;
    }
  }
  return countExportPlaceholders(frame) === 0;
}

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
      {searchPanel}
      <div
        ref={editorHostRef}
        className="editor-host"
        data-mode={sourceMode ? 'source' : 'visual'}
        onContextMenu={onVisualContextMenu}
        style={
          sourceMode
            ? {
                display: 'none',
              }
            : undefined
        }
      >
        <EditorContent editor={editor} />
      </div>
      {sourceMode ? (
        <SourceEditor
          ref={sourceTextareaRef}
          value={sourceDraft}
          onChange={onSourceChange}
          onSelect={onSourceSelect}
          onCursorChange={onSourceCursorChange}
          onContextMenu={onSourceContextMenu}
        />
      ) : null}
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
  const scrollAnchorCompensationRef = useRef(0);
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
  const pendingModeSwitchRatioRestoredRef = useRef(false);
  const pendingSourceSelectionRef = useRef<SourceSearchMatch | null>(null);
  const skipSourceDraftExternalSyncRef = useRef(false);
  const suppressSourceSelectRef = useRef(false);
  const lastVisualSelectionRef = useRef<{ from: number; to: number; kind: 'text' | 'node' } | null>(null);
  const lastModeSwitchSourceSelectionRef = useRef<SourceSearchMatch | null>(null);
  const sourceCaretMovedRef = useRef(false);
  const pendingVisualSelectionRestoreRef = useRef(false);
  const startupCaretPlacedRef = useRef(false);
  const scrollMemoryRef = useRef<Map<string, ScrollAnchor | SourceScrollAnchor | number>>(new Map());
  const prevDocPathRef = useRef(document.path);
  const pendingScrollRestoreRef = useRef<ScrollAnchor | SourceScrollAnchor | number | null>(null);
  const sourceSelectionRef = useRef<SourceSearchMatch>({
    start: 0,
    end: 0,
  });
  const sourcePreviewCacheRef = useRef<{
    markdown: string;
    selection: SourceSearchMatch;
    content: JSONContent;
  } | null>(null);
  const modeSwitchCacheRef = useRef<ModeSwitchCache | null>(null);
  const visualEditRangeRef = useRef<{ from: number; to: number } | null>(null);
  const modeSwitchRequestRef = useRef(0);
  const sourcePreviewTimerRef = useRef<number | null>(null);
  const sourcePreviewRequestRef = useRef(0);
  const formulaHtmlCacheGenerationRef = useRef(0);
  const formulaHtmlCacheRef = useRef<Map<string, string>>(new Map());
  const formulaChunkRequestRef = useRef(0);
  const formulaChunkQueueRef = useRef<FormulaIndexEntry[][]>([]);
  const formulaChunkInFlightRef = useRef<Map<number, number>>(new Map());
  const formulaPrefetchRequestedKeysRef = useRef<Set<string>>(new Set());
  const formulaChunkSentAtRef = useRef<Map<number, number>>(new Map());
  const formulaChunkDiagnosticsRef = useRef({
    messages: 0,
    entries: 0,
    waitMs: 0,
    processRuns: 0,
    processMs: 0,
    editGateSkips: 0,
  });
  const pendingFormulaHtmlChunksRef = useRef<Array<Record<string, string>>>([]);
  const formulaHtmlProcessingScheduledRef = useRef(false);
  const formulaHtmlProcessingTimerRef = useRef<number | null>(null);
  const enqueueFormulaHtmlProcessingRef = useRef<
    ((formulaHtml: Record<string, string>) => void) | null
  >(null);
  const lastVisualEditAtRef = useRef(0);
  const lastEditorInteractionAtRef = useRef(0);
  const heightCacheInvalidationFrameRef = useRef<number | null>(null);
  const lastAnchorRestoredScrollTopRef = useRef<number | null>(null);
  const keepAtBottomRef = useRef(false);
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
    const frame = editorFrameRef.current;
    const markInteraction = (): void => {
      lastEditorInteractionAtRef.current = performance.now();
    };
    frame?.addEventListener('keydown', markInteraction, { capture: true });
    frame?.addEventListener('pointerdown', markInteraction, { capture: true });
    frame?.addEventListener('input', markInteraction, { capture: true });
    return () => {
      frame?.removeEventListener('keydown', markInteraction, { capture: true });
      frame?.removeEventListener('pointerdown', markInteraction, { capture: true });
      frame?.removeEventListener('input', markInteraction, { capture: true });
    };
  }, []);

  useEffect(() => {
    if (sourceMode) {
      keepAtBottomRef.current = false;
      const frame = editorFrameRef.current;
      frame?.querySelector(':scope > .editor-scroll-spacer')?.remove();
      const editorSurface =
        frame?.querySelector<HTMLElement>('.editor-surface .ProseMirror') ??
        frame?.querySelector<HTMLElement>('.editor-surface > .tiptap') ??
        frame?.querySelector<HTMLElement>('.editor-surface');
      if (editorSurface) {
        editorSurface.style.marginTop = '';
      }
      scrollAnchorCompensationRef.current = 0;
      if (frame) {
        frame.scrollTop = 0;
        frame.scrollLeft = 0;
      }
    }
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

  const cancelFormulaHtmlProcessingTimer = useCallback(() => {
    if (formulaHtmlProcessingTimerRef.current !== null) {
      const idleWindow = window as Window & {
        cancelIdleCallback?: (handle: number) => void;
      };
      if (typeof idleWindow.cancelIdleCallback === 'function') {
        idleWindow.cancelIdleCallback(formulaHtmlProcessingTimerRef.current);
      } else {
        window.clearTimeout(formulaHtmlProcessingTimerRef.current);
      }
      formulaHtmlProcessingTimerRef.current = null;
    }
    formulaHtmlProcessingScheduledRef.current = false;
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
          suppressSourceSelectRef.current = true;
          input.setSelectionRange(selection.start, selection.end);
          window.setTimeout(() => {
            suppressSourceSelectRef.current = false;
          }, 0);
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

  const parseMarkdownInWorker = useCallback((markdown: string, includeFormulaHtml = false) => {
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
      worker.postMessage({ id: requestId, markdown, includeFormulaHtml });
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

      if (markdown.length >= LARGE_DOCUMENT_THRESHOLD) {
        sourcePreviewTimerRef.current = null;
        return;
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
      }, 60);
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
      formulaChunkQueueRef.current = [];
      formulaChunkInFlightRef.current.clear();
      formulaPrefetchRequestedKeysRef.current.clear();
      formulaChunkSentAtRef.current.clear();
      cancelFormulaHtmlProcessingTimer();
      pendingFormulaHtmlChunksRef.current = [];
      enqueueFormulaHtmlProcessingRef.current = null;
    };
  }, []);

  // Sync source draft only when the document changes externally (open file /
  // reload). Do NOT reset the caret on every local keystroke — that used to
  // jump the selection to the end of the file while editing in source mode,
  // and also fought with the visual↔source selection restore path.
  useEffect(() => {
    if (!sourceMode) {
      skipSourceDraftExternalSyncRef.current = false;
      return;
    }

    // The parent may still hold the pre-flush document during this render;
    // do not let that stale prop overwrite the visual-to-source draft.
    if (skipSourceDraftExternalSyncRef.current) {
      skipSourceDraftExternalSyncRef.current = false;
      return;
    }

    // Local source edits already keep sourceDraft / document.markdown in sync.
    if (document.markdown === sourceDraftRef.current) {
      setLiveDirty(document.dirty);
      return;
    }

    setSourceDraft(document.markdown);
    sourceDraftRef.current = document.markdown;
    modeSwitchCacheRef.current = null;
    visualEditRangeRef.current = null;
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
      const coords = coordsAtPos(currentEditor, info.pos);
      if (coords) {
        x = coords.left;
        y = coords.bottom + 8;
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
        mousemove: (_view: TiptapEditor['view'], event: globalThis.MouseEvent) => {
          const currentEditor = editorRef.current;
          const domSelection = window.getSelection();
          if (!currentEditor || !domSelection || domSelection.isCollapsed) {
            return false;
          }
          forceActivateAtCoords(currentEditor, event.clientX, event.clientY);
          return false;
        },
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
      if (isInlineMathSelectionNearby(nextEditor)) {
        requestAnimationFrame(() => {
          if (!nextEditor.isDestroyed) {
            syncInlineMathSelection(nextEditor);
          }
        });
      }
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
      lastVisualEditAtRef.current = performance.now();
      try {
        const changed = transaction.changedRange();
        const previous = visualEditRangeRef.current;
        visualEditRangeRef.current = {
          from: Math.min(previous?.from ?? changed?.from ?? 0, changed?.from ?? 0),
          to: Math.max(previous?.to ?? changed?.to ?? 0, changed?.to ?? 0),
        };
      } catch {
        visualEditRangeRef.current = {
          from: 0,
          to: nextEditor.state.doc.content.size,
        };
      }
      if (isInlineMathSelectionNearby(nextEditor)) {
        requestAnimationFrame(() => {
          if (!nextEditor.isDestroyed) {
            syncInlineMathSelection(nextEditor);
          }
        });
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
    editorRef.current = editor;
    if (window.markdownEditor.getBenchmarkEnabled?.()) {
      const benchmarkWindow = window as unknown as Record<string, unknown>;
      benchmarkWindow.__marivellEditor = editor;
      benchmarkWindow.__marivellClearFormulaHtmlCache = clearFormulaHtmlCache;
      benchmarkWindow.__marivellNodeHeightCacheSize = getNodeHeightCacheSizeForTest();
      benchmarkWindow.__marivellGetEditorWidthBucketDiagnostics =
        getEditorWidthBucketDiagnostics;
      benchmarkWindow.__marivellGetNodeHeightCacheStats =
        getNodeHeightCacheStatsForTest;
      benchmarkWindow.__marivellGetInlineMathHeightPrefetchStats =
        getInlineMathHeightPrefetchStatsForTest;
      benchmarkWindow.__marivellGetFormulaTemplateCacheStats =
        getFormulaTemplateCacheStatsForTest;
      benchmarkWindow.__marivellResetFormulaTemplateCacheForTest =
        resetFormulaTemplateCacheForTest;
      benchmarkWindow.__marivellResetFormulaTemplateCacheStatsForTest =
        resetFormulaTemplateCacheStatsForTest;
      benchmarkWindow.__marivellFormulaChunkDiagnostics =
        formulaChunkDiagnosticsRef.current;
    }
  }, [editor]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const frame = editorFrameRef.current;
    if (!frame) {
      return;
    }

    const provider = {
      capture: () => {
        const anchor = captureVisualScrollAnchor(frame, editor);
        if (anchor === null) {
          return null;
        }
        return { ...anchor, scrollTop: frame.scrollTop };
      },
      restore: (anchor: ScrollAnchor & { scrollTop?: number }) => {
        restoreVisualScrollAnchor(frame, editor, anchor);
        if (typeof anchor.scrollTop === 'number') {
          const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
          const restoredScrollTop = Math.max(0, Math.min(anchor.scrollTop, maxScrollTop));
          const snappedScrollTop =
            restoredScrollTop >= maxScrollTop - 1
              ? Math.round(maxScrollTop)
              : restoredScrollTop;
          if (frame.scrollTop !== snappedScrollTop) {
            frame.scrollTop = snappedScrollTop;
          }
          lastAnchorRestoredScrollTopRef.current = snappedScrollTop;
        } else {
          lastAnchorRestoredScrollTopRef.current = frame.scrollTop;
        }
      },
    };
    setScrollAnchorProvider(provider);
    return () => {
      setScrollAnchorProvider(null);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    let disposed = false;

    const rehydrateViewport = () => {
      heightCacheInvalidationFrameRef.current = null;
      if (sourceModeRef.current) {
        return;
      }
      const frame = editorFrameRef.current;
      if (!frame) {
        return;
      }
      forceActivateViewport(frame);
    };

    const invalidateHeightCache = () => {
      resetEditorEnvironmentKeyCache();
      clearNodeHeightCache();
      if (formulaHtmlCacheRef.current.size > 0) {
        prepareInlineMathForFormulaHtml(
          Object.fromEntries(formulaHtmlCacheRef.current),
        );
      }
      if (heightCacheInvalidationFrameRef.current !== null) {
        cancelAnimationFrame(heightCacheInvalidationFrameRef.current);
      }
      heightCacheInvalidationFrameRef.current = requestAnimationFrame(rehydrateViewport);
    };

    window.addEventListener('resize', invalidateHeightCache);

    let zoomQuery: MediaQueryList | null = null;
    try {
      zoomQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      zoomQuery.addEventListener?.('change', invalidateHeightCache);
    } catch {
      // Some test environments expose a partial matchMedia implementation.
    }

    let themeObserver: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined') {
      themeObserver = new MutationObserver(() => invalidateHeightCache());
      themeObserver.observe(window.document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-color-scheme', 'data-font-version'],
      });
    }

    let fontsReady: Promise<unknown> | null = null;
    try {
      fontsReady = window.document.fonts?.ready ?? null;
    } catch {
      fontsReady = null;
    }
    if (fontsReady) {
      fontsReady.then(() => {
        if (!disposed) {
          invalidateHeightCache();
        }
      }).catch(() => {
        // Font loading can be interrupted in tests; the next resize/theme event retries.
      });
    }

    return () => {
      disposed = true;
      window.removeEventListener('resize', invalidateHeightCache);
      zoomQuery?.removeEventListener?.('change', invalidateHeightCache);
      themeObserver?.disconnect();
      if (heightCacheInvalidationFrameRef.current !== null) {
        cancelAnimationFrame(heightCacheInvalidationFrameRef.current);
        heightCacheInvalidationFrameRef.current = null;
      }
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const frame = editorFrameRef.current;
    if (!frame) {
      return;
    }

    let hydrationFrame: number | null = null;
    let hydrationInProgress = false;
    let hydrationSettleTimer: ReturnType<typeof setTimeout> | null = null;
    let heightPauseTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSyncHydrateScrollTop = frame.scrollTop;
    let lastRecordedScrollTop = frame.scrollTop;
    let lastScrollBurstWasLarge = false;
    let deferInlineMathHydrationForNextScroll = false;
    let lastKnownMaxScrollTop = Math.max(
      frame.scrollHeight - frame.clientHeight,
      0,
    );
    let scrollHydrationAnchorForFallback: { pmPos: number; offsetTop: number } | null = null;
    let surfaceCompensationY = scrollAnchorCompensationRef.current;
    let scrollEventCount = 0;
    let hydrateRunCount = 0;
    let preciseCenterCount = 0;
    let ratioCenterCount = 0;
    let anchorCaptureCount = 0;
    let maxHydrateWorkMs = 0;
    const scrollHotpathTimings: Array<Record<string, unknown>> = [];

    const publishScrollHotpathDiagnostics = (): void => {
      (window as unknown as Record<string, unknown>).__marivellScrollHotpathDiagnostics = {
        scrollEventCount,
        hydrateRunCount,
        preciseCenterCount,
        ratioCenterCount,
        anchorCaptureCount,
        maxHydrateWorkMs,
        timings: scrollHotpathTimings.slice(-12),
      };
    };
    const resetScrollHotpathDiagnostics = (): void => {
      scrollEventCount = 0;
      hydrateRunCount = 0;
      preciseCenterCount = 0;
      ratioCenterCount = 0;
      anchorCaptureCount = 0;
      maxHydrateWorkMs = 0;
      scrollHotpathTimings.length = 0;
      publishScrollHotpathDiagnostics();
    };
    (window as unknown as Record<string, unknown>).__marivellResetScrollHotpathDiagnostics =
      resetScrollHotpathDiagnostics;

    const applySurfaceAnchorCompensation = (delta: number): void => {
      if (Math.abs(delta) < 0.5 || Math.abs(delta) > Math.max(frame.clientHeight * 4, 2000)) {
        return;
      }
      surfaceCompensationY -= delta;
      const surface =
        frame.querySelector<HTMLElement>('.editor-surface .ProseMirror') ??
        frame.querySelector<HTMLElement>('.editor-surface > .tiptap') ??
        frame.querySelector<HTMLElement>('.editor-surface');
      if (surface) {
        surface.style.marginTop = Math.abs(surfaceCompensationY) < 0.5
          ? ''
          : `${surfaceCompensationY}px`;
      }
      scrollAnchorCompensationRef.current = surfaceCompensationY;
    };

    const compensateBottomAnchor = (anchor: { pmPos: number; offsetTop: number }): void => {
      requestAnimationFrame(() => {
        const currentEditor = editorRef.current;
        if (!currentEditor) {
          return;
        }
        try {
          const frameRect = frame.getBoundingClientRect();
          const coords = coordsAtPos(currentEditor, anchor.pmPos);
          if (!coords) {
            return;
          }
          const delta = (coords.top - frameRect.top) - anchor.offsetTop;
          if (Math.abs(delta) >= 0.5) {
            const spacer = getOrCreateEditorScrollSpacer(frame);
            const currentSpacerHeight = Number.parseFloat(spacer.style.height) || 0;
            spacer.style.height = `${Math.max(0, currentSpacerHeight + delta)}px`;
            const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
            frame.scrollTop = Math.round(maxScrollTop);
            lastAnchorRestoredScrollTopRef.current = frame.scrollTop;
            keepAtBottomRef.current = true;
          }
        } catch {
          // Bottom anchor compensation is best-effort.
        }
      });
    };

    const compensateTopAnchor = (
      anchor: { pmPos: number; offsetTop: number },
      attempt = 0,
      scrollTopTarget?: number,
    ): void => {
      const currentEditor = editorRef.current;
      if (!currentEditor || attempt > 3) {
        return;
      }
      if (attempt < 1) {
        requestAnimationFrame(() => compensateTopAnchor(anchor, attempt + 1, scrollTopTarget));
        return;
      }
      try {
        const stillAtTargetScroll =
          typeof scrollTopTarget !== 'number' ||
          Math.abs(frame.scrollTop - scrollTopTarget) < 1;
        const frameRect = frame.getBoundingClientRect();
        const coords = coordsAtPos(currentEditor, anchor.pmPos);
        if (coords) {
          const delta = (coords.top - frameRect.top) - anchor.offsetTop;
          applySurfaceAnchorCompensation(delta);
        }
        if (typeof scrollTopTarget === 'number' && stillAtTargetScroll) {
          const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
          const pinnedScrollTop = Math.min(scrollTopTarget, maxScrollTop);
          frame.scrollTop = pinnedScrollTop;
          lastAnchorRestoredScrollTopRef.current = pinnedScrollTop;
        }
        if (attempt === 2) {
          requestAnimationFrame(() => compensateTopAnchor(anchor, 3, scrollTopTarget));
        }
        if (attempt === 1) {
          requestAnimationFrame(() => {
            if (!frame.isConnected || typeof scrollTopTarget !== 'number') {
              return;
            }
            const latestMax = Math.max(frame.scrollHeight - frame.clientHeight, 0);
            if (Math.abs(frame.scrollTop - scrollTopTarget) < 1) {
              frame.scrollTop = Math.min(scrollTopTarget, latestMax);
              lastAnchorRestoredScrollTopRef.current = frame.scrollTop;
            }
            const latestEditor = editorRef.current;
            if (!latestEditor) {
              return;
            }
            try {
              const latestFrameRect = frame.getBoundingClientRect();
              const latestCoords = coordsAtPos(latestEditor, anchor.pmPos);
              if (latestCoords) {
                const latestDelta = (latestCoords.top - latestFrameRect.top) - anchor.offsetTop;
                if (Math.abs(latestDelta) >= 0.1) {
                  applySurfaceAnchorCompensation(latestDelta);
                }
              }
            } catch {
              // Anchor compensation is best-effort when PM layout is transient.
            }
            compensateTopAnchor(anchor, 2, scrollTopTarget);
            window.setTimeout(() => compensateTopAnchor(anchor, 2, scrollTopTarget), 120);
          });
        }
      } catch {
        // Anchor compensation is best-effort when PM layout is transient.
      }
    };

    setInlineMathScrollAnchorProvider({
      capture: () => {
        const currentEditor = editorRef.current;
        const anchor = currentEditor ? captureVisualScrollAnchor(frame, currentEditor) : null;
        return anchor === null ? null : { ...anchor, scrollTop: frame.scrollTop };
      },
      restore: (anchor) => {
        const currentEditor = editorRef.current;
        if (!currentEditor) {
          return;
        }
        restoreVisualScrollAnchor(frame, currentEditor, anchor);
        if (typeof anchor.scrollTop === 'number') {
          const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
          const snappedScrollTop = Math.max(0, Math.min(anchor.scrollTop, maxScrollTop));
          if (Math.abs(frame.scrollTop - snappedScrollTop) >= 0.01) {
            frame.scrollTop = snappedScrollTop;
          }
          lastAnchorRestoredScrollTopRef.current = snappedScrollTop;
        }
      },
    });
    const getCheapViewportCenterAndRadius = (
      scrollTopValue = frame.scrollTop,
      scrollHeightValue = frame.scrollHeight,
      clientHeightValue = frame.clientHeight,
    ): { pos: number; radius: number } | null => {
      const currentEditor = editorRef.current;
      if (!currentEditor) {
        return null;
      }
      const docSize = currentEditor.state.doc.content.size;
      if (docSize <= 0) {
        return null;
      }
      const maxScrollTop = Math.max(scrollHeightValue - clientHeightValue, 0);
      const ratio = maxScrollTop > 0
        ? Math.min(1, Math.max(0, scrollTopValue / maxScrollTop))
        : 0;
      const pos = Math.max(0, Math.min(docSize, Math.round(docSize * ratio)));
      const radius = Math.max(
        1,
        Math.ceil(
          (docSize * clientHeightValue) / Math.max(scrollHeightValue, 1),
        ),
      );
      return { pos, radius };
    };
    (window as unknown as Record<string, unknown>).__marivellGetInlineMathPlaceholderCountInViewport = () => {
      const centerAndRadius = getCheapViewportCenterAndRadius();
      if (!centerAndRadius) {
        return 0;
      }
      return countInlineMathPlaceholdersInPositionRange(
        centerAndRadius.pos,
        centerAndRadius.radius,
      );
    };
    (window as unknown as Record<string, unknown>).__marivellResetHydrationSyncForTest = () => {
      lastSyncHydrateScrollTop = 0;
    };
    (window as unknown as Record<string, unknown>).__marivellSetDeferInlineMathHydrationForNextScroll = (
      value: boolean,
    ) => {
      deferInlineMathHydrationForNextScroll = value;
    };
    (window as unknown as Record<string, unknown>).__marivellDeactivateAllInlineMathGroups =
      deactivateAllInlineMathGroups;
    (window as unknown as Record<string, unknown>).__marivellResetScrollAnchorCompensation = () => {
      surfaceCompensationY = 0;
      scrollAnchorCompensationRef.current = 0;
      const surface =
        frame.querySelector<HTMLElement>('.editor-surface .ProseMirror') ??
        frame.querySelector<HTMLElement>('.editor-surface > .tiptap') ??
        frame.querySelector<HTMLElement>('.editor-surface');
      if (surface) {
        surface.style.marginTop = '';
      }
    };
    (window as unknown as Record<string, unknown>).__marivellSyncIoForTest = () => {
      const currentEditor = editorRef.current;
      const currentFrame = editorFrameRef.current;
      if (!currentEditor || !currentFrame) {
        return 0;
      }
      const centerAndRadius = getCheapViewportCenterAndRadius();
      if (!centerAndRadius) {
        return 0;
      }
      const radius = Math.max(1, Math.ceil(centerAndRadius.radius * 1.5));
      hydrateTargetRange(currentFrame, centerAndRadius.pos, radius, false, true);
      hydrateInlineMathGroupsAroundPosition(
        currentFrame,
        centerAndRadius.pos,
        radius,
      );
      return getIoDiagnosticsForTest().lastSyncObserved;
    };
    (window as unknown as Record<string, unknown>).__marivellForceInlineHydrateViewport = () => {
      const currentEditor = editorRef.current;
      const currentFrame = editorFrameRef.current;
      if (!currentEditor || !currentFrame) {
        return 0;
      }
      const benchmarkWindow = window as unknown as Record<string, unknown>;
      const forceStart = performance.now();
      const centerAndRadius = getRatioViewportCenterAndRadius();
      const viewportMs = performance.now() - forceStart;
      if (!centerAndRadius) {
        benchmarkWindow.__marivellForceInlineHydrateMetrics = {
          viewportMs,
          hydrateMs: 0,
          totalMs: viewportMs,
          activated: 0,
        };
        return 0;
      }
      const hydrateStart = performance.now();
      const activated = hydrateInlineMathGroupsAroundPosition(
        currentFrame,
        centerAndRadius.pos,
        centerAndRadius.radius,
      );
      const hydrateMs = performance.now() - hydrateStart;
      benchmarkWindow.__marivellForceInlineHydrateMetrics = {
        viewportMs,
        hydrateMs,
        totalMs: performance.now() - forceStart,
        activated,
      };
      return activated;
    };

    const getRatioViewportCenterAndRadius = (): { pos: number; radius: number } | null => {
      const currentEditor = editorRef.current;
      if (!currentEditor) {
        return null;
      }
      const docSize = currentEditor.state.doc.content.size;
      if (docSize <= 0) {
        return null;
      }
      const rect = frame.getBoundingClientRect();
      if (rect.height <= 0) {
        return null;
      }
      const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
      const ratio = maxScrollTop > 0
        ? Math.min(1, Math.max(0, frame.scrollTop / maxScrollTop))
        : 0;
      const pos = Math.max(0, Math.min(docSize, Math.round(docSize * ratio)));
      const radius = Math.max(
        1,
        Math.ceil(
          (docSize * frame.clientHeight) / Math.max(frame.scrollHeight, 1),
        ),
      );
      return { pos, radius: Math.ceil(radius * 4) };
    };

    const captureHydrationAnchor = (editorForAnchor: typeof editor): { pmPos: number; offsetTop: number } | null => {
      const benchmarkAnchor = (window as unknown as {
        __marivellBenchmarkTopAnchor?: { pmPos: number; relativeTop: number } | null;
      }).__marivellBenchmarkTopAnchor;
      if (benchmarkAnchor) {
        return {
          pmPos: benchmarkAnchor.pmPos,
          offsetTop: benchmarkAnchor.relativeTop,
        };
      }
      try {
        const frameRect = frame.getBoundingClientRect();
        if (frameRect.width <= 0 || frameRect.height <= 0) {
          return null;
        }
        const point = posAtCoords(
          editorForAnchor,
          frameRect.left + frameRect.width * 0.2,
          frameRect.top + 8,
        );
        if (!point) {
          return null;
        }
        const coords = editorForAnchor.view.coordsAtPos(point.pos);
        if (!coords || (coords.top === 0 && coords.bottom === 0 && coords.left === 0 && coords.right === 0)) {
          return null;
        }
        return {
          pmPos: point.pos,
          offsetTop: coords.top - frameRect.top,
        };
      } catch {
        return null;
      }
    };

    const getViewportCenterAndRadius = (): { pos: number; radius: number } | null => {
      const currentEditor = editorRef.current;
      if (!currentEditor) {
        return null;
      }
      const rect = frame.getBoundingClientRect();
      if (rect.height <= 0) {
        return null;
      }
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const docSize = currentEditor.state.doc.content.size;
      const fallbackRadius = () =>
        Math.max(
          1,
          Math.ceil(
            (docSize * frame.clientHeight) / Math.max(frame.scrollHeight, 1),
          ),
        );
      try {
        const center = posAtCoords(currentEditor, centerX, centerY);
        if (center) {
          preciseCenterCount += 1;
          return { pos: center.pos, radius: fallbackRadius() };
        }
      } catch {
        // Fall through to the ratio estimate below.
      }
      const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
      const ratio = maxScrollTop > 0
        ? Math.min(1, Math.max(0, frame.scrollTop / maxScrollTop))
        : 0;
      const pos = Math.max(0, Math.min(docSize, Math.round(docSize * ratio)));
      ratioCenterCount += 1;
      return { pos, radius: fallbackRadius() };
    };

    const performScrollHydration = (options?: { settle?: boolean; drain?: boolean }): void => {
      if (hydrationInProgress) {
        return;
      }
      hydrationInProgress = true;
      try {
        runScrollHydration(options);
      } finally {
        hydrationInProgress = false;
      }
    };

    const runSettleFallbackScan = (): void => {
      const currentEditor = editorRef.current;
      if (!currentEditor || sourceModeRef.current || hydrationInProgress) {
        return;
      }
      const centerAndRadius = getCheapViewportCenterAndRadius();
      if (!centerAndRadius) {
        return;
      }
      const radius = Math.max(1, Math.ceil(centerAndRadius.radius * 2));
      hydrateTargetRange(frame, centerAndRadius.pos, radius, false, true);
      if (!deferInlineMathHydrationForNextScroll) {
        hydrateInlineMathGroupsAroundPosition(
          frame,
          centerAndRadius.pos,
          radius,
        );
      }

      const anchor =
        scrollHydrationAnchorForFallback ??
        captureHydrationAnchor(currentEditor);
      if (anchor === null) {
        return;
      }
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const frameRect = frame.getBoundingClientRect();
          const coords = coordsAtPos(currentEditor, anchor.pmPos);
          if (!coords) {
            break;
          }
          const delta = (coords.top - frameRect.top) - anchor.offsetTop;
          if (Math.abs(delta) < 0.5) {
            break;
          }
          applySurfaceAnchorCompensation(delta);
        }
      } catch {
        // Anchor compensation is best-effort when PM layout is transient.
      }
    };

    const runScrollHydration = (options?: { settle?: boolean; drain?: boolean }): void => {
      hydrationFrame = null;
      const currentEditor = editorRef.current;
      if (!currentEditor || sourceModeRef.current) {
        return;
      }
      hydrateRunCount += 1;

      const timingStart = performance.now();
      const scrollTopBeforeHydrate = frame.scrollTop;
      const scrollHeightBeforeHydrate = frame.scrollHeight;
      const clientHeight = frame.clientHeight;
      const oldMaxScrollTop = Math.max(scrollHeightBeforeHydrate - clientHeight, 0);
      const scrollDelta = Math.abs(scrollTopBeforeHydrate - lastSyncHydrateScrollTop);
      const isAtBottomNow = scrollTopBeforeHydrate >= oldMaxScrollTop - 1;
      const centerStart = performance.now();
      const cheapCenterAndRadius = getCheapViewportCenterAndRadius(
        scrollTopBeforeHydrate,
        scrollHeightBeforeHydrate,
        clientHeight,
      );
      const centerAndRadius = getViewportCenterAndRadius();
      const shouldHydrate = centerAndRadius !== null || cheapCenterAndRadius !== null;
      if (centerAndRadius === null && cheapCenterAndRadius !== null) {
        ratioCenterCount += 1;
      }
      const centerMs = performance.now() - centerStart;
      const centerPos = centerAndRadius?.pos ?? cheapCenterAndRadius?.pos ?? null;
      const viewportRadius = Math.ceil(
        (centerAndRadius?.radius ?? cheapCenterAndRadius?.radius ?? 1) * 1.5,
      );
      let activatedInlineGroups = 0;
      const anchorStart = performance.now();
      const anchorBeforeHydrate = shouldHydrate
        ? (anchorCaptureCount += 1, captureHydrationAnchor(currentEditor))
        : null;
      scrollHydrationAnchorForFallback = anchorBeforeHydrate;
      const anchorMs = performance.now() - anchorStart;
      const hydrateStart = performance.now();
      let activatedBlocks = 0;
      if (shouldHydrate && centerPos !== null) {
        activatedBlocks = hydrateTargetRange(
          frame,
          centerPos,
          viewportRadius,
          false,
          options?.drain === true,
        );
        if (!deferInlineMathHydrationForNextScroll) {
          activatedInlineGroups += hydrateInlineMathGroupsAroundPosition(
            frame,
            centerPos,
            viewportRadius,
          );
        }
        lastSyncHydrateScrollTop = frame.scrollTop;
      }
      const inlineGroupDiagnostics = (window as unknown as Record<string, unknown>)
        .__marivellInlineGroupHydrateDiagnostics as
        | Record<string, unknown>
        | undefined;
      const hydrateMs = performance.now() - hydrateStart;
      const wasAtBottom = isAtBottomNow;
      keepAtBottomRef.current = wasAtBottom;
      lastKnownMaxScrollTop = Math.max(
        frame.scrollHeight - frame.clientHeight,
        0,
      );
      const posAtCoordsMs = 0;
      const activateMs = 0;

      if (options?.settle !== true) {
        frame.querySelector<HTMLElement>(':scope > .editor-scroll-spacer')?.remove();
        const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
        const wasAtTop = scrollTopBeforeHydrate <= 1;
        if (wasAtTop) {
          scrollAnchorCompensationRef.current = 0;
          surfaceCompensationY = 0;
          const surface =
            frame.querySelector<HTMLElement>('.editor-surface .ProseMirror') ??
            frame.querySelector<HTMLElement>('.editor-surface > .tiptap') ??
            frame.querySelector<HTMLElement>('.editor-surface');
          if (surface) {
            surface.style.marginTop = '';
          }
          if (frame.scrollTop !== 0) {
            frame.scrollTop = 0;
          }
        } else if (wasAtBottom) {
          scrollAnchorCompensationRef.current = 0;
          surfaceCompensationY = 0;
          const surface =
            frame.querySelector<HTMLElement>('.editor-surface .ProseMirror') ??
            frame.querySelector<HTMLElement>('.editor-surface > .tiptap') ??
            frame.querySelector<HTMLElement>('.editor-surface');
          if (surface) {
            surface.style.marginTop = '';
          }
          const bottomScrollTop = Math.round(maxScrollTop);
          if (Math.abs(frame.scrollTop - bottomScrollTop) >= 0.01) {
            frame.scrollTop = bottomScrollTop;
          }
        } else if (anchorBeforeHydrate !== null) {
          surfaceCompensationY = scrollAnchorCompensationRef.current;
          const pinnedScrollTop = Math.max(
            0,
            Math.min(scrollTopBeforeHydrate, maxScrollTop),
          );
          if (Math.abs(frame.scrollTop - pinnedScrollTop) >= 0.01) {
            frame.scrollTop = pinnedScrollTop;
          }
          try {
            for (let attempt = 0; attempt < 3; attempt += 1) {
              const frameRect = frame.getBoundingClientRect();
              const coords = coordsAtPos(
                currentEditor,
                anchorBeforeHydrate.pmPos,
              );
              if (!coords) {
                break;
              }
              const delta =
                (coords.top - frameRect.top) - anchorBeforeHydrate.offsetTop;
              if (Math.abs(delta) < 0.5) {
                break;
              }
              applySurfaceAnchorCompensation(delta);
            }
          } catch {
            // Anchor compensation is best-effort when PM layout is transient.
          }
        }
        lastAnchorRestoredScrollTopRef.current = frame.scrollTop;
        lastSyncHydrateScrollTop = frame.scrollTop;
      }
      keepAtBottomRef.current = false;
      const workMs = performance.now() - timingStart;
      maxHydrateWorkMs = Math.max(maxHydrateWorkMs, workMs);
      scrollHotpathTimings.push({
        totalMs: Math.round(workMs * 10) / 10,
        centerMs: Math.round(centerMs * 10) / 10,
        anchorMs: Math.round(anchorMs * 10) / 10,
        hydrateMs: Math.round(hydrateMs * 10) / 10,
        activatedBlocks,
        activatedInlineGroups,
        inlineGroupDiagnostics,
        scrollDelta: Math.round(scrollDelta),
        shouldHydrate,
        scrollTop: Math.round(frame.scrollTop),
      });
      publishScrollHotpathDiagnostics();
      (window as unknown as Record<string, unknown>).__marivellPhase4Timings = {
        totalMs: workMs,
        posAtCoordsMs,
        activateMs,
        anchor: anchorBeforeHydrate,
        shouldHydrate,
        scrollDelta,
        lastSyncHydrateScrollTop,
        benchmarkAnchor: (window as unknown as {
          __marivellBenchmarkTopAnchor?: unknown;
        }).__marivellBenchmarkTopAnchor ?? null,
        compensation: scrollAnchorCompensationRef.current,
      };
    };

    const clearHydrationSettleTimer = (): void => {
      if (hydrationSettleTimer !== null) {
        clearTimeout(hydrationSettleTimer);
        hydrationSettleTimer = null;
      }
    };

    const scheduleHydrationFrame = (): void => {
      clearHydrationSettleTimer();
      if (hydrationFrame !== null) {
        return;
      }
      hydrationFrame = requestAnimationFrame(() => {
        hydrationFrame = null;
        performScrollHydration({ drain: true });
      });
    };

    const hydrateScrollEnd = (): void => {
      const nextScrollTop = frame.scrollTop;
      const largeBurst = lastScrollBurstWasLarge;
      lastScrollBurstWasLarge = false;
      const isTopEndpoint = nextScrollTop <= 1;
      const isBottomEndpoint =
        lastKnownMaxScrollTop > 0 &&
        nextScrollTop >= lastKnownMaxScrollTop - 1;
      const isEndpointScroll = isTopEndpoint || isBottomEndpoint;
      if (hydrationFrame !== null) {
        cancelAnimationFrame(hydrationFrame);
        hydrationFrame = null;
      }
      clearHydrationSettleTimer();
      if (sourceModeRef.current) {
        return;
      }
      if (largeBurst || isEndpointScroll) {
        performScrollHydration({
          settle: !isBottomEndpoint,
          drain: true,
        });
        runSettleFallbackScan();
        deferInlineMathHydrationForNextScroll = false;
        return;
      }
      hydrationSettleTimer = setTimeout(() => {
        hydrationSettleTimer = null;
        if (hydrationFrame === null && !sourceModeRef.current) {
          deferInlineMathHydrationForNextScroll = false;
          performScrollHydration({ settle: true, drain: true });
          runSettleFallbackScan();
        }
      }, 300);
    };

    const hydrateScrollTarget = () => {
      scrollEventCount += 1;
      const nextScrollTop = frame.scrollTop;
      const previousScrollTop = lastRecordedScrollTop;
      lastRecordedScrollTop = nextScrollTop;
      setHeightMeasurementScrollPaused(true);
      if (heightPauseTimer !== null) {
        clearTimeout(heightPauseTimer);
        heightPauseTimer = null;
      }
      if (
        hydrationFrame !== null ||
        (lastAnchorRestoredScrollTopRef.current !== null &&
          Math.abs(nextScrollTop - lastAnchorRestoredScrollTopRef.current) < 0.01)
      ) {
        return;
      }

      const burstDelta = Math.abs(nextScrollTop - previousScrollTop);
      const isEndpointScroll =
        nextScrollTop <= 1 ||
        (lastKnownMaxScrollTop > 0 &&
          nextScrollTop >= lastKnownMaxScrollTop - 1);
      lastScrollBurstWasLarge = burstDelta >= 1000 || isEndpointScroll;
      if (burstDelta >= 1000 || isEndpointScroll) {
        scheduleHydrationFrame();
      } else {
        clearHydrationSettleTimer();
        hydrationSettleTimer = setTimeout(() => {
          hydrationSettleTimer = null;
          if (hydrationFrame === null && !sourceModeRef.current) {
            deferInlineMathHydrationForNextScroll = false;
            performScrollHydration({ settle: true });
            runSettleFallbackScan();
          }
        }, 300);
      }
    };
    frame.addEventListener('scroll', hydrateScrollTarget, { passive: true });
    frame.addEventListener('scrollend', hydrateScrollEnd, { passive: true });
    return () => {
      frame.removeEventListener('scroll', hydrateScrollTarget);
      frame.removeEventListener('scrollend', hydrateScrollEnd);
      clearHydrationSettleTimer();
      if (heightPauseTimer !== null) {
        clearTimeout(heightPauseTimer);
        heightPauseTimer = null;
      }
      setHeightMeasurementScrollPaused(false);
      if (hydrationFrame !== null) {
        cancelAnimationFrame(hydrationFrame);
        hydrationFrame = null;
      }
      setInlineMathScrollAnchorProvider(null);
    };
  }, [editor]);

  useEffect(() => {
    const frame = editorFrameRef.current;
    if (!frame || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (!keepAtBottomRef.current) {
        return;
      }
      const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
      frame.scrollTop = Math.round(maxScrollTop);
      lastAnchorRestoredScrollTopRef.current = frame.scrollTop;
    });
    observer.observe(frame);
    return () => {
      observer.disconnect();
    };
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

  function flushVisualSync(
    targetEditor = editor,
    deferSideEffects = false,
  ): { markdown: string; stats: DocumentStats } | null {
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
    const canonicalSource =
      lastEmittedMarkdownRef.current ||
      visualMarkdownRef.current ||
      serializeMarkdown(targetEditor.getJSON());
    let markdown: string;
    if (visualDocEditedRef.current) {
      const localResult = serializeVisualDocumentLocally(
        targetEditor,
        canonicalSource,
        modeSwitchCacheRef.current,
        visualEditRangeRef.current,
      );
      if (localResult && !localResult.fullPath) {
        markdown = localResult.markdown;
      } else {
        markdown = serializeMarkdown(targetEditor.getJSON());
        incrementModeSwitchMetric('visual-to-source-full-serialize');
      }
    } else {
      markdown = canonicalSource;
    }
    const stats = calculateDocumentStats(getEditorPlainText(targetEditor));
    visualMarkdownRef.current = markdown;
    visualStatsRef.current = stats;
    lastEmittedMarkdownRef.current = markdown;
    visualDocEditedRef.current = false;
    visualEditRangeRef.current = null;
    const nextCache = profileModeSwitchPhase(
      'visual-to-source-build-cache',
      () => buildModeSwitchCache(markdown, targetEditor),
    );
    if (nextCache) {
      modeSwitchCacheRef.current = {
        ...nextCache,
        visualSelectionMapping: modeSwitchCacheRef.current?.visualSelectionMapping,
      };
    } else {
      modeSwitchCacheRef.current = null;
    }
    const nextOutline = profileModeSwitchPhase(
      'visual-to-source-outline',
      () => extractOutlineFromEditor(targetEditor),
    );
    const applySideEffects = (): void => {
      setLiveStats((current) => (areStatsEqual(current, stats) ? current : stats));
      setLiveDirty(markdown !== document.savedMarkdown);
      onDocumentChange(markdown, stats);
      setOutline((current) => (areOutlinesEqual(current, nextOutline) ? current : nextOutline));
    };
    if (deferSideEffects) {
      window.setTimeout(applySideEffects, 0);
    } else {
      applySideEffects();
    }
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
      let savedScroll: ScrollAnchor | SourceScrollAnchor | number;
      if (sourceModeRef.current && sourceTextareaRef.current) {
        savedScroll = captureSourceScrollAnchor(sourceTextareaRef.current);
      } else if (sourceModeRef.current) {
        savedScroll = computeScrollRatio(scrollEl);
      } else {
        const currentEditor = editorRef.current ?? editor;
        savedScroll =
          (currentEditor ? captureVisualScrollAnchor(scrollEl, currentEditor) : null) ??
          computeScrollRatio(scrollEl);
      }
      scrollMemoryRef.current.set(previousPath, savedScroll);
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

    // Queue scroll restoration before the source/visual startup effects consume it.
    const pathKey = document.path;
    const savedScroll = pathKey ? scrollMemoryRef.current.get(pathKey) : undefined;
    pendingScrollRestoreRef.current = savedScroll ?? null;

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
    let finished = false;
    const loadId = latestExternalLoadRef.current + 1;
    latestExternalLoadRef.current = loadId;
    const formulaCacheGeneration = ++formulaHtmlCacheGenerationRef.current;
    lastVisualEditAtRef.current = 0;
    lastEditorInteractionAtRef.current = 0;
    clearFormulaHtmlCache();
    formulaHtmlCacheRef.current.clear();
    formulaChunkQueueRef.current = [];
    formulaChunkInFlightRef.current.clear();
    formulaPrefetchRequestedKeysRef.current.clear();
    cancelFormulaHtmlProcessingTimer();
    pendingFormulaHtmlChunksRef.current = [];
    setLoadingExternalDocument(true);
    startupCaretPlacedRef.current = false;
    editor.setEditable(false);


    const isActiveLoad = () =>
      !cancelled && latestExternalLoadRef.current === loadId && !editor.isDestroyed;
    // Formula pre-rendering is allowed to outlive a cancelled renderer effect
    // when the same document/generation is still current. Only a new document
    // load or editor teardown must invalidate it.
    const isActivePrefetch = () =>
      formulaHtmlCacheGenerationRef.current === formulaCacheGeneration && !editor.isDestroyed;

    const finishLoad = () => {
      if (!isActiveLoad()) {
        return;
      }
      finished = true;
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
      const frame = editorFrameRef.current;
      if (frame && !sourceModeRef.current) {
        requestAnimationFrame(() => {
          if (!isActiveLoad() || sourceModeRef.current) {
            return;
          }
          const currentFrame = editorFrameRef.current;
          if (currentFrame) {
            const currentEditor = editorRef.current;
            let centerPosition: number | undefined;
            let positionRadius: number | undefined;
            if (currentEditor) {
              try {
                const rect = currentFrame.getBoundingClientRect();
                const coords = posAtCoords(
                  currentEditor,
                  rect.left + rect.width / 2,
                  rect.top + rect.height / 2,
                );
                centerPosition = coords?.pos;
                const topCoords = posAtCoords(
                  currentEditor,
                  rect.left + rect.width / 2,
                  rect.top + 1,
                );
                const bottomCoords = posAtCoords(
                  currentEditor,
                  rect.left + rect.width / 2,
                  rect.bottom - 1,
                );
                if (topCoords && bottomCoords) {
                  positionRadius = Math.max(
                    1,
                    Math.ceil(
                      Math.max(
                        (coords?.pos ?? 0) - topCoords.pos,
                        bottomCoords.pos - (coords?.pos ?? 0),
                        bottomCoords.pos - topCoords.pos,
                      ),
                    ),
                  );
                }
              } catch {
                // Full-viewport fallback below handles missing coordinates.
              }
            }
            activateInlineMathGroupsInViewport(
              currentFrame,
              1600,
              centerPosition,
              positionRadius,
            );
          }
        });
      }

      // Keep the file's original markdown as canonical so a load+mode-switch
      // does not rewrite the document via parse/serialize normalization.
      const stats = calculateDocumentStats(getEditorPlainText(editor));
      const nextOutline = outlineItems ?? extractOutline(document.markdown);
      visualMarkdownRef.current = document.markdown;
      visualStatsRef.current = stats;
      lastEmittedMarkdownRef.current = document.markdown;
      modeSwitchCacheRef.current = buildModeSwitchCache(document.markdown, editor);
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
      modeSwitchCacheRef.current = buildModeSwitchCache('', editor);
      setOutline((current) => (current.length === 0 ? current : []));
      setLiveStats((current) => (areStatsEqual(current, emptyStats) ? current : emptyStats));
      setLiveDirty(document.dirty);
      setVisualSearchRevision((current) => current + 1);
    };

    const scheduleFormulaHeightMeasurement = (
      _entries: FormulaIndexEntry[] | null | undefined,
      formulaHtml: Record<string, string>,
    ): void => {
      if (!formulaHtml) {
        return;
      }
      for (const [key, html] of Object.entries(formulaHtml)) {
        formulaHtmlCacheRef.current.set(key, html);
      }
      prepareInlineMathForFormulaHtml(formulaHtml);
    };

    const enqueueFormulaHtmlProcessing = (formulaHtml: Record<string, string>): void => {
      if (!formulaHtml || Object.keys(formulaHtml).length === 0) {
        return;
      }
      pendingFormulaHtmlChunksRef.current.push(formulaHtml);
      if (formulaHtmlProcessingScheduledRef.current) {
        return;
      }
      const processChunk = (): void => {
        formulaHtmlProcessingScheduledRef.current = false;
        formulaHtmlProcessingTimerRef.current = null;
        const recentInteraction =
          performance.now() -
            Math.max(lastVisualEditAtRef.current, lastEditorInteractionAtRef.current) <
          1500;
        if (sourceModeRef.current || recentInteraction) {
          formulaChunkDiagnosticsRef.current.editGateSkips += 1;
          scheduleFormulaHtmlProcessing(160);
          return;
        }
        const chunk = pendingFormulaHtmlChunksRef.current.shift();
        if (!chunk) {
          return;
        }
        const processStart = performance.now();
        scheduleFormulaHeightMeasurement(null, chunk);
        formulaChunkDiagnosticsRef.current.processRuns += 1;
        formulaChunkDiagnosticsRef.current.processMs += performance.now() - processStart;
        scheduleFormulaHtmlProcessing(32);
      };
      const scheduleFormulaHtmlProcessing = (delay = 0): void => {
        if (formulaHtmlProcessingTimerRef.current !== null || formulaHtmlProcessingScheduledRef.current) {
          return;
        }
        formulaHtmlProcessingScheduledRef.current = true;
        const runProcess = (): void => {
          formulaHtmlProcessingScheduledRef.current = false;
          formulaHtmlProcessingTimerRef.current = null;
          processChunk();
        };
        const idleWindow = window as Window & {
          requestIdleCallback?: (
            callback: () => void,
            options?: { timeout: number },
          ) => number;
        };
        if (typeof idleWindow.requestIdleCallback === 'function') {
          formulaHtmlProcessingTimerRef.current = idleWindow.requestIdleCallback(
            runProcess,
            { timeout: delay + 64 },
          );
        } else {
          formulaHtmlProcessingTimerRef.current = window.setTimeout(runProcess, delay);
        }
      };
      scheduleFormulaHtmlProcessing();
      enqueueFormulaHtmlProcessingRef.current = enqueueFormulaHtmlProcessing;
    };

    const pumpFormulaChunks = (): void => {
      if (
        !isActivePrefetch() ||
        formulaChunkQueueRef.current.length === 0
      ) {
        return;
      }

      if (!markdownWorkerRef.current) {
        markdownWorkerRef.current = createMarkdownWorker();
      }
      const worker = markdownWorkerRef.current;

      const inFlightForGeneration = (): number => {
        let count = 0;
        for (const generation of formulaChunkInFlightRef.current.values()) {
          if (generation === formulaCacheGeneration) {
            count += 1;
          }
        }
        return count;
      };

      while (formulaChunkQueueRef.current.length > 0 && inFlightForGeneration() < FORMULA_CHUNK_MAX_IN_FLIGHT) {
        const chunk = formulaChunkQueueRef.current.shift();
        if (!chunk) {
          break;
        }

        const missingEntries = chunk.filter(
          (entry) => getCachedFormulaHtml(entry.latex, entry.display) === null,
        );
        if (missingEntries.length === 0) {
          for (const entry of chunk) {
            formulaPrefetchRequestedKeysRef.current.delete(
              getFormulaCacheKey(entry.latex, entry.display),
            );
          }
          continue;
        }

        const requestId = FORMULA_CHUNK_REQUEST_ID_OFFSET + ++formulaChunkRequestRef.current;
        formulaChunkInFlightRef.current.set(requestId, formulaCacheGeneration);

        const handleError = (): void => {
          worker.removeEventListener('message', handleMessage);
          worker.removeEventListener('error', handleError);
          formulaChunkInFlightRef.current.delete(requestId);
          formulaChunkSentAtRef.current.delete(requestId);
          for (const entry of missingEntries) {
            formulaPrefetchRequestedKeysRef.current.delete(
              getFormulaCacheKey(entry.latex, entry.display),
            );
          }
          pumpFormulaChunks();
        };

        const handleMessage = (event: MessageEvent<FormulaChunkResponse>) => {
          if (event.data.requestType !== 'formula-chunk' || event.data.id !== requestId) {
            return;
          }
          worker.removeEventListener('message', handleMessage);
          worker.removeEventListener('error', handleError);
          formulaChunkInFlightRef.current.delete(requestId);
          const sentAt = formulaChunkSentAtRef.current.get(requestId);
          formulaChunkSentAtRef.current.delete(requestId);
          if (typeof sentAt === 'number') {
            formulaChunkDiagnosticsRef.current.waitMs += performance.now() - sentAt;
          }
          if (event.data.ok) {
            formulaChunkDiagnosticsRef.current.messages += 1;
            formulaChunkDiagnosticsRef.current.entries += Object.keys(event.data.formulaHtml ?? {}).length;
          }
          if (event.data.ok && isActivePrefetch()) {
            seedFormulaHtmlCache(event.data.formulaHtml);
            for (const [key, html] of Object.entries(event.data.formulaHtml)) {
              formulaHtmlCacheRef.current.set(key, html);
            }
            enqueueFormulaHtmlProcessing(event.data.formulaHtml);
          }
          for (const entry of missingEntries) {
            formulaPrefetchRequestedKeysRef.current.delete(
              getFormulaCacheKey(entry.latex, entry.display),
            );
          }
          pumpFormulaChunks();
        };

        worker.addEventListener('message', handleMessage);
        worker.addEventListener('error', handleError);
        formulaChunkSentAtRef.current.set(requestId, performance.now());
        worker.postMessage({
          id: requestId,
          requestType: 'formula-chunk',
          entries: missingEntries,
        });
      }
    };

    const requestFormulaPrefetch = (entries: FormulaIndexEntry[]): void => {
      if (!isActivePrefetch() || !entries || entries.length === 0) {
        return;
      }
      const requestedKeys = formulaPrefetchRequestedKeysRef.current;
      const missing = entries.filter((entry) => {
        const key = getFormulaCacheKey(entry.latex, entry.display);
        if (getCachedFormulaHtml(entry.latex, entry.display) !== null || requestedKeys.has(key)) {
          return false;
        }
        requestedKeys.add(key);
        return true;
      });
      if (missing.length === 0) {
        return;
      }
      formulaChunkQueueRef.current.unshift(missing);
      pumpFormulaChunks();
    };

    setInlineMathPrefetchRequester(requestFormulaPrefetch);

    const startFormulaChunkPrefetch = (entries: FormulaIndexEntry[] | null | undefined): void => {
      if (!isActivePrefetch() || !entries || entries.length === 0) {
        return;
      }

      for (const entry of entries) {
        formulaPrefetchRequestedKeysRef.current.add(
          getFormulaCacheKey(entry.latex, entry.display),
        );
      }
      formulaChunkQueueRef.current = splitFormulaChunks(entries);
      pumpFormulaChunks();
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
      void parseMarkdownInWorker(document.markdown, true)
        .then((result) => {
          if (isActivePrefetch()) {
            if (result.formulaHtml) {
              seedFormulaHtmlCache(result.formulaHtml);
              for (const [key, html] of Object.entries(result.formulaHtml)) {
                formulaHtmlCacheRef.current.set(key, html);
              }
              scheduleFormulaHeightMeasurement(
                result.formulaIndex ?? null,
                result.formulaHtml,
              );
            }
          }
          startFormulaChunkPrefetch(result.formulaIndex ?? null);
          applyParsedContent(result.content, result.outline);
          if (result.formulaHtml) {
            prepareInlineMathForFormulaHtml(result.formulaHtml);
          }
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
      setInlineMathPrefetchRequester(null);
      formulaPrefetchRequestedKeysRef.current.clear();
      if (finished) {
        return;
      }
      cancelled = true;
      formulaChunkQueueRef.current = [];
      cancelFormulaHtmlProcessingTimer();
      pendingFormulaHtmlChunksRef.current = [];
      // If this load is still the latest owner, unlock so a cancelled/re-run path
      // cannot leave contenteditable=false. A newer load will lock again immediately.
      if (latestExternalLoadRef.current === loadId && !editor.isDestroyed) {
        editor.setEditable(true);
        setLoadingExternalDocument(false);
      }
    };
  }, [document.markdown, document.path, editor, parseMarkdownInWorker, sourceMode]);

  useEffect(() => {
    if (sourceMode) {
      requestAnimationFrame(() => {
        const input = sourceTextareaRef.current;
        if (!input) {
          return;
        }

        input.focus({ preventScroll: true });
        const savedScroll = pendingScrollRestoreRef.current;
        if (
          savedScroll != null &&
          typeof savedScroll === 'object' &&
          'markdownOffset' in savedScroll
        ) {
          restoreSourceScrollAnchor(input, savedScroll);
          pendingScrollRestoreRef.current = null;
        }

        const restorePendingModeSwitchRatio = (): void => {
          const ratio = pendingModeSwitchScrollRatioRef.current;
          if (ratio === null) {
            return;
          }
          requestAnimationFrame(() => {
            const nextInput = sourceTextareaRef.current;
            if (!nextInput) {
              return;
            }
            const maxScrollTop = Math.max(
              nextInput.scrollHeight - nextInput.clientHeight,
              0,
            );
            if (maxScrollTop > 0) {
              nextInput.scrollTop = maxScrollTop * ratio;
            }
            pendingModeSwitchScrollRatioRef.current = null;
            pendingModeSwitchRatioRestoredRef.current = true;
          });
        };
        const selection = pendingSourceSelectionRef.current;
        if (selection) {
          suppressSourceSelectRef.current = true;
          input.setSelectionRange(selection.start, selection.end);
          sourceSelectionRef.current = selection;
          queueSourcePreview(sourceDraftRef.current, selection);
          window.setTimeout(() => {
            pendingSourceSelectionRef.current = null;
            suppressSourceSelectRef.current = false;
          }, 120);
          startupCaretPlacedRef.current = true;
          restorePendingModeSwitchRatio();
          return;
        }

        const nextSelection = {
          start: input.selectionStart ?? sourceDraftRef.current.length,
          end: input.selectionEnd ?? sourceDraftRef.current.length,
        };
        sourceSelectionRef.current = nextSelection;
        queueSourcePreview(sourceDraftRef.current, nextSelection);
        startupCaretPlacedRef.current = true;
        restorePendingModeSwitchRatio();
      });
      return;
    }
  }, [document.markdown, queueSourcePreview, sourceMode]);

  useLayoutEffect(() => {
    if (sourceMode || !editor) {
      return;
    }

    if (pendingVisualSelectionRestoreRef.current) {
      sourceCaretMovedRef.current = false;
      return;
    }

    const selection = editor.state.selection;
    const coords = editor.view.coordsAtPos(selection.from);
    const frame = editorFrameRef.current;
    const frameRect = frame?.getBoundingClientRect();
    const caretOutside =
      coords === null ||
      frameRect === undefined ||
      coords.top < frameRect.top - 1 ||
      coords.bottom > frameRect.bottom + 1;

    if (sourceCaretMovedRef.current) {
      pendingModeSwitchScrollRatioRef.current = null;
      scrollPosIntoView(editor, selection.from);
    } else if (pendingModeSwitchScrollRatioRef.current === null && caretOutside) {
      scrollPosIntoView(editor, selection.from);
    }
    sourceCaretMovedRef.current = false;
  }, [editor, sourceMode]);

  useLayoutEffect(() => {
    const ratio = pendingModeSwitchScrollRatioRef.current;
    if (ratio === null) {
      return;
    }

    const target = sourceMode ? sourceTextareaRef.current : editorFrameRef.current;
    if (!target) {
      pendingModeSwitchScrollRatioRef.current = null;
      return;
    }

    let retryCount = 0;
    const applyRatio = (): void => {
      const currentTarget = sourceMode
        ? sourceTextareaRef.current
        : editorFrameRef.current;
      if (!currentTarget) {
        if (sourceMode && retryCount < 3) {
          retryCount += 1;
          requestAnimationFrame(applyRatio);
          return;
        }
        pendingModeSwitchScrollRatioRef.current = null;
        pendingModeSwitchRatioRestoredRef.current = true;
        return;
      }
      if (
        sourceMode &&
        typeof HTMLTextAreaElement !== 'undefined' &&
        currentTarget instanceof HTMLTextAreaElement
      ) {
        currentTarget.closest('.source-editor')?.classList.remove('source-editor--pending');
      }
      const maxScrollTop = Math.max(
        currentTarget.scrollHeight - currentTarget.clientHeight,
        0,
      );
      if (maxScrollTop <= 0 && sourceMode && retryCount < 3) {
        retryCount += 1;
        requestAnimationFrame(applyRatio);
        return;
      }
      currentTarget.scrollTop = maxScrollTop * ratio;
      pendingModeSwitchScrollRatioRef.current = null;
      pendingModeSwitchRatioRestoredRef.current = true;
    };
    applyRatio();
  }, [document.markdown, sourceDraft, sourceMode]);

  useLayoutEffect(() => {
    if (!editor) {
      return;
    }
    if (sourceMode) {
      profileModeSwitchPhase('source-deactivate-height-suspend', () => {
        setHeightMeasurementSuspended(true);
        clearPendingInlineMathHeightMeasurements();
      });
      profileModeSwitchPhase('source-deactivate-syntax-clear', () => {
        clearMathSyntaxDecorations(editor.view);
      });
      profileModeSwitchPhase('source-deactivate-virtual-nodes', () => {
        forceDeactivateAllVirtualNodes();
      });
      profileModeSwitchPhase('source-deactivate-inline-groups', () => {
        deactivateAllInlineMathGroups();
      });
      return;
    }
    profileModeSwitchPhase('visual-reactivate-height-resume', () => {
      setHeightMeasurementSuspended(false);
      clearPendingInlineMathHeightMeasurements();
      requestMathSyntaxViewportRefresh();
      const cachedHtml = Object.fromEntries(formulaHtmlCacheRef.current);
      const keys = Object.keys(cachedHtml);
      const reenqueuePrefetch = (): void => {
        if (!editor.isDestroyed && enqueueFormulaHtmlProcessingRef.current) {
          for (let index = 0; index < keys.length; index += 150) {
            const chunk: Record<string, string> = {};
            for (const key of keys.slice(index, index + 150)) {
              chunk[key] = cachedHtml[key]!;
            }
            enqueueFormulaHtmlProcessingRef.current(chunk);
          }
        }
      };
      const idleWindow = window as Window & {
        requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      };
      if (typeof idleWindow.requestIdleCallback === 'function') {
        idleWindow.requestIdleCallback(reenqueuePrefetch, { timeout: 1000 });
      } else {
        window.setTimeout(reenqueuePrefetch, 300);
      }
    });
    const frame = editorFrameRef.current;
    if (frame) {
      let centerPosition: number | null = null;
      let positionRadius: number | null = null;
      profileModeSwitchPhase('visual-reactivate-position-map', () => {
        try {
          const rect = frame.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const center = posAtCoords(editor, centerX, rect.top + rect.height / 2);
          const top = posAtCoords(editor, centerX, rect.top + 1);
          const bottom = posAtCoords(editor, centerX, rect.bottom - 1);
          if (center && top && bottom && rect.height > 0) {
            centerPosition = center.pos;
            positionRadius = Math.max(
              1,
              Math.ceil(
                Math.max(
                  center.pos - top.pos,
                  bottom.pos - center.pos,
                  bottom.pos - top.pos,
                ),
              ),
            );
          }
        } catch {
          // The ratio fallback below is enough for a transient first-frame layout.
        }
      });
      if (centerPosition === null || positionRadius === null) {
        const docSize = editor.state.doc.content.size;
        const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
        const ratio = maxScrollTop > 0
          ? Math.min(1, Math.max(0, frame.scrollTop / maxScrollTop))
          : 0;
        centerPosition = Math.max(0, Math.min(docSize, Math.round(docSize * ratio)));
        positionRadius = Math.max(
          1,
          Math.ceil(
            (docSize * frame.clientHeight) / Math.max(frame.scrollHeight, 1),
          ),
        );
      }
      const hydrateCenter = centerPosition;
      const hydrateRadius = positionRadius;
      if (hydrateCenter !== null && hydrateRadius !== null) {
        profileModeSwitchPhase('visual-reactivate-hydrate-blocks', () => {
          hydrateTargetRange(frame, hydrateCenter, hydrateRadius, true);
        });
        profileModeSwitchPhase('visual-reactivate-hydrate-inline', () => {
          hydrateInlineMathGroupsAroundPosition(
            frame,
            hydrateCenter,
            hydrateRadius,
          );
        });
      }
    }
  }, [editor, sourceMode]);

  useLayoutEffect(() => {
    if (sourceMode || !editor || !pendingVisualSelectionRestoreRef.current) {
      return;
    }

    pendingVisualSelectionRestoreRef.current = false;
    externalUpdateRef.current = true;
    armSkipNextDocChange();
    visualDocEditedRef.current = false;
    restoreSelectionMarkersFromEditorState(editor.state, editor.view);
    const restoredSelection = editor.state.selection;
    lastVisualSelectionRef.current = {
      from: restoredSelection.from,
      to: restoredSelection.to,
      kind: restoredSelection instanceof NodeSelection ? 'node' : 'text',
    };
    const cache = modeSwitchCacheRef.current;
    const sourceSelection = lastModeSwitchSourceSelectionRef.current;
    if (
      cache &&
      cache.sourceText === sourceDraftRef.current &&
      sourceSelection
    ) {
      cache.visualSelectionMapping = {
        source: sourceSelection,
        visual: lastVisualSelectionRef.current,
      };
    }
    if (pendingModeSwitchRatioRestoredRef.current) {
      pendingModeSwitchRatioRestoredRef.current = false;
      sourceCaretMovedRef.current = false;
      externalUpdateRef.current = false;
      return;
    }
    scrollPosIntoView(editor, editor.state.selection.from);
    sourceCaretMovedRef.current = false;
    externalUpdateRef.current = false;
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
      const savedScroll = pendingScrollRestoreRef.current;
      if (savedScroll != null) {
        pendingScrollRestoreRef.current = null;
        const frame = editorFrameRef.current;
        if (frame) {
          if (typeof savedScroll === 'number') {
            const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
            frame.scrollTop = maxScrollTop * savedScroll;
          } else if ('pmPos' in savedScroll) {
            restoreVisualScrollAnchor(frame, editor, savedScroll);
          }
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
      void scrollPosIntoViewAfterHydration(editor, Math.min(pos, editor.state.doc.content.size));
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

  const syncSourceToVisualState = useCallback(
    (
      markdown: string,
      sourceSelection: SourceSearchMatch,
      visualSelection: { from: number; to: number; kind: 'text' | 'node' } | null,
    ) => {
      if (!editor) {
        return;
      }
      const stats = computeSourceStats(markdown);
      onDocumentChange(markdown, stats);
      onDocumentMetaChange(markdown !== document.savedMarkdown);
      visualMarkdownRef.current = markdown;
      visualStatsRef.current = stats;
      lastEmittedMarkdownRef.current = markdown;
      const nextCache = profileModeSwitchPhase(
        'source-to-visual-build-cache',
        () => buildModeSwitchCache(markdown, editor),
      );
      if (nextCache) {
        modeSwitchCacheRef.current = nextCache;
        if (visualSelection) {
          modeSwitchCacheRef.current.visualSelectionMapping = {
            source: sourceSelection,
            visual: visualSelection,
          };
        }
      } else {
        modeSwitchCacheRef.current = null;
      }
      setLiveStats((currentStats) => (areStatsEqual(currentStats, stats) ? currentStats : stats));
      setLiveDirty(markdown !== document.savedMarkdown);
      const nextOutline = profileModeSwitchPhase(
        'source-to-visual-outline',
        () => extractOutline(markdown),
      );
      setOutline((currentOutline) =>
        areOutlinesEqual(currentOutline, nextOutline) ? currentOutline : nextOutline,
      );
      setVisualSearchRevision((currentRevision) => currentRevision + 1);
    },
    [document.savedMarkdown, editor, onDocumentChange, onDocumentMetaChange],
  );

  const toggleSourceModePreservingViewport = useCallback(() => {
    const switchStart = performance.now();
    lastVisualEditAtRef.current = performance.now();
    pendingModeSwitchRatioRestoredRef.current = false;
    captureModeSwitchScrollRatio();
    const currentSourceMode = sourceModeRef.current;
    if (!currentSourceMode) {
      setHeightMeasurementSuspended(true);
    }
    if (currentSourceMode && editor) {
      const input = sourceTextareaRef.current;
      const markdown = sourceDraftRef.current;
      const nextSelection = clampSourceSelection(
        {
          start: input?.selectionStart ?? sourceSelectionRef.current.start,
          end: input?.selectionEnd ?? sourceSelectionRef.current.end,
        },
        markdown,
      );
      const previousSelection = lastModeSwitchSourceSelectionRef.current;
      sourceCaretMovedRef.current =
        previousSelection !== null &&
        (nextSelection.start !== previousSelection.start ||
          nextSelection.end !== previousSelection.end);
    }

    if (!currentSourceMode) {
      pendingVisualSelectionRestoreRef.current = false;
      if (editor) {
        const currentVisualSelection = editor.state.selection;
        lastVisualSelectionRef.current = {
          from: currentVisualSelection.from,
          to: currentVisualSelection.to,
          kind: currentVisualSelection instanceof NodeSelection ? 'node' : 'text',
        };
        const flushed = profileModeSwitchPhase(
          'visual-to-source-flush',
          () => flushVisualSync(editor, true),
        );
        const markdown =
          flushed?.markdown ??
          lastEmittedMarkdownRef.current ??
          documentMarkdownRef.current;
        const selection = profileModeSwitchPhase(
          'visual-to-source-selection-map',
          () => buildSourceSelectionFromVisualEditor(
            editor,
            markdown,
            modeSwitchCacheRef.current,
          ),
        );
        if (modeSwitchCacheRef.current) {
          modeSwitchCacheRef.current.visualSelectionMapping = {
            source: selection,
            visual: lastVisualSelectionRef.current,
          };
        }
        pendingSourceSelectionRef.current = selection;
        lastModeSwitchSourceSelectionRef.current = {
          start: selection.start,
          end: selection.end,
        };
        sourceSelectionRef.current = selection;
        skipSourceDraftExternalSyncRef.current = true;
        setSourceDraft(markdown);
        sourceDraftRef.current = markdown;
        profileModeSwitchPhase('visual-to-source-queue-preview', () => {
          queueSourcePreview(markdown, selection);
        });
        setSourceMode(true);
        sourceModeRef.current = true;
        recordModeSwitchPhase(
          'visual-to-source-total',
          performance.now() - switchStart,
        );
        return;
      }

      const fallbackMarkdown = documentMarkdownRef.current;
      pendingSourceSelectionRef.current = {
        start: fallbackMarkdown.length,
        end: fallbackMarkdown.length,
      };
      sourceSelectionRef.current = pendingSourceSelectionRef.current;
      skipSourceDraftExternalSyncRef.current = true;
      setSourceDraft(fallbackMarkdown);
      sourceDraftRef.current = fallbackMarkdown;
      const stats = computeSourceStats(fallbackMarkdown);
      setLiveStats((currentStats) => (areStatsEqual(currentStats, stats) ? currentStats : stats));
      setSourceMode(true);
      sourceModeRef.current = true;
      return;
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

      const cached = modeSwitchCacheRef.current;
      if (markdown === lastEmittedMarkdownRef.current) {
        incrementModeSwitchMetric('source-to-visual-fast');
        const savedSourceSelection = lastModeSwitchSourceSelectionRef.current;
        const savedVisualSelection = lastVisualSelectionRef.current;
        let nextVisualSelection: { from: number; to: number; kind: 'text' | 'node' } | null = null;
        if (
          savedVisualSelection &&
          !sourceCaretMovedRef.current &&
          savedSourceSelection &&
          selection.start === savedSourceSelection.start &&
          selection.end === savedSourceSelection.end
        ) {
          nextVisualSelection = savedVisualSelection;
          const nextSelection =
            savedVisualSelection.kind === 'node'
              ? NodeSelection.create(editor.state.doc, savedVisualSelection.from)
              : TextSelection.create(
                  editor.state.doc,
                  savedVisualSelection.from,
                  savedVisualSelection.to,
                );
          externalUpdateRef.current = true;
          armSkipNextDocChange();
          visualDocEditedRef.current = false;
          editor.view.dispatch(editor.state.tr.setSelection(nextSelection));
          externalUpdateRef.current = false;
        } else {
          const mappedFrom = profileModeSwitchPhase(
            'source-to-visual-selection-map',
            () => sourceOffsetToPmPosWithAnchors(
              markdown,
              cached?.sourceBlocks ?? [],
              selection.start,
              editor.state.doc.content.size,
            ),
          );
          const mappedTo =
            mappedFrom === null
              ? null
              : profileModeSwitchPhase(
                  'source-to-visual-selection-map',
                  () => sourceOffsetToPmPosWithAnchors(
                    markdown,
                    cached?.sourceBlocks ?? [],
                    selection.end,
                    editor.state.doc.content.size,
                  ),
                );
          const from = mappedFrom ?? Math.min(selection.start, editor.state.doc.content.size);
          const to = mappedTo ?? Math.max(from, Math.min(selection.end, editor.state.doc.content.size));
          nextVisualSelection = { from, to, kind: 'text' };
          externalUpdateRef.current = true;
          armSkipNextDocChange();
          visualDocEditedRef.current = false;
          try {
            editor.view.dispatch(
              editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
            );
          } catch {
            editor.view.dispatch(
              editor.state.tr.setSelection(
                TextSelection.create(editor.state.doc, editor.state.doc.content.size),
              ),
            );
          }
          externalUpdateRef.current = false;
        }
        pendingVisualSelectionRestoreRef.current = false;
        lastModeSwitchSourceSelectionRef.current = {
          start: selection.start,
          end: selection.end,
        };
        lastVisualSelectionRef.current = nextVisualSelection;
        profileModeSwitchPhase(
          'source-to-visual-sync-state',
          () => syncSourceToVisualState(markdown, selection, nextVisualSelection),
        );
        setSourceMode(false);
        sourceModeRef.current = false;
        recordModeSwitchPhase(
          'source-to-visual-total',
          performance.now() - switchStart,
        );
        return;
      }

      const localChange =
        cached && cached.sourceText === lastEmittedMarkdownRef.current
          ? findLocalSourceBlockChange(cached, markdown)
          : null;
      if (localChange) {
        const blockText = markdown.slice(
          localChange.newAnchor.sourceStart,
          localChange.newAnchor.sourceEnd,
        );
        const relativeStart = Math.max(
          0,
          Math.min(selection.start - localChange.newAnchor.sourceStart, blockText.length),
        );
        const relativeEnd = Math.max(
          relativeStart,
          Math.min(selection.end - localChange.newAnchor.sourceStart, blockText.length),
        );
        const markedBlock = insertSelectionMarkersIntoMarkdown(
          blockText,
          relativeStart,
          relativeEnd,
        );
        const parsedBlocks = parseMarkdownFragment(markedBlock);
        if (parsedBlocks.length === 1) {
          try {
            const blockNode = editor.schema.nodeFromJSON(parsedBlocks[0]!);
            externalUpdateRef.current = true;
            armSkipNextDocChange();
            visualDocEditedRef.current = false;
            editor.view.dispatch(
              editor.state.tr.replaceWith(
                localChange.oldAnchor.pmStart,
                localChange.oldAnchor.pmEnd,
                blockNode,
              ),
            );
            externalUpdateRef.current = false;
            incrementModeSwitchMetric('source-to-visual-fast');
            pendingVisualSelectionRestoreRef.current = true;
            lastModeSwitchSourceSelectionRef.current = {
              start: selection.start,
              end: selection.end,
            };
            profileModeSwitchPhase(
              'source-to-visual-sync-state',
              () => syncSourceToVisualState(markdown, selection, null),
            );
            setSourceMode(false);
            sourceModeRef.current = false;
            recordModeSwitchPhase(
              'source-to-visual-total',
              performance.now() - switchStart,
            );
            return;
          } catch {
            externalUpdateRef.current = false;
          }
        }
      }

      incrementModeSwitchMetric('source-to-visual-full-parse');
      const markedMarkdown = insertSelectionMarkersIntoMarkdown(
        markdown,
        selection.start,
        selection.end,
      );
      const cachedPreview = sourcePreviewCacheRef.current;
      const cacheHit = Boolean(
        cachedPreview &&
        cachedPreview.markdown === markdown &&
        isSameSourceSelection(cachedPreview.selection, selection),
      );
      const applyParsedMarkedContent = (content: JSONContent) => {
        externalUpdateRef.current = true;
        armSkipNextDocChange();
        visualDocEditedRef.current = false;
        replaceEditorContent(editor, content);
        externalUpdateRef.current = false;
        pendingVisualSelectionRestoreRef.current = true;
        lastModeSwitchSourceSelectionRef.current = {
          start: selection.start,
          end: selection.end,
        };
        profileModeSwitchPhase(
          'source-to-visual-sync-state',
          () => syncSourceToVisualState(markdown, selection, null),
        );
      };
      if (cacheHit && cachedPreview) {
        applyParsedMarkedContent(cachedPreview.content);
      } else if (markdown.length >= LARGE_DOCUMENT_THRESHOLD) {
        const requestId = ++modeSwitchRequestRef.current;
        void parseMarkdownInWorker(markedMarkdown)
          .then((result) => {
            if (
              requestId !== modeSwitchRequestRef.current ||
              sourceModeRef.current ||
              editor.isDestroyed
            ) {
              return;
            }
            applyParsedMarkedContent(result.content);
          })
          .catch(() => {
            if (requestId !== modeSwitchRequestRef.current || editor.isDestroyed) {
              return;
            }
            applyParsedMarkedContent(
              parseMarkdown(markedMarkdown),
            );
          });
      } else {
        applyParsedMarkedContent(parseMarkdown(markedMarkdown));
      }
    }

    setSourceMode(false);
    sourceModeRef.current = false;
    recordModeSwitchPhase(
      'source-to-visual-total',
      performance.now() - switchStart,
    );
  }, [
    armSkipNextDocChange,
    captureModeSwitchScrollRatio,
    document.savedMarkdown,
    editor,
    onDocumentChange,
    onDocumentMetaChange,
    parseMarkdownInWorker,
    queueSourcePreview,
    syncSourceToVisualState,
  ]);

  const toggleSourceModeWithTransition = useCallback(() => {
    const transitionStart = performance.now();
    requestAnimationFrame(() => {
      toggleSourceModePreservingViewport();
      recordModeSwitchPhase(
        'overlay-delay',
        performance.now() - transitionStart,
      );
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

  const prepareExportPayload = useCallback(async (kind: 'pdf' | 'image' | 'pandoc') => {
    const benchmarkWindow = window as unknown as Record<string, unknown>;
    const capture: ExportTestCapture =
      (benchmarkWindow.__marivellExportCapture as ExportTestCapture | undefined) ??
      { enabled: false, calls: [] };
    benchmarkWindow.__marivellExportCapture = capture;
    const startedAt = performance.now();
    const frame = sourceModeRef.current ? null : editorFrameRef.current;

    if (frame && editorRef.current) {
      forceHydrateAll();
      let stable = await waitForExportDomStable(frame);
      if (!stable) {
        forceHydrateAll();
        stable = await waitForExportDomStable(frame);
      }
      if (!stable) {
        throw new Error('Export aborted: virtual content did not hydrate before capture');
      }
    }

    const payload = getExportPayload();
    const hydrateCalls =
      typeof benchmarkWindow.__marivellForceHydrateAllCalls === 'number'
        ? (benchmarkWindow.__marivellForceHydrateAllCalls as number)
        : 0;
    if (capture.enabled) {
      capture.calls.push({
        kind,
        payload,
        snapshot: editorRef.current?.view.dom.outerHTML ?? '',
        hydrateCalls,
        elapsedMs: performance.now() - startedAt,
      });
    }

    return { payload, captured: capture.enabled };
  }, [getExportPayload]);

  const callExportPdf = useCallback(async () => {
    const result = await prepareExportPayload('pdf');
    if (!result.captured) {
      await window.markdownEditor.exportAsPdf(result.payload);
    }
  }, [prepareExportPayload]);

  const callExportImage = useCallback(async () => {
    const result = await prepareExportPayload('image');
    if (!result.captured) {
      await window.markdownEditor.exportAsImage(result.payload);
    }
  }, [prepareExportPayload]);

  const callExportPandoc = useCallback(
    async (
      format: Parameters<typeof window.markdownEditor.exportWithPandoc>[1],
      options?: Parameters<typeof window.markdownEditor.exportWithPandoc>[2],
    ) => {
      const result = await prepareExportPayload('pandoc');
      if (!result.captured) {
        await window.markdownEditor.exportWithPandoc(result.payload, format, options);
      }
    },
    [prepareExportPayload],
  );

  useEffect(() => {
    const offPandoc = window.markdownEditor.onExportPandocRequest((format, options) => {
      void callExportPandoc(format, options);
    });
    return offPandoc;
  }, [callExportPandoc]);

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
        void callExportPdf();
        return;
      }

      if (menuEvent.detail === 'export-image') {
        void callExportImage();
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
  }, [callExportImage, callExportPdf, onSaveDocument, onSaveDocumentAs, toggleSourceModeWithTransition]);

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
          const coords = posAtCoords(editor, event.clientX, event.clientY);
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
      if (suppressSourceSelectRef.current || pendingSourceSelectionRef.current !== null) {
        return;
      }
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
    void callExportPdf();
  }, [callExportPdf]);

  const handleExportImage = useCallback(() => {
    void callExportImage();
  }, [callExportImage]);

  const handleExportPandoc = useCallback(
    (format: Parameters<typeof window.markdownEditor.exportWithPandoc>[1]) => {
      void callExportPandoc(format);
    },
    [callExportPandoc],
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

      const item = outline[index];
      if (!editor || !item || item.start == null || item.start < 0) {
        return;
      }

      const pos = item.start;
      void (async () => {
        try {
          await hydrateAndWaitForPosition(editor, pos);
          const selection = TextSelection.create(editor.state.doc, pos + 1);
          editor.view.dispatch(editor.state.tr.setSelection(selection));
          await scrollPosIntoViewAfterHydration(editor, pos + 1);
          editor.view.focus();
        } catch {
          // ignore invalid positions
        }
      })();
    },
    [editor, jumpSourceToOffset, outline],
  );

  const jumpToFootnoteDefinition = useCallback(
    async (label: string) => {
      const currentEditor = editorRef.current ?? editor;
      if (!currentEditor) {
        return;
      }

      let targetPos: number | null = null;
      currentEditor.state.doc.descendants((node, pos) => {
        if (
          targetPos === null &&
          node.type.name === 'footnoteDefinition' &&
          String(node.attrs.label ?? '') === label
        ) {
          targetPos = pos;
          return false;
        }
        return true;
      });

      if (targetPos === null) {
        return;
      }

      const hydrated = await hydrateAndWaitForPosition(currentEditor, targetPos);
      if (!hydrated) {
        return;
      }
      const selection = TextSelection.near(currentEditor.state.doc.resolve(targetPos + 1));
      currentEditor.view.dispatch(currentEditor.state.tr.setSelection(selection));
      await scrollPosIntoViewAfterHydration(currentEditor, targetPos);
      currentEditor.view.focus();
    },
    [editor],
  );

  useEffect(() => {
    const frame = editorFrameRef.current;
    if (!frame) {
      return;
    }
    const handler = (event: Event) => {
      const target = event.target as HTMLElement | null;
      const reference = target?.closest<HTMLElement>('[data-type="footnote-reference"]');
      if (!reference) {
        return;
      }
      const label = reference.getAttribute('data-label');
      if (!label) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void jumpToFootnoteDefinition(label);
    };
    frame.addEventListener('click', handler, true);
    return () => {
      frame.removeEventListener('click', handler, true);
    };
  }, [editor, jumpToFootnoteDefinition]);

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

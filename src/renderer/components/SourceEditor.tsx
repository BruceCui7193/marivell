import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type Ref,
  type SyntheticEvent,
} from 'react';
import { highlightMarkdownSource, offsetToLineCol } from '../editor/markdown-highlight';

export interface SourceCursorInfo {
  line: number;
  column: number;
  start: number;
  end: number;
}

function recordSourceEditorPhase(name: string, ms: number): void {
  try {
    if (!window.markdownEditor?.getBenchmarkEnabled?.()) {
      return;
    }
    const target = window as unknown as {
      __marivellModeSwitchPhases?: Array<{ name: string; ms: number }>;
    };
    if (!target.__marivellModeSwitchPhases) {
      target.__marivellModeSwitchPhases = [];
    }
    target.__marivellModeSwitchPhases.push({ name, ms });
  } catch {
    // Benchmark-only instrumentation must never affect editor behavior.
  }
}

function profileSourceEditorPhase<T>(name: string, operation: () => T): T {
  const start = performance.now();
  try {
    return operation();
  } finally {
    recordSourceEditorPhase(name, performance.now() - start);
  }
}

interface SourceEditorProps {
  value: string;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  onCursorChange?: (info: SourceCursorInfo) => void;
  onContextMenu?: (event: React.MouseEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === 'function') {
    ref(value);
  } else {
    (ref as { current: T | null }).current = value;
  }
}

function setNativeTextareaValue(textarea: HTMLTextAreaElement, next: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  descriptor?.set?.call(textarea, next);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Indent or outdent every line in the current selection. */
export function applyLineIndent(textarea: HTMLTextAreaElement, indent: boolean): void {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  let blockEnd = value.indexOf('\n', Math.max(end - 1, lineStart));
  if (blockEnd === -1 || end === value.length) {
    blockEnd = value.length;
  }
  // Include the last selected line fully.
  if (end > lineStart && value[end - 1] !== '\n') {
    const nextNl = value.indexOf('\n', end);
    blockEnd = nextNl === -1 ? value.length : nextNl;
  }

  const block = value.slice(lineStart, Math.max(blockEnd, end));
  const lines = block.split('\n');
  const nextLines = lines.map((line) => {
    if (indent) {
      return `  ${line}`;
    }
    if (line.startsWith('  ')) return line.slice(2);
    if (line.startsWith('\t')) return line.slice(1);
    return line;
  });
  const nextBlock = nextLines.join('\n');
  const nextValue = `${value.slice(0, lineStart)}${nextBlock}${value.slice(lineStart + block.length)}`;
  setNativeTextareaValue(textarea, nextValue);
  textarea.setSelectionRange(lineStart, lineStart + nextBlock.length);
  textarea.focus();
}

const SOURCE_LINE_HEIGHT_PX = 23.8;
const SOURCE_PADDING_TOP_PX = 28;
const SOURCE_GUTTER_OVERSCAN = 24;
const SOURCE_MIN_HIGHLIGHT_LINES = 160;
const SOURCE_INITIAL_HIGHLIGHT_LINES = 240;

interface SourceEditorMetrics {
  lineHeight: number;
  paddingTop: number;
}

interface SourceVisibleRange {
  start: number;
  endExclusive: number;
}

function countSourceLines(value: string): number {
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) {
      lines += 1;
    }
  }
  return lines;
}

function getSourceLineRange(
  markdown: string,
  startLine: number,
  endLineExclusive: number,
): string {
  const safeStart = Math.max(0, startLine);
  const safeEnd = Math.max(safeStart, endLineExclusive);
  if (safeStart === safeEnd) {
    return '';
  }

  let line = 0;
  let startOffset = 0;
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown.charCodeAt(index) !== 10) {
      continue;
    }
    if (safeStart > 0 && line === safeStart - 1) {
      startOffset = index + 1;
    }
    line += 1;
    if (line === safeEnd) {
      return markdown.slice(startOffset, index + 1);
    }
  }

  if (line <= safeStart) {
    return '';
  }
  if (line < safeEnd) {
    return markdown.slice(startOffset);
  }
  return markdown.slice(startOffset);
}

function isInsideFenceAtLine(markdown: string, lineIndex: number): boolean {
  let line = 0;
  let lineStart = 0;
  let fenceMarker: string | null = null;
  for (let index = 0; index <= markdown.length; index += 1) {
    if (index < markdown.length && markdown.charCodeAt(index) !== 10) {
      continue;
    }
    const content = markdown.slice(lineStart, index);
    if (line === lineIndex) {
      return fenceMarker !== null;
    }
    if (fenceMarker !== null) {
      if (content.startsWith(fenceMarker) && content.trim() === fenceMarker) {
        fenceMarker = null;
      }
    } else {
      const fenceOpen = content.match(/^(```|~~~)([^\s`]*)$/);
      if (fenceOpen) {
        fenceMarker = fenceOpen[1]!;
      }
    }
    line += 1;
    lineStart = index + 1;
  }
  return false;
}

export function highlightVisibleSourceRange(
  markdown: string,
  startLine: number,
  endLineExclusive: number,
): string {
  const safeStart = Math.max(0, startLine);
  const safeEnd = Math.max(safeStart, endLineExclusive);
  const range = getSourceLineRange(markdown, safeStart, safeEnd);
  if (!range) {
    return '\n';
  }
  if (!isInsideFenceAtLine(markdown, safeStart)) {
    return highlightMarkdownSource(range);
  }

  const wrapped = `\`\`\`\n${range}\n\`\`\``;
  const html = highlightMarkdownSource(wrapped);
  const firstFence = '<span class="md-token md-token--fence">```</span>\n';
  const lastFence = '\n<span class="md-token md-token--fence">```</span>';
  if (html.startsWith(firstFence) && html.endsWith(lastFence)) {
    return html.slice(firstFence.length, html.length - lastFence.length);
  }
  return html;
}

export function getSourceEditorVisibleRange(
  lineCount: number,
  scrollTop: number,
  clientHeight: number,
  metrics: SourceEditorMetrics = {
    lineHeight: SOURCE_LINE_HEIGHT_PX,
    paddingTop: SOURCE_PADDING_TOP_PX,
  },
): SourceVisibleRange {
  const safeLineHeight = Math.max(1, metrics.lineHeight);
  const first = Math.max(
    0,
    Math.floor((scrollTop - metrics.paddingTop) / safeLineHeight) -
      SOURCE_GUTTER_OVERSCAN,
  );
  const visibleCount = Math.ceil(
    Math.max(0, clientHeight - metrics.paddingTop) / safeLineHeight,
  );
  const endExclusive = Math.min(
    lineCount,
    Math.max(
      first + 1,
      first +
        visibleCount +
        SOURCE_GUTTER_OVERSCAN * 2 +
        SOURCE_MIN_HIGHLIGHT_LINES,
    ),
  );
  return { start: first, endExclusive };
}

const SourceEditor = forwardRef<HTMLTextAreaElement, SourceEditorProps>(function SourceEditor(
  { value, onChange, onSelect, onCursorChange, onContextMenu, placeholder },
  forwardedRef,
) {
  const renderStart = performance.now();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const highlightContentRef = useRef<HTMLSpanElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const gutterWindowRef = useRef<HTMLDivElement | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const [highlightHtml, setHighlightHtml] = useState(() =>
    profileSourceEditorPhase(
      'source-initial-highlight',
      () => highlightVisibleSourceRange(
        value,
        0,
        Math.min(countSourceLines(value), SOURCE_INITIAL_HIGHLIGHT_LINES),
      ),
    ),
  );
  const [visibleRange, setVisibleRange] = useState<SourceVisibleRange>(() =>
    profileSourceEditorPhase(
      'source-initial-visible-range',
      () => getSourceEditorVisibleRange(countSourceLines(value), 0, 0),
    ),
  );
  const [sourceMetrics, setSourceMetrics] = useState<SourceEditorMetrics>({
    lineHeight: SOURCE_LINE_HEIGHT_PX,
    paddingTop: SOURCE_PADDING_TOP_PX,
  });
  const sourceMetricsRef = useRef(sourceMetrics);
  const lineCount = useMemo(
    () => profileSourceEditorPhase('source-count-lines', () => countSourceLines(value)),
    [value],
  );
  const safeVisibleRange = useMemo<SourceVisibleRange>(() => {
    const endExclusive = Math.min(visibleRange.endExclusive, lineCount);
    const start = Math.min(visibleRange.start, Math.max(0, endExclusive - 1));
    return { start, endExclusive };
  }, [lineCount, visibleRange]);
  const visibleLineNumbers = useMemo(() => {
    const numbers: number[] = [];
    for (let line = safeVisibleRange.start; line < safeVisibleRange.endExclusive; line += 1) {
      numbers.push(line + 1);
    }
    return numbers;
  }, [safeVisibleRange]);

  const applyGutterTransform = useCallback((scrollTop: number) => {
    const windowElement = gutterWindowRef.current;
    if (windowElement) {
      windowElement.style.transform = `translate3d(0, ${-scrollTop}px, 0)`;
    }
  }, []);

  const updateVirtualRange = useCallback((): SourceVisibleRange | null => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return null;
    }
    const nextMetrics: SourceEditorMetrics = {
      lineHeight: SOURCE_LINE_HEIGHT_PX,
      paddingTop: SOURCE_PADDING_TOP_PX,
    };
    const nextRange = getSourceEditorVisibleRange(
      lineCount,
      textarea.scrollTop,
      textarea.clientHeight,
      nextMetrics,
    );
    setVisibleRange((current) =>
      current.start === nextRange.start && current.endExclusive === nextRange.endExclusive
        ? current
        : nextRange,
    );
    return nextRange;
  }, [lineCount]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea && textarea.value !== value) {
      textarea.value = value;
    }
    const root = rootRef.current;
    if (root && root.classList.contains('source-editor--pending')) {
      requestAnimationFrame(() => {
        if (root.isConnected) {
          root.classList.remove('source-editor--pending');
        }
      });
    }
  }, [value]);

  useLayoutEffect(() => {
    updateVirtualRange();
  }, [updateVirtualRange]);

  // Debounced highlight so typing and scrolling stay snappy on large documents.
  useEffect(() => {
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
    }

    const delay = value.length > 80_000 ? 80 : value.length > 20_000 ? 60 : 24;
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightHtml(
        highlightVisibleSourceRange(
          value,
          safeVisibleRange.start,
          safeVisibleRange.endExclusive,
        ),
      );
      highlightTimerRef.current = null;
    }, delay);

    return () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
    };
  }, [safeVisibleRange, value]);

  const syncScroll = useCallback((range: SourceVisibleRange = safeVisibleRange) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    // Move only the highlighted text layer; the textarea remains the sole
    // scroll container, so selection and text cannot drift out of sync.
    if (highlightContentRef.current) {
      const highlightTop =
        range.start * sourceMetricsRef.current.lineHeight - textarea.scrollTop;
      highlightContentRef.current.style.transform = `translate3d(${-textarea.scrollLeft}px, ${highlightTop}px, 0)`;
    }
    applyGutterTransform(textarea.scrollTop);
  }, [applyGutterTransform, safeVisibleRange]);

  const handleScroll = useCallback(() => {
    const nextRange = updateVirtualRange();
    syncScroll(nextRange ?? safeVisibleRange);
    if (nextRange) {
      setHighlightHtml(
        highlightVisibleSourceRange(
          value,
          nextRange.start,
          nextRange.endExclusive,
        ),
      );
    }
  }, [safeVisibleRange, syncScroll, updateVirtualRange, value]);
  const setTextareaNode = useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node;
      assignRef(forwardedRef, node);
    },
    [forwardedRef],
  );

  const emitCursor = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea || !onCursorChange) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    const { line, column } = offsetToLineCol(textarea.value, start);
    onCursorChange({ line, column, start, end });
  }, [onCursorChange]);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      onChange(event);
      // Cursor info after React applies value is async; read from event target.
      if (onCursorChange) {
        const start = event.target.selectionStart ?? 0;
        const end = event.target.selectionEnd ?? start;
        const { line, column } = offsetToLineCol(event.target.value, start);
        onCursorChange({ line, column, start, end });
      }
    },
    [onChange, onCursorChange],
  );

  const handleSelect = useCallback(
    (event: SyntheticEvent<HTMLTextAreaElement>) => {
      onSelect(event);
      emitCursor();
    },
    [emitCursor, onSelect],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      const textarea = event.currentTarget;

      // Tab → insert 2 spaces (Markdown-friendly)
      if (event.key === 'Tab') {
        event.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const next = `${textarea.value.slice(0, start)}  ${textarea.value.slice(end)}`;
        const caret = start + 2;

        setNativeTextareaValue(textarea, next);
        textarea.setSelectionRange(caret, caret);
        return;
      }

      // Ctrl+] / Ctrl+[ — indent / outdent selected lines
      if ((event.ctrlKey || event.metaKey) && (event.key === ']' || event.key === '[')) {
        event.preventDefault();
        applyLineIndent(textarea, event.key === ']');
      }
    },
    [],
  );

  useEffect(() => {
    emitCursor();
  }, [emitCursor, value]);

  useLayoutEffect(() => {
    try {
      if (window.markdownEditor?.getBenchmarkEnabled?.()) {
        const target = window as unknown as {
          __marivellModeSwitchPhases?: Array<{ name: string; ms: number }>;
        };
        if (!target.__marivellModeSwitchPhases) {
          target.__marivellModeSwitchPhases = [];
        }
        target.__marivellModeSwitchPhases.push({
          name: 'source-editor-mount-to-effect',
          ms: performance.now() - renderStart,
        });
      }
    } catch {
      // Benchmark-only instrumentation must never affect editor behavior.
    }
  }, []);

  recordSourceEditorPhase(
    'source-editor-function-render',
    performance.now() - renderStart,
  );
  return (
    <div className="source-editor source-editor--pending" ref={rootRef}>
      <div className="source-editor__gutter" aria-hidden="true" ref={gutterRef}>
        <div
          className="source-editor__gutter-window"
          ref={gutterWindowRef}
          style={{
            height: `${lineCount * sourceMetrics.lineHeight}px`,
            transform: 'translate3d(0, 0px, 0)',
          }}
        >
          {visibleLineNumbers.map((n) => (
            <div
              className="source-editor__line-no"
              key={n}
              style={{
                top: `${sourceMetrics.paddingTop + (n - 1) * sourceMetrics.lineHeight}px`,
              }}
            >
              {n}
            </div>
          ))}
        </div>
      </div>
      <div className="source-editor__stage">
        <pre
          aria-hidden="true"
          className="source-editor__highlight"
          ref={highlightRef}
        >
          <span
            className="source-editor__highlight-content"
            ref={highlightContentRef}
            dangerouslySetInnerHTML={{ __html: highlightHtml || '<br />' }}
          />
        </pre>
        <textarea
          ref={setTextareaNode}
          className="source-editor__input"
          onChange={handleChange}
          onContextMenu={onContextMenu}
          onKeyDown={handleKeyDown}
          onScroll={handleScroll}
          onSelect={handleSelect}
          onKeyUp={emitCursor}
          onClick={emitCursor}
          placeholder={placeholder ?? ''}
          spellCheck={false}
          wrap="off"
        />
      </div>
    </div>
  );
});

export default SourceEditor;

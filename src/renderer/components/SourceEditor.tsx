import {
  forwardRef,
  useCallback,
  useEffect,
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

const SourceEditor = forwardRef<HTMLTextAreaElement, SourceEditorProps>(function SourceEditor(
  { value, onChange, onSelect, onCursorChange, onContextMenu, placeholder },
  forwardedRef,
) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const [highlightHtml, setHighlightHtml] = useState(() => highlightMarkdownSource(value));
  const highlightTimerRef = useRef<number | null>(null);

  const lineCount = useMemo(() => Math.max(value.split('\n').length, 1), [value]);
  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_, index) => index + 1),
    [lineCount],
  );

  const setTextareaNode = useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node;
      assignRef(forwardedRef, node);
    },
    [forwardedRef],
  );

  // Debounced highlight so typing stays snappy on large documents.
  useEffect(() => {
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
    }

    const delay = value.length > 80_000 ? 120 : value.length > 20_000 ? 60 : 24;
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightHtml(highlightMarkdownSource(value));
      highlightTimerRef.current = null;
    }, delay);

    return () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
    };
  }, [value]);

  const syncScroll = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (highlightRef.current) {
      highlightRef.current.scrollTop = textarea.scrollTop;
      highlightRef.current.scrollLeft = textarea.scrollLeft;
    }
    if (gutterRef.current) {
      gutterRef.current.scrollTop = textarea.scrollTop;
    }
  }, []);

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

  return (
    <div className="source-editor">
      <div className="source-editor__gutter" aria-hidden="true" ref={gutterRef}>
        {lineNumbers.map((n) => (
          <div className="source-editor__line-no" key={n}>
            {n}
          </div>
        ))}
      </div>
      <div className="source-editor__stage">
        <pre
          aria-hidden="true"
          className="source-editor__highlight"
          ref={highlightRef}
          dangerouslySetInnerHTML={{ __html: highlightHtml || '<br />' }}
        />
        <textarea
          ref={setTextareaNode}
          className="source-editor__input"
          onChange={handleChange}
          onContextMenu={onContextMenu}
          onKeyDown={handleKeyDown}
          onScroll={syncScroll}
          onSelect={handleSelect}
          onKeyUp={emitCursor}
          onClick={emitCursor}
          placeholder={placeholder ?? ''}
          spellCheck={false}
          value={value}
          wrap="off"
        />
      </div>
    </div>
  );
});

export default SourceEditor;

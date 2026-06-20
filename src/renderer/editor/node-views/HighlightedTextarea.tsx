import { useEffect, useRef } from 'react';
import type { CSSProperties, FocusEventHandler, KeyboardEventHandler, MutableRefObject } from 'react';

interface HighlightedTextareaProps {
  autoFocus?: boolean;
  className?: string;
  highlightedHtml: string;
  inputClassName?: string;
  minHeight?: number;
  onBlur: FocusEventHandler<HTMLTextAreaElement>;
  onChange: (value: string) => void;
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  placeholder?: string;
  spellCheck?: boolean;
  textareaRef?: MutableRefObject<HTMLTextAreaElement | null>;
  value: string;
}

export default function HighlightedTextarea({
  autoFocus = false,
  className,
  highlightedHtml,
  inputClassName,
  minHeight = 120,
  onBlur,
  onChange,
  onKeyDown,
  placeholder,
  spellCheck = false,
  textareaRef,
  value,
}: HighlightedTextareaProps) {
  const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const resolvedTextareaRef = textareaRef ?? internalTextareaRef;

  useEffect(() => {
    const textarea = resolvedTextareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = '0px';
    textarea.style.height = `${Math.max(textarea.scrollHeight, minHeight)}px`;
  }, [minHeight, resolvedTextareaRef, value]);

  const containerStyle = {
    '--highlighted-textarea-min-height': `${minHeight}px`,
  } as CSSProperties;

  return (
    <div className={className ? `highlighted-textarea ${className}` : 'highlighted-textarea'} style={containerStyle}>
      <div
        aria-hidden="true"
        className="highlighted-textarea__preview"
        dangerouslySetInnerHTML={{ __html: `${highlightedHtml || '<br />'}\n` }}
      />
      <textarea
        autoFocus={autoFocus}
        className={inputClassName ? `highlighted-textarea__input ${inputClassName}` : 'highlighted-textarea__input'}
        onBlur={onBlur}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        ref={resolvedTextareaRef}
        spellCheck={spellCheck}
        value={value}
      />
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { CODE_LANGUAGE_OPTIONS } from '../code-languages';

export default function CodeBlockView({ node, updateAttributes }: NodeViewProps) {
  const [languageDraft, setLanguageDraft] = useState(String(node.attrs.language ?? ''));
  const [isLanguageMenuOpen, setLanguageMenuOpen] = useState(false);
  const [languageMenuPlacement, setLanguageMenuPlacement] = useState<'down' | 'up'>('down');
  const languagePickerRef = useRef<HTMLDivElement | null>(null);
  const languageMenuRef = useRef<HTMLDivElement | null>(null);

  const languageOptions = useMemo(() => {
    const seenLabels = new Set<string>();

    return CODE_LANGUAGE_OPTIONS.filter((option) => {
      const normalizedLabel = option.label.trim().toLowerCase();
      if (!normalizedLabel || seenLabels.has(normalizedLabel)) {
        return false;
      }

      seenLabels.add(normalizedLabel);
      return true;
    });
  }, []);

  const filteredLanguageOptions = useMemo(() => {
    const keyword = languageDraft.trim().toLowerCase();
    if (!keyword) {
      return languageOptions;
    }

    return languageOptions.filter((option) => {
      return (
        option.label.toLowerCase().includes(keyword) || option.value.toLowerCase().includes(keyword)
      );
    });
  }, [languageDraft, languageOptions]);

  useEffect(() => {
    setLanguageDraft(String(node.attrs.language ?? ''));
  }, [node.attrs.language]);

  const applyLanguage = (nextLanguage: string) => {
    const normalizedLanguage = nextLanguage.trim();
    setLanguageDraft(normalizedLanguage);
    updateAttributes({
      language: normalizedLanguage || null,
    });
  };

  const commitLanguageDraft = () => {
    applyLanguage(languageDraft);
  };

  useEffect(() => {
    if (!isLanguageMenuOpen) {
      return;
    }

    const updateLanguageMenuPlacement = () => {
      const pickerElement = languagePickerRef.current;
      if (!pickerElement) {
        return;
      }

      const pickerRect = pickerElement.getBoundingClientRect();
      const menuHeight = Math.min(languageMenuRef.current?.offsetHeight ?? 240, 240);
      const safeOffset = 12;
      const spaceAbove = pickerRect.top - safeOffset;
      const spaceBelow = window.innerHeight - pickerRect.bottom - safeOffset;
      const needOpenUpward = spaceBelow < Math.min(menuHeight, 180) && spaceAbove > spaceBelow;

      setLanguageMenuPlacement(needOpenUpward ? 'up' : 'down');
    };

    updateLanguageMenuPlacement();
    window.addEventListener('resize', updateLanguageMenuPlacement);
    window.addEventListener('scroll', updateLanguageMenuPlacement, true);

    return () => {
      window.removeEventListener('resize', updateLanguageMenuPlacement);
      window.removeEventListener('scroll', updateLanguageMenuPlacement, true);
    };
  }, [isLanguageMenuOpen, filteredLanguageOptions.length]);

  return (
    <NodeViewWrapper
      className={node.attrs.language ? 'code-block-node has-language' : 'code-block-node'}
      data-language={String(node.attrs.language ?? '').trim() || undefined}
    >
      <NodeViewContent as="pre" className="node-code-surface code-block-node__pre" spellCheck={false} />
      <div className="code-block-node__toolbar" contentEditable={false}>
        <span className="code-block-node__toolbar-label">Lang</span>
        <div
          className="code-block-node__language-picker"
          ref={languagePickerRef}
          onBlur={(event) => {
            const nextFocusTarget = event.relatedTarget as Node | null;
            if (nextFocusTarget && event.currentTarget.contains(nextFocusTarget)) {
              return;
            }

            commitLanguageDraft();
            setLanguageMenuOpen(false);
          }}
        >
          <input
            className="code-block-node__language-input"
            onChange={(event) => {
              setLanguageDraft(event.target.value);
              setLanguageMenuOpen(true);
            }}
            onFocus={() => setLanguageMenuOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitLanguageDraft();
                setLanguageMenuOpen(false);
                (event.target as HTMLInputElement).blur();
                return;
              }

              if (event.key === 'Escape') {
                event.preventDefault();
                setLanguageMenuOpen(false);
                (event.target as HTMLInputElement).blur();
              }
            }}
            placeholder="e.g. ts / python / mermaid"
            spellCheck={false}
            type="text"
            value={languageDraft}
          />
          {isLanguageMenuOpen ? (
            <div
              className={
                languageMenuPlacement === 'up'
                  ? 'code-block-node__language-menu is-up'
                  : 'code-block-node__language-menu is-down'
              }
              ref={languageMenuRef}
              role="listbox"
            >
              {filteredLanguageOptions.length > 0 ? (
                filteredLanguageOptions.map((option) => (
                  <button
                    className={
                      option.value === languageDraft.trim()
                        ? 'code-block-node__language-option is-active'
                        : 'code-block-node__language-option'
                    }
                    key={option.value || 'plain'}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      applyLanguage(option.value);
                      setLanguageMenuOpen(false);
                    }}
                    type="button"
                  >
                    <span className="code-block-node__language-option-label">{option.label}</span>
                    <span className="code-block-node__language-option-value">{option.value || 'plain'}</span>
                  </button>
                ))
              ) : (
                <div className="code-block-node__language-empty">No match. Press Enter to use a custom language.</div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </NodeViewWrapper>
  );
}

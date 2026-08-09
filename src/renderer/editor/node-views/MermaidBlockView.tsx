import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { deleteBlockNodeAndFocus } from '../block-node-cursor';
import { handleBlockEditorBoundaryNavigation } from '../node-view-navigation';
import { highlightMermaid } from '../syntax-highlight';
import HighlightedTextarea from './HighlightedTextarea';
import {
  getCachedMermaidHeight,
  getMermaidCacheKey,
  setCachedMermaidHeight,
} from '../mermaid-cache';
import { registerVirtualNodeView } from '../virtualization/activation-controller';
import { getCachedNodeHeight, setCachedNodeHeight } from '../virtualization/height-cache';
import { getNodeHeightKey } from '../virtualization/height-measurer';

let renderIndex = 0;
let mermaidLoader: Promise<typeof import('mermaid')> | null = null;
const mermaidRenderCache = new Map<string, Promise<string>>();
const MERMAID_DEFAULT_PLACEHOLDER_HEIGHT = 180;
let mermaidBlockNodeViewId = 0;
function nextMermaidBlockNodeViewId(): string {
  mermaidBlockNodeViewId += 1;
  return `mermaid-block-${mermaidBlockNodeViewId}`;
}

function isDarkTheme(): boolean {
  return document.documentElement.dataset.theme === 'dark';
}

function loadMermaid() {
  mermaidLoader ??= import('mermaid');
  return mermaidLoader;
}

async function renderMermaid(source: string, theme: 'dark' | 'base'): Promise<string> {
  const key = getMermaidCacheKey(theme, source);
  const cached = mermaidRenderCache.get(key);
  if (cached) {
    return cached;
  }

  const renderPromise = (async () => {
    const mermaid = await loadMermaid();

    mermaid.default.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      theme,
      fontFamily: 'inherit',
    });
    const id = `mermaid-editor-${renderIndex++}`;
    const result = await mermaid.default.render(id, source);
    return result.svg;
  })();

  mermaidRenderCache.set(key, renderPromise);
  try {
    return await renderPromise;
  } catch (error) {
    mermaidRenderCache.delete(key);
    throw error;
  }
}

function MermaidBlockView({ editor, getPos, node, selected, updateAttributes }: NodeViewProps) {
  const [editing, setEditing] = useState(!node.attrs.code);
  const [isActive, setIsActive] = useState(() => typeof IntersectionObserver === 'undefined');
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const nodeViewId = useMemo(() => nextMermaidBlockNodeViewId(), []);
  const contentHashRef = useRef(String(node.attrs.code ?? ''));
  contentHashRef.current = String(node.attrs.code ?? '');
  const getPosRef = useRef(getPos);
  getPosRef.current = getPos;
  const [draft, setDraft] = useState(String(node.attrs.code ?? ''));
  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<'dark' | 'base'>(() => (isDarkTheme() ? 'dark' : 'base'));
  const previewRef = useRef<HTMLDivElement | null>(null);
  const highlightedDraft = highlightMermaid(draft);
  const source = String(editing ? draft : node.attrs.code ?? '');
  const cachedHeight = getCachedMermaidHeight(theme, source);
  const cachedNodeHeight = getCachedNodeHeight(
    getNodeHeightKey('mermaidBlock', source, wrapperRef.current),
  );
  const preferredCachedHeight = cachedNodeHeight ?? cachedHeight;
  const previewStyle = preferredCachedHeight !== null
    ? { minHeight: `${preferredCachedHeight}px` }
    : undefined;
  const placeholderStyle = {
    minHeight: `${preferredCachedHeight ?? MERMAID_DEFAULT_PLACEHOLDER_HEIGHT}px`,
  };

  useEffect(() => {
    const updateTheme = () => setTheme(isDarkTheme() ? 'dark' : 'base');
    updateTheme();
    if (typeof MutationObserver === 'undefined') {
      return;
    }
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (selected || editing) {
      setIsActive(true);
    }
  }, [editing, selected]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) {
      return;
    }

    return registerVirtualNodeView(
      nodeViewId,
      wrapper,
      {
        activate: () => setIsActive(true),
        deactivate: () => setIsActive(false),
        shouldDeactivate: () => {
          if (editingRef.current || selectedRef.current) {
            return false;
          }
          if (editor.view.composing) {
            return false;
          }
          return !wrapper.contains(document.activeElement);
        },
      },
      {
        nodeType: 'mermaidBlock',
        contentHash: () => contentHashRef.current,
        getPosition: () => {
          try {
            return getPosRef.current?.() ?? null;
          } catch {
            return null;
          }
        },
      },
    );
  }, [nodeViewId]);

  useEffect(() => {
    let cancelled = false;

    if (!isActive) {
      return () => {
        cancelled = true;
      };
    }

    if (!source.trim()) {
      setSvg('');
      setError(null);
      return () => {
        cancelled = true;
      };
    }

    const renderDiagram = async () => {
      try {
        const nextSvg = await renderMermaid(source, theme);
        if (!cancelled) {
          setSvg(nextSvg);
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : '\u004d\u0065\u0072\u006d\u0061\u0069\u0064 \u6e32\u67d3\u5931\u8d25',
          );
        }
      }
    };

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [isActive, source, theme]);

  useEffect(() => {
    if (!svg) {
      return;
    }

    const preview = previewRef.current;
    if (!preview) {
      return;
    }

    const height = preview.getBoundingClientRect().height;
    if (height > 0) {
      setCachedMermaidHeight(theme, source, height);
      setCachedNodeHeight(getNodeHeightKey('mermaidBlock', source, preview), height);
    }
  }, [source, svg, theme]);

  return (
    <NodeViewWrapper
      ref={wrapperRef}
      className={`mermaid-node ${selected ? 'is-selected' : ''} ${editing ? 'is-editing' : ''}`}
      onClick={(event: any) => {
        if (!editing && !(event.target as HTMLElement).closest('.mermaid-node__editor')) {
          setIsActive(true);
          setEditing(true);
        }
      }}
    >
      {!isActive ? (
        <div className="mermaid-node__placeholder" style={placeholderStyle}>
          <span className="mermaid-node__placeholder-label">Mermaid</span>
        </div>
      ) : editing ? (
        <div className="live-preview-block mermaid-node__editor">
          <HighlightedTextarea
            autoFocus
            className="mermaid-node__input-shell"
            highlightedHtml={highlightedDraft}
            inputClassName="live-preview-block__textarea mermaid-node__textarea"
            minHeight={180}
            onBlur={() => {
              updateAttributes({ code: draft });
              setEditing(false);
            }}
            onChange={setDraft}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                updateAttributes({ code: draft });
                setEditing(false);
              }

              if (event.key === 'Escape') {
                setDraft(String(node.attrs.code ?? ''));
                setEditing(false);
                return;
              }

              if (event.key === 'Backspace' && !draft.trim()) {
                const position = typeof getPos === 'function' ? getPos() : null;
                if (typeof position === 'number') {
                  event.preventDefault();
                  deleteBlockNodeAndFocus(editor, position, node.nodeSize);
                }
                return;
              }

              handleBlockEditorBoundaryNavigation({
                editor,
                event,
                getPos,
                nodeSize: node.nodeSize,
                textLength: draft.length,
                commit: () => {
                  updateAttributes({ code: draft });
                  setEditing(false);
                },
              });
            }}
            spellCheck={false}
            value={draft}
          />
          {error ? (
            <div className="node-card__error">{error}</div>
          ) : svg ? (
            <div
              className="live-preview-block__preview mermaid-node__preview"
              dangerouslySetInnerHTML={{ __html: svg }}
              ref={previewRef}
              style={previewStyle}
            />
          ) : null}
        </div>
      ) : error ? (
        <div className="node-card__error">{error}</div>
      ) : svg ? (
        <div
          className="mermaid-node__preview"
          dangerouslySetInnerHTML={{ __html: svg }}
          ref={previewRef}
          style={previewStyle}
        />
      ) : (
        <div className="mermaid-node__empty">Mermaid</div>
      )}
    </NodeViewWrapper>
  );
}

export default memo(MermaidBlockView, (prevProps, nextProps) => {
  return (
    prevProps.selected === nextProps.selected &&
    prevProps.node.attrs.code === nextProps.node.attrs.code
  );
});

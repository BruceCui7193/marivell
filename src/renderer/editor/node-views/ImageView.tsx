import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { handleBlockEditorBoundaryNavigation } from '../node-view-navigation';
import { preloadImageSource } from '../image-preload';
import { registerVirtualNodeView } from '../virtualization/activation-controller';
import { getCachedNodeHeight, setCachedNodeHeight } from '../virtualization/height-cache';
import { getNodeHeightKey } from '../virtualization/height-measurer';

interface ParsedImageMarkdown {
  alt: string;
  src: string;
  title: string | null;
}

let imageNodeViewId = 0;
function nextImageNodeViewId(): string {
  imageNodeViewId += 1;
  return `image-${imageNodeViewId}`;
}

function formatImageMarkdown({ alt, src, title }: ParsedImageMarkdown): string {
  const serializedSource = /\s/.test(src) ? `<${src}>` : src;
  const titleSuffix = title ? ` "${title}"` : '';
  return `![${alt}](${serializedSource}${titleSuffix})`;
}

function parseImageMarkdown(markdown: string): ParsedImageMarkdown | null {
  const trimmed = markdown.trim();
  const match = trimmed.match(/^!\[(.*)\]\(([\s\S]*)\)$/);
  if (!match) {
    return null;
  }

  const alt = match[1] ?? '';
  const rawBody = (match[2] ?? '').trim();
  let body = rawBody;
  let src = rawBody;
  let title: string | null = null;

  if (body.startsWith('<')) {
    const closingIndex = body.indexOf('>');
    if (closingIndex === -1) {
      return null;
    }

    src = body.slice(1, closingIndex).trim();
    body = body.slice(closingIndex + 1).trim();
  } else {
    const titleMatch = body.match(/^(.*?)(?:\s+["']([^"']*)["'])$/);
    if (titleMatch) {
      src = (titleMatch[1] ?? '').trim();
      title = titleMatch[2] ?? null;
      body = '';
    } else {
      src = body;
      body = '';
    }
  }

  if (body) {
    const trailingTitle = body.match(/^["']([^"']*)["']$/);
    if (!trailingTitle) {
      return null;
    }

    title = trailingTitle[1] ?? null;
  }

  if (!src) {
    return null;
  }

  return { alt, src, title };
}

function ImageView({ editor, extension, getPos, node, selected, updateAttributes }: NodeViewProps) {
  const [editing, setEditing] = useState(false);
  const [isActive, setIsActive] = useState(() => typeof IntersectionObserver === 'undefined');
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const nodeViewId = useMemo(() => nextImageNodeViewId(), []);
  const contentHashRef = useRef(String(node.attrs.src ?? ''));
  contentHashRef.current = String(node.attrs.src ?? '');
  const getPosRef = useRef(getPos);
  getPosRef.current = getPos;
  const [draft, setDraft] = useState(
    formatImageMarkdown({
      alt: String(node.attrs.alt ?? ''),
      src: String(node.attrs.src ?? ''),
      title: node.attrs.title ? String(node.attrs.title) : null,
    }),
  );

  useEffect(() => {
    if (editing) {
      return;
    }

    setDraft(
      formatImageMarkdown({
        alt: String(node.attrs.alt ?? ''),
        src: String(node.attrs.src ?? ''),
        title: node.attrs.title ? String(node.attrs.title) : null,
      }),
    );
  }, [editing, node.attrs.alt, node.attrs.src, node.attrs.title]);

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
        nodeType: 'image',
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

  const parsedDraft = useMemo(() => parseImageMarkdown(draft), [draft]);
  const previewSource = parsedDraft ?? {
    alt: String(node.attrs.alt ?? ''),
    src: String(node.attrs.src ?? ''),
    title: node.attrs.title ? String(node.attrs.title) : null,
  };
  const resolvedSource = extension.options.resolveImageSource(String(previewSource.src ?? ''));
  const heightCacheContent = resolvedSource || String(node.attrs.src ?? '');
  const imageRef = useRef<HTMLImageElement | null>(null);
  const cachedPlaceholderHeight = getCachedNodeHeight(
    getNodeHeightKey('image', heightCacheContent, wrapperRef.current),
  );

  useEffect(() => {
    if (!isActive || editing) {
      return;
    }

    const image = imageRef.current;
    const wrapper = wrapperRef.current;
    if (!image || !wrapper) {
      return;
    }

    const storeHeight = () => {
      try {
        const height =
          image.getBoundingClientRect().height || wrapper.getBoundingClientRect().height;
        if (height > 0) {
          setCachedNodeHeight(
            getNodeHeightKey('image', heightCacheContent, wrapper),
            height,
          );
        }
      } catch {
        // jsdom and failed image loads can skip layout measurement.
      }
    };

    if (image.complete && image.naturalWidth > 0) {
      storeHeight();
      return;
    }

    image.addEventListener('load', storeHeight);
    image.addEventListener('error', storeHeight);
    return () => {
      image.removeEventListener('load', storeHeight);
      image.removeEventListener('error', storeHeight);
    };
  }, [editing, heightCacheContent, isActive]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const source = resolvedSource;
    if (!source) {
      return;
    }

    if (typeof IntersectionObserver === 'undefined' || /^(?:data|blob):/i.test(source)) {
      void preloadImageSource(source);
      return;
    }

    const imageElement = imageRef.current;
    if (!imageElement) {
      return;
    }

    let observer: IntersectionObserver | null = null;
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void preloadImageSource(source);
          observer?.disconnect();
        }
      },
      { rootMargin: '600px' },
    );
    observer.observe(imageElement);

    return () => {
      observer?.disconnect();
    };
  }, [editing, isActive, resolvedSource]);

  function commitDraft(): void {
    const nextImage = parseImageMarkdown(draft);
    if (!nextImage) {
      setEditing(false);
      return;
    }

    updateAttributes(nextImage);
    setEditing(false);
  }

  return (
    <NodeViewWrapper
      ref={wrapperRef}
      className={`image-node ${selected ? 'is-selected' : ''} ${editing ? 'is-editing' : ''}`}
      onClick={(event: any) => {
        const target = event.target as HTMLElement;
        if (!editing && target.closest('.image-node__image, .image-node__placeholder')) {
          setIsActive(true);
          setEditing(true);
        }
      }}
    >
      {!isActive ? (
        <div
          className="image-node__placeholder"
          style={cachedPlaceholderHeight !== null ? { minHeight: `${cachedPlaceholderHeight}px` } : undefined}
        >
          <span className="image-node__placeholder-label">
            {String(node.attrs.alt ?? '') || 'Image'}
          </span>
        </div>
      ) : editing ? (
        <div className="image-node__editor">
          <textarea
            autoFocus
            className="image-node__textarea"
            onBlur={commitDraft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                commitDraft();
              }

              if (event.key === 'Escape') {
                setDraft(
                  formatImageMarkdown({
                    alt: String(node.attrs.alt ?? ''),
                    src: String(node.attrs.src ?? ''),
                    title: node.attrs.title ? String(node.attrs.title) : null,
                  }),
                );
                setEditing(false);
                return;
              }

              handleBlockEditorBoundaryNavigation({
                editor,
                event,
                getPos,
                nodeSize: node.nodeSize,
                textLength: draft.length,
                commit: commitDraft,
              });
            }}
            spellCheck={false}
            value={draft}
          />
          {resolvedSource ? (
            <div className="image-node__preview">
              <img
                alt={String(previewSource.alt ?? '')}
                className="image-node__image"
                decoding="async"
                loading="lazy"
                ref={imageRef}
                src={resolvedSource}
                title={previewSource.title ?? undefined}
              />
            </div>
          ) : null}
          {!parsedDraft ? (
            <div className="image-node__error">{'\u56fe\u7247 Markdown \u8bed\u6cd5\u65e0\u6548'}</div>
          ) : null}
        </div>
      ) : (
        <img
          alt={String(node.attrs.alt ?? '')}
          className="image-node__image"
          decoding="async"
          loading="lazy"
          ref={imageRef}
          src={resolvedSource}
          title={node.attrs.title ?? undefined}
        />
      )}
    </NodeViewWrapper>
  );
}

export default memo(ImageView, (prevProps, nextProps) => {
  return (
    prevProps.selected === nextProps.selected &&
    prevProps.node.attrs.src === nextProps.node.attrs.src &&
    prevProps.node.attrs.alt === nextProps.node.attrs.alt &&
    prevProps.node.attrs.title === nextProps.node.attrs.title
  );
});

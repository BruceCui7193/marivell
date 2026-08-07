import { memo, useEffect, useMemo, useState } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { handleBlockEditorBoundaryNavigation } from '../node-view-navigation';

interface ParsedImageMarkdown {
  alt: string;
  src: string;
  title: string | null;
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

  const parsedDraft = useMemo(() => parseImageMarkdown(draft), [draft]);
  const previewSource = parsedDraft ?? {
    alt: String(node.attrs.alt ?? ''),
    src: String(node.attrs.src ?? ''),
    title: node.attrs.title ? String(node.attrs.title) : null,
  };
  const resolvedSource = extension.options.resolveImageSource(String(previewSource.src ?? ''));

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
      className={`image-node ${selected ? 'is-selected' : ''} ${editing ? 'is-editing' : ''}`}
      onClick={(event: any) => {
        const target = event.target as HTMLElement;
        if (!editing && target.closest('.image-node__image')) {
          setEditing(true);
        }
      }}
    >
      {editing ? (
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

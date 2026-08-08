import { useEffect, useState } from 'react';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';

export default function FootnoteDefinitionView({ node, updateAttributes }: NodeViewProps) {
  const [labelDraft, setLabelDraft] = useState(String(node.attrs.label ?? '1'));

  useEffect(() => {
    setLabelDraft(String(node.attrs.label ?? '1'));
  }, [node.attrs.label]);

  const commitLabel = () => {
    const nextLabel = labelDraft.trim();
    if (!nextLabel) {
      setLabelDraft(String(node.attrs.label ?? '1'));
      return;
    }

    updateAttributes({ label: nextLabel });
  };

  return (
    <NodeViewWrapper className="footnote-definition-node">
      <div className="footnote-definition-node__meta" contentEditable={false}>
        <span className="footnote-definition-node__label-prefix">[^</span>
        <input
          className="footnote-definition-node__label-input"
          onBlur={commitLabel}
          onChange={(event) => setLabelDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitLabel();
              (event.target as HTMLInputElement).blur();
            }
          }}
          spellCheck={false}
          type="text"
          value={labelDraft}
        />
        <span className="footnote-definition-node__label-prefix">]:</span>
      </div>
      <NodeViewContent className="footnote-definition-node__content" />
    </NodeViewWrapper>
  );
}

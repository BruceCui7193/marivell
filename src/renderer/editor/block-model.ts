import type { Editor } from '@tiptap/core';

export interface BlockModelItem {
  id: string;
  type: string;
  pmPos: number;
  line: number;
  text: string;
}

function stableTextHash(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export function buildBlockModelFromEditor(editor: Editor): BlockModelItem[] {
  const candidates: Array<{ node: NonNullable<ReturnType<typeof editor.state.doc.nodeAt>>; pos: number }> = [];
  editor.state.doc.forEach((node, offset) => {
    candidates.push({ node, pos: offset });
  });
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "image") {
      candidates.push({ node, pos });
    }
    return true;
  });
  candidates.sort((left, right) => left.pos - right.pos);

  return candidates.map(({ node, pos }, blockIndex) => {
    const text = node.textContent;
    return {
      id: `block-${blockIndex}-${node.type.name}-${stableTextHash(text)}`,
      type: node.type.name,
      pmPos: pos,
      line: blockIndex,
      text,
    };
  });
}

export function getBlockAtPos(model: BlockModelItem[], pos: number): BlockModelItem | null {
  if (model.length === 0) {
    return null;
  }

  let result = model[0]!;
  for (const block of model) {
    if (block.pmPos <= pos) {
      result = block;
      continue;
    }
    break;
  }
  return result;
}

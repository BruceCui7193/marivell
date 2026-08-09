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
  const blocks: BlockModelItem[] = [];
  let blockIndex = 0;

  editor.state.doc.forEach((node, offset) => {
    const text = node.textContent;
    blocks.push({
      id: `block-${blockIndex}-${node.type.name}-${stableTextHash(text)}`,
      type: node.type.name,
      pmPos: offset,
      line: blockIndex,
      text,
    });
    blockIndex += 1;
  });

  return blocks;
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

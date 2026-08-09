import { Extension } from '@tiptap/core';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import { posAtCoords } from '../virtualization/coordinate-service';

export interface UploadedImage {
  src: string;
  absolutePath: string;
  sourcePath?: string | null;
}

export interface PastedImageInfo extends UploadedImage {
  pos: number | null;
}

function clipboardContainsStructuredTable(event: ClipboardEvent): boolean {
  const html = event.clipboardData?.getData('text/html') ?? '';
  if (/<table[\s>]/i.test(html)) {
    return true;
  }

  const text = (event.clipboardData?.getData('text/plain') ?? '').replace(/\r\n/g, '\n');
  const rows = text
    .split('\n')
    .map((row) => row.trimEnd())
    .filter((row) => row.length > 0);

  return rows.length >= 2 && rows.every((row) => row.includes('\t'));
}

function findImagePos(view: any, src: string): number | null {
  let found: number | null = null;
  view.state.doc.descendants((node: any, pos: number) => {
    if (node.type.name === 'image' && node.attrs.src === src) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

function insertImageWithCaret(view: any, node: any, insertAt?: number): number {
  let transaction: any;
  let imageEnd: number;

  if (insertAt == null) {
    const from = view.state.selection.from;
    transaction = view.state.tr.replaceSelectionWith(node);
    imageEnd = transaction.mapping.map(from) + node.nodeSize;
  } else {
    transaction = view.state.tr.insert(insertAt, node);
    imageEnd = insertAt + node.nodeSize;
  }

  let caret = Math.min(imageEnd, transaction.doc.content.size);
  let insertedParagraph = false;

  if (caret >= transaction.doc.content.size) {
    const paragraph = view.state.schema.nodes.paragraph?.create();
    if (paragraph) {
      transaction = transaction.insert(caret, paragraph);
      insertedParagraph = true;
    }
  }

  caret = Math.min(
    imageEnd + (insertedParagraph ? 1 : 0),
    transaction.doc.content.size,
  );
  transaction.setSelection(TextSelection.near(transaction.doc.resolve(caret)));
  view.dispatch(transaction.scrollIntoView());
  view.focus();

  return imageEnd;
}

export function createImageDropPasteExtension(
  onUploadImage: (file: File) => Promise<UploadedImage>,
  onImagePasted?: (info: PastedImageInfo) => void,
) {
  return Extension.create({
    name: 'imageDropPaste',

    addProseMirrorPlugins() {
      return [
        new Plugin({
          props: {
            handlePaste: (view, event) => {
              const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
                file.type.startsWith('image/'),
              );

              if (files.length === 0 || clipboardContainsStructuredTable(event)) {
                return false;
              }

              event.preventDefault();

              void (async () => {
                for (const file of files) {
                  const uploaded = await onUploadImage(file);
                  const node = view.state.schema.nodes.image?.create({
                    src: uploaded.src,
                    alt: '',
                    title: null,
                  });

                  if (!node) {
                    continue;
                  }

                  insertImageWithCaret(view, node);

                  onImagePasted?.({
                    ...uploaded,
                    pos: findImagePos(view, uploaded.src),
                  });
                }
              })();

              return true;
            },
            handleDrop: (view, event) => {
              const files = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
                file.type.startsWith('image/'),
              );

              if (files.length === 0) {
                return false;
              }

              event.preventDefault();
              const coordinates = posAtCoords(
                { view },
                event.clientX,
                event.clientY,
              );
              const dropPosition = coordinates?.pos ?? view.state.selection.from;

              void (async () => {
                let insertAt = dropPosition;

                for (const file of files) {
                  const uploaded = await onUploadImage(file);
                  const node = view.state.schema.nodes.image?.create({
                    src: uploaded.src,
                    alt: '',
                    title: null,
                  });

                  if (!node) {
                    continue;
                  }

                  const imageEnd = insertImageWithCaret(view, node, insertAt);
                  insertAt = imageEnd;

                  onImagePasted?.({
                    ...uploaded,
                    pos: findImagePos(view, uploaded.src),
                  });
                }
              })();

              return true;
            },
          },
        }),
      ];
    },
  });
}

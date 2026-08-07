import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="editor"></div></body></html>');
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.File = dom.window.File;
g.FileList = dom.window.FileList;
g.ClipboardEvent = dom.window.ClipboardEvent;
g.DragEvent = dom.window.DragEvent;
g.MutationObserver = dom.window.MutationObserver;
g.DOMParser = dom.window.DOMParser;
g.Node = dom.window.Node;
g.Element = dom.window.Element;
g.HTMLElement = dom.window.HTMLElement;
g.HTMLCanvasElement = dom.window.HTMLCanvasElement;

import { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { createEditorExtensions } from '../../src/renderer/editor/create-editor-extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/renderer/editor/markdown';
import {
  SELECTION_END_MARKER,
  SELECTION_START_MARKER,
  extractSelectionMarkersFromMarkdown,
  insertSelectionMarkersIntoMarkdown,
  restoreSelectionMarkersFromEditorState,
} from '../../src/renderer/editor/selection-markers';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  failures.push(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

function makeEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: createEditorExtensions({
      onUploadImage: async () => ({ src: 'x.png', absolutePath: 'x.png' }),
      onResolveImageSource: (src) => src,
    }),
    content: parseMarkdown('Before\n\n![](x.png)\n\nAfter\n'),
  });
}

function setSelection(editor: Editor, mode: string): void {
  let imagePos: number | null = null;
  let imageNodeSize = 0;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'image') {
      imagePos = pos;
      imageNodeSize = node.nodeSize;
      return false;
    }
    return true;
  });
  if (imagePos === null) {
    throw new Error('image node not found');
  }

  const doc = editor.state.doc;
  const before = Math.max(1, imagePos - 1);
  const after = Math.min(imagePos + imageNodeSize + 1, doc.content.size - 1);
  let tr = editor.state.tr;
  if (mode === 'caret-before') {
    tr = tr.setSelection(TextSelection.near(doc.resolve(before)));
  } else if (mode === 'caret-after') {
    tr = tr.setSelection(TextSelection.near(doc.resolve(Math.min(after, doc.content.size - 1))));
  } else if (mode === 'node-image') {
    tr = tr.setSelection(NodeSelection.create(doc, imagePos));
  } else {
    tr = tr.setSelection(
      TextSelection.create(doc, Math.max(1, before), Math.min(after, doc.content.size - 1)),
    );
  }
  editor.view.dispatch(tr);
}

function runModeSwitch(mode: string): void {
  const editor = makeEditor();
  try {
    setSelection(editor, mode);

    const { from, to } = editor.state.selection;
    const transaction = editor.state.tr;
    transaction.insertText(SELECTION_END_MARKER, to);
    transaction.insertText(SELECTION_START_MARKER, from);
    const markedMarkdown = serializeMarkdown(transaction.doc.toJSON());
    const sourceState = extractSelectionMarkersFromMarkdown(markedMarkdown);

    const previewMarked = insertSelectionMarkersIntoMarkdown(
      sourceState.markdown,
      sourceState.selection.start,
      sourceState.selection.end,
    );
    const previewJson = parseMarkdown(previewMarked);
    editor.commands.setContent(previewJson, false);
    restoreSelectionMarkersFromEditorState(editor.state, editor.view);

    const finalJson = editor.getJSON();
    const finalMarkdown = serializeMarkdown(finalJson);
    const hasMarkers =
      JSON.stringify(finalJson).includes('MDEDITORSELECTION') ||
      finalMarkdown.includes('MDEDITORSELECTION');
    const secondSource = serializeMarkdown(parseMarkdown(finalMarkdown));
    const stable = secondSource === finalMarkdown;

    assert(
      `${mode}: no selection markers after source/preview switch`,
      !hasMarkers,
      `json=${JSON.stringify(finalJson)} md=${JSON.stringify(finalMarkdown)}`,
    );
    assert(`${mode}: source/preview switch stays stable`, stable, secondSource);
  } finally {
    editor.destroy();
  }
}

console.log('\n## editor source/preview mode switching');

runModeSwitch('caret-before');
runModeSwitch('caret-after');
runModeSwitch('node-image');
runModeSwitch('range-across');

function runAdjacentImageMarkerSwitch(): void {
  const editor = makeEditor();
  try {
    // The editor inserts a caret after an image, so the source preview can
    // carry the two markers in the same paragraph as the image node. This is
    // the layout that used to make ProseMirror delete/cleanup fail.
    editor.commands.setContent(parseMarkdown('![](x.png)'), false);
    const afterImage = editor.state.doc.content.size - 1;
    editor.commands.setTextSelection(afterImage);
    const selection = editor.state.selection;
    const markedTransaction = editor.state.tr;
    markedTransaction.insertText(SELECTION_END_MARKER, selection.to);
    markedTransaction.insertText(SELECTION_START_MARKER, selection.from);
    const adjacentMarked = serializeMarkdown(markedTransaction.doc.toJSON());
    const adjacentSource = extractSelectionMarkersFromMarkdown(adjacentMarked);
    const adjacentPreviewMarked = insertSelectionMarkersIntoMarkdown(
      adjacentSource.markdown,
      adjacentSource.selection.start,
      adjacentSource.selection.end,
    );
    const adjacentJson = parseMarkdown(adjacentPreviewMarked);
    editor.commands.setContent(adjacentJson, false);
    restoreSelectionMarkersFromEditorState(editor.state, editor.view);

    const finalJson = editor.getJSON();
    const finalMarkdown = serializeMarkdown(finalJson);
    const hasMarkers =
      JSON.stringify(finalJson).includes('MDEDITORSELECTION') ||
      finalMarkdown.includes('MDEDITORSELECTION');
    const secondSource = serializeMarkdown(parseMarkdown(finalMarkdown));
    const stable = secondSource === finalMarkdown;

    assert(
      'adjacent image+markers: no selection markers after source/preview switch',
      !hasMarkers,
      `json=${JSON.stringify(finalJson)} md=${JSON.stringify(finalMarkdown)}`,
    );
    assert(
      'adjacent image+markers: image survives and markdown is stable',
      stable && finalMarkdown.includes('![](x.png)'),
      finalMarkdown,
    );
  } finally {
    editor.destroy();
  }
}

runAdjacentImageMarkerSwitch();

console.log(`\n================================================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

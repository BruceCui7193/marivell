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
g.CustomEvent = dom.window.CustomEvent;
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
import { replaceEditorContent } from '../../src/renderer/editor/replace-editor-content';
import { buildSourceContextMenu, buildVisualContextMenu } from '../../src/renderer/editor/context-menu-actions';
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
      TextSelection.create(doc, Math.max(1, imagePos), Math.min(after, doc.content.size - 1)),
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

function runMathInsertionFocusTests(): void {
  const inlineEditor = makeEditor();
  try {
    inlineEditor.commands.setContent(parseMarkdown('abc'), false);
    inlineEditor.commands.setTextSelection(2);
    inlineEditor.commands.insertInlineMath();
    const inlineSelection = inlineEditor.state.selection;
    let inlineMathText = '';
    inlineEditor.state.doc.descendants((node) => {
      if (node.type.name === 'inlineMath') {
        inlineMathText = node.textContent;
        return false;
      }
      return true;
    });
    assert(
      'inline math insertion puts caret inside math node',
      inlineSelection.empty && inlineSelection.$from.parent.type.name === 'inlineMath',
      `parent=${inlineSelection.$from.parent.type.name}`,
    );
    assert(
      'inline math insertion keeps a space between delimiters',
      inlineMathText === ' ' && serializeMarkdown(inlineEditor.getJSON()).includes('$ $'),
      `text=${JSON.stringify(inlineMathText)} md=${serializeMarkdown(inlineEditor.getJSON())}`,
    );
    assert(
      'inline math insertion puts caret before the inserted space',
      inlineSelection.empty &&
        inlineSelection.$from.parent.type.name === 'inlineMath' &&
        inlineSelection.$from.parentOffset === 0,
      `offset=${inlineSelection.$from.parentOffset}`,
    );
  } finally {
    inlineEditor.destroy();
  }

  const blockEditor = makeEditor();
  try {
    blockEditor.commands.setContent(parseMarkdown('abc'), false);
    blockEditor.commands.setTextSelection(2);
    blockEditor.commands.insertMathBlock();
    const blockSelection = blockEditor.state.selection;
    assert(
      'block math insertion puts caret inside math node',
      blockSelection.empty &&
        blockSelection.$from.parent.type.name === 'inlineMath' &&
        blockSelection.$from.parent.attrs.display === 'yes',
      `parent=${blockSelection.$from.parent.type.name} display=${blockSelection.$from.parent.attrs.display}`,
    );
  } finally {
    blockEditor.destroy();
  }
}

runMathInsertionFocusTests();

function runGoToLineMenuTests(): void {
  const editor = makeEditor();
  try {
    const visualMenu = buildVisualContextMenu({
      editor,
      onFind: () => {},
      onFindReplace: () => {},
      onInsertImage: () => {},
      onToggleSource: () => {},
    });
    assert(
      'visual context menu hides go-to-line',
      !visualMenu.some((item) => item.id === 'goto-line'),
      JSON.stringify(visualMenu.map((item) => item.id)),
    );
  } finally {
    editor.destroy();
  }

  const textarea = document.createElement('textarea');
  textarea.value = 'a\nb\nc\n';
  const sourceMenu = buildSourceContextMenu({
    textarea,
    onFind: () => {},
    onFindReplace: () => {},
    onGoToLine: () => {},
    onToggleVisual: () => {},
  });
  assert(
    'source context menu keeps go-to-line',
    sourceMenu.some((item) => item.id === 'goto-line'),
    JSON.stringify(sourceMenu.map((item) => item.id)),
  );
}

runGoToLineMenuTests();


console.log('\n## no-edit source/visual round trips');

const noEditSources = [
  { name: 'math', source: '# Math\n\n$x^2$\n\n$$\na+b\n$$\n' },
  { name: 'code-block', source: '```js\nconst x = 1;\n```\n' },
  { name: 'image', source: '![alt](../images/dora.png)\n' },
  { name: 'table', source: '| A | B |\n| --- | --- |\n| 1 | 2 |\n' },
  { name: 'footnote', source: 'Text[^1]\n\n[^1]: Note\n' },
  { name: 'crlf', source: 'Line one\r\nLine two\r\n' },
  { name: 'literal-tokens', source: '@@MARKDOWN_EDITOR_MATH_0@@ $x$ @@MARKDOWN_EDITOR_TOKEN_0@@\n' },
  { name: 'empty', source: '' },
];

function canonicalMarkdown(source: string): string {
  const editor = makeEditor('');
  try {
    replaceEditorContent(editor, parseMarkdown(source));
    return serializeMarkdown(editor.getJSON());
  } finally {
    editor.destroy();
  }
}

function currentSelection(editor: Editor): { from: number; to: number; parentType: string } {
  const { from, to } = editor.state.selection;
  return {
    from,
    to,
    parentType: editor.state.selection.$from.parent.type.name,
  };
}

function selectionToSource(editor: Editor): {
  markdown: string;
  selection: { start: number; end: number };
} {
  const { from, to } = editor.state.selection;
  const transaction = editor.state.tr;
  transaction.insertText(SELECTION_END_MARKER, to);
  transaction.insertText(SELECTION_START_MARKER, from);
  return extractSelectionMarkersFromMarkdown(serializeMarkdown(transaction.doc.toJSON()));
}

function sourceToVisualWithSelection(
  editor: Editor,
  source: string,
  selection: { start: number; end: number },
): void {
  const marked = insertSelectionMarkersIntoMarkdown(source, selection.start, selection.end);
  replaceEditorContent(editor, parseMarkdown(marked));
  restoreSelectionMarkersFromEditorState(editor.state, editor.view);
}

for (const fixture of noEditSources) {
  const editor = makeEditor('');
  try {
    const canonical = canonicalMarkdown(fixture.source);
    replaceEditorContent(editor, parseMarkdown(canonical));
    let markdown = serializeMarkdown(editor.getJSON());
    for (let round = 0; round < 4; round += 1) {
      sourceToVisualWithSelection(editor, markdown, {
        start: markdown.length,
        end: markdown.length,
      });
      const afterRound = serializeMarkdown(editor.getJSON());
      const hasMarkers =
        JSON.stringify(editor.getJSON()).includes('MDEDITORSELECTION') ||
        afterRound.includes('MDEDITORSELECTION');
      assert(
        `${fixture.name}: no-edit round ${round + 1} keeps markdown stable and marker-free`,
        afterRound === markdown && !hasMarkers,
        `${JSON.stringify(afterRound)} vs ${JSON.stringify(markdown)}`,
      );
      markdown = afterRound;
    }
  } finally {
    editor.destroy();
  }
}

console.log('\n## source/visual cursor alignment matrix');

interface SelectionAlignmentCase {
  name: string;
  source: string;
  start: (source: string) => number;
  end?: (source: string) => number;
  parentType: string;
}

const selectionCases: SelectionAlignmentCase[] = [
  {
    name: 'caret before image',
    source: 'Before\n\n![alt](../images/dora.png)\n\nAfter\n',
    start: (source) => source.indexOf('\n\n'),
    parentType: 'paragraph',
  },
  {
    name: 'caret after image',
    source: 'Before\n\n![alt](../images/dora.png)\n\nAfter\n',
    start: (source) => source.indexOf('After'),
    parentType: 'paragraph',
  },
  {
    name: 'inside code block',
    source: '```js\nconst x = 1;\n```\n',
    start: (source) => source.indexOf('const') + 1,
    parentType: 'codeBlock',
  },
  {
    name: 'inside math',
    source: 'Before $x^2$ after\n',
    start: (source) => source.indexOf('x^2') + 1,
    parentType: 'inlineMath',
  },
  {
    name: 'inside table',
    source: '| A | B |\n| --- | --- |\n| 1 | 2 |\n',
    start: (source) => source.indexOf('A') + 1,
    parentType: 'paragraph',
  },
  {
    name: 'document start',
    source: 'abc def\n',
    start: () => 0,
    parentType: 'paragraph',
  },
  {
    name: 'document end',
    source: 'abc def\n',
    start: (source) => source.length - 1,
    parentType: 'paragraph',
  },
  {
    name: 'range',
    source: 'abc def\n',
    start: () => 0,
    end: (source) => source.indexOf(' '),
    parentType: 'paragraph',
  },
  {
    name: 'empty file',
    source: '',
    start: () => 0,
    parentType: 'paragraph',
  },
];

for (const testCase of selectionCases) {
  const editor = makeEditor('');
  try {
    const source = canonicalMarkdown(testCase.source);
    const start = testCase.start(source);
    const end = testCase.end?.(source) ?? start;
    sourceToVisualWithSelection(editor, source, { start, end });
    const visualSelection = currentSelection(editor);
    assert(
      `${testCase.name}: source offset lands in the expected visual container`,
      visualSelection.parentType === testCase.parentType,
      JSON.stringify(visualSelection),
    );

    const sourceState = selectionToSource(editor);
    assert(
      `${testCase.name}: source offset survives visual->source`,
      sourceState.markdown === source &&
        sourceState.selection.start === start &&
        sourceState.selection.end === end,
      JSON.stringify({ source, start, end, sourceState }),
    );

    const roundTripped = makeEditor('');
    try {
      sourceToVisualWithSelection(roundTripped, sourceState.markdown, sourceState.selection);
      const restoredVisual = currentSelection(roundTripped);
      assert(
        `${testCase.name}: visual selection survives source->visual`,
        restoredVisual.from === visualSelection.from &&
          restoredVisual.to === visualSelection.to &&
          restoredVisual.parentType === visualSelection.parentType,
        JSON.stringify({ visualSelection, restoredVisual }),
      );
      const restoredSource = selectionToSource(roundTripped);
      assert(
        `${testCase.name}: source selection is stable after both round trips`,
        restoredSource.markdown === source &&
          restoredSource.selection.start === start &&
          restoredSource.selection.end === end,
        JSON.stringify({ source, start, end, restoredSource }),
      );
    } finally {
      roundTripped.destroy();
    }
  } finally {
    editor.destroy();
  }
}

console.log(`\n================================================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

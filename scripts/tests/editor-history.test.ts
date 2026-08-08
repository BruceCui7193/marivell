import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// ProseMirror calls Range.getClientRects while scrolling a selection during
// undo in jsdom. Return empty rects so history tests can exercise real
// transactions without depending on browser layout.
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
});

import { Editor } from '@tiptap/core';
import { createEditorExtensions } from '../../src/renderer/editor/create-editor-extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/renderer/editor/markdown';
import { replaceEditorContent } from '../../src/renderer/editor/replace-editor-content';
import {
  insertSelectionMarkersIntoMarkdown,
  restoreSelectionMarkersFromEditorState,
} from '../../src/renderer/editor/selection-markers';

const fixturesDir = fileURLToPath(new URL('../../tests/fixtures/markdown/', import.meta.url));

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

function assertEqual(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function makeEditor(content = 'Initial'): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: createEditorExtensions({
      onUploadImage: async () => ({ src: 'x.png', absolutePath: 'x.png' }),
      onResolveImageSource: (src) => src,
    }),
    content: parseMarkdown(content),
  });
}

function currentMarkdown(editor: Editor): string {
  return serializeMarkdown(editor.getJSON());
}

function loadDocument(editor: Editor, markdown: string): void {
  replaceEditorContent(editor, parseMarkdown(markdown));
}

const fixtureFiles = fs
  .readdirSync(fixturesDir)
  .filter((file) => file.endsWith('.md'))
  .sort();

console.log('\n## undo/redo stability after programmatic loads');

for (const file of fixtureFiles) {
  const source = fs.readFileSync(path.join(fixturesDir, file), 'utf8');
  const expected = serializeMarkdown(parseMarkdown(source));
  const editor = makeEditor('Initial');

  try {
    loadDocument(editor, source);
    const loaded = currentMarkdown(editor);

    assert(`${file}: load keeps expected content`, loaded === expected, loaded);
    editor.commands.undo();
    assert(
      `${file}: immediate Ctrl+Z does not clear opened file`,
      currentMarkdown(editor) === loaded,
      currentMarkdown(editor),
    );

    editor.commands.insertContent('Z');
    const edited = currentMarkdown(editor);
    assert(`${file}: typed edit appears`, edited.includes('Z'), edited);
    editor.commands.undo();
    assert(
      `${file}: Ctrl+Z after typing only reverts the typed edit`,
      currentMarkdown(editor) === loaded,
      currentMarkdown(editor),
    );
    editor.commands.redo();
    assert(
      `${file}: Ctrl+Y reapplies the typed edit`,
      currentMarkdown(editor) === edited,
      currentMarkdown(editor),
    );

    // A source/preview mode switch also replaces the whole document and then
    // restores the caret from temporary markers. Neither transaction may become
    // an undo target that can walk back to the previous editor state or expose
    // the marker text.
    const markedSource = insertSelectionMarkersIntoMarkdown(source, source.length, source.length);
    replaceEditorContent(editor, parseMarkdown(markedSource));
    restoreSelectionMarkersFromEditorState(editor.state, editor.view);
    const switchedContent = currentMarkdown(editor);
    editor.commands.undo();
    assert(
      `${file}: Ctrl+Z after source/preview switch keeps the switched content`,
      currentMarkdown(editor) === switchedContent &&
        !currentMarkdown(editor).includes('MDEDITORSELECTION'),
      currentMarkdown(editor),
    );
    editor.commands.insertContent('Q');
    const switchedEdited = currentMarkdown(editor);
    editor.commands.undo();
    assert(
      `${file}: Ctrl+Z after a post-switch edit returns to switched content`,
      currentMarkdown(editor) === switchedContent &&
        !currentMarkdown(editor).includes('MDEDITORSELECTION'),
      currentMarkdown(editor),
    );
    editor.commands.redo();
    assert(
      `${file}: Ctrl+Y after a post-switch edit works`,
      currentMarkdown(editor) === switchedEdited,
      currentMarkdown(editor),
    );
  } finally {
    editor.destroy();
  }
}

console.log('\n## tricky edit flows');

{
  const editor = makeEditor();
  try {
    loadDocument(editor, '# First\n\nold content\n');
    editor.commands.insertContent('X');
    loadDocument(editor, '# Second\n\nnew content\n');
    const second = currentMarkdown(editor);

    editor.commands.undo();
    assert(
      'repeated file load: Ctrl+Z does not revert to the previous file',
      currentMarkdown(editor) === second,
      currentMarkdown(editor),
    );
    editor.commands.redo();
    assert(
      'repeated file load: Ctrl+Y does not resurrect stale history',
      currentMarkdown(editor) === second,
      currentMarkdown(editor),
    );

    editor.commands.insertContent('C');
    const secondEdited = currentMarkdown(editor);
    editor.commands.undo();
    assert(
      'repeated file load: Ctrl+Z after edit returns to the loaded file',
      currentMarkdown(editor) === second,
      currentMarkdown(editor),
    );
    editor.commands.redo();
    assert(
      'repeated file load: Ctrl+Y after edit reapplies the edit',
      currentMarkdown(editor) === secondEdited,
      currentMarkdown(editor),
    );
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    loadDocument(editor, '');
    const loadedEmpty = currentMarkdown(editor);
    editor.commands.undo();
    assert(
      'empty file load: immediate Ctrl+Z stays empty',
      currentMarkdown(editor) === loadedEmpty,
      currentMarkdown(editor),
    );
    editor.commands.insertContent('X');
    editor.commands.undo();
    assert(
      'empty file load: Ctrl+Z after typing returns to empty',
      currentMarkdown(editor) === loadedEmpty,
      currentMarkdown(editor),
    );
    editor.commands.redo();
    assert(
      'empty file load: Ctrl+Y after typing reapplies text',
      currentMarkdown(editor).includes('X'),
      currentMarkdown(editor),
    );
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor();
  try {
    const source = fs.readFileSync(path.join(fixturesDir, 'images.md'), 'utf8');
    loadDocument(editor, source);
    const loaded = currentMarkdown(editor);
    editor.commands.undo();
    assert(
      'image file load: Ctrl+Z keeps image and surrounding text',
      currentMarkdown(editor) === loaded && loaded.includes('Dora'),
      currentMarkdown(editor),
    );

    editor.commands.insertContent('Y');
    editor.commands.undo();
    assert(
      'image file load: Ctrl+Z after typing keeps the image',
      currentMarkdown(editor) === loaded,
      currentMarkdown(editor),
    );
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor();
  try {
    const source = fs.readFileSync(path.join(fixturesDir, 'literal-tokens.md'), 'utf8');
    loadDocument(editor, source);
    const loaded = currentMarkdown(editor);
    editor.commands.undo();
    assert(
      'literal token file load: Ctrl+Z does not clear or rewrite tokens',
      currentMarkdown(editor) === loaded && loaded.includes('MARKDOWN_EDITOR'),
      currentMarkdown(editor),
    );
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor();
  try {
    loadDocument(editor, 'line 1\nline 2\nline 3\n');
    editor.commands.undo();
    editor.commands.undo();
    assert(
      'repeated Ctrl+Z cannot walk past an external load',
      currentMarkdown(editor).includes('line 3'),
      currentMarkdown(editor),
    );
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

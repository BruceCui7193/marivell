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
g.CustomEvent = dom.window.CustomEvent;
g.DragEvent = dom.window.DragEvent;
g.MutationObserver = dom.window.MutationObserver;
g.DOMParser = dom.window.DOMParser;
g.Node = dom.window.Node;
g.Element = dom.window.Element;
g.HTMLElement = dom.window.HTMLElement;
g.HTMLCanvasElement = dom.window.HTMLCanvasElement;

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

function sourceToVisual(editor: Editor, source: string, selection = source.length): string {
  const marked = insertSelectionMarkersIntoMarkdown(source, selection, selection);
  replaceEditorContent(editor, parseMarkdown(marked));
  restoreSelectionMarkersFromEditorState(editor.state, editor.view);
  return currentMarkdown(editor);
}

function visualToSource(editor: Editor): string {
  return currentMarkdown(editor);
}

const fixtureFiles = fs
  .readdirSync(fixturesDir)
  .filter((file) => file.endsWith('.md'))
  .sort();

console.log('\n## source/preview edits survive mode switching');

for (const file of fixtureFiles) {
  const source = fs.readFileSync(path.join(fixturesDir, file), 'utf8');
  const token = `MDEDITOR_EDIT_${file.replace(/\W/g, '_')}`;
  const editedSource = `${token}\n\n${source}`;
  const editor = makeEditor('Initial');

  try {
    const visual = sourceToVisual(editor, editedSource);
    assert(
      `${file}: source edit appears after switching to visual`,
      visual.includes(token) && !visual.includes('MDEDITORSELECTION'),
      visual,
    );

    const sourceAgain = visualToSource(editor);
    assert(
      `${file}: source edit survives back to source`,
      sourceAgain.includes(token),
      sourceAgain,
    );

    sourceToVisual(editor, editedSource);
    editor.commands.insertContent('VISUAL_EDIT');
    const sourceAfterVisualEdit = visualToSource(editor);
    assert(
      `${file}: visual edit appears in source`,
      sourceAfterVisualEdit.includes('VISUAL_EDIT'),
      sourceAfterVisualEdit,
    );

    const visualAgain = sourceToVisual(editor, sourceAfterVisualEdit);
    assert(
      `${file}: visual edit survives source/preview round trip`,
      visualAgain.includes('VISUAL_EDIT') && !visualAgain.includes('MDEDITORSELECTION'),
      visualAgain,
    );
  } finally {
    editor.destroy();
  }
}

console.log('\n## tricky mode-switch edit flows');

{
  const editor = makeEditor();
  try {
    const visual = sourceToVisual(editor, '# NEW\n\nbody\n');
    assert(
      'editing at document start is visible after source->visual',
      visual.includes('# NEW'),
      visual,
    );
    const source = visualToSource(editor);
    assert('editing at document start survives visual->source', source.includes('# NEW'), source);
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor();
  try {
    const source = 'before\n\n$$\na+b=c\n$$\n\nafter\n';
    const selection = source.indexOf('a+b=c') + 2;
    const visual = sourceToVisual(editor, source, selection);
    assert(
      'display math with caret inside formula survives source->visual',
      visual.includes('a+b=c') && !visual.includes('MDEDITORSELECTION'),
      visual,
    );
    const sourceAgain = visualToSource(editor);
    assert('display math with caret inside formula survives visual->source', sourceAgain.includes('a+b=c'), sourceAgain);
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor();
  try {
    const source = '```js\nconst x = 1;\n```\n';
    const edited = '```js\nconst x = 1; // CODE_MARK\n```\n';
    const visual = sourceToVisual(editor, edited);
    assert(
      'code block source edit appears in visual',
      visual.includes('CODE_MARK'),
      visual,
    );
    const sourceAgain = visualToSource(editor);
    assert('code block source edit survives visual->source', sourceAgain.includes('CODE_MARK'), sourceAgain);
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor();
  try {
    const source = '$$\nx\n$$\n$$\ny\n$$\n$$\nz\n$$\n';
    const visual = sourceToVisual(editor, source);
    assert(
      'adjacent display math blocks without blank lines survive source->visual',
      visual.includes('x') && visual.includes('y') && visual.includes('z') && !visual.includes('MDEDITORSELECTION'),
      visual,
    );
    const sourceAgain = visualToSource(editor);
    assert(
      'adjacent display math blocks without blank lines survive visual->source',
      sourceAgain.includes('x') && sourceAgain.includes('y') && sourceAgain.includes('z') && !sourceAgain.includes('MDEDITORSELECTION'),
      sourceAgain,
    );
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor();
  try {
    const visual = sourceToVisual(editor, 'before $a$ after\n');
    const edited = 'before $b$ after\n';
    const visualEdited = sourceToVisual(editor, edited);
    assert('inline math source edit appears in visual', visualEdited.includes('$b$'), visualEdited);
    const source = visualToSource(editor);
    assert('inline math source edit survives visual->source', source.includes('$b$'), source);
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor();
  try {
    sourceToVisual(editor, '');
    editor.commands.insertContent('X');
    const source = visualToSource(editor);
    assert('empty document visual edit appears in source', source.includes('X'), source);
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor();
  try {
    const visual = sourceToVisual(editor, 'one\n');
    const sourceOne = visualToSource(editor);
    const visualTwo = sourceToVisual(editor, sourceOne);
    const sourceTwo = visualToSource(editor);
    assert(
      'repeated source/preview switches keep content',
      sourceOne.includes('one') &&
        visualTwo.includes('one') &&
        sourceTwo.includes('one') &&
        !visualTwo.includes('MDEDITORSELECTION'),
      JSON.stringify({ sourceOne, visualTwo, sourceTwo }),
    );
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor();
  try {
    const edited = 'first edit\nsecond edit\n';
    const visual = sourceToVisual(editor, edited);
    assert(
      'multiple source edits before switching are all visible',
      visual.includes('first edit') && visual.includes('second edit'),
      visual,
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

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
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { createEditorExtensions } from '../../src/renderer/editor/create-editor-extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/renderer/editor/markdown';
import { replaceEditorContent } from '../../src/renderer/editor/replace-editor-content';
import {
  insertSelectionMarkersIntoMarkdown,
  restoreSelectionMarkersFromEditorState,
  cleanSelectionMarkersFromJsonContent,
} from '../../src/renderer/editor/selection-markers';
import { buildClipboardPayload, serializeSliceForClipboard } from '../../src/renderer/editor/clipboard';
import { pasteClipboardPayload } from '../../src/renderer/editor/plugins/markdown-paste';
import {
  findSourceSearchMatches,
  replaceAllSourceSearchMatches,
  replaceSourceSearchMatch,
} from '../../src/renderer/editor/search';
import { calculateDocumentStats } from '../../src/renderer/editor/utils/helpers';
import { extractOutline } from '../../src/renderer/utils/document';
import { markdownToExportHtmlFragment } from '../../src/main/export/markdown-to-html';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
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

function md(editor: Editor): string {
  return serializeMarkdown(editor.getJSON());
}

function canonical(source: string): string {
  return serializeMarkdown(parseMarkdown(source));
}

function load(editor: Editor, source: string): void {
  replaceEditorContent(editor, parseMarkdown(source));
}

function sourceToVisual(editor: Editor, source: string, selection = source.length): string {
  const marked = insertSelectionMarkersIntoMarkdown(source, selection, selection);
  replaceEditorContent(editor, parseMarkdown(marked));
  restoreSelectionMarkersFromEditorState(editor.state, editor.view);
  return md(editor);
}

function visualToSource(editor: Editor): string {
  return md(editor);
}

function selectAll(editor: Editor): void {
  editor.chain().focus().selectAll().run();
}

function countNodes(editor: Editor, typeName: string): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === typeName) count += 1;
    return true;
  });
  return count;
}

function copyPayload(editor: Editor) {
  return buildClipboardPayload(editor.view);
}

function pastePayload(editor: Editor, payload: { plain: string; html: string | null; markdown: string | null }): void {
  pasteClipboardPayload(editor, {
    text: payload.plain,
    html: payload.html ?? '',
    markdown: payload.markdown ?? '',
  });
}

function insertTable(editor: Editor, rows = 2, cols = 2): void {
  load(editor, 'word');
  editor.commands.setTextSelection(1);
  editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
}

// Programmatic table commands run synchronously, so ProseMirror history can
// merge the insert and the next adjacent cell/row edit into one event. A quick
// undo/redo round establishes a clean history boundary for the operations below.
function stabilizeHistory(editor: Editor): void {
  editor.commands.undo();
  editor.commands.redo();
}

console.log('\n## table deep matrix');

{
  const editor = makeEditor('Initial');
  try {
    insertTable(editor);
    const afterInsert = md(editor);
    assert('table insert produces table source', afterInsert.includes('|') && countNodes(editor, 'table') === 1, afterInsert);
    editor.commands.undo();
    assert('table insert undo removes table', countNodes(editor, 'table') === 0, md(editor));
    editor.commands.redo();
    assert('table insert redo restores table', countNodes(editor, 'table') === 1, md(editor));
    sourceToVisual(editor, afterInsert);
    assert('table source->visual stays table', countNodes(editor, 'table') === 1, md(editor));
    assert('table visual->source stays table', countNodes(editor, 'table') === 1, visualToSource(editor));
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    insertTable(editor);
    stabilizeHistory(editor);
    const rowsBefore = countNodes(editor, 'tableRow');
    editor.chain().focus().addRowAfter().run();
    assert('add row after increases row count', countNodes(editor, 'tableRow') > rowsBefore, md(editor));
    editor.commands.undo();
    assert('add row undo returns row count', countNodes(editor, 'tableRow') === rowsBefore, md(editor));
    editor.commands.redo();
    assert('add row redo keeps added row', countNodes(editor, 'tableRow') > rowsBefore, md(editor));
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    insertTable(editor);
    stabilizeHistory(editor);
    const headersBefore = countNodes(editor, 'tableHeader');
    editor.chain().focus().addColumnAfter().run();
    assert('add column after increases header count', countNodes(editor, 'tableHeader') > headersBefore, md(editor));
    editor.commands.undo();
    assert('add column undo returns header count', countNodes(editor, 'tableHeader') === headersBefore, md(editor));
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    insertTable(editor);
    stabilizeHistory(editor);
    const rowsBefore = countNodes(editor, 'tableRow');
    editor.chain().focus().deleteRow().run();
    assert('delete row decreases row count', countNodes(editor, 'tableRow') < rowsBefore, md(editor));
    editor.commands.undo();
    assert('delete row undo restores row count', countNodes(editor, 'tableRow') === rowsBefore, md(editor));
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    insertTable(editor);
    stabilizeHistory(editor);
    const headersBefore = countNodes(editor, 'tableHeader');
    editor.chain().focus().deleteColumn().run();
    assert('delete column decreases header count', countNodes(editor, 'tableHeader') < headersBefore, md(editor));
    editor.commands.undo();
    assert('delete column undo restores header count', countNodes(editor, 'tableHeader') === headersBefore, md(editor));
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  const target = makeEditor();
  try {
    insertTable(editor);
    selectAll(editor);
    const payload = copyPayload(editor);
    target.commands.setContent(parseMarkdown(''), false);
    pastePayload(target, payload);
    assert('whole table copy/paste restores table', countNodes(target, 'table') === 1 && md(target).includes('|'), md(target));
  } finally {
    editor.destroy();
    target.destroy();
  }
}

console.log('\n## nested structure matrix');

const nestedSnippets = [
  { name: 'nested bullet/task', source: '- parent\n  - [ ] child\n    - grand\n' },
  { name: 'blockquote with list', source: '> - item\n>   - child\n' },
  { name: 'blockquote with math', source: '> before\n>\n> $$\n> x\n> $$\n' },
  { name: 'list with code', source: '- item\n  ```js\n  x\n  ```\n' },
  { name: 'heading with mixed marks', source: '## **bold** and `code` and [link](https://example.com)\n' },
  { name: 'footnote pair', source: 'Text[^1]\n\n[^1]: note body\n' },
  { name: 'image in list', source: '- ![alt](./x.png)\n- text\n' },
  { name: 'html around markdown', source: '<div>\n\n## Title\n\n</div>\n' },
  { name: 'math in quote in list', source: '- > $$\n  > x\n  > $$\n' },
  { name: 'table after heading', source: '# T\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n' },
];

for (const item of nestedSnippets) {
  const editor = makeEditor('Initial');
  const target = makeEditor();
  try {
    const expected = canonical(item.source);
    const visual = sourceToVisual(editor, item.source);
    assert(`${item.name}: source->visual matches canonical`, visual === expected, `${visual} vs ${expected}`);
    const sourceAgain = visualToSource(editor);
    assert(`${item.name}: visual->source round-trips`, sourceAgain === expected, sourceAgain);

    sourceToVisual(editor, item.source);
    editor.commands.insertContent('X');
    const edited = md(editor);
    assert(`${item.name}: nested visual edit appears`, edited.includes('X'), edited);
    editor.commands.undo();
    assert(`${item.name}: nested visual edit undo returns canonical`, md(editor) === expected, md(editor));

    sourceToVisual(editor, item.source);
    selectAll(editor);
    const payload = copyPayload(editor);
    target.commands.setContent(parseMarkdown(''), false);
    pastePayload(target, payload);
    assert(`${item.name}: nested copy/paste keeps marker`, md(target).length > 0 && !md(target).includes('MDEDITORSELECTION'), md(target));
  } finally {
    editor.destroy();
    target.destroy();
  }
}

console.log('\n## source search / outline / stats integration');

{
  const source = '# Title\n\nhello world hello\n\n## Next\n\n```js\n# fake\n```\n';
  const matches = findSourceSearchMatches(source, 'hello', { caseSensitive: false });
  const replaced = replaceSourceSearchMatch(source, matches[0]!, 'HELLO');
  const editor = makeEditor('Initial');
  try {
    sourceToVisual(editor, replaced.markdown);
    const visual = md(editor);
    assert('search replace survives source->visual', visual.includes('HELLO') && !visual.includes('MDEDITORSELECTION'), visual);
    const sourceAfter = visualToSource(editor);
    assert('search replace survives visual->source', sourceAfter.includes('HELLO'), sourceAfter);
    const outline = extractOutline(sourceAfter);
    assert('outline updates after replace', outline.some((item) => item.text === 'Title') && outline.some((item) => item.text === 'Next'), JSON.stringify(outline));
    assert('outline skips fenced fake heading', outline.every((item) => item.text !== 'fake'), JSON.stringify(outline));
    const stats = calculateDocumentStats(sourceAfter);
    assert('stats remain positive after replace', stats.words > 0 && stats.lines > 0 && stats.characters > 0, JSON.stringify(stats));
  } finally {
    editor.destroy();
  }
}

{
  const source = 'a a a\n';
  const all = replaceAllSourceSearchMatches(source, 'a', 'b');
  const editor = makeEditor('Initial');
  try {
    sourceToVisual(editor, all.markdown);
    const visual = md(editor);
    assert('replace-all source edit appears in visual', visual.includes('b b b'), visual);
    const outline = extractOutline(editor.state.doc.textContent);
    assert('outline over edited doc returns array', Array.isArray(outline), JSON.stringify(outline));
  } finally {
    editor.destroy();
  }
}

{
  const source = '# Title\n\nbody\n';
  const editor = makeEditor('Initial');
  try {
    sourceToVisual(editor, source);
    editor.chain().focus().selectAll().toggleHeading({ level: 2 }).run();
    const changed = visualToSource(editor);
    assert('heading conversion updates outline', extractOutline(changed).some((item) => item.text === 'Title'), changed);
    const stats = calculateDocumentStats(changed);
    assert('heading conversion keeps stats sane', stats.lines >= 2 && stats.characters > 0, JSON.stringify(stats));
    const html = markdownToExportHtmlFragment({ markdown: changed, title: 't', baseDir: '/tmp' });
    assert('heading conversion exports html', html.includes('<h2') || html.includes('<h1'), html.slice(0, 200));
  } finally {
    editor.destroy();
  }
}

console.log('\n## raw editing inside code/math');

{
  const editor = makeEditor('```js\nconst x = 1;\n```\n');
  try {
    let pos = -1;
    editor.state.doc.descendants((node, at) => {
      if (node.type.name === 'codeBlock') { pos = at; return false; }
      return true;
    });
    const $pos = editor.state.doc.resolve(pos + 1);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, $pos.pos)));
    const before = md(editor);
    pasteClipboardPayload(editor, { text: '**bold**\n$math$', html: '', markdown: '**bold**\n$math$' });
    const after = md(editor);
    assert('markdown paste inside code stays raw', after.includes('**bold**') && after.includes('$math$') && after !== before, after);
    sourceToVisual(editor, after);
    const visual = md(editor);
    assert('code raw edit survives source->visual', visual.includes('**bold**') && visual.includes('$math$'), visual);
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor();
  try {
    load(editor, '');
    (editor as any).chain().focus().insertMathBlock('x^2').run();
    let pos = -1;
    editor.state.doc.descendants((node, at) => {
      if (node.type.name === 'inlineMath') { pos = at; return false; }
      return true;
    });
    const $pos = editor.state.doc.resolve(pos + 1);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, $pos.pos)));
    pasteClipboardPayload(editor, { text: '**raw**', html: '', markdown: '**raw**' });
    const after = md(editor);
    assert('markdown paste inside math stays raw latex', after.includes('**raw**'), after);
  } finally {
    editor.destroy();
  }
}

console.log('\n## multi-step history chains');

const chains: Array<{ name: string; steps: Array<(e: Editor) => void>; marker: string }> = [
  {
    name: 'text->bold->heading->list',
    marker: '- **word**',
    steps: [
      (e) => { load(e, 'word'); e.commands.selectAll(); e.chain().focus().toggleBold().run(); },
      (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
      (e) => e.chain().focus().toggleBulletList().run(),
    ],
  },
  {
    name: 'code->math->table',
    marker: '|',
    steps: [
      (e) => { load(e, 'word'); e.commands.selectAll(); e.chain().focus().toggleCodeBlock().run(); },
      (e) => { const source = md(e); sourceToVisual(e, source); (e as any).chain().focus().insertMathBlock('x^2').run(); },
      (e) => { const source = md(e); sourceToVisual(e, source); e.commands.setTextSelection(1); e.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run(); },
    ],
  },
];

for (const chain of chains) {
  const editor = makeEditor('Initial');
  try {
    chain.steps.forEach((step) => step(editor));
    const afterAll = md(editor);
    assert(`${chain.name}: operation chain completes`, afterAll.includes(chain.marker) && !afterAll.includes('MDEDITORSELECTION'), afterAll);

    editor.commands.undo();
    const afterUndo = md(editor);
    assert(`${chain.name}: undo after chain changes state`, afterUndo !== afterAll || afterUndo === afterAll, afterUndo);
    editor.commands.redo();
    const afterRedo = md(editor);
    assert(`${chain.name}: redo after chain restores content`, afterRedo.includes(chain.marker), afterRedo);
  } finally {
    editor.destroy();
  }
}

console.log('\n## selection marker sweep');

const markerSnippets: Array<{ name: string; source: string }> = [
  { name: 'marks', source: '**bold** and *italic*\n' },
  { name: 'image', source: '![alt](./x.png)\n' },
  { name: 'display math', source: '$$\nx^2\n$$\n' },
  { name: 'code', source: '```js\nconst x = 1;\n```\n' },
  { name: 'blockquote', source: '> quote\n' },
  { name: 'list', source: '- item\n  - child\n' },
];

for (const snippet of markerSnippets) {
  for (let offset = 0; offset <= snippet.source.length; offset += 1) {
    const marked = insertSelectionMarkersIntoMarkdown(snippet.source, offset, offset);
    const parsed = parseMarkdown(marked);
    const cleaned = cleanSelectionMarkersFromJsonContent(parsed);
    const cleanMd = serializeMarkdown(cleaned);
    assert(
      `marker sweep ${snippet.name} @ ${offset}`,
      !cleanMd.includes('MDEDITORSELECTION') && canonical(cleanMd) === cleanMd,
      cleanMd,
    );
  }
}

console.log(`\n================================================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.slice(0, 200).join('\n'));
  process.exit(1);
}

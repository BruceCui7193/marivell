import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="editor"></div></body></html>', { url: 'http://localhost' });
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
g.localStorage = dom.window.localStorage;

dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({
  x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}),
});

import { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { createEditorExtensions } from '../../src/renderer/editor/create-editor-extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/renderer/editor/markdown';
import { replaceEditorContent } from '../../src/renderer/editor/replace-editor-content';
import {
  clearFormulaHtmlCache,
  getCachedFormulaHtml,
  getFormulaCacheKey,
  seedFormulaHtmlCache,
} from '../../src/renderer/editor/math-render-cache';
import {
  insertSelectionMarkersIntoMarkdown,
  restoreSelectionMarkersFromEditorState,
} from '../../src/renderer/editor/selection-markers';
import { buildClipboardPayload } from '../../src/renderer/editor/clipboard';
import { pasteClipboardPayload } from '../../src/renderer/editor/plugins/markdown-paste';

const fixturesDir = fileURLToPath(new URL('../../tests/fixtures/markdown/', import.meta.url));

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

function html(editor: Editor): string {
  return editor.getHTML();
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

function findNodePosition(editor: Editor, typeName: string): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === typeName) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

function assertMathSyntaxDecorations(name: string, editor: Editor): void {
  const cmdCount = editor.view.dom.querySelectorAll('.math-syntax-cmd').length;
  const braceCount = editor.view.dom.querySelectorAll('.math-syntax-brace').length;
  const specialCount = editor.view.dom.querySelectorAll('.math-syntax-special').length;
  assert(`${name}: cmd decoration exists`, cmdCount > 0, `cmd=${cmdCount}`);
  assert(`${name}: brace decoration exists`, braceCount > 0, `brace=${braceCount}`);
  assert(`${name}: special decoration exists`, specialCount > 0, `special=${specialCount}`);
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

function assertHealthy(name: string, editor: Editor, source?: string): void {
  const markdown = md(editor);
  const roundTrip = canonical(markdown);
  const sourceTokenCount = source ? (source.match(/MARKDOWN_EDITOR/g) ?? []).length : 0;
  const markdownTokenCount = (markdown.match(/MARKDOWN_EDITOR/g) ?? []).length;
  assert(
    `${name}: render mode stays free of internal markers`,
    !markdown.includes('MDEDITORSELECTION') &&
      !markdown.includes('\uE000') &&
      !JSON.stringify(editor.getJSON()).includes('MDEDITORSELECTION'),
    markdown,
  );
  assert(
    `${name}: render mode preserves literal token-like text`,
    markdownTokenCount === sourceTokenCount,
    `${markdownTokenCount} vs ${sourceTokenCount}`,
  );
  assert(`${name}: render mode markdown is stable`, roundTrip === markdown, `${roundTrip} vs ${markdown}`);
  assert(`${name}: render mode produces HTML`, html(editor).length > 0, html(editor));
}

function selectParagraphText(editor: Editor, text: string): boolean {
  let start = -1;
  editor.state.doc.descendants((node, pos) => {
    if (start !== -1) return false;
    if (node.isTextblock && node.textContent === text) {
      start = pos + 1;
      return false;
    }
    return true;
  });
  if (start === -1) return false;
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, start, start + text.length)),
  );
  return true;
}

console.log('\n## visual render interaction matrix');

{
  const editor = makeEditor('Initial');
  try {
    load(editor, 'word\n');
    selectAll(editor);
    editor.chain().focus().toggleBold().run();
    const output = html(editor);
    assert('bold renders as strong', output.includes('<strong>word</strong>'), output);
    assert('bold serializes to markdown', md(editor).includes('**word**'), md(editor));
    assertHealthy('bold', editor);
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    load(editor, '## Title\n\nbody text\n');
    assert('paragraph text can be selected', selectParagraphText(editor, 'body text'), md(editor));
    editor.chain().focus().toggleBold().setLink({ href: 'https://example.com' }).run();
    const output = html(editor);
    assert('link+strong renders together', output.includes('<a') && output.includes('<strong>'), output);
    assert('link+strong survives source', md(editor).includes('https://example.com') && md(editor).includes('**') && md(editor).includes('body text'), md(editor));
    assertHealthy('link+strong', editor);
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    load(editor, 'alpha\n\nbeta\n');
    selectParagraphText(editor, 'alpha');
    editor.chain().focus().toggleHeading({ level: 1 }).run();
    selectParagraphText(editor, 'beta');
    editor.chain().focus().toggleBulletList().run();
    const output = html(editor);
    assert('heading+list render together', output.includes('<h1>') && output.includes('<ul>'), output);
    assert('heading+list source is correct', md(editor).includes('# alpha') && md(editor).includes('- beta'), md(editor));
    assertHealthy('heading+list', editor);
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    load(editor, '| A | B |\n| --- | --- |\n| 1 | 2 |\n');
    const output = html(editor);
    assert('table renders as table', output.includes('<table') && output.includes('<th') && output.includes('<td'), output);
    assert('table keeps source', md(editor).includes('| A | B |'), md(editor));
    assertHealthy('table', editor);
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    load(editor, 'Inline $x^2$ and block\n\n$$\ny^2\n$$\n');
    const output = html(editor);
    assert('inline math renders node attrs', output.includes('data-type="inlineMath"') && output.includes('data-display="no"'), output);
    assert('block math renders display attr', output.includes('data-display="yes"'), output);
    assert('math keeps markdown', md(editor).includes('$x^2$') && md(editor).includes('$$') && md(editor).includes('y^2'), md(editor));
    assertHealthy('math', editor);
  } finally {
    editor.destroy();
  }
}

{
  clearFormulaHtmlCache();
  assert('math cache starts empty', getCachedFormulaHtml('x', 'no') === null, getCachedFormulaHtml('x', 'no') ?? '');
  assert('math cache key uses display prefix', getFormulaCacheKey('x', 'yes') === 'block\u0000x' && getFormulaCacheKey('x', 'no') === 'inline\u0000x', getFormulaCacheKey('x', 'yes'));
  const seededHtml = '<span class="cached-formula">x</span>';
  const seeded = seedFormulaHtmlCache({
    [getFormulaCacheKey('x', 'no')]: seededHtml,
  });
  assert('math cache seeds html', seeded === 1 && getCachedFormulaHtml('x', 'no') === seededHtml, `seeded=${seeded}`);

  const cachedEditor = makeEditor('Initial');
  try {
    load(cachedEditor, '$x$');
    assert('math node view uses seeded formula html cache', cachedEditor.view.dom.querySelector('.cached-formula') !== null, html(cachedEditor));
    assert('cached formula keeps markdown source', md(cachedEditor).includes('$x$'), md(cachedEditor));
  } finally {
    cachedEditor.destroy();
  }

  clearFormulaHtmlCache();
  assert('math cache clears', getCachedFormulaHtml('x', 'no') === null);

  const fallbackEditor = makeEditor('Initial');
  try {
    load(fallbackEditor, '$x$');
    const preview = fallbackEditor.view.dom.querySelector('.math-node-preview');
    assert('math node view renders after cache clear', preview !== null && preview.querySelector('.katex') !== null, html(fallbackEditor));
    assert('cleared cache render keeps markdown source', md(fallbackEditor).includes('$x$'), md(fallbackEditor));
  } finally {
    fallbackEditor.destroy();
  }
}


{
  const editor = makeEditor('Initial');
  try {
    load(editor, '```ts\nconst x = 1;\n```\n');
    const output = html(editor);
    assert('code block renders pre/code', output.includes('<pre') && output.includes('<code'), output);
    assert('code block keeps markdown', md(editor).includes('const x = 1;'), md(editor));
    assertHealthy('code block', editor);
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    load(editor, '![Dora](../images/dora.png)\n');
    const output = html(editor);
    assert('image renders img', output.includes('<img') && output.includes('../images/dora.png'), output);
    assertHealthy('image', editor);
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    load(editor, '- [ ] todo\n- [x] done\n');
    const output = html(editor);
    assert('task list renders checkbox', output.includes('type="checkbox"') && output.includes('checked'), output);
    assert('task list serializes checked state', md(editor).includes('- [ ] todo') && md(editor).includes('- [x] done'), md(editor));
    assertHealthy('task list', editor);
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    load(editor, 'Text[^1]\n\n[^1]: note body\n');
    const output = html(editor);
    assert('footnote renders without crashing', output.length > 0, output);
    assert('footnote keeps source', md(editor).includes('[^1]') && md(editor).includes('note body'), md(editor));
    assertHealthy('footnote', editor);
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    load(editor, '```mermaid\ngraph TD; A-->B\n```\n');
    const output = html(editor);
    assert('mermaid renders without crashing', output.length > 0, output);
    assert('mermaid keeps source', md(editor).includes('mermaid') && md(editor).includes('graph TD; A-->B'), md(editor));
    assertHealthy('mermaid', editor);
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  const target = makeEditor('Initial');
  try {
    load(
      editor,
      '# Mixed\n\nInline $x$ and **bold** and `code`.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\nconst y = 1;\n```\n\n![alt](../images/dora.png)\n',
    );
    selectAll(editor);
    const payload = copyPayload(editor);
    target.commands.setContent(parseMarkdown(''), false);
    pastePayload(target, payload);
    const output = html(target);
    assert('mixed copy/paste renders all major blocks', output.includes('<h1>') && output.includes('data-type="inlineMath"') && output.includes('<strong>') && output.includes('<table') && output.includes('<pre') && output.includes('<img'), output);
    assert('mixed copy/paste markdown is stable', canonical(md(target)) === md(target), md(target));
    assertHealthy('mixed copy/paste', target);
  } finally {
    editor.destroy();
    target.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    load(editor, 'Inline $\\frac{x}{y}_1$\n');
    assertMathSyntaxDecorations('math syntax highlight initial', editor);
    assert('math syntax highlight initial markdown', md(editor).includes('$\\frac{x}{y}_1$'), md(editor));

    const start = findNodePosition(editor, 'inlineMath');
    assert('math syntax highlight finds inline math', start !== null, String(start));
    if (start === null) throw new Error('missing inlineMath');
    const insertPos = start + 1;
    const insertTr = editor.state.tr.insert(insertPos, editor.state.schema.text('{b}'));
    editor.view.dispatch(insertTr.setSelection(TextSelection.create(insertTr.doc, insertPos + 2)));
    const insertedMd = md(editor);
    assert('math syntax highlight insertion content', insertedMd.includes('{b}\\frac{x}{y}_1'), insertedMd);
    assertMathSyntaxDecorations('math syntax highlight insertion', editor);

    editor.commands.undo();
    const undoneMd = md(editor);
    assert('math syntax highlight undo insertion', undoneMd.includes('$\\frac{x}{y}_1$'), undoneMd);
    assertMathSyntaxDecorations('math syntax highlight undo insertion', editor);

    editor.commands.redo();
    const redoneMd = md(editor);
    assert('math syntax highlight redo insertion', redoneMd.includes('{b}\\frac{x}{y}_1'), redoneMd);
    assertMathSyntaxDecorations('math syntax highlight redo insertion', editor);

    const formulaPos = findNodePosition(editor, 'inlineMath');
    if (formulaPos === null) throw new Error('missing inlineMath after redo');
    const deleteFrom = formulaPos + 1;
    const deleteTr = editor.state.tr.delete(deleteFrom, deleteFrom + 1);
    editor.view.dispatch(deleteTr.setSelection(TextSelection.create(deleteTr.doc, deleteFrom)));
    const deletedMd = md(editor);
    assert('math syntax highlight deletion content', deletedMd.includes('b}\\frac{x}{y}_1'), deletedMd);
    assertMathSyntaxDecorations('math syntax highlight deletion', editor);

    editor.commands.undo();
    const undoDeleteMd = md(editor);
    assert('math syntax highlight undo deletion', undoDeleteMd.includes('{b}\\frac{x}{y}_1'), undoDeleteMd);
    assertMathSyntaxDecorations('math syntax highlight undo deletion', editor);

    editor.commands.redo();
    const redoDeleteMd = md(editor);
    assert('math syntax highlight redo deletion', redoDeleteMd.includes('b}\\frac{x}{y}_1'), redoDeleteMd);
    assertMathSyntaxDecorations('math syntax highlight redo deletion', editor);
    assertHealthy('math syntax highlight', editor);
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    const formulaCount = 300;
    const source = Array.from({ length: formulaCount }, (_, index) => `$\\frac{x_{${index}}}{y_${index}}$`).join('\n');
    load(editor, source);
    assert('math syntax highlight many formulas loaded', countNodes(editor, 'inlineMath') === formulaCount, md(editor).slice(0, 200));
    assertMathSyntaxDecorations('math syntax highlight many formulas initial', editor);

    const pos = findNodePosition(editor, 'inlineMath');
    if (pos === null) throw new Error('missing inlineMath in many formulas');
    const manyInsertTr = editor.state.tr.insert(pos + 1, editor.state.schema.text('{edit}'));
    editor.view.dispatch(manyInsertTr.setSelection(TextSelection.create(manyInsertTr.doc, pos + 2)));
    const manyMd = md(editor);
    assert('math syntax highlight many formulas edit', countNodes(editor, 'inlineMath') === formulaCount && manyMd.includes('{edit}\\frac{x_{0}}{y_0}'), manyMd.slice(0, 300));
    assertMathSyntaxDecorations('math syntax highlight many formulas after edit', editor);
  } finally {
    editor.destroy();
  }
}
console.log('\n## fixture render interaction sweep');

const fixtureFiles = fs
  .readdirSync(fixturesDir)
  .filter((file) => file.endsWith('.md'))
  .sort();

for (const file of fixtureFiles) {
  const source = fs.readFileSync(path.join(fixturesDir, file), 'utf8');
  const name = file.replace(/\.md$/, '');

  {
    const editor = makeEditor('Initial');
    try {
      sourceToVisual(editor, source);
      const output = html(editor);
      assert(`${name}: visual render is non-empty`, output.length > 0, output.slice(0, 200));
      assert(`${name}: visual render survives source round trip`, md(editor) === canonical(md(editor)), md(editor).slice(0, 300));
      assertHealthy(`${name}: visual render fixture`, editor, source);
    } finally {
      editor.destroy();
    }
  }

  {
    const editor = makeEditor('Initial');
    try {
      sourceToVisual(editor, source);
      editor.commands.insertContent('VISUAL_RENDER_EDIT');
      const beforeEdit = md(editor);
      editor.commands.undo();
      const undone = md(editor);
      editor.commands.redo();
      const redone = md(editor);
      assert(`${name}: render edit undo/redo is token-free`, !beforeEdit.includes('MDEDITORSELECTION') && !undone.includes('MDEDITORSELECTION') && !redone.includes('MDEDITORSELECTION'), beforeEdit);
      assert(`${name}: render edit survives redo`, redone.includes('VISUAL_RENDER_EDIT'), redone.slice(0, 300));
      assert(`${name}: render edit HTML stays alive`, html(editor).length > 0, html(editor).slice(0, 200));
    } finally {
      editor.destroy();
    }
  }
}

console.log('\n## violent render operation chains');

const chainSources = [
  { name: 'format + structure', source: 'alpha\n\nbeta\n', ops: [
    (e: Editor) => selectParagraphText(e, 'alpha') && e.chain().focus().toggleHeading({ level: 2 }).run(),
    (e: Editor) => selectParagraphText(e, 'beta') && e.chain().focus().toggleBulletList().run(),
    (e: Editor) => e.commands.undo(),
    (e: Editor) => e.commands.redo(),
  ], marker: 'beta', htmlNeedle: '<ul>' },
  { name: 'math + table + undo', source: 'alpha\n\nbeta\n', ops: [
    (e: Editor) => selectParagraphText(e, 'alpha') && (e as any).chain().focus().insertInlineMath('a^2').run(),
    (e: Editor) => selectParagraphText(e, 'beta') && e.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run(),
    (e: Editor) => e.commands.undo(),
    (e: Editor) => e.commands.undo(),
    (e: Editor) => e.commands.redo(),
    (e: Editor) => e.commands.redo(),
  ], marker: 'a^2', htmlNeedle: 'data-type="inlineMath"' },
  { name: 'copy + paste + mode round trip', source: '# T\n\nbody\n', ops: [
    (e: Editor) => selectAll(e),
    (e: Editor) => { const payload = copyPayload(e); const target = makeEditor(''); target.commands.setContent(parseMarkdown(''), false); pastePayload(target, payload); const output = html(target); assert('chain copy/paste HTML renders', output.length > 0, output.slice(0, 200)); target.destroy(); return true; },
    (e: Editor) => { sourceToVisual(e, visualToSource(e)); return true; },
    (e: Editor) => { const back = visualToSource(e); sourceToVisual(e, back); return true; },
  ], marker: 'body', htmlNeedle: '<h1>' },
  { name: 'image + code + heading + undo/redo', source: '## Title\n\n![alt](../images/dora.png)\n\n```js\nx\n```\n', ops: [
    (e: Editor) => e.commands.setTextSelection(1) && e.chain().focus().toggleHeading({ level: 1 }).run(),
    (e: Editor) => e.commands.undo(),
    (e: Editor) => e.commands.redo(),
    (e: Editor) => { const back = visualToSource(e); sourceToVisual(e, back); return true; },
  ], marker: 'Title', htmlNeedle: '<img' },
];

for (const chain of chainSources) {
  const editor = makeEditor('Initial');
  try {
    sourceToVisual(editor, chain.source);
    for (const op of chain.ops) {
      op(editor);
      assertHealthy(`${chain.name}: intermediate render stays healthy`, editor);
    }
    const output = html(editor);
    assert(`${chain.name}: final HTML includes expected needle`, output.includes(chain.htmlNeedle), output.slice(0, 500));
    assert(`${chain.name}: final source includes marker`, md(editor).includes(chain.marker), md(editor).slice(0, 500));
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

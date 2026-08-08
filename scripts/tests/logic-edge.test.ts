import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
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
import { convertHtmlToMarkdown, looksLikeStructuredHtml } from '../../src/renderer/editor/html-to-markdown';
import { highlightLatex, highlightMermaid, highlightSearchInHtml } from '../../src/renderer/editor/syntax-highlight';
import { getCodeLanguageLabel, CODE_LANGUAGE_OPTIONS } from '../../src/renderer/editor/code-languages';
import { findVisualSearchMatches, replaceAllVisualSearchMatches, replaceVisualSearchMatch, selectVisualSearchMatch } from '../../src/renderer/editor/search';
import { moveCursorAroundBlockNode, deleteBlockNodeAndFocus } from '../../src/renderer/editor/block-node-cursor';
import { buildSourceContextMenu, buildVisualContextMenu } from '../../src/renderer/editor/context-menu-actions';
import { SAMPLE_DOCUMENT } from '../../src/renderer/sample-document';
import { getThemePaletteColors, isGlassEffect, isThemePalette, GLASS_EFFECT_OPTIONS, THEME_PALETTE_OPTIONS } from '../../src/renderer/theme';
import { DEFAULT_FROSTED_GLASS, DEFAULT_LIQUID_GLASS, isHexColor, loadCustomColorsEnabled, resolveCustomColorsEnabled } from '../../src/renderer/settings';
import { setAppLanguage, translate } from '../../src/renderer/i18n';

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

console.log('\n## html-to-markdown');

{
  const html = '<h1>Title</h1><p>Hello <strong>bold</strong> and <em>italic</em> and <code>code</code>.</p>';
  const md = convertHtmlToMarkdown(html);
  assert('html heading converts', md.includes('# Title'), md);
  assert('html strong converts', md.includes('**bold**'), md);
  assert('html em converts', md.includes('*italic*'), md);
  assert('html code converts', md.includes('`code`'), md);
  assert('structured html detected', looksLikeStructuredHtml(html));
  assert('plain text not structured html', !looksLikeStructuredHtml('plain text'));
}

{
  const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
  const md = convertHtmlToMarkdown(html);
  assert('html table converts', md.includes('| A | B |') && md.includes('| 1 | 2 |'), md);
}

{
  const html = '<p>Inline <span class="katex">\\(x^2\\)</span></p>';
  const md = convertHtmlToMarkdown(html);
  assert('html latex converts', md.includes('x^2'), md);
}

{
  const html = '<pre><code class="language-js">const x = 1;</code></pre>';
  const md = convertHtmlToMarkdown(html);
  assert('html pre/code converts', md.includes('```') && md.includes('const x = 1;'), md);
}

{
  const html = '<ul><li>one</li><li>two</li></ul>';
  const md = convertHtmlToMarkdown(html);
  assert('html list converts', md.includes('- one') && md.includes('- two'), md);
}

console.log('\n## visual search');

{
  const editor = makeEditor('hello world hello');
  try {
    const matches = findVisualSearchMatches(editor, 'hello');
    assert('visual search finds text matches', matches.length === 2, JSON.stringify(matches));
    selectVisualSearchMatch(editor, matches[0]!);
    assert('visual search selects match', editor.state.selection.from === 1 && editor.state.selection.to === 6, `${editor.state.selection.from}:${editor.state.selection.to}`);
    replaceVisualSearchMatch(editor, matches[0]!, 'bye');
    assert('visual search replace one', serializeMarkdown(editor.getJSON()).includes('bye world hello'), serializeMarkdown(editor.getJSON()));
    const editor2 = makeEditor('a a a');
    try {
      const count = replaceAllVisualSearchMatches(editor2, 'a', 'b');
      assert('visual search replace all', count === 3 && serializeMarkdown(editor2.getJSON()).includes('b b b'), serializeMarkdown(editor2.getJSON()));
    } finally {
      editor2.destroy();
    }
  } finally {
    editor.destroy();
  }
}

console.log('\n## code language and syntax highlight');

{
  assert('plain text language label', getCodeLanguageLabel(null) === 'Plain Text');
  assert('plaintext alias label', getCodeLanguageLabel('plaintext') === 'Plain Text');
  assert('typescript alias label', getCodeLanguageLabel('typescript') === 'TypeScript');
  assert('unknown label falls back', getCodeLanguageLabel('zzz') === 'zzz');
  assert('language options are unique', new Set(CODE_LANGUAGE_OPTIONS.map((o) => o.value)).size === CODE_LANGUAGE_OPTIONS.length);
}

{
  const latex = highlightLatex('\\frac{1}{2}');
  assert('latex highlight has token classes', latex.includes('syntax-token'), latex);
  const mermaid = highlightMermaid('graph TD; A-->B');
  assert('mermaid highlight has token classes', mermaid.includes('syntax-token'), mermaid);
  const searched = highlightSearchInHtml('hello world', 'hello', () => 0, { search: { matches: [{ from: 0 }], currentIndex: 0 } });
  assert('search highlight wraps query', searched.includes('search-highlight-in-editor'), searched);
}

console.log('\n## sample document');

{
  const editor = makeEditor('Initial');
  try {
    const loaded = serializeMarkdown(parseMarkdown(SAMPLE_DOCUMENT));
    assert('sample document parses', loaded.length > 100, loaded);
    assert('sample document has table', loaded.includes('|'));
    assert('sample document has math', loaded.includes('\\int_0^1'));
    assert('sample document has mermaid', loaded.includes('graph LR') || loaded.includes('graph'));
    assert('sample document has footnote', loaded.includes('[^1]'));
    const visual = parseMarkdown(SAMPLE_DOCUMENT);
    assert('sample document JSON has no marker tokens', !JSON.stringify(visual).includes('MDEDITORSELECTION'));
  } finally {
    editor.destroy();
  }
}

console.log('\n## block node cursor');

{
  const editor = makeEditor('before\n\n```mermaid\ngraph LR;\nA-->B\n```\n\nafter\n');
  try {
    let pos = -1;
    let size = 0;
    editor.state.doc.descendants((node, at) => {
      if (node.type.name === 'mermaidBlock') { pos = at; size = node.nodeSize; return false; }
      return true;
    });
    const moved = moveCursorAroundBlockNode(editor, pos, size, 'before');
    assert('move cursor before block succeeds', moved && editor.state.selection.from < pos, `${editor.state.selection.from} < ${pos}`);
    const deleted = deleteBlockNodeAndFocus(editor, pos, size);
    assert('delete block node succeeds', deleted && !JSON.stringify(editor.getJSON()).includes('mermaidBlock'), serializeMarkdown(editor.getJSON()));
  } finally {
    editor.destroy();
  }
}

console.log('\n## context menu builders');

{
  const textarea = document.createElement('textarea');
  textarea.value = 'abc';
  textarea.setSelectionRange(0, 1);
  const sourceMenu = buildSourceContextMenu({
    textarea,
    onFind: () => {},
    onFindReplace: () => {},
    onGoToLine: () => {},
    onToggleVisual: () => {},
  });
  const ids = sourceMenu.map((item) => ('id' in item ? item.id : item.id));
  assert('source menu has copy/cut/paste/select', ['copy', 'cut', 'paste', 'select-all', 'goto-line'].every((id) => ids.includes(id)), JSON.stringify(ids));
  const selectAll = sourceMenu.find((item) => 'id' in item && item.id === 'select-all');
  assert('source select-all enables and selects', Boolean(selectAll) && !('disabled' in (selectAll ?? {}) && (selectAll as any).disabled));
}

{
  const editor = makeEditor('word');
  try {
    const visualMenu = buildVisualContextMenu({
      editor,
      onFind: () => {},
      onFindReplace: () => {},
      onInsertImage: () => {},
      onToggleSource: () => {},
    });
    const ids = visualMenu.map((item) => ('id' in item ? item.id : item.id));
    assert('visual menu has clipboard/source actions', ['copy', 'paste', 'select-all', 'source'].every((id) => ids.includes(id)), JSON.stringify(ids));
  } finally {
    editor.destroy();
  }
}

console.log('\n## theme / settings / i18n');

{
  assert('theme palette set is valid', THEME_PALETTE_OPTIONS.length >= 8);
  for (const option of THEME_PALETTE_OPTIONS) {
    assert(`theme palette ${option.id} has colors`, Object.keys(getThemePaletteColors(option.id)).length > 0, JSON.stringify(option));
  }
  assert('theme palette validator', isThemePalette('natural') && !isThemePalette('bogus'));
  assert('glass validator', isGlassEffect('liquid') && !isGlassEffect('bogus'));
  assert('glass options include off/frosted/liquid', ['off', 'frosted', 'liquid'].every((id) => GLASS_EFFECT_OPTIONS.some((o) => o.id === id)));
  assert('hex validator', isHexColor('#abcdef') && !isHexColor('red'));
  assert('custom color enable resolver', resolveCustomColorsEnabled('1') === true && resolveCustomColorsEnabled(null) === false);
  assert('default frosted glass has blur', DEFAULT_FROSTED_GLASS.blur > 0);
  assert('default liquid glass has refraction', DEFAULT_LIQUID_GLASS.refractiveIndex > 0);
}

{
  const previous = getComputedLanguage();
  setAppLanguage('en');
  assert('english translation active', translate('save') === 'Save' || translate('save').includes('Save'), translate('save'));
  setAppLanguage('zh');
  assert('chinese translation active', translate('save') === '保存', translate('save'));
  setAppLanguage(previous);
}

function getComputedLanguage(): 'en' | 'zh' {
  const el = document.documentElement;
  return el.lang === 'en' ? 'en' : 'zh';
}

console.log(`\n================================================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.slice(0, 200).join('\n'));
  process.exit(1);
}

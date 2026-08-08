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
import { NodeSelection } from '@tiptap/pm/state';
import { createEditorExtensions } from '../../src/renderer/editor/create-editor-extensions';
import { parseMarkdown, parseMarkdownFragment, serializeMarkdown } from '../../src/renderer/editor/markdown';
import { replaceEditorContent } from '../../src/renderer/editor/replace-editor-content';
import {
  insertSelectionMarkersIntoMarkdown,
  restoreSelectionMarkersFromEditorState,
} from '../../src/renderer/editor/selection-markers';
import { buildClipboardPayload, serializeSliceForClipboard } from '../../src/renderer/editor/clipboard';
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

function selectWholeNode(editor: Editor, typeName: string): void {
  let pos = -1;
  editor.state.doc.descendants((node, at) => {
    if (pos !== -1) return false;
    if (node.type.name === typeName) {
      pos = at;
      return false;
    }
    return true;
  });
  if (pos === -1) throw new Error(`missing node ${typeName}`);
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
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

function countNodes(editor: Editor, typeName: string): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === typeName) count += 1;
    return true;
  });
  return count;
}

const fixtureFiles = fs
  .readdirSync(fixturesDir)
  .filter((file) => file.endsWith('.md'))
  .sort();

console.log('\n## fixture cross-edit stress');

for (const file of fixtureFiles) {
  const source = fs.readFileSync(path.join(fixturesDir, file), 'utf8');
  const name = file.replace(/\.md$/, '');

  {
    const editor = makeEditor('Initial');
    try {
      const edited = `${source.trimEnd()}\n\n<!-- EDGE_${name} -->\n`;
      const visual = sourceToVisual(editor, edited);
      assert(`${name}: source edit at end survives to visual`, visual.includes(`EDGE_${name}`) && !visual.includes('MDEDITORSELECTION'), visual);
      const sourceAgain = visualToSource(editor);
      assert(`${name}: source edit at end survives back`, sourceAgain.includes(`EDGE_${name}`), sourceAgain);

      const prefixed = `<!-- HEAD_${name} -->\n\n${source}`;
      const visual2 = sourceToVisual(editor, prefixed);
      assert(`${name}: source edit at start survives to visual`, visual2.includes(`HEAD_${name}`), visual2);
      const source2 = visualToSource(editor);
      assert(`${name}: source edit at start survives back`, source2.includes(`HEAD_${name}`), source2);
    } finally {
      editor.destroy();
    }
  }

  {
    const editor = makeEditor('Initial');
    try {
      sourceToVisual(editor, source);
      const beforeEdit = md(editor);
      editor.commands.insertContent('VISUAL_EDIT');
      const edited = md(editor);
      assert(`${name}: visual edit appears in source`, edited.includes('VISUAL_EDIT'), edited);
      editor.commands.undo();
      assert(`${name}: undo visual edit returns to switched content`, md(editor) === beforeEdit, md(editor));
      editor.commands.redo();
      assert(`${name}: redo visual edit reapplies`, md(editor).includes('VISUAL_EDIT'), md(editor));
      const sourceAgain = visualToSource(editor);
      assert(`${name}: visual edit survives visual->source`, sourceAgain.includes('VISUAL_EDIT'), sourceAgain);
    } finally {
      editor.destroy();
    }
  }

  {
    const editor = makeEditor('Initial');
    const target = makeEditor();
    try {
      sourceToVisual(editor, source);
      selectAll(editor);
      const payload = copyPayload(editor);
      target.commands.setContent(parseMarkdown(''), false);
      pastePayload(target, payload);
      const pasted = md(target);
      assert(`${name}: whole visual copy/paste is non-empty and token-free`, pasted.length > 0 && !pasted.includes('MDEDITORSELECTION'), pasted);
    } finally {
      editor.destroy();
      target.destroy();
    }
  }
}

console.log('\n## structural command matrix');

type Op = {
  name: string;
  apply: (editor: Editor) => void;
  prep?: (editor: Editor) => void;
  marker?: string;
  nodeType?: string;
  jsonMarker?: (json: any) => boolean;
};

function hasMark(editor: Editor, markType: string): boolean {
  let found = false;
  editor.state.doc.descendants((node) => {
    if (found) return false;
    if (node.marks.some((mark) => mark.type.name === markType)) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

const ops: Op[] = [
  { name: 'heading 1', apply: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(), prep: (e) => { load(e, 'word'); e.commands.selectAll(); }, marker: '# word' },
  { name: 'heading 6', apply: (e) => e.chain().focus().toggleHeading({ level: 6 }).run(), prep: (e) => { load(e, 'word'); e.commands.selectAll(); }, marker: '###### word' },
  { name: 'bold', apply: (e) => e.chain().focus().toggleBold().run(), prep: (e) => { load(e, 'word'); e.commands.selectAll(); }, marker: '**word**' },
  { name: 'italic', apply: (e) => e.chain().focus().toggleItalic().run(), prep: (e) => { load(e, 'word'); e.commands.selectAll(); }, marker: '*word*' },
  { name: 'strike', apply: (e) => e.chain().focus().toggleStrike().run(), prep: (e) => { load(e, 'word'); e.commands.selectAll(); }, marker: '~~word~~' },
  { name: 'inline code', apply: (e) => e.chain().focus().toggleCode().run(), prep: (e) => { load(e, 'word'); e.commands.selectAll(); }, marker: '`word`' },
  { name: 'link', apply: (e) => e.chain().focus().setLink({ href: 'https://example.com' }).run(), prep: (e) => { load(e, 'word'); e.commands.selectAll(); }, marker: '[word](https://example.com)' },
  { name: 'bullet list', apply: (e) => e.chain().focus().toggleBulletList().run(), prep: (e) => { load(e, 'word'); e.commands.selectAll(); }, marker: '- word' },
  { name: 'ordered list', apply: (e) => e.chain().focus().toggleOrderedList().run(), prep: (e) => { load(e, 'word'); e.commands.selectAll(); }, marker: '1. word' },
  { name: 'task list', apply: (e) => e.chain().focus().toggleTaskList().run(), prep: (e) => { load(e, 'word'); e.commands.selectAll(); }, marker: '- [ ] word' },
  { name: 'blockquote', apply: (e) => e.chain().focus().toggleBlockquote().run(), prep: (e) => { load(e, 'word'); e.commands.selectAll(); }, marker: '> word' },
  { name: 'code block', apply: (e) => e.chain().focus().toggleCodeBlock().run(), prep: (e) => { load(e, 'word'); e.commands.selectAll(); }, marker: '```' },
  { name: 'horizontal rule', apply: (e) => e.chain().focus().setHorizontalRule().run(), prep: (e) => { load(e, 'before'); e.commands.setTextSelection(6); }, marker: '---' },
  { name: 'inline math', apply: (e) => (e as any).chain().focus().insertInlineMath('a^2').run(), prep: (e) => { load(e, 'before after'); e.commands.setTextSelection(7); }, marker: '$a^2$' },
  { name: 'display math', apply: (e) => (e as any).chain().focus().insertMathBlock('x+y').run(), prep: (e) => { load(e, 'before'); e.commands.setTextSelection(6); }, marker: '$$' },
  { name: 'table', apply: (e) => e.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run(), prep: (e) => { load(e, 'word'); e.commands.setTextSelection(1); }, marker: '|' },
  { name: 'mermaid', apply: (e) => (e as any).chain().focus().insertMermaidBlock('graph TD; A-->B').run(), prep: (e) => { load(e, 'word'); e.commands.setTextSelection(1); }, marker: 'mermaid' },
  { name: 'image', apply: (e) => e.chain().focus().setImage({ src: './x.png', alt: 'alt' }).run(), prep: (e) => { load(e, 'word'); e.commands.setTextSelection(1); }, marker: '![alt](./x.png)' },
  { name: 'footnote reference', apply: (e) => (e as any).chain().focus().insertFootnoteReference('42').run(), prep: (e) => { load(e, 'word'); e.commands.setTextSelection(6); }, marker: '[^42]' },
  { name: 'footnote definition', apply: (e) => (e as any).chain().focus().insertFootnoteDefinition('42').run(), prep: (e) => { load(e, 'word'); e.commands.setTextSelection(1); }, marker: '[^42]:' },
  { name: 'html block', apply: (e) => e.chain().focus().insertContent({ type: 'htmlBlock', attrs: { html: '<div>HTML_BLOCK</div>' } }).run(), prep: (e) => { load(e, 'word'); e.commands.setTextSelection(1); }, marker: '<div>HTML_BLOCK</div>' },
  { name: 'underline', apply: (e) => e.chain().focus().toggleUnderline().run(), prep: (e) => { load(e, 'word'); e.commands.selectAll(); }, jsonMarker: (json) => { let found = false; const walk = (n: any) => { if (found) return; if (n.marks?.some((m: any) => m.type === 'underline')) { found = true; return; } (n.content ?? []).forEach(walk); }; walk(json); return found; } },
];

for (const op of ops) {
  const editor = makeEditor('Initial');
  const target = makeEditor();
  try {
    op.prep?.(editor);
    const before = md(editor);
    op.apply(editor);
    const after = md(editor);
    assert(`${op.name}: changes document`, after !== before, `${before} -> ${after}`);
    if (op.marker) {
      assert(`${op.name}: source contains expected marker`, after.includes(op.marker), after);
    } else if (op.jsonMarker) {
      assert(`${op.name}: JSON contains expected mark/node`, op.jsonMarker(editor.getJSON()), JSON.stringify(editor.getJSON()));
    }

    editor.commands.undo();
    assert(`${op.name}: undo returns to before`, md(editor) === before, md(editor));
    editor.commands.redo();
    assert(`${op.name}: redo reapplies`, md(editor) === after, md(editor));

    const visual = sourceToVisual(editor, after);
    assert(`${op.name}: source->visual is token-free`, !visual.includes('MDEDITORSELECTION'), visual);
    const roundTrip = visualToSource(editor);
    assert(`${op.name}: visual->source keeps content`, roundTrip === canonical(after), `${roundTrip} vs ${canonical(after)}`);

    selectAll(editor);
    const payload = copyPayload(editor);
    target.commands.setContent(parseMarkdown(''), false);
    pastePayload(target, payload);
    const pasted = md(target);
    assert(`${op.name}: copy/paste keeps content`, pasted.length > 0 && !pasted.includes('MDEDITORSELECTION'), pasted);
    if (op.nodeType) {
      assert(`${op.name}: paste restores node`, countNodes(target, op.nodeType) > 0, pasted);
    }
  } finally {
    editor.destroy();
    target.destroy();
  }
}

console.log('\n## clipboard context matrix');

const snippets = [
  { name: 'heading', source: '# Heading\n\nbody\n', marker: 'Heading' },
  { name: 'bold paragraph', source: '**bold** text\n', marker: 'bold' },
  { name: 'list', source: '- one\n- two\n', marker: 'two' },
  { name: 'table', source: '| A | B |\n| --- | --- |\n| 1 | 2 |\n', marker: '|' },
  { name: 'code', source: '```js\nconst x=1;\n```\n', marker: 'const x=1;' },
  { name: 'inline math', source: 'before $a^2$ after\n', marker: '$a^2$' },
  { name: 'display math', source: '$$\nx^2\n$$\n', marker: '$$' },
  { name: 'image', source: 'before ![alt](./x.png) after\n', marker: '![alt](./x.png)' },
  { name: 'footnote', source: 'Text[^1]\n\n[^1]: note body\n', marker: '[^1]' },
  { name: 'mermaid', source: '```mermaid\ngraph TD;\nA-->B\n```\n', marker: 'A-->B' },
  { name: 'html', source: 'before\n\n<div>HTML_MARK</div>\n\nafter\n', marker: 'HTML_MARK' },
  { name: 'mixed', source: '# Title\n\n- item\n\n$$\nx^2\n$$\n\n```js\nlet a=1;\n```\n', marker: 'Title' },
];

for (const snippet of snippets) {
  const sourceEditor = makeEditor('Initial');
  try {
    sourceToVisual(sourceEditor, snippet.source);
    selectAll(sourceEditor);
    const payload = copyPayload(sourceEditor);

    const target = makeEditor();
    try {
      target.commands.setContent(parseMarkdown(''), false);
      pastePayload(target, payload);
      const pasted = md(target);
      assert(`${snippet.name}: paste into empty doc keeps marker`, pasted.includes(snippet.marker) && !pasted.includes('MDEDITORSELECTION'), pasted);
    } finally {
      target.destroy();
    }

    const target2 = makeEditor();
    try {
      load(target2, 'before  after\n');
      target2.commands.setTextSelection(7);
      pastePayload(target2, payload);
      const pasted = md(target2);
      assert(`${snippet.name}: paste into paragraph keeps marker`, pasted.includes(snippet.marker) && !pasted.includes('MDEDITORSELECTION'), pasted);
    } finally {
      target2.destroy();
    }

    const target3 = makeEditor();
    try {
      load(target3, '## Heading\n\nbefore  after\n');
      target3.commands.setTextSelection(target3.state.doc.nodeSize - 4);
      pastePayload(target3, payload);
      const pasted = md(target3);
      assert(`${snippet.name}: paste near heading keeps marker`, pasted.includes(snippet.marker) && !pasted.includes('MDEDITORSELECTION'), pasted);
    } finally {
      target3.destroy();
    }
  } finally {
    sourceEditor.destroy();
  }
}

console.log('\n## repeated copy/paste and mode-switch stress');

{
  const source = '# Start\n\nparagraph\n\n$$\na+b\n$$\n\n- item\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n';
  const editor = makeEditor('Initial');
  const target = makeEditor();
  try {
    sourceToVisual(editor, source);
    for (let i = 0; i < 3; i += 1) {
      selectAll(editor);
      const payload = copyPayload(editor);
      target.commands.setContent(parseMarkdown(''), false);
      pastePayload(target, payload);
      sourceToVisual(editor, md(target));
      assert(`repeated copy/paste round ${i + 1} keeps core content`, md(editor).includes('Start') && md(editor).includes('a+b') && !md(editor).includes('MDEDITORSELECTION'), md(editor));
    }
  } finally {
    editor.destroy();
    target.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    sourceToVisual(editor, 'one\n');
    const sourceOne = visualToSource(editor);
    sourceToVisual(editor, sourceOne);
    const sourceTwo = visualToSource(editor);
    editor.commands.undo();
    const afterUndo = md(editor);
    editor.commands.redo();
    const afterRedo = md(editor);
    assert('mode switch undo/redo remains stable', sourceTwo === afterUndo && sourceTwo === afterRedo, `${sourceTwo} ${afterUndo} ${afterRedo}`);
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    load(editor, 'word');
    editor.commands.selectAll();
    editor.chain().focus().toggleBold().run();
    const bold = md(editor);
    sourceToVisual(editor, bold);
    editor.commands.undo();
    const undone = md(editor);
    editor.commands.redo();
    const redone = md(editor);
    assert('bold + source switch + undo/redo keeps bold', redone.includes('**word**'), `${undone} -> ${redone}`);
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    sourceToVisual(editor, '# Title\n\nbody\n');
    editor.chain().focus().selectAll().toggleBulletList().run();
    const listSource = visualToSource(editor);
    assert('heading converted to list in visual mode survives to source', listSource.includes('- Title'), listSource);
    sourceToVisual(editor, listSource);
    editor.commands.undo();
    const undone = md(editor);
    assert('undo after heading->list conversion returns to converted state', undone === listSource, undone);
  } finally {
    editor.destroy();
  }
}

console.log(`\n================================================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.slice(0, 200).join('\n'));
  process.exit(1);
}

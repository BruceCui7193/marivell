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
import { parseMarkdown, serializeMarkdown } from '../../src/renderer/editor/markdown';
import {
  buildClipboardPayload,
  serializeSliceForClipboard,
} from '../../src/renderer/editor/clipboard';
import { pasteClipboardPayload } from '../../src/renderer/editor/plugins/markdown-paste';

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

function findNodePosition(editor: Editor, typeName: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found !== -1) {
      return false;
    }
    if (node.type.name === typeName) {
      found = pos;
      return false;
    }
    return true;
  });
  if (found === -1) {
    throw new Error(`missing ${typeName} node`);
  }
  return found;
}

function selectWholeNode(editor: Editor, typeName: string): void {
  const pos = findNodePosition(editor, typeName);
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
}

function pastePayload(editor: Editor, payload: {
  plain: string;
  html: string | null;
  markdown: string | null;
}): void {
  pasteClipboardPayload(editor, {
    text: payload.plain,
    html: payload.html ?? '',
    markdown: payload.markdown ?? '',
  });
}

console.log('\n## math insertion and clipboard round-trips');

{
  const editor = makeEditor();
  try {
    editor.commands.setContent(parseMarkdown(''), false);
    editor.commands.insertMathBlock();
    editor.view.dispatch(editor.state.tr.insertText('x'));
    const source = serializeMarkdown(editor.getJSON());
    assert(
      'inserted display math uses $$ delimiters in source',
      source === '$$\nx\n$$\n',
      source,
    );
    const mathPos = findNodePosition(editor, 'inlineMath');
    const node = editor.state.doc.nodeAt(mathPos);
    assert(
      'inserted display math keeps display=yes',
      node?.attrs.display === 'yes' && node.attrs.openDelim === '$$' && node.attrs.closeDelim === '$$',
      JSON.stringify(node?.attrs),
    );
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor();
  try {
    editor.commands.setContent(parseMarkdown(''), false);
    editor.commands.insertMathBlock();
    editor.view.dispatch(editor.state.tr.insertText('x'));
    selectWholeNode(editor, 'inlineMath');
    const payload = buildClipboardPayload(editor.view);
    assert(
      'whole display math copy keeps $$ markdown',
      payload.markdown === '$$\nx\n$$' && payload.plain === '$$\nx\n$$',
      JSON.stringify(payload),
    );
    const sliceText = serializeSliceForClipboard(editor.state.selection.content());
    assert('whole display math slice keeps $$ markdown', sliceText === '$$\nx\n$$', sliceText);

    const target = makeEditor();
    try {
      target.commands.setContent(parseMarkdown(''), false);
      pastePayload(target, payload);
      const source = serializeMarkdown(target.getJSON());
      assert(
        'whole display math paste restores display math',
        source === '$$\nx\n$$\n',
        source,
      );
      const pasted = target.state.doc.nodeAt(findNodePosition(target, 'inlineMath'));
      assert(
        'pasted display math has display=yes and $$ delimiters',
        pasted?.attrs.display === 'yes' && pasted.attrs.openDelim === '$$' && pasted.attrs.closeDelim === '$$',
        JSON.stringify(pasted?.attrs),
      );
    } finally {
      target.destroy();
    }
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('before $a$ after');
  try {
    selectWholeNode(editor, 'inlineMath');
    const payload = buildClipboardPayload(editor.view);
    assert(
      'whole inline math copy keeps single-dollar markdown',
      payload.markdown === '$a$',
      JSON.stringify(payload),
    );

    const target = makeEditor();
    try {
      target.commands.setContent(parseMarkdown(''), false);
      pastePayload(target, payload);
      const source = serializeMarkdown(target.getJSON());
      assert(
        'whole inline math paste restores inline math',
        source === '$a$\n',
        source,
      );
      const pasted = target.state.doc.nodeAt(findNodePosition(target, 'inlineMath'));
      assert(
        'pasted inline math has display=no and single-dollar delimiters',
        pasted?.attrs.display === 'no' && pasted.attrs.openDelim === '$' && pasted.attrs.closeDelim === '$',
        JSON.stringify(pasted?.attrs),
      );
    } finally {
      target.destroy();
    }
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('```js\nconst x = 1;\n```\n');
  try {
    selectWholeNode(editor, 'codeBlock');
    const payload = buildClipboardPayload(editor.view);
    assert(
      'whole code block copy keeps fence wrappers',
      payload.markdown?.includes('```') && payload.markdown?.includes('const x = 1;'),
      JSON.stringify(payload),
    );

    const target = makeEditor();
    try {
      target.commands.setContent(parseMarkdown(''), false);
      pastePayload(target, payload);
      const source = serializeMarkdown(target.getJSON());
      assert(
        'whole code block paste restores code block',
        source.includes('```') && source.includes('const x = 1;'),
        source,
      );
      let hasCodeBlock = false;
      target.state.doc.descendants((node) => {
        if (node.type.name === 'codeBlock') {
          hasCodeBlock = true;
          return false;
        }
        return true;
      });
      assert('pasted code block is a codeBlock node', hasCodeBlock, 'did not find codeBlock');
    } finally {
      target.destroy();
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

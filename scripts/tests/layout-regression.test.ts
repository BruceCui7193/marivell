import { readFileSync } from 'node:fs';
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

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const css = readFileSync(path.join(projectRoot, 'src/renderer/styles/editor.css'), 'utf8');

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
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

function assertEqual(name: string, actual: string, expected: string): void {
  assert(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

async function main() {
  console.log('\n## task list layout');

  {
    const source = '- [ ] todo\n- [x] done\n';
    const editor = makeEditor(source);
    await tick();
    const json = editor.getJSON();
    const taskList = json.content?.find((node) => node.type === 'taskList');
    const items = taskList?.content ?? [];
    assert('task list parses two items', items.length === 2, JSON.stringify(json));
    if (items.length >= 2) {
      assert('unchecked task item keeps checked=false', items[0].attrs?.checked === false, JSON.stringify(items[0]));
      assert('checked task item keeps checked=true', items[1].attrs?.checked === true, JSON.stringify(items[1]));
    }
    const html = editor.getHTML();
    assert('task html keeps checkbox before text wrapper', html.includes('<label><input type="checkbox">') && html.includes('<div><p>todo</p></div>') && html.includes('<div><p>done</p></div>'), html);
    assertEqual('task list serializes back to source', serializeMarkdown(editor.getJSON()), source);
    editor.destroy();
  }

  {
    const cases = [
      '- [ ] a\n- [x] b\n',
      '- [ ] parent\n  - [x] child\n',
      '- [ ] a\n  - [ ] b\n  - [x] c\n',
    ];
    for (const source of cases) {
      const editor = makeEditor(source);
      const out = serializeMarkdown(editor.getJSON());
      assert(`task list round-trips: ${JSON.stringify(source)}`, out === source, out);
      editor.destroy();
    }
  }

  console.log('\n## footnote definition layout');

  {
    const source = 'Text[^1]\n\n[^1]: note body\n';
    const editor = makeEditor(source);
    await tick();
    const json = editor.getJSON();
    const definition = json.content?.find((node) => node.type === 'footnoteDefinition');
    assert('footnote definition node parses with label', definition?.attrs?.label === '1', JSON.stringify(json));
    const body = definition?.content?.[0]?.content?.map((part) => part.text ?? '').join('') ?? '';
    assert('footnote definition keeps body content', body.includes('note body'), JSON.stringify(definition));
    assertEqual('footnote definition serializes back to source', serializeMarkdown(editor.getJSON()), source);
    editor.destroy();
  }

  {
    const cases = [
      'Text[^1]\n\n[^1]: note body\n',
      'Text[^a]\n\n[^a]: body with **bold**\n',
      'Text[^42]\n\n[^42]: body with $x$\n',
      'Text[^1]\n\n[^1]: code `const x = 1`\n',
    ];
    for (const source of cases) {
      const editor = makeEditor(source);
      const out = serializeMarkdown(editor.getJSON());
      assert(`footnote round-trips: ${JSON.stringify(source)}`, out === source, out);
      editor.destroy();
    }
  }

  console.log('\n## layout css regression');

  {
    for (const [newlines, expected] of [[2, 0], [3, 1], [4, 2]] as const) {
      const source = `$$\nx\n$$${'\n'.repeat(newlines)}abc\n`;
      const editor = makeEditor(source);
      const math = editor.getJSON().content?.find((node) => node.type === 'inlineMath');
      assert(
        `display math preserves ${expected} explicit trailing blanks`,
        Number(math?.attrs?.trailingBlankLines ?? 0) === expected,
        JSON.stringify(math?.attrs),
      );
      const mathDom = document.querySelector<HTMLElement>('.math-block-node');
      assert(
        `display math DOM exposes ${expected} trailing blanks`,
        Number(mathDom?.dataset.trailingBlankLines ?? 0) === expected,
        String(mathDom?.outerHTML.slice(0, 300)),
      );
      editor.destroy();
    }
  }

  {
    assert(
      'task list uses flex row',
      /ul\[data-type='taskList'\] li\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*row|ul\[data-type='taskList'\] li\s*\{[^}]*display:\s*flex/.test(css),
    );
    assert('task list centers checkbox with text', /ul\[data-type='taskList'\] li\s*\{[^}]*align-items:\s*center/.test(css));
    assert('task text paragraph removes block margin', /li > div p\s*\{[^}]*margin:\s*0/.test(css));
    assert('footnote label input is compact', /\.footnote-definition-node__label-input\s*\{[^}]*width:\s*2ch/.test(css));
    assert('footnote definition uses flex row', /\.footnote-definition-node\s*\{[^}]*display:\s*flex/.test(css));
    assert('footnote definition drops card border', /\.footnote-definition-node\s*\{[^}]*border:\s*none/.test(css));
    assert('footnote content sits inline with label', /\.footnote-definition-node__content\s*\{[^}]*padding:\s*0/.test(css));
    assert('display math structural separator has no bottom margin', /\.editor-surface \.math-block-node\s*\{[^}]*margin-bottom:\s*0/.test(css));
    assert('paragraph after display math has no top margin', /\.editor-surface \.math-block-node \+ p\s*\{[^}]*margin-top:\s*0/.test(css));
    assert('explicit display math blanks render as line spacers', /\.editor-surface \.math-block-node\[data-trailing-blank-lines\]::after\s*\{[^}]*height:\s*calc\(/.test(css));
    assert(
      'dialog overlay does not isolate backdrop with will-change opacity',
      !/\.app-dialog-overlay\s*\{[^}]*will-change:\s*opacity/.test(css),
    );
    assert(
      'dialog overlay keeps backdrop sampling during entrance animation',
      !/\.app-dialog-overlay\s*\{[^}]*animation:\s*overlayIn/.test(css),
    );
    assert(
      'settings overlay keeps backdrop sampling during entrance animation',
      !/\.settings-dialog-overlay\s*\{[^}]*animation:\s*overlayIn/.test(css),
    );
  }

  console.log(`\n${'='.repeat(48)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.error('\nFailures:');
    for (const f of failures) console.error(f);
    process.exit(1);
  }
  console.log('All layout-regression tests passed.');
}

void main();

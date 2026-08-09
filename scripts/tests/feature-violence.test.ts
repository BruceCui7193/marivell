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
g.Event = dom.window.Event;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.MouseEvent = dom.window.MouseEvent;
g.DragEvent = dom.window.DragEvent;
g.MutationObserver = dom.window.MutationObserver;
g.DOMParser = dom.window.DOMParser;
g.Node = dom.window.Node;
g.Element = dom.window.Element;
g.HTMLElement = dom.window.HTMLElement;
g.HTMLCanvasElement = dom.window.HTMLCanvasElement;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
g.localStorage = dom.window.localStorage;

class FakeEditorWorker {
  addEventListener(): void {}
  removeEventListener(): void {}
  postMessage(): void {}
  terminate(): void {}
}
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
dom.window.Worker = FakeEditorWorker as unknown as typeof Worker;
g.Worker = FakeEditorWorker;
dom.window.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
g.ResizeObserver = FakeResizeObserver;
(dom.window as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  onchange: null,
  dispatchEvent: () => false,
});
(dom.window.HTMLElement.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
(dom.window.Element.prototype as unknown as { attachEvent: () => void }).attachEvent = () => {};
(dom.window.Element.prototype as unknown as { detachEvent: () => void }).detachEvent = () => {};

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
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import EditorShell from '../../src/renderer/components/EditorShell';
import { createEditorExtensions } from '../../src/renderer/editor/create-editor-extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/renderer/editor/markdown';
import { replaceEditorContent } from '../../src/renderer/editor/replace-editor-content';
import {
  insertSelectionMarkersIntoMarkdown,
  restoreSelectionMarkersFromEditorState,
  cleanSelectionMarkersFromJsonContent,
} from '../../src/renderer/editor/selection-markers';
import { buildClipboardPayload } from '../../src/renderer/editor/clipboard';
import { pasteClipboardPayload } from '../../src/renderer/editor/plugins/markdown-paste';
import {
  findSourceSearchMatches,
  replaceAllSourceSearchMatches,
  replaceSourceSearchMatch,
  replaceAllVisualSearchMatches,
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
  const message = `✗ ${name}${detail ? ` — ${detail}` : ''}`;
  failures.push(message);
  console.error(message);
}

function assertEqual(name: string, actual: unknown, expected: unknown): void {
  const ok = Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function makeEditor(
  content = 'Initial',
  resolveImageSource: (source: string) => string = (source) => source,
): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: createEditorExtensions({
      onUploadImage: async () => ({ src: 'x.png', absolutePath: 'x.png' }),
      onResolveImageSource: resolveImageSource,
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

function findNodePosition(editor: Editor, typeName: string, nth = 0): number {
  let found = -1;
  let seen = 0;
  editor.state.doc.descendants((node, pos) => {
    if (found !== -1) return false;
    if (node.type.name === typeName) {
      if (seen === nth) {
        found = pos;
        return false;
      }
      seen += 1;
    }
    return true;
  });
  if (found === -1) {
    throw new Error(`missing node ${typeName}#${nth}`);
  }
  return found;
}

function selectWholeNode(editor: Editor, typeName: string, nth = 0): void {
  const pos = findNodePosition(editor, typeName, nth);
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
}

function selectText(editor: Editor, text: string): void {
  let pos = -1;
  editor.state.doc.descendants((node, at) => {
    if (pos !== -1) return false;
    if (node.isText && node.text?.includes(text)) {
      pos = at + node.text.indexOf(text);
      return false;
    }
    return true;
  });
  if (pos === -1) {
    throw new Error(`missing text ${text}`);
  }
  editor.view.dispatch(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos, pos + text.length)),
  );
}

function selectionParentType(editor: Editor): string {
  return editor.state.selection.$from.parent.type.name;
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

function hasMarkerLeak(text: string): boolean {
  return (
    text.includes('MDEDITORSELECTION') ||
    text.includes('MARKDOWN_EDITOR') ||
    text.includes('\uE000')
  );
}

interface FeatureCase {
  name: string;
  baseline: string;
  rounds?: number;
  prepare?: (editor: Editor, round: number) => void;
  apply: (editor: Editor, round: number, target: Editor) => void;
  changed?: boolean;
  undoable?: boolean;
  exact?: string;
  expected?: (round: number) => string;
  includes?: string;
  nodeType?: string;
  nodeCount?: number;
  selectionParent?: string;
  searchTerm?: string;
  targetExact?: string;
  targetIncludes?: string;
  targetNodeType?: string;
  targetNodeCount?: number;
  continuousChain?: boolean;
  custom?: (editor: Editor, target: Editor, round: number, prefix: string) => void;
}

const DEFAULT_ROUNDS = 10;
const CROSS_INTERVAL = 3;
let crossCursor = 0;

function crossFeature(
  editor: Editor,
  target: Editor,
  before: string,
  after: string,
  feature: FeatureCase,
  prefix: string,
  _round: number,
): void {
  const kinds = feature.undoable === false ? ['mode', 'clipboard', 'search'] : ['mode', 'undo', 'clipboard', 'search'];
  const kind = kinds[crossCursor % kinds.length];
  crossCursor += 1;
  const term = feature.searchTerm ?? 'e';

  if (kind === 'mode') {
    const snapshot = md(editor);
    const visual = sourceToVisual(editor, snapshot);
    assertEqual(`${prefix} cross mode source->visual`, visual, canonical(snapshot));
    assert(`${prefix} cross mode no marker`, !hasMarkerLeak(visual), visual);
    assertEqual(`${prefix} cross mode visual->source`, visualToSource(editor), canonical(snapshot));
    return;
  }

  if (kind === 'undo') {
    const snapshot = md(editor);
    editor.commands.undo();
    assertEqual(`${prefix} cross undo`, md(editor), before);
    editor.commands.redo();
    assertEqual(`${prefix} cross redo`, md(editor), snapshot);
    return;
  }

  if (kind === 'clipboard') {
    selectAll(editor);
    const payload = copyPayload(editor);
    target.commands.setContent(parseMarkdown(''), false);
    pastePayload(target, payload);
    const pasted = md(target);
    assert(`${prefix} cross clipboard non-empty token-free`, pasted.length > 0 && !hasMarkerLeak(pasted), pasted);
    assert(`${prefix} cross clipboard keeps content`, pasted.includes(term), pasted);
    return;
  }

  const matches = findSourceSearchMatches(after, term, { caseSensitive: false });
  assert(`${prefix} cross search finds target`, matches.length > 0, JSON.stringify(matches));
  const replaced = replaceAllSourceSearchMatches(after, term, 'VIOLENCEZZZ', { caseSensitive: false });
  assertEqual(`${prefix} cross search replace count`, replaced.count, matches.length);
  assert(
    `${prefix} cross search replacement applied`,
    replaced.markdown.includes('VIOLENCEZZZ') && !hasMarkerLeak(replaced.markdown),
    replaced.markdown,
  );
}

function appendAtWritableEnd(editor: Editor, text: string): void {
  const doc = editor.state.doc;
  const last = doc.lastChild;
  if (last?.isTextblock) {
    editor.chain().focus('end').run();
    editor.commands.insertContent(text);
    return;
  }
  const paragraph = editor.state.schema.nodes.paragraph?.create();
  if (!paragraph) {
    editor.chain().focus('end').insertContent(text).run();
    return;
  }
  const tr = editor.state.tr.insert(doc.content.size, paragraph);
  const pos = tr.doc.content.size - 1;
  editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos)));
  editor.commands.insertContent(text);
}

function runContinuousModeChain(editor: Editor, after: string, prefix: string): void {
  const visual = sourceToVisual(editor, after);
  assertEqual(`${prefix} chain source->visual`, visual, canonical(after));
  assert(`${prefix} chain visual no marker`, !hasMarkerLeak(visual), visual);

  appendAtWritableEnd(editor, 'CHAIN_X');
  const edited = md(editor);
  assert(`${prefix} chain visual edit`, edited.includes('CHAIN_X') && !hasMarkerLeak(edited), edited);

  const back = visualToSource(editor);
  assert(`${prefix} chain visual->source`, back.includes('CHAIN_X') && !hasMarkerLeak(back), back);

  const visualAgain = sourceToVisual(editor, back);
  assertEqual(`${prefix} chain source->visual again`, visualAgain, canonical(back));
  assert(`${prefix} chain final no marker`, !hasMarkerLeak(visualAgain), visualAgain);
}

function runFeatureCase(feature: FeatureCase): void {
  const editor = makeEditor('Initial');
  const target = makeEditor('Initial');
  const rounds = feature.rounds ?? DEFAULT_ROUNDS;
  try {
    for (let round = 0; round < rounds; round += 1) {
      load(editor, feature.baseline);
      feature.prepare?.(editor, round);
      const before = md(editor);
      feature.apply(editor, round, target);
      const after = md(editor);
      const prefix = `${feature.name} r${round + 1}`;
      const expected = feature.expected?.(round) ?? feature.exact;

      if (expected !== undefined) {
        assertEqual(`${prefix} markdown`, after, expected);
      } else if (feature.changed !== false) {
        assert(`${prefix} changes document`, after !== before, `${before} -> ${after}`);
      }
      if (feature.includes) {
        assert(`${prefix} contains ${feature.includes}`, after.includes(feature.includes), after);
      }
      assert(`${prefix} no marker leak`, !hasMarkerLeak(after), after);
      assert(`${prefix} html non-empty`, editor.getHTML().length > 0, String(editor.getHTML().length));
      if (feature.nodeType) {
        assertEqual(
          `${prefix} ${feature.nodeType} count`,
          countNodes(editor, feature.nodeType),
          feature.nodeCount ?? 1,
        );
      }
      if (feature.selectionParent) {
        assertEqual(`${prefix} selection parent`, selectionParentType(editor), feature.selectionParent);
      }
      if (feature.targetExact) {
        assertEqual(`${prefix} target markdown`, md(target), feature.targetExact);
      }
      if (feature.targetIncludes) {
        assert(`${prefix} target contains ${feature.targetIncludes}`, md(target).includes(feature.targetIncludes), md(target));
      }
      if (feature.targetNodeType) {
        assertEqual(
          `${prefix} target ${feature.targetNodeType} count`,
          countNodes(target, feature.targetNodeType),
          feature.targetNodeCount ?? 1,
        );
      }
      feature.custom?.(editor, target, round, prefix);

      if ((round + 1) % CROSS_INTERVAL === 0) {
        crossFeature(editor, target, before, after, feature, prefix, round);
      }
      if (feature.continuousChain && (round === 3 || round === 8)) {
        runContinuousModeChain(editor, after, prefix);
      }
    }
  } finally {
    editor.destroy();
    target.destroy();
  }
}

const featureCases: FeatureCase[] = [
  {
    name: 'bold',
    baseline: 'word\n',
    prepare: selectAll,
    apply: (e) => e.chain().focus().toggleBold().run(),
    exact: '**word**\n',
    searchTerm: 'word',
  },
  {
    name: 'italic',
    baseline: 'word\n',
    prepare: selectAll,
    apply: (e) => e.chain().focus().toggleItalic().run(),
    exact: '*word*\n',
    searchTerm: 'word',
  },
  {
    name: 'strike',
    baseline: 'word\n',
    prepare: selectAll,
    apply: (e) => e.chain().focus().toggleStrike().run(),
    exact: '~~word~~\n',
    searchTerm: 'word',
  },
  {
    name: 'underline',
    baseline: 'word\n',
    prepare: selectAll,
    apply: (e) => e.chain().focus().toggleUnderline().run(),
    exact: '++word++\n',
    searchTerm: 'word',
  },
  {
    name: 'inline code',
    baseline: 'word\n',
    prepare: selectAll,
    apply: (e) => e.chain().focus().toggleCode().run(),
    exact: '`word`\n',
    searchTerm: 'word',
  },
  {
    name: 'link',
    baseline: 'word\n',
    prepare: selectAll,
    apply: (e) => e.chain().focus().setLink({ href: 'https://example.com' }).run(),
    exact: '[word](https://example.com)\n',
    searchTerm: 'word',
  },
  {
    name: 'clear formatting',
    baseline: '**bold** and *italic*\n',
    prepare: selectAll,
    apply: (e) => e.chain().focus().unsetAllMarks().run(),
    exact: 'bold and italic\n',
    searchTerm: 'bold',
  },
  {
    name: 'headings 1-6',
    baseline: 'word\n',
    prepare: selectAll,
    apply: (e, round) => e.chain().focus().toggleHeading({ level: (round % 6) + 1 }).run(),
    expected: (round) => `${'#'.repeat((round % 6) + 1)} word\n`,
    nodeType: 'heading',
    nodeCount: 1,
    searchTerm: 'word',
  },
  {
    name: 'paragraph',
    baseline: '# word\n',
    prepare: selectAll,
    apply: (e) => e.chain().focus().setParagraph().run(),
    exact: 'word\n',
    searchTerm: 'word',
  },
  {
    name: 'horizontal rule',
    baseline: 'before\n\nafter\n',
    prepare: (e) => e.commands.setTextSelection(7),
    apply: (e) => e.chain().focus().setHorizontalRule().run(),
    exact: 'before\n\n---\n\nafter\n',
    nodeType: 'horizontalRule',
    nodeCount: 1,
    searchTerm: 'before',
  },
  {
    name: 'blockquote',
    baseline: 'word\n',
    prepare: selectAll,
    apply: (e) => e.chain().focus().toggleBlockquote().run(),
    exact: '> word\n',
    searchTerm: 'word',
  },
  {
    name: 'bullet list',
    baseline: 'word\n',
    prepare: selectAll,
    apply: (e) => e.chain().focus().toggleBulletList().run(),
    exact: '- word\n',
    searchTerm: 'word',
  },
  {
    name: 'ordered list',
    baseline: 'word\n',
    prepare: selectAll,
    apply: (e) => e.chain().focus().toggleOrderedList().run(),
    exact: '1. word\n',
    searchTerm: 'word',
  },
  {
    name: 'task list',
    baseline: 'word\n',
    prepare: selectAll,
    apply: (e, round) => {
      e.chain().focus().toggleTaskList().run();
      if (round % 2 === 1) {
        e.chain().focus().updateAttributes('taskItem', { checked: true }).run();
      }
    },
    expected: (round) => (round % 2 === 1 ? '- [x] word\n' : '- [ ] word\n'),
    searchTerm: 'word',
  },
  {
    name: 'nested lists',
    baseline: '- parent\n- child\n',
    prepare: (e) => selectText(e, 'child'),
    apply: (e) => e.chain().focus().sinkListItem('listItem').run(),
    exact: '- parent\n  - child\n',
    searchTerm: 'child',
  },
  {
    name: 'table insert',
    baseline: 'word\n',
    prepare: (e) => e.commands.setTextSelection(1),
    apply: (e) => e.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run(),
    exact: '|  |  |\n| --- | --- |\n|  |  |\n\nword\n',
    nodeType: 'table',
    nodeCount: 1,
    searchTerm: 'word',
  },
  {
    name: 'table row/column mutation',
    baseline: '| A | B |\n| --- | --- |\n| 1 | 2 |\n',
    prepare: (e) => selectText(e, '1'),
    apply: (e, round) => {
      if (round % 2 === 0) {
        e.chain().focus().addRowAfter().run();
      } else {
        e.chain().focus().deleteColumn().run();
      }
    },
    custom: (editor, _target, round, prefix) => {
      if (round % 2 === 0) {
        assert(prefix, countNodes(editor, 'tableRow') === 3, String(countNodes(editor, 'tableRow')));
      } else {
        assert(prefix, countNodes(editor, 'tableHeader') === 1, String(countNodes(editor, 'tableHeader')));
      }
    },
    searchTerm: 'A',
  },
  {
    name: 'table cell edit',
    baseline: '| A | B |\n| --- | --- |\n| 1 | 2 |\n',
    prepare: (e) => selectText(e, 'A'),
    apply: (e) => e.chain().focus().insertContent('X').run(),
    exact: '| X | B |\n| --- | --- |\n| 1 | 2 |\n',
    searchTerm: 'X',
  },
  {
    name: 'table whole clipboard',
    baseline: '| A | B |\n| --- | --- |\n| 1 | 2 |\n',
    apply: (e, _round, target) => {
      selectWholeNode(e, 'table');
      const payload = copyPayload(e);
      target.commands.setContent(parseMarkdown(''), false);
      pastePayload(target, payload);
    },
    changed: false,
    undoable: false,
    targetExact: '\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n',
    targetNodeType: 'table',
    targetNodeCount: 1,
    searchTerm: 'A',
  },

  {
    name: 'inline math',
    baseline: 'before after\n',
    prepare: (e) => e.commands.setTextSelection(7),
    apply: (e) => (e as any).chain().focus().insertInlineMath('a^2').run(),
    exact: 'before$a^2$ after\n',
    nodeType: 'inlineMath',
    nodeCount: 1,
    searchTerm: 'after',
  },
  {
    name: 'display math',
    baseline: 'before\n',
    prepare: (e) => e.commands.setTextSelection(7),
    apply: (e) => (e as any).chain().focus().insertMathBlock('x^2').run(),
    exact: 'before\n\n$$\nx^2\n$$\n\n',
    nodeType: 'inlineMath',
    nodeCount: 1,
    searchTerm: 'before',
  },
  {
    name: 'math caret inside',
    baseline: 'before after\n',
    prepare: (e) => e.commands.setTextSelection(7),
    apply: (e) => (e as any).chain().focus().insertInlineMath('').run(),
    exact: 'before$ $ after\n',
    nodeType: 'inlineMath',
    nodeCount: 1,
    selectionParent: 'inlineMath',
    searchTerm: 'after',
  },
  {
    name: 'math edit',
    baseline: 'before $a^2$ after\n',
    apply: (e) => {
      const pos = findNodePosition(e, 'inlineMath');
      e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, pos + 1, pos + 2)));
      e.view.dispatch(e.state.tr.insertText('b'));
    },
    exact: 'before $b^2$ after\n',
    nodeType: 'inlineMath',
    nodeCount: 1,
    selectionParent: 'inlineMath',
    searchTerm: 'before',
  },
  {
    name: 'math clipboard',
    baseline: 'before $a^2$ after\n',
    apply: (e, _round, target) => {
      selectWholeNode(e, 'inlineMath');
      const payload = copyPayload(e);
      target.commands.setContent(parseMarkdown(''), false);
      pastePayload(target, payload);
    },
    changed: false,
    undoable: false,
    targetExact: '$a^2$\n',
    targetNodeType: 'inlineMath',
    targetNodeCount: 1,
    searchTerm: 'before',
  },
  {
    name: 'unclosed math',
    baseline: 'unclosed $x^2\n',
    apply: (e) => {
      sourceToVisual(e, e.state.doc.textContent);
    },
    changed: false,
    undoable: false,
    includes: '$x^2',
    searchTerm: 'unclosed',
  },
  {
    name: 'multiple math',
    baseline: '$x^2$ and $y^2$\n',
    apply: (e) => {
      sourceToVisual(e, md(e));
    },
    changed: false,
    undoable: false,
    includes: '$x^2$ and $y^2$',
    nodeType: 'inlineMath',
    nodeCount: 2,
    searchTerm: 'and',
  },

  {
    name: 'code pseudo math',
    baseline: '```js\nconst x = 1;\n```\n',
    prepare: (e) => {
      const pos = findNodePosition(e, 'codeBlock');
      e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, pos + 1, pos + 1)));
    },
    apply: (e) => {
      const ok = pasteClipboardPayload(e, { text: '**bold** $x^2$', html: '', markdown: '**bold** $x^2$' });
      assert('code pseudo paste returns true', ok);
    },
    includes: '**bold** $x^2$const',
    nodeType: 'codeBlock',
    nodeCount: 1,
    searchTerm: 'bold',
  },
  {
    name: 'html pseudo math',
    baseline: '<div>\n$a+b$\n</div>\n',
    apply: (e) => {
      sourceToVisual(e, md(e));
    },
    changed: false,
    undoable: false,
    includes: '$a+b$',
    nodeType: 'htmlBlock',
    nodeCount: 1,
    searchTerm: 'a+b',
  },
  {
    name: 'code block insert',
    baseline: 'word\n',
    prepare: selectAll,
    apply: (e) => e.chain().focus().toggleCodeBlock().run(),
    exact: '````\nword\n````\n',
    nodeType: 'codeBlock',
    nodeCount: 1,
    searchTerm: 'word',
  },
  {
    name: 'code language switch',
    baseline: '````js\nconst x = 1;\n````\n',
    prepare: (e) => selectText(e, 'const'),
    apply: (e) => e.chain().focus().updateAttributes('codeBlock', { language: 'python' }).run(),
    exact: '````python\nconst x = 1;\n````\n',
    nodeType: 'codeBlock',
    nodeCount: 1,
    searchTerm: 'const',
  },
  {
    name: 'code raw edit',
    baseline: '````js\nconst x = 1;\n````\n',
    prepare: (e) => selectText(e, 'const'),
    apply: (e) => e.chain().focus().insertContent('RAW_').run(),
    includes: 'RAW_ x = 1;',
    nodeType: 'codeBlock',
    nodeCount: 1,
    searchTerm: 'RAW_ x',
  },
  {
    name: 'mermaid',
    baseline: 'word\n',
    prepare: (e) => e.commands.setTextSelection(1),
    apply: (e) => (e as any).chain().focus().insertMermaidBlock('graph TD; A-->B').run(),
    exact: '\n\n````mermaid\ngraph TD; A-->B\n````\n\nword\n',
    nodeType: 'mermaidBlock',
    nodeCount: 1,
    searchTerm: 'word',
  },
  {
    name: 'image insert',
    baseline: 'word\n',
    prepare: (e) => e.commands.setTextSelection(1),
    apply: (e) => e.chain().focus().setImage({ src: './x.png', alt: 'alt' }).run(),
    exact: '![alt](./x.png)word\n',
    nodeType: 'image',
    nodeCount: 1,
    searchTerm: 'word',
  },
  {
    name: 'image clipboard',
    baseline: 'before ![alt](./x.png) after\n',
    apply: (e, _round, target) => {
      selectWholeNode(e, 'image');
      const payload = copyPayload(e);
      target.commands.setContent(parseMarkdown(''), false);
      pastePayload(target, payload);
    },
    changed: false,
    undoable: false,
    targetExact: '![alt](./x.png)\n',
    targetNodeType: 'image',
    targetNodeCount: 1,
    searchTerm: 'before',
  },
  {
    name: 'image mode cursor',
    baseline: 'before ![alt](./x.png) after\n',
    apply: (e) => {
      const caret = e.state.doc.textContent.indexOf('after') + 2;
      sourceToVisual(e, md(e), caret);
    },
    changed: false,
    undoable: false,
    includes: '![alt](./x.png)',
    nodeType: 'image',
    nodeCount: 1,
    selectionParent: 'paragraph',
    searchTerm: 'before',
  },
  {
    name: 'footnote reference',
    baseline: 'word\n',
    prepare: (e) => e.commands.setTextSelection(6),
    apply: (e) => (e as any).chain().focus().insertFootnoteReference('42').run(),
    exact: 'word[^42]\n',
    nodeType: 'footnoteReference',
    nodeCount: 1,
    searchTerm: 'word',
  },
  {
    name: 'footnote definition',
    baseline: 'word\n',
    prepare: (e) => e.commands.setTextSelection(1),
    apply: (e) => (e as any).chain().focus().insertFootnoteDefinition('42').run(),
    exact: '\n\n[^42]: \n\nword\n',
    nodeType: 'footnoteDefinition',
    nodeCount: 1,
    searchTerm: 'word',
  },
  {
    name: 'footnote switch',
    baseline: 'Text[^1]\n\n[^1]: note body\n',
    apply: (e) => {
      sourceToVisual(e, md(e));
    },
    changed: false,
    undoable: false,
    includes: 'note body',
    nodeType: 'footnoteDefinition',
    nodeCount: 1,
    searchTerm: 'Text',
  },
  {
    name: 'html block',
    baseline: 'word\n',
    prepare: (e) => e.commands.setTextSelection(1),
    apply: (e) => e.chain().focus().insertContent({ type: 'htmlBlock', attrs: { html: '<div>HTML_BLOCK</div>' } }).run(),
    exact: '\n\n<div>HTML_BLOCK</div>\n\nword\n',
    nodeType: 'htmlBlock',
    nodeCount: 1,
    searchTerm: 'word',
  },
  {
    name: 'html pseudo markdown',
    baseline: '<div># **fake** $x$</div>\n',
    apply: (e) => {
      sourceToVisual(e, md(e));
    },
    changed: false,
    undoable: false,
    includes: '# **fake** $x$',
    nodeType: 'htmlBlock',
    nodeCount: 1,
    searchTerm: 'fake',
  },

  {
    name: 'search source',
    baseline: 'hello world hello\n',
    apply: (e) => {
      const replaced = replaceAllSourceSearchMatches(md(e), 'hello', 'HELLO', { caseSensitive: false });
      sourceToVisual(e, replaced.markdown);
    },
    undoable: false,
    includes: 'HELLO world HELLO',
    searchTerm: 'HELLO',
  },
  {
    name: 'search visual',
    baseline: 'hello world hello\n',
    apply: (e) => {
      sourceToVisual(e, md(e));
      const count = replaceAllVisualSearchMatches(e, 'hello', 'HELLO', { caseSensitive: false });
      assert(`visual replace count`, count === 2, String(count));
    },
    includes: 'HELLO world HELLO',
    searchTerm: 'HELLO',
  },
  {
    name: 'search case sensitivity',
    baseline: 'Hello hello HELLO\n',
    apply: (e) => {
      const insensitive = replaceAllSourceSearchMatches(md(e), 'hello', 'X', { caseSensitive: false });
      const sensitive = replaceAllSourceSearchMatches(md(e), 'Hello', 'Y', { caseSensitive: true });
      assert(`case-insensitive count`, insensitive.count === 3, String(insensitive.count));
      assert(`case-sensitive count`, sensitive.count === 1, String(sensitive.count));
      sourceToVisual(e, insensitive.markdown);
    },
    undoable: false,
    includes: 'X X X',
    searchTerm: 'X',
  },
  {
    name: 'replace then switch',
    baseline: 'a a a\n',
    apply: (e) => {
      const matches = findSourceSearchMatches(md(e), 'a', { caseSensitive: false });
      const replaced = replaceSourceSearchMatch(md(e), matches[0]!, 'b');
      sourceToVisual(e, replaced.markdown);
      const switchedBack = visualToSource(e);
      assert(`replace then switch source`, switchedBack === 'b a a\n', switchedBack);
    },
    undoable: false,
    includes: 'b a a',
    searchTerm: 'a',
  },
  {
    name: 'history chain',
    baseline: 'word\n',
    prepare: selectAll,
    apply: (e) => e.chain().focus().toggleBold().toggleHeading({ level: 2 }).toggleBulletList().run(),
    exact: '- **word**\n',
    searchTerm: 'word',
  },
  {
    name: 'cross-mode undo redo',
    baseline: '# Title\n\nbody\n',
    apply: (e) => {
      sourceToVisual(e, md(e));
      const switched = md(e);
      e.commands.insertContent('X');
      const edited = md(e);
      e.commands.undo();
      assertEqual(`cross-mode undo after visual edit`, md(e), switched);
      e.commands.redo();
      assertEqual(`cross-mode redo after visual edit`, md(e), edited);
    },
    undoable: false,
    includes: 'X',
    searchTerm: 'Title',
  },
  {
    name: 'programmatic load undo redo',
    baseline: 'loaded text\n',
    apply: (e) => {
      load(e, 'second document\n');
      const loaded = md(e);
      e.commands.insertContent('X');
      const edited = md(e);
      e.commands.undo();
      assertEqual(`load undo only reverts edit`, md(e), loaded);
      e.commands.redo();
      assertEqual(`load redo reapplies edit`, md(e), edited);
    },
    undoable: false,
    includes: 'X',
    searchTerm: 'second',
  },
];

const continuousChainNames = new Set([
  'bold',
  'italic',
  'strike',
  'underline',
  'inline code',
  'link',
  'clear formatting',
  'headings 1-6',
  'paragraph',
  'horizontal rule',
  'blockquote',
  'bullet list',
  'ordered list',
  'task list',
  'nested lists',
  'table insert',
  'table cell edit',
  'code block insert',
  'code language switch',
  'code raw edit',
  'footnote reference',
  'footnote definition',
  'html block',
  'history chain',
  'cross-mode undo redo',
  'programmatic load undo redo',
]);
for (const feature of featureCases) {
  feature.continuousChain = continuousChainNames.has(feature.name);
}

console.log('\n## feature violence matrix');
for (const feature of featureCases) {
  runFeatureCase(feature);
}

console.log('\n## explicit image trailing caret regression');

{
  const source = '\n\n![alt](./x.png)\n\nword\n';
  const editor = makeEditor('Initial');
  try {
    sourceToVisual(editor, source);
    assertEqual(
      'image trailing caret selection parent is paragraph',
      selectionParentType(editor),
      'paragraph',
    );
    assert('image trailing caret markdown is token-free', !hasMarkerLeak(md(editor)), md(editor));
  } finally {
    editor.destroy();
  }
}

console.log('\n## clipboard context matrix');

const clipboardSources = [
  { name: 'empty', source: 'pasted marker\n' },
  { name: 'paragraph', source: 'pasted marker\n' },
  { name: 'heading', source: 'pasted marker\n' },
  { name: 'table', source: '| A | B |\n| --- | --- |\n| 1 | 2 |\n' },
  { name: 'code', source: '```js\nconst x = 1;\n```\n' },
  { name: 'formula', source: 'before $a^2$ after\n' },
  { name: 'image', source: 'before ![alt](./x.png) after\n' },
  { name: 'mixed', source: '# Title\n\nparagraph\n\n$$x^2$$\n\n```js\nconst y = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n' },
];

for (const item of clipboardSources) {
  const sourceEditor = makeEditor('Initial');
  const target = makeEditor('Initial');
  try {
    sourceToVisual(sourceEditor, item.source);
    for (let round = 0; round < 6; round += 1) {
      selectAll(sourceEditor);
      const payload = copyPayload(sourceEditor);
      target.commands.setContent(parseMarkdown(''), false);
      pastePayload(target, payload);
      const pasted = md(target);
      assert(`${item.name} clipboard round ${round + 1} non-empty token-free`, pasted.length > 0 && !hasMarkerLeak(pasted), pasted);
      assert(`${item.name} clipboard round ${round + 1} retains content`, pasted.includes('pasted') || pasted.includes('|') || pasted.includes('const') || pasted.includes('a^2') || pasted.includes('![alt]'), pasted);
      assert(`${item.name} clipboard round ${round + 1} renders`, target.getHTML().length > 0, String(target.getHTML().length));
    }
  } finally {
    sourceEditor.destroy();
    target.destroy();
  }
}

console.log('\n## selection marker sweep');

const markerSnippets = [
  '**bold** and *italic*\n',
  '![alt](./x.png)\n',
  '$$\nx^2\n$$\n',
  '```js\nconst x = 1;\n```\n',
  '> quote\n',
  '- item\n  - child\n',
  '| A | B |\n| --- | --- |\n| 1 | 2 |\n',
];

for (const snippet of markerSnippets) {
  for (let offset = 0; offset <= snippet.length; offset += 1) {
    const marked = insertSelectionMarkersIntoMarkdown(snippet, offset, offset);
    const cleaned = cleanSelectionMarkersFromJsonContent(parseMarkdown(marked));
    const cleanMd = serializeMarkdown(cleaned);
    assert(
      `marker sweep offset ${offset}`,
      !hasMarkerLeak(cleanMd) && canonical(cleanMd) === cleanMd,
      cleanMd,
    );
  }
}

console.log('\n## pure render/outline/stats');

{
  const editor = makeEditor();
  try {
    load(editor, '# Title\n\nhello world hello\n\n## Next\n\n```js\n# fake\n```\n');
    const outline = extractOutline(md(editor));
    const stats = calculateDocumentStats(md(editor));
    const html = markdownToExportHtmlFragment({ markdown: md(editor), title: 't', baseDir: '/tmp' });
    assert('outline includes real headings', outline.some((item) => item.text === 'Title') && outline.some((item) => item.text === 'Next'), JSON.stringify(outline));
    assert('outline skips fenced heading', outline.every((item) => item.text !== 'fake'), JSON.stringify(outline));
    assert('stats stay positive', stats.words > 0 && stats.lines > 0 && stats.characters > 0, JSON.stringify(stats));
    assert('export html non-empty', html.length > 0, String(html.length));
  } finally {
    editor.destroy();
  }
}

interface ShellMocks {
  saveCalls: Array<{ markdown: string }>;
  saveAsCalls: Array<{ markdown: string }>;
  pdfCalls: Array<Record<string, unknown>>;
  imageCalls: Array<Record<string, unknown>>;
  pandocCalls: Array<{ payload: Record<string, unknown>; format: string; options?: unknown }>;
  pandocCallback?: (format: string, options?: unknown) => void;
}

function createMarkdownEditorApi(mocks: ShellMocks): Record<string, unknown> {
  return {
    newWindow: async () => {},
    openDocumentDialog: async () => null,
    openDocumentDialogInNewWindow: async () => false,
    openDocumentPath: async () => { throw new Error('not used'); },
    openFolderDialog: async () => null,
    openFolderDialogInNewWindow: async () => false,
    readFolder: async () => ({ path: '', name: '', entries: [] }),
    saveDocument: async () => null,
    saveDocumentAs: async () => null,
    saveImage: async () => ({ path: 'x', markdownPath: 'x', base64: '' }),
    chooseImageDirectory: async () => null,
    openExternal: async () => {},
    exportClipboardDebug: async () => null,
    exportAsPdf: async (payload: Record<string, unknown>) => {
      mocks.pdfCalls.push(payload);
      return true;
    },
    exportAsImage: async (payload: Record<string, unknown>) => {
      mocks.imageCalls.push(payload);
      return true;
    },
    exportWithPandoc: async (payload: Record<string, unknown>, format: string, options?: unknown) => {
      mocks.pandocCalls.push({ payload, format, options });
      return true;
    },
    onExportPandocRequest: (callback: (format: string, options?: unknown) => void) => {
      mocks.pandocCallback = callback;
      return () => {};
    },
    getExportCapabilities: async () => ({}),
    getPandocTemplates: async () => ({}),
    setPandocTemplate: async () => ({}),
    choosePandocTemplate: async () => null,
    getAppInfo: async () => ({}),
    checkForUpdates: async () => ({ hasUpdate: false, latestVersion: '', releaseUrl: null }),
    reportBenchmarkMetric: () => {},
    getBenchmarkTimeline: async () => [],
    getBenchmarkEnabled: () => true,
    setTheme: async () => {},
    zoomIn: async () => {},
    zoomOut: async () => {},
    zoomReset: async () => {},
    setWindowDirty: async () => {},
    setWindowDocumentState: async () => {},
    respondSaveBeforeClose: () => {},
    acknowledgeExternalFileChange: async () => {},
    onDocumentOpened: () => () => {},
    onFolderOpened: () => () => {},
    onExportStatus: () => () => {},
    onRequestSaveBeforeClose: () => () => {},
    onMenuAction: () => () => {},
    onExternalFileChange: () => () => {},
    getPathForFile: () => 'x',
  };
}

interface MountedEditorShell {
  root: ReturnType<typeof createRoot>;
  container: HTMLDivElement;
  editor: Editor;
  dirty: boolean;
  emitted: string;
  mocks: ShellMocks;
  sourceTextarea: HTMLTextAreaElement | null;
  menuAction: (action: string) => Promise<void>;
}


async function mountEditorShell(source: string): Promise<MountedEditorShell> {
  localStorage.clear();
  const mocks: ShellMocks = {
    saveCalls: [],
    saveAsCalls: [],
    pdfCalls: [],
    imageCalls: [],
    pandocCalls: [],
  };
  (window as unknown as { markdownEditor: unknown }).markdownEditor = createMarkdownEditorApi(mocks);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const state = {
    path: '/tmp/feature-violence.md',
    title: 'feature-violence',
    markdown: source,
    savedMarkdown: source,
    dirty: false,
    lastSavedAt: Date.now(),
    stats: { words: 0, characters: 0, lines: 1 },
  };
  let dirty = false;
  let emitted = source;
  const root = createRoot(container);
  root.render(
    createElement(
      EditorShell,
      {
        document: state,
        folder: null,
        theme: 'light',
        themePalette: 'natural',
        glassEffect: 'frosted',
        resolvedTheme: 'light',
        onDocumentChange: (markdown: string) => {
          state.markdown = markdown;
          state.dirty = markdown !== state.savedMarkdown;
          emitted = markdown;
          dirty = markdown !== state.savedMarkdown;
        },
        onDocumentMetaChange: (nextDirty: boolean) => {
          state.dirty = nextDirty;
          dirty = nextDirty;
        },
        onOpenDocument: async () => {},
        onOpenDocumentPath: async () => {},
        onReloadDocumentPath: async () => {},
        onOpenFolder: async () => {},
        onSaveDocument: (markdown: string) => {
          mocks.saveCalls.push({ markdown });
          state.savedMarkdown = markdown;
          state.markdown = markdown;
          state.dirty = false;
          dirty = false;
          return true;
        },
        onSaveDocumentAs: (markdown: string) => {
          mocks.saveAsCalls.push({ markdown });
          return null;
        },
        onCreateDocument: async () => {},
        onSetTheme: () => {},
        onSetThemePalette: () => {},
        onSetGlassEffect: () => {},
        onOpenSettings: () => {},
      } as any,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  const editor = (window as unknown as Record<string, unknown>).__marivellEditor as Editor | undefined;
  if (!editor) {
    throw new Error('EditorShell did not mount an editor');
  }

  return {
    root,
    container,
    editor,
    mocks,
    get dirty() {
      return dirty;
    },
    get emitted() {
      return emitted;
    },
    get sourceTextarea() {
      return container.querySelector<HTMLTextAreaElement>('.source-editor__input');
    },
    async menuAction(action: string) {
      window.dispatchEvent(
        new CustomEvent('markdown-editor:menu-action', {
          detail: action,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 120));
    },
  };
}

console.log('\n## EditorShell menu-action flows');

{
  const source = '# Shell Title\n\nhello world\n';
  const shell = await mountEditorShell(source);
  try {
    await shell.menuAction('save-document');
    assert('shell save menu calls save once', shell.mocks.saveCalls.length === 1, String(shell.mocks.saveCalls.length));
    assert('shell save payload matches source', shell.mocks.saveCalls[0]?.markdown === source, JSON.stringify(shell.mocks.saveCalls[0]));

    await shell.menuAction('save-document-as');
    assert('shell save-as menu calls save-as once', shell.mocks.saveAsCalls.length === 1, String(shell.mocks.saveAsCalls.length));
    assert('shell save-as payload matches source', shell.mocks.saveAsCalls[0]?.markdown === source, JSON.stringify(shell.mocks.saveAsCalls[0]));

    await shell.menuAction('export-pdf');
    assert('shell pdf export called once', shell.mocks.pdfCalls.length === 1, String(shell.mocks.pdfCalls.length));
    assert('shell pdf payload matches source', shell.mocks.pdfCalls[0]?.markdown === source, JSON.stringify(shell.mocks.pdfCalls[0]));

    await shell.menuAction('export-image');
    assert('shell image export called once', shell.mocks.imageCalls.length === 1, String(shell.mocks.imageCalls.length));
    assert('shell image payload matches source', shell.mocks.imageCalls[0]?.markdown === source, JSON.stringify(shell.mocks.imageCalls[0]));

    shell.mocks.pandocCallback?.('docx');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert('shell pandoc request calls api', shell.mocks.pandocCalls.length === 1, String(shell.mocks.pandocCalls.length));
    assert('shell pandoc request format', shell.mocks.pandocCalls[0]?.format === 'docx', JSON.stringify(shell.mocks.pandocCalls[0]));
    assert('shell pandoc payload matches source', shell.mocks.pandocCalls[0]?.payload.markdown === source, JSON.stringify(shell.mocks.pandocCalls[0]));

    assert('shell opens clean', !shell.dirty && shell.emitted === source, `dirty=${shell.dirty} emitted=${JSON.stringify(shell.emitted)}`);
    await shell.menuAction('toggle-source-mode');
    assert('shell source mode shows textarea', Boolean(shell.sourceTextarea), 'missing textarea');
    assert('shell source mode preserves markdown', shell.sourceTextarea?.value === source, JSON.stringify(shell.sourceTextarea?.value));
    await shell.menuAction('toggle-source-mode');
    assert('shell visual mode hides textarea', !shell.sourceTextarea, 'textarea still present');

    shell.editor.chain().focus().insertContent('VISUAL_EDIT').run();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert('shell visual edit marks dirty', shell.dirty, `dirty=${shell.dirty}`);
    await shell.menuAction('save-document');
    assert('shell save after edit sends edited source', shell.mocks.saveCalls.length === 2 && shell.mocks.saveCalls[1]?.markdown.includes('VISUAL_EDIT'), JSON.stringify(shell.mocks.saveCalls));
    assert('shell visual edit emits after save', shell.emitted.includes('VISUAL_EDIT'), shell.emitted);
    await shell.menuAction('toggle-toolbar');
    assert('shell toolbar hides', Boolean(shell.container.querySelector('.toolbar.is-hidden')), shell.container.innerHTML.slice(0, 120));
    await shell.menuAction('toggle-toolbar');
    assert('shell toolbar restores', Boolean(shell.container.querySelector('.toolbar.is-visible')), shell.container.innerHTML.slice(0, 120));

    await shell.menuAction('toggle-sidebar');
    assert('shell sidebar hides', Boolean(shell.container.querySelector('.sidebar.is-hidden')), shell.container.innerHTML.slice(0, 120));
    await shell.menuAction('toggle-sidebar');
    assert('shell sidebar restores', Boolean(shell.container.querySelector('.sidebar:not(.is-hidden)')), shell.container.innerHTML.slice(0, 120));

    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'h', ctrlKey: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const queryInput = shell.container.querySelector<HTMLInputElement>('.search-panel__input');
    assert('shell search panel opens', Boolean(queryInput), 'missing query input');
    const replacedCount = replaceAllVisualSearchMatches(shell.editor, 'hello', 'HELLO', { caseSensitive: false });
    assert('shell visual replace count', replacedCount === 1, String(replacedCount));
    await shell.menuAction('toggle-source-mode');
    assert('shell replace all updates emitted source', shell.emitted.includes('HELLO'), shell.emitted);
    assert('shell replace all marks dirty', shell.dirty, `dirty=${shell.dirty}`);
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert('shell go-to-line opens in source mode', Boolean(document.body.querySelector('.app-dialog')), 'missing go-to-line dialog');
    document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await shell.menuAction('toggle-source-mode');
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert('shell go-to-line blocked in visual mode', !document.body.querySelector('.app-dialog'), 'dialog opened in visual mode');
  } finally {
    shell.root.unmount();
    shell.container.remove();
    (window as unknown as Record<string, unknown>).__marivellEditor = undefined;
  }
}

console.log(`\n================================================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.slice(0, 400).join('\n'));
  process.exit(1);
}

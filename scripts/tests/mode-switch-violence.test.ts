import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="editor"></div></body></html>', {
  url: 'http://localhost',
});
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
g.Event = dom.window.Event;
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
(dom.window.Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
(dom.window.Element.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {};

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
import { TextSelection } from '@tiptap/pm/state';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { createEditorExtensions } from '../../src/renderer/editor/create-editor-extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/renderer/editor/markdown';
import { replaceEditorContent } from '../../src/renderer/editor/replace-editor-content';
import { buildClipboardPayload } from '../../src/renderer/editor/clipboard';
import { pasteClipboardPayload } from '../../src/renderer/editor/plugins/markdown-paste';
import {
  insertSelectionMarkersIntoMarkdown,
  restoreSelectionMarkersFromEditorState,
} from '../../src/renderer/editor/selection-markers';
import EditorShell from '../../src/renderer/components/EditorShell';

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

function sourceToVisual(editor: Editor, source: string, selection = source.length): string {
  if (!source) {
    replaceEditorContent(editor, parseMarkdown(''));
    return md(editor);
  }
  const marked = insertSelectionMarkersIntoMarkdown(source, selection, selection);
  replaceEditorContent(editor, parseMarkdown(marked));
  restoreSelectionMarkersFromEditorState(editor.state, editor.view);
  return md(editor);
}

function visualToSource(editor: Editor): string {
  return md(editor);
}

function countString(value: string, token: string): number {
  if (!token) return 0;
  return value.split(token).length - 1;
}

function assertClean(
  name: string,
  editor: Editor,
  expectedSource: string,
  dirty: boolean,
): void {
  const markdown = md(editor);
  const json = JSON.stringify(editor.getJSON());
  const html = editor.getHTML();
  const expectedMarkdownEditorTokens = countString(expectedSource, 'MARKDOWN_EDITOR');
  const expectedSelectionTokens = countString(expectedSource, 'MDEDITORSELECTION');
  const expectedPrivateTokens = countString(expectedSource, '\uE000');
  const clean =
    markdown === expectedSource &&
    !markdown.includes('MDEDITORSELECTIONSTARTTOKEN') &&
    !markdown.includes('MDEDITORSELECTIONENDTOKEN') &&
    !json.includes('MDEDITORSELECTIONSTARTTOKEN') &&
    !json.includes('MDEDITORSELECTIONENDTOKEN') &&
    !json.includes('\uE000') &&
    !html.includes('MDEDITORSELECTIONSTARTTOKEN') &&
    !html.includes('MDEDITORSELECTIONENDTOKEN') &&
    !html.includes('\uE000') &&
    countString(markdown, 'MARKDOWN_EDITOR') === expectedMarkdownEditorTokens &&
    countString(markdown, 'MDEDITORSELECTION') === expectedSelectionTokens &&
    countString(markdown, '\uE000') === expectedPrivateTokens &&
    html.length > 0 &&
    dirty === false;
  assert(name, clean, `md=${JSON.stringify(markdown)} json=${json} html=${html}`);
}

function makeLargeDocument(): string {
  const parts: string[] = [];
  for (let index = 0; index < 120; index += 1) {
    parts.push(
      [
        `## Section ${index}`,
        '',
        `Paragraph ${index} has $x_${index}$ and inline \`code_${index}\`.`,
        '',
        `$$`,
        `y_${index} = x_${index}^2 + \\alpha_${index}`,
        `$$`,
      ].join('\n'),
    );
  }
  return `${parts.join('\n\n')}\n`;
}

const scenarios: Array<{ name: string; raw: string }> = [
  { name: 'empty-document', raw: '' },
  { name: 'plain-text', raw: 'Plain alpha text.\n\nAnother plain paragraph.\n' },
  { name: 'heading-1', raw: '# Heading One\n\nBody text.\n' },
  { name: 'heading-2', raw: '## Heading Two\n\nBody text.\n' },
  { name: 'heading-3', raw: '### Heading Three\n\nBody text.\n' },
  { name: 'heading-4', raw: '#### Heading Four\n\nBody text.\n' },
  { name: 'heading-5', raw: '##### Heading Five\n\nBody text.\n' },
  { name: 'heading-6', raw: '###### Heading Six\n\nBody text.\n' },
  {
    name: 'inline-styles',
    raw: '**bold** *italic* ~~strike~~ `code` ++underline++\n',
  },
  { name: 'link', raw: 'Visit [example](https://example.com "Example") now.\n' },
  { name: 'horizontal-rule', raw: 'Before\n\n***\n\nAfter\n' },
  { name: 'blockquote', raw: 'Before\n\n> quoted alpha\n> quoted beta\n\nAfter\n' },
  { name: 'bullet-list', raw: '- alpha\n- beta\n- gamma\n' },
  { name: 'ordered-list', raw: '3. three\n4. four\n5. five\n' },
  { name: 'task-list', raw: '- [x] done\n- [ ] pending\n' },
  {
    name: 'nested-list',
    raw: '- parent\n  - child\n    - grandchild\n      - great-grandchild\n',
  },
  {
    name: 'table',
    raw: '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n',
  },
  { name: 'code-js', raw: '```js\nconst value = 1;\nexport default value;\n```\n' },
  { name: 'code-ts', raw: '```ts\nconst value: number = 1;\nconsole.log(value);\n```\n' },
  { name: 'code-md', raw: '```md\n# Inside code\n\n**not bold**\n```\n' },
  {
    name: 'code-mermaid',
    raw: '```mermaid\ngraph TD;\n  A --> B;\n  B --> C;\n```\n',
  },
  { name: 'inline-math', raw: 'Before $x^2$ after $y_1$.\n' },
  { name: 'display-math-dollar', raw: 'Before\n\n$$\na+b=c\n$$\n\nAfter\n' },
  { name: 'display-math-bracket', raw: 'Before\n\n\\[\n\\frac{a}{b}\n\\]\n\nAfter\n' },
  { name: 'footnote', raw: 'Text with note[^1].\n\n[^1]: Footnote text\n' },
  { name: 'image', raw: 'Before\n\n![alt](./img.png "Title")\n\nAfter\n' },
  {
    name: 'html-block',
    raw: '<div class="block">\n<p>html alpha</p>\n</div>\n',
  },
  { name: 'crlf', raw: 'CRLF line one\r\n\r\nCRLF line two\r\n' },
  {
    name: 'literal-tokens',
    raw: '@@MARKDOWN_EDITOR_MATH_0@@ $x$ @@MARKDOWN_EDITOR_TOKEN_0@@\nMDEDITORSELECTIONLITERAL\n',
  },
  {
    name: 'adjacent-display-math',
    raw: '$$\na\n$$\n$$\nb\n$$\n$$\nc\n$$\n',
  },
  {
    name: 'formula-special',
    raw: '$$\n\\frac{alpha}{beta} + x_1 + \\sqrt{x_2}\n$$\n\nInline $\\gamma_2 + \\{brace\\}$\n',
  },
  {
    name: 'table-task-image',
    raw: '| Task | Image |\n| --- | --- |\n| - [ ] todo | ![pic](pic.png) |\n| - [x] done | ![alt](alt.png) |\n',
  },
  {
    name: 'quote-formula',
    raw: '> Quote with $\\alpha$ and $x_1$.\n',
  },
  {
    name: 'code-pseudo-formula',
    raw: '```js\n// $x$ and $$y$$ and \\[z\\]\nconst price = "$5";\n```\n',
  },
  { name: 'unclosed-dollar', raw: 'Price: $5 and $10\n\nOpen math: $x + $\n' },
  {
    name: 'multiple-formulas',
    raw: 'A $x^2$ B $y_1$ C $z_2$\n\n$$\nfirst = 1\n$$\n\nD $w_3$ E $v_4$\n\n$$\nsecond = 2\n$$\n',
  },
  { name: 'image-start-end', raw: '![start](start.png)\n\nmiddle\n\n![end](end.png)\n' },
  {
    name: 'deep-nesting',
    raw: '> > > deep quote\n>\n> > - parent\n> >   - child\n> >     - grandchild\n',
  },
  { name: 'large-synthetic-document', raw: makeLargeDocument() },
  {
    name: 'mixed-heavy',
    raw: [
      '# Mixed',
      '',
      '- [x] task',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '```ts',
      'const mixed = 1;',
      '```',
      '',
      '> quote $x^2$',
      '',
      '$$',
      'mixed = 1',
      '$$',
      '',
      '[^1]: note',
      '',
      '![end](end.png)',
    ].join('\n') + '\n',
  },
];

const expectedSources = scenarios.map((scenario) => canonical(scenario.raw));

function selectionForRound(source: string, round: number): number {
  if (!source) return 0;
  if (round % 3 === 0) return Math.floor(source.length / 2);
  if (round % 3 === 1) return 0;
  return source.length;
}

console.log('\n## no-edit continuous mode-switch violence');

for (let index = 0; index < scenarios.length; index += 1) {
  const scenario = scenarios[index]!;
  const expected = expectedSources[index]!;
  const editor = makeEditor('Initial');
  let dirty = false;
  try {
    for (let round = 0; round < 10; round += 1) {
      const selection = selectionForRound(expected, round);
      const visual = sourceToVisual(editor, expected, selection);
      const sourceBack = visualToSource(editor);
      assert(
        `${scenario.name}: no-edit round ${round} mode switch keeps exact markdown`,
        visual === expected && sourceBack === expected,
        `visual=${JSON.stringify(visual)} source=${JSON.stringify(sourceBack)}`,
      );
      assertClean(
        `${scenario.name}: no-edit round ${round} clean`,
        editor,
        expected,
        dirty,
      );
    }
  } finally {
    editor.destroy();
  }
}

type VisualOp = {
  name: string;
  run: (editor: Editor) => boolean;
};

function setFirstTextblockSelection(editor: Editor): boolean {
  let found = false;
  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.isTextblock && node.textContent.length > 0) {
      const from = pos + 1;
      const to = from + node.textContent.length;
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
      );
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

function ensureTextSelection(editor: Editor): void {
  if (!setFirstTextblockSelection(editor)) {
    try {
      editor.commands.setTextSelection(1);
    } catch {
      editor.commands.selectAll();
    }
  }
}

const visualEditOps: VisualOp[] = [
  {
    name: 'insert-content',
    run: (editor) => {
      ensureTextSelection(editor);
      return editor.chain().focus().insertContent(' VISUAL_EDIT_MARK').run();
    },
  },
  {
    name: 'heading-toggle',
    run: (editor) => {
      ensureTextSelection(editor);
      return editor.chain().focus().toggleHeading({ level: 2 }).run();
    },
  },
  {
    name: 'table-insert',
    run: (editor) => {
      ensureTextSelection(editor);
      return editor
        .chain()
        .focus()
        .insertTable({ rows: 2, cols: 2, withHeaderRow: true })
        .run();
    },
  },
  {
    name: 'math-block-insert',
    run: (editor) => {
      ensureTextSelection(editor);
      return (editor as any).chain().focus().insertMathBlock('x^2').run();
    },
  },
  {
    name: 'math-inline-insert',
    run: (editor) => {
      ensureTextSelection(editor);
      return (editor as any).chain().focus().insertInlineMath('y_1').run();
    },
  },
  {
    name: 'footnote-insert',
    run: (editor) => {
      ensureTextSelection(editor);
      return (editor as any).chain().focus().insertFootnoteReference('77').run();
    },
  },
  {
    name: 'image-insert',
    run: (editor) => {
      ensureTextSelection(editor);
      return editor.chain().focus().setImage({ src: './x.png', alt: 'alt' }).run();
    },
  },
  {
    name: 'task-list-toggle',
    run: (editor) => {
      ensureTextSelection(editor);
      return editor.chain().focus().toggleTaskList().run();
    },
  },
  {
    name: 'mermaid-insert',
    run: (editor) => {
      ensureTextSelection(editor);
      return (editor as any).chain().focus().insertMermaidBlock('graph TD; A-->B').run();
    },
  },
  {
    name: 'bullet-list-toggle',
    run: (editor) => {
      ensureTextSelection(editor);
      return editor.chain().focus().toggleBulletList().run();
    },
  },
  {
    name: 'blockquote-toggle',
    run: (editor) => {
      ensureTextSelection(editor);
      return editor.chain().focus().toggleBlockquote().run();
    },
  },
];

function runVisualOp(editor: Editor, op: VisualOp): void {
  try {
    const ok = op.run(editor);
    if (!ok) {
      editor.chain().focus().insertContent(' FALLBACK_VISUAL_MARK').run();
    }
  } catch {
    try {
      editor.chain().focus().insertContent(' FALLBACK_VISUAL_MARK').run();
    } catch {
      editor.commands.selectAll();
    }
  }
}

function expectedAfterVisualOp(editor: Editor, op: VisualOp): string {
  const reference = makeEditor();
  try {
    replaceEditorContent(reference, editor.getJSON());
    runVisualOp(reference, op);
    return md(reference);
  } finally {
    reference.destroy();
  }
}

interface InsertionPoint {
  name: string;
  pos: number;
}

function insertionPoints(source: string): InsertionPoint[] {
  const points: InsertionPoint[] = [];
  if (!source) return points;
  points.push({ name: 'head', pos: 0 });
  points.push({ name: 'tail', pos: source.length });
  points.push({ name: 'middle', pos: Math.floor(source.length / 2) });

  const codeMatch = source.match(/```[^\n]*\n/);
  if (codeMatch?.index != null) {
    points.push({ name: 'code', pos: codeMatch.index + codeMatch[0].length });
  }

  const displayIndex = source.indexOf('$$\n');
  if (displayIndex >= 0) {
    points.push({ name: 'display-math', pos: displayIndex + 3 });
  }
  const bracketIndex = source.indexOf('\\[\n');
  if (bracketIndex >= 0) {
    points.push({ name: 'bracket-math', pos: bracketIndex + 3 });
  }

  const tableIndex = source.indexOf('| ');
  if (tableIndex >= 0) {
    points.push({ name: 'table', pos: tableIndex + 2 });
  }

  const quoteIndex = source.indexOf('> ');
  if (quoteIndex >= 0) {
    points.push({ name: 'quote', pos: quoteIndex + 2 });
  }

  return points;
}

function insertAt(source: string, pos: number, text: string): string {
  const safe = Math.max(0, Math.min(pos, source.length));
  return `${source.slice(0, safe)}${text}${source.slice(safe)}`;
}

function chooseInsertionPoint(source: string, round: number): InsertionPoint {
  const points = insertionPoints(source);
  if (points.length === 0) return { name: 'empty', pos: 0 };
  const preferred = ['code', 'display-math', 'bracket-math', 'table', 'quote'];
  const preferredPoint = points.find((point) => preferred.includes(point.name));
  if (round === 0) return points.find((point) => point.name === 'head') ?? points[0]!;
  if (round === 1) return points.find((point) => point.name === 'tail') ?? points[0]!;
  return preferredPoint ?? points.find((point) => point.name === 'middle') ?? points[0]!;
}

function applySourceInterruption(
  source: string,
  scenarioName: string,
  round: number,
): { edited: string; label: string } {
  const token = `SRC_${scenarioName.replace(/\W/g, '_')}_${round}`;
  if (round === 0) {
    const search = source.search(/(?:plain|alpha|body|text|word|cell|Paragraph|Mixed)/i);
    if (search >= 0) {
      return {
        edited: `${source.slice(0, search)}SEARCH_REPLACED${source.slice(search + 5)}`,
        label: 'source-search-replace',
      };
    }
  }
  const point = chooseInsertionPoint(source, round);
  return {
    edited: insertAt(source, point.pos, `${token}\n`),
    label: `source-insert-${point.name}`,
  };
}

console.log('\n## interleaved source/visual edits');

for (let index = 0; index < scenarios.length; index += 1) {
  const scenario = scenarios[index]!;
  const editor = makeEditor('Initial');
  try {
    let current = expectedSources[index]!;
    for (let round = 0; round < 3; round += 1) {
      const point = chooseInsertionPoint(current, round);
      const sourceToken = `SRC_EDIT_${scenario.name.replace(/\W/g, '_')}_${round}`;
      const edited = insertAt(current, point.pos, sourceToken);
      const expectedEdited = canonical(edited);
      const visual = sourceToVisual(editor, edited);
      assert(
        `${scenario.name}: interleaved ${round} source edit (${point.name}) reaches exact visual markdown`,
        visual === expectedEdited && !visual.includes('MDEDITORSELECTIONSTARTTOKEN') && !visual.includes('MDEDITORSELECTIONENDTOKEN'),
        `expected=${JSON.stringify(expectedEdited)} actual=${JSON.stringify(visual)}`,
      );

      const op = visualEditOps[(index + round) % visualEditOps.length]!;
      const expectedVisual = expectedAfterVisualOp(editor, op);
      runVisualOp(editor, op);
      const actualSource = visualToSource(editor);
      assert(
        `${scenario.name}: interleaved ${round} visual ${op.name} reaches exact source markdown`,
        actualSource === expectedVisual,
        `expected=${JSON.stringify(expectedVisual)} actual=${JSON.stringify(actualSource)}`,
      );

      const expectedRoundTrip = canonical(actualSource);
      const roundTripVisual = sourceToVisual(editor, actualSource);
      const roundTripSource = visualToSource(editor);
      const clean =
        roundTripVisual === expectedRoundTrip &&
        roundTripSource === expectedRoundTrip &&
        !roundTripVisual.includes('MDEDITORSELECTIONSTARTTOKEN') && !roundTripVisual.includes('MDEDITORSELECTIONENDTOKEN') &&
        !roundTripVisual.includes('\uE000') &&
        !JSON.stringify(editor.getJSON()).includes('MDEDITORSELECTIONSTARTTOKEN') &&
        !JSON.stringify(editor.getJSON()).includes('MDEDITORSELECTIONENDTOKEN') &&
        !JSON.stringify(editor.getJSON()).includes('\uE000') &&
        editor.getHTML().length > 0;
      assert(
        `${scenario.name}: interleaved ${round} round trip is strict and clean`,
        clean,
        `expected=${JSON.stringify(expectedRoundTrip)} visual=${JSON.stringify(roundTripVisual)} source=${JSON.stringify(roundTripSource)}`,
      );
      current = expectedVisual;
    }
  } finally {
    editor.destroy();
  }
}

const interruptionOps: VisualOp[] = [
  {
    name: 'copy-paste',
    run: (editor) => {
      editor.commands.selectAll();
      const payload = buildClipboardPayload(editor.view);
      editor.commands.setTextSelection(editor.state.doc.content.size);
      return pasteClipboardPayload(editor, payload);
    },
  },
  {
    name: 'undo-redo',
    run: (editor) => {
      ensureTextSelection(editor);
      const before = md(editor);
      const inserted = editor.chain().focus().insertContent(' UNDO_REDO_MARK').run();
      if (!inserted) return false;
      const after = md(editor);
      editor.commands.undo();
      const undone = md(editor) === before;
      editor.commands.redo();
      return undone && md(editor) === after;
    },
  },
  {
    name: 'format-bold',
    run: (editor) => {
      ensureTextSelection(editor);
      return editor.chain().focus().toggleBold().run();
    },
  },
  {
    name: 'format-strike',
    run: (editor) => {
      ensureTextSelection(editor);
      return editor.chain().focus().toggleStrike().run();
    },
  },
  {
    name: 'insert-code-block',
    run: (editor) => {
      ensureTextSelection(editor);
      return editor.chain().focus().setCodeBlock({ language: 'js' }).run();
    },
  },
  {
    name: 'insert-table',
    run: (editor) => {
      ensureTextSelection(editor);
      return editor
        .chain()
        .focus()
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run();
    },
  },
  {
    name: 'insert-display-math',
    run: (editor) => {
      ensureTextSelection(editor);
      return (editor as any).chain().focus().insertMathBlock('x^2').run();
    },
  },
  {
    name: 'insert-image',
    run: (editor) => {
      ensureTextSelection(editor);
      return editor.chain().focus().setImage({ src: './i.png', alt: 'i' }).run();
    },
  },
  {
    name: 'insert-footnote',
    run: (editor) => {
      ensureTextSelection(editor);
      return (editor as any).chain().focus().insertFootnoteReference('99').run();
    },
  },
  {
    name: 'insert-mermaid',
    run: (editor) => {
      ensureTextSelection(editor);
      return (editor as any).chain().focus().insertMermaidBlock('graph LR; A-->B').run();
    },
  },
  {
    name: 'insert-html',
    run: (editor) => {
      ensureTextSelection(editor);
      return editor
        .chain()
        .focus()
        .insertContent('<div data-interrupt="true">interrupt html</div>')
        .run();
    },
  },
  {
    name: 'select-all-jump',
    run: (editor) => {
      editor.commands.selectAll();
      const size = editor.state.doc.content.size;
      const selected = editor.state.selection.from !== editor.state.selection.to;
      editor.commands.setTextSelection(size);
      return selected && editor.state.selection.empty;
    },
  },
  {
    name: 'table-row-column',
    run: (editor) => {
      let tableCount = 0;
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'table') tableCount += 1;
        return true;
      });
      if (tableCount === 0) {
        ensureTextSelection(editor);
        return editor
          .chain()
          .focus()
          .insertTable({ rows: 2, cols: 2, withHeaderRow: true })
          .run();
      }
      setFirstTextblockSelection(editor);
      const ok = editor.chain().focus().addRowAfter().run();
      if (ok) return true;
      return editor.chain().focus().addColumnAfter().run();
    },
  },
];

console.log('\n## interrupted mode switches');

for (let index = 0; index < scenarios.length; index += 1) {
  const scenario = scenarios[index]!;
  const editor = makeEditor('Initial');
  try {
    let current = expectedSources[index]!;
    for (let round = 0; round < 2; round += 1) {
      const interruption = applySourceInterruption(current, scenario.name, round);
      const expectedAfterSource = canonical(interruption.edited);
      const visualAfterSource = sourceToVisual(editor, interruption.edited);
      assert(
        `${scenario.name}: interrupted ${round} ${interruption.label} reaches exact visual markdown`,
        visualAfterSource === expectedAfterSource &&
          !visualAfterSource.includes('MDEDITORSELECTIONSTARTTOKEN') &&
          !visualAfterSource.includes('MDEDITORSELECTIONENDTOKEN'),
        `expected=${JSON.stringify(expectedAfterSource)} actual=${JSON.stringify(visualAfterSource)}`,
      );

      const op = interruptionOps[(index + round * 3) % interruptionOps.length]!;
      const expectedAfterVisual = expectedAfterVisualOp(editor, op);
      runVisualOp(editor, op);
      const sourceAfterVisual = visualToSource(editor);
      assert(
        `${scenario.name}: interrupted ${round} visual ${op.name} reaches exact source markdown`,
        sourceAfterVisual === expectedAfterVisual,
        `expected=${JSON.stringify(expectedAfterVisual)} actual=${JSON.stringify(sourceAfterVisual)}`,
      );

      const expectedFinal = canonical(sourceAfterVisual);
      const finalVisual = sourceToVisual(editor, sourceAfterVisual);
      const finalSource = visualToSource(editor);
      const clean =
        finalVisual === expectedFinal &&
        finalSource === expectedFinal &&
        !finalVisual.includes('MDEDITORSELECTIONSTARTTOKEN') && !finalVisual.includes('MDEDITORSELECTIONENDTOKEN') &&
        !finalVisual.includes('\uE000') &&
        !JSON.stringify(editor.getJSON()).includes('MDEDITORSELECTIONSTARTTOKEN') &&
        !JSON.stringify(editor.getJSON()).includes('MDEDITORSELECTIONENDTOKEN') &&
        !JSON.stringify(editor.getJSON()).includes('\uE000') &&
        editor.getHTML().length > 0;
      assert(
        `${scenario.name}: interrupted ${round} final round trip is strict and clean`,
        clean,
        `expected=${JSON.stringify(expectedFinal)} visual=${JSON.stringify(finalVisual)} source=${JSON.stringify(finalSource)}`,
      );
      current = expectedAfterVisual;
    }
  } finally {
    editor.destroy();
  }
}

function createMarkdownEditorApi(): Record<string, unknown> {
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
    exportAsPdf: async () => true,
    exportAsImage: async () => true,
    exportWithPandoc: async () => true,
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
    onExportPandocRequest: () => () => {},
    getPathForFile: () => 'x',
  };
}

interface MountedEditorShell {
  root: ReturnType<typeof createRoot>;
  container: HTMLDivElement;
  editor: Editor;
  dirty: boolean;
  emitted: string;
  sourceTextarea: HTMLTextAreaElement | null;
  toggle: () => Promise<void>;
}

async function mountEditorShell(source: string): Promise<MountedEditorShell> {
  window.localStorage.clear();
  (window as unknown as { markdownEditor: unknown }).markdownEditor = createMarkdownEditorApi();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const state = {
    path: `/tmp/shell-violence-${Date.now()}-${Math.random()}.md`,
    title: 'shell-violence',
    markdown: source,
    savedMarkdown: source,
    dirty: false,
    lastSavedAt: Date.now(),
    stats: { words: 0, characters: 0, lines: 1 },
  };
  let dirty = false;
  let emitted = source;
  const handleDocumentChange = (markdown: string): void => {
    emitted = markdown;
    dirty = markdown !== state.savedMarkdown;
  };
  const handleDocumentMetaChange = (nextDirty: boolean): void => {
    dirty = nextDirty;
  };
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
        onDocumentChange: handleDocumentChange,
        onDocumentMetaChange: handleDocumentMetaChange,
        onOpenDocument: async () => {},
        onOpenDocumentPath: async () => {},
        onReloadDocumentPath: async () => {},
        onOpenFolder: async () => {},
        onSaveDocument: async () => true,
        onSaveDocumentAs: async () => null,
        onCreateDocument: async () => {},
        onSetTheme: () => {},
        onSetThemePalette: () => {},
        onSetGlassEffect: () => {},
        onOpenSettings: () => {},
      } as any,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 180));
  const editor = (window as unknown as Record<string, unknown>).__marivellEditor as Editor | undefined;
  if (!editor) {
    throw new Error('EditorShell did not mount an editor');
  }

  return {
    root,
    container,
    editor,
    get dirty() {
      return dirty;
    },
    get emitted() {
      return emitted;
    },
    get sourceTextarea() {
      return container.querySelector<HTMLTextAreaElement>('.source-editor__input');
    },
    async toggle() {
      window.dispatchEvent(
        new CustomEvent('markdown-editor:menu-action', {
          detail: 'toggle-source-mode',
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 120));
    },
  };
}

function setTextareaValue(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  if (setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }
  const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps$'));
  const reactProps = propsKey ? (input as Record<string, unknown>)[propsKey] as Record<string, unknown> | undefined : undefined;
  const onChange = reactProps?.onChange;
  if (typeof onChange === 'function') {
    (onChange as (event: unknown) => void)({ target: input, currentTarget: input });
    return;
  }
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function makeScrollLargeDocument(kind: 'sections' | 'mixed' | 'formula'): string {
  const parts: string[] = [];
  const count = kind === 'mixed' ? 90 : 150;
  for (let index = 0; index < count; index += 1) {
    if (kind === 'mixed') {
      parts.push(
        [
          `## Mixed Section ${index}`,
          '',
          `| Key ${index} | Value ${index} |`,
          '| --- | --- |',
          `| alpha | ${index} |`,
          '',
          '```ts',
          `const value${index} = ${index};`,
          '```',
          '',
          `> quote $x_${index}$`,
        ].join('\n'),
      );
      continue;
    }
    if (kind === 'formula') {
      parts.push(
        [
          `#### Formula Section ${index}`,
          '',
          `Inline $x_${index}^2$ and $y_{${index}}$`,
          '',
          '$$',
          `z_${index} = \\alpha_${index} + \\beta_${index}`,
          '$$',
        ].join('\n'),
      );
      continue;
    }
    parts.push(
      [
        `## Scroll Section ${index}`,
        '',
        `Paragraph ${index} with \`code_${index}\` and $x_${index}$ and [link](https://example.com).`,
      ].join('\n'),
    );
  }
  return `${parts.join('\n\n')}\n`;
}

function scrollEditorFrameToBottom(container: HTMLElement): HTMLElement | null {
  const frame = container.querySelector<HTMLElement>('.editor-frame');
  if (!frame) {
    return null;
  }
  frame.style.height = '4000px';
  frame.style.minHeight = '4000px';
  frame.style.overflow = 'auto';
  try {
    Object.defineProperty(frame, 'scrollHeight', {
      configurable: true,
      value: 100000,
    });
    Object.defineProperty(frame, 'clientHeight', {
      configurable: true,
      value: 800,
    });
  } catch {
    // jsdom may expose these as non-configurable; style height is enough for the test hook.
  }
  frame.scrollTop = 95000;
  frame.dispatchEvent(new window.Event('scroll', { bubbles: true }));
  return frame;
}

const shellScenarios: Array<{ name: string; source: string }> = [
  { name: 'shell-empty', source: expectedSources[0]! },
  { name: 'shell-heading-math', source: expectedSources[2]! },
  { name: 'shell-inline-styles', source: expectedSources[8]! },
  { name: 'shell-table', source: expectedSources[14]! },
  { name: 'shell-code', source: expectedSources[17]! },
  { name: 'shell-lists', source: expectedSources[15]! },
  { name: 'shell-footnote', source: expectedSources[22]! },
  { name: 'shell-html', source: expectedSources[25]! },
  { name: 'shell-tokens', source: expectedSources[27]! },
  { name: 'shell-formula', source: expectedSources[30]! },
  { name: 'shell-image', source: expectedSources[36]! },
  { name: 'shell-large', source: expectedSources[38]! },
];

console.log('\n## real EditorShell integration matrix');

for (let shellIndex = 0; shellIndex < shellScenarios.length; shellIndex += 1) {
  const scenario = shellScenarios[shellIndex]!;
  const shell = await mountEditorShell(scenario.source);
  try {
    assert(
      `${scenario.name}: opened clean`,
      !shell.dirty && shell.emitted === scenario.source,
      `dirty=${shell.dirty} emitted=${JSON.stringify(shell.emitted)}`,
    );

    let current = scenario.source;
    let dirty = false;
    for (let toggleRound = 0; toggleRound < 6; toggleRound += 1) {
      await shell.toggle();
      const inSourceMode = Boolean(shell.sourceTextarea);
      const expectedMode = toggleRound % 2 === 0;
      assert(
        `${scenario.name}: toggle ${toggleRound} reaches expected mode and content`,
        inSourceMode === expectedMode &&
          shell.emitted === current &&
          shell.dirty === dirty,
        `source=${inSourceMode} expectedSource=${expectedMode} emitted=${JSON.stringify(shell.emitted)} dirty=${shell.dirty}`,
      );

      if (inSourceMode) {
        const clean =
          shell.sourceTextarea?.value === current &&
          !shell.container.innerHTML.includes('MDEDITORSELECTIONSTARTTOKEN') && !shell.container.innerHTML.includes('MDEDITORSELECTIONENDTOKEN') &&
          !shell.container.innerHTML.includes('\uE000');
        assert(
          `${scenario.name}: toggle ${toggleRound} source textarea strict and marker-free`,
          clean,
          `value=${JSON.stringify(shell.sourceTextarea?.value)}`,
        );
      } else {
        const visualClean =
          shell.editor.getHTML().length > 0 &&
          !JSON.stringify(shell.editor.getJSON()).includes('MDEDITORSELECTIONSTARTTOKEN') &&
          !JSON.stringify(shell.editor.getJSON()).includes('MDEDITORSELECTIONENDTOKEN') &&
          !JSON.stringify(shell.editor.getJSON()).includes('\uE000');
        assert(
          `${scenario.name}: toggle ${toggleRound} visual render non-empty and marker-free`,
          visualClean,
          `html=${shell.editor.getHTML()}`,
        );
      }

      if (inSourceMode && (toggleRound === 2 || toggleRound === 4)) {
        const token = `SHELL_SRC_${shellIndex}_${toggleRound}`;
        const input = shell.sourceTextarea;
        if (input) {
          const edited = `${current}${token}\n`;
          setTextareaValue(input, edited);
          await new Promise((resolve) => setTimeout(resolve, 120));
          const fired =
            shell.emitted === edited &&
            shell.sourceTextarea?.value === edited &&
            shell.dirty === true;
          assert(
            `${scenario.name}: toggle ${toggleRound} real textarea edit fires React onChange`,
            fired,
            `emitted=${JSON.stringify(shell.emitted)} value=${JSON.stringify(shell.sourceTextarea?.value)} dirty=${shell.dirty}`,
          );
          current = edited;
          dirty = true;
        }
      } else if (!inSourceMode && (toggleRound === 1 || toggleRound === 3)) {
        const op = visualEditOps[(shellIndex + toggleRound) % visualEditOps.length]!;
        const expectedAfter = expectedAfterVisualOp(shell.editor, op);
        runVisualOp(shell.editor, op);
        current = expectedAfter;
        dirty = true;
      }
    }

    assert(
      `${scenario.name}: final document remains non-empty`,
      shell.editor.getHTML().length > 0,
      shell.editor.getHTML(),
    );
  } finally {
    shell.root.unmount();
    shell.container.remove();
    (window as unknown as Record<string, unknown>).__marivellEditor = undefined;
  }
}

const scrollShellScenarios: Array<{ name: string; source: string }> = [
  { name: 'scroll-large', source: expectedSources[38]! },
  { name: 'scroll-mixed', source: makeScrollLargeDocument('mixed') },
  { name: 'scroll-formula', source: makeScrollLargeDocument('formula') },
];

console.log('\n## visual scroll to bottom -> source switch');

for (const scrollScenario of scrollShellScenarios) {
  const shell = await mountEditorShell(scrollScenario.source);
  try {
    assert(
      `${scrollScenario.name}: opened clean`,
      !shell.dirty && shell.emitted === scrollScenario.source,
      `dirty=${shell.dirty} emitted=${JSON.stringify(shell.emitted)}`,
    );

    for (let round = 0; round < 2; round += 1) {
      if (round > 0) {
        await shell.toggle();
      }
      const frame = scrollEditorFrameToBottom(shell.container);
      assert(
        `${scrollScenario.name}: round ${round} visual scroll simulated`,
        frame !== null && frame.scrollTop > 0,
        `scrollTop=${frame?.scrollTop ?? 'null'}`,
      );

      await shell.toggle();
      const textarea = shell.sourceTextarea;
      const highlight = shell.container.querySelector<HTMLElement>('.source-editor__highlight');
      const highlightContent = shell.container.querySelector<HTMLElement>('.source-editor__highlight-content');
      const clean =
        textarea !== null &&
        textarea.value.length > 0 &&
        textarea.value === scrollScenario.source &&
        highlight !== null &&
        highlight.innerHTML.length > 0 &&
        (highlightContent === null || highlightContent.innerHTML.length > 0) &&
        !shell.container.innerHTML.includes('MDEDITORSELECTIONSTARTTOKEN') &&
        !shell.container.innerHTML.includes('MDEDITORSELECTIONENDTOKEN') &&
        !shell.container.innerHTML.includes('\uE000') &&
        shell.dirty === false &&
        shell.emitted === scrollScenario.source;
      assert(
        `${scrollScenario.name}: round ${round} source after visual scroll is non-blank and clean`,
        clean,
        `valueLen=${textarea?.value.length ?? 0} value=${JSON.stringify(textarea?.value.slice(0, 120))} highlight=${highlight?.innerHTML.length ?? 0} dirty=${shell.dirty}`,
      );
    }
  } finally {
    shell.root.unmount();
    shell.container.remove();
    (window as unknown as Record<string, unknown>).__marivellEditor = undefined;
  }
}

console.log('\n================================================');

console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

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
import { createEditorExtensions } from '../../src/renderer/editor/create-editor-extensions';
import { parseMarkdown, serializeMarkdown } from '../../src/renderer/editor/markdown';
import { replaceEditorContent } from '../../src/renderer/editor/replace-editor-content';
import {
  insertSelectionMarkersIntoMarkdown,
  restoreSelectionMarkersFromEditorState,
} from '../../src/renderer/editor/selection-markers';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import EditorShell from '../../src/renderer/components/EditorShell';

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


console.log('\n## EditorShell no-edit mode switches stay clean');

interface EditorShellFixture {
  name: string;
  source: string;
}

const editorShellFixtures: EditorShellFixture[] = [
  { name: 'math', source: '# Math\n\n$x^2$\n\n$$\na+b\n$$\n' },
  { name: 'code-block', source: '```js\nconst x = 1;\n```\n' },
  { name: 'image', source: 'Before\n\n![alt](../images/dora.png)\n\nAfter\n' },
  { name: 'table', source: '| A | B |\n| --- | --- |\n| 1 | 2 |\n' },
  { name: 'footnote', source: 'Text[^1]\n\n[^1]: Note\n' },
  { name: 'crlf', source: 'Line one\r\nLine two\r\n' },
  { name: 'literal-tokens', source: '@@MARKDOWN_EDITOR_MATH_0@@ $x$ @@MARKDOWN_EDITOR_TOKEN_0@@\n' },
  { name: 'empty', source: '' },
  { name: 'repeated', source: '# Title\n\nbody\n' },
];

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
  (window as unknown as { markdownEditor: unknown }).markdownEditor = createMarkdownEditorApi();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const state = {
    path: '/tmp/mode-edit.md',
    title: 'mode-edit',
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
  await new Promise((resolve) => setTimeout(resolve, 150));
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
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  };
}

for (const fixture of editorShellFixtures) {
  const shell = await mountEditorShell(fixture.source);
  try {
    assert(
      `${fixture.name}: opened clean`,
      !shell.dirty && shell.emitted === fixture.source,
      `dirty=${shell.dirty} emitted=${JSON.stringify(shell.emitted)}`,
    );

    for (let round = 0; round < 4; round += 1) {
      await shell.toggle();
      const inSourceMode = Boolean(shell.sourceTextarea);
      assert(
        `${fixture.name}: toggle ${round + 1} reaches expected mode`,
        (round % 2 === 0) === inSourceMode,
        `round=${round} source=${inSourceMode}`,
      );
      if (inSourceMode) {
        const expectedSourceValue = fixture.source.replace(/\r\n/g, '\n');
        assert(
          `${fixture.name}: source mode preserves markdown`,
          shell.sourceTextarea?.value === expectedSourceValue,
          JSON.stringify(shell.sourceTextarea?.value),
        );
      }
      assert(
        `${fixture.name}: toggle ${round + 1} stays clean`,
        !shell.dirty &&
          shell.emitted === fixture.source &&
          !shell.container.innerHTML.includes('MDEDITORSELECTION'),
        `dirty=${shell.dirty} emitted=${JSON.stringify(shell.emitted)}`,
      );
    }
  } finally {
    shell.root.unmount();
    shell.container.remove();
    (window as unknown as Record<string, unknown>).__marivellEditor = undefined;
  }
}

console.log(`\n================================================`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

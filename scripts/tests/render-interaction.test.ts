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
import * as TiptapReact from '@tiptap/react';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { createEditorExtensions } from '../../src/renderer/editor/create-editor-extensions';
import CodeBlockView from '../../src/renderer/editor/node-views/CodeBlockView';
import ImageView from '../../src/renderer/editor/node-views/ImageView';
import { parseMarkdown, serializeMarkdown } from '../../src/renderer/editor/markdown';
import { replaceEditorContent } from '../../src/renderer/editor/replace-editor-content';
import { findVisualSearchMatches, selectVisualSearchMatch } from '../../src/renderer/editor/search';
import {
  clearFormulaHtmlCache,
  getCachedFormulaHtml,
  getFormulaCacheKey,
  seedFormulaHtmlCache,
} from '../../src/renderer/editor/math-render-cache';
import {
  collectFormulaIndex,
  renderFormulaChunk,
  splitFormulaChunks,
} from '../../src/renderer/editor/markdown.worker';
import {
  insertSelectionMarkersIntoMarkdown,
  restoreSelectionMarkersFromEditorState,
} from '../../src/renderer/editor/selection-markers';
import { buildBlockModelFromEditor, getBlockAtPos } from '../../src/renderer/editor/block-model';
import { markdownOffsetToPmPos } from '../../src/renderer/editor/position-map';
import {
  captureSourceScrollAnchor,
  captureVisualScrollAnchor,
  restoreSourceScrollAnchor,
  restoreVisualScrollAnchor,
} from '../../src/renderer/editor/scroll-anchor';
import { extractOutlineFromEditor } from '../../src/renderer/components/EditorShell';
import { buildClipboardPayload } from '../../src/renderer/editor/clipboard';
import { pasteClipboardPayload } from '../../src/renderer/editor/plugins/markdown-paste';
import {
  VIRTUAL_ACTIVATION_BATCH_SIZE,
  forceActivate,
  forceHydrateAll,
  hydrateTargetRange,
  registerVirtualNodeView,
  resetActivationControllerForTest,
  setScrollAnchorProvider,
} from '../../src/renderer/editor/virtualization/activation-controller';
import {
  coordsAtPos,
  domAtPos,
  forceActivateAtCoords,
  forceActivateAtPosition,
  posAtCoords,
  scrollPosIntoView,
} from '../../src/renderer/editor/virtualization/coordinate-service';
import {
  clearNodeHeightCache,
  getCachedNodeHeight,
  getHeightCacheKey,
  notifyNodeHeightCacheSeeded,
  setCachedNodeHeight,
} from '../../src/renderer/editor/virtualization/height-cache';
import {
  buildFormulaHeightMeasurementItems,
  getFormulaHeightKey,
  measureFormulaHeights,
  resetHeightMeasurerForTest,
} from '../../src/renderer/editor/virtualization/height-measurer';
import {
  getInlineMathGroupCountForTest,
  getInlineMathGroupIndexTestCountersForTest,
  hydrateInlineMathGroupsAroundPosition,
  resetInlineMathGroupRegistryForTest,
} from '../../src/renderer/editor/virtualization/inline-math-group-registry';
import {
  getVirtualNodePositionIndexSizeForTest,
  getVirtualNodePositionIndexTestCountersForTest,
} from '../../src/renderer/editor/virtualization/activation-controller';

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

  const allSyntaxSpans = editor.view.dom.querySelectorAll('[class*="math-syntax-"]');
  const outsideEditingFormula = Array.from(allSyntaxSpans).filter(
    (element) => !element.closest('.math-inline-node.is-editing'),
  );
  assert(
    `${name}: syntax spans stay inside the focused formula`,
    outsideEditingFormula.length === 0,
    `outside=${outsideEditingFormula.length} total=${allSyntaxSpans.length}`,
  );
}

function assertNoMathSyntaxDecorations(name: string, editor: Editor): void {
  const count = editor.view.dom.querySelectorAll('[class*="math-syntax-"]').length;
  assert(`${name}: no math syntax decoration outside editing/viewport`, count === 0, `count=${count}`);
}

function focusFirstMath(editor: Editor): void {
  const pos = findNodePosition(editor, 'inlineMath');
  if (pos === null) throw new Error('missing inlineMath');
  editor.commands.setTextSelection(pos + 1);
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

{
  const element = document.createElement('div');
  let activated = 0;
  let deactivated = 0;
  const unregister = registerVirtualNodeView('no-io-activation-test', element, {
    activate: () => {
      activated += 1;
    },
    deactivate: () => {
      deactivated += 1;
    },
    shouldDeactivate: () => true,
  });
  assert(
    'activation controller activates immediately without IntersectionObserver',
    activated === 1 && deactivated === 0,
    `activated=${activated} deactivated=${deactivated}`,
  );
  assert(
    'activation controller sets data-virtual-node-id',
    element.dataset.virtualNodeId === 'no-io-activation-test',
    String(element.dataset.virtualNodeId),
  );
  unregister();
}

{
  const globals = globalThis as Record<string, unknown>;
  const previousIntersectionObserver = globals.IntersectionObserver;
  class FakeIntersectionObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globals.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;

  const element = document.createElement('div');
  const nested = document.createElement('span');
  element.appendChild(nested);
  let activated = 0;
  const unregister = registerVirtualNodeView('coordinate-service-activation-test', element, {
    activate: () => {
      activated += 1;
    },
    deactivate: () => {},
    shouldDeactivate: () => true,
  });
  const editor = makeEditor('Initial');
  try {
    let threw = false;
    try {
      forceActivateAtPosition(editor, 0);
    } catch {
      threw = true;
    }
    assert('coordinate service does not throw in jsdom', !threw, 'forceActivateAtPosition threw');
    assert('coordinate service leaves placeholder inactive', activated === 0, `activated=${activated}`);
    const fakeEditor = {
      view: { domAtPos: () => ({ node: nested, offset: 0 }) },
    } as unknown as Editor;
    forceActivateAtPosition(fakeEditor, 0);
    assert(
      'coordinate service activates dataset ancestor',
      activated === 1,
      `activated=${activated}`,
    );
  } finally {
    unregister();
    editor.destroy();
    if (previousIntersectionObserver === undefined) {
      delete globals.IntersectionObserver;
    } else {
      globals.IntersectionObserver = previousIntersectionObserver;
    }
  }
}

{
  const globals = globalThis as Record<string, unknown>;
  const previousIntersectionObserver = globals.IntersectionObserver;
  class FakeIntersectionObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globals.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;

  const element = document.createElement('div');
  const nested = document.createElement('span');
  element.appendChild(nested);
  let activated = 0;
  const unregister = registerVirtualNodeView('coordinate-service-coords-activation-test', element, {
    activate: () => {
      activated += 1;
    },
    deactivate: () => {},
    shouldDeactivate: () => true,
  });
  const editor = makeEditor('Initial');
  try {
    let threw = false;
    try {
      forceActivateAtCoords(editor, 10, 20);
    } catch {
      threw = true;
    }
    assert(
      'coordinate service forceActivateAtCoords does not throw in jsdom',
      !threw,
      'forceActivateAtCoords threw',
    );
    assert(
      'coordinate service forceActivateAtCoords leaves placeholder inactive',
      activated === 0,
      `activated=${activated}`,
    );

    const fakeEditor = {
      view: {
        posAtCoords: () => ({ pos: 7, inside: -1 }),
        domAtPos: () => ({ node: nested, offset: 0 }),
      },
    } as unknown as Editor;
    forceActivateAtCoords(fakeEditor, 12, 34);
    assert(
      'coordinate service forceActivateAtCoords activates placeholder from posAtCoords',
      activated === 1,
      `activated=${activated}`,
    );
  } finally {
    unregister();
    editor.destroy();
    if (previousIntersectionObserver === undefined) {
      delete globals.IntersectionObserver;
    } else {
      globals.IntersectionObserver = previousIntersectionObserver;
    }
  }
}

{
  const globals = globalThis as Record<string, unknown>;
  const previousIntersectionObserver = globals.IntersectionObserver;
  class FakeIntersectionObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globals.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;

  const editor = makeEditor('Initial');
  const element = document.createElement('div');
  const nested = document.createElement('span');
  element.appendChild(nested);
  try {
    let threw = false;
    try {
      coordsAtPos(editor, 0);
      posAtCoords(editor, 10, 20);
      domAtPos(editor, 0);
      scrollPosIntoView(editor, 0);
    } catch {
      threw = true;
    }
    assert(
      'coordinate service wrappers do not throw in jsdom',
      !threw,
      'coordinate wrapper threw',
    );

    const calls: string[] = [];
    const fakeView = {
      state: { doc: { content: { size: 10 } } },
      domAtPos: (pos: number) => {
        calls.push(`dom:${pos}`);
        return { node: nested, offset: 0 };
      },
      posAtCoords: (coords: { left: number; top: number }) => {
        calls.push(`pos:${coords.left}:${coords.top}`);
        return { pos: 7, inside: -1 };
      },
      coordsAtPos: (pos: number) => {
        calls.push(`coords:${pos}`);
        return { left: 1, right: 1, top: 2, bottom: 3 };
      },
    };
    const fakeEditor = { view: fakeView } as unknown as Editor;

    let activated = 0;
    let unregister = registerVirtualNodeView('coordinate-wrapper-coords', element, {
      activate: () => { activated += 1; },
      deactivate: () => {},
      shouldDeactivate: () => true,
    });
    calls.length = 0;
    coordsAtPos(fakeEditor, 7);
    assert(
      'coordsAtPos activates before calling PM coordsAtPos',
      activated === 1 && calls[0] === 'dom:7' && calls[1] === 'coords:7',
      JSON.stringify(calls),
    );
    unregister();

    activated = 0;
    unregister = registerVirtualNodeView('coordinate-wrapper-pos', element, {
      activate: () => { activated += 1; },
      deactivate: () => {},
      shouldDeactivate: () => true,
    });
    calls.length = 0;
    posAtCoords(fakeEditor, 12, 34);
    assert(
      'posAtCoords activates then remeasures PM posAtCoords',
      activated === 1 &&
        calls[0] === 'pos:12:34' &&
        calls[1] === 'dom:7' &&
        calls[2] === 'pos:12:34',
      JSON.stringify(calls),
    );
    unregister();

    activated = 0;
    unregister = registerVirtualNodeView('coordinate-wrapper-dom', element, {
      activate: () => { activated += 1; },
      deactivate: () => {},
      shouldDeactivate: () => true,
    });
    calls.length = 0;
    domAtPos(fakeEditor, 7);
    assert(
      'domAtPos activates before calling PM domAtPos',
      activated === 1 && calls[0] === 'dom:7' && calls[1] === 'dom:7',
      JSON.stringify(calls),
    );
    unregister();

    activated = 0;
    unregister = registerVirtualNodeView('coordinate-wrapper-scroll', element, {
      activate: () => { activated += 1; },
      deactivate: () => {},
      shouldDeactivate: () => true,
    });
    calls.length = 0;
    scrollPosIntoView(fakeEditor, 7);
    assert(
      'scrollPosIntoView activates before PM dom measurement',
      activated === 1 && calls[0] === 'dom:7' && calls[1] === 'dom:7',
      JSON.stringify(calls),
    );
    unregister();
  } finally {
    editor.destroy();
    if (previousIntersectionObserver === undefined) {
      delete globals.IntersectionObserver;
    } else {
      globals.IntersectionObserver = previousIntersectionObserver;
    }
  }
}

{
  const editor = makeEditor('Initial');
  try {
    load(editor, '# Heading\n\nparagraph\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n![alt](../images/dora.png)\n');
    const blocks = buildBlockModelFromEditor(editor);
    const types = blocks.map((block) => block.type);
    assert('block model includes heading', types.includes('heading'), JSON.stringify(types));
    assert('block model includes paragraph', types.includes('paragraph'), JSON.stringify(types));
    assert('block model includes table', types.includes('table'), JSON.stringify(types));
    assert('block model includes image', types.includes('image'), JSON.stringify(types));
    assert('block model ids are unique', new Set(blocks.map((block) => block.id)).size === blocks.length, JSON.stringify(blocks.map((block) => block.id)));
    assert(
      'block model ids are stable',
      JSON.stringify(blocks.map((block) => block.id)) === JSON.stringify(buildBlockModelFromEditor(editor).map((block) => block.id)),
      JSON.stringify(blocks.map((block) => block.id)),
    );
    assert(
      'block model pm positions are valid and ascending',
      blocks.every((block, index) => {
        if (editor.state.doc.nodeAt(block.pmPos)?.type.name !== block.type) return false;
        return index === 0 || block.pmPos > blocks[index - 1]!.pmPos;
      }),
      JSON.stringify(blocks),
    );
    assert('block model returns first block at head', getBlockAtPos(blocks, 0) === blocks[0], JSON.stringify(getBlockAtPos(blocks, 0)));
    assert('block model returns last block at tail', getBlockAtPos(blocks, Number.MAX_SAFE_INTEGER) === blocks[blocks.length - 1], JSON.stringify(getBlockAtPos(blocks, Number.MAX_SAFE_INTEGER)));
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    load(editor, '## Alpha\n\nbody\n\n### Beta\n');
    const outline = extractOutlineFromEditor(editor);
    assert('outline headings have PM positions', outline.length === 2 && outline.every((item) => item.start >= 0), JSON.stringify(outline));
    assert('outline heading ids use block model', outline.every((item) => item.id.startsWith('block-')), JSON.stringify(outline));
    const alpha = outline.find((item) => item.text === 'Alpha');
    assert('outline finds heading text', Boolean(alpha), JSON.stringify(outline));
    if (!alpha) throw new Error('missing Alpha outline heading');
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, alpha.start + 1)));
    const selectionPos = editor.state.doc.resolve(editor.state.selection.from);
    assert(
      'outline jump selection lands in heading',
      selectionPos.parent.type.name === 'heading' && selectionPos.parent.textContent === 'Alpha',
      `${selectionPos.parent.type.name}:${selectionPos.parent.textContent}`,
    );
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    load(editor, '# Heading\n\nbody text\n');
    const frame = document.createElement('div');
    document.body.appendChild(frame);
    try {
      let captured: ReturnType<typeof captureVisualScrollAnchor> = null;
      let captureThrew = false;
      try {
        captured = captureVisualScrollAnchor(frame, editor);
      } catch {
        captureThrew = true;
      }
      assert('scroll anchor capture does not throw', !captureThrew, 'capture threw');
      assert(
        'scroll anchor capture returns null or anchor',
        captured === null || (typeof captured.pmPos === 'number' && typeof captured.offsetTop === 'number'),
        JSON.stringify(captured),
      );

      let restoreThrew = false;
      try {
        restoreVisualScrollAnchor(frame, editor, { pmPos: 1, offsetTop: 0 });
      } catch {
        restoreThrew = true;
      }
      assert('scroll anchor restore does not throw', !restoreThrew, 'restore threw');
      assert('scroll anchor restore accepts captured anchor', (() => {
        if (!captured) return true;
        try {
          restoreVisualScrollAnchor(frame, editor, captured);
          return true;
        } catch {
          return false;
        }
      })());
    } finally {
      frame.remove();
    }
  } finally {
    editor.destroy();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    const headingSource = '# Heading\n';
    const headingPos = markdownOffsetToPmPos(headingSource, parseMarkdown(headingSource), 0);
    assert('markdown offset maps heading line start', headingPos === 1, String(headingPos));

    const paragraphSource = 'Paragraph middle text\n';
    const paragraphOffset = paragraphSource.indexOf('middle');
    const paragraphPos = markdownOffsetToPmPos(paragraphSource, parseMarkdown(paragraphSource), paragraphOffset);
    load(editor, paragraphSource);
    assert(
      'markdown offset maps paragraph middle',
      paragraphPos !== null && editor.state.doc.resolve(paragraphPos).parent.type.name === 'paragraph',
      String(paragraphPos),
    );

    const imageSource = '![alt](../images/dora.png)\n';
    const imageContent = parseMarkdown(imageSource);
    const imageBefore = markdownOffsetToPmPos(imageSource, imageContent, 0);
    const imageAfter = markdownOffsetToPmPos(imageSource, imageContent, imageSource.length);
    const imageUrlOffset = imageSource.indexOf('images') + 2;
    assert(
      'markdown offset maps before image',
      imageBefore !== null && Number.isInteger(imageBefore) && imageBefore >= 0,
      String(imageBefore),
    );
    assert(
      'markdown offset maps after image',
      imageAfter !== null && Number.isInteger(imageAfter) && imageAfter >= 0,
      String(imageAfter),
    );
    assert(
      'markdown offset returns null when marker is not text-positionable',
      markdownOffsetToPmPos(imageSource, imageContent, imageUrlOffset) === null,
      String(markdownOffsetToPmPos(imageSource, imageContent, imageUrlOffset)),
    );

    const mathSource = 'Before $x^2$ after\n';
    const mathOffset = mathSource.indexOf('$');
    const mathAfterOffset = mathSource.indexOf(' after') + 1;
    const mathBeforePos = markdownOffsetToPmPos(mathSource, parseMarkdown(mathSource), mathOffset);
    const mathAfterPos = markdownOffsetToPmPos(mathSource, parseMarkdown(mathSource), mathAfterOffset);
    load(editor, mathSource);
    assert(
      'markdown offset maps before inline math',
      mathBeforePos !== null && editor.state.doc.resolve(mathBeforePos).parent.type.name === 'paragraph',
      String(mathBeforePos),
    );
    assert(
      'markdown offset maps after inline math',
      mathAfterPos !== null && editor.state.doc.resolve(mathAfterPos).parent.type.name === 'paragraph',
      String(mathAfterPos),
    );
  } finally {
    editor.destroy();
  }
}

{
  const textarea = document.createElement('textarea');
  textarea.value = 'line one\nline two\nline three\n';
  document.body.appendChild(textarea);
  try {
    textarea.selectionStart = 10;
    textarea.selectionEnd = 14;
    textarea.scrollTop = 12;
    let anchor: ReturnType<typeof captureSourceScrollAnchor> | null = null;
    let captureThrew = false;
    try {
      anchor = captureSourceScrollAnchor(textarea);
    } catch {
      captureThrew = true;
    }
    assert('source scroll anchor capture does not throw', !captureThrew, 'capture threw');
    assert(
      'source scroll anchor records offset and scroll top',
      anchor !== null && anchor.markdownOffset === 10 && anchor.offsetTop === 12,
      JSON.stringify(anchor),
    );

    textarea.value = 'short';
    let restoreThrew = false;
    try {
      restoreSourceScrollAnchor(textarea, anchor ?? { markdownOffset: 0, offsetTop: 0 });
    } catch {
      restoreThrew = true;
    }
    assert('source scroll anchor restore does not throw', !restoreThrew, 'restore threw');
    assert(
      'source scroll anchor restore clamps offset',
      textarea.selectionStart === 5 && textarea.selectionEnd === 5,
      textarea.selectionStart + ':' + textarea.selectionEnd,
    );
  } finally {
    textarea.remove();
  }
}

{
  const globals = globalThis as Record<string, unknown>;
  const previousIntersectionObserver = globals.IntersectionObserver;
  class FakeIntersectionObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globals.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;

  const editor = makeEditor('hello world');
  const wrapper = document.createElement('div');
  const editorDom = editor.view.dom;
  editorDom.parentNode?.insertBefore(wrapper, editorDom);
  wrapper.appendChild(editorDom);
  let activated = 0;
  const unregister = registerVirtualNodeView('visual-search-coordinate-activation-test', wrapper, {
    activate: () => {
      activated += 1;
    },
    deactivate: () => {},
    shouldDeactivate: () => true,
  });
  try {
    const matches = findVisualSearchMatches(editor, 'hello');
    let threw = false;
    try {
      selectVisualSearchMatch(editor, matches[0]!);
    } catch {
      threw = true;
    }
    assert(
      'visual search select does not throw in jsdom',
      !threw,
      'selectVisualSearchMatch threw',
    );
    assert(
      'visual search select activates wrapped virtual node',
      activated === 1,
      'activated=' + activated,
    );
    assert(
      'visual search select still lands on match',
      editor.state.selection.from === 1 && editor.state.selection.to === 6,
      editor.state.selection.from + ':' + editor.state.selection.to,
    );
  } finally {
    unregister();
    wrapper.remove();
    editor.destroy();
    if (previousIntersectionObserver === undefined) {
      delete globals.IntersectionObserver;
    } else {
      globals.IntersectionObserver = previousIntersectionObserver;
    }
  }
}

{
  const globals = globalThis as Record<string, unknown>;
  const previousIntersectionObserver = globals.IntersectionObserver;
  const previousRequestAnimationFrame = globals.requestAnimationFrame;
  const previousCancelAnimationFrame = globals.cancelAnimationFrame;
  let ioCallback: IntersectionObserverCallback | null = null;
  const rafCallbacks: FrameRequestCallback[] = [];

  class FakeIntersectionObserver {
    callback: IntersectionObserverCallback;

    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
      ioCallback = callback;
    }

    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  globals.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
  globals.requestAnimationFrame = (callback: FrameRequestCallback) => {
    rafCallbacks.push(callback);
    return rafCallbacks.length;
  };
  globals.cancelAnimationFrame = () => {};
  resetActivationControllerForTest();

  const fire = (element: HTMLElement, isIntersecting: boolean): void => {
    ioCallback?.(
      [{ target: element, isIntersecting } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
  };

  const unregisters: Array<() => void> = [];
  const activated = new Array<number>(VIRTUAL_ACTIVATION_BATCH_SIZE * 2).fill(0);
  const anchorEvents: string[] = [];
  setScrollAnchorProvider({
    capture: () => {
      anchorEvents.push('capture');
      return { pmPos: 1, offsetTop: 0 };
    },
    restore: () => {
      anchorEvents.push('restore');
    },
  });
  try {
    for (let index = 0; index < activated.length; index += 1) {
      const element = document.createElement('div');
      unregisters.push(
        registerVirtualNodeView(`batch-activation-${index}`, element, {
          activate: () => {
            activated[index] += 1;
          },
          deactivate: () => {},
          shouldDeactivate: () => true,
        }),
      );
      fire(element, true);
    }

    assert(
      'activation controller batches pending activations without immediate work',
      rafCallbacks.length === 1 && activated.every((count) => count === 0),
      `frames=${rafCallbacks.length} active=${activated.filter((count) => count > 0).length}`,
    );

    const firstFrame = rafCallbacks.shift();
    firstFrame?.(0);
    assert(
      'activation controller activates at most one batch per frame',
      activated.filter((count) => count === 1).length === VIRTUAL_ACTIVATION_BATCH_SIZE &&
        rafCallbacks.length === 1,
      `active=${activated.filter((count) => count > 0).length} frames=${rafCallbacks.length}`,
    );
    assert(
      'activation controller anchors around each IO batch',
      anchorEvents.length === 2 && anchorEvents[0] === 'capture' && anchorEvents[1] === 'restore',
      `anchorEvents=${anchorEvents.join(',')}`,
    );

    const secondFrame = rafCallbacks.shift();
    secondFrame?.(0);
    assert(
      'activation controller drains pending nodes on the next frame',
      activated.every((count) => count === 1) && rafCallbacks.length === 0,
      `active=${activated.filter((count) => count > 0).length} frames=${rafCallbacks.length}`,
    );
    assert(
      'activation controller anchors every activation batch',
      anchorEvents.length === 4 &&
        anchorEvents[0] === 'capture' &&
        anchorEvents[1] === 'restore' &&
        anchorEvents[2] === 'capture' &&
        anchorEvents[3] === 'restore',
      `anchorEvents=${anchorEvents.join(',')}`,
    );
  } finally {
    for (const unregister of unregisters) {
      unregister();
    }
  }

  const forceElement = document.createElement('div');
  let forceActivated = 0;
  let forceUnregister: (() => void) | null = null;
  try {
    forceUnregister = registerVirtualNodeView('batch-force-activation', forceElement, {
      activate: () => {
        forceActivated += 1;
      },
      deactivate: () => {},
      shouldDeactivate: () => true,
    });
    fire(forceElement, true);
    assert(
      'forceActivate starts with a queued pending activation',
      forceActivated === 0 && rafCallbacks.length === 1,
      `active=${forceActivated} frames=${rafCallbacks.length}`,
    );
    forceActivate('batch-force-activation');
    assert(
      'forceActivate activates the target immediately',
      forceActivated === 1,
      `active=${forceActivated}`,
    );
    rafCallbacks.shift()?.(0);
    assert(
      'forceActivate removes the pending activation from the queue',
      forceActivated === 1 && rafCallbacks.length === 0,
      `active=${forceActivated} frames=${rafCallbacks.length}`,
    );
  } finally {
    forceUnregister?.();
  }

  {
    const hydrateElements = Array.from({ length: 3 }, () => document.createElement('div'));
    const hydrateActivated = [0, 0, 0];
    const hydrateUnregisters: Array<() => void> = [];
    try {
      for (let index = 0; index < hydrateElements.length; index += 1) {
        hydrateUnregisters.push(
          registerVirtualNodeView(`force-hydrate-${index}`, hydrateElements[index]!, {
            activate: () => { hydrateActivated[index] += 1; },
            deactivate: () => {},
            shouldDeactivate: () => true,
          }),
        );
        fire(hydrateElements[index]!, true);
      }

      assert(
        'forceHydrateAll starts with all nodes pending',
        hydrateActivated.every((count) => count === 0) && rafCallbacks.length === 1,
        `active=${hydrateActivated.join(',')} frames=${rafCallbacks.length}`,
      );

      const hydrated = forceHydrateAll();
      assert(
        'forceHydrateAll activates every pending node in one call',
        hydrated === hydrateElements.length && hydrateActivated.every((count) => count === 1),
        `count=${hydrated} active=${hydrateActivated.join(',')}`,
      );

      const hydratedAgain = forceHydrateAll();
      assert(
        'forceHydrateAll does not re-activate active nodes',
        hydratedAgain === 0 && hydrateActivated.every((count) => count === 1),
        `count=${hydratedAgain} active=${hydrateActivated.join(',')}`,
      );

      rafCallbacks.shift()?.(0);
      assert(
        'forceHydrateAll clears pending activation queue',
        hydrateActivated.every((count) => count === 1) && rafCallbacks.length === 0,
        `active=${hydrateActivated.join(',')} frames=${rafCallbacks.length}`,
      );
    } finally {
      for (const unregister of hydrateUnregisters) {
        unregister();
      }
    }
  }

  {
    const element = document.createElement('div');
    let unregisteredActivated = 0;
    let unregister: (() => void) | null = null;
    try {
      unregister = registerVirtualNodeView('force-hydrate-unregistered', element, {
        activate: () => { unregisteredActivated += 1; },
        deactivate: () => {},
        shouldDeactivate: () => true,
      });
      fire(element, true);
      unregister();
      unregister = null;
      const hydrated = forceHydrateAll();
      assert(
        'forceHydrateAll ignores unregistered pending nodes',
        hydrated === 0 && unregisteredActivated === 0,
        `count=${hydrated} active=${unregisteredActivated}`,
      );
      rafCallbacks.shift()?.(0);
      assert(
        'forceHydrateAll does not leave unregistered node queued',
        unregisteredActivated === 0 && rafCallbacks.length === 0,
        `active=${unregisteredActivated} frames=${rafCallbacks.length}`,
      );
    } finally {
      unregister?.();
    }
  }

  const leaveElement = document.createElement('div');
  let leaveActivated = 0;
  let leaveUnregister: (() => void) | null = null;
  try {
    leaveUnregister = registerVirtualNodeView('batch-leave-pending', leaveElement, {
      activate: () => {
        leaveActivated += 1;
      },
      deactivate: () => {},
      shouldDeactivate: () => true,
    });
    fire(leaveElement, true);
    fire(leaveElement, false);
    rafCallbacks.shift()?.(0);
    assert(
      'activation controller removes pending nodes that leave the preload range',
      leaveActivated === 0 && rafCallbacks.length === 0,
      `active=${leaveActivated} frames=${rafCallbacks.length}`,
    );
  } finally {
    leaveUnregister?.();
  }

  const unregisterElement = document.createElement('div');
  let unregisterActivated = 0;
  let unregisterVirtualNode: (() => void) | null = null;
  try {
    unregisterVirtualNode = registerVirtualNodeView('batch-unregister-pending', unregisterElement, {
      activate: () => {
        unregisterActivated += 1;
      },
      deactivate: () => {},
      shouldDeactivate: () => true,
    });
    fire(unregisterElement, true);
    unregisterVirtualNode();
    unregisterVirtualNode = null;
    rafCallbacks.shift()?.(0);
    assert(
      'activation controller removes pending nodes on unregister',
      unregisterActivated === 0 && rafCallbacks.length === 0,
      `active=${unregisterActivated} frames=${rafCallbacks.length}`,
    );
  } finally {
    unregisterVirtualNode?.();
  }

  if (previousIntersectionObserver === undefined) {
    delete globals.IntersectionObserver;
  } else {
    globals.IntersectionObserver = previousIntersectionObserver;
  }
  if (previousRequestAnimationFrame === undefined) {
    delete globals.requestAnimationFrame;
  } else {
    globals.requestAnimationFrame = previousRequestAnimationFrame;
  }
  if (previousCancelAnimationFrame === undefined) {
    delete globals.cancelAnimationFrame;
  } else {
    globals.cancelAnimationFrame = previousCancelAnimationFrame;
  }
  resetActivationControllerForTest();
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
    const blockNode = editor.view.dom.querySelector('.math-block-node');
    const inlineNode = editor.view.dom.querySelector('.math-inline-node');
    assert('block math renders katex in jsdom', blockNode?.querySelector('.katex') !== null, output);
    assert('block math placeholder clears after immediate activation', blockNode?.classList.contains('math-block-node-placeholder') === false, output);
    assert('inline math stays rendered without block placeholder', inlineNode?.querySelector('.katex') !== null && inlineNode?.classList.contains('math-block-node-placeholder') === false, output);
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
  const chunkEditor = makeEditor('Initial');
  try {
    clearFormulaHtmlCache();
    seedFormulaHtmlCache({
      [getFormulaCacheKey('cached', 'no')]: '<span class="chunk-cached-formula">cached</span>',
    });
    load(chunkEditor, '$cached$ and $fallback$');
    assert(
      'math cache seeds initial chunk and unseeded formula falls back',
      chunkEditor.view.dom.querySelector('.chunk-cached-formula') !== null &&
        chunkEditor.view.dom.querySelector('.math-node-preview .katex') !== null,
      html(chunkEditor),
    );
    assert(
      'cached chunk formula and fallback formula keep markdown',
      md(chunkEditor).includes('$cached$') && md(chunkEditor).includes('$fallback$'),
      md(chunkEditor),
    );
  } finally {
    chunkEditor.destroy();
    clearFormulaHtmlCache();
  }
}


{
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  const firstKey = getHeightCacheKey('inlineMath', 'x^2', 6, 'light:default', 1, 'default');
  const secondKey = getHeightCacheKey('inlineMath', 'y^2', 6, 'light:default', 1, 'default');
  resetHeightMeasurerForTest();
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.className.includes('math-node-preview')) {
      return { height: this.textContent?.includes('x') ? 42 : 37 } as DOMRect;
    }
    return originalGetBoundingClientRect.call(this);
  };
  try {
    const heightsPromise = measureFormulaHeights([
      { key: firstKey, html: '<span>x</span>', display: 'yes' },
      { key: secondKey, html: '<span>y</span>', display: 'no' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const heights = await heightsPromise;
    assert(
      'height measurer returns mocked layout heights',
      JSON.stringify(heights) === JSON.stringify({ [firstKey]: 42, [secondKey]: 37 }),
      JSON.stringify(heights),
    );
    for (const [key, height] of Object.entries(heights)) {
      setCachedNodeHeight(key, height);
    }
    assert('height measurer seeds node height cache', getCachedNodeHeight(firstKey) === 42, String(getCachedNodeHeight(firstKey)));
    assert(
      'height measurer removes hidden layer after read',
      document.querySelector('.height-measurer') === null,
      String(document.querySelector('.height-measurer')?.outerHTML),
    );
  } finally {
    resetHeightMeasurerForTest();
    clearNodeHeightCache();
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  }
}

{
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  resetHeightMeasurerForTest();
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.className.includes('math-node-preview')) {
      return { height: 48 } as DOMRect;
    }
    return originalGetBoundingClientRect.call(this);
  };
  try {
    const entries = collectFormulaIndex(
      parseMarkdown('$a^2$\n\n$$\nb^2\n$$\n'),
    );
    const chunks = splitFormulaChunks(entries, 2);
    const firstChunk = chunks[0]!;
    const renderedChunk = renderFormulaChunk(firstChunk);
    const measurementItems = buildFormulaHeightMeasurementItems(
      firstChunk,
      renderedChunk,
      document.body,
    );
    assert(
      'formula chunk height measurement items cover rendered chunk',
      measurementItems.length === firstChunk.length,
      `items=${measurementItems.length} chunk=${firstChunk.length}`,
    );

    const heights = await measureFormulaHeights(measurementItems);
    assert(
      'formula chunk measurement returns heights for every item',
      Object.keys(heights).length === measurementItems.length,
      JSON.stringify(heights),
    );
    for (const [key, height] of Object.entries(heights)) {
      setCachedNodeHeight(key, height);
    }
    assert(
      'formula chunk measured height writes node height cache',
      measurementItems.every((item) => getCachedNodeHeight(item.key) === 48),
      JSON.stringify(heights),
    );
    assert(
      'formula chunk measurement clears hidden layer',
      document.querySelector('.height-measurer') === null,
      String(document.querySelector('.height-measurer')?.outerHTML),
    );
  } finally {
    resetHeightMeasurerForTest();
    clearNodeHeightCache();
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
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
  const ReactNodeViewContext = (TiptapReact as any).ReactNodeViewContext;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const contentDOM = document.createElement('code');
  contentDOM.textContent = 'const x = 1;';
  const root = createRoot(container);
  try {
    root.render(
      createElement(
        ReactNodeViewContext.Provider,
        {
          value: {
            onDragStart: () => {},
            nodeViewContentRef: (element: HTMLElement | null) => {
              if (element && !element.contains(contentDOM)) {
                element.appendChild(contentDOM);
              }
            },
          },
        },
        createElement(
          CodeBlockView,
          {
            editor: { view: { composing: false } },
            node: { attrs: { language: 'ts' } },
            selected: false,
            updateAttributes: () => {},
          } as any,
        ),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const blockNode = container.querySelector('.code-block-node');
    const preNode = container.querySelector('.code-block-node__pre');
    assert(
      'code block activates immediately without IntersectionObserver',
      blockNode?.classList.contains('code-block-node--placeholder') === false &&
        blockNode?.getAttribute('data-virtual-node-id') !== null,
      String(blockNode?.className),
    );
    assert(
      'code block contentDOM stays mounted in jsdom',
      preNode?.contains(contentDOM) === true && contentDOM.textContent?.includes('const x = 1;') === true,
      String(contentDOM.textContent),
    );
    assert(
      'code block keeps language toolbar when active',
      container.querySelector('.code-block-node__toolbar') !== null,
      String(container.innerHTML),
    );
  } finally {
    root.unmount();
    container.remove();
  }
}

{
  const globals = globalThis as Record<string, unknown>;
  const previousIntersectionObserver = globals.IntersectionObserver;
  class FakeIntersectionObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globals.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
  const ReactNodeViewContext = (TiptapReact as any).ReactNodeViewContext;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const contentDOM = document.createElement('code');
  contentDOM.textContent = 'const x = 1;';
  const root = createRoot(container);
  try {
    let threw = false;
    try {
      root.render(
        createElement(
          ReactNodeViewContext.Provider,
          {
            value: {
              onDragStart: () => {},
              nodeViewContentRef: (element: HTMLElement | null) => {
                if (element && !element.contains(contentDOM)) {
                  element.appendChild(contentDOM);
                }
              },
            },
          },
          createElement(
            CodeBlockView,
            {
              editor: { view: { composing: false } },
              node: { attrs: { language: 'ts' } },
              selected: false,
              updateAttributes: () => {},
            } as any,
          ),
        ),
      );
    } catch {
      threw = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    const blockNode = container.querySelector('.code-block-node');
    const preNode = container.querySelector('.code-block-node__pre');
    assert('code block placeholder creation does not throw', !threw, 'root.render threw');
    assert(
      'code block placeholder stays inactive with IntersectionObserver',
      blockNode?.classList.contains('code-block-node--placeholder') === true,
      String(blockNode?.className),
    );
    assert(
      'code block placeholder marks content node',
      preNode?.classList.contains('code-block-node--placeholder') === true,
      String(preNode?.className),
    );
    assert(
      'code block placeholder keeps contentDOM mounted',
      preNode?.contains(contentDOM) === true && contentDOM.textContent?.includes('const x = 1;') === true,
      String(contentDOM.textContent),
    );
    assert(
      'code block placeholder keeps pre/code',
      preNode !== null && container.querySelector('code') !== null,
      String(container.innerHTML),
    );
  } finally {
    root.unmount();
    container.remove();
    if (previousIntersectionObserver === undefined) {
      delete globals.IntersectionObserver;
    } else {
      globals.IntersectionObserver = previousIntersectionObserver;
    }
  }
}

{
  const globals = globalThis as Record<string, unknown>;
  const previousIntersectionObserver = globals.IntersectionObserver;
  class FakeIntersectionObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globals.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
  resetActivationControllerForTest();

  const editor = makeEditor('before after');
  try {
    editor.commands.setTextSelection(6);
    editor.chain().focus().insertMathBlock('x+y').run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const blockNode = editor.view.dom.querySelector('.math-block-node');
    const preview = blockNode?.querySelector('.math-node-preview');
    assert(
      'inserted block math activates immediately while selection is inside',
      blockNode !== null &&
        blockNode.classList.contains('math-block-node-placeholder') === false &&
        preview?.querySelector('.katex') !== null,
      String(blockNode?.outerHTML ?? 'missing'),
    );
    assert(
      'inserted block math preview shows inserted latex',
      preview?.textContent?.includes('x') === true && preview?.textContent?.includes('y') === true,
      String(preview?.textContent),
    );
    assert(
      'inserted block math keeps markdown',
      md(editor).includes('$$') && md(editor).includes('x+y'),
      md(editor),
    );
    assert(
      'inserted block math render mode stays free of internal markers',
      !md(editor).includes('MDEDITORSELECTION') && !md(editor).includes('\uE000'),
      md(editor),
    );
  } finally {
    editor.destroy();
    if (previousIntersectionObserver === undefined) {
      delete globals.IntersectionObserver;
    } else {
      globals.IntersectionObserver = previousIntersectionObserver;
    }
    resetActivationControllerForTest();
  }
}

{
  const globals = globalThis as Record<string, unknown>;
  const previousIntersectionObserver = globals.IntersectionObserver;
  class FakeIntersectionObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globals.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
  resetActivationControllerForTest();

  const editor = makeEditor('before after');
  try {
    load(editor, 'before\n\n$$\nx+y\n$$\n\nafter\n');
    const blockNode = editor.view.dom.querySelector<HTMLElement>('.math-block-node');
    const preview = blockNode?.querySelector<HTMLElement>('.math-node-preview');
    const virtualNodeId = blockNode?.dataset.virtualNodeId;
    assert(
      'block math placeholder is registered under fake IO',
      blockNode?.classList.contains('math-block-node-placeholder') === true && Boolean(virtualNodeId),
      String(blockNode?.outerHTML ?? 'missing'),
    );

    let activationThrew = false;
    try {
      if (virtualNodeId) {
        forceActivate(virtualNodeId);
      }
    } catch {
      activationThrew = true;
    }
    assert(
      'block math activation with height compensation does not throw in jsdom',
      !activationThrew,
      'forceActivate threw',
    );
    assert(
      'block math activates after forced hydration',
      blockNode?.classList.contains('math-block-node-placeholder') === false,
      String(blockNode?.className),
    );
    assert(
      'block math double-buffer preview replaces placeholder without residue',
      preview?.querySelector('.katex') !== null &&
        preview?.querySelector('.math-node-placeholder-hint') === null &&
        preview?.querySelector('.math-node-empty-hint') === null,
      String(preview?.outerHTML ?? 'missing'),
    );

    let clearThrew = false;
    try {
      clearNodeHeightCache();
    } catch {
      clearThrew = true;
    }
    assert(
      'node height cache clears after block math activation',
      !clearThrew,
      'clearNodeHeightCache threw',
    );
  } finally {
    editor.destroy();
    if (previousIntersectionObserver === undefined) {
      delete globals.IntersectionObserver;
    } else {
      globals.IntersectionObserver = previousIntersectionObserver;
    }
    resetActivationControllerForTest();
  }
}

{
  const globals = globalThis as Record<string, unknown>;
  const previousIntersectionObserver = globals.IntersectionObserver;
  class FakeIntersectionObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globals.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
  resetActivationControllerForTest();

  const editor = makeEditor('before after');
  try {
    load(editor, 'before\n\n$$\nx+y\n$$\n\nafter\n');
    const blockNode = editor.view.dom.querySelector<HTMLElement>('.math-block-node');
    const preview = blockNode?.querySelector<HTMLElement>('.math-node-preview');
    assert(
      'block math placeholder starts with default height',
      preview?.style.minHeight === '96px',
      String(preview?.style.minHeight),
    );

    const heightKey = getFormulaHeightKey('x+y', 'yes', blockNode ?? undefined);
    setCachedNodeHeight(heightKey, 77);
    notifyNodeHeightCacheSeeded();
    assert(
      'block math placeholder refreshes to measured height',
      preview?.style.minHeight === '77px',
      String(preview?.style.minHeight),
    );
  } finally {
    clearNodeHeightCache();
    editor.destroy();
    if (previousIntersectionObserver === undefined) {
      delete globals.IntersectionObserver;
    } else {
      globals.IntersectionObserver = previousIntersectionObserver;
    }
    resetActivationControllerForTest();
  }
}

{
  const editor = makeEditor('Initial');
  try {
    load(editor, '![Dora](../images/dora.png)\n');
    const output = html(editor);
    assert('image renders img', output.includes('<img') && output.includes('../images/dora.png'), output);

    const imageProps: any = {
      editor: editor as any,
      extension: { options: { resolveImageSource: (src: string) => src } } as any,
      getPos: () => 1,
      node: { attrs: { src: '../images/dora.png', alt: 'Dora', title: null }, nodeSize: 1 } as any,
      selected: false,
      updateAttributes: () => {},
    };
    const imageOutput = renderToStaticMarkup(createElement(ImageView, imageProps));
    assert(
      'image renders lazy async attrs',
      imageOutput.includes('loading="lazy"') && imageOutput.includes('decoding="async"'),
      imageOutput,
    );
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
  try {
    load(editor, '<div>HTML_BLOCK</div>\n');
    const output = html(editor);
    assert('html block stays rendered in jsdom', output.includes('HTML_BLOCK'), output);
    assertHealthy('html block', editor);
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
    assertNoMathSyntaxDecorations('math syntax non-edit initial', editor);
    assert('math syntax highlight initial markdown', md(editor).includes('$\\frac{x}{y}_1$'), md(editor));

    const start = findNodePosition(editor, 'inlineMath');
    assert('math syntax highlight finds inline math', start !== null, String(start));
    if (start === null) throw new Error('missing inlineMath');
    editor.commands.setTextSelection(start + 1);
    assertMathSyntaxDecorations('math syntax focused initial', editor);

    const formulaNode = editor.state.doc.nodeAt(start);
    if (!formulaNode) throw new Error('missing inlineMath node');
    editor.commands.setTextSelection({
      from: start + 1,
      to: start + 1 + formulaNode.textContent.length,
    });
    const partialPayload = copyPayload(editor);
    assert(
      'math syntax partial copy stays raw latex',
      partialPayload.plain === '\\frac{x}{y}_1' && partialPayload.markdown === null,
      JSON.stringify(partialPayload),
    );

    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, start)));
    const wholePayload = copyPayload(editor);
    assert(
      'math syntax whole-node copy keeps delimiters',
      wholePayload.markdown?.includes('$\\frac{x}{y}_1$') ?? false,
      JSON.stringify(wholePayload),
    );
    const pasteTarget = makeEditor('');
    try {
      pastePayload(pasteTarget, wholePayload);
      assert(
        'math syntax paste keeps formula',
        md(pasteTarget).includes('$\\frac{x}{y}_1$'),
        md(pasteTarget),
      );
    } finally {
      pasteTarget.destroy();
    }

    editor.commands.setTextSelection(start + 1);
    const insertPos = start + 1;
    const insertTr = editor.state.tr.insert(insertPos, editor.state.schema.text('{b}'));
    editor.view.dispatch(insertTr.setSelection(TextSelection.create(insertTr.doc, insertPos + 2)));
    const insertedMd = md(editor);
    assert('math syntax highlight insertion content', insertedMd.includes('{b}\\frac{x}{y}_1'), insertedMd);
    assertMathSyntaxDecorations('math syntax highlight insertion', editor);

    editor.commands.undo();
    const undoneMd = md(editor);
    assert('math syntax highlight undo insertion', undoneMd.includes('$\\frac{x}{y}_1$'), undoneMd);
    focusFirstMath(editor);
    assertMathSyntaxDecorations('math syntax highlight undo insertion', editor);

    editor.commands.redo();
    const redoneMd = md(editor);
    assert('math syntax highlight redo insertion', redoneMd.includes('{b}\\frac{x}{y}_1'), redoneMd);
    focusFirstMath(editor);
    assertMathSyntaxDecorations('math syntax highlight redo insertion', editor);

    const formulaPos = findNodePosition(editor, 'inlineMath');
    if (formulaPos === null) throw new Error('missing inlineMath after redo');
    const deleteFrom = formulaPos + 1;
    const deleteTr = editor.state.tr.delete(deleteFrom, deleteFrom + 1);
    editor.view.dispatch(deleteTr.setSelection(TextSelection.create(deleteTr.doc, deleteFrom)));
    const deletedMd = md(editor);
    assert('math syntax highlight deletion content', deletedMd.includes('b}\\frac{x}{y}_1'), deletedMd);
    focusFirstMath(editor);
    assertMathSyntaxDecorations('math syntax highlight deletion', editor);

    editor.commands.undo();
    const undoDeleteMd = md(editor);
    assert('math syntax highlight undo deletion', undoDeleteMd.includes('{b}\\frac{x}{y}_1'), undoDeleteMd);
    focusFirstMath(editor);
    assertMathSyntaxDecorations('math syntax highlight undo deletion', editor);

    editor.commands.redo();
    const redoDeleteMd = md(editor);
    assert('math syntax highlight redo deletion', redoDeleteMd.includes('b}\\frac{x}{y}_1'), redoDeleteMd);
    focusFirstMath(editor);
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
    assertNoMathSyntaxDecorations('math syntax many formulas non-edit initial', editor);

    const pos = findNodePosition(editor, 'inlineMath');
    if (pos === null) throw new Error('missing inlineMath in many formulas');
    editor.commands.setTextSelection(pos + 1);
    const manyInsertTr = editor.state.tr.insert(pos + 1, editor.state.schema.text('{edit}'));
    editor.view.dispatch(manyInsertTr.setSelection(TextSelection.create(manyInsertTr.doc, pos + 2)));
    const manyMd = md(editor);
    assert('math syntax highlight many formulas edit', countNodes(editor, 'inlineMath') === formulaCount && manyMd.includes('{edit}\\frac{x_{0}}{y_0}'), manyMd.slice(0, 300));
    assertMathSyntaxDecorations('math syntax highlight many formulas after edit', editor);
    const scopedSpanCount = editor.view.dom.querySelectorAll('[class*="math-syntax-"]').length;
    assert(
      'math syntax highlight many formulas remains scoped',
      scopedSpanCount < 100,
      `scopedSpanCount=${scopedSpanCount}`,
    );
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


// ---------------------------------------------------------------------------
// Virtual node hydration: binary-search range instead of full scan
// ---------------------------------------------------------------------------
{
  const globals = globalThis as Record<string, unknown>;
  const previousIntersectionObserver = globals.IntersectionObserver;
  const previousRaf = globals.requestAnimationFrame;
  const previousCancelRaf = globals.cancelAnimationFrame;
  const rafCallbacks: FrameRequestCallback[] = [];
  class FakeIntersectionObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globals.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
  globals.requestAnimationFrame = (callback: FrameRequestCallback) => {
    rafCallbacks.push(callback);
    return rafCallbacks.length;
  };
  globals.cancelAnimationFrame = () => {};
  resetActivationControllerForTest();

  const unregisters: Array<() => void> = [];
  try {
    for (let index = 0; index < 1000; index += 1) {
      const element = document.createElement('div');
      element.className = 'virtual-position-test';
      unregisters.push(
        registerVirtualNodeView(`hydrate-range-${index}`, element, {
          activate: () => {},
          deactivate: () => {},
        }, { getPosition: () => index * 10 }),
      );
    }
    hydrateTargetRange(
      document.createElement('div'),
      5_000,
      1_000,
    );
    // Drain any follow-up hydration frames synchronously before the group tests.
    while (true) {
      const next = rafCallbacks.shift();
      if (!next) break;
      next(0);
    }
    assert(
      'hydrateTargetRange uses cached position index',
      getVirtualNodePositionIndexSizeForTest() === 1000,
      `after=${getVirtualNodePositionIndexSizeForTest()}`,
    );
    const countersAfterHydrate = getVirtualNodePositionIndexTestCountersForTest();
    assert(
      'hydrateTargetRange range query does not full-scan the map',
      countersAfterHydrate.fullScans === 0 &&
        countersAfterHydrate.rangeQueries > 0 &&
        countersAfterHydrate.rangeQueries < 1000,
      JSON.stringify(countersAfterHydrate),
    );
    assert(
      'hydrateTargetRange flush visits only dirty registrations',
      countersAfterHydrate.dirtyFlushes === 1 &&
        countersAfterHydrate.dirtyEntriesSeen === 1000,
      JSON.stringify(countersAfterHydrate),
    );

    for (let index = 0; index < 250; index += 1) {
      unregisters[index]!();
    }
    assert(
      'unregister removes from the position index without a full scan',
      getVirtualNodePositionIndexSizeForTest() === 750 &&
        getVirtualNodePositionIndexTestCountersForTest().fullScans === 0 &&
        getVirtualNodePositionIndexTestCountersForTest().unregisters === 250,
      `size=${getVirtualNodePositionIndexSizeForTest()} counters=${JSON.stringify(getVirtualNodePositionIndexTestCountersForTest())}`,
    );
  } finally {
    for (const unregister of unregisters) {
      unregister();
    }
    resetActivationControllerForTest();
    if (previousIntersectionObserver === undefined) {
      delete globals.IntersectionObserver;
    } else {
      globals.IntersectionObserver = previousIntersectionObserver;
    }
    globals.requestAnimationFrame = previousRaf;
    globals.cancelAnimationFrame = previousCancelRaf;
  }
}

// ---------------------------------------------------------------------------
// Virtual node hydration: drainQueue consumes every in-radius task
// ---------------------------------------------------------------------------
{
  const globals = globalThis as Record<string, unknown>;
  const previousIntersectionObserver = globals.IntersectionObserver;
  const previousRaf = globals.requestAnimationFrame;
  const previousCancelRaf = globals.cancelAnimationFrame;
  const rafCallbacks: FrameRequestCallback[] = [];
  class FakeIntersectionObserver {
    private callback: IntersectionObserverCallback;
    readonly root: Element | null = null;

    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element): void {
      const entry = {
        target,
        isIntersecting: true,
      } as unknown as IntersectionObserverEntry;
      this.callback([entry], this as unknown as IntersectionObserver);
    }

    unobserve(): void {}
    disconnect(): void {}
  }
  globals.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
  globals.requestAnimationFrame = (callback: FrameRequestCallback) => {
    rafCallbacks.push(callback);
    return rafCallbacks.length;
  };
  globals.cancelAnimationFrame = () => {};
  resetActivationControllerForTest();

  const unregisters: Array<() => void> = [];
  const activated: string[] = [];
  try {
    const register = (id: string, position: number): void => {
      const element = document.createElement('div');
      element.className = 'hydrate-drain-test';
      unregisters.push(
        registerVirtualNodeView(id, element, {
          activate: () => activated.push(id),
          deactivate: () => {},
        }, { getPosition: () => position }),
      );
    };
    register('hydrate-drain-far', -80);
    register('hydrate-drain-near', 40);

    // The IO callbacks above seed the queue with a far task followed by a near task.
    hydrateTargetRange(
      document.createElement('div'),
      0,
      50,
      false,
      true,
    );

    const timings = (globalThis.window as unknown as Record<string, unknown>)
      .__marivellPhase4HydrateTimings as
      | {
          queueSizeBefore: number;
          queueSizeAfter: number;
          drainedTasks: number;
          drainRadius: number;
        }
      | null;

    assert(
      'hydrateTargetRange drainQueue activates all in-radius queued nodes',
      activated.includes('hydrate-drain-near') &&
        !activated.includes('hydrate-drain-far'),
      `activated=${JSON.stringify(activated)}`,
    );
    assert(
      'hydrateTargetRange drainQueue leaves out-of-radius nodes queued',
      timings !== null &&
        timings.queueSizeBefore === 2 &&
        timings.drainedTasks === 1 &&
        timings.queueSizeAfter === 1 &&
        timings.drainRadius === 75,
      JSON.stringify(timings),
    );
  } finally {
    for (const unregister of unregisters) {
      unregister();
    }
    resetActivationControllerForTest();
    if (previousIntersectionObserver === undefined) {
      delete globals.IntersectionObserver;
    } else {
      globals.IntersectionObserver = previousIntersectionObserver;
    }
    globals.requestAnimationFrame = previousRaf;
    globals.cancelAnimationFrame = previousCancelRaf;
  }
}

// ---------------------------------------------------------------------------
// Inline math registry: interaction must not full-traverse/rebuild (Phase C)
// ---------------------------------------------------------------------------
{
  const editor = makeEditor('Initial');
  try {
    resetInlineMathGroupRegistryForTest();
    const manyMath: string[] = [];
    for (let index = 0; index < 400; index += 1) {
      manyMath.push(`$x_${index}$ math text for paragraph ${index}
`);
    }
    load(editor, manyMath.join('\n'));
    assert(
      'inline math registry builds groups from live NodeViews',
      getInlineMathGroupCountForTest() >= 100,
      `groups=${getInlineMathGroupCountForTest()}`,
    );

    const frame = document.createElement('div');
    frame.className = 'editor-frame';
    const groupCountBeforeQueries = getInlineMathGroupCountForTest();
    const broadRangeActivated = hydrateInlineMathGroupsAroundPosition(frame, 10, 100_000);
    assert(
      'inline math broad range query finds live groups',
      broadRangeActivated > 0,
      `activated=${broadRangeActivated}`,
    );
    assert(
      'inline math range query preserves the group map',
      getInlineMathGroupCountForTest() === groupCountBeforeQueries,
      `before=${groupCountBeforeQueries} after=${getInlineMathGroupCountForTest()}`,
    );
    hydrateInlineMathGroupsAroundPosition(frame, 10, 1);
    hydrateInlineMathGroupsAroundPosition(frame, 10, 1);
    hydrateInlineMathGroupsAroundPosition(frame, 10, 1);
    const inlineIndexCounters = getInlineMathGroupIndexTestCountersForTest();
    assert(
      'inline math position queries do not re-sort the full group index',
      inlineIndexCounters.sorts === 0 &&
        inlineIndexCounters.fullGroupScans === 0 &&
        inlineIndexCounters.rangeQueries >= 3,
      JSON.stringify(inlineIndexCounters),
    );
    assert(
      'repeated inline math range queries do not lose groups',
      getInlineMathGroupCountForTest() === groupCountBeforeQueries,
      `before=${groupCountBeforeQueries} after=${getInlineMathGroupCountForTest()}`,
    );

    const groupCountBeforeTyping = getInlineMathGroupCountForTest();
    editor.commands.setTextSelection(1);
    editor.chain().focus().insertContent('typed text at start').run();
    assert(
      'typing does not rebuild the inline math group map',
      getInlineMathGroupCountForTest() === groupCountBeforeTyping,
      `before=${groupCountBeforeTyping} after=${getInlineMathGroupCountForTest()}`,
    );
    const typingCounters = getInlineMathGroupIndexTestCountersForTest();
    assert(
      'typing does not sort or full-scan inline math groups',
      typingCounters.sorts === 0 &&
        typingCounters.fullGroupScans === 0,
      JSON.stringify(typingCounters),
    );

    // Editing inside an existing inlineMath keeps the same group alive.
    const groupCountBefore = getInlineMathGroupCountForTest();
    editor.commands.setTextSelection(1);
    editor.chain().focus().insertContent('A').run();
    assert(
      'typing preserves inline math group count',
      getInlineMathGroupCountForTest() === groupCountBefore,
      `before=${groupCountBefore} after=${getInlineMathGroupCountForTest()}`,
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

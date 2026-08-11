import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const electronBin = path.join(projectRoot, 'node_modules/.bin/electron');
const electronViteBin = path.join(projectRoot, 'node_modules/.bin/electron-vite');

export interface U3LineBoxPercentileSummary {
  count: number;
  min: number;
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

export interface U3LineBoxPageResult {
  environment: {
    docSize: number;
    blockCount: number;
    lineCount: number;
    cellCount: number;
    scrollHeight: number;
    clientHeight: number;
  };
  build: {
    ms: number;
    rectReads: number;
    clientRectReads: number;
    nativeCoordsCalls: number;
    frameScrollTop: number;
    currentScrollTop: number;
  };
  coordsAtPos: {
    samples: number;
    deltaPx: U3LineBoxPercentileSummary;
    topDeltaPx: U3LineBoxPercentileSummary;
    bottomDeltaPx: U3LineBoxPercentileSummary;
    leftDeltaPx: U3LineBoxPercentileSummary;
    rightDeltaPx: U3LineBoxPercentileSummary;
    nativeMs: U3LineBoxPercentileSummary;
    protoMs: U3LineBoxPercentileSummary;
  };
  posAtCoords: {
    samples: number;
    posDelta: U3LineBoxPercentileSummary;
    nativeMs: U3LineBoxPercentileSummary;
    protoMs: U3LineBoxPercentileSummary;
  };
  scroll: {
    frames: number;
    native: {
      ms: U3LineBoxPercentileSummary;
      rectReads: number;
      clientRectReads: number;
      queryRectReads: number;
      queryClientRectReads: number;
    };
    proto: {
      ms: U3LineBoxPercentileSummary;
      rectReads: number;
      clientRectReads: number;
      queryRectReads: number;
      queryClientRectReads: number;
    };
  };
  incrementalUpdate: {
    insertedChars: number;
    pmDelta: number;
    heightDeltaPx: number;
    updateMs: number;
    fullRebuildMs: number;
    rectReads: number;
    clientRectReads: number;
    nativeCoordsCalls: number;
    restoredAfterUndo: boolean;
  };
  diagnostics: {
    coordsTopSamples: number[];
    coordsBottomSamples: number[];
    coordsLeftSamples: number[];
    coordsRightSamples: number[];
    posAtCoordsSamples: number[];
    nativeCoordQueryMs: number[];
    protoCoordQueryMs: number[];
    nativePosQueryMs: number[];
    protoPosQueryMs: number[];
    posAtCoordsDetails: Array<{
      queryX: number;
      queryY: number;
      nativePos: number;
      protoPos: number;
      protoDocY: number;
      blockType: string | null;
      lineStart: number | null;
      lineEnd: number | null;
    }>;
    tablePreview: Array<{
      pmStart: number;
      pmEnd: number;
      type: string;
      docTop: number;
      docBottom: number;
      lineCount: number;
    }>;
    linePreview: Array<{
      blockType: string;
      lineStart: number;
      lineEnd: number;
      docTop: number;
      docBottom: number;
      cellCount: number;
      cellMinStart: number | null;
      cellMaxEnd: number | null;
    }>;
    partsPreview: Array<{
      blockType: string;
      blockStart: number;
      blockEnd: number;
      parts: Array<{
        partKind: string;
        partStart: number;
        partEnd: number;
        formula: boolean;
        textLength: number;
        domType: number | null;
      }>;
    }>;
    descPreview: Array<{
      blockType: string;
      blockStart: number;
      blockEnd: number;
      children: Array<{
        childType: string | null;
        childStart: number;
        childEnd: number;
        childSize: number;
        domType: number | null;
        domTag: string | null;
      }>;
    }>;
    lineBoxesPreview: Array<{
      blockType: string;
      blockStart: number;
      boxCount: number;
      boxes: Array<{ docTop: number; docBottom: number; docLeftStart: number; docLeftEnd: number }>;
    }>;
    scrollNativeMs: number[];
    scrollProtoMs: number[];
  };
}

export interface U3LineBoxE2EResult {
  markdownPath: string;
  sourceBytes: number;
  buildMs: number;
  launchMs: number;
  readyMs: number;
  page: U3LineBoxPageResult;
}

interface ElectronHandle {
  child: ReturnType<typeof spawn>;
  browser: Browser;
  page: Page;
  port: number;
  spawnedAt: number;
}

interface RectStats {
  rectReads: number;
  clientRectReads: number;
}

interface FrameState {
  top: number;
  left: number;
  scrollTop: number;
  scrollLeft: number;
}

interface CharCell {
  startPos: number;
  endPos: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  center: number;
  formula: boolean;
}

interface LineRecord {
  startPos: number;
  endPos: number;
  docTop: number;
  docBottom: number;
  docLeftStart: number;
  docLeftEnd: number;
  height: number;
  cells: CharCell[];
}

interface BlockRecord {
  pmStart: number;
  pmEnd: number;
  type: string;
  depth: number;
  dom: HTMLElement;
  contentDOM: HTMLElement | null;
  docTop: number;
  docBottom: number;
  docLeftStart: number;
  docLeftEnd: number;
  height: number;
  lines: LineRecord[];
}

interface DescNodeLike {
  isBlock?: boolean;
  isTextblock?: boolean;
  isLeaf?: boolean;
  isText?: boolean;
  isInline?: boolean;
  type?: { name: string };
  content?: { size: number };
}

interface DescLike {
  node?: DescNodeLike | null;
  posAtStart: number;
  posAtEnd: number;
  dom: Node | null;
  contentDOM: Node | null;
  children?: DescLike[];
}

interface TextPart {
  kind: 'text';
  dom: Text;
  startPos: number;
  endPos: number;
  formula: boolean;
}

interface ElementPart {
  kind: 'element';
  dom: Element;
  startPos: number;
  endPos: number;
  type: string;
}

type InlinePart = TextPart | ElementPart;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildRenderer(outDir: string): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  await execFileAsync(
    electronViteBin,
    ['build', '--outDir', outDir, '--logLevel', 'warn'],
    { cwd: projectRoot, env: { ...process.env } },
  );
  const nodeModules = path.join(outDir, 'node_modules');
  if (!fs.existsSync(nodeModules)) {
    fs.symlinkSync(path.join(projectRoot, 'node_modules'), nodeModules, 'dir');
  }
}

async function connectToElectron(port: number, timeoutMs: number): Promise<Browser> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error;
      await wait(250);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('failed to connect to Electron');
}

async function launchElectron(
  outDir: string,
  filePath: string,
  port: number,
  profile: string,
): Promise<ElectronHandle> {
  const spawnedAt = Date.now();
  const child = spawn(
    electronBin,
    [
      path.join(outDir, 'main', 'index.js'),
      '--no-sandbox',
      '--disable-gpu',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      filePath,
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, MARIVELL_BENCHMARK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    },
  );

  const browser = await connectToElectron(port, 30_000);
  const context = browser.contexts()[0];
  const page = context?.pages()[0];
  if (!page) {
    throw new Error('Electron page was not created');
  }
  await page.waitForLoadState('domcontentloaded');
  return { child, browser, page, port, spawnedAt };
}

async function waitForVisualReady(
  page: Page,
  expectedNodeSize: number,
  deadlineMs: number,
): Promise<{ waitMs: number; timedOut: boolean }> {
  return page.evaluate(
    async ({ expectedSize, deadlineMs }) => {
      const start = Date.now();
      const deadline = start + deadlineMs;
      while (Date.now() < deadline) {
        const loading = document.querySelector('.editor-loading');
        const surface = document.querySelector('.editor-surface');
        const frame = document.querySelector('.editor-frame');
        const editor = (window as unknown as {
          __marivellEditor?: { state?: { doc?: { nodeSize?: number } } };
        }).__marivellEditor;
        const nodeReady = Boolean(editor?.state?.doc && editor.state.doc.nodeSize > expectedSize);
        const textReady = Boolean(
          surface && (surface as HTMLElement).innerText.length > Math.min(expectedSize, 10_000),
        );
        if (!loading && surface && frame && (nodeReady || textReady)) {
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          return { waitMs: Date.now() - start, timedOut: false };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return { waitMs: Date.now() - start, timedOut: true };
    },
    { expectedSize: expectedNodeSize, deadlineMs },
  );
}

function generateSmallMarkdown(): string {
  const parts: string[] = [];
  for (let index = 0; index < 64; index += 1) {
    parts.push(`## Section ${index}\n`);
    parts.push(
      `Paragraph ${index} has a bounded inline expression $x_{${index}}^2 + y_{${index}}$ and enough plain text to keep the coordinate engine sample meaningful: ${index} ${index} ${index} ${index}.\n`,
    );
    if (index % 6 === 0) {
      parts.push(`- list item ${index} alpha\n- list item ${index} beta\n`);
    }
    if (index % 9 === 0) {
      parts.push('```ts\nconst sample = 1 + 2;\n```\n');
    }
    if (index % 13 === 0) {
      parts.push('$$\n\\frac{a^2}{b+1} + c\n$$\n');
    }
  }
  return parts.join('\n');
}

function percentileSummary(values: number[]): U3LineBoxPercentileSummary {
  if (values.length === 0) {
    return { count: 0, min: 0, avg: 0, p50: 0, p95: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (ratio: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)));
    return sorted[index] ?? 0;
  };
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    avg: sum / sorted.length,
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

export async function runU3LineBoxPoCInPage(): Promise<U3LineBoxPageResult> {
  const benchmarkWindow = window as unknown as Record<string, unknown>;
  const editor = (benchmarkWindow as {
    __marivellEditor?: {
      view: {
        state: {
          doc: {
            content: { size: number };
            nodeSize: number;
          };
          tr: unknown;
        };
        coordsAtPos: (pos: number, side?: number) => {
          top: number;
          bottom: number;
          left: number;
          right: number;
        } | null;
        posAtCoords: (coords: { left: number; top: number }) => {
          pos: number;
          inside: number;
        } | null;
        docView: unknown;
        dispatch: (tr: unknown) => void;
      };
      commands: { undo: () => boolean };
    };
  }).__marivellEditor ?? null;
  if (!editor?.view?.state?.doc) {
    throw new Error('benchmark editor not exposed');
  }
  const frame = document.querySelector<HTMLElement>('.editor-frame');
  if (!frame) {
    throw new Error('editor frame missing');
  }

  const percentileSummaryLocal = (values: number[]): U3LineBoxPercentileSummary => {
    if (values.length === 0) {
      return { count: 0, min: 0, avg: 0, p50: 0, p95: 0, max: 0 };
    }
    const sorted = [...values].sort((a, b) => a - b);
    const pick = (ratio: number): number => {
      const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)));
      return sorted[index] ?? 0;
    };
    const sum = sorted.reduce((total, value) => total + value, 0);
    return {
      count: sorted.length,
      min: sorted[0] ?? 0,
      avg: sum / sorted.length,
      p50: pick(0.5),
      p95: pick(0.95),
      max: sorted[sorted.length - 1] ?? 0,
    };
  };

  const rectStats: RectStats = {
    rectReads: 0,
    clientRectReads: 0,
  };
  const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
  const originalGetClientRects = Range.prototype.getClientRects;
  Element.prototype.getBoundingClientRect = function getBoundingClientRectPatched(
    this: Element,
  ): DOMRect {
    rectStats.rectReads += 1;
    return originalGetBoundingClientRect.call(this);
  };
  Range.prototype.getClientRects = function getClientRectsPatched(this: Range): DOMRectList {
    rectStats.clientRectReads += 1;
    return originalGetClientRects.call(this);
  };

  try {
    const view = editor.view;
    const frameRect = frame.getBoundingClientRect();
    const frameState: FrameState = {
      top: frameRect.top,
      left: frameRect.left,
      scrollTop: frame.scrollTop,
      scrollLeft: frame.scrollLeft,
    };
    const toDoc = (value: number, origin: number, scroll: number): number =>
      value - origin + scroll;

    const readRangeRect = (range: Range, fallbackToBoundingRect: boolean): DOMRect | null => {
      const rects = range.getClientRects();
      for (const rect of Array.from(rects)) {
        if (rect.width !== 0 || rect.height !== 0) {
          return rect;
        }
      }
      if (rects.length > 0) {
        return rects[0] ?? null;
      }
      if (fallbackToBoundingRect) {
        rectStats.rectReads += 1;
        return range.getBoundingClientRect();
      }
      return null;
    };

    const isVisibleBlockNode = (node: DescNodeLike): boolean => {
      if (!node.isBlock) return false;
      if (node.isTextblock) return true;
      if (node.isLeaf) return true;
      return ['image', 'mathBlock', 'mermaid', 'htmlBlock'].includes(node.type?.name ?? '');
    };

    const collectInlineParts = (desc: DescLike, insideInlineMath: boolean): InlinePart[] => {
      const parts: InlinePart[] = [];
      const walk = (current: DescLike | null, inFormula: boolean): void => {
        if (!current) return;
        const node = current.node;
        const nodeName = node?.type?.name ?? '';
        const childInFormula = inFormula || nodeName === 'inlineMath';
        const textNode =
          current.dom?.nodeType === Node.TEXT_NODE
            ? (current.dom as Text)
            : current.dom instanceof Element
              ? Array.from(current.dom.childNodes).find(
                  (child): child is Text => child.nodeType === Node.TEXT_NODE,
                ) ?? null
              : null;
        if (node?.isText && textNode) {
          parts.push({
            kind: 'text',
            dom: textNode,
            startPos: current.posAtStart,
            endPos: current.posAtEnd,
            formula: inFormula,
          });
        } else if (
          node?.isInline &&
          node.isLeaf &&
          !node.isText &&
          current.dom instanceof Element
        ) {
          parts.push({
            kind: 'element',
            dom: current.dom,
            startPos: current.posAtStart,
            endPos: current.posAtEnd,
            type: nodeName,
          });
          return;
        }
        for (const child of current.children ?? []) {
          walk(child as DescLike, childInFormula);
        }
      };
      walk(desc, insideInlineMath);
      return parts;
    };

    const measureTextParts = (
      parts: InlinePart[],
      state: FrameState,
    ): { cells: CharCell[]; elementCells: CharCell[] } => {
      const cells: CharCell[] = [];
      const elementCells: CharCell[] = [];
      for (const part of parts) {
        if (part.kind === 'element') {
          const range = document.createRange();
          range.selectNode(part.dom);
          const rect = readRangeRect(range, true);
          if (rect) {
            const left = toDoc(rect.left, state.left, state.scrollLeft);
            const right = toDoc(rect.right, state.left, state.scrollLeft);
            elementCells.push({
              startPos: part.startPos,
              endPos: part.endPos,
              left,
              right,
              top: toDoc(rect.top, state.top, state.scrollTop),
              bottom: toDoc(rect.bottom, state.top, state.scrollTop),
              center: (left + right) / 2,
              formula: false,
            });
          }
          continue;
        }
        const textNode = part.dom;
        const text = textNode.nodeValue ?? '';
        if (text.length === 0) continue;
        const range = document.createRange();
        for (let index = 0; index < text.length; index += 1) {
          range.setStart(textNode, index);
          range.setEnd(textNode, index + 1);
          const rect = readRangeRect(range, true);
          if (!rect) continue;
          const left = toDoc(rect.left, state.left, state.scrollLeft);
          const right = toDoc(rect.right, state.left, state.scrollLeft);
          cells.push({
            startPos: part.startPos + index,
            endPos: part.startPos + index + 1,
            left,
            right,
            top: toDoc(rect.top, state.top, state.scrollTop),
            bottom: toDoc(rect.bottom, state.top, state.scrollTop),
            center: (left + right) / 2,
            formula: part.formula,
          });
        }
      }
      return { cells, elementCells };
    };

    const getMergedLineBoxes = (
      contentDOM: HTMLElement,
      state: FrameState,
    ): Array<{ docTop: number; docBottom: number; docLeftStart: number; docLeftEnd: number }> => {
      const range = document.createRange();
      range.selectNodeContents(contentDOM);
      const rects = range.getClientRects();
      const merged: Array<{ docTop: number; docBottom: number; docLeftStart: number; docLeftEnd: number }> = [];
      for (const rect of Array.from(rects)) {
        if (rect.width === 0 && rect.height === 0) continue;
        const docTop = toDoc(rect.top, state.top, state.scrollTop);
        const docBottom = toDoc(rect.bottom, state.top, state.scrollTop);
        const docLeftStart = toDoc(rect.left, state.left, state.scrollLeft);
        const docLeftEnd = toDoc(rect.right, state.left, state.scrollLeft);
        let existing: (typeof merged)[number] | null = null;
        for (const candidate of merged) {
          if (
            Math.abs(candidate.docTop - docTop) <= 1 &&
            Math.abs(candidate.docBottom - docBottom) <= 1
          ) {
            existing = candidate;
            break;
          }
        }
        if (existing) {
          existing.docTop = Math.min(existing.docTop, docTop);
          existing.docBottom = Math.max(existing.docBottom, docBottom);
          existing.docLeftStart = Math.min(existing.docLeftStart, docLeftStart);
          existing.docLeftEnd = Math.max(existing.docLeftEnd, docLeftEnd);
        } else {
          merged.push({ docTop, docBottom, docLeftStart, docLeftEnd });
        }
      }
      return merged.sort((a, b) => a.docTop - b.docTop || a.docLeftStart - b.docLeftStart);
    };

    const groupCellsIntoLines = (
      lineBoxes: Array<{ docTop: number; docBottom: number; docLeftStart: number; docLeftEnd: number }>,
      cells: CharCell[],
      elementCells: CharCell[],
      blockStart: number,
      blockEnd: number,
    ): LineRecord[] => {
      const allCells = [...cells, ...elementCells].sort((a, b) => a.startPos - b.startPos);
      if (allCells.length > 0) {
        const lines: LineRecord[] = [];
        const tolerance = 14;
        for (const cell of allCells) {
          const centerY = (cell.top + cell.bottom) / 2;
          let line: LineRecord | null = null;
          for (const candidate of lines) {
            const candidateCenter = (candidate.docTop + candidate.docBottom) / 2;
            if (Math.abs(centerY - candidateCenter) <= tolerance) {
              line = candidate;
              break;
            }
          }
          if (!line) {
            line = {
              startPos: cell.startPos,
              endPos: cell.endPos,
              docTop: cell.top,
              docBottom: cell.bottom,
              docLeftStart: cell.left,
              docLeftEnd: cell.right,
              height: cell.bottom - cell.top,
              cells: [],
            };
            lines.push(line);
          }
          line.cells.push(cell);
          line.startPos = Math.min(line.startPos, cell.startPos);
          line.endPos = Math.max(line.endPos, cell.endPos);
          line.docTop = Math.min(line.docTop, cell.top);
          line.docBottom = Math.max(line.docBottom, cell.bottom);
          line.docLeftStart = Math.min(line.docLeftStart, cell.left);
          line.docLeftEnd = Math.max(line.docLeftEnd, cell.right);
          line.height = line.docBottom - line.docTop;
        }
        return lines
          .map((line) => ({
            ...line,
            cells: line.cells.sort((a, b) => a.startPos - b.startPos),
          }))
          .sort((a, b) => a.docTop - b.docTop || a.startPos - b.startPos);
      }
      const lines: LineRecord[] = lineBoxes.map((box) => ({
        startPos: blockStart,
        endPos: blockEnd,
        docTop: box.docTop,
        docBottom: box.docBottom,
        docLeftStart: box.docLeftStart,
        docLeftEnd: box.docLeftEnd,
        height: box.docBottom - box.docTop,
        cells: [],
      }));
      return lines;
    };

    const collectBlockParts = (desc: DescLike): InlinePart[] =>
      collectInlineParts(desc, false);

    const buildBlockFromDesc = (
      desc: DescLike,
      depth: number,
      state: FrameState,
    ): BlockRecord => {
      const domElement =
        desc.dom instanceof HTMLElement
          ? desc.dom
          : desc.contentDOM instanceof HTMLElement
            ? desc.contentDOM
            : null;
      if (!domElement) {
        throw new Error(`block has no DOM element: ${desc.node?.type?.name ?? 'unknown'}`);
      }
      const pmStart = desc.posAtStart;
      const pmEnd = desc.posAtEnd;
      let lines: LineRecord[] = [];
      if (desc.node?.isTextblock && !desc.node.isLeaf) {
        const contentDOM =
          desc.contentDOM instanceof HTMLElement ? desc.contentDOM : domElement;
        const parts = collectBlockParts(desc);
        const { cells, elementCells } = measureTextParts(parts, state);
        const lineBoxes = getMergedLineBoxes(contentDOM, state);
        lines = groupCellsIntoLines(lineBoxes, cells, elementCells, pmStart, pmEnd);
        if (lines.length === 0) {
          const range = document.createRange();
          range.selectNodeContents(contentDOM);
          const rect = readRangeRect(range, true);
          const docTop = rect ? toDoc(rect.top, state.top, state.scrollTop) : pmStart;
          const docBottom = rect ? toDoc(rect.bottom, state.top, state.scrollTop) : pmEnd;
          lines.push({
            startPos: pmStart,
            endPos: pmEnd,
            docTop,
            docBottom,
            docLeftStart: rect ? toDoc(rect.left, state.left, state.scrollLeft) : 0,
            docLeftEnd: rect ? toDoc(rect.right, state.left, state.scrollLeft) : 0,
            height: docBottom - docTop,
            cells: [],
          });
        }
      } else {
        const range = document.createRange();
        range.selectNode(domElement);
        const rect = readRangeRect(range, true);
        const docTop = rect ? toDoc(rect.top, state.top, state.scrollTop) : 0;
        const docBottom = rect ? toDoc(rect.bottom, state.top, state.scrollTop) : 0;
        const docLeftStart = rect ? toDoc(rect.left, state.left, state.scrollLeft) : 0;
        const docLeftEnd = rect ? toDoc(rect.right, state.left, state.scrollLeft) : 0;
        lines.push({
          startPos: pmStart,
          endPos: pmEnd,
          docTop,
          docBottom,
          docLeftStart,
          docLeftEnd,
          height: docBottom - docTop,
          cells: [],
        });
      }
      const docTop = Math.min(...lines.map((line) => line.docTop));
      const docBottom = Math.max(...lines.map((line) => line.docBottom));
      const docLeftStart = Math.min(...lines.map((line) => line.docLeftStart));
      const docLeftEnd = Math.max(...lines.map((line) => line.docLeftEnd));
      return {
        pmStart,
        pmEnd,
        type: desc.node?.type?.name ?? 'unknown',
        depth,
        dom: domElement,
        contentDOM: desc.contentDOM instanceof HTMLElement ? desc.contentDOM : null,
        docTop,
        docBottom,
        docLeftStart,
        docLeftEnd,
        height: docBottom - docTop,
        lines,
      };
    };

    const collectBlocks = (state: FrameState): BlockRecord[] => {
      const blocks: BlockRecord[] = [];
      const walk = (desc: DescLike | null, depth: number): void => {
        if (!desc) return;
        if (desc.node && isVisibleBlockNode(desc.node)) {
          blocks.push(buildBlockFromDesc(desc, depth, state));
        }
        for (const child of desc.children ?? []) {
          walk(child as DescLike, depth + 1);
        }
      };
      walk(view.docView as DescLike, 0);
      blocks.sort((a, b) => a.pmStart - b.pmStart || a.pmEnd - b.pmEnd);
      return blocks;
    };

    rectStats.rectReads = 0;
    rectStats.clientRectReads = 0;
    const buildStart = performance.now();
    let table = collectBlocks(frameState);
    const buildMs = performance.now() - buildStart;
    const buildRectReads = rectStats.rectReads;
    const buildClientRectReads = rectStats.clientRectReads;
    const buildNativeCoordsCalls = 0;

    const lineCount = table.reduce((sum, block) => sum + block.lines.length, 0);
    const cellCount = table.reduce(
      (sum, block) => sum + block.lines.reduce((lineSum, line) => lineSum + line.cells.length, 0),
      0,
    );
    if (table.length < 4 || lineCount < 8 || cellCount < 16) {
      throw new Error(
        `line-box offset table too small: blocks=${table.length} lines=${lineCount} cells=${cellCount}`,
      );
    }

    const findDescByStart = (start: number, type: string): DescLike | null => {
      let found: DescLike | null = null;
      const walk = (desc: DescLike | null): void => {
        if (!desc) return;
        if (desc.node && desc.posAtStart === start && desc.node.type?.name === type) {
          found = desc;
        }
        for (const child of desc.children ?? []) {
          walk(child as DescLike);
        }
      };
      walk(view.docView as DescLike);
      return found;
    };

    const findBlockAtPos = (pos: number): BlockRecord | null => {
      let lo = 0;
      let hi = table.length - 1;
      let best: BlockRecord | null = null;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const block = table[mid];
        if (!block) break;
        if (block.pmStart <= pos) {
          best = block;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return best && pos <= best.pmEnd ? best : null;
    };

    const findLineAtPos = (block: BlockRecord, pos: number): LineRecord | null => {
      const startsAtPos = block.lines.filter((line) => line.startPos === pos);
      if (startsAtPos.length > 0) {
        return startsAtPos[0] ?? null;
      }
      let best: LineRecord | null = null;
      for (const line of block.lines) {
        if (line.startPos <= pos && pos <= line.endPos) {
          best = line;
        }
      }
      return best;
    };

    const findCellAtPos = (line: LineRecord, pos: number): CharCell | null => {
      const cells = line.cells;
      if (cells.length === 0) return null;
      const atStart = cells.find((cell) => cell.startPos === pos);
      if (atStart) return atStart;
      const atEnd = cells.find((cell) => cell.endPos === pos);
      if (atEnd) return atEnd;
      if (pos < cells[0].startPos) return cells[0];
      if (pos > cells[cells.length - 1].endPos) return cells[cells.length - 1];
      return (
        cells.find((cell) => cell.startPos <= pos && pos <= cell.endPos) ??
        cells.reduce<CharCell | null>((best, cell) => {
          if (!best) return cell;
          const bestDistance = Math.min(Math.abs(best.startPos - pos), Math.abs(best.endPos - pos));
          const cellDistance = Math.min(Math.abs(cell.startPos - pos), Math.abs(cell.endPos - pos));
          return cellDistance < bestDistance ? cell : best;
        }, null)
      );
    };

    const protoCoordsAtPos = (
      pos: number,
      state: FrameState,
    ): { top: number; bottom: number; left: number; right: number } | null => {
      const block = findBlockAtPos(pos);
      if (!block) return null;
      const line = findLineAtPos(block, pos) ?? block.lines[block.lines.length - 1];
      if (!line) return null;
      const cell = findCellAtPos(line, pos);
      let top: number;
      let bottom: number;
      let left: number;
      if (!cell) {
        top = line.docTop;
        bottom = line.docBottom;
        left = line.docLeftStart;
      } else if (pos >= cell.startPos && pos < cell.endPos) {
        top = cell.top;
        bottom = cell.bottom;
        left = cell.left;
      } else {
        top = cell.top;
        bottom = cell.bottom;
        left = cell.right;
      }
      return {
        top: state.top + top - state.scrollTop,
        bottom: state.top + bottom - state.scrollTop,
        left: state.left + left - state.scrollLeft,
        right: state.left + left - state.scrollLeft,
      };
    };

    const findBlockAtDocYWithRelation = (
      docY: number,
    ): { block: BlockRecord | null; relation: 'inside' | 'before' | 'after' } => {
      let best: BlockRecord | null = null;
      let bestDistance = Infinity;
      let relation: 'inside' | 'before' | 'after' = 'after';
      for (const block of table) {
        if (docY >= block.docTop && docY <= block.docBottom) {
          return { block, relation: 'inside' };
        }
        const distance = docY < block.docTop ? block.docTop - docY : docY - block.docBottom;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = block;
          relation = docY < block.docTop ? 'before' : 'after';
        }
      }
      return { block: best, relation };
    };

    const findLineAtDocYWithRelation = (
      block: BlockRecord,
      docY: number,
    ): { line: LineRecord | null; relation: 'inside' | 'before' | 'after' } => {
      let best: LineRecord | null = null;
      let bestDistance = Infinity;
      let relation: 'inside' | 'before' | 'after' = 'after';
      for (const line of block.lines) {
        if (docY >= line.docTop && docY <= line.docBottom) {
          return { line, relation: 'inside' };
        }
        const distance = docY < line.docTop ? line.docTop - docY : docY - line.docBottom;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = line;
          relation = docY < line.docTop ? 'before' : 'after';
        }
      }
      return { line: best, relation };
    };

    const blockBoundaryForRelation = (
      block: BlockRecord,
      relation: 'before' | 'after',
      _docX: number,
    ): number => {
      const effectiveStart = block.lines[0]?.startPos ?? block.pmStart;
      const effectiveEnd = block.lines[block.lines.length - 1]?.endPos ?? block.pmEnd;
      return relation === 'before' ? effectiveStart : effectiveEnd;
    };

    const lineBoundaryForRelation = (
      block: BlockRecord,
      line: LineRecord,
      relation: 'before' | 'after',
    ): number => {
      return relation === 'before' ? line.startPos : line.endPos;
    };

    const protoPosAtCoords = (
      left: number,
      top: number,
      state: FrameState,
    ): { pos: number } | null => {
      const docY = top - state.top + state.scrollTop;
      const docX = left - state.left + state.scrollLeft;
      const blockInfo = findBlockAtDocYWithRelation(docY);
      const block = blockInfo.block;
      if (!block) return null;
      if (blockInfo.relation !== 'inside') {
        return { pos: blockBoundaryForRelation(block, blockInfo.relation, docX) };
      }
      const lineInfo = findLineAtDocYWithRelation(block, docY);
      const line = lineInfo.line;
      if (!line) return null;
      if (lineInfo.relation !== 'inside') {
        return { pos: lineBoundaryForRelation(block, line, lineInfo.relation) };
      }
      const cells = line.cells;
      if (cells.length === 0) {
        const lineCenter = (line.docTop + line.docBottom) / 2;
        return {
          pos: docY < lineCenter ? line.startPos : line.endPos,
        };
      }
      if (docX <= cells[0].left) return { pos: cells[0].startPos };
      if (docX >= cells[cells.length - 1].right) {
        return { pos: cells[cells.length - 1].endPos };
      }
      let best: CharCell = cells[0];
      let bestDistance = Infinity;
      for (const cell of cells) {
        if (docX >= cell.left && docX <= cell.right) {
          return { pos: docX >= cell.center ? cell.endPos : cell.startPos };
        }
        const distance = Math.min(Math.abs(docX - cell.left), Math.abs(docX - cell.right));
        if (distance < bestDistance) {
          bestDistance = distance;
          best = cell;
        }
      }
      return { pos: docX >= best.center ? best.endPos : best.startPos };
    };

    const state: FrameState = { ...frameState };
    const samplePositions: number[] = [];
    for (const block of table) {
      for (const line of block.lines) {
        samplePositions.push(line.startPos);
        samplePositions.push(line.endPos);
        if (line.cells.length > 0) {
          const midpoint = Math.floor((line.startPos + line.endPos) / 2);
          samplePositions.push(midpoint);
        }
        for (let index = 0; index < Math.min(line.cells.length, 6); index += 1) {
          samplePositions.push(line.cells[index].startPos);
        }
      }
    }
    const uniquePositions = Array.from(new Set(samplePositions)).slice(0, 600);

    const coordsTopDeltas: number[] = [];
    const coordsBottomDeltas: number[] = [];
    const coordsLeftDeltas: number[] = [];
    const coordsRightDeltas: number[] = [];
    const coordsMaxDeltas: number[] = [];
    for (const pos of uniquePositions) {
      const native = view.coordsAtPos(pos);
      const proto = protoCoordsAtPos(pos, state);
      if (!native || !proto) continue;
      const topDelta = Math.abs(native.top - proto.top);
      const bottomDelta = Math.abs(native.bottom - proto.bottom);
      const leftDelta = Math.abs(native.left - proto.left);
      const rightDelta = Math.abs(native.right - proto.right);
      coordsTopDeltas.push(topDelta);
      coordsBottomDeltas.push(bottomDelta);
      coordsLeftDeltas.push(leftDelta);
      coordsRightDeltas.push(rightDelta);
      coordsMaxDeltas.push(Math.max(topDelta, bottomDelta, leftDelta, rightDelta));
    }

    const nativeCoordQueryMs: number[] = [];
    const protoCoordQueryMs: number[] = [];
    const coordQueryPositions = uniquePositions.slice(0, 100);
    for (let round = 0; round < 5; round += 1) {
      for (const pos of coordQueryPositions) {
        const nativeStart = performance.now();
        view.coordsAtPos(pos);
        nativeCoordQueryMs.push(performance.now() - nativeStart);
        const protoStart = performance.now();
        protoCoordsAtPos(pos, state);
        protoCoordQueryMs.push(performance.now() - protoStart);
      }
    }

    const frameRectForGrid = frame.getBoundingClientRect();
    const gridStep = Math.max(4, Math.floor(frameRectForGrid.height / 16));
    const posNativeDeltas: number[] = [];
    const posAtCoordsDetails: Array<{
      queryX: number;
      queryY: number;
      nativePos: number;
      protoPos: number;
      protoDocY: number;
      blockType: string | null;
      lineStart: number | null;
      lineEnd: number | null;
    }> = [];
    for (let y = frameRectForGrid.top + 4; y < frameRectForGrid.bottom - 4; y += gridStep) {
      for (const xRatio of [0.1, 0.5, 0.9]) {
        const left = frameRectForGrid.left + frameRectForGrid.width * xRatio;
        const native = view.posAtCoords({ left, top: y });
        if (!native) continue;
        const proto = protoPosAtCoords(left, y, state);
        if (!proto) continue;
        const protoDocY = y - state.top + state.scrollTop;
        const protoBlock = findBlockAtDocYWithRelation(protoDocY).block;
        const protoLine = protoBlock ? findLineAtDocYWithRelation(protoBlock, protoDocY).line : null;
        posAtCoordsDetails.push({
          queryX: left,
          queryY: y,
          nativePos: native.pos,
          protoPos: proto.pos,
          protoDocY,
          blockType: protoBlock?.type ?? null,
          lineStart: protoLine?.startPos ?? null,
          lineEnd: protoLine?.endPos ?? null,
        });
        posNativeDeltas.push(Math.abs(native.pos - proto.pos));
      }
    }

    const nativePosQueryMs: number[] = [];
    const protoPosQueryMs: number[] = [];
    const posQueryGrid: Array<{ left: number; top: number }> = [];
    for (let y = frameRectForGrid.top + 8; y < frameRectForGrid.bottom - 8; y += Math.max(8, gridStep)) {
      for (const xRatio of [0.2, 0.5, 0.8]) {
        posQueryGrid.push({
          left: frameRectForGrid.left + frameRectForGrid.width * xRatio,
          top: y,
        });
      }
    }
    for (let round = 0; round < 5; round += 1) {
      for (const point of posQueryGrid.slice(0, 80)) {
        const nativeStart = performance.now();
        view.posAtCoords({ left: point.left, top: point.top });
        nativePosQueryMs.push(performance.now() - nativeStart);
        const protoStart = performance.now();
        protoPosAtCoords(point.left, point.top, state);
        protoPosQueryMs.push(performance.now() - protoStart);
      }
    }

    const runScrollFramePath = async (
      mode: 'native' | 'proto',
      frames: number,
    ): Promise<{
      ms: number[];
      rectReads: number;
      clientRectReads: number;
      queryRectReads: number;
      queryClientRectReads: number;
    }> => {
      const ms: number[] = [];
      rectStats.rectReads = 0;
      rectStats.clientRectReads = 0;
      let queryRectReads = 0;
      let queryClientRectReads = 0;
      const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
      const stopScroll = (event: Event): void => {
        event.stopImmediatePropagation();
      };
      frame.addEventListener('scroll', stopScroll, { capture: true });
      try {
        for (let index = 0; index < frames; index += 1) {
          const ratio = 0.08 + (index / Math.max(frames - 1, 1)) * 0.84;
          const target = Math.round(maxScrollTop * ratio);
          const start = performance.now();
          frame.scrollTop = target;
          const pointLeft = frameState.left + frame.clientWidth * 0.5;
          const pointTop = frameState.top + frame.clientHeight * 0.5;
          const currentState: FrameState = {
            ...frameState,
            scrollTop: frame.scrollTop,
            scrollLeft: frame.scrollLeft,
          };
          if (mode === 'native') {
            const beforeRect = rectStats.rectReads;
            const beforeClientRect = rectStats.clientRectReads;
            const nativePos = view.posAtCoords({ left: pointLeft, top: pointTop })?.pos ?? 0;
            view.coordsAtPos(nativePos);
            queryRectReads += rectStats.rectReads - beforeRect;
            queryClientRectReads += rectStats.clientRectReads - beforeClientRect;
          } else {
            const beforeRect = rectStats.rectReads;
            const beforeClientRect = rectStats.clientRectReads;
            const protoPos = protoPosAtCoords(pointLeft, pointTop, currentState);
            if (protoPos) {
              protoCoordsAtPos(protoPos.pos, currentState);
            }
            queryRectReads += rectStats.rectReads - beforeRect;
            queryClientRectReads += rectStats.clientRectReads - beforeClientRect;
          }
          await new Promise((resolve) => requestAnimationFrame(resolve));
          ms.push(performance.now() - start);
        }
      } finally {
        frame.removeEventListener('scroll', stopScroll, { capture: true });
      }
      return {
        ms,
        rectReads: rectStats.rectReads,
        clientRectReads: rectStats.clientRectReads,
        queryRectReads,
        queryClientRectReads,
      };
    };

    const changedBlock = table.find(
      (block) => block.type === 'paragraph' && block.lines.length > 0,
    );
    if (!changedBlock) {
      throw new Error('no paragraph block available for incremental update');
    }
    const previousFontSize = changedBlock.dom.style.fontSize;
    rectStats.rectReads = 0;
    rectStats.clientRectReads = 0;
    const updateStart = performance.now();
    changedBlock.dom.style.fontSize = '34px';
    void changedBlock.dom.offsetHeight;
    const changedIndex = table.findIndex((block) => block.pmStart === changedBlock.pmStart);
    const changedDesc = findDescByStart(changedBlock.pmStart, changedBlock.type);
    if (!changedDesc || changedIndex === -1) {
      throw new Error('changed block disappeared after incremental edit');
    }
    const rebuiltChangedBlock = buildBlockFromDesc(changedDesc, changedBlock.depth, state);
    const pmDelta = 0;
    const heightDeltaPx = rebuiltChangedBlock.height - changedBlock.height;
    const originalChangedBlock = table[changedIndex];
    if (!originalChangedBlock) {
      throw new Error('changed block missing from offset table');
    }
    originalChangedBlock.pmEnd = rebuiltChangedBlock.pmEnd;
    originalChangedBlock.docTop = rebuiltChangedBlock.docTop;
    originalChangedBlock.docBottom = rebuiltChangedBlock.docBottom;
    originalChangedBlock.docLeftStart = rebuiltChangedBlock.docLeftStart;
    originalChangedBlock.docLeftEnd = rebuiltChangedBlock.docLeftEnd;
    originalChangedBlock.height = rebuiltChangedBlock.height;
    originalChangedBlock.lines = rebuiltChangedBlock.lines;
    for (let index = changedIndex + 1; index < table.length; index += 1) {
      const block = table[index];
      if (!block) continue;
      block.pmStart += pmDelta;
      block.pmEnd += pmDelta;
      block.docTop += heightDeltaPx;
      block.docBottom += heightDeltaPx;
      for (const line of block.lines) {
        line.startPos += pmDelta;
        line.endPos += pmDelta;
        line.docTop += heightDeltaPx;
        line.docBottom += heightDeltaPx;
      }
    }
    const updateMs = performance.now() - updateStart;
    const updateRectReads = rectStats.rectReads;
    const updateClientRectReads = rectStats.clientRectReads;
    const fullRebuildStart = performance.now();
    const fullRebuildBlocks = collectBlocks(state);
    const fullRebuildMs = performance.now() - fullRebuildStart;
    changedBlock.dom.style.fontSize = previousFontSize;
    void changedBlock.dom.offsetHeight;
    const restoredAfterUndo = true;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    table = collectBlocks(state);

    const scrollNative = await runScrollFramePath('native', 20);
    const scrollProto = await runScrollFramePath('proto', 20);

    const summary = (values: number[]): U3LineBoxPercentileSummary =>
      percentileSummaryLocal(values);
    const result: U3LineBoxPageResult = {
      environment: {
        docSize: view.state.doc.content.size,
        blockCount: table.length,
        lineCount,
        cellCount,
        scrollHeight: frame.scrollHeight,
        clientHeight: frame.clientHeight,
      },
      build: {
        ms: buildMs,
        rectReads: buildRectReads,
        clientRectReads: buildClientRectReads,
        nativeCoordsCalls: buildNativeCoordsCalls,
        frameScrollTop: frameState.scrollTop,
        currentScrollTop: frame.scrollTop,
      },
      coordsAtPos: {
        samples: coordsMaxDeltas.length,
        deltaPx: summary(coordsMaxDeltas),
        topDeltaPx: summary(coordsTopDeltas),
        bottomDeltaPx: summary(coordsBottomDeltas),
        leftDeltaPx: summary(coordsLeftDeltas),
        rightDeltaPx: summary(coordsRightDeltas),
        nativeMs: summary(nativeCoordQueryMs),
        protoMs: summary(protoCoordQueryMs),
      },
      posAtCoords: {
        samples: posNativeDeltas.length,
        posDelta: summary(posNativeDeltas),
        nativeMs: summary(nativePosQueryMs),
        protoMs: summary(protoPosQueryMs),
      },
      scroll: {
        frames: scrollNative.ms.length,
        native: {
          ms: summary(scrollNative.ms),
          rectReads: scrollNative.rectReads,
          clientRectReads: scrollNative.clientRectReads,
          queryRectReads: scrollNative.queryRectReads,
          queryClientRectReads: scrollNative.queryClientRectReads,
        },
        proto: {
          ms: summary(scrollProto.ms),
          rectReads: scrollProto.rectReads,
          clientRectReads: scrollProto.clientRectReads,
          queryRectReads: scrollProto.queryRectReads,
          queryClientRectReads: scrollProto.queryClientRectReads,
        },
      },
      incrementalUpdate: {
        insertedChars: 0,
        pmDelta,
        heightDeltaPx,
        updateMs,
        fullRebuildMs,
        rectReads: updateRectReads,
        clientRectReads: updateClientRectReads,
        nativeCoordsCalls: 0,
        restoredAfterUndo,
      },
      diagnostics: {
        coordsTopSamples: coordsTopDeltas,
        coordsBottomSamples: coordsBottomDeltas,
        coordsLeftSamples: coordsLeftDeltas,
        coordsRightSamples: coordsRightDeltas,
        posAtCoordsSamples: posNativeDeltas,
        nativeCoordQueryMs,
        protoCoordQueryMs,
        nativePosQueryMs,
        protoPosQueryMs,
        posAtCoordsDetails,
        tablePreview: table.slice(0, 200).map((block) => ({
          pmStart: block.pmStart,
          pmEnd: block.pmEnd,
          type: block.type,
          docTop: block.docTop,
          docBottom: block.docBottom,
          lineCount: block.lines.length,
        })),
        linePreview: table
          .slice(0, 5)
          .flatMap((block) =>
            block.lines.map((line) => ({
              blockType: block.type,
              lineStart: line.startPos,
              lineEnd: line.endPos,
              docTop: line.docTop,
              docBottom: line.docBottom,
              cellCount: line.cells.length,
              cellMinStart: line.cells.length > 0 ? Math.min(...line.cells.map((cell) => cell.startPos)) : null,
              cellMaxEnd: line.cells.length > 0 ? Math.max(...line.cells.map((cell) => cell.endPos)) : null,
            })),
          )
          .map((line) => ({
            ...line,
          })),
        partsPreview: table.slice(0, 6).map((block) => {
          const desc = findDescByStart(block.pmStart, block.type);
          return {
            blockType: block.type,
            blockStart: block.pmStart,
            blockEnd: block.pmEnd,
            parts: desc
              ? collectBlockParts(desc).map((part) => ({
                  partKind: part.kind,
                  partStart: part.startPos,
                  partEnd: part.endPos,
                  formula: part.kind === 'text' ? part.formula : false,
                  textLength: part.kind === 'text' ? (part.dom.nodeValue ?? '').length : 0,
                  domType: part.dom.nodeType,
                }))
              : [],
          };
        }),
        descPreview: table.slice(0, 6).map((block) => {
          const desc = findDescByStart(block.pmStart, block.type);
          return {
            blockType: block.type,
            blockStart: block.pmStart,
            blockEnd: block.pmEnd,
            children: (desc?.children ?? []).map((child) => ({
              childType: child.node?.type?.name ?? (child.dom?.nodeType === Node.TEXT_NODE ? 'textNode' : 'mark/wrapper'),
              childStart: child.posAtStart,
              childEnd: child.posAtEnd,
              childSize: child.posAtEnd - child.posAtStart,
              domType: child.dom?.nodeType ?? null,
              domTag:
                child.dom instanceof Element
                  ? child.dom.tagName.toLowerCase()
                  : child.dom?.nodeType === Node.TEXT_NODE
                    ? '#text'
                    : null,
            })),
          };
        }),
        lineBoxesPreview: table.slice(0, 6).map((block) => {
          const contentDOM = block.contentDOM ?? block.dom;
          const range = document.createRange();
          range.selectNodeContents(contentDOM);
          const rects = range.getClientRects();
          return {
            blockType: block.type,
            blockStart: block.pmStart,
            boxCount: rects.length,
            boxes: Array.from(rects)
              .filter((rect) => rect.width !== 0 || rect.height !== 0)
              .map((rect) => ({
                docTop: toDoc(rect.top, state.top, state.scrollTop),
                docBottom: toDoc(rect.bottom, state.top, state.scrollTop),
                docLeftStart: toDoc(rect.left, state.left, state.scrollLeft),
                docLeftEnd: toDoc(rect.right, state.left, state.scrollLeft),
              })),
          };
        }),
        scrollNativeMs: scrollNative.ms,
        scrollProtoMs: scrollProto.ms,
      },
    };
    return result;
  } finally {
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    Range.prototype.getClientRects = originalGetClientRects;
  }
}

export interface U3LineBoxRunOptions {
  markdownPath?: string;
  outDir?: string;
  profile?: string;
  port?: number;
  keepTempFiles?: boolean;
}

export async function runU3LineBoxPoCE2E(
  options: U3LineBoxRunOptions = {},
): Promise<U3LineBoxE2EResult> {
  let markdownPath = options.markdownPath;
  let generatedMarkdown = false;
  if (!markdownPath) {
    markdownPath = path.join(os.tmpdir(), `marivell-u3-line-box-small-${process.pid}.md`);
    fs.writeFileSync(markdownPath, generateSmallMarkdown(), 'utf8');
    generatedMarkdown = true;
  }
  const sourceBytes = fs.statSync(markdownPath).size;
  if (sourceBytes > 1_000_000 && process.env.MARIVELL_U3_ALLOW_LARGE !== '1') {
    throw new Error(
      'U3.1 line-box PoC is restricted to small files. Large-file runs must be executed alone by the main agent.',
    );
  }

  const outDir =
    options.outDir ?? path.join(os.tmpdir(), `marivell-u3-line-box-build-${process.pid}`);
  const profile =
    options.profile ?? path.join(os.tmpdir(), `marivell-u3-line-box-profile-${process.pid}`);
  const port = options.port ?? 10000 + (process.pid % 200);

  let handle: ElectronHandle | null = null;
  try {
    const buildStart = performance.now();
    await buildRenderer(outDir);
    const buildMs = performance.now() - buildStart;
    handle = await launchElectron(outDir, markdownPath, port, profile);
    const launchMs = Date.now() - handle.spawnedAt;
    const ready = await waitForVisualReady(
      handle.page,
      Math.min(Math.max(Math.floor(sourceBytes * 0.4), 500), 200_000),
      60_000,
    );
    if (ready.timedOut) {
      throw new Error(`visual editor did not become ready in time: ${ready.waitMs}ms`);
    }
    await handle.page.evaluate(() => {
      const benchmarkWindow = window as unknown as Record<string, unknown>;
      benchmarkWindow.__name = (fn: unknown): unknown => fn;
    });
    const page = await handle.page.evaluate(runU3LineBoxPoCInPage);
    return {
      markdownPath,
      sourceBytes,
      buildMs,
      launchMs,
      readyMs: ready.waitMs,
      page,
    };
  } finally {
    if (handle) {
      if (process.platform !== 'win32') {
        try {
          process.kill(-handle.child.pid, 'SIGKILL');
        } catch {
          // Process group may already be gone.
        }
      }
      handle.child.kill('SIGKILL');
      await handle.browser.close().catch(() => {});
    }
    if (!options.keepTempFiles) {
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
        fs.rmSync(profile, { recursive: true, force: true });
        if (generatedMarkdown && markdownPath) {
          fs.rmSync(markdownPath, { force: true });
        }
      } catch {
        // Cleanup is best-effort.
      }
    }
  }
}

function formatSummary(result: U3LineBoxE2EResult): Record<string, unknown> {
  return {
    markdownPath: result.markdownPath,
    sourceBytes: result.sourceBytes,
    buildMs: Math.round(result.buildMs * 10) / 10,
    launchMs: Math.round(result.launchMs * 10) / 10,
    readyMs: Math.round(result.readyMs * 10) / 10,
    environment: result.page.environment,
    build: result.page.build,
    coordsAtPos: {
      samples: result.page.coordsAtPos.samples,
      deltaTopPx: result.page.coordsAtPos.deltaPx,
      nativeMs: result.page.coordsAtPos.nativeMs,
      protoMs: result.page.coordsAtPos.protoMs,
    },
    posAtCoords: result.page.posAtCoords,
    scroll: result.page.scroll,
    incrementalUpdate: result.page.incrementalUpdate,
  };
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const markdownPath = arg && arg !== '--small' ? path.resolve(arg) : undefined;
  const result = await runU3LineBoxPoCE2E({ markdownPath });
  const rawPath = path.join(os.tmpdir(), `marivell-u3-line-box-poc-${Date.now()}.json`);
  fs.writeFileSync(rawPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(formatSummary(result), null, 2));
  console.log(`\nSaved raw U3.1 line-box PoC JSON to ${rawPath}`);
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

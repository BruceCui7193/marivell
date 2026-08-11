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

export interface U3PercentileSummary {
  count: number;
  min: number;
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

export interface U3PageResult {
  environment: {
    docSize: number;
    blockCount: number;
    lineCount: number;
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
    deltaPx: U3PercentileSummary;
    topDeltaPx: U3PercentileSummary;
    bottomDeltaPx: U3PercentileSummary;
    leftDeltaPx: U3PercentileSummary;
    rightDeltaPx: U3PercentileSummary;
    nativeMs: U3PercentileSummary;
    protoMs: U3PercentileSummary;
  };
  posAtCoords: {
    samples: number;
    posDelta: U3PercentileSummary;
    queryToProtoYDeltaPx: U3PercentileSummary;
    nativeMs: U3PercentileSummary;
    protoMs: U3PercentileSummary;
  };
  scroll: {
    frames: number;
    native: {
      ms: U3PercentileSummary;
      rectReads: number;
      clientRectReads: number;
      queryRectReads: number;
      queryClientRectReads: number;
    };
    proto: {
      ms: U3PercentileSummary;
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
      blockPmStart: number | null;
      blockType: string | null;
      matchedBlocks: Array<{ pmStart: number; type: string; docTop: number; docBottom: number }>;
      lineStart: number | null;
      lineEnd: number | null;
      lineTop: number | null;
      lineBottom: number | null;
    }>;
    tablePreview: Array<{
      pmStart: number;
      pmEnd: number;
      type: string;
      docTop: number;
      docBottom: number;
      lineCount: number;
    }>;
    tablePreviewAtMeasurement: Array<{
      pmStart: number;
      pmEnd: number;
      type: string;
      docTop: number;
      docBottom: number;
      lineCount: number;
      firstLineStart: number;
      firstLineEnd: number;
    }>;
    linesPreviewAtMeasurement: Array<{
      pmStart: number;
      type: string;
      lines: Array<{ startPos: number; endPos: number; docTop: number; docBottom: number }>;
    }>;
    blockDebug: Array<{
      pmStart: number;
      pmEnd: number;
      type: string;
      frameScrollTop: number;
      stateScrollTop: number;
      frameTop: number;
      domClassName: string;
      domText: string;
      domRectTop: number;
      domRectBottom: number;
      linesPreview: Array<{
        startPos: number;
        endPos: number;
        docTop: number;
        docBottom: number;
      }>;
      sampleCoords: Array<{ offset: number; top: number; bottom: number; left: number }>;
    }>;
    buildBlockDebug: Array<{
      pmStart: number;
      pmEnd: number;
      type: string;
      buildScrollTop: number;
      domRectTop: number;
      coordsStartTop: number;
      coordsStartBottom: number;
    }>;
    scrollNativeMs: number[];
    scrollProtoMs: number[];
  };
}

export interface U3E2EResult {
  markdownPath: string;
  sourceBytes: number;
  buildMs: number;
  launchMs: number;
  readyMs: number;
  page: U3PageResult;
}

interface ElectronHandle {
  child: ReturnType<typeof spawn>;
  browser: Browser;
  page: Page;
  port: number;
  spawnedAt: number;
}

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
        const editor = window.__marivellEditor as
          | { state?: { doc?: { nodeSize?: number } } }
          | undefined;
        const nodeReady = Boolean(editor?.state?.doc && editor.state.doc.nodeSize > expectedSize);
        const textReady = Boolean(surface && surface.innerText.length > Math.min(expectedSize, 10_000));
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

function percentileSummary(values: number[]): U3PercentileSummary {
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

export async function runU3PoCInPage(): Promise<U3PageResult> {
  const benchmarkWindow = window as unknown as Record<string, unknown>;
  const editor = benchmarkWindow.__marivellEditor as {
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
  } | null;
  if (!editor?.view?.state?.doc) {
    throw new Error('benchmark editor not exposed');
  }
  const frame = document.querySelector<HTMLElement>('.editor-frame');
  if (!frame) {
    throw new Error('editor frame missing');
  }

  const percentileSummary = (values: number[]): U3PercentileSummary => {
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

  const rectStats = {
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
    const frameState = {
      top: frameRect.top,
      left: frameRect.left,
      scrollTop: frame.scrollTop,
      scrollLeft: frame.scrollLeft,
    };

    interface LineRecord {
      startPos: number;
      endPos: number;
      docTop: number;
      docBottom: number;
      docLeftStart: number;
      docLeftEnd: number;
      height: number;
    }
    interface BlockRecord {
      pmStart: number;
      pmEnd: number;
      type: string;
      depth: number;
      dom: HTMLElement;
      docTop: number;
      docBottom: number;
      height: number;
      lines: LineRecord[];
    }

    const isVisibleBlockNode = (node: {
      isBlock: boolean;
      isTextblock: boolean;
      isLeaf: boolean;
      type: { name: string };
    }): boolean => {
      if (!node.isBlock) return false;
      if (node.isTextblock) return true;
      if (node.isLeaf) return true;
      return ['image', 'mathBlock', 'mermaid', 'htmlBlock'].includes(node.type.name);
    };

    const buildBlockFromDesc = (
      desc: {
        node: {
          isTextblock: boolean;
          isLeaf: boolean;
          type: { name: string };
          content: { size: number };
        };
        posAtStart: number;
        posAtEnd: number;
        dom: Element;
        contentDOM: Element | null;
        children: unknown[];
      },
      depth: number,
    ): BlockRecord => {
      const domElement =
        desc.dom instanceof HTMLElement
          ? desc.dom
          : desc.contentDOM instanceof HTMLElement
            ? desc.contentDOM
            : (desc.dom as HTMLElement | null);
      if (!domElement) {
        throw new Error(`block has no DOM element: ${desc.node.type.name}`);
      }
      const pmStart = desc.posAtStart;
      const pmEnd = desc.posAtEnd;
      const lines: LineRecord[] = [];
      if (desc.node.isTextblock && !desc.node.isLeaf) {
        const contentLength = desc.node.content.size;
        let current: LineRecord | null = null;
        for (let offset = 0; offset <= contentLength; offset += 1) {
          const pos = pmStart + offset;
          nativeCoordsCallCount += 1;
          const coords = view.coordsAtPos(pos);
          if (!coords || coords.top === 0 && coords.bottom === 0) {
            continue;
          }
          const docTop = coords.top - frameState.top + frameState.scrollTop;
          if (!current || Math.abs(docTop - current.docTop) > 0.5) {
            if (current) {
              current.endPos = pos;
            }
            current = {
              startPos: pos,
              endPos: pos + 1,
              docTop,
              docBottom: coords.bottom - frameState.top + frameState.scrollTop,
              docLeftStart: coords.left - frameState.left + frameState.scrollLeft,
              docLeftEnd: coords.right - frameState.left + frameState.scrollLeft,
              height: coords.bottom - coords.top,
            };
            lines.push(current);
          } else if (current) {
            current.endPos = pos + 1;
            current.docBottom = coords.bottom - frameState.top + frameState.scrollTop;
            current.docLeftEnd = coords.right - frameState.left + frameState.scrollLeft;
            current.height = Math.max(current.height, coords.bottom - coords.top);
          }
        }
        if (current) {
          current.endPos = pmEnd;
        }
      }
      if (lines.length === 0) {
        const rect = domElement.getBoundingClientRect();
        lines.push({
          startPos: pmStart,
          endPos: pmEnd,
          docTop: rect.top - frameState.top + frameState.scrollTop,
          docBottom: rect.bottom - frameState.top + frameState.scrollTop,
          docLeftStart: rect.left - frameState.left + frameState.scrollLeft,
          docLeftEnd: rect.right - frameState.left + frameState.scrollLeft,
          height: rect.height,
        });
      }
      const docTop = Math.min(...lines.map((line) => line.docTop));
      const docBottom = Math.max(...lines.map((line) => line.docBottom));
      return {
        pmStart,
        pmEnd,
        type: desc.node.type.name,
        depth,
        dom: domElement,
        docTop,
        docBottom,
        height: docBottom - docTop,
        lines,
      };
    };

    const collectedBuildBlockDebug: Array<{
      pmStart: number;
      pmEnd: number;
      type: string;
      buildScrollTop: number;
      domRectTop: number;
      coordsStartTop: number;
      coordsStartBottom: number;
    }> = [];
    let nativeCoordsCallCount = 0;
    const collectBlocks = (): BlockRecord[] => {
      const blocks: BlockRecord[] = [];
      const walk = (
        desc: {
          node?: {
            isBlock: boolean;
            isTextblock: boolean;
            isLeaf: boolean;
            type: { name: string };
            content: { size: number };
          } | null;
          posAtStart: number;
          posAtEnd: number;
          dom: Element;
          contentDOM: Element | null;
          children?: unknown[];
        } | null,
        depth: number,
      ): void => {
        if (!desc) return;
        if (desc.node && isVisibleBlockNode(desc.node)) {
          const block = buildBlockFromDesc(
            desc as {
              node: {
                isTextblock: boolean;
                isLeaf: boolean;
                type: { name: string };
                content: { size: number };
              };
              posAtStart: number;
              posAtEnd: number;
              dom: Element;
              contentDOM: Element | null;
              children: unknown[];
            },
            depth,
          );
          blocks.push(block);
          if (blocks.length <= 2) {
            const startCoords = view.coordsAtPos(block.pmStart);
            collectedBuildBlockDebug.push({
              pmStart: block.pmStart,
              pmEnd: block.pmEnd,
              type: block.type,
              buildScrollTop: frame.scrollTop,
              domRectTop: block.dom.getBoundingClientRect().top,
              coordsStartTop: startCoords?.top ?? 0,
              coordsStartBottom: startCoords?.bottom ?? 0,
            });
          }
        }
        for (const child of (desc.children ?? []) as unknown[]) {
          walk(child as Parameters<typeof walk>[0], depth + 1);
        }
      };
      walk(view.docView as Parameters<typeof walk>[0], 0);
      blocks.sort((a, b) => a.pmStart - b.pmStart || a.pmEnd - b.pmEnd);
      return blocks;
    };

    const rectStatsSnapshot = (): { rectReads: number; clientRectReads: number } => ({
      rectReads: rectStats.rectReads,
      clientRectReads: rectStats.clientRectReads,
    });

    rectStats.rectReads = 0;
    rectStats.clientRectReads = 0;
    const buildStart = performance.now();
    const table = collectBlocks();
    const buildMs = performance.now() - buildStart;
    const buildRectReads = rectStats.rectReads;
    const buildClientRectReads = rectStats.clientRectReads;
    const buildNativeCoordsCalls = nativeCoordsCallCount;

    const lineCount = table.reduce((sum, block) => sum + block.lines.length, 0);
    if (table.length < 4 || lineCount < 8) {
      throw new Error(`offset table too small: blocks=${table.length} lines=${lineCount}`);
    }

    const findDescByStart = (
      start: number,
      type: string,
    ): {
      node: {
        isTextblock: boolean;
        isLeaf: boolean;
        type: { name: string };
        content: { size: number };
      };
      posAtStart: number;
      posAtEnd: number;
      dom: Element;
      contentDOM: Element | null;
      children: unknown[];
    } | null => {
      let found: ReturnType<typeof findDescByStart> = null;
      const walk = (
        desc: {
          node?: {
            isBlock: boolean;
            isTextblock: boolean;
            isLeaf: boolean;
            type: { name: string };
            content: { size: number };
          } | null;
          posAtStart: number;
          posAtEnd: number;
          dom: Element;
          contentDOM: Element | null;
          children?: unknown[];
        } | null,
      ): void => {
        if (!desc) return;
        if (desc.node && desc.posAtStart === start && desc.node.type.name === type) {
          found = desc as ReturnType<typeof findDescByStart>;
        }
        for (const child of (desc.children ?? []) as unknown[]) {
          walk(child as Parameters<typeof walk>[0]);
        }
      };
      walk(view.docView as Parameters<typeof walk>[0]);
      return found;
    };

    const getFrameState = (): {
      top: number;
      left: number;
      scrollTop: number;
      scrollLeft: number;
    } => {
      const rect = frame.getBoundingClientRect();
      return {
        top: rect.top,
        left: rect.left,
        scrollTop: frame.scrollTop,
        scrollLeft: frame.scrollLeft,
      };
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
      let lo = 0;
      let hi = block.lines.length - 1;
      let best: LineRecord | null = null;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const line = block.lines[mid];
        if (!line) break;
        if (line.startPos <= pos) {
          best = line;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return best && pos <= best.endPos ? best : null;
    };

    const protoCoordsAtPos = (
      pos: number,
      state: { top: number; left: number; scrollTop: number; scrollLeft: number },
    ): { top: number; bottom: number; left: number; right: number } | null => {
      const block = findBlockAtPos(pos);
      if (!block) return null;
      const line = findLineAtPos(block, pos) ?? block.lines[block.lines.length - 1];
      if (!line) return null;
      const span = Math.max(line.endPos - line.startPos, 1);
      const ratio = Math.max(0, Math.min(1, (pos - line.startPos) / span));
      const left = state.left + line.docLeftStart + ratio * (line.docLeftEnd - line.docLeftStart) - state.scrollLeft;
      return {
        top: state.top + line.docTop - state.scrollTop,
        bottom: state.top + line.docBottom - state.scrollTop,
        left,
        right: left,
      };
    };

    const findBlockAtDocY = (docY: number): BlockRecord | null => {
      let best: BlockRecord | null = null;
      let bestDistance = Infinity;
      for (const block of table) {
        if (docY >= block.docTop && docY <= block.docBottom) {
          best = block;
          bestDistance = 0;
          continue;
        }
        const distance = docY < block.docTop
          ? block.docTop - docY
          : docY - block.docBottom;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = block;
        }
      }
      return best;
    };

    const findLineAtDocY = (block: BlockRecord, docY: number): LineRecord | null => {
      let best: LineRecord | null = null;
      let bestDistance = Infinity;
      for (const line of block.lines) {
        if (docY >= line.docTop && docY <= line.docBottom) {
          best = line;
          bestDistance = 0;
          continue;
        }
        const distance = docY < line.docTop
          ? line.docTop - docY
          : docY - line.docBottom;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = line;
        }
      }
      return best;
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
        const distance = docY < block.docTop
          ? block.docTop - docY
          : docY - block.docBottom;
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
        const distance = docY < line.docTop
          ? line.docTop - docY
          : docY - line.docBottom;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = line;
          relation = docY < line.docTop ? 'before' : 'after';
        }
      }
      return { line: best, relation };
    };

    const protoPosAtCoords = (
      left: number,
      top: number,
      state: { top: number; left: number; scrollTop: number; scrollLeft: number },
    ): { pos: number } | null => {
      const docY = top - state.top + state.scrollTop;
      const docX = left - state.left + state.scrollLeft;
      const blockInfo = findBlockAtDocYWithRelation(docY);
      const block = blockInfo.block;
      if (!block) return null;
      if (blockInfo.relation !== 'inside') {
        const blockIndex = table.indexOf(block);
        const previous = blockIndex > 0 ? table[blockIndex - 1] : null;
        const next = blockIndex >= 0 && blockIndex < table.length - 1 ? table[blockIndex + 1] : null;
        if (blockInfo.relation === 'before' && previous) {
          return { pos: previous.pmEnd };
        }
        if (blockInfo.relation === 'after' && next) {
          return { pos: next.pmStart };
        }
        return { pos: blockInfo.relation === 'before' ? block.pmStart : block.pmEnd };
      }
      const lineInfo = findLineAtDocYWithRelation(block, docY);
      const line = lineInfo.line;
      if (!line) return null;
      if (lineInfo.relation !== 'inside') {
        const lineIndex = block.lines.indexOf(line);
        const previousLine = lineIndex > 0 ? block.lines[lineIndex - 1] : null;
        const nextLine = lineIndex >= 0 && lineIndex < block.lines.length - 1 ? block.lines[lineIndex + 1] : null;
        if (lineInfo.relation === 'before' && previousLine) {
          return { pos: previousLine.endPos };
        }
        if (lineInfo.relation === 'after' && nextLine) {
          return { pos: nextLine.startPos };
        }
        return { pos: lineInfo.relation === 'before' ? line.startPos : line.endPos };
      }
      const span = Math.max(line.endPos - line.startPos, 1);
      const lineWidth = Math.max(line.docLeftEnd - line.docLeftStart, 1);
      const ratio = Math.max(0, Math.min(1, (docX - line.docLeftStart) / lineWidth));
      return { pos: Math.round(line.startPos + ratio * span) };
    };

    const state = getFrameState();
    const tablePreviewAtMeasurement = table.map((block) => ({
      pmStart: block.pmStart,
      pmEnd: block.pmEnd,
      type: block.type,
      docTop: block.docTop,
      docBottom: block.docBottom,
      lineCount: block.lines.length,
      firstLineStart: block.lines[0]?.startPos ?? null,
      firstLineEnd: block.lines[0]?.endPos ?? null,
    }));
    const linesPreviewAtMeasurement = table.slice(0, 4).map((block) => ({
      pmStart: block.pmStart,
      type: block.type,
      lines: block.lines.map((line) => ({
        startPos: line.startPos,
        endPos: line.endPos,
        docTop: line.docTop,
        docBottom: line.docBottom,
      })),
    }));
    const samplePositions: number[] = [];
    for (const block of table) {
      if (block.lines.length === 0) continue;
      for (const line of block.lines) {
        samplePositions.push(line.startPos);
        samplePositions.push(Math.floor((line.startPos + line.endPos) / 2));
        samplePositions.push(line.endPos);
      }
    }
    const uniquePositions = Array.from(new Set(samplePositions)).slice(0, 240);

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
    const coordQueryPositions = uniquePositions.slice(0, 80);
    for (let round = 0; round < 3; round += 1) {
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
    const queryToProtoYDeltaPx: number[] = [];
    const posAtCoordsDetails: Array<{
      queryX: number;
      queryY: number;
      nativePos: number;
      protoPos: number;
      protoDocY: number;
      blockPmStart: number | null;
      blockType: string | null;
      matchedBlocks: Array<{ pmStart: number; type: string; docTop: number; docBottom: number }>;
      lineStart: number | null;
      lineEnd: number | null;
      lineTop: number | null;
      lineBottom: number | null;
    }> = [];
    for (let y = frameRectForGrid.top + 4; y < frameRectForGrid.bottom - 4; y += gridStep) {
      for (const xRatio of [0.1, 0.5, 0.9]) {
        const left = frameRectForGrid.left + frameRectForGrid.width * xRatio;
        const native = view.posAtCoords({ left, top: y });
        if (!native) continue;
        const proto = protoPosAtCoords(left, y, state);
        if (!proto) continue;
        const protoDocY = y - state.top + state.scrollTop;
        const protoBlock = findBlockAtDocY(protoDocY);
        const protoLine = protoBlock ? findLineAtDocY(protoBlock, protoDocY) : null;
        posAtCoordsDetails.push({
          queryX: left,
          queryY: y,
          nativePos: native.pos,
          protoPos: proto.pos,
          protoDocY,
          blockPmStart: protoBlock?.pmStart ?? null,
          blockType: protoBlock?.type ?? null,
          matchedBlocks: table
            .filter((candidate) => protoDocY >= candidate.docTop && protoDocY <= candidate.docBottom)
            .slice(0, 5)
            .map((candidate) => ({
              pmStart: candidate.pmStart,
              type: candidate.type,
              docTop: candidate.docTop,
              docBottom: candidate.docBottom,
            })),
          lineStart: protoLine?.startPos ?? null,
          lineEnd: protoLine?.endPos ?? null,
          lineTop: protoLine?.docTop ?? null,
          lineBottom: protoLine?.docBottom ?? null,
        });
        posNativeDeltas.push(Math.abs(native.pos - proto.pos));
        const protoCoords = view.coordsAtPos(proto.pos);
        if (protoCoords) {
          queryToProtoYDeltaPx.push(Math.abs((protoCoords.top + protoCoords.bottom) / 2 - y));
        }
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
    for (let round = 0; round < 3; round += 1) {
      for (const point of posQueryGrid.slice(0, 60)) {
        const nativeStart = performance.now();
        view.posAtCoords({ left: point.left, top: point.top });
        nativePosQueryMs.push(performance.now() - nativeStart);
        const protoStart = performance.now();
        protoPosAtCoords(point.left, point.top, state);
        protoPosQueryMs.push(performance.now() - protoStart);
      }
    }

    const runScrollFramePath = async (mode: 'native' | 'proto', frames: number): Promise<{
      ms: number[];
      rectReads: number;
      clientRectReads: number;
      queryRectReads: number;
      queryClientRectReads: number;
    }> => {
      const ms: number[] = [];
      const baseState = getFrameState();
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
          const pointLeft = baseState.left + frame.clientWidth * 0.5;
          const pointTop = baseState.top + frame.clientHeight * 0.5;
          const currentState = {
            top: baseState.top,
            left: baseState.left,
            scrollTop: frame.scrollTop,
            scrollLeft: frame.scrollLeft,
          };
          if (mode === 'native') {
            const beforeRect = rectStats.rectReads;
            const beforeClientRect = rectStats.clientRectReads;
            view.posAtCoords({ left: pointLeft, top: pointTop });
            view.coordsAtPos(view.posAtCoords({ left: pointLeft, top: pointTop })?.pos ?? 0);
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
    const rebuiltChangedBlock = buildBlockFromDesc(changedDesc, changedBlock.depth);
    const pmDelta = 0;
    const heightDeltaPx = rebuiltChangedBlock.height - changedBlock.height;
    const originalChangedBlock = table[changedIndex];
    if (!originalChangedBlock) {
      throw new Error('changed block missing from offset table');
    }
    originalChangedBlock.pmEnd = rebuiltChangedBlock.pmEnd;
    originalChangedBlock.docTop = rebuiltChangedBlock.docTop;
    originalChangedBlock.docBottom = rebuiltChangedBlock.docBottom;
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
    collectBlocks();
    const fullRebuildMs = performance.now() - fullRebuildStart;
    changedBlock.dom.style.fontSize = previousFontSize;
    void changedBlock.dom.offsetHeight;
    const restoredAfterUndo = true;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    table.length = 0;
    table.push(...collectBlocks());

    const scrollNative = await runScrollFramePath('native', 20);
    const scrollProto = await runScrollFramePath('proto', 20);

    const summary: U3PercentileSummary = (values: number[]) => percentileSummary(values);
    const result: U3PageResult = {
      environment: {
        docSize: view.state.doc.content.size,
        blockCount: table.length,
        lineCount,
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
        deltaPx: {
          count: coordsMaxDeltas.length,
          min: Math.min(...coordsMaxDeltas, 0),
          avg: coordsMaxDeltas.reduce((sum, value) => sum + value, 0) / Math.max(coordsMaxDeltas.length, 1),
          p50: summary(coordsMaxDeltas).p50,
          p95: summary(coordsMaxDeltas).p95,
          max: Math.max(...coordsMaxDeltas, 0),
        },
        topDeltaPx: percentileSummary(coordsTopDeltas),
        bottomDeltaPx: percentileSummary(coordsBottomDeltas),
        leftDeltaPx: percentileSummary(coordsLeftDeltas),
        rightDeltaPx: percentileSummary(coordsRightDeltas),
        nativeMs: percentileSummary(nativeCoordQueryMs),
        protoMs: percentileSummary(protoCoordQueryMs),
      },
      posAtCoords: {
        samples: posNativeDeltas.length,
        posDelta: percentileSummary(posNativeDeltas),
        queryToProtoYDeltaPx: percentileSummary(queryToProtoYDeltaPx),
        nativeMs: percentileSummary(nativePosQueryMs),
        protoMs: percentileSummary(protoPosQueryMs),
      },
      scroll: {
        frames: scrollNative.ms.length,
        native: {
          ms: percentileSummary(scrollNative.ms),
          rectReads: scrollNative.rectReads,
          clientRectReads: scrollNative.clientRectReads,
          queryRectReads: scrollNative.queryRectReads,
          queryClientRectReads: scrollNative.queryClientRectReads,
        },
        proto: {
          ms: percentileSummary(scrollProto.ms),
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
        tablePreviewAtMeasurement,
        linesPreviewAtMeasurement,
        blockDebug: table.slice(0, 2).map((block) => ({
          pmStart: block.pmStart,
          pmEnd: block.pmEnd,
          type: block.type,
          frameScrollTop: frame.scrollTop,
          stateScrollTop: state.scrollTop,
          frameTop: state.top,
          domClassName: block.dom.className,
          domText: block.dom.textContent?.slice(0, 40) ?? '',
          domRectTop: block.dom.getBoundingClientRect().top,
          domRectBottom: block.dom.getBoundingClientRect().bottom,
          linesPreview: block.lines.map((line) => ({
            startPos: line.startPos,
            endPos: line.endPos,
            docTop: line.docTop,
            docBottom: line.docBottom,
          })),
          sampleCoords: Array.from({ length: Math.min(12, block.pmEnd - block.pmStart + 1) }, (_, index) => {
            const coords = view.coordsAtPos(block.pmStart + index);
            return {
              offset: index,
              top: coords?.top ?? 0,
              bottom: coords?.bottom ?? 0,
              left: coords?.left ?? 0,
            };
          }),
        })),
        buildBlockDebug: collectedBuildBlockDebug,
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

export interface U3RunOptions {
  markdownPath?: string;
  outDir?: string;
  profile?: string;
  port?: number;
  keepTempFiles?: boolean;
}

export async function runU3PocE2E(options: U3RunOptions = {}): Promise<U3E2EResult> {
  let markdownPath = options.markdownPath;
  let generatedMarkdown = false;
  if (!markdownPath) {
    markdownPath = path.join(os.tmpdir(), `marivell-u3-small-${process.pid}.md`);
    fs.writeFileSync(markdownPath, generateSmallMarkdown(), 'utf8');
    generatedMarkdown = true;
  }
  const sourceBytes = fs.statSync(markdownPath).size;
  if (sourceBytes > 1_000_000 && process.env.MARIVELL_U3_ALLOW_LARGE !== '1') {
    throw new Error(
      'U3.0 parallel PoC is restricted to small files. Large-file runs must be executed alone by the main agent.',
    );
  }

  const outDir =
    options.outDir ?? path.join(os.tmpdir(), `marivell-u3-poc-build-${process.pid}`);
  const profile =
    options.profile ?? path.join(os.tmpdir(), `marivell-u3-poc-profile-${process.pid}`);
  const port = options.port ?? 9800 + (process.pid % 200);

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
    const page = await handle.page.evaluate(runU3PoCInPage);
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

function formatSummary(result: U3E2EResult): Record<string, unknown> {
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
  const result = await runU3PocE2E({ markdownPath });
  const rawPath = path.join(os.tmpdir(), `marivell-u3-poc-${Date.now()}.json`);
  fs.writeFileSync(rawPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(formatSummary(result), null, 2));
  console.log(`\nSaved raw U3 PoC JSON to ${rawPath}`);
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

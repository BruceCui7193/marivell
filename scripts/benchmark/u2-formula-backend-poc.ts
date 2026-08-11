import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { PNG } from 'pngjs';
import { parseMarkdown, parseMarkdownFragment, serializeMarkdown } from '../../src/renderer/editor/markdown.ts';
import {
  collectFormulaIndex,
  renderFormulaChunk,
} from '../../src/renderer/editor/markdown.worker.ts';
import { findSourceSearchMatches } from '../../src/renderer/editor/search.ts';
import { markdownToExportHtmlFragment } from '../../src/main/export/markdown-to-html.ts';
import {
  createSingleNodeExportPayload,
  findSingleNodeFormulaByLatex,
  restoreSingleNodeFormulaHtml,
  serializeSingleNodeFormula,
  type SingleNodeFormulaCandidate,
} from '../../src/renderer/editor/virtualization/formula-single-node.ts';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const electronBin = path.join(projectRoot, 'node_modules/.bin/electron');
const electronViteBin = path.join(projectRoot, 'node_modules/.bin/electron-vite');
const defaultSourceMarkdown = '/home/crh/下载/barfoot_ser24/barfoot_ser24.md';

export interface U2Percentile {
  count: number;
  min: number;
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

export interface FormulaCorpusEntry {
  key: string;
  latex: string;
  display: 'yes' | 'no';
  html: string;
  htmlBytes: number;
}

export interface FormulaCorpus {
  sourceBytes: number;
  totalUnique: number;
  selected: number;
  inline: number;
  block: number;
  quartileCounts: number[];
  sample: FormulaCorpusEntry[];
}

export type U2CandidateKind =
  | 'katex-html'
  | 'canvas-raster'
  | 'bitmap-data-url'
  | 'svg-viewbox';

export interface U2CandidateStat {
  rootNodeCount: number;
  subtreeNodeCount: number;
  serializedBytes: number;
  decodedPngBytes: number;
}

export interface U2FormulaStat {
  key: string;
  latex: string;
  display: 'yes' | 'no';
  htmlBytes: number;
  htmlNodeCount: number;
  candidates: Record<U2CandidateKind, U2CandidateStat>;
  baseline: {
    bottomDeltaPx: number;
    centerDeltaPx: number;
    lineBottomDeltaPx: number;
  };
  highFormula: {
    overflowTopPx: number;
    overflowBottomPx: number;
    overflowLeftPx: number;
    overflowRightPx: number;
    previewHeightPx: number;
    contentHeightPx: number;
  };
  dpr: {
    dpr1CssWidth: number;
    dpr1CssHeight: number;
    dpr15Width: number;
    dpr15Height: number;
    dpr2Width: number;
    dpr2Height: number;
    dpr1VsDpr2MeanAbsDiff: number;
    dpr1VsDpr2DiffRatio: number;
    dpr15VsDpr2MeanAbsDiff: number;
    clarityRatio: number;
  };
  pixelDiff: Record<
    'canvas-raster' | 'bitmap-data-url' | 'svg-viewbox',
    { meanAbsDiff: number; diffRatio: number }
  >;
}

export interface U2InjectionKindResult {
  kind: U2CandidateKind;
  samples: number;
  ms: U2Percentile;
  heapDelta: U2Percentile;
}

export interface U2PageResult {
  environment: {
    userAgent: string;
    title: string;
    viewport: { width: number; height: number };
    corpus: {
      selected: number;
      inline: number;
      block: number;
      quartileCounts: number[];
    };
  };
  dom: {
    katexHtmlNodeCount: U2Percentile;
    candidateSubtreeNodeCount: Record<U2CandidateKind, U2Percentile>;
    katexHtmlBytes: U2Percentile;
    candidateSerializedBytes: Record<U2CandidateKind, U2Percentile>;
  };
  injection: Record<U2CandidateKind, U2InjectionKindResult>;
  baseline: {
    samples: number;
    bottomDeltaPx: U2Percentile;
    centerDeltaPx: U2Percentile;
    lineBottomDeltaPx: U2Percentile;
  };
  highFormula: {
    total: number;
    overflowCount: number;
    candidateCropCovered: boolean;
    overflowTopMaxPx: number;
    overflowBottomMaxPx: number;
    overflowLeftMaxPx: number;
    overflowRightMaxPx: number;
  };
  dpr: {
    samples: number;
    dpr2Scale: U2Percentile;
    dpr15Scale: U2Percentile;
    dpr1VsDpr2MeanAbsDiff: U2Percentile;
    dpr1VsDpr2DiffRatio: U2Percentile;
    dpr15VsDpr2MeanAbsDiff: U2Percentile;
    clarityRatio: U2Percentile;
  };
  pixelDiff: Record<
    'canvas-raster' | 'bitmap-data-url' | 'svg-viewbox',
    { samples: number; meanAbsDiff: U2Percentile; diffRatio: U2Percentile }
  >;
  memory: {
    apiAvailable: boolean;
    usedBeforeHarness: number | null;
    usedAfterImages: number | null;
    usedAfterInjection: number | null;
    usedAfterCleanup: number | null;
    imageDelta: number | null;
    injectionDelta: number | null;
    cleanupDelta: number | null;
  };
  capabilities: {
    serializedSamples: Array<{ key: string; latex: string; source: string }>;
    search: {
      query: string;
      matchCount: number;
      firstMatchStart: number | null;
      firstMatchEnd: number | null;
    };
    restore: {
      katexPresent: boolean;
      restoredNodeCount: number;
    };
    export: {
      key: string;
      dataUrlPresent: boolean;
      htmlPresent: boolean;
      width: number | null;
      height: number | null;
    };
    editorCopy: {
      attempted: boolean;
      plainText: string;
      latexPreserved: boolean;
    };
    editorSearch: {
      attempted: boolean;
      docText: string;
      found: boolean;
    };
  };
  formulaStats: U2FormulaStat[];
}

export interface U2E2EResult {
  sourceMarkdown: string;
  corpus: FormulaCorpus;
  buildMs: number;
  launchMs: number;
  readyMs: number;
  page: U2PageResult;
  nodeCapabilities: {
    serializedSource: string;
    searchMatchCount: number;
    restoreHasHtml: boolean;
    exportDataUrlPresent: boolean;
    exportHtmlHasKatex: boolean;
    sourceSearchMatchCount: number;
    markdownRoundTripOk: boolean;
  };
}

interface ElectronHandle {
  child: ReturnType<typeof spawn>;
  browser: Browser;
  page: Page;
  port: number;
  spawnedAt: number;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PreparedFormula {
  index: number;
  key: string;
  latex: string;
  display: 'yes' | 'no';
  html: string;
  htmlBytes: number;
  htmlNodeCount: number;
  cell: Rect;
  preview: Rect;
  content: Rect;
  overflow: {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
}

interface PreparedHostResult {
  formulas: PreparedFormula[];
  screenshotHostRemoved: boolean;
}

interface U2FormulaBenchmarkInput {
  formulas: Array<{
    index: number;
    key: string;
    latex: string;
    display: 'yes' | 'no';
    html: string;
    htmlBytes: number;
    htmlNodeCount: number;
    cssWidth: number;
    cssHeight: number;
    pngDpr1: string;
    pngDpr15: string;
    pngDpr2: string;
    svgDpr2: string;
    decodedPngBytes: number;
    svgBytes: number;
    cropCovered: boolean;
    overflow: {
      top: number;
      bottom: number;
      left: number;
      right: number;
      previewHeight: number;
      contentHeight: number;
    };
  }>;
  warmupRounds: number;
  measurementRounds: number;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentileSummary(values: number[]): U2Percentile {
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

function buildFormulaCorpus(
  sourceMarkdownPath: string,
  selectedCount: number,
): FormulaCorpus & { formulaHtml: string[] } {
  const sourceBytes = fs.statSync(sourceMarkdownPath).size;
  const markdown = fs.readFileSync(sourceMarkdownPath, 'utf8');
  const entries = collectFormulaIndex(parseMarkdown(markdown));
  const rendered = renderFormulaChunk(entries);
  const sized = entries
    .map((entry) => ({
      entry,
      html: rendered[entry.key] ?? '',
      htmlBytes: Buffer.byteLength(rendered[entry.key] ?? '', 'utf8'),
    }))
    .filter((item) => item.htmlBytes > 0);

  const pickFromBucket = (
    bucket: Array<typeof sized[number]>,
    needed: number,
  ): Array<typeof sized[number]> => {
    if (bucket.length === 0) {
      return [];
    }
    const result: Array<typeof sized[number]> = [];
    const step = bucket.length / needed;
    for (let index = 0; index < needed; index += 1) {
      const picked = bucket[Math.min(bucket.length - 1, Math.floor(index * step))];
      if (picked) {
        result.push(picked);
      }
    }
    return result;
  };

  const selectedByDisplay: Array<typeof sized[number]> = [];
  const quartileCounts: number[] = [0, 0, 0, 0];
  for (const display of ['no', 'yes'] as const) {
    const byDisplay = sized
      .filter((item) => item.entry.display === display)
      .sort((a, b) => a.htmlBytes - b.htmlBytes);
    const perDisplay = Math.ceil(selectedCount / 2);
    const bucketSize = Math.max(1, Math.ceil(byDisplay.length / 4));
    for (let quartile = 0; quartile < 4; quartile += 1) {
      const start = quartile * bucketSize;
      const bucket = byDisplay.slice(start, start + bucketSize);
      const needed = Math.ceil(perDisplay / 4);
      const picked = pickFromBucket(bucket, needed);
      selectedByDisplay.push(...picked);
      quartileCounts[quartile] += picked.length;
    }
  }

  const selected = selectedByDisplay.slice(0, selectedCount);
  const unique = new Set(selected.map((item) => item.entry.key));
  if (selected.length !== selectedCount || unique.size !== selected.length) {
    throw new Error(
      `formula corpus selection failed: selected=${selected.length} unique=${unique.size}`,
    );
  }

  return {
    sourceBytes,
    totalUnique: sized.length,
    selected: selected.length,
    inline: selected.filter((item) => item.entry.display === 'no').length,
    block: selected.filter((item) => item.entry.display === 'yes').length,
    quartileCounts,
    sample: selected.map((item) => ({
      key: item.entry.key,
      latex: item.entry.latex,
      display: item.entry.display,
      html: item.html,
      htmlBytes: item.htmlBytes,
    })),
    formulaHtml: selected.map((item) => item.html),
  };
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
      '--enable-precise-memory-info',
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

function cropPng(buffer: Buffer, cell: Rect, content: Rect, scale: number): Buffer {
  const png = PNG.sync.read(buffer);
  const ratio = scale > 0 ? scale : png.width / Math.max(cell.width, 1);
  const margin = 2;
  const cropLeft = Math.max(0, Math.floor((content.left - cell.left - margin) * ratio));
  const cropTop = Math.max(0, Math.floor((content.top - cell.top - margin) * ratio));
  const cropWidth = Math.max(
    1,
    Math.min(png.width - cropLeft, Math.ceil((content.width + margin * 2) * ratio)),
  );
  const cropHeight = Math.max(
    1,
    Math.min(png.height - cropTop, Math.ceil((content.height + margin * 2) * ratio)),
  );
  const cropped = new PNG({ width: cropWidth, height: cropHeight });
  for (let y = 0; y < cropHeight; y += 1) {
    for (let x = 0; x < cropWidth; x += 1) {
      const sourceX = Math.min(png.width - 1, cropLeft + x);
      const sourceY = Math.min(png.height - 1, cropTop + y);
      const sourceOffset = (sourceY * png.width + sourceX) * 4;
      const targetOffset = (y * cropWidth + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        cropped.data[targetOffset + channel] = png.data[sourceOffset + channel] ?? 0;
      }
    }
  }
  return PNG.sync.write(cropped);
}

function dataUrlFromPng(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

function svgViewBoxDataUrl(pngDataUrl: string, width: number, height: number): string {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}"><image href="${pngDataUrl}" x="0" y="0" width="${safeWidth}" height="${safeHeight}"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

async function prepareFormulaScreenshotHost(
  input: Array<Pick<FormulaCorpusEntry, 'key' | 'latex' | 'display' | 'html' | 'htmlBytes'>>,
): Promise<PreparedHostResult> {
  const benchmarkWindow = window as unknown as Record<string, unknown>;
  const captureContentWidth = 2200;
  const host = document.createElement('div');
  host.id = 'u2-formula-screenshot-host';
  host.style.cssText =
    'position:absolute;left:0;top:0;width:2400px;z-index:2147483647;background:#fff;pointer-events:none;';
  const cells = new Map<number, HTMLElement>();

  const showCell = (index: number): void => {
    for (const cell of cells.values()) {
      cell.style.display = 'none';
    }
    const cell = cells.get(index);
    if (cell) {
      cell.style.display = 'inline-block';
    }
  };

  try {
    document.body.appendChild(host);
    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
    const formulas: PreparedFormula[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const meta = input[index];
      if (!meta) {
        continue;
      }
      const cell = document.createElement('div');
      cell.className = 'u2-katex-cell';
      cell.dataset.u2Index = String(index);
      cell.style.cssText =
        'display:inline-block;vertical-align:top;padding:32px;background:#fff;overflow:visible;';
      const preview = document.createElement(meta.display === 'yes' ? 'div' : 'span');
      preview.className =
        meta.display === 'yes'
          ? 'math-block-node math-node-wrapper'
          : 'math-inline-node math-node-wrapper';
      preview.style.setProperty('contain', 'none');
      preview.style.setProperty('content-visibility', 'visible');
      const previewContent = document.createElement('span');
      previewContent.className = 'math-node-preview';
      previewContent.innerHTML = meta.html;
      preview.appendChild(previewContent);
      cell.appendChild(preview);
      host.appendChild(cell);
      cells.set(index, cell);
      showCell(index);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );

      const cellRect = cell.getBoundingClientRect();
      const previewRect = preview.getBoundingClientRect();
      let contentLeft = Infinity;
      let contentTop = Infinity;
      let contentRight = -Infinity;
      let contentBottom = -Infinity;
      const walk = (element: Element): void => {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          contentLeft = Math.min(contentLeft, rect.left);
          contentTop = Math.min(contentTop, rect.top);
          contentRight = Math.max(contentRight, rect.right);
          contentBottom = Math.max(contentBottom, rect.bottom);
        }
        for (let childIndex = 0; childIndex < element.children.length; childIndex += 1) {
          const child = element.children[childIndex];
          if (child) {
            walk(child);
          }
        }
      };
      walk(preview);
      const safeLeft = Number.isFinite(contentLeft) ? contentLeft : previewRect.left;
      const safeTop = Number.isFinite(contentTop) ? contentTop : previewRect.top;
      const safeRight = Number.isFinite(contentRight) ? contentRight : previewRect.right;
      const safeBottom = Number.isFinite(contentBottom) ? contentBottom : previewRect.bottom;
      const rawContentWidth = Math.max(1, safeRight - safeLeft);
      const rawContentHeight = Math.max(1, safeBottom - safeTop);
      const renderScale = Math.min(1, captureContentWidth / rawContentWidth);
      const targetLeft = cellRect.left + 8;
      const targetTop = cellRect.top + 8;
      const previewOriginLeft = previewRect.left;
      const previewOriginTop = previewRect.top;
      const offsetX =
        targetLeft - previewOriginLeft - (safeLeft - previewOriginLeft) * renderScale;
      const offsetY =
        targetTop - previewOriginTop - (safeTop - previewOriginTop) * renderScale;
      preview.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${renderScale})`;
      preview.style.transformOrigin = '0 0';
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const scaledCellRect = cell.getBoundingClientRect();
      const scaledPreviewRect = preview.getBoundingClientRect();
      let scaledLeft = Infinity;
      let scaledTop = Infinity;
      let scaledRight = -Infinity;
      let scaledBottom = -Infinity;
      const scaledWalk = (element: Element): void => {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          scaledLeft = Math.min(scaledLeft, rect.left);
          scaledTop = Math.min(scaledTop, rect.top);
          scaledRight = Math.max(scaledRight, rect.right);
          scaledBottom = Math.max(scaledBottom, rect.bottom);
        }
        for (let childIndex = 0; childIndex < element.children.length; childIndex += 1) {
          const child = element.children[childIndex];
          if (child) {
            scaledWalk(child);
          }
        }
      };
      scaledWalk(preview);
      const scaledSafeLeft = Number.isFinite(scaledLeft) ? scaledLeft : scaledPreviewRect.left;
      const scaledSafeTop = Number.isFinite(scaledTop) ? scaledTop : scaledPreviewRect.top;
      const scaledSafeRight = Number.isFinite(scaledRight) ? scaledRight : scaledPreviewRect.right;
      const scaledSafeBottom = Number.isFinite(scaledBottom) ? scaledBottom : scaledPreviewRect.bottom;
      const scaledContentWidth = Math.max(1, scaledSafeRight - scaledSafeLeft);
      const scaledContentHeight = Math.max(1, scaledSafeBottom - scaledSafeTop);
      cell.style.width = `${Math.ceil(scaledContentWidth + 16)}px`;
      cell.style.height = `${Math.ceil(scaledContentHeight + 16)}px`;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const sizedCellRect = cell.getBoundingClientRect();
      let nodeCount = 1;
      const walker = document.createTreeWalker(preview, NodeFilter.SHOW_ALL);
      while (walker.nextNode()) {
        nodeCount += 1;
      }
      formulas.push({
        index,
        key: meta.key,
        latex: meta.latex,
        display: meta.display,
        html: meta.html,
        htmlBytes: meta.htmlBytes,
        htmlNodeCount: nodeCount,
        cell: {
          left: sizedCellRect.left,
          top: sizedCellRect.top,
          width: sizedCellRect.width,
          height: sizedCellRect.height,
        },
        preview: {
          left: scaledPreviewRect.left,
          top: scaledPreviewRect.top,
          width: scaledPreviewRect.width,
          height: scaledPreviewRect.height,
        },
        content: {
          left: scaledSafeLeft,
          top: scaledSafeTop,
          width: scaledSafeRight - scaledSafeLeft,
          height: scaledSafeBottom - scaledSafeTop,
        },
        overflow: {
          top: Math.max(0, scaledPreviewRect.top - scaledSafeTop),
          bottom: Math.max(0, scaledSafeBottom - scaledPreviewRect.bottom),
          left: Math.max(0, scaledPreviewRect.left - scaledSafeLeft),
          right: Math.max(0, scaledSafeRight - scaledPreviewRect.right),
        },
      });
    }
    showCell(-1);
    benchmarkWindow.__u2FormulaScreenshotHost = host;
    benchmarkWindow.__u2FormulaScreenshotCells = cells;
    return { formulas, screenshotHostRemoved: !host.isConnected };
  } catch (error) {
    host.remove();
    throw error;
  }
}

async function showFormulaScreenshotCell(page: Page, index: number): Promise<void> {
  await page.evaluate(({ targetIndex }) => {
    const benchmarkWindow = window as unknown as {
      __u2FormulaScreenshotCells?: Map<number, HTMLElement>;
    };
    const cells = benchmarkWindow.__u2FormulaScreenshotCells;
    if (!cells) {
      return;
    }
    for (const cell of cells.values()) {
      cell.style.display = 'none';
    }
    const target = cells.get(targetIndex);
    if (target) {
      target.style.display = 'inline-block';
      void target.offsetWidth;
    }
  }, { targetIndex: index });
}

async function cleanupFormulaScreenshotHost(page: Page): Promise<void> {
  await page.evaluate(() => {
    const benchmarkWindow = window as unknown as {
      __u2FormulaScreenshotHost?: HTMLElement;
      __u2FormulaScreenshotCells?: Map<number, HTMLElement>;
    };
    benchmarkWindow.__u2FormulaScreenshotHost?.remove();
    benchmarkWindow.__u2FormulaScreenshotHost = undefined;
    benchmarkWindow.__u2FormulaScreenshotCells = undefined;
  });
}

export async function runU2FormulaBenchmarkInPage(
  input: U2FormulaBenchmarkInput,
): Promise<U2PageResult> {
  const benchmarkWindow = window as unknown as Record<string, unknown>;
  const memory = (
    performance as Performance & { memory?: { usedJSHeapSize: number } }
  ).memory;
  const usedBeforeHarness = memory?.usedJSHeapSize ?? null;
  const host = document.createElement('div');
  host.id = 'u2-formula-benchmark-host';
  host.style.cssText =
    'position:absolute;left:0;top:0;width:2400px;z-index:2147483646;opacity:0.001;pointer-events:none;';
  document.body.appendChild(host);

  const percentile = (values: number[]): U2Percentile => {
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

  const loadImage = (src: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`failed to load image: ${src.slice(0, 32)}`));
      image.src = src;
    });

  const imageMaps = {
    dpr1: new Map<number, HTMLImageElement>(),
    dpr15: new Map<number, HTMLImageElement>(),
    dpr2: new Map<number, HTMLImageElement>(),
    svg: new Map<number, HTMLImageElement>(),
  };
  for (let start = 0; start < input.formulas.length; start += 16) {
    const chunk = input.formulas.slice(start, start + 16);
    await Promise.all(
      chunk.flatMap((formula) => [
        loadImage(formula.pngDpr1).then((image) => imageMaps.dpr1.set(formula.index, image)),
        loadImage(formula.pngDpr15).then((image) => imageMaps.dpr15.set(formula.index, image)),
        loadImage(formula.pngDpr2).then((image) => imageMaps.dpr2.set(formula.index, image)),
        loadImage(formula.svgDpr2).then((image) => imageMaps.svg.set(formula.index, image)),
      ]),
    );
  }
  const usedAfterImages = memory?.usedJSHeapSize ?? null;

  const countSubtreeNodes = (element: Element): number => {
    let count = 1;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ALL);
    while (walker.nextNode()) {
      count += 1;
    }
    return count;
  };

  const setFormulaAttrs = (element: HTMLElement, formula: U2FormulaBenchmarkInput['formulas'][number]): void => {
    element.dataset.u2Latex = formula.latex;
    element.dataset.u2Display = formula.display;
    element.dataset.u2KatexHtml = formula.html;
    element.dataset.u2ExportDpr2 = formula.pngDpr2;
    element.dataset.u2ExportSvg = formula.svgDpr2;
    element.setAttribute('role', 'img');
    element.setAttribute('aria-label', `LaTeX: ${formula.latex}`);
  };

  const createKatexElement = (formula: U2FormulaBenchmarkInput['formulas'][number]): HTMLElement => {
    const preview = document.createElement('span');
    preview.className = 'math-node-preview';
    preview.innerHTML = formula.html;
    return preview;
  };

  const createCandidateElement = (
    kind: Exclude<U2CandidateKind, 'katex-html'>,
    formula: U2FormulaBenchmarkInput['formulas'][number],
  ): HTMLElement => {
    if (kind === 'canvas-raster') {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(formula.cssWidth * 2));
      canvas.height = Math.max(1, Math.round(formula.cssHeight * 2));
      const context = canvas.getContext('2d');
      const image = imageMaps.dpr2.get(formula.index);
      if (context && image) {
        context.imageSmoothingEnabled = true;
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
      }
      canvas.style.width = `${formula.cssWidth}px`;
      canvas.style.height = `${formula.cssHeight}px`;
      setFormulaAttrs(canvas, formula);
      return canvas;
    }

    const image = document.createElement('img');
    image.alt = '';
    image.width = Math.max(1, Math.round(formula.cssWidth));
    image.height = Math.max(1, Math.round(formula.cssHeight));
    image.src = kind === 'svg-viewbox' ? formula.svgDpr2 : formula.pngDpr2;
    image.style.width = `${formula.cssWidth}px`;
    image.style.height = `${formula.cssHeight}px`;
    setFormulaAttrs(image, formula);
    return image;
  };

  const injectionResults = {} as Record<U2CandidateKind, U2InjectionKindResult>;
  const injectionKinds: U2CandidateKind[] = [
    'katex-html',
    'canvas-raster',
    'bitmap-data-url',
    'svg-viewbox',
  ];
  for (const kind of injectionKinds) {
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:0;top:0;';
    host.appendChild(container);
    for (let warm = 0; warm < input.warmupRounds; warm += 1) {
      container.replaceChildren();
      for (const formula of input.formulas) {
        const element =
          kind === 'katex-html'
            ? createKatexElement(formula)
            : createCandidateElement(kind, formula);
        container.appendChild(element);
      }
    }

    const times: number[] = [];
    const heapDeltas: number[] = [];
    for (const formula of input.formulas) {
      for (let sample = 0; sample < input.measurementRounds; sample += 1) {
        container.replaceChildren();
        const heapBefore = memory?.usedJSHeapSize ?? 0;
        const start = performance.now();
        const element =
          kind === 'katex-html'
            ? createKatexElement(formula)
            : createCandidateElement(kind, formula);
        container.appendChild(element);
        const end = performance.now();
        const heapAfter = memory?.usedJSHeapSize ?? 0;
        times.push(end - start);
        heapDeltas.push(heapAfter - heapBefore);
      }
    }
    container.remove();
    injectionResults[kind] = {
      kind,
      samples: times.length,
      ms: percentile(times),
      heapDelta: percentile(heapDeltas),
    };
  }
  const usedAfterInjection = memory?.usedJSHeapSize ?? null;

  const formulaStats: U2FormulaStat[] = [];
  const katexNodeCounts: number[] = [];
  const candidateNodeCounts = {
    'katex-html': [] as number[],
    'canvas-raster': [] as number[],
    'bitmap-data-url': [] as number[],
    'svg-viewbox': [] as number[],
  };
  const candidateBytes = {
    'katex-html': [] as number[],
    'canvas-raster': [] as number[],
    'bitmap-data-url': [] as number[],
    'svg-viewbox': [] as number[],
  };
  const baselineBottomDeltas: number[] = [];
  const baselineCenterDeltas: number[] = [];
  const baselineLineBottomDeltas: number[] = [];
  const dpr2Scales: number[] = [];
  const dpr15Scales: number[] = [];
  const dpr1VsDpr2MeanAbsDiffs: number[] = [];
  const dpr1VsDpr2DiffRatios: number[] = [];
  const dpr15VsDpr2MeanAbsDiffs: number[] = [];
  const clarityRatios: number[] = [];
  const pixelDiffResults = {
    'canvas-raster': { samples: 0, meanAbsDiff: [] as number[], diffRatio: [] as number[] },
    'bitmap-data-url': { samples: 0, meanAbsDiff: [] as number[], diffRatio: [] as number[] },
    'svg-viewbox': { samples: 0, meanAbsDiff: [] as number[], diffRatio: [] as number[] },
  };
  const highFormulaCounts = {
    total: input.formulas.length,
    overflow: 0,
    overflowTopMax: 0,
    overflowBottomMax: 0,
    overflowLeftMax: 0,
    overflowRightMax: 0,
    candidateCropCovered: input.formulas.every((formula) => formula.cropCovered),
  };

  const measureBaselineLine = (
    display: 'yes' | 'no',
    createElement: () => HTMLElement,
  ): { formulaRect: DOMRect; lineRect: DOMRect } => {
    const line = document.createElement('div');
    line.style.cssText =
      'position:absolute;left:0;top:0;font-family:serif;font-size:16px;line-height:1.6;white-space:nowrap;background:#fff;color:#000;opacity:0.001;pointer-events:none;';
    line.innerHTML =
      '<span class="u2-before">Ag</span><span class="u2-host"></span><span class="u2-after">Ag</span>';
    const hostSlot = line.querySelector<HTMLElement>('.u2-host');
    if (!hostSlot) {
      throw new Error('baseline host slot missing');
    }
    if (display === 'yes') {
      hostSlot.style.display = 'block';
      hostSlot.style.textAlign = 'center';
      line.style.whiteSpace = 'normal';
    }
    const formulaElement = createElement();
    hostSlot.appendChild(formulaElement);
    host.appendChild(line);
    const formulaRect = formulaElement.getBoundingClientRect();
    const lineRect = line.getBoundingClientRect();
    line.remove();
    return { formulaRect, lineRect };
  };

  const drawScaled = (
    canvas: HTMLCanvasElement,
    image: CanvasImageSource,
    cssWidth: number,
    cssHeight: number,
    dpr: number,
  ): void => {
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    const context = canvas.getContext('2d');
    if (context) {
      context.imageSmoothingEnabled = true;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
    }
  };

  const diffImageData = (
    left: ImageData,
    right: ImageData,
  ): { meanAbsDiff: number; diffRatio: number } => {
    const length = Math.min(left.data.length, right.data.length);
    let total = 0;
    let changed = 0;
    for (let index = 0; index < length; index += 4) {
      const dr = Math.abs((left.data[index] ?? 0) - (right.data[index] ?? 0));
      const dg = Math.abs((left.data[index + 1] ?? 0) - (right.data[index + 1] ?? 0));
      const db = Math.abs((left.data[index + 2] ?? 0) - (right.data[index + 2] ?? 0));
      const da = Math.abs((left.data[index + 3] ?? 0) - (right.data[index + 3] ?? 0));
      const value = (dr + dg + db + da) / 4;
      total += value;
      if (value > 8) {
        changed += 1;
      }
    }
    const pixels = Math.max(1, length / 4);
    return {
      meanAbsDiff: total / pixels,
      diffRatio: changed / pixels,
    };
  };

  const edgeEnergy = (data: Uint8ClampedArray, width: number, height: number): number => {
    const gray = new Float64Array(width * height);
    for (let index = 0; index < gray.length; index += 1) {
      const offset = index * 4;
      const r = data[offset] ?? 0;
      const g = data[offset + 1] ?? 0;
      const b = data[offset + 2] ?? 0;
      gray[index] = r * 0.299 + g * 0.587 + b * 0.114;
    }
    let energy = 0;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        const gx =
          (gray[index - width - 1] ?? 0) +
          2 * (gray[index - 1] ?? 0) +
          (gray[index + width - 1] ?? 0) -
          ((gray[index - width + 1] ?? 0) +
            2 * (gray[index + 1] ?? 0) +
            (gray[index + width + 1] ?? 0));
        const gy =
          (gray[index - width - 1] ?? 0) +
          2 * (gray[index - width] ?? 0) +
          (gray[index - width + 1] ?? 0) -
          ((gray[index + width - 1] ?? 0) +
            2 * (gray[index + width] ?? 0) +
            (gray[index + width + 1] ?? 0));
        energy += Math.hypot(gx, gy);
      }
    }
    return energy;
  };

  const candidateKindWithoutKatex: Array<'canvas-raster' | 'bitmap-data-url' | 'svg-viewbox'> = [
    'canvas-raster',
    'bitmap-data-url',
    'svg-viewbox',
  ];

  for (const formula of input.formulas) {
    const katexElement = createKatexElement(formula);
    const katexNodes = countSubtreeNodes(katexElement);
    katexNodeCounts.push(katexNodes);

    const candidates: Record<U2CandidateKind, U2CandidateStat> = {
      'katex-html': {
        rootNodeCount: 1,
        subtreeNodeCount: katexNodes,
        serializedBytes: formula.htmlBytes,
        decodedPngBytes: 0,
      },
      'canvas-raster': {
        rootNodeCount: 1,
        subtreeNodeCount: 1,
        serializedBytes: formula.svgBytes,
        decodedPngBytes: formula.decodedPngBytes,
      },
      'bitmap-data-url': {
        rootNodeCount: 1,
        subtreeNodeCount: 1,
        serializedBytes: formula.pngDpr2.length,
        decodedPngBytes: formula.decodedPngBytes,
      },
      'svg-viewbox': {
        rootNodeCount: 1,
        subtreeNodeCount: 1,
        serializedBytes: formula.svgBytes,
        decodedPngBytes: formula.decodedPngBytes,
      },
    };
    for (const kind of candidateKindWithoutKatex) {
      const element = createCandidateElement(kind, formula);
      const nodes = countSubtreeNodes(element);
      candidates[kind].subtreeNodeCount = nodes;
      candidateNodeCounts[kind].push(nodes);
      candidateBytes[kind].push(
        kind === 'bitmap-data-url' ? formula.pngDpr2.length : formula.svgBytes,
      );
    }
    candidateNodeCounts['katex-html'].push(katexNodes);
    candidateBytes['katex-html'].push(formula.htmlBytes);

    const katexLine = measureBaselineLine(formula.display, () => {
      const element = createKatexElement(formula);
      return element;
    });
    const candidateDeltas = candidateKindWithoutKatex.map((kind) => {
      const candidateLine = measureBaselineLine(formula.display, () =>
        createCandidateElement(kind, formula),
      );
      return {
        bottom: candidateLine.formulaRect.bottom - katexLine.formulaRect.bottom,
        center:
          (candidateLine.formulaRect.top + candidateLine.formulaRect.bottom) / 2 -
          (katexLine.formulaRect.top + katexLine.formulaRect.bottom) / 2,
        lineBottom: candidateLine.formulaRect.bottom - candidateLine.lineRect.bottom,
      };
    });
    const baseline = candidateDeltas.reduce(
      (result, delta) => ({
        bottom: Math.max(result.bottom, Math.abs(delta.bottom)),
        center: Math.max(result.center, Math.abs(delta.center)),
        lineBottom: Math.max(result.lineBottom, Math.abs(delta.lineBottom)),
      }),
      { bottom: 0, center: 0, lineBottom: 0 },
    );
    baselineBottomDeltas.push(baseline.bottom);
    baselineCenterDeltas.push(baseline.center);
    baselineLineBottomDeltas.push(baseline.lineBottom);

    const dpr1Image = imageMaps.dpr1.get(formula.index);
    const dpr15Image = imageMaps.dpr15.get(formula.index);
    const dpr2Image = imageMaps.dpr2.get(formula.index);
    const dpr1Canvas = document.createElement('canvas');
    const dpr2DownCanvas = document.createElement('canvas');
    const dpr15Canvas = document.createElement('canvas');
    const dpr2Down15Canvas = document.createElement('canvas');
    if (dpr1Image && dpr2Image) {
      drawScaled(dpr1Canvas, dpr1Image, formula.cssWidth, formula.cssHeight, 1);
      drawScaled(dpr2DownCanvas, dpr2Image, formula.cssWidth, formula.cssHeight, 1);
      const leftData = dpr1Canvas.getContext('2d')?.getImageData(0, 0, dpr1Canvas.width, dpr1Canvas.height);
      const rightData = dpr2DownCanvas.getContext('2d')?.getImageData(
        0,
        0,
        dpr2DownCanvas.width,
        dpr2DownCanvas.height,
      );
      if (leftData && rightData) {
        const diff = diffImageData(leftData, rightData);
        dpr1VsDpr2MeanAbsDiffs.push(diff.meanAbsDiff);
        dpr1VsDpr2DiffRatios.push(diff.diffRatio);
        const leftEnergy = edgeEnergy(leftData.data, leftData.width, leftData.height);
        const rightEnergy = edgeEnergy(rightData.data, rightData.width, rightData.height);
        clarityRatios.push(rightEnergy / Math.max(leftEnergy, 1));
      }
    }
    if (dpr15Image && dpr2Image) {
      drawScaled(dpr15Canvas, dpr15Image, formula.cssWidth, formula.cssHeight, 1.5);
      drawScaled(dpr2Down15Canvas, dpr2Image, formula.cssWidth, formula.cssHeight, 1.5);
      const leftData = dpr15Canvas.getContext('2d')?.getImageData(0, 0, dpr15Canvas.width, dpr15Canvas.height);
      const rightData = dpr2Down15Canvas.getContext('2d')?.getImageData(
        0,
        0,
        dpr2Down15Canvas.width,
        dpr2Down15Canvas.height,
      );
      if (leftData && rightData) {
        dpr15VsDpr2MeanAbsDiffs.push(diffImageData(leftData, rightData).meanAbsDiff);
      }
    }
    if (dpr1Image && dpr15Image && dpr2Image) {
      dpr2Scales.push(dpr2Image.naturalWidth / Math.max(formula.cssWidth, 1));
      dpr15Scales.push(dpr15Image.naturalWidth / Math.max(formula.cssWidth, 1));
    }

    const sourceCanvas = document.createElement('canvas');
    drawScaled(sourceCanvas, dpr2Image ?? dpr1Image ?? document.createElement('canvas'), formula.cssWidth, formula.cssHeight, 2);
    const sourceData = sourceCanvas.getContext('2d')?.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
    for (const kind of candidateKindWithoutKatex) {
      let candidateData: ImageData | null = null;
      const element = createCandidateElement(kind, formula);
      if (kind === 'canvas-raster') {
        const canvas = element as HTMLCanvasElement;
        candidateData = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height) ?? null;
      } else {
        const candidateCanvas = document.createElement('canvas');
        const image =
          kind === 'svg-viewbox'
            ? imageMaps.svg.get(formula.index) ?? null
            : imageMaps.dpr2.get(formula.index) ?? null;
        if (image) {
          drawScaled(candidateCanvas, image, formula.cssWidth, formula.cssHeight, 2);
          candidateData = candidateCanvas.getContext('2d')?.getImageData(
            0,
            0,
            candidateCanvas.width,
            candidateCanvas.height,
          );
        }
      }
      if (sourceData && candidateData) {
        const diff = diffImageData(sourceData, candidateData);
        pixelDiffResults[kind].meanAbsDiff.push(diff.meanAbsDiff);
        pixelDiffResults[kind].diffRatio.push(diff.diffRatio);
        pixelDiffResults[kind].samples += 1;
      }
    }

    const overflow = formula.overflow;
    highFormulaCounts.overflowTopMax = Math.max(highFormulaCounts.overflowTopMax, overflow.top);
    highFormulaCounts.overflowBottomMax = Math.max(
      highFormulaCounts.overflowBottomMax,
      overflow.bottom,
    );
    highFormulaCounts.overflowLeftMax = Math.max(highFormulaCounts.overflowLeftMax, overflow.left);
    highFormulaCounts.overflowRightMax = Math.max(
      highFormulaCounts.overflowRightMax,
      overflow.right,
    );
    if (
      overflow.top > 0.5 ||
      overflow.bottom > 0.5 ||
      overflow.left > 0.5 ||
      overflow.right > 0.5
    ) {
      highFormulaCounts.overflow += 1;
    }

    formulaStats.push({
      key: formula.key,
      latex: formula.latex,
      display: formula.display,
      htmlBytes: formula.htmlBytes,
      htmlNodeCount: katexNodes,
      candidates,
      baseline,
      highFormula: {
        overflowTopPx: overflow.top,
        overflowBottomPx: overflow.bottom,
        overflowLeftPx: overflow.left,
        overflowRightPx: overflow.right,
        previewHeightPx: overflow.previewHeight,
        contentHeightPx: overflow.contentHeight,
      },
      dpr: {
        dpr1CssWidth: formula.cssWidth,
        dpr1CssHeight: formula.cssHeight,
        dpr15Width: dpr15Image?.naturalWidth ?? 0,
        dpr15Height: dpr15Image?.naturalHeight ?? 0,
        dpr2Width: dpr2Image?.naturalWidth ?? 0,
        dpr2Height: dpr2Image?.naturalHeight ?? 0,
        dpr1VsDpr2MeanAbsDiff: dpr1VsDpr2MeanAbsDiffs[dpr1VsDpr2MeanAbsDiffs.length - 1] ?? 0,
        dpr1VsDpr2DiffRatio: dpr1VsDpr2DiffRatios[dpr1VsDpr2DiffRatios.length - 1] ?? 0,
        dpr15VsDpr2MeanAbsDiff:
          dpr15VsDpr2MeanAbsDiffs[dpr15VsDpr2MeanAbsDiffs.length - 1] ?? 0,
        clarityRatio: clarityRatios[clarityRatios.length - 1] ?? 0,
      },
      pixelDiff: {
        'canvas-raster': {
          meanAbsDiff: pixelDiffResults['canvas-raster'].meanAbsDiff[
            pixelDiffResults['canvas-raster'].meanAbsDiff.length - 1
          ] ?? 0,
          diffRatio: pixelDiffResults['canvas-raster'].diffRatio[
            pixelDiffResults['canvas-raster'].diffRatio.length - 1
          ] ?? 0,
        },
        'bitmap-data-url': {
          meanAbsDiff: pixelDiffResults['bitmap-data-url'].meanAbsDiff[
            pixelDiffResults['bitmap-data-url'].meanAbsDiff.length - 1
          ] ?? 0,
          diffRatio: pixelDiffResults['bitmap-data-url'].diffRatio[
            pixelDiffResults['bitmap-data-url'].diffRatio.length - 1
          ] ?? 0,
        },
        'svg-viewbox': {
          meanAbsDiff: pixelDiffResults['svg-viewbox'].meanAbsDiff[
            pixelDiffResults['svg-viewbox'].meanAbsDiff.length - 1
          ] ?? 0,
          diffRatio: pixelDiffResults['svg-viewbox'].diffRatio[
            pixelDiffResults['svg-viewbox'].diffRatio.length - 1
          ] ?? 0,
        },
      },
    });
  }

  const capabilityFormulas = input.formulas.slice(0, 30);
  const serializedSamples = capabilityFormulas.map((formula) => ({
    key: formula.key,
    latex: formula.latex,
    source:
      formula.display === 'yes'
        ? `$$\n${formula.latex}\n$$`
        : `$${formula.latex}$`,
  }));
  const searchableSource = serializedSamples
    .map((sample) => sample.source)
    .join('\n');
  const searchFormula =
    capabilityFormulas.find((formula) => formula.latex.includes('x')) ??
    capabilityFormulas.find((formula) => formula.latex.includes('1')) ??
    capabilityFormulas[0];
  const searchQuery = searchFormula?.latex.slice(0, Math.min(searchFormula.latex.length, 48)) ?? '';
  const normalizedSearch = searchQuery.toLocaleLowerCase();
  let searchMatchCount = 0;
  let firstMatchStart: number | null = null;
  let firstMatchEnd: number | null = null;
  if (searchQuery) {
    const haystack = searchableSource.toLocaleLowerCase();
    let cursor = 0;
    while (cursor <= haystack.length - normalizedSearch.length) {
      const start = haystack.indexOf(normalizedSearch, cursor);
      if (start === -1) {
        break;
      }
      searchMatchCount += 1;
      if (firstMatchStart === null) {
        firstMatchStart = start;
        firstMatchEnd = start + searchQuery.length;
      }
      cursor = start + Math.max(searchQuery.length, 1);
    }
  }

  const restoreSample = capabilityFormulas[0];
  const restoreCandidate = document.createElement('span');
  restoreCandidate.className = 'math-node-preview';
  restoreCandidate.innerHTML = restoreSample?.html ?? '';
  const restoredNodeCount = countSubtreeNodes(restoreCandidate);
  const restoreResult = {
    katexPresent: restoreCandidate.querySelector('.katex') !== null,
    restoredNodeCount,
  };

  const exportSample = capabilityFormulas[0];
  const exportResult = {
    key: exportSample?.key ?? '',
    dataUrlPresent: Boolean(exportSample?.pngDpr2),
    htmlPresent: Boolean(exportSample?.html),
    width: exportSample?.cssWidth ?? null,
    height: exportSample?.cssHeight ?? null,
  };

  let editorCopy = { attempted: false, plainText: '', latexPreserved: false };
  let editorSearch = { attempted: false, docText: '', found: false };
  const editor = (benchmarkWindow as {
    __marivellEditor?: {
      commands: {
        setContent: (content: unknown, emitUpdate?: boolean) => boolean;
        selectAll: () => boolean;
      };
      view: {
        dom: HTMLElement;
        state: { doc: { content: { size: number } } };
      };
      state: { doc: { textBetween: (from: number, to: number) => string } };
    };
  }).__marivellEditor;
  if (editor) {
    try {
      editor.commands.setContent(
        {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'inlineMath',
                  attrs: { display: 'no', openDelim: '$', closeDelim: '$' },
                  content: [{ type: 'text', text: 'x+y' }],
                },
              ],
            },
          ],
        },
        false,
      );
      editor.commands.selectAll();
      const dataTransfer = new DataTransfer();
      const copyEvent = new ClipboardEvent('copy', {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true,
      });
      editor.view.dom.dispatchEvent(copyEvent);
      const plainText = copyEvent.clipboardData?.getData('text/plain') ?? '';
      editorCopy = {
        attempted: true,
        plainText,
        latexPreserved: plainText.includes('$') && plainText.includes('x+y'),
      };
    } catch {
      editorCopy = { attempted: true, plainText: '', latexPreserved: false };
    }

    try {
      editor.commands.setContent(
        {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'inlineMath',
                  attrs: { display: 'no' },
                  content: [{ type: 'text', text: 'u2SearchTokenAlpha' }],
                },
              ],
            },
          ],
        },
        false,
      );
      const docText = editor.state.doc.textBetween(0, editor.view.state.doc.content.size);
      editorSearch = {
        attempted: true,
        docText,
        found: docText.includes('u2SearchTokenAlpha'),
      };
    } catch {
      editorSearch = { attempted: true, docText: '', found: false };
    }
  }

  host.remove();
  const usedAfterCleanup = memory?.usedJSHeapSize ?? null;

  return {
    environment: {
      userAgent: navigator.userAgent,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      corpus: {
        selected: input.formulas.length,
        inline: input.formulas.filter((formula) => formula.display === 'no').length,
        block: input.formulas.filter((formula) => formula.display === 'yes').length,
        quartileCounts: [],
      },
    },
    dom: {
      katexHtmlNodeCount: percentile(katexNodeCounts),
      candidateSubtreeNodeCount: {
        'katex-html': percentile(candidateNodeCounts['katex-html']),
        'canvas-raster': percentile(candidateNodeCounts['canvas-raster']),
        'bitmap-data-url': percentile(candidateNodeCounts['bitmap-data-url']),
        'svg-viewbox': percentile(candidateNodeCounts['svg-viewbox']),
      },
      katexHtmlBytes: percentile(input.formulas.map((formula) => formula.htmlBytes)),
      candidateSerializedBytes: {
        'katex-html': percentile(input.formulas.map((formula) => formula.htmlBytes)),
        'canvas-raster': percentile(input.formulas.map((formula) => formula.svgBytes)),
        'bitmap-data-url': percentile(input.formulas.map((formula) => formula.pngDpr2.length)),
        'svg-viewbox': percentile(input.formulas.map((formula) => formula.svgBytes)),
      },
    },
    injection: injectionResults,
    baseline: {
      samples: baselineBottomDeltas.length,
      bottomDeltaPx: percentile(baselineBottomDeltas),
      centerDeltaPx: percentile(baselineCenterDeltas),
      lineBottomDeltaPx: percentile(baselineLineBottomDeltas),
    },
    highFormula: highFormulaCounts,
    dpr: {
      samples: dpr1VsDpr2MeanAbsDiffs.length,
      dpr2Scale: percentile(dpr2Scales),
      dpr15Scale: percentile(dpr15Scales),
      dpr1VsDpr2MeanAbsDiff: percentile(dpr1VsDpr2MeanAbsDiffs),
      dpr1VsDpr2DiffRatio: percentile(dpr1VsDpr2DiffRatios),
      dpr15VsDpr2MeanAbsDiff: percentile(dpr15VsDpr2MeanAbsDiffs),
      clarityRatio: percentile(clarityRatios),
    },
    pixelDiff: {
      'canvas-raster': {
        samples: pixelDiffResults['canvas-raster'].samples,
        meanAbsDiff: percentile(pixelDiffResults['canvas-raster'].meanAbsDiff),
        diffRatio: percentile(pixelDiffResults['canvas-raster'].diffRatio),
      },
      'bitmap-data-url': {
        samples: pixelDiffResults['bitmap-data-url'].samples,
        meanAbsDiff: percentile(pixelDiffResults['bitmap-data-url'].meanAbsDiff),
        diffRatio: percentile(pixelDiffResults['bitmap-data-url'].diffRatio),
      },
      'svg-viewbox': {
        samples: pixelDiffResults['svg-viewbox'].samples,
        meanAbsDiff: percentile(pixelDiffResults['svg-viewbox'].meanAbsDiff),
        diffRatio: percentile(pixelDiffResults['svg-viewbox'].diffRatio),
      },
    },
    memory: {
      apiAvailable: memory != null,
      usedBeforeHarness,
      usedAfterImages,
      usedAfterInjection,
      usedAfterCleanup,
      imageDelta:
        usedBeforeHarness !== null && usedAfterImages !== null
          ? usedAfterImages - usedBeforeHarness
          : null,
      injectionDelta:
        usedAfterImages !== null && usedAfterInjection !== null
          ? usedAfterInjection - usedAfterImages
          : null,
      cleanupDelta:
        usedAfterInjection !== null && usedAfterCleanup !== null
          ? usedAfterCleanup - usedAfterInjection
          : null,
    },
    capabilities: {
      serializedSamples,
      search: {
        query: searchQuery,
        matchCount: searchMatchCount,
        firstMatchStart,
        firstMatchEnd,
      },
      restore: restoreResult,
      export: exportResult,
      editorCopy,
      editorSearch,
    },
    formulaStats,
  };
}

interface CapturedFormulaInput {
  index: number;
  key: string;
  latex: string;
  display: 'yes' | 'no';
  html: string;
  htmlBytes: number;
  htmlNodeCount: number;
  cssWidth: number;
  cssHeight: number;
  pngDpr1: string;
  pngDpr15: string;
  pngDpr2: string;
  svgDpr2: string;
  decodedPngBytes: number;
  svgBytes: number;
  cropCovered: boolean;
  overflow: {
    top: number;
    bottom: number;
    left: number;
    right: number;
    previewHeight: number;
    contentHeight: number;
  };
}

async function captureFormulaRepresentations(
  page: Page,
  prepared: PreparedHostResult,
): Promise<CapturedFormulaInput[]> {
  await page.setViewportSize({ width: 5200, height: 1200 });
  const tempDir = path.join(os.tmpdir(), `marivell-u2-capture-${process.pid}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const results: CapturedFormulaInput[] = [];
  try {
    for (const formula of prepared.formulas) {
      await showFormulaScreenshotCell(page, formula.index);
      const captures: Record<number, Buffer> = {};
      for (const dpr of [1, 1.5, 2] as const) {
        await page.evaluate(({ zoom }) => {
          const host = document.querySelector<HTMLElement>('#u2-formula-screenshot-host');
          if (host) {
            host.style.zoom = String(zoom);
          }
        }, { zoom: dpr });
        const filePath = path.join(tempDir, `u2-${formula.index}-${dpr}.png`);
        await page
          .locator(`[data-u2-index="${formula.index}"]`)
          .screenshot({ path: filePath, scale: 'device', animations: 'disabled' });
        captures[dpr] = fs.readFileSync(filePath);
      }
      await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('#u2-formula-screenshot-host');
        if (host) {
          host.style.zoom = '1';
        }
      });

      const dpr1Png = PNG.sync.read(captures[1] ?? Buffer.alloc(0));
      const dpr15Png = PNG.sync.read(captures[1.5] ?? Buffer.alloc(0));
      const dpr2Png = PNG.sync.read(captures[2] ?? Buffer.alloc(0));
      const scale1 = dpr1Png.width / Math.max(formula.cell.width, 1);
      const scale15 = dpr15Png.width / Math.max(formula.cell.width, 1);
      const scale2 = dpr2Png.width / Math.max(formula.cell.width, 1);
      const cropped1 = cropPng(captures[1] ?? Buffer.alloc(0), formula.cell, formula.content, scale1);
      const cropped15 = cropPng(captures[1.5] ?? Buffer.alloc(0), formula.cell, formula.content, scale15);
      const cropped2 = cropPng(captures[2] ?? Buffer.alloc(0), formula.cell, formula.content, scale2);
      const pngDpr1 = dataUrlFromPng(cropped1);
      const pngDpr15 = dataUrlFromPng(cropped15);
      const pngDpr2 = dataUrlFromPng(cropped2);
      const cropped2Png = PNG.sync.read(cropped2);
      const cssWidth = Math.max(1, formula.content.width);
      const cssHeight = Math.max(1, formula.content.height);
      const svgDpr2 = svgViewBoxDataUrl(pngDpr2, cssWidth, cssHeight);
      const expectedCropWidth = Math.ceil((formula.content.width + 4) * scale2);
      const expectedCropHeight = Math.ceil((formula.content.height + 4) * scale2);
      const cropCovered =
        cropped2Png.width >= expectedCropWidth - 2 &&
        cropped2Png.height >= expectedCropHeight - 2;
      results.push({
        index: formula.index,
        key: formula.key,
        latex: formula.latex,
        display: formula.display,
        html: formula.html,
        htmlBytes: formula.htmlBytes,
        htmlNodeCount: formula.htmlNodeCount,
        cssWidth,
        cssHeight,
        pngDpr1,
        pngDpr15,
        pngDpr2,
        svgDpr2,
        decodedPngBytes: cropped2Png.data.length,
        svgBytes: Buffer.byteLength(svgDpr2, 'utf8'),
        cropCovered,
        overflow: {
          top: formula.overflow.top,
          bottom: formula.overflow.bottom,
          left: formula.overflow.left,
          right: formula.overflow.right,
          previewHeight: formula.preview.height,
          contentHeight: formula.content.height,
        },
      });
    }
    return results;
  } finally {
    await cleanupFormulaScreenshotHost(page);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export interface U2FormulaBackendPocOptions {
  sourceMarkdownPath?: string;
  corpusSize?: number;
  warmupRounds?: number;
  measurementRounds?: number;
  outDir?: string;
  profile?: string;
  port?: number;
  keepTempFiles?: boolean;
}

export async function runU2FormulaBackendPoCE2E(
  options: U2FormulaBackendPocOptions = {},
): Promise<U2E2EResult> {
  const sourceMarkdown =
    options.sourceMarkdownPath ??
    process.env.MARIVELL_U2_POC_SOURCE ??
    defaultSourceMarkdown;
  const corpusSize = options.corpusSize ?? 200;
  const warmupRounds = options.warmupRounds ?? 5;
  const measurementRounds = options.measurementRounds ?? 20;
  if (corpusSize < 200 || corpusSize % 2 !== 0) {
    throw new Error(`corpusSize must be at least 200 and even: ${corpusSize}`);
  }
  if (warmupRounds < 5 || measurementRounds < 20) {
    throw new Error(
      `protocol too small: warmup=${warmupRounds} measured=${measurementRounds}`,
    );
  }

  const corpus = buildFormulaCorpus(sourceMarkdown, corpusSize);
  const markdownPath = path.join(os.tmpdir(), `marivell-u2-formula-backend-${process.pid}.md`);
  fs.writeFileSync(
    markdownPath,
    '# U2 formula backend PoC\n\nSmall placeholder file used only to host the benchmark window.\n',
    'utf8',
  );
  const outDir =
    options.outDir ?? path.join(os.tmpdir(), `marivell-u2-poc-build-${process.pid}`);
  const profile =
    options.profile ?? path.join(os.tmpdir(), `marivell-u2-poc-profile-${process.pid}`);
  const port = options.port ?? 10400 + (process.pid % 200);

  let handle: ElectronHandle | null = null;
  try {
    const buildStart = performance.now();
    await buildRenderer(outDir);
    const buildMs = performance.now() - buildStart;
    handle = await launchElectron(outDir, markdownPath, port, profile);
    const launchMs = Date.now() - handle.spawnedAt;
    const ready = await waitForVisualReady(handle.page, 1, 60_000);
    if (ready.timedOut) {
      throw new Error(`visual editor did not become ready in time: ${ready.waitMs}ms`);
    }

    await handle.page.evaluate(() => {
      const benchmarkWindow = window as unknown as {
        __name?: (fn: unknown) => unknown;
      };
      benchmarkWindow.__name = (fn: unknown): unknown => fn;
    });
    const prepared = await handle.page.evaluate(prepareFormulaScreenshotHost, corpus.sample);
    const captured = await captureFormulaRepresentations(handle.page, prepared);
    const page = await handle.page.evaluate(runU2FormulaBenchmarkInPage, {
      formulas: captured,
      warmupRounds,
      measurementRounds,
    } satisfies U2FormulaBenchmarkInput);
    page.environment.corpus.quartileCounts = corpus.quartileCounts;

    const prototypeCandidates: SingleNodeFormulaCandidate[] = corpus.sample.slice(0, 30).map(
      (entry) => ({
        key: entry.key,
        latex: entry.latex,
        display: entry.display,
        html: entry.html,
      }),
    );
    const serializedSource = serializeSingleNodeFormula(prototypeCandidates[0] ?? {
      latex: 'x',
      display: 'no',
    });
    const searchQuery = prototypeCandidates.find((candidate) => candidate.latex.includes('x'))?.latex ?? 'x';
    const searchMatchCount = findSingleNodeFormulaByLatex(
      prototypeCandidates,
      searchQuery,
    ).length;
    const restoreHtml = restoreSingleNodeFormulaHtml(prototypeCandidates[0] ?? {
      key: 'inline\u0000x',
      latex: 'x',
      display: 'no',
      html: '',
    });
    const firstCaptured = captured[0];
    const exportPayload = createSingleNodeExportPayload({
      key: firstCaptured?.key ?? 'inline\u0000x',
      latex: firstCaptured?.latex ?? 'x',
      display: firstCaptured?.display ?? 'no',
      html: firstCaptured?.html ?? '',
      dpr2DataUrl: firstCaptured?.pngDpr2,
      svgDataUrl: firstCaptured?.svgDpr2,
      cssWidth: firstCaptured?.cssWidth,
      cssHeight: firstCaptured?.cssHeight,
      decodedPngBytes: firstCaptured?.decodedPngBytes,
      svgBytes: firstCaptured?.svgBytes,
    });
    const exportHtml = markdownToExportHtmlFragment({
      markdown: `${serializedSource}\n`,
    });
    const parsedRoundTrip = parseMarkdownFragment(serializedSource);
    const roundTripSource = serializeMarkdown({ type: 'doc', content: parsedRoundTrip });
    const sourceSearchMarkdown = prototypeCandidates
      .map((candidate) => serializeSingleNodeFormula(candidate))
      .join('\n');
    const sourceSearchMatchCount = findSourceSearchMatches(
      sourceSearchMarkdown,
      searchQuery,
    ).length;

    return {
      sourceMarkdown,
      corpus: {
        sourceBytes: corpus.sourceBytes,
        totalUnique: corpus.totalUnique,
        selected: corpus.selected,
        inline: corpus.inline,
        block: corpus.block,
        quartileCounts: corpus.quartileCounts,
        sample: corpus.sample,
      },
      buildMs,
      launchMs,
      readyMs: ready.waitMs,
      page,
      nodeCapabilities: {
        serializedSource,
        searchMatchCount,
        restoreHasHtml: restoreHtml.html === prototypeCandidates[0]?.html,
        exportDataUrlPresent: exportPayload.dataUrl !== null,
        exportHtmlHasKatex: exportHtml.includes('katex'),
        sourceSearchMatchCount,
        markdownRoundTripOk: roundTripSource.includes('x') || roundTripSource.includes('$'),
      },
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
        fs.rmSync(markdownPath, { force: true });
      } catch {
        // Cleanup is best-effort.
      }
    }
  }
}

function formatSummary(result: U2E2EResult): Record<string, unknown> {
  return {
    sourceMarkdown: result.sourceMarkdown,
    corpus: {
      sourceBytes: result.corpus.sourceBytes,
      totalUnique: result.corpus.totalUnique,
      selected: result.corpus.selected,
      inline: result.corpus.inline,
      block: result.corpus.block,
      quartileCounts: result.corpus.quartileCounts,
    },
    buildMs: Math.round(result.buildMs * 10) / 10,
    launchMs: Math.round(result.launchMs * 10) / 10,
    readyMs: Math.round(result.readyMs * 10) / 10,
    environment: result.page.environment,
    dom: result.page.dom,
    injection: result.page.injection,
    baseline: result.page.baseline,
    highFormula: result.page.highFormula,
    dpr: result.page.dpr,
    pixelDiff: result.page.pixelDiff,
    memory: result.page.memory,
    capabilities: result.page.capabilities,
    nodeCapabilities: result.nodeCapabilities,
  };
}

async function main(): Promise<void> {
  const sourceArg = process.argv[2];
  const sourceMarkdown =
    sourceArg && sourceArg !== '--default' ? path.resolve(sourceArg) : undefined;
  const result = await runU2FormulaBackendPoCE2E({ sourceMarkdownPath: sourceMarkdown });
  const rawPath = path.join(os.tmpdir(), `marivell-u2-formula-backend-${Date.now()}.json`);
  fs.writeFileSync(rawPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(formatSummary(result), null, 2));
  console.log(`\nSaved raw U2 formula backend PoC JSON to ${rawPath}`);
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

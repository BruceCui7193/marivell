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
import { acquireExclusiveBenchmarkRun } from './exclusive-run';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const electronBin = path.join(projectRoot, 'node_modules/.bin/electron');
const electronViteBin = path.join(projectRoot, 'node_modules/.bin/electron-vite');
const defaultSourceMarkdown = '/home/crh/下载/barfoot_ser24/barfoot_ser24.md';

export interface U2BatchPercentile {
  count: number;
  min: number;
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

export interface U2BatchCorpusEntry {
  key: string;
  latex: string;
  display: 'yes' | 'no';
  html: string;
  htmlBytes: number;
}

export interface U2BatchCorpus {
  sourceBytes: number;
  totalUnique: number;
  selected: number;
  inline: number;
  block: number;
  quartileCounts: number[];
  sample: U2BatchCorpusEntry[];
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface CaptureTransform {
  offsetX: number;
  offsetY: number;
  scale: number;
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
  renderScale: number;
  captureTransform: CaptureTransform;
  overflow: {
    top: number;
    bottom: number;
    left: number;
    right: number;
    previewHeight: number;
    contentHeight: number;
  };
}

interface PreparedHostResult {
  formulas: PreparedFormula[];
  screenshotHostRemoved: boolean;
}

export interface U2BatchCapturedFormula {
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
  decodedPngBytes: number;
  cropCovered: boolean;
  renderScale: number;
  captureTransform: CaptureTransform;
  overflow: {
    top: number;
    bottom: number;
    left: number;
    right: number;
    previewHeight: number;
    contentHeight: number;
  };
}

export interface U2BatchPageInput {
  formulas: U2BatchCapturedFormula[];
}

export interface U2BatchBaselineSample {
  id: string;
  latex: string;
  display: 'yes' | 'no';
  fontFamily: string;
  fontSizePx: number;
  lineHeightPx: number;
  probeMetricDeltaPx: number;
  katexBaselineTopPx: number;
  katexBottomPx: number;
  candidateBaselineTopPx: number;
  baselineDeltaPx: number;
  bottomDeltaToKatexPx: number;
  bottomDeltaToTextFontPx: number;
  bottomDeltaToTextLineBoxPx: number;
  centerDeltaPx: number;
  renderScale: number;
}

export interface U2BatchFormulaStat {
  key: string;
  latex: string;
  display: 'yes' | 'no';
  htmlBytes: number;
  htmlNodeCount: number;
  candidateNodeCount: number;
  serializedBytes: number;
  decodedPngBytes: number;
  dpr: {
    dpr2Scale: number;
    dpr1VsDpr2MeanAbsDiff: number;
    dpr1VsDpr2DiffRatio: number;
    clarityRatio: number;
  };
  highFormula: {
    previewHeightPx: number;
    contentHeightPx: number;
    overflowTopPx: number;
    overflowBottomPx: number;
    cropCovered: boolean;
    candidateCropDetected: boolean;
  };
  baseline: {
    widthPx: number;
    heightPx: number;
    baselineOffsetTopPx: number;
    descenderPx: number;
    verticalAlignPx: number;
    bottomDeltaPx: number;
    centerDeltaPx: number;
    baselineDeltaPx: number;
  };
}

export interface U2BatchBatchResult {
  kind: 'canvas-raster' | 'bitmap-data-url';
  wallMs: number;
  batches: number;
  tasks: number;
  completed: number;
  failed: number;
  batchSize: number;
  concurrency: number;
  maxSwapPerFrame: number;
  maxSwapsInFrameObserved: number;
  generationMs: U2BatchPercentile;
  swapMs: U2BatchPercentile;
  batchMs: U2BatchPercentile;
  priority0BeforePriority1: boolean;
  priority0Keys: string[];
  processedKeys: string[];
}

export interface U2BatchPageResult {
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
    katexHtmlNodeCount: U2BatchPercentile;
    candidateNodeCount: Record<'canvas-raster' | 'bitmap-data-url', U2BatchPercentile>;
    katexHtmlBytes: U2BatchPercentile;
    candidateSerializedBytes: Record<'canvas-raster' | 'bitmap-data-url', U2BatchPercentile>;
  };
  injection: Record<
    'canvas-raster' | 'bitmap-data-url',
    { samples: number; ms: U2BatchPercentile }
  >;
  baseline: {
    samples: U2BatchBaselineSample[];
    strictA: U2BatchBaselineSample[];
    strictTextBaselineDeltaMaxPx: number;
    strictTextBottomDeltaMaxPx: number;
    perFormulaInline: {
      bottomDeltaPx: U2BatchPercentile;
      centerDeltaPx: U2BatchPercentile;
      baselineDeltaPx: U2BatchPercentile;
    };
    perFormulaBlock: {
      heightDeltaPx: U2BatchPercentile;
      centerDeltaPx: U2BatchPercentile;
    };
  };
  highFormula: {
    total: number;
    overflowCount: number;
    cropCoveredCount: number;
    candidateCropDetectedCount: number;
    overflowTopMaxPx: number;
    overflowBottomMaxPx: number;
  };
  dpr: {
    samples: number;
    dpr2Scale: U2BatchPercentile;
    dpr1VsDpr2MeanAbsDiff: U2BatchPercentile;
    dpr1VsDpr2DiffRatio: U2BatchPercentile;
    clarityRatio: U2BatchPercentile;
  };
  batch: {
    canvas: U2BatchBatchResult;
    bitmap: U2BatchBatchResult;
    timers: {
      activeMax: number;
      totalCalls: number;
      perFormulaCalls: number;
    };
  };
  memory: {
    apiAvailable: boolean;
    usedBeforeHarness: number | null;
    usedAfterImages: number | null;
    usedAfterMeasurement: number | null;
    usedAfterBatch: number | null;
    usedAfterCleanup: number | null;
    imageDelta: number | null;
    measurementDelta: number | null;
    batchDelta: number | null;
    cleanupDelta: number | null;
    domBeforeHarness: number;
    domAfterBatch: number;
    domAfterCleanup: number;
  };
  capabilities: {
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
  formulaStats: U2BatchFormulaStat[];
}

export interface U2BatchE2EResult {
  sourceMarkdown: string;
  corpus: U2BatchCorpus;
  buildMs: number;
  launchMs: number;
  readyMs: number;
  page: U2BatchPageResult;
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentileSummary(values: number[]): U2BatchPercentile {
  if (values.length === 0) {
    return { count: 0, min: 0, avg: 0, p50: 0, p95: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (ratio: number): number => {
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.floor((sorted.length - 1) * ratio)),
    );
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
): U2BatchCorpus {
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

  const controlledEntries = [
    { key: 'u2b-control-inline-a', latex: 'a', display: 'no' as const },
    { key: 'u2b-control-inline-x', latex: 'x', display: 'no' as const },
    { key: 'u2b-control-inline-x2', latex: 'x^2', display: 'no' as const },
    { key: 'u2b-control-inline-sqrt', latex: '\\sqrt{x}', display: 'no' as const },
    { key: 'u2b-control-inline-frac', latex: '\\frac{a}{b}', display: 'no' as const },
    {
      key: 'u2b-control-block-matrix',
      latex: '\\begin{pmatrix}1 & 0 \\\\ 0 & 1 \\\\ 2 & 3 \\\\ 4 & 5 \\\\ 6 & 7 \\end{pmatrix}',
      display: 'yes' as const,
    },
    {
      key: 'u2b-control-block-sum',
      latex: '\\sum_{i=1}^{n} i^2',
      display: 'yes' as const,
    },
  ];
  const controlledHtml = renderFormulaChunk(controlledEntries);
  const controlled = controlledEntries
    .map((entry) => ({
      entry,
      html: controlledHtml[entry.key] ?? '',
      htmlBytes: Buffer.byteLength(controlledHtml[entry.key] ?? '', 'utf8'),
    }))
    .filter((item) => item.htmlBytes > 0);

  const sample = [...selected, ...controlled].map((item) => ({
    key: item.entry.key,
    latex: item.entry.latex,
    display: item.entry.display,
    html: item.html,
    htmlBytes: item.htmlBytes,
  }));

  return {
    sourceBytes,
    totalUnique: sized.length,
    selected: sample.length,
    inline: sample.filter((item) => item.display === 'no').length,
    block: sample.filter((item) => item.display === 'yes').length,
    quartileCounts,
    sample,
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

async function prepareFormulaScreenshotHost(
  input: Array<Pick<U2BatchCorpusEntry, 'key' | 'latex' | 'display' | 'html' | 'htmlBytes'>>,
): Promise<PreparedHostResult> {
  const benchmarkWindow = window as unknown as Record<string, unknown>;
  const captureContentWidth = 2200;
  const host = document.createElement('div');
  host.id = 'u2b-formula-screenshot-host';
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
      cell.className = 'u2b-katex-cell';
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
          width: scaledContentWidth,
          height: scaledContentHeight,
        },
        renderScale,
        captureTransform: { offsetX, offsetY, scale: renderScale },
        overflow: {
          top: Math.max(0, scaledPreviewRect.top - scaledSafeTop),
          bottom: Math.max(0, scaledSafeBottom - scaledPreviewRect.bottom),
          left: Math.max(0, scaledPreviewRect.left - scaledSafeLeft),
          right: Math.max(0, scaledSafeRight - scaledPreviewRect.right),
          previewHeight: scaledPreviewRect.height,
          contentHeight: scaledContentHeight,
        },
      });
    }
    showCell(-1);
    benchmarkWindow.__u2bFormulaScreenshotHost = host;
    benchmarkWindow.__u2bFormulaScreenshotCells = cells;
    return { formulas, screenshotHostRemoved: !host.isConnected };
  } catch (error) {
    host.remove();
    throw error;
  }
}

async function showFormulaScreenshotCell(page: Page, index: number): Promise<void> {
  await page.evaluate(({ targetIndex }) => {
    const benchmarkWindow = window as unknown as {
      __u2bFormulaScreenshotCells?: Map<number, HTMLElement>;
    };
    const cells = benchmarkWindow.__u2bFormulaScreenshotCells;
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
      __u2bFormulaScreenshotHost?: HTMLElement;
      __u2bFormulaScreenshotCells?: Map<number, HTMLElement>;
    };
    benchmarkWindow.__u2bFormulaScreenshotHost?.remove();
    benchmarkWindow.__u2bFormulaScreenshotHost = undefined;
    benchmarkWindow.__u2bFormulaScreenshotCells = undefined;
  });
}

async function captureFormulaRepresentations(
  page: Page,
  prepared: PreparedHostResult,
): Promise<U2BatchCapturedFormula[]> {
  await page.setViewportSize({ width: 5200, height: 1200 });
  const tempDir = path.join(os.tmpdir(), `marivell-u2b-capture-${process.pid}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const results: U2BatchCapturedFormula[] = [];
  try {
    for (const formula of prepared.formulas) {
      await showFormulaScreenshotCell(page, formula.index);
      const captures: Record<number, Buffer> = {};
      for (const dpr of [1, 1.5, 2] as const) {
        await page.evaluate(({ zoom }) => {
          const host = document.querySelector<HTMLElement>('#u2b-formula-screenshot-host');
          if (host) {
            host.style.zoom = String(zoom);
          }
        }, { zoom: dpr });
        const filePath = path.join(tempDir, `u2b-${formula.index}-${dpr}.png`);
        await page
          .locator(`[data-u2-index="${formula.index}"]`)
          .screenshot({ path: filePath, scale: 'device', animations: 'disabled' });
        captures[dpr] = fs.readFileSync(filePath);
      }
      await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('#u2b-formula-screenshot-host');
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
        decodedPngBytes: cropped2Png.data.length,
        cropCovered,
        renderScale: formula.renderScale,
        captureTransform: formula.captureTransform,
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

interface InlineFontSpec {
  family: string;
  sizePx: number;
  lineHeightPx: number;
}

interface InlineReferenceMeasurement {
  katexTopPx: number;
  katexBottomPx: number;
  katexLeftPx: number;
  katexRightPx: number;
  lineBaselineTopPx: number;
  probeMetricDeltaPx: number;
  fontDescentPx: number;
  textRectBottomPx: number;
  lineBoxTrimPx: number;
}

interface InlineCandidateMeasurement {
  candidateTopPx: number;
  candidateBottomPx: number;
  candidateBaselineTopPx: number;
  baselineDeltaPx: number;
  bottomDeltaToKatexPx: number;
  bottomDeltaToTextFontPx: number;
  bottomDeltaToTextLineBoxPx: number;
  centerDeltaPx: number;
}

interface BlockReferenceMeasurement {
  contentTopPx: number;
  contentBottomPx: number;
  contentLeftPx: number;
  contentRightPx: number;
}

interface BlockCandidateMeasurement {
  candidateTopPx: number;
  candidateBottomPx: number;
  candidateLeftPx: number;
  candidateRightPx: number;
  heightDeltaPx: number;
  centerDeltaPx: number;
  cropDetected: boolean;
}

export async function runU2BatchBenchmarkInPage(
  input: U2BatchPageInput,
): Promise<U2BatchPageResult> {
  const benchmarkWindow = window as unknown as Record<string, unknown>;
  const memory = (
    performance as Performance & { memory?: { usedJSHeapSize: number } }
  ).memory;
  const countDomNodes = (root: ParentNode = document): number => {
    let count = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
    while (walker.nextNode()) {
      count += 1;
    }
    return count;
  };
  const usedBeforeHarness = memory?.usedJSHeapSize ?? null;
  const domBeforeHarness = countDomNodes();
  const benchmarkHost = document.createElement('div');
  benchmarkHost.id = 'u2b-benchmark-host';
  benchmarkHost.style.cssText =
    'position:absolute;left:0;top:0;width:1600px;z-index:2147483646;opacity:0.001;pointer-events:none;overflow:visible;';
  document.body.appendChild(benchmarkHost);

  const percentile = (values: number[]): U2BatchPercentile => {
    if (values.length === 0) {
      return { count: 0, min: 0, avg: 0, p50: 0, p95: 0, max: 0 };
    }
    const sorted = [...values].sort((a, b) => a - b);
    const pick = (ratio: number): number => {
      const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.floor((sorted.length - 1) * ratio)),
      );
      return sorted[index] ?? 0;
    };
    return {
      count: sorted.length,
      min: sorted[0] ?? 0,
      avg: sorted.reduce((total, value) => total + value, 0) / sorted.length,
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
  };
  for (let start = 0; start < input.formulas.length; start += 12) {
    const chunk = input.formulas.slice(start, start + 12);
    await Promise.all(
      chunk.flatMap((formula) => [
        loadImage(formula.pngDpr1).then((image) => imageMaps.dpr1.set(formula.index, image)),
        loadImage(formula.pngDpr15).then((image) => imageMaps.dpr15.set(formula.index, image)),
        loadImage(formula.pngDpr2).then((image) => imageMaps.dpr2.set(formula.index, image)),
      ]),
    );
  }
  const usedAfterImages = memory?.usedJSHeapSize ?? null;

  let activeSetTimeout = 0;
  let maxActiveSetTimeout = 0;
  let totalSetTimeoutCalls = 0;
  const nativeSetTimeout = window.setTimeout.bind(window);
  const wrappedSetTimeout = ((
    handler: (...args: unknown[]) => void,
    timeout?: number,
    ...args: unknown[]
  ): number => {
    activeSetTimeout += 1;
    maxActiveSetTimeout = Math.max(maxActiveSetTimeout, activeSetTimeout);
    totalSetTimeoutCalls += 1;
    const id = nativeSetTimeout(
      () => {
        activeSetTimeout -= 1;
        handler(...args);
      },
      timeout,
    );
    return id;
  }) as typeof setTimeout;
  window.setTimeout = wrappedSetTimeout;

  const countSubtreeNodes = (element: Element): number => {
    let count = 1;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ALL);
    while (walker.nextNode()) {
      count += 1;
    }
    return count;
  };

  const createHostWrapper = (display: 'yes' | 'no'): HTMLElement => {
    const wrapper = document.createElement(display === 'yes' ? 'div' : 'span');
    wrapper.className =
      display === 'yes'
        ? 'math-block-node math-node-wrapper'
        : 'math-inline-node math-node-wrapper';
    if (display === 'yes') {
      wrapper.style.cssText = 'display:block;margin:0;overflow:visible;';
    } else {
      wrapper.style.cssText =
        'display:inline-block;align-items:normal;vertical-align:baseline;min-height:0;line-height:0;overflow:visible;';
    }
    return wrapper;
  };

  const createPreview = (display: 'yes' | 'no'): HTMLSpanElement => {
    const preview = document.createElement('span');
    preview.className = 'math-node-preview';
    preview.style.display = display === 'yes' ? 'block' : 'inline-block';
    preview.style.overflow = 'visible';
    preview.style.lineHeight = display === 'yes' ? 'normal' : '0';
    preview.style.verticalAlign = 'baseline';
    return preview;
  };

  const createKatexPreview = (
    formula: U2BatchCapturedFormula,
    useTransform: boolean,
  ): HTMLElement => {
    const wrapper = createHostWrapper(formula.display);
    const preview = createPreview(formula.display);
    preview.innerHTML = formula.html;
    if (useTransform && formula.captureTransform) {
      const transform = formula.captureTransform;
      preview.style.transform = `translate(${transform.offsetX}px, ${transform.offsetY}px) scale(${transform.scale})`;
      preview.style.transformOrigin = '0 0';
    }
    wrapper.appendChild(preview);
    return wrapper;
  };

  const createSyncCandidateElement = (
    formula: U2BatchCapturedFormula,
    kind: 'canvas-raster' | 'bitmap-data-url',
    geometry?: {
      widthPx: number;
      heightPx: number;
      baselineOffsetTopPx: number;
      descenderPx: number;
      verticalAlignPx: number;
    },
  ): HTMLElement => {
    const width = geometry?.widthPx ?? formula.cssWidth;
    const height = geometry?.heightPx ?? formula.cssHeight;
    if (kind === 'canvas-raster') {
      const canvas = document.createElement('canvas');
      const source = imageMaps.dpr2.get(formula.index);
      canvas.width = Math.max(1, source?.naturalWidth ?? Math.round(formula.cssWidth * 2));
      canvas.height = Math.max(1, source?.naturalHeight ?? Math.round(formula.cssHeight * 2));
      const context = canvas.getContext('2d');
      if (context && source) {
        context.drawImage(source, 0, 0);
      }
      canvas.style.display = formula.display === 'yes' ? 'block' : 'inline-block';
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.style.overflow = 'visible';
      if (formula.display === 'no') {
        canvas.style.verticalAlign = `${geometry?.verticalAlignPx ?? 0}px`;
      }
      return canvas;
    }
    const image = document.createElement('img');
    image.alt = '';
    image.src = formula.pngDpr2;
    image.style.display = formula.display === 'yes' ? 'block' : 'inline-block';
    image.style.width = `${width}px`;
    image.style.height = `${height}px`;
    image.style.overflow = 'visible';
    if (formula.display === 'no') {
      image.style.verticalAlign = `${geometry?.verticalAlignPx ?? 0}px`;
    }
    return image;
  };

  const createCandidateHost = async (
    formula: U2BatchCapturedFormula,
    kind: 'canvas-raster' | 'bitmap-data-url',
    geometry: {
      widthPx: number;
      heightPx: number;
      baselineOffsetTopPx: number;
      descenderPx: number;
      verticalAlignPx: number;
    },
  ): Promise<HTMLElement> => {
    const wrapper = createHostWrapper(formula.display);
    const preview = createPreview(formula.display);
    const element = createSyncCandidateElement(formula, kind, geometry);
    if (kind === 'bitmap-data-url') {
      await (element as HTMLImageElement).decode();
    }
    preview.appendChild(element);
    wrapper.appendChild(preview);
    return wrapper;
  };

  const createInlineLine = (
    font: InlineFontSpec,
    createHost: () => HTMLElement,
  ): {
    line: HTMLElement;
    probe: HTMLElement;
    text: HTMLElement;
    hostSlot: HTMLElement;
    hostElement: HTMLElement;
  } => {
    const line = document.createElement('div');
    line.className = 'u2b-inline-line';
    line.style.cssText =
      `position:absolute;left:0;top:0;white-space:nowrap;font-family:${font.family};` +
      `font-size:${font.sizePx}px;line-height:${font.lineHeightPx}px;` +
      'background:#fff;color:#000;opacity:0.001;pointer-events:none;overflow:visible;';
    line.innerHTML =
      '<span class="u2b-before">Ag</span>' +
      '<span class="u2b-probe" style="display:inline-block;width:0;height:0;overflow:visible;vertical-align:baseline;line-height:0;"></span>' +
      '<span class="u2b-text">a</span>' +
      '<span class="u2b-host"></span>' +
      '<span class="u2b-after">Ag</span>';
    const probe = line.querySelector<HTMLElement>('.u2b-probe');
    const text = line.querySelector<HTMLElement>('.u2b-text');
    const hostSlot = line.querySelector<HTMLElement>('.u2b-host');
    if (!probe || !text || !hostSlot) {
      throw new Error('inline baseline line host missing');
    }
    const hostElement = createHost();
    hostSlot.appendChild(hostElement);
    benchmarkHost.appendChild(line);
    return { line, probe, text, hostSlot, hostElement };
  };

  const estimateBaselineFromFontMetrics = (
    lineRect: DOMRect,
    font: InlineFontSpec,
  ): { ascentPx: number; descentPx: number; baselineTopPx: number } => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) {
      return {
        ascentPx: font.sizePx * 0.8,
        descentPx: font.sizePx * 0.2,
        baselineTopPx: lineRect.top + font.sizePx * 0.8,
      };
    }
    context.font = `${font.sizePx}px ${font.family}`;
    const metrics = context.measureText('a');
    const ascentPx =
      metrics.actualBoundingBoxAscent ??
      metrics.fontBoundingBoxAscent ??
      font.sizePx * 0.8;
    const descentPx =
      metrics.actualBoundingBoxDescent ??
      metrics.fontBoundingBoxDescent ??
      font.sizePx * 0.2;
    const halfLeading = (font.lineHeightPx - ascentPx - descentPx) / 2;
    return {
      ascentPx,
      descentPx,
      baselineTopPx: lineRect.top + ascentPx + halfLeading,
    };
  };

  const measureInlineReference = (
    formula: U2BatchCapturedFormula,
    font: InlineFontSpec,
  ): InlineReferenceMeasurement => {
    const { line, probe, text } = createInlineLine(font, () =>
      createKatexPreview(formula, false),
    );
    const lineRect = line.getBoundingClientRect();
    const probeRect = probe.getBoundingClientRect();
    const katexElement = line.querySelector('.katex') ?? line.querySelector('.u2b-host');
    const katexRect = katexElement?.getBoundingClientRect() ?? lineRect;
    const metric = estimateBaselineFromFontMetrics(lineRect, font);
    const result: InlineReferenceMeasurement = {
      katexTopPx: katexRect.top,
      katexBottomPx: katexRect.bottom,
      katexLeftPx: katexRect.left,
      katexRightPx: katexRect.right,
      lineBaselineTopPx: probeRect.bottom,
      probeMetricDeltaPx: probeRect.bottom - metric.baselineTopPx,
      fontDescentPx: metric.descentPx,
      textRectBottomPx: text.getBoundingClientRect().bottom,
      lineBoxTrimPx: Math.max(
        0,
        (katexRect.bottom - probeRect.bottom) * formula.renderScale -
          (text.getBoundingClientRect().bottom - probeRect.bottom),
      ),
    };
    line.remove();
    return result;
  };

  const measureInlineCandidate = async (
    formula: U2BatchCapturedFormula,
    kind: 'canvas-raster' | 'bitmap-data-url',
    geometry: {
      widthPx: number;
      heightPx: number;
      baselineOffsetTopPx: number;
      descenderPx: number;
      verticalAlignPx: number;
    },
    reference: InlineReferenceMeasurement,
    font: InlineFontSpec,
  ): Promise<InlineCandidateMeasurement> => {
    const hostElement = await createCandidateHost(formula, kind, geometry);
    const { line, probe, text } = createInlineLine(font, () => hostElement);
    const probeRect = probe.getBoundingClientRect();
    const candidateElement =
      line.querySelector('canvas, img') ?? line.querySelector('.u2b-host');
    const candidateRect = candidateElement?.getBoundingClientRect() ?? line.getBoundingClientRect();
    const candidateBaselineTopPx = candidateRect.top + geometry.baselineOffsetTopPx;
    const scaledReferenceBottomPx =
      reference.lineBaselineTopPx +
      (reference.katexBottomPx - reference.lineBaselineTopPx) * formula.renderScale;
    const scaledReferenceCenterPx =
      reference.lineBaselineTopPx +
      ((reference.katexTopPx + reference.katexBottomPx) / 2 -
        reference.lineBaselineTopPx) *
        formula.renderScale;
    const trimmedReferenceBottomPx =
      scaledReferenceBottomPx - reference.lineBoxTrimPx;
    const result: InlineCandidateMeasurement = {
      candidateTopPx: candidateRect.top,
      candidateBottomPx: candidateRect.bottom,
      candidateBaselineTopPx,
      baselineDeltaPx: Math.abs(candidateBaselineTopPx - reference.lineBaselineTopPx),
      bottomDeltaToKatexPx: candidateRect.bottom - trimmedReferenceBottomPx,
      bottomDeltaToTextFontPx:
        candidateRect.bottom - (reference.lineBaselineTopPx + reference.fontDescentPx),
      bottomDeltaToTextLineBoxPx: candidateRect.bottom - text.getBoundingClientRect().bottom,
      centerDeltaPx: (candidateRect.top + candidateRect.bottom) / 2 - scaledReferenceCenterPx,
    };
    line.remove();
    return result;
  };

  const createBlockHost = (
    formula: U2BatchCapturedFormula,
    candidate: {
      kind: 'canvas-raster' | 'bitmap-data-url';
      geometry: {
        widthPx: number;
        heightPx: number;
        baselineOffsetTopPx: number;
        descenderPx: number;
        verticalAlignPx: number;
      };
    } | null,
  ): HTMLElement => {
    const block = document.createElement('div');
    block.style.cssText =
      'position:absolute;left:0;top:0;width:1200px;overflow:visible;background:#fff;opacity:0.001;pointer-events:none;';
    const wrapper = candidate
      ? createHostWrapper('yes')
      : createKatexPreview(formula, true);
    if (candidate) {
      const preview = createPreview('yes');
      preview.appendChild(
        createSyncCandidateElement(formula, candidate.kind, candidate.geometry),
      );
      wrapper.appendChild(preview);
    }
    block.appendChild(wrapper);
    benchmarkHost.appendChild(block);
    return block;
  };

  const measureBlockReference = (
    formula: U2BatchCapturedFormula,
  ): BlockReferenceMeasurement => {
    const block = createBlockHost(formula, null);
    const katexElement = block.querySelector('.katex');
    const rect = katexElement?.getBoundingClientRect() ?? block.getBoundingClientRect();
    const result: BlockReferenceMeasurement = {
      contentTopPx: rect.top,
      contentBottomPx: rect.bottom,
      contentLeftPx: rect.left,
      contentRightPx: rect.right,
    };
    block.remove();
    return result;
  };

  const measureBlockCandidate = async (
    formula: U2BatchCapturedFormula,
    kind: 'canvas-raster' | 'bitmap-data-url',
    geometry: {
      widthPx: number;
      heightPx: number;
      baselineOffsetTopPx: number;
      descenderPx: number;
      verticalAlignPx: number;
    },
    reference: BlockReferenceMeasurement,
  ): BlockCandidateMeasurement => {
    const block = createBlockHost(formula, { kind, geometry });
    const candidateElement = block.querySelector('canvas, img');
    if (candidateElement instanceof HTMLImageElement) {
      await candidateElement.decode().catch(() => {});
    }
    const rect = candidateElement?.getBoundingClientRect() ?? block.getBoundingClientRect();
    let clipped = false;
    let current = candidateElement?.parentElement ?? block;
    while (current && current !== document.body) {
      const style = getComputedStyle(current);
      if (
        style.overflowX === 'hidden' ||
        style.overflowY === 'hidden' ||
        style.overflowX === 'clip' ||
        style.overflowY === 'clip'
      ) {
        clipped = true;
        break;
      }
      current = current.parentElement;
    }
    const result: BlockCandidateMeasurement = {
      candidateTopPx: rect.top,
      candidateBottomPx: rect.bottom,
      candidateLeftPx: rect.left,
      candidateRightPx: rect.right,
      heightDeltaPx: rect.height - formula.cssHeight,
      centerDeltaPx:
        (rect.top + rect.bottom) / 2 -
        (reference.contentTopPx + reference.contentBottomPx) / 2,
      cropDetected:
        clipped ||
        Math.abs(rect.width - formula.cssWidth) > 1 ||
        Math.abs(rect.height - formula.cssHeight) > 1,
    };
    block.remove();
    return result;
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

  const edgeEnergy = (
    data: Uint8ClampedArray,
    width: number,
    height: number,
  ): number => {
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

  const inlineFonts: InlineFontSpec[] = [
    { family: 'serif', sizePx: 16, lineHeightPx: 28.48 },
    { family: 'sans-serif', sizePx: 18, lineHeightPx: 30.6 },
    { family: '"Times New Roman", Times, serif', sizePx: 20, lineHeightPx: 32 },
  ];

  const formulaStats: U2BatchFormulaStat[] = [];
  const inlineBottomDeltas: number[] = [];
  const inlineCenterDeltas: number[] = [];
  const inlineBaselineDeltas: number[] = [];
  const blockHeightDeltas: number[] = [];
  const blockCenterDeltas: number[] = [];
  const baselineSamples: U2BatchBaselineSample[] = [];
  const strictA: U2BatchBaselineSample[] = [];
  const dpr2Scales: number[] = [];
  const dpr1VsDpr2MeanAbsDiffs: number[] = [];
  const dpr1VsDpr2DiffRatios: number[] = [];
  const clarityRatios: number[] = [];
  const baselineGeometries = new Map<
    string,
    {
      widthPx: number;
      heightPx: number;
      baselineOffsetTopPx: number;
      descenderPx: number;
      verticalAlignPx: number;
    }
  >();
  let highOverflowCount = 0;
  let highCropCoveredCount = 0;
  let highCandidateCropDetectedCount = 0;
  let highOverflowTopMax = 0;
  let highOverflowBottomMax = 0;

  const candidateKinds: Array<'canvas-raster' | 'bitmap-data-url'> = [
    'canvas-raster',
    'bitmap-data-url',
  ];

  for (const formula of input.formulas) {
    const display = formula.display;
    let bottomDelta = 0;
    let centerDelta = 0;
    let baselineDelta = 0;
    let candidateCropDetected = false;
    let geometry: {
      widthPx: number;
      heightPx: number;
      baselineOffsetTopPx: number;
      descenderPx: number;
      verticalAlignPx: number;
    };

    if (display === 'no') {
      const font = inlineFonts[0];
      const reference = measureInlineReference(formula, font);
      const referenceBaselineOffsetPx =
        reference.lineBaselineTopPx - reference.katexTopPx;
      const referenceHeightPx = reference.katexBottomPx - reference.katexTopPx;
      const referenceWidthPx = reference.katexRightPx - reference.katexLeftPx;
      geometry = {
        widthPx: referenceWidthPx * formula.renderScale,
        heightPx: Math.max(
          1,
          referenceHeightPx * formula.renderScale - reference.lineBoxTrimPx,
        ),
        baselineOffsetTopPx: referenceBaselineOffsetPx * formula.renderScale,
        descenderPx: Math.max(
          0,
          Math.max(
            1,
            referenceHeightPx * formula.renderScale - reference.lineBoxTrimPx,
          ) -
            referenceBaselineOffsetPx * formula.renderScale,
        ),
        verticalAlignPx:
          referenceBaselineOffsetPx * formula.renderScale -
          Math.max(
            1,
            referenceHeightPx * formula.renderScale - reference.lineBoxTrimPx,
          ),
      };
      for (const kind of candidateKinds) {
        const candidate = await measureInlineCandidate(
          formula,
          kind,
          geometry,
          reference,
          font,
        );
        bottomDelta = Math.max(bottomDelta, Math.abs(candidate.bottomDeltaToKatexPx));
        centerDelta = Math.max(centerDelta, Math.abs(candidate.centerDeltaPx));
        baselineDelta = Math.max(baselineDelta, candidate.baselineDeltaPx);
      }
      inlineBottomDeltas.push(bottomDelta);
      inlineCenterDeltas.push(centerDelta);
      inlineBaselineDeltas.push(baselineDelta);

      for (const font of inlineFonts) {
        const strictReference = measureInlineReference(formula, font);
        const strictBaselineOffsetPx =
          strictReference.lineBaselineTopPx - strictReference.katexTopPx;
        const strictHeightPx =
          strictReference.katexBottomPx - strictReference.katexTopPx;
        const strictWidthPx =
          strictReference.katexRightPx - strictReference.katexLeftPx;
        const strictGeometry = {
          widthPx: strictWidthPx * formula.renderScale,
          heightPx: Math.max(
            1,
            strictHeightPx * formula.renderScale -
              strictReference.lineBoxTrimPx,
          ),
          baselineOffsetTopPx: strictBaselineOffsetPx * formula.renderScale,
          descenderPx: Math.max(
            0,
            Math.max(
              1,
              strictHeightPx * formula.renderScale -
                strictReference.lineBoxTrimPx,
            ) -
              strictBaselineOffsetPx * formula.renderScale,
          ),
          verticalAlignPx:
            strictBaselineOffsetPx * formula.renderScale -
            Math.max(
              1,
              strictHeightPx * formula.renderScale -
                strictReference.lineBoxTrimPx,
            ),
        };
        for (const kind of candidateKinds) {
          const candidate = await measureInlineCandidate(
            formula,
            kind,
            strictGeometry,
            strictReference,
            font,
          );
          const sample: U2BatchBaselineSample = {
            id: `${formula.key}|${kind}|${font.sizePx}`,
            latex: formula.latex,
            display,
            fontFamily: font.family,
            fontSizePx: font.sizePx,
            lineHeightPx: font.lineHeightPx,
            probeMetricDeltaPx: strictReference.probeMetricDeltaPx,
            katexBaselineTopPx: strictReference.lineBaselineTopPx,
            katexBottomPx: strictReference.katexBottomPx,
            candidateBaselineTopPx: candidate.candidateBaselineTopPx,
            baselineDeltaPx: candidate.baselineDeltaPx,
            bottomDeltaToKatexPx: candidate.bottomDeltaToKatexPx,
            bottomDeltaToTextFontPx: candidate.bottomDeltaToTextFontPx,
            bottomDeltaToTextLineBoxPx: candidate.bottomDeltaToTextLineBoxPx,
            centerDeltaPx: candidate.centerDeltaPx,
            renderScale: formula.renderScale,
          };
          baselineSamples.push(sample);
          if (formula.key === 'u2b-control-inline-a') {
            strictA.push(sample);
          }
        }
      }
    } else {
      const reference = measureBlockReference(formula);
      geometry = {
        widthPx: formula.cssWidth,
        heightPx: formula.cssHeight,
        baselineOffsetTopPx: 0,
        descenderPx: 0,
        verticalAlignPx: 0,
      };
      for (const kind of candidateKinds) {
        const candidate = await measureBlockCandidate(formula, kind, geometry, reference);
        bottomDelta = Math.max(bottomDelta, Math.abs(candidate.heightDeltaPx));
        centerDelta = Math.max(centerDelta, Math.abs(candidate.centerDeltaPx));
        if (candidate.cropDetected) {
          candidateCropDetected = true;
          highCandidateCropDetectedCount += 1;
        }
      }
      blockHeightDeltas.push(bottomDelta);
      blockCenterDeltas.push(centerDelta);
    }

    baselineGeometries.set(formula.key, geometry);
    const dpr2Image = imageMaps.dpr2.get(formula.index);
    const dpr1Image = imageMaps.dpr1.get(formula.index);
    if (dpr2Image && dpr1Image) {
      const dpr1Canvas = document.createElement('canvas');
      const dpr2DownCanvas = document.createElement('canvas');
      drawScaled(dpr1Canvas, dpr1Image, formula.cssWidth, formula.cssHeight, 1);
      drawScaled(dpr2DownCanvas, dpr2Image, formula.cssWidth, formula.cssHeight, 1);
      const leftData = dpr1Canvas
        .getContext('2d')
        ?.getImageData(0, 0, dpr1Canvas.width, dpr1Canvas.height);
      const rightData = dpr2DownCanvas
        .getContext('2d')
        ?.getImageData(0, 0, dpr2DownCanvas.width, dpr2DownCanvas.height);
      if (leftData && rightData) {
        const diff = diffImageData(leftData, rightData);
        dpr1VsDpr2MeanAbsDiffs.push(diff.meanAbsDiff);
        dpr1VsDpr2DiffRatios.push(diff.diffRatio);
        const leftEnergy = edgeEnergy(leftData.data, leftData.width, leftData.height);
        const rightEnergy = edgeEnergy(rightData.data, rightData.width, rightData.height);
        clarityRatios.push(rightEnergy / Math.max(leftEnergy, 1));
      }
      dpr2Scales.push(dpr2Image.naturalWidth / Math.max(formula.cssWidth, 1));
    }

    if (formula.overflow.top > 0.5 || formula.overflow.bottom > 0.5) {
      highOverflowCount += 1;
    }
    if (formula.cropCovered) {
      highCropCoveredCount += 1;
    }
    highOverflowTopMax = Math.max(highOverflowTopMax, formula.overflow.top);
    highOverflowBottomMax = Math.max(highOverflowBottomMax, formula.overflow.bottom);

    formulaStats.push({
      key: formula.key,
      latex: formula.latex,
      display,
      htmlBytes: formula.htmlBytes,
      htmlNodeCount: formula.htmlNodeCount,
      candidateNodeCount: 1,
      serializedBytes: formula.pngDpr2.length,
      decodedPngBytes: formula.decodedPngBytes,
      dpr: {
        dpr2Scale:
          dpr2Image?.naturalWidth !== undefined
            ? dpr2Image.naturalWidth / Math.max(formula.cssWidth, 1)
            : 0,
        dpr1VsDpr2MeanAbsDiff:
          dpr1VsDpr2MeanAbsDiffs[dpr1VsDpr2MeanAbsDiffs.length - 1] ?? 0,
        dpr1VsDpr2DiffRatio: dpr1VsDpr2DiffRatios[dpr1VsDpr2DiffRatios.length - 1] ?? 0,
        clarityRatio: clarityRatios[clarityRatios.length - 1] ?? 0,
      },
      highFormula: {
        previewHeightPx: formula.overflow.previewHeight,
        contentHeightPx: formula.overflow.contentHeight,
        overflowTopPx: formula.overflow.top,
        overflowBottomPx: formula.overflow.bottom,
        cropCovered: formula.cropCovered,
        candidateCropDetected,
      },
      baseline: {
        widthPx: geometry.widthPx,
        heightPx: geometry.heightPx,
        baselineOffsetTopPx: geometry.baselineOffsetTopPx,
        descenderPx: geometry.descenderPx,
        verticalAlignPx: geometry.verticalAlignPx,
        bottomDeltaPx: bottomDelta,
        centerDeltaPx: centerDelta,
        baselineDeltaPx: baselineDelta,
      },
    });
  }

  const usedAfterMeasurement = memory?.usedJSHeapSize ?? null;

  const measureInjection = (
    kind: 'canvas-raster' | 'bitmap-data-url',
  ): { samples: number; ms: U2BatchPercentile } => {
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;';
    benchmarkHost.appendChild(container);
    const times: number[] = [];
    for (let round = 0; round < 10; round += 1) {
      for (const formula of input.formulas) {
        container.replaceChildren();
        const start = performance.now();
        const element = createSyncCandidateElement(formula, kind);
        container.appendChild(element);
        times.push(performance.now() - start);
      }
    }
    container.remove();
    return { samples: times.length, ms: percentile(times) };
  };

  class PageBatchProcessor {
    private readonly batchSize = 12;
    private readonly concurrency = 8;
    private readonly maxSwapPerFrame = 3;
    private readonly queue: Array<{
      key: string;
      priority: number;
      formula: U2BatchCapturedFormula;
    }> = [];
    private readonly generationTimes: number[] = [];
    private readonly swapTimes: number[] = [];
    private readonly batchTimes: number[] = [];
    private readonly processedKeys: string[] = [];
    private readonly priority0Keys: string[] = [];
    private active = 0;
    private completed = 0;
    private failed = 0;
    private batchCount = 0;
    private swapsInFrame = 0;
    private maxSwapsInFrame = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private pumpScheduled = false;
    private pumping = false;
    private flushResolvers: Array<() => void> = [];
    private readonly priorityByKey = new Map<string, number>();

    constructor(
      private readonly kind: 'canvas-raster' | 'bitmap-data-url',
      private readonly container: HTMLElement,
    ) {}

    enqueue(formulas: U2BatchCapturedFormula[]): void {
      for (let index = 0; index < formulas.length; index += 1) {
        const formula = formulas[index];
        if (!formula) {
          continue;
        }
        const priority = index < 16 ? 0 : 1;
        this.priorityByKey.set(formula.key, priority);
        if (priority === 0) {
          this.priority0Keys.push(formula.key);
        }
        this.queue.push({ key: formula.key, priority, formula });
      }
      this.queue.sort((left, right) => left.priority - right.priority);
      this.schedulePump();
    }

    async flush(): Promise<U2BatchBatchResult> {
      this.schedulePump();
      if (this.queue.length === 0 && this.active === 0 && !this.pumping) {
        return this.getResult();
      }
      await new Promise<void>((resolve) => {
        this.flushResolvers.push(resolve);
      });
      return this.getResult();
    }

    private schedulePump(): void {
      if (this.pumpScheduled || this.pumping) {
        return;
      }
      this.pumpScheduled = true;
      this.timer = setTimeout(() => {
        this.pumpScheduled = false;
        this.timer = null;
        void this.pump();
      }, 0);
    }

    private async pump(): Promise<void> {
      if (this.pumping) {
        return;
      }
      this.pumping = true;
      try {
        while (this.queue.length > 0) {
          const batch = this.queue.splice(0, this.batchSize);
          const start = performance.now();
          await this.runBatch(batch);
          this.batchTimes.push(performance.now() - start);
          this.batchCount += 1;
        }
      } finally {
        this.pumping = false;
        const resolvers = this.flushResolvers.splice(0);
        for (const resolve of resolvers) {
          resolve();
        }
      }
    }

    private async runBatch(
      batch: Array<{ key: string; priority: number; formula: U2BatchCapturedFormula }>,
    ): Promise<void> {
      const pending = [...batch];
      const workers = Array.from(
        { length: Math.min(this.concurrency, pending.length) },
        async () => {
          while (pending.length > 0) {
            const item = pending.shift();
            if (!item) {
              break;
            }
            this.active += 1;
            const start = performance.now();
            try {
              const element = await this.generate(item.formula);
              this.generationTimes.push(performance.now() - start);
              const swapStart = performance.now();
              await this.swapWithFrameLimit(element);
              this.swapTimes.push(performance.now() - swapStart);
              this.processedKeys.push(item.key);
              this.completed += 1;
            } catch {
              this.failed += 1;
            } finally {
              this.active -= 1;
            }
          }
        },
      );
      await Promise.all(workers);
    }

    private async generate(formula: U2BatchCapturedFormula): Promise<HTMLElement> {
      const geometry =
        baselineGeometries.get(formula.key) ?? {
          widthPx: formula.cssWidth,
          heightPx: formula.cssHeight,
          baselineOffsetTopPx: 0,
          descenderPx: 0,
          verticalAlignPx: 0,
        };
      if (this.kind === 'canvas-raster') {
        const source = imageMaps.dpr2.get(formula.index) ?? (await loadImage(formula.pngDpr2));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, source.naturalWidth);
        canvas.height = Math.max(1, source.naturalHeight);
        const context = canvas.getContext('2d');
        if (context) {
          context.drawImage(source, 0, 0);
        }
        canvas.style.display = formula.display === 'yes' ? 'block' : 'inline-block';
        canvas.style.width = `${geometry.widthPx}px`;
        canvas.style.height = `${geometry.heightPx}px`;
        if (formula.display === 'no') {
          canvas.style.verticalAlign = `${geometry.verticalAlignPx}px`;
        }
        return canvas;
      }
      const image = document.createElement('img');
      image.alt = '';
      image.src = formula.pngDpr2;
      image.style.display = formula.display === 'yes' ? 'block' : 'inline-block';
      image.style.width = `${geometry.widthPx}px`;
      image.style.height = `${geometry.heightPx}px`;
      if (formula.display === 'no') {
        image.style.verticalAlign = `${geometry.verticalAlignPx}px`;
      }
      await image.decode();
      return image;
    }

    private async swapWithFrameLimit(element: HTMLElement): Promise<void> {
      if (this.swapsInFrame >= this.maxSwapPerFrame) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        this.swapsInFrame = 0;
      }
      this.swapsInFrame += 1;
      this.maxSwapsInFrame = Math.max(this.maxSwapsInFrame, this.swapsInFrame);
      this.container.appendChild(element);
    }

    private getResult(): U2BatchBatchResult {
      let priority0BeforePriority1 = true;
      let lastPriority0Index = -1;
      let firstPriority1Index = Number.POSITIVE_INFINITY;
      this.processedKeys.forEach((key, index) => {
        if (this.priorityByKey.get(key) === 0) {
          lastPriority0Index = Math.max(lastPriority0Index, index);
        } else {
          firstPriority1Index = Math.min(firstPriority1Index, index);
        }
      });
      if (firstPriority1Index < lastPriority0Index) {
        priority0BeforePriority1 = false;
      }
      return {
        kind: this.kind,
        wallMs: 0,
        batches: this.batchCount,
        tasks: this.completed + this.failed,
        completed: this.completed,
        failed: this.failed,
        batchSize: this.batchSize,
        concurrency: this.concurrency,
        maxSwapPerFrame: this.maxSwapPerFrame,
        maxSwapsInFrameObserved: this.maxSwapsInFrame,
        generationMs: percentile(this.generationTimes),
        swapMs: percentile(this.swapTimes),
        batchMs: percentile(this.batchTimes),
        priority0BeforePriority1,
        priority0Keys: [...this.priority0Keys],
        processedKeys: [...this.processedKeys],
      };
    }
  }

  const runBatchedKind = async (
    kind: 'canvas-raster' | 'bitmap-data-url',
  ): Promise<U2BatchBatchResult> => {
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;';
    benchmarkHost.appendChild(container);
    const start = performance.now();
    const processor = new PageBatchProcessor(kind, container);
    processor.enqueue(input.formulas);
    const result = await processor.flush();
    result.wallMs = performance.now() - start;
    container.remove();
    return result;
  };

  const canvasInjection = measureInjection('canvas-raster');
  const bitmapInjection = measureInjection('bitmap-data-url');
  const usedAfterInjection = memory?.usedJSHeapSize ?? null;
  const canvasBatch = await runBatchedKind('canvas-raster');
  const bitmapBatch = await runBatchedKind('bitmap-data-url');
  const usedAfterBatch = memory?.usedJSHeapSize ?? null;
  const domAfterBatch = countDomNodes();
  window.setTimeout = nativeSetTimeout;

  const restoreSample = input.formulas[0];
  const restorePreview = document.createElement('span');
  restorePreview.innerHTML = restoreSample?.html ?? '';
  const restoreResult = {
    katexPresent: restorePreview.querySelector('.katex') !== null,
    restoredNodeCount: countSubtreeNodes(restorePreview),
  };

  const exportSample = input.formulas[0];
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
                  content: [{ type: 'text', text: 'u2bSearchTokenAlpha' }],
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
        found: docText.includes('u2bSearchTokenAlpha'),
      };
    } catch {
      editorSearch = { attempted: true, docText: '', found: false };
    }
  }

  benchmarkHost.remove();
  const usedAfterCleanup = memory?.usedJSHeapSize ?? null;
  const domAfterCleanup = countDomNodes();

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
      katexHtmlNodeCount: percentile(input.formulas.map((formula) => formula.htmlNodeCount)),
      candidateNodeCount: {
        'canvas-raster': percentile(input.formulas.map(() => 1)),
        'bitmap-data-url': percentile(input.formulas.map(() => 1)),
      },
      katexHtmlBytes: percentile(input.formulas.map((formula) => formula.htmlBytes)),
      candidateSerializedBytes: {
        'canvas-raster': percentile(input.formulas.map((formula) => formula.pngDpr2.length)),
        'bitmap-data-url': percentile(input.formulas.map((formula) => formula.pngDpr2.length)),
      },
    },
    injection: {
      'canvas-raster': canvasInjection,
      'bitmap-data-url': bitmapInjection,
    },
    baseline: {
      samples: baselineSamples,
      strictA,
      strictTextBaselineDeltaMaxPx: Math.max(0, ...strictA.map((sample) => sample.baselineDeltaPx)),
      strictTextBottomDeltaMaxPx: Math.max(
        0,
        ...strictA.map((sample) => Math.abs(sample.bottomDeltaToTextFontPx)),
      ),
      perFormulaInline: {
        bottomDeltaPx: percentile(inlineBottomDeltas),
        centerDeltaPx: percentile(inlineCenterDeltas),
        baselineDeltaPx: percentile(inlineBaselineDeltas),
      },
      perFormulaBlock: {
        heightDeltaPx: percentile(blockHeightDeltas),
        centerDeltaPx: percentile(blockCenterDeltas),
      },
    },
    highFormula: {
      total: input.formulas.length,
      overflowCount: highOverflowCount,
      cropCoveredCount: highCropCoveredCount,
      candidateCropDetectedCount: highCandidateCropDetectedCount,
      overflowTopMaxPx: highOverflowTopMax,
      overflowBottomMaxPx: highOverflowBottomMax,
    },
    dpr: {
      samples: dpr1VsDpr2MeanAbsDiffs.length,
      dpr2Scale: percentile(dpr2Scales),
      dpr1VsDpr2MeanAbsDiff: percentile(dpr1VsDpr2MeanAbsDiffs),
      dpr1VsDpr2DiffRatio: percentile(dpr1VsDpr2DiffRatios),
      clarityRatio: percentile(clarityRatios),
    },
    batch: {
      canvas: canvasBatch,
      bitmap: bitmapBatch,
      timers: {
        activeMax: maxActiveSetTimeout,
        totalCalls: totalSetTimeoutCalls,
        perFormulaCalls: totalSetTimeoutCalls / Math.max(input.formulas.length, 1),
      },
    },
    memory: {
      apiAvailable: memory != null,
      usedBeforeHarness,
      usedAfterImages,
      usedAfterMeasurement,
      usedAfterBatch,
      usedAfterCleanup,
      imageDelta:
        usedBeforeHarness !== null && usedAfterImages !== null
          ? usedAfterImages - usedBeforeHarness
          : null,
      measurementDelta:
        usedAfterImages !== null && usedAfterMeasurement !== null
          ? usedAfterMeasurement - usedAfterImages
          : null,
      batchDelta:
        usedAfterMeasurement !== null && usedAfterBatch !== null
          ? usedAfterBatch - usedAfterMeasurement
          : null,
      cleanupDelta:
        usedAfterBatch !== null && usedAfterCleanup !== null
          ? usedAfterCleanup - usedAfterBatch
          : null,
      domBeforeHarness,
      domAfterBatch,
      domAfterCleanup,
    },
    capabilities: {
      restore: restoreResult,
      export: exportResult,
      editorCopy,
      editorSearch,
    },
    formulaStats,
  };
}

async function waitForExclusiveBenchmarkLock(
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof acquireExclusiveBenchmarkRun>>> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await acquireExclusiveBenchmarkRun();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lockHeld =
        message.includes('marivell-benchmark.lock') ||
        message.includes('held by PID') ||
        message.includes('Only one marivell Electron performance task');
      if (!lockHeld) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the exclusive Electron benchmark lock: ${message}`);
      }
      await wait(2_000);
    }
  }
}

export interface U2BatchBaselinePoCOptions {
  sourceMarkdownPath?: string;
  corpusSize?: number;
  outDir?: string;
  profile?: string;
  port?: number;
  keepTempFiles?: boolean;
  lockTimeoutMs?: number;
}

export async function runU2BatchBaselinePoCE2E(
  options: U2BatchBaselinePoCOptions = {},
): Promise<U2BatchE2EResult> {
  const sourceMarkdown =
    options.sourceMarkdownPath ??
    process.env.MARIVELL_U2B_POC_SOURCE ??
    defaultSourceMarkdown;
  const corpusSize = options.corpusSize ?? 200;
  if (corpusSize < 200 || corpusSize % 2 !== 0) {
    throw new Error(`corpusSize must be at least 200 and even: ${corpusSize}`);
  }

  const exclusiveRun = await waitForExclusiveBenchmarkLock(
    options.lockTimeoutMs ?? 180_000,
  );
  const corpus = buildFormulaCorpus(sourceMarkdown, corpusSize);
  const markdownPath = path.join(os.tmpdir(), `marivell-u2b-batch-baseline-${process.pid}.md`);
  fs.writeFileSync(
    markdownPath,
    '# U2 batch baseline PoC\n\nSmall placeholder file used only to host the benchmark window.\n',
    'utf8',
  );
  const outDir =
    options.outDir ?? path.join(os.tmpdir(), `marivell-u2b-build-${process.pid}`);
  const profile =
    options.profile ?? path.join(os.tmpdir(), `marivell-u2b-profile-${process.pid}`);
  const port = options.port ?? 10500 + (process.pid % 200);

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
    const prepared = await handle.page.evaluate(
      prepareFormulaScreenshotHost,
      corpus.sample,
    );
    const captured = await captureFormulaRepresentations(handle.page, prepared);
    const page = await handle.page.evaluate(runU2BatchBenchmarkInPage, {
      formulas: captured,
    } satisfies U2BatchPageInput);
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
    const searchQuery =
      prototypeCandidates.find((candidate) => candidate.latex.includes('x'))?.latex ?? 'x';
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
      dpr1DataUrl: firstCaptured?.pngDpr1,
      cssWidth: firstCaptured?.cssWidth,
      cssHeight: firstCaptured?.cssHeight,
      decodedPngBytes: firstCaptured?.decodedPngBytes,
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
      corpus,
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
    await exclusiveRun.release();
  }
}

function formatSummary(result: U2BatchE2EResult): Record<string, unknown> {
  return {
    sourceMarkdown: result.sourceMarkdown,
    corpus: result.corpus,
    buildMs: Math.round(result.buildMs * 10) / 10,
    launchMs: Math.round(result.launchMs * 10) / 10,
    readyMs: Math.round(result.readyMs * 10) / 10,
    environment: result.page.environment,
    dom: result.page.dom,
    injection: result.page.injection,
    baseline: result.page.baseline,
    highFormula: result.page.highFormula,
    dpr: result.page.dpr,
    batch: result.page.batch,
    memory: result.page.memory,
    capabilities: result.page.capabilities,
    nodeCapabilities: result.nodeCapabilities,
  };
}

async function main(): Promise<void> {
  const sourceArg = process.argv[2];
  const sourceMarkdown =
    sourceArg && sourceArg !== '--default' ? path.resolve(sourceArg) : undefined;
  const result = await runU2BatchBaselinePoCE2E({ sourceMarkdownPath: sourceMarkdown });
  const rawPath = path.join(os.tmpdir(), `marivell-u2b-batch-baseline-${Date.now()}.json`);
  fs.writeFileSync(rawPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(formatSummary(result), null, 2));
  console.log(`\nSaved raw U2 batch baseline PoC JSON to ${rawPath}`);
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

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core';
import type { ResourceSnapshot } from './resource-metrics.ts';
import { readRendererResources } from './resource-metrics.ts';
import { parseMarkdown } from '../../src/renderer/editor/markdown';
import { markdownOffsetToPmPos } from '../../src/renderer/editor/position-map';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const electronBin = path.join(projectRoot, 'node_modules/.bin/electron');
const electronViteBin = path.join(projectRoot, 'node_modules/.bin/electron-vite');

export type U4HostStrategy = 'display-none' | 'left-offscreen' | 'transform-offscreen';

export interface PercentileSummary {
  count: number;
  min: number;
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

export interface CdpMetrics {
  taskDuration: number;
  scriptDuration: number;
  layoutDuration: number;
  layoutCount: number;
  recalcStyleDuration: number;
  recalcStyleCount: number;
  paintDuration: number;
  compositeDuration: number;
  taskCount: number;
}

export interface LongTaskSummary {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface ModeSwitchSample {
  wallMs: number;
  firstScrollTop: number;
  firstScrollRatio: number;
  finalScrollTop: number;
  finalScrollRatio: number;
  cdp: CdpMetrics;
  longTasks: LongTaskSummary;
  phases: Array<{ name: string; ms: number }>;
}

export interface HostSnapshot {
  elements: number;
  textNodes: number;
  totalNodes: number;
  katexCount: number;
  inlineActive: number;
  inlinePlaceholder: number;
  syntaxCount: number;
  display: string;
  visibility: string;
  pointerEvents: string;
  left: number;
  top: number;
  width: number;
  height: number;
  layoutActive: boolean;
  computedTransform: string;
  computedWillChange: string;
}

export interface VisualCaretResult {
  from: number;
  to: number;
  empty: boolean;
  coords: { left: number; top: number; right: number; bottom: number } | null;
  frame: { left: number; top: number; right: number; bottom: number };
  mappedPos: number | null;
  mappedInside: number | null;
  markerLeak: boolean;
  sourceContainsMarker: boolean;
  textLength: number;
}

export interface ModeCounters {
  fast: number;
  fullParse: number;
  fullSerialize: number;
}

export interface MemorySnapshot {
  performanceMemoryMb: number | null;
  cdpHeapMb: number | null;
  rendererWorkingSetMb: number | null;
  domTotalNodes: number;
}

export interface StrategyMemory {
  before: MemorySnapshot;
  afterForcedGc: MemorySnapshot;
  afterEachRoundCdpHeapMb: number[];
  afterEachRoundPerformanceHeapMb: number[];
  rawSlopeMbPerRound: number | null;
  forcedGcDeltaMb: number | null;
  gcAvailable: boolean;
  sourceHostAfterFirst: HostSnapshot | null;
  sourceHostAfterLast: HostSnapshot | null;
  visualHostAfterLast: HostSnapshot | null;
}

export interface StrategyBehavior {
  countersBefore: ModeCounters;
  countersAfter: ModeCounters;
  fastDelta: number;
  fullParseDelta: number;
  fullSerializeDelta: number;
  markerLeak: boolean;
  lastCaret: VisualCaretResult | null;
  expectedCaretFrom: number | null;
  caretDelta: number | null;
  caretCoordsInsideFrame: boolean;
  posAtCoordsNearSelection: boolean;
}

export interface StrategyResult {
  strategy: U4HostStrategy;
  environment: {
    frameScrollHeight: number;
    frameClientHeight: number;
    maxScrollTop: number;
    hostDomCount: number;
    sourceBytes: number;
  };
  visualToSource: ModeSwitchSample[];
  sourceToVisual: ModeSwitchSample[];
  visualToSourceSummary: {
    wallMs: PercentileSummary;
    layoutDurationDelta: PercentileSummary;
    layoutCountDelta: PercentileSummary;
    scriptDurationDelta: PercentileSummary;
    recalcStyleDurationDelta: PercentileSummary;
    compositeDurationDelta: PercentileSummary;
    longTasks: LongTaskSummary;
    firstScrollRatio: PercentileSummary;
  };
  sourceToVisualSummary: {
    wallMs: PercentileSummary;
    layoutDurationDelta: PercentileSummary;
    layoutCountDelta: PercentileSummary;
    scriptDurationDelta: PercentileSummary;
    recalcStyleDurationDelta: PercentileSummary;
    compositeDurationDelta: PercentileSummary;
    longTasks: LongTaskSummary;
    firstScrollRatio: PercentileSummary;
  };
  memory: StrategyMemory;
  behavior: StrategyBehavior;
}

export interface U4Decision {
  baseline: U4HostStrategy;
  candidate: U4HostStrategy;
  visualToSourceNotWorse: boolean;
  sourceToVisualNotWorse: boolean;
  visualToSourceThresholdMs: number;
  sourceToVisualThresholdMs: number;
  enterU41: boolean;
}

export interface U4ModeSwitchE2EResult {
  markdownPath: string;
  sourceBytes: number;
  buildMs: number;
  strategies: StrategyResult[];
  decision: U4Decision;
}

interface ElectronHandle {
  child: ReturnType<typeof spawn>;
  browser: Browser;
  page: Page;
  port: number;
}

const NOT_WORSE_MULTIPLIER = 1.1;
const NOT_WORSE_MS = 10;
const DEFAULT_CYCLES = 10;
const SWITCH_DEADLINE_MS = 30_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildRenderer(outDir: string): Promise<number> {
  fs.mkdirSync(outDir, { recursive: true });
  const startedAt = Date.now();
  await execFileAsync(
    electronViteBin,
    ['build', '--outDir', outDir, '--logLevel', 'warn'],
    { cwd: projectRoot, env: { ...process.env } },
  );
  const nodeModules = path.join(outDir, 'node_modules');
  if (!fs.existsSync(nodeModules)) {
    fs.symlinkSync(path.join(projectRoot, 'node_modules'), nodeModules, 'dir');
  }
  return Date.now() - startedAt;
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
  return { child, browser, page, port };
}

async function waitForVisualReady(
  page: Page,
  expectedTextLength: number,
  deadlineMs: number,
): Promise<number> {
  return page.evaluate(
    async ({ expectedTextLength, deadlineMs }) => {
      const start = performance.now();
      const deadline = start + deadlineMs;
      while (performance.now() < deadline) {
        const loading = document.querySelector('.editor-loading');
        const surface = document.querySelector<HTMLElement>('.editor-surface');
        const frame = document.querySelector<HTMLElement>('.editor-frame');
        const editor = (window as unknown as {
          __marivellEditor?: { state?: { doc?: { nodeSize?: number } } };
        }).__marivellEditor;
        const nodeReady = Boolean(
          editor?.state?.doc &&
            (editor.state.doc.nodeSize ?? 0) > Math.min(expectedTextLength, 500_000),
        );
        const textReady = Boolean(
          surface && surface.innerText.length > Math.min(expectedTextLength, 100_000),
        );
        if (!loading && surface && frame && (nodeReady || textReady)) {
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          return performance.now() - start;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('visual editor did not become ready');
    },
    { expectedTextLength, deadlineMs },
  );
}

async function installLongTaskObserver(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const target = window;
    target.__u4LongTasks = [];
    target.__u4LongObserver?.disconnect?.();
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const timing = entry;
        target.__u4LongTasks.push({
          startTime: timing.startTime,
          duration: timing.duration,
          name: timing.name,
        });
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
    target.__u4LongObserver = observer;
  })()`);
}

async function clearLongTasks(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const target = window;
    target.__u4LongTasks = [];
  })()`);
}

async function takeLongTasks(page: Page): Promise<LongTaskSummary> {
  const tasks = (await page.evaluate(`(() => {
    return (window.__u4LongTasks ?? []).map((task) => ({
      duration: task.duration,
    }));
  })()`)) as Array<{ duration: number }>;
  return {
    count: tasks.length,
    totalMs: tasks.reduce((sum, task) => sum + task.duration, 0),
    maxMs: tasks.reduce((max, task) => Math.max(max, task.duration), 0),
  };
}

async function installHostStrategy(page: Page, strategy: U4HostStrategy): Promise<void> {
  await page.evaluate((strategy) => {
    let style = document.querySelector<HTMLStyleElement>('#u4-host-strategy-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'u4-host-strategy-style';
      document.head.appendChild(style);
    }
    if (strategy === 'display-none') {
      style.textContent = '';
      return;
    }
    const offscreen =
      strategy === 'left-offscreen'
        ? 'left:-10000px;transform:none;will-change:auto;contain:layout style;'
        : 'left:0;transform:translate3d(-10000px,0,0);will-change:transform;contain:layout style paint;';
    style.textContent = `
      .editor-frame.is-source .editor-host {
        display:block !important;
        position:absolute !important;
        top:0 !important;
        width:100% !important;
        visibility:hidden !important;
        pointer-events:none !important;
        z-index:-1 !important;
        ${offscreen}
      }
    `;
  }, strategy);
}

async function readCounters(page: Page): Promise<ModeCounters> {
  return page.evaluate(() => {
    const target = window as unknown as Record<string, number | undefined>;
    return {
      fast: target.__marivellModeSwitchFastPath ?? 0,
      fullParse: target.__marivellModeSwitchFullParse ?? 0,
      fullSerialize: target.__marivellModeSwitchFullSerialize ?? 0,
    };
  });
}

async function readCdpMetrics(session: CDPSession): Promise<CdpMetrics> {
  await session.send('Performance.enable').catch(() => {});
  const result = (await session.send('Performance.getMetrics')) as {
    metrics: Array<{ name: string; value: number }>;
  };
  const values = new Map(result.metrics.map((metric) => [metric.name, metric.value]));
  const read = (name: string): number => values.get(name) ?? 0;
  return {
    taskDuration: read('TaskDuration'),
    scriptDuration: read('ScriptDuration'),
    layoutDuration: read('LayoutDuration'),
    layoutCount: read('LayoutCount'),
    recalcStyleDuration: read('RecalcStyleDuration'),
    recalcStyleCount: read('RecalcStyleCount'),
    paintDuration: read('PaintDuration'),
    compositeDuration: read('CompositeDuration'),
    taskCount: read('TaskCount'),
  };
}

function cdpDelta(before: CdpMetrics, after: CdpMetrics): CdpMetrics {
  return {
    taskDuration: Math.max(after.taskDuration - before.taskDuration, 0),
    scriptDuration: Math.max(after.scriptDuration - before.scriptDuration, 0),
    layoutDuration: Math.max(after.layoutDuration - before.layoutDuration, 0),
    layoutCount: Math.max(after.layoutCount - before.layoutCount, 0),
    recalcStyleDuration: Math.max(
      after.recalcStyleDuration - before.recalcStyleDuration,
      0,
    ),
    recalcStyleCount: Math.max(after.recalcStyleCount - before.recalcStyleCount, 0),
    paintDuration: Math.max(after.paintDuration - before.paintDuration, 0),
    compositeDuration: Math.max(after.compositeDuration - before.compositeDuration, 0),
    taskCount: Math.max(after.taskCount - before.taskCount, 0),
  };
}

async function forceGc(session: CDPSession): Promise<boolean> {
  try {
    await session.send('HeapProfiler.enable');
    await session.send('HeapProfiler.collectGarbage');
    return true;
  } catch {
    return false;
  }
}

function heapBytes(snapshot: ResourceSnapshot): number | null {
  return snapshot.heap.cdp?.usedSize ?? snapshot.heap.performanceMemory?.usedJSHeapSize ?? null;
}

function rendererWorkingSetMb(snapshot: ResourceSnapshot): number | null {
  const renderer = snapshot.appMetrics.metrics.find(
    (metric) => metric.pid === snapshot.appMetrics.rendererProcessId,
  ) ?? snapshot.appMetrics.metrics.find((metric) => metric.type === 'Tab');
  return renderer ? renderer.memory.workingSetSize / 1024 / 1024 : null;
}

function memorySnapshot(snapshot: ResourceSnapshot): MemorySnapshot {
  return {
    performanceMemoryMb:
      snapshot.heap.performanceMemory === null
        ? null
        : snapshot.heap.performanceMemory.usedJSHeapSize / 1024 / 1024,
    cdpHeapMb: heapBytes(snapshot) === null ? null : (heapBytes(snapshot) ?? 0) / 1024 / 1024,
    rendererWorkingSetMb: rendererWorkingSetMb(snapshot),
    domTotalNodes: snapshot.dom.totalNodes,
  };
}

async function collectHostSnapshot(page: Page): Promise<HostSnapshot> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.editor-host');
    if (!host) {
      throw new Error('editor host missing');
    }
    const elements = host.querySelectorAll('*').length + 1;
    let textNodes = 0;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      textNodes += 1;
    }
    const rect = host.getBoundingClientRect();
    const style = getComputedStyle(host);
    return {
      elements,
      textNodes,
      totalNodes: elements + textNodes,
      katexCount: host.querySelectorAll('.math-node-preview .katex').length,
      inlineActive: Array.from(host.querySelectorAll<HTMLElement>('.math-inline-node')).filter(
        (node) => node.querySelector(':scope > .math-node-preview .katex'),
      ).length,
      inlinePlaceholder: host.querySelectorAll('.math-inline-node--placeholder').length,
      syntaxCount: host.querySelectorAll('[class*="math-syntax-"]').length,
      display: style.display,
      visibility: style.visibility,
      pointerEvents: style.pointerEvents,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      layoutActive: rect.width > 0 || rect.height > 0,
      computedTransform: style.transform,
      computedWillChange: style.willChange,
    };
  });
}

async function collectVisualCaret(page: Page): Promise<VisualCaretResult> {
  return page.evaluate(async () => {
    const editor = (window as unknown as {
      __marivellEditor?: {
        state: {
          selection: { from: number; to: number; empty: boolean };
          doc: { content: { size: number }; textBetween: (from: number, to: number) => string };
        };
        view: {
          coordsAtPos: (pos: number) => {
            left: number;
            top: number;
            right: number;
            bottom: number;
          } | null;
          posAtCoords: (coords: { left: number; top: number }) => {
            pos: number;
            inside: number;
          } | null;
        };
        getJSON: () => unknown;
      };
    }).__marivellEditor;
    const frame = document.querySelector<HTMLElement>('.editor-frame');
    const surface = document.querySelector<HTMLElement>('.editor-surface');
    if (!editor || !frame || !surface) {
      throw new Error('visual editor missing');
    }
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    const selection = editor.state.selection;
    const size = editor.state.doc.content.size;
    const coords = editor.view.coordsAtPos(selection.from);
    const frameRect = frame.getBoundingClientRect();
    const mapped = coords ? editor.view.posAtCoords({ left: coords.left, top: coords.top }) : null;
    return {
      from: selection.from,
      to: selection.to,
      empty: selection.empty,
      coords,
      frame: {
        left: frameRect.left,
        top: frameRect.top,
        right: frameRect.right,
        bottom: frameRect.bottom,
      },
      mappedPos: mapped?.pos ?? null,
      mappedInside: mapped?.inside ?? null,
      markerLeak:
        surface.innerText.includes('MDEDITORSELECTION') ||
        JSON.stringify(editor.getJSON()).includes('MDEDITORSELECTION'),
      sourceContainsMarker: document
        .querySelector<HTMLTextAreaElement>('.source-editor__input')
        ?.value.includes('MDEDITORSELECTION') ?? false,
      textLength: surface.innerText.length,
    };
  });
}

async function switchOnce(
  page: Page,
  input: {
    strategy: U4HostStrategy;
    target: 'source' | 'visual';
    scrollRatio: number;
    selectionStart?: number;
    selectionEnd?: number;
  },
): Promise<{
  wallMs: number;
  firstScrollTop: number;
  firstScrollRatio: number;
  finalScrollTop: number;
  finalScrollRatio: number;
  phases: Array<{ name: string; ms: number }>;
}> {
  return page.evaluate(
    async (input) => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      if (!frame) {
        throw new Error('editor frame missing');
      }
      const target = window as unknown as {
        __marivellModeSwitchPhases?: Array<{ name: string; ms: number }>;
        __u4Strategy?: string;
      };
      target.__marivellModeSwitchPhases = [];
      const start = performance.now();
      const deadline = start + 30_000;
      const isHostStyleReady = (): boolean => {
        const host = document.querySelector<HTMLElement>('.editor-host');
        if (!host || !frame.classList.contains('is-source')) {
          return true;
        }
        const style = getComputedStyle(host);
        if (input.strategy === 'display-none') {
          return style.display === 'none';
        }
        if (style.display === 'none' || style.visibility !== 'hidden') {
          return false;
        }
        if (input.strategy === 'left-offscreen') {
          return style.left === '-10000px';
        }
        return (
          style.transform.includes('-10000') &&
          style.willChange === 'transform'
        );
      };
      const scrollRatio = Math.min(1, Math.max(0, input.scrollRatio));
      if (input.target === 'source') {
        const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
        frame.scrollTop = maxScrollTop * scrollRatio;
      } else {
        const sourceInput = document.querySelector<HTMLTextAreaElement>('.source-editor__input');
        if (!sourceInput) {
          throw new Error('source input missing before source->visual switch');
        }
        const maxScrollTop = Math.max(sourceInput.scrollHeight - sourceInput.clientHeight, 0);
        sourceInput.scrollTop = maxScrollTop * scrollRatio;
        sourceInput.focus({ preventScroll: true });
        if (input.selectionStart !== undefined && input.selectionEnd !== undefined) {
          sourceInput.setSelectionRange(input.selectionStart, input.selectionEnd);
          sourceInput.dispatchEvent(new Event('select', { bubbles: true }));
        }
      }
      window.dispatchEvent(
        new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-source-mode' }),
      );

      let first: { time: number; scrollTop: number; ratio: number } | null = null;
      while (performance.now() < deadline) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const currentFrame = document.querySelector<HTMLElement>('.editor-frame');
        const sourceInput = document.querySelector<HTMLTextAreaElement>('.source-editor__input');
        const overlay = document.querySelector<HTMLElement>('.editor-loading--mode-switch');
        const isSource = Boolean(currentFrame?.classList.contains('is-source'));
        const ready =
          input.target === 'source'
            ? isSource && Boolean(sourceInput) && !overlay && isHostStyleReady()
            : !isSource && !sourceInput && !overlay && !currentFrame?.querySelector('.editor-loading--mode-switch');
        if (!ready) {
          continue;
        }
        const scrollEl = input.target === 'source'
          ? sourceInput
          : currentFrame;
        const scrollTop = scrollEl?.scrollTop ?? 0;
        const maxScrollTop = Math.max((scrollEl?.scrollHeight ?? 1) - (scrollEl?.clientHeight ?? 0), 0);
        const ratio = maxScrollTop > 0 ? scrollTop / maxScrollTop : 0;
        if (!first) {
          first = {
            time: performance.now() - start,
            scrollTop,
            ratio,
          };
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const finalScrollEl = input.target === 'source'
          ? document.querySelector<HTMLTextAreaElement>('.source-editor__input')
          : document.querySelector<HTMLElement>('.editor-frame');
        const finalScrollTop = finalScrollEl?.scrollTop ?? 0;
        const finalMax = Math.max((finalScrollEl?.scrollHeight ?? 1) - (finalScrollEl?.clientHeight ?? 0), 0);
        const finalRatio = finalMax > 0 ? finalScrollTop / finalMax : 0;
        return {
          wallMs: performance.now() - start,
          firstScrollTop: first.scrollTop,
          firstScrollRatio: first.ratio,
          finalScrollTop,
          finalScrollRatio: finalRatio,
          phases: target.__marivellModeSwitchPhases ?? [],
        };
      }
      throw new Error(`mode switch to ${input.target} timed out`);
    },
    {
      strategy: input.strategy,
      target: input.target,
      scrollRatio: input.scrollRatio,
      selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd,
    },
  );
}

function percentileSummary(values: number[]): PercentileSummary {
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

function summaryForSamples(samples: ModeSwitchSample[]): StrategyResult['visualToSourceSummary'] {
  return {
    wallMs: percentileSummary(samples.map((sample) => sample.wallMs)),
    layoutDurationDelta: percentileSummary(samples.map((sample) => sample.cdp.layoutDuration)),
    layoutCountDelta: percentileSummary(samples.map((sample) => sample.cdp.layoutCount)),
    scriptDurationDelta: percentileSummary(samples.map((sample) => sample.cdp.scriptDuration)),
    recalcStyleDurationDelta: percentileSummary(
      samples.map((sample) => sample.cdp.recalcStyleDuration),
    ),
    compositeDurationDelta: percentileSummary(
      samples.map((sample) => sample.cdp.compositeDuration),
    ),
    longTasks: {
      count: samples.reduce((sum, sample) => sum + sample.longTasks.count, 0),
      totalMs: samples.reduce((sum, sample) => sum + sample.longTasks.totalMs, 0),
      maxMs: samples.reduce((max, sample) => Math.max(max, sample.longTasks.maxMs), 0),
    },
    firstScrollRatio: percentileSummary(samples.map((sample) => sample.firstScrollRatio)),
  };
}

function linearSlopePerRound(valuesMb: number[]): number | null {
  if (valuesMb.length < 2) {
    return null;
  }
  const n = valuesMb.length;
  const xs = valuesMb.map((_, index) => index);
  const sumX = xs.reduce((sum, value) => sum + value, 0);
  const sumY = valuesMb.reduce((sum, value) => sum + value, 0);
  const sumXY = xs.reduce((sum, value, index) => sum + value * valuesMb[index]!, 0);
  const sumXX = xs.reduce((sum, value) => sum + value * value, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) {
    return null;
  }
  return (n * sumXY - sumX * sumY) / denominator;
}

function generateSmallMarkdown(): string {
  const parts: string[] = [];
  const targetNeedle = 'U4_CARET_TARGET';
  for (let index = 0; index < 280; index += 1) {
    parts.push(`## Section ${index}\n`);
    const needle = index === 117 ? ` ${targetNeedle} ` : '';
    parts.push(
      `Paragraph ${index}${needle}has bounded inline math $\\frac{x_{${index}}}{y_{${index}}}$ and enough plain text to keep source and visual scroll heights stable for mode switching: ${index} ${index} ${index} ${index} ${index}.\n`,
    );
    if (index % 7 === 0) {
      parts.push(`- list item ${index} alpha\n- list item ${index} beta\n`);
    }
    if (index % 13 === 0) {
      parts.push('$$\n\\int_0^1 x^2 + \\frac{1}{n}\\,dx\n$$\n');
    }
    if (index % 19 === 0) {
      parts.push('```ts\nconst sample = 1 + 2;\n```\n');
    }
  }
  return parts.join('\n');
}

function findCaretOffset(source: string): number {
  const index = source.indexOf('U4_CARET_TARGET');
  if (index === -1) {
    throw new Error('caret target not found');
  }
  return index + 2;
}

async function runStrategy(
  strategy: U4HostStrategy,
  options: {
    outDir: string;
    markdownPath: string;
    source: string;
    port: number;
    profile: string;
    cycles: number;
  },
): Promise<StrategyResult> {
  const handle = await launchElectron(options.outDir, options.markdownPath, options.port, options.profile);
  const session = await handle.page.context().newCDPSession(handle.page);
  try {
    const readyMs = await waitForVisualReady(handle.page, Math.min(options.source.length, 200_000), 60_000);
    await installLongTaskObserver(handle.page);
    await installHostStrategy(handle.page, strategy);
    await handle.page.evaluate(() => {
      const benchmarkWindow = window as unknown as {
        __name?: (fn: unknown) => unknown;
      };
      benchmarkWindow.__name = (fn: unknown): unknown => fn;
    });
    const gcAvailable = await forceGc(session);
    await wait(500);
    const heapBeforeSnapshot = await readRendererResources(handle.page);
    const environment = await handle.page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      const host = document.querySelector<HTMLElement>('.editor-host');
      if (!frame || !host) {
        throw new Error('editor frame/host missing');
      }
      return {
        frameScrollHeight: frame.scrollHeight,
        frameClientHeight: frame.clientHeight,
        maxScrollTop: Math.max(frame.scrollHeight - frame.clientHeight, 0),
        hostDomCount: host.querySelectorAll('*').length + 1,
      };
    });
    const countersBefore = await readCounters(handle.page);
    const caretOffset = findCaretOffset(options.source);
    const parsed = parseMarkdown(options.source);
    const expectedCaretFrom = markdownOffsetToPmPos(options.source, parsed, caretOffset);
    const visualToSource: ModeSwitchSample[] = [];
    const sourceToVisual: ModeSwitchSample[] = [];
    const afterEachRoundCdpHeapMb: number[] = [];
    const afterEachRoundPerformanceHeapMb: number[] = [];
    let sourceHostAfterFirst: HostSnapshot | null = null;
    let sourceHostAfterLast: HostSnapshot | null = null;
    let visualHostAfterLast: HostSnapshot | null = null;
    let markerLeak = false;
    let lastCaret: VisualCaretResult | null = null;

    for (let round = 0; round < options.cycles; round += 1) {
      await clearLongTasks(handle.page);
      const v2sBefore = await readCdpMetrics(session);
      const v2sRaw = await switchOnce(handle.page, {
        strategy,
        target: 'source',
        scrollRatio: 0.7,
      });
      const v2sAfter = await readCdpMetrics(session);
      const v2sLongTasks = await takeLongTasks(handle.page);
      visualToSource.push({
        wallMs: v2sRaw.wallMs,
        firstScrollTop: v2sRaw.firstScrollTop,
        firstScrollRatio: v2sRaw.firstScrollRatio,
        finalScrollTop: v2sRaw.finalScrollTop,
        finalScrollRatio: v2sRaw.finalScrollRatio,
        cdp: cdpDelta(v2sBefore, v2sAfter),
        longTasks: v2sLongTasks,
        phases: v2sRaw.phases,
      });
      if (round === 0) {
        sourceHostAfterFirst = await collectHostSnapshot(handle.page);
      }
      if (round === options.cycles - 1) {
        sourceHostAfterLast = await collectHostSnapshot(handle.page);
      }

      await clearLongTasks(handle.page);
      const s2vBefore = await readCdpMetrics(session);
      const s2vRaw = await switchOnce(handle.page, {
        strategy,
        target: 'visual',
        scrollRatio: round === options.cycles - 1 ? 0.42 : 0.72,
        selectionStart: caretOffset,
        selectionEnd: caretOffset,
      });
      const s2vAfter = await readCdpMetrics(session);
      const s2vLongTasks = await takeLongTasks(handle.page);
      sourceToVisual.push({
        wallMs: s2vRaw.wallMs,
        firstScrollTop: s2vRaw.firstScrollTop,
        firstScrollRatio: s2vRaw.firstScrollRatio,
        finalScrollTop: s2vRaw.finalScrollTop,
        finalScrollRatio: s2vRaw.finalScrollRatio,
        cdp: cdpDelta(s2vBefore, s2vAfter),
        longTasks: s2vLongTasks,
        phases: s2vRaw.phases,
      });
      const caret = await collectVisualCaret(handle.page);
      lastCaret = caret;
      markerLeak ||= caret.markerLeak || caret.sourceContainsMarker;
      if (round === options.cycles - 1) {
        visualHostAfterLast = await collectHostSnapshot(handle.page);
      }
      if (gcAvailable) {
        await forceGc(session);
      }
      const heapAfterRound = await readRendererResources(handle.page);
      afterEachRoundCdpHeapMb.push(
        heapBytes(heapAfterRound) === null ? 0 : (heapBytes(heapAfterRound) ?? 0) / 1024 / 1024,
      );
      afterEachRoundPerformanceHeapMb.push(
        heapAfterRound.heap.performanceMemory === null
          ? 0
          : heapAfterRound.heap.performanceMemory.usedJSHeapSize / 1024 / 1024,
      );
    }

    if (gcAvailable) {
      await forceGc(session);
    }
    const heapAfterSnapshot = await readRendererResources(handle.page);
    const countersAfter = await readCounters(handle.page);
    const behavior: StrategyBehavior = {
      countersBefore,
      countersAfter,
      fastDelta: countersAfter.fast - countersBefore.fast,
      fullParseDelta: countersAfter.fullParse - countersBefore.fullParse,
      fullSerializeDelta: countersAfter.fullSerialize - countersBefore.fullSerialize,
      markerLeak,
      lastCaret,
      expectedCaretFrom,
      caretDelta:
        lastCaret === null || expectedCaretFrom === null
          ? null
          : Math.abs(lastCaret.from - expectedCaretFrom),
      caretCoordsInsideFrame:
        lastCaret?.coords !== null &&
        lastCaret?.frame !== undefined &&
        lastCaret.coords !== null &&
        lastCaret.coords.left >= lastCaret.frame.left - 2 &&
        lastCaret.coords.right <= lastCaret.frame.right + 2 &&
        lastCaret.coords.top >= lastCaret.frame.top - 2 &&
        lastCaret.coords.bottom <= lastCaret.frame.bottom + 2,
      posAtCoordsNearSelection:
        lastCaret?.mappedPos !== null &&
        lastCaret !== null &&
        Math.abs((lastCaret.mappedPos ?? -1) - lastCaret.from) <= 8,
    };

    const rawSlopeMbPerRound = linearSlopePerRound(afterEachRoundCdpHeapMb);
    const startHeapMb = heapBytes(heapBeforeSnapshot);
    const endHeapMb = heapBytes(heapAfterSnapshot);
    return {
      strategy,
      environment: {
        ...environment,
        sourceBytes: options.source.length,
      },
      visualToSource,
      sourceToVisual,
      visualToSourceSummary: summaryForSamples(visualToSource),
      sourceToVisualSummary: summaryForSamples(sourceToVisual),
      memory: {
        before: memorySnapshot(heapBeforeSnapshot),
        afterForcedGc: memorySnapshot(heapAfterSnapshot),
        afterEachRoundCdpHeapMb,
        afterEachRoundPerformanceHeapMb,
        rawSlopeMbPerRound,
        forcedGcDeltaMb:
          startHeapMb !== null && endHeapMb !== null
            ? (endHeapMb - startHeapMb) / 1024 / 1024
            : null,
        gcAvailable,
        sourceHostAfterFirst,
        sourceHostAfterLast,
        visualHostAfterLast,
      },
      behavior,
    };
  } finally {
    if (session) {
      await session.detach().catch(() => {});
    }
    if (handle) {
      const childPid = handle.child.pid;
      if (process.platform !== 'win32') {
        try {
          if (childPid !== undefined) {
            process.kill(-childPid, 'SIGKILL');
          }
        } catch {
          // Process group may already be gone.
        }
      }
      handle.child.kill('SIGKILL');
      await handle.browser.close().catch(() => {});
    }
  }
}

function summarizeStrategy(result: StrategyResult): Record<string, unknown> {
  return {
    strategy: result.strategy,
    environment: result.environment,
    visualToSource: result.visualToSourceSummary,
    sourceToVisual: result.sourceToVisualSummary,
    memory: {
      before: result.memory.before,
      afterForcedGc: result.memory.afterForcedGc,
      rawSlopeMbPerRound: result.memory.rawSlopeMbPerRound,
      forcedGcDeltaMb: result.memory.forcedGcDeltaMb,
      sourceHostAfterFirst: result.memory.sourceHostAfterFirst,
      sourceHostAfterLast: result.memory.sourceHostAfterLast,
      visualHostAfterLast: result.memory.visualHostAfterLast,
    },
    behavior: result.behavior,
  };
}

export async function runU4ModeSwitchPocE2E(options?: {
  markdownPath?: string;
  cycles?: number;
  keepTempFiles?: boolean;
}): Promise<U4ModeSwitchE2EResult> {
  const cycles = options?.cycles ?? DEFAULT_CYCLES;
  const source =
    options?.markdownPath && fs.existsSync(options.markdownPath)
      ? fs.readFileSync(options.markdownPath, 'utf8')
      : generateSmallMarkdown();
  const markdownPath =
    options?.markdownPath && fs.existsSync(options.markdownPath)
      ? options.markdownPath
      : path.join(os.tmpdir(), `marivell-u4-mode-switch-${process.pid}.md`);
  if (!options?.markdownPath || !fs.existsSync(options.markdownPath)) {
    fs.writeFileSync(markdownPath, source, 'utf8');
  }
  const outDir = path.join(os.tmpdir(), `marivell-u4-build-${process.pid}`);
  const strategies: U4HostStrategy[] = ['display-none', 'left-offscreen', 'transform-offscreen'];
  const results: StrategyResult[] = [];
  let buildMs = 0;
  try {
    buildMs = await buildRenderer(outDir);
    for (let index = 0; index < strategies.length; index += 1) {
      const strategy = strategies[index]!;
      const profile = path.join(os.tmpdir(), `marivell-u4-profile-${process.pid}-${index}`);
      const port = 10100 + ((process.pid + index * 7) % 100);
      const result = await runStrategy(strategy, {
        outDir,
        markdownPath,
        source,
        port,
        profile,
        cycles,
      });
      results.push(result);
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  } finally {
    if (!options?.keepTempFiles) {
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
        if (!options?.markdownPath) {
          fs.rmSync(markdownPath, { force: true });
        }
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  const baseline = results.find((result) => result.strategy === 'display-none');
  const candidate = results.find((result) => result.strategy === 'transform-offscreen');
  if (!baseline || !candidate) {
    throw new Error('U4 comparison strategies missing');
  }
  const visualToSourceThresholdMs =
    baseline.visualToSourceSummary.wallMs.p50 * NOT_WORSE_MULTIPLIER + NOT_WORSE_MS;
  const sourceToVisualThresholdMs =
    baseline.sourceToVisualSummary.wallMs.p50 * NOT_WORSE_MULTIPLIER + NOT_WORSE_MS;
  const visualToSourceNotWorse =
    candidate.visualToSourceSummary.wallMs.p50 <= visualToSourceThresholdMs;
  const sourceToVisualNotWorse =
    candidate.sourceToVisualSummary.wallMs.p50 <= sourceToVisualThresholdMs;
  return {
    markdownPath,
    sourceBytes: source.length,
    buildMs,
    strategies: results,
    decision: {
      baseline: 'display-none',
      candidate: 'transform-offscreen',
      visualToSourceNotWorse,
      sourceToVisualNotWorse,
      visualToSourceThresholdMs,
      sourceToVisualThresholdMs,
      enterU41: visualToSourceNotWorse && sourceToVisualNotWorse,
    },
  };
}

function formatSummary(result: U4ModeSwitchE2EResult): Record<string, unknown> {
  return {
    markdownPath: result.markdownPath,
    sourceBytes: result.sourceBytes,
    buildMs: Math.round(result.buildMs * 10) / 10,
    decision: result.decision,
    strategies: result.strategies.map(summarizeStrategy),
  };
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const markdownPath = arg && arg !== '--default' ? path.resolve(arg) : undefined;
  const result = await runU4ModeSwitchPocE2E({ markdownPath });
  const rawPath = path.join(os.tmpdir(), `marivell-u4-mode-switch-${Date.now()}.json`);
  fs.writeFileSync(rawPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(formatSummary(result), null, 2));
  console.log(`\nSaved raw U4 PoC JSON to ${rawPath}`);
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

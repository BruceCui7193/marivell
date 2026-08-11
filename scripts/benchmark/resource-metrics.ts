import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import type {
  BenchmarkAppMetrics,
  BenchmarkProcessMetric,
} from '../../src/shared/contracts.ts';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const electronBin = path.join(projectRoot, 'node_modules/.bin/electron');
const electronViteBin = path.join(projectRoot, 'node_modules/.bin/electron-vite');

export const RESOURCE_MARKDOWN_PATH =
  process.env.MARIVELL_RESOURCE_FILE ??
  '/home/crh/文档/Machine_Learning_25D/面向不同车型的2.5D野外地形风险感知路径规划：机器学习与搜索算法双向嵌套完整方案.md';
export const RESOURCE_IDLE10_MS = 10_000;
export const RESOURCE_IDLE30_MS = 30_000;
export const RESOURCE_MODE_CYCLES = 3;

export interface ElectronHandle {
  child: ReturnType<typeof spawn>;
  browser: Browser;
  page: Page;
  port: number;
  profile: string;
}

export interface LongTaskEntry {
  startTime: number;
  duration: number;
  name: string;
  attribution: string;
}

export interface LoafEntry {
  startTime: number;
  duration: number;
  blockingDuration: number;
  renderDuration: number;
  scriptDuration: number;
  scripts: number;
}

export interface AppMetricsSnapshot extends BenchmarkAppMetrics {
  at: number;
}

export interface HeapSnapshot {
  performanceMemory: {
    usedJSHeapSize: number;
    totalJSHeapSize: number;
    jsHeapSizeLimit: number;
  } | null;
  cdp: {
    usedSize: number;
    totalSize: number;
    embedderHeapUsedSize: number;
    backingStorageSize: number;
  } | null;
}

export interface DomSnapshot {
  totalNodes: number;
  elements: number;
  textNodes: number;
  commentNodes: number;
  tags: Record<string, number>;
  classes: Record<string, number>;
  cdpNodes: number;
  cdpDocuments: number;
  cdpJsEventListeners: number;
  editorHostElements: number;
  editorSurfaceElements: number;
  editorFrameElements: number;
  sourceTextareas: number;
}

export interface WorkerDiagnostics {
  exists: boolean;
  formulaChunks: Record<string, number | boolean> | null;
  inline: Record<string, number> | null;
  heightCache: Record<string, number> | null;
  deferred: Record<string, unknown> | null;
  formulaQueueDepth: number;
  formulaInFlightCount: number;
  pendingFormulaHtmlChunks: number;
  formulaHtmlProcessingScheduled: boolean;
  formulaChunkPumpThrottled: boolean;
  maxFormulaQueueDepth: number;
  maxPendingFormulaHtmlChunks: number;
}

export interface ResourceSnapshot {
  at: number;
  appMetrics: AppMetricsSnapshot;
  heap: HeapSnapshot;
  dom: DomSnapshot;
  worker: WorkerDiagnostics;
}

export interface ObserverCollection {
  longTasks: LongTaskEntry[];
  loafEntries: LoafEntry[];
  rafGaps: number[];
  observedMs: number;
}

export interface CpuSample {
  from: number;
  to: number;
  durationMs: number;
  rendererCpuPercent: number | null;
  gpuCpuPercent: number | null;
  method: 'cumulative' | 'last-percent';
}

export interface IdleSample {
  label: string;
  requestedMs: number;
  actualMs: number;
  cpuSamples: CpuSample[];
  observers: ObserverCollection;
  start: ResourceSnapshot;
  end: ResourceSnapshot;
  heapUsedDeltaMb: number;
  domNodeDelta: number;
  workerWaitMsDelta: number;
  workerProcessMsDelta: number;
  workerProcessRunsDelta: number;
  workerMessagesDelta: number;
  workerEntriesDelta: number;
  workerQueueDepthDelta: number;
  workerInFlightCountDelta: number;
  workerPendingHtmlDelta: number;
  maxWorkerQueueDepth: number;
  maxWorkerPendingHtmlChunks: number;
  pendingHeightMeasurements: number | null;
}

export interface ActivitySample {
  label: string;
  wallMs: number;
  cpu: CpuSample;
  observers: ObserverCollection;
  start: ResourceSnapshot;
  end: ResourceSnapshot;
  detail: Record<string, unknown>;
  heapUsedDeltaMb: number;
  domNodeDelta: number;
  workerWaitMsDelta: number;
  workerProcessMsDelta: number;
  workerProcessRunsDelta: number;
  workerMessagesDelta: number;
  workerEntriesDelta: number;
  workerQueueDepthDelta: number;
  workerInFlightCountDelta: number;
  workerPendingHtmlDelta: number;
  maxWorkerQueueDepth: number;
  maxWorkerPendingHtmlChunks: number;
  pendingHeightMeasurements: number | null;
}

export interface ResourceRound {
  round: number;
  startedAt: string;
  filePath: string;
  fileBytes: number;
  open: ResourceSnapshot;
  idle10: IdleSample;
  modeSwitch: ActivitySample;
  scroll: ActivitySample;
  idle30: IdleSample;
  final: ResourceSnapshot;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function buildRenderer(outDir: string): Promise<void> {
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

export async function launchResourceElectron(
  outDir: string,
  filePath: string,
  port: number,
  profile: string,
): Promise<ElectronHandle> {
  const installedBin = process.env.MARIVELL_E2E_BIN ?? '';
  const binary = installedBin || electronBin;
  const args = installedBin
    ? [
        '--no-sandbox',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        filePath,
      ]
    : [
        path.join(outDir, 'main', 'index.js'),
        '--no-sandbox',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        filePath,
      ];
  const child = spawn(binary, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      MARIVELL_BENCHMARK: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  const browser = await connectToElectron(port, 30_000);
  const context = browser.contexts()[0];
  const page = context?.pages()[0];
  if (!page) {
    throw new Error('Electron page was not created');
  }
  await page.waitForLoadState('domcontentloaded');
  return { child, browser, page, port, profile };
}

export async function waitForVisualReady(
  page: Page,
  expectedTextLength: number,
  deadlineMs = 60_000,
): Promise<{ waitMs: number; timedOut: boolean; detail: Record<string, unknown> }> {
  return page.evaluate(
    async ({ expectedLength, deadlineMs }) => {
      const start = performance.now();
      const deadline = start + deadlineMs;
      while (performance.now() < deadline) {
        const loading = document.querySelector('.editor-loading');
        const surface = document.querySelector('.editor-surface');
        const frame = document.querySelector('.editor-frame');
        const editor = (window as unknown as {
          __marivellEditor?: { state?: { doc?: { nodeSize?: number } } };
        }).__marivellEditor;
        const nodeReady = Boolean(
          editor?.state?.doc && editor.state.doc.nodeSize > Math.min(expectedLength, 500_000),
        );
        const textReady = Boolean(
          surface && surface.innerText.length > Math.min(expectedLength, 100_000),
        );
        if (!loading && surface && frame && (nodeReady || textReady)) {
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          return {
            waitMs: performance.now() - start,
            timedOut: false,
            detail: {
              nodeSize: editor?.state?.doc?.nodeSize ?? 0,
              textLength: surface.innerText.length,
              scrollHeight: frame.scrollHeight,
              clientHeight: frame.clientHeight,
            },
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const frame = document.querySelector('.editor-frame');
      const surface = document.querySelector('.editor-surface');
      return {
        waitMs: performance.now() - start,
        timedOut: true,
        detail: {
          nodeSize: (window as unknown as { __marivellEditor?: { state?: { doc?: { nodeSize?: number } } } })
            .__marivellEditor?.state?.doc?.nodeSize ?? 0,
          textLength: surface?.innerText?.length ?? 0,
          scrollHeight: frame?.scrollHeight ?? 0,
          clientHeight: frame?.clientHeight ?? 0,
        },
      };
    },
    { expectedLength: expectedTextLength, deadlineMs },
  );
}

export async function installResourceObservers(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const target = window;
    target.__resourceRafGaps = [];
    target.__resourceLongTasks = [];
    target.__resourceLoafEntries = [];
    target.__resourceRafLast = performance.now();
    target.__resourceRafStart = performance.now();
    target.__resourceRafRunning = false;
    target.__resourceRafStarted = false;

    target.__resourceLongObserver?.disconnect?.();
    const longObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      for (const entry of entries) {
        const timing = entry;
        const tasks = target.__resourceLongTasks;
        tasks?.push({
          startTime: timing.startTime,
          duration: timing.duration,
          name: timing.name,
          attribution: (timing.attribution ?? []).map((item) => (item.name ?? '') + ':' + (item.containerType ?? ''))
            .join('|'),
        });
      }
    });
    longObserver.observe({ type: 'longtask', buffered: true });
    target.__resourceLongObserver = longObserver;

    target.__resourceLoafObserver?.disconnect?.();
    if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) {
      const loafObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        for (const entry of entries) {
          const timing = entry;
          const loafEntries = target.__resourceLoafEntries;
          loafEntries?.push({
            startTime: timing.startTime,
            duration: timing.duration,
            blockingDuration: timing.blockingDuration ?? 0,
            renderDuration: timing.renderDuration ?? 0,
            scriptDuration: timing.scriptDuration ?? 0,
            scripts: timing.scripts?.length ?? 0,
          });
        }
      });
      loafObserver.observe({ type: 'long-animation-frame', buffered: true });
      target.__resourceLoafObserver = loafObserver;
    }
  })()`);
}

export async function startResourceObservers(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const target = window;
    target.__resourceRafGaps = [];
    target.__resourceLongTasks = [];
    target.__resourceLoafEntries = [];
    target.__resourceRafLast = performance.now();
    target.__resourceRafStart = performance.now();
    target.__resourceRafRunning = true;
    if (target.__resourceRafStarted) {
      return;
    }
    target.__resourceRafStarted = true;
    const tick = () => {
      if (!target.__resourceRafRunning) {
        target.__resourceRafStarted = false;
        return;
      }
      const now = performance.now();
      const gaps = target.__resourceRafGaps;
      const last = target.__resourceRafLast;
      gaps.push(now - last);
      target.__resourceRafLast = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
}

export async function collectResourceObservers(page: Page): Promise<ObserverCollection> {
  const result = await page.evaluate(`(() => {
    const target = window;
    target.__resourceRafRunning = false;
    const observedMs = performance.now() - target.__resourceRafStart;
    return {
      longTasks: target.__resourceLongTasks ?? [],
      loafEntries: target.__resourceLoafEntries ?? [],
      rafGaps: target.__resourceRafGaps ?? [],
      observedMs,
    };
  })()`);
  return result as ObserverCollection;
}

async function readAppMetrics(page: Page): Promise<AppMetricsSnapshot> {
  const result = await page.evaluate(`(async () => {
    const api = window.markdownEditor;
    if (!api || typeof api.getAppMetrics !== 'function') {
      throw new Error('markdownEditor.getAppMetrics bridge is missing');
    }
    return await api.getAppMetrics();
  })()`);
  return { at: Date.now(), ...(result as BenchmarkAppMetrics) };
}

async function readCdpSnapshots(page: Page): Promise<{
  heap: HeapSnapshot['cdp'];
  dom: { nodes: number; documents: number; jsEventListeners: number };
}> {
  const session = await page.context().newCDPSession(page);
  try {
    const heap = (await session.send('Runtime.getHeapUsage')) as {
      usedSize: number;
      totalSize: number;
      embedderHeapUsedSize: number;
      backingStorageSize: number;
    };
    const dom = (await session.send('Memory.getDOMCounters')) as {
      nodes: number;
      documents: number;
      jsEventListeners: number;
    };
    return {
      heap: {
        usedSize: heap.usedSize,
        totalSize: heap.totalSize,
        embedderHeapUsedSize: heap.embedderHeapUsedSize,
        backingStorageSize: heap.backingStorageSize,
      },
      dom,
    };
  } finally {
    await session.detach();
  }
}

async function readDomSnapshot(
  page: Page,
  cdpOverride?: Awaited<ReturnType<typeof readCdpSnapshots>>,
): Promise<DomSnapshot> {
  const cdp = cdpOverride ?? (await readCdpSnapshots(page));
  const tree = await page.evaluate(`(() => {
    const tags = {};
    const classes = {};
    let totalNodes = 0;
    let elements = 0;
    let textNodes = 0;
    let commentNodes = 0;
    const tagKeys = [
      'p', 'div', 'span', 'pre', 'img', 'svg', 'table', 'section', 'a', 'button',
      'textarea', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'code', 'math',
    ];
    const classKeys = [
      'editor-host', 'editor-surface', 'editor-frame', 'ProseMirror',
      'math-inline-node', 'math-block-node', 'math-node-content', 'math-node-preview',
      'math-inline-node--placeholder', 'math-block-node-placeholder', 'katex',
      'math-syntax-cmd', 'math-syntax-brace', 'math-syntax-special', 'math-syntax-comment',
      'image-node', 'mermaid-node', 'code-block-node',
    ];
    const countNode = (node) => {
      totalNodes += 1;
      if (node.nodeType === Node.ELEMENT_NODE) {
        elements += 1;
        const element = node;
        const tag = element.tagName.toLowerCase();
        if (tagKeys.includes(tag)) {
          tags[tag] = (tags[tag] ?? 0) + 1;
        }
        for (const key of classKeys) {
          if (element.classList.contains(key)) {
            classes[key] = (classes[key] ?? 0) + 1;
          }
        }
      } else if (node.nodeType === Node.TEXT_NODE) {
        textNodes += 1;
      } else if (node.nodeType === Node.COMMENT_NODE) {
        commentNodes += 1;
      }
    };
    const root = document.documentElement;
    countNode(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
    while (walker.nextNode()) {
      countNode(walker.currentNode);
    }
    return {
      totalNodes,
      elements,
      textNodes,
      commentNodes,
      tags,
      classes,
      editorHostElements: document.querySelectorAll('.editor-host').length,
      editorSurfaceElements: document.querySelectorAll('.editor-surface').length,
      editorFrameElements: document.querySelectorAll('.editor-frame').length,
      sourceTextareas: document.querySelectorAll('.source-editor__input').length,
    };
  })()`);
  return {
    ...tree,
    cdpNodes: cdp.dom.nodes,
    cdpDocuments: cdp.dom.documents,
    cdpJsEventListeners: cdp.dom.jsEventListeners,
  };
}

async function readWorkerDiagnostics(page: Page): Promise<WorkerDiagnostics> {
  return page.evaluate(`(() => {
    const target = window;
    const formulaChunks = target.__marivellFormulaChunkDiagnostics;
    const deferred = typeof target.__marivellGetDeferredWorkDiagnostics === 'function'
      ? target.__marivellGetDeferredWorkDiagnostics()
      : null;
    const inline = typeof target.__marivellGetInlineMathHeightPrefetchStats === 'function'
      ? target.__marivellGetInlineMathHeightPrefetchStats()
      : null;
    const heightCache = typeof target.__marivellGetNodeHeightCacheStats === 'function'
      ? target.__marivellGetNodeHeightCacheStats()
      : null;
    const numberOrZero = (value) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
    return {
      exists: Boolean(formulaChunks || inline || heightCache),
      formulaChunks: formulaChunks ? { ...formulaChunks } : null,
      inline: inline ? { ...inline } : null,
      heightCache: heightCache ? { ...heightCache } : null,
      deferred,
      formulaQueueDepth: numberOrZero(deferred?.formulaChunkQueueDepth),
      formulaInFlightCount: numberOrZero(deferred?.formulaChunkInFlightCount),
      pendingFormulaHtmlChunks: numberOrZero(deferred?.pendingFormulaHtmlChunks),
      formulaHtmlProcessingScheduled: Boolean(deferred?.formulaHtmlProcessingScheduled),
      formulaChunkPumpThrottled: Boolean(deferred?.formulaChunkPumpThrottled),
      maxFormulaQueueDepth: numberOrZero(deferred?.maxFormulaChunkQueueDepth),
      maxPendingFormulaHtmlChunks: numberOrZero(deferred?.maxPendingFormulaHtmlChunks),
    };
  })()`);
}

export async function readRendererResources(page: Page): Promise<ResourceSnapshot> {
  const appMetrics = await readAppMetrics(page);
  const cdp = await readCdpSnapshots(page);
  const dom = await readDomSnapshot(page, cdp);
  const worker = await readWorkerDiagnostics(page);
  const performanceMemory = await page.evaluate(`(() => {
    const memory = performance.memory;
    return memory
      ? {
          usedJSHeapSize: memory.usedJSHeapSize,
          totalJSHeapSize: memory.totalJSHeapSize,
          jsHeapSizeLimit: memory.jsHeapSizeLimit,
        }
      : null;
  })()`);
  return {
    at: Date.now(),
    appMetrics,
    heap: {
      performanceMemory,
      cdp: cdp.heap,
    },
    dom: {
      ...dom,
      cdpNodes: cdp.dom.nodes,
      cdpDocuments: cdp.dom.documents,
      cdpJsEventListeners: cdp.dom.jsEventListeners,
    },
    worker,
  };
}

function findProcess(
  snapshot: AppMetricsSnapshot,
  rendererProcessId: number | null,
  type: string,
): BenchmarkProcessMetric | null {
  return (
    snapshot.metrics.find((metric) => metric.pid === rendererProcessId) ??
    snapshot.metrics.find((metric) => metric.type === type) ??
    null
  );
}

function cpuPercent(
  start: AppMetricsSnapshot,
  end: AppMetricsSnapshot,
  durationMs: number,
): { rendererCpuPercent: number | null; gpuCpuPercent: number | null; method: 'cumulative' | 'last-percent' } {
  const durationSec = Math.max(durationMs / 1000, 0.001);
  const rendererStart = findProcess(start, start.rendererProcessId, 'Tab');
  const rendererEnd = findProcess(end, end.rendererProcessId, 'Tab');
  const gpuStart = findProcess(start, null, 'GPU');
  const gpuEnd = findProcess(end, null, 'GPU');

  let method: 'cumulative' | 'last-percent' = 'last-percent';
  let rendererCpuPercent: number | null = null;
  if (
    rendererStart?.cpu.cumulativeCPUUsage !== undefined &&
    rendererEnd?.cpu.cumulativeCPUUsage !== undefined
  ) {
    const cumulative = rendererEnd.cpu.cumulativeCPUUsage - rendererStart.cpu.cumulativeCPUUsage;
    rendererCpuPercent = (cumulative / durationSec) * 100;
    method = 'cumulative';
  } else {
    rendererCpuPercent = rendererEnd?.cpu.percentCPUUsage ?? null;
  }

  let gpuCpuPercent: number | null = null;
  if (
    gpuStart?.cpu.cumulativeCPUUsage !== undefined &&
    gpuEnd?.cpu.cumulativeCPUUsage !== undefined
  ) {
    const cumulative = gpuEnd.cpu.cumulativeCPUUsage - gpuStart.cpu.cumulativeCPUUsage;
    gpuCpuPercent = (cumulative / durationSec) * 100;
  } else {
    gpuCpuPercent = gpuEnd?.cpu.percentCPUUsage ?? null;
  }

  return { rendererCpuPercent, gpuCpuPercent, method };
}

function memoryMb(metric: BenchmarkProcessMetric | null): number | null {
  return metric ? metric.memory.workingSetSize / 1024 : null;
}

function workerDelta(start: ResourceSnapshot, end: ResourceSnapshot): {
  waitMs: number;
  processMs: number;
  processRuns: number;
  messages: number;
  entries: number;
  queueDepth: number;
  inFlightCount: number;
  pendingHtmlChunks: number;
  maxQueueDepth: number;
  maxPendingHtmlChunks: number;
  pendingHeightMeasurements: number | null;
} {
  const read = (snapshot: ResourceSnapshot, key: string): number => {
    const value = snapshot.worker.formulaChunks?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  return {
    waitMs: read(end, 'waitMs') - read(start, 'waitMs'),
    processMs: read(end, 'processMs') - read(start, 'processMs'),
    processRuns: read(end, 'processRuns') - read(start, 'processRuns'),
    messages: read(end, 'messages') - read(start, 'messages'),
    entries: read(end, 'entries') - read(start, 'entries'),
    queueDepth: end.worker.formulaQueueDepth - start.worker.formulaQueueDepth,
    inFlightCount: end.worker.formulaInFlightCount - start.worker.formulaInFlightCount,
    pendingHtmlChunks:
      end.worker.pendingFormulaHtmlChunks - start.worker.pendingFormulaHtmlChunks,
    maxQueueDepth: end.worker.maxFormulaQueueDepth,
    maxPendingHtmlChunks: end.worker.maxPendingFormulaHtmlChunks,
    pendingHeightMeasurements: end.worker.inline?.pendingHeightMeasurements ?? null,
  };
}

function heapUsedBytes(snapshot: ResourceSnapshot): number | null {
  return snapshot.heap.cdp?.usedSize ?? snapshot.heap.performanceMemory?.usedJSHeapSize ?? null;
}

function mb(value: number | null): number | null {
  return typeof value === 'number' ? value / (1024 * 1024) : null;
}

export async function sampleIdle(
  page: Page,
  durationMs: number,
  label: string,
  cpuWindowMs = durationMs,
): Promise<IdleSample> {
  await startResourceObservers(page);
  const start = await readRendererResources(page);
  const cpuSamples: CpuSample[] = [];
  let previous = start.appMetrics;
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const waitMs = Math.min(cpuWindowMs, Math.max(deadline - Date.now(), 0));
    if (waitMs > 0) {
      await wait(waitMs);
    }
    const now = await readAppMetrics(page);
    const intervalMs = Math.max(now.at - previous.at, 1);
    const cpu = cpuPercent(previous, now, intervalMs);
    cpuSamples.push({
      from: previous.at,
      to: now.at,
      durationMs: intervalMs,
      rendererCpuPercent: cpu.rendererCpuPercent,
      gpuCpuPercent: cpu.gpuCpuPercent,
      method: cpu.method,
    });
    previous = now;
  }
  const end = await readRendererResources(page);
  const observers = await collectResourceObservers(page);
  const delta = workerDelta(start, end);
  const startHeap = heapUsedBytes(start);
  const endHeap = heapUsedBytes(end);
  return {
    label,
    requestedMs: durationMs,
    actualMs: end.at - start.at,
    cpuSamples,
    observers,
    start,
    end,
    heapUsedDeltaMb:
      startHeap !== null && endHeap !== null ? mb(endHeap - startHeap) ?? 0 : 0,
    domNodeDelta: end.dom.totalNodes - start.dom.totalNodes,
    workerWaitMsDelta: delta.waitMs,
    workerProcessMsDelta: delta.processMs,
    workerProcessRunsDelta: delta.processRuns,
    workerMessagesDelta: delta.messages,
    workerEntriesDelta: delta.entries,
    workerQueueDepthDelta: delta.queueDepth,
    workerInFlightCountDelta: delta.inFlightCount,
    workerPendingHtmlDelta: delta.pendingHtmlChunks,
    maxWorkerQueueDepth: delta.maxQueueDepth,
    maxWorkerPendingHtmlChunks: delta.maxPendingHtmlChunks,
    pendingHeightMeasurements: delta.pendingHeightMeasurements,
  };
}

async function toggleMode(page: Page, target: 'source' | 'visual'): Promise<number> {
  const start = Date.now();
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-source-mode' }),
    );
  });
  const ok = await page.evaluate(async (targetMode) => {
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      const input = frame?.querySelector<HTMLTextAreaElement>('.source-editor__input');
      const overlay = frame?.querySelector<HTMLElement>('.editor-loading--mode-switch');
      const isSource = Boolean(frame?.classList.contains('is-source'));
      if (targetMode === 'source') {
        if (isSource && input && !overlay) {
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          return true;
        }
      } else if (!isSource && !input && !overlay) {
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }, target);
  if (!ok) {
    throw new Error(`mode switch to ${target} timed out`);
  }
  return Date.now() - start;
}

export async function sampleModeSwitchCycles(
  page: Page,
  cycles: number,
): Promise<ActivitySample> {
  await startResourceObservers(page);
  const start = await readRendererResources(page);
  const cycleDurations: number[] = [];
  const startedAt = Date.now();
  for (let index = 0; index < cycles; index += 1) {
    cycleDurations.push(await toggleMode(page, 'source'));
    cycleDurations.push(await toggleMode(page, 'visual'));
  }
  const wallMs = Date.now() - startedAt;
  const end = await readRendererResources(page);
  const observers = await collectResourceObservers(page);
  const cpu = cpuPercent(start.appMetrics, end.appMetrics, Math.max(wallMs, 1));
  const delta = workerDelta(start, end);
  const startHeap = heapUsedBytes(start);
  const endHeap = heapUsedBytes(end);
  return {
    label: 'mode-switch',
    wallMs,
    cpu: {
      from: start.at,
      to: end.at,
      durationMs: Math.max(wallMs, 1),
      rendererCpuPercent: cpu.rendererCpuPercent,
      gpuCpuPercent: cpu.gpuCpuPercent,
      method: cpu.method,
    },
    observers,
    start,
    end,
    detail: { cycles, cycleDurations },
    heapUsedDeltaMb:
      startHeap !== null && endHeap !== null ? mb(endHeap - startHeap) ?? 0 : 0,
    domNodeDelta: end.dom.totalNodes - start.dom.totalNodes,
    workerWaitMsDelta: delta.waitMs,
    workerProcessMsDelta: delta.processMs,
    workerProcessRunsDelta: delta.processRuns,
    workerMessagesDelta: delta.messages,
    workerEntriesDelta: delta.entries,
    workerQueueDepthDelta: delta.queueDepth,
    workerInFlightCountDelta: delta.inFlightCount,
    workerPendingHtmlDelta: delta.pendingHtmlChunks,
    maxWorkerQueueDepth: delta.maxQueueDepth,
    maxWorkerPendingHtmlChunks: delta.maxPendingHtmlChunks,
    pendingHeightMeasurements: delta.pendingHeightMeasurements,
  };
}

export async function sampleScrollRoundTrip(page: Page): Promise<ActivitySample> {
  await startResourceObservers(page);
  const start = await readRendererResources(page);
  const startedAt = Date.now();
  const detail = await page.evaluate(async () => {
    const frame = document.querySelector<HTMLElement>('.editor-frame');
    if (!frame) {
      throw new Error('editor frame missing');
    }
    const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
    const positions = [0, maxScrollTop, Math.round(maxScrollTop / 2)];
    const reached: number[] = [];
    for (const target of positions) {
      frame.scrollTop = target;
      frame.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 120));
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      reached.push(frame.scrollTop);
    }
    return {
      scrollHeight: frame.scrollHeight,
      clientHeight: frame.clientHeight,
      maxScrollTop,
      reached,
      finalScrollTop: frame.scrollTop,
    };
  });
  const wallMs = Date.now() - startedAt;
  const end = await readRendererResources(page);
  const observers = await collectResourceObservers(page);
  const cpu = cpuPercent(start.appMetrics, end.appMetrics, Math.max(wallMs, 1));
  const delta = workerDelta(start, end);
  const startHeap = heapUsedBytes(start);
  const endHeap = heapUsedBytes(end);
  return {
    label: 'scroll',
    wallMs,
    cpu: {
      from: start.at,
      to: end.at,
      durationMs: Math.max(wallMs, 1),
      rendererCpuPercent: cpu.rendererCpuPercent,
      gpuCpuPercent: cpu.gpuCpuPercent,
      method: cpu.method,
    },
    observers,
    start,
    end,
    detail,
    heapUsedDeltaMb:
      startHeap !== null && endHeap !== null ? mb(endHeap - startHeap) ?? 0 : 0,
    domNodeDelta: end.dom.totalNodes - start.dom.totalNodes,
    workerWaitMsDelta: delta.waitMs,
    workerProcessMsDelta: delta.processMs,
    workerProcessRunsDelta: delta.processRuns,
    workerMessagesDelta: delta.messages,
    workerEntriesDelta: delta.entries,
    workerQueueDepthDelta: delta.queueDepth,
    workerInFlightCountDelta: delta.inFlightCount,
    workerPendingHtmlDelta: delta.pendingHtmlChunks,
    maxWorkerQueueDepth: delta.maxQueueDepth,
    maxWorkerPendingHtmlChunks: delta.maxPendingHtmlChunks,
    pendingHeightMeasurements: delta.pendingHeightMeasurements,
  };
}

function sampleResourceSnapshot(snapshot: ResourceSnapshot): Record<string, unknown> {
  const renderer = findProcess(
    snapshot.appMetrics,
    snapshot.appMetrics.rendererProcessId,
    'Tab',
  );
  const gpu = findProcess(snapshot.appMetrics, null, 'GPU');
  return {
    at: snapshot.at,
    rendererPid: renderer?.pid ?? null,
    rendererWorkingSetMb: memoryMb(renderer),
    gpuPid: gpu?.pid ?? null,
    gpuWorkingSetMb: memoryMb(gpu),
    heapUsedMb: mb(heapUsedBytes(snapshot)),
    heapPerformanceUsedMb: mb(snapshot.heap.performanceMemory?.usedJSHeapSize ?? null),
    cdpUsedMb: mb(snapshot.heap.cdp?.usedSize ?? null),
    domTotalNodes: snapshot.dom.totalNodes,
    domElements: snapshot.dom.elements,
    domTextNodes: snapshot.dom.textNodes,
    domCdpNodes: snapshot.dom.cdpNodes,
    domCdpDocuments: snapshot.dom.cdpDocuments,
    domCdpJsEventListeners: snapshot.dom.cdpJsEventListeners,
    workerExists: snapshot.worker.exists,
    workerFormulaChunks: snapshot.worker.formulaChunks,
    workerInline: snapshot.worker.inline,
    workerHeightCache: snapshot.worker.heightCache,
    workerDeferred: snapshot.worker.deferred,
    workerQueueDepth: snapshot.worker.formulaQueueDepth,
    workerInFlightCount: snapshot.worker.formulaInFlightCount,
    workerPendingFormulaHtmlChunks: snapshot.worker.pendingFormulaHtmlChunks,
    workerFormulaHtmlProcessingScheduled: snapshot.worker.formulaHtmlProcessingScheduled,
    workerPumpThrottled: snapshot.worker.formulaChunkPumpThrottled,
    workerMaxQueueDepth: snapshot.worker.maxFormulaQueueDepth,
    workerMaxPendingFormulaHtmlChunks: snapshot.worker.maxPendingFormulaHtmlChunks,
  };
}

function summarizeIdle(sample: IdleSample): Record<string, unknown> {
  return {
    actualMs: sample.actualMs,
    cpu: sample.cpuSamples,
    longTaskCount: sample.observers.longTasks.length,
    longTaskMaxMs: sample.observers.longTasks.reduce(
      (max, task) => Math.max(max, task.duration),
      0,
    ),
    longTaskTotalMs: sample.observers.longTasks.reduce(
      (sum, task) => sum + task.duration,
      0,
    ),
    loafCount: sample.observers.loafEntries.length,
    loafMaxMs: sample.observers.loafEntries.reduce(
      (max, entry) => Math.max(max, entry.duration),
      0,
    ),
    rafGapP50: percentile(sample.observers.rafGaps, 0.5),
    rafGapP95: percentile(sample.observers.rafGaps, 0.95),
    rafGapMax: sample.observers.rafGaps.length
      ? Math.max(...sample.observers.rafGaps)
      : null,
    rafGapCount: sample.observers.rafGaps.length,
    heapUsedDeltaMb: sample.heapUsedDeltaMb,
    domNodeDelta: sample.domNodeDelta,
    workerWaitMsDelta: sample.workerWaitMsDelta,
    workerProcessMsDelta: sample.workerProcessMsDelta,
    workerProcessRunsDelta: sample.workerProcessRunsDelta,
    workerMessagesDelta: sample.workerMessagesDelta,
    workerEntriesDelta: sample.workerEntriesDelta,
    workerQueueDepthDelta: sample.workerQueueDepthDelta,
    workerInFlightCountDelta: sample.workerInFlightCountDelta,
    workerPendingHtmlDelta: sample.workerPendingHtmlDelta,
    maxWorkerQueueDepth: sample.maxWorkerQueueDepth,
    maxWorkerPendingHtmlChunks: sample.maxWorkerPendingHtmlChunks,
    pendingHeightMeasurements: sample.pendingHeightMeasurements,
    start: sampleResourceSnapshot(sample.start),
    end: sampleResourceSnapshot(sample.end),
  };
}

function summarizeActivity(sample: ActivitySample): Record<string, unknown> {
  return {
    wallMs: sample.wallMs,
    detail: sample.detail,
    cpu: sample.cpu,
    longTaskCount: sample.observers.longTasks.length,
    longTaskMaxMs: sample.observers.longTasks.reduce(
      (max, task) => Math.max(max, task.duration),
      0,
    ),
    longTaskTotalMs: sample.observers.longTasks.reduce(
      (sum, task) => sum + task.duration,
      0,
    ),
    loafCount: sample.observers.loafEntries.length,
    loafMaxMs: sample.observers.loafEntries.reduce(
      (max, entry) => Math.max(max, entry.duration),
      0,
    ),
    rafGapP50: percentile(sample.observers.rafGaps, 0.5),
    rafGapP95: percentile(sample.observers.rafGaps, 0.95),
    rafGapMax: sample.observers.rafGaps.length
      ? Math.max(...sample.observers.rafGaps)
      : null,
    rafGapCount: sample.observers.rafGaps.length,
    heapUsedDeltaMb: sample.heapUsedDeltaMb,
    domNodeDelta: sample.domNodeDelta,
    workerWaitMsDelta: sample.workerWaitMsDelta,
    workerProcessMsDelta: sample.workerProcessMsDelta,
    workerProcessRunsDelta: sample.workerProcessRunsDelta,
    workerMessagesDelta: sample.workerMessagesDelta,
    workerEntriesDelta: sample.workerEntriesDelta,
    workerQueueDepthDelta: sample.workerQueueDepthDelta,
    workerInFlightCountDelta: sample.workerInFlightCountDelta,
    workerPendingHtmlDelta: sample.workerPendingHtmlDelta,
    maxWorkerQueueDepth: sample.maxWorkerQueueDepth,
    maxWorkerPendingHtmlChunks: sample.maxWorkerPendingHtmlChunks,
    pendingHeightMeasurements: sample.pendingHeightMeasurements,
    start: sampleResourceSnapshot(sample.start),
    end: sampleResourceSnapshot(sample.end),
  };
}

export function compactRound(round: ResourceRound): Record<string, unknown> {
  return {
    round: round.round,
    startedAt: round.startedAt,
    filePath: round.filePath,
    fileBytes: round.fileBytes,
    open: sampleResourceSnapshot(round.open),
    idle10: summarizeIdle(round.idle10),
    modeSwitch: summarizeActivity(round.modeSwitch),
    scroll: summarizeActivity(round.scroll),
    idle30: summarizeIdle(round.idle30),
    final: sampleResourceSnapshot(round.final),
  };
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index] ?? null;
}

export async function runOneResourceRound(
  round: number,
  filePath = RESOURCE_MARKDOWN_PATH,
): Promise<ResourceRound> {
  const outDir = path.join(os.tmpdir(), `marivell-resource-build-${process.pid}-${round}`);
  const profile = path.join(os.tmpdir(), `marivell-resource-profile-${process.pid}-${round}`);
  const port = 9700 + ((process.pid + round * 13) % 200);
  const startedAt = new Date().toISOString();
  const fileBytes = fs.statSync(filePath).size;
  const source = fs.readFileSync(filePath, 'utf8');

  console.log(`\n[resource round ${round}] building and launching on ${path.basename(filePath)}`);
  await buildRenderer(outDir);
  const handle = await launchResourceElectron(outDir, filePath, port, profile);
  try {
    const ready = await waitForVisualReady(
      handle.page,
      Math.min(Math.max(source.length * 0.5, 10_000), 100_000),
    );
    if (ready.timedOut) {
      throw new Error(`round ${round} visual ready timeout: ${JSON.stringify(ready.detail)}`);
    }
    await installResourceObservers(handle.page);

    const open = await readRendererResources(handle.page);
    const idle10 = await sampleIdle(handle.page, RESOURCE_IDLE10_MS, 'idle10');
    const modeSwitch = await sampleModeSwitchCycles(
      handle.page,
      RESOURCE_MODE_CYCLES,
    );
    const scroll = await sampleScrollRoundTrip(handle.page);
    const idle30 = await sampleIdle(handle.page, RESOURCE_IDLE30_MS, 'idle30', 10_000);
    const final = await readRendererResources(handle.page);

    return {
      round,
      startedAt,
      filePath,
      fileBytes,
      open,
      idle10,
      modeSwitch,
      scroll,
      idle30,
      final,
    };
  } finally {
    if (process.platform !== 'win32') {
      try {
        process.kill(-handle.child.pid, 'SIGKILL');
      } catch {
        // Process group may already be gone.
      }
    }
    handle.child.kill('SIGKILL');
    await handle.browser.close().catch(() => {});
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

interface MetricRow {
  metric: string;
  unit: string;
  rounds: Array<number | null>;
  p50: number | null;
  p95: number | null;
  max: number | null;
  n: number;
}

function formatNumber(value: number | null, digits = 2): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

function makeRow(
  metric: string,
  unit: string,
  values: Array<number | null>,
  perRound: Array<number | null> = values,
): MetricRow {
  const finite = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return {
    metric,
    unit,
    rounds: perRound,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: finite.length ? Math.max(...finite) : null,
    n: finite.length,
  };
}

function phaseScalar(rounds: ResourceRound[], phase: 'idle10' | 'idle30', key: string): Array<number | null> {
  return rounds.map((round) => {
    const sample = round[phase];
    const value = (sample as unknown as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  });
}

function phaseCpuValues(rounds: ResourceRound[], phase: 'idle10' | 'idle30'): Array<number | null> {
  return rounds.flatMap((round) =>
    round[phase].cpuSamples.map((sample) => sample.rendererCpuPercent),
  );
}

function phaseDistribution(
  rounds: ResourceRound[],
  phase: 'idle10' | 'idle30',
  key: 'rafGaps' | 'longTasks' | 'loafEntries',
): Array<number | null> {
  return rounds.flatMap((round) => {
    const observers = round[phase].observers;
    if (key === 'rafGaps') {
      return observers.rafGaps;
    }
    if (key === 'loafEntries') {
      return observers.loafEntries.map((entry) => entry.duration);
    }
    return observers.longTasks.map((entry) => entry.duration);
  });
}

function phaseDistributionP95(rounds: ResourceRound[], phase: 'idle10' | 'idle30'): Array<number | null> {
  return rounds.map((round) => {
    const observers = round[phase].observers;
    const durations = observers.longTasks.map((entry) => entry.duration);
    return durations.length ? percentile(durations, 0.95) : 0;
  });
}

function distributionPerRound(
  rounds: ResourceRound[],
  phase: 'idle10' | 'idle30' | 'modeSwitch' | 'scroll',
  key: 'rafGaps' | 'longTasks' | 'loafEntries',
): Array<number | null> {
  return rounds.map((round) => {
    const values = round[phase].observers[key];
    if (values.length === 0) {
      return 0;
    }
    const durations =
      key === 'rafGaps'
        ? values
        : values.map((entry) => entry.duration);
    return percentile(durations, 0.95);
  });
}

function buildMetricRows(rounds: ResourceRound[]): MetricRow[] {
  const rows: MetricRow[] = [];
  const push = (
    metric: string,
    unit: string,
    values: Array<number | null>,
    perRound?: Array<number | null>,
  ): void => {
    rows.push(makeRow(metric, unit, values, perRound ?? values));
  };

  push('open.heap-used-mb', 'MB', rounds.map((round) => mb(heapUsedBytes(round.open))));
  push('open.dom-total-nodes', 'nodes', rounds.map((round) => round.open.dom.totalNodes));
  push('open.dom-cdp-nodes', 'nodes', rounds.map((round) => round.open.dom.cdpNodes));
  push('open.gpu-working-set-mb', 'MB', rounds.map((round) => {
    const gpu = findProcess(round.open.appMetrics, null, 'GPU');
    return memoryMb(gpu);
  }));
  push('open.renderer-working-set-mb', 'MB', rounds.map((round) => {
    const renderer = findProcess(
      round.open.appMetrics,
      round.open.appMetrics.rendererProcessId,
      'Tab',
    );
    return memoryMb(renderer);
  }));

  push('idle10.renderer-cpu-percent', '%', phaseCpuValues(rounds, 'idle10'));
  push(
    'idle10.raf-gap-ms',
    'ms',
    phaseDistribution(rounds, 'idle10', 'rafGaps'),
    distributionPerRound(rounds, 'idle10', 'rafGaps'),
  );
  push(
    'idle10.long-task-duration-ms',
    'ms',
    phaseDistribution(rounds, 'idle10', 'longTasks'),
    distributionPerRound(rounds, 'idle10', 'longTasks'),
  );
  push('idle10.long-task-p95-per-round', 'ms', phaseDistributionP95(rounds, 'idle10'));
  push(
    'idle10.loaf-duration-ms',
    'ms',
    phaseDistribution(rounds, 'idle10', 'loafEntries'),
    distributionPerRound(rounds, 'idle10', 'loafEntries'),
  );
  push('idle10.heap-used-delta-mb', 'MB', phaseScalar(rounds, 'idle10', 'heapUsedDeltaMb'));
  push('idle10.dom-node-delta', 'nodes', phaseScalar(rounds, 'idle10', 'domNodeDelta'));
  push('idle10.worker-wait-ms-delta', 'ms', phaseScalar(rounds, 'idle10', 'workerWaitMsDelta'));
  push('idle10.worker-process-ms-delta', 'ms', phaseScalar(rounds, 'idle10', 'workerProcessMsDelta'));
  push('idle10.worker-queue-depth-delta', 'chunks', phaseScalar(rounds, 'idle10', 'workerQueueDepthDelta'));
  push('idle10.worker-pending-html-delta', 'chunks', phaseScalar(rounds, 'idle10', 'workerPendingHtmlDelta'));
  push('idle10.worker-max-queue-depth', 'chunks', phaseScalar(rounds, 'idle10', 'maxWorkerQueueDepth'));
  push('idle10.worker-max-pending-html', 'chunks', phaseScalar(rounds, 'idle10', 'maxWorkerPendingHtmlChunks'));
  push('idle10.pending-height-measurements', 'items', phaseScalar(rounds, 'idle10', 'pendingHeightMeasurements'));

  push(
    'mode-switch.total-ms',
    'ms',
    rounds.map((round) => round.modeSwitch.wallMs),
  );
  push(
    'mode-switch.renderer-cpu-percent',
    '%',
    rounds.map((round) => round.modeSwitch.cpu.rendererCpuPercent),
  );
  push(
    'mode-switch.raf-gap-ms',
    'ms',
    rounds.flatMap((round) => round.modeSwitch.observers.rafGaps),
    distributionPerRound(rounds, 'modeSwitch', 'rafGaps'),
  );
  push(
    'mode-switch.long-task-duration-ms',
    'ms',
    rounds.flatMap((round) => round.modeSwitch.observers.longTasks.map((entry) => entry.duration)),
    distributionPerRound(rounds, 'modeSwitch', 'longTasks'),
  );
  push(
    'mode-switch.long-task-p95-per-round',
    'ms',
    distributionPerRound(rounds, 'modeSwitch', 'longTasks'),
  );
  push(
    'mode-switch.worker-wait-ms-delta',
    'ms',
    rounds.map((round) => round.modeSwitch.workerWaitMsDelta),
  );
  push(
    'mode-switch.worker-process-ms-delta',
    'ms',
    rounds.map((round) => round.modeSwitch.workerProcessMsDelta),
  );
  push(
    'mode-switch.worker-max-queue-depth',
    'chunks',
    rounds.map((round) => round.modeSwitch.maxWorkerQueueDepth),
  );
  push(
    'mode-switch.worker-max-pending-html',
    'chunks',
    rounds.map((round) => round.modeSwitch.maxWorkerPendingHtmlChunks),
  );
  push(
    'mode-switch.heap-used-delta-mb',
    'MB',
    rounds.map((round) => round.modeSwitch.heapUsedDeltaMb),
  );

  push('scroll.total-ms', 'ms', rounds.map((round) => round.scroll.wallMs));
  push(
    'scroll.renderer-cpu-percent',
    '%',
    rounds.map((round) => round.scroll.cpu.rendererCpuPercent),
  );
  push(
    'scroll.raf-gap-ms',
    'ms',
    rounds.flatMap((round) => round.scroll.observers.rafGaps),
    distributionPerRound(rounds, 'scroll', 'rafGaps'),
  );
  push(
    'scroll.long-task-duration-ms',
    'ms',
    rounds.flatMap((round) => round.scroll.observers.longTasks.map((entry) => entry.duration)),
    distributionPerRound(rounds, 'scroll', 'longTasks'),
  );
  push(
    'scroll.long-task-p95-per-round',
    'ms',
    distributionPerRound(rounds, 'scroll', 'longTasks'),
  );
  push(
    'scroll.worker-wait-ms-delta',
    'ms',
    rounds.map((round) => round.scroll.workerWaitMsDelta),
  );
  push(
    'scroll.worker-process-ms-delta',
    'ms',
    rounds.map((round) => round.scroll.workerProcessMsDelta),
  );
  push(
    'scroll.worker-max-queue-depth',
    'chunks',
    rounds.map((round) => round.scroll.maxWorkerQueueDepth),
  );
  push(
    'scroll.worker-max-pending-html',
    'chunks',
    rounds.map((round) => round.scroll.maxWorkerPendingHtmlChunks),
  );
  push(
    'scroll.heap-used-delta-mb',
    'MB',
    rounds.map((round) => round.scroll.heapUsedDeltaMb),
  );

  push('idle30.renderer-cpu-percent', '%', phaseCpuValues(rounds, 'idle30'));
  push(
    'idle30.raf-gap-ms',
    'ms',
    phaseDistribution(rounds, 'idle30', 'rafGaps'),
    distributionPerRound(rounds, 'idle30', 'rafGaps'),
  );
  push(
    'idle30.long-task-duration-ms',
    'ms',
    phaseDistribution(rounds, 'idle30', 'longTasks'),
    distributionPerRound(rounds, 'idle30', 'longTasks'),
  );
  push('idle30.long-task-p95-per-round', 'ms', phaseDistributionP95(rounds, 'idle30'));
  push(
    'idle30.loaf-duration-ms',
    'ms',
    phaseDistribution(rounds, 'idle30', 'loafEntries'),
    distributionPerRound(rounds, 'idle30', 'loafEntries'),
  );
  push('idle30.heap-used-delta-mb', 'MB', phaseScalar(rounds, 'idle30', 'heapUsedDeltaMb'));
  push('idle30.dom-node-delta', 'nodes', phaseScalar(rounds, 'idle30', 'domNodeDelta'));
  push('idle30.worker-wait-ms-delta', 'ms', phaseScalar(rounds, 'idle30', 'workerWaitMsDelta'));
  push('idle30.worker-process-ms-delta', 'ms', phaseScalar(rounds, 'idle30', 'workerProcessMsDelta'));
  push('idle30.worker-queue-depth-delta', 'chunks', phaseScalar(rounds, 'idle30', 'workerQueueDepthDelta'));
  push('idle30.worker-pending-html-delta', 'chunks', phaseScalar(rounds, 'idle30', 'workerPendingHtmlDelta'));
  push('idle30.worker-max-queue-depth', 'chunks', phaseScalar(rounds, 'idle30', 'maxWorkerQueueDepth'));
  push('idle30.worker-max-pending-html', 'chunks', phaseScalar(rounds, 'idle30', 'maxWorkerPendingHtmlChunks'));
  push('idle30.pending-height-measurements', 'items', phaseScalar(rounds, 'idle30', 'pendingHeightMeasurements'));

  push('final.heap-used-mb', 'MB', rounds.map((round) => mb(heapUsedBytes(round.final))));
  push('final.dom-total-nodes', 'nodes', rounds.map((round) => round.final.dom.totalNodes));
  push('final.dom-cdp-nodes', 'nodes', rounds.map((round) => round.final.dom.cdpNodes));
  push('final.gpu-working-set-mb', 'MB', rounds.map((round) => {
    const gpu = findProcess(round.final.appMetrics, null, 'GPU');
    return memoryMb(gpu);
  }));
  push('final.renderer-working-set-mb', 'MB', rounds.map((round) => {
    const renderer = findProcess(
      round.final.appMetrics,
      round.final.appMetrics.rendererProcessId,
      'Tab',
    );
    return memoryMb(renderer);
  }));

  return rows;
}

function printRows(rows: MetricRow[]): void {
  const header = ['metric', 'unit', 'r1', 'r2', 'r3', 'p50', 'p95', 'max'];
  console.log(`\n${header.join('\t')}`);
  for (const row of rows) {
    console.log(
      [
        row.metric,
        row.unit,
        row.rounds.map((value) => formatNumber(value)).join('\t'),
        formatNumber(row.p50),
        formatNumber(row.p95),
        formatNumber(row.max),
      ].join('\t'),
    );
  }
}

async function main(): Promise<void> {
  const filePath = RESOURCE_MARKDOWN_PATH;
  const roundsCount = Number(process.env.RESOURCE_ROUNDS ?? 3);
  if (!fs.existsSync(filePath)) {
    throw new Error(`resource file missing: ${filePath}`);
  }
  const rounds: ResourceRound[] = [];
  for (let round = 1; round <= roundsCount; round += 1) {
    rounds.push(await runOneResourceRound(round, filePath));
  }
  const rows = buildMetricRows(rounds);
  console.log('\n## RESOURCE_BASELINE_ROWS');
  printRows(rows);
  console.log('\n## RESOURCE_BASELINE_COMPACT');
  console.log(JSON.stringify({ rounds: rounds.map(compactRound), rows }, null, 2));
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

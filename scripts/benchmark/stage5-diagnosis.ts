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

interface LongTaskEntry {
  startTime: number;
  duration: number;
  name: string;
  attribution: string;
}

interface MutationCounts {
  childListAdded: number;
  childListRemoved: number;
  attributes: number;
  characterData: number;
  styleChanges: number;
  affectedElements: number;
  maxTextMutationLength: number;
}

interface Stage5Event {
  path: string;
  phase: string;
  start: number;
  duration: number;
  detail?: Record<string, unknown>;
}

interface PathResult {
  name: string;
  wallMs: number;
  timedOut: boolean;
  longTasks: LongTaskEntry[];
  mutations: MutationCounts;
  detail: Record<string, unknown>;
  error?: string;
}

interface ElectronHandle {
  child: ReturnType<typeof spawn>;
  browser: Browser;
  page: Page;
  port: number;
  spawnedAt: number;
}

interface CdpMetrics {
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<{ ok: true; value: T } | { ok: false; label: string }> {
  const timeout = waitUnref(timeoutMs).then(() => ({ ok: false as const, label }));
  const result = await Promise.race([
    promise.then((value) => ({ ok: true as const, value })),
    timeout,
  ]);
  return result;
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

async function connectToElectron(
  port: number,
  timeoutMs: number,
): Promise<Browser> {
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

async function installLongTaskObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as {
      __stage5LongTasks?: LongTaskEntry[];
      __stage5LongTaskObserver?: PerformanceObserver;
    };
    target.__stage5LongTasks = [];
    target.__stage5LongTaskObserver?.disconnect();
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const timing = entry as PerformanceEntry & {
          duration: number;
          attribution?: Array<{ name?: string; containerType?: string }>;
        };
        target.__stage5LongTasks?.push({
          startTime: timing.startTime,
          duration: timing.duration,
          name: timing.name,
          attribution: (timing.attribution ?? [])
            .map((item) => `${item.name ?? ''}:${item.containerType ?? ''}`)
            .join('|'),
        });
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
    target.__stage5LongTaskObserver = observer;
  });
}

async function clearLongTasks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as { __stage5LongTasks?: LongTaskEntry[] };
    if (target.__stage5LongTasks) {
      target.__stage5LongTasks.length = 0;
    }
  });
}

async function installRuntimeCounters(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const benchmarkWindow = window;
    const editor = benchmarkWindow.__marivellEditor;
    if (!editor?.view) {
      return false;
    }
    const existing = benchmarkWindow.__stage5RuntimeCounters;
    if (existing?.installed) {
      return true;
    }
    const counters = {
      installed: true,
      dispatchCount: 0,
      dispatchMs: 0,
      rectCount: 0,
      rectMs: 0,
      posAtCoordsCount: 0,
      posAtCoordsMs: 0,
    };
    const view = editor.view;
    const originalDispatch = view.dispatch.bind(view);
    view.dispatch = (tr) => {
      const start = performance.now();
      counters.dispatchCount += 1;
      originalDispatch(tr);
      counters.dispatchMs += performance.now() - start;
    };
    const originalPos = view.posAtCoords.bind(view);
    view.posAtCoords = (...args) => {
      const start = performance.now();
      counters.posAtCoordsCount += 1;
      const result = originalPos(...args);
      counters.posAtCoordsMs += performance.now() - start;
      return result;
    };
    const originalRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (...args) {
      const start = performance.now();
      const result = originalRect.apply(this, args);
      counters.rectCount += 1;
      counters.rectMs += performance.now() - start;
      return result;
    };
    benchmarkWindow.__stage5RuntimeCounters = {
      installed: true,
      snapshot: () => ({
        dispatchCount: counters.dispatchCount,
        dispatchMs: counters.dispatchMs,
        rectCount: counters.rectCount,
        rectMs: counters.rectMs,
        posAtCoordsCount: counters.posAtCoordsCount,
        posAtCoordsMs: counters.posAtCoordsMs,
      }),
    };
    return true;
  })()`);
}

async function getCdpMetrics(page: Page): Promise<CdpMetrics> {
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  const result = await session.send('Performance.getMetrics');
  await session.detach();
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
    taskDuration: after.taskDuration - before.taskDuration,
    scriptDuration: after.scriptDuration - before.scriptDuration,
    layoutDuration: after.layoutDuration - before.layoutDuration,
    layoutCount: after.layoutCount - before.layoutCount,
    recalcStyleDuration: after.recalcStyleDuration - before.recalcStyleDuration,
    recalcStyleCount: after.recalcStyleCount - before.recalcStyleCount,
    paintDuration: after.paintDuration - before.paintDuration,
    compositeDuration: after.compositeDuration - before.compositeDuration,
    taskCount: after.taskCount - before.taskCount,
  };
}

const cdpByPath: Record<string, CdpMetrics> = {};

async function measureWithCdp(
  page: Page,
  name: string,
  measure: () => Promise<PathResult>,
  timeoutMs: number,
  label: string,
): Promise<{ ok: true; value: PathResult } | { ok: false; label: string }> {
  const before = await getCdpMetrics(page);
  const result = await withTimeout(measure(), timeoutMs, label);
  if (result.ok) {
    cdpByPath[name] = cdpDelta(before, await getCdpMetrics(page));
  }
  return result;
}

function subtractSnapshot(
  before: Record<string, any> | null | undefined,
  after: Record<string, any> | null | undefined,
): Record<string, unknown> | null {
  if (!before || !after) {
    return null;
  }
  const sub = (left: any, right: any): any => {
    if (typeof left === 'number' && typeof right === 'number') {
      return right - left;
    }
    if (left && right && typeof left === 'object' && typeof right === 'object') {
      const out: Record<string, any> = {};
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        if (key in left && key in right) {
          out[key] = sub(left[key], right[key]);
        }
      }
      return out;
    }
    return right;
  };
  return sub(before, after);
}

function longTaskSummary(tasks: LongTaskEntry[]): Record<string, number> {
  const over50 = tasks.filter((task) => task.duration > 50);
  const buckets = {
    '50-100ms': over50.filter((task) => task.duration <= 100).length,
    '100-200ms': over50.filter((task) => task.duration > 100 && task.duration <= 200).length,
    '200-400ms': over50.filter((task) => task.duration > 200 && task.duration <= 400).length,
    '400-800ms': over50.filter((task) => task.duration > 400 && task.duration <= 800).length,
    '800ms+': over50.filter((task) => task.duration > 800).length,
  };
  const totalMs = over50.reduce((sum, task) => sum + task.duration, 0);
  const maxMs = over50.reduce((max, task) => Math.max(max, task.duration), 0);
  return {
    count: over50.length,
    totalMs: Math.round(totalMs * 10) / 10,
    maxMs: Math.round(maxMs * 10) / 10,
    ...buckets,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]! * 10) / 10;
}

function summarizeDurations(values: number[]): {
  count: number;
  totalMs: number;
  p50: number;
  p95: number;
  max: number;
} {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    count: sorted.length,
    totalMs: Math.round(sorted.reduce((sum, value) => sum + value, 0) * 10) / 10,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: percentile(sorted, 100),
  };
}

function eventExclusiveDuration(
  event: Stage5Event,
  allEvents: Stage5Event[],
): number {
  const start = event.start;
  const end = start + event.duration;
  let childMs = 0;
  for (const other of allEvents) {
    if (other === event) {
      continue;
    }
    const otherStart = other.start;
    const otherEnd = otherStart + other.duration;
    if (otherStart >= start && otherEnd <= end) {
      childMs += other.duration;
    }
  }
  return Math.max(0, event.duration - childMs);
}

function summarizeEvents(events: Stage5Event[]): {
  byPhase: Record<string, ReturnType<typeof summarizeDurations> & { exclusiveMs: number }>;
  totalExclusiveMs: number;
} {
  const durationsByPhase = new Map<string, number[]>();
  for (const event of events) {
    const key = `${event.path}:${event.phase}`;
    const values = durationsByPhase.get(key) ?? [];
    values.push(event.duration);
    durationsByPhase.set(key, values);
  }
  const byPhase: Record<string, ReturnType<typeof summarizeDurations> & { exclusiveMs: number }> = {};
  let totalExclusiveMs = 0;
  for (const [key, values] of durationsByPhase) {
    byPhase[key] = {
      ...summarizeDurations(values),
      exclusiveMs: 0,
    };
  }
  for (const event of events) {
    const key = `${event.path}:${event.phase}`;
    const exclusive = eventExclusiveDuration(event, events);
    byPhase[key]!.exclusiveMs += exclusive;
    totalExclusiveMs += exclusive;
  }
  return { byPhase, totalExclusiveMs };
}

async function measureOperation(
  page: Page,
  name: string,
  operationBody: string,
): Promise<PathResult> {
  await clearLongTasks(page);
  const script = `(async () => {
    const longBefore = (window.__stage5LongTasks ?? []).length;
    const runtimeBefore = window.__stage5RuntimeCounters?.snapshot?.() ?? null;
    const mathBefore = window.__marivellMathSyntaxDiagnostics
      ? { ...window.__marivellMathSyntaxDiagnostics }
      : null;
    const chunkBefore = window.__marivellFormulaChunkDiagnostics
      ? { ...window.__marivellFormulaChunkDiagnostics }
      : null;
    const heightBefore = window.__marivellGetInlineMathHeightPrefetchStats?.() ?? null;
    const widthBefore = window.__marivellGetEditorWidthBucketDiagnostics?.() ?? null;
    const cacheBefore = window.__marivellGetNodeHeightCacheStats?.() ?? null;
    const eventBefore = Array.isArray(window.__stage5Events)
      ? window.__stage5Events.length
      : 0;
    const mutations = {
      childListAdded: 0,
      childListRemoved: 0,
      attributes: 0,
      characterData: 0,
      styleChanges: 0,
      affectedElements: 0,
      maxTextMutationLength: 0,
    };
    const affectedElements = new Set();
    const mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'childList') {
          mutations.childListAdded += record.addedNodes.length;
          mutations.childListRemoved += record.removedNodes.length;
          for (const node of record.addedNodes) {
            if (node instanceof Element) {
              affectedElements.add(node);
            }
          }
          for (const node of record.removedNodes) {
            if (node instanceof Element) {
              affectedElements.add(node);
            }
          }
        } else if (record.type === 'attributes') {
          mutations.attributes += 1;
          if (record.attributeName === 'style') {
            mutations.styleChanges += 1;
          }
          if (record.target instanceof Element) {
            affectedElements.add(record.target);
          }
        } else if (record.type === 'characterData') {
          mutations.characterData += 1;
          const length = record.target.textContent?.length ?? 0;
          mutations.maxTextMutationLength = Math.max(mutations.maxTextMutationLength, length);
        }
      }
    });
    mutationObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const start = performance.now();
    let timedOut = false;
    let error = null;
    let detail = {};
    try {
      const result = await (async () => { ${operationBody} })();
      detail = result ?? {};
      if (typeof result?.timedOut === 'boolean') {
        timedOut = result.timedOut;
      }
    } catch (err) {
      error = String(err);
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    mutationObserver.disconnect();
    mutations.affectedElements = affectedElements.size;
    const wallMs = performance.now() - start;
    const longTasks = (window.__stage5LongTasks ?? []).slice(longBefore);
    const runtimeAfter = window.__stage5RuntimeCounters?.snapshot?.() ?? null;
    const mathAfter = window.__marivellMathSyntaxDiagnostics
      ? { ...window.__marivellMathSyntaxDiagnostics }
      : null;
    const chunkAfter = window.__marivellFormulaChunkDiagnostics
      ? { ...window.__marivellFormulaChunkDiagnostics }
      : null;
    const heightAfter = window.__marivellGetInlineMathHeightPrefetchStats?.() ?? null;
    const widthAfter = window.__marivellGetEditorWidthBucketDiagnostics?.() ?? null;
    const cacheAfter = window.__marivellGetNodeHeightCacheStats?.() ?? null;
    const events = (window.__stage5Events ?? []).slice(eventBefore).map((event) => ({
      ...event,
      start: Math.round((event.start - start) * 1000) / 1000,
    }));
    return {
      wallMs,
      timedOut,
      longTasks,
      mutations,
      detail: {
        ...detail,
        events,
        runtime: runtimeBefore && runtimeAfter
          ? { before: runtimeBefore, after: runtimeAfter }
          : null,
        mathSyntax: mathBefore && mathAfter ? { before: mathBefore, after: mathAfter } : null,
        formulaChunks: chunkBefore && chunkAfter ? { before: chunkBefore, after: chunkAfter } : null,
        heightStats: heightBefore && heightAfter ? { before: heightBefore, after: heightAfter } : null,
        widthBucket: widthBefore && widthAfter
          ? {
              before: widthBefore,
              after: widthAfter,
            }
          : null,
        nodeHeightCache: cacheBefore && cacheAfter ? { before: cacheBefore, after: cacheAfter } : null,
      },
      error,
    };
  })()`;
  const result = await page.evaluate(script) as {
    wallMs: number;
    timedOut: boolean;
    longTasks: LongTaskEntry[];
    mutations: MutationCounts;
    detail: Record<string, unknown>;
    error: string | null;
  };
  const runtime = result.detail.runtime as { before: Record<string, any>; after: Record<string, any> } | null | undefined;
  if (runtime?.before && runtime?.after) {
    result.detail.runtime = {
      ...runtime,
      delta: subtractSnapshot(runtime.before, runtime.after),
    };
  }
  const mathSyntax = result.detail.mathSyntax as { before: Record<string, any>; after: Record<string, any> } | null | undefined;
  if (mathSyntax?.before && mathSyntax?.after) {
    result.detail.mathSyntax = {
      ...mathSyntax,
      delta: subtractSnapshot(mathSyntax.before, mathSyntax.after),
    };
  }
  const formulaChunks = result.detail.formulaChunks as { before: Record<string, any>; after: Record<string, any> } | null | undefined;
  if (formulaChunks?.before && formulaChunks?.after) {
    result.detail.formulaChunks = {
      ...formulaChunks,
      delta: subtractSnapshot(formulaChunks.before, formulaChunks.after),
    };
  }
  const heightStats = result.detail.heightStats as { before: Record<string, any>; after: Record<string, any> } | null | undefined;
  if (heightStats?.before && heightStats?.after) {
    result.detail.heightStats = {
      ...heightStats,
      delta: subtractSnapshot(heightStats.before, heightStats.after),
    };
  }
  const nodeHeightCache = result.detail.nodeHeightCache as { before: Record<string, any>; after: Record<string, any> } | null | undefined;
  if (nodeHeightCache?.before && nodeHeightCache?.after) {
    result.detail.nodeHeightCache = {
      ...nodeHeightCache,
      delta: subtractSnapshot(nodeHeightCache.before, nodeHeightCache.after),
    };
  }
  return { name, ...result, error: result.error ?? undefined };
}

async function waitForVisualReady(
  page: Page,
  expectedTextLength: number,
  deadlineMs: number,
): Promise<{ wallMs: number; timedOut: boolean }> {
  return page.evaluate(
    async ({ expectedLength, deadlineMs }) => {
      const start = performance.now();
      const deadline = start + deadlineMs;
      while (performance.now() < deadline) {
        const loading = document.querySelector('.editor-loading');
        const surface = document.querySelector('.editor-surface');
        if (!loading && surface && surface.innerText.length > expectedLength) {
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return { wallMs: performance.now() - start, timedOut: false };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return { wallMs: performance.now() - start, timedOut: true };
    },
    { expectedLength: expectedTextLength, deadlineMs },
  );
}

function formatPathResult(result: PathResult): string {
  const long = longTaskSummary(result.longTasks);
  const events = result.detail.events as Stage5Event[] | undefined;
  const phaseLines = events
    ? Object.entries(summarizeEvents(events).byPhase)
        .sort((a, b) => b[1].exclusiveMs - a[1].exclusiveMs)
        .map(([key, value]) => `    ${key} count=${value.count} total=${value.totalMs} p50=${value.p50} p95=${value.p95} max=${value.max} exclusive=${Math.round(value.exclusiveMs * 10) / 10}`)
        .join('\n')
    : '    no stage5 product events';
  return [
    `path: ${result.name}`,
    `  wallMs=${Math.round(result.wallMs * 10) / 10}`,
    `  timedOut=${result.timedOut}`,
    `  longTaskCount=${long.count} totalMs=${long.totalMs} maxMs=${long.maxMs}`,
    `  longTaskBuckets=${JSON.stringify({
      '50-100': long['50-100ms'],
      '100-200': long['100-200ms'],
      '200-400': long['200-400ms'],
      '400-800': long['400-800ms'],
      '800+': long['800ms+'],
    })}`,
    `  mutations=${JSON.stringify(result.mutations)}`,
    `  phases:\n${phaseLines}`,
    `  detail=${JSON.stringify(result.detail).slice(0, 8000)}`,
    result.error ? `  error=${result.error}` : '',
  ].filter(Boolean).join('\n');
}

function printSummary(paths: PathResult[], output: Record<string, unknown>): void {
  console.log('\nStage 5 summary');
  for (const result of paths) {
    const long = longTaskSummary(result.longTasks);
    const cdp = cdpByPath[result.name];
    const events = result.detail.events as Stage5Event[] | undefined;
    const phaseSummary = summarizeEvents(events ?? []);
    console.log(
      `${result.name}: wall=${Math.round(result.wallMs * 10) / 10}ms longTasks=${long.count} longTaskMs=${long.totalMs} layoutCount=${Math.round(cdp?.layoutCount ?? 0)} layoutMs=${Math.round((cdp?.layoutDuration ?? 0) * 10) / 10} recalcCount=${Math.round(cdp?.recalcStyleCount ?? 0)} recalcMs=${Math.round((cdp?.recalcStyleDuration ?? 0) * 10) / 10} phaseExclusive=${Math.round(phaseSummary.totalExclusiveMs * 10) / 10}ms`,
    );
  }
  const outputPath = output.outputPath as string;
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nSaved raw diagnosis JSON to ${outputPath}`);
}

function buildTypingBody(iterations: number): string {
  return `
    const editor = window.__marivellEditor;
    if (!editor) throw new Error('editor missing');
    const results = [];
    for (let index = 0; index < ${iterations}; index += 1) {
      let from = -1;
      let to = -1;
      editor.state.doc.descendants((node, pos) => {
        if (from !== -1) return false;
        if (node.isTextblock && node.textContent) {
          from = pos + 1;
          to = pos + 1 + node.textContent.length;
          return false;
        }
        return true;
      });
      if (from === -1) throw new Error('no text block');
      editor.commands.setTextSelection({ from, to: from });
      const marker = 'PERF_STAGE5_TYPING_' + index + '_' + Date.now();
      const ok = document.execCommand('insertText', false, marker);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\\n', '\\n');
      results.push({
        index,
        ok: Boolean(ok && text.includes(marker)),
        markerLength: marker.length,
      });
      editor.commands.undo();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    return { iterations: results.length, results, timedOut: false };
  `;
}

function buildScrollBody(iterations: number): string {
  return `
    const frame = document.querySelector('.editor-frame');
    if (!frame || frame.classList.contains('is-source')) {
      return { error: 'not visual mode', timedOut: true };
    }
    const runtimeBeforeAll = window.__stage5RuntimeCounters?.snapshot?.() ?? null;
    const mathBeforeAll = window.__marivellMathSyntaxDiagnostics
      ? { ...window.__marivellMathSyntaxDiagnostics }
      : null;
    const frameMutations = {
      childListAdded: 0,
      childListRemoved: 0,
      attributes: 0,
      characterData: 0,
      styleChanges: 0,
      affectedElements: 0,
      maxTextMutationLength: 0,
    };
    let activeFrame = -1;
    let frameAffectedElements = new Set();
    const mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (activeFrame < 0) continue;
        if (record.type === 'childList') {
          frameMutations.childListAdded += record.addedNodes.length;
          frameMutations.childListRemoved += record.removedNodes.length;
          for (const node of record.addedNodes) {
            if (node instanceof Element) frameAffectedElements.add(node);
          }
          for (const node of record.removedNodes) {
            if (node instanceof Element) frameAffectedElements.add(node);
          }
        } else if (record.type === 'attributes') {
          frameMutations.attributes += 1;
          if (record.attributeName === 'style') frameMutations.styleChanges += 1;
          if (record.target instanceof Element) frameAffectedElements.add(record.target);
        } else if (record.type === 'characterData') {
          frameMutations.characterData += 1;
          frameMutations.maxTextMutationLength = Math.max(
            frameMutations.maxTextMutationLength,
            record.target.textContent?.length ?? 0,
          );
        }
      }
    });
    mutationObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
    const target = Math.round(maxScrollTop * 0.5);
    const steps = ${iterations};
    const perFrame = [];
    let before = runtimeBeforeAll;
    let mathBeforeFrame = mathBeforeAll;
    frame.scrollTop = 0;
    frame.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    for (let index = 0; index < steps; index += 1) {
      activeFrame = index;
      frameAffectedElements = new Set();
      const next = Math.round(maxScrollTop * ((index + 1) / steps));
      const stepStart = performance.now();
      frame.scrollTop = next;
      frame.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const stepMs = performance.now() - stepStart;
      frameMutations.affectedElements = frameAffectedElements.size;
      const after = window.__stage5RuntimeCounters?.snapshot?.() ?? null;
      const mathAfter = window.__marivellMathSyntaxDiagnostics
        ? { ...window.__marivellMathSyntaxDiagnostics }
        : null;
      perFrame.push({
        index,
        stepMs: Math.round(stepMs * 10) / 10,
        scrollTop: next,
        dispatch: after?.dispatchCount - (before?.dispatchCount ?? 0),
        dispatchMs: after?.dispatchMs - (before?.dispatchMs ?? 0),
        rect: after?.rectCount - (before?.rectCount ?? 0),
        rectMs: after?.rectMs - (before?.rectMs ?? 0),
        posAtCoords: after?.posAtCoordsCount - (before?.posAtCoordsCount ?? 0),
        posAtCoordsMs: after?.posAtCoordsMs - (before?.posAtCoordsMs ?? 0),
        mathSyntaxFullBuilds: (mathAfter?.fullBuildCount ?? 0) - (mathBeforeFrame?.fullBuildCount ?? 0),
        mathSyntaxLocalBuilds: (mathAfter?.localBuildCount ?? 0) - (mathBeforeFrame?.localBuildCount ?? 0),
        mutations: { ...frameMutations },
      });
      frameMutations.childListAdded = 0;
      frameMutations.childListRemoved = 0;
      frameMutations.attributes = 0;
      frameMutations.characterData = 0;
      frameMutations.styleChanges = 0;
      frameMutations.affectedElements = 0;
      frameMutations.maxTextMutationLength = 0;
      before = after;
      mathBeforeFrame = mathAfter;
      activeFrame = -1;
    }
    const placeholderSelectors = [
      '[data-virtual-node-id].math-block-node-placeholder',
      '[data-virtual-node-id].image-node__placeholder',
      '[data-virtual-node-id].mermaid-node__placeholder',
      '[data-virtual-node-id].html-block-placeholder',
      '[data-virtual-node-id].code-block-node--placeholder',
    ];
    const isInlineMathPlaceholder = (element) => {
      if (element.classList.contains('math-inline-node--placeholder')) return true;
      const preview = element.querySelector(':scope > .math-node-preview');
      if (!preview) return true;
      if (preview.querySelector('.katex')) return false;
      if (preview.querySelector('.katex-error')) return false;
      if (preview.querySelector('.math-node-empty-hint, .math-node-placeholder-hint') !== null) return false;
      return !Array.from(preview.childNodes).some(
        (child) => child.nodeType === Node.TEXT_NODE && Boolean(child.textContent?.trim()),
      );
    };
    const visiblePlaceholderCount = () => {
      const frameRect = frame.getBoundingClientRect();
      let count = 0;
      for (const selector of placeholderSelectors) {
        for (const element of frame.querySelectorAll(selector)) {
          const rect = element.getBoundingClientRect();
          if (rect.bottom > frameRect.top && rect.top < frameRect.bottom) count += 1;
        }
      }
      for (const element of frame.querySelectorAll('.math-inline-node')) {
        if (isInlineMathPlaceholder(element)) {
          const rect = element.getBoundingClientRect();
          if (rect.bottom > frameRect.top && rect.top < frameRect.bottom) count += 1;
        }
      }
      return count;
    };
    mutationObserver.disconnect();
    const deadline = performance.now() + 15000;
    let placeholders = visiblePlaceholderCount();
    while (placeholders > 0 && performance.now() < deadline) {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      placeholders = visiblePlaceholderCount();
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      steps: perFrame,
      target,
      finalScrollTop: frame.scrollTop,
      maxScrollTop: Math.max(frame.scrollHeight - frame.clientHeight, 0),
      placeholders,
      timedOut: placeholders > 0,
      phase4Timings: window.__marivellPhase4Timings ?? null,
      hydrateTimings: window.__marivellPhase4HydrateTimings ?? null,
      scrollHotpathDiagnostics: window.__marivellScrollHotpathDiagnostics ?? null,
      inlineMathActivationReadyMs: window.__marivellInlineMathActivationReadyMs ?? 0,
    };
  `;
}

function buildKatexBody(iterations: number, cold: boolean): string {
  return `
    const frame = document.querySelector('.editor-frame');
    if (!frame || frame.classList.contains('is-source')) {
      return { error: 'not visual mode', timedOut: true };
    }
    const benchmarkWindow = window;
    const runs = [];
    for (let index = 0; index < ${iterations}; index += 1) {
      if (typeof benchmarkWindow.__marivellClearFormulaHtmlCache === 'function') {
        benchmarkWindow.__marivellClearFormulaHtmlCache();
      }
      if (${cold} && typeof benchmarkWindow.__marivellClearPreparedFormulaHtml === 'function') {
        benchmarkWindow.__marivellClearPreparedFormulaHtml();
      }
      if (typeof benchmarkWindow.__marivellResetScrollAnchorCompensation === 'function') {
        benchmarkWindow.__marivellResetScrollAnchorCompensation();
      }
      if (typeof benchmarkWindow.__marivellResetInlineMathActivationMetrics === 'function') {
        benchmarkWindow.__marivellResetInlineMathActivationMetrics();
      }
      if (typeof benchmarkWindow.__marivellResetHydrationSyncForTest === 'function') {
        benchmarkWindow.__marivellResetHydrationSyncForTest();
      }
      const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
      const targetRatio = ${cold} ? 0.98 : (0.2 + (index % 5) * 0.15);
      const target = Math.round(maxScrollTop * targetRatio);
      const runStart = performance.now();
      const unPauseBeforeHydration = new Promise((resolve) => {
        requestAnimationFrame(() => {
          if (typeof benchmarkWindow.__marivellSetHeightMeasurementScrollPaused === 'function') {
            benchmarkWindow.__marivellSetHeightMeasurementScrollPaused(false);
          }
          resolve();
        });
      });
      frame.scrollTop = 0;
      frame.scrollTop = target;
      const afterAssignScrollTop = frame.scrollTop;
      frame.dispatchEvent(new Event('scroll'));
      await unPauseBeforeHydration;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const isRealKatex = (element) => {
        const preview = element.querySelector(':scope > .math-node-preview');
        if (!preview) return false;
        if (preview.querySelector('.katex')) return true;
        if (preview.querySelector('.katex-error')) return true;
        if (preview.querySelector('.math-node-empty-hint, .math-node-placeholder-hint')) return true;
        return Array.from(preview.childNodes).some(
          (child) => child.nodeType === Node.TEXT_NODE && Boolean(child.textContent?.trim()),
        );
      };
      const visibleStats = () => {
        const frameRect = frame.getBoundingClientRect();
        let total = 0;
        let real = 0;
        let notReal = 0;
        for (const element of frame.querySelectorAll('.math-inline-node, .math-block-node')) {
          const rect = element.getBoundingClientRect();
          if (rect.bottom <= frameRect.top || rect.top >= frameRect.bottom) continue;
          total += 1;
          if (isRealKatex(element)) real += 1; else notReal += 1;
        }
        return { total, real, notReal };
      };
      const firstStats = visibleStats();
      const firstSeenAt = firstStats.notReal > 0 ? performance.now() : null;
      const deadline = performance.now() + 30000;
      let finalStats = firstStats;
      while (finalStats.notReal > 0 && performance.now() < deadline) {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        finalStats = visibleStats();
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      runs.push({
        index,
        fullMs: performance.now() - runStart,
        readyMs: firstSeenAt === null ? 0 : performance.now() - firstSeenAt,
        firstStats,
        finalStats,
        target,
        afterAssignScrollTop,
        finalScrollTop: frame.scrollTop,
        timedOut: finalStats.notReal > 0,
        phase4Timings: window.__marivellPhase4Timings ?? null,
        hydrateTimings: window.__marivellPhase4HydrateTimings ?? null,
        scrollHotpathDiagnostics: window.__marivellScrollHotpathDiagnostics ?? null,
        inlineMathActivationReadyMs: window.__marivellInlineMathActivationReadyMs ?? 0,
      });
    }
    return {
      runs,
      timedOut: runs.some((run) => run.timedOut),
      cold: ${cold},
    };
  `;
}

async function main(): Promise<void> {
  const markdownPath = process.argv[2];
  if (!markdownPath || !fs.existsSync(markdownPath)) {
    throw new Error('usage: npx tsx scripts/benchmark/stage5-diagnosis.ts <markdown-file>');
  }
  const iterations = Number(process.env.STAGE5_ITERATIONS ?? 5);
  const katexIterations = Number(process.env.STAGE5_KATEX_ITERATIONS ?? iterations);
  const outDir = path.join(os.tmpdir(), `marivell-stage5-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-stage5-profile-${process.pid}`);
  const port = 9500 + (process.pid % 200);
  const sourceSize = fs.statSync(markdownPath).size;
  const expectedVisualTextLength = Math.min(Math.max(sourceSize * 0.35, 1_000), 500_000);
  const openTimeoutMs = Number(process.env.MARIVELL_STAGE5_OPEN_TIMEOUT_MS ?? 90_000);
  const operationTimeoutMs = Number(process.env.MARIVELL_STAGE5_OP_TIMEOUT_MS ?? 120_000);

  console.log(`Stage 5 diagnosis for ${markdownPath}`);
  console.log(`sourceSize=${sourceSize} expectedVisualTextLength=${expectedVisualTextLength} iterations=${iterations} katexIterations=${katexIterations}`);
  console.log('Building renderer bundle...');
  await buildRenderer(outDir);
  console.log('Launching Electron...');
  const handle = await launchElectron(outDir, markdownPath, port, profile);
  const results: PathResult[] = [];

  try {
    await installLongTaskObserver(handle.page);
    const ready = await waitForVisualReady(handle.page, expectedVisualTextLength, openTimeoutMs);
    console.log(`open-ready wallMs=${Math.round(ready.wallMs * 10) / 10} timedOut=${ready.timedOut}`);
    const runtimeInstalled = await installRuntimeCounters(handle.page);
    console.log(`runtimeCountersInstalled=${runtimeInstalled}`);
    const productEventsAvailable = await handle.page.evaluate(
      () => Array.isArray((window as unknown as { __stage5Events?: unknown[] }).__stage5Events),
    );
    console.log(`stage5ProductEventsAvailable=${productEventsAvailable}`);

    const typingResult = await measureWithCdp(
      handle.page,
      'typing',
      () => measureOperation(handle.page, 'typing', buildTypingBody(iterations)),
      operationTimeoutMs,
      'typing',
    );
    if (typingResult.ok) {
      results.push(typingResult.value);
      console.log('\n' + formatPathResult(typingResult.value));
    } else {
      console.log('typing timeout');
    }

    const scrollResult = await measureWithCdp(
      handle.page,
      'scroll-frames',
      () => measureOperation(handle.page, 'scroll-frames', buildScrollBody(iterations)),
      operationTimeoutMs,
      'scroll-frames',
    );
    if (scrollResult.ok) {
      results.push(scrollResult.value);
      console.log('\n' + formatPathResult(scrollResult.value));
    } else {
      console.log('scroll-frames timeout');
    }

    const katexWarmResult = await measureWithCdp(
      handle.page,
      'katex-ready-warm',
      () => measureOperation(handle.page, 'katex-ready-warm', buildKatexBody(katexIterations, false)),
      operationTimeoutMs,
      'katex-ready-warm',
    );
    if (katexWarmResult.ok) {
      results.push(katexWarmResult.value);
      console.log('\n' + formatPathResult(katexWarmResult.value));
    } else {
      console.log('katex-ready-warm timeout');
    }

    const katexColdResult = await measureWithCdp(
      handle.page,
      'katex-ready-cold',
      () => measureOperation(handle.page, 'katex-ready-cold', buildKatexBody(1, true)),
      operationTimeoutMs,
      'katex-ready-cold',
    );
    if (katexColdResult.ok) {
      results.push(katexColdResult.value);
      console.log('\n' + formatPathResult(katexColdResult.value));
    } else {
      console.log('katex-ready-cold timeout');
    }

    const output = {
      markdownPath,
      commit: process.env.GIT_COMMIT ?? '',
      node: process.version,
      platform: process.platform,
      sourceSize,
      iterations,
      katexIterations,
      runtimeCountersInstalled: runtimeInstalled,
      productEventsAvailable,
      cdpByPath,
      paths: results.map((result) => ({
        ...result,
        longTaskSummary: longTaskSummary(result.longTasks),
        phaseSummary: summarizeEvents((result.detail.events as Stage5Event[] | undefined) ?? []),
      })),
    };
    const outputPath = `/tmp/marivell-stage5-${path.basename(markdownPath).replace(/\.[^.]+$/, '')}.json`;
    printSummary(results, { ...output, outputPath });
  } finally {
    if (process.platform !== 'win32') {
      try {
        process.kill(-handle.child.pid, 'SIGKILL');
      } catch {
        // process group may already be gone
      }
    }
    handle.child.kill('SIGKILL');
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

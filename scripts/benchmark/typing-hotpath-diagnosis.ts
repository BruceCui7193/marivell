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

interface RectSample {
  method: string;
  target: string;
  atMs: number;
  stack: string;
}

interface RuntimeSnapshot {
  dispatchCount: number;
  dispatchMs: number;
  rectCount: number;
  rectMs: number;
  coordsAtPosCount: number;
  coordsAtPosMs: number;
  posAtCoordsCount: number;
  posAtCoordsMs: number;
  rectSamples: RectSample[];
}

interface MathSyntaxSnapshot {
  fullBuildCount: number;
  localBuildCount: number;
  spanCount: number;
  rangeCount: number;
  viewportFrom: number;
  viewportTo: number;
  viewportDispatchCount: number;
  viewportSkippedCount: number;
}

interface RunResult {
  index: number;
  ok: boolean;
  markerPresent: boolean;
  runWallMs: number;
  dispatchCount: number;
  dispatchMs: number;
  rectCount: number;
  rectMs: number;
  insertLocalBuilds: number;
  insertFullBuilds: number;
  undoLocalBuilds: number;
  undoFullBuilds: number;
}

interface TypingResult {
  wallMs: number;
  iterations: number;
  timedOut: boolean;
  selectionOk: boolean;
  selectionWallMs: number;
  runs: RunResult[];
  runtime: {
    before: RuntimeSnapshot;
    after: RuntimeSnapshot;
    delta: Omit<RuntimeSnapshot, 'rectSamples'> & { rectSamples: RectSample[] };
  };
  mathSyntax: {
    before: MathSyntaxSnapshot;
    after: MathSyntaxSnapshot;
    delta: MathSyntaxSnapshot;
  };
  longTasks: LongTaskEntry[];
  error?: string;
}

interface ElectronHandle {
  child: ReturnType<typeof spawn>;
  browser: Browser;
  page: Page;
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
  return Promise.race([
    promise.then((value) => ({ ok: true as const, value })),
    timeout,
  ]);
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
  return { child, browser, page };
}

async function installLongTaskObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as {
      __typingHotpathLongTasks?: LongTaskEntry[];
      __typingHotpathLongTaskObserver?: PerformanceObserver;
    };
    target.__typingHotpathLongTasks = [];
    target.__typingHotpathLongTaskObserver?.disconnect();
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const timing = entry as PerformanceEntry & {
          duration: number;
          attribution?: Array<{ name?: string; containerType?: string }>;
        };
        target.__typingHotpathLongTasks?.push({
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
    target.__typingHotpathLongTaskObserver = observer;
  });
}

async function installRuntimeCounters(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const benchmarkWindow = window;
    const editor = benchmarkWindow.__marivellEditor;
    if (!editor?.view) {
      return false;
    }
    const existing = benchmarkWindow.__typingHotpathRuntime;
    if (existing?.installed) {
      return true;
    }
    const counters = {
      installed: true,
      dispatchCount: 0,
      dispatchMs: 0,
      rectCount: 0,
      rectMs: 0,
      coordsAtPosCount: 0,
      coordsAtPosMs: 0,
      posAtCoordsCount: 0,
      posAtCoordsMs: 0,
      rectSamples: [],
    };
    const view = editor.view;
    const originalDispatch = view.dispatch.bind(view);
    view.dispatch = (tr) => {
      const start = performance.now();
      counters.dispatchCount += 1;
      originalDispatch(tr);
      counters.dispatchMs += performance.now() - start;
    };
    const originalCoords = view.coordsAtPos.bind(view);
    view.coordsAtPos = (...args) => {
      const start = performance.now();
      counters.coordsAtPosCount += 1;
      const result = originalCoords(...args);
      counters.coordsAtPosMs += performance.now() - start;
      return result;
    };
    const originalPos = view.posAtCoords.bind(view);
    view.posAtCoords = (...args) => {
      const start = performance.now();
      counters.posAtCoordsCount += 1;
      const result = originalPos(...args);
      counters.posAtCoordsMs += performance.now() - start;
      return result;
    };
    const describeTarget = (target) => {
      if (target instanceof Element) {
        const className = typeof target.className === 'string'
          ? target.className.trim().split(/\\s+/).filter(Boolean).join('.')
          : '';
        return target.tagName.toLowerCase() + (className ? '.' + className : '');
      }
      return target?.nodeName ?? 'unknown';
    };
    const sampleRect = (method, target) => {
      counters.rectCount += 1;
      if (counters.rectSamples.length >= 8) {
        return;
      }
      const stack = (new Error().stack ?? '')
        .split('\\n')
        .slice(2, 9)
        .join(' | ');
      counters.rectSamples.push({
        method,
        target: describeTarget(target),
        atMs: performance.now(),
        stack,
      });
    };
    const originalElementRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (...args) {
      const start = performance.now();
      const result = originalElementRect.apply(this, args);
      sampleRect('Element.getBoundingClientRect', this);
      counters.rectMs += performance.now() - start;
      return result;
    };
    const originalElementRects = Element.prototype.getClientRects;
    Element.prototype.getClientRects = function (...args) {
      const start = performance.now();
      const result = originalElementRects.apply(this, args);
      sampleRect('Element.getClientRects', this);
      counters.rectMs += performance.now() - start;
      return result;
    };
    const originalRangeRect = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = function (...args) {
      const start = performance.now();
      const result = originalRangeRect.apply(this, args);
      sampleRect('Range.getBoundingClientRect', this.startContainer);
      counters.rectMs += performance.now() - start;
      return result;
    };
    const originalRangeRects = Range.prototype.getClientRects;
    Range.prototype.getClientRects = function (...args) {
      const start = performance.now();
      const result = originalRangeRects.apply(this, args);
      sampleRect('Range.getClientRects', this.startContainer);
      counters.rectMs += performance.now() - start;
      return result;
    };
    benchmarkWindow.__typingHotpathRuntime = {
      installed: true,
      snapshot: () => ({
        dispatchCount: counters.dispatchCount,
        dispatchMs: counters.dispatchMs,
        rectCount: counters.rectCount,
        rectMs: counters.rectMs,
        coordsAtPosCount: counters.coordsAtPosCount,
        coordsAtPosMs: counters.coordsAtPosMs,
        posAtCoordsCount: counters.posAtCoordsCount,
        posAtCoordsMs: counters.posAtCoordsMs,
        rectSamples: counters.rectSamples.slice(),
      }),
    };
    return true;
  })()`);
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
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          return { wallMs: performance.now() - start, timedOut: false };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return { wallMs: performance.now() - start, timedOut: true };
    },
    { expectedLength: expectedTextLength, deadlineMs },
  );
}

function subtractSnapshot(
  before: Record<string, any>,
  after: Record<string, any>,
): Record<string, unknown> {
  const sub = (left: any, right: any): any => {
    if (typeof left === 'number' && typeof right === 'number') {
      return right - left;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      return right;
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

function buildTypingBody(iterations: number): string {
  return `
    const editor = window.__marivellEditor;
    if (!editor) throw new Error('editor missing');
    const runtime = window.__typingHotpathRuntime;
    if (!runtime) throw new Error('runtime counters missing');
    const snapshot = () => runtime.snapshot();
    const mathSnapshot = () => {
      const d = window.__marivellMathSyntaxDiagnostics;
      return d
        ? {
            fullBuildCount: d.fullBuildCount ?? 0,
            localBuildCount: d.localBuildCount ?? 0,
            spanCount: d.spanCount ?? 0,
            rangeCount: d.rangeCount ?? 0,
            viewportFrom: d.viewportFrom ?? -1,
            viewportTo: d.viewportTo ?? -1,
            viewportDispatchCount: d.viewportDispatchCount ?? 0,
            viewportSkippedCount: d.viewportSkippedCount ?? 0,
          }
        : null;
    };
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
    const selectionStart = performance.now();
    const selectionOk = editor.commands.setTextSelection({ from, to: from });
    editor.commands.focus();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const selectionWallMs = performance.now() - selectionStart;
    const runs = [];
    const markerBase = 'PERF_TYPING_' + Date.now();
    for (let index = 0; index < ${iterations}; index += 1) {
      const beforeRun = snapshot();
      const mathBefore = mathSnapshot();
      const runStart = performance.now();
      const marker = markerBase + '_' + index;
      const ok = document.execCommand('insertText', false, marker);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\\n', '\\n');
      const mathAfterInsert = mathSnapshot();
      editor.commands.undo();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const afterUndo = snapshot();
      const mathAfterUndo = mathSnapshot();
      runs.push({
        index,
        ok: Boolean(ok && text.includes(marker)),
        markerPresent: text.includes(marker),
        runWallMs: performance.now() - runStart,
        dispatchCount: afterUndo.dispatchCount - beforeRun.dispatchCount,
        dispatchMs: afterUndo.dispatchMs - beforeRun.dispatchMs,
        rectCount: afterUndo.rectCount - beforeRun.rectCount,
        rectMs: afterUndo.rectMs - beforeRun.rectMs,
        insertLocalBuilds: mathAfterInsert && mathBefore ? mathAfterInsert.localBuildCount - mathBefore.localBuildCount : 0,
        insertFullBuilds: mathAfterInsert && mathBefore ? mathAfterInsert.fullBuildCount - mathBefore.fullBuildCount : 0,
        undoLocalBuilds: mathAfterUndo && mathAfterInsert ? mathAfterUndo.localBuildCount - mathAfterInsert.localBuildCount : 0,
        undoFullBuilds: mathAfterUndo && mathAfterInsert ? mathAfterUndo.fullBuildCount - mathAfterInsert.fullBuildCount : 0,
      });
    }
    return {
      iterations: runs.length,
      timedOut: false,
      selectionOk,
      selectionWallMs,
      runs,
      runtime: { before: snapshot(), after: snapshot() },
      mathSyntax: {
        before: mathSnapshot(),
        after: mathSnapshot(),
      },
    };
  `;
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
  return {
    count: over50.length,
    totalMs: Math.round(over50.reduce((sum, task) => sum + task.duration, 0) * 10) / 10,
    maxMs: Math.round(over50.reduce((max, task) => Math.max(max, task.duration), 0) * 10) / 10,
    ...buckets,
  };
}

function formatResult(result: TypingResult): string {
  const long = longTaskSummary(result.longTasks);
  const delta = result.runtime.delta;
  const math = result.mathSyntax.delta;
  return [
    `wallMs=${Math.round(result.wallMs * 10) / 10}`,
    `selectionOk=${result.selectionOk} selectionWallMs=${Math.round(result.selectionWallMs * 10) / 10}`,
    `dispatchCount=${delta.dispatchCount} dispatchMs=${Math.round(delta.dispatchMs * 10) / 10}`,
    `rectReads=${delta.rectCount} rectMs=${Math.round(delta.rectMs * 10) / 10}`,
    `coordsAtPosCount=${delta.coordsAtPosCount} coordsAtPosMs=${Math.round(delta.coordsAtPosMs * 10) / 10}`,
    `posAtCoordsCount=${delta.posAtCoordsCount} posAtCoordsMs=${Math.round(delta.posAtCoordsMs * 10) / 10}`,
    `mathSyntaxFullBuilds=${math.fullBuildCount} mathSyntaxLocalBuilds=${math.localBuildCount}`,
    `longTasks=${long.count} longTaskMs=${long.totalMs} maxLongTaskMs=${long.maxMs}`,
    `longTaskBuckets=${JSON.stringify({
      '50-100': long['50-100ms'],
      '100-200': long['100-200ms'],
      '200-400': long['200-400ms'],
      '400-800': long['400-800ms'],
      '800+': long['800ms+'],
    })}`,
    `rectSamples=${JSON.stringify(delta.rectSamples)}`,
    `runs=${JSON.stringify(result.runs)}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const markdownPath = process.argv[2];
  if (!markdownPath || !fs.existsSync(markdownPath)) {
    throw new Error('usage: npx tsx scripts/benchmark/typing-hotpath-diagnosis.ts <markdown-file>');
  }
  const iterations = Number(process.env.TYPING_ITERATIONS ?? 5);
  const outDir = path.join(os.tmpdir(), `marivell-typing-hotpath-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-typing-hotpath-profile-${process.pid}`);
  const port = 9400 + (process.pid % 200);
  const sourceSize = fs.statSync(markdownPath).size;
  const expectedVisualTextLength = Math.min(Math.max(sourceSize * 0.35, 1_000), 500_000);

  console.log(`Typing hotpath diagnosis for ${markdownPath}`);
  console.log(`sourceSize=${sourceSize} iterations=${iterations}`);
  console.log('Building renderer bundle...');
  await buildRenderer(outDir);
  console.log('Launching Electron...');
  const handle = await launchElectron(outDir, markdownPath, port, profile);
  let result: TypingResult | null = null;
  try {
    await installLongTaskObserver(handle.page);
    const ready = await withTimeout(
      waitForVisualReady(handle.page, expectedVisualTextLength, 90_000),
      100_000,
      'visual-open',
    );
    console.log(`open-ready wallMs=${Math.round(ready.value?.wallMs ?? 0) / 10} timedOut=${ready.ok ? ready.value.timedOut : true}`);
    if (!ready.ok || ready.value.timedOut) {
      throw new Error('visual editor did not become ready');
    }
    const runtimeInstalled = await installRuntimeCounters(handle.page);
    console.log(`runtimeCountersInstalled=${runtimeInstalled}`);
    if (!runtimeInstalled) {
      throw new Error('runtime counters were not installed');
    }
    const script = `(async () => {
      const longBefore = (window.__typingHotpathLongTasks ?? []).length;
      const runtimeBefore = window.__typingHotpathRuntime?.snapshot?.() ?? null;
      const mathBefore = window.__marivellMathSyntaxDiagnostics
        ? { ...window.__marivellMathSyntaxDiagnostics }
        : null;
      const start = performance.now();
      let timedOut = false;
      let error = null;
      let detail = null;
      try {
        detail = await (async () => { ${buildTypingBody(iterations)} })();
        if (typeof detail?.timedOut === 'boolean') {
          timedOut = detail.timedOut;
        }
      } catch (err) {
        error = String(err);
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const wallMs = performance.now() - start;
      const longTasks = (window.__typingHotpathLongTasks ?? []).slice(longBefore);
      const runtimeAfter = window.__typingHotpathRuntime?.snapshot?.() ?? null;
      const mathAfter = window.__marivellMathSyntaxDiagnostics
        ? { ...window.__marivellMathSyntaxDiagnostics }
        : null;
      return {
        wallMs,
        timedOut,
        error,
        longTasks,
        runtime: runtimeBefore && runtimeAfter ? { before: runtimeBefore, after: runtimeAfter } : null,
        mathSyntax: mathBefore && mathAfter ? { before: mathBefore, after: mathAfter } : null,
        detail,
      };
    })()`;
    const raw = await handle.page.evaluate(script) as {
      wallMs: number;
      timedOut: boolean;
      error: string | null;
      longTasks: LongTaskEntry[];
      runtime: { before: RuntimeSnapshot; after: RuntimeSnapshot } | null;
      mathSyntax: { before: MathSyntaxSnapshot; after: MathSyntaxSnapshot } | null;
      detail: TypingResult | null;
    };
    if (!raw.runtime || !raw.mathSyntax || !raw.detail) {
      throw new Error(raw.error ?? 'missing measurement data');
    }
    const runtimeDelta = subtractSnapshot(
      raw.runtime.before as unknown as Record<string, any>,
      raw.runtime.after as unknown as Record<string, any>,
    ) as unknown as Omit<RuntimeSnapshot, 'rectSamples'> & { rectSamples: RectSample[] };
    const mathDelta = subtractSnapshot(
      raw.mathSyntax.before as unknown as Record<string, any>,
      raw.mathSyntax.after as unknown as Record<string, any>,
    ) as unknown as MathSyntaxSnapshot;
    result = {
      ...raw.detail,
      wallMs: raw.wallMs,
      timedOut: raw.timedOut,
      error: raw.error ?? undefined,
      longTasks: raw.longTasks,
      runtime: {
        before: raw.runtime.before,
        after: raw.runtime.after,
        delta: runtimeDelta,
      },
      mathSyntax: {
        before: raw.mathSyntax.before,
        after: raw.mathSyntax.after,
        delta: mathDelta,
      },
    };
    console.log('\n## typing hotpath result');
    console.log(formatResult(result));
    const output = {
      markdownPath,
      commit: process.env.GIT_COMMIT ?? '',
      node: process.version,
      platform: process.platform,
      sourceSize,
      iterations,
      longTaskSummary: longTaskSummary(raw.longTasks),
      result,
    };
    const outputPath = `/tmp/marivell-typing-hotpath-${path.basename(markdownPath).replace(/\.[^.]+$/, '')}.json`;
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');
    console.log(`\nSaved raw diagnosis JSON to ${outputPath}`);
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
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort.
    }
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

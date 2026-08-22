import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { installPlaceholderHelpers } from './test-utils/placeholder';
import { waitForExclusiveBenchmarkLock } from './test-utils/exclusive-run';
import { buildFormulaDenseMarkdown } from './test-utils/markdown';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const electronBin = path.join(projectRoot, 'node_modules/.bin/electron');
const electronViteBin = path.join(projectRoot, 'node_modules/.bin/electron-vite');

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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<{ ok: true; value: T } | { ok: false; label: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; label: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, label }), timeoutMs);
    timer.unref?.();
  });
  const result = await Promise.race([
    promise.then((value) => ({ ok: true as const, value })),
    timeout,
  ]);
  if (timer) clearTimeout(timer);
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

interface ElectronHandle {
  child: ReturnType<typeof spawn>;
  browser: Browser;
  page: Page;
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

async function waitForVisualReady(
  page: Page,
  expectedTextLength: number,
  deadlineMs: number,
): Promise<boolean> {
  return page.evaluate(
    async ({ expectedLength, deadlineMs }) => {
      const deadline = performance.now() + deadlineMs;
      while (performance.now() < deadline) {
        const loading = document.querySelector('.editor-loading');
        const surface = document.querySelector('.editor-surface');
        const frame = document.querySelector('.editor-frame');
        if (!loading && surface && frame && surface.innerText.length > expectedLength) {
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    },
    { expectedLength: expectedTextLength, deadlineMs },
  );
}

interface ScrollGeometry {
  left: number;
  right: number;
  top: number;
  bottom: number;
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  maxScrollTop: number;
}

async function getScrollGeometry(page: Page): Promise<ScrollGeometry> {
  return page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>('.editor-frame');
    if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
    const rect = frame.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      clientHeight: frame.clientHeight,
      scrollHeight: frame.scrollHeight,
      scrollTop: frame.scrollTop,
      maxScrollTop: Math.max(frame.scrollHeight - frame.clientHeight, 0),
    };
  });
}

async function dragScrollbarToRatio(
  page: Page,
  ratio: number,
  geometry: ScrollGeometry,
): Promise<{ before: number; after: number; moved: boolean }> {
  if (geometry.maxScrollTop <= 0 || geometry.clientHeight <= 0) {
    return { before: geometry.scrollTop, after: geometry.scrollTop, moved: false };
  }
  const scrollbarWidth = 16;
  const trackHeight = geometry.clientHeight;
  const thumbHeight = Math.max(
    32,
    trackHeight * (trackHeight / geometry.scrollHeight),
  );
  const usableTrack = trackHeight - thumbHeight;
  const startY =
    geometry.top +
    (geometry.scrollTop / geometry.maxScrollTop) * usableTrack;
  const endY = geometry.top + ratio * usableTrack;
  const x = geometry.right - Math.max(4, scrollbarWidth / 2);
  await page.mouse.move(x, startY);
  await page.mouse.down();
  const steps = 8;
  for (let index = 1; index <= steps; index += 1) {
    await page.mouse.move(
      x,
      startY + ((endY - startY) * index) / steps,
      { steps: 2 },
    );
  }
  await page.mouse.up();
  await page.waitForTimeout(80);
  const after = (await getScrollGeometry(page)).scrollTop;
  return { before: geometry.scrollTop, after, moved: after !== geometry.scrollTop };
}

async function applyProgrammaticJumpAndWheel(
  page: Page,
  ratio: number,
): Promise<void> {
  await page.evaluate((ratio) => {
    const frame = document.querySelector<HTMLElement>('.editor-frame');
    if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
    const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
    frame.scrollTop = Math.round(maxScrollTop * ratio);
    frame.dispatchEvent(new Event('scroll'));
  }, ratio);
  await page.waitForTimeout(60);
  const rect = await getScrollGeometry(page);
  await page.mouse.move(
    rect.left + Math.max(20, Math.min(rect.right - rect.left - 20, 400)),
    rect.top + Math.max(20, rect.clientHeight / 2),
  );
  await page.mouse.wheel(0, 60);
  await page.waitForTimeout(60);
}

interface PostReleaseResult {
  ratio: number;
  scrollTop: number;
  maxScrollTop: number;
  firstTop: number;
  lastTop: number;
  topChanges: number;
  eventsAfterFirstRaf: number;
  layoutShiftEntries: number;
  layoutShiftCumulative: number;
  layoutShiftSupported: boolean;
  sampledFrames: number;
  nextScrollTop: number;
  nextScrollResponded: boolean;
  dragMoved: boolean;
  dragBefore: number;
  dragAfter: number;
}

async function measurePostRelease(
  page: Page,
  ratio: number,
): Promise<PostReleaseResult> {
  const geometry = await getScrollGeometry(page);
  const drag = await dragScrollbarToRatio(page, ratio, geometry);
  await applyProgrammaticJumpAndWheel(page, ratio);
  const script = `(async () => {
    const frame = document.querySelector('.editor-frame');
    if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
    const events = [];
    const onScroll = () => events.push(performance.now());
    frame.addEventListener('scroll', onScroll, { passive: true });
    const layoutShifts = [];
    let layoutObserver = null;
    try {
      layoutObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          layoutShifts.push({ value: entry.value || 0 });
        }
      });
      layoutObserver.observe({ type: 'layout-shift' });
    } catch {}
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const releaseEventCount = events.length;
    const shiftsBeforeIdle = layoutShifts.length;
    const firstTop = frame.scrollTop;
    const start = performance.now();
    let previousTop = firstTop;
    let topChanges = 0;
    let sampledFrames = 0;
    while (performance.now() - start < 1000 && sampledFrames < 60) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const top = frame.scrollTop;
      if (top !== previousTop) topChanges += 1;
      previousTop = top;
      sampledFrames += 1;
    }
    const lastTop = frame.scrollTop;
    const eventsAfterFirstRaf = events.length - releaseEventCount;
    const idleShifts = layoutShifts.slice(shiftsBeforeIdle);
    const stableTop = lastTop;
    const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
    const nextTarget =
      stableTop > maxScrollTop - 2
        ? Math.max(0, stableTop - frame.clientHeight * 0.2)
        : Math.min(maxScrollTop, stableTop + frame.clientHeight * 0.2);
    frame.scrollTop = nextTarget;
    frame.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const nextScrollTop = frame.scrollTop;
    const nextScrollResponded = nextScrollTop !== stableTop;
    layoutObserver?.disconnect();
    frame.removeEventListener('scroll', onScroll);
    return {
      scrollTop: stableTop,
      maxScrollTop,
      firstTop,
      lastTop,
      topChanges,
      eventsAfterFirstRaf,
      layoutShiftEntries: idleShifts.length,
      layoutShiftCumulative: idleShifts.reduce((total, entry) => total + entry.value, 0),
      layoutShiftSupported: layoutObserver !== null,
      sampledFrames,
      nextScrollTop,
      nextScrollResponded,
    };
  })()`;
  const stable = await page.evaluate(script);
  return {
    ratio,
    ...(stable as Omit<PostReleaseResult, 'ratio' | 'dragMoved' | 'dragBefore' | 'dragAfter'>),
    dragMoved: drag.moved,
    dragBefore: drag.before,
    dragAfter: drag.after,
  };
}

async function resetScrollEventCounter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>('.editor-frame');
    if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
    const benchmarkWindow = window as unknown as Record<string, unknown>;
    benchmarkWindow.__marivellStressScrollEvents = 0;
    benchmarkWindow.__marivellStressScrollListener = () => {
      benchmarkWindow.__marivellStressScrollEvents =
        (benchmarkWindow.__marivellStressScrollEvents as number) + 1;
    };
    frame.addEventListener(
      'scroll',
      benchmarkWindow.__marivellStressScrollListener as EventListener,
      { passive: true },
    );
  });
}

async function getScrollEventCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const benchmarkWindow = window as unknown as Record<string, unknown>;
    return (benchmarkWindow.__marivellStressScrollEvents as number) ?? 0;
  });
}

interface StressRoundResult {
  scrollTop: number;
  maxScrollTop: number;
  waitMs: number;
  timedOut: boolean;
  probe: {
    placeholderCount: number;
    visibleInlineMathCount: number;
    visibleUnrenderedInlineMathCount: number;
    visibleUnloadedImageCount: number;
    grayLatexDirectTextCount: number;
    placeholderDetails: Array<Record<string, unknown>>;
  };
  diagnostics: Record<string, unknown>;
}

async function measureStressRound(
  page: Page,
  deadlineMs: number,
): Promise<StressRoundResult> {
  const script = `(async () => {
    const deadlineMs = ${JSON.stringify(deadlineMs)};
    const frame = document.querySelector('.editor-frame');
    if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
    const start = performance.now();
    let probe = marivellCollectVisiblePlaceholderState(frame);
    let stableFrames = 0;
    let timedOut = true;
    while (performance.now() - start < deadlineMs) {
      probe = marivellCollectVisiblePlaceholderState(frame);
      const ready =
        probe.placeholderCount === 0 &&
        probe.visibleUnrenderedInlineMathCount === 0 &&
        probe.visibleUnloadedImageCount === 0 &&
        probe.grayLatexDirectTextCount === 0;
      if (ready) {
        stableFrames += 1;
        if (stableFrames >= 3) {
          timedOut = false;
          break;
        }
      } else {
        stableFrames = 0;
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    probe = marivellCollectVisiblePlaceholderState(frame);
    const benchmarkWindow = window;
    const ioDiagnostics =
      typeof benchmarkWindow.__marivellGetIoDiagnostics === 'function'
        ? benchmarkWindow.__marivellGetIoDiagnostics()
        : null;
    const rawU2 =
      typeof benchmarkWindow.__marivellGetU2ActivationDiagnostics === 'function'
        ? benchmarkWindow.__marivellGetU2ActivationDiagnostics()
        : null;
    return {
      scrollTop: frame.scrollTop,
      maxScrollTop: Math.max(frame.scrollHeight - frame.clientHeight, 0),
      waitMs: performance.now() - start,
      timedOut,
      probe,
      diagnostics: {
        phase4: benchmarkWindow.__marivellPhase4Timings ?? null,
        hydrate: benchmarkWindow.__marivellPhase4HydrateTimings ?? null,
        fallback: benchmarkWindow.__marivellVisibleFallbackTimings ?? null,
        io: ioDiagnostics,
        u2: rawU2 && rawU2.enabled ? rawU2 : null,
        scrollHotpath: benchmarkWindow.__marivellScrollHotpathDiagnostics ?? null,
      },
    };
  })()`;
  return page.evaluate(script) as Promise<StressRoundResult>;
}

async function main(): Promise<void> {
  const exclusiveRun = await waitForExclusiveBenchmarkLock();
  console.log('\n## multi-position post-release stability e2e');
  const outDir = path.join(os.tmpdir(), `marivell-post-release-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-post-release-profile-${process.pid}`);
  const port = 9400 + (process.pid % 100);
  const source = buildFormulaDenseMarkdown(900);
  const markdownPath = path.join(os.tmpdir(), `marivell-post-release-${process.pid}.md`);
  fs.writeFileSync(markdownPath, source, 'utf8');
  let handle: ElectronHandle | null = null;
  try {
    console.log('Building multi-position post-release bundle...');
    await buildRenderer(outDir);
    handle = await launchElectron(outDir, markdownPath, port, profile);
    await installPlaceholderHelpers(handle.page);
    const ready = await withTimeout(
      waitForVisualReady(handle.page, Math.min(Math.max(source.length * 0.5, 1_000), 500_000), 60_000),
      70_000,
      'visual-open',
    );
    assert('open deterministic formula-dense document in visual mode', ready.ok && ready.value, ready.ok ? '' : ready.label);
    if (!ready.ok || !ready.value) {
      return;
    }
    const ratios = [0.08, 0.25, 0.5, 0.75, 0.93, 1];
    const rows: Array<PostReleaseResult & { label: string }> = [];
    for (const ratio of ratios) {
      const label = ratio === 1 ? 'bottom' : `${Math.round(ratio * 100)}%`;
      const result = await withTimeout(
        measurePostRelease(handle.page, ratio),
        12_000,
        `post-release-${label}`,
      );
      if (!result.ok) {
        assert(`position ${label} completes`, false, result.label);
        continue;
      }
      const value = result.value;
      rows.push({ ...value, label });
      const stable =
        value.topChanges === 0 &&
        value.firstTop === value.lastTop &&
        value.eventsAfterFirstRaf === 0 &&
        value.layoutShiftCumulative <= 0.05;
      assert(
        `position ${label} stays stable for 1000ms after release (scrollTop=${value.scrollTop})`,
        stable,
        JSON.stringify(value),
      );
      assert(
        `position ${label} responds to a new scroll after stability`,
        value.nextScrollResponded,
        JSON.stringify({
          stableTop: value.scrollTop,
          nextScrollTop: value.nextScrollTop,
        }),
      );
    }
    console.log('\n  post-release pass table');
    console.log(
      `  ${'position'.padEnd(12)} ${'scrollTop'.padStart(10)} ${'topChanges'.padStart(10)} ${'events'.padStart(7)} ${'shift'.padStart(7)} ${'respond'.padStart(8)} ${'drag'.padStart(6)}`,
    );
    for (const row of rows) {
      console.log(
        `  ${row.label.padEnd(12)} ${String(row.scrollTop).padStart(10)} ${String(row.topChanges).padStart(10)} ${String(row.eventsAfterFirstRaf).padStart(7)} ${String(row.layoutShiftCumulative).padStart(7)} ${String(row.nextScrollResponded).padStart(8)} ${String(row.dragMoved).padStart(6)}`,
      );
    }

    const stressRounds = [
      { ratio: 0.2, direction: 1 },
      { ratio: 0.35, direction: 1 },
      { ratio: 0.5, direction: 1 },
      { ratio: 0.65, direction: 1 },
      { ratio: 0.8, direction: 1 },
      { ratio: 0.95, direction: 1 },
      { ratio: 0.9, direction: -1 },
      { ratio: 0.75, direction: -1 },
      { ratio: 0.6, direction: -1 },
      { ratio: 0.45, direction: -1 },
      { ratio: 0.3, direction: -1 },
      { ratio: 0.1, direction: -1 },
    ];
    const stressRows: Array<{
      round: number;
      ratio: number;
      direction: number;
      scrollTop: number;
      scrollEvents: number;
      waitMs: number;
      ok: boolean;
      probe: StressRoundResult['probe'] | null;
      diagnostics: Record<string, unknown> | null;
    }> = [];
    for (let round = 1; round <= stressRounds.length; round += 1) {
      const stressRound = stressRounds[round - 1];
      const { ratio, direction } = stressRound;
      await resetScrollEventCounter(handle.page);
      const geometry = await getScrollGeometry(handle.page);
      await dragScrollbarToRatio(handle.page, ratio, geometry);
      await handle.page.evaluate((ratio) => {
        const frame = document.querySelector<HTMLElement>('.editor-frame');
        if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
        const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
        frame.scrollTop = Math.round(maxScrollTop * ratio);
        frame.dispatchEvent(new Event('scroll'));
      }, ratio);
      const wheelGeometry = await getScrollGeometry(handle.page);
      await handle.page.mouse.move(
        wheelGeometry.left +
          Math.max(20, Math.min(wheelGeometry.right - wheelGeometry.left - 20, 400)),
        wheelGeometry.top + Math.max(20, wheelGeometry.clientHeight / 2),
      );
      for (let wheel = 0; wheel < 120; wheel += 1) {
        await handle.page.mouse.wheel(0, direction * 40);
        await handle.page.waitForTimeout(5);
      }
      await handle.page.waitForTimeout(200);
      const scrollEvents = await getScrollEventCount(handle.page);
      const stress = await withTimeout(
        measureStressRound(handle.page, 8_000),
        12_000,
        `drag-wheel-stress-${round}`,
      );
      if (!stress.ok) {
        const row = {
          round,
          ratio,
          direction,
          scrollTop: 0,
          scrollEvents,
          waitMs: 0,
          ok: false,
          probe: null,
          diagnostics: null,
        };
        stressRows.push(row);
        assert(
          `drag+wheel stress round ${round} completes`,
          false,
          stress.label,
        );
        continue;
      }
      const value = stress.value;
      const ok =
        !value.timedOut &&
        value.probe.placeholderCount === 0 &&
        value.probe.visibleUnrenderedInlineMathCount === 0 &&
        value.probe.visibleUnloadedImageCount === 0 &&
        value.probe.grayLatexDirectTextCount === 0;
      stressRows.push({
        round,
        ratio,
        direction,
        scrollTop: value.scrollTop,
        scrollEvents,
        waitMs: Math.round(value.waitMs),
        ok,
        probe: value.probe,
        diagnostics: value.diagnostics,
      });
      assert(
        `drag+wheel stress round ${round} hydrates all visible content (scrollTop=${value.scrollTop})`,
        ok,
        JSON.stringify({
          round,
          ratio,
          direction,
          scrollTop: value.scrollTop,
          scrollEvents,
          probe: value.probe,
          diagnostics: value.diagnostics,
        }),
      );
    }
    console.log('\n  drag+wheel stress table');
    console.log(
      `  ${'round'.padEnd(6)} ${'direction'.padEnd(9)} ${'ratio'.padEnd(6)} ${'scrollTop'.padStart(10)} ${'events'.padStart(7)} ${'waitMs'.padStart(7)} ${'placeholders'.padStart(12)} ${'inlineTotal'.padStart(11)} ${'inlineReal'.padStart(10)} ${'inlineUnrendered'.padStart(15)} ${'images'.padStart(8)} ${'gray'.padStart(6)} ${'ok'.padStart(5)}`,
    );
    for (const row of stressRows) {
      console.log(
        `  ${String(row.round).padEnd(6)} ${(row.direction > 0 ? 'down' : 'up').padEnd(9)} ${String(row.ratio).padEnd(6)} ${String(row.scrollTop).padStart(10)} ${String(row.scrollEvents).padStart(7)} ${String(row.waitMs).padStart(7)} ${String(row.probe?.placeholderCount ?? 'n/a').padStart(12)} ${String(row.probe?.visibleInlineMathCount ?? 'n/a').padStart(11)} ${String(row.probe?.visibleRealKatexCount ?? 'n/a').padStart(10)} ${String(row.probe?.visibleUnrenderedInlineMathCount ?? 'n/a').padStart(15)} ${String(row.probe?.visibleUnloadedImageCount ?? 'n/a').padStart(8)} ${String(row.probe?.grayLatexDirectTextCount ?? 'n/a').padStart(6)} ${String(row.ok).padStart(5)}`,
      );
    }
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
    try {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.rmSync(profile, { recursive: true, force: true });
      fs.rmSync(markdownPath, { force: true });
    } catch {
      // Cleanup is best-effort.
    }
    await exclusiveRun.release();
  }

  console.log(`\n================================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

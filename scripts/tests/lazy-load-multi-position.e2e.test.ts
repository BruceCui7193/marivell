import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { installPlaceholderHelpers } from './test-utils/placeholder';
import { waitForExclusiveBenchmarkLock } from './test-utils/exclusive-run';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const electronBin = path.join(projectRoot, 'node_modules/.bin/electron');
const electronViteBin = path.join(projectRoot, 'node_modules/.bin/electron-vite');
const markdownPath = '/home/crh/下载/barfoot_ser24/barfoot_ser24.md';

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
): Promise<{ waitMs: number; scrollHeight: number; textLength: number; timedOut: boolean }> {
  return page.evaluate(
    async ({ expectedLength, deadlineMs }) => {
      const start = Date.now();
      const deadline = start + deadlineMs;
      while (Date.now() < deadline) {
        const loading = document.querySelector('.editor-loading');
        const surface = document.querySelector('.editor-surface');
        const frame = document.querySelector('.editor-frame');
        if (!loading && surface && frame && surface.innerText.length > expectedLength) {
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          return {
            waitMs: Date.now() - start,
            scrollHeight: (frame as HTMLElement).scrollHeight,
            textLength: surface.innerText.length,
            timedOut: false,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const frame = document.querySelector('.editor-frame');
      const surface = document.querySelector('.editor-surface');
      return {
        waitMs: Date.now() - start,
        scrollHeight: frame instanceof HTMLElement ? frame.scrollHeight : 0,
        textLength: surface?.innerText?.length ?? 0,
        timedOut: true,
      };
    },
    { expectedLength: expectedTextLength, deadlineMs },
  );
}

interface LazyPositionResult {
  ratio: number;
  targetScrollTop: number;
  finalScrollTop: number;
  maxScrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  waitMs: number;
  timedOut: boolean;
  stableFrames: number;
  probe: {
    placeholderCount: number;
    visibleInlineMathCount: number;
    visibleRealKatexCount: number;
    visibleUnrenderedInlineMathCount: number;
    visiblePlaceholderInlineMathCount: number;
    visibleImageCount: number;
    visibleUnloadedImageCount: number;
    grayLatexDirectTextCount: number;
    placeholderDetails: Array<Record<string, unknown>>;
  };
  diagnostics: Record<string, unknown>;
}

async function measurePosition(
  page: Page,
  ratio: number,
  deadlineMs: number,
): Promise<LazyPositionResult> {
  const script = `(async () => {
    const ratio = ${JSON.stringify(ratio)};
    const deadlineMs = ${JSON.stringify(deadlineMs)};
    const frame = document.querySelector('.editor-frame');
    if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
    const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
    const targetScrollTop = Math.round(maxScrollTop * ratio);
    frame.scrollTop = targetScrollTop;
    frame.dispatchEvent(new Event('scroll'));
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
      ratio,
      targetScrollTop,
      finalScrollTop: frame.scrollTop,
      maxScrollTop,
      scrollHeight: frame.scrollHeight,
      clientHeight: frame.clientHeight,
      waitMs: performance.now() - start,
      timedOut,
      stableFrames,
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
  return page.evaluate(script) as Promise<LazyPositionResult>;
}

async function main(): Promise<void> {
  const exclusiveRun = await waitForExclusiveBenchmarkLock();
  console.log('\n## large-file multi-position lazy-load e2e');
  const outDir = path.join(os.tmpdir(), `marivell-lazy-multi-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-lazy-multi-profile-${process.pid}`);
  const port = 9500 + (process.pid % 100);
  let handle: ElectronHandle | null = null;
  try {
    console.log('Building multi-position lazy-load bundle...');
    await buildRenderer(outDir);
    handle = await launchElectron(outDir, markdownPath, port, profile);
    await installPlaceholderHelpers(handle.page);
    const sourceSize = fs.statSync(markdownPath).size;
    const ready = await withTimeout(
      waitForVisualReady(handle.page, Math.min(Math.max(sourceSize * 0.5, 1_000), 500_000), 60_000),
      70_000,
      'visual-open',
    );
    assert('open barfoot_ser24.md in visual mode', ready.ok && !ready.value.timedOut, ready.ok ? '' : ready.label);
    if (!ready.ok || ready.value.timedOut) {
      return;
    }
    const positions = [
      0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1,
      0.173, 0.287, 0.413, 0.587, 0.729, 0.861,
    ];
    const rows: Array<LazyPositionResult & { label: string }> = [];
    for (const ratio of positions) {
      const label = ratio === 0 ? 'top' : ratio === 1 ? 'bottom' : `${Math.round(ratio * 100)}%`;
      const result = await withTimeout(
        measurePosition(handle.page, ratio, 6_000),
        12_000,
        `lazy-position-${label}`,
      );
      if (!result.ok) {
        assert(`position ${label} completes within deadline`, false, result.label);
        continue;
      }
      const value = result.value;
      rows.push({ ...value, label });
      const ok =
        !value.timedOut &&
        value.probe.placeholderCount === 0 &&
        value.probe.visibleUnrenderedInlineMathCount === 0 &&
        value.probe.visibleUnloadedImageCount === 0 &&
        value.probe.grayLatexDirectTextCount === 0;
      assert(
        `position ${label} hydrated (scrollTop=${value.finalScrollTop})`,
        ok,
        JSON.stringify({
          scrollTop: value.finalScrollTop,
          target: value.targetScrollTop,
          waitMs: Math.round(value.waitMs),
          probe: value.probe,
          diagnostics: value.diagnostics,
        }),
      );
    }
    console.log('\n  multi-position pass table');
    console.log(
      `  ${'position'.padEnd(12)} ${'scrollTop'.padStart(10)} ${'waitMs'.padStart(8)} ${'placeholders'.padStart(12)} ${'inlineTotal'.padStart(11)} ${'inlineReal'.padStart(10)} ${'inlineUnrendered'.padStart(15)} ${'images'.padStart(8)} ${'gray'.padStart(6)}`,
    );
    for (const row of rows) {
      console.log(
        `  ${row.label.padEnd(12)} ${String(row.finalScrollTop).padStart(10)} ${Math.round(row.waitMs).toString().padStart(8)} ${String(row.probe.placeholderCount).padStart(12)} ${String(row.probe.visibleInlineMathCount).padStart(11)} ${String(row.probe.visibleRealKatexCount).padStart(10)} ${String(row.probe.visibleUnrenderedInlineMathCount).padStart(15)} ${String(row.probe.visibleUnloadedImageCount).padStart(8)} ${String(row.probe.grayLatexDirectTextCount).padStart(6)}`,
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

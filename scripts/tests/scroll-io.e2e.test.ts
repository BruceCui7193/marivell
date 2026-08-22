import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import {
  installPlaceholderHelpers,
} from './test-utils/placeholder';
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
        const editor = window.__marivellEditor as { state?: { doc?: { nodeSize?: number } } } | undefined;
        const nodeReady = Boolean(editor?.state?.doc && editor.state.doc.nodeSize > expectedSize);
        const textReady = Boolean(surface && surface.innerText.length > Math.min(expectedSize, 1000));
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

interface IoState {
  observedCount: number;
  observerCount: number;
  observerRoot: string | null;
  callbackEntries: number;
  intersectingEntries: number;
  activeSkipEntries: number;
  missingTargetEntries: number;
  enqueuedEntries: number;
  lastSyncObserved: number;
  placeholders: number;
  placeholderDetails: Array<Record<string, unknown>>;
  drift: number;
  scrollTop: number;
  targetScrollTop: number;
}

async function scrollAndInspect(
  page: Page,
  ratio: number,
): Promise<IoState> {
  return page.evaluate(async (ratio) => {
    const frame = document.querySelector<HTMLElement>('.editor-frame');
    if (!frame) throw new Error('editor frame missing');
    const benchmarkWindow = window as unknown as Record<string, unknown>;
    const placeholderWindow = window as unknown as {
      marivellCollectVisiblePlaceholderState: (
        frame: HTMLElement,
      ) => { placeholderCount: number };
    };
    const countPlaceholders = (): number =>
      placeholderWindow.marivellCollectVisiblePlaceholderState(frame).placeholderCount;
    const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
    const target = Math.round(maxScrollTop * ratio);
    frame.scrollTop = target;
    if (typeof benchmarkWindow.__marivellSyncIoForTest === 'function') {
      (benchmarkWindow.__marivellSyncIoForTest as () => number)();
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    }
    frame.dispatchEvent(new Event('scroll'));
    const deadline = performance.now() + 15_000;
    let placeholders = countPlaceholders();
    while (placeholders > 0 && performance.now() < deadline) {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      placeholders = countPlaceholders();
    }
    for (let index = 0; index < 3; index += 1) {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    }
    const finalProbe = placeholderWindow.marivellCollectVisiblePlaceholderState(frame);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const placeholdersBeforeStep = placeholders;
    const driftBeforeStep = Math.abs(frame.scrollTop - target);
    frame.scrollTop = Math.min(
      Math.max(frame.scrollHeight - frame.clientHeight, 0),
      frame.scrollTop + frame.clientHeight * 0.1,
    );
    frame.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const diagnostics =
      typeof benchmarkWindow.__marivellGetIoDiagnostics === 'function'
        ? (benchmarkWindow.__marivellGetIoDiagnostics() as {
            observedCount: number;
            observerCount: number;
            observerRoot: string | null;
            callbackEntries: number;
            intersectingEntries: number;
            activeSkipEntries: number;
            missingTargetEntries: number;
            enqueuedEntries: number;
            lastSyncObserved: number;
          })
        : null;
    return {
      observedCount: diagnostics?.observedCount ?? 0,
      observerCount: diagnostics?.observerCount ?? 0,
      observerRoot: diagnostics?.observerRoot ?? null,
      callbackEntries: diagnostics?.callbackEntries ?? 0,
      intersectingEntries: diagnostics?.intersectingEntries ?? 0,
      activeSkipEntries: diagnostics?.activeSkipEntries ?? 0,
      missingTargetEntries: diagnostics?.missingTargetEntries ?? 0,
      enqueuedEntries: diagnostics?.enqueuedEntries ?? 0,
      lastSyncObserved: diagnostics?.lastSyncObserved ?? 0,
      placeholders: placeholdersBeforeStep,
      placeholderDetails: finalProbe.placeholderDetails,
      drift: driftBeforeStep,
      scrollTop: frame.scrollTop,
      target,
    };
  }, ratio);
}

async function main(): Promise<void> {
  console.log('\n## scroll IO safety net e2e');
  const source = buildFormulaDenseMarkdown(900);
  const markdownPath = path.join(os.tmpdir(), `marivell-scroll-io-${process.pid}.md`);
  fs.writeFileSync(markdownPath, source, 'utf8');

  const outDir = path.join(os.tmpdir(), `marivell-scroll-io-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-scroll-io-profile-${process.pid}`);
  const port = 9700 + (process.pid % 150);

  let handle: ElectronHandle | null = null;
  try {
    console.log('Building e2e bundle (no install needed)...');
    await buildRenderer(outDir);
    handle = await launchElectron(outDir, markdownPath, port, profile);
    await installPlaceholderHelpers(handle.page);

    const ready = await withTimeout(
      waitForVisualReady(handle.page, Math.min(source.length * 0.5, 500_000), 60_000),
      70_000,
      'visual-open',
    );
    assert('open scroll IO document in visual mode', ready.ok && !ready.value.timedOut, ready.label);
    if (!ready.ok || ready.value.timedOut) {
      return;
    }

    await handle.page.evaluate(() => {
      const benchmarkWindow = window as unknown as { __name?: (fn: unknown) => unknown };
      benchmarkWindow.__name = (fn: unknown) => fn;
    });
    await handle.page.evaluate(() => {
      const benchmarkWindow = window as unknown as Record<string, unknown>;
      if (typeof benchmarkWindow.__marivellResetIoDiagnostics === 'function') {
        (benchmarkWindow.__marivellResetIoDiagnostics as () => void)();
      }
    });

    const defaultLimit = await handle.page.evaluate(() => {
      const diagnostics = (
        window as unknown as {
          __marivellGetIoDiagnostics?: () => { observationLimit: number };
        }
      ).__marivellGetIoDiagnostics?.();
      return diagnostics?.observationLimit ?? 0;
    });
    assert('IO diagnostics expose the default observation limit', defaultLimit === 1000, `limit=${defaultLimit}`);

    for (const limit of [300, 500, 1000]) {
      await handle.page.evaluate((limit) => {
        const benchmarkWindow = window as unknown as Record<string, unknown>;
        if (typeof benchmarkWindow.__marivellSetIoObservationLimit === 'function') {
          (benchmarkWindow.__marivellSetIoObservationLimit as (value: number) => void)(limit);
        }
        if (typeof benchmarkWindow.__marivellSetIoEnabled === 'function') {
          (benchmarkWindow.__marivellSetIoEnabled as (value: boolean) => void)(true);
        }
        if (typeof benchmarkWindow.__marivellResetIoDiagnostics === 'function') {
          (benchmarkWindow.__marivellResetIoDiagnostics as () => void)();
        }
      }, limit);
      const state = await scrollAndInspect(handle.page, 0.5 + limit / 100_000);
      assert(
        `IO uses a single observer at limit ${limit}`,
        state.observerCount === 1,
        JSON.stringify(state),
      );
      assert(
        `IO entries only enqueue placeholders at limit ${limit}`,
        state.callbackEntries === 0 || state.enqueuedEntries > 0,
        JSON.stringify(state),
      );
      assert(
        `scroll hydration stays clean at limit ${limit}`,
        state.placeholders === 0 && state.drift < 1,
        JSON.stringify(state),
      );
    }

    await handle.page.evaluate(() => {
      const benchmarkWindow = window as unknown as Record<string, unknown>;
      if (typeof benchmarkWindow.__marivellSetIoEnabled === 'function') {
        (benchmarkWindow.__marivellSetIoEnabled as (value: boolean) => void)(false);
      }
      if (typeof benchmarkWindow.__marivellResetIoDiagnostics === 'function') {
        (benchmarkWindow.__marivellResetIoDiagnostics as () => void)();
      }
    });
    const offState = await scrollAndInspect(handle.page, 0.75);
    assert(
      'disabled IO observes no placeholder nodes',
      offState.observedCount === 0 && offState.observerCount === 1,
      JSON.stringify(offState),
    );
    assert(
      'disabled IO emits no callbacks or enqueues',
      offState.callbackEntries === 0 && offState.enqueuedEntries === 0,
      JSON.stringify(offState),
    );
    assert(
      'disabled IO still keeps scroll hydration hard gates',
      offState.placeholders === 0 && offState.drift < 1,
      JSON.stringify(offState),
    );

    await handle.page.evaluate(() => {
      const benchmarkWindow = window as unknown as Record<string, unknown>;
      if (typeof benchmarkWindow.__marivellSetIoEnabled === 'function') {
        (benchmarkWindow.__marivellSetIoEnabled as (value: boolean) => void)(true);
      }
      if (typeof benchmarkWindow.__marivellResetIoDiagnostics === 'function') {
        (benchmarkWindow.__marivellResetIoDiagnostics as () => void)();
      }
    });
    const onState = await scrollAndInspect(handle.page, 0.25);
    assert(
      're-enabled IO resumes observing placeholder nodes',
      onState.enqueuedEntries > 0,
      JSON.stringify(onState),
    );
    assert(
      're-enabled IO keeps the single-observer contract',
      onState.observerCount === 1,
      JSON.stringify(onState),
    );
    assert(
      're-enabled IO keeps scroll hydration hard gates',
      onState.placeholders === 0 && onState.drift < 1,
      JSON.stringify(onState),
    );
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

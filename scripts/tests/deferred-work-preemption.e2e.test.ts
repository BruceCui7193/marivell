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

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ok ${name}`);
    return;
  }
  failed += 1;
  failures.push(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  console.error(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`);
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
): Promise<void> {
  await page.evaluate(
    async ({ expectedSize, deadlineMs }) => {
      const deadline = performance.now() + deadlineMs;
      while (performance.now() < deadline) {
        const loading = document.querySelector('.editor-loading');
        const surface = document.querySelector('.editor-surface');
        const frame = document.querySelector('.editor-frame');
        const editor = window.__marivellEditor as { state?: { doc?: { nodeSize?: number } } } | undefined;
        const nodeReady = Boolean(editor?.state?.doc && editor.state.doc.nodeSize > expectedSize);
        const textReady = Boolean(surface && surface.innerText.length > Math.min(expectedSize, 100_000));
        if (!loading && surface && frame && (nodeReady || textReady)) {
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('visual editor did not become ready');
    },
    { expectedSize: expectedNodeSize, deadlineMs },
  );
}

async function main(): Promise<void> {
  console.log('\n## deferred work BFR and gesture preemption e2e');
  const uniqueCount = 900;
  const lines: string[] = [];
  for (let index = 0; index < uniqueCount; index += 1) {
    lines.push(
      `## Section ${index}`,
      '',
      `Paragraph ${index} has $\\frac{x_{${index}}}{y_{${index}}}$ and enough filler text to keep this file over the worker threshold while preserving unique formula heights: ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index} ${index}.`,
      '',
    );
  }
  const source = lines.join('\n');
  if (source.length < 200_000) {
    throw new Error(`test source is below the worker threshold: ${source.length}`);
  }
  const markdownPath = path.join(os.tmpdir(), `marivell-deferred-work-${process.pid}.md`);
  fs.writeFileSync(markdownPath, source, 'utf8');
  const outDir = path.join(os.tmpdir(), `marivell-deferred-work-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-deferred-work-profile-${process.pid}`);
  const port = 9950 + (process.pid % 100);
  let handle: ElectronHandle | null = null;

  try {
    console.log('Building deferred work preemption bundle...');
    await buildRenderer(outDir);
    handle = await launchElectron(outDir, markdownPath, port, profile);
    const timeline = await handle.page.evaluate(() => window.markdownEditor.getBenchmarkTimeline());
    const openStart =
      timeline.find((entry) => entry.name === 'document-open-main-start')?.value ?? Date.now();
    await waitForVisualReady(
      handle.page,
      Math.min(Math.max(source.length * 0.5, 10_000), 500_000),
      60_000,
    );

    const preemptionBefore = await handle.page.evaluate(() => {
      const target = window as unknown as Record<string, unknown>;
      const diag =
        typeof target.__marivellGetDeferredWorkDiagnostics === 'function'
          ? (
              target.__marivellGetDeferredWorkDiagnostics as () => Record<string, unknown>
            )()
          : null;
      return {
        preemptionSkips: typeof diag?.preemptionSkips === 'number' ? diag.preemptionSkips : 0,
        lastPreemptedAt: typeof diag?.lastPreemptedAt === 'number' ? diag.lastPreemptedAt : 0,
        queueLength: typeof diag?.formulaChunkQueueLength === 'number' ? diag.formulaChunkQueueLength : 0,
        pendingHtml: typeof diag?.pendingFormulaHtmlChunks === 'number' ? diag.pendingFormulaHtmlChunks : 0,
      };
    });

    const gestureStart = await handle.page.evaluate(() => {
      const editor = window.__marivellEditor as {
        state: { doc: { descendants: (fn: (node: { isTextblock?: boolean; textContent?: string }, pos: number) => boolean | void) => void } };
        commands: { focus: () => boolean; setTextSelection: (pos: number) => boolean };
      };
      let from = -1;
      editor.state.doc.descendants((node, pos) => {
        if (from !== -1) {
          return false;
        }
        if (node.isTextblock && node.textContent) {
          from = pos + 1;
          return false;
        }
        return true;
      });
      editor.commands.setTextSelection(Math.max(1, from));
      editor.commands.focus();
      return performance.now();
    });
    await handle.page.keyboard.insertText(' PREEMPTION_MARK ');
    const preempted = await handle.page
      .waitForFunction(
        ({ before, gestureStart }) => {
          const target = window as unknown as Record<string, unknown>;
          const diag =
            typeof target.__marivellGetDeferredWorkDiagnostics === 'function'
              ? (
                  target.__marivellGetDeferredWorkDiagnostics as () => Record<string, unknown>
                )()
              : null;
          return Boolean(
            diag &&
              ((typeof diag.preemptionSkips === 'number' && diag.preemptionSkips > before) ||
                (typeof diag.lastPreemptedAt === 'number' && diag.lastPreemptedAt > gestureStart)),
          );
        },
        { before: preemptionBefore.preemptionSkips, gestureStart },
        { timeout: 5000 },
      )
      .then(() => true)
      .catch(() => false);
    const preemptionAfter = await handle.page.evaluate(() => {
      const target = window as unknown as Record<string, unknown>;
      const diag =
        typeof target.__marivellGetDeferredWorkDiagnostics === 'function'
          ? (
              target.__marivellGetDeferredWorkDiagnostics as () => Record<string, unknown>
            )()
          : null;
      return diag ?? null;
    });
    assert(
      'user gesture preempts background formula processing',
      preempted,
      JSON.stringify({ preemptionBefore, preemptionAfter }),
    );

    const bfrScript = `(async () => {
      const uniqueCount = ${uniqueCount};
      const openStart = ${openStart};
      const deadline = openStart + 10000;
      const target = window;
      let last = null;
      while (Date.now() < deadline) {
        const deferred = typeof target.__marivellGetDeferredWorkDiagnostics === 'function'
          ? target.__marivellGetDeferredWorkDiagnostics()
          : null;
        const cache = typeof target.__marivellGetNodeHeightCacheStats === 'function'
          ? target.__marivellGetNodeHeightCacheStats()
          : null;
        const inline = typeof target.__marivellGetInlineMathHeightPrefetchStats === 'function'
          ? target.__marivellGetInlineMathHeightPrefetchStats()
          : null;
        last = { deferred, cache, inline };
        const ready = Boolean(
          last.deferred?.workerQueueEmpty === true &&
            typeof last.cache?.size === 'number' &&
            last.cache.size >= uniqueCount &&
            typeof last.inline?.preparedFormulaHtml === 'number' &&
            last.inline.preparedFormulaHtml >= uniqueCount &&
            last.inline.pendingHeightMeasurements === 0
        );
        if (ready) {
          return { done: true, atMs: Date.now() - openStart, last };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { done: false, atMs: Date.now() - openStart, last };
    })()`;
    const bfr = await handle.page.evaluate(bfrScript) as {
      done: boolean;
      atMs: number;
      last: Record<string, unknown>;
    };
    assert(
      'BFR completes by open+10s with height cache 100% and worker queue empty',
      bfr.done,
      JSON.stringify(bfr),
    );

    const offscreenDecoration = await handle.page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      if (!frame) {
        return -1;
      }
      const frameRect = frame.getBoundingClientRect();
      return Array.from(
        frame.querySelectorAll<HTMLElement>('[class*="math-syntax-"]'),
      ).filter((element) => {
        const rect = element.getBoundingClientRect();
        return !(
          rect.bottom > frameRect.top &&
          rect.top < frameRect.bottom &&
          rect.right > frameRect.left &&
          rect.left < frameRect.right
        );
      }).length;
    });
    assert(
      'BFR leaves no offscreen syntax decoration backlog',
      offscreenDecoration === 0,
      `offscreenSyntaxDecorationCount=${offscreenDecoration}`,
    );

    const statsReady = await handle.page.evaluate(() => {
      const text = document.querySelector('.status-bar__right')?.textContent ?? '';
      return {
        nonEmpty: text.length > 0,
        hasNumbers: /\d/.test(text),
      };
    });
    assert(
      'BFR exposes document stats',
      statsReady.nonEmpty && statsReady.hasNumbers,
      JSON.stringify(statsReady),
    );

    await handle.page.evaluate(() => {
      const tabs = document.querySelectorAll<HTMLButtonElement>('.sidebar__tab');
      tabs[1]?.click();
    });
    await wait(100);
    const outlineCount = await handle.page.evaluate(
      () => document.querySelectorAll('.outline-item').length,
    );
    assert('BFR exposes outline entries', outlineCount > 0, `outline=${outlineCount}`);

    await handle.page.keyboard.press('Control+f');
    await wait(100);
    await handle.page.keyboard.type('Paragraph 0');
    await wait(200);
    const searchReady = await handle.page.evaluate(() => {
      const panel = document.querySelector('.search-panel');
      const count = document.querySelector('.search-panel__count')?.textContent ?? '';
      return {
        open: panel?.classList.contains('is-open') ?? false,
        count,
      };
    });
    assert(
      'BFR exposes search with a match count',
      searchReady.open && /\d+\/\d+/.test(searchReady.count),
      JSON.stringify(searchReady),
    );

    await handle.page.evaluate(() => {
      const target = window as unknown as { __deferredIdleLongTasks?: Array<{ duration: number }> };
      target.__deferredIdleLongTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          target.__deferredIdleLongTasks?.push({ duration: entry.duration });
        }
      }).observe({ type: 'longtask' });
    });
    await wait(5000);
    const idleLongTasks = await handle.page.evaluate(
      () =>
        (window as unknown as { __deferredIdleLongTasks?: Array<{ duration: number }> })
          .__deferredIdleLongTasks ?? [],
    );
    assert('BFR idle window has zero long tasks for 5s', idleLongTasks.length === 0, JSON.stringify(idleLongTasks));
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

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

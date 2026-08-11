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

async function launchElectron(
  outDir: string,
  filePath: string,
  port: number,
  profile: string,
): Promise<{ child: ReturnType<typeof spawn>; page: Page }> {
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
  if (!page) throw new Error('Electron page was not created');
  await page.waitForLoadState('domcontentloaded');
  return { child, page };
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
  console.log('\n## formula height idle prefetch e2e');
  const uniqueCount = 1800;
  const lines: string[] = [];
  for (let index = 0; index < uniqueCount; index += 1) {
    lines.push(
      `## Section ${index}`,
      '',
      `Paragraph ${index} has $\\frac{x_{${index}}}{y_{${index}}}$ and enough filler text to keep this file over the worker threshold while preserving many unique formula heights: ${index} ${index} ${index}.`,
      '',
    );
  }
  const source = lines.join('\n');
  const markdownPath = path.join(os.tmpdir(), `marivell-formula-height-idle-${process.pid}.md`);
  fs.writeFileSync(markdownPath, source, 'utf8');
  const outDir = path.join(os.tmpdir(), `marivell-formula-height-idle-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-formula-height-idle-profile-${process.pid}`);
  const port = 9800 + (process.pid % 100);
  let handle: { child: ReturnType<typeof spawn>; page: Page } | null = null;

  try {
    console.log('Building formula height idle prefetch e2e bundle...');
    await buildRenderer(outDir);
    handle = await launchElectron(outDir, markdownPath, port, profile);
    await waitForVisualReady(
      handle.page,
      Math.min(Math.max(source.length * 0.5, 10_000), 500_000),
      60_000,
    );

    const coverageReady = await handle.page
      .waitForFunction(
        (count) => {
          const target = window as unknown as Record<string, unknown>;
          const cache = target.__marivellGetNodeHeightCacheStats?.() as
            | { size: number }
            | undefined;
          const inline = target.__marivellGetInlineMathHeightPrefetchStats?.() as
            | { preparedFormulaHtml: number; pendingHeightMeasurements: number }
            | undefined;
          return Boolean(
            cache &&
              inline &&
              cache.size >= count * 0.9 &&
              inline.preparedFormulaHtml >= count &&
              inline.pendingHeightMeasurements === 0,
          );
        },
        uniqueCount,
        { timeout: 60_000 },
      )
      .catch(() => false);

    const stats = await handle.page.evaluate(() => {
      const target = window as unknown as Record<string, unknown>;
      return {
        cache: target.__marivellGetNodeHeightCacheStats?.() ?? null,
        inline: target.__marivellGetInlineMathHeightPrefetchStats?.() ?? null,
      };
    });
    assert(
      'idle prefetch fills formula height cache without user interaction',
      Boolean(coverageReady) &&
        stats.cache?.size >= uniqueCount * 0.9 &&
        stats.inline?.pendingHeightMeasurements === 0,
      JSON.stringify({ uniqueCount, stats }),
    );

    await handle.page.evaluate(() => {
      const target = window as unknown as { __idleTypingLongTasks?: Array<{ duration: number }> };
      target.__idleTypingLongTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          target.__idleTypingLongTasks?.push({ duration: entry.duration });
        }
      }).observe({ type: 'longtask' });
    });

    const typing = await handle.page.evaluate(async () => {
      const editor = window.__marivellEditor as {
        commands: { focus: () => boolean; setTextSelection: (pos: number) => boolean };
        state: {
          doc: {
            descendants: (fn: (node: { isTextblock?: boolean; textContent?: string }, pos: number) => boolean | void) => void;
            content: { size: number };
            textBetween: (from: number, to: number, sep?: string, leaf?: string) => string;
          };
        };
        getJSON: () => unknown;
      };
      const surface = document.querySelector<HTMLElement>('.editor-surface');
      if (!editor || !surface) throw new Error('editor/surface missing');
      let from = -1;
      editor.state.doc.descendants((node, pos) => {
        if (from !== -1) return false;
        if (node.isTextblock && node.textContent) {
          from = pos + 1;
          return false;
        }
        return true;
      });
      if (from === -1) throw new Error('text block missing');
      editor.commands.setTextSelection(from);
      editor.commands.focus();
      const marker = 'IDLE_PREFETCH_TYPING_' + Date.now();
      const start = performance.now();
      const applied = document.execCommand('insertText', false, marker);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\n');
      return {
        wallMs: performance.now() - start,
        typed: Boolean(applied && text.includes(marker)),
        markerLeak: JSON.stringify(editor.getJSON()).includes('MDEDITORSELECTION'),
      };
    });
    const longTasks = await handle.page.evaluate(
      () => (window as unknown as { __idleTypingLongTasks?: Array<{ duration: number }> }).__idleTypingLongTasks ?? [],
    );
    assert(
      'typing after idle prefetch completes without a long task',
      typing.typed && !typing.markerLeak && longTasks.length === 0,
      JSON.stringify({ typing, longTasks }),
    );
    assert(
      'ordinary typing stays below the soft long-task wall budget',
      typing.wallMs < 300,
      JSON.stringify(typing),
    );

    const syntax = await handle.page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      const editor = window.__marivellEditor as { getJSON: () => unknown } | undefined;
      return {
        syntaxSpans: frame?.querySelectorAll('[class*="math-syntax-"]').length ?? 0,
        markerLeak: editor ? JSON.stringify(editor.getJSON()).includes('MDEDITORSELECTION') : true,
      };
    });
    assert(
      'ordinary input keeps scoped syntax decoration and no marker leakage',
      syntax.syntaxSpans > 0 && !syntax.markerLeak,
      JSON.stringify(syntax),
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

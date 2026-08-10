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

function buildMarkdown(): string {
  const lines: string[] = [];
  for (let index = 0; index < 240; index += 1) {
    lines.push(
      `## Section ${index}`,
      '',
      `Paragraph ${index} has $\\frac{x_{${index}}}{y_${index}}$ and enough filler text to keep this paragraph far outside the initial viewport later in the document: ${index} ${index} ${index}.`,
      '',
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  console.log('\n## scoped math syntax decoration e2e');
  const source = buildMarkdown();
  const markdownPath = path.join(os.tmpdir(), `marivell-math-syntax-scoped-${process.pid}.md`);
  fs.writeFileSync(markdownPath, source, 'utf8');

  const outDir = path.join(os.tmpdir(), `marivell-math-syntax-scoped-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-math-syntax-scoped-profile-${process.pid}`);
  const port = 9700 + (process.pid % 200);

  let handle: ElectronHandle | null = null;
  try {
    console.log('Building e2e bundle (no install needed)...');
    await buildRenderer(outDir);
    handle = await launchElectron(outDir, markdownPath, port, profile);

    const ready = await withTimeout(
      waitForVisualReady(handle.page, Math.min(source.length * 0.5, 500_000), 60_000),
      70_000,
      'visual-open',
    );
    assert('open scoped syntax document in visual mode', ready.ok && !ready.value.timedOut, JSON.stringify(ready));

    const initialWait = await withTimeout(
      handle.page.waitForFunction(() => {
        const frame = document.querySelector<HTMLElement>('.editor-frame');
        return Boolean(
          frame &&
            frame.querySelectorAll('[class*="math-syntax-"]').length > 0,
        );
      }, undefined, { timeout: 15_000 }),
      20_000,
      'initial-syntax',
    );
    assert('initial viewport receives scoped syntax decoration', initialWait.ok, initialWait.label);

    const initial = await handle.page.evaluate(`(() => {
      const frame = document.querySelector('.editor-frame');
      if (!frame) throw new Error('editor frame missing');
      const frameRect = frame.getBoundingClientRect();
      const nodes = Array.from(frame.querySelectorAll('.math-inline-node'));
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > frameRect.top && rect.top < frameRect.bottom;
      };
      const spans = Array.from(frame.querySelectorAll('[class*="math-syntax-"]'));
      const offscreenWithSyntax = nodes.filter(
        (node) => !isVisible(node) && node.querySelector('[class*="math-syntax-"]') !== null,
      ).length;
      const syntaxOutsideVisible = spans.filter((span) => {
        const node = span.closest('.math-inline-node');
        return node === null || (!isVisible(node) && !node.classList.contains('is-editing'));
      }).length;
      return {
        totalMath: nodes.length,
        visibleMath: nodes.filter(isVisible).length,
        spanCount: spans.length,
        offscreenWithSyntax,
        syntaxOutsideVisible,
      };
    })()`);
    assert(
      'initial offscreen formulas have no syntax spans',
      initial.offscreenWithSyntax === 0,
      JSON.stringify(initial),
    );
    assert(
      'initial syntax spans are limited to visible formulas',
      initial.syntaxOutsideVisible === 0 && initial.spanCount > 0,
      JSON.stringify(initial),
    );

    await handle.page.evaluate(`(() => {
      const frame = document.querySelector('.editor-frame');
      if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
      const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
      frame.scrollTop = Math.round(maxScrollTop * 0.5);
      frame.dispatchEvent(new Event('scroll'));
    })()`);
    const middleWait = await withTimeout(
      handle.page.waitForFunction(() => {
        const frame = document.querySelector<HTMLElement>('.editor-frame');
        if (!frame) return false;
        const frameRect = frame.getBoundingClientRect();
        return Array.from(frame.querySelectorAll<HTMLElement>('.math-inline-node')).some((node) => {
          const rect = node.getBoundingClientRect();
          return (
            rect.bottom > frameRect.top &&
            rect.top < frameRect.bottom &&
            node.querySelector('[class*="math-syntax-"]') !== null
          );
        });
      }, undefined, { timeout: 15_000 }),
      20_000,
      'middle-syntax',
    );
    assert('scrolled viewport receives scoped syntax decoration', middleWait.ok, middleWait.label);
    await handle.page.waitForTimeout(250);

    const middle = await handle.page.evaluate(`(() => {
      const frame = document.querySelector('.editor-frame');
      if (!frame) throw new Error('editor frame missing');
      const frameRect = frame.getBoundingClientRect();
      const nodes = Array.from(frame.querySelectorAll('.math-inline-node'));
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > frameRect.top && rect.top < frameRect.bottom;
      };
      const spans = Array.from(frame.querySelectorAll('[class*="math-syntax-"]'));
      const offscreenWithSyntax = nodes.filter(
        (node) => !isVisible(node) && node.querySelector('[class*="math-syntax-"]') !== null,
      ).length;
      const syntaxOutsideVisible = spans.filter((span) => {
        const node = span.closest('.math-inline-node');
        return node === null || (!isVisible(node) && !node.classList.contains('is-editing'));
      }).length;
      return {
        totalMath: nodes.length,
        visibleMath: nodes.filter(isVisible).length,
        spanCount: spans.length,
        offscreenWithSyntax,
        syntaxOutsideVisible,
      };
    })()`);
    assert(
      'scrolled offscreen formulas have no syntax spans',
      middle.offscreenWithSyntax === 0,
      JSON.stringify(middle),
    );
    assert(
      'scrolled syntax span count stays far below all formulas',
      middle.spanCount > 0 && middle.spanCount < middle.totalMath * 0.4,
      JSON.stringify(middle),
    );

    await handle.page.evaluate(`(() => {
      const editor = window.__marivellEditor;
      if (!editor) throw new Error('editor missing');
      let pos = -1;
      editor.state.doc.descendants((node, nodePos) => {
        if (pos !== -1) return;
        if (node.type.name === 'inlineMath') pos = nodePos;
      });
      if (pos === -1) throw new Error('inlineMath missing');
      editor.commands.setTextSelection(pos + 1);
    })()`);
    const focusWait = await withTimeout(
      handle.page.waitForFunction(() => {
        const editing = document.querySelector<HTMLElement>('.math-inline-node.is-editing');
        return Boolean(editing?.querySelector('[class*="math-syntax-"]'));
      }, undefined, { timeout: 10_000 }),
      15_000,
      'editing-syntax',
    );
    assert('focused formula receives syntax decoration', focusWait.ok, focusWait.label);

    await handle.page.evaluate(`(() => {
      const editor = window.__marivellEditor;
      if (!editor) throw new Error('editor missing');
      editor.commands.setTextSelection(0);
    })()`);
    const exitOk = await withTimeout(
      handle.page.waitForFunction(() => document.querySelectorAll('.math-inline-node.is-editing').length === 0, undefined, { timeout: 10_000 }),
      15_000,
      'editing-exit',
    );
    assert('caret exits formula and drops editing decoration', exitOk.ok, exitOk.label);

    await handle.page.evaluate(`(() => {
      window.dispatchEvent(
        new CustomEvent('markdown-editor:menu-action', {
          detail: 'toggle-source-mode',
        }),
      );
    })()`);
    const sourceWait = await withTimeout(
      handle.page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('.source-editor__input')?.value.length ?? 0 > 10_000, undefined, { timeout: 30_000 }),
      35_000,
      'source-mode',
    );
    assert('source mode opens after scoped syntax interactions', sourceWait.ok, sourceWait.label);
    const sourceValue = await handle.page.locator('.source-editor__input').inputValue();
    assert(
      'source mode has no selection marker leakage',
      !sourceValue.includes('MDEDITORSELECTION'),
      sourceValue.slice(0, 200),
    );

    await handle.page.evaluate(`(() => {
      window.dispatchEvent(
        new CustomEvent('markdown-editor:menu-action', {
          detail: 'toggle-source-mode',
        }),
      );
    })()`);
    const visualBack = await withTimeout(
      waitForVisualReady(handle.page, Math.min(source.length * 0.5, 500_000), 30_000),
      35_000,
      'visual-back',
    );
    assert('visual mode returns after source mode', visualBack.ok && !visualBack.value.timedOut, JSON.stringify(visualBack));
    const markerCount = await handle.page.evaluate(() => {
      const editor = (window as unknown as { __marivellEditor?: { getJSON: () => unknown } }).__marivellEditor;
      return editor ? JSON.stringify(editor.getJSON()).match(/MDEDITORSELECTION/g)?.length ?? 0 : -1;
    });
    assert('visual mode has no selection marker leakage', markerCount === 0, String(markerCount));
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
  }

  if (failed > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
  console.log(`\n  ${passed} passed, ${failed} failed`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

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
): Promise<{ waitMs: number; scrollHeight: number; textLength: number; timedOut: boolean }> {
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
          return {
            waitMs: Date.now() - start,
            scrollHeight: frame.scrollHeight,
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
        scrollHeight: frame?.scrollHeight ?? 0,
        textLength: surface?.innerText?.length ?? 0,
        timedOut: true,
      };
    },
    { expectedSize: expectedNodeSize, deadlineMs },
  );
}

async function toggleSource(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-source-mode' }),
    );
  });
}

async function waitForSourceInput(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline) {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      const input = frame?.querySelector<HTMLTextAreaElement>('.source-editor__input');
      const overlay = frame?.querySelector<HTMLElement>('.editor-loading--mode-switch');
      if (frame?.classList.contains('is-source') && input && !overlay) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('source input did not appear');
  });
}

async function waitForVisualMode(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      const input = frame?.querySelector<HTMLElement>('.source-editor__input');
      const overlay = frame?.querySelector<HTMLElement>('.editor-loading--mode-switch');
      if (frame && !frame.classList.contains('is-source') && !input && !overlay) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('visual mode did not appear');
  });
}

async function main(): Promise<void> {
  console.log('\n## inline math lazy rendering e2e');
  const lines: string[] = [];
  for (let index = 0; index < 700; index += 1) {
    lines.push(
      `## Section ${index}\n\n` +
        `Paragraph ${index} has $x_${index}^2 + y_{${index}}$ and enough text to keep this document scrollable.\n`,
    );
  }
  const source = `${lines.join('\n')}\n`;
  const markdownPath = path.join(os.tmpdir(), `marivell-inline-math-lazy-${process.pid}.md`);
  fs.writeFileSync(markdownPath, source, 'utf8');

  const outDir = path.join(os.tmpdir(), `marivell-inline-math-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-inline-math-profile-${process.pid}`);
  const port = 9800 + (process.pid % 200);

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
    assert(
      'open inline-math-heavy document in visual mode',
      ready.ok && !ready.value.timedOut,
      JSON.stringify(ready),
    );

    const initial = await handle.page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      if (!frame) throw new Error('editor frame missing');
      const frameRect = frame.getBoundingClientRect();
      const nodes = Array.from(document.querySelectorAll<HTMLElement>('.math-inline-node'));
      const probe = (
        window as unknown as {
          marivellCollectVisiblePlaceholderState: (
            frame: HTMLElement,
          ) => {
            placeholderCount: number;
            visibleUnrenderedInlineMathCount: number;
          };
        }
      ).marivellCollectVisiblePlaceholderState(frame);
      const active = nodes.filter(
        (element) => {
          const rect = element.getBoundingClientRect();
          return (
            element.querySelector(':scope > .math-node-preview .katex') !== null &&
            rect.bottom > frameRect.top &&
            rect.top < frameRect.bottom
          );
        },
      );
      const visibleInline = nodes.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > frameRect.top && rect.top < frameRect.bottom;
      });
      const offscreen = nodes.filter((element) => {
        const rect = element.getBoundingClientRect();
        return !(rect.bottom > frameRect.top && rect.top < frameRect.bottom);
      });
      return {
        total: nodes.length,
        visiblePlaceholders: probe.placeholderCount,
        visibleActive: active.length,
        visibleInlineCount: visibleInline.length,
        visibleNotRealKatex: probe.visibleUnrenderedInlineMathCount,
        offscreenCount: offscreen.length,
        offscreenPlaceholders: offscreen.filter(
          (element) => element.classList.contains('math-inline-node--placeholder'),
        ).length,
        offscreenContentConnected: offscreen.filter(
          (element) => element.querySelector(':scope > .math-node-content')?.isConnected === true,
        ).length,
        scrollHeight: frame.scrollHeight,
        clientHeight: frame.clientHeight,
      };
    });
    assert(
      'initial viewport has no inline math placeholders',
      initial.visiblePlaceholders === 0,
      JSON.stringify(initial),
    );
    assert(
      'initial viewport contains rendered KaTeX inline math',
      initial.visibleActive >= 1 &&
        initial.visibleInlineCount > 0 &&
        initial.visibleActive === initial.visibleInlineCount &&
        initial.visibleNotRealKatex === 0,
      JSON.stringify(initial),
    );
    assert(
      'offscreen inline math is lazy and keeps contentDOM connected',
      initial.total >= 500 &&
        initial.offscreenCount > 0 &&
        initial.offscreenPlaceholders > 0 &&
        initial.offscreenContentConnected === initial.offscreenCount,
      JSON.stringify(initial),
    );

    const selectionResult = await handle.page.evaluate(async () => {
      const editor = window.__marivellEditor as {
        state: { doc: { descendants: (fn: (node: { type: { name: string }; attrs: { display?: string }; textContent: string }, pos: number) => boolean | void) => void } };
        view: { nodeDOM: (pos: number) => Node | null };
        chain: () => { setTextSelection: (pos: number) => { focus: () => { run: () => boolean } } };
        isEditable: boolean;
      };
      let targetPos: number | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (targetPos !== null) return false;
        if (node.type.name !== 'inlineMath' || node.attrs.display === 'yes') return true;
        const dom = editor.view.nodeDOM(pos);
        if (dom instanceof HTMLElement && dom.classList.contains('math-inline-node--placeholder')) {
          targetPos = pos;
          return false;
        }
        return true;
      });
      if (targetPos === null) throw new Error('no offscreen inline math placeholder found');
      editor.chain().setTextSelection(targetPos + 1).focus().run();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      const dom = editor.view.nodeDOM(targetPos);
      const element = dom instanceof HTMLElement ? dom : null;
      return {
        targetPos,
        active: Boolean(
          element &&
            !element.classList.contains('math-inline-node--placeholder') &&
            element.querySelector(':scope > .math-node-preview .katex'),
        ),
        contentConnected: Boolean(
          element?.querySelector(':scope > .math-node-content')?.isConnected,
        ),
        editable: editor.isEditable,
      };
    });
    assert(
      'selection into offscreen inline math activates it',
      selectionResult.active,
      JSON.stringify(selectionResult),
    );
    assert(
      'activated offscreen inline math keeps editable contentDOM',
      selectionResult.contentConnected && selectionResult.editable,
      JSON.stringify(selectionResult),
    );

    const scrollStart = await handle.page.evaluate(() => {
      const frame = document.querySelector('.editor-frame');
      if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
      const w: any = window;
      const marivellEditor: any = w.__marivellEditor;
      const frameRect = frame.getBoundingClientRect();
      const candidates = Array.from(
        frame.querySelectorAll('p, .math-inline-node'),
      )
        .map((element: HTMLElement) => {
          const rect = element.getBoundingClientRect();
          return { element, relativeTop: rect.top - frameRect.top, bottom: rect.bottom, top: rect.top };
        })
        .filter((candidate) => candidate.bottom > frameRect.top && candidate.top < frameRect.bottom)
        .sort((a, b) => a.relativeTop - b.relativeTop || (a.element.tagName === 'P' ? -1 : b.element.tagName === 'P' ? 1 : 0));
      const anchor = candidates[0]?.element ?? null;
      let anchorPos: number | null = null;
      try {
        const coords = marivellEditor?.view?.posAtCoords({ left: frameRect.left + 10, top: frameRect.top + 10 });
        anchorPos = coords?.pos ?? null;
      } catch {
        anchorPos = null;
      }
      return {
        beforeHydrateCalls: (w.__marivellHydrateTargetRangeCalls as number | undefined) ?? 0,
        targetScrollTop: Math.round((frame.scrollHeight - frame.clientHeight) * 0.5),
        beforeAnchorTop: anchor ? anchor.getBoundingClientRect().top - frameRect.top : null,
        anchorPos,
        anchorText: anchor ? (anchor.textContent ?? '').slice(0, 80) : '',
      };
    });
    await handle.page.evaluate(({ targetScrollTop }) => {
      const frame = document.querySelector('.editor-frame');
      if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
      frame.scrollTop = targetScrollTop;
      frame.dispatchEvent(new Event('scroll'));
    }, { targetScrollTop: scrollStart.targetScrollTop });
    await handle.page.waitForFunction(() => {
      const frame = document.querySelector('.editor-frame');
      if (!(frame instanceof HTMLElement)) return false;
      const probe = (
        window as unknown as {
          marivellCollectVisiblePlaceholderState: (
            frame: HTMLElement,
          ) => { placeholderCount: number; visibleUnrenderedInlineMathCount: number };
        }
      ).marivellCollectVisiblePlaceholderState(frame);
      return probe.placeholderCount === 0 && probe.visibleUnrenderedInlineMathCount === 0;
    }, undefined, { timeout: 10_000 }).catch(() => {});
    const fastScrollResult = await handle.page.evaluate(({ beforeHydrateCalls, beforeAnchorTop, anchorPos, targetScrollTop }) => {
      const frame = document.querySelector('.editor-frame');
      if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
      const w: any = window;
      const marivellEditorAfter: any = w.__marivellEditor;
      const frameRect = frame.getBoundingClientRect();
      const candidates = Array.from(
        frame.querySelectorAll('p, .math-inline-node'),
      )
        .map((element: HTMLElement) => {
          const rect = element.getBoundingClientRect();
          return { element, relativeTop: rect.top - frameRect.top, bottom: rect.bottom, top: rect.top };
        })
        .filter((candidate) => candidate.bottom > frameRect.top && candidate.top < frameRect.bottom)
        .sort((a, b) => a.relativeTop - b.relativeTop);
      let anchor: HTMLElement | null = null;
      try {
        const dom = marivellEditorAfter?.view?.domAtPos(anchorPos);
        const node = dom?.node;
        const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        anchor = element?.closest('p') ?? null;
      } catch {
        anchor = null;
      }
      const afterHydrateCalls = (w.__marivellHydrateTargetRangeCalls as number | undefined) ?? 0;
      const probe = (
        window as unknown as {
          marivellCollectVisiblePlaceholderState: (
            frame: HTMLElement,
          ) => {
            placeholderCount: number;
            visibleInlineMathCount: number;
            visibleRealKatexCount: number;
            visibleUnrenderedInlineMathCount: number;
          };
        }
      ).marivellCollectVisiblePlaceholderState(frame);
      const drift = Math.abs(frame.scrollTop - targetScrollTop);
      return {
        beforeHydrateCalls,
        afterHydrateCalls,
        targetScrollTop,
        finalScrollTop: frame.scrollTop,
        finalPlaceholders: probe.placeholderCount,
        visibleInlineCount: probe.visibleInlineMathCount,
        visibleRealKatex: probe.visibleRealKatexCount,
        visibleNotRealKatex: probe.visibleUnrenderedInlineMathCount,
        drift,
        anchorConnected: anchor?.isConnected ?? false,
        anchorVisibleAfter: Boolean(anchor),
      };
    }, { beforeHydrateCalls: scrollStart.beforeHydrateCalls, beforeAnchorTop: scrollStart.beforeAnchorTop, anchorPos: scrollStart.anchorPos, targetScrollTop: scrollStart.targetScrollTop });
    assert(
      'fast scroll path invokes hydrateTargetRange',
      fastScrollResult.afterHydrateCalls > fastScrollResult.beforeHydrateCalls,
      JSON.stringify(fastScrollResult),
    );
    assert(
      'fast scroll lands with zero visible inline math placeholders',
      fastScrollResult.finalPlaceholders === 0,
      JSON.stringify(fastScrollResult),
    );
    assert(
      'fast scroll renders real KaTeX for every visible inline math node',
      fastScrollResult.visibleInlineCount > 0 &&
        fastScrollResult.visibleRealKatex === fastScrollResult.visibleInlineCount &&
        fastScrollResult.visibleNotRealKatex === 0,
      JSON.stringify(fastScrollResult),
    );
    assert(
      'fast scroll lands with zero scroll drift',
      fastScrollResult.drift < 1,
      JSON.stringify(fastScrollResult),
    );

    await toggleSource(handle.page);
    await waitForSourceInput(handle.page);
    const sourceClean = await handle.page.evaluate(() => {
      const frame = document.querySelector('.editor-frame');
      const input = frame?.querySelector<HTMLTextAreaElement>('.source-editor__input');
      return !(
        frame?.innerHTML.includes('MDEDITORSELECTIONSTARTTOKEN') ||
        frame?.innerHTML.includes('MDEDITORSELECTIONENDTOKEN') ||
        input?.value.includes('MDEDITORSELECTIONSTARTTOKEN') ||
        input?.value.includes('MDEDITORSELECTIONENDTOKEN')
      );
    });
    assert('source switch leaves no selection marker leak', sourceClean, String(sourceClean));

    await toggleSource(handle.page);
    await waitForVisualMode(handle.page);
    const visualClean = await handle.page.evaluate(() => {
      const editor = window.__marivellEditor as { getJSON: () => unknown };
      const surface = document.querySelector('.editor-surface');
      return !(
        JSON.stringify(editor.getJSON()).includes('MDEDITORSELECTIONSTARTTOKEN') ||
        JSON.stringify(editor.getJSON()).includes('MDEDITORSELECTIONENDTOKEN') ||
        surface?.innerHTML.includes('MDEDITORSELECTIONSTARTTOKEN') ||
        surface?.innerHTML.includes('MDEDITORSELECTIONENDTOKEN')
      );
    });
    assert('visual switch leaves no selection marker leak', visualClean, String(visualClean));
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

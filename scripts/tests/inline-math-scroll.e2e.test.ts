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

interface JumpResult {
  placeholdersAfter: number;
  activeAfter: number;
  notRealKatexAfter: number;
  anchorDrift: number;
  sawRawPlaceholder: boolean;
  rawToKatexMs: number;
  maxActivationFrameMs: number;
  timedOut: boolean;
  placeholderDetails: Array<{ cls: string; text: string; preview: string; html: string }>;
  hydrateTimings: Record<string, unknown> | null;
  phaseTimings: Record<string, unknown> | null;
  centerDebug: { center: number | null; top: number | null; bottom: number | null; scrollTop: number };
}

async function main(): Promise<void> {
  console.log('\n## inline math scroll activation e2e');
  const lines: string[] = [];
  for (let index = 0; index < 1200; index += 1) {
    const math = index === 600
      ? ' $x$ '
      : index === 1199
        ? ' $y$ '
        : ' no-math ';
    lines.push(
      `## Section ${index}\n\n` +
        `Paragraph ${index} has${math}and this filler text keeps the file above the large-document worker threshold while retaining a compact formula-heavy scroll target: ${index} ${index} ${index}.\n`,
    );
  }
  const source = `${lines.join('\n')}\n`;
  const markdownPath = path.join(os.tmpdir(), `marivell-inline-math-scroll-${process.pid}.md`);
  fs.writeFileSync(markdownPath, source, 'utf8');

  const outDir = path.join(os.tmpdir(), `marivell-inline-math-scroll-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-inline-math-scroll-profile-${process.pid}`);
  const port = 9900 + (process.pid % 200);

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
    await handle.page.evaluate(() => {
      const benchmarkWindow = window as unknown as Record<string, unknown>;
      if (typeof benchmarkWindow.__marivellClearFormulaHtmlCache === 'function') {
        (benchmarkWindow.__marivellClearFormulaHtmlCache as () => void)();
      }
    });
    // Let the worker pre-render the formula chunk cache before exercising the
    // scroll gate. When a fallback is still observed, the assertions below keep
    // the 50ms replacement constraint instead of assuming cached activation.
    const jumpScript = `(async (args) => {
      const { ratio = 0.5 } = args ?? {};
      const frame = document.querySelector('.editor-frame');
      if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
      const editor = window.__marivellEditor;
      if (!editor) throw new Error('benchmark editor not exposed');
      const benchmarkWindow = window;
      if (typeof benchmarkWindow.__marivellResetInlineMathActivationMetrics === 'function') {
        benchmarkWindow.__marivellResetInlineMathActivationMetrics();
      }

      const frameRect = frame.getBoundingClientRect();
      const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
      const targetScrollTop = Math.min(maxScrollTop, Math.round(maxScrollTop * ratio));
      frame.scrollTop = targetScrollTop;
      void frame.offsetHeight;

      const getTopAnchor = () => {
        const currentRect = frame.getBoundingClientRect();
        const candidates = Array.from(
          frame.querySelectorAll('.editor-surface p, .math-inline-node'),
        )
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return { element, relativeTop: rect.top - currentRect.top, top: rect.top, bottom: rect.bottom };
          })
          .filter((candidate) => candidate.bottom > currentRect.top && candidate.top < currentRect.bottom)
          .sort((a, b) => a.relativeTop - b.relativeTop);
        return candidates[0] ?? null;
      };
      const beforeTopAnchor = getTopAnchor();

      const isInlineMathPlaceholder = (element) => {
        if (element.classList.contains('math-inline-node--placeholder')) return true;
        const preview = element.querySelector(':scope > .math-node-preview');
        if (!preview) return true;
        if (preview.querySelector('.katex')) return false;
        if (preview.querySelector('.katex-error')) return false;
        if (preview.querySelector('.math-node-empty-hint, .math-node-placeholder-hint')) return false;
        return !Array.from(preview.childNodes).some(
          (child) => child.nodeType === Node.TEXT_NODE && Boolean(child.textContent?.trim()),
        );
      };
      const countInline = () => {
        const currentRect = frame.getBoundingClientRect();
        let count = 0;
        for (const element of frame.querySelectorAll('.math-inline-node')) {
          const rect = element.getBoundingClientRect();
          if (rect.bottom > currentRect.top && rect.top < currentRect.bottom && isInlineMathPlaceholder(element)) {
            count += 1;
          }
        }
        return count;
      };
      const countActive = () => {
        const currentRect = frame.getBoundingClientRect();
        let count = 0;
        for (const element of frame.querySelectorAll('.math-inline-node')) {
          const rect = element.getBoundingClientRect();
          if (rect.bottom > currentRect.top && rect.top < currentRect.bottom && element.querySelector('.math-node-preview .katex')) {
            count += 1;
          }
        }
        return count;
      };
      const countNotRealKatex = () => {
        const currentRect = frame.getBoundingClientRect();
        let count = 0;
        for (const element of frame.querySelectorAll('.math-inline-node')) {
          const rect = element.getBoundingClientRect();
          if (rect.bottom <= currentRect.top || rect.top >= currentRect.bottom) continue;
          const preview = element.querySelector(':scope > .math-node-preview');
          const hasKatex = Boolean(preview?.querySelector('.katex'));
          const hasErrorOrHint = Boolean(
            preview?.querySelector('.katex-error, .math-node-empty-hint, .math-node-placeholder-hint'),
          );
          if (!hasKatex || hasErrorOrHint) count += 1;
        }
        return count;
      };

      let sawRawPlaceholder = false;
      let rawStart = 0;
      let rawToKatexMs = 0;
      let forceActivated = 0;
      let immediateCount = 0;
      let currentCount = 0;
      const firstFrame = new Promise((resolve) => requestAnimationFrame(resolve));
      frame.dispatchEvent(new Event('scroll'));
      await firstFrame;
      const firstCount = countInline();
      if (firstCount > 0) {
        sawRawPlaceholder = true;
        rawStart = performance.now();
        if (typeof benchmarkWindow.__marivellForceInlineHydrateViewport === 'function') {
          forceActivated = benchmarkWindow.__marivellForceInlineHydrateViewport();
        }
        immediateCount = countInline();
        if (immediateCount === 0) {
          currentCount = 0;
          rawToKatexMs = performance.now() - rawStart;
        }
      }
      const deadline = performance.now() + 10_000;
      while (currentCount > 0 && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        currentCount = countInline();
        if (sawRawPlaceholder && currentCount === 0) {
          rawToKatexMs = performance.now() - rawStart;
        }
      }
      if (sawRawPlaceholder && currentCount === 0 && rawToKatexMs === 0) {
        rawToKatexMs = performance.now() - rawStart;
      }
      for (let index = 0; index < 3; index += 1) {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }

      const afterTopAnchor = getTopAnchor();
      const anchorDrift =
        !beforeTopAnchor ||
        !afterTopAnchor ||
        beforeTopAnchor.element !== afterTopAnchor.element ||
        !afterTopAnchor.element.isConnected
          ? 99
          : Math.abs(afterTopAnchor.relativeTop - beforeTopAnchor.relativeTop);

      return {
        placeholdersAfter: countInline(),
        activeAfter: countActive(),
        notRealKatexAfter: countNotRealKatex(),
        anchorDrift,
        sawRawPlaceholder,
        rawToKatexMs,
        maxActivationFrameMs: benchmarkWindow.__marivellInlineMathActivationMaxFrameMs ?? 0,
        timedOut: currentCount > 0,
        forceActivated,
        immediateCount,
        placeholderDetails: [],
        hydrateTimings: null,
        phaseTimings: null,
        centerDebug: { center: null, top: null, bottom: null, scrollTop: frame.scrollTop },
      };
    })()`;

    for (const [name, ratio] of [
      ['middle', 0.5],
      ['bottom', 1],
    ] as const) {
      const jump = await withTimeout(
        handle.page.evaluate(jumpScript, { ratio }),
        15_000,
        `inline-math-scroll-${name}`,
      );
      if (!jump.ok) {
        assert(`scroll to ${name} completes`, false, jump.label);
        continue;
      }
      const result = jump.value as JumpResult;
      assert(
        `scroll to ${name} replaces visible inline placeholders`,
        result.placeholdersAfter === 0 && !result.timedOut,
        JSON.stringify(result),
      );
      assert(
        `scroll to ${name} renders visible .katex inline math`,
        result.activeAfter > 0,
        JSON.stringify(result),
      );
      assert(
        `scroll to ${name} renders real KaTeX for every visible inline math node`,
        result.notRealKatexAfter === 0,
        JSON.stringify(result),
      );
      assert(
        `scroll to ${name} keeps viewport top anchor drift at zero`,
        result.anchorDrift < 1,
        JSON.stringify(result),
      );
      if (name === 'middle') {
        assert(
          `scroll to ${name} exercises raw to KaTeX fallback`,
          result.sawRawPlaceholder,
          JSON.stringify(result),
        );
      }
      assert(
        `scroll to ${name} raw to KaTeX replacement stays within 50ms`,
        !result.sawRawPlaceholder || result.rawToKatexMs <= 50,
        JSON.stringify(result),
      );
      assert(
        `scroll to ${name} single activation frame stays within 4ms`,
        result.maxActivationFrameMs <= 4,
        JSON.stringify(result),
      );
    }

    const dragScript = `(async () => {
      const frame = document.querySelector('.editor-frame');
      if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
      const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
      const target = Math.round(maxScrollTop * 0.25);

      const isInlineMathPlaceholder = (element) => {
        if (element.classList.contains('math-inline-node--placeholder')) return true;
        const preview = element.querySelector(':scope > .math-node-preview');
        if (!preview) return true;
        if (preview.querySelector('.katex')) return false;
        if (preview.querySelector('.katex-error')) return false;
        if (preview.querySelector('.math-node-empty-hint, .math-node-placeholder-hint')) return false;
        return !Array.from(preview.childNodes).some(
          (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
        );
      };
      const countInline = () => {
        const frameRect = frame.getBoundingClientRect();
        let count = 0;
        for (const element of frame.querySelectorAll('.math-inline-node')) {
          const rect = element.getBoundingClientRect();
          if (rect.bottom > frameRect.top && rect.top < frameRect.bottom && isInlineMathPlaceholder(element)) count += 1;
        }
        return count;
      };
      const getTopAnchor = () => {
        const frameRect = frame.getBoundingClientRect();
        const editor = window.__marivellEditor;
        if (!editor) return null;
        try {
          const point = editor.view.posAtCoords({
            left: frameRect.left + Math.max(8, frameRect.width * 0.2),
            top: frameRect.top + 8,
          });
          if (!point) return null;
          const anchorDom = editor.view.domAtPos(point.pos);
          let activationElement = anchorDom?.node instanceof Element
            ? anchorDom.node
            : (anchorDom?.node?.parentElement ?? null);
          while (activationElement) {
            const virtualNodeId = activationElement.getAttribute?.('data-virtual-node-id');
            if (virtualNodeId) {
              window.__marivellForceActivateById?.(virtualNodeId);
              break;
            }
            activationElement = activationElement.parentElement;
          }
          const coords = editor.view.coordsAtPos(point.pos);
          if (!coords) return null;
          return { pmPos: point.pos, relativeTop: coords.top - frameRect.top };
        } catch {
          return null;
        }
      };
      const doubleRaf = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      frame.scrollTop = target;
      frame.dispatchEvent(new Event('scroll'));
      let readyPlaceholders = countInline();
      const readyDeadline = performance.now() + 10000;
      while (readyPlaceholders > 0 && performance.now() < readyDeadline) {
        await doubleRaf();
        readyPlaceholders = countInline();
      }
      for (let index = 0; index < 3; index += 1) await doubleRaf();
      const beforeTopAnchor = getTopAnchor();
      const start = performance.now();
      frame.scrollTop = 0;
      frame.dispatchEvent(new Event('scroll'));
      frame.scrollTop = maxScrollTop;
      frame.dispatchEvent(new Event('scroll'));
      frame.scrollTop = target;
      frame.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const firstFramePlaceholders = countInline();
      let finalPlaceholders = firstFramePlaceholders;
      const deadline = performance.now() + 10000;
      while (finalPlaceholders > 0 && performance.now() < deadline) {
        await doubleRaf();
        finalPlaceholders = countInline();
      }
      let stableAnchorFrames = 0;
      const stabilityDeadline = performance.now() + 2000;
      while (stableAnchorFrames < 2 && performance.now() < stabilityDeadline) {
        await doubleRaf();
        const stabilityFrameRect = frame.getBoundingClientRect();
        const stabilityEditor = window.__marivellEditor;
        const stabilityCoords = stabilityEditor?.view.coordsAtPos(beforeTopAnchor.pmPos);
        const driftNow = stabilityCoords
          ? Math.abs(stabilityCoords.top - stabilityFrameRect.top - beforeTopAnchor.relativeTop)
          : Number.POSITIVE_INFINITY;
        if (driftNow < 0.5) {
          stableAnchorFrames += 1;
        } else {
          stableAnchorFrames = 0;
        }
      }
      for (let index = 0; index < 3; index += 1) await doubleRaf();
      const afterTopAnchor = getTopAnchor();
      const frameRect = frame.getBoundingClientRect();
      const editor = window.__marivellEditor;
      const afterDom = beforeTopAnchor && editor ? editor.view.domAtPos(beforeTopAnchor.pmPos) : null;
      let afterActivationElement = afterDom?.node instanceof Element
        ? afterDom.node
        : (afterDom?.node?.parentElement ?? null);
      while (afterActivationElement) {
        const virtualNodeId = afterActivationElement.getAttribute?.('data-virtual-node-id');
        if (virtualNodeId) {
          window.__marivellForceActivateById?.(virtualNodeId);
          break;
        }
        afterActivationElement = afterActivationElement.parentElement;
      }
      const afterCoords = beforeTopAnchor && editor
        ? editor.view.coordsAtPos(beforeTopAnchor.pmPos)
        : null;
      const anchorDrift =
        !beforeTopAnchor || !afterTopAnchor || !afterCoords
          ? 99
          : Math.abs(afterCoords.top - frameRect.top - beforeTopAnchor.relativeTop);
      return {
        firstFramePlaceholders,
        finalPlaceholders,
        scrollTopDrift: Math.abs(frame.scrollTop - target),
        anchorDrift,
        inlineHeightDrift: anchorDrift,
        readyMs: performance.now() - start,
        timedOut: finalPlaceholders > 0,
      };
    })()`;
    const drag = await withTimeout(
      handle.page.evaluate(dragScript),
      20_000,
      'drag-sequence',
    );
    if (!drag.ok) {
      assert('drag top -> bottom -> middle completes', false, drag.label);
    } else {
      const result = drag.value as {
        firstFramePlaceholders: number;
        finalPlaceholders: number;
        scrollTopDrift: number;
        anchorDrift: number;
        inlineHeightDrift: number;
        readyMs: number;
        timedOut: boolean;
      };
      assert(
        'drag first frame has zero visible placeholders',
        result.firstFramePlaceholders === 0 && result.finalPlaceholders === 0 && !result.timedOut,
        JSON.stringify(result),
      );
      assert(
        'drag keeps scrollTop drift at zero',
        result.scrollTopDrift === 0,
        JSON.stringify(result),
      );
      assert(
        'drag keeps inline height drift at zero',
        result.inlineHeightDrift === 0,
        JSON.stringify(result),
      );
    }

    const syntaxBefore = await handle.page.evaluate(() => {
      const diagnostics = (window as unknown as Record<string, unknown>).__marivellMathSyntaxDiagnostics as
        | { scrollEventCount?: number; viewportRafCount?: number; viewportDispatchCount?: number }
        | undefined;
      return {
        scrollEventCount: diagnostics?.scrollEventCount ?? 0,
        viewportRafCount: diagnostics?.viewportRafCount ?? 0,
        viewportDispatchCount: diagnostics?.viewportDispatchCount ?? 0,
      };
    });
    await handle.page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      if (!frame) throw new Error('editor frame missing');
      frame.scrollTop = 0;
      for (let index = 0; index < 120; index += 1) {
        frame.dispatchEvent(new Event('scroll'));
      }
    });
    await handle.page.waitForTimeout(200);
    const syntaxAfter = await handle.page.evaluate(() => {
      const diagnostics = (window as unknown as Record<string, unknown>).__marivellMathSyntaxDiagnostics as
        | { scrollEventCount?: number; viewportRafCount?: number; viewportDispatchCount?: number }
        | undefined;
      return {
        scrollEventCount: diagnostics?.scrollEventCount ?? 0,
        viewportRafCount: diagnostics?.viewportRafCount ?? 0,
        viewportDispatchCount: diagnostics?.viewportDispatchCount ?? 0,
      };
    });
    assert(
      'MathSyntaxHighlight coalesces a scroll burst into one rAF update',
      syntaxAfter.scrollEventCount - syntaxBefore.scrollEventCount >= 120 &&
        syntaxAfter.viewportRafCount - syntaxBefore.viewportRafCount <= 2 &&
        syntaxAfter.viewportDispatchCount - syntaxBefore.viewportDispatchCount <= 2,
      JSON.stringify({ syntaxBefore, syntaxAfter }),
    );

    const postDragMarker = `POST_DRAG_${Date.now()}`;
    const postDrag = await handle.page.evaluate(async (marker) => {
      const editor = (window as unknown as {
        getJSON: () => unknown;
        commands: {
          setTextSelection: (pos: number) => boolean;
          selectAll: () => boolean;
          focus: () => boolean;
        };
        state: {
          doc: {
            descendants: (fn: (node: { isTextblock?: boolean; textContent?: string }, pos: number) => boolean | void) => void;
            content: { size: number };
            textBetween: (from: number, to: number, sep?: string, leaf?: string) => string;
          };
          selection: { from: number; to: number };
        };
      }).__marivellEditor;
      if (!editor) throw new Error('editor missing');
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
      const typed = document.execCommand('insertText', false, marker);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '\n');
      const before = editor.state.doc.content.size;
      const selected = editor.commands.selectAll();
      const { from: selectionFrom, to: selectionTo } = editor.state.selection;
      return {
        typed: Boolean(typed && text.includes(marker)),
        selectAll: Boolean(selected && selectionFrom === 0 && selectionTo >= before),
        markerLeak: JSON.stringify(editor.getJSON()).includes('MDEDITORSELECTION'),
      };
    }, postDragMarker);
    assert(
      'large scroll drag followed by typing and Ctrl+A stays functional',
      postDrag.typed && postDrag.selectAll && !postDrag.markerLeak,
      JSON.stringify(postDrag),
    );

    await handle.page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-source-mode' }),
      );
    });
    const sourceInputWait = await withTimeout(
      handle.page.waitForFunction(() => {
        const input = document.querySelector<HTMLTextAreaElement>('.source-editor__input');
        return Boolean(input && input.value.length > 100_000);
      }, undefined, { timeout: 30_000 }),
      35_000,
      'post-drag-source',
    );
    assert('source mode opens after large scroll drag', sourceInputWait.ok, sourceInputWait.label);
    const sourceValueAfterDrag = await handle.page.locator('.source-editor__input').inputValue();
    assert(
      'source mode after scroll drag has no selection marker leakage',
      !sourceValueAfterDrag.includes('MDEDITORSELECTION'),
      sourceValueAfterDrag.slice(0, 200),
    );

    await handle.page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-source-mode' }),
      );
    });
    const visualBackWait = await withTimeout(
      handle.page.waitForFunction(() => {
        const frame = document.querySelector<HTMLElement>('.editor-frame');
        return Boolean(
          frame &&
            !frame.classList.contains('is-source') &&
            !frame.querySelector('.source-editor__input') &&
            !frame.querySelector('.editor-loading--mode-switch'),
        );
      }, undefined, { timeout: 30_000 }),
      35_000,
      'post-drag-visual',
    );
    assert('visual mode returns after source mode post-drag', visualBackWait.ok, visualBackWait.label);
    const finalVisualState = await handle.page.evaluate(() => {
      const editor = (window as unknown as { getJSON: () => unknown }).__marivellEditor;
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      const frameRect = frame?.getBoundingClientRect();
      let visiblePlaceholders = 0;
      if (frame && frameRect) {
        for (const element of frame.querySelectorAll('.math-inline-node')) {
          if (!element.classList.contains('math-inline-node--placeholder')) continue;
          const rect = element.getBoundingClientRect();
          if (rect.bottom > frameRect.top && rect.top < frameRect.bottom) visiblePlaceholders += 1;
        }
      }
      return {
        markerLeak: editor ? JSON.stringify(editor.getJSON()).includes('MDEDITORSELECTION') : true,
        visiblePlaceholders,
      };
    });
    assert(
      'visual mode after post-drag round-trip has no marker or viewport placeholder regression',
      !finalVisualState.markerLeak && finalVisualState.visiblePlaceholders === 0,
      JSON.stringify(finalVisualState),
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

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { acquireExclusiveBenchmarkRun } from './exclusive-run';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const electronBin = path.join(projectRoot, 'node_modules/.bin/electron');
const electronViteBin = path.join(projectRoot, 'node_modules/.bin/electron-vite');

const defaultMarkdownPath =
  process.env.MARIVELL_BENCHMARK_FILE ??
  '/home/crh/下载/barfoot_ser24/barfoot_ser24.md';

interface ReportEntry {
  metric: string;
  value: number | string;
  unit: string;
  note?: string;
}

type MeasuredValue = number | string | null;

interface BudgetComparisonEntry {
  budget: number;
  measured: MeasuredValue;
  status: 'pass' | 'fail' | 'not-measured';
  note?: string;
}

interface BenchmarkTimelineEntry {
  name: string;
  value: number;
}

interface ElectronHandle {
  child: ReturnType<typeof spawn>;
  browser: Browser;
  page: Page;
  port: number;
  spawnedAt: number;
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = waitUnref(timeoutMs).then(() => ({ ok: false as const, label }));
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

async function getTimeline(page: Page): Promise<BenchmarkTimelineEntry[]> {
  return page.evaluate(() => window.markdownEditor.getBenchmarkTimeline());
}

async function waitForVisualReady(
  page: Page,
  expectedTextLength: number,
  deadlineMs: number,
): Promise<{
  waitMs: number;
  scrollHeight: number;
  textLength: number;
  timedOut: boolean;
}> {
  return page.evaluate(
    async ({ expectedLength, deadlineMs }) => {
      const start = Date.now();
      const deadline = start + deadlineMs;
      while (Date.now() < deadline) {
        const loading = document.querySelector('.editor-loading');
        const surface = document.querySelector('.editor-surface');
        const frame = document.querySelector('.editor-frame');
        if (
          !loading &&
          surface &&
          frame &&
          surface.innerText.length > expectedLength
        ) {
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
    { expectedLength: expectedTextLength, deadlineMs },
  );
}

async function measureModeSwitch(
  page: Page,
  targetMode: 'source' | 'visual',
  expectedTextLength: number,
  timeoutMs: number,
): Promise<{
  switchMs: number;
  timedOut: boolean;
  note: string;
  widthBucketCalls?: number;
  widthBucketLayoutReads?: number;
  hydrateTargetRangeCalls?: number;
}> {
  const targetIsSource = targetMode === 'source';
  const script = `(async () => {
    const frame = document.querySelector('.editor-frame');
    if (!frame) {
      return { switchMs: 0, timedOut: true, note: 'editor frame missing' };
    }

    const widthBucketBefore = window.__marivellGetEditorWidthBucketDiagnostics?.() ?? null;
    const hydrateBefore = window.__marivellHydrateTargetRangeCalls ?? 0;
    const start = performance.now();
    const currentlySource = frame.classList.contains('is-source');
    if (currentlySource !== ${targetIsSource}) {
      window.dispatchEvent(
        new CustomEvent('markdown-editor:menu-action', {
          detail: 'toggle-source-mode',
        }),
      );
    }

    const deadline = start + ${timeoutMs};
    const doubleRaf = () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    let note = 'not-ready';

    while (performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const currentFrame = document.querySelector('.editor-frame');
      const currentIsSource = currentFrame?.classList.contains('is-source') ?? null;
      const overlay = document.querySelector('.editor-loading--mode-switch');
      const modeMatches = currentIsSource === ${targetIsSource};
      if (!currentFrame || !modeMatches || overlay) {
        if (!modeMatches) note = 'mode-not-switched';
        if (overlay) note = 'mode-switch-overlay';
        continue;
      }

      let loaded = false;
      if (${targetIsSource}) {
        const input = currentFrame.querySelector('.source-editor__input');
        loaded = Boolean(
          input instanceof HTMLTextAreaElement &&
            input.value.length >= ${Math.max(expectedTextLength, 1_000)},
        );
        if (!loaded) note = 'source-text-not-loaded';
      } else {
        const surface = currentFrame.querySelector('.editor-surface');
        const proseMirror = currentFrame.querySelector('.ProseMirror');
        const editor = window.__marivellEditor;
        loaded = Boolean(
          surface &&
            proseMirror &&
            editor &&
            !editor.isDestroyed &&
            editor.state.doc.nodeSize > ${Math.max(expectedTextLength, 1_000)},
        );
        if (!loaded) note = 'visual-content-not-ready';
      }

      if (loaded) {
        await doubleRaf();
        const widthBucketAfter = window.__marivellGetEditorWidthBucketDiagnostics?.() ?? null;
        return {
          switchMs: performance.now() - start,
          timedOut: false,
          note: currentIsSource ? 'source-ready' : 'visual-ready',
          widthBucketCalls:
            widthBucketBefore && widthBucketAfter
              ? widthBucketAfter.calls - widthBucketBefore.calls
              : undefined,
          widthBucketLayoutReads:
            widthBucketBefore && widthBucketAfter
              ? widthBucketAfter.layoutReads - widthBucketBefore.layoutReads
              : undefined,
          hydrateTargetRangeCalls:
            (window.__marivellHydrateTargetRangeCalls ?? 0) - hydrateBefore,
        };
      }
    }

    return { switchMs: performance.now() - start, timedOut: true, note };
  })()`;
  return page.evaluate(script);
}

async function measureVisualEdit(page: Page): Promise<{
  editMs: number;
  marker: string;
  applied: boolean;
}> {
  return page.evaluate(async () => {
    const surface = document.querySelector<HTMLElement>('.editor-surface');
    if (!surface) throw new Error('editor surface missing');
    surface.focus();
    const selection = window.getSelection();
    if (selection) {
      selection.selectAllChildren(surface);
      selection.collapseToStart();
    }
    const marker = `PERF_MARK_${Date.now()}`;
    const start = performance.now();
    document.execCommand('insertText', false, marker);
    while (
      !surface.innerText.includes(marker) &&
      performance.now() - start < 60_000
    ) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const editMs = performance.now() - start;
    const applied = surface.innerText.includes(marker);
    return { editMs, marker, applied };
  });
}

interface UiffClickResult {
  x: number;
  y: number;
  selectionExists: boolean;
  selectedPos: number | null;
  mappedPos: number | null;
  deviationPx: number;
}

interface UiffInputResult {
  ms: number;
  roundTripMs?: number;
  applied: boolean;
}

interface UiffViewportResult {
  placeholderCount: number;
  visibleFormulaCount: number;
  visibleRealKatexCount: number;
  real: boolean;
}

interface UiffOverlayResult {
  overlayCount: number;
  hitEditor: boolean;
  hitElement: string | null;
  noOverlay: boolean;
}

interface UiffCoordsResult {
  sampled: number;
  nonNull: number;
  points: Array<{ x: number; y: number; pos: number | null }>;
}

interface UiffScrollResult {
  stableFrames: number;
  scrollTop: number;
  layoutShiftEntries: number;
  layoutShiftCumulative: number;
  layoutShiftSupported: boolean;
  stable: boolean;
}

interface FirstFrameContractResult {
  click: UiffClickResult;
  input: UiffInputResult;
  viewport: UiffViewportResult;
  overlay: UiffOverlayResult;
  coords: UiffCoordsResult;
  scroll: UiffScrollResult;
  passed: boolean;
}

async function measureFirstFrameContract(page: Page): Promise<FirstFrameContractResult> {
  const clickTarget = await page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>('.editor-frame');
    if (!frame) {
      throw new Error('editor frame missing');
    }
    const frameRect = frame.getBoundingClientRect();
    const editor = window.__marivellEditor as {
      view?: {
        coordsAtPos: (pos: number) => { left: number; top: number; bottom: number } | null;
        posAtCoords: (coords: { left: number; top: number }) => { pos: number; inside: number } | null;
      };
    };
    const candidates = Array.from(
      frame.querySelectorAll<HTMLElement>(
        '.editor-surface p, .editor-surface li, .editor-surface blockquote, .editor-surface h1, .editor-surface h2, .editor-surface h3',
      ),
    )
      .filter((element) => (element.textContent ?? '').trim().length > 0);
    const intersectingCandidates = candidates.filter((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.bottom > frameRect.top &&
        rect.top < frameRect.bottom &&
        rect.right > frameRect.left &&
        rect.left < frameRect.right
      );
    });
    const orderedCandidates =
      intersectingCandidates.length > 0 ? intersectingCandidates : candidates;
    orderedCandidates.sort((left, right) => {
        const leftBody = left.matches('p, li, blockquote') ? 0 : 1;
        const rightBody = right.matches('p, li, blockquote') ? 0 : 1;
        return leftBody !== rightBody
          ? leftBody - rightBody
          : left.getBoundingClientRect().top - right.getBoundingClientRect().top;
      });
    for (const element of orderedCandidates) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const text = node.nodeValue ?? '';
        const match = text.search(/\S/);
        if (match >= 0) {
          const range = document.createRange();
          range.setStart(node, match);
          range.setEnd(node, match + 1);
          const rect = range.getBoundingClientRect();
          if (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > frameRect.top &&
            rect.top < frameRect.bottom &&
            rect.right > frameRect.left &&
            rect.left < frameRect.right
          ) {
            const pointPos = editor?.view?.posAtCoords({
              left: rect.left + 0.5,
              top: rect.top + rect.height / 2,
            });
            const coords = pointPos
              ? editor?.view?.coordsAtPos(pointPos.pos) ?? null
              : null;
            if (coords) {
              return {
                x: coords.left,
                y: coords.top + Math.max(1, (coords.bottom - coords.top) / 2),
              };
            }
          }
        }
        node = walker.nextNode();
      }
    }
    throw new Error('no visible text target');
  });
  await page.mouse.click(clickTarget.x, clickTarget.y);
  await page.waitForTimeout(80);
  const click = await page.evaluate((point) => {
    const editor = window.__marivellEditor as {
      state: { selection: { from: number } };
      view: {
        coordsAtPos: (pos: number) => { left: number; top: number; right: number; bottom: number } | null;
        posAtCoords: (coords: { left: number; top: number }) => { pos: number; inside: number } | null;
      };
    };
    const selection = editor?.state.selection;
    const pointPos = editor?.view.posAtCoords({ left: point.x, top: point.y }) ?? null;
    const coords = pointPos ? editor?.view.coordsAtPos(pointPos.pos) ?? null : null;
    return {
      x: point.x,
      y: point.y,
      selectionExists: Boolean(selection && selection.from >= 0),
      selectedPos: selection?.from ?? null,
      mappedPos: pointPos?.pos ?? null,
      deviationPx: coords
        ? Math.max(
            Math.abs(coords.left - point.x),
            Math.abs(coords.right - point.x),
            Math.abs((coords.top + coords.bottom) / 2 - point.y),
          )
        : Number.POSITIVE_INFINITY,
    };
  }, clickTarget);

  const cdpSession = await page.context().newCDPSession(page);
  const inputBefore = await page.evaluate(() => {
    const editor = window.__marivellEditor as {
      state: {
        doc: { content: { size: number }; descendants: (fn: (node: { isTextblock?: boolean; textContent?: string }, pos: number) => boolean | void) => void };
        selection: { from: number };
      };
      commands: { focus: () => boolean; setTextSelection: (pos: number) => boolean };
    };
    if (!editor) {
      throw new Error('editor missing');
    }
    let from = editor.state.selection?.from ?? -1;
    if (from < 0) {
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
      if (from === -1) {
        throw new Error('no text block');
      }
      editor.commands.setTextSelection(from);
      editor.commands.focus();
    }
    editor.commands.focus();
    return {
      before: editor.state.doc.content.size,
      selectedPos: editor.state.selection.from,
    };
  });
  const inputStart = performance.now();
  await cdpSession.send('Input.insertText', { text: 'x' });
  const inputPoll = await page.evaluate(async (before) => {
    const start = performance.now();
    const deadline = start + 5000;
    while (performance.now() < deadline) {
      const editor = window.__marivellEditor as {
        state?: { doc?: { content?: { size?: number } } };
      };
      if (
        editor?.state?.doc?.content &&
        typeof editor.state.doc.content.size === 'number' &&
        editor.state.doc.content.size === before + 1
      ) {
        return { applied: true, ms: performance.now() - start };
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { applied: false, ms: performance.now() - start };
  }, inputBefore.before);
  const inputRoundTripMs = performance.now() - inputStart;
  await page.evaluate(() => {
    const editor = window.__marivellEditor as {
      commands: { undo: () => boolean };
    };
    editor?.commands.undo();
  });
  await cdpSession.detach().catch(() => {});
  const input: UiffInputResult = {
    ms: inputPoll.ms,
    roundTripMs: inputRoundTripMs,
    applied: inputPoll.applied,
  };

  const viewport = await page.evaluate((): UiffViewportResult => {
    const frame = document.querySelector<HTMLElement>('.editor-frame');
    if (!frame) {
      throw new Error('editor frame missing');
    }
    const frameRect = frame.getBoundingClientRect();
    const placeholderSelector = [
      '.math-inline-node--placeholder',
      '.math-block-node-placeholder',
      '.image-node__placeholder',
      '.mermaid-node__placeholder',
      '.html-block-placeholder',
      '.code-block-node--placeholder',
      '.mermaid-node__empty',
    ].join(',');
    const visibleFormulas = Array.from(
      frame.querySelectorAll<HTMLElement>('.math-inline-node, .math-block-node'),
    ).filter((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.bottom > frameRect.top &&
        rect.top < frameRect.bottom &&
        rect.right > frameRect.left &&
        rect.left < frameRect.right
      );
    });
    const visibleRealKatexCount = visibleFormulas.filter((element) =>
      element.querySelector('.math-node-preview .katex, .katex'),
    ).length;
    const placeholderCount = Array.from(frame.querySelectorAll<HTMLElement>(placeholderSelector)).filter(
      (element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.bottom > frameRect.top &&
          rect.top < frameRect.bottom &&
          rect.right > frameRect.left &&
          rect.left < frameRect.right
        );
      },
    ).length;
    return {
      placeholderCount,
      visibleFormulaCount: visibleFormulas.length,
      visibleRealKatexCount,
      real: visibleFormulas.length > 0 && visibleRealKatexCount === visibleFormulas.length && placeholderCount === 0,
    };
  });

  const overlay = await page.evaluate((): UiffOverlayResult => {
    const frame = document.querySelector<HTMLElement>('.editor-frame');
    if (!frame) {
      throw new Error('editor frame missing');
    }
    const overlayCount = document.querySelectorAll(
      '.editor-loading, .editor-loading--mode-switch',
    ).length;
    const rect = frame.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const isSource = frame.classList.contains('is-source');
    const hitEditor = Boolean(
      hit &&
        frame.contains(hit) &&
        (isSource
          ? hit.closest('.source-editor__input') !== null
          : hit.closest('.editor-surface, .ProseMirror') !== null),
    );
    return {
      overlayCount,
      hitEditor,
      hitElement: hit ? `${hit.tagName.toLowerCase()}.${String(hit.className).split(' ').join('.')}` : null,
      noOverlay: overlayCount === 0 && hitEditor,
    };
  });

  const coords = await page.evaluate((): UiffCoordsResult => {
    const frame = document.querySelector<HTMLElement>('.editor-frame');
    const editor = window.__marivellEditor as {
      view?: { posAtCoords: (coords: { left: number; top: number }) => { pos: number } | null };
    };
    if (!frame || !editor?.view) {
      throw new Error('editor frame/view missing');
    }
    const rect = frame.getBoundingClientRect();
    const samplePoints = [
      { x: rect.left + rect.width * 0.25, y: rect.top + rect.height * 0.15 },
      { x: rect.left + rect.width * 0.75, y: rect.top + rect.height * 0.35 },
      { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.5 },
      { x: rect.left + rect.width * 0.25, y: rect.top + rect.height * 0.7 },
      { x: rect.left + rect.width * 0.75, y: rect.top + rect.height * 0.8 },
    ];
    const points = samplePoints.map((point) => ({
      x: point.x,
      y: point.y,
      pos: editor.view?.posAtCoords({ left: point.x, top: point.y })?.pos ?? null,
    }));
    return {
      sampled: points.length,
      nonNull: points.filter((point) => point.pos !== null).length,
      points,
    };
  });

  const scroll = await page.evaluate((): Promise<UiffScrollResult> => {
    const frame = document.querySelector<HTMLElement>('.editor-frame');
    if (!(frame instanceof HTMLElement)) {
      throw new Error('editor frame missing');
    }
    return (async () => {
      const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
      const target = maxScrollTop * 0.4;
      const layoutShifts: Array<{ value: number }> = [];
      let layoutObserver: PerformanceObserver | null = null;
      try {
        layoutObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            layoutShifts.push({ value: (entry as PerformanceEntry & { value?: number }).value ?? 0 });
          }
        });
        layoutObserver.observe({ type: 'layout-shift' });
      } catch {
        // Chromium normally exposes layout-shift; older test builds may not.
      }
      frame.scrollTop = target;
      frame.dispatchEvent(new Event('scroll'));
      const settleDeadline = performance.now() + 3000;
      let previousTop = frame.scrollTop;
      let settleFrames = 0;
      while (performance.now() < settleDeadline && settleFrames < 3) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const nextTop = frame.scrollTop;
        if (nextTop === previousTop) {
          settleFrames += 1;
        } else {
          settleFrames = 0;
          previousTop = nextTop;
        }
      }
      const hydrationDeadline = performance.now() + 5000;
      let hydrationQuietFrames = 0;
      let lastLayoutShiftCount = layoutShifts.length;
      while (performance.now() < hydrationDeadline && hydrationQuietFrames < 10) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const nextTop = frame.scrollTop;
        const nextShiftCount = layoutShifts.length;
        if (nextTop === previousTop && nextShiftCount === lastLayoutShiftCount) {
          hydrationQuietFrames += 1;
        } else {
          hydrationQuietFrames = 0;
          previousTop = nextTop;
          lastLayoutShiftCount = nextShiftCount;
        }
      }
      const firstTop = frame.scrollTop;
      const shiftsBeforeIdle = layoutShifts.length;
      let stableFrames = 0;
      for (let index = 0; index < 10; index += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (frame.scrollTop === firstTop) {
          stableFrames += 1;
        }
      }
      const idleShifts = layoutShifts.slice(shiftsBeforeIdle);
      layoutObserver?.disconnect();
      return {
        stableFrames,
        scrollTop: firstTop,
        layoutShiftEntries: idleShifts.length,
        layoutShiftCumulative: idleShifts.reduce((total, entry) => total + entry.value, 0),
        layoutShiftSupported: layoutObserver !== null,
        stable: stableFrames === 10 && idleShifts.length === 0,
      };
    })();
  });

  const passed =
    click.selectionExists &&
    click.deviationPx <= 4 &&
    input.applied &&
    input.ms <= 100 &&
    viewport.real &&
    overlay.noOverlay &&
    coords.nonNull === coords.sampled &&
    scroll.stable;

  return { click, input, viewport, overlay, coords, scroll, passed };
}

async function measureBackgroundReadiness(
  page: Page,
  expectedUnique: number | null = null,
): Promise<Record<string, unknown>> {
  return page.evaluate((expected) => {
    const target = window as unknown as Record<string, unknown>;
    const frame = document.querySelector<HTMLElement>('.editor-frame');
    const frameRect = frame?.getBoundingClientRect();
    const offscreenSyntaxDecorationCount =
      frameRect && frame
        ? Array.from(frame.querySelectorAll<HTMLElement>('[class*="math-syntax-"]')).filter(
            (element) => {
              const rect = element.getBoundingClientRect();
              return !(
                rect.bottom > frameRect.top &&
                rect.top < frameRect.bottom &&
                rect.right > frameRect.left &&
                rect.left < frameRect.right
              );
            },
          ).length
        : -1;
    return {
      deferred:
        typeof target.__marivellGetDeferredWorkDiagnostics === 'function'
          ? (
              target.__marivellGetDeferredWorkDiagnostics as () => Record<string, unknown>
            )()
          : null,
      heightCache:
        typeof target.__marivellGetNodeHeightCacheStats === 'function'
          ? (
              target.__marivellGetNodeHeightCacheStats as () => Record<string, unknown>
            )()
          : null,
      expectedUnique: expected,
      inline:
        typeof target.__marivellGetInlineMathHeightPrefetchStats === 'function'
          ? (
              target.__marivellGetInlineMathHeightPrefetchStats as () => Record<string, unknown>
            )()
          : null,
      syntax: target.__marivellMathSyntaxDiagnostics ?? null,
      placeholderCount: document.querySelectorAll(
        '.math-inline-node--placeholder, .math-block-node-placeholder, .image-node__placeholder, .mermaid-node__placeholder, .html-block-placeholder, .code-block-node--placeholder, .mermaid-node__empty',
      ).length,
      offscreenSyntaxDecorationCount,
    };
  }, expectedUnique);
}

async function runVisualInteractionSuite(
  page: Page,
): Promise<Record<string, { ms: number; applied: boolean; error?: string; detail?: string }>> {
  const script = `(async () => {
    const editor = window.__marivellEditor;
    if (!editor) return { error: 'benchmark editor not exposed' };
    const raf = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const selectFirstTextBlock = (caretOnly = false) => {
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
      if (from === -1) return false;
      return editor.commands.setTextSelection(caretOnly ? { from, to: from } : { from, to });
    };

    const runOne = async (name) => {
      const start = performance.now();
      let applied = false;
      let error = '';
      let previewError = '';
      let dispatchStart = 0;
      let dispatchMs = 0;
      let rafMs = 0;
      try {
        switch (name) {
          case 'typing':
            selectFirstTextBlock(true);
            dispatchStart = performance.now();
            applied = editor.chain().focus().insertContent('PERF_TYPING').run();
            dispatchMs = performance.now() - dispatchStart;
            break;
          case 'bold':
            selectFirstTextBlock();
            applied = editor.chain().focus().toggleBold().run();
            break;
          case 'heading':
            selectFirstTextBlock();
            applied = editor.chain().focus().toggleHeading({ level: 1 }).run();
            break;
          case 'list':
            selectFirstTextBlock();
            applied = editor.chain().focus().toggleBulletList().run();
            break;
          case 'inline-math':
            selectFirstTextBlock(true);
            applied = editor.chain().focus().insertInlineMath('a^2').run();
            break;
          case 'block-math':
            selectFirstTextBlock(true);
            applied = editor.chain().focus().insertMathBlock('x+y').run();
            break;
          case 'table':
            selectFirstTextBlock(true);
            applied = editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
            break;
          case 'code-block':
            selectFirstTextBlock();
            applied = editor.chain().focus().toggleCodeBlock().run();
            break;
          case 'image':
            selectFirstTextBlock(true);
            applied = editor.chain().focus().setImage({ src: './perf.png', alt: 'perf' }).run();
            break;
          case 'footnote':
            selectFirstTextBlock(true);
            applied = editor.chain().focus().insertFootnoteReference('999').run();
            break;
          case 'undo':
            applied = editor.commands.undo();
            break;
          case 'redo':
            applied = editor.commands.redo();
            break;
          default:
            error = 'unknown operation';
        }
      } catch (err) {
        error = String(err);
      }
      const beforeRaf = performance.now();
      await raf();
      rafMs = performance.now() - beforeRaf;
      if (name === 'block-math' && applied) {
        const blockNode = document.querySelector('.math-block-node');
        if (
          !blockNode ||
          blockNode.classList.contains('math-block-node-placeholder') ||
          !blockNode.querySelector('.math-node-preview .katex')
        ) {
          previewError = 'block math preview not ready after insertion';
        }
      }
      return {
        ms: performance.now() - start,
        applied,
        error: error || previewError,
        detail:
          name === 'typing'
            ? JSON.stringify({ dispatchMs, rafMs, productMs: dispatchMs })
            : undefined,
      };
    };

    const results = {};
    for (const name of ['typing', 'bold', 'heading', 'list', 'inline-math', 'block-math', 'table', 'code-block', 'image', 'footnote', 'undo', 'redo']) {
      results[name] = await runOne(name);
    }

    const combinedStart = performance.now();
    const combinedDetail = {};
    for (const name of ['typing', 'bold', 'inline-math', 'undo', 'redo']) {
      combinedDetail[name] = await runOne(name);
    }
    results.combined = {
      ms: performance.now() - combinedStart,
      applied: true,
      detail: JSON.stringify(combinedDetail),
    };

    return results;
  })()`;
  return page.evaluate(script) as Promise<
    Record<string, { ms: number; applied: boolean; error?: string; detail?: string }>
  >;
}

async function measureVisualScroll(page: Page): Promise<{
  scrollResponseMs: number | null;
  avgFrameMs: number | null;
  maxFrameMs: number | null;
  scrollHeight: number;
  scrollFrameDomMutations: number[];
  scrollFrameRectReads: number[];
  scrollFramePosAtCoordsCalls: number[];
}> {
  const script = `(async () => {
    const frame = document.querySelector('.editor-frame');
    if (!frame) throw new Error('editor frame missing');
    const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    const benchmarkEditor = window.__marivellEditor;
    const originalPosAtCoords = benchmarkEditor?.view?.posAtCoords;
    let rectReads = 0;
    let posAtCoordsCalls = 0;
    Element.prototype.getBoundingClientRect = function (...args) {
      rectReads += 1;
      return originalGetBoundingClientRect.apply(this, args);
    };
    if (benchmarkEditor?.view && typeof originalPosAtCoords === 'function') {
      benchmarkEditor.view.posAtCoords = function (...args) {
        posAtCoordsCalls += 1;
        return originalPosAtCoords.apply(this, args);
      };
    }
    let currentFrameMutations = 0;
    const mutationObserver = new MutationObserver((records) => {
      currentFrameMutations += records.length;
    });
    mutationObserver.observe(frame, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const start = performance.now();
    let eventAt = null;
    const onScroll = () => {
      if (eventAt === null) eventAt = performance.now();
    };
    frame.addEventListener('scroll', onScroll, { once: true });
    frame.scrollBy({ top: Math.max(1, frame.clientHeight * 0.8) });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    frame.removeEventListener('scroll', onScroll);
    const scrollResponseMs = eventAt === null ? null : eventAt - start;

    const deltas = [];
    const scrollFrameDomMutations = [];
    const scrollFrameRectReads = [];
    const scrollFramePosAtCoordsCalls = [];
    let previous = performance.now();
    for (let index = 0; index < 20; index += 1) {
      const mutationsBefore = currentFrameMutations;
      const rectReadsBefore = rectReads;
      const posAtCoordsBefore = posAtCoordsCalls;
      frame.scrollTop = Math.min(
        frame.scrollHeight,
        frame.scrollTop + frame.clientHeight * 0.2,
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = performance.now();
      deltas.push(now - previous);
      scrollFrameDomMutations.push(currentFrameMutations - mutationsBefore);
      scrollFrameRectReads.push(rectReads - rectReadsBefore);
      scrollFramePosAtCoordsCalls.push(posAtCoordsCalls - posAtCoordsBefore);
      previous = now;
    }

    mutationObserver.disconnect();
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    if (
      benchmarkEditor?.view &&
      typeof originalPosAtCoords === 'function'
    ) {
      benchmarkEditor.view.posAtCoords = originalPosAtCoords;
    }
    const avgFrameMs = deltas.length > 0
      ? deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length
      : null;
    const maxFrameMs = deltas.length > 0 ? Math.max(...deltas) : null;
    return {
      scrollResponseMs,
      avgFrameMs,
      maxFrameMs,
      scrollHeight: frame.scrollHeight,
      scrollFrameDomMutations,
      scrollFrameRectReads,
      scrollFramePosAtCoordsCalls,
    };
  })()`;
  return page.evaluate(script) as ReturnType<typeof measureVisualScroll>;
}

interface ScrollIoStateResult {
  avgFrameMs: number;
  p95FrameMs: number;
  maxFrameMs: number;
  callbackEntries: number;
  enqueuedEntries: number;
  observedCount: number;
  observerCount: number;
  callbackMsTotal: number;
  callbackMsMax: number;
}

interface ScrollIoOverheadResult {
  on: ScrollIoStateResult;
  off: ScrollIoStateResult;
  deltaAvgFrameMs: number;
}

async function measureScrollIoOverhead(page: Page): Promise<ScrollIoOverheadResult> {
  const script = `(async () => {
    const frame = document.querySelector('.editor-frame');
    if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
    const benchmarkWindow = window;
    const getDiagnostics = () =>
      typeof benchmarkWindow.__marivellGetIoDiagnostics === 'function'
        ? benchmarkWindow.__marivellGetIoDiagnostics()
        : null;
    const setEnabled = (enabled) => {
      benchmarkWindow.__marivellSetIoEnabled?.(enabled);
    };
    const resetDiagnostics = () => {
      benchmarkWindow.__marivellResetIoDiagnostics?.();
    };
    const percentile = (values, percentileValue) => {
      if (values.length === 0) return 0;
      const sorted = Array.from(values).sort((a, b) => a - b);
      const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
      );
      return sorted[index] ?? 0;
    };
    const runState = async (enabled) => {
      setEnabled(enabled);
      resetDiagnostics();
      frame.scrollTop = 0;
      frame.dispatchEvent(new Event('scroll'));
      const deltas = [];
      let previous = performance.now();
      for (let index = 0; index < 300; index += 1) {
        const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
        const step = Math.max(1, Math.ceil(frame.clientHeight * 0.05));
        frame.scrollTop = Math.min(maxScrollTop, frame.scrollTop + step);
        frame.dispatchEvent(new Event('scroll'));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const now = performance.now();
        deltas.push(now - previous);
        previous = now;
      }
      const diagnostics = getDiagnostics() ?? {
        callbackEntries: 0,
        enqueuedEntries: 0,
        observedCount: 0,
        observerCount: 0,
        callbackMsTotal: 0,
        callbackMsMax: 0,
      };
      return {
        avgFrameMs:
          deltas.length > 0
            ? deltas.reduce((total, value) => total + value, 0) / deltas.length
            : 0,
        p95FrameMs: percentile(deltas, 95),
        maxFrameMs: deltas.length > 0 ? Math.max(...deltas) : 0,
        callbackEntries: diagnostics.callbackEntries,
        enqueuedEntries: diagnostics.enqueuedEntries,
        observedCount: diagnostics.observedCount,
        observerCount: diagnostics.observerCount,
        callbackMsTotal: diagnostics.callbackMsTotal,
        callbackMsMax: diagnostics.callbackMsMax,
      };
    };
    const off = await runState(false);
    const on = await runState(true);
    return {
      on,
      off,
      deltaAvgFrameMs: on.avgFrameMs - off.avgFrameMs,
    };
  })()`;
  return page.evaluate(script) as Promise<ScrollIoOverheadResult>;
}

type ScrollJumpScenario = 'bottom' | 'middle' | 'drag';

async function measureScrollJumpScenario(
  page: Page,
  scenario: ScrollJumpScenario,
): Promise<{
  jumpReadyMs: number;
  placeholderReadyMs: number;
  settleOverheadMs: number;
  firstFramePlaceholders: number;
  finalPlaceholderCount: number;
  scrollTopDrift: number;
  targetScrollTop: number;
  scrollHeight: number;
  beforeScrollTop: number;
  afterAssignScrollTop: number;
  finalScrollTop: number;
  currentMaxScrollTop: number;
  timings: Record<string, unknown> | null;
  hydrateTimings: Record<string, unknown> | null;
  visibleFallbackTimings: Record<string, unknown> | null;
  placeholderDetails: string[];
  firstFrameReady: boolean;
  inlineHeightDrift: number | 'n/a';
  inlineHeightDriftNote: string;
  inlineHeightAnchor: string | null;
  inlineMathActivateReadyMs: number;
  inlineMathActivateMaxFrameMs: number;
  inlineMathViewportKatexReadyMs: number;
  inlineMathViewportKatexMaxFrameMs: number;
  inlineMathViewportKatexCount: number;
  templateCacheHits: number;
  templateCacheMisses: number;
  templateBytes: number;
  katexInjectP50Ms: number;
  katexInjectP95Ms: number;
  katexInjectMaxMs: number;
  placeholderScanMs: number;
  inlinePlaceholderScanMs: number;
  placeholderScanCalls: number;
  inlinePlaceholderScanCalls: number;
  timedOut: boolean;
  functionCosts: Record<string, { totalMs: number; maxMs: number; count: number }> | null;
}> {
  const scenarioName = JSON.stringify(scenario);
  const script = `(async () => {
    const frame = document.querySelector('.editor-frame');
    if (!frame) throw new Error('editor frame missing');

    const placeholderSelectors = [
      '[data-virtual-node-id].math-block-node-placeholder',
      '[data-virtual-node-id].image-node__placeholder',
      '[data-virtual-node-id].mermaid-node__placeholder',
      '[data-virtual-node-id].html-block-placeholder',
      '[data-virtual-node-id].code-block-node--placeholder',
    ];
    const isInlineMathPlaceholder = (element) => {
      if (element.classList.contains('math-inline-node--placeholder')) {
        return true;
      }
      const preview = element.querySelector(':scope > .math-node-preview');
      if (!preview) {
        return true;
      }
      if (preview.querySelector('.katex')) {
        return false;
      }
      if (preview.querySelector('.katex-error')) {
        return false;
      }
      if (preview.querySelector('.math-node-empty-hint, .math-node-placeholder-hint') !== null) {
        return false;
      }
      const hasDirectErrorText = Array.from(preview.childNodes).some(
        (child) => child.nodeType === Node.TEXT_NODE && Boolean(child.textContent?.trim()),
      );
      return !hasDirectErrorText;
    };
    const visiblePlaceholderCount = () => {
      const frameRect = frame.getBoundingClientRect();
      let count = 0;
      for (const selector of placeholderSelectors) {
        for (const element of frame.querySelectorAll(selector)) {
          const rect = element.getBoundingClientRect();
          if (rect.bottom > frameRect.top && rect.top < frameRect.bottom) {
            count += 1;
          }
        }
      }
      for (const element of frame.querySelectorAll('.math-inline-node')) {
        if (isInlineMathPlaceholder(element)) {
          const rect = element.getBoundingClientRect();
          if (rect.bottom > frameRect.top && rect.top < frameRect.bottom) {
            count += 1;
          }
        }
      }
      return count;
    };

    const visibleInlineMathPlaceholderCount = () => {
      const frameRect = frame.getBoundingClientRect();
      let count = 0;
      for (const element of frame.querySelectorAll('.math-inline-node')) {
        if (!isInlineMathPlaceholder(element)) {
          continue;
        }
        const rect = element.getBoundingClientRect();
        if (rect.bottom > frameRect.top && rect.top < frameRect.bottom) {
          count += 1;
        }
      }
      return count;
    };

    const isInlineMathRealKatex = (element) => {
      const preview = element.querySelector(':scope > .math-node-preview');
      if (!preview) {
        return false;
      }
      if (!preview.querySelector('.katex')) {
        return false;
      }
      if (
        preview.querySelector(
          '.katex-error, .math-node-empty-hint, .math-node-placeholder-hint',
        ) !== null
      ) {
        return false;
      }
      return true;
    };

    const visibleInlineMathKatexStats = () => {
      const frameRect = frame.getBoundingClientRect();
      let total = 0;
      let realKatex = 0;
      let notRealKatex = 0;
      for (const element of frame.querySelectorAll('.math-inline-node')) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom <= frameRect.top || rect.top >= frameRect.bottom) {
          continue;
        }
        total += 1;
        if (isInlineMathRealKatex(element)) {
          realKatex += 1;
        } else {
          notRealKatex += 1;
        }
      }
      return { total, realKatex, notRealKatex };
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
        const coords = editor.view.coordsAtPos(point.pos);
        if (!coords) return null;
        const anchorNode = editor.view.domAtPos(point.pos);
        const anchorElement = anchorNode?.node instanceof Element
          ? anchorNode.node
          : (anchorNode?.node?.parentElement ?? null);
        const anchorContext = anchorElement?.closest?.(
          '.math-block-node, .math-inline-node, p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th',
        );
        const anchorText = anchorContext instanceof HTMLElement
          ? (anchorContext.textContent ?? '').trim().slice(0, 40)
          : '';
        return {
          pmPos: point.pos,
          relativeTop: coords.top - frameRect.top,
          description: 'pm:' + point.pos + '|' + (anchorContext?.className ?? '') + (anchorText ? '|' + anchorText : ''),
        };
      } catch {
        return null;
      }
    };

    const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
    let targetScrollTop = 0;
    let middle = 0;
    if (${scenarioName} === 'bottom') {
      targetScrollTop = Math.round(maxScrollTop * 0.98);
    } else if (${scenarioName} === 'middle') {
      middle = Math.round(maxScrollTop * 0.5);
      targetScrollTop = middle;
    } else {
      middle = Math.round(maxScrollTop * 0.5);
      targetScrollTop = Math.round(maxScrollTop * 0.25);
    }

    const benchmarkWindow = window;
    const countInlineMathPlaceholdersForMetric = () =>
      typeof benchmarkWindow.__marivellGetInlineMathPlaceholderCountInViewport === 'function'
        ? benchmarkWindow.__marivellGetInlineMathPlaceholderCountInViewport() ?? 0
        : visibleInlineMathPlaceholderCount();
    if (typeof benchmarkWindow.__marivellClearFormulaHtmlCache === 'function') {
      benchmarkWindow.__marivellClearFormulaHtmlCache();
    }
    if (typeof benchmarkWindow.__marivellResetScrollAnchorCompensation === 'function') {
      benchmarkWindow.__marivellResetScrollAnchorCompensation();
    }
    if (typeof benchmarkWindow.__marivellResetInlineMathActivationMetrics === 'function') {
      benchmarkWindow.__marivellResetInlineMathActivationMetrics();
    }
    if (typeof benchmarkWindow.__marivellResetFormulaTemplateCacheStatsForTest === 'function') {
      benchmarkWindow.__marivellResetFormulaTemplateCacheStatsForTest();
    }
    const start = performance.now();

    // --- Diagnostic observers: longtask, layout-shift, mutation bursts ---
    const longTasks = [];
    let longTaskObserver = null;
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
            name: entry.name,
            attribution: (entry.attribution || []).map(
              (a) => {
                const attr = a;
                return {
                  name: attr.name,
                  containerType: attr.containerType,
                  containerSrc: attr.containerSrc,
                };
              },
            ) ?? [],
          });
        }
      });
      longTaskObserver.observe({ type: 'longtask' });
    } catch (_) { /* longtask not supported in this browser */ }

    const layoutShifts = [];
    let layoutShiftObserver = null;
    try {
      layoutShiftObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          layoutShifts.push({
            startTime: entry.startTime,
            value: entry.value ?? 0,
          });
        }
      });
      layoutShiftObserver.observe({ type: 'layout-shift' });
    } catch (_) { /* layout-shift not supported in this browser */ }

    const mutationBursts = [];
    const mutationObserverDiag = new MutationObserver((records) => {
      mutationBursts.push({ at: performance.now() - start, count: records.length });
    });
    mutationObserverDiag.observe(frame, { subtree: true, childList: true, attributes: true, characterData: true });
    // --- End diagnostic observers ---

    // --- Reset function timers for D10 attribution ---
    if (typeof benchmarkWindow.__marivellResetFunctionTimings === 'function') {
      benchmarkWindow.__marivellResetFunctionTimings();
    }

    if (typeof benchmarkWindow.__marivellResetHydrationSyncForTest === 'function') {
      benchmarkWindow.__marivellResetHydrationSyncForTest();
    }
    const beforeScrollTop = frame.scrollTop;
    if (${scenarioName} === 'drag') {
      frame.scrollTop = 0;
      frame.scrollTop = maxScrollTop;
      frame.scrollTop = targetScrollTop;
    } else {
      frame.scrollTop = 0;
      frame.scrollTop = targetScrollTop;
    }
    const afterAssignScrollTop = frame.scrollTop;
    const preDispatchInlinePlaceholders = countInlineMathPlaceholdersForMetric();
    const beforeTopAnchor = getTopAnchor();
    benchmarkWindow.__marivellBenchmarkTopAnchor = beforeTopAnchor;
    let inlineMathActivateReadyMs = null;
    let inlineMathPlaceholderFirstSeenAt = null;
    let inlineMathViewportKatexFirstSeenAt = null;
    let inlineMathViewportKatexReadyMs = null;
    let inlineMathViewportKatexMaxFrameMs = 0;
    let inlineMathViewportKatexCount = 0;
    let forceInlineActivated = 0;
    let afterForceInlinePlaceholders = preDispatchInlinePlaceholders;
    let forceInlineMs = 0;
    if (preDispatchInlinePlaceholders > 0) {
      inlineMathPlaceholderFirstSeenAt = performance.now();
    }
    const firstInlineFrame = new Promise((resolve) => requestAnimationFrame(resolve));
    const rAFBefore = performance.now();
    frame.dispatchEvent(new Event('scroll'));
    await firstInlineFrame;
    const frame1Now = performance.now();
    const frame1Ms = frame1Now - rAFBefore;
    const firstInlinePlaceholders = countInlineMathPlaceholdersForMetric();
    const firstViewportKatexStats = visibleInlineMathKatexStats();
    inlineMathViewportKatexCount = firstViewportKatexStats.total;
    if (firstViewportKatexStats.notRealKatex > 0) {
      inlineMathViewportKatexFirstSeenAt = performance.now();
    }
    if (
      preDispatchInlinePlaceholders > 0 &&
      firstInlinePlaceholders === 0 &&
      inlineMathPlaceholderFirstSeenAt !== null
    ) {
      inlineMathActivateReadyMs = performance.now() - inlineMathPlaceholderFirstSeenAt;
    }
    if (firstInlinePlaceholders > 0) {
      if (inlineMathPlaceholderFirstSeenAt === null) {
        inlineMathPlaceholderFirstSeenAt = performance.now();
      }
      if (typeof benchmarkWindow.__marivellForceInlineHydrateViewport === 'function') {
        const forceStart = performance.now();
        forceInlineActivated = benchmarkWindow.__marivellForceInlineHydrateViewport() ?? 0;
        forceInlineMs = performance.now() - forceStart;
        const forceInlineMetrics = benchmarkWindow.__marivellForceInlineHydrateMetrics;
        afterForceInlinePlaceholders = countInlineMathPlaceholdersForMetric();
        if (afterForceInlinePlaceholders === 0) {
          inlineMathActivateReadyMs = forceInlineMetrics?.hydrateMs ?? forceInlineMs;
        }
      }
    }
    const deadline = performance.now() + 15_000;
    const frameStamps = [];
    let frameStartTime = frame1Now;
    // Record the first rAF frame (from dispatch to firstInlineFrame resolution)
    frameStamps.push({ at: frame1Now - start, ms: frame1Ms });
    const waitForFrame = () => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const now = performance.now();
        frameStamps.push({ at: now - start, ms: now - frameStartTime });
        frameStartTime = now;
        resolve(undefined);
      }));
    });
    let firstFramePlaceholders = -1;
    let firstFramePlaceholderDetails = [];
    let timedOut = false;
    let placeholderReadyAt = null;
    let placeholderScanMs = 0;
    let inlinePlaceholderScanMs = 0;
    let placeholderScanCalls = 0;
    let inlinePlaceholderScanCalls = 0;
    while (true) {
      await waitForFrame();
      let __t0 = performance.now();
      const placeholders = visiblePlaceholderCount();
      placeholderScanMs += performance.now() - __t0;
      placeholderScanCalls += 1;
      __t0 = performance.now();
      const inlinePlaceholders = visibleInlineMathPlaceholderCount();
      inlinePlaceholderScanMs += performance.now() - __t0;
      inlinePlaceholderScanCalls += 1;
      if (inlinePlaceholders > 0 && inlineMathPlaceholderFirstSeenAt === null) {
        inlineMathPlaceholderFirstSeenAt = performance.now();
      }
      if (inlinePlaceholders === 0 && inlineMathPlaceholderFirstSeenAt !== null && inlineMathActivateReadyMs === null) {
        inlineMathActivateReadyMs = performance.now() - inlineMathPlaceholderFirstSeenAt;
      }
      if (firstFramePlaceholders === -1) {
        firstFramePlaceholders = placeholders;
        if (placeholders > 0) {
          firstFramePlaceholderDetails = Array.from(
            frame.querySelectorAll(
              placeholderSelectors.join(',') + ',.math-inline-node--placeholder',
            ),
          )
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              const frameRect = frame.getBoundingClientRect();
              return rect.bottom > frameRect.top && rect.top < frameRect.bottom;
            })
            .slice(0, 8)
            .map((element) => {
              const node = element.querySelector('.math-node-content');
              const text = node?.textContent?.slice(0, 40) ?? '';
              return (element.id || element.className) + (text ? '|' + text : '');
            });
        }
      }
      if (placeholders === 0 || performance.now() > deadline) {
        timedOut = placeholders !== 0;
        if (!timedOut) {
          placeholderReadyAt = performance.now();
        }
        break;
      }
    }

    const katexDeadline = performance.now() + 15_000;
    while (
      visibleInlineMathKatexStats().notRealKatex > 0 &&
      performance.now() < katexDeadline
    ) {
      const frameStart = performance.now();
      await waitForFrame();
      const frameMs = performance.now() - frameStart;
      const katexStats = visibleInlineMathKatexStats();
      inlineMathViewportKatexCount = katexStats.total;
      inlineMathViewportKatexMaxFrameMs = Math.max(
        inlineMathViewportKatexMaxFrameMs,
        frameMs,
      );
      if (inlineMathViewportKatexFirstSeenAt === null && katexStats.notRealKatex > 0) {
        inlineMathViewportKatexFirstSeenAt = performance.now();
      }
    }
    if (inlineMathViewportKatexFirstSeenAt !== null) {
      inlineMathViewportKatexReadyMs =
        performance.now() - inlineMathViewportKatexFirstSeenAt;
    } else {
      inlineMathViewportKatexReadyMs = 0;
    }

    for (let settleFrame = 0; settleFrame < 3; settleFrame += 1) {
      await waitForFrame();
    }
    const finalPlaceholderDetails = visiblePlaceholderCount() > 0
      ? Array.from(frame.querySelectorAll(placeholderSelectors.join(',')))
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            const frameRect = frame.getBoundingClientRect();
            return rect.bottom > frameRect.top && rect.top < frameRect.bottom;
          })
          .slice(0, 3)
          .map((element) => element.id || element.className)
      : [];
    const currentMaxScrollTop = Math.round(Math.max(frame.scrollHeight - frame.clientHeight, 0));
    const scrollTopDrift = Math.abs(frame.scrollTop - targetScrollTop);

    let inlineHeightDrift = 'n/a';
    let inlineHeightDriftNote = 'no visible paragraph or inline math anchor before jump';
    let inlineHeightAnchor = null;
    if (beforeTopAnchor) {
      inlineHeightAnchor = beforeTopAnchor.description;
      try {
        const frameRect = frame.getBoundingClientRect();
        const editor = window.__marivellEditor;
        const coords = editor?.view.coordsAtPos(beforeTopAnchor.pmPos);
        if (coords) {
          const afterRelativeTop = coords.top - frameRect.top;
          inlineHeightDrift = Math.abs(afterRelativeTop - beforeTopAnchor.relativeTop);
          const surfaceMargin = (frame.querySelector('.editor-surface .ProseMirror') ?? frame.querySelector('.editor-surface > .tiptap') ?? frame.querySelector('.editor-surface'))?.style?.marginTop ?? '';
          inlineHeightDriftNote = 'anchor=' + inlineHeightAnchor + ' before=' + Math.round(beforeTopAnchor.relativeTop * 10) / 10 + ' after=' + Math.round(afterRelativeTop * 10) / 10 + ' margin=' + surfaceMargin;
        } else {
          inlineHeightDriftNote = 'top anchor coords unavailable after hydration';
        }
      } catch {
        inlineHeightDriftNote = 'top anchor coords failed after hydration';
      }
    }

    const inlineMathActivateMaxFrameMs =
      benchmarkWindow.__marivellInlineMathActivationMaxFrameMs ?? 0;
    const instrumentedInlineMathReadyMs =
      benchmarkWindow.__marivellInlineMathActivationReadyMs ?? 0;
    const templateCacheStats =
      typeof benchmarkWindow.__marivellGetFormulaTemplateCacheStats === 'function'
        ? benchmarkWindow.__marivellGetFormulaTemplateCacheStats()
        : null;

    // Disconnect diagnostic observers
    mutationObserverDiag.disconnect();
    if (longTaskObserver) longTaskObserver.disconnect();
    if (layoutShiftObserver) layoutShiftObserver.disconnect();

    // Filter long tasks to only those after start
    const relevantLongTasks = longTasks.filter((t) => t.startTime >= start);

    return {
      jumpReadyMs: performance.now() - start,
      placeholderReadyMs:
        placeholderReadyAt === null
          ? performance.now() - start
          : placeholderReadyAt - start,
      settleOverheadMs:
        placeholderReadyAt === null
          ? 0
          : performance.now() - placeholderReadyAt,
      firstFramePlaceholders,
      finalPlaceholderCount: visiblePlaceholderCount(),
      scrollTopDrift,
      targetScrollTop,
      scrollHeight: frame.scrollHeight,
      beforeScrollTop,
      afterAssignScrollTop,
      finalScrollTop: frame.scrollTop,
      currentMaxScrollTop,
      timings: window.__marivellPhase4Timings ?? null,
      hydrateTimings: window.__marivellPhase4HydrateTimings ?? null,
      visibleFallbackTimings: window.__marivellVisibleFallbackTimings ?? null,
      placeholderDetails: firstFramePlaceholderDetails,
      firstFrameReady: firstFramePlaceholders === 0,
      inlineHeightDrift,
      inlineHeightDriftNote,
      inlineHeightAnchor,
      inlineMathActivateReadyMs:
        instrumentedInlineMathReadyMs > 0
          ? instrumentedInlineMathReadyMs
          : (inlineMathActivateReadyMs ?? 0),
      instrumentedInlineMathReadyMs,
      inlineMathActivateMaxFrameMs,
      inlineMathViewportKatexReadyMs:
        inlineMathViewportKatexReadyMs ?? 0,
      inlineMathViewportKatexMaxFrameMs,
      inlineMathViewportKatexCount,
      templateCacheHits: templateCacheStats?.hits ?? 0,
      templateCacheMisses: templateCacheStats?.misses ?? 0,
      templateBytes: templateCacheStats?.bytes ?? 0,
      katexInjectP50Ms: templateCacheStats?.injectP50Ms ?? 0,
      katexInjectP95Ms: templateCacheStats?.injectP95Ms ?? 0,
      katexInjectMaxMs: templateCacheStats?.injectMaxMs ?? 0,
      preDispatchInlinePlaceholders,
      firstInlinePlaceholders,
      afterForceInlinePlaceholders,
      forceInlineActivated,
      forceInlineMs,
      activateProfile: window.__marivellHydrateActivateProfile ?? [],
      placeholderScanMs,
      inlinePlaceholderScanMs,
      placeholderScanCalls,
      inlinePlaceholderScanCalls,
      settleScanDiagnostics: window.__marivellSettleScanDiagnostics ?? null,
      lateStabilizationDiagnostics: window.__marivellLateAnchorStabilizationDiagnostics ?? null,
      longTasks: relevantLongTasks,
      frameStamps,
      layoutShifts,
      mutationBursts,
      functionCosts: typeof benchmarkWindow.__marivellFunctionTimings === 'function' ? benchmarkWindow.__marivellFunctionTimings() : null,
      timedOut,
    };
  })()`;
  return page.evaluate(script) as Promise<{
    jumpReadyMs: number;
    placeholderReadyMs: number;
    settleOverheadMs: number;
    firstFramePlaceholders: number;
    finalPlaceholderCount: number;
    scrollTopDrift: number;
    targetScrollTop: number;
    scrollHeight: number;
    visibleFallbackTimings: Record<string, unknown> | null;
    firstFrameReady: boolean;
    inlineHeightDrift: number | 'n/a';
    inlineHeightDriftNote: string;
    inlineHeightAnchor: string | null;
    inlineMathActivateReadyMs: number;
    instrumentedInlineMathReadyMs: number;
    inlineMathActivateMaxFrameMs: number;
    inlineMathViewportKatexReadyMs: number;
    inlineMathViewportKatexMaxFrameMs: number;
    inlineMathViewportKatexCount: number;
    templateCacheHits: number;
    templateCacheMisses: number;
    templateBytes: number;
    katexInjectP50Ms: number;
    katexInjectP95Ms: number;
    katexInjectMaxMs: number;
    preDispatchInlinePlaceholders: number;
    firstInlinePlaceholders: number;
    afterForceInlinePlaceholders: number;
    forceInlineActivated: number;
    forceInlineMs: number;
    activateProfile: Array<{ id: string; nodeType?: string; ms: number }>;
    placeholderScanMs: number;
    inlinePlaceholderScanMs: number;
    placeholderScanCalls: number;
    inlinePlaceholderScanCalls: number;
    settleScanDiagnostics: Record<string, unknown> | null;
    lateStabilizationDiagnostics: Record<string, unknown> | null;
    longTasks: Array<{ startTime: number; duration: number; name: string; attribution: unknown[] }>;
    frameStamps: Array<{ at: number; ms: number }>;
    layoutShifts: Array<{ startTime: number; value: number }>;
    mutationBursts: Array<{ at: number; count: number }>;
    timedOut: boolean;
  }>;
}

async function measureVisualContextMenu(page: Page): Promise<{
  contextMenuMs: number;
  visible: boolean;
}> {
  const result = await page.evaluate(async () => {
    const target =
      document.querySelector<HTMLElement>('.editor-frame') ??
      document.querySelector<HTMLElement>('.editor-surface');
    if (!target) throw new Error('editor target missing');
    const rect = target.getBoundingClientRect();
    const x = rect.left + Math.min(320, Math.max(120, rect.width / 2));
    const y = rect.top + Math.min(260, Math.max(120, rect.height / 2));
    const start = performance.now();
    target.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 2,
      }),
    );
    while (
      !document.querySelector('.context-menu') &&
      performance.now() - start < 30_000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const contextMenuMs = performance.now() - start;
    const visible = Boolean(document.querySelector('.context-menu'));
    return { contextMenuMs, visible };
  });
  if (result.visible) {
    await page.keyboard.press('Escape').catch(() => {});
  }
  return result;
}

function countNodePipelineMetrics(content: any): {
  formulaHtmlUnique: number;
  imageNodeCount: number;
  mermaidNodeCount: number;
} {
  const formulaKeys = new Set<string>();
  let imageNodeCount = 0;
  let mermaidNodeCount = 0;

  const visit = (node: any): void => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (node.type === 'inlineMath') {
      const display = node.attrs?.display === 'yes' ? 'yes' : 'no';
      const latex =
        typeof node.attrs?.latex === 'string'
          ? node.attrs.latex
          : Array.isArray(node.content)
            ? node.content
                .map((child: any) => (typeof child.text === 'string' ? child.text : ''))
                .join('')
            : '';
      formulaKeys.add(`${display}\u0000${latex}`);
    } else if (node.type === 'image') {
      imageNodeCount += 1;
    } else if (node.type === 'mermaidBlock') {
      mermaidNodeCount += 1;
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        visit(child);
      }
    }
  };

  visit(content);
  return {
    formulaHtmlUnique: formulaKeys.size,
    imageNodeCount,
    mermaidNodeCount,
  };
}

async function measureNodePipeline(markdownPath: string): Promise<ReportEntry[]> {
  const [{ parseMarkdown, serializeMarkdown }, { highlightMarkdownSource }, { extractOutline }] =
    await Promise.all([
      import('../../src/renderer/editor/markdown.ts'),
      import('../../src/renderer/editor/markdown-highlight.ts'),
      import('../../src/renderer/utils/document.ts'),
    ]);

  const source = fs.readFileSync(markdownPath, 'utf8');
  parseMarkdown('');
  const sourceBytes = Buffer.byteLength(source);
  const lines = source.split('\n').length;
  const blockFormulaCount =
    (source.match(/^\$\$/gm) ?? []).length + (source.match(/^\\\[/gm) ?? []).length;
  const inlineFormulaEstimate = (source.match(/\$[^$\n]+\$/g) ?? []).length;

  const parseStart = performance.now();
  const json = parseMarkdown(source);
  const parseMs = performance.now() - parseStart;

  const serializeStart = performance.now();
  const markdown = serializeMarkdown(json);
  const serializeMs = performance.now() - serializeStart;

  const highlightStart = performance.now();
  const highlightHtml = highlightMarkdownSource(source);
  const highlightMs = performance.now() - highlightStart;

  const outlineStart = performance.now();
  const outline = extractOutline(source);
  const outlineMs = performance.now() - outlineStart;
  const nodeMetrics = countNodePipelineMetrics(json);

  return [
    { metric: 'source-size', value: sourceBytes, unit: 'bytes' },
    { metric: 'source-lines', value: lines, unit: 'lines' },
    { metric: 'markdown-parse', value: round(parseMs), unit: 'ms' },
    { metric: 'markdown-serialize', value: round(serializeMs), unit: 'ms' },
    { metric: 'source-highlight', value: round(highlightMs), unit: 'ms' },
    { metric: 'outline-extract', value: round(outlineMs), unit: 'ms' },
    { metric: 'block-formula-count', value: blockFormulaCount, unit: 'blocks' },
    { metric: 'inline-formula-estimate', value: inlineFormulaEstimate, unit: 'inline' },
    { metric: 'heading-count', value: outline.length, unit: 'headings' },
    { metric: 'formula-html-unique', value: nodeMetrics.formulaHtmlUnique, unit: 'unique' },
    { metric: 'image-node-count', value: nodeMetrics.imageNodeCount, unit: 'nodes' },
    { metric: 'mermaid-node-count', value: nodeMetrics.mermaidNodeCount, unit: 'nodes' },
  ];
}

const BUDGET_METRIC_ALIASES: Record<string, string[]> = {
  visualOpenMs: ['visual-open'],
  rendererReadyMs: ['renderer-render-to-ready'],
  typingMs: ['interaction-typing'],
  interactionCombinedMs: ['interaction-combined'],
  modeSwitchSourceToVisualMs: ['mode-switch-source-to-visual-ms'],
  modeSwitchVisualToSourceMs: ['mode-switch-visual-to-source-ms'],
  scrollAvgFrameMs: ['scroll-avg-frame'],
  scrollMaxFrameMs: ['scroll-max-frame'],
  inlineMathActivateReadyMs: ['inline-math-activate-ready-ms'],
};

function readPerfBudget(): Record<string, number> {
  const budgetPath = path.join(projectRoot, 'perf-budget.json');
  const parsed = JSON.parse(fs.readFileSync(budgetPath, 'utf8')) as Record<string, unknown>;
  const budget: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`perf-budget.json key ${key} must be a finite number`);
    }
    budget[key] = value;
  }
  return budget;
}

function compareToBudget(
  report: ReportEntry[],
  budget: Record<string, number>,
): Record<string, BudgetComparisonEntry> {
  const scenarios = ['scroll-jump-bottom', 'scroll-jump-middle', 'scroll-drag-sequence'];
  const result: Record<string, BudgetComparisonEntry> = {};

  const firstValue = (metrics: string[]): MeasuredValue => {
    for (const metric of metrics) {
      const entry = report.find((item) => item.metric === metric);
      if (entry) {
        return entry.value;
      }
    }
    return null;
  };

  const worstJumpValue = (suffix: string): MeasuredValue => {
    const values: MeasuredValue[] = [];
    for (const scenario of scenarios) {
      const entry = report.find((item) => item.metric === `${scenario}-${suffix}`);
      values.push(entry ? entry.value : null);
    }
    if (values.some((value) => value === null || value === 'n/a' || value === 'timeout')) {
      return 'n/a';
    }
    const numericValues = values.filter((value): value is number => typeof value === 'number');
    return numericValues.length > 0 ? Math.max(...numericValues) : 'n/a';
  };

  const statusFor = (measured: MeasuredValue, budgetValue: number): BudgetComparisonEntry['status'] => {
    if (measured === null || measured === 'n/a' || measured === 'timeout') {
      return 'not-measured';
    }
    if (typeof measured !== 'number') {
      return 'not-measured';
    }
    return measured <= budgetValue ? 'pass' : 'fail';
  };

  const scenarioBreakdown = (suffix: string): string => {
    return scenarios
      .map((scenario) => {
        const entry = report.find((item) => item.metric === `${scenario}-${suffix}`);
        return `${scenario}=${entry ? entry.value : 'missing'}`;
      })
      .join(' ');
  };

  for (const [key, budgetValue] of Object.entries(budget)) {
    let measured: MeasuredValue = null;
    let note: string | undefined;

    if (key === 'scrollJumpReadyMs') {
      measured = worstJumpValue('jump-ready-ms');
      note = scenarioBreakdown('jump-ready-ms');
    } else if (key === 'scrollDriftPx') {
      measured = worstJumpValue('drift');
      note = scenarioBreakdown('drift');
    } else if (key === 'viewportPlaceholders') {
      measured = worstJumpValue('first-frame-placeholders');
      note = scenarioBreakdown('first-frame-placeholders');
    } else if (BUDGET_METRIC_ALIASES[key]) {
      measured = firstValue(BUDGET_METRIC_ALIASES[key]);
    } else {
      measured = firstValue([key]);
    }

    const status = statusFor(measured, budgetValue);
    if (status === 'not-measured') {
      note = note ? `${note}; not-measured` : 'not-measured';
    }
    result[key] = {
      budget: budgetValue,
      measured,
      status,
      note,
    };
  }

  return result;
}

function formatBudgetComparison(budget: Record<string, BudgetComparisonEntry>): string {
  const width = Math.max(...Object.keys(budget).map((key) => key.length), 10);
  return Object.entries(budget)
    .map(([key, entry]) => {
      const measured = entry.measured === null ? 'not-measured' : String(entry.measured);
      return `  ${key.padEnd(width)}  ${measured.padStart(10)}  ${entry.status.padEnd(12)}  budget=${entry.budget}${
        entry.note ? `  (${entry.note})` : ''
      }`;
    })
    .join('\n');
}

async function measureDomSnapshot(page: Page): Promise<ReportEntry[]> {
  const snapshot = await page.evaluate(() => {
    const inlineMathNodes = Array.from(document.querySelectorAll<HTMLElement>('.math-inline-node'));
    const inlineMathPreviewActive = inlineMathNodes.filter((node) =>
      node.querySelector('.math-node-preview .katex'),
    ).length;
    const inlineMathPreviewPlaceholder = inlineMathNodes.filter((node) => {
      if (node.classList.contains('math-inline-node--placeholder')) {
        return true;
      }
      const preview = node.querySelector(':scope > .math-node-preview');
      if (!preview) {
        return true;
      }
      if (preview.querySelector('.katex')) {
        return false;
      }
      if (preview.querySelector('.katex-error')) {
        return false;
      }
      const hasCurrentActiveHint = preview.querySelector(
        '.math-node-empty-hint, .math-node-placeholder-hint',
      );
      if (hasCurrentActiveHint !== null) {
        return false;
      }
      const hasDirectErrorText = Array.from(preview.childNodes).some(
        (child) => child.nodeType === Node.TEXT_NODE && Boolean(child.textContent?.trim()),
      );
      return !hasDirectErrorText;
    }).length;
    const syntaxSpanElements = Array.from(
      document.querySelectorAll<HTMLElement>('[class*="math-syntax-"]'),
    );
    const syntaxDiagnostics = (
      window as unknown as Record<string, unknown>
    ).__marivellMathSyntaxDiagnostics as
      | { fullBuildCount: number; localBuildCount: number; spanCount: number }
      | undefined;
    return {
      documentDomNodeCount: document.querySelectorAll('*').length,
      paragraphNodeCount: document.querySelectorAll('.editor-surface p').length,
      katexNodeCount: document.querySelectorAll('.math-node-preview .katex').length,
      inlineMathNodeCount: inlineMathNodes.length,
      inlineMathPreviewActive,
      inlineMathPreviewPlaceholder,
      syntaxDecorationSpanCount: syntaxSpanElements.length,
      syntaxDecorationFullBuildCount: syntaxDiagnostics?.fullBuildCount ?? 0,
      syntaxDecorationLocalBuildCount: syntaxDiagnostics?.localBuildCount ?? 0,
    };
  });

  return [
    {
      metric: 'document-dom-node-count',
      value: snapshot.documentDomNodeCount,
      unit: 'nodes',
      note: 'document.querySelectorAll(*) count',
    },
    {
      metric: 'syntax-decoration-span-count',
      value: snapshot.syntaxDecorationSpanCount,
      unit: 'nodes',
      note: '.math-syntax-* decoration span count',
    },
    {
      metric: 'syntax-decoration-full-build-count',
      value: snapshot.syntaxDecorationFullBuildCount,
      unit: 'builds',
      note: 'MathSyntaxHighlight full-document decoration builds',
    },
    {
      metric: 'syntax-decoration-local-build-count',
      value: snapshot.syntaxDecorationLocalBuildCount,
      unit: 'builds',
      note: 'MathSyntaxHighlight local decoration builds',
    },
    {
      metric: 'paragraph-node-count',
      value: snapshot.paragraphNodeCount,
      unit: 'nodes',
      note: '.editor-surface p count',
    },
    {
      metric: 'katex-node-count',
      value: snapshot.katexNodeCount,
      unit: 'nodes',
      note: '.math-node-preview .katex count',
    },
    {
      metric: 'inline-math-node-count',
      value: snapshot.inlineMathNodeCount,
      unit: 'nodes',
      note: '.math-inline-node count',
    },
    {
      metric: 'inline-math-preview-active',
      value: snapshot.inlineMathPreviewActive,
      unit: 'nodes',
      note: '.math-inline-node with rendered .math-node-preview .katex',
    },
    {
      metric: 'inline-math-preview-placeholder',
      value: snapshot.inlineMathPreviewPlaceholder,
      unit: 'nodes',
      note: 'contract: .math-inline-node--placeholder or preview without .katex (current hint/error text previews are not placeholder state)',
    },
  ];
}

async function measureVisualHostDomSnapshot(page: Page): Promise<ReportEntry[]> {
  const snapshot = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.editor-host');
    if (!host) {
      return null;
    }
    const all = Array.from(host.querySelectorAll('*'));
    const tags: Record<string, number> = {};
    const classes: Record<string, number> = {};
    const classNames = [
      'math-inline-node',
      'math-block-node',
      'math-node-content',
      'math-node-preview',
      'math-inline-node--placeholder',
      'math-block-node-placeholder',
      'katex',
      'math-syntax-cmd',
      'math-syntax-brace',
      'math-syntax-special',
      'math-syntax-comment',
      'image-node',
      'code-block-node',
      'mermaid-node',
    ];
    for (const element of all) {
      const tag = element.tagName.toLowerCase();
      tags[tag] = (tags[tag] ?? 0) + 1;
      for (const className of classNames) {
        if (element.classList.contains(className)) {
          classes[className] = (classes[className] ?? 0) + 1;
        }
      }
    }
    let textNodes = 0;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      textNodes += 1;
    }
    const inlineMathNodes = Array.from(host.querySelectorAll<HTMLElement>('.math-inline-node'));
    const inlinePreviewActive = inlineMathNodes.filter((node) =>
      node.querySelector(':scope > .math-node-preview .katex'),
    ).length;
    const inlinePreviewPlaceholder = inlineMathNodes.filter((node) =>
      node.classList.contains('math-inline-node--placeholder'),
    ).length;
    return {
      elements: all.length,
      textNodes,
      tags,
      classes,
      inlineMathNodeCount: inlineMathNodes.length,
      inlinePreviewActive,
      inlinePreviewPlaceholder,
      katexCount: host.querySelectorAll('.math-node-preview .katex').length,
      syntaxCount: host.querySelectorAll('[class*="math-syntax-"]').length,
      display: host.style.display,
      visibility: host.style.visibility,
    };
  });
  if (!snapshot) {
    return [
      {
        metric: 'mode-switch-source-host-dom-count',
        value: 'missing',
        unit: 'nodes',
        note: '.editor-host not found',
      },
    ];
  }
  return [
    {
      metric: 'mode-switch-source-host-dom-count',
      value: snapshot.elements,
      unit: 'nodes',
      note: `.editor-host subtree; display=${snapshot.display}; visibility=${snapshot.visibility}`,
    },
    {
      metric: 'mode-switch-source-host-text-node-count',
      value: snapshot.textNodes,
      unit: 'nodes',
    },
    {
      metric: 'mode-switch-source-host-tags',
      value: JSON.stringify(snapshot.tags),
      unit: 'json',
    },
    {
      metric: 'mode-switch-source-host-classes',
      value: JSON.stringify(snapshot.classes),
      unit: 'json',
    },
    {
      metric: 'mode-switch-source-host-inline-active',
      value: snapshot.inlinePreviewActive,
      unit: 'nodes',
      note: '.math-inline-node with rendered .katex',
    },
    {
      metric: 'mode-switch-source-host-inline-placeholder',
      value: snapshot.inlinePreviewPlaceholder,
      unit: 'nodes',
      note: '.math-inline-node--placeholder',
    },
    {
      metric: 'mode-switch-source-host-katex-count',
      value: snapshot.katexCount,
      unit: 'nodes',
    },
    {
      metric: 'mode-switch-source-host-syntax-span-count',
      value: snapshot.syntaxCount,
      unit: 'nodes',
    },
  ];
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatEntries(entries: ReportEntry[]): string {
  const width = Math.max(...entries.map((entry) => entry.metric.length), 10);
  return entries
    .map(
      (entry) =>
        `  ${entry.metric.padEnd(width)}  ${String(entry.value).padStart(10)} ${entry.unit}${
          entry.note ? `  (${entry.note})` : ''
        }`,
    )
    .join('\n');
}

async function runBenchmark(): Promise<void> {
  const markdownPath = process.argv[2] || defaultMarkdownPath;
  if (!fs.existsSync(markdownPath)) {
    throw new Error(`benchmark markdown not found: ${markdownPath}`);
  }

  const outDir = path.join(os.tmpdir(), `marivell-perf-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-perf-profile-${process.pid}`);
  const port = 9300 + (process.pid % 300);
  const sourceSize = fs.statSync(markdownPath).size;
  const expectedVisualTextLength = Math.min(Math.max(sourceSize * 0.5, 1_000), 500_000);
  const expectedSourceTextLength = Math.max(sourceSize * 0.5, 1_000);
  const openTimeoutMs = Number(process.env.MARIVELL_BENCHMARK_OPEN_TIMEOUT_MS ?? 30_000);
  const interactionTimeoutMs = Number(process.env.MARIVELL_BENCHMARK_INTERACTION_TIMEOUT_MS ?? 15_000);
  const suiteTimeoutMs = Number(process.env.MARIVELL_BENCHMARK_SUITE_TIMEOUT_MS ?? 90_000);
  const modeSwitchTimeoutMs = Number(
    process.env.MARIVELL_BENCHMARK_MODE_SWITCH_TIMEOUT_MS ??
      Math.max(openTimeoutMs, 60_000),
  );
  const ioObservationLimit = Number(
    process.env.MARIVELL_IO_OBSERVATION_LIMIT ?? 1000,
  );

  console.log('Building benchmark bundle (no install needed)...');
  await buildRenderer(outDir);
  console.log('Launching Electron in visual/render mode...');

  const handle = await launchElectron(outDir, markdownPath, port, profile);
  const report: ReportEntry[] = [];
  const perfBudget = readPerfBudget();
  const spawnWallStart = handle.spawnedAt;
  report.push({
    metric: 'exclusive-run',
    value: true,
    unit: 'bool',
    note: 'lock acquired and no marivell temp Electron/POC process detected',
  });

  try {
    const ready = await withTimeout(
      waitForVisualReady(handle.page, expectedVisualTextLength, openTimeoutMs),
      openTimeoutMs,
      'visual-open',
    );
    if (!ready.ok) {
      report.push({
        metric: 'visual-open',
        value: 'timeout',
        unit: `${openTimeoutMs}ms`,
      });
    } else {
      const timeline = await getTimeline(handle.page);
      const find = (name: string) => timeline.find((entry) => entry.name === name)?.value;
      const openStart = find('document-open-main-start');
      const readEnd = find('document-read-end');
      const sentAt = find('document-open-sent');
      const readyAt = find('visual-editor-ready');
      report.push(
        {
          metric: 'visual-open',
          value: ready.value.waitMs,
          unit: 'ms',
          note: 'DOM ready after launch',
        },
        {
          metric: 'app-to-open-start',
          value: openStart ? openStart - spawnWallStart : 'n/a',
          unit: 'ms',
        },
        {
          metric: 'main-read-file',
          value: openStart && readEnd ? readEnd - openStart : 'n/a',
          unit: 'ms',
        },
        {
          metric: 'renderer-render-to-ready',
          value: sentAt && readyAt ? readyAt - sentAt : 'n/a',
          unit: 'ms',
        },
        {
          metric: 'open-total',
          value: openStart && readyAt ? readyAt - openStart : 'n/a',
          unit: 'ms',
        },
        {
          metric: 'visual-dom-text',
          value: ready.value.textLength,
          unit: 'chars',
        },
        {
          metric: 'visual-dom-height',
          value: ready.value.scrollHeight,
          unit: 'px',
        },
      );
      report.push(...(await measureDomSnapshot(handle.page)));
      report.push(...(await measureNodePipeline(markdownPath)));

      const suite = await withTimeout(
        runVisualInteractionSuite(handle.page),
        suiteTimeoutMs,
        'interaction-suite',
      );
      if (suite.ok) {
        for (const [name, result] of Object.entries(suite.value)) {
          report.push({
            metric: `interaction-${name}`,
            value: round(result.ms),
            unit: 'ms',
            note: result.error ? `error: ${result.error}` : result.applied ? 'applied' : 'not-applied',
          });
          if (result.detail) {
            report.push({
              metric: `interaction-${name}-detail`,
              value: result.detail,
              unit: 'json',
            });
            if (name === 'typing') {
              const parsed = JSON.parse(result.detail) as {
                dispatchMs: number;
                rafMs: number;
              };
              report.push({
                metric: 'interaction-typing-dispatch-ms',
                value: round(parsed.dispatchMs),
                unit: 'ms',
                note: 'focus+insertContent dispatch inside the main typing timer; selection is also inside the main timer',
              });
              report.push({
                metric: 'interaction-typing-raf-overhead-ms',
                value: round(parsed.rafMs),
                unit: 'ms',
                note: 'two animation frames waited after dispatch',
              });
            }
          }
        }
      } else {
        report.push({ metric: 'interaction-suite', value: 'timeout', unit: `${suiteTimeoutMs}ms` });
      }

      const modeSwitchSteps: Array<{
        metric: string;
        targetMode: 'source' | 'visual';
        expectedTextLength: number;
      }> = [
        {
          metric: 'mode-switch-visual-to-source-ms',
          targetMode: 'source',
          expectedTextLength: expectedSourceTextLength,
        },
        {
          metric: 'mode-switch-source-to-visual-ms',
          targetMode: 'visual',
          expectedTextLength: expectedVisualTextLength,
        },
      ];
      for (const modeStep of modeSwitchSteps) {
        const countersBefore =
          modeStep.targetMode === 'visual'
            ? await handle.page.evaluate(() => {
                const target = window as unknown as Record<string, number | undefined>;
                return {
                  fast: target.__marivellModeSwitchFastPath ?? 0,
                  full: target.__marivellModeSwitchFullParse ?? 0,
                };
              })
            : null;
        const switchResult = await withTimeout(
          measureModeSwitch(
            handle.page,
            modeStep.targetMode,
            modeStep.expectedTextLength,
            modeSwitchTimeoutMs,
          ),
          modeSwitchTimeoutMs,
          modeStep.metric,
        );
        if (switchResult.ok && !switchResult.value.timedOut) {
          report.push({
            metric: modeStep.metric,
            value: round(switchResult.value.switchMs),
            unit: 'ms',
            note: switchResult.value.note,
          });
          if (typeof switchResult.value.widthBucketCalls === 'number') {
            report.push({
              metric: `${modeStep.metric}-width-bucket-calls`,
              value: switchResult.value.widthBucketCalls,
              unit: 'calls',
            });
          }
          if (typeof switchResult.value.widthBucketLayoutReads === 'number') {
            report.push({
              metric: `${modeStep.metric}-width-bucket-layout-reads`,
              value: switchResult.value.widthBucketLayoutReads,
              unit: 'reads',
            });
          }
          if (typeof switchResult.value.hydrateTargetRangeCalls === 'number') {
            report.push({
              metric: `${modeStep.metric}-hydrate-target-range-calls`,
              value: switchResult.value.hydrateTargetRangeCalls,
              unit: 'calls',
            });
          }
        } else {
          report.push({
            metric: modeStep.metric,
            value: 'timeout',
            unit: `${modeSwitchTimeoutMs}ms`,
            note: switchResult.ok ? switchResult.value.note : undefined,
          });
        }

        if (modeStep.targetMode === 'source') {
          report.push(...(await measureVisualHostDomSnapshot(handle.page)));
        }

        if (modeStep.targetMode === 'visual') {
          const countersAfter = await handle.page.evaluate(() => {
            const target = window as unknown as Record<string, number | undefined>;
            return {
              fast: target.__marivellModeSwitchFastPath ?? 0,
              full: target.__marivellModeSwitchFullParse ?? 0,
            };
          });
          const fastDelta =
            countersAfter.fast - (countersBefore?.fast ?? 0);
          const fullDelta =
            countersAfter.full - (countersBefore?.full ?? 0);
          const noReparse = fastDelta > 0 && fullDelta === 0;
          report.push(
            {
              metric: 'mode-switch-no-reparse',
              value: noReparse,
              unit: 'boolean',
              note: `fast-path=${fastDelta} full-parse=${fullDelta}`,
            },
            {
              metric: 'mode-switch-source-to-visual-no-reparse',
              value: noReparse,
              unit: 'boolean',
              note: `fast-path=${fastDelta} full-parse=${fullDelta}`,
            },
          );
        }
      }

      const edit = await withTimeout(measureVisualEdit(handle.page), interactionTimeoutMs, 'visual-edit');
      report.push(
        edit.ok
          ? {
              metric: 'visual-edit',
              value: round(edit.value.editMs),
              unit: 'ms',
              note: edit.value.applied ? 'applied' : 'not-applied',
            }
          : { metric: 'visual-edit', value: 'timeout', unit: `${interactionTimeoutMs}ms` },
      );

      const formulaUniqueEntry = report.find((item) => item.metric === 'formula-html-unique');
      const formulaUnique = typeof formulaUniqueEntry?.value === 'number' ? formulaUniqueEntry.value : 0;
      await handle.page
        .waitForFunction(
          (count) => (window.__marivellNodeHeightCacheSize ?? 0) >= count,
          formulaUnique,
          { timeout: 60_000 },
        )
        .catch(() => {});
      const heightStats = await handle.page.evaluate(() => {
        const target = window as unknown as Record<string, unknown>;
        const cache = target.__marivellGetNodeHeightCacheStats?.() ?? null;
        const inline = target.__marivellGetInlineMathHeightPrefetchStats?.() ?? null;
        const formulaChunks = target.__marivellFormulaChunkDiagnostics
          ? { ...(target.__marivellFormulaChunkDiagnostics as Record<string, number>) }
          : null;
        return { cache, inline, formulaChunks };
      });
      const cacheSize =
        typeof heightStats.cache?.size === 'number'
          ? heightStats.cache.size
          : ((await handle.page.evaluate(
              () => (window.__marivellNodeHeightCacheSize ?? 0) as number,
            )) as number);
      report.push(
        {
          metric: 'height-cache-size',
          value: cacheSize,
          unit: 'unique',
        },
        {
          metric: 'height-cache-coverage',
          value:
            formulaUnique > 0
              ? round((cacheSize / formulaUnique) * 100)
              : 0,
          unit: 'percent',
          note: `unique=${formulaUnique}`,
        },
        {
          metric: 'inline-height-prefetch-pending',
          value: heightStats.inline?.pendingHeightMeasurements ?? 0,
          unit: 'keys',
        },
        {
          metric: 'formula-html-prefetched',
          value: heightStats.inline?.preparedFormulaHtml ?? 0,
          unit: 'keys',
        },
        {
          metric: 'formula-chunk-process-runs',
          value: heightStats.formulaChunks?.processRuns ?? 0,
          unit: 'runs',
        },
        {
          metric: 'formula-chunk-process-ms',
          value: heightStats.formulaChunks?.processMs
            ? round(heightStats.formulaChunks.processMs)
            : 0,
          unit: 'ms',
        },
      );

      await handle.page.evaluate(() => {
        const benchmarkWindow = window as unknown as Record<string, unknown>;
        if (typeof benchmarkWindow.__marivellResetScrollAnchorCompensation === 'function') {
          benchmarkWindow.__marivellResetScrollAnchorCompensation();
        }
      });
      await handle.page.evaluate(
        (limit) => {
          const benchmarkWindow = window as unknown as Record<string, unknown>;
          if (typeof benchmarkWindow.__marivellSetIoObservationLimit === 'function') {
            (benchmarkWindow.__marivellSetIoObservationLimit as (value: number) => void)(
              limit,
            );
          }
        },
        ioObservationLimit,
      );
      report.push({
        metric: 'scroll-io-observation-limit',
        value: ioObservationLimit,
        unit: 'nodes',
      });
      const scroll = await withTimeout(measureVisualScroll(handle.page), interactionTimeoutMs, 'visual-scroll');
      report.push(
        scroll.ok
          ? {
              metric: 'scroll-response',
              value:
                scroll.value.scrollResponseMs === null
                  ? 'n/a'
                  : round(scroll.value.scrollResponseMs),
              unit: 'ms',
            }
          : { metric: 'scroll-response', value: 'timeout', unit: `${interactionTimeoutMs}ms` },
        scroll.ok
          ? {
              metric: 'scroll-avg-frame',
              value:
                scroll.value.avgFrameMs === null ? 'n/a' : round(scroll.value.avgFrameMs),
              unit: 'ms',
            }
          : { metric: 'scroll-avg-frame', value: 'timeout', unit: `${interactionTimeoutMs}ms` },
        scroll.ok
          ? {
              metric: 'scroll-max-frame',
              value: scroll.value.maxFrameMs === null ? 'n/a' : round(scroll.value.maxFrameMs),
              unit: 'ms',
            }
          : { metric: 'scroll-max-frame', value: 'timeout', unit: `${interactionTimeoutMs}ms` },
      );

      if (scroll.ok) {
        const sum = (values: number[]): number =>
          values.reduce((total, value) => total + value, 0);
        report.push(
          {
            metric: 'scroll-frame-dom-mutations',
            value: sum(scroll.value.scrollFrameDomMutations),
            unit: 'mutations',
            note: `per-frame=${JSON.stringify(scroll.value.scrollFrameDomMutations)}`,
          },
          {
            metric: 'scroll-frame-rect-reads',
            value: sum(scroll.value.scrollFrameRectReads),
            unit: 'reads',
            note: `per-frame=${JSON.stringify(scroll.value.scrollFrameRectReads)}`,
          },
          {
            metric: 'scroll-frame-posatcoords',
            value: sum(scroll.value.scrollFramePosAtCoordsCalls),
            unit: 'calls',
            note: `per-frame=${JSON.stringify(scroll.value.scrollFramePosAtCoordsCalls)}`,
          },
        );
      }

      const scrollIoOverhead = await withTimeout(
        measureScrollIoOverhead(handle.page),
        Math.max(interactionTimeoutMs * 2, 30_000),
        'scroll-io-overhead',
      );
      if (scrollIoOverhead.ok) {
        const io = scrollIoOverhead.value;
        report.push(
          {
            metric: 'scroll-io-overhead-on-avg-frame-ms',
            value: round(io.on.avgFrameMs),
            unit: 'ms',
            note: `frames=300 entries=${io.on.callbackEntries} enqueued=${io.on.enqueuedEntries} observed=${io.on.observedCount} observers=${io.on.observerCount} callbackMaxMs=${round(io.on.callbackMsMax)}`,
          },
          {
            metric: 'scroll-io-overhead-on-p95-frame-ms',
            value: round(io.on.p95FrameMs),
            unit: 'ms',
          },
          {
            metric: 'scroll-io-overhead-on-max-frame-ms',
            value: round(io.on.maxFrameMs),
            unit: 'ms',
          },
          {
            metric: 'scroll-io-overhead-off-avg-frame-ms',
            value: round(io.off.avgFrameMs),
            unit: 'ms',
            note: `frames=300 entries=${io.off.callbackEntries} enqueued=${io.off.enqueuedEntries} observed=${io.off.observedCount}`,
          },
          {
            metric: 'scroll-io-overhead-off-p95-frame-ms',
            value: round(io.off.p95FrameMs),
            unit: 'ms',
          },
          {
            metric: 'scroll-io-overhead-off-max-frame-ms',
            value: round(io.off.maxFrameMs),
            unit: 'ms',
          },
          {
            metric: 'scroll-io-overhead-delta-avg-ms',
            value: round(io.deltaAvgFrameMs),
            unit: 'ms',
            note: 'positive means IO on is slower',
          },
          {
            metric: 'scroll-io-observer-count',
            value: io.on.observerCount,
            unit: 'observers',
            note: `on=${io.on.observerCount} off=${io.off.observerCount}`,
          },
        );
      } else {
        report.push({
          metric: 'scroll-io-overhead',
          value: 'timeout',
          unit: `${Math.max(interactionTimeoutMs * 2, 30_000)}ms`,
        });
      }

      const scrollFirstFrameReady: Record<string, boolean> = {};
      const inlineHeightDrifts: Record<string, number | 'n/a'> = {};
      const inlineMathActivateReady: number[] = [];
      const inlineMathActivateMaxFrame: number[] = [];
      const inlineMathViewportKatexReady: number[] = [];
      const inlineMathViewportKatexMaxFrame: number[] = [];
      const inlineMathViewportKatexCounts: number[] = [];
      const templateCacheHits: number[] = [];
      const templateCacheMisses: number[] = [];
      const templateBytes: number[] = [];
      const katexInjectP50Ms: number[] = [];
      const katexInjectP95Ms: number[] = [];
      const katexInjectMaxMs: number[] = [];
      const scrollJumpScenarios: Array<{ metric: string; scenario: ScrollJumpScenario }> = [
        { metric: 'scroll-jump-bottom', scenario: 'bottom' },
        { metric: 'scroll-jump-middle', scenario: 'middle' },
        { metric: 'scroll-drag-sequence', scenario: 'drag' },
      ];
      for (const jumpScenario of scrollJumpScenarios) {
        const jump = await withTimeout(
          measureScrollJumpScenario(handle.page, jumpScenario.scenario),
          interactionTimeoutMs,
          jumpScenario.metric,
        );
        if (jump.ok) {
          report.push(
            {
              metric: jumpScenario.metric,
              value: round(jump.value.jumpReadyMs),
              unit: 'ms',
              note: `before=${round(jump.value.beforeScrollTop)} assign=${round(jump.value.afterAssignScrollTop)} final=${round(jump.value.finalScrollTop)} max=${round(jump.value.currentMaxScrollTop)} ${jump.value.timedOut ? 'timeout' : 'ready'} placeholders=${jump.value.firstFramePlaceholders} drift=${round(jump.value.scrollTopDrift)} timings=${JSON.stringify(jump.value.timings)} hydrate=${JSON.stringify(jump.value.hydrateTimings)} details=${JSON.stringify(jump.value.placeholderDetails)}`,
            },
            {
              metric: `${jumpScenario.metric}-jump-ready-ms`,
              value: round(jump.value.jumpReadyMs),
              unit: 'ms',
            },
            {
              metric: `${jumpScenario.metric}-placeholder-ready-ms`,
              value: round(jump.value.placeholderReadyMs),
              unit: 'ms',
              note: 'jump ready when visible placeholders first reach zero',
            },
            {
              metric: `${jumpScenario.metric}-settle-overhead-ms`,
              value: round(jump.value.settleOverheadMs),
              unit: 'ms',
              note: 'extra rAF/settle time after placeholders reach zero',
            },
            {
              metric: `${jumpScenario.metric}-placeholder-scan-ms`,
              value: round(jump.value.placeholderScanMs),
              unit: 'ms',
              note: `total scan time for visiblePlaceholderCount() across ${jump.value.placeholderScanCalls} calls`,
            },
            {
              metric: `${jumpScenario.metric}-inline-placeholder-scan-ms`,
              value: round(jump.value.inlinePlaceholderScanMs),
              unit: 'ms',
              note: `total scan time for visibleInlineMathPlaceholderCount() across ${jump.value.inlinePlaceholderScanCalls} calls`,
            },
            {
              metric: `${jumpScenario.metric}-first-frame-placeholders`,
              value: jump.value.firstFramePlaceholders,
              unit: 'nodes',
              note: jump.value.timedOut ? 'timed-out' : 'ready',
            },
            {
              metric: `${jumpScenario.metric}-drift`,
              value: round(jump.value.scrollTopDrift),
              unit: 'px',
            },
            {
              metric: `${jumpScenario.metric}-first-frame-ready`,
              value: jump.value.firstFrameReady,
              unit: 'boolean',
              note: `first-frame-placeholders=${jump.value.firstFramePlaceholders}`,
            },
            {
              metric: `${jumpScenario.metric}-visible-fallback`,
              value: JSON.stringify(jump.value.visibleFallbackTimings),
              unit: 'json',
            },
            {
              metric: `${jumpScenario.metric}-settle-scan`,
              value: JSON.stringify(jump.value.settleScanDiagnostics),
              unit: 'json',
            },
            {
              metric: `${jumpScenario.metric}-late-stabilization`,
              value: JSON.stringify(jump.value.lateStabilizationDiagnostics),
              unit: 'json',
            },
            {
              metric: `${jumpScenario.metric}-inline-height-drift`,
              value: jump.value.inlineHeightDrift,
              unit: 'px',
              note: jump.value.inlineHeightDriftNote,
            },
            {
              metric: `${jumpScenario.metric}-inline-math-activate-ready-ms`,
              value: round(jump.value.inlineMathActivateReadyMs),
              unit: 'ms',
              note: `pre=${jump.value.preDispatchInlinePlaceholders} first=${jump.value.firstInlinePlaceholders} after=${jump.value.afterForceInlinePlaceholders} activated=${jump.value.forceInlineActivated} forceMs=${round(jump.value.forceInlineMs)} instrumented=${round(jump.value.instrumentedInlineMathReadyMs)}`,
            },
            {
              metric: `${jumpScenario.metric}-activate-profile`,
              value: JSON.stringify(jump.value.activateProfile),
              unit: 'json',
            },
            {
              metric: `${jumpScenario.metric}-inline-math-activate-max-frame-ms`,
              value: round(jump.value.inlineMathActivateMaxFrameMs),
              unit: 'ms',
            },
            {
              metric: `${jumpScenario.metric}-inline-math-viewport-katex-ready-ms`,
              value: round(jump.value.inlineMathViewportKatexReadyMs),
              unit: 'ms',
              note: `visible-katex=${jump.value.inlineMathViewportKatexCount}`,
            },
            {
              metric: `${jumpScenario.metric}-inline-math-viewport-katex-max-frame-ms`,
              value: round(jump.value.inlineMathViewportKatexMaxFrameMs),
              unit: 'ms',
              note: `visible-katex=${jump.value.inlineMathViewportKatexCount}`,
            },
            {
              metric: `${jumpScenario.metric}-template-cache-hits`,
              value: jump.value.templateCacheHits,
              unit: 'hits',
            },
            {
              metric: `${jumpScenario.metric}-template-cache-misses`,
              value: jump.value.templateCacheMisses,
              unit: 'misses',
            },
            {
              metric: `${jumpScenario.metric}-template-bytes`,
              value: jump.value.templateBytes,
              unit: 'bytes',
            },
            {
              metric: `${jumpScenario.metric}-katex-inject-p50-ms`,
              value: round(jump.value.katexInjectP50Ms),
              unit: 'ms',
            },
            {
              metric: `${jumpScenario.metric}-katex-inject-p95-ms`,
              value: round(jump.value.katexInjectP95Ms),
              unit: 'ms',
            },
            {
              metric: `${jumpScenario.metric}-katex-inject-max-ms`,
              value: round(jump.value.katexInjectMaxMs),
              unit: 'ms',
            },
            {
              metric: `${jumpScenario.metric}-longtasks`,
              value: JSON.stringify(jump.value.longTasks),
              unit: "json",
              note: `count=${jump.value.longTasks.length}`,
            },
            {
              metric: `${jumpScenario.metric}-frame-stamps`,
              value: JSON.stringify(jump.value.frameStamps),
              unit: "json",
            },
            {
              metric: `${jumpScenario.metric}-layout-shifts`,
              value: JSON.stringify(jump.value.layoutShifts),
              unit: "json",
            },
            {
              metric: `${jumpScenario.metric}-mutation-bursts`,
              value: JSON.stringify(jump.value.mutationBursts),
              unit: "json",
            },
            {
              metric: `${jumpScenario.metric}-function-costs`,
              value: JSON.stringify(jump.value.functionCosts ?? {}),
              unit: 'json',
            },
          );
          scrollFirstFrameReady[jumpScenario.metric] = jump.value.firstFrameReady;
          inlineHeightDrifts[jumpScenario.metric] = jump.value.inlineHeightDrift;
          inlineMathActivateReady.push(jump.value.inlineMathActivateReadyMs);
          inlineMathActivateMaxFrame.push(jump.value.inlineMathActivateMaxFrameMs);
          inlineMathViewportKatexReady.push(jump.value.inlineMathViewportKatexReadyMs);
          inlineMathViewportKatexMaxFrame.push(jump.value.inlineMathViewportKatexMaxFrameMs);
          inlineMathViewportKatexCounts.push(jump.value.inlineMathViewportKatexCount);
          templateCacheHits.push(jump.value.templateCacheHits);
          templateCacheMisses.push(jump.value.templateCacheMisses);
          templateBytes.push(jump.value.templateBytes);
          katexInjectP50Ms.push(jump.value.katexInjectP50Ms);
          katexInjectP95Ms.push(jump.value.katexInjectP95Ms);
          katexInjectMaxMs.push(jump.value.katexInjectMaxMs);
        } else {
          report.push({
            metric: jumpScenario.metric,
            value: 'timeout',
            unit: `${interactionTimeoutMs}ms`,
          });
          scrollFirstFrameReady[jumpScenario.metric] = false;
          inlineHeightDrifts[jumpScenario.metric] = 'n/a';
        }
      }

      const allScrollFirstFrameReady =
        Object.keys(scrollFirstFrameReady).length > 0 &&
        Object.values(scrollFirstFrameReady).every((value) => value);
      const numericHeightDrifts = Object.values(inlineHeightDrifts).filter(
        (value): value is number => typeof value === 'number',
      );
      const inlineHeightDriftSummary =
        numericHeightDrifts.length > 0 ? Math.max(...numericHeightDrifts) : 'n/a';
      report.push(
        {
          metric: 'scroll-first-frame-ready',
          value: allScrollFirstFrameReady,
          unit: 'boolean',
          note: `bottom=${scrollFirstFrameReady['scroll-jump-bottom'] ?? 'n/a'} middle=${scrollFirstFrameReady['scroll-jump-middle'] ?? 'n/a'} drag=${scrollFirstFrameReady['scroll-drag-sequence'] ?? 'n/a'}`,
        },
        {
          metric: 'inline-height-drift',
          value: inlineHeightDriftSummary,
          unit: 'px',
          note: `bottom=${inlineHeightDrifts['scroll-jump-bottom'] ?? 'n/a'} middle=${inlineHeightDrifts['scroll-jump-middle'] ?? 'n/a'} drag=${inlineHeightDrifts['scroll-drag-sequence'] ?? 'n/a'}`,
        },
        {
          metric: 'inline-math-activate-ready-ms',
          value: inlineMathActivateReady.length > 0
            ? round(Math.max(...inlineMathActivateReady))
            : 'n/a',
          unit: 'ms',
          note: `bottom=${inlineMathActivateReady[0] ?? 'n/a'} middle=${inlineMathActivateReady[1] ?? 'n/a'} drag=${inlineMathActivateReady[2] ?? 'n/a'}`,
        },
        {
          metric: 'inline-math-activate-max-frame-ms',
          value: inlineMathActivateMaxFrame.length > 0
            ? round(Math.max(...inlineMathActivateMaxFrame))
            : 'n/a',
          unit: 'ms',
          note: `bottom=${inlineMathActivateMaxFrame[0] ?? 'n/a'} middle=${inlineMathActivateMaxFrame[1] ?? 'n/a'} drag=${inlineMathActivateMaxFrame[2] ?? 'n/a'}`,
        },
        {
          metric: 'inline-math-viewport-katex-ready-ms',
          value: inlineMathViewportKatexReady.length > 0
            ? round(Math.max(...inlineMathViewportKatexReady))
            : 'n/a',
          unit: 'ms',
          note: `bottom=${inlineMathViewportKatexReady[0] ?? 'n/a'} middle=${inlineMathViewportKatexReady[1] ?? 'n/a'} drag=${inlineMathViewportKatexReady[2] ?? 'n/a'}`,
        },
        {
          metric: 'inline-math-viewport-katex-max-frame-ms',
          value: inlineMathViewportKatexMaxFrame.length > 0
            ? round(Math.max(...inlineMathViewportKatexMaxFrame))
            : 'n/a',
          unit: 'ms',
          note: `bottom=${inlineMathViewportKatexMaxFrame[0] ?? 'n/a'} middle=${inlineMathViewportKatexMaxFrame[1] ?? 'n/a'} drag=${inlineMathViewportKatexMaxFrame[2] ?? 'n/a'}`,
        },
        {
          metric: 'inline-math-viewport-katex-count',
          value: inlineMathViewportKatexCounts.length > 0
            ? Math.max(...inlineMathViewportKatexCounts)
            : 0,
          unit: 'nodes',
          note: `bottom=${inlineMathViewportKatexCounts[0] ?? 'n/a'} middle=${inlineMathViewportKatexCounts[1] ?? 'n/a'} drag=${inlineMathViewportKatexCounts[2] ?? 'n/a'}`,
        },
        {
          metric: 'template-cache-hits',
          value: templateCacheHits.length > 0
            ? templateCacheHits.reduce((total, value) => total + value, 0)
            : 0,
          unit: 'hits',
          note: `bottom=${templateCacheHits[0] ?? 'n/a'} middle=${templateCacheHits[1] ?? 'n/a'} drag=${templateCacheHits[2] ?? 'n/a'}`,
        },
        {
          metric: 'template-cache-misses',
          value: templateCacheMisses.length > 0
            ? templateCacheMisses.reduce((total, value) => total + value, 0)
            : 0,
          unit: 'misses',
          note: `bottom=${templateCacheMisses[0] ?? 'n/a'} middle=${templateCacheMisses[1] ?? 'n/a'} drag=${templateCacheMisses[2] ?? 'n/a'}`,
        },
        {
          metric: 'template-bytes',
          value: templateBytes.length > 0 ? Math.max(...templateBytes) : 0,
          unit: 'bytes',
          note: `bottom=${templateBytes[0] ?? 'n/a'} middle=${templateBytes[1] ?? 'n/a'} drag=${templateBytes[2] ?? 'n/a'}`,
        },
        {
          metric: 'katex-inject-p50-ms',
          value: katexInjectP50Ms.length > 0
            ? round(Math.max(...katexInjectP50Ms))
            : 0,
          unit: 'ms',
          note: `bottom=${round(katexInjectP50Ms[0] ?? 0)} middle=${round(katexInjectP50Ms[1] ?? 0)} drag=${round(katexInjectP50Ms[2] ?? 0)}`,
        },
        {
          metric: 'katex-inject-p95-ms',
          value: katexInjectP95Ms.length > 0
            ? round(Math.max(...katexInjectP95Ms))
            : 0,
          unit: 'ms',
          note: `bottom=${round(katexInjectP95Ms[0] ?? 0)} middle=${round(katexInjectP95Ms[1] ?? 0)} drag=${round(katexInjectP95Ms[2] ?? 0)}`,
        },
        {
          metric: 'katex-inject-max-ms',
          value: katexInjectMaxMs.length > 0
            ? round(Math.max(...katexInjectMaxMs))
            : 0,
          unit: 'ms',
          note: `bottom=${round(katexInjectMaxMs[0] ?? 0)} middle=${round(katexInjectMaxMs[1] ?? 0)} drag=${round(katexInjectMaxMs[2] ?? 0)}`,
        },
      );

      const contextMenu = await withTimeout(
        measureVisualContextMenu(handle.page),
        interactionTimeoutMs,
        'context-menu',
      );
      report.push(
        contextMenu.ok
          ? {
              metric: 'context-menu-open',
              value: round(contextMenu.value.contextMenuMs),
              unit: 'ms',
              note: contextMenu.value.visible ? 'visible' : 'not-visible',
            }
          : { metric: 'context-menu-open', value: 'timeout', unit: `${interactionTimeoutMs}ms` },
      );

      const uiff = await withTimeout(
        measureFirstFrameContract(handle.page),
        interactionTimeoutMs,
        'first-frame-contract',
      );
      if (uiff.ok) {
        const contract = uiff.value;
        report.push(
          {
            metric: 'uiff-click-selection-deviation-px',
            value: round(contract.click.deviationPx),
            unit: 'px',
            note: `exists=${contract.click.selectionExists} mapped=${contract.click.mappedPos} selected=${contract.click.selectedPos}`,
          },
          {
            metric: 'uiff-cdp-insert-x-ms',
            value: round(contract.input.ms),
            unit: 'ms',
            note: `applied=${contract.input.applied} roundTrip=${round(contract.input.roundTripMs ?? 0)}`,
          },
          {
            metric: 'uiff-viewport-real',
            value: contract.viewport.real,
            unit: 'boolean',
            note: `visible=${contract.viewport.visibleFormulaCount} katex=${contract.viewport.visibleRealKatexCount} placeholders=${contract.viewport.placeholderCount}`,
          },
          {
            metric: 'uiff-scroll-stable',
            value: contract.scroll.stable,
            unit: 'boolean',
            note: `frames=${contract.scroll.stableFrames} layout-shift=${round(contract.scroll.layoutShiftCumulative)} entries=${contract.scroll.layoutShiftEntries} supported=${contract.scroll.layoutShiftSupported}`,
          },
          {
            metric: 'uiff-no-overlay',
            value: contract.overlay.noOverlay,
            unit: 'boolean',
            note: `overlays=${contract.overlay.overlayCount} hitEditor=${contract.overlay.hitEditor} hit=${contract.overlay.hitElement}`,
          },
          {
            metric: 'uiff-coords-available',
            value: contract.coords.nonNull === contract.coords.sampled,
            unit: 'boolean',
            note: `sampled=${contract.coords.sampled} nonNull=${contract.coords.nonNull} points=${JSON.stringify(contract.coords.points)}`,
          },
          {
            metric: 'uiff-passed',
            value: contract.passed,
            unit: 'boolean',
            note: JSON.stringify(contract),
          },
        );
      } else {
        report.push({
          metric: 'uiff-passed',
          value: 'timeout',
          unit: `${interactionTimeoutMs}ms`,
        });
      }

      const bfr = await withTimeout(
        measureBackgroundReadiness(handle.page, formulaUnique),
        interactionTimeoutMs,
        'background-full-readiness',
      );
      if (bfr.ok) {
        const deferred = bfr.value.deferred as Record<string, unknown> | null;
        const cache = bfr.value.heightCache as Record<string, unknown> | null;
        const inline = bfr.value.inline as Record<string, unknown> | null;
        const syntax = bfr.value.syntax as Record<string, unknown> | null;
        const placeholderCount = bfr.value.placeholderCount;
        const offscreenSyntaxDecorationCount = bfr.value.offscreenSyntaxDecorationCount;
        const expectedUnique = bfr.value.expectedUnique;
        const cacheSize =
          typeof cache?.size === 'number' ? cache.size : null;
        report.push(
          {
            metric: 'bfr-worker-queue-empty',
            value:
              typeof deferred?.workerQueueEmpty === 'boolean'
                ? deferred.workerQueueEmpty
                : 'n/a',
            unit: 'boolean',
            note: JSON.stringify(deferred),
          },
          {
            metric: 'bfr-pending-inline-height-measurements',
            value:
              typeof inline?.pendingHeightMeasurements === 'number'
                ? inline.pendingHeightMeasurements
                : 'n/a',
            unit: 'keys',
          },
          {
            metric: 'bfr-placeholders',
            value: typeof placeholderCount === 'number' ? placeholderCount : 'n/a',
            unit: 'nodes',
          },
          {
            metric: 'bfr-syntax-decoration-span-count',
            value:
              typeof syntax?.spanCount === 'number' ? syntax.spanCount : 'n/a',
            unit: 'spans',
            note: JSON.stringify(syntax),
          },
          {
            metric: 'bfr-offscreen-syntax-decoration-count',
            value:
              typeof offscreenSyntaxDecorationCount === 'number'
                ? offscreenSyntaxDecorationCount
                : 'n/a',
            unit: 'spans',
            note: 'default track keeps syntax decoration scoped to viewport/selection',
          },
          {
            metric: 'bfr-height-cache-coverage',
            value:
              typeof expectedUnique === 'number' &&
              expectedUnique > 0 &&
              cacheSize !== null
                ? round((cacheSize / expectedUnique) * 100)
                : 'n/a',
            unit: 'percent',
            note: JSON.stringify(cache),
          },
        );
      } else {
        report.push({
          metric: 'bfr-worker-queue-empty',
          value: 'timeout',
          unit: `${interactionTimeoutMs}ms`,
        });
      }
    }
  } finally {
    // SIGKILL avoids the app's unsaved-changes close prompt after the edit benchmark.
    if (process.platform !== 'win32') {
      try {
        process.kill(-handle.child.pid, 'SIGKILL');
      } catch {
        // Process group may already be gone.
      }
    }
    handle.child.kill('SIGKILL');
  }

  console.log(`\nPerformance report for ${markdownPath}`);
  console.log(formatEntries(report));
  const budgetComparison = compareToBudget(report, perfBudget);
  console.log(`\nBudget comparison`);
  console.log(formatBudgetComparison(budgetComparison));
  const outputPath = path.join(projectRoot, 'perf-report.json');
  const output = { metrics: report, budget: budgetComparison };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nSaved machine-readable report to ${outputPath}`);
}

async function main(): Promise<void> {
  const exclusiveRun = await acquireExclusiveBenchmarkRun();
  try {
    await runBenchmark();
  } finally {
    await exclusiveRun.release();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

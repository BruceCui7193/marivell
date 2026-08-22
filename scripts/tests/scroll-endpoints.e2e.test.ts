import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { installPlaceholderHelpers } from './test-utils/placeholder';

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
        const textReady = Boolean(surface && surface.innerText.length > Math.min(expectedSize, 10_000));
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

interface StableScrollState {
  scrollTop: number;
  maxScrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  stable: boolean;
  timedOut: boolean;
  eventCount: number;
  postStableEvents: number;
  postStableTopChanges: number;
  firstVisibleText: string;
  markerVisible: boolean;
  markerRect: { top: number; bottom: number } | null;
  visiblePlaceholders: number;
  visibleUnrenderedInlineMathCount: number;
  visibleUnloadedImageCount: number;
  grayLatexDirectTextCount: number;
  inlineHeightDrift: number | 'n/a';
  inlineHeightDriftNote: string;
  settleScanDiagnostics: Record<string, unknown> | null;
}

const buildStableScrollScript = (
  target: number | null,
  ratio: number,
  marker: string,
  timeoutMs: number,
): string => `(async () => {
  const frame = document.querySelector('.editor-frame');
  if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
  const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
  const target = ${JSON.stringify(target)} === null
    ? Math.round(maxScrollTop * ${JSON.stringify(ratio)})
    : ${JSON.stringify(target)};
  const marker = ${JSON.stringify(marker)};
  const events = [];
  const onScroll = () => events.push(performance.now());
  frame.addEventListener('scroll', onScroll, { passive: true });
  frame.scrollTop = target;
  frame.dispatchEvent(new Event('scroll'));
  const start = performance.now();
  let previousTop = frame.scrollTop;
  let stableFrames = 0;
  let timedOut = true;
  while (performance.now() - start < ${JSON.stringify(timeoutMs)}) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const top = frame.scrollTop;
    const lastEventAt = events.length > 0 ? events[events.length - 1] : start;
    if (top === previousTop && events.length === 0) {
      stableFrames += 1;
    } else if (top === previousTop && events.length > 0 && performance.now() - lastEventAt >= 200) {
      stableFrames += 1;
    } else {
      stableFrames = 0;
    }
    previousTop = top;
    if (stableFrames >= 3 && (events.length === 0 || performance.now() - lastEventAt >= 200)) {
      timedOut = false;
      break;
    }
  }
  const stableTop = frame.scrollTop;
  const postStableStartEvents = events.length;
  let postStableTopChanges = 0;
  for (let index = 0; index < 12; index += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (frame.scrollTop !== stableTop) postStableTopChanges += 1;
  }
  const postStableEvents = events.length - postStableStartEvents;
  frame.removeEventListener('scroll', onScroll);

  const frameRect = frame.getBoundingClientRect();
  const textCandidates = Array.from(
    frame.querySelectorAll('.editor-surface h1, .editor-surface h2, .editor-surface h3, .editor-surface p, .editor-surface li, .editor-surface blockquote'),
  ).map((element) => {
    const rect = element.getBoundingClientRect();
    return { element, rect, text: (element.textContent ?? '').trim() };
  }).filter((candidate) =>
    candidate.text.length > 0 &&
    candidate.rect.bottom > frameRect.top &&
    candidate.rect.top < frameRect.bottom
  ).sort((a, b) => a.rect.top - b.rect.top);
  const firstVisibleText = textCandidates[0]?.text ?? '';
  let markerVisible = false;
  let markerRect = null;
  if (marker) {
    for (const candidate of textCandidates) {
      if (candidate.text.includes(marker)) {
        markerVisible = true;
        markerRect = { top: candidate.rect.top, bottom: candidate.rect.bottom };
        break;
      }
    }
  }
  // D10: collect inline-height-drift and placeholder diagnostics
  let visiblePlaceholders = 0;
  let visibleUnrenderedInlineMathCount = 0;
  let visibleUnloadedImageCount = 0;
  let grayLatexDirectTextCount = 0;
  try {
    const probe = window.marivellCollectVisiblePlaceholderState(frame);
    visiblePlaceholders = probe.placeholderCount;
    visibleUnrenderedInlineMathCount = probe.visibleUnrenderedInlineMathCount;
    visibleUnloadedImageCount = probe.visibleUnloadedImageCount;
    grayLatexDirectTextCount = probe.grayLatexDirectTextCount;
  } catch { visiblePlaceholders = -1; }

  let inlineHeightDrift = 'n/a';
  let inlineHeightDriftNote = 'diagnostics not available';
  let settleScanDiagnostics = null;
  try {
    const scan = window.__marivellSettleScanDiagnostics;
    settleScanDiagnostics = scan ?? null;
    if (scan && scan.finalDelta !== null) {
      inlineHeightDrift = Math.abs(scan.finalDelta);
      inlineHeightDriftNote = 'coordsOk=' + scan.coordsOk +
        ' domFallback=' + (scan.domFallbackUsed || false) +
        ' compensation=' + scan.compensationApplied;
    }
  } catch { /* diagnostics unavailable */ }
  return {
    scrollTop: frame.scrollTop,
    maxScrollTop: Math.max(frame.scrollHeight - frame.clientHeight, 0),
    scrollHeight: frame.scrollHeight,
    clientHeight: frame.clientHeight,
    stable: stableFrames >= 3,
    timedOut,
    eventCount: events.length,
    postStableEvents,
    postStableTopChanges,
    firstVisibleText,
    markerVisible,
    markerRect,
    visiblePlaceholders,
    visibleUnrenderedInlineMathCount,
    visibleUnloadedImageCount,
    grayLatexDirectTextCount,
    inlineHeightDrift,
    inlineHeightDriftNote,
    settleScanDiagnostics,
  };
})()`;

async function scrollToStable(
  page: Page,
  args: { target?: number; ratio?: number; marker?: string; timeoutMs?: number },
): Promise<StableScrollState> {
  const script = buildStableScrollScript(
    args.target ?? null,
    args.ratio ?? 0.5,
    args.marker ?? '',
    args.timeoutMs ?? 15_000,
  );
  const result = await page.evaluate(script);
  return result as unknown as StableScrollState;
}

interface PostReleaseMonitor {
  firstTop: number;
  lastTop: number;
  topChanges: number;
  eventsAfterFirstRaf: number;
  eventTimes: number[];
  maxScrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  sampledFrames: number;
}

const buildPostReleaseMonitorScript = (target: number | null, ratio: number): string => `(async () => {
  const frame = document.querySelector('.editor-frame');
  if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
  const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
  const target = ${JSON.stringify(target)} === null
    ? Math.round(maxScrollTop * ${JSON.stringify(ratio)})
    : ${JSON.stringify(target)};
  const eventTimes = [];
  const onScroll = () => eventTimes.push(performance.now());
  frame.addEventListener('scroll', onScroll, { passive: true });
  frame.scrollTop = target;
  frame.dispatchEvent(new Event('scroll'));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const firstTop = frame.scrollTop;
  const releaseEvents = eventTimes.length;
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
  const eventsAfterFirstRaf = eventTimes.length - releaseEvents;
  frame.removeEventListener('scroll', onScroll);
  return {
    firstTop,
    lastTop,
    topChanges,
    eventsAfterFirstRaf,
    eventTimes,
    maxScrollTop: Math.max(frame.scrollHeight - frame.clientHeight, 0),
    scrollHeight: frame.scrollHeight,
    clientHeight: frame.clientHeight,
    sampledFrames,
  };
})()`;

async function monitorPostRelease(
  page: Page,
  args: { target?: number; ratio?: number },
): Promise<PostReleaseMonitor> {
  const script = buildPostReleaseMonitorScript(args.target ?? null, args.ratio ?? 0.5);
  const result = await page.evaluate(script);
  return result as unknown as PostReleaseMonitor;
}

async function waitForMode(page: Page, mode: 'source' | 'visual'): Promise<boolean> {
  return page.evaluate(
    async ({ mode }) => {
      const deadline = performance.now() + 30_000;
      while (performance.now() < deadline) {
        const frame = document.querySelector<HTMLElement>('.editor-frame');
        const input = frame?.querySelector<HTMLTextAreaElement>('.source-editor__input');
        const overlay = frame?.querySelector<HTMLElement>('.editor-loading--mode-switch');
        if (!frame || overlay) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        if (mode === 'source') {
          if (!frame.classList.contains('is-source') || !input) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            continue;
          }
          const maxInputScrollTop = Math.max(input.scrollHeight - input.clientHeight, 0);
          if (maxInputScrollTop > 0 && input.scrollTop <= 0) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            continue;
          }
        } else if (frame.classList.contains('is-source') || input) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        } else {
          const maxFrameScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
          if (maxFrameScrollTop > 0 && frame.scrollTop <= 0) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            continue;
          }
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return true;
      }
      return false;
    },
    { mode },
  );
}

interface ModeStabilityMonitor {
  mode: 'source' | 'visual';
  frameTop: number;
  frameMaxScrollTop: number;
  inputTop: number | null;
  inputMaxScrollTop: number | null;
  frameTopChanges: number;
  inputTopChanges: number;
  eventsAfterBaseline: number;
  sampledFrames: number;
}

const buildModeStabilityMonitorScript = (): string => `(async () => {
  const frame = document.querySelector('.editor-frame');
  if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
  const input = frame.querySelector('.source-editor__input');
  const eventTimes = [];
  const onScroll = () => eventTimes.push(performance.now());
  frame.addEventListener('scroll', onScroll, { passive: true });
  input?.addEventListener('scroll', onScroll, { passive: true });
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const baselineEvents = eventTimes.length;
  const firstFrameTop = frame.scrollTop;
  const firstInputTop = input instanceof HTMLElement ? input.scrollTop : null;
  const start = performance.now();
  let frameTopChanges = 0;
  let inputTopChanges = 0;
  let sampledFrames = 0;
  while (performance.now() - start < 500 && sampledFrames < 30) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (frame.scrollTop !== firstFrameTop) frameTopChanges += 1;
    if (input instanceof HTMLElement && input.scrollTop !== firstInputTop) {
      inputTopChanges += 1;
    }
    sampledFrames += 1;
  }
  const eventsAfterBaseline = eventTimes.length - baselineEvents;
  frame.removeEventListener('scroll', onScroll);
  input?.removeEventListener('scroll', onScroll);
  return {
    mode: frame.classList.contains('is-source') ? 'source' : 'visual',
    frameTop: frame.scrollTop,
    frameMaxScrollTop: Math.max(frame.scrollHeight - frame.clientHeight, 0),
    inputTop: input instanceof HTMLElement ? input.scrollTop : null,
    inputMaxScrollTop: input instanceof HTMLElement
      ? Math.max(input.scrollHeight - input.clientHeight, 0)
      : null,
    frameTopChanges,
    inputTopChanges,
    eventsAfterBaseline,
    sampledFrames,
  };
})()`;

async function monitorModeStability(page: Page): Promise<ModeStabilityMonitor> {
  const result = await page.evaluate(buildModeStabilityMonitorScript());
  return result as unknown as ModeStabilityMonitor;
}

async function getVisibleFirstText(page: Page): Promise<{ text: string; frameTop: number }> {
  return page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>('.editor-frame');
    if (!frame) throw new Error('editor frame missing');
    const frameRect = frame.getBoundingClientRect();
    const candidates = Array.from(
      frame.querySelectorAll('.editor-surface h1, .editor-surface h2, .editor-surface h3, .editor-surface p, .editor-surface li, .editor-surface blockquote'),
    ).map((element) => {
      const rect = element.getBoundingClientRect();
      return { element, rect, text: (element.textContent ?? '').trim() };
    }).filter((candidate) =>
      candidate.text.length > 0 &&
      candidate.rect.bottom > frameRect.top &&
      candidate.rect.top < frameRect.bottom
    ).sort((a, b) => a.rect.top - b.rect.top);
    return {
      text: candidates[0]?.text ?? '',
      frameTop: frame.scrollTop,
    };
  });
}

async function main(): Promise<void> {
  console.log('\n## scroll endpoint and post-release stability e2e');
  const topMarker = 'BEGIN_DOCUMENT_MARKER_7f3a';
  const middleMarker = 'MIDDLE_DOCUMENT_MARKER_9c1b';
  const endMarker = 'END_DOCUMENT_MARKER_4d8e';
  const lines: string[] = [];
  lines.push(`# ${topMarker}\n\nIntro paragraph before the main body. Inline math $\\alpha + \\beta$.\n`);
  for (let index = 0; index < 898; index += 1) {
    lines.push(
      `## Section ${index}\n\nParagraph ${index} contains enough text to make this document scrollable, ` +
        `plus inline math $x_{${index}}^2 + y_{${index}}^2$ and code \`value_${index}\`.\n`,
    );
  }
  lines.push(`# ${middleMarker}\n\nMiddle marker section with math $\\sum_{i=1}^{n} i$.\n`);
  for (let index = 898; index < 1800; index += 1) {
    lines.push(
      `## Section ${index}\n\nParagraph ${index} contains enough text to make this document scrollable, ` +
        `plus inline math $x_{${index}}^2 + y_{${index}}^2$ and code \`value_${index}\`.\n`,
    );
  }
  lines.push(`# ${endMarker}\n\nFinal paragraph after the end marker with math $\\omega + 1$.\n`);
  const source = lines.join('\n');
  const markdownPath = path.join(os.tmpdir(), `marivell-scroll-endpoints-${process.pid}.md`);
  fs.writeFileSync(markdownPath, source, 'utf8');

  const outDir = path.join(os.tmpdir(), `marivell-scroll-endpoints-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-scroll-endpoints-profile-${process.pid}`);
  const port = 9800 + (process.pid % 150);

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
    assert('open large document in visual mode', ready.ok && !ready.value.timedOut, ready.label);
    if (!ready.ok || ready.value.timedOut) {
      return;
    }

    const initialState = await handle.page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      if (!frame) throw new Error('editor frame missing');
      return {
        scrollTop: frame.scrollTop,
        maxScrollTop: Math.max(frame.scrollHeight - frame.clientHeight, 0),
        scrollHeight: frame.scrollHeight,
        clientHeight: frame.clientHeight,
      };
    });
    console.log(`  initial viewport: ${JSON.stringify(initialState)}`);

    const middle = await withTimeout(
      scrollToStable(handle.page, { ratio: 0.5, marker: middleMarker }),
      20_000,
      'scroll-to-middle',
    );
    assert(
      'scroll to middle settles at the requested region',
      middle.ok && middle.value.stable && !middle.value.timedOut,
      middle.ok ? JSON.stringify(middle.value) : middle.label,
    );
    if (!middle.ok || !middle.value.stable) {
      return;
    }

    const top = await withTimeout(
      scrollToStable(handle.page, { target: 0, marker: topMarker }),
      20_000,
      'scroll-back-to-top',
    );
    assert(
      'scroll back to top settles without timing out',
      top.ok && top.value.stable && !top.value.timedOut,
      top.ok ? JSON.stringify(top.value) : top.label,
    );
    if (!top.ok || !top.value.stable) {
      return;
    }
    assert(
      'top endpoint has scrollTop exactly 0',
      top.value.scrollTop === 0,
      JSON.stringify(top.value),
    );
    assert(
      'top endpoint shows the document start marker',
      top.value.firstVisibleText.includes(topMarker),
      JSON.stringify(top.value),
    );
    assert(
      'top endpoint is stable across post-stable rAFs',
      top.value.postStableEvents === 0 && top.value.postStableTopChanges === 0,
      JSON.stringify(top.value),
    );

    const bottom = await withTimeout(
      scrollToStable(handle.page, { ratio: 1, marker: endMarker }),
      25_000,
      'scroll-to-bottom',
    );
    assert(
      'scroll to bottom settles without timing out',
      bottom.ok && bottom.value.stable && !bottom.value.timedOut,
      bottom.ok ? JSON.stringify(bottom.value) : bottom.label,
    );
    if (!bottom.ok || !bottom.value.stable) {
      return;
    }
    assert(
      'bottom endpoint is at maximum scrollTop',
      Math.abs(bottom.value.scrollTop - bottom.value.maxScrollTop) <= 1,
      JSON.stringify(bottom.value),
    );
    assert(
      'bottom endpoint shows the document end marker',
      bottom.value.markerVisible &&
        bottom.value.markerRect !== null &&
        bottom.value.markerRect.bottom > bottom.value.clientHeight * 0.5,
      JSON.stringify(bottom.value),
    );
    assert(
      'bottom endpoint is stable across post-stable rAFs',
      bottom.value.postStableEvents === 0 && bottom.value.postStableTopChanges === 0,
      JSON.stringify(bottom.value),
    );
    assert(
      'bottom inline-height-drift is within tolerance after D10 fix',
      typeof bottom.value.inlineHeightDrift === 'number' && bottom.value.inlineHeightDrift <= 1,
      JSON.stringify({
        drift: bottom.value.inlineHeightDrift,
        note: bottom.value.inlineHeightDriftNote,
        settleScan: bottom.value.settleScanDiagnostics,
      }),
    );

    const release = await withTimeout(
      monitorPostRelease(handle.page, { ratio: 0.5 }),
      15_000,
      'post-release-stability',
    );
    assert(
      'post-release monitor completes',
      release.ok,
      release.ok ? '' : release.label,
    );
    if (!release.ok) {
      return;
    }
    const releaseState = release.value;
    console.log(`  post-release monitor: ${JSON.stringify(releaseState)}`);
    assert(
      'post-release keeps scrollTop stable for 1000ms',
      releaseState.topChanges === 0 && releaseState.firstTop === releaseState.lastTop,
      JSON.stringify(releaseState),
    );
    assert(
      'post-release emits no new scroll events for 1000ms',
      releaseState.eventsAfterFirstRaf === 0,
      JSON.stringify(releaseState),
    );

    await handle.page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-source-mode' }),
      );
    });
    const sourceReady = await withTimeout(waitForMode(handle.page, 'source'), 35_000, 'visual-to-source');
    assert(
      'visual to source switch reaches source mode',
      sourceReady.ok && sourceReady.value,
      sourceReady.ok ? '' : sourceReady.label,
    );
    if (!sourceReady.ok || !sourceReady.value) {
      return;
    }
    const sourceStability = await monitorModeStability(handle.page);
    console.log(`  source-mode stability: ${JSON.stringify(sourceStability)}`);
    assert(
      'source mode restores the target scroll position',
      sourceStability.mode === 'source' &&
        sourceStability.frameTop === 0 &&
        sourceStability.inputTop !== null &&
        sourceStability.inputTop > 0,
      JSON.stringify(sourceStability),
    );
    assert(
      'source mode stays stable for 500ms after switch',
      sourceStability.frameTopChanges === 0 &&
        sourceStability.inputTopChanges === 0 &&
        sourceStability.eventsAfterBaseline === 0,
      JSON.stringify(sourceStability),
    );

    await handle.page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-source-mode' }),
      );
    });
    const visualReady = await withTimeout(waitForMode(handle.page, 'visual'), 35_000, 'source-to-visual');
    assert(
      'source to visual switch reaches visual mode',
      visualReady.ok && visualReady.value,
      visualReady.ok ? '' : visualReady.label,
    );
    if (!visualReady.ok || !visualReady.value) {
      return;
    }
    const visualStability = await monitorModeStability(handle.page);
    const visualTarget = await getVisibleFirstText(handle.page);
    console.log(`  visual-mode stability: ${JSON.stringify({ visualStability, visualTarget })}`);
    assert(
      'visual mode restores the target scroll position',
      visualStability.mode === 'visual' &&
        visualStability.frameTop > 0 &&
        visualTarget.text.includes(middleMarker),
      JSON.stringify({ visualStability, visualTarget }),
    );
    assert(
      'visual mode stays stable for 500ms after switch',
      visualStability.frameTopChanges === 0 &&
        visualStability.inputTopChanges === 0 &&
        visualStability.eventsAfterBaseline === 0,
      JSON.stringify(visualStability),
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

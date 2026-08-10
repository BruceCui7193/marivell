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

interface LongTaskEntry {
  startTime: number;
  duration: number;
  name: string;
  attribution: string;
}

interface MutationCounts {
  childListAdded: number;
  childListRemoved: number;
  attributes: number;
  characterData: number;
}

interface PathResult {
  name: string;
  wallMs: number;
  timedOut: boolean;
  longTasks: LongTaskEntry[];
  mutations: MutationCounts;
  detail: Record<string, unknown>;
  error?: string;
}

interface DomClassification {
  elements: number;
  textNodes: number;
  tags: Record<string, number>;
  classes: Record<string, number>;
  decorationUniqueElements: number;
  decorationClassOccurrences: number;
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

async function installLongTaskObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as {
      __stage0LongTasks?: LongTaskEntry[];
      __stage0LongTaskObserver?: PerformanceObserver;
    };
    target.__stage0LongTasks = [];
    target.__stage0LongTaskObserver?.disconnect();
    const observer = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      for (const entry of entries) {
        const timing = entry as PerformanceEntry & {
          duration: number;
          attribution?: Array<{ name?: string; containerType?: string }>;
        };
        target.__stage0LongTasks?.push({
          startTime: timing.startTime,
          duration: timing.duration,
          name: timing.name,
          attribution: (timing.attribution ?? [])
            .map((item) => `${item.name ?? ''}:${item.containerType ?? ''}`)
            .join('|'),
        });
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
    target.__stage0LongTaskObserver = observer;
  });
}

async function clearLongTasks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as { __stage0LongTasks?: LongTaskEntry[] };
    if (target.__stage0LongTasks) {
      target.__stage0LongTasks.length = 0;
    }
  });
}

function longTaskSummary(tasks: LongTaskEntry[]): Record<string, number> {
  const over50 = tasks.filter((task) => task.duration > 50);
  const buckets = {
    '50-100ms': over50.filter((task) => task.duration <= 100).length,
    '100-200ms': over50.filter((task) => task.duration > 100 && task.duration <= 200).length,
    '200-400ms': over50.filter((task) => task.duration > 200 && task.duration <= 400).length,
    '400-800ms': over50.filter((task) => task.duration > 400 && task.duration <= 800).length,
    '800ms+': over50.filter((task) => task.duration > 800).length,
  };
  const totalMs = over50.reduce((sum, task) => sum + task.duration, 0);
  const maxMs = over50.reduce((max, task) => Math.max(max, task.duration), 0);
  return {
    count: over50.length,
    totalMs: Math.round(totalMs * 10) / 10,
    maxMs: Math.round(maxMs * 10) / 10,
    ...buckets,
  };
}

async function measureWithObservers(
  page: Page,
  name: string,
  operationBody: string,
): Promise<PathResult> {
  await clearLongTasks(page);
  const script = `(async () => {
    const longBefore = (window.__stage0LongTasks ?? []).length;
    const mutations = { childListAdded: 0, childListRemoved: 0, attributes: 0, characterData: 0 };
    const mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'childList') {
          mutations.childListAdded += record.addedNodes.length;
          mutations.childListRemoved += record.removedNodes.length;
        } else if (record.type === 'attributes') {
          mutations.attributes += 1;
        } else if (record.type === 'characterData') {
          mutations.characterData += 1;
        }
      }
    });
    mutationObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const start = performance.now();
    let detail = {};
    let timedOut = false;
    let error = null;
    try {
      const result = await (async () => { ${operationBody} })();
      detail = result ?? {};
      if (typeof result?.timedOut === 'boolean') timedOut = result.timedOut;
    } catch (err) {
      error = String(err);
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    mutationObserver.disconnect();
    const wallMs = performance.now() - start;
    const longTasks = (window.__stage0LongTasks ?? []).slice(longBefore);
    return { wallMs, timedOut, longTasks, mutations, detail, error };
  })()`;
  const result = await page.evaluate(script) as {
    wallMs: number;
    timedOut: boolean;
    longTasks: LongTaskEntry[];
    mutations: MutationCounts;
    detail: Record<string, unknown>;
    error: string | null;
  };
  return { name, ...result, error: result.error ?? undefined };
}

async function measureOpenReady(
  page: Page,
  expectedTextLength: number,
  deadlineMs: number,
): Promise<PathResult> {
  await clearLongTasks(page);
  const script = `(async () => {
    const longBefore = (window.__stage0LongTasks ?? []).length;
    const mutations = { childListAdded: 0, childListRemoved: 0, attributes: 0, characterData: 0 };
    const mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'childList') {
          mutations.childListAdded += record.addedNodes.length;
          mutations.childListRemoved += record.removedNodes.length;
        } else if (record.type === 'attributes') {
          mutations.attributes += 1;
        } else if (record.type === 'characterData') {
          mutations.characterData += 1;
        }
      }
    });
    mutationObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const start = performance.now();
    const deadline = start + ${deadlineMs};
    let timedOut = false;
    let scrollHeight = 0;
    let textLength = 0;
    while (performance.now() < deadline) {
      const loading = document.querySelector('.editor-loading');
      const surface = document.querySelector('.editor-surface');
      const frame = document.querySelector('.editor-frame');
      if (!loading && surface && frame && surface.innerText.length > ${expectedTextLength}) {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        scrollHeight = frame.scrollHeight;
        textLength = surface.innerText.length;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (scrollHeight === 0) {
      const frame = document.querySelector('.editor-frame');
      const surface = document.querySelector('.editor-surface');
      scrollHeight = frame?.scrollHeight ?? 0;
      textLength = surface?.innerText?.length ?? 0;
      timedOut = true;
    }
    mutationObserver.disconnect();
    const wallMs = performance.now() - start;
    const longTasks = (window.__stage0LongTasks ?? []).slice(longBefore);
    let timeline = null;
    try {
      timeline = await window.markdownEditor?.getBenchmarkTimeline?.() ?? null;
    } catch {
      timeline = null;
    }
    return {
      wallMs,
      timedOut,
      longTasks,
      mutations,
      detail: { scrollHeight, textLength, timeline },
    };
  })()`;
  const result = await page.evaluate(script) as {
    wallMs: number;
    timedOut: boolean;
    longTasks: LongTaskEntry[];
    mutations: MutationCounts;
    detail: Record<string, unknown>;
  };
  return { name: 'open-ready', ...result };
}

async function classifyDom(page: Page): Promise<DomClassification> {
  return page.evaluate(() => {
    const tags = { p: 0, div: 0, span: 0, pre: 0, img: 0, table: 0, svg: 0 };
    const classes = {
      'math-inline-node': 0,
      'math-node-content': 0,
      'math-node-preview': 0,
      'math-syntax-cmd': 0,
      'math-syntax-brace': 0,
      'math-syntax-special': 0,
      'math-syntax-comment': 0,
      katex: 0,
      'code-block-node': 0,
      'image-node': 0,
      'mermaid-node': 0,
      'footnote-definition-node': 0,
    };
    const all = document.querySelectorAll('*');
    let decorationUniqueElements = 0;
    let decorationClassOccurrences = 0;
    for (const element of Array.from(all)) {
      const tag = element.tagName.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(tags, tag)) {
        tags[tag as keyof typeof tags] += 1;
      }
      const classList = element.classList;
      for (const key of Object.keys(classes)) {
        if (classList.contains(key)) {
          classes[key as keyof typeof classes] += 1;
        }
      }
      let hasDecorationClass = false;
      for (const className of Array.from(classList)) {
        if (className.startsWith('math-syntax-')) {
          decorationClassOccurrences += 1;
          hasDecorationClass = true;
        }
      }
      if (hasDecorationClass) {
        decorationUniqueElements += 1;
      }
    }
    let textNodes = 0;
    const walker = document.createTreeWalker(
      document.documentElement,
      NodeFilter.SHOW_TEXT,
    );
    while (walker.nextNode()) {
      textNodes += 1;
    }
    return {
      elements: all.length,
      textNodes,
      tags,
      classes,
      decorationUniqueElements,
      decorationClassOccurrences,
    };
  });
}

function formatPathResult(result: PathResult): string {
  const long = longTaskSummary(result.longTasks);
  return [
    `path: ${result.name}`,
    `  wallMs=${Math.round(result.wallMs * 10) / 10}`,
    `  timedOut=${result.timedOut}`,
    `  longTaskCount=${long.count} totalMs=${long.totalMs} maxMs=${long.maxMs}`,
    `  longTaskBuckets=${JSON.stringify({
      '50-100': long['50-100ms'],
      '100-200': long['100-200ms'],
      '200-400': long['200-400ms'],
      '400-800': long['400-800ms'],
      '800+': long['800ms+'],
    })}`,
    `  mutations=${JSON.stringify(result.mutations)}`,
    `  detail=${JSON.stringify(result.detail)}`,
    result.error ? `  error=${result.error}` : '',
  ].filter(Boolean).join('\n');
}

async function main(): Promise<void> {
  const markdownPath = process.argv[2] || process.env.MARIVELL_STAGE0_FILE;
  if (!markdownPath || !fs.existsSync(markdownPath)) {
    throw new Error('usage: npx tsx scripts/benchmark/stage0-diagnosis.ts <markdown-file>');
  }

  const outDir = path.join(os.tmpdir(), `marivell-stage0-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-stage0-profile-${process.pid}`);
  const port = 9400 + (process.pid % 200);
  const sourceSize = fs.statSync(markdownPath).size;
  const expectedVisualTextLength = Math.min(Math.max(sourceSize * 0.35, 1_000), 500_000);
  const expectedSourceTextLength = Math.max(sourceSize * 0.5, 1_000);
  const openTimeoutMs = Number(process.env.MARIVELL_STAGE0_OPEN_TIMEOUT_MS ?? 60_000);
  const operationTimeoutMs = Number(process.env.MARIVELL_STAGE0_OP_TIMEOUT_MS ?? 60_000);

  console.log(`Stage 0 diagnosis for ${markdownPath}`);
  console.log(`sourceSize=${sourceSize} expectedVisualTextLength=${expectedVisualTextLength}`);
  console.log('Building renderer bundle...');
  await buildRenderer(outDir);

  console.log('Launching Electron...');
  const handle = await launchElectron(outDir, markdownPath, port, profile);
  const results: PathResult[] = [];

  try {
    await installLongTaskObserver(handle.page);

    const openResult = await withTimeout(
      measureOpenReady(handle.page, expectedVisualTextLength, openTimeoutMs),
      openTimeoutMs + 15_000,
      'open-ready',
    );
    if (openResult.ok) {
      results.push(openResult.value);
      console.log('\n' + formatPathResult(openResult.value));
    } else {
      results.push({
        name: 'open-ready',
        wallMs: 0,
        timedOut: true,
        longTasks: [],
        mutations: { childListAdded: 0, childListRemoved: 0, attributes: 0, characterData: 0 },
        detail: { error: 'timeout' },
      });
      console.log('open-ready timeout');
    }

    const visualDom = await classifyDom(handle.page);
    console.log('\nVisual DOM classification:');
    console.log(JSON.stringify(visualDom, null, 2));

    const typingResult = await withTimeout(
      measureWithObservers(
        handle.page,
        'typing',
        `
          const editor = window.__marivellEditor;
          const surface = document.querySelector('.editor-surface');
          if (!editor || !surface) throw new Error('editor/surface missing');
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
          if (from === -1) throw new Error('no text block');
          editor.commands.focus();
          editor.commands.setTextSelection({ from, to: from });
          const marker = 'PERF_STAGE0_TYPING_' + Date.now();
          const ok = document.execCommand('insertText', false, marker);
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\\n', '\\n');
          return { marker, applied: Boolean(ok && text.includes(marker)), containsMarker: text.includes(marker) };
        `,
      ),
      operationTimeoutMs,
      'typing',
    );

    if (typingResult.ok) {
      results.push(typingResult.value);
      console.log('\n' + formatPathResult(typingResult.value));
      await handle.page.evaluate(() => {
        const editor = window.__marivellEditor as unknown as { commands: { undo: () => boolean } };
        editor?.commands?.undo?.();
      });
    } else {
      console.log('typing timeout');
    }

    const inlineMathResult = await withTimeout(
      measureWithObservers(
        handle.page,
        'inline-math-insert',
        `
          const editor = window.__marivellEditor;
          if (!editor) throw new Error('editor missing');
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
          if (from === -1) throw new Error('no text block');
          editor.commands.setTextSelection({ from, to: from });
          const before = document.querySelectorAll('.math-inline-node').length;
          const applied = editor.chain().focus().insertInlineMath('x^2').run();
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const after = document.querySelectorAll('.math-inline-node').length;
          return { before, after, applied, inserted: after - before };
        `,
      ),
      operationTimeoutMs,
      'inline-math-insert',
    );
    if (inlineMathResult.ok) {
      results.push(inlineMathResult.value);
      console.log('\n' + formatPathResult(inlineMathResult.value));
    } else {
      console.log('inline-math-insert timeout');
    }

    const undoResult = await withTimeout(
      measureWithObservers(
        handle.page,
        'undo',
        `
          const editor = window.__marivellEditor;
          if (!editor) throw new Error('editor missing');
          const before = document.querySelectorAll('.math-inline-node').length;
          const applied = editor.commands.undo();
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const after = document.querySelectorAll('.math-inline-node').length;
          return { before, after, applied, removed: before - after };
        `,
      ),
      operationTimeoutMs,
      'undo',
    );
    if (undoResult.ok) {
      results.push(undoResult.value);
      console.log('\n' + formatPathResult(undoResult.value));
    } else {
      console.log('undo timeout');
    }

    const redoResult = await withTimeout(
      measureWithObservers(
        handle.page,
        'redo',
        `
          const editor = window.__marivellEditor;
          if (!editor) throw new Error('editor missing');
          const before = document.querySelectorAll('.math-inline-node').length;
          const applied = editor.commands.redo();
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const after = document.querySelectorAll('.math-inline-node').length;
          return { before, after, applied, added: after - before };
        `,
      ),
      operationTimeoutMs,
      'redo',
    );
    if (redoResult.ok) {
      results.push(redoResult.value);
      console.log('\n' + formatPathResult(redoResult.value));
      await handle.page.evaluate(() => {
        const editor = window.__marivellEditor as unknown as { commands: { undo: () => boolean } };
        editor?.commands?.undo?.();
      });
    } else {
      console.log('redo timeout');
    }

    const sourceSwitchResult = await withTimeout(
      measureWithObservers(
        handle.page,
        'visual-to-source',
        `
          const frame = document.querySelector('.editor-frame');
          if (!frame) throw new Error('editor frame missing');
          const start = performance.now();
          if (!frame.classList.contains('is-source')) {
            window.dispatchEvent(new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-source-mode' }));
          }
          let timedOut = false;
          let note = 'not-ready';
          const deadline = start + 60000;
          const doubleRaf = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          while (performance.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            const currentFrame = document.querySelector('.editor-frame');
            const overlay = document.querySelector('.editor-loading--mode-switch');
            const modeMatches = currentFrame?.classList.contains('is-source') ?? false;
            if (!currentFrame || !modeMatches || overlay) continue;
            const input = currentFrame.querySelector('.source-editor__input');
            const loaded = input instanceof HTMLTextAreaElement && input.value.length >= ${Math.max(expectedSourceTextLength, 1000)};
            note = loaded ? 'source-ready' : 'source-text-not-loaded';
            if (loaded) {
              await doubleRaf();
              return { timedOut: false, note, loaded };
            }
          }
          timedOut = true;
          return { timedOut, note, loaded: false };
        `,
      ),
      operationTimeoutMs,
      'visual-to-source',
    );
    if (sourceSwitchResult.ok) {
      results.push(sourceSwitchResult.value);
      console.log('\n' + formatPathResult(sourceSwitchResult.value));
    } else {
      console.log('visual-to-source timeout');
    }

    const sourceDom = await classifyDom(handle.page);
    console.log('\nSource-mode DOM classification:');
    console.log(JSON.stringify(sourceDom, null, 2));

    const visualSwitchResult = await withTimeout(
      measureWithObservers(
        handle.page,
        'source-to-visual',
        `
          const frame = document.querySelector('.editor-frame');
          if (!frame) throw new Error('editor frame missing');
          const start = performance.now();
          if (frame.classList.contains('is-source')) {
            window.dispatchEvent(new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-source-mode' }));
          }
          let timedOut = false;
          let note = 'not-ready';
          const deadline = start + 60000;
          const doubleRaf = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          while (performance.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            const currentFrame = document.querySelector('.editor-frame');
            const overlay = document.querySelector('.editor-loading--mode-switch');
            const modeMatches = !(currentFrame?.classList.contains('is-source') ?? true);
            if (!currentFrame || !modeMatches || overlay) continue;
            const surface = currentFrame.querySelector('.editor-surface');
            const proseMirror = currentFrame.querySelector('.ProseMirror');
            const editor = window.__marivellEditor;
            const loaded = Boolean(
              surface &&
              proseMirror &&
              editor &&
              !editor.isDestroyed &&
              editor.state.doc.nodeSize > ${Math.max(expectedVisualTextLength, 1000)},
            );
            note = loaded ? 'visual-ready' : 'visual-content-not-ready';
            if (loaded) {
              await doubleRaf();
              return { timedOut: false, note, loaded };
            }
          }
          timedOut = true;
          return { timedOut, note, loaded: false };
        `,
      ),
      operationTimeoutMs,
      'source-to-visual',
    );
    if (visualSwitchResult.ok) {
      results.push(visualSwitchResult.value);
      console.log('\n' + formatPathResult(visualSwitchResult.value));
    } else {
      console.log('source-to-visual timeout');
    }

    const visualDomAfter = await classifyDom(handle.page);
    console.log('\nVisual DOM classification after mode round-trip:');
    console.log(JSON.stringify(visualDomAfter, null, 2));

    const scrollResult = await withTimeout(
      measureWithObservers(
        handle.page,
        'scroll-top-middle-bottom-middle',
        `
          const frame = document.querySelector('.editor-frame');
          if (!frame || frame.classList.contains('is-source')) return { error: 'not visual mode' };
          const benchmarkWindow = window;
          if (typeof benchmarkWindow.__marivellClearFormulaHtmlCache === 'function') {
            benchmarkWindow.__marivellClearFormulaHtmlCache();
          }
          if (typeof benchmarkWindow.__marivellResetScrollAnchorCompensation === 'function') {
            benchmarkWindow.__marivellResetScrollAnchorCompensation();
          }
          if (typeof benchmarkWindow.__marivellResetHydrationSyncForTest === 'function') {
            benchmarkWindow.__marivellResetHydrationSyncForTest();
          }
          const placeholderSelectors = [
            '[data-virtual-node-id].math-block-node-placeholder',
            '[data-virtual-node-id].image-node__placeholder',
            '[data-virtual-node-id].mermaid-node__placeholder',
            '[data-virtual-node-id].html-block-placeholder',
            '[data-virtual-node-id].code-block-node--placeholder',
          ];
          const isInlineMathPlaceholder = (element) => {
            if (element.classList.contains('math-inline-node--placeholder')) return true;
            const preview = element.querySelector(':scope > .math-node-preview');
            if (!preview) return true;
            if (preview.querySelector('.katex')) return false;
            if (preview.querySelector('.katex-error')) return false;
            if (preview.querySelector('.math-node-empty-hint, .math-node-placeholder-hint') !== null) return false;
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
                if (rect.bottom > frameRect.top && rect.top < frameRect.bottom) count += 1;
              }
            }
            for (const element of frame.querySelectorAll('.math-inline-node')) {
              if (isInlineMathPlaceholder(element)) {
                const rect = element.getBoundingClientRect();
                if (rect.bottom > frameRect.top && rect.top < frameRect.bottom) count += 1;
              }
            }
            return count;
          };
          const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
          const middle = Math.round(maxScrollTop * 0.5);
          const bottom = Math.round(maxScrollTop * 0.98);
          const targets = [middle, bottom, middle];
          const beforeScrollTop = frame.scrollTop;
          frame.scrollTop = 0;
          for (const target of targets) {
            frame.scrollTop = target;
            frame.dispatchEvent(new Event('scroll'));
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
          const deadline = performance.now() + 15000;
          const doubleRaf = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          let placeholders = visiblePlaceholderCount();
          while (placeholders > 0 && performance.now() < deadline) {
            await doubleRaf();
            placeholders = visiblePlaceholderCount();
          }
          await doubleRaf();
          return {
            beforeScrollTop,
            targets,
            finalScrollTop: frame.scrollTop,
            finalTarget: targets[targets.length - 1],
            driftPx: Math.abs(frame.scrollTop - targets[targets.length - 1]),
            placeholders,
            scrollHeight: frame.scrollHeight,
            maxScrollTop: Math.max(frame.scrollHeight - frame.clientHeight, 0),
            timedOut: placeholders > 0,
          };
        `,
      ),
      operationTimeoutMs,
      'scroll-top-middle-bottom-middle',
    );
    if (scrollResult.ok) {
      results.push(scrollResult.value);
      console.log('\n' + formatPathResult(scrollResult.value));
    } else {
      console.log('scroll sequence timeout');
    }

    const contextMenuResult = await withTimeout(
      measureWithObservers(
        handle.page,
        'context-menu-open',
        `
          const target = document.querySelector('.editor-frame') ?? document.querySelector('.editor-surface');
          if (!target) throw new Error('editor target missing');
          const rect = target.getBoundingClientRect();
          const x = rect.left + Math.min(320, Math.max(120, rect.width / 2));
          const y = rect.top + Math.min(260, Math.max(120, rect.height / 2));
          const start = performance.now();
          target.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            button: 2,
          }));
          let visible = false;
          while (!visible && performance.now() - start < 30000) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            visible = Boolean(document.querySelector('.context-menu'));
          }
          return { visible, timedOut: !visible };
        `,
      ),
      operationTimeoutMs,
      'context-menu-open',
    );
    if (contextMenuResult.ok) {
      results.push(contextMenuResult.value);
      console.log('\n' + formatPathResult(contextMenuResult.value));
      await handle.page.keyboard.press('Escape').catch(() => {});
    } else {
      console.log('context-menu timeout');
    }

    console.log('\nStage 0 summary');
    for (const result of results) {
      const long = longTaskSummary(result.longTasks);
      console.log(
        `${result.name}: wall=${Math.round(result.wallMs * 10) / 10}ms longTasks=${long.count} longTaskMs=${long.totalMs} mutations=${JSON.stringify(result.mutations)}`,
      );
    }

    const output = {
      markdownPath,
      commit: process.env.GIT_COMMIT ?? '',
      node: process.version,
      platform: process.platform,
      sourceSize,
      visualDom,
      sourceDom,
      visualDomAfter,
      paths: results.map((result) => ({
        ...result,
        longTaskSummary: longTaskSummary(result.longTasks),
      })),
    };
    const outputPath = `/tmp/marivell-stage0-${path.basename(markdownPath).replace(/\.[^.]+$/, '')}.json`;
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');
    console.log(`\nSaved raw diagnosis JSON to ${outputPath}`);
  } finally {
    if (process.platform !== 'win32') {
      try {
        process.kill(-handle.child.pid, 'SIGKILL');
      } catch {
        // process group may already be gone
      }
    }
    handle.child.kill('SIGKILL');
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

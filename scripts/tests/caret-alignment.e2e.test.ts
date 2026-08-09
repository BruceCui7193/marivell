import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMarkdown } from '../../src/renderer/editor/markdown';
import { markdownOffsetToPmPos } from '../../src/renderer/editor/position-map';
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
        if (
          !loading &&
          surface &&
          frame &&
          (nodeReady || textReady)
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

async function waitForSourceInput(page: Page): Promise<HTMLTextAreaElement> {
  return page.evaluate(async () => {
    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline) {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      const input = frame?.querySelector<HTMLTextAreaElement>('.source-editor__input');
      const highlight = frame?.querySelector<HTMLElement>('.source-editor__highlight-content');
      if (
        frame?.classList.contains('is-source') &&
        input &&
        highlight &&
        highlight.textContent?.length > 0 &&
        !frame.querySelector('.editor-loading--mode-switch')
      ) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        return input;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      'source input did not appear; frame=' +
        JSON.stringify(
          document
            .querySelector<HTMLElement>('.editor-frame')
            ?.className ?? null,
        ) +
        ' inputs=' +
        document.querySelectorAll('.source-editor__input').length +
        ' overlays=' +
        document.querySelectorAll('.editor-loading--mode-switch').length +
        ' scrollTop=' +
        String(document.querySelector<HTMLElement>('.editor-frame')?.scrollTop),
    );
  });
}


async function waitForVisualMode(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      const input = frame?.querySelector<HTMLElement>('.source-editor__input');
      const overlay = frame?.querySelector<HTMLElement>('.editor-loading--mode-switch');
      if (frame && !frame.classList.contains('is-source') && !input && !overlay) {
        const firstScrollTop = frame.scrollTop;
        await new Promise((resolve) => setTimeout(resolve, 500));
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        return firstScrollTop;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('visual mode did not appear');
  });
}

interface VisualCaretResult {
  from: number;
  to: number;
  empty: boolean;
  parentType: string;
  coords: { left: number; top: number; right: number; bottom: number } | null;
  frame: { left: number; top: number; right: number; bottom: number };
  frameScrollTop: number;
  mappedPos: number | null;
  mappedInside: number | null;
  markerLeak: boolean;
  textLength: number;
}

async function setSourceSelection(
  page: Page,
  start: number,
  end: number,
  edit?: string,
): Promise<void> {
  await page.evaluate(
    async ({ start, end, edit }) => {
      const deadline = performance.now() + 20_000;
      let input: HTMLTextAreaElement | null = null;
      while (performance.now() < deadline) {
        input = document.querySelector<HTMLTextAreaElement>(".source-editor__input");
        if (input) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!input) throw new Error("source input missing");
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      if (edit !== undefined) {
        const nextValue = input.value.slice(0, start) + edit + input.value.slice(end);
        setter?.call(input, nextValue);
        input.focus();
        const caret = start + edit.length;
        input.setSelectionRange(caret, caret);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      } else {
        setter?.call(input, input.value);
        input.focus();
        input.setSelectionRange(start, end);
        input.dispatchEvent(new window.Event("select", { bubbles: true }));
      }
      const effectiveStart = edit === undefined ? start : start + edit.length;
      const textBefore = input.value.slice(0, effectiveStart);
      const targetLine = textBefore.split("\n").length;
      const lineHeight = 20;
      const visibleLines = Math.max(Math.floor(input.clientHeight / lineHeight), 1);
      const targetScrollTop = Math.max(0, (targetLine - Math.floor(visibleLines / 2)) * lineHeight);
      input.scrollTop = targetScrollTop;
      input.dispatchEvent(new window.Event("scroll", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd,
        scrollTop: input.scrollTop,
        scrollHeight: input.scrollHeight,
        clientHeight: input.clientHeight,
      };
    },
    { start, end, edit },
  );
}

async function collectVisualCaret(page: Page): Promise<VisualCaretResult> {
  return page.evaluate(async () => {
    const editor = window.__marivellEditor as {
      state: { selection: { from: number; to: number; empty: boolean; $from: { parent: { type: { name: string } } } } };
      view: {
        coordsAtPos: (pos: number) => { left: number; top: number; right: number; bottom: number } | null;
        posAtCoords: (coords: { left: number; top: number }) => { pos: number; inside: number } | null;
        domAtPos: (pos: number) => { node: Node } | null;
      };
    };
    const frame = document.querySelector<HTMLElement>(".editor-frame");
    const surface = document.querySelector<HTMLElement>(".editor-surface");
    if (!editor || !frame || !surface) throw new Error("visual editor not ready");
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );

    const selection = editor.state.selection;
    const coords = editor.view.coordsAtPos(selection.from);
    const frameRect = frame.getBoundingClientRect();
    const mapped = coords ? editor.view.posAtCoords({ left: coords.left, top: coords.top }) : null;
    return {
      from: selection.from,
      to: selection.to,
      empty: selection.empty,
      parentType: selection.$from.parent.type.name,
      coords: coords
        ? { left: coords.left, top: coords.top, right: coords.right, bottom: coords.bottom }
        : null,
      frame: {
        left: frameRect.left,
        top: frameRect.top,
        right: frameRect.right,
        bottom: frameRect.bottom,
      },
      frameScrollTop: frame.scrollTop,
      mappedPos: mapped?.pos ?? null,
      mappedInside: mapped?.inside ?? null,
      markerLeak: surface.innerText.includes("MDEDITORSELECTION"),
      textLength: surface.innerText.length,
    };
  });
}

function offsetOf(source: string, needle: string, add = 0): number {
  const index = source.indexOf(needle);
  if (index === -1) throw new Error(`needle not found: ${needle}`);
  return index + add;
}

async function startCaretScrollTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>(".editor-frame");
    const trace: Array<{ source: boolean; scrollTop: number; overlay: boolean }> = [];
    (window as unknown as Record<string, unknown>).__caretScrollTrace = trace;
    const started = performance.now();
    const timer = window.setInterval(() => {
      trace.push({
        source: frame?.classList.contains("is-source") ?? true,
        scrollTop: frame?.scrollTop ?? 0,
        overlay: Boolean(frame?.querySelector(".editor-loading--mode-switch")),
      });
      if (performance.now() - started >= 1500) {
        window.clearInterval(timer);
      }
    }, 16);
  });
}

async function readCaretScrollTrace(page: Page): Promise<Array<{ source: boolean; scrollTop: number; overlay: boolean }>> {
  return page.evaluate(() => {
    return ((window as unknown as Record<string, unknown>).__caretScrollTrace as Array<{ source: boolean; scrollTop: number; overlay: boolean }> | undefined) ?? [];
  });
}

async function main(): Promise<void> {
  console.log('\n## source->visual caret alignment e2e');
  const source = [
    '# Heading One',
    '',
    'Paragraph body with $x^2$ inline math and `code` here.',
    '',
    '> Quote line',
    '',
    '- [x] task',
    '- plain item',
    '',
    '| A | B |',
    '| --- | --- |',
    '| cell | value |',
    '',
    '```js',
    'const caretCode = 1;',
    '```',
    '',
    '$$\nblockDisplay = 1\n$$',
    '',
    'Before ![alt](./img.png "Title") after',
    '',
    'Text[^1]',
    '',
    '[^1]: footnote body',
    '',
    '## Heading Two',
    '',
    'range start paragraph',
    '',
    'range end paragraph',
  ].join('\n');

  const markdownPath = path.join(os.tmpdir(), `marivell-caret-align-${process.pid}.md`);
  fs.writeFileSync(markdownPath, source, 'utf8');
  const outDir = path.join(os.tmpdir(), `marivell-caret-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-caret-profile-${process.pid}`);
  const port = 9800 + (process.pid % 100);

  const cases: Array<{ name: string; find: (source: string) => number; endFind?: (source: string) => number; edit?: string }> = [
    { name: "document-start", find: () => 0 },
    { name: "paragraph-middle", find: (source) => source.indexOf("Paragraph body") + 6 },
    { name: "inside-inline-math", find: (source) => source.indexOf("x^2") + 1 },
    { name: "inside-code", find: (source) => source.indexOf("const") + 3 },
    { name: "inside-display-math", find: (source) => source.indexOf("blockDisplay") + 2 },
    { name: "inside-table", find: (source) => source.indexOf("cell") + 1 },
    { name: "before-image", find: (source) => source.indexOf("![alt]") },
    { name: "after-image", find: (source) => source.indexOf("after", 0) },
    { name: "inside-heading", find: (source) => source.indexOf("Heading Two") + 4 },
    { name: "document-end", find: (source) => source.length },
    { name: "deep-document-bottom", find: (source) => source.indexOf("range end") + 2 },
    {
      name: "range-across-paragraph",
      find: (source) => source.indexOf("range start paragraph"),
      endFind: (source) => source.indexOf("range end paragraph") + "range end paragraph".length,
    },
    { name: "paragraph-middle-edit", find: (source) => source.indexOf("Paragraph body") + 6, edit: " EDITED " },
    { name: "document-end-edit", find: (source) => source.length, edit: "\n\nAppended paragraph" },
    {
      name: "range-across-paragraph-edit",
      find: (source) => source.indexOf("range start paragraph"),
      endFind: (source) => source.indexOf("range end paragraph") + "range end paragraph".length,
      edit: "replacement text",
    },
  ];

  let handle: ElectronHandle | null = null;
  try {
    console.log('Building caret alignment bundle...');
    await buildRenderer(outDir);
    handle = await launchElectron(outDir, markdownPath, port, profile);

    const ready = await withTimeout(
      waitForVisualReady(handle.page, 100, 60_000),
      70_000,
      'visual-open',
    );
    assert('open caret document in visual mode', ready.ok && !ready.value.timedOut, JSON.stringify(ready));

    const onlyCase = process.env.CARET_ONLY ?? '';
  const maxRounds = Number(process.env.CARET_MAX_ROUNDS ?? 3);
  const pageErrors: string[] = [];
  handle.page.on('pageerror', (error) => {
    pageErrors.push(String(error?.stack ?? error));
  });

  for (const testCase of cases) {
    if (onlyCase && testCase.name !== onlyCase) continue;
    for (let round = 1; round <= (testCase.edit ? 1 : maxRounds); round += 1) {
      const prefix = `${testCase.name} r${round}`;
      await toggleSource(handle.page);
      await waitForSourceInput(handle.page);
      const sourceText = await handle.page.evaluate(
        () => document.querySelector<HTMLTextAreaElement>(".source-editor__input")?.value ?? "",
      );
      const start = testCase.find(sourceText);
      const end = testCase.endFind?.(sourceText) ?? start;
      const edit = testCase.edit;
      const effectiveSource = edit === undefined ? sourceText : sourceText.slice(0, start) + edit + sourceText.slice(end);
      const caretStart = edit === undefined ? start : start + edit.length;
      const caretEnd = edit === undefined ? end : caretStart;
      const expected = (() => {
        try {
          const parsed = parseMarkdown(effectiveSource);
          const from = markdownOffsetToPmPos(effectiveSource, parsed, caretStart);
          const to = markdownOffsetToPmPos(effectiveSource, parsed, caretEnd);
          return from === null || to === null ? null : { from, to };
        } catch {
          return null;
        }
      })();
      await setSourceSelection(handle.page, start, end, edit);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await startCaretScrollTrace(handle.page);
      await toggleSource(handle.page);
      await waitForVisualMode(handle.page);
      const scrollTrace = await readCaretScrollTrace(handle.page);
      const firstVisualTrace = scrollTrace.find((entry) => !entry.source);
      if (pageErrors.length > 0) {
        throw new Error(`PAGE_ERRORS=${pageErrors.join("\n---\n")}`);
      }
      const result = await collectVisualCaret(handle.page);

      const isRange = testCase.endFind !== undefined && edit === undefined;
      assert(
        `${prefix}: visual selection survives source->visual`,
        result.from >= 0 &&
          result.to >= result.from &&
          (isRange ? result.to > result.from : result.empty),
        JSON.stringify(result),
      );
      if (expected) {
        assert(
          `${prefix}: visual selection matches expected PM range`,
          Math.abs(result.from - expected.from) <= 1 &&
            Math.abs(result.to - expected.to) <= 1,
          JSON.stringify({ expected, result }),
        );
      }
      assert(
        `${prefix}: caret coords exist`,
        result.coords !== null,
        JSON.stringify(result),
      );
      if (result.coords) {
        assert(
          `${prefix}: caret coords inside editor frame`,
          result.coords.left >= result.frame.left - 2 &&
            result.coords.right <= result.frame.right + 2 &&
            result.coords.top >= result.frame.top - 2 &&
            result.coords.bottom <= result.frame.bottom + 2,
          JSON.stringify(result),
        );
      }
      assert(
        `${prefix}: posAtCoords maps back near selection`,
        result.mappedPos !== null &&
          Math.abs(result.mappedPos - result.from) <= 8,
        JSON.stringify(result),
      );
      assert(
        `${prefix}: no marker leak and visual text rendered`,
        !result.markerLeak && result.textLength > 0,
        JSON.stringify(result),
      );
      if (
        testCase.name === "before-image" ||
        testCase.name === "after-image" ||
        testCase.name === "document-end" ||
        testCase.name === "document-end-edit" ||
        testCase.name === "deep-document-bottom" ||
        testCase.name === "range-across-paragraph" ||
        testCase.name === "range-across-paragraph-edit"
      ) {
        assert(
          `${prefix}: first visual frame starts at caret scroll, not top`,
          firstVisualTrace !== undefined && firstVisualTrace.scrollTop > 0,
          `firstVisualTrace=${JSON.stringify(firstVisualTrace)} trace=${JSON.stringify(scrollTrace.slice(0, 8))}`,
        );
      }
    }
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

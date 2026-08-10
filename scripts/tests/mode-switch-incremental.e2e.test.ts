import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { parseMarkdown } from '../../src/renderer/editor/markdown';
import { markdownOffsetToPmPos } from '../../src/renderer/editor/position-map';

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

async function waitForVisualReady(page: Page, expectedTextLength: number): Promise<void> {
  await page.evaluate(
    async ({ expectedLength }) => {
      const deadline = performance.now() + 30_000;
      while (performance.now() < deadline) {
        const loading = document.querySelector('.editor-loading');
        const surface = document.querySelector('.editor-surface');
        const editor = window.__marivellEditor as { state?: { doc?: { nodeSize?: number } } } | undefined;
        const nodeReady = Boolean(editor?.state?.doc && editor.state.doc.nodeSize > 100);
        if (!loading && surface && (nodeReady || surface.innerText.length >= expectedLength)) {
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('visual editor did not become ready');
    },
    { expectedLength: expectedTextLength },
  );
}

async function toggleSource(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-source-mode' }),
    );
  });
}

async function waitForSourceInput(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline) {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      const input = frame?.querySelector<HTMLTextAreaElement>('.source-editor__input');
      const overlay = frame?.querySelector<HTMLElement>('.editor-loading--mode-switch');
      if (frame?.classList.contains('is-source') && input && !overlay) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return input.value;
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
        const editor = window.__marivellEditor as { isDestroyed?: boolean; state?: { doc?: { nodeSize?: number } } } | undefined;
        if (editor && !editor.isDestroyed && editor.state?.doc && editor.state.doc.nodeSize > 100) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('visual mode did not appear');
  });
}

async function readModeSwitchCounters(page: Page): Promise<{ fast: number; full: number }> {
  return page.evaluate(() => {
    const target = window as unknown as Record<string, number | undefined>;
    return {
      fast: target.__marivellModeSwitchFastPath ?? 0,
      full: target.__marivellModeSwitchFullParse ?? 0,
    };
  });
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
        input = document.querySelector<HTMLTextAreaElement>('.source-editor__input');
        if (input) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!input) throw new Error('source input missing');
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      if (edit !== undefined) {
        const nextValue = input.value.slice(0, start) + edit + input.value.slice(end);
        setter?.call(input, nextValue);
        input.focus();
        const caret = start + edit.length;
        input.setSelectionRange(caret, caret);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      } else {
        setter?.call(input, input.value);
        input.focus();
        input.setSelectionRange(start, end);
        input.dispatchEvent(new window.Event('select', { bubbles: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    },
    { start, end, edit },
  );
}

async function collectVisualCaret(page: Page): Promise<{
  from: number;
  to: number;
  markerLeak: boolean;
  editorText: string;
}> {
  return page.evaluate(() => {
    const editor = window.__marivellEditor as {
      state: { selection: { from: number; to: number } };
      getJSON: () => unknown;
    };
    const surface = document.querySelector<HTMLElement>('.editor-surface');
    if (!editor || !surface) throw new Error('visual editor not ready');
    const selection = editor.state.selection;
    return {
      from: selection.from,
      to: selection.to,
      markerLeak:
        surface.innerText.includes('MDEDITORSELECTION') ||
        JSON.stringify(editor.getJSON()).includes('MDEDITORSELECTION'),
      editorText: surface.innerText,
    };
  });
}

async function main(): Promise<void> {
  console.log('\n## incremental mode-switch e2e');
  const source = [
    '# Heading One',
    '',
    'Paragraph body with $x^2$ and `code` here.',
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
    'const code = 1;',
    '```',
    '',
    '## Heading Two',
    '',
    'range start paragraph',
    '',
    'range end paragraph',
  ].join('\n');

  const markdownPath = path.join(os.tmpdir(), `marivell-incremental-${process.pid}.md`);
  fs.writeFileSync(markdownPath, source, 'utf8');
  const outDir = path.join(os.tmpdir(), `marivell-incremental-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-incremental-profile-${process.pid}`);
  const port = 9700 + (process.pid % 200);

  let handle: ElectronHandle | null = null;
  try {
    console.log('Building incremental mode-switch bundle...');
    await buildRenderer(outDir);
    handle = await launchElectron(outDir, markdownPath, port, profile);
    await waitForVisualReady(handle.page, 100);

    const noEditBefore = await readModeSwitchCounters(handle.page);
    await toggleSource(handle.page);
    const sourceValue = await waitForSourceInput(handle.page);
    assert(
      'source mode preserves original markdown after visual->source',
      sourceValue === source,
      JSON.stringify({ sourceValue, source }),
    );
    await toggleSource(handle.page);
    await waitForVisualMode(handle.page);
    const noEditAfter = await readModeSwitchCounters(handle.page);
    assert(
      'no-edit source->visual uses fast path without full parse',
      noEditAfter.fast > noEditBefore.fast && noEditAfter.full === noEditBefore.full,
      JSON.stringify({ before: noEditBefore, after: noEditAfter }),
    );
    const noEditVisual = await collectVisualCaret(handle.page);
    assert(
      'no-edit visual content is clean and rendered',
      noEditVisual.editorText.includes('Paragraph body') && !noEditVisual.markerLeak,
      JSON.stringify(noEditVisual),
    );

    await toggleSource(handle.page);
    await waitForSourceInput(handle.page);
    const editStart = source.indexOf('Paragraph body') + 6;
    const editEnd = editStart;
    const paragraphEdit = ' INCREMENTAL_EDIT ';
    await setSourceSelection(handle.page, editStart, editEnd, paragraphEdit);
    const editedSource = `${source.slice(0, editStart)}${paragraphEdit}${source.slice(editEnd)}`;
    const caretStart = editStart + paragraphEdit.length;
    const expected = (() => {
      try {
        return markdownOffsetToPmPos(editedSource, parseMarkdown(editedSource), caretStart);
      } catch {
        return null;
      }
    })();
    const paragraphBefore = await readModeSwitchCounters(handle.page);
    await toggleSource(handle.page);
    await waitForVisualMode(handle.page);
    const paragraphAfter = await readModeSwitchCounters(handle.page);
    const paragraphVisual = await collectVisualCaret(handle.page);
    assert(
      'paragraph-local source edit is reflected in visual',
      paragraphVisual.editorText.includes('INCREMENTAL_EDIT'),
      JSON.stringify(paragraphVisual),
    );
    assert(
      'paragraph-local source edit uses incremental fast path without full parse',
      paragraphAfter.fast > paragraphBefore.fast &&
        paragraphAfter.full === paragraphBefore.full,
      JSON.stringify({ before: paragraphBefore, after: paragraphAfter }),
    );
    if (expected !== null) {
      assert(
        'paragraph-local caret maps to the edited paragraph',
        Math.abs(paragraphVisual.from - expected) <= 1,
        JSON.stringify({ expected, visual: paragraphVisual }),
      );
    }
    assert(
      'paragraph-local visual content is clean',
      !paragraphVisual.markerLeak,
      JSON.stringify(paragraphVisual),
    );

    await toggleSource(handle.page);
    await waitForSourceInput(handle.page);
    const crossEdit = `\n\n## Inserted Heading\n\nInserted paragraph\n`;
    await setSourceSelection(handle.page, editedSource.length, editedSource.length, crossEdit);
    const crossSource = `${editedSource}${crossEdit}`;
    const crossBefore = await readModeSwitchCounters(handle.page);
    await toggleSource(handle.page);
    await waitForVisualMode(handle.page);
    const crossAfter = await readModeSwitchCounters(handle.page);
    const crossVisual = await collectVisualCaret(handle.page);
    assert(
      'cross-block source edit is reflected in visual',
      crossVisual.editorText.includes('Inserted Heading') &&
        crossVisual.editorText.includes('Inserted paragraph'),
      JSON.stringify(crossVisual),
    );
    assert(
      'cross-block source edit uses measured full-parse fallback',
      crossAfter.full > crossBefore.full,
      JSON.stringify({ before: crossBefore, after: crossAfter }),
    );
    assert(
      'cross-block visual content is clean',
      !crossVisual.markerLeak,
      JSON.stringify(crossVisual),
    );

    for (let round = 0; round < 3; round += 1) {
      const before = await readModeSwitchCounters(handle.page);
      await toggleSource(handle.page);
      const repeatedSource = await waitForSourceInput(handle.page);
      await toggleSource(handle.page);
      await waitForVisualMode(handle.page);
      const after = await readModeSwitchCounters(handle.page);
      const repeatedVisual = await collectVisualCaret(handle.page);
      assert(
        `repeated switch r${round} keeps source and visual aligned`,
        repeatedSource === crossSource &&
          repeatedVisual.editorText.includes('Inserted Heading') &&
          !repeatedVisual.markerLeak &&
          after.fast > before.fast &&
          after.full === before.full,
        JSON.stringify({
          before,
          after,
          sourceLen: repeatedSource.length,
          visual: repeatedVisual,
        }),
      );
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

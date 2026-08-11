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
      const start = performance.now();
      const deadline = start + deadlineMs;
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

async function toggleSource(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-source-mode' }),
    );
  });
}

async function waitForSourceInput(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      const input = frame?.querySelector<HTMLTextAreaElement>('.source-editor__input');
      const overlay = frame?.querySelector<HTMLElement>('.editor-loading--mode-switch');
      if (frame?.classList.contains('is-source') && input && !overlay) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        return input.value;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('source input did not appear');
  });
}

async function waitForVisualWithTrace(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const frame = document.querySelector<HTMLElement>('.editor-frame');
    if (!frame) {
      throw new Error('editor frame missing');
    }
    const deadline = performance.now() + 30_000;
    let firstVisualScrollTop = 0;
    while (performance.now() < deadline) {
      const currentFrame = document.querySelector<HTMLElement>('.editor-frame');
      const input = currentFrame?.querySelector<HTMLElement>('.source-editor__input');
      const overlay = currentFrame?.querySelector<HTMLElement>('.editor-loading--mode-switch');
      if (
        currentFrame &&
        !currentFrame.classList.contains('is-source') &&
        !input &&
        !overlay
      ) {
        if (firstVisualScrollTop === 0) {
          firstVisualScrollTop = currentFrame.scrollTop;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        return firstVisualScrollTop;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('visual mode did not appear');
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
      const effectiveStart = edit === undefined ? start : start + (edit?.length ?? 0);
      const textBefore = input.value.slice(0, effectiveStart);
      const targetLine = textBefore.split('\n').length;
      const lineHeight = 20;
      const visibleLines = Math.max(Math.floor(input.clientHeight / lineHeight), 1);
      input.scrollTop = Math.max(
        0,
        (targetLine - Math.floor(visibleLines / 2)) * lineHeight,
      );
      input.dispatchEvent(new window.Event('scroll', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 500));
    },
    { start, end, edit },
  );
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

async function collectVisualState(page: Page, marker: string): Promise<Record<string, unknown>> {
  return page.evaluate((searchText) => {
    const editor = window.__marivellEditor as {
      state: {
        selection: { from: number; to: number; empty: boolean };
        doc: { content: { size: number }; textBetween: (from: number, to: number) => string };
      };
      view: { coordsAtPos: (pos: number) => { left: number; top: number; right: number; bottom: number } | null };
      getJSON: () => unknown;
    };
    const frame = document.querySelector<HTMLElement>('.editor-frame');
    const surface = document.querySelector<HTMLElement>('.editor-surface');
    if (!editor || !frame || !surface) throw new Error('visual editor missing');
    const { from, to } = editor.state.selection;
    const size = editor.state.doc.content.size;
    const selectionText = editor.state.doc.textBetween(
      Math.max(0, from - 80),
      Math.min(size, to + 80),
      '\n',
    );
    const coords = editor.view.coordsAtPos(from);
    const frameRect = frame.getBoundingClientRect();
    const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
    return {
      containsMarker: editor.state.doc.textBetween(0, size, '\n').includes(searchText),
      markerLeak:
        surface.innerText.includes('MDEDITORSELECTION') ||
        JSON.stringify(editor.getJSON()).includes('MDEDITORSELECTION'),
      selectionInsideMarker: selectionText.includes(searchText),
      selectionEmpty: editor.state.selection.empty,
      caretInFrame: Boolean(
        coords &&
          coords.left >= frameRect.left - 2 &&
          coords.right <= frameRect.right + 2 &&
          coords.top >= frameRect.top - 2 &&
          coords.bottom <= frameRect.bottom + 2,
      ),
      scrollRatio: maxScrollTop > 0 ? frame.scrollTop / maxScrollTop : 0,
    };
  }, marker);
}

async function main(): Promise<void> {
  console.log('\n## large-file mode-switch layout e2e');
  const envFile = process.env.MARIVELL_E2E_FILE ?? '';
  const source = envFile && fs.existsSync(envFile)
    ? fs.readFileSync(envFile, 'utf8')
    : Array.from(
        { length: 1800 },
        (_, index) =>
          `## Section ${index}\n\nParagraph ${index} has $\\frac{x_{${index}}}{y_{${index}}}$ and enough text for a scrollable large-file mode-switch test: ${index} ${index} ${index}.\n`,
      ).join('\n');
  const markdownPath = envFile && fs.existsSync(envFile)
    ? envFile
    : path.join(os.tmpdir(), `marivell-mode-switch-large-${process.pid}.md`);
  if (!envFile || !fs.existsSync(envFile)) {
    fs.writeFileSync(markdownPath, source, 'utf8');
  }

  const outDir = path.join(os.tmpdir(), `marivell-mode-switch-large-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-mode-switch-large-profile-${process.pid}`);
  const port = 9700 + (process.pid % 100);
  let handle: ElectronHandle | null = null;

  try {
    console.log('Building large-file mode-switch bundle...');
    await buildRenderer(outDir);
    handle = await launchElectron(outDir, markdownPath, port, profile);
    await waitForVisualReady(
      handle.page,
      Math.min(Math.max(source.length * 0.5, 10_000), 500_000),
      60_000,
    );

    const bottomSwitch = await handle.page.evaluate(async () => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      if (!frame) throw new Error('editor frame missing');
      const max = Math.max(frame.scrollHeight - frame.clientHeight, 0);
      frame.scrollTop = max;
      frame.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const visualRatio = max > 0 ? frame.scrollTop / max : 0;
      window.dispatchEvent(
        new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-source-mode' }),
      );
      const sourceDeadline = performance.now() + 30_000;
      while (performance.now() < sourceDeadline) {
        const input = document.querySelector<HTMLTextAreaElement>('.source-editor__input');
        const overlay = document.querySelector<HTMLElement>('.editor-loading--mode-switch');
        if (input && !overlay) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const input = document.querySelector<HTMLTextAreaElement>('.source-editor__input');
      if (!input) throw new Error('source input missing');
      const sourceMax = Math.max(input.scrollHeight - input.clientHeight, 0);
      const sourceRatio = sourceMax > 0 ? input.scrollTop / sourceMax : 0;
      window.dispatchEvent(
        new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-source-mode' }),
      );
      const visualDeadline = performance.now() + 30_000;
      let firstVisualRatio = 0;
      while (performance.now() < visualDeadline) {
        const currentFrame = document.querySelector<HTMLElement>('.editor-frame');
        const currentInput = currentFrame?.querySelector<HTMLElement>('.source-editor__input');
        if (
          currentFrame &&
          !currentFrame.classList.contains('is-source') &&
          !currentInput &&
          !currentFrame.querySelector('.editor-loading--mode-switch')
        ) {
          const currentMax = Math.max(currentFrame.scrollHeight - currentFrame.clientHeight, 0);
          if (firstVisualRatio === 0 && currentMax > 0) {
            firstVisualRatio = currentFrame.scrollTop / currentMax;
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
          const finalMax = Math.max(currentFrame.scrollHeight - currentFrame.clientHeight, 0);
          return {
            visualRatio,
            sourceRatio,
            firstVisualRatio,
            finalVisualRatio: finalMax > 0 ? currentFrame.scrollTop / finalMax : 0,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('visual mode did not return after bottom scroll');
    });
    assert(
      'bottom scroll survives visual-to-source-to-visual',
      bottomSwitch.visualRatio > 0.9 &&
        bottomSwitch.sourceRatio > 0.9 &&
        bottomSwitch.firstVisualRatio > 0.9 &&
        bottomSwitch.finalVisualRatio > 0.9,
      JSON.stringify(bottomSwitch),
    );

    const anchorMatch = source.match(/^[^\n]{10,}/m);
    const anchor = anchorMatch?.[0] ?? 'the';
    const editOffset = Math.min(
      Math.max(0, source.indexOf(anchor) + Math.min(6, Math.floor(anchor.length / 2))),
      source.length,
    );
    const marker = ' MODE_SWITCH_LARGE_MARK ';
    await toggleSource(handle.page);
    await waitForSourceInput(handle.page);
    await setSourceSelection(handle.page, editOffset, editOffset, marker);
    const sourceText = await handle.page.evaluate(
      () => document.querySelector<HTMLTextAreaElement>('.source-editor__input')?.value ?? '',
    );
    await toggleSource(handle.page);
    await waitForVisualWithTrace(handle.page);
    const visualAfterEdit = await collectVisualState(handle.page, marker);
    assert(
      'source edit is visible in visual content',
      Boolean(visualAfterEdit.containsMarker),
      JSON.stringify(visualAfterEdit),
    );
    assert(
      'visual caret after source edit is inside the edited text',
      Boolean(visualAfterEdit.selectionInsideMarker) &&
        Boolean(visualAfterEdit.selectionEmpty) &&
        Boolean(visualAfterEdit.caretInFrame),
      JSON.stringify(visualAfterEdit),
    );
    assert(
      'source edit switches back without marker leakage',
      !visualAfterEdit.markerLeak,
      JSON.stringify(visualAfterEdit),
    );
    assert(
      'source edit did not lose document content',
      sourceText.includes(marker) && visualAfterEdit.containsMarker,
      `sourceLen=${sourceText.length}`,
    );

    const countersBeforeRepeat = await readModeSwitchCounters(handle.page);
    for (let round = 0; round < 3; round += 1) {
      await toggleSource(handle.page);
      const repeatedSource = await waitForSourceInput(handle.page);
      await toggleSource(handle.page);
      await waitForVisualWithTrace(handle.page);
      const countersAfter = await readModeSwitchCounters(handle.page);
      const repeated = await handle.page.evaluate(() => {
        const editor = window.__marivellEditor as { getJSON: () => unknown };
        return {
          markerLeak: JSON.stringify(editor.getJSON()).includes('MDEDITORSELECTION'),
          bodyHasMarker: document.body.innerText.includes('MODE_SWITCH_LARGE_MARK'),
        };
      });
      assert(
        `repeated large-file switch r${round} stays clean and fast`,
        repeatedSource.includes(marker) &&
          repeated.bodyHasMarker &&
          !repeated.markerLeak &&
          countersAfter.fast > countersBeforeRepeat.fast &&
          countersAfter.full === countersBeforeRepeat.full,
        JSON.stringify({ countersBefore: countersBeforeRepeat, countersAfter, repeated }),
      );
    }

    const undoRedo = await handle.page.evaluate(async () => {
      const editor = window.__marivellEditor as {
        commands: { undo: () => boolean; redo: () => boolean; focus: () => boolean };
        state: { doc: { content: { size: number }; textBetween: (from: number, to: number) => string } };
      };
      const surface = document.querySelector<HTMLElement>('.editor-surface');
      if (!editor || !surface) throw new Error('visual editor missing');
      editor.chain().focus().insertContent(' VISUAL_ONLY_MARK ').run();
      const deadline = performance.now() + 30_000;
      while (
        !editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n').includes('VISUAL_ONLY_MARK') &&
        performance.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const beforeUndo = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n');
      editor.commands.undo();
      const afterUndo = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n');
      editor.commands.redo();
      const afterRedo = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n');
      return {
        visualMarkBefore: beforeUndo.includes('VISUAL_ONLY_MARK'),
        visualMarkUndone: !afterUndo.includes('VISUAL_ONLY_MARK'),
        visualMarkRedone: afterRedo.includes('VISUAL_ONLY_MARK'),
        sourceMarkKept:
          beforeUndo.includes('MODE_SWITCH_LARGE_MARK') &&
          afterUndo.includes('MODE_SWITCH_LARGE_MARK') &&
          afterRedo.includes('MODE_SWITCH_LARGE_MARK'),
      };
    });
    assert(
      'undo/redo after mode switch only affects the user edit',
      undoRedo.visualMarkBefore &&
        undoRedo.visualMarkUndone &&
        undoRedo.visualMarkRedone &&
        undoRedo.sourceMarkKept,
      JSON.stringify(undoRedo),
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
      if (!process.env.MARIVELL_E2E_FILE) {
        fs.rmSync(markdownPath, { force: true });
      }
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

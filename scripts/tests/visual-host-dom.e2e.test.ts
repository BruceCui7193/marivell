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

async function waitForVisualReady(page: Page, expectedTextLength: number): Promise<void> {
  await page.evaluate(
    async ({ expectedLength }) => {
      const deadline = performance.now() + 60_000;
      while (performance.now() < deadline) {
        const loading = document.querySelector('.editor-loading');
        const surface = document.querySelector('.editor-surface');
        const frame = document.querySelector('.editor-frame');
        const editor = window.__marivellEditor as { state?: { doc?: { nodeSize?: number } } } | undefined;
        const nodeReady = Boolean(editor?.state?.doc && editor.state.doc.nodeSize > expectedLength);
        const textReady = Boolean(surface && surface.innerText.length > Math.min(expectedLength, 100_000));
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

async function waitForVisualMode(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      const input = frame?.querySelector<HTMLElement>('.source-editor__input');
      const overlay = frame?.querySelector<HTMLElement>('.editor-loading--mode-switch');
      if (frame && !frame.classList.contains('is-source') && !input && !overlay) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('visual mode did not appear');
  });
}

interface HostSnapshot {
  elements: number;
  textNodes: number;
  tags: Record<string, number>;
  classes: Record<string, number>;
  inlineActive: number;
  inlinePlaceholder: number;
  katexCount: number;
  syntaxCount: number;
  contentDomCount: number;
}

async function classifyVisualHost(page: Page): Promise<HostSnapshot> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.editor-host');
    if (!host) {
      throw new Error('.editor-host missing');
    }
    const all = Array.from(host.querySelectorAll('*'));
    const tags: Record<string, number> = {};
    const classes: Record<string, number> = {};
    for (const element of all) {
      const tag = element.tagName.toLowerCase();
      tags[tag] = (tags[tag] ?? 0) + 1;
      const classList = element.classList;
      for (const key of [
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
      ]) {
        if (classList.contains(key)) {
          classes[key] = (classes[key] ?? 0) + 1;
        }
      }
    }
    let textNodes = 0;
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      textNodes += 1;
    }
    const inlineNodes = Array.from(host.querySelectorAll<HTMLElement>('.math-inline-node'));
    return {
      elements: all.length,
      textNodes,
      tags,
      classes,
      inlineActive: inlineNodes.filter((node) =>
        node.querySelector(':scope > .math-node-preview .katex'),
      ).length,
      inlinePlaceholder: inlineNodes.filter((node) =>
        node.classList.contains('math-inline-node--placeholder'),
      ).length,
      katexCount: host.querySelectorAll('.math-node-preview .katex').length,
      syntaxCount: host.querySelectorAll('[class*="math-syntax-"]').length,
      contentDomCount: host.querySelectorAll('.math-node-content').length,
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
      await new Promise((resolve) => setTimeout(resolve, 400));
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

async function main(): Promise<void> {
  console.log('\n## visual host DOM reduction e2e');
  const lines: string[] = [];
  for (let index = 0; index < 1800; index += 1) {
    lines.push(
      `## Section ${index}`,
      '',
      `Paragraph ${index} has $\\frac{x_{${index}}}{y_{${index}}}$ and filler text that keeps this file over the worker threshold while preserving many formula node views: ${index} ${index} ${index}.`,
      '',
    );
  }
  const source = lines.join('\n');
  const markdownPath = path.join(os.tmpdir(), `marivell-visual-host-dom-${process.pid}.md`);
  fs.writeFileSync(markdownPath, source, 'utf8');

  const outDir = path.join(os.tmpdir(), `marivell-visual-host-dom-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-visual-host-dom-profile-${process.pid}`);
  const port = 9400 + (process.pid % 200);

  let handle: ElectronHandle | null = null;
  try {
    console.log('Building visual host DOM e2e bundle...');
    await buildRenderer(outDir);
    handle = await launchElectron(outDir, markdownPath, port, profile);
    await waitForVisualReady(handle.page, Math.min(source.length * 0.5, 500_000));

    const visualBefore = await classifyVisualHost(handle.page);
    assert(
      'visual host preserves normal paragraph and contentDOM structure before source mode',
      visualBefore.contentDomCount > 1000 && visualBefore.tags.p > 1000,
      JSON.stringify({ tags: visualBefore.tags, classes: visualBefore.classes }),
    );

    await toggleSource(handle.page);
    const sourceValue = await waitForSourceInput(handle.page);
    assert(
      'source mode preserves the exact source text',
      sourceValue === source,
      `len=${sourceValue.length}/${source.length}`,
    );

    const sourceHost = await classifyVisualHost(handle.page);
    console.log(
      `  visualHostBefore=${visualBefore.elements} sourceHost=${sourceHost.elements} katex=${sourceHost.katexCount} syntax=${sourceHost.syntaxCount} inlinePlaceholder=${sourceHost.inlinePlaceholder}`,
    );
    assert(
      'source mode visual host subtree stays below 100k DOM nodes',
      sourceHost.elements < 100_000,
      `elements=${sourceHost.elements} text=${sourceHost.textNodes}`,
    );
    assert(
      'source mode drops rendered KaTeX and syntax decoration from visual host',
      sourceHost.katexCount === 0 && sourceHost.syntaxCount === 0,
      JSON.stringify(sourceHost.classes),
    );
    assert(
      'source mode keeps formula contentDOM text intact as lightweight placeholders',
      sourceHost.contentDomCount === visualBefore.contentDomCount &&
        sourceHost.inlinePlaceholder > 0,
      `content=${sourceHost.contentDomCount}/${visualBefore.contentDomCount} placeholder=${sourceHost.inlinePlaceholder}`,
    );

    const editOffset = source.indexOf('Paragraph 500') + 6;
    const sourceMarker = ' VISUAL_HOST_EDIT ';
    const editedSource = `${source.slice(0, editOffset)}${sourceMarker}${source.slice(editOffset)}`;
    await setSourceSelection(handle.page, editOffset, editOffset, sourceMarker);
    await handle.page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>('.source-editor__input');
      if (!input) return;
      const maxScrollTop = Math.max(input.scrollHeight - input.clientHeight, 0);
      input.scrollTop = Math.round(maxScrollTop * 0.8);
      input.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    const sourceRatioBeforeVisual = await handle.page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>('.source-editor__input');
      if (!input) return 0;
      const max = Math.max(input.scrollHeight - input.clientHeight, 0);
      return max > 0 ? input.scrollTop / max : 0;
    });
    await toggleSource(handle.page);
    await waitForVisualMode(handle.page);

    const visualAfterEdit = await handle.page.evaluate(() => {
      const editor = window.__marivellEditor as {
        state: { doc: { textBetween: (from: number, to: number) => string } };
        getJSON: () => unknown;
      };
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      const surface = document.querySelector<HTMLElement>('.editor-surface');
      const max = frame ? Math.max(frame.scrollHeight - frame.clientHeight, 0) : 0;
      return {
        contains: editor.state.doc.textBetween(0, editor.state.doc.content.size).includes('VISUAL_HOST_EDIT'),
        markerLeak:
          Boolean(surface?.innerText.includes('MDEDITORSELECTION')) ||
          JSON.stringify(editor.getJSON()).includes('MDEDITORSELECTION'),
        scrollRatio: frame && max > 0 ? frame.scrollTop / max : 0,
      };
    });
    assert(
      'source edit is reflected in visual content without marker leakage',
      visualAfterEdit.contains && !visualAfterEdit.markerLeak,
      JSON.stringify(visualAfterEdit),
    );
    assert(
      'source to visual restores the preserved scroll ratio',
      Math.abs(visualAfterEdit.scrollRatio - sourceRatioBeforeVisual) < 0.06,
      `source=${sourceRatioBeforeVisual} visual=${visualAfterEdit.scrollRatio}`,
    );

    const undoRedo = await handle.page.evaluate(async () => {
      const editor = window.__marivellEditor as {
        commands: { undo: () => boolean; redo: () => boolean; focus: () => boolean };
        state: { doc: { textBetween: (from: number, to: number) => string } };
      };
      const surface = document.querySelector<HTMLElement>('.editor-surface');
      if (!editor || !surface) throw new Error('visual editor missing');
      editor.commands.focus();
      document.execCommand('insertText', false, ' VISUAL_UNDO_MARK ');
      const deadline = performance.now() + 30_000;
      while (!editor.state.doc.textBetween(0, editor.state.doc.content.size).includes('VISUAL_UNDO_MARK') && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const beforeUndo = editor.state.doc.textBetween(0, editor.state.doc.content.size);
      editor.commands.undo();
      const afterUndo = editor.state.doc.textBetween(0, editor.state.doc.content.size);
      editor.commands.redo();
      const afterRedo = editor.state.doc.textBetween(0, editor.state.doc.content.size);
      return {
        beforeHas: beforeUndo.includes('VISUAL_UNDO_MARK'),
        undoRemoved: !afterUndo.includes('VISUAL_UNDO_MARK'),
        redoRestored: afterRedo.includes('VISUAL_UNDO_MARK'),
        sourceEditKept: beforeUndo.includes('VISUAL_HOST_EDIT') &&
          afterUndo.includes('VISUAL_HOST_EDIT') &&
          afterRedo.includes('VISUAL_HOST_EDIT'),
      };
    });
    assert(
      'undo/redo work normally after source to visual switch',
      undoRedo.beforeHas && undoRedo.undoRemoved && undoRedo.redoRestored && undoRedo.sourceEditKept,
      JSON.stringify(undoRedo),
    );

    for (let round = 0; round < 3; round += 1) {
      const countersBefore = await readModeSwitchCounters(handle.page);
      await toggleSource(handle.page);
      const repeatedSource = await waitForSourceInput(handle.page);
      await toggleSource(handle.page);
      await waitForVisualMode(handle.page);
      const countersAfter = await readModeSwitchCounters(handle.page);
      const repeated = await handle.page.evaluate(() => {
        const editor = window.__marivellEditor as { getJSON: () => unknown };
        return {
          sourceMarker: document.body.innerText.includes('VISUAL_HOST_EDIT'),
          markerLeak: JSON.stringify(editor.getJSON()).includes('MDEDITORSELECTION'),
        };
      });
      assert(
        `repeated switch r${round} keeps content clean and uses fast path`,
        repeatedSource.includes('VISUAL_HOST_EDIT') &&
          repeated.sourceMarker &&
          !repeated.markerLeak &&
          countersAfter.fast > countersBefore.fast &&
          countersAfter.full === countersBefore.full,
        JSON.stringify({ countersBefore, countersAfter, repeated }),
      );
    }

    await handle.page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      if (!frame) return;
      const max = Math.max(frame.scrollHeight - frame.clientHeight, 0);
      frame.scrollTop = Math.round(max * 0.5);
      frame.dispatchEvent(new Event('scroll'));
    });
    const activation = await withTimeout(
      handle.page.waitForFunction(() => {
        const frame = document.querySelector<HTMLElement>('.editor-frame');
        if (!frame) return false;
        const frameRect = frame.getBoundingClientRect();
        return Array.from(frame.querySelectorAll<HTMLElement>('.math-inline-node')).some((node) => {
          const rect = node.getBoundingClientRect();
          return (
            rect.bottom > frameRect.top &&
            rect.top < frameRect.bottom &&
            node.querySelector(':scope > .math-node-preview .katex') !== null
          );
        });
      }, undefined, { timeout: 15_000 }),
      20_000,
      'visible formula activation',
    );
    assert('returning to visual activates formulas in the viewport', activation.ok, activation.label);
    const placeholderClear = await withTimeout(
      handle.page.waitForFunction(() => {
        const frame = document.querySelector<HTMLElement>('.editor-frame');
        if (!frame) return false;
        const frameRect = frame.getBoundingClientRect();
        return Array.from(frame.querySelectorAll<HTMLElement>('.math-inline-node--placeholder')).every(
          (node) => {
            const rect = node.getBoundingClientRect();
            return rect.bottom <= frameRect.top || rect.top >= frameRect.bottom;
          },
        );
      }, undefined, { timeout: 10_000 }),
      15_000,
      'visible placeholder clear',
    );
    assert(
      'visible viewport has no inline math placeholders after activation',
      placeholderClear.ok,
      placeholderClear.label,
    );
    const visiblePlaceholders = await handle.page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      if (!frame) return -1;
      const frameRect = frame.getBoundingClientRect();
      return Array.from(frame.querySelectorAll<HTMLElement>('.math-inline-node--placeholder'))
        .map((node) => {
          const rect = node.getBoundingClientRect();
          const paragraph = node.closest('p');
          const paragraphRect = paragraph?.getBoundingClientRect();
          const preview = node.querySelector<HTMLElement>(':scope > .math-node-preview');
          const content = node.querySelector<HTMLElement>(':scope > .math-node-content');
          return {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            frameTop: frameRect.top,
            frameBottom: frameRect.bottom,
            paragraphTop: paragraphRect?.top ?? null,
            paragraphBottom: paragraphRect?.bottom ?? null,
            contentText: content?.textContent?.slice(0, 80) ?? null,
            previewText: preview?.textContent?.slice(0, 80) ?? null,
            hasKatex: Boolean(preview?.querySelector('.katex')),
            visible: rect.bottom > frameRect.top && rect.top < frameRect.bottom,
          };
        })
        .filter((entry) => entry.visible);
    });
    assert(
      'visible viewport has no inline math placeholders after activation',
      visiblePlaceholders.length === 0,
      JSON.stringify(visiblePlaceholders),
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

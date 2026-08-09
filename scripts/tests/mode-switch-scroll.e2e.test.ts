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
  const installedBin = process.env.MARIVELL_E2E_BIN ?? '';
  const binary = installedBin || electronBin;
  const args = installedBin
    ? [
        '--no-sandbox',
        '--disable-gpu',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        filePath,
      ]
    : [
        path.join(outDir, 'main', 'index.js'),
        '--no-sandbox',
        '--disable-gpu',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        filePath,
      ];
  const child = spawn(
    binary,
    args,
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...(process.env.MARIVELL_E2E_BENCHMARK === '1' ? { MARIVELL_BENCHMARK: '1' } : {}),
      },
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
        const textReady = Boolean(surface && surface.innerText.length > Math.min(expectedSize, 10_000));
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

async function main(): Promise<void> {
  console.log('\n## scroll-then-source mode-switch e2e');
  const lines: string[] = [];
  for (let index = 0; index < 900; index += 1) {
    lines.push(
      `## Section ${index}\n\nParagraph ${index} contains enough text to make this editor scrollable.\n\n` +
        `Inline math $x_${index}^2$ and code \`value_${index}\`.\n`,
    );
  }
  const envFile = process.env.MARIVELL_E2E_FILE ?? '';
  const source = envFile && fs.existsSync(envFile)
    ? fs.readFileSync(envFile, 'utf8')
    : `${lines.join('\n')}\n`;
  const markdownPath = envFile && fs.existsSync(envFile)
    ? envFile
    : path.join(os.tmpdir(), `marivell-e2e-scroll-${process.pid}.md`);
  if (!envFile || !fs.existsSync(envFile)) {
    fs.writeFileSync(markdownPath, source, 'utf8');
  }

  const outDir = path.join(os.tmpdir(), `marivell-e2e-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-e2e-profile-${process.pid}`);
  const port = 9600 + (process.pid % 200);

  let handle: ElectronHandle | null = null;
  try {
    if (!process.env.MARIVELL_E2E_BIN) {
      console.log('Building e2e bundle (no install needed)...');
      await buildRenderer(outDir);
    } else {
      console.log('Using installed e2e binary...');
    }

    handle = await launchElectron(outDir, markdownPath, port, profile);

    const glassEffect = process.env.MARIVELL_E2E_GLASS ?? '';
    if (glassEffect) {
      const glassSet = await handle.page.evaluate(async (effect) => {
        const deadline = performance.now() + 30_000;
        let themeButton: HTMLButtonElement | null = null;
        while (performance.now() < deadline) {
          themeButton = Array.from(document.querySelectorAll<HTMLButtonElement>('.toolbar-button')).find(
            (button) => {
              const label = button.getAttribute('aria-label') ?? '';
              return label.includes('Ctrl+Shift+L') || label.includes('主题') || label.includes('Theme');
            },
          );
          if (themeButton) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!themeButton) {
          return { opened: false, reason: 'theme button missing', buttons: Array.from(document.querySelectorAll('button')).slice(0, 20).map((b) => b.getAttribute('aria-label')) };
        }
        themeButton.click();
        await new Promise((resolve) => setTimeout(resolve, 80));
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.theme-glass-button'));
        const target = buttons.find((button) => {
          const text = button.textContent ?? '';
          return (
            text.includes('液态') ||
            text.includes('Liquid') ||
            text.includes('玻璃') ||
            text.includes('Glass')
          );
        });
        if (!target) {
          return { opened: true, reason: 'glass button missing', buttons: buttons.map((b) => b.textContent) };
        }
        target.click();
        await new Promise((resolve) => setTimeout(resolve, 120));
        return { opened: true, reason: 'clicked' };
      }, glassEffect);
      console.log(`  glass-effect setup: ${JSON.stringify(glassSet)}`);
    }

    const ready = await withTimeout(
      waitForVisualReady(handle.page, Math.min(Math.max(source.length * 0.5, 10_000), 500_000), 60_000),
      70_000,
      'visual-open',
    );
    assert(
      'open long document in visual mode before scrolling',
      ready.ok && !ready.value.timedOut,
      JSON.stringify(ready),
    );

    let scroll: Awaited<ReturnType<typeof waitForVisualReady>> extends never ? never : {
      scrolled: boolean;
      maxScrollTop: number;
      scrollHeight: number;
      clientHeight: number;
      scrollTop: number;
    };
    if (process.env.MARIVELL_E2E_WHEEL === '1') {
      const frameBox = await handle.page.locator('.editor-frame').boundingBox();
      if (!frameBox) throw new Error('editor frame box missing');
      await handle.page.mouse.move(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2);
      for (let index = 0; index < 12; index += 1) {
        await handle.page.mouse.wheel(0, 5000);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      const wheelState = await handle.page.evaluate(() => {
        const frame = document.querySelector<HTMLElement>('.editor-frame');
        if (!frame) throw new Error('editor frame missing');
        return {
          scrolled: frame.scrollTop > 0,
          maxScrollTop: Math.max(frame.scrollHeight - frame.clientHeight, 0),
          scrollHeight: frame.scrollHeight,
          clientHeight: frame.clientHeight,
          scrollTop: frame.scrollTop,
        };
      });
      scroll = wheelState;
    } else {
      const immediate = process.env.MARIVELL_E2E_IMMEDIATE === '1';
      scroll = await handle.page.evaluate(async ({ immediate }) => {
        const frame = document.querySelector<HTMLElement>('.editor-frame');
        if (!frame) {
          throw new Error('editor frame missing');
        }
        const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
        if (maxScrollTop <= 0) {
          return {
            scrolled: false,
            maxScrollTop,
            scrollHeight: frame.scrollHeight,
            clientHeight: frame.clientHeight,
            scrollTop: 0,
          };
        }
        for (const ratio of [0.9, 0.5, 1, 0.75]) {
          frame.scrollTop = Math.floor(maxScrollTop * ratio);
          frame.dispatchEvent(new Event('scroll'));
          if (!immediate) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        return {
          scrolled: true,
          maxScrollTop,
          scrollHeight: frame.scrollHeight,
          clientHeight: frame.clientHeight,
          scrollTop: frame.scrollTop,
        };
      }, { immediate });
    }
    assert(
      'visual mode scrolls to a non-top position',
      scroll.scrolled && scroll.scrollTop > 0,
      JSON.stringify(scroll),
    );

    const switchStart = Date.now();
    await handle.page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-source-mode' }),
      );
    });

    const firstSource = await handle.page.evaluate(async () => {
      const deadline = performance.now() + 30_000;
      while (performance.now() < deadline) {
        const frame = document.querySelector<HTMLElement>('.editor-frame');
        const input = frame?.querySelector<HTMLTextAreaElement>('.source-editor__input');
        const highlight = frame?.querySelector<HTMLElement>('.source-editor__highlight-content');
        if (frame?.classList.contains('is-source') && input) {
          return {
            sourceLength: input.value.length,
            highlightLength: highlight?.textContent?.length ?? 0,
            overlayVisible: Boolean(frame.querySelector<HTMLElement>('.editor-loading--mode-switch')),
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return { sourceLength: 0, highlightLength: 0, overlayVisible: false };
    });
    assert(
      'source textarea is populated on first source frame after scrolling',
      firstSource.sourceLength >= 1000,
      JSON.stringify(firstSource),
    );
    assert(
      'source highlight is populated on first source frame after scrolling',
      firstSource.highlightLength >= 1000,
      JSON.stringify(firstSource),
    );

    const sourceResult = await handle.page.evaluate(async () => {
      const deadline = performance.now() + 30_000;
      while (performance.now() < deadline) {
        const frame = document.querySelector<HTMLElement>('.editor-frame');
        const input = frame?.querySelector<HTMLTextAreaElement>('.source-editor__input');
        const highlight = frame?.querySelector<HTMLElement>('.source-editor__highlight-content');
        const overlay = frame?.querySelector<HTMLElement>('.editor-loading--mode-switch');
        if (frame?.classList.contains('is-source') && input && !overlay) {
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          const sourceEditor = frame?.querySelector<HTMLElement>('.source-editor');
          const inputRect = input.getBoundingClientRect();
          const highlightRect = highlight?.getBoundingClientRect();
          const editorRect = sourceEditor?.getBoundingClientRect();
          const frameRect = frame.getBoundingClientRect();
          const highlightVisible = Boolean(
            highlightRect &&
              editorRect &&
              highlightRect.top < editorRect.bottom &&
              highlightRect.bottom > editorRect.top &&
              highlightRect.left < editorRect.right &&
              highlightRect.right > editorRect.left,
          );
          return {
            switched: true,
            sourceLength: input.value.length,
            highlightLength: highlight?.textContent?.length ?? 0,
            textareaVisibleHeight: input.clientHeight,
            inputScrollTop: input.scrollTop,
            inputScrollHeight: input.scrollHeight,
            highlightTransform: highlight?.style.transform ?? '',
            highlightVisible,
            frameScrollTop: frame.scrollTop,
            sourceEditorTop: editorRect?.top ?? null,
            sourceEditorBottom: editorRect?.bottom ?? null,
            viewportTop: frameRect.top,
            viewportBottom: frameRect.bottom,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      const input = frame?.querySelector<HTMLTextAreaElement>('.source-editor__input');
      const highlight = frame?.querySelector<HTMLElement>('.source-editor__highlight-content');
      return {
        switched: Boolean(frame?.classList.contains('is-source')),
        sourceLength: input?.value.length ?? 0,
        highlightLength: highlight?.textContent?.length ?? 0,
        textareaVisibleHeight: input?.clientHeight ?? 0,
        inputScrollTop: input?.scrollTop ?? 0,
        inputScrollHeight: input?.scrollHeight ?? 0,
        highlightTransform: highlight?.style.transform ?? '',
        highlightVisible: false,
        frameScrollTop: frame?.scrollTop ?? 0,
        sourceEditorTop: null,
        sourceEditorBottom: null,
        viewportTop: null,
        viewportBottom: null,
      };
    });

    assert(
      'scroll then source switch reaches source mode',
      sourceResult.switched,
      JSON.stringify(sourceResult),
    );
    assert(
      'source textarea is populated after scrolling',
      sourceResult.sourceLength >= 1000,
      JSON.stringify(sourceResult),
    );
    assert(
      'source highlight layer is populated after scrolling',
      sourceResult.highlightLength >= 1000,
      JSON.stringify(sourceResult),
    );
    assert(
      'source highlight layer is visible inside source viewport after scrolling',
      sourceResult.highlightVisible,
      JSON.stringify(sourceResult),
    );
    assert(
      'source mode resets editor frame scroll after visual scroll',
      sourceResult.frameScrollTop === 0,
      JSON.stringify(sourceResult),
    );
    assert(
      'source editor is inside visible frame after visual scroll',
      sourceResult.sourceEditorTop !== null &&
        sourceResult.viewportTop !== null &&
        sourceResult.sourceEditorTop >= sourceResult.viewportTop - 1 &&
        sourceResult.sourceEditorBottom !== null &&
        sourceResult.sourceEditorBottom <= sourceResult.viewportBottom + 1,
      JSON.stringify(sourceResult),
    );

    const switchMs = Date.now() - switchStart;
    console.log(`  scroll->source switch completed in ${switchMs}ms`);
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

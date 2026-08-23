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

async function buildRenderer(outDir: string): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  await execFileAsync(
    electronViteBin,
    ['build', '--outDir', outDir, '--logLevel', 'warn'],
    { cwd: projectRoot, env: { ...process.env } },
  );
  const nodeModules = path.join(outDir, 'node_modules');
  if (!fs.existsSync(nodeModules)) fs.symlinkSync(path.join(projectRoot, 'node_modules'), nodeModules, 'dir');
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

interface Handle {
  child: ReturnType<typeof spawn>;
  browser: Browser;
  page: Page;
}

async function launch(outDir: string, filePath: string, port: number, profile: string): Promise<Handle> {
  const child = spawn(electronBin, [
    path.join(outDir, 'main', 'index.js'),
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    filePath,
  ], {
    cwd: projectRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const browser = await connectToElectron(port, 30_000);
  const page = browser.contexts()[0]?.pages()[0];
  if (!page) throw new Error('Electron page missing');
  await page.waitForLoadState('domcontentloaded');
  return { child, browser, page };
}

interface Snapshot {
  value: string;
  overlayText: string;
  overlayHtml: string;
  dataComposing: string;
  overlayStyle: Record<string, string>;
  contentStyle: Record<string, string>;
  contentRect: { x: number; y: number; width: number; height: number };
  textareaRect: { x: number; y: number; width: number; height: number };
}

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>('.source-editor__input')!;
    const root = document.querySelector<HTMLElement>('.source-editor')!;
    const overlay = document.querySelector<HTMLElement>('.source-editor__highlight')!;
    const content = document.querySelector<HTMLElement>('.source-editor__highlight-content')!;
    return {
      value: input.value,
      overlayText: content.textContent ?? '',
      overlayHtml: content.innerHTML,
      dataComposing: root.dataset.composing ?? '',
      overlayStyle: {
        color: getComputedStyle(overlay).color,
        fill: getComputedStyle(overlay).webkitTextFillColor,
        visibility: getComputedStyle(overlay).visibility,
        display: getComputedStyle(overlay).display,
        opacity: getComputedStyle(overlay).opacity,
        zIndex: getComputedStyle(overlay).zIndex,
      },
      contentStyle: {
        color: getComputedStyle(content).color,
        fill: getComputedStyle(content).webkitTextFillColor,
        visibility: getComputedStyle(content).visibility,
        display: getComputedStyle(content).display,
        opacity: getComputedStyle(content).opacity,
        transform: getComputedStyle(content).transform,
      },
      contentRect: {
        x: content.getBoundingClientRect().x,
        y: content.getBoundingClientRect().y,
        width: content.getBoundingClientRect().width,
        height: content.getBoundingClientRect().height,
      },
      textareaRect: {
        x: input.getBoundingClientRect().x,
        y: input.getBoundingClientRect().y,
        width: input.getBoundingClientRect().width,
        height: input.getBoundingClientRect().height,
      },
    };
  });
}

async function main(): Promise<void> {
  const markdownPath = path.join(os.tmpdir(), `marivell-source-empty-${process.pid}.md`);
  const outDir = path.join(os.tmpdir(), `marivell-source-empty-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-source-empty-profile-${process.pid}`);
  const screenshot = path.join(os.tmpdir(), `marivell-source-typing-${process.pid}.png`);
  fs.writeFileSync(markdownPath, '', 'utf8');
  let handle: Handle | null = null;
  try {
    await buildRenderer(outDir);
    handle = await launch(outDir, markdownPath, 9800 + (process.pid % 100), profile);
    await handle.page.waitForSelector('.editor-surface', { timeout: 30_000 });
    await handle.page.evaluate(() => window.dispatchEvent(
      new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-source-mode' }),
    ));
    await handle.page.waitForSelector('.source-editor__input', { timeout: 30_000 });
    await handle.page.locator('.source-editor__input').click();

    for (const key of ['a', 'b', 'c']) {
      await handle.page.keyboard.press(key);
      const beforeFrame = await snapshot(handle.page);
      console.log(`after ${key}:`, JSON.stringify(beforeFrame));
      assert(`overlay contains ${key} immediately`, beforeFrame.overlayText.includes(key), JSON.stringify(beforeFrame));
    }

    await handle.page.locator('.editor-frame').screenshot({ path: screenshot });
    const image = await fs.promises.readFile(screenshot);
    assert('typing screenshot is captured', image.length > 5_000, `${image.length} bytes`);
  } finally {
    if (handle) {
      if (process.platform !== 'win32') try { process.kill(-handle.child.pid, 'SIGKILL'); } catch {}
      handle.child.kill('SIGKILL');
      await handle.browser.close().catch(() => {});
    }
    for (const target of [markdownPath, outDir, profile, screenshot]) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  if (failed) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

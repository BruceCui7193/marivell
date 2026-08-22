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
  if (!fs.existsSync(nodeModules)) {
    fs.symlinkSync(path.join(projectRoot, 'node_modules'), nodeModules, 'dir');
  }
}

async function connectToElectron(port: number, timeoutMs = 30_000): Promise<Browser> {
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
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    },
  );
  const browser = await connectToElectron(port);
  const page = browser.contexts()[0]?.pages()[0];
  if (!page) {
    throw new Error('Electron page was not created');
  }
  await page.waitForLoadState('domcontentloaded');
  return { child, browser, page };
}

async function waitForVisualReady(page: Page): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let ready = false;
    try {
      ready = await page.evaluate(() => {
        const frame = document.querySelector<HTMLElement>('.editor-frame');
        const surface = document.querySelector<HTMLElement>('.editor-surface');
        return Boolean(frame && surface && !document.querySelector('.editor-loading') && surface.textContent?.includes('SMALL_TABLE_END'));
      });
    } catch (error) {
      if (!isExecution_contextDestroyed(error)) throw error;
      await wait(100);
      continue;
    }
    if (ready) {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(
        () => requestAnimationFrame(() => resolve(null)),
      )));
      return;
    }
    await wait(50);
  }
  throw new Error('visual editor did not become ready');
}

function isExecution_contextDestroyed(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Execution context was destroyed');
}

function buildMarkdown(): string {
  const wideHeader = Array.from({ length: 32 }, (_, index) => `COLUMN_${String(index + 1).padStart(2, '0')}`).join(' | ');
  const wideDivider = Array.from({ length: 32 }, () => '---').join(' | ');
  const wideRow = Array.from({ length: 32 }, (_, index) => `value-${index + 1}`).join(' | ');
  return [
    '# Table UI regression',
    '',
    'Paragraph before the small table.',
    '',
    'Paragraph before the wide table. SMALL_TABLE_END',
    '',
    `| ${wideHeader} |`,
    `| ${wideDivider} |`,
    `| ${wideRow} |`,
    '',
    '```ts',
    'const value = 1;',
    '```',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  console.log('\n## table UI and overflow e2e');
  const markdownPath = path.join(os.tmpdir(), `marivell-table-ui-${process.pid}.md`);
  const source = buildMarkdown();
  fs.writeFileSync(markdownPath, source, 'utf8');
  const outDir = path.join(os.tmpdir(), `marivell-table-ui-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-table-ui-profile-${process.pid}`);
  const port = 9800 + (process.pid % 150);
  let handle: ElectronHandle | null = null;

  try {
    console.log('Building e2e bundle (no install needed)...');
    await buildRenderer(outDir);
    handle = await launchElectron(outDir, markdownPath, port, profile);
    // tsx keeps function names while serializing evaluate callbacks; provide
    // the same helper inside the page that esbuild expects at runtime.
    await handle.page.evaluate('globalThis.__name = (fn) => fn;');
    await waitForVisualReady(handle.page);

    await handle.page.locator('.editor-surface p').first().click();
    await wait(100);

    const outsideTrigger = await handle.page.evaluate(() => {
      const normalized = (value: string | null) => (value ?? '').replace(/\s+/g, ' ').trim();
      const findTrigger = () => Array.from(document.querySelectorAll<HTMLButtonElement>(
        '.toolbar .toolbar-button',
      )).find((button) => {
        const label = normalized(button.getAttribute('aria-label'));
        return label === '插入表格' || label === 'Insert table' || label === '表格编辑' || label === 'Table editing';
      }) ?? null;
      return {
        label: normalized(findTrigger()?.getAttribute('aria-label')),
        count: findTrigger() ? 1 : 0,
      };
    });

    assert(
      'table button inserts outside a table',
      outsideTrigger.count === 1 && outsideTrigger.label === '插入表格',
      JSON.stringify(outsideTrigger),
    );

    await handle.page.locator('.editor-surface td').first().click();
    await wait(250);
    const editingTriggerCount = await handle.page.evaluate(() => Array.from(
      document.querySelectorAll<HTMLButtonElement>('.toolbar .toolbar-button[data-panel-trigger]'),
    ).filter((button) => ['表格编辑', 'Table editing'].includes(
      (button.getAttribute('aria-label') ?? '').trim(),
    )).length);
    assert(
      'table button becomes the editing trigger inside a table',
      editingTriggerCount === 1,
      `editingTriggers=${editingTriggerCount}`,
    );

    await handle.page.locator('.toolbar .toolbar-button[data-panel-trigger][aria-label="表格编辑"]').click();
    await wait(220);
    const menuProbe = await handle.page.evaluate(() => {
      const menu = document.querySelector<HTMLElement>('.toolbar-submenu.is-open.is-portaled');
      const smallTable = document.querySelector('.editor-surface table');
      return {
        open: Boolean(menu),
        itemCount: menu ? menu.querySelectorAll('.toolbar-submenu__item').length : 0,
        hasIcons: Boolean(menu?.querySelector('svg')),
        rowsBefore: smallTable instanceof HTMLTableElement ? smallTable.rows.length : 0,
      };
    });
    assert(
      'table editing opens one consistent portal menu',
      menuProbe.open,
      JSON.stringify(menuProbe),
    );
    assert(
      'table menu has seven text-only commands',
      menuProbe.itemCount === 7 && !menuProbe.hasIcons,
      JSON.stringify(menuProbe),
    );

    await handle.page.locator('.toolbar-submenu.is-open .toolbar-submenu__item').nth(1).click();
    await wait(280);
    const rowsAfter = await handle.page.evaluate(() => {
      const smallTable = document.querySelector('.editor-surface table');
      return smallTable instanceof HTMLTableElement ? smallTable.rows.length : 0;
    });
    assert(
      'text command performs the table edit',
      rowsAfter > menuProbe.rowsBefore,
      `before=${menuProbe.rowsBefore}, after=${rowsAfter}`,
    );

    const wideWrapper = handle.page.locator('.editor-surface .tableWrapper').last();
    await wideWrapper.scrollIntoViewIfNeeded();
    await wideWrapper.locator('th').first().click();
    await wait(220);
    const overflowProbe = await handle.page.evaluate(async () => {
      const wrappers = document.querySelectorAll<HTMLElement>('.editor-surface .tableWrapper');
      const target = wrappers[wrappers.length - 1];
      const table = target?.querySelector('table');
      const cell = target?.querySelector('th');
      if (!target || !table || !cell) return null;
      const style = getComputedStyle(target);
      target.scrollLeft = target.scrollWidth;
      await new Promise((resolve) => setTimeout(resolve, 120));
      return {
        overflowX: style.overflowX,
        maxWidth: style.maxWidth,
        cellOverflowWrap: getComputedStyle(cell).overflowWrap,
        clientWidth: target.clientWidth,
        scrollWidth: target.scrollWidth,
        scrolledWrapperRight: target.getBoundingClientRect().right,
        scrolledTableRight: table.getBoundingClientRect().right,
        frameRight: document.querySelector<HTMLElement>('.editor-frame')?.getBoundingClientRect().right ?? null,
      };
    });
    assert(
      'wide table is mounted in its own scroller',
      overflowProbe !== null,
      String(overflowProbe),
    );
    assert(
      'wide table uses a constrained horizontal scroller',
      overflowProbe !== null &&
        overflowProbe.overflowX === 'auto' &&
        ['100%', 'none'].includes(overflowProbe.maxWidth) &&
        overflowProbe.scrollWidth >= overflowProbe.clientWidth,
      JSON.stringify(overflowProbe),
    );
    assert(
      'wide table right boundary stays inside its scroller after scrolling',
      overflowProbe !== null &&
        Math.abs(overflowProbe.scrolledTableRight - overflowProbe.scrolledWrapperRight) <= 2,
      JSON.stringify(overflowProbe),
    );
    assert(
      'wide table scroller does not cross the editor boundary',
      overflowProbe !== null && overflowProbe.scrolledWrapperRight <= overflowProbe.frameRight + 1,
      JSON.stringify(overflowProbe),
    );
    assert(
      'wide cells wrap pathological content instead of forcing infinite width',
      overflowProbe?.cellOverflowWrap === 'anywhere',
      overflowProbe?.cellOverflowWrap ?? '',
    );

    await handle.page.evaluate(() => {
      localStorage.setItem('markdown-editor-glass-effect', 'liquid');
      location.reload();
    });

    await waitForVisualReady(handle.page);
    await handle.page.evaluate(async () => {
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        if (document.documentElement.dataset.glassEffect === 'liquid') return;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    });
    await handle.page.locator('.code-block-node__language-input').first().focus();
    await wait(300);
    const liquidProbe = await handle.page.evaluate(() => {
      const menu = document.querySelector<HTMLElement>('.code-block-node__language-menu');
      return {
        layers: menu ? menu.querySelectorAll('.liquid-glass-layer').length : -1,
        attribute: Boolean(menu?.hasAttribute('data-liquid-glass')),
        backdrop: menu ? getComputedStyle(menu).backdropFilter : '',
        glass: document.documentElement.dataset.glassEffect ?? '',
      };
    });
    assert(
      'liquid mode leaves code language menu as a normal opaque menu',
      liquidProbe.glass === 'liquid' &&
        liquidProbe.layers === 0 &&
        !liquidProbe.attribute &&
        liquidProbe.backdrop === 'none',
      JSON.stringify({ liquid: liquidProbe }),
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

  console.log('\n================================================');
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

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
        const textReady = Boolean(surface && surface.innerText.length > Math.min(expectedSize, 1000));
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

function buildMarkdown(): string {
  const imageMarkdown =
    '![Alt](data:image/svg+xml;base64,' +
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20">' +
        '<rect width="40" height="20" fill="#4f8" /></svg>',
    ).toString('base64') +
    ')';
  const lines: string[] = [];
  lines.push('# Outline One');
  lines.push('');
  lines.push(`Paragraph zero has $x_0^2 + y_0$ and $$\\int_0^1 x\\,dx$$.`);
  lines.push('');
  lines.push('```ts');
  lines.push('const answer: number = 42;');
  lines.push('```');
  lines.push('');
  lines.push('```mermaid');
  lines.push('graph TD');
  lines.push('  A-->B');
  lines.push('```');
  lines.push('');
  lines.push('<div class="export-html"><strong>HTML payload</strong></div>');
  lines.push('');
  lines.push(`A footnote reference with math[^1].`);
  lines.push('');
  lines.push(imageMarkdown);
  lines.push('');

  for (let index = 0; index < 900; index += 1) {
    lines.push(
      `## Outline Section ${index + 1}\n\n` +
        `Paragraph ${index + 1} has $a_{${index + 1}} + b^{2}$ and filler text to keep the file scrollable.\n`,
    );
  }

  lines.push('');
  lines.push('# Outline Two');
  lines.push('');
  lines.push(`Paragraph target has $z_{target}^2$ and enough text to create a jump target: target target target.`);
  lines.push('');
  lines.push('[^1]: Footnote definition with $f^2$ and code `inline-code`.');
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  console.log('\n## export hydrate e2e');
  const source = buildMarkdown();
  const markdownPath = path.join(os.tmpdir(), `marivell-export-hydrate-${process.pid}.md`);
  fs.writeFileSync(markdownPath, source, 'utf8');

  const outDir = path.join(os.tmpdir(), `marivell-export-hydrate-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-export-hydrate-profile-${process.pid}`);
  const port = 9700 + (process.pid % 200);

  let handle: ElectronHandle | null = null;
  try {
    console.log('Building e2e bundle (no install needed)...');
    await buildRenderer(outDir);
    handle = await launchElectron(outDir, markdownPath, port, profile);

    const ready = await withTimeout(
      waitForVisualReady(handle.page, Math.min(source.length * 0.5, 500_000), 60_000),
      70_000,
      'visual-open',
    );
    assert(
      'open export-hydrate document in visual mode',
      ready.ok && !ready.value.timedOut,
      JSON.stringify(ready),
    );

    const initial = await handle.page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      if (!frame) throw new Error('editor frame missing');
      const frameRect = frame.getBoundingClientRect();
      const mathNodes = Array.from(document.querySelectorAll<HTMLElement>('.math-inline-node, .math-block-node'));
      const visible = mathNodes.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > frameRect.top && rect.top < frameRect.bottom;
      });
      const visiblePlaceholders = visible.filter((element) =>
        element.classList.contains('math-inline-node--placeholder') ||
        element.classList.contains('math-block-node-placeholder'),
      ).length;
      const offscreen = mathNodes.length - visible.length;
      return {
        mathCount: mathNodes.length,
        visiblePlaceholders,
        offscreenCount: offscreen,
        imageCount: document.querySelectorAll('.image-node').length,
        codeCount: document.querySelectorAll('.code-block-node').length,
        mermaidCount: document.querySelectorAll('.mermaid-node').length,
        htmlCount: document.querySelectorAll('.html-block').length,
        footnoteCount: document.querySelectorAll('sup[data-type="footnote-reference"]').length,
        footnoteDefinitionCount: document.querySelectorAll('.footnote-definition-node').length,
      };
    });
    assert(
      'document includes all virtualized node types',
      initial.mathCount > 2 &&
        initial.imageCount === 1 &&
        initial.codeCount === 1 &&
        initial.mermaidCount === 1 &&
        initial.htmlCount === 1 &&
        initial.footnoteCount === 1 &&
        initial.footnoteDefinitionCount === 1,
      JSON.stringify(initial),
    );
    assert(
      'initial viewport has no math placeholders while offscreen math is lazy',
      initial.visiblePlaceholders === 0 && initial.offscreenCount > 0,
      JSON.stringify(initial),
    );

    const beforePdf = await handle.page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
      frame.scrollTop = Math.round((frame.scrollHeight - frame.clientHeight) * 0.75);
      frame.dispatchEvent(new Event('scroll'));
      w.__marivellExportCapture = {
        enabled: true,
        calls: [],
      };
      return {
        hydrateCalls: (w.__marivellForceHydrateAllCalls as number | undefined) ?? 0,
        hydrateTargetCalls: (w.__marivellHydrateTargetRangeCalls as number | undefined) ?? 0,
        scrollTop: frame.scrollTop,
      };
    });

    await handle.page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('markdown-editor:menu-action', { detail: 'export-pdf' }),
      );
    });
    await withTimeout(
      handle.page.waitForFunction(() => {
        const capture = (window as unknown as Record<string, unknown>).__marivellExportCapture as
          | { calls?: unknown[] }
          | undefined;
        return capture?.calls?.length === 1;
      }, undefined, { timeout: 15_000 }),
      20_000,
      'pdf capture',
    );

    const pdfResult = await handle.page.evaluate(({ beforeHydrateCalls }) => {
      const w = window as unknown as Record<string, unknown>;
      const capture = w.__marivellExportCapture as {
        calls: Array<{
          kind: string;
          payload: { markdown: string };
          snapshot: string;
          hydrateCalls: number;
        }>;
      };
      const call = capture.calls[0]!;
      const dom = new DOMParser().parseFromString(call.snapshot, 'text/html');
      const placeholderSelector = [
        '.math-inline-node--placeholder',
        '.math-block-node-placeholder',
        '.image-node__placeholder',
        '.mermaid-node__placeholder',
        '.html-block-placeholder',
        '.code-block-node--placeholder',
        '.mermaid-node__empty',
      ].join(',');
      const placeholders = dom.querySelectorAll(placeholderSelector).length;
      const mathNodes = dom.querySelectorAll('.math-inline-node, .math-block-node').length;
      const katexNodes = dom.querySelectorAll('.math-node-preview .katex').length;
      const codeText = dom.querySelector('.code-block-node__pre')?.textContent ?? '';
      const mermaidSvgCount = dom.querySelectorAll('.mermaid-node__preview svg').length;
      const imageCount = dom.querySelectorAll('img.image-node__image').length;
      const htmlText = dom.querySelector('.html-block')?.textContent ?? '';
      return {
        kind: call.kind,
        markdown: call.payload.markdown,
        snapshot: call.snapshot,
        hydrateCalls: call.hydrateCalls,
        beforeHydrateCalls,
        placeholders,
        mathNodes,
        katexNodes,
        codeText,
        mermaidSvgCount,
        imageCount,
        htmlText,
        hasRawHint: call.snapshot.includes('math-inline-placeholder-hint') ||
          call.snapshot.includes('math-node-placeholder-hint'),
      };
    }, { beforeHydrateCalls: beforePdf.hydrateCalls });

    assert(
      'pdf export forces hydration before capture',
      pdfResult.hydrateCalls > pdfResult.beforeHydrateCalls,
      JSON.stringify(pdfResult),
    );
    assert(
      'pdf exported payload preserves formulas, code, mermaid, image, html, and footnote',
      pdfResult.markdown.includes('$x_0^2 + y_0$') &&
        pdfResult.markdown.includes('\\int_0^1 x\\,dx') &&
        pdfResult.markdown.includes('const answer: number = 42;') &&
        pdfResult.markdown.includes('graph TD') &&
        pdfResult.markdown.includes('data:image/svg+xml') &&
        pdfResult.markdown.includes('<strong>HTML payload</strong>') &&
        pdfResult.markdown.includes('[^1]:'),
      JSON.stringify(pdfResult),
    );
    assert(
      'pdf exported DOM snapshot has no placeholders',
      pdfResult.placeholders === 0 && !pdfResult.hasRawHint,
      JSON.stringify(pdfResult),
    );
    assert(
      'pdf exported DOM contains all math, image, code, mermaid, and html content',
      pdfResult.mathNodes > 2 &&
        pdfResult.katexNodes >= pdfResult.mathNodes &&
        pdfResult.codeText.includes('const answer: number = 42;') &&
        pdfResult.mermaidSvgCount === 1 &&
        pdfResult.imageCount === 1 &&
        pdfResult.htmlText.includes('HTML payload'),
      JSON.stringify(pdfResult),
    );

    await handle.page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('markdown-editor:menu-action', { detail: 'export-image' }),
      );
    });
    await withTimeout(
      handle.page.waitForFunction(() => {
        const capture = (window as unknown as Record<string, unknown>).__marivellExportCapture as
          | { calls?: unknown[] }
          | undefined;
        return capture?.calls?.length === 2;
      }, undefined, { timeout: 15_000 }),
      20_000,
      'image capture',
    );

    const imageResult = await handle.page.evaluate(({ beforeHydrateCalls }) => {
      const w = window as unknown as Record<string, unknown>;
      const capture = w.__marivellExportCapture as {
        calls: Array<{
          kind: string;
          payload: { markdown: string };
          snapshot: string;
          hydrateCalls: number;
        }>;
      };
      const call = capture.calls[1]!;
      const dom = new DOMParser().parseFromString(call.snapshot, 'text/html');
      return {
        kind: call.kind,
        hydrateCalls: call.hydrateCalls,
        beforeHydrateCalls,
        markdown: call.payload.markdown,
        placeholders: dom.querySelectorAll('.math-inline-node--placeholder, .math-block-node-placeholder, .image-node__placeholder, .mermaid-node__placeholder, .html-block-placeholder, .code-block-node--placeholder, .mermaid-node__empty').length,
        katexNodes: dom.querySelectorAll('.math-node-preview .katex').length,
        mathNodes: dom.querySelectorAll('.math-inline-node, .math-block-node').length,
        imageCount: dom.querySelectorAll('img.image-node__image').length,
        codeText: dom.querySelector('.code-block-node__pre')?.textContent ?? '',
        mermaidSvgCount: dom.querySelectorAll('.mermaid-node__preview svg').length,
      };
    }, { beforeHydrateCalls: pdfResult.hydrateCalls });

    assert(
      'long-image export forces hydration before capture',
      imageResult.hydrateCalls > imageResult.beforeHydrateCalls,
      JSON.stringify(imageResult),
    );
    assert(
      'long-image exported payload is complete',
      imageResult.markdown.includes('$x_0^2 + y_0$') &&
        imageResult.markdown.includes('const answer: number = 42;') &&
        imageResult.markdown.includes('graph TD') &&
        imageResult.markdown.includes('data:image/svg+xml') &&
        imageResult.markdown.includes('<strong>HTML payload</strong>') &&
        imageResult.markdown.includes('[^1]:'),
      JSON.stringify(imageResult),
    );
    assert(
      'long-image exported DOM has no placeholders and all rich content',
      imageResult.placeholders === 0 &&
        imageResult.mathNodes > 2 &&
        imageResult.katexNodes >= imageResult.mathNodes &&
        imageResult.imageCount === 1 &&
        imageResult.codeText.includes('const answer: number = 42;') &&
        imageResult.mermaidSvgCount === 1,
      JSON.stringify(imageResult),
    );

    const outlineBefore = await handle.page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return {
        hydrateTargetCalls: (w.__marivellHydrateTargetRangeCalls as number | undefined) ?? 0,
        scrollTop: (document.querySelector<HTMLElement>('.editor-frame')?.scrollTop ?? 0),
      };
    });
    await handle.page.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>('.sidebar');
      if (!sidebar || sidebar.classList.contains('is-hidden')) {
        window.dispatchEvent(
          new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-sidebar' }),
        );
      }
    });
    await handle.page.waitForFunction(() => {
      const sidebar = document.querySelector<HTMLElement>('.sidebar');
      return Boolean(sidebar && !sidebar.classList.contains('is-hidden'));
    }, undefined, { timeout: 5_000 });
    await handle.page.evaluate(() => {
      const outlineTab = document.querySelectorAll<HTMLElement>('.sidebar__tab')[1];
      outlineTab?.click();
    });
    await handle.page.waitForFunction(() => document.querySelectorAll('.outline-item').length > 0);
    await handle.page.evaluate(() => {
      const target = Array.from(document.querySelectorAll<HTMLElement>('.outline-item'))
        .find((button) => button.textContent?.includes('Outline Two'));
      if (!target) throw new Error('outline item not found');
      target.click();
    });
    await withTimeout(
      handle.page.waitForFunction(({ beforeCalls }) => {
        const w = window as unknown as Record<string, unknown>;
        const calls = (w.__marivellHydrateTargetRangeCalls as number | undefined) ?? 0;
        const frame = document.querySelector<HTMLElement>('.editor-frame');
        if (!frame || calls <= beforeCalls) return false;
        const frameRect = frame.getBoundingClientRect();
        const heading = Array.from(frame.querySelectorAll<HTMLElement>('h1, h2, h3'))
          .find((element) => element.textContent?.includes('Outline Two'));
        if (!heading) return false;
        const rect = heading.getBoundingClientRect();
        const inViewport = rect.top >= frameRect.top - 2 && rect.bottom <= frameRect.bottom + 2;
        const placeholders = Array.from(frame.querySelectorAll('.math-inline-node, .math-block-node'))
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            if (rect.bottom <= frameRect.top || rect.top >= frameRect.bottom) return false;
            return element.classList.contains('math-inline-node--placeholder') ||
              element.classList.contains('math-block-node-placeholder');
          }).length;
        return inViewport && placeholders === 0;
      }, { beforeCalls: outlineBefore.hydrateTargetCalls }, { timeout: 12_000 }),
      18_000,
      'outline jump',
    );
    const outlineResult = await handle.page.evaluate(({ beforeCalls, beforeScrollTop }) => {
      const w = window as unknown as Record<string, unknown>;
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
      const frameRect = frame.getBoundingClientRect();
      const heading = Array.from(frame.querySelectorAll<HTMLElement>('h1, h2, h3'))
        .find((element) => element.textContent?.includes('Outline Two'));
      const headingRect = heading?.getBoundingClientRect();
      const visibleMath = Array.from(frame.querySelectorAll('.math-inline-node, .math-block-node'))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.bottom > frameRect.top && rect.top < frameRect.bottom;
        });
      return {
        hydrateCallsAfter: (w.__marivellHydrateTargetRangeCalls as number | undefined) ?? 0,
        beforeCalls,
        scrollMoved: frame.scrollTop !== beforeScrollTop,
        headingVisible: Boolean(
          headingRect &&
          headingRect.top >= frameRect.top - 2 &&
          headingRect.bottom <= frameRect.bottom + 2,
        ),
        visiblePlaceholders: visibleMath.filter((element) =>
          element.classList.contains('math-inline-node--placeholder') ||
          element.classList.contains('math-block-node-placeholder'),
        ).length,
        visibleKatex: visibleMath.filter((element) =>
          element.querySelector('.math-node-preview .katex') !== null,
        ).length,
      };
    }, { beforeCalls: outlineBefore.hydrateTargetCalls, beforeScrollTop: outlineBefore.scrollTop });
    assert(
      'outline jump hydrates around target before scrolling',
      outlineResult.hydrateCallsAfter > outlineResult.beforeCalls && outlineResult.scrollMoved,
      JSON.stringify(outlineResult),
    );
    assert(
      'outline target is centered with visible formulas rendered and no viewport placeholders',
      outlineResult.headingVisible &&
        outlineResult.visiblePlaceholders === 0 &&
        outlineResult.visibleKatex >= 1,
      JSON.stringify(outlineResult),
    );

    const footnoteBefore = await handle.page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
      frame.scrollTop = 0;
      frame.dispatchEvent(new Event('scroll'));
      return {
        hydrateTargetCalls: (w.__marivellHydrateTargetRangeCalls as number | undefined) ?? 0,
        scrollTop: frame.scrollTop,
      };
    });
    await handle.page.evaluate(() => {
      const reference = document.querySelector<HTMLElement>('sup[data-type="footnote-reference"][data-label="1"]');
      if (!reference) throw new Error('footnote reference not found');
      reference.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await withTimeout(
      handle.page.waitForFunction(({ beforeCalls }) => {
        const w = window as unknown as Record<string, unknown>;
        const calls = (w.__marivellHydrateTargetRangeCalls as number | undefined) ?? 0;
        const frame = document.querySelector<HTMLElement>('.editor-frame');
        if (!frame || calls <= beforeCalls) return false;
        const frameRect = frame.getBoundingClientRect();
        const definition = frame.querySelector<HTMLElement>('.footnote-definition-node');
        if (!definition) return false;
        const rect = definition.getBoundingClientRect();
        const inViewport = rect.top >= frameRect.top - 2 && rect.bottom <= frameRect.bottom + 2;
        const placeholders = Array.from(frame.querySelectorAll('.math-inline-node, .math-block-node'))
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            if (rect.bottom <= frameRect.top || rect.top >= frameRect.bottom) return false;
            return element.classList.contains('math-inline-node--placeholder') ||
              element.classList.contains('math-block-node-placeholder');
          }).length;
        return inViewport && placeholders === 0;
      }, { beforeCalls: footnoteBefore.hydrateTargetCalls }, { timeout: 12_000 }),
      18_000,
      'footnote jump',
    );
    const footnoteResult = await handle.page.evaluate(({ beforeCalls, beforeScrollTop }) => {
      const w = window as unknown as Record<string, unknown>;
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      if (!(frame instanceof HTMLElement)) throw new Error('editor frame missing');
      const frameRect = frame.getBoundingClientRect();
      const definition = frame.querySelector<HTMLElement>('.footnote-definition-node');
      const rect = definition?.getBoundingClientRect();
      const visibleMath = Array.from(frame.querySelectorAll('.math-inline-node, .math-block-node'))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.bottom > frameRect.top && rect.top < frameRect.bottom;
        });
      const editor = window.__marivellEditor as { state?: { selection?: { from?: number }; doc?: { nodeSize?: number } } } | undefined;
      return {
        hydrateCallsAfter: (w.__marivellHydrateTargetRangeCalls as number | undefined) ?? 0,
        beforeCalls,
        scrollMoved: frame.scrollTop !== beforeScrollTop,
        footnoteVisible: Boolean(
          rect && rect.top >= frameRect.top - 2 && rect.bottom <= frameRect.bottom + 2,
        ),
        visiblePlaceholders: visibleMath.filter((element) =>
          element.classList.contains('math-inline-node--placeholder') ||
          element.classList.contains('math-block-node-placeholder'),
        ).length,
        selectionNearDefinition: typeof editor?.state?.selection?.from === 'number' &&
          typeof editor?.state?.doc?.nodeSize === 'number' &&
          editor.state.selection.from >= editor.state.doc.nodeSize - 2000,
      };
    }, { beforeCalls: footnoteBefore.hydrateTargetCalls, beforeScrollTop: footnoteBefore.scrollTop });
    assert(
      'footnote jump hydrates target before scrolling',
      footnoteResult.hydrateCallsAfter > footnoteResult.beforeCalls && footnoteResult.scrollMoved,
      JSON.stringify(footnoteResult),
    );
    assert(
      'footnote target is visible with no viewport placeholders',
      footnoteResult.footnoteVisible &&
        footnoteResult.visiblePlaceholders === 0 &&
        footnoteResult.selectionNearDefinition,
      JSON.stringify(footnoteResult),
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

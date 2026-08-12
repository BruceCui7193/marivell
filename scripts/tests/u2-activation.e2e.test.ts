import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { acquireExclusiveBenchmarkRun } from '../benchmark/exclusive-run';

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
  const timeout = wait(timeoutMs).then(() => ({ ok: false as const, label }));
  const result = await Promise.race([
    promise.then((value) => ({ ok: true as const, value })),
    timeout,
  ]);
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
  spawnedAt: number;
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
      '--enable-precise-memory-info',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      filePath,
    ],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        MARIVELL_BENCHMARK: '1',
        MARIVELL_ULTIMATE_U2: '1',
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
  return { child, browser, page, spawnedAt };
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
        const editor = (window as unknown as {
          __marivellEditor?: { state?: { doc?: { nodeSize?: number } } };
        }).__marivellEditor;
        const nodeReady = Boolean(editor?.state?.doc && editor.state.doc.nodeSize > expectedSize);
        const textReady = Boolean(
          surface && (surface as HTMLElement).innerText.length > Math.min(expectedSize, 1000),
        );
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

async function waitForExclusiveBenchmarkLock(
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof acquireExclusiveBenchmarkRun>>> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await acquireExclusiveBenchmarkRun();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !message.includes('marivell-benchmark.lock') &&
        !message.includes('held by PID') &&
        !message.includes('Only one marivell Electron performance task')
      ) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for exclusive benchmark lock: ${message}`);
      }
      await wait(2_000);
    }
  }
}

function buildMarkdown(): string {
  const filler: string[] = [];
  for (let index = 0; index < 120; index += 1) {
    filler.push(
      `## Filler Section ${index}`,
      '',
      `Filler paragraph ${index} keeps the U2 activation probe below the initial viewport.`,
      '',
    );
  }
  return [
    ...filler,
    '# U2 Activation Probe',
    '',
    'Before text $a$ and ordinary a after keeps the simple baseline measurable.',
    '',
    'Before text $\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\\\ 5 & 6 \\\\ 7 & 8 \\end{pmatrix}$ after text keeps a high inline formula visible.',
    '',
    '$$',
    '\\begin{pmatrix}',
    '1 & 2 \\\\ 3 & 4 \\\\ 5 & 6 \\\\ 7 & 8 \\\\ 9 & 10 \\\\ 11 & 12',
    '\\end{pmatrix}',
    '$$',
    '',
    'A following paragraph keeps the tall block separated from the inline check.',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  console.log('\n## U2 activation e2e (flag on)');
  const source = buildMarkdown();
  const markdownPath = path.join(os.tmpdir(), `marivell-u2-activation-${process.pid}.md`);
  fs.writeFileSync(markdownPath, source, 'utf8');
  const outDir = path.join(os.tmpdir(), `marivell-u2-activation-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-u2-activation-profile-${process.pid}`);
  const port = 10600 + (process.pid % 200);

  const exclusiveRun = await waitForExclusiveBenchmarkLock(180_000);
  let handle: ElectronHandle | null = null;
  try {
    console.log('Building U2 activation bundle...');
    await buildRenderer(outDir);
    handle = await launchElectron(outDir, markdownPath, port, profile);
    const ready = await withTimeout(
      waitForVisualReady(handle.page, Math.min(source.length * 0.5, 500_000), 60_000),
      70_000,
      'visual-open',
    );
    assert('open U2 activation document in visual mode', ready.ok && !ready.value.timedOut, JSON.stringify(ready));

    await handle.page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      if (frame) {
        frame.scrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
        frame.dispatchEvent(new Event('scroll'));
      }
    });
    let swapWait: { ok: boolean; label: string };
    try {
      await handle.page.waitForFunction(() => {
        const frame = document.querySelector<HTMLElement>('.editor-frame');
        if (!frame) return false;
        return frame.querySelectorAll<HTMLElement>('.math-node-preview [data-u2-single-node="1"]').length >= 3;
      }, undefined, { timeout: 30_000 });
      swapWait = { ok: true, label: '' };
    } catch (error) {
      swapWait = { ok: false, label: error instanceof Error ? error.message : String(error) };
    }
    if (!swapWait.ok) {
      const debug = await handle.page.evaluate(() => {
        const getter = (window as unknown as {
          __marivellGetU2ActivationDiagnostics?: () => unknown;
        }).__marivellGetU2ActivationDiagnostics;
        const frame = document.querySelector<HTMLElement>('.editor-frame');
        return {
          diagnostics: getter?.() ?? null,
          katexCount: frame?.querySelectorAll('.katex').length ?? 0,
          singleNodeCount: frame?.querySelectorAll('[data-u2-single-node="1"]').length ?? 0,
          previewChildren: Array.from(frame?.querySelectorAll('.math-node-preview') ?? [])
            .slice(0, 5)
            .map((preview) => preview.innerHTML.slice(0, 120)),
        };
      });
      console.error(`U2 swap debug: ${JSON.stringify(debug)}`);
    }
    assert('viewport formulas swap to single-node raster', swapWait.ok, swapWait.ok ? '' : swapWait.label);

    const initial = await handle.page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      if (!frame) throw new Error('editor frame missing');
      const swapped = Array.from(
        frame.querySelectorAll<HTMLElement>('.math-node-preview [data-u2-single-node="1"]'),
      );
      const swappedPreviews = swapped.map((element) => element.closest('.math-node-preview'));
      const katexInsideSwapped = swappedPreviews.filter((preview) =>
        preview?.querySelector('.katex'),
      ).length;
      const inlineA = Array.from(frame.querySelectorAll<HTMLImageElement>('[data-u2-single-node="1"][data-u2-latex="a"]'))[0] ?? null;
      const block = Array.from(frame.querySelectorAll<HTMLElement>('.math-block-node [data-u2-single-node="1"]'))[0] ?? null;
      return {
        swappedCount: swapped.length,
        katexInsideSwapped,
        inlineACount: inlineA ? 1 : 0,
        blockCount: block ? 1 : 0,
      };
    });
    assert(
      'swapped previews are single-node and no longer contain KaTeX',
      initial.swappedCount >= 3 && initial.katexInsideSwapped === 0 && initial.inlineACount === 1 && initial.blockCount === 1,
      JSON.stringify(initial),
    );

    const baseline = await handle.page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      if (!frame) throw new Error('editor frame missing');
      const candidate = Array.from(frame.querySelectorAll<HTMLImageElement>('[data-u2-single-node="1"][data-u2-latex="a"]'))[0];
      if (!candidate) return null;
      const clone = candidate.cloneNode(true) as HTMLImageElement;
      const katexHtml = candidate.dataset.u2KatexHtml ?? '';
      const baselineOffset = Number(candidate.dataset.u2BaselineOffsetTop ?? 0);
      const paragraph =
        candidate.closest<HTMLElement>('p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th') ??
        candidate.parentElement ??
        candidate;
      const paragraphStyle = getComputedStyle(paragraph);
      const fontSize = Number.parseFloat(paragraphStyle.fontSize) || 16;
      const rawLineHeight =
        paragraphStyle.lineHeight === 'normal'
          ? fontSize * 1.2
          : Number.parseFloat(paragraphStyle.lineHeight);
      const lineHeight =
        Number.isFinite(rawLineHeight) && rawLineHeight > 0 ? rawLineHeight : fontSize * 1.2;
      const line = document.createElement('div');
      line.style.cssText =
        'position:absolute;left:0;top:0;white-space:nowrap;overflow:visible;' +
        `font-family:${paragraphStyle.fontFamily || 'serif'};font-size:${fontSize}px;line-height:${lineHeight}px;` +
        'background:#fff;color:#000;opacity:0.001;pointer-events:none;';
      line.innerHTML =
        '<span>Ag</span>' +
        '<span class="u2b-probe" style="display:inline-block;width:0;height:0;overflow:visible;vertical-align:baseline;line-height:0;"></span>' +
        '<span class="u2b-text">a</span>' +
        '<span class="u2b-candidate-host"></span>' +
        '<span class="u2b-katex-host"></span>' +
        '<span>Ag</span>';
      const probe = line.querySelector<HTMLElement>('.u2b-probe');
      const text = line.querySelector<HTMLElement>('.u2b-text');
      const candidateHost = line.querySelector<HTMLElement>('.u2b-candidate-host');
      const katexHost = line.querySelector<HTMLElement>('.u2b-katex-host');
      if (!probe || !text || !candidateHost || !katexHost) return null;
      candidateHost.appendChild(clone);
      katexHost.innerHTML = katexHtml;
      document.body.appendChild(line);
      try {
        const probeRect = probe.getBoundingClientRect();
        const candidateRect = clone.getBoundingClientRect();
        const katexRect = katexHost.querySelector('.katex')?.getBoundingClientRect() ?? katexHost.getBoundingClientRect();
        const textRect = text.getBoundingClientRect();
        return {
          baselineDeltaPx: Math.abs(candidateRect.top + baselineOffset - probeRect.bottom),
          bottomDeltaToTextPx: Math.abs(candidateRect.bottom - textRect.bottom),
          bottomDeltaToKatexPx: Math.abs(candidateRect.bottom - katexRect.bottom),
        };
      } finally {
        line.remove();
      }
    });
    assert(
      'inline $a$ baseline/bottom <=1px in activation DOM',
      baseline !== null &&
        baseline.baselineDeltaPx <= 1 &&
        baseline.bottomDeltaToTextPx <= 1 &&
        baseline.bottomDeltaToKatexPx <= 1,
      JSON.stringify(baseline),
    );

    const highFormula = await handle.page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      if (!frame) return null;
      const element = frame.querySelector<HTMLImageElement>('.math-block-node [data-u2-single-node="1"]');
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const width = Number(element.dataset.u2Width ?? 0);
      const height = Number(element.dataset.u2Height ?? 0);
      let clipped = false;
      let current = element.parentElement;
      while (current && current !== document.body) {
        const style = getComputedStyle(current);
        if (
          style.overflowX === 'hidden' ||
          style.overflowY === 'hidden' ||
          style.overflowX === 'clip' ||
          style.overflowY === 'clip'
        ) {
          clipped = true;
          break;
        }
        current = current.parentElement;
      }
      return {
        widthDeltaPx: Math.abs(rect.width - width),
        heightDeltaPx: Math.abs(rect.height - height),
        clipped,
        dpr2Resolution: element.naturalWidth / Math.max(rect.width, 1),
      };
    });
    assert(
      'high block matrix is not cropped and stays DPR2',
      highFormula !== null &&
        highFormula.widthDeltaPx <= 1 &&
        highFormula.heightDeltaPx <= 1 &&
        !highFormula.clipped &&
        highFormula.dpr2Resolution >= 1.8,
      JSON.stringify(highFormula),
    );

    const editRestore = await handle.page.evaluate(async () => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      const node = frame?.querySelector<HTMLElement>('.math-inline-node');
      if (!node) return { clicked: false };
      node.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        clicked: true,
        editing: node.classList.contains('is-editing'),
        hasKatex: node.querySelector('.math-node-preview .katex') !== null,
        hasSingleNode: node.querySelector('[data-u2-single-node="1"]') !== null,
      };
    });
    assert(
      'editing restores KaTeX HTML and removes single-node preview',
      editRestore.clicked && editRestore.editing && editRestore.hasKatex && !editRestore.hasSingleNode,
      JSON.stringify(editRestore),
    );

    const diagnostics = await handle.page.evaluate(() => {
      const getter = (window as unknown as {
        __marivellGetU2ActivationDiagnostics?: () => unknown;
      }).__marivellGetU2ActivationDiagnostics;
      return getter?.() ?? null;
    });
    assert(
      'batch controller has no leaked pending tasks after edit restore',
      diagnostics !== null &&
        typeof diagnostics === 'object' &&
        (diagnostics as { pending: number; queueDepth: number }).pending === 0 &&
        (diagnostics as { pending: number; queueDepth: number }).queueDepth === 0,
      JSON.stringify(diagnostics),
    );

    const modeSwitch = await handle.page.evaluate(async () => {
      window.dispatchEvent(
        new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-source-mode' }),
      );
      await new Promise((resolve) => setTimeout(resolve, 800));
      const textarea = document.querySelector<HTMLTextAreaElement>('.editor-source');
      const sourceText = textarea?.value ?? '';
      window.dispatchEvent(
        new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-source-mode' }),
      );
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      const markerLeak = Boolean(
        frame && (frame.textContent ?? '').includes('MDEDITORSELECTION'),
      );
      return { sourceHasMarker: sourceText.includes('MDEDITORSELECTION'), markerLeak };
    });
    assert(
      'mode switch keeps source clean and returns without marker leak',
      !modeSwitch.sourceHasMarker && !modeSwitch.markerLeak,
      JSON.stringify(modeSwitch),
    );

    const exportResult = await handle.page.evaluate(async () => {
      const benchmarkWindow = window as unknown as {
        __marivellExportCapture?: {
          enabled: boolean;
          calls: Array<{ snapshot: string }>;
        };
      };
      const capture =
        benchmarkWindow.__marivellExportCapture ??
        {
          enabled: false,
          calls: [],
        };
      benchmarkWindow.__marivellExportCapture = capture;
      capture.enabled = true;
      window.dispatchEvent(
        new CustomEvent('markdown-editor:menu-action', { detail: 'export-pdf' }),
      );
      const deadline = Date.now() + 20_000;
      while (capture.calls.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const snapshot = capture.calls[0]?.snapshot ?? '';
      return {
        captured: capture.calls.length > 0,
        hasKatex: snapshot.includes('class="katex"') || snapshot.includes("class='katex'"),
        hasSingleNode: snapshot.includes('data-u2-single-node'),
      };
    });
    assert(
      'export forces KaTeX restore and does not capture single-node DOM',
      exportResult.captured && exportResult.hasKatex && !exportResult.hasSingleNode,
      JSON.stringify(exportResult),
    );

    const capabilities = await handle.page.evaluate(() => {
      const editor = (window as unknown as {
        __marivellEditor?: {
          commands: {
            setContent: (content: unknown, emitUpdate?: boolean) => boolean;
            selectAll: () => boolean;
          };
          view: {
            dom: HTMLElement;
            state: { doc: { content: { size: number } } };
          };
          state: { doc: { textBetween: (from: number, to: number) => string } };
        };
      }).__marivellEditor;
      if (!editor) {
        return { available: false };
      }
      editor.commands.setContent(
        {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'inlineMath',
                  attrs: { display: 'no', openDelim: '$', closeDelim: '$' },
                  content: [{ type: 'text', text: 'x+y' }],
                },
              ],
            },
          ],
        },
        false,
      );
      editor.commands.selectAll();
      const dataTransfer = new DataTransfer();
      const copyEvent = new ClipboardEvent('copy', {
        clipboardData: dataTransfer,
        bubbles: true,
        cancelable: true,
      });
      editor.view.dom.dispatchEvent(copyEvent);
      const plainText = copyEvent.clipboardData?.getData('text/plain') ?? '';
      editor.commands.setContent(
        {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'inlineMath',
                  attrs: { display: 'no' },
                  content: [{ type: 'text', text: 'u2bSearchTokenAlpha' }],
                },
              ],
            },
          ],
        },
        false,
      );
      const docText = editor.state.doc.textBetween(0, editor.view.state.doc.content.size);
      return {
        available: true,
        copyPlainText: plainText,
        copyLatexPreserved: plainText.includes('$') && plainText.includes('x+y'),
        searchFound: docText.includes('u2bSearchTokenAlpha'),
      };
    });
    assert(
      'copy/search semantics remain source-based',
      capabilities.available && capabilities.copyLatexPreserved && capabilities.searchFound,
      JSON.stringify(capabilities),
    );

    const finalDiagnostics = await handle.page.evaluate(() => {
      const getter = (window as unknown as {
        __marivellGetU2ActivationDiagnostics?: () => unknown;
      }).__marivellGetU2ActivationDiagnostics;
      const inlineWindow = window as unknown as {
        __marivellInlineMathActivationReadyMs?: number;
      };
      return {
        u2: getter?.() ?? null,
        katexReadyMs: inlineWindow.__marivellInlineMathActivationReadyMs ?? null,
      };
    });
    console.log(
      `  U2 activation metrics: ${JSON.stringify(finalDiagnostics)}`,
    );
    assert(
      'U2 activation diagnostics expose swap and queue data',
      finalDiagnostics !== null &&
        (finalDiagnostics as { u2: { requested: number; completed: number } }).u2.requested > 0 &&
        (finalDiagnostics as { u2: { requested: number; completed: number } }).u2.completed > 0,
      JSON.stringify(finalDiagnostics),
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
    await exclusiveRun.release();
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

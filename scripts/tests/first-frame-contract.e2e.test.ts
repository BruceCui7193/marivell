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
      const deadline = performance.now() + deadlineMs;
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

async function waitForSourceInput(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      const input = frame?.querySelector<HTMLTextAreaElement>('.source-editor__input');
      if (
        frame?.classList.contains('is-source') &&
        input &&
        input.value.length > 0 &&
        !document.querySelector('.editor-loading, .editor-loading--mode-switch')
      ) {
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        return input.value;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('source input did not become ready');
  });
}

async function waitForVisualMode(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      if (
        frame &&
        !frame.classList.contains('is-source') &&
        !frame.querySelector('.source-editor__input') &&
        !document.querySelector('.editor-loading, .editor-loading--mode-switch')
      ) {
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('visual mode did not become ready');
  });
}

async function findVisibleTextPoint(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>('.editor-frame');
    if (!frame) {
      throw new Error('editor frame missing');
    }
    const frameRect = frame.getBoundingClientRect();
    const editor = window.__marivellEditor as {
      view?: {
        coordsAtPos: (pos: number) => { left: number; top: number; bottom: number } | null;
        posAtCoords: (coords: { left: number; top: number }) => { pos: number; inside: number } | null;
      };
    };
    const candidates = Array.from(
      frame.querySelectorAll<HTMLElement>(
        '.editor-surface p, .editor-surface li, .editor-surface blockquote, .editor-surface h1, .editor-surface h2, .editor-surface h3',
      ),
    )
      .filter((element) => (element.textContent ?? '').trim().length > 0)
      .sort((left, right) => {
        const leftBody = left.matches('p, li, blockquote') ? 0 : 1;
        const rightBody = right.matches('p, li, blockquote') ? 0 : 1;
        return leftBody !== rightBody
          ? leftBody - rightBody
          : left.getBoundingClientRect().top - right.getBoundingClientRect().top;
      });
    for (const element of candidates) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const text = node.nodeValue ?? '';
        const match = text.search(/\S/);
        if (match >= 0) {
          const range = document.createRange();
          range.setStart(node, match);
          range.setEnd(node, match + 1);
          const rect = range.getBoundingClientRect();
          if (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.bottom > frameRect.top &&
            rect.top < frameRect.bottom &&
            rect.right > frameRect.left &&
            rect.left < frameRect.right
          ) {
            const pointPos = editor?.view?.posAtCoords({
              left: rect.left + 0.5,
              top: rect.top + rect.height / 2,
            });
            const coords = pointPos
              ? editor?.view?.coordsAtPos(pointPos.pos) ?? null
              : null;
            if (coords) {
              return {
                x: coords.left,
                y: coords.top + Math.max(1, (coords.bottom - coords.top) / 2),
              };
            }
          }
        }
        node = walker.nextNode();
      }
    }
    throw new Error('no visible text target');
  });
}

async function collectVisualContract(
  page: Page,
): Promise<{
  placeholders: number;
  visibleFormulas: number;
  visibleKatex: number;
  overlayCount: number;
  hitEditor: boolean;
  sampled: number;
  nonNull: number;
  points: Array<{ x: number; y: number; pos: number | null }>;
  scroll: { stableFrames: number; layoutShiftEntries: number; layoutShiftCumulative: number; supported: boolean };
}> {
  const script = `(async () => {
    const frame = document.querySelector('.editor-frame');
    if (!frame) throw new Error('editor frame missing');
    const frameRect = frame.getBoundingClientRect();
    const placeholderSelector = [
      '.math-inline-node--placeholder',
      '.math-block-node-placeholder',
      '.image-node__placeholder',
      '.mermaid-node__placeholder',
      '.html-block-placeholder',
      '.code-block-node--placeholder',
      '.mermaid-node__empty'
    ].join(',');
    const intersects = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > frameRect.top &&
        rect.top < frameRect.bottom &&
        rect.right > frameRect.left &&
        rect.left < frameRect.right;
    };
    const visibleFormulas = Array.from(
      frame.querySelectorAll('.math-inline-node, .math-block-node')
    ).filter(intersects);
    const visibleKatex = visibleFormulas.filter((element) =>
      element.querySelector('.math-node-preview .katex, .katex')
    ).length;
    const placeholders = Array.from(
      frame.querySelectorAll(placeholderSelector)
    ).filter(intersects).length;
    const overlayCount = document.querySelectorAll(
      '.editor-loading, .editor-loading--mode-switch'
    ).length;
    const centerHit = document.elementFromPoint(
      frameRect.left + frameRect.width / 2,
      frameRect.top + frameRect.height / 2
    );
    const hitEditor = Boolean(
      centerHit &&
        frame.contains(centerHit) &&
        centerHit.closest('.editor-surface, .ProseMirror') !== null
    );
    const editor = window.__marivellEditor;
    const samplePoints = [
      { x: frameRect.left + frameRect.width * 0.25, y: frameRect.top + frameRect.height * 0.15 },
      { x: frameRect.left + frameRect.width * 0.75, y: frameRect.top + frameRect.height * 0.35 },
      { x: frameRect.left + frameRect.width * 0.5, y: frameRect.top + frameRect.height * 0.5 },
      { x: frameRect.left + frameRect.width * 0.25, y: frameRect.top + frameRect.height * 0.7 },
      { x: frameRect.left + frameRect.width * 0.75, y: frameRect.top + frameRect.height * 0.8 }
    ];
    const points = samplePoints.map((point) => ({
      x: point.x,
      y: point.y,
      pos: editor?.view?.posAtCoords({ left: point.x, top: point.y })?.pos ?? null
    }));

    const layoutShifts = [];
    let layoutObserver = null;
    try {
      layoutObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          layoutShifts.push({ value: entry.value ?? 0 });
        }
      });
      layoutObserver.observe({ type: 'layout-shift' });
    } catch {}
    const maxScrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
    frame.scrollTop = maxScrollTop * 0.4;
    frame.dispatchEvent(new Event('scroll'));
    const settleDeadline = performance.now() + 3000;
    let previousTop = frame.scrollTop;
    let settleFrames = 0;
    while (performance.now() < settleDeadline && settleFrames < 3) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (frame.scrollTop === previousTop) {
        settleFrames += 1;
      } else {
        settleFrames = 0;
        previousTop = frame.scrollTop;
      }
    }
    const firstTop = frame.scrollTop;
    const shiftsBeforeIdle = layoutShifts.length;
    let stableFrames = 0;
    for (let index = 0; index < 10; index += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      if (frame.scrollTop === firstTop) stableFrames += 1;
    }
    const idleShifts = layoutShifts.slice(shiftsBeforeIdle);
    layoutObserver?.disconnect();
    return {
      placeholders,
      visibleFormulas: visibleFormulas.length,
      visibleKatex,
      overlayCount,
      hitEditor,
      sampled: points.length,
      nonNull: points.filter((point) => point.pos !== null).length,
      points,
      scroll: {
        stableFrames,
        layoutShiftEntries: idleShifts.length,
        layoutShiftCumulative: idleShifts.reduce((total, entry) => total + entry.value, 0),
        supported: layoutObserver !== null
      }
    };
  })()`;
  return page.evaluate(script);
}

async function collectClickDeviation(
  page: Page,
  point: { x: number; y: number },
): Promise<{ exists: boolean; deviationPx: number; mappedPos: number | null; selectedPos: number | null; coords: { left: number; top: number; right: number; bottom: number } | null }> {
  return page.evaluate((target) => {
    const editor = window.__marivellEditor as {
      state: { selection: { from: number } };
      view: {
        coordsAtPos: (pos: number) => { left: number; top: number; right: number; bottom: number } | null;
        posAtCoords: (coords: { left: number; top: number }) => { pos: number; inside: number } | null;
      };
    };
    const selection = editor?.state.selection;
    const pointPos = editor?.view.posAtCoords({ left: target.x, top: target.y }) ?? null;
    const coords = pointPos ? editor?.view.coordsAtPos(pointPos.pos) ?? null : null;
    return {
      exists: Boolean(selection && selection.from >= 0),
      deviationPx: coords
        ? Math.max(
            Math.abs(coords.left - target.x),
            Math.abs(coords.right - target.x),
            Math.abs((coords.top + coords.bottom) / 2 - target.y),
          )
        : Number.POSITIVE_INFINITY,
      mappedPos: pointPos?.pos ?? null,
      selectedPos: selection?.from ?? null,
      coords,
    };
  }, point);
}

async function main(): Promise<void> {
  console.log('\n## first-frame UIFF contract e2e');
  const lines: string[] = [];
  lines.push('# UIFF Heading\n\nIntro paragraph with $x^2 + y^2$ and enough visible text for caret placement.\n');
  for (let index = 0; index < 420; index += 1) {
    lines.push(
      `## Section ${index}\n\nParagraph ${index} has $\\frac{x_{${index}}}{y_{${index}}}$ and enough text to keep the viewport full: ${index} ${index} ${index}.\n`,
    );
  }
  const source = lines.join('\n');
  const markdownPath = path.join(os.tmpdir(), `marivell-first-frame-${process.pid}.md`);
  fs.writeFileSync(markdownPath, source, 'utf8');
  const outDir = path.join(os.tmpdir(), `marivell-first-frame-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-first-frame-profile-${process.pid}`);
  const port = 9900 + (process.pid % 100);
  let handle: ElectronHandle | null = null;

  try {
    console.log('Building first-frame contract bundle...');
    await buildRenderer(outDir);
    handle = await launchElectron(outDir, markdownPath, port, profile);
    await waitForVisualReady(
      handle.page,
      Math.min(Math.max(source.length * 0.5, 10_000), 500_000),
      60_000,
    );

    const point = await findVisibleTextPoint(handle.page);
    await handle.page.mouse.click(point.x, point.y);
    await handle.page.waitForTimeout(100);
    const click = await collectClickDeviation(handle.page, point);
    assert(
      'clicking viewport text produces a selection within 4px',
      click.exists && click.deviationPx <= 4,
      JSON.stringify({ point, click }),
    );

    const cdp = await handle.page.context().newCDPSession(handle.page);
    const before = await handle.page.evaluate(() => {
      const editor = window.__marivellEditor as {
        state: { doc: { content: { size: number }; descendants: (fn: (node: { isTextblock?: boolean; textContent?: string }, pos: number) => boolean | void) => void } };
        commands: { focus: () => boolean; setTextSelection: (pos: number) => boolean };
      };
      let from = -1;
      editor.state.doc.descendants((node, pos) => {
        if (from !== -1) {
          return false;
        }
        if (node.isTextblock && node.textContent) {
          from = pos + 1;
          return false;
        }
        return true;
      });
      if (from === -1) {
        throw new Error('no text block');
      }
      editor.commands.setTextSelection(from);
      editor.commands.focus();
      return { size: editor.state.doc.content.size };
    });
    const inputStart = performance.now();
    await cdp.send('Input.insertText', { text: 'x' });
    const inputPoll = await handle.page.evaluate(async (size) => {
      const start = performance.now();
      const deadline = start + 5000;
      while (performance.now() < deadline) {
        const editor = window.__marivellEditor as {
          state?: { doc?: { content?: { size?: number } } };
        };
        if (
          editor?.state?.doc?.content &&
          typeof editor.state.doc.content.size === 'number' &&
          editor.state.doc.content.size === size + 1
        ) {
          return { applied: true, ms: performance.now() - start };
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return { applied: false, ms: performance.now() - start };
    }, before.size);
    const inputMs = performance.now() - inputStart;
    await handle.page.evaluate(() => {
      const editor = window.__marivellEditor as { commands: { undo: () => boolean } };
      editor.commands.undo();
    });
    await cdp.detach().catch(() => {});
    assert(
      'CDP insertText("x") echoes within 100ms',
      inputPoll.applied && inputMs <= 100,
      JSON.stringify({ inputApplied: inputPoll.applied, inputMs, pollMs: inputPoll.ms }),
    );

    const visual = await collectVisualContract(handle.page);
    assert(
      'viewport has no placeholders and visible formulas are real .katex',
      visual.placeholders === 0 &&
        visual.visibleFormulas > 0 &&
        visual.visibleKatex === visual.visibleFormulas,
      JSON.stringify(visual),
    );
    assert(
      'no overlay is on the ready path and hit test reaches editor content',
      visual.overlayCount === 0 && visual.hitEditor,
      JSON.stringify(visual),
    );
    assert(
      'posAtCoords answers all five viewport samples',
      visual.sampled === 5 && visual.nonNull === 5,
      JSON.stringify(visual),
    );
    assert(
      'scrollTop is stable across 10 rAFs with zero layout shift',
      visual.scroll.stableFrames === 10 &&
        visual.scroll.layoutShiftEntries === 0 &&
        visual.scroll.layoutShiftCumulative === 0,
      JSON.stringify(visual.scroll),
    );

    await handle.page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-source-mode' }),
      );
    });
    await waitForSourceInput(handle.page);
    const sourceContract = await handle.page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      const input = frame?.querySelector<HTMLTextAreaElement>('.source-editor__input');
      const hit = input
        ? document.elementFromPoint(
            input.getBoundingClientRect().left + input.getBoundingClientRect().width / 2,
            input.getBoundingClientRect().top + input.getBoundingClientRect().height / 2,
          )
        : null;
      return {
        overlayCount: document.querySelectorAll('.editor-loading, .editor-loading--mode-switch').length,
        hitEditor: Boolean(hit && input?.contains(hit)),
        valueReady: Boolean(input && input.value.length > 0),
      };
    });
    assert(
      'source mode is unmasked and the textarea is hit-testable',
      sourceContract.overlayCount === 0 && sourceContract.hitEditor && sourceContract.valueReady,
      JSON.stringify(sourceContract),
    );

    await handle.page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('markdown-editor:menu-action', { detail: 'toggle-source-mode' }),
      );
    });
    await waitForVisualMode(handle.page);
    const visualAfterRoundTrip = await collectVisualContract(handle.page);
    assert(
      'source->visual return keeps UIFF viewport real and unmasked',
      visualAfterRoundTrip.placeholders === 0 &&
        visualAfterRoundTrip.visibleFormulas > 0 &&
        visualAfterRoundTrip.visibleKatex === visualAfterRoundTrip.visibleFormulas &&
        visualAfterRoundTrip.overlayCount === 0 &&
        visualAfterRoundTrip.hitEditor &&
        visualAfterRoundTrip.nonNull === 5,
      JSON.stringify(visualAfterRoundTrip),
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

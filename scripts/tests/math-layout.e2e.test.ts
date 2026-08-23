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
  const filler: string[] = [];
  for (let index = 0; index < 160; index += 1) {
    filler.push(
      `## Filler Section ${index}`,
      '',
      `Paragraph ${index} keeps the math probe below the initial viewport and allows its placeholder height cache to settle.`,
      '',
    );
  }
  return [
    ...filler,
    '# Math Layout Probe',
    '',
    'Before text $a$ and ordinary a after keeps the simple baseline measurable.',
    '',
    'Before text $\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}$ after text keeps the high formula measurable.',
    '',
    '$$',
    '\\begin{aligned}',
    'a &= b + c \\\\',
    '  &= d + \\frac{e}{f} \\\\',
    '  &= \\sum_{i=1}^{n} i^2 \\\\',
    '  &= \\int_0^1 x^2\\,dx \\\\',
    '  &= \\left(\\begin{matrix} 1 & 2 \\\\ 3 & 4 \\end{matrix}\\right) \\\\',
    '  &= \\sqrt{\\frac{a^2+b^2}{c^2+d^2}} \\\\',
    '  &= \\frac{p}{q} + \\frac{r}{s} \\\\',
    '  &= \\lim_{x \\to 0} \\frac{\\sin x}{x} \\\\',
    '  &= \\begin{cases} x & \\text{if } y \\\\ 0 & \\text{otherwise} \\end{cases}',
    '\\end{aligned}',
    '$$',
    '',
    'A following paragraph keeps the tall block clearly separated from the inline check.',
    '',
    '$$',
    'x',
    '$$',
    '',
    'Structural following paragraph has no extra visual gap.',
    '',
    '$$',
    'y',
    '$$',
    '',
    '',
    'Explicit following paragraph keeps one requested blank line.',
    '',
  ].join('\n');
}
async function main(): Promise<void> {
  console.log('\n## math layout e2e');
  const source = buildMarkdown();
  const markdownPath = path.join(os.tmpdir(), `marivell-math-layout-${process.pid}.md`);
  fs.writeFileSync(markdownPath, source, 'utf8');
  const outDir = path.join(os.tmpdir(), `marivell-math-layout-build-${process.pid}`);
  const profile = path.join(os.tmpdir(), `marivell-math-layout-profile-${process.pid}`);
  const port = 9600 + (process.pid % 200);

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
    assert('open math layout document in visual mode', ready.ok && !ready.value.timedOut, JSON.stringify(ready));
    await handle.page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      if (frame) {
        frame.scrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
        frame.dispatchEvent(new Event('scroll'));
      }
    });
    await withTimeout(
      handle.page.waitForFunction(() => {
        const frame = document.querySelector<HTMLElement>('.editor-frame');
        if (!frame) return false;
        const hasActiveBlock = Array.from(frame.querySelectorAll('.math-block-node')).some(
          (element) => element.querySelector(':scope > .math-node-preview .katex') !== null,
        );
        const hasActiveInline = Array.from(frame.querySelectorAll('.math-inline-node')).some(
          (element) => element.querySelector(':scope > .math-node-preview .katex') !== null,
        );
        return hasActiveBlock && hasActiveInline;
      }, undefined, { timeout: 20_000 }),
      25_000,
      'math activation',
    );
    await handle.page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      const block = frame?.querySelector<HTMLElement>('.math-block-node');
      if (frame && block) {
        block.scrollIntoView({ block: 'center' });
        frame.dispatchEvent(new Event('scroll'));
      }
    });
    await withTimeout(
      handle.page.waitForFunction(() => {
        const frame = document.querySelector<HTMLElement>('.editor-frame');
        const block = frame?.querySelector<HTMLElement>('.math-block-node');
        const preview = block?.querySelector<HTMLElement>(':scope > .math-node-preview');
        if (!block || !preview) return false;
        const frameRect = frame?.getBoundingClientRect();
        const blockRect = block.getBoundingClientRect();
        return Boolean(
          frameRect &&
          blockRect.bottom > frameRect.top &&
          blockRect.top < frameRect.bottom &&
          blockRect.height >= preview.getBoundingClientRect().height - 2,
        );
      }, undefined, { timeout: 20_000 }),
      25_000,
      'block visible layout',
    );

    const metrics = await handle.page.evaluate(`(() => {
      const frame = document.querySelector('.editor-frame');
      if (!frame) throw new Error('editor frame missing');
      const blockCandidates = Array.from(frame.querySelectorAll('.math-block-node'));
      const blockWithKatex = blockCandidates
        .map((element) => ({
          element,
          katex: element.querySelector(':scope > .math-node-preview .katex'),
        }))
        .filter((entry) => entry.katex !== null)
        .sort((a, b) => b.katex.getBoundingClientRect().height - a.katex.getBoundingClientRect().height)[0];
      const block = blockWithKatex ? blockWithKatex.element : null;
      const blockKatex = blockWithKatex ? blockWithKatex.katex : null;

      const allInline = Array.from(frame.querySelectorAll('.math-inline-node'))
        .map((element) => {
          const katex = element.querySelector(':scope > .math-node-preview .katex');
          const base = katex ? katex.querySelector('.katex-html .base') : null;
          return {
            element,
            katex,
            base,
            baseHeight: base ? base.getBoundingClientRect().height : 0,
          };
        })
        .filter((entry) => entry.katex !== null);
      const tallInlineEntry = allInline
        .slice()
        .sort((a, b) => b.baseHeight - a.baseHeight)[0];
      const simpleInlineEntry = allInline.find(
        (entry) => entry.element.querySelector(':scope .mord')?.textContent?.trim() === 'a',
      ) ?? allInline[0];
      const inline = tallInlineEntry ? tallInlineEntry.element : null;
      const inlineKatex = tallInlineEntry ? tallInlineEntry.katex : null;
      const inlineBase = tallInlineEntry ? tallInlineEntry.base : null;
      const simpleInline = simpleInlineEntry ? simpleInlineEntry.element : null;
      const simpleKatex = simpleInlineEntry ? simpleInlineEntry.katex : null;
      const simpleGlyph = simpleInline
        ? (simpleInline.querySelector(':scope .katex .mord') ?? simpleKatex)
        : null;

      const blockPreview = block ? block.querySelector(':scope > .math-node-preview') : null;
      const inlinePreview = inline ? inline.querySelector(':scope > .math-node-preview') : null;

      const rect = (element) => {
        if (!element) return null;
        const value = element.getBoundingClientRect();
        return {
          top: value.top,
          bottom: value.bottom,
          left: value.left,
          right: value.right,
          width: value.width,
          height: value.height,
        };
      };

      const paragraph = inline ? inline.closest('p') : null;
      const textNodes = paragraph
        ? Array.from(paragraph.childNodes).filter(
            (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent && node.textContent.trim()),
          )
        : [];
      const firstText = textNodes[0];
      const lastText = textNodes[textNodes.length - 1];
      const firstTextRect = firstText instanceof Node
        ? (() => {
            const range = document.createRange();
            range.selectNodeContents(firstText);
            return range.getBoundingClientRect();
          })()
        : null;
      const lastTextRect = lastText instanceof Node
        ? (() => {
            const range = document.createRange();
            range.selectNodeContents(lastText);
            return range.getBoundingClientRect();
          })()
        : null;

      const simpleParagraph = simpleInline ? simpleInline.closest('p') : null;
      const simpleTextNodes = simpleParagraph
        ? Array.from(simpleParagraph.childNodes).filter(
            (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent && node.textContent.trim()),
          )
        : [];
      const firstSimpleText = simpleTextNodes[0];
      const firstSimpleTextRect = firstSimpleText instanceof Node
        ? (() => {
            const range = document.createRange();
            range.selectNodeContents(firstSimpleText);
            return range.getBoundingClientRect();
          })()
        : null;

      const blockStyle = blockPreview ? getComputedStyle(blockPreview) : null;
      const inlineStyle = inline ? getComputedStyle(inline) : null;
      const inlinePreviewStyle = inlinePreview ? getComputedStyle(inlinePreview) : null;
      const lineTop = firstTextRect && lastTextRect ? Math.min(firstTextRect.top, lastTextRect.top) : null;
      const lineBottom = firstTextRect && lastTextRect ? Math.max(firstTextRect.bottom, lastTextRect.bottom) : null;
      const textCenter = lineTop !== null && lineBottom !== null ? (lineTop + lineBottom) / 2 : null;
      const inlinePreviewRect = rect(inlinePreview);
      const inlineCenter = inlinePreviewRect ? (inlinePreviewRect.top + inlinePreviewRect.bottom) / 2 : null;

      const simpleGlyphRect = rect(simpleGlyph);
      const simpleBottomDelta =
        simpleGlyphRect && firstSimpleTextRect
          ? Math.abs(simpleGlyphRect.bottom - firstSimpleTextRect.bottom)
          : null;
      const inlineBaseRect = rect(inlineBase);

      return {
        block: {
          active: Boolean(block && blockKatex && !block.classList.contains('math-block-node-placeholder')),
          katexHeight: rect(blockKatex) ? rect(blockKatex).height : 0,
          wrapperHeight: rect(block) ? rect(block).height : 0,
          previewHeight: rect(blockPreview) ? rect(blockPreview).height : 0,
          katexInsideWrapper: Boolean(
            block && blockKatex && rect(block) && rect(blockKatex) &&
            rect(blockKatex).top >= rect(block).top - 0.5 &&
            rect(blockKatex).bottom <= rect(block).bottom + 0.5,
          ),
          previewHeightAtLeastKatex: Boolean(
            blockPreview && blockKatex &&
            rect(blockPreview).height >= rect(blockKatex).height - 1,
          ),
          previewOverflowY: blockStyle ? blockStyle.overflowY : null,
          previewInlineHeight: blockPreview ? blockPreview.style.height : null,
          previewScrollHeight: blockPreview ? blockPreview.scrollHeight : 0,
          previewClientHeight: blockPreview ? blockPreview.clientHeight : 0,
          scrollHeight: block ? block.scrollHeight : 0,
          clientHeight: block ? block.clientHeight : 0,
        },
        inline: {
          active: Boolean(inline && inlineKatex && !inline.classList.contains('math-inline-node--placeholder')),
          katexHeight: rect(inlineKatex) ? rect(inlineKatex).height : 0,
          wrapperHeight: rect(inline) ? rect(inline).height : 0,
          previewHeight: rect(inlinePreview) ? rect(inlinePreview).height : 0,
          katexInsideWrapper: Boolean(
            inline && inlineKatex && rect(inline) && rect(inlineKatex) &&
            rect(inlineKatex).top >= rect(inline).top - 0.5 &&
            rect(inlineKatex).bottom <= rect(inline).bottom + 0.5,
          ),
          previewHeightAtLeastKatex: Boolean(
            inlinePreview && inlineKatex &&
            rect(inlinePreview).height >= rect(inlineKatex).height - 1,
          ),
          wrapperOverflowY: inlineStyle ? inlineStyle.overflowY : null,
          previewOverflowY: inlinePreviewStyle ? inlinePreviewStyle.overflowY : null,
          wrapperVerticalAlign: inlineStyle ? inlineStyle.verticalAlign : null,
          previewVerticalAlign: inlinePreviewStyle ? inlinePreviewStyle.verticalAlign : null,
          sameLine: Boolean(
            firstTextRect && lastTextRect &&
            firstTextRect.bottom > lastTextRect.top &&
            lastTextRect.bottom > firstTextRect.top,
          ),
          textCenter,
          inlineCenter,
          centerDelta: textCenter !== null && inlineCenter !== null ? Math.abs(inlineCenter - textCenter) : null,
          katexTop: rect(inlineKatex) ? rect(inlineKatex).top : 0,
          katexBottom: rect(inlineKatex) ? rect(inlineKatex).bottom : 0,
          lineTop,
          lineBottom,
          previewScrollHeight: inlinePreview ? inlinePreview.scrollHeight : 0,
          previewClientHeight: inlinePreview ? inlinePreview.clientHeight : 0,
        },
        simple: {
          active: Boolean(simpleInline && simpleKatex && !simpleInline.classList.contains('math-inline-node--placeholder')),
          glyphBottom: simpleGlyphRect ? simpleGlyphRect.bottom : null,
          textBottom: firstSimpleTextRect ? firstSimpleTextRect.bottom : null,
          bottomDelta: simpleBottomDelta,
          wrapperVerticalAlign: simpleInline ? getComputedStyle(simpleInline).verticalAlign : null,
          previewVerticalAlign: simpleInline && simpleInline.querySelector(':scope > .math-node-preview')
            ? getComputedStyle(simpleInline.querySelector(':scope > .math-node-preview')).verticalAlign
            : null,
        },
        highInline: {
          baseHeight: inlineBaseRect ? inlineBaseRect.height : 0,
          wrapperHeight: rect(inline) ? rect(inline).height : 0,
          baseInsideWrapper: Boolean(
            inline && inlineBase && rect(inline) && inlineBaseRect &&
            inlineBaseRect.top >= rect(inline).top - 0.5 &&
            inlineBaseRect.bottom <= rect(inline).bottom + 0.5,
          ),
          wrapperHeightAtLeastBase: Boolean(
            inline && inlineBase && rect(inline) && inlineBaseRect &&
            rect(inline).height >= inlineBaseRect.height - 1,
          ),
          extendsAboveText: Boolean(firstTextRect && inlineBaseRect && inlineBaseRect.top < firstTextRect.top - 0.5),
          extendsBelowText: Boolean(firstTextRect && inlineBaseRect && inlineBaseRect.bottom > firstTextRect.bottom + 0.5),
        },
      };
    })()`);
    console.log('  math layout probe:', JSON.stringify(metrics));

    await handle.page.evaluate(() => {
      const frame = document.querySelector<HTMLElement>('.editor-frame');
      if (frame) {
        frame.scrollTop = Math.max(frame.scrollHeight - frame.clientHeight, 0);
        frame.dispatchEvent(new Event('scroll'));
      }
    });
    await withTimeout(
      handle.page.waitForFunction(() => {
        const blocks = Array.from(document.querySelectorAll('.math-block-node'));
        return Boolean(
          blocks.find((element) =>
            element.parentElement?.nextElementSibling?.textContent?.startsWith('Structural following paragraph'),
          )?.querySelector(':scope > .math-node-preview .katex') &&
          blocks.find((element) =>
            element.parentElement?.nextElementSibling?.textContent?.startsWith('Explicit following paragraph'),
          )?.querySelector(':scope > .math-node-preview .katex'),
        );
      }, undefined, { timeout: 20_000 }),
      25_000,
      'spacing activation',
    );
    const spacingMetrics = await handle.page.evaluate(`(() => {
      const frame = document.querySelector('.editor-frame');
      if (!frame) throw new Error('editor frame missing');
      const probeSpacing = (paragraphPrefix) => {
        const entry = Array.from(frame.querySelectorAll('.math-block-node'))
          .map((element) => ({ element, paragraph: element.closest('p') }))
          .find(({ paragraph }) =>
            paragraph?.tagName === 'P' &&
            paragraph.nextElementSibling?.textContent?.startsWith(paragraphPrefix),
          );
        const katexDisplay = entry?.element.querySelector(':scope > .math-node-preview .katex-display');
        const mathElement = entry?.element.querySelector(':scope > .math-node-preview .katex');
        const wrapperRect = entry?.paragraph?.getBoundingClientRect();
        const followingRect = entry?.paragraph?.nextElementSibling?.getBoundingClientRect();
        const mathRect = mathElement?.getBoundingClientRect();
        return {
          active: Boolean(mathElement),
          katexBottomOverflow: wrapperRect && mathRect ? mathRect.bottom - wrapperRect.bottom : null,
          visualGap: mathRect && followingRect ? followingRect.top - mathRect.bottom : null,
          blockMarginBottom: entry ? getComputedStyle(entry.element).marginBottom : null,
          blockPaddingBottom: entry ? getComputedStyle(entry.element).paddingBottom : null,
          wrapperMarginBottom: entry?.paragraph ? getComputedStyle(entry.paragraph).marginBottom : null,
          wrapperMarginTop: entry?.paragraph ? getComputedStyle(entry.paragraph).marginTop : null,
          displayMarginBottom: katexDisplay ? getComputedStyle(katexDisplay).marginBottom : null,
          trailingBlankLines: entry?.element.dataset.trailingBlankLines ?? null,
          pseudoHeight: entry ? getComputedStyle(entry.element, '::after').height : null,
          previewMinHeight: entry?.element.querySelector(':scope > .math-node-preview')
            ? getComputedStyle(entry.element.querySelector(':scope > .math-node-preview')).minHeight
            : null,
        };
      };
      return {
        structural: probeSpacing('Structural following paragraph'),
        explicit: probeSpacing('Explicit following paragraph'),
      };
    })()`);
    console.log('  math spacing probe:', JSON.stringify(spacingMetrics));

    assert(
      'tall display math is active and taller than the 96px placeholder',
      metrics.block.active && metrics.block.katexHeight > 96,
      JSON.stringify(metrics.block),
    );
    assert(
      'active block math KaTeX is not clipped by wrapper or preview height locking',
      metrics.block.katexInsideWrapper &&
        metrics.block.previewHeightAtLeastKatex &&
        metrics.block.previewOverflowY === 'visible' &&
        metrics.block.previewInlineHeight === 'auto',
      JSON.stringify(metrics.block),
    );
    assert(
      'active inline math is rendered and not clipped',
      metrics.inline.active &&
        metrics.inline.katexInsideWrapper &&
        metrics.inline.previewHeightAtLeastKatex &&
        metrics.highInline.baseInsideWrapper &&
        metrics.highInline.wrapperHeightAtLeastBase,
      JSON.stringify({ ...metrics.inline, ...metrics.highInline }),
    );
    assert(
      'active inline math uses visible overflow and baseline alignment',
      metrics.inline.wrapperOverflowY === 'visible' &&
        metrics.inline.previewOverflowY === 'visible' &&
        metrics.inline.wrapperVerticalAlign === 'baseline' &&
        metrics.inline.previewVerticalAlign === 'baseline',
      JSON.stringify(metrics.inline),
    );
    assert(
      'simple $a$ bottom aligns with ordinary text a',
      metrics.simple.active &&
        metrics.simple.bottomDelta !== null &&
        metrics.simple.bottomDelta <= 1,
      JSON.stringify(metrics.simple),
    );
    assert(
      'high inline formula remains on the line without clipping or collapsing upward',
      metrics.inline.sameLine &&
        metrics.highInline.extendsAboveText &&
        metrics.highInline.extendsBelowText,
      JSON.stringify(metrics.highInline),
    );
    assert(
      'one structural newline after display math uses normal paragraph spacing',
      spacingMetrics.structural.active &&
        spacingMetrics.structural.trailingBlankLines === '0' &&
        spacingMetrics.structural.blockMarginBottom === '0px' &&
        spacingMetrics.structural.blockPaddingBottom === '0px' &&
        spacingMetrics.structural.wrapperMarginBottom !== null &&
        Number.parseFloat(spacingMetrics.structural.wrapperMarginBottom) >= 12 &&
        Number.parseFloat(spacingMetrics.structural.wrapperMarginBottom) <= 18 &&
        spacingMetrics.structural.wrapperMarginTop === '0px' &&
        spacingMetrics.structural.displayMarginBottom === '0px' &&
        spacingMetrics.structural.visualGap !== null &&
        spacingMetrics.structural.visualGap >= 10 &&
        spacingMetrics.structural.visualGap <= 24,
      JSON.stringify(spacingMetrics.structural),
    );
    assert(
      'additional newlines after display math remain explicit blank spacers',
      spacingMetrics.explicit.active &&
        spacingMetrics.explicit.trailingBlankLines === '1' &&
        spacingMetrics.explicit.visualGap !== null &&
        spacingMetrics.structural.visualGap !== null &&
        spacingMetrics.explicit.visualGap - spacingMetrics.structural.visualGap >= 24 &&
        spacingMetrics.explicit.visualGap - spacingMetrics.structural.visualGap <= 42,
      JSON.stringify(spacingMetrics),
    );
    assert(
      'inline math stays on the surrounding text line',
      metrics.inline.sameLine && metrics.inline.centerDelta !== null && metrics.inline.centerDelta <= 12,
      JSON.stringify(metrics.inline),
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

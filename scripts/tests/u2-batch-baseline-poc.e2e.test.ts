import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runU2BatchBaselinePoCE2E,
  type U2BatchE2EResult,
} from '../benchmark/u2-batch-baseline-poc.ts';

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

function waitUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<{ ok: true; value: T } | { ok: false; label: string }> {
  const timeout = waitUnref(timeoutMs).then(() => ({ ok: false as const, label }));
  const result = await Promise.race([
    promise.then((value) => ({ ok: true as const, value })),
    timeout,
  ]);
  return result;
}

async function main(): Promise<void> {
  console.log('\n## U2.2 batch/baseline single-node PoC e2e');
  const run = await withTimeout(
    runU2BatchBaselinePoCE2E(),
    600_000,
    'u2-batch-baseline-poc',
  );
  assert('U2.2 PoC completes on a real Electron renderer', run.ok, run.ok ? '' : run.label);
  if (!run.ok) {
    failed += 1;
    console.error(failures.join('\n'));
    process.exit(1);
  }
  const result: U2BatchE2EResult = run.value;
  const page = result.page;
  const corpus = result.corpus;
  const rawPath = path.join(os.tmpdir(), `marivell-u2b-final-${Date.now()}.json`);
  fs.writeFileSync(rawPath, JSON.stringify(result, null, 2), 'utf8');

  console.log(
    `  corpus=${corpus.selected} inline=${corpus.inline} block=${corpus.block} quartiles=${corpus.quartileCounts.join('/')}`,
  );
  console.log(
    `  strictA=${page.baseline.strictA.length} baselineMax=${page.baseline.strictTextBaselineDeltaMaxPx.toFixed(3)}px textBottomMax=${page.baseline.strictTextBottomDeltaMaxPx.toFixed(3)}px`,
  );
  console.log(
    `  inline bottom p50/p95=${page.baseline.perFormulaInline.bottomDeltaPx.p50.toFixed(3)}/${page.baseline.perFormulaInline.bottomDeltaPx.p95.toFixed(3)}px`,
  );
  console.log(
    `  batch canvas=${page.batch.canvas.batches} batches/${page.batch.canvas.tasks} tasks, timers activeMax=${page.batch.timers.activeMax}`,
  );

  assert('corpus has at least 200 layered real formulas', corpus.selected >= 200, JSON.stringify(corpus));
  assert('corpus balances inline and block formulas', corpus.inline >= 80 && corpus.block >= 80, JSON.stringify(corpus));
  assert('corpus covers every HTML-size quartile', corpus.quartileCounts.every((count) => count >= 20), JSON.stringify(corpus.quartileCounts));
  assert('page measured all formulas', page.formulaStats.length >= 200, String(page.formulaStats.length));
  assert(
    'KaTeX HTML node count is measured and larger than a single node',
    page.dom.katexHtmlNodeCount.count >= 200 && page.dom.katexHtmlNodeCount.p50 >= 5,
    JSON.stringify(page.dom.katexHtmlNodeCount),
  );
  assert(
    'both single-node candidates stay at one DOM node',
    page.dom.candidateNodeCount['canvas-raster'].count >= 200 &&
      page.dom.candidateNodeCount['canvas-raster'].max === 1 &&
      page.dom.candidateNodeCount['bitmap-data-url'].max === 1,
    JSON.stringify(page.dom.candidateNodeCount),
  );
  assert(
    'injection timing was sampled for both representations',
    page.injection['canvas-raster'].samples >= 200 * 10 &&
      page.injection['bitmap-data-url'].samples >= 200 * 10 &&
      page.injection['canvas-raster'].ms.p95 > 0 &&
      page.injection['bitmap-data-url'].ms.p95 > 0,
    JSON.stringify(page.injection),
  );
  assert(
    'inline $a$ strict baseline samples exist for both candidates and multiple fonts',
    page.baseline.strictA.length >= 6,
    JSON.stringify(page.baseline.strictA),
  );
  assert(
    'inline $a$ virtual baseline aligns to text baseline within 1px',
    page.baseline.strictTextBaselineDeltaMaxPx <= 1,
    `max=${page.baseline.strictTextBaselineDeltaMaxPx.toFixed(3)}`,
  );
  assert(
    'inline $a$ raster bottom aligns to plain text line-box bottom within 1px',
    page.baseline.strictA.every(
      (sample) => Math.abs(sample.bottomDeltaToTextLineBoxPx) <= 1,
    ),
    JSON.stringify(
      page.baseline.strictA.map((sample) => sample.bottomDeltaToTextLineBoxPx),
    ),
  );
  assert(
    'inline $a$ raster bottom aligns to KaTeX bottom within 1px',
    page.baseline.strictA.every(
      (sample) => Math.abs(sample.bottomDeltaToKatexPx) <= 1,
    ),
    JSON.stringify(page.baseline.strictA.map((sample) => sample.bottomDeltaToKatexPx)),
  );
  assert(
    'DPR clarity was sampled',
    page.dpr.samples >= 200,
    JSON.stringify(page.dpr),
  );
  assert(
    'DPR2 capture scaled above 1 CSS pixel per pixel',
    page.dpr.dpr2Scale.avg >= 1.8,
    JSON.stringify(page.dpr.dpr2Scale),
  );
  assert(
    'high formula crop coverage was captured for the corpus',
    page.highFormula.cropCoveredCount >= 200,
    JSON.stringify(page.highFormula),
  );
  assert(
    'no candidate crop was detected in the baseline host',
    page.highFormula.candidateCropDetectedCount === 0,
    JSON.stringify(page.highFormula),
  );
  const matrix = page.formulaStats.find(
    (stat) => stat.key === 'u2b-control-block-matrix',
  );
  assert(
    'controlled high matrix has no crop',
    Boolean(matrix && matrix.highFormula.cropCovered && !matrix.highFormula.candidateCropDetected),
    JSON.stringify(matrix?.highFormula),
  );
  assert(
    'batch processor completed every task for both kinds',
    page.batch.canvas.completed === page.batch.canvas.tasks &&
      page.batch.bitmap.completed === page.batch.bitmap.tasks &&
      page.batch.canvas.tasks >= 200 &&
      page.batch.bitmap.tasks >= 200,
    JSON.stringify({ canvas: page.batch.canvas, bitmap: page.batch.bitmap }),
  );
  assert(
    'batch processor used bounded batch size and concurrency',
    page.batch.canvas.batchSize === 12 &&
      page.batch.canvas.concurrency === 8 &&
      page.batch.bitmap.batchSize === 12 &&
      page.batch.bitmap.concurrency === 8,
    JSON.stringify({ canvas: page.batch.canvas, bitmap: page.batch.bitmap }),
  );
  assert(
    'same-frame swap limit stayed at 2-4',
    page.batch.canvas.maxSwapPerFrame === 3 &&
      page.batch.bitmap.maxSwapPerFrame === 3 &&
      page.batch.canvas.maxSwapsInFrameObserved <= 4 &&
      page.batch.bitmap.maxSwapsInFrameObserved <= 4,
    JSON.stringify({ canvas: page.batch.canvas, bitmap: page.batch.bitmap }),
  );
  assert(
    'batch queue did not create one timer per formula',
    page.batch.timers.activeMax <= 4 && page.batch.timers.perFormulaCalls < 1,
    JSON.stringify(page.batch.timers),
  );
  assert(
    'viewport/anchor priority tasks were swapped before far tasks',
    (() => {
      const orderOk = (result: typeof page.batch.canvas): boolean => {
        const priority0Keys = new Set(result.priority0Keys);
        return (
          result.priority0Keys.length >= 12 &&
          result.processedKeys.slice(0, 12).every((key) => priority0Keys.has(key)) &&
          new Set(result.processedKeys.slice(0, 12)).size === 12
        );
      };
      return (
        orderOk(page.batch.canvas) && orderOk(page.batch.bitmap)
      );
    })(),
    JSON.stringify({
      canvasPriority0Count: page.batch.canvas.priority0Keys.length,
      bitmapPriority0Count: page.batch.bitmap.priority0Keys.length,
      canvasFirst16: page.batch.canvas.processedKeys.slice(0, 16),
      canvas: page.batch.canvas.processedKeys.slice(0, 20),
      bitmap: page.batch.bitmap.processedKeys.slice(0, 20),
    }),
  );
  assert(
    'memory API is available and reports harness deltas',
    page.memory.apiAvailable &&
      page.memory.usedBeforeHarness !== null &&
      page.memory.usedAfterCleanup !== null,
    JSON.stringify(page.memory),
  );
  assert(
    'copy path preserves LaTeX source',
    page.capabilities.editorCopy.attempted && page.capabilities.editorCopy.latexPreserved,
    JSON.stringify(page.capabilities.editorCopy),
  );
  assert(
    'search path remains based on source text',
    page.capabilities.editorSearch.found &&
      result.nodeCapabilities.sourceSearchMatchCount > 0,
    JSON.stringify({ editorSearch: page.capabilities.editorSearch, node: result.nodeCapabilities }),
  );
  assert(
    'edit path can restore KaTeX HTML from the single-node prototype',
    page.capabilities.restore.katexPresent &&
      page.capabilities.restore.restoredNodeCount > 1 &&
      result.nodeCapabilities.restoreHasHtml,
    JSON.stringify({ page: page.capabilities.restore, node: result.nodeCapabilities }),
  );
  assert(
    'export path can emit high-resolution bitmap or original HTML',
    page.capabilities.export.dataUrlPresent &&
      page.capabilities.export.htmlPresent &&
      result.nodeCapabilities.exportDataUrlPresent &&
      result.nodeCapabilities.exportHtmlHasKatex,
    JSON.stringify({ page: page.capabilities.export, node: result.nodeCapabilities }),
  );
  assert(
    'serialized single-node source round-trips into Markdown math',
    result.nodeCapabilities.markdownRoundTripOk,
    JSON.stringify(result.nodeCapabilities),
  );

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

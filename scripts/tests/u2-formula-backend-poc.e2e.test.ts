import {
  runU2FormulaBackendPoCE2E,
  type U2E2EResult,
} from '../benchmark/u2-formula-backend-poc.ts';

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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = waitUnref(timeoutMs).then(() => ({ ok: false as const, label }));
  const result = await Promise.race([
    promise.then((value) => ({ ok: true as const, value })),
    timeout,
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

async function main(): Promise<void> {
  console.log('\n## U2 formula backend single-node PoC e2e');
  const run = await withTimeout(runU2FormulaBackendPoCE2E(), 420_000, 'u2-formula-backend-poc');
  assert('U2 PoC completes on a real Electron renderer', run.ok, run.ok ? '' : run.label);
  if (!run.ok) {
    failed += 1;
    console.error(failures.join('\n'));
    process.exit(1);
  }
  const result: U2E2EResult = run.value;
  const page = result.page;
  const corpus = result.corpus;

  console.log(
    `  corpus=${corpus.selected} inline=${corpus.inline} block=${corpus.block} quartiles=${corpus.quartileCounts.join('/')}`,
  );
  console.log(
    `  katex nodes p50=${page.dom.katexHtmlNodeCount.p50.toFixed(2)} candidate nodes=${page.dom.candidateSubtreeNodeCount['bitmap-data-url'].p50.toFixed(2)}`,
  );
  console.log(
    `  injection p50/p95 katex=${page.injection['katex-html'].ms.p50.toFixed(3)}/${page.injection['katex-html'].ms.p95.toFixed(3)}ms bitmap=${page.injection['bitmap-data-url'].ms.p50.toFixed(3)}/${page.injection['bitmap-data-url'].ms.p95.toFixed(3)}ms`,
  );
  console.log(
    `  baseline bottom p50/p95=${page.baseline.bottomDeltaPx.p50.toFixed(3)}/${page.baseline.bottomDeltaPx.p95.toFixed(3)}px`,
  );
  console.log(
    `  dpr2Scale avg=${page.dpr.dpr2Scale.avg.toFixed(2)} dpr1v2 mean=${page.dpr.dpr1VsDpr2MeanAbsDiff.avg.toFixed(3)}`,
  );

  assert('corpus has at least 200 layered real formulas', corpus.selected >= 200, JSON.stringify(corpus));
  assert('corpus balances inline and block formulas', corpus.inline >= 80 && corpus.block >= 80, JSON.stringify(corpus));
  assert('corpus covers every HTML-size quartile', corpus.quartileCounts.every((count) => count >= 20), JSON.stringify(corpus.quartileCounts));
  assert('page measured all formulas', page.formulaStats.length >= 200, String(page.formulaStats.length));
  assert(
    'KaTeX HTML node count is measured and larger than a single node',
    page.dom.katexHtmlNodeCount.count >= 200 &&
      page.dom.katexHtmlNodeCount.p50 >= 5,
    JSON.stringify(page.dom.katexHtmlNodeCount),
  );
  assert(
    'all single-node candidates stay at one DOM node',
    ['canvas-raster', 'bitmap-data-url', 'svg-viewbox'].every(
      (kind) =>
        page.dom.candidateSubtreeNodeCount[kind as 'canvas-raster'].count >= 200 &&
        page.dom.candidateSubtreeNodeCount[kind as 'canvas-raster'].max === 1,
    ),
    JSON.stringify(page.dom.candidateSubtreeNodeCount),
  );
  for (const kind of ['katex-html', 'canvas-raster', 'bitmap-data-url', 'svg-viewbox'] as const) {
    assert(
      `${kind} injection produced per-formula measured samples`,
      page.injection[kind].samples >= 200 * 20 && page.injection[kind].ms.p95 > 0,
      JSON.stringify(page.injection[kind]),
    );
  }
  assert(
    'candidate single-node injection p95 is far below the legacy innerHTML injection in this session',
    page.injection['bitmap-data-url'].ms.p95 < page.injection['katex-html'].ms.p95 &&
      page.injection['svg-viewbox'].ms.p95 < page.injection['katex-html'].ms.p95,
    JSON.stringify(page.injection),
  );
  assert('baseline offset was sampled', page.baseline.samples >= 200, JSON.stringify(page.baseline));
  assert(
    'candidate raster covers high formula content without cropping',
    page.highFormula.candidateCropCovered,
    JSON.stringify(page.highFormula),
  );
  assert('DPR clarity was sampled', page.dpr.samples >= 200, JSON.stringify(page.dpr));
  assert(
    'DPR2 capture scaled above 1 CSS pixel per pixel',
    page.dpr.dpr2Scale.avg >= 1.8,
    JSON.stringify(page.dpr.dpr2Scale),
  );
  assert(
    'pixel diff was sampled for all candidate kinds',
    ['canvas-raster', 'bitmap-data-url', 'svg-viewbox'].every(
      (kind) => page.pixelDiff[kind as 'canvas-raster'].samples >= 200,
    ),
    JSON.stringify(page.pixelDiff),
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
      page.capabilities.search.matchCount > 0 &&
      result.nodeCapabilities.sourceSearchMatchCount > 0,
    JSON.stringify({ editorSearch: page.capabilities.editorSearch, search: page.capabilities.search }),
  );
  assert(
    'edit path can restore KaTeX HTML from the single-node prototype',
    page.capabilities.restore.katexPresent && page.capabilities.restore.restoredNodeCount > 1,
    JSON.stringify(page.capabilities.restore),
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

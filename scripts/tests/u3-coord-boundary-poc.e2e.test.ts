import { runU3BoundaryPoCE2E } from '../benchmark/u3-coord-boundary-poc.ts';

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
  console.log('\n## U3.2 coordinate engine boundary PoC e2e');
  const run = await withTimeout(runU3BoundaryPoCE2E(), 240_000, 'u3-boundary-poc');
  const runFailure = (run as { label?: string }).label ?? '';
  assert('U3.2 PoC completes on a small file', run.ok, runFailure);
  if (!run.ok) {
    failed += 1;
    console.error(failures.join('\n'));
    process.exit(1);
  }
  const result = run.value;
  const page = result.page;

  console.log(
    `  sourceBytes=${result.sourceBytes} blocks=${page.environment.blockCount} lines=${page.environment.lineCount} cells=${page.environment.cellCount}`,
  );
  console.log(`  buildMs=${page.build.ms.toFixed(2)} ranges=${page.build.clientRectReads}`);
  console.log(
    `  coordsAtPos deltaPx p50/p95/max=${page.coordsAtPos.deltaPx.p50.toFixed(3)}/${page.coordsAtPos.deltaPx.p95.toFixed(3)}/${page.coordsAtPos.deltaPx.max.toFixed(3)}`,
  );
  console.log(
    `  posAtCoords posDelta p50/p95/max=${page.posAtCoords.posDelta.p50.toFixed(3)}/${page.posAtCoords.posDelta.p95.toFixed(3)}/${page.posAtCoords.posDelta.max.toFixed(3)}`,
  );
  console.log(
    `  posAtCoords maxDeltaPx p50/p95/max=${page.posAtCoords.maxDeltaPx.p50.toFixed(3)}/${page.posAtCoords.maxDeltaPx.p95.toFixed(3)}/${page.posAtCoords.maxDeltaPx.max.toFixed(3)} fallbackRate=${page.posAtCoords.fallbackRate.toFixed(3)}`,
  );
  console.log(
    `  scroll proto query rects/clientRects/PM=${page.scroll.proto.queryRectReads}/${page.scroll.proto.queryClientRectReads}/${page.scroll.proto.queryPmCalls}`,
  );

  assert(
    'offset table has enough blocks, lines, and DOM cells',
    page.environment.blockCount >= 8 &&
      page.environment.lineCount >= 16 &&
      page.environment.cellCount >= 16,
    JSON.stringify(page.environment),
  );
  assert(
    'build path did not call PM coordinate methods',
    page.build.nativeCoordsCalls === 0,
    JSON.stringify(page.build),
  );
  assert(
    'aggregated build kept Range.getClientRects well below per-character U3.1',
    page.build.clientRectReads > 0 && page.build.clientRectReads < 4_000,
    JSON.stringify(page.build),
  );
  assert(
    'coordsAtPos p95 and max are <=1px',
    page.coordsAtPos.deltaPx.p95 <= 1 && page.coordsAtPos.deltaPx.max <= 1,
    JSON.stringify(page.coordsAtPos.deltaPx),
  );
  assert(
    'posAtCoords posDelta p95 and max are <=1',
    page.posAtCoords.posDelta.p95 <= 1 && page.posAtCoords.posDelta.max <= 1,
    JSON.stringify(page.posAtCoords.posDelta),
  );
  assert(
    'posAtCoords coordinate mapping p95 and max are <=1px',
    page.posAtCoords.maxDeltaPx.p95 <= 1 && page.posAtCoords.maxDeltaPx.max <= 1,
    JSON.stringify(page.posAtCoords.maxDeltaPx),
  );
  assert(
    'real line/cell queries avoid PM fallback and rect reads',
    page.posAtCoords.lineHits > 0 &&
      page.posAtCoords.lineQueryRectReads === 0 &&
      page.posAtCoords.lineQueryClientRectReads === 0 &&
      page.posAtCoords.lineQueryPmCalls === 0,
    JSON.stringify(page.posAtCoords),
  );
  assert(
    'gap/edge fallback policy is bounded and explicit',
    page.posAtCoords.fallbackRate > 0 &&
      page.posAtCoords.fallbackRate < 1 &&
      page.posAtCoords.pmFallbacks === page.posAtCoords.samples - page.posAtCoords.lineHits,
    JSON.stringify(page.posAtCoords),
  );
  assert(
    'native and prototype query timings were collected',
    page.coordsAtPos.nativeMs.count > 0 &&
      page.coordsAtPos.protoMs.count > 0 &&
      page.posAtCoords.nativeMs.count > 0 &&
      page.posAtCoords.protoMs.count > 0,
    'query timing missing',
  );
  assert('scroll A/B produced frames', page.scroll.native.ms.count >= 10 && page.scroll.proto.ms.count >= 10, JSON.stringify(page.scroll));
  assert(
    'prototype scroll query path avoids Range client rect reads',
    page.scroll.proto.queryClientRectReads === 0,
    JSON.stringify(page.scroll.proto),
  );
  assert(
    'incremental update was measured without block rect reads or PM calls',
    page.incrementalUpdate.updateMs >= 0 &&
      page.incrementalUpdate.fullRebuildMs >= 0 &&
      page.incrementalUpdate.rectReads === 0 &&
      page.incrementalUpdate.nativeCoordsCalls === 0,
    JSON.stringify(page.incrementalUpdate),
  );
  assert(
    'incremental edit was restored',
    page.incrementalUpdate.restoredAfterUndo,
    JSON.stringify(page.incrementalUpdate),
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

import { runU3PocE2E } from '../benchmark/u3-poc.ts';

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
  console.log('\n## U3.0 coordinate engine PoC e2e');
  const run = await withTimeout(runU3PocE2E(), 180_000, 'u3-poc');
  assert('U3.0 PoC completes on a small file', run.ok, run.ok ? '' : run.label);
  if (!run.ok) {
    failed += 1;
    console.error(failures.join('\n'));
    process.exit(1);
  }
  const result = run.value;
  const page = result.page;

  console.log(
    `  sourceBytes=${result.sourceBytes} blocks=${page.environment.blockCount} lines=${page.environment.lineCount}`,
  );
  console.log(`  buildMs=${page.build.ms.toFixed(2)}`);
  console.log(
    `  coordsAtPos deltaPx p50/p95/max=${page.coordsAtPos.deltaPx.p50.toFixed(3)}/${page.coordsAtPos.deltaPx.p95.toFixed(3)}/${page.coordsAtPos.deltaPx.max.toFixed(3)}`,
  );
  console.log(
    `  posAtCoords posDelta p50/p95/max=${page.posAtCoords.posDelta.p50.toFixed(3)}/${page.posAtCoords.posDelta.p95.toFixed(3)}/${page.posAtCoords.posDelta.max.toFixed(3)}`,
  );
  console.log(
    `  scroll native/proto p50=${page.scroll.native.ms.p50.toFixed(2)}/${page.scroll.proto.ms.p50.toFixed(2)}ms`,
  );
  console.log(
    `  scroll rect reads native/proto=${page.scroll.native.rectReads}/${page.scroll.proto.rectReads}`,
  );
  console.log(
    `  scroll query rect reads native/proto=${page.scroll.native.queryRectReads}/${page.scroll.proto.queryRectReads}`,
  );

  assert('offset table has enough blocks and lines', page.environment.blockCount >= 8 && page.environment.lineCount >= 16, JSON.stringify(page.environment));
  assert('coordsAtPos produced sampled comparisons', page.coordsAtPos.samples >= 16, JSON.stringify(page.coordsAtPos.deltaPx));
  assert('posAtCoords produced sampled comparisons', page.posAtCoords.samples >= 16, JSON.stringify(page.posAtCoords.posDelta));
  assert('native and prototype query timings were collected', page.coordsAtPos.nativeMs.count > 0 && page.coordsAtPos.protoMs.count > 0, 'query timing missing');
  assert('scroll A/B produced frames', page.scroll.native.ms.count >= 10 && page.scroll.proto.ms.count >= 10, JSON.stringify(page.scroll));
  assert('prototype scroll queries avoid native rect reads', page.scroll.proto.queryRectReads === 0 && page.scroll.proto.queryClientRectReads === 0, JSON.stringify(page.scroll.proto));
  assert('incremental update was measured', page.incrementalUpdate.updateMs >= 0 && page.incrementalUpdate.fullRebuildMs >= 0, JSON.stringify(page.incrementalUpdate));
  assert('incremental edit was restored with undo', page.incrementalUpdate.restoredAfterUndo, JSON.stringify(page.incrementalUpdate));

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

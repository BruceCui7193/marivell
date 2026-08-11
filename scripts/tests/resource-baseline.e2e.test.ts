import path from 'node:path';
import {
  compactRound,
  RESOURCE_MARKDOWN_PATH,
  RESOURCE_MODE_CYCLES,
  runOneResourceRound,
} from '../benchmark/resource-metrics.ts';

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

async function main(): Promise<void> {
  console.log('\n## resource baseline e2e (small file only)');
  assert('small resource file exists', path.isAbsolute(RESOURCE_MARKDOWN_PATH));

  const round = await runOneResourceRound(1, RESOURCE_MARKDOWN_PATH);
  const compact = compactRound(round);

  assert(
    'round uses the required small markdown file',
    round.filePath === RESOURCE_MARKDOWN_PATH,
    round.filePath,
  );
  assert(
    'visual editor opens with live resource bridges',
    round.open.dom.totalNodes > 0 &&
      round.open.dom.cdpNodes > 0 &&
      round.open.heap.cdp !== null &&
      round.open.worker.exists,
    JSON.stringify(compact.open),
  );
  assert(
    'idle 10s sample reaches the requested duration',
    round.idle10.actualMs >= 9_500,
    `actualMs=${round.idle10.actualMs}`,
  );
  assert(
    'idle 10s collects rAF gaps',
    round.idle10.observers.rafGaps.length > 0,
    `rafGaps=${round.idle10.observers.rafGaps.length}`,
  );
  assert(
    `mode switch completes ${RESOURCE_MODE_CYCLES} full cycles`,
    round.modeSwitch.detail.cycles === RESOURCE_MODE_CYCLES &&
      Array.isArray(round.modeSwitch.detail.cycleDurations) &&
      round.modeSwitch.detail.cycleDurations.length === RESOURCE_MODE_CYCLES * 2 &&
      (round.modeSwitch.detail.cycleDurations as number[]).every((value) => value > 0),
    JSON.stringify(round.modeSwitch.detail),
  );
  const scrollDetail = round.scroll.detail as {
    maxScrollTop: number;
    reached: number[];
    finalScrollTop: number;
  };
  assert(
    'scroll round trip covers top -> bottom -> middle',
    scrollDetail.maxScrollTop > 0 &&
      scrollDetail.reached.length === 3 &&
      scrollDetail.reached[0] === 0 &&
      scrollDetail.reached[1] > 0 &&
      scrollDetail.reached[2] >= 0 &&
      scrollDetail.reached[2] <= scrollDetail.maxScrollTop,
    JSON.stringify(scrollDetail),
  );
  assert(
    'idle 30s sample reaches the requested duration',
    round.idle30.actualMs >= 29_000,
    `actualMs=${round.idle30.actualMs}`,
  );
  assert(
    'idle 30s collects rAF gaps',
    round.idle30.observers.rafGaps.length > 0,
    `rafGaps=${round.idle30.observers.rafGaps.length}`,
  );
  assert(
    'TreeWalker and CDP DOM counters are cross-validatable',
    round.final.dom.totalNodes > 0 && round.final.dom.cdpNodes > 0,
    `tree=${round.final.dom.totalNodes} cdp=${round.final.dom.cdpNodes}`,
  );
  assert(
    'worker diagnostics are available in compact output',
    Boolean(compact.open.workerFormulaChunks || compact.open.workerInline),
    JSON.stringify(compact.open.workerFormulaChunks),
  );
  assert(
    'worker queue depth diagnostics expose depth and backpressure fields',
    typeof round.open.worker.formulaQueueDepth === 'number' &&
      typeof round.open.worker.formulaInFlightCount === 'number' &&
      typeof round.open.worker.pendingFormulaHtmlChunks === 'number' &&
      typeof round.open.worker.formulaChunkPumpThrottled === 'boolean' &&
      typeof round.open.worker.maxFormulaQueueDepth === 'number',
    JSON.stringify(round.open.worker),
  );
  assert(
    'idle samples carry worker queue depth deltas',
    typeof round.idle10.workerQueueDepthDelta === 'number' &&
      typeof round.idle30.workerPendingHtmlDelta === 'number',
    JSON.stringify({ idle10: round.idle10.workerQueueDepthDelta, idle30: round.idle30.workerPendingHtmlDelta }),
  );

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

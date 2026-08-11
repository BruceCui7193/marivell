import {
  runU4ModeSwitchPocE2E,
  type U4ModeSwitchE2EResult,
} from '../benchmark/u4-mode-switch-poc.ts';

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
  console.log('\n## U4.0 mode-switch host strategy PoC e2e');
  const run = await withTimeout(runU4ModeSwitchPocE2E(), 600_000, 'u4-mode-switch-poc');
  assert('U4.0 PoC completes on a real Electron renderer', run.ok, run.ok ? '' : run.label);
  if (!run.ok) {
    failed += 1;
    console.error(failures.join('\n'));
    process.exit(1);
  }
  const result: U4ModeSwitchE2EResult = run.value;
  const strategies = result.strategies;
  const baseline = strategies.find((entry) => entry.strategy === 'display-none');
  const left = strategies.find((entry) => entry.strategy === 'left-offscreen');
  const transform = strategies.find((entry) => entry.strategy === 'transform-offscreen');

  assert(
    'PoC compares all three host strategies',
    Boolean(baseline && left && transform),
    `strategies=${strategies.map((entry) => entry.strategy).join(',')}`,
  );
  assert(
    'generated source is a small benchmark document',
    result.sourceBytes > 1_000 && result.sourceBytes < 2_000_000,
    `sourceBytes=${result.sourceBytes}`,
  );

  for (const strategy of strategies) {
    const prefix = strategy.strategy;
    assert(
      `${prefix}: collected 10 visual->source samples`,
      strategy.visualToSource.length === 10 &&
        strategy.visualToSource.every((sample) => sample.wallMs > 0),
      `count=${strategy.visualToSource.length}`,
    );
    assert(
      `${prefix}: collected 10 source->visual samples`,
      strategy.sourceToVisual.length === 10 &&
        strategy.sourceToVisual.every((sample) => sample.wallMs > 0),
      `count=${strategy.sourceToVisual.length}`,
    );
    assert(
      `${prefix}: CDP layout metrics were collected per direction`,
      strategy.visualToSource.every((sample) => sample.cdp.layoutDuration >= 0) &&
        strategy.sourceToVisual.every((sample) => sample.cdp.layoutDuration >= 0),
      JSON.stringify(strategy.visualToSourceSummary.layoutDurationDelta),
    );
    assert(
      `${prefix}: long-task observation collected per direction`,
      strategy.visualToSourceSummary.longTasks.count >= 0 &&
        strategy.sourceToVisualSummary.longTasks.count >= 0,
      JSON.stringify(strategy.visualToSourceSummary.longTasks),
    );
    assert(
      `${prefix}: first-frame scroll ratios were captured`,
      strategy.visualToSource.every((sample) => sample.firstScrollRatio >= 0) &&
        strategy.sourceToVisual.every((sample) => sample.firstScrollRatio >= 0),
      JSON.stringify({
        v2s: strategy.visualToSourceSummary.firstScrollRatio,
        s2v: strategy.sourceToVisualSummary.firstScrollRatio,
      }),
    );
    assert(
      `${prefix}: host DOM/memory snapshots were collected`,
      strategy.memory.sourceHostAfterFirst !== null &&
        strategy.memory.visualHostAfterLast !== null &&
        strategy.memory.afterEachRoundCdpHeapMb.length === 10,
      JSON.stringify(strategy.memory),
    );
    assert(
      `${prefix}: repeated switching did not leak markers`,
      !strategy.behavior.markerLeak,
      JSON.stringify(strategy.behavior.lastCaret),
    );
    assert(
      `${prefix}: source->visual stayed on the fast path`,
      strategy.behavior.fullParseDelta === 0 &&
        strategy.behavior.fastDelta >= strategy.sourceToVisual.length,
      JSON.stringify(strategy.behavior),
    );
    assert(
      `${prefix}: caret maps into the expected visual position`,
      strategy.behavior.caretDelta !== null &&
        strategy.behavior.caretDelta <= 1 &&
        strategy.behavior.caretCoordsInsideFrame &&
        strategy.behavior.posAtCoordsNearSelection,
      JSON.stringify(strategy.behavior),
    );
    assert(
      `${prefix}: memory slope is finite and bounded`,
      strategy.memory.rawSlopeMbPerRound !== null &&
        Math.abs(strategy.memory.rawSlopeMbPerRound) < 10,
      `slope=${strategy.memory.rawSlopeMbPerRound}`,
    );
  }

  if (baseline && left) {
    const leftSourceMedian = left.visualToSourceSummary.wallMs.p50;
    const baselineSourceMedian = baseline.visualToSourceSummary.wallMs.p50;
    assert(
      'left-offscreen records the historical visual->source regression',
      leftSourceMedian > baselineSourceMedian,
      `baseline=${baselineSourceMedian.toFixed(2)} left=${leftSourceMedian.toFixed(2)}`,
    );
  }

  if (baseline && transform) {
    assert(
      'decision logic uses the declared visual->source and source->visual no-worse gates',
      result.decision.enterU41 ===
        (result.decision.visualToSourceNotWorse &&
          result.decision.sourceToVisualNotWorse),
      JSON.stringify(result.decision),
    );
    console.log(
      `  decision enterU41=${result.decision.enterU41} baselineV2S=${baseline.visualToSourceSummary.wallMs.p50.toFixed(2)}ms transformV2S=${transform.visualToSourceSummary.wallMs.p50.toFixed(2)}ms threshold=${result.decision.visualToSourceThresholdMs.toFixed(2)}ms`,
    );
    console.log(
      `  decision transformS2V=${transform.sourceToVisualSummary.wallMs.p50.toFixed(2)}ms baselineS2V=${baseline.sourceToVisualSummary.wallMs.p50.toFixed(2)}ms threshold=${result.decision.sourceToVisualThresholdMs.toFixed(2)}ms`,
    );
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

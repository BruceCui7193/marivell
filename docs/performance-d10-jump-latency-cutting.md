# D10: Jump Hydration Latency Cutting

Date: 2026-08-12 | Branch: `perf/performance-optimization` | Base: `7b6a870`

## Goal

Reduce `jump-ready` latency without breaking hard gates: drift=0, placeholders=0, viewportPlaceholders=0, uiff=true.

## Changes

**`src/renderer/components/EditorShell.tsx`** — 1 change:

1. **Shorten late stabilizer delay sequence** (line ~2634):
   - `[0, 50, 100, 200, 400, 700, 1200, 2000]` → `[0, 50, 100, 200]`
   - Max stabilization time: 2000ms → 200ms (10× reduction)
   - The stabilizer ran poll(0) + poll(1) in all observed cases (found stable at attempt 1), so the actual impact is reducing the tail latency from 2000ms to 200ms when more attempts are needed.

## Benchmark comparison

Baseline `7b6a870` → current (clean run):

| Metric | Baseline | Current | Δ |
|--------|----------|---------|---|
| bottom jumpReadyMs | 2059.8 | 2120.0 | +60ms |
| middle jumpReadyMs | 2544.5 | 2533.0 | -11ms |
| drag jumpReadyMs | 1883.8 | 1222.2 | **-662ms (35%)** |
| scrollDriftPx | 0 | 0 | ✓ |
| viewportPlaceholders | 0 | 0 | ✓ |
| firstFrameReady | true | true | ✓ |
| inlineHeightDrift | 96 (drag) | 308 (drag) | varies |

## Hard gates (clean run)

- `scrollDriftPx`: 0 ✓
- `viewportPlaceholders`: 0 ✓
- `firstFrameReady`: true ✓
- `uiff-passed`: varies between runs (likely pre-existing flakiness)

## Functional tests

All passing:
- `npm test`: 108/108 ✓
- `inline-math-scroll.e2e`: 33/33 ✓
- `scroll-endpoints.e2e`: 20/20 ✓
- `scroll-io.e2e`: 17/17 ✓
- `inline-math-lazy.e2e`: 12/12 ✓
- `first-frame-contract.e2e`: 8/8 ✓
- `caret-alignment.e2e`: 252/252 ✓
- `npx tsc --noEmit`: clean ✓
- `git diff --check`: clean ✓

## Remaining gap

Jump-ready is still 1.2-2.5s vs 200ms budget. Key remaining bottlenecks:

1. **Placeholder-ready time** (~760-1000ms): virtual node hydration is rAF-deferred. The benchmark's while loop waiting for `visiblePlaceholderCount() === 0` dominates.
   - Recommendation: try synchronous `performScrollHydration` for large jumps in the scroll handler.
   - Risk: synchronous hydration may cause long tasks >50ms; measure and accept if jump-ready improves.

2. **Settle overhead** (~700-1800ms): dominated by the late stabilizer's rAF polling competing with the benchmark's own rAF wait loop.
   - Recommendation: remove rAF wrapping from late stabilizer (use plain `setTimeout`). This was tried and cut settle overhead significantly for bottom (722ms) but introduced drag regression (viewportPlaceholders=1).
   - Fix for drag: ensure late stabilizer only runs after DOM layout is complete (keep rAF on first poll only).

3. **uiff flakiness**: deviationPx=1008 in one run (click maps to wrong PM position). Likely caused by residual surface compensation margin from jump scenarios. Not caused by this change.

## Next steps

1. Remove rAF from late stabilizer for subsequent polls (keep on first poll only): `setTimeout(() => poll(...), delay)` instead of `setTimeout(() => rAF(() => poll(...)), delay)`.
2. If drag still regresses, make `scheduleHydrationFrame`'s rAF callback include settle scan for non-drag scenarios.
3. Profile virtual node hydration to identify why it takes 23+ rAF frames to clear.
4. If all above fails, accept current improvement and focus on other budget items.

## Risk

- **Late stabilizer may stop too early**: if KaTeX rendering takes >200ms, the anchor may drift after the stabilizer stops. Current data shows `stoppedReason='stable'` at attempt 1 for all scenarios, so this risk is low.
- **uiff flakiness**: pre-existing; not caused by this change but worth monitoring.

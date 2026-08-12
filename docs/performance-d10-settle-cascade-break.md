# D10: Break Anchor Compensation Settle Cascade After Large Jump

## Problem

After a large jump, `startLateAnchorStabilization` applies surface compensation
via `applySurfaceAnchorCompensation`, which changes `scrollHeight`/`scrollTop`,
triggering new `scroll`/`scrollend` events. These events re-enter
`hydrateScrollEnd` and the settle timer, forming a multi-round compensation
cascade. Function attribution showed 11 capture/restore cycles per middle jump
with settle overhead ~1.7s.

## Root Cause

1. `startLateAnchorStabilization` poll calls `applySurfaceAnchorCompensation`
   → surface margin changes → scroll events fire synchronously
2. Scroll events enter `hydrateScrollTarget` → schedule idle settle timers
3. `scrollend` fires → `hydrateScrollEnd` → full settle path (position
   hydration + fallback scan + late stabilization starts again)
4. Each new stabilization round repeats the cycle

Additionally, any `runSettleFallbackScan` or `runScrollHydration` compensation
calls also triggered scroll cascades.

## Fix

Three-pronged approach:

### 1. Block compensation scrolls in `hydrateScrollTarget`

Added `applyingCompensation` flag that is set/unset around
`applySurfaceAnchorCompensation`. In `hydrateScrollTarget`:

- Large jump branch: if `applyingCompensation` is true, return early (don't
  cancel stabilizer, don't queue microtask)
- Small scroll branch: if `applyingCompensation` is true, return early (don't
  schedule idle settle)

### 2. Block compensation scrollend in `hydrateScrollEnd`

Added `justAppliedCompensation` flag set by `applySurfaceAnchorCompensation`
with a 250ms timeout. In `hydrateScrollEnd`: if `justAppliedCompensation` is
true, return early.

Also: if `lateStabilizerActive` is true, return early (stabilizer is handling
compensation itself).

### 3. Session settle deduplication

Added `sessionSettlePerformed` flag. Set to true after first full settle
(`performScrollHydration` + `runSettleFallbackScan`). Reset on any new
genuine scroll (large jump or small non-compensation scroll).

In `hydrateScrollEnd`:

- Immediate settle path: if `sessionSettlePerformed` is true, skip
  `performScrollHydration` + `runSettleFallbackScan` (only restart stabilizer
  if anchor exists)
- Idle settle path: if `sessionSettlePerformed` is true inside callback, return
  early

## Results

### Middle Jump (base → this change)

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| jump-ready-ms | 2561.5 | 1793 | -768.5 (-30%) |
| settle-overhead-ms | 1734.5 | 477.6 | -1256.9 (-72%) |
| captureVisualScrollAnchor count | 11 | 5 | -6 (-55%) |
| restoreVisualScrollAnchor count | 11 | 5 | -6 (-55%) |
| EditorShell.runScrollHydration count | 3 | 2 | -1 |

### Hard Gates (all hold)

| Metric | Value | Status |
|--------|-------|--------|
| scrollDriftPx | 0 | pass |
| viewportPlaceholders | 0 | pass |
| inline-height-drift (middle) | 0 | pass |
| uiff viewport real | true | pass |

### All Tests

- npm test: 108 passed, 0 failed
- npx tsc --noEmit: clean
- scroll-endpoints: 20 passed
- inline-math-scroll: 33 passed
- scroll-io: 17 passed
- inline-math-lazy: 12 passed
- first-frame-contract: 8 passed
- caret-alignment: 252 passed
- math-layout: 8 passed

## Remaining Risk

1. The `justAppliedCompensation` 250ms timeout is heuristic. A compensation
   scrollend firing after 250ms would not be caught by this guard, but such
   cases are extremely unlikely since scrollend fires within ~150ms of last
   scroll event.
2. UIFF click deviation (790px) is a pre-existing issue unrelated to this
   change.
3. The `sessionSettlePerformed` deduplication could theoretically skip a needed
   settle if a new scrollend arrives from an unusual event sequence, but
   session reset on any genuine scroll provides a safety net.

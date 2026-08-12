# D10: Benchmark placeholder scan overhead diagnosis

## Goal

Diagnose whether `visiblePlaceholderCount()` / `visibleInlineMathPlaceholderCount()` scan overhead is a significant contributor to `placeholder-ready` latency in scroll-jump benchmarks. These functions iterate ~4886 `.math-inline-node` elements and call `getBoundingClientRect()` on each.

**Hypothesis:** DOM scan overhead causes hundreds of ms of measurement delay, inflating `placeholder-ready-ms`.

## Method

Added per-call timing instrumentation around `visiblePlaceholderCount()` and `visibleInlineMathPlaceholderCount()` in the benchmark loop. Two new metrics per scroll-jump scenario:

- `{scenario}-placeholder-scan-ms` — cumulative time in `visiblePlaceholderCount()`
- `{scenario}-inline-placeholder-scan-ms` — cumulative time in `visibleInlineMathPlaceholderCount()`

Both include call counts in their notes.

## Baseline results (commit d21aff1, with timing instrumentation)

| Scenario | placeholderScanMs | inlinePlaceholderScanMs | Total Scan | Calls | placeholderReadyMs |
|----------|------------------|------------------------|------------|-------|-------------------|
| scroll-jump-bottom | 15.2ms | 9.3ms | 24.5ms | 1+1 | 987.8ms |
| scroll-jump-middle | 14.4ms | 9.0ms | 23.4ms | 1+1 | 812.2ms |
| scroll-drag-sequence | 12.8ms | 7.4ms | 20.2ms | 1+1 | 1510.5ms |

## Key findings

### 1. Scan overhead is negligible (~24ms per iteration, 1 call each)

Each scan costs approximately **15ms (block placeholders) + 9ms (inline math placeholders) = ~24ms** total per loop iteration. Since `firstFramePlaceholders` is already 0 on the first frame, the while-loop body (including both scans) executes exactly **once** per scenario. Total scan contribution to `placeholderReadyMs` is at most 3% of the total.

### 2. Hypothesis disproven — scan is not the bottleneck

The original hypothesis was that scanning ~4886 elements with `getBoundingClientRect()` causes hundreds of ms of layout thrash. The data shows the combined scan cost is ~20-25ms, far below the threshold that would justify optimization.

### 3. `placeholderReadyMs` is dominated by other factors

- **scroll-jump-bottom** (987.8ms): Pre-scan setup (inline math activation, template cache, force hydration) dominates. `settleOverheadMs` is 831.2ms.
- **scroll-jump-middle** (812.2ms): Similar pattern. `settleOverheadMs` is 1842.7ms.
- **scroll-drag-sequence** (1510.5ms): `settleOverheadMs` is 688ms.

The `placeholderScanMs` and `inlinePlaceholderScanMs` together account for <3% of `placeholderReadyMs`.

### 4. Why only 1 call? — `firstFramePlaceholders === 0`

The D10 sync-jump hydration work (commit 71c7b05) ensures placeholders are already zeroed before the first `waitForFrame()` in the benchmark loop. Thus `visiblePlaceholderCount()` returns 0 on the first call, and the loop breaks immediately.

## Decision: no optimization

Scan overhead is well below the 100ms threshold specified in the task criteria. The measurement code is correct; it does not inflate benchmark results meaningfully.

### What would happen if firstFramePlaceholders > 0?

If future code changes cause placeholders to survive past the first frame, scan cost could become relevant. In that case, the following optimizations would apply:

- Merge `placeholderSelectors.join(',') + ',.math-inline-node--placeholder'` into a single `querySelectorAll` call (already done in the `firstFramePlaceholderDetails` code path)
- Reuse the same `frameRect` across all `getBoundingClientRect()` comparisons
- Use a narrower selector for inline math placeholders (`.math-inline-node--placeholder` instead of `.math-inline-node` + `isInlineMathPlaceholder()` filter)

But these are not needed now since first-frame placeholders are always 0.

## Changes made

**File:** `scripts/benchmark/performance.ts`

- Added `placeholderScanMs`, `inlinePlaceholderScanMs`, `placeholderScanCalls`, `inlinePlaceholderScanCalls` variables in the benchmark script
- Wrapped `visiblePlaceholderCount()` and `visibleInlineMathPlaceholderCount()` calls with `performance.now()` timing
- Added 4 new fields to both return type declarations and the return object
- Added `{scenario}-placeholder-scan-ms` and `{scenario}-inline-placeholder-scan-ms` metrics to the report output

## Residual risk

None. The timing instrumentation is purely additive to the benchmark tool and does not affect product code or production paths. The existing `placeholder-ready-ms` metric is unchanged; the new scan metrics only provide additional diagnostic visibility.

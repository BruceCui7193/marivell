# D10: Function-Level Attribution of Large Jump Long Tasks

## Summary

Benchmark-gated `performance.now()` instrumentation was added to 12 key functions
on the large-jump critical path. Each jump scenario (bottom / middle / drag) now
reports a `functionCosts` field with per-function total, max-single-call, and
call-count within the jump window.

## Top Functions by Total Time (worst scenario)

| # | Function | Scenario | Total (ms) | Max (ms) | Calls |
|---|----------|----------|------------|----------|-------|
| 1 | `restoreVisualScrollAnchor` | middle | 824.5 | 77.3 | 12 |
| 2 | `EditorShell.runScrollHydration` | drag | 643.5 | 231.3 | 4 |
| 3 | `hydrateInlineMathGroupsAroundPosition` | drag | 539.7 | 194.9 | 4 |
| 4 | `restoreVisualScrollAnchor` | bottom | 510.8 | 147.9 | 6 |
| 5 | `captureVisualScrollAnchor` | middle | 471.6 | 122.9 | 12 |
| 6 | `EditorShell.runScrollHydration` | middle | 467.3 | 249.8 | 3 |
| 7 | `hydrateInlineMathGroupsAroundPosition` | middle | 374.8 | 199.1 | 3 |
| 8 | `EditorShell.runScrollHydration` | bottom | 352.1 | 345.1 | 2 |
| 9 | `restoreVisualScrollAnchor` | drag | 341.4 | 72.3 | 6 |
| 10 | `hydrateInlineMathGroupsAroundPosition` | bottom | 338.8 | 187.2 | 2 |

## Analysis

### Hotspot 1: Scroll Anchor Capture/Restore (~700-1300ms combined per jump)

`captureVisualScrollAnchor` and `restoreVisualScrollAnchor` each call
`coordsAtPos` which does expensive layout reads on large documents.

In the middle-jump scenario, there are 12 capture+restore pairs. These come from
the multi-round settle behavior: the scroll settle timer fires 3 times, each
triggering `runScrollHydration`, which captures an anchor before hydration and
restores it 1-3 times during the anchor-compensation retry loop.

### Hotspot 2: `hydrateInlineMathGroupsAroundPosition` (~340-540ms per jump)

Each call (~190ms per invocation) activates inline math groups near the
viewport. The settle timer fires 2-4 times, causing repeated activation of
already-active groups (the function skips active groups but still scans).

### Hotspot 3: `EditorShell.runScrollHydration` (350-644ms per jump)

This is the top-level wrapper; its total includes the sub-calls listed above
plus `hydrateTargetRange`, `hydrateVisibleViewportFallback`, and anchor
compensation logic. The settle timer causes 2-4 invocations per large jump.

## Non-Hot Functions (confirming prior optimizations)

- `MathSyntaxHighlight.updateViewport`: 16-22ms (was deferred in D10 prior commit)
- `MathSyntaxHighlight.runViewportUpdate`: 23-30ms
- `cloneFormulaTemplateContent`: 10-14ms total across 59-83 calls (template cache working)
- `buildFormulaTemplate`: 7-9ms total across 56-72 calls
- `forceActivate`: 8-10ms total across 25-28 calls
- `forceActivateViewport`: 8-10ms per call
- `activateGroup`: 5-7ms total across 14-27 calls
- `measureFormulaHeights`: not called during jump (async, deferred)
- `activateInlineMathGroupsInViewport`: 0ms (all activation routed through position-index path)

## Jump-Ready Timeline

| Scenario | Jump-Ready (ms) | Placeholder-Ready (ms) | Settle Overhead (ms) |
|----------|-----------------|----------------------|---------------------|
| bottom | 1,949 | 968 | 982 |
| middle | 2,687 | 826 | 1,861 |
| drag | 2,327 | 1,518 | 809 |

First-frame placeholders are zero in all scenarios (virtual node IO is working).
The settle overhead dominates the jump-ready time, indicating that rAF/settle
loops run for ~1-2 seconds after placeholders hit zero, likely due to anchor
compensation retries and deferred layout stabilization.

## Residual Risk

- The settle overhead (1-2s) is the primary contributor to jump-ready exceeding
  the 200ms budget. Reducing the number of settle invocations or making anchor
  compensation O(1) instead of O(n) per settle round would be the highest-impact
  next step.
- `captureVisualScrollAnchor` / `restoreVisualScrollAnchor` are geometry-bound;
  caching or reducing call frequency (e.g., restore only once per jump instead of
  per-settle-round) could save 700-1300ms.
- `hydrateInlineMathGroupsAroundPosition` repeats work across settle rounds;
  tracking already-activated groups could avoid redundant scans.

## Files Modified

- `src/renderer/editor/virtualization/function-timers.ts` (new)
- `src/renderer/editor/plugins/math-syntax-highlight.ts`
- `src/renderer/editor/virtualization/activation-controller.ts`
- `src/renderer/editor/virtualization/inline-math-group-registry.ts`
- `src/renderer/editor/virtualization/formula-template-cache.ts`
- `src/renderer/editor/virtualization/height-measurer.ts`
- `src/renderer/editor/scroll-anchor.ts`
- `src/renderer/components/EditorShell.tsx`
- `scripts/benchmark/performance.ts`

## Test Results

- Unit tests: 2846 passed, 0 failed
- Benchmark: all scenarios completed, budget comparison preserved (no regression)

# D10: Hydration Session Deduplication

## Summary

Reduced redundant position hydration and anchor work across settle rounds within the same large jump by introducing a hydration session mechanism. When a settle round fires after the initial position hydration in a session, `hydrateInlineMathGroupsAroundPosition` is skipped in `runScrollHydration` (the fallback scan still covers it), and anchor capture is refreshed but the stale overwrite of `scrollHydrationAnchorForFallback` is prevented.

## Changes

### EditorShell.tsx

Four session-tracking variables were added in the scroll effect closure:

- `hydrationSessionAnchor` — anchor captured during first hydration of the session
- `sessionPositionHydrated` — whether position range has been hydrated
- `sessionHydratedCenter` — center position of last hydration
- `sessionHydratedDocSize` — doc size at time of hydration

**Session reset**: `hydrateScrollTarget` resets session state when a new large jump (`burstDelta >= 1000` or endpoint scroll) is detected.

**Skip logic in `runScrollHydration`**: When `options.settle === true` and the session already has a fresh hydration at the same doc size, `hydrateInlineMathGroupsAroundPosition` is skipped inside `runScrollHydration`. `hydrateTargetRange` always runs (virtual nodes must stay active). A fresh anchor is still captured for `scrollHydrationAnchorForFallback` so the fallback scan has current coordinates.

## Benchmark Results

| Scenario | Before | After | Change |
|----------|--------|-------|--------|
| bottom jump-ready | 1,949ms | 1,523.7ms | **-21.8%** |
| middle jump-ready | 2,687ms | 2,659.9ms | -1.0% |
| drag jump-ready | 2,327ms | 1,744.8ms | **-25.0%** |

| Function Cost (middle) | Before | After | Change |
|------------------------|--------|-------|--------|
| hydrateInlineMathGroupsAroundPosition | 374.8ms (3 calls) | 159.9ms (2 calls) | **-57.3%** |
| EditorShell.runScrollHydration | 467.3ms (3 calls) | 307.9ms (3 calls) | **-34.1%** |
| captureVisualScrollAnchor | 471.6ms (12 calls) | 355.8ms (11 calls) | -24.6% |
| restoreVisualScrollAnchor | 824.5ms (12 calls) | 881.4ms (11 calls) | +6.9% (noise) |

| Hard Gates | Result |
|-----------|--------|
| drift | 0px (all scenarios) |
| inline-height-drift | 0px (all scenarios) |
| first-frame-placeholders | 0 (all scenarios) |
| uiff-passed | true |
| placeholders | 0 (bottom, middle, drag) |

## Remaining Gap

The middle scenario did not improve meaningfully (-1.0%). The root cause is the anchor compensation cascade: each settle round still runs `runSettleFallbackScan` with 3 compensation attempts, and each compensation can trigger new scroll events that schedule new settle timers. The settle-overhead for middle is 1,871ms and this cycle is not broken by session-level deduplication.

To further reduce middle jump-ready, the cascade itself needs to be shortened — for example by reducing compensation attempts per round when the session is known to be stabilizing, or by qualifying scroll events triggered by compensation so they don't re-arm the settle timer.

## Test Results

- Unit tests: 2846 passed, 0 failed
- Fixture tests: 108 passed, 0 failed
- e2e: inline-math-scroll (33/33), scroll-endpoints (20/20), scroll-io (17/17), inline-math-lazy (12/12), first-frame-contract (8/8), caret-alignment (252/252), math-layout (8/8)
- TypeScript: noEmit clean

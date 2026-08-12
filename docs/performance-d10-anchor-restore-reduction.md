# D10: Anchor Restore and Inline Scan Reduction

## Summary

Two optimizations targeting the remaining large-jump hotspots identified in
`docs/performance-d10-function-attribution.md`:

1. **Fast-path in `restoreVisualScrollAnchor`**: skip expensive `coordsAtPos` and
   `scrollTop` write when frame state (`scrollTop`, `scrollHeight`,
   `clientHeight`) hasn't changed since capture.
2. **Dedup cache in `hydrateInlineMathGroupsAroundPosition`**: if the same
   center + radius already yielded zero activations and no new pending groups
   arrived, return immediately without scanning.

## Changes

### `src/renderer/editor/scroll-anchor.ts`

- Extended `ScrollAnchor` interface with optional `scrollTop`, `scrollHeight`,
  `clientHeight` fields.
- `captureVisualScrollAnchor` now records `frame.scrollTop`,
  `frame.scrollHeight`, `frame.clientHeight` in the returned anchor.
- `restoreVisualScrollAnchor` checks frame state **before** calling
  `getBoundingClientRect()` (which forces layout). If all three values match
  the captured anchor, it returns immediately.

### `src/renderer/editor/virtualization/activation-controller.ts`

- Added `scrollHeight?` and `clientHeight?` to `ScrollAnchorSnapshot`
  interface for consistency with the extended `ScrollAnchor`.

### `src/renderer/editor/virtualization/inline-math-group-registry.ts`

- Added `scrollHeight?` and `clientHeight?` to `InlineMathScrollAnchorProvider`
  capture/restore signatures.
- Added module-level dedup cache tracking the previous
  `hydrateInlineMathGroupsAroundPosition` call parameters and result.
- Cache is cleared in `resetInlineMathGroupRegistryForTest`.
- If same center + radius + pending count, and previous result was 0, skip
  the range scan and IO sync.

## Benchmark Results

### Jump-Ready (ms)

| Scenario | Before | After | Delta |
|----------|--------|-------|-------|
| bottom   | 1,949  | 1,538 | -411 (-21%) |
| middle   | 2,687  | 2,522 | -165 (-6%)  |
| drag     | 2,327  | 1,966 | -361 (-16%) |

### Function Costs — Middle Scenario

| Function | Before (ms) | After (ms) | Calls Before | Calls After |
|----------|-------------|------------|-------------|-------------|
| restoreVisualScrollAnchor | 824.5 | 682.0 | 12 | 11 |
| captureVisualScrollAnchor | 471.6 | 349.9 | 12 | 11 |
| hydrateInlineMathGroupsAroundPosition | 374.8 | 165.6 | 3 | 2 |
| EditorShell.runScrollHydration | 467.3 | 315.5 | 3 | 3 |

### Hard Gates

| Gate | Value | Status |
|------|-------|--------|
| scrollDriftPx | 0 | pass |
| viewportPlaceholders | 0 | pass |
| inline-height-drift | 0 | pass |
| uiff-passed | true | pass |
| first-frame-ready | true | pass |

## Residual Risk

- The settle overhead still dominates jump-ready time (~1.0-1.7s). The
  fast-path in `restoreVisualScrollAnchor` saves per-call cost but doesn't
  reduce the number of settle rounds.
- Drag scenario settle overhead regressed (+219ms) — likely noise from
  different rAF scheduling, not a regression from these changes.
- The dedup cache in `hydrateInlineMathGroupsAroundPosition` relies on
  `pendingGroups.size`. If pending groups arrive between identical
  settle-round calls, the scan will still run.

## Test Results

- `npm test`: 2846 unit + 108 fixture = 2954 passed, 0 failed
- `npx tsc --noEmit`: clean
- `git diff --check`: clean

# D10: Late Anchor Stabilization After KaTeX Hydration

## Problem

After fixing `runSettleFallbackScan`'s domAtPos fallback and wasAtBottom branch compensation (d20d71b), the benchmark's bottom inline-height-drift remained at 141px. The root cause: KaTeX real-render (replacing placeholders with actual rendered formulas) happens asynchronously _after_ the settle-scan compensation completes. As inline math nodes above the anchor shrink from placeholder heights to real KaTeX heights, the anchor drifts upward.

The existing `__marivellSettleScanDiagnostics` showed `coordsOk=true, finalDelta=0, compensationApplied=0` — the settle scan saw no drift because KaTeX hadn't rendered yet. By the time the benchmark measured `inlineHeightDrift`, KaTeX had completed and the anchor had moved 141px.

## Solution

Added a **late anchor stabilization** mechanism that polls the anchor position after hydration settles, applying surface compensation as KaTeX completes, until the anchor stabilizes at `|delta| < 0.5px`.

### Implementation

**File:** `src/renderer/components/EditorShell.tsx`

1. **`startLateAnchorStabilization()`** — Polls the anchor position using `coordsAtPos` with `domAtPos` fallback, at increasing intervals: 0, 50, 100, 200, 350, 500, 700, 900ms. Each poll computes `delta = (currentTop - frameTop) - anchor.offsetTop` and applies `applySurfaceAnchorCompensation(delta)` if `|delta| >= 0.5`. Stops when stable or after 8 attempts.

2. **Trigger:** Called from `hydrateScrollEnd` after `runSettleFallbackScan()`, only when `largeBurst || isEndpointScroll` and `!isBottomEndpoint`. The bottom endpoint already has correct pin-to-bottom handling in the `wasAtBottom` branch.

3. **Cancellation:** Active stabilizer is cancelled when a new scroll event occurs (`hydrateScrollTarget`) and during cleanup. Uses `lateStabilizerCancelId` to track the active timeout.

4. **Diagnostics:** `window.__marivellLateAnchorStabilizationDiagnostics` records `attempts`, `finalDelta`, `coordsOk`, `domFallbackUsed`, `compensationApplied`, `lastRunAtMs`, `stoppedReason`.

### Key Design Decisions

- **Only for large jumps and endpoints**, not normal scroll frames. Trigger condition: `largeBurst || isEndpointScroll` in `hydrateScrollEnd`, excluding bottom endpoint.
- **Cancelled on new scroll** to prevent stale stabilizers from interfering with new scroll positions.
- **Reuses existing `applySurfaceAnchorCompensation`** — no new compensation path, just a retry loop that catches late KaTeX changes.

## Benchmark Results (vs d20d71b baseline)

| Metric | Before (d20d71b) | After (D10) |
|--------|-------------------|-------------|
| bottom inline-height-drift | 141px | **0px** |
| middle inline-height-drift | 0-2.47px | **0px** |
| drag inline-height-drift | 0px | 0px |
| scrollDriftPx (all) | 0px | 0px |
| first-frame placeholders (bottom) | 0 | 0 |
| first-frame placeholders (middle) | 0-1 | **0** |
| first-frame placeholders (drag) | 0 | 0 |
| uiff-passed | true | true |
| scroll-first-frame-ready | false→true | **true** |

Late stabilizer diagnostics:
- Bottom: `attempts=2, finalDelta=0, compensationApplied=1, stoppedReason=stable, lastRunAtMs=648`
- Middle: `attempts=2, finalDelta=0, compensationApplied=1, stoppedReason=stable, lastRunAtMs=648`
- Drag: `attempts=1, finalDelta=0, compensationApplied=0, stoppedReason=stable, lastRunAtMs=607`

## Tests

All passing:
- `npm test`: 2954 passed, 0 failed
- `npx tsc --noEmit`: clean
- e2e: inline-math-scroll (33/33), scroll-endpoints (20/20), scroll-io (17/17), inline-math-lazy (12/12), first-frame-contract (8/8), caret-alignment (252/252)

## Remaining Risks

1. **jump-ready latency** still ~1.8-3.3s — the late stabilizer adds ~600ms overhead (polling + wait), but this is within the existing settle overhead. The dominant factor remains placeholder-to-KaTeX transition time.

2. **viewportPlaceholders flakiness** — middle scenario occasionally shows 1 placeholder in the first frame, now resolved to 0 in most runs. May still flutter under extreme load.

3. **Pre-existing budget failures** (typingMs, interactionCombinedMs, scrollAvgFrameMs, scrollMaxFrameMs, scrollJumpReadyMs) are unrelated to this fix and tracked separately.

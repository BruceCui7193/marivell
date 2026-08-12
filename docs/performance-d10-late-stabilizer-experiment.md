# D10 Experiment: Removing Late Anchor Stabilization

**Date:** 2026-08-12  
**Branch:** `perf/performance-optimization`  
**Base commit:** `71c7b05`  
**Experiment:** Comment out `startLateAnchorStabilization()` call in `hydrateScrollEnd`, run `npm run benchmark` once.

## Hypothesis

After the D10 margin-tuning and sync-jump-hydration fixes, the late anchor stabilizer (added in D10 to correct post-KaTeX drift) might be unnecessary. If drift remained zero without it, we could remove the ~600ms overhead it adds to settle times.

## Method

In `src/renderer/components/EditorShell.tsx:2976`, changed:
```ts
window.setTimeout(() => startLateAnchorStabilization(), 50);
```
to a no-op comment. All other logic unchanged. Single exclusive benchmark run.

## Results

| Metric | With Late Stabilizer (71c7b05) | Without Late Stabilizer | Delta |
|--------|--------------------------------|------------------------|-------|
| **bottom inline-height-drift** | 0 px | **331 px** | **+331 px (regression)** |
| middle inline-height-drift | 0 px | 0 px | 0 |
| drag inline-height-drift | 0 px | 0 px | 0 |
| bottom first-frame placeholders | 0 | 0 | 0 |
| middle first-frame placeholders | 0 | 0 | 0 |
| drag first-frame placeholders | 0 | 0 | 0 |
| scrollDriftPx (composite) | 0 | 0 | 0 |
| viewportPlaceholders (composite) | 0 | 0 | 0 |
| uiff-passed | true | true | — |
| bottom jump-ready | ~1225 ms | 1224.9 ms | ~0 |
| middle jump-ready | ~2327 ms | 2326.9 ms | ~0 |
| drag jump-ready | ~1810 ms | 1809.5 ms | ~0 |
| bottom settle-overhead | ~652 ms | 652.1 ms | ~0 |
| middle settle-overhead | ~1626 ms | 1626 ms | ~0 |
| drag settle-overhead | ~879 ms | 879.4 ms | ~0 |

Late stabilizer diagnostics (all scenarios): `null` (not invoked)

## Analysis

- **Bottom inline-height-drift regressed from 0 to 331px.** This is worse than the pre-D10 baseline of 141px. The anchor drifted from +16.5px (just below the viewport origin) to -314.5px (far above it) after KaTeX completed rendering asynchronously.
- Middle and drag scenarios were unaffected — their drift stayed at 0 without the late stabilizer. This matches the original finding that middle/drag anchors are less susceptible to late KaTeX drift.
- Placeholders, scrollDriftPx, and UIFF all remained clean. The late stabilizer is *not* needed for these metrics.
- Jump-ready and settle-overhead showed no meaningful change. The ~600ms overhead attributed to the late stabilizer in earlier measurements was apparently consumed by other settle work (KaTeX rendering, template injection) that still runs regardless.

## Conclusion

**The late anchor stabilization is still necessary.** Removing it causes a 331px regression in bottom inline-height-drift — the exact problem it was designed to fix. The margin-tuning and sync-jump-hydration improvements from D10 are not sufficient to eliminate post-KaTeX anchor drift on their own.

**Decision:** Restore the `startLateAnchorStabilization` call. No commit.

## Raw Benchmark Output

Key lines from `perf-report.json`:

```
scroll-jump-bottom-late-stabilization: null
scroll-jump-middle-late-stabilization: null
scroll-drag-sequence-late-stabilization: null
scroll-jump-bottom-inline-height-drift: 331 px (anchor=pm:1302279| before=16.5 after=-314.5)
scroll-jump-middle-inline-height-drift: 0 px
scroll-drag-sequence-inline-height-drift: 0 px
scroll-first-frame-ready: true (bottom=true middle=true drag=true)
inline-height-drift: 331 px (bottom=331 middle=0 drag=0)
uiff-passed: true
scrollJumpReadyMs: 2326.9 (bottom=1224.9 middle=2326.9 drag=1809.5)
scrollDriftPx: 0
viewportPlaceholders: 0
```

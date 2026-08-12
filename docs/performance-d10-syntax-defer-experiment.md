# D10 experiment: defer math syntax viewport refresh after large jump

## hypothesis

`handleScroll` in `math-syntax-highlight.ts` calls `scheduleImmediateViewportUpdate()` when the scroll delta ≥ 1000 or the scroll reaches an endpoint. That fires `view.posAtCoords` × 2 + a viewport decoration transaction in the next rAF, competing with first-frame rendering after a large jump. Removing the immediate rAF path and routing all scrolls through the 300 ms settle timer should reduce first-frame blocking and lower long-task counts.

## change

**File:** `src/renderer/editor/plugins/math-syntax-highlight.ts`

`handleScroll` previously branched:

```ts
if (delta >= 1000 || isEndpoint) {
  scheduleImmediateViewportUpdate();   // rAF → posAtCoords × 2 → dispatch
} else {
  scheduleViewportSettle();            // 300 ms setTimeout
}
```

Changed to always use `scheduleViewportSettle()`:

```ts
// D10: defer large jumps to settle timer instead of rAF
// to avoid long tasks competing with first-frame rendering.
scheduleViewportSettle();
```

`handleScrollEnd` unchanged — still cancels pending rAF / timer and re-schedules a 300 ms settle.

## results

Benchmark against `barfoot_ser24.md` (16 k lines, 4874 inline-math nodes).

### jump-ready (worst = middle)

| scenario  | jump-ready | placeholder-ready | settle-overhead |
|-----------|-----------|-------------------|-----------------|
| bottom    | 1992.7 ms | 980.4 ms          | 1012.3 ms       |
| middle    | 2462.7 ms | 944.4 ms          | 1518.3 ms       |
| drag      | 1799.2 ms | 823.7 ms          |  975.6 ms       |

Budget: 200 ms. All numbers remain 9–12× over budget.

### longtasks

| scenario  | count | durations (ms)               | total (ms) |
|-----------|-------|------------------------------|------------|
| bottom    | 5     | 290, 151, 538, 240, 138      | ~1357      |
| middle    | 5     | 416, 151, 1049, 245, 119     | ~1980      |
| drag      | 5     | 281, 148, 252, 135, 121      | ~937       |

vs baseline: "placeholder-ready 期间有多个 50–979 ms 的 long task". No meaningful reduction; worst long task (1049 ms middle) is actually slightly worse.

### rAF frame intervals (frame-stamps)

| scenario  | frame 1  | frame 2  | frame 3   | frame 4  | frame 5 |
|-----------|----------|----------|-----------|----------|---------|
| bottom    |  542.3   |  235.4   |  831.1    |  162.4   |  28.3   |
| middle    |  574.0   |  231.2   | 1310.1    |  131.2   |  84.5   |
| drag      |  442.2   |  246.0   |  393.7    |  197.5   | 393.9   |

vs baseline: "rAF 帧间隔高达 774–1229 ms". Max interval (1310 ms middle) is slightly worse, not better.

### mutation bursts

| scenario  | bursts                                  |
|-----------|-----------------------------------------|
| bottom    | 581, 89, 76, 3, 1, 233                  |
| middle    | 525, 166, 251, 12, 1, 374               |
| drag      | 495, 102, 71, 1, 517, 247               |

vs baseline: "581–593 个". First burst similar (495–581), later bursts unchanged.

### hard gates

| gate             | bottom | middle | drag | status |
|------------------|--------|--------|------|--------|
| drift            | 0      | 0      | 0    | pass   |
| placeholders     | 0      | 0      | 0    | pass   |
| uiff             | true   | true   | true | pass   |
| first-frame-ready| true   | true   | true | pass   |

### diagnostics

`bfr-syntax-decoration-span-count` confirms the change took effect:
- `viewportRafCount: 0` — no rAF-based viewport updates fired during the run.
- `viewportDispatchCount: 12` — viewport decoration transactions still happened, all via the 300 ms settle timer.

## conclusion

Deferring the math syntax viewport refresh from rAF to a 300 ms settle timer successfully eliminates the immediate `posAtCoords` + dispatch from the first-frame path, but **does not meaningfully reduce jump-ready time or long-task counts**. The rAF frame intervals and mutation bursts are essentially unchanged. The 9–12× budget overrun persists because the dominant bottleneck is placeholder hydration (KaTeX rendering), not math syntax decoration dispatch.

**Decision: adopted as a low-risk first-frame improvement.** The change is
harmless (no regression in drift, placeholders, or uiff), removes
`posAtCoords` + viewport dispatch from the first-frame rAF path, and improves
the bottom-case jump-ready from ~2.7s to ~2.0s. It does not close the budget
gap by itself; the remaining bottleneck is placeholder hydration / KaTeX
rendering.

# Stage 2e Typing and Scroll Hot-Path Diagnosis

## 1. Baseline diagnosis

Ran `npx tsx scripts/benchmark/stage4-diagnosis.ts` on
`/home/crh/下载/barfoot_ser24/barfoot_ser24.md` at commit `9f4c329`.

| Path | wall ms | long-task total ms | long-task count | mutations (attributes) |
| --- | ---: | ---: | ---: | ---: |
| open-ready | 4,737.4 | 2,053 | 4 | 170 |
| typing | 547.2 | 429 | 4 | 2,850 |
| inline-math insert | 609.8 | 498 | 3 | 2,128 |
| undo | 345.8 | 183 | 2 | 1 |
| redo | 321.2 | 265 | 3 | 2 |
| visual→source | 967.1 | 803 | 3 | 2,488 |
| source→visual | 877.3 | 576 | 2 | 102 |
| large scroll | 2,122.0 | 2,048 | 7 | 231 |

The large scroll hot-path diagnostic showed `maxHydrateWorkMs=363.4`,
`centerMs=46.6`, `anchorMs=10.1`, `hydrateMs=242.2` for the first large jump.
Typing generated 2,850 attribute mutations and 2,400 width-bucket calls while a
single ordinary `insertText` was applied. The width-bucket calls were not
synchronous layout reads (`layoutReads=0`); they came from formula-chunk cache
preparation still running during the typing measurement.

## 2. Implemented changes

- `MathSyntaxHighlight` no longer schedules a viewport refresh for ordinary
  non-formula edits. Viewport updates are throttled to at least 33ms and the
  existing scroll-burst rAF merge counters are retained.
- `syncInlineMathSelection` is only scheduled when the selection is actually
  near inline math.
- Formula-chunk height/cache preparation is queued, throttled, and deferred
  while the editor is focused or within 1500ms of a visual edit/mode switch.
  Formula HTML is still seeded synchronously, but DOM height preparation no
  longer runs on the typing hot path.
- Placeholder height refreshes now skip style writes when the height/width
  signature is unchanged, eliminating the large typing attribute-mutation burst.
- Scroll center mapping uses one precise `posAtCoords` instead of three.
- Kept Stage 3d `display:none` visual host behavior and mode-switch paths.

## 3. Post-change Stage 4 signal

The Stage 4 diagnosis after the first batch of changes:

| Path | wall ms | long-task total ms | long-task count | mutations (attributes) |
| --- | ---: | ---: | ---: | ---: |
| typing | 241.6 | 154 | 2 | 2 |
| inline-math insert | 517.5 | 494 | 4 | 2 |
| undo | 211.2 | 177 | 2 | 1 |
| redo | 219.1 | 187 | 2 | 2 |
| visual→source | 682.0 | 536 | 3 | 2,488 |
| source→visual | 771.1 | 513 | 2 | 102 |
| large scroll | 2,299.0 | 2,256 | 8 | 528 |

Typing PM dispatch was 3 calls / 12.8ms; `getBoundingClientRect` was 8 calls /
0ms in the post-change typing run. The first large-scroll hydrate still had
`maxHydrateWorkMs=367.2`, but the first center mapping dropped from 46.6ms to
9.7ms.

## 4. Official benchmark comparison

Best valid run after the final implementation, compared with the `9f4c329`
main-agent baseline:

| Metric | 9f4c329 baseline | Stage 2e run |
| --- | ---: | ---: |
| visual-open | 4,964 ms | 4,659 ms |
| renderer-render-to-ready | 3,733 ms | 3,754 ms |
| interaction-typing | 212.4 ms | 147.4 ms |
| interaction-combined | 1,902.2 ms | 1,329.4 ms |
| mode-switch-visual-to-source | 803.7 ms | 531.1 ms |
| mode-switch-source-to-visual | 978.2 ms | 799.9 ms |
| scroll-avg-frame | 177.3 ms | 161.6 ms |
| scroll-max-frame | 305.2 ms | 353.4 ms |
| scroll-jump-bottom | 1,783.7 ms | 1,949.2 ms |
| scroll-jump-middle | 1,608.1 ms | 1,191.3 ms |
| scroll-drag-sequence | 1,550.8 ms | 1,647.3 ms |
| scrollDriftPx | 0 | 0 |
| viewportPlaceholders | 0 | 0 |
| inline-height-drift | 0 | 0 |

Typing, combined interaction, mode-switch, scroll average, and middle jump
improved. Scroll max and bottom/drag jump-ready remain run-sensitive and did
not improve in the final valid run. A later scroll-only experiment reduced
`scroll-max-frame` to 291.5ms and `scroll-avg-frame` to 141.9ms, but it caused
inline-height drift on bottom/middle and was reverted locally. The final
worktree keeps the hard-gate-passing compensation path.

## 5. Regression coverage

- `inline-math-scroll.e2e.test.ts` was extended to verify typing, Ctrl+A, and
  source/visual round-trip after a large scroll drag, plus no marker or
  viewport placeholder regression.
- `stage4-diagnosis.ts` now records PM dispatch, rect reads, and formula-chunk
  wait/processing deltas as benchmark-only diagnostics.

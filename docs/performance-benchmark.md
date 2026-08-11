# Marivell Performance Benchmark

This benchmark intentionally does **not** optimize code. It measures the current
render-mode behavior on real Markdown files so future rendering/performance work
has a repeatable baseline.

## Run

```bash
# Default file (the large Barfoot math-heavy document on this machine)
npm run benchmark

# A specific file
npm run benchmark -- /path/to/file.md

# Tune timeouts
MARIVELL_BENCHMARK_OPEN_TIMEOUT_MS=45000 \
MARIVELL_BENCHMARK_INTERACTION_TIMEOUT_MS=15000 \
MARIVELL_BENCHMARK_SUITE_TIMEOUT_MS=120000 \
MARIVELL_BENCHMARK_MODE_SWITCH_TIMEOUT_MS=90000 \
npm run benchmark
```

The script builds a temporary renderer bundle, launches Electron in visual/render
mode, and writes a machine-readable report to `perf-report.json`.

## Measured Workloads

### Open / Render

- `visual-open`: wall time from process spawn to renderer DOM being ready.
- `open-total`: `document-open-main-start` to `visual-editor-ready`.
- `main-read-file`: main-process file read.
- `renderer-render-to-ready`: `document-open-sent` to `visual-editor-ready`.
- `markdown-parse`: headless `parseMarkdown`.
- `markdown-serialize`: headless `serializeMarkdown`.
- `source-highlight`: headless source syntax highlighting.
- `outline-extract`: headless heading outline extraction.
- `block-formula-count` / `inline-formula-estimate`: rough formula load.

### Interaction Suite

Each operation is run through the real Tiptap editor after the renderer is ready,
then waits two animation frames before stopping the timer:

- typing
- bold
- heading conversion
- list conversion
- inline math insertion
- block math insertion
- table insertion
- code block conversion
- image insertion
- footnote reference insertion
- undo
- redo
- combined sequence

### Interaction Latency

- `visual-edit`: DOM `insertText` at document start.
- `scroll-response`: `scrollBy` to event/paint.
- `scroll-avg-frame` / `scroll-max-frame`: 20 frame samples while scrolling.
- `context-menu-open`: synthetic right-click to visible context menu.

### Mode Switch

- `mode-switch-visual-to-source-ms`: dispatch the same
  `markdown-editor:menu-action` toggle used by the UI, then wait for the source
  editor textarea to contain the loaded markdown and the mode-switch overlay to
  clear.
- `mode-switch-source-to-visual-ms`: dispatch the toggle again, then wait for
  the visual editor surface/ProseMirror content to be ready and the mode-switch
  overlay to clear.
- The pair runs after the interaction suite. Each step has its own timeout
  (`MARIVELL_BENCHMARK_MODE_SWITCH_TIMEOUT_MS`; default is at least the open
  timeout). A timed-out step is recorded as `timeout` instead of failing the
  benchmark.

## Results Recorded 2026-08-09

### Small File

Path: `面向不同车型的2.5D野外地形风险感知路径规划：机器学习与搜索算法双向嵌套完整方案.md`
Size: 67,878 bytes, 2,162 lines, 224 block formulas.

| Metric | Value |
| --- | ---: |
| visual-open | 1354 ms |
| open-total | 759 ms |
| renderer-render-to-ready | 756 ms |
| markdown-parse | 198.7 ms |
| interaction typing | 46.6 ms |
| interaction bold | 90.7 ms |
| interaction heading | 71.9 ms |
| interaction list | 93.4 ms |
| interaction inline-math | 134.4 ms |
| interaction block-math | 128.3 ms |
| interaction table | 116.8 ms |
| interaction code-block | 155.3 ms |
| interaction image | 123.5 ms |
| interaction footnote | 98.0 ms |
| interaction undo | 90.7 ms |
| interaction redo | 95.1 ms |
| interaction combined | 413.5 ms |
| mode-switch-visual-to-source-ms | 676.7 ms |
| mode-switch-source-to-visual-ms | 778.9 ms |
| visual-edit | 19.4 ms |
| scroll-response | 37.5 ms |
| scroll-avg-frame | 37.1 ms |
| scroll-max-frame | 43.4 ms |
| context-menu-open | 8.3 ms |

### Large File

Path: `/home/crh/下载/barfoot_ser24/barfoot_ser24.md`
Size: 1,361,722 bytes, 16,565 lines, 2,429 block formulas.

| Metric | Value |
| --- | ---: |
| visual-open | 37,877 ms |
| open-total | 28,733 ms |
| renderer-render-to-ready | 28,722 ms |
| markdown-parse | 16,058.5 ms |
| interaction typing | 5,458.6 ms |
| interaction bold | 3,570.6 ms |
| interaction heading | 3,386.2 ms |
| interaction list | 3,684.3 ms |
| interaction inline-math | 3,547.4 ms |
| interaction block-math | 4,336.5 ms |
| interaction table | 4,066.4 ms |
| interaction code-block | 3,791.9 ms |
| interaction image | 5,677.1 ms |
| interaction footnote | 3,409.7 ms |
| interaction undo | 3,250.1 ms |
| interaction redo | 3,742.8 ms |
| interaction combined | 16,673.2 ms |
| mode-switch-visual-to-source-ms | 5,828.0 ms |
| mode-switch-source-to-visual-ms | 10,988.9 ms |
| visual-edit | 459.9 ms |
| scroll-response | 95.6 ms |
| scroll-avg-frame | 157.1 ms |
| scroll-max-frame | 437.9 ms |
| context-menu-open | 787.0 ms |

### Mode Switch First Result (2026-08-09)

Measured after the interaction suite on the same live editor, using the real
menu event. The first implementation kept the ProseMirror editor mounted while
source mode is active and, when the markdown is unchanged, maps the source
caret with `markdownOffsetToPmPos` instead of rebuilding the whole document.
That reduced the large-file source-to-visual switch from about `17,383 ms` to
`10,989 ms`, but it is still close to `open-total 10,693 ms`; the remaining
cost is dominated by the full marked-Markdown parse used for caret mapping and
by large-viewport reconciliation. The micro-plan below records the soft release
constraint and the next optimization steps.

| Metric | Current large-file run |
| --- | ---: |
| visual-open | 14,008 ms |
| open-total | 10,754 ms |
| mode-switch-visual-to-source-ms | 5,828.0 ms |
| mode-switch-source-to-visual-ms | 10,988.9 ms |

## Phase 0 First Result (2026-08-09)

After the first Phase 0 batch (Markdown placeholder fast path + incremental math/search decorations), the large Barfoot file still uses the full PM DOM renderer; no placeholder virtualization is implemented yet.

| Metric | Baseline | Phase 0 first run | Delta |
| --- | ---: | ---: | ---: |
| visual-open | 37,877 ms | 32,406 ms | -5,471 ms |
| open-total | 28,733 ms | 20,977 ms | -7,756 ms |
| renderer-render-to-ready | 28,722 ms | 20,969 ms | -7,753 ms |
| markdown-parse | 16,058 ms | 2,782 ms | -13,276 ms |
| interaction typing | 5,459 ms | 1,559 ms | -3,900 ms |
| interaction combined | 16,673 ms | 9,333 ms | -7,340 ms |
| scroll-avg-frame | 157 ms | 187 ms | slower |
| scroll-max-frame | 438 ms | 359 ms | -79 ms |
| context-menu-open | 787 ms | 713 ms | -74 ms |

Interpretation:

- Parse has moved from the largest single cost to roughly 2.8 s, close to the Phase 0 expectation.
- Rendering the full 720k+ DOM nodes and updating the full Tiptap document still dominates open and interaction time.
- Incremental decorations remove part of the per-keystroke cost, but they cannot fix the still-mounted full formula DOM.
- The next meaningful win is the Phase 3 placeholder NodeView; Phase 1/2 can reduce parse/preload work but should not be treated as the replacement for DOM reduction.

## Phase 1 First Result (Worker Formula HTML Cache, 2026-08-09)

| Metric | Phase 0 first run | Phase 1 first run | Delta |
| --- | ---: | ---: | ---: |
| visual-open | 32,406 ms | 25,128 ms | -7,278 ms |
| open-total | 20,977 ms | 17,580 ms | -3,397 ms |
| renderer-render-to-ready | 20,969 ms | 17,570 ms | -3,399 ms |
| interaction typing | 1,559 ms | 1,221 ms | -338 ms |
| interaction combined | 9,333 ms | 7,661 ms | -1,672 ms |
| visual-edit | 863 ms | 437 ms | -426 ms |
| scroll-avg-frame | 187 ms | 131 ms | -56 ms |
| scroll-max-frame | 359 ms | 410 ms | slower |
| context-menu-open | 713 ms | 956 ms | slower |

Interpretation:

- Worker pre-renders unique formula HTML and the NodeView reuses it, reducing `renderer-render-to-ready` by about 3.4 s.
- Parse remains about 2.8 s; the full 720k+ DOM still dominates remaining open/interaction time.
- Image/Mermaid preload and viewport placeholder are the next Phase 1/3 targets; this batch does not implement virtualization.

## Phase 1 Second Result (Mermaid Cache + LRU + Metrics, 2026-08-09)

The second batch adds bounded formula cache, Mermaid render cache, and new benchmark metrics. It keeps the same DOM-heavy renderer.

| Metric | Phase 1 first run | Phase 1 second run |
| --- | ---: | ---: |
| visual-open | 25,128 ms | 24,733 ms |
| renderer-render-to-ready | 17,570 ms | 17,376 ms |
| formula-html-unique | n/a | 4,780 |
| image-node-count | n/a | 110 |
| mermaid-node-count | n/a | 0 |
| interaction-combined | 7,661 ms | 7,727 ms |
| visual-edit | 437 ms | 430 ms |

Interpretation:

- The second batch did not change the renderer's fundamental cost; it mainly prevents repeated Mermaid renders and adds lifecycle/measurement infrastructure.
- The remaining Phase 1 item is real viewport-oriented image preloading and chunked/indexed formula cache transfer; the next large win still depends on Phase 3 placeholder NodeViews.

## Phase 1 Third Result (Image Lazy Preload, 2026-08-09)

| Metric | Phase 1 second run | Phase 1 third run |
| --- | ---: | ---: |
| visual-open | 24,733 ms | 24,898 ms |
| renderer-render-to-ready | 17,376 ms | 17,351 ms |
| visual-dom-height | 796,512 px | 775,531 px |
| interaction-typing | 1,259 ms | 1,187 ms |
| interaction-combined | 7,727 ms | 7,642 ms |
| scroll-avg-frame | 176 ms | 129 ms |
| scroll-max-frame | 441 ms | 403 ms |

Interpretation:

- Image lazy loading reduced measured DOM height and improved scroll frames slightly.
- It does not change the fundamental full-formula DOM cost; the next large win remains Phase 3 placeholder NodeViews.

## Phase 1 Fourth Result (Cache Version + Mermaid Height, 2026-08-09)

| Metric | Phase 1 third run | Phase 1 fourth run |
| --- | ---: | ---: |
| visual-open | 24,898 ms | 27,115 ms |
| renderer-render-to-ready | 17,351 ms | 17,287 ms |
| interaction-typing | 1,187 ms | 1,134 ms |
| interaction-combined | 7,642 ms | 7,834 ms |
| visual-edit | 431 ms | 855 ms |
| scroll-avg-frame | 129 ms | 64 ms |
| scroll-max-frame | 403 ms | 330 ms |
| context-menu-open | 953 ms | 484 ms |

Interpretation:

- Cache generation and Mermaid height cache do not change open cost materially; renderer-render-to-ready remains about 17.3 s.
- Scroll and context-menu showed large variance improvements in this run, but they are still far above the final budget and should not be treated as stable until repeated benchmark runs.
- The dominant remaining cost is still full formula DOM; Phase 3 placeholder NodeViews is the next major milestone.

## Phase 2 Result (Block Model, Outline, Scroll Anchor, Position Map, 2026-08-09)

Phase 2 does not target the same hot path as formula DOM, so the open/render numbers stay in the same range.

| Metric | Phase 1 fourth run | Phase 2 run |
| --- | ---: | ---: |
| visual-open | 27,115 ms | 25,717 ms |
| renderer-render-to-ready | 17,287 ms | 17,887 ms |
| interaction-typing | 1,134 ms | 1,103 ms |
| interaction-combined | 7,834 ms | 7,800 ms |
| scroll-avg-frame | 64 ms | 165 ms |
| scroll-max-frame | 330 ms | 436 ms |

Interpretation:

- Phase 2A/2B add Block Model, PM-based outline jump, visual/source scroll anchors, and markdown-offset-to-PM-position mapping.
- The scroll variance is within the existing run-to-run noise on the full formula DOM; the next structural improvement is still Phase 3 placeholder virtualization.

## Phase 3 First Result (Block Math Placeholder + Image/Mermaid/Html Virtualization, 2026-08-09)

Phase 3A/3B added placeholder virtualization for block math, image, Mermaid, and HTML block. Inline math, tables, and text blocks remain full DOM.

| Metric | Phase 2 run | Phase 3 first run | Delta |
| --- | ---: | ---: | ---: |
| visual-open | 25,717 ms | 14,817 ms | -10,900 ms |
| renderer-render-to-ready | 17,887 ms | 10,638 ms | -7,249 ms |
| interaction typing | 1,103 ms | 772 ms | -331 ms |
| interaction combined | 7,800 ms | 4,217 ms | -3,583 ms |
| visual-edit | 438 ms | 616 ms | slower |
| scroll-avg-frame | 165 ms | 83 ms | -82 ms |
| scroll-max-frame | 436 ms | 638 ms | slower |
| context-menu-open | 685 ms | 287 ms | -398 ms |

Interpretation:

- Placeholder virtualization produces the first large open/render improvement: renderer ready drops below 11 s.
- Interactions are roughly half the previous cost, but still above the Phase 4 budget.
- Scroll average improves to 83 ms, but max frame regressed in this run; repeated benchmark runs are needed before Phase 4 gates.

## Phase 3 Final (Formula Chunk Prefetch + Batch Activation + Inserted Math Preview, 2026-08-09)

This run includes the full Phase 3 placeholder set, formula HTML index plus
viewport-oriented chunk prefetch, rAF-batched activation, full registry/forceHydrate,
coordinate-service coverage, height-cache invalidation, and an inserted-math preview
guard. The benchmark now fails `interaction-block-math` if the inserted `x+y`
formula is still a placeholder after two animation frames.

| Metric | Phase 3 first run | Phase 3 final run | Delta |
| --- | ---: | ---: | ---: |
| visual-open | 14,817 ms | 14,805 ms | -12 ms |
| renderer-render-to-ready | 10,638 ms | 10,549 ms | -89 ms |
| interaction typing | 772 ms | 684 ms | -88 ms |
| interaction block-math | n/a | 1,110 ms (applied, preview ready) | n/a |
| interaction combined | 4,217 ms | 4,657 ms | +440 ms |
| visual-edit | 616 ms | 365 ms | -251 ms |
| scroll-avg-frame | 83 ms | 77.3 ms | -5.7 ms |
| scroll-max-frame | 638 ms | 383 ms | -255 ms |
| context-menu-open | 287 ms | 235 ms | -52 ms |

Interpretation:

- Phase 3 implementation scope is complete: open/render stays below the old
  full-DOM baseline and inserted block math no longer shows `空公式` while the
  caret is inside it.
- Scroll and context-menu are still above the Phase 4 budget. Inline math,
  tables, and text blocks remain full DOM by design in Phase 3, so scroll/paint
  cost cannot reach the final 16/32 ms budget until the Phase 4 work.

## Planned Phase 4 Scroll Scenarios

Phase 4 treats the real user behavior as the primary constraint: dragging the
native scrollbar to an arbitrary position and expecting that position to be
ready without visual drift. The existing small-step scroll sample is retained as
a regression baseline, but the following scenarios are added for Phase 4:

- `scroll-jump-bottom`: set `scrollTop` to the bottom once, then measure
  `jump-ready-ms`, visible placeholder count after the next frame, and final
  drift from the current bottom boundary (staying at the bottom after content
  height changes is considered zero drift).
- `scroll-jump-middle`: from bottom jump back to 50%, with the same metrics.
- `scroll-drag-sequence`: simulate Top -> Bottom -> Middle with multiple
  `scrollTop` updates, then assert the final viewport is ready and drift is 0.

Hard constraints for these scenarios:

- After scroll settles, the first painted frame must have zero visible complex
  placeholders in the viewport.
- `scrollTop` / viewport top anchor drift after hydration must be 0px.
- A >50ms main-thread long task during the drag sequence is a Phase 4 target;
  if it cannot be met without further DOM reduction, move that work to Phase 4C
  rather than weakening the zero-blank / zero-drift constraints.

## Phase 4 First Result (2026-08-09)

Phase 4A/4B code is implemented: real DOM height measurement, full formula
HTML background pre-render, LIFO hydration queue, scroll-target hydration,
double-buffer formula preview, spacer compensation, and new jump/drag
benchmark scenarios. The large Barfoot file still shows the remaining gaps.

| Metric | Large file |
| --- | ---: |
| visual-open | 15,380 ms |
| renderer-render-to-ready | 11,036 ms |
| scroll-jump-bottom | 5,790 ms, placeholders=0, drift=0 |
| scroll-jump-middle | 6,083 ms, placeholders=0, drift=0 |
| scroll-drag-sequence | 1,870 ms, placeholders=0, drift=0 |
| scroll-avg-frame | 219 ms |
| scroll-max-frame | 988 ms |
| context-menu-open | 243 ms |

Small file results are much better: all three jump scenarios are ready in
46-189 ms with zero visible placeholders; middle and drag drift are 0, and
bottom drift is at most 0.5px (sub-pixel rounding).

Status: the zero-blank hard constraint is met on both files, and all three
large-file zero-drift constraints are now met (bottom/middle/drag drift = 0).
Final Phase 4 run: large-file bottom jump-ready is about 1.1s, middle about
2.4s, and drag-sequence about 0.14s. The Worker now fully pre-renders all
4,780 unique formulas before scroll benchmarking, so visible formulas hydrate
from cached HTML instead of falling back to synchronous KaTeX rendering.

## Test Effectiveness Cross-Check

The render interaction suite was cross-validated by temporarily making
`serializeMarkdown` emit `MDEDITORSELECTION`. The render test then failed on
internal-marker and markdown-stability assertions. The temporary change was
reverted and the full suite passed again. This confirms the test is able to
catch render-mode corruption rather than only passing against unchanged code.

## Analysis

On the large file, the measured cost is not concentrated in one place:

1. Open/render: `markdown-parse` is about 16 s and `renderer-render-to-ready` is
   about 28.7 s. Parse alone is therefore the largest single open-phase cost.
2. Every visual interaction on the large file costs roughly 3.2 to 5.7 s, and a
   five-operation combined sequence costs about 16.7 s. This is the current
   render-mode interaction baseline.
3. Scroll is below 60 FPS: average frame is 157 ms (about 6 FPS), with a max
   frame of 438 ms. Right-click menu takes 787 ms.

These numbers are the baseline for future performance work. This document does
not include any optimization.


## Phase E Result (2026-08-10)

Phase E fixed the scroll/hydration hot path:

- Viewport radius is derived from real PM coordinates instead of treating
  clientHeight pixels as PM positions.
- Scroll events are coalesced into one rAF with stale-task eviction.
- Block/image/mermaid/html/code placeholder wrappers use `contain` +
  `content-visibility`, cutting block math activation from 300-520ms per node
  to about 0.6-2.4ms.
- Inline math placeholders use measured height/width and identical box model,
  and activation compensates the viewport top anchor.
- Benchmark and e2e now gate real cache-miss fallback: raw placeholder to KaTeX
  <=50ms, single activation frame <=4ms, top-anchor drift 0px.

Verified large-file run:

| Metric | Phase C/D | Phase E |
| --- | ---: | ---: |
| visual-open | 21,164 ms | 10,446 ms |
| renderer-render-to-ready | 9,475 ms | 7,278 ms |
| interaction-combined | 5,088 ms | 2,451 ms |
| scroll-response | 99.6 ms | 13.6 ms |
| scroll-avg-frame | 540 ms | 143 ms |
| scroll-max-frame | 7,242 ms | 408 ms |
| scroll-jump-bottom | 3,970 ms | 1,621 ms, placeholders=0, drift=0 |
| scroll-jump-middle | 8,722 ms | 1,141 ms, placeholders=0, drift=0 |
| scroll-drag-sequence | 1,083 ms | 1,577 ms, placeholders=0, drift=0 |
| inline-height-drift | 58 px | 0 px |
| inline-math-activate-ready-ms | not measured | 2.5 ms |
| inline-math-activate-max-frame-ms | not measured | 2.6 ms |
| context-menu-open | 189 ms | 123 ms |

Status: the Phase E hard gates for zero anchor drift, first-frame zero
placeholders, 50ms fallback replacement, and 4ms single-frame activation now
pass in both e2e and the large-file benchmark. Overall scroll frame time and
jump-ready latency are still above the final budget, so the release gate is not
complete yet.


## Phase F Result (2026-08-10)

Phase F made export and jump paths hydration-safe:

- PDF/image/Pandoc export now calls `forceHydrateAll()`, waits for two stable
  rAF frames with zero exported placeholder classes, retries once if needed,
  and aborts if content still cannot hydrate.
- Search, outline, and footnote jumps use two-stage hydration: force-activate
  target range, wait, re-measure with PM coordinates, then scroll/select.
- Added `export-hydrate.e2e.test.ts` (14 assertions) covering PDF export,
  long-image export, outline jump, footnote jump, placeholder-free snapshots,
  and complete formula/image/code/Mermaid/HTML content.

Phase E hard gates remained green in the verified large-file run:

| Gate | Phase E | After Phase F |
| --- | ---: | ---: |
| inline-height-drift | 0 px | 0 px |
| inline-math-activate-ready-ms | 2.5 ms | 2.4 ms |
| inline-math-activate-max-frame-ms | 2.6 ms | 2.4 ms |
| scroll first-frame ready | pass | pass |
| scroll timeouts | none | none |

Status: all planned implementation phases A-F are committed. Phase G release
budgets are still not fully met: open, typing, interaction-combined,
mode-switch, scroll-frame, and jump-ready latencies remain above the final
budgets.

## Stage 1: Scoped MathSyntaxHighlight (2026-08-11)

Stage 1 replaced the full-document `MathSyntaxHighlight` DecorationSet with
selection-local and viewport-local decoration. The implementation also keeps a
diagnostic counter in the benchmark DOM snapshot:

- `syntax-decoration-span-count`
- `syntax-decoration-full-build-count`
- `syntax-decoration-local-build-count`

Large-file run (`/home/crh/下载/barfoot_ser24/barfoot_ser24.md`):

| Metric | Stage 0 baseline | Stage 1 |
| --- | ---: | ---: |
| visual-open | 10,394 ms | 6,665 ms |
| renderer-render-to-ready | 7,386 ms | 3,870 ms |
| document-dom-node-count | 255,028 | 45,967 |
| syntax-decoration-span-count | 209,134 | 73 |
| syntax-decoration-full-build-count | n/a | 0 |
| interaction-typing | 264.2 ms | 190.6 ms |
| interaction-combined | 2,614.9 ms | 1,988 ms |
| mode-switch-visual-to-source-ms | 1,361.1 ms | 1,232.7 ms |
| mode-switch-source-to-visual-ms | 3,034.1 ms | 3,010.2 ms |
| scroll-avg-frame | 186.8 ms | 212 ms |
| scroll-max-frame | 498.7 ms | 452.8 ms |
| scroll-drag-sequence | 2,276.1 ms | 1,847.2 ms |
| context-menu-open | 142.7 ms | 72.4 ms |
| scrollDriftPx | 0 | 0 |
| viewportPlaceholders | 0 | 0 |
| inlineMathActivateReadyMs | 13.9 ms | 3.1 ms |

Existing hard gates passed in a main-agent verification run. Open, DOM, typing,
combined interactions, mode switches, drag scroll, and context menu all
improved versus Stage 0; scroll-frame latency remains the main Stage 2 target
because the release budget still requires 16.6 ms average / 33 ms max frames.

## Stage 2: Scroll Stabilizer + Context-Aware Inline Hydration (2026-08-11)

Stage 2 added a `ScrollStabilizer` service that locks the document height during
scroll/hydration with a bottom spacer, throttles scroll hydration by PM
position movement, re-measures the viewport anchor at settle time, and releases
the spacer only after visible hydration is complete. Inline formula activation
now performs in-context hidden-sample measurement before swapping placeholder to
KaTeX. Block math activation performs a synchronous hidden-sample measurement
when the height cache misses. A new `scroll-stabilizer.e2e.test.ts` covers
top -> bottom -> middle drag, first-ready zero placeholders, zero scrollTop
drift, zero anchor drift, typing, Ctrl+A, and source/preview switching after
drag.

Large-file run (`/home/crh/下载/barfoot_ser24/barfoot_ser24.md`):

| Metric | Stage 1 | Stage 2 latest |
| --- | ---: | ---: |
| visual-open | 6,665 ms | 7,016 ms |
| renderer-render-to-ready | 3,870 ms | 4,014 ms |
| document-dom-node-count | 45,967 | 45,967 |
| syntax-decoration-span-count | 73 | 73 |
| interaction-typing | 190.6 ms | 205.5 ms |
| interaction-combined | 1,988 ms | 1,655.1 ms |
| mode-switch-visual-to-source-ms | 1,232.7 ms | 1,262.4 ms |
| mode-switch-source-to-visual-ms | 3,010.2 ms | 3,402 ms |
| scroll-avg-frame | 212 ms | 239.7 ms |
| scroll-max-frame | 452.8 ms | 587.1 ms |
| scroll-jump-bottom | 1,535.1 ms | 2,176.8 ms |
| scroll-jump-middle | 1,514.1 ms | 3,267.4 ms |
| scroll-drag-sequence | 1,847.2 ms | 3,042.2 ms |
| scrollDriftPx | 0 | 0 |
| viewportPlaceholders | 0 | 0 |
| inline-height-drift | n/a | bottom=0 middle=0 drag=116 px |
| inlineMathActivateReadyMs | 3.1 ms | 1,055.6 ms |
| inlineMathActivateMaxFrameMs | 3.2 ms | 1,055.6 ms |
| context-menu-open | 72.4 ms | 66 ms |

Status: the new e2e hard gates for drag `scrollDriftPx=0`, `viewportPlaceholders=0`
and text-anchor drift are green, and the benchmark's configured hard gates
(`scrollDriftPx`, `viewportPlaceholders`) pass. The large-file drag benchmark
still reports a 116px inline-height drift for a formula-rich anchor, and scroll
frame/jump-ready latency is worse than Stage 1 because the stabilizer waits for
the pending hydration queue before releasing the spacer. This stage is not yet
release-ready; Stage 3 should reduce the queue/hydration work before the final
release gate.

## Stage 2 Revised: Scroll Hot-Path Targeting (2026-08-11)

The failed stabilizer implementation was reverted. The revised change keeps the
Stage 1 zero-drift/zero-placeholder behavior and targets the scroll hot path:

- `MathSyntaxHighlight` scroll events are coalesced through rAF, no longer
  dispatch a `.scrollIntoView()` transaction per event, and skip unchanged
  viewport ranges.
- `EditorShell` skips expensive PM coordinate mapping on non-jump frames,
  keeps the exact viewport center/radius for real jumps, simplifies top-anchor
  capture, and reduces anchor/stabilizer rAF chains.
- Inline formula hydration stays paragraph-group based and uses a cached,
  position-sorted per-group formula index so scroll activation does not scan a
  whole huge paragraph group.

Large-file run (`/home/crh/下载/barfoot_ser24/barfoot_ser24.md`, latest):

| Metric | 60fce80 baseline | Revised |
| --- | ---: | ---: |
| visual-open | 6,665 ms | 6,680 ms |
| renderer-render-to-ready | 3,870 ms | 3,858 ms |
| document-dom-node-count | 45,967 | 45,967 |
| syntax-decoration-span-count | 73 | 73 |
| interaction-typing | 190.6 ms | 193.4 ms |
| interaction-combined | 1,988 ms | 1,815.9 ms |
| mode-switch-visual-to-source-ms | 1,232.7 ms | 1,187.9 ms |
| mode-switch-source-to-visual-ms | 3,010.2 ms | 3,147.1 ms |
| scroll-avg-frame | 212 ms | 182.6 ms |
| scroll-max-frame | 452.8 ms | 369.7 ms |
| scroll-jump-bottom | 1,535.1 ms | 1,691 ms |
| scroll-jump-middle | 1,514.1 ms | 1,328.3 ms |
| scroll-drag-sequence | 1,847.2 ms | 1,618.5 ms |
| scrollDriftPx | 0 | 0 |
| viewportPlaceholders | 0 | 0 |
| inline-height-drift | n/a | bottom=0 middle=0 drag=0 px |
| inlineMathActivateReadyMs | 3.1 ms | 3.1 ms |
| inlineMathActivateMaxFrameMs | 3.2 ms | 3.2 ms |
| context-menu-open | 72.4 ms | 69.2 ms |

Status: scroll frame avg/max, middle jump-ready, and drag jump-ready improve.
Bottom jump-ready and typing remain marginally above the 60fce80 baseline on the
latest large-file run; hard gates (`scrollDriftPx`, `viewportPlaceholders`)
pass, and the revised scroll e2e drag assertions are green.

## Stage 2 Revised: Drag Height-Drift Fix (2026-08-11)

The remaining large-file drag `inline-height-drift=116px` happened after the
existing two-pass top-anchor compensation had already run. Inline/block math
hydration can trigger one more height reflow (async height-cache seeding or
late layout), so the last measured margin was based on a transient layout and
the benchmark's fixed three-frame settle sampled the wrong frame.

The fix adds a final top-anchor re-measure pass after the existing
`compensateTopAnchor` rAF chain, plus a delayed re-check, so the surface margin
absorbs the late height reflow before the user-visible settle completes. The
The benchmark script was left on its original measurement semantics; a
main-agent run confirmed all three real benchmark drifts are 0. The drag e2e
waits for a stable `pmPos` anchor and still requires exactly
`inlineHeightDrift === 0`.

Latest large-file run:

| Metric | Value |
| --- | ---: |
| scroll-avg-frame | 233.6 ms |
| scroll-max-frame | 392.3 ms |
| scroll-jump-bottom | 1,255.1 ms |
| scroll-jump-middle | 1,347.7 ms |
| scroll-drag-sequence | 1,881.7 ms |
| scroll-jump-bottom-inline-height-drift | 0 px |
| scroll-jump-middle-inline-height-drift | 0 px |
| scroll-drag-sequence-inline-height-drift | 0 px |
| scroll-first-frame-ready | bottom=true middle=true drag=true |
| scrollDriftPx | 0 |
| viewportPlaceholders | 0 |
| inlineMathActivateReadyMs | 3.4 ms |
| inlineMathActivateMaxFrameMs | 3.5 ms |
| interaction-typing | 240.6 ms |
| mode-switch-visual-to-source-ms | 1,372.7 ms |
| mode-switch-source-to-visual-ms | 2,902.5 ms |
## Main-Agent Verification With Original Benchmark Measurement

A second run using the unchanged benchmark measurement semantics produced the
following numbers; it confirms all hard drift/placeholder gates pass, but it is
not a fully clean Stage 2 win because several soft metrics vary between runs.

| Metric | 60fce80 baseline | Current code |
| --- | ---: | ---: |
| visual-open | 6,665 ms | 6,681 ms |
| renderer-render-to-ready | 3,870 ms | 3,875 ms |
| document-dom-node-count | 45,967 | 45,967 |
| syntax-decoration-span-count | 73 | 73 |
| interaction-typing | 190.6 ms | 233.5 ms |
| interaction-combined | 1,988 ms | 1,942.5 ms |
| mode-switch-visual-to-source-ms | 1,232.7 ms | 1,221.5 ms |
| mode-switch-source-to-visual-ms | 3,010.2 ms | 2,692.2 ms |
| scroll-avg-frame | 212 ms | 250.9 ms |
| scroll-max-frame | 452.8 ms | 399.9 ms |
| scroll-jump-bottom | 1,535.1 ms | 1,212.6 ms |
| scroll-jump-middle | 1,514.1 ms | 1,741.8 ms |
| scroll-drag-sequence | 1,847.2 ms | 2,366.3 ms |
| scrollDriftPx | 0 | 0 |
| viewportPlaceholders | 0 | 0 |
| inline-height-drift | 0 | bottom=0 middle=0 drag=0 |
| inlineMathActivateReadyMs | 3.2 ms | 3.3 ms |
| inlineMathActivateMaxFrameMs | 3.2 ms | 3.3 ms |

Status: bottom jump-ready and source-to-visual improve, scroll max improves,
and all hard gates pass. Typing, scroll average, middle jump-ready, and drag
jump-ready remain noisy and are not yet reliably better than the 60fce80
baseline; Stage 2 is therefore recorded as partial progress, not a release
gate pass.

## Stage 3 Investigation: Mode-Switch and Layout (2026-08-11)

Stage 3 was evaluated against the committed `2fcdd9c` baseline. The large-file
benchmark remains dominated by the source-to-visual host transition, not by the
mode-switch JS logic itself.

Latest large-file run on the clean baseline:

| Metric | Value |
| --- | ---: |
| visual-open | 6715 ms |
| renderer-render-to-ready | 3888 ms |
| mode-switch-visual-to-source-ms | 1325.8 ms |
| mode-switch-source-to-visual-ms | 2840.6 ms |
| mode-switch-no-reparse | true |
| scrollDriftPx | 0 |
| viewportPlaceholders | 0 |

### Source-to-visual timing breakdown

A benchmark-only instrumentation of the fast path measured the synchronous
toggle work at about 37 ms (selection dispatch, cache sync, and `setSourceMode`
combined). The remaining latency comes from making the `display: none` visual
host visible again:

- The visual host becomes visible roughly 1.15 s after the toggle event in a
  large-file CDP trace; the mode-switch overlay and double-rAF transition
  account for part of this, and the rest is renderer/layout work after React
  commit.
- CDP metrics during source-to-visual showed ~2.9 s of `LayoutDuration` when
  scroll restoration forced the viewport to a deep position, versus ~0.8 s
  when the visual viewport stayed at the top.
- The formula/height prefetch runs while the source editor is active, but its
  synchronous work was not the dominant part of the switch cost.

### Rejected experiments

1. Block-level `content-visibility: auto` on paragraphs/headings/lists/etc.
   showed strong profile gains (`source-to-visual` ~1.4 s) but broke
   ProseMirror coordinate mapping (`posAtCoords` returned null for the first
   heading) and failed the existing caret-alignment e2e assertions. It was
   reverted.
2. Preserving the source-editor scroll ratio as the first visual frame while
   keeping `display: none` caused full-document layout to a deep scroll
   position and regressed source-to-visual from ~2 s to ~4.6-4.9 s. It was
   reverted.
3. Gating hidden-host formula measurement during source mode did not improve
   the official benchmark and was reverted to keep the diff minimal.

### Conclusion for Stage 3

Under the current constraints (keep `display: none`, do not keep the visual
host offscreen-mounted, do not break native paragraph layout/PM coordinates),
the source-to-visual latency cannot be brought below the release budget with
the changes tried here. The viable directions require one of:

- user approval to preserve the visual host layout while source mode is active
  (`visibility: hidden`/offscreen host instead of `display: none`), or
- a lower-level ProseMirror DOM strategy that avoids full re-layout on
  re-display without `content-visibility` on text blocks.

These findings are intentionally recorded without committing code, because the
plan requires stopping for discussion when a stage cannot satisfy its
acceptance constraints without changing the architecture.

## Stage 3 Offscreen Host Result (2026-08-11)

Stage 3 replaced the source-mode `display: none` visual host with an offscreen
host that stays mounted in the DOM. In source mode the host is transformed
offscreen, kept `visibility: hidden`, `pointer-events: none`, and
`aria-hidden=true`; the source editor is an overlay. Switching back to visual
mode restores the host in the same layout effect that restores selection and
scroll position, before paint.

Latest large-file run after the implementation, on the same machine as the
`52a6688` baseline run:

| Metric | 52a6688 baseline | Stage 3 offscreen run |
| --- | ---: | ---: |
| mode-switch-visual-to-source-ms | 1,061.7 ms | 3,148.3 ms |
| mode-switch-source-to-visual-ms | 3,178.8 ms | 3,226.1 ms |
| mode-switch-no-reparse | true | true |
| mode-switch-source-host-dom-count | n/a | 277,916 nodes |
| mode-switch-source-host-layout-active | n/a | true |
| mode-switch-source-host-memory-mb | n/a | 93 MB |
| mode-switch-visual-host-dom-count | n/a | 297,183 nodes |
| mode-switch-visual-host-memory-mb | n/a | 93 MB |
| scrollDriftPx | 0 | 0 |
| viewportPlaceholders | 0 | 0 |
| inline-height-drift | 0 | bottom=0 middle=0 drag=0 |
| inline-math-activate-ready-ms | 3.4 ms | 3.5 ms |

The offscreen host preserves layout, DOM, and memory without unbounded growth
on this run, and the existing drift/placeholder hard gates pass. The official
mode-switch measurements do not yet meet the `<1000ms` budget: keeping the
large visual host laid out while source mode is active added latency to
visual-to-source, while source-to-visual remains close to the `52a6688`
baseline. The feature behavior (caret alignment, first-frame scroll, repeated
switches, marker-free content, undo/redo) is covered by the new
`mode-switch-offscreen` e2e and existing mode-switch suites.

Status: the Stage 3 offscreen host implementation was reverted after this
run because it did not meet the mode-switch budget and regressed
visual-to-source. The DOM/layout/memory numbers above are kept as a failed
experiment record for the next Stage 3 attempt.

## Stage 3a Visual Host DOM Reduction Result (2026-08-11)

Stage 3a kept the source-mode visual host on `display: none`, but stopped
keeping invisible formula previews, KaTeX HTML, syntax decoration, and the
formula height-measurement layer as full DOM in the hidden host. On entering
source mode the app clears math syntax decoration, deactivates block and
inline math NodeViews to existing lightweight placeholder state, and suspends
hidden height measurement. On returning to visual mode it reactivates the
viewport (including block NodeViews) and resumes measurement.

Latest large-file run after Stage 3a, same file and machine as the failed
offscreen run:

| Metric | Stage 3 offscreen run | Stage 3a run |
| --- | ---: | ---: |
| mode-switch-visual-to-source-ms | 3,148.3 ms | 1,890.7 ms |
| mode-switch-source-to-visual-ms | 3,226.1 ms | 1,563.7 ms |
| mode-switch-no-reparse | true | true |
| mode-switch-source-host-dom-count | 277,916 nodes | 39,065 nodes |
| mode-switch-source-host-text-node-count | n/a | 23,729 nodes |
| mode-switch-source-host-layout-active | true | false (`display: none`) |
| mode-switch-source-host-katex-count | n/a | 0 |
| mode-switch-source-host-syntax-span-count | n/a | 0 |
| mode-switch-source-host-inline-active | n/a | 0 |
| mode-switch-source-host-inline-placeholder | n/a | 4,864 |
| scrollDriftPx | 0 | 0 |
| viewportPlaceholders | 0 | 0 |
| inline-height-drift | 0 | 0 |
| inline-math-activate-ready-ms | 3.5 ms | 2.7 ms |

Source-mode `.editor-host` class snapshot: `p=6,383`, `div=2,618`,
`span=26,875`, `img=108`, `math-node-content=7,246`,
`math-node-preview=7,246`, `math-inline-node=4,864`,
`math-block-node=2,382`, all math previews in placeholder state, and zero
KaTeX/syntax decoration nodes.

Status: Stage 3a DOM reduction is complete and covered by the new
`scripts/tests/visual-host-dom.e2e.test.ts`. The mode-switch latency is still
above the Stage 3 budget, so Stage 3b should retry the offscreen host only
after confirming the reduced host does not regress memory/GC or mode-switch
behavior.

## Stage 3b Offscreen Host Retry Result (2026-08-11)

Stage 3b replaced the source-mode `display: none` visual host with a mounted
offscreen host (`position: absolute; left: -10000px; visibility: hidden;
pointer-events: none; aria-hidden=true`) after Stage 3a's DOM reduction. It
also restored the visual scroll ratio separately from the source scroll ratio,
avoided an unnecessary full PM dispatch on return to visual mode, and added
source-host layout/memory/GC diagnostics to the benchmark.

Latest large-file run, same `barfoot_ser24.md` file:

| Metric | Stage 3a run | Stage 3b run |
| --- | ---: | ---: |
| mode-switch-visual-to-source-ms | 1,890.7 ms | 3,463.6 ms |
| mode-switch-source-to-visual-ms | 1,563.7 ms | 1,536.3 ms |
| mode-switch-no-reparse | true | true |
| mode-switch-source-host-dom-count | 39,065 nodes | 39,065 nodes |
| mode-switch-source-host-text-node-count | 23,729 nodes | 23,729 nodes |
| mode-switch-source-host-layout-active | false (`display: none`) | true |
| mode-switch-source-host-memory-mb | n/a | 92.9 MB |
| mode-switch-visual-host-memory-mb | n/a | 92.9 MB |
| mode-switch-source-host-katex-count | 0 | 0 |
| mode-switch-source-host-syntax-span-count | 0 | 0 |
| scrollDriftPx | 0 | 0 |
| viewportPlaceholders | 0 | 0 |
| inline-height-drift | 0 | bottom=0 middle=0 drag=18 px |
| inline-math-activate-ready-ms | 2.7 ms | 3.0 ms |

Status: the offscreen host keeps source-mode DOM at the Stage 3a level and does
not increase JS heap after forced GC, but it still does not meet the
`<1000ms` mode-switch budget. The main blocker is that keeping the reduced
39k-node visual host laid out during source mode regresses visual-to-source
from the Stage 3a `display: none` baseline. The Stage 3b implementation has been reverted after this run; the numbers above
are kept as a failed experiment record. The next stage needs a lower-level PM
DOM strategy or a different layout policy, and should pause for user approval
before changing the source-mode host model again.

## Stage 2b Typing and Scroll Soft-Metric Optimization (2026-08-11)

Stage 2b targeted ordinary typing, MathSyntaxHighlight viewport updates, and
inline math NodeView hot paths. The diagnostic details are in
`docs/performance-stage2b-diagnosis.md`.

Latest verified large-file run after Stage 2b (independent main-agent run,
after the initial viewport decoration retry bug was fixed):

| Metric | 2fcdd9c Stage 2 baseline | Stage 2b run |
| --- | ---: | ---: |
| visual-open | 6,665 ms | 5,067 ms |
| renderer-render-to-ready | 3,928 ms | 3,734 ms |
| syntax-decoration-span-count | 73 | 81 |
| interaction-typing | 233.5 ms | 221.3 ms |
| interaction-combined | 1,942.5 ms | 1,826.5 ms |
| mode-switch-visual-to-source-ms | 1,221.5 ms | 1,326.0 ms |
| mode-switch-source-to-visual-ms | 2,692.2 ms | 2,822.4 ms |
| scroll-avg-frame | 250.9 ms | 224.2 ms |
| scroll-max-frame | 399.9 ms | 372.5 ms |
| scroll-jump-bottom | 1,212.6 ms | 1,132.7 ms |
| scroll-jump-middle | 1,741.8 ms | 1,483.8 ms |
| scroll-drag-sequence | 2,366.3 ms | 1,999.1 ms |
| scrollDriftPx | 0 | 0 |
| viewportPlaceholders | 0 | 0 |
| inline-height-drift | 0 | bottom=0 middle=0 drag=0 |
| inlineMathActivateReadyMs | 3.3 ms | 3.3 ms |

Status: typing, combined interaction, scroll average, scroll max, and all
three jump-ready metrics improved on this run. Mode-switch timings remain
slightly above the cited `2fcdd9c` numbers and are still run-sensitive. Hard
drift/placeholder gates pass with zero inline-height drift. Stage 2b is
recorded as progress toward the soft metrics rather than a release gate pass.

## Stage 4a React NodeView Cost Diagnosis (2026-08-11)

Stage 4a ran on commit `7c5a399` with benchmark-only instrumentation and the
same large Barfoot file. The full breakdown is in
`docs/performance-stage4-diagnosis.md`.

Large-file diagnostic run:

| Path | wall ms | long task ms | PM dispatch ms | React NodeView ms | NodeView updates |
| --- | ---: | ---: | ---: | ---: | ---: |
| visual-open | 4,993.7 | 2,231.0 | 672.1 | ~29.3 | 0 after mount |
| typing | 531.7 | 150.0 | 12.5 | 0 | 0 |
| inline-math insert | 514.8 | 416.0 | 84.9 | 0 | 0 |
| undo | 329.2 | 285.0 | 81.4 | 0 | 0 |
| redo | 363.7 | 286.0 | 86.2 | 0 | 0 |
| visual-to-source | 2,058.3 | 1,738.0 | 9.2 | 0 | 0 |
| source-to-visual | 1,029.1 | 798.0 | 13.5 | 0 | 0 |
| large scroll | 2,671.1 | 2,593.0 | 8.8 | 0 | 0 |

Initial NodeView counts: CodeBlock 2, Image 110, Mermaid 0, Footnote 0,
HTML 0. React NodeView initialization was about 0.6% of visual-open and no
measured interaction path triggered a NodeView update, React render, or DOM
replacement. Conclusion: Stage 4b is not triggered by the current large file;
layout/parse and mode-switch work remain the dominant costs.

Scroll hydration on a separate un-instrumented run: `maxHydrateWorkMs=839.9`,
first hydrate `centerMs=265.1 / anchorMs=76.1 / hydrateMs=425.4`,
`inlineMathActivationReadyMs=0.5`, and no React NodeView work.

## Stage 3c Mode-Switch Layout Reads and Long-Task Reduction (2026-08-11)

Stage 3c ran from commit `b20e69b` and kept the Stage 3a `display:none`
hidden visual host. The root causes found for the large-file mode-switch cost:

1. `getEditorWidthBucket()` recomputed the width bucket on every hidden math
   NodeView call even after the bucket was cached. In the first Stage 3c
   benchmark run this still generated about 52,405 calls during
   `visual→source`, and the earlier Stage 4a instrumentation counted 59,713
   layout reads on the same path.
2. Source→visual reactivation called `forceActivateViewport()`, which read a
   `getBoundingClientRect()` for every registered virtual node (about 2.5k
   reads on the large file).
3. The source-mode hidden host still retained 7.2k formula preview elements
   even after Stage 3a removed KaTeX and syntax spans.
4. Delayed top-anchor compensation could restore a stale scroll target after
   the user or benchmark had already scrolled elsewhere.

Implementation changes:

- Cache the editor width bucket by editor frame and return it before any
  `clientWidth`/`getBoundingClientRect` fallback read; reset the cache with the
  other environment keys.
- While height measurement is suspended, hidden math placeholders remove their
  preview DOM instead of keeping empty preview elements; contentDOM and all PM
  text stay intact.
- Source→visual reactivation now uses the PM position index through
  `hydrateTargetRange(..., includeAllVirtualNodes=true)` and
  `hydrateInlineMathGroupsAroundPosition()` instead of the full virtual-node
  rect scan.
- Block math height keys are cached per NodeView, removing the repeated
  `refreshBlockMathPlaceholderHeights` key reconstruction.
- Top-anchor compensation and scroll stabilization no longer override a scroll
  position that has moved away from their captured target.
- MathSyntaxHighlight keeps the latest scrollTop even when a viewport rAF is
  already queued, preventing a stale scroll restore.

Latest large-file benchmark (`/home/crh/下载/barfoot_ser24/barfoot_ser24.md`):

| Metric | Stage 3a baseline | Stage 3c run |
| --- | ---: | ---: |
| mode-switch-visual-to-source-ms | 1,890.7 | 1,303.0 |
| mode-switch-source-to-visual-ms | 1,563.7 | 1,209.8 |
| visual-to-source width-bucket-calls | n/a (Stage 4a layout reads 59,713) | 1 |
| source-to-visual width-bucket-calls | n/a | 5 |
| mode-switch-source-host-dom-count | 39,065 | 24,573 |
| mode-switch-source-host-text-node-count | 23,729 | 16,483 |
| mode-switch-source-host-katex-count | 0 | 0 |
| mode-switch-source-host-syntax-span-count | 0 | 0 |
| scrollDriftPx | 0 | 0 |
| viewportPlaceholders | 0 | 0 |
| inline-height-drift | 0 | bottom=0 middle=0 drag=0 |
| inlineMathActivateReadyMs | 2.7 | 2.2 |

Stage 4 diagnosis on the same final code measured `visual→source` at
1,266.8 ms with 897 ms long-task total, and `source→visual` at 1,143.7 ms with
744 ms long-task total. Width-bucket calls and layout reads in both mode-switch
paths are effectively zero. The `<1000ms` soft mode-switch budget is not met on
every run yet, but both paths improved substantially from the Stage 3a
benchmark and the hard drift/placeholder gates pass.

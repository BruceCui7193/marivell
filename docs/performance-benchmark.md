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
| visual-edit | 459.9 ms |
| scroll-response | 95.6 ms |
| scroll-avg-frame | 157.1 ms |
| scroll-max-frame | 437.9 ms |
| context-menu-open | 787.0 ms |

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

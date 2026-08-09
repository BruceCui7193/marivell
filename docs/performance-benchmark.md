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

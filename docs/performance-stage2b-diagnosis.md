# Stage 2b Typing and Scroll Hot-Path Diagnosis

## 1. Large-file diagnosis

The large-file diagnosis was run against the current Stage 2 worktree before
the Stage 2b code changes were made:

```bash
npx tsx scripts/benchmark/stage0-diagnosis.ts \
  '/home/crh/下载/barfoot_ser24/barfoot_ser24.md'
```

Key pre-change results:

| Path | wall ms | long-task total ms | max task ms |
| --- | ---: | ---: | ---: |
| open-ready | 6,676.5 | 3,938 | 2,135 |
| typing | 645.2 | 495 | 135 |
| visual-to-source | 1,303.7 | 934 | 399 |
| source-to-visual | 2,232.6 | 1,973 | 1,133 |
| scroll top-middle-bottom-middle | 3,502.7 | 3,382 | 1,419 |

The pre-change DOM classification had 45,967 elements and 73 syntax
decoration spans. A single ordinary typing operation generated 1,964 attribute
mutations.

## 2. Hot-path conclusions

1. Ordinary typing was rebuilding the scoped MathSyntaxHighlight decoration set
   from its viewport ranges on every transaction. The plugin also mapped the
   full decoration set on every transaction even when the edit did not touch an
   inline formula.
2. Initial document replacement was treated as one large changed range. Any
   implementation that rebuilt decorations for that whole range caused a huge
   one-time full-document decoration build and a major open-time regression.
3. Inline math NodeView update paths repeatedly computed formula height keys,
   wrote the same sizing styles, and scheduled height measurement even when the
   cached key was already measured.
4. `syncInlineMathSelection` ran on every selection update, including ordinary
   caret movement outside inline math, and triggered group reconciliation and
   paragraph activation work that was not needed for normal typing.
5. MathSyntaxHighlight viewport updates used `posAtCoords` for every scrolled
   frame. Large scroll jumps also competed with EditorShell hydration in the
   same animation frame, which made bottom jump-ready noisy and slow.

## 3. What Stage 2b changed

- MathSyntaxHighlight now maps the existing decoration set and rebuilds only a
  small local changed/selection range. Large transactions are capped so a bulk
  replace or initial load does not become a full-document decoration build.
- Non-formula edits defer viewport decoration refresh to an animation frame
  instead of rebuilding synchronously on every keystroke.
- Viewport decoration updates are skipped while the loading overlay is present
  and then scheduled once the visual host is ready.
- Programmatic document replacement (`view.updateState`) now requests a
  viewport refresh explicitly, because it bypasses normal transactions. The
  refresh retries until `posAtCoords` is available or the viewport is
  definitively empty, which fixes the initial viewport decoration failure.
- Inline math NodeView height-key and sizing writes are cached; height
  measurement accepts an already-computed key.
- `syncInlineMathSelection` now returns early for caret-only moves that do not
  touch inline math, while non-empty selections keep the existing activation
  behavior.

### Initial viewport decoration bug

The first implementation of the deferred refresh used `view.update()` and a
module flag set only by plugin `apply`. `replaceEditorContent` builds a fresh
`EditorState` and calls `view.updateState()`, so no transaction reaches `apply`
and the flag stayed unset. The fix adds an explicit
`requestMathSyntaxViewportRefresh()` call before `view.updateState` and makes
the refresh loop keep retrying until the viewport update dispatches or
reports no math in view. This was verified by two consecutive
`math-syntax-scoped.e2e.test.ts` runs after the failure had been reproduced.

## 4. Post-change large-file signal

The Stage 2b clean benchmark run still shows noise in bottom jump-ready and
mode-switch timing, but the hard drift/placeholder gates pass with zero
drift on bottom, middle, and drag. The post-change diagnostics on the official
benchmark:

| Metric | 2fcdd9c baseline | Stage 2b verified run |
| --- | ---: | ---: |
| interaction-typing | 233.5 ms | 221.3 ms |
| interaction-combined | 1,942.5 ms | 1,826.5 ms |
| scroll-avg-frame | 250.9 ms | 224.2 ms |
| scroll-max-frame | 399.9 ms | 372.5 ms |
| scroll-jump-bottom | 1,212.6 ms | 1,132.7 ms |
| scroll-jump-middle | 1,741.8 ms | 1,483.8 ms |
| scroll-drag-sequence | 2,366.3 ms | 1,999.1 ms |
| scrollDriftPx | 0 | 0 |
| viewportPlaceholders | 0 | 0 |
| inline-height-drift | 0 | 0 |
| syntax-decoration-span-count | 73 | 81 |

Mode-switch timings remain slightly above the cited baseline and run-sensitive
on this machine; the Stage 2b changes do not claim the release-budget targets
yet.

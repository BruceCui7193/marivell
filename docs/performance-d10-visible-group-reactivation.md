# D10: Visible Inline Group Reactivation with Residual Placeholders

## Problem

After commit `d83ec3d` (perf: dedupe large jump hydration and anchor work), the drag benchmark regressed:

- `scroll-drag-sequence-first-frame-placeholders`: 1 (was 0) — hard gate failure
- `viewportPlaceholders`: 1 (was 0) — hard gate failure
- `uiff-click-selection-deviation`: Infinity — hard gate failure (uiff-passed=false)

Diagnostics revealed `scannedInlineGroups=477, visibleInlineGroups=1, activatedInlineGroups=0` during `hydrateVisibleViewportFallback`. A single visible inline math group was not reactivated, leaving one formula as a placeholder in the viewport.

## Root Cause

In `activateInlineMathGroupsInViewport`, when a group had `group.active === true`, the code unconditionally skipped reactivation. However, `group.active` is a coarse flag set when `activateGroup()` is first called — individual registrations within the group can remain non-active (`registration.active === false`) if their `activate()` callback was deferred, failed silently, or was never called due to a race condition during rapid scrolling (drag).

The affected code paths:

1. **Position-index path**: `if (group.active)` skipped directly, never pushing to `toActivate`.
2. **Full-group-scan path**: `if (!group.active)` was the only condition for adding to `toActivate`; active groups were skipped even when their registrations still had placeholders.
3. **`forceHydrateAllInlineMathGroups`**: Same `if (group.active) continue` pattern.

## Fix

Added a `hasResidualPlaceholders(group)` helper that iterates the group's registrations and returns `true` if any non-destroyed registration has `registration.active === false`.

Modified three locations in `inline-math-group-registry.ts`:

| Location | Before | After |
|---|---|---|
| Position-index path (~line 1142) | `if (group.active)` | `if (group.active && !hasResidualPlaceholders(group))` |
| Full-group-scan path (~line 1207) | `if (!group.active)` | `if (!group.active \|\| hasResidualPlaceholders(group))` |
| `forceHydrateAllInlineMathGroups` (~line 1245) | `if (group.active)` | `if (group.active && !hasResidualPlaceholders(group))` |

When `group.active` is true but residual placeholders exist, the group falls through to `toActivate` (viewport paths) or `activateGroup()` (force hydrate path). `activateGroup()` already checks `registration.active` individually, so only the genuinely non-active registrations are reactivated — no double-render.

## `forceActivateViewport` Check

`forceActivateViewport` (block-level virtual nodes) does not have the same masking issue: it already calls `registration.activate()` for every visible node regardless of `active` state. No fix needed.

## Benchmark Results (d6c9192)

| Metric | Before (d83ec3d) | After (d6c9192) | Budget |
|---|---|---|---|
| drag first-frame-placeholders | 1 | **0** | 0 |
| viewportPlaceholders (all) | 1/0/0 | **0/0/0** | 0 |
| uiff-click-selection-deviation-px | Infinity | **0** | — |
| uiff-passed | false | **true** | — |
| scrollDriftPx | 0 | 0 | 0 |
| inline-height-drift | 0 px | 0 px | 0 |
| inline-math-activate-ready-ms | ~2.5 | 2.5 | 50 |
| scroll-jump-bottom-ready-ms | ~1814 | 1814.9 | 200 |
| scroll-jump-middle-ready-ms | ~2520 | 2520.3 | 200 |
| scroll-drag-sequence-ready-ms | ~1865 | 1865.1 | — |

No regression on any hard gate. All three scroll sequences pass placeholders=0, drift=0, inline-height-drift=0.

## Test Results

- `npm test`: 108 passed, 0 failed
- `npx tsc --noEmit`: clean
- E2E: inline-math-scroll (33 passed), scroll-endpoints (20 passed), scroll-io (17 passed), inline-math-lazy (12 passed), first-frame-contract (8 passed), caret-alignment (252 passed), math-layout (8 passed)

## Files Modified

- `src/renderer/editor/virtualization/inline-math-group-registry.ts` (+12, −3)

## Commit

`d6c9192` — fix: re-activate visible inline groups with residual placeholders (D10)

## Residual Risk

- **Low.** The change is narrowly scoped: only groups that are `active` AND contain residual non-active registrations get an extra `activateGroup()` call. `activateGroup()` guards against redundant per-registration activation.
- The position-index fallthrough for `group.active && hasResidualPlaceholders` groups at `distance > radius && <= radius*2` hits `prepareGroup()`, which is a no-op for active groups — safe.

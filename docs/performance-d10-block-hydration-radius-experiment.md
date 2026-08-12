# D10 Block Hydration Radius Experiment (largeJump radius: original → 1)

日期: 2026-08-12
基准: `perf/performance-optimization` 分支
HEAD: c1c08fe (docs: record inline fallback margin A/B result (D10))

## 动机

大文件 benchmark 的 jump-ready 仍 1.5-2.7s，预算 200ms。已排除 DOM 扫描（~24ms）和 inline margin（1600→0 无改善且 drag 回归）。嫌疑是 `hydrateTargetRange` 在大 jump 时用 `viewportRadius * 1.5` 激活大量 block math / virtual node（block math placeholder 约 2382 个），异步 KaTeX/模板注入导致 settle-overhead 849-1962ms。

本实验验证假设：大 jump 时，`hydrateVisibleViewportFallback`（rootMargin=400）已经覆盖 first frame 的真实视口。将传给 `hydrateTargetRange` 的 radius 从 `viewportRadius * 1.5` 缩小到 1，让 hydrateTargetRange 只维护 hydration queue / IO / evict，不再激活半径 1.5x viewport 内的 block/virtual node。

## 改动

`src/renderer/components/EditorShell.tsx` `runScrollHydration` 函数：

```typescript
// 原始
activatedBlocks = hydrateTargetRange(frame, centerPos, viewportRadius, false, options?.drain === true);
activatedInlineGroups += hydrateInlineMathGroupsAroundPosition(frame, centerPos, viewportRadius);

// 实验
const targetRadius = options?.largeJump === true ? 1 : viewportRadius;
activatedBlocks = hydrateTargetRange(frame, centerPos, targetRadius, false, options?.drain === true);
activatedInlineGroups += hydrateInlineMathGroupsAroundPosition(frame, centerPos, targetRadius);
```

- `largeJump=true` 时 `targetRadius=1`，内部 `activationRadius=1.5`、`prefetchRadius=3`、`evictRadius=3`
- 普通滚动和非 large jump 路径保持不变
- `drainQueue` 和 `syncPlaceholderIo` 行为保留
- `hydrateVisibleViewportFallback` 不受影响

## 实验结果

所有数值来自 `/home/crh/下载/barfoot_ser24/barfoot_ser24.md`（1.36MB, 16565 行）的独占 benchmark。

### 关键指标

| 指标 | bottom | middle | drag |
|------|--------|--------|------|
| jump-ready | 1716.4ms | 2686.0ms | 1653.0ms |
| placeholder-ready | 814.2ms | 698.1ms | 673.2ms |
| settle-overhead | 902.3ms | 1987.9ms | 979.8ms |
| first-frame-placeholders | 0 | 0 | 0 |
| drift | 0px | 0px | 0px |
| first-frame-ready | true | true | true |
| inline-height-drift | 0px | 0px | 0px |
| uiff-passed | true | — | — |

### hydrateTargetRange 内部指标

| 指标 | bottom | middle | drag |
|------|--------|--------|------|
| scanned | 21 | 38 | 25 |
| activated | 0 | 0 | 0 |
| drainedTasks | 0 | 0 | 0 |
| queueSizeBefore | 9 | 18 | 9 |

### 模板缓存

| 指标 | bottom | middle | drag | 合计 |
|------|--------|--------|------|------|
| hits | 3 | 11 | 15 | 29 |
| misses | 56 | 72 | 59 | 187 |
| bytes | 476KB | 763KB | 1097KB | — |

## 分析

1. **activate 降到 0**：`hydrateTargetRange` 在大 jump 时不再激活任何 virtual node，行为符合预期。
2. **first-frame-placeholders=0**：`hydrateVisibleViewportFallback` 独立覆盖了真实视口，无退化。
3. **drift=0、uiff-passed=true**：视觉一致性和交互正确性未受影响。
4. **jump-ready 几乎未改善**：settle-overhead 仍 902-1988ms，占 jump-ready 的 52-74%。瓶颈不在 `hydrateTargetRange` 的 block 激活，而在 KaTeX 渲染 — 每次 jump 有 56-72 次模板 cache miss，注入 476KB-1097KB 的 KaTeX HTML。

## 结论

**不采纳**。将 `hydrateTargetRange` 的 large jump radius 缩小到 1 对 jump-ready 无改善。Placeholder 达到零只需 673-814ms，但后续 KaTeX 异步渲染还需 900-1988ms settle overhead。下一步应关注 KaTeX 渲染流水线（预渲染、缓存升温、或 chunked injection）而非 block activation 半径。

代码已恢复至原始状态（`git checkout`），未提交。

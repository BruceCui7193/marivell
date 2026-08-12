# D10 Fallback Margin Tuning & Late Stabilization

日期: 2026-08-12
基准: `perf/performance-optimization` 分支
HEAD: 待提交

## 修改摘要

三处改动，均在 `src/renderer/components/EditorShell.tsx`：

### 1. 收窄 large jump fallback 的虚拟节点扫描边距

`hydrateVisibleViewportFallback` 中 `forceActivateViewport` 的 `rootMargin` 默认值从 **800px → 400px**。

原因：原始 800px 边距会激活视口上方大片区域的虚拟节点，这些节点在 first frame 之后继续异步渲染（KaTeX），导致 anchor 上方内容收缩，产生 late drift。收窄到 400px 后，激活范围集中在视口附近，减少 late shrink 的绝对量。

`inlineMargin` 保持 1600px 不变——inline math 组的覆盖范围对 drag 场景的 first-frame placeholders 至关重要。

### 2. 延长 late stabilizer 的尾部覆盖

`startLateAnchorStabilization` 的轮询延迟序列从：
```
[0, 50, 100, 200, 350, 500, 700, 900]
```
改为：
```
[0, 50, 100, 200, 400, 700, 1200, 2000]
```

末尾延迟从 900ms 延长到 2000ms，确保 catch-all 检查能覆盖 KaTeX 渲染的完整尾段。早期检查仍然密集（0-200ms），所以大多数场景在 early exit（delta < 0.5）时不受影响。

实际运行中，late stabilizer 仍然在 2 次尝试内达到 stable（attempts: 2, stoppedReason: "stable"），扩展的尾部延迟仅在极少数 KaTeX 延迟渲染的场景下作为保险。

### 3. 新增诊断字段

`VisibleViewportFallbackTimings` 接口新增 `rootMargin` 和 `inlineMargin` 字段，记录实际使用的边距值。Benchmark 输出中可直接对照。

## 实验结果

所有数值基于 `/home/crh/下载/barfoot_ser24/barfoot_ser24.md`（1.36MB, 16565 行）的独占 benchmark。

### 关键指标对比

| 指标 | bca2b9b (baseline) | 本次 | 变化 |
|------|-------------------|------|------|
| inline-height-drift (bottom) | 96px | **0px** | ✓ |
| inline-height-drift (middle) | 0px | **0px** | ✓ |
| inline-height-drift (drag) | 0px | **0px** | ✓ |
| first-frame placeholders | 0-1 (middle 偶发) | **0/0/0** | ✓ |
| viewportPlaceholders | 0-1 | **0** | ✓ |
| scrollDriftPx | 0 | **0** | ✓ |
| uiff-passed | true | **true** | ✓ |
| jump-ready (max) | 3043.3ms | **2660.7ms** | -382.6ms (-12.6%) |
| bottom jump-ready | 2056.6ms | 1815.9ms | -240.7ms |
| middle jump-ready | 2581ms | 2660.7ms | +79.7ms |
| drag jump-ready | 3043.3ms | 1819.0ms | -1224.3ms |
| inline-math-activate-ready-ms | 2.6ms | 2.7ms | ✓ (< 50ms budget) |

### 实验过程记录

| 迭代 | rootMargin | inlineMargin | stabilizer | 结果 |
|------|-----------|-------------|-----------|------|
| 1 | 200 | 400 | 2 attempts [0,50] | drift=96, drag placeholders=1 |
| 2 | 200 | 800 | 4 attempts [0,50,100,200] | drift=96, drag placeholders=1 |
| 3 | 200 | 800 | 8 attempts (original) | drift=0 but bottom placeholders=2 |
| 4 | 400 | 1600 | 8 attempts (original) | **drift=0, placeholders=0** (首次全绿) |
| 5 | 400 | 1600 | 8 attempts, no early exit | drift=0 but jump-ready=2720ms |
| 6 | 400 | 1600 | 8 attempts, extended delays | **drift=0, placeholders=0, jump-ready=2661ms** |

迭代 4 和 6 均达成全绿。迭代 6 选为最终方案——扩展的延迟尾部提供更可靠的 catch-all，且不影响常见场景的 early exit。

## 机制分析

### 为什么收窄 rootMargin 有效

原始 800px 边距激活视口上方约 800px 的虚拟节点。这些节点的 KaTeX 渲染在 first frame 之后进行，导致内容收缩：

- Bottom 场景：anchor 在视口顶部（offsetTop≈6px），上方激活的虚拟节点渲染后收缩约 96-141px
- 收窄到 400px 后，只激活视口上方约 400px 区域，late shrinkage 大幅减少

late stabilizer 的第一次补偿（0ms 时）能正确捕获 hydration 后的 anchor 偏移。第二次补偿（50ms 时）捕获早期 KaTeX 渲染。扩展的 2000ms 尾部检查作为 catch-all。

### 为什么 inlineMargin 保持 1600px

Drag 场景视口包含大量 inline math。inlineMargin=400 或 800 时，drag 的 first-frame placeholders 为 1（一个 `\mu_{y,k}` 公式在 fallback 扫描范围之外）。1600px 确保覆盖。

### 为什么 middle jump-ready 略有回归

Middle 场景的 settle-overhead 从 ~1600ms 增加到 ~1789ms。这可能是扩展延迟序列导致的——即使 stabilizer early-exit，延迟数组中的下一跳在 setTimeout 队列中，可能与其他异步工作交错。但回归幅度（~80ms）在 benchmark 噪声范围内（单次测量）。

## 功能测试

全部通过：
- `npm test`: 108 passed
- `npx tsc --noEmit`: 无错误
- e2e: inline-math-scroll (33), scroll-endpoints (20), scroll-io (17), inline-math-lazy (12), first-frame-contract (8), caret-alignment (252) — 全部通过

## 剩余风险

1. **单次测量噪声**：benchmark 结果来自单次独占运行。middle jump-ready 的 +80ms 回归可能在多轮测量中消失。
2. **极低概率的 late drift**：如果 KaTeX 在 2000ms 后仍有渲染（理论上可能，大文件极低概率），drift 可能非零。当前 2000ms 覆盖了 observed settle-overhead (~1100ms) 的约 2 倍。
3. **rootMargin=400 的边界情况**：在某些视口高度或字体大小配置下，400px 边距可能不足以覆盖 viewport。当前 benchmark 的 clientHeight=615px，400px 边距覆盖 1415px 总范围 (>2x viewport height)。

## 回退方案

若出现 drift 回归，可将 `effectiveRootMargin` 恢复为 800：
```typescript
const effectiveRootMargin = options.rootMargin ?? 800;
```
或将延迟序列恢复为原始值：
```typescript
const delays = [0, 50, 100, 200, 350, 500, 700, 900];
```

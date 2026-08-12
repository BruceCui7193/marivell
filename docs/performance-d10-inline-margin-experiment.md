# D10 Inline Fallback Margin Experiment (inlineMargin: 1600 → 0)

日期: 2026-08-12
基准: `perf/performance-optimization` 分支
HEAD: ff99883 (perf: reduce benchmark placeholder scan overhead (D10))

## 动机

大文件 benchmark 的 jump-ready 仍 1.8-2.7s，预算 200ms。`hydrateVisibleViewportFallback`
当前 `rootMargin=400`、`inlineMargin=1600`。inline margin 会激活视口外大量 inline math group，
造成后续 KaTeX/layout/paint 长任务，是 settle-overhead 高的嫌疑来源。

本实验将 `inlineMargin` 从 **1600 → 0**，观察能否降低 settle-overhead 从而减少 jump-ready。

## 改动

`src/renderer/components/EditorShell.tsx` 第 331 行：

```typescript
// 原始
const effectiveInlineMargin = options.inlineMargin ?? 1600;
// 实验
const effectiveInlineMargin = options.inlineMargin ?? 0;
```

rootMargin 保持 400，late stabilizer 延迟序列不变。

## 实验结果

所有数值来自 `/home/crh/下载/barfoot_ser24/barfoot_ser24.md`（1.36MB, 16565 行）的独占 benchmark。

### 关键指标对比

| 指标 | inlineMargin=1600 (baseline) | inlineMargin=0 | 变化 |
|------|----------------------------|----------------|------|
| bottom jump-ready | 1542.1ms | 1517.7ms | -24.4ms (-1.6%) |
| middle jump-ready | 2710.1ms | 2633.9ms | -76.2ms (-2.8%) |
| drag jump-ready | 1575.8ms | **1943.8ms** | **+368.0ms (+23.4%)** |
| bottom settle-overhead | 853.7ms | 849.8ms | -3.9ms |
| middle settle-overhead | 1962.6ms | 1818.2ms | -144.4ms |
| drag settle-overhead | 656.6ms | 1023.1ms | +366.5ms |
| bottom placeholder-ready | 688.4ms | 667.9ms | -20.5ms |
| middle placeholder-ready | 747.5ms | 815.7ms | +68.2ms |
| drag placeholder-ready | 919.3ms | 920.8ms | +1.5ms |
| bottom inline-height-drift | 0px | 0px | ✓ |
| middle inline-height-drift | 0px | 0px | ✓ |
| drag inline-height-drift | 0px | 0px | ✓ |
| first-frame placeholders | 0/0/0 | 0/0/0 | ✓ |
| scrollDriftPx | 0 | 0 | ✓ |
| uiff-passed | true | true | ✓ |

### late stabilization diagnostics (inlineMargin=0)

| 场景 | attempts | finalDelta | stoppedReason | lastRunAtMs |
|------|----------|-----------|---------------|-------------|
| bottom | 2 | 0 | stable | 661ms |
| middle | 2 | 0 | stable | 1366ms |
| drag | 2 | 0 | stable | 498ms |

### visible fallback timings (inlineMargin=0)

| 场景 | fallbackMs | virtualMs | inlineMs | activatedInlineGroups | scannedInlineGroups |
|------|-----------|-----------|----------|-----------------------|---------------------|
| bottom | 6.3 | 3.6 | 2.7 | 0 | 2000 |
| middle | 4.9 | 3.5 | 1.4 | 0 | 955 |
| drag | 4.3 | 3.6 | 0.7 | 0 | 474 |

## 结论

**inlineMargin=0 未带来有意义的 jump-ready 改进，且 drag 场景出现显著回归 (+368ms)。**

1. 质量指标全部保持：drift=0、first-frame-placeholders=0、uiff-passed=true
2. bottom 和 middle 的 jump-ready 仅降低 1-3%（~25-76ms），属于噪声级别，远未达到预算
3. **drag jump-ready 从 1575.8ms 退化为 1943.8ms (+23.4%)**，推测原因：inlineMargin=0
   使 fallback 覆盖范围过窄，drag 跳转后视口内的 inline math 组未被预激活，
   改为依赖后续 settle 阶段的异步 hydration，反而增加了等待成本
4. 核心 settle-overhead（849-1962ms）与 inlineMargin 基本无关——KaTeX/layout/paint 长任务
   来源于视口内的 block math 和虚拟节点的异步渲染，而非 inline math 组

## 决定

- **不提交代码**，恢复 `inlineMargin=1600`
- 前一文档 `docs/performance-d10-fallback-margin-tuning.md` 的结论仍然成立：
  inlineMargin=1600 是保证 drag 场景 first-frame-placeholders=0 的必要值
- settle-overhead 的根本原因需要进一步诊断（可能是 block math 异步渲染队列、
  虚拟节点的 KaTeX 注入、或 intersect 触发链）

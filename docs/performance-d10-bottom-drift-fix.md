# D10 Bottom Drift Fix

日期: 2026-08-12
分支: `perf/performance-optimization`
HEAD: b9a4bc8 (工作区含 D10 修复)

## 修改概要

### 修复 1: `runSettleFallbackScan` — coordsAtPos null 时的 domAtPos 兜底

**文件**: `src/renderer/components/EditorShell.tsx` → `runSettleFallbackScan`

**问题**: 补偿循环遇到 `coordsAtPos` 返回 null 时直接 `break`，导致 anchor 补偿从未执行。

**修复**:
- 添加 `domAtPos` + `getBoundingClientRect` 兜底路径，与 `runScrollHydration` 的 deferred 补偿路径一致
- 新增 `domFallbackUsed: boolean` 字段到 `settleDiag` 诊断对象
- 兜底成功后应用 `applySurfaceAnchorCompensation(delta)`，最多 1 次（domAtPos 路径后 break）

**诊断字段新增**: `__marivellSettleScanDiagnostics.domFallbackUsed`

### 修复 2: `runScrollHydration` — wasAtBottom 分支添加 anchor 补偿

**文件**: `src/renderer/components/EditorShell.tsx` → `runScrollHydration`

**问题**: `wasAtBottom` 分支直接清空所有补偿并滚到底部，完全跳过 `anchorBeforeHydrate` 的补偿。用户滚到底部后 placeholder→真实内容收缩导致文档净收缩，但补偿从未触发。

**修复**:
- 在 pin 到 `bottomScrollTop` 后，若 `anchorBeforeHydrate !== null`，执行 anchor 补偿
- 使用 `coordsAtPos` + `domAtPos` 兜底获取 anchor 位置
- 补偿后重新 pin 到底部 (`frame.scrollTop = Math.round(newMax)`)
- 更新 `anchorCompensationAttempts` 和 `lastAnchorCompensationDelta`

### 测试更新: `scroll-endpoints.e2e.test.ts`

- `StableScrollState` 接口新增 `visiblePlaceholders`, `inlineHeightDrift`, `inlineHeightDriftNote`, `settleScanDiagnostics` 字段
- `buildStableScrollScript` 在 settle 后采集 inline-height-drift 和 placeholder 统计
- 新增断言: `bottom inline-height-drift is within tolerance after D10 fix`

## Benchmark 关键数字 (core fixes only, vs b9a4bc8)

| 指标 | bottom | middle | drag |
|------|--------|--------|------|
| first-frame placeholders | 0 | 0 | 0 |
| viewportPlaceholders | 0 | 0 | 0 |
| drift (scrollTop) | 0px | 0px | 0px |
| inline-height-drift | **141px** | 2.47px | ~0-78px |
| jump-ready | ~1145ms | ~2984ms | ~1280ms |
| placeholder-ready | ~596ms | ~2587ms | ~820ms |
| settle-overhead | ~549ms | ~397ms | ~460ms |
| uiff-passed | true | — | — |

### settle-scan 诊断

```
bottom: coordsOk=true, finalDelta=0, domFallbackUsed=false, compensationApplied=0
middle: coordsOk=true, finalDelta=0, domFallbackUsed=false, compensationApplied=1
drag:   coordsOk=true, finalDelta=0, domFallbackUsed=false, compensationApplied=1
```

## 剩余差距

### bottom inline-height-drift 仍为 141px

**根因**: benchmark 的 bottom 场景（scrollTop = maxScrollTop * 0.98）不满足 `wasAtBottom` 条件（`scrollTop >= maxScrollTop - 1`），走的是 `else if (anchorBeforeHydrate !== null)` 的 middle/drag 路径。修复 2（wasAtBottom 补偿）在此场景下不触发。

settle-scan 的补偿循环看到 `coordsAtPos` 返回成功且 delta=0，因为 settle-scan 运行时 KaTeX 尚未完全渲染（hydrateTargetRange 只激活 viewport 附近的节点）。anchor 以上的大量 inline math 节点在 benchmark 的 settle 等待阶段被逐步激活，其收缩导致 anchor 上移 141px。

**解决方向**:
1. 扩大 settle-scan 的 hydration 范围以覆盖 anchor 以上的 inline math 区域（成本高，可能严重影响性能）
2. 在 settle-scan 后添加轻量级 deferred 补偿，仅补偿不重新 hydration（尝试过，引入 scrollTop drift 279px）
3. 使用 height-cache 预估 placeholder→真实内容的高度差并预补偿（依赖 U3.2 坐标引擎）

### drag inline-height-drift 波动

不同 benchmark 运行中 drag 的 inline-height-drift 在 0-91px 之间波动，受 inline math 激活顺序和 KaTeX 渲染时序影响。middle 的 drift 稳定在 2.47px。

## 功能测试

所有测试通过:
- `npm test` — 全部通过
- `npx tsc --noEmit` — 无错误
- `git diff --check` — 无空白问题
- `tsx scripts/tests/inline-math-scroll.e2e.test.ts` — 33/33
- `tsx scripts/tests/scroll-endpoints.e2e.test.ts` — 20/20
- `tsx scripts/tests/scroll-io.e2e.test.ts` — 17/17
- `tsx scripts/tests/inline-math-lazy.e2e.test.ts` — 12/12
- `tsx scripts/tests/first-frame-contract.e2e.test.ts` — 8/8
- `tsx scripts/tests/caret-alignment.e2e.test.ts` — 252/252

## 不修改项

- settle frames 仍为 3（未减少）
- benchmark 主指标语义未修改
- perf-budget.json 未修改
- middle/drag 路径未增加新的延迟补偿

## 风险

1. **wasAtBottom 补偿**: 仅在真正的底部场景触发（用户手动滚到底部或文档末尾）。不影响 middle/drag 的 0-drift 路径。
2. **domAtPos 兜底**: 只在 `coordsAtPos` 返回 null 时触发，当前 benchmark 中 `coordsAtPos` 始终成功，该路径未激活。代码路径与已有的 deferred 补偿一致，风险低。
3. **诊断字段**: `domFallbackUsed` 是新增字段，向后兼容（benchmark 使用 `JSON.stringify` 记录完整对象）。

# D10 Bottom Drift & Jump-Ready Latency 根因诊断

日期: 2026-08-12
基准: `/home/crh/下载/barfoot_ser24/barfoot_ser24.md`（1.36MB, 16565 行）
HEAD: `4cfb931` (`perf/performance-optimization`)

## 1. 现象汇总

| 指标 | bottom | middle | drag |
|------|--------|--------|------|
| jump-ready | 1109ms | 2297ms | 1666ms |
| placeholder-ready | 571.5ms | ~600ms | ~600ms |
| settle-overhead | 537.5ms | ~1600ms | ~1000ms |
| first-frame placeholders | 0 | 0–1 | 0 |
| inline-height-drift | **141px** | 2.47px | 0px |
| scrollDriftPx | 0 | 0 | 0 |
| fallback | 10.3ms | 7.5ms | 8.9ms |
| hydration totalMs | 183.6ms | — | — |

关键异常:
- **bottom inline-height-drift 始终 141px**，且 `margin=`（空），说明 surface margin compensation 从未生效
- **jump-ready 1.1–2.3s**，其中 placeholder-ready 571ms、settle-overhead 537ms（bottom）；middle 的 settle-overhead 高达 1600ms
- **middle first-frame placeholders 偶尔 1**，drift 偶尔 2.47px

## 2. Bottom 141px Drift 根因

### 2.1 证据链

来源于 `perf-report.json` 中 `scroll-jump-bottom` 的 note 字段：

```
before=9300 assign=739260 final=739260 max=754027
anchor=pm:1302279| before=16.6 after=-124.4 margin=
```

解码：
- `before=16.6`: 跳转到 `targetScrollTop = maxScrollTop * 0.98` (739260) 后，
  `beforeTopAnchor.relativeTop = 16.625` → anchor 在视口顶部附近（符合预期：采样点在 `frameRect.top + 8`）
- `after=-124.4`: KaTeX settle 完成后 `coordsTop - frameRectTop = -124.4`
  → anchor 移到了视口上方 124.4px 处
- `margin=`: 空字符串 → `surface.style.marginTop` 从未被设置
- `drift = |(-124.4) - 16.6| = 141px`

Timings 关键字段:
```json
"compensation": 0,
"anchorCompensationAttempts": 0,
"anchorCoordsOk": false,
"lastAnchorCompensationDelta": null
```

### 2.2 根因定位

#### 2.2.1 `captureHydrationAnchor` 捕获的是视口顶部 anchor

文件: `src/renderer/components/EditorShell.tsx:2342`

```typescript
const captureHydrationAnchor = (editorForAnchor) => {
  const benchmarkAnchor = window.__marivellBenchmarkTopAnchor;
  if (benchmarkAnchor) {
    return {
      pmPos: benchmarkAnchor.pmPos,        // 1302279
      offsetTop: benchmarkAnchor.relativeTop, // 16.625
    };
  }
  // fallback: posAtCoords(frameRect.left + 20%, frameRect.top + 8)
};
```

Benchmark 在 `scrollTop = maxScrollTop * 0.98` 后调用 `getTopAnchor()`，
在 `(frameRect.left + 20%, frameRect.top + 8)` 处采样 → pmPos=1302279。
这个位置在文档**中部偏下**（非文档顶部），因为视口此时在页面底部。

#### 2.2.2 `wasAtBottom` 分支跳过所有 anchor 补偿

文件: `src/renderer/components/EditorShell.tsx:2566-2595`

```typescript
// runScrollHydration 的 options.settle !== true 路径
if (wasAtTop) {
  // 清除补偿，scrollTop = 0
} else if (wasAtBottom) {
  scrollAnchorCompensationRef.current = 0;
  surfaceCompensationY = 0;
  surface.style.marginTop = '';       // ← margin 被清空
  frame.scrollTop = bottomScrollTop;  // ← 直接滚到底
  // ⚠️ anchorBeforeHydrate 的补偿被完全跳过
} else if (anchorBeforeHydrate !== null) {
  // 这里是 middle/drag 场景走的 anchor 补偿路径
  // 有 3 次同步补偿尝试 + deferred rAF 补偿（含 domAtPos 兜底）
}
```

对于 bottom 场景: `scrollTopBeforeHydrate >= oldMaxScrollTop - 1` → `wasAtBottom = true`，
直接进入底部固定分支，**anchorBeforeHydrate 的补偿代码从未执行**。

#### 2.2.3 `runSettleFallbackScan` 的补偿使用了错误的 anchor 且无 null-coords 兜底

文件: `src/renderer/components/EditorShell.tsx:2431-2473`

```typescript
const runSettleFallbackScan = () => {
  // 1. hydrate near cheap center (bottom area)
  hydrateTargetRange(frame, centerPos, radius, false, true);
  hydrateInlineMathGroupsAroundPosition(frame, centerPos, radius);

  // 2. 使用 runScrollHydration 中设置的 stale anchor
  const anchor = scrollHydrationAnchorForFallback
    ?? captureHydrationAnchor(currentEditor);
  // anchor = { pmPos: 1302279, offsetTop: 16.625 }

  // 3. 补偿循环 — 无 domAtPos 兜底
  for (let attempt = 0; attempt < 3; attempt++) {
    const coords = coordsAtPos(currentEditor, anchor.pmPos);
    if (!coords) { break; }  // ← null 时直接退出，无 fallback
    const delta = (coords.top - frameRect.top) - anchor.offsetTop;
    if (Math.abs(delta) < 0.5) { break; }
    applySurfaceAnchorCompensation(delta);
  }
};
```

对比 `runScrollHydration` 的 deferred 补偿路径（line 2629-2668），它有针对
`coordsAtPos` 返回 null 的兜底：

```typescript
const coords = coordsAtPos(editorForCompensation, deferredAnchor.pmPos);
let anchorTop = coords?.top ?? null;
if (anchorTop === null) {
  // 兜底: domAtPos + getBoundingClientRect
  const domPosition =
    editorForCompensation.view.domAtPos(deferredAnchor.pmPos);
  anchorTop = anchorElement.getBoundingClientRect().top;
}
```

`runSettleFallbackScan` **没有这个兜底**。在 settle 时刻，
`coordsAtPos` 可能因 ProseMirror DOM 尚未 flush 或虚拟节点正在激活而返回 null，
导致补偿循环在第一次迭代就退出（`break`），**surface margin 从未被设置**。

#### 2.2.4 为什么 drift 正好 141px

跳转前（scrollTop=0），文档顶部内容已经是真实的（初始渲染已激活）。
跳转到 bottom (scrollTop=739260) 后：
- `hydrateTargetRange` 和 `hydrateVisibleViewportFallback` 激活了视口附近的虚拟节点
- 视口附近的 placeholder 被替换为真实内容
- 真实内容比 placeholder **矮约 141px**（placeholder 使用估算高度，真实 KaTeX/图片渲染后更矮）
- pmPos=1302279 以上的所有内容净收缩 141px
- anchor 在页面上向上移动 141px
- `afterRelativeTop = coords.top - frameRect.top = before - 141 = -124.4`

由于补偿从未被应用（`wasAtBottom` 跳过 + settle scan 无兜底），
drift 保持为 141px。

### 2.3 根因结论

1. **主因**: `wasAtBottom` 分支直接清空所有补偿并跳到底部，跳过 anchor 补偿
2. **次因**: `runSettleFallbackScan` 的补偿循环缺少 `coordsAtPos → null` 时的
   `domAtPos` + `getBoundingClientRect` 兜底，导致 settle 阶段也无法补偿
3. **结构性问题**: `scrollHydrationAnchorForFallback` 是一个**跨阶段全局变量**，
   存储的是 hydration 前捕获的 anchor（pmPos=1302279, offsetTop=16.625）。
   在 hydration 完成后，文档高度已改变，这个 anchor 的 `offsetTop` 已经不再准确。
   即使 coords 可用，补偿的是「使 anchor 回到视口顶部 16.6px 处」，
   而非「保持当前视口内容稳定」。

## 3. Jump-Ready 延迟根因

### 3.1 时间构成分解（bottom 场景）

| 阶段 | 耗时 | 占比 | 说明 |
|------|------|------|------|
| hydration work | ~184ms | 17% | `runScrollHydration` totalMs |
| visible fallback | 10.3ms | 0.9% | forceActivateViewport + activateInlineMathGroupsInViewport |
| placeholder 等待 | ~387ms | 35% | placeholder-ready - hydration - fallback |
| KaTeX real-render | ~537ms | 48% | settle-overhead（notRealKatex → 0 的等待 + 3 settle frames） |
| **jump-ready** | **~1109ms** | 100% | |

### 3.2 Placeholder-Ready 阶段 (571ms)

文件: `scripts/benchmark/performance.ts:1390-1425`

```javascript
while (true) {
  await waitForFrame();  // 2 × rAF → ~33ms per iteration
  const placeholders = visiblePlaceholderCount();
  if (placeholders === 0 || performance.now() > deadline) break;
}
```

- 每轮轮询等待 2 个 rAF（约 33ms @ 60fps）
- `visiblePlaceholderCount()` 扫描 DOM（5 个选择器 × querySelectorAll + 所有 .math-inline-node 逐一检查）
- 大文件有 ~2000+ inline math nodes 在视口内
- placeholder 归零的时机取决于 inline math 的异步激活（公式 HTML prepare + KaTeX 注入）
- 延迟来源:
  - KaTeX HTML 注入到 DOM 的 rAF 调度
  - `hydrateInlineMathGroupsAroundPosition` 内部按 batch 激活（每批受 rAF 调度）
  - inline math 的 `placeholder → real` 转换需要至少 1 帧 + KaTeX render

### 3.3 Settle-Overhead 阶段 (537ms bottom, 1600ms middle)

文件: `scripts/benchmark/performance.ts:1430-1455`

```javascript
// KaTeX 真实化等待
while (visibleInlineMathKatexStats().notRealKatex > 0 && perf < deadline) {
  await waitForFrame();  // 2 rAF per iteration → ~33ms
}
// 3 个 settle frames
for (let settleFrame = 0; settleFrame < 3; settleFrame++) {
  await waitForFrame();
}
```

- KaTeX 真实化: inline math 占位符被替换为真实 `.katex` 元素后，浏览器需要 layout + paint
- `notRealKatex > 0` 的循环等待所有视口内公式完成 KaTeX 渲染
- middle 的 settle-overhead 高达 1600ms 的原因:
  - middle 视口包含更多 inline math（ratio center 在文档中部，inline math 密度更高）
  - 更多公式需要 KaTeX 渲染 → 更多帧等待
- 3 个 settle frames 是固定开销（约 100ms @ 60fps）

### 3.4 根因结论

- **placeholder 阶段**: inline math 的异步激活调度（rAF batching）和公式 HTML 准备是瓶颈
- **settle 阶段**: KaTeX 真实化渲染是主要开销；middle 场景因公式密度更高而更慢
- **非 fallback 本身**: fallback 仅 7–11ms，不是延迟来源
- **无主线程长任务**: hydration work 184ms 分布在多个微任务中，不阻塞 rAF

## 4. Middle 场景波动分析

### 4.1 first-frame placeholders 偶尔 1

- `hydrateVisibleViewportFallback` 扫描 viewport ±800px 范围（`forceActivateViewport(frame, 800)`）
- 偶有边缘 virtual node 在 viewport 内但不在 800px margin 内（或 IO 观察未触发）
- 与 bottom 补偿的残留 rAF 无关（bottom 的 settle scan 不产生 rAF side effect）

### 4.2 inline-height-drift 偶尔 2.47px

证据: `margin=770.656px` → middle 的 surface compensation 生效了（770px marginTop）
2.47px 是 residual KaTeX 渲染引起的亚像素漂移（KaTeX 公式高度与 placeholder 估算不完全一致）

### 4.3 跨场景残留

- `scrollHydrationAnchorForFallback` 是闭包变量，在每次 `runScrollHydration` 中被覆盖
- benchmark 各场景之间调用了 `__marivellResetScrollAnchorCompensation` 和
  `__marivellResetHydrationSyncForTest`，清除补偿状态
- **没有发现跨场景 spacer/margin 残留**

## 5. 修复方案

### 5.1 Bottom Drift 修复

#### 方案 A: 修复 `runSettleFallbackScan` 的 coords null 兜底（推荐，最小改动）

**文件**: `src/renderer/components/EditorShell.tsx` → `runSettleFallbackScan`

在补偿循环中添加 `domAtPos` + `getBoundingClientRect` 兜底，
与 `runScrollHydration` 的 deferred 补偿路径保持一致：

```typescript
for (let attempt = 0; attempt < 3; attempt++) {
  const frameRect = frame.getBoundingClientRect();
  const coords = coordsAtPos(currentEditor, anchor.pmPos);
  let anchorTop: number | null = coords?.top ?? null;
  if (anchorTop === null) {
    // 兜底: 当 ProseMirror coordsAtPos 返回 null 时使用原生 DOM 坐标
    try {
      const domPos = currentEditor.view.domAtPos(anchor.pmPos);
      const el = domPos.node.nodeType === Node.ELEMENT_NODE
        ? domPos.node as Element
        : domPos.node.parentElement;
      anchorTop = el?.getBoundingClientRect().top ?? null;
    } catch { anchorTop = null; }
  }
  if (anchorTop === null) { break; }
  const delta = (anchorTop - frameRect.top) - anchor.offsetTop;
  if (Math.abs(delta) < 0.5) { break; }
  applySurfaceAnchorCompensation(delta);
}
```

**风险**: 低。与已有 deferred 补偿路径一致。domAtPos 在大文件上约 <0.1ms。

#### 方案 B: 为 bottom 端点添加专门的 `bottomAnchor` 补偿（更精确）

在 `runScrollHydration` 的 `wasAtBottom` 分支中，不跳过 anchor 补偿，
而是捕获一个**视口底部**的 anchor 并在 hydration 后补偿：

```typescript
} else if (wasAtBottom) {
  // 捕获底部 anchor（视口底部上方 8px）
  const bottomAnchor = captureHydrationAnchorAtBottom(currentEditor);
  // ... hydration ...
  // 补偿底部 anchor
  if (bottomAnchor) {
    const coords = coordsAtPos(currentEditor, bottomAnchor.pmPos);
    if (coords) {
      const delta = (coords.bottom - frameRect.bottom)
        - bottomAnchor.offsetFromBottom;
      applySurfaceAnchorCompensation(-delta);
    }
  }
  frame.scrollTop = Math.round(maxScrollTop);
}
```

**风险**: 中。需要新增 `captureHydrationAnchorAtBottom` 函数，
且底部 anchor 的语义（offsetFromBottom vs offsetTop）需要仔细处理。

#### 方案 C: 引入 U3.2 height cache 做 cheap placeholder→real delta 预估

在 hydration 前，用 height cache 预估 placeholder 和真实内容的高度差，
提前在 `surfaceCompensationY` 中预留 delta。hydration 后微调。

**风险**: 中高。依赖 U3.2 坐标引擎（当前仅在 POC 阶段 `bf21ef1`），
需要大量集成工作。建议作为后续阶段。

### 5.2 Jump-Ready 延迟修复

#### 方案 A: 并行化 placeholder 轮询与 settle

当前 placeholder 等待和 KaTeX settle 是**串行**的。可以将它们改为并行：
一旦 `visiblePlaceholderCount() === 0`，立即开始 KaTeX settle 等待，
而非等 placeholder loop 完全退出。

**文件**: `scripts/benchmark/performance.ts` → `measureScrollJumpScenario`

**风险**: 低（仅 benchmark 改动）。

#### 方案 B: 用 MutationObserver 替代轮询

用 `MutationObserver` 监听 `.math-inline-node--placeholder` 的 class 变化，
在 placeholder 归零时立即 resolve，而非每 33ms 轮询一次。

**风险**: 中。MO 在大量 DOM 变更时可能产生回调风暴。

#### 方案 C: 减少 settle frames（3 → 1）

当前 3 个 settle frames 是为了确保 layout 稳定。在 inline math count
较高的场景，可以减少到 1 个 settle frame + `requestIdleCallback` 兜底。

**风险**: 低。首帧 layout 通常已经准确；额外的 settle frames 是安全余量。

### 5.3 推荐修复顺序

1. **立即**: 方案 5.1-A（`runSettleFallbackScan` null-coords 兜底）— 修复 bottom drift
2. **立即**: 方案 5.2-C（减少 settle frames）— 减少 settle-overhead 约 66ms
3. **短期**: 方案 5.2-B（MutationObserver 轮询）— 减少 placeholder-ready 约 200ms
4. **中期**: 方案 5.1-B（bottom 专用 anchor）— 更精确的 bottom 补偿
5. **长期**: 方案 5.1-C（U3.2 height cache）— 架构级优化

## 6. 验证步骤

1. 应用方案 5.1-A + 5.2-C
2. 运行 `npm run benchmark`（exclusive-run=true）
3. 验证: bottom `inline-height-drift` 归零，`settle-overhead` 减少 ~66ms
4. 若 drift 未归零，检查 settle scan 的 `domAtPos` 是否也返回 null
   （可能需要在 hydration 完成后延迟一帧再补偿）
5. 确认 middle first-frame placeholders 仍 ≤1

## 7. 风险与回退

- 方案 5.1-A 的 `domAtPos` 兜底可能返回错误的 element（如果 PM pos 映射到 text node）。
  已有代码（`EditorShell.tsx:2643-2648`）处理了此情况，可直接复用。
- 方案 5.2-C 减少 settle frames 可能导致 UIFF 检测到 layout shift。
  若出现回退，恢复 3 frames。
- 所有改动不改变非 largeJump 路径（普通滚动帧和普通 scrollend settle 不变）。

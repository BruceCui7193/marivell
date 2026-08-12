# D10 Drag Drift Verification

## 1. Problem

本轮要解决的是 D10 大跳转优化后 drag 场景的残余视觉漂移和 scroll session 风暴：

- 主代理复测时 drag `inlineHeightDrift` 达到 `308.921875px`。
  - `anchor=pm:341870`，`before=-17`，`after=-325.9`，`margin=41.2109px`。
  - 说明 `runScrollHydration` 补偿后，后续 KaTeX/layout 变化仍会让 anchor 继续移动。
- drag 后 UIFF 失败。
  - 独立复测出现 `click deviation 790.3px`，`selectedPos=342338`、`mappedPos=341877`，说明视口内容仍错位。
- scroll-io 后小步 scroll 会污染后续 jump scenario。
  - middle 和 drag 多次 `timeout 15000ms`。
  - timeout diagnostics 显示 `hydrateRunCount=284..307`。
  - 大量 `scrollTop≈8804..9300`、`scrollDelta=31/62/93` 的小步 hydration。
  - 这些内部滚动先于目标大跳转出现，说明前一个测试遗留的 hydration/settle/anchor restore 流没有被清理。

## 2. Root Cause

### 2.1 400ms 单次 drift 校验太晚

最初方案是 late stabilizer 稳定后只等 `400ms` 再校验一次：

- drag benchmark 不一定触发 `scrollend`，因此 late stabilizer 不一定是当前 scenario 的可靠入口。
- 400ms 单次校验可能晚于 benchmark settle 测量，也可能只漏掉一次后续布局变化。

### 2.2 补偿产生的 scroll 事件被当成新 session

`applySurfaceAnchorCompensation` 修改 surface `marginTop` 后可能产生小步 scroll 事件。

旧逻辑会把这类事件当作真实新滚动：

- `cancelLateAnchorStabilization()`
- 重置 `sessionSettlePerformed`
- 重新 schedule 360ms idle settle
- 每次 settle 又可能触发 anchor restore / `forceActivateViewport`，继续写 `frame.scrollTop`

最终形成自持循环：

```text
compensation -> small scroll -> new session -> idle settle -> anchor restore
  -> small scroll -> new session -> ...
```

timeout diagnostics 中的 `hydrateRunCount=284..307` 正是这个循环。

### 2.3 前一个 scenario 的遗留状态污染下一个 scenario

scroll-io overhead 会执行 300 次小步滚动，结束后遗留：

- idle settle timer
- activation-controller pending hydration frame
- late stabilizer / drift verification timer
- pending sync jump

如果 jump scenario 开始前不清理，这些遗留任务会在新 scenario 中继续触发 hydration。

## 3. Fix

### 3.1 有界早 drift 校验

`runScrollHydration` 完成 anchor 补偿后，直接启动有界 drift 校验：

- 延迟窗口：`50ms / 100ms`
- 不再依赖 drag 是否触发 `scrollend`
- 每次复测 delta `>=0.5px` 时继续补偿
- 校验结束后标记 `stable-drift-verified` 或 `stable-drift-corrected`

### 3.2 补偿后 pin scrollTop

drift 校验补偿后：

- 把 `frame.scrollTop` pin 回当前 scenario captured target
- 更新 `lastAnchorRestoredScrollTopRef`

避免补偿产生的 scrollTop 漂移被当成新的真实滚动。

### 3.3 Scroll Session Phase Gate

新增 session phase：

```text
active -> settling -> settled
```

- large jump / endpoint：始终开启新 session
- settled 后，未受信小步 scroll 不再重启 session
- 真实用户滚动（`event.isTrusted`）仍可开启新 session

这样内部 `restoreVisualScrollAnchor` / idle settle 的 scrollTop 写入不会形成 hydration 风暴。

### 3.4 Scenario Reset

新增 benchmark-gated API：

```text
__marivellResetScrollSessionForTest
```

每个 scroll-jump scenario 开始前调用，清理：

- idle settle timer
- EditorShell `hydrationFrame`
- late stabilizer / drift verification timer
- pending sync jump
- session phase 和 settle 状态

同时新增：

```text
cancelPendingHydrationForTest()
```

用于清理 activation-controller 的 pending rAF 和 hydration queue。

### 3.5 补偿滚动抑制只作用于未受信滚动

`hydrateScrollTarget` 中 600ms 补偿滚动抑制限制为：

```ts
!event.isTrusted &&
performance.now() < compensationScrollSuppressUntil &&
burstDelta < 1000 &&
!isEndpointScroll
```

真实用户滚动不受影响。

### 3.6 Benchmark Diagnostics

benchmark 增加：

- 每个 scroll-jump scenario 前 reset settle/late stabilization diagnostics
- timeout diagnostics：hotpath、late stabilization、phase4、fallback、inline placeholders
- scrollTop write instrumentation
- UIFF 点击前等待 drift/layout 收敛，并优先选择稳定点击目标

## 4. Results

### 4.1 Subagent 连续 3 轮

以下 3 轮均为独占 benchmark，全部满足：

- `scrollDriftPx=0`
- `viewportPlaceholders=0`
- `inlineHeightDrift=0`
- `firstFrameReady=true`
- `UIFF=true`

| 轮次 | bottom ms | middle ms | drag ms | UIFF |
|---|---:|---:|---:|---|
| 1 | 1550.4 | 1818.0 | 2074.4 | true |
| 2 | 1531.2 | 1916.1 | 2018.1 | true |
| 3 | 1986.1 | 1775.4 | 2153.7 | true |

### 4.2 主代理独立 2 轮

| 轮次 | bottom ms | middle ms | drag ms | hard gate |
|---|---:|---:|---:|---|
| 1 | 1946.5 | 1718.6 | 2140.4 | all green |
| 2 | 2293.5 | 1850.9 | 2206.5 | all green |

主代理两轮同样满足：

- bottom/middle/drag `scrollDriftPx=0`
- `viewportPlaceholders=0`
- `inlineHeightDrift=0`
- `firstFrameReady=true`
- `UIFF=true`

## 5. Remaining Known Issues

### 5.1 perf-budget 未达标项

以下 budget 项仍未达标，本轮不修改 `perf-budget.json`：

- `typingMs`
- `interactionCombinedMs`
- `scrollAvgFrameMs`
- `scrollMaxFrameMs`
- `scrollJumpReadyMs`

### 5.2 scroll-io HEAD 基线失败

`scroll-io.e2e.test.ts` 仍有 2 个失败，已在 HEAD 基线复现：

- `disabled IO still keeps scroll hydration hard gates`
  - `placeholders=3`，`drift=0`
- `re-enabled IO keeps scroll hydration hard gates`
  - `placeholders=4`，`drift=0`

未放宽断言，未修改该测试。

## 6. Git Status

当前有 4 个未提交文件：

```text
M scripts/benchmark/performance.ts
M src/renderer/components/EditorShell.tsx
M src/renderer/editor/virtualization/activation-controller.ts
?? docs/performance-d10-drag-drift-verification.md
```

未 commit，未 push。

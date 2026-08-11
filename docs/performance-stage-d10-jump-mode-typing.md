# D10 跳转 ready 与模式切换定向优化实现记录

分支：`perf/performance-optimization`
任务：v3 Default Track D10“跳转 ready 与模式切换定向优化”。

## 目标

1. 大跳转/端点的 jump-ready 不再被非视口 prefetch drain、精确 PM 坐标映射或
   benchmark settle 等待掩盖。
2. source->visual 在保持 UIFF/BFR、无 overlay、无 marker、无重 parse 的前提下
   减少首帧前的同步工作。
3. 区分 typing 产品延迟与 benchmark 的 focus/rAF 测量开销。

未运行 `barfoot_ser24.md` 大文件 benchmark；等待主代理独占复测。

## 实现

### activation-controller.ts

- `hydrateTargetRange` 的 `drainQueue` 现在只 drain 到视口激活半径，不再把
  ±prefetch 半径内的所有队列任务一次性激活。
- 非 drain 路径保持原有分批行为，避免破坏 hydration-queue e2e/unit 的进度语义。
- `__marivellPhase4HydrateTimings` 增加 `queueSizeBefore`、`queueSizeAfter`、
  `drainedTasks`、`drainRadius`，用于确认大跳转只消费视口内任务。

### EditorShell.tsx

#### 大跳转 hydration

- 大 burst/端点继续取消 300ms settle，在 rAF 中执行 `settle + drain`。
- 大跳转和累计 delta >=1000px 的 hydration 使用 cheap ratio center，不再调用
  `posAtCoords` 做精确中心映射。
- benchmark top-anchor 仍参与锚点补偿；timings 增加 `centerSource=cheap|precise`。

#### source->visual

- unchanged fast path 复用 `modeSwitchCacheRef`、`visualStatsRef` 和
  `modeSwitchOutlineRef`，跳过 source->visual 的 `buildModeSwitchCache`、
  `computeSourceStats`、`extractOutline` 同步重算。
- 未移动 source caret 且存在 mode-switch ratio 时，layout effect 不再先执行
  `coordsAtPos` 检查，直接由 ratio restore 决定首帧位置。
- 最终保留精确 `posAtCoords` 首帧 hydration。定向实验中曾将模式切换 hydration
  改成 cheap ratio，但会让 source input 卸载后的 scroll reflow 事件落到
  `scroll-endpoints` 的 500ms 稳定窗口之后；因此该实验未保留。

### scripts/benchmark/performance.ts

- `interaction-typing` 主指标保持原有完整路径：`selectFirstTextBlock`、
  `focus()`、`insertContent('PERF_TYPING')` 和双 rAF 都在同一计时内。
- 新增 `interaction-typing-dispatch-ms`、`interaction-typing-raf-overhead-ms`
  和 typing detail JSON 作为附加诊断字段，不替代主指标语义。
- jump 场景新增 `placeholder-ready-ms` 与 `settle-overhead-ms`，把“可见
  placeholder 归零”和“额外 settle/rAF 等待”分开报告。

## 小文件 benchmark 数据

文件：`/tmp/marivell-d7-small.md`（112,639 source bytes，800 个唯一公式）。

| 指标 | 结果 |
| --- | ---: |
| interaction-typing | 55.6 ms |
| interaction-typing-dispatch-ms | 19.8 ms |
| interaction-typing-raf-overhead-ms | 34.4 ms |
| mode-switch-visual-to-source-ms | 265.5 ms |
| mode-switch-source-to-visual-ms | 209.0 ms |
| scroll-jump-bottom | 359.9 ms |
| scroll-jump-bottom-placeholder-ready-ms | 127.7 ms |
| scroll-jump-middle | 461.4 ms |
| scroll-jump-middle-placeholder-ready-ms | 188.7 ms |
| scroll-drag-sequence | 472.7 ms |
| scroll-drag-sequence-placeholder-ready-ms | 237.5 ms |
| scrollDriftPx | 0 |
| viewportPlaceholders | 0 |
| inline-math-activate-ready-ms | 7.2 ms |
| uiff-passed | true |
| bfr-worker-queue-empty | true |

结论：小文件 jump 的可见 placeholder 归零约 128-238ms，主 `jump-ready-ms`
额外包含约 232-273ms 的 3 轮 settle 双 rAF；产品 hydration 工作本身不再被
非视口队列 drain 放大。typing 主指标的 55.6ms 中约 19.8ms 是
focus+insertContent dispatch，约 34.4ms 是双 rAF 等待；selection 仍计入主指标。

## 验证

已通过：

- `npm test`
- `npx tsc --noEmit`
- `git diff --check`
- `scripts/tests/inline-math-scroll.e2e.test.ts`：33 passed
- `scripts/tests/scroll-endpoints.e2e.test.ts`：19 passed
- `scripts/tests/mode-switch-large.e2e.test.ts`：9 passed
- `scripts/tests/first-frame-contract.e2e.test.ts`：8 passed
- `scripts/tests/deferred-work-preemption.e2e.test.ts`：7 passed
- `scripts/tests/caret-alignment.e2e.test.ts`：252 passed

## 状态

READY_FOR_LARGE_BENCHMARK

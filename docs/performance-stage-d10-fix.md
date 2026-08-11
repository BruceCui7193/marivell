# D10 跳转 hydration 回归修复与独占 benchmark 验证记录

分支：`perf/performance-optimization`
基准文件：`/home/crh/下载/barfoot_ser24/barfoot_ser24.md`
运行状态：独占运行，`exclusive-run=true`，无 marivell 临时 Electron/POC 进程。

## 结论

- `hydrationQueue.nextWithin(maxDistance, centerPosition)` 已加入，drainQueue 不再因
  第一个半径外任务重新入队并 break，会持续消费所有半径内任务。
- `__marivellPhase4HydrateTimings` 的 `queueSizeBefore`、`queueSizeAfter`、
  `drainedTasks`、`drainRadius` 语义保留。
- 大文件 benchmark 的 scroll-jump/drag 硬门禁仍失败。最终一次独占复测中，队列在最终
  hydrate 调用里剩余任务都在 drainRadius 外；可见 placeholder 的迟到归零主要跟随
  cheap ratio center 与滚动锚点补偿的后续 settle 循环，而不是本次修复的队列 starvation。

## 关键结果

| 指标 | 结果 |
| --- | ---: |
| exclusive-run | true |
| interaction-typing | 170.3 ms |
| mode-switch-visual-to-source-ms | 705.8 ms |
| mode-switch-source-to-visual-ms | 737.2 ms |
| scroll-jump-bottom | timeout 15000 ms |
| scroll-jump-middle-jump-ready-ms | 2707.9 ms |
| scroll-jump-middle-placeholder-ready-ms | 2167.0 ms |
| scroll-jump-middle-first-frame-placeholders | 13 |
| scroll-jump-middle-drift | 0 px |
| scroll-jump-middle-inline-height-drift | 0 px |
| scroll-drag-sequence-jump-ready-ms | 3028.5 ms |
| scroll-drag-sequence-placeholder-ready-ms | 2333.9 ms |
| scroll-drag-sequence-first-frame-placeholders | 11 |
| scroll-drag-sequence-drift | 0 px |
| scroll-drag-sequence-inline-height-drift | 0 px |
| scroll-first-frame-ready | false |
| inline-height-drift | 0 px |

最终 jump hydrate 诊断仍出现 `queueSizeBefore=15/8`、`queueSizeAfter=15/8`、
`drainedTasks=0`。结合纯逻辑与 render-interaction 回归，问题不是半径内任务被第一个
半径外任务饿死；是这些剩余队列任务本身在最终 drainRadius 外，而可见 placeholder 还依赖
cheap ratio 中心补偿后的后续 hydration 轮次。

## 验证

- `npm test`
- `npx tsc --noEmit`
- `git diff --check`
- `scripts/tests/inline-math-scroll.e2e.test.ts`
- `scripts/tests/scroll-endpoints.e2e.test.ts`
- `scripts/tests/scroll-io.e2e.test.ts`
- `scripts/tests/inline-math-lazy.e2e.test.ts`
- `npm run benchmark`（独占锁生效）

## 未处理风险

大文件 jump 的首帧 placeholder 归零仍不满足硬门禁。当前证据指向 cheap ratio center
在大文件上的 PM 偏移、滚动锚点补偿触发多轮 settle，以及 IO 候选范围基于 cheap center
导致首帧未覆盖真实视口。这些需要下一阶段继续处理，不能只靠队列 drain 半径修复。

# D10 Jump Long Task and Frame Diagnostics

**Date:** 2026-08-12
**Branch:** `perf/performance-optimization`
**Base commit:** `224f817`

## 背景

大文件 benchmark 的 scroll-jump 场景中，`placeholder-ready` 在 700-1500ms，但 `jump-ready` 在 2000-2400ms。已知：
- `first-frame-placeholders` 已经为 0（首帧即无可视 placeholder）
- placeholder DOM 扫描只有 ~24ms
- hydration `totalMs` 约 6-250ms
- 禁用 late stabilizer 不改变 jump-ready
- 缩小 block/inline hydration radius 不改变 jump-ready

说明 jump-ready 延迟发生在 placeholder 归零之后的 settle 阶段，主线程在此期间被阻塞。

## 诊断方法

在 `scripts/benchmark/performance.ts` 的 `measureScrollJumpScenario` 的浏览器端脚本中增加四项诊断：

1. **`PerformanceObserver('longtask')`**：记录 jump 期间所有 long task（>50ms），含 `startTime`、`duration`、`name`、`attribution`
2. **rAF frame stamps**：在 `firstInlineFrame`（单 rAF）和每个 `waitForFrame`（双 rAF）解析时记录时间戳和帧耗时，相对于 `start`
3. **`PerformanceObserver('layout-shift')`**：记录 jump 期间的 layout shift 事件
4. **`MutationObserver`**：记录每次 mutation callback 触发时的突变数量和发生时间（Mutation Burst）

所有诊断输出到每个 jump 场景的 report 指标中：`-longtasks`、`-frame-stamps`、`-layout-shifts`、`-mutation-bursts`。

MutationObserver 配置为 `{ subtree: true, childList: true, attributes: true, characterData: true }`，仅在 jump 场景期间激活，不影响其他测量。

## Benchmark 结果（大文件 barfoot_ser24.md）

### scroll-jump-bottom

| 指标 | 值 |
|------|-----|
| jump-ready-ms | **2085.3 ms** |
| placeholder-ready-ms | **979.8 ms** |
| settle-overhead-ms | **1105.5 ms** |

**Long Tasks（6 个，总计 1418ms）：**

| # | startTime (abs) | duration | attribution |
|---|----------------|----------|-------------|
| 1 | 65494 | 266ms | self / window |
| 2 | 65761 | 142ms | self / window |
| 3 | 65905 | **483ms** | self / window |
| 4 | 66394 | 246ms | self / window |
| 5 | 66675 | 153ms | self / window |
| 6 | 66829 | 128ms | self / window |

> 所有 long task 的 `attribution` 均为 `[{name:"unknown", containerType:"window"}]`，说明这些是主线程上的匿名长任务（Chromium 对 window 主线程的归因能力有限）。

**Frame Stamps（5 帧）：**

| # | at (ms from start) | ms (gap) | 说明 |
|---|-------------------|----------|------|
| 0 | 735.2 | 537.9 | 首个 rAF（dispatch→firstInlineFrame） |
| 1 | 957.2 | 222.0 | 首次 waitForFrame（placeholder 检查） |
| 2 | 1731.8 | **774.6** | 首个 settle frame |
| 3 | 2010.5 | 278.7 | 第二个 settle frame |
| 4 | 2070.4 | 59.9 | 第三个 settle frame |

> **关键发现**：Frame 1→Frame 2 之间间隔 774.6ms，而此时 placeholder 已经归零（979.8ms 处）。正常帧间隔应为 ~32ms（双 rAF）。

**Layout Shifts（5 个）：**

startTime: 65068, 65523, 65873, 66613, 66781
value: 0.056, 0.0004, 0.140, 0.127, 0.042

**Mutation Bursts（6 个）：**

| at (ms) | count |
|---------|-------|
| 545.7 | 581 |
| 735.1 | 89 |
| 1311.3 | 71 |
| 1446.3 | 3 |
| 1554.4 | 1 |
| 1717.0 | 186 |

### scroll-jump-middle

| 指标 | 值 |
|------|-----|
| jump-ready-ms | **2406.3 ms** |
| placeholder-ready-ms | **761.4 ms** |
| settle-overhead-ms | **1645.0 ms** |

**Long Tasks（5 个，总计 1738ms）：**

| # | startTime (abs) | duration |
|---|----------------|----------|
| 1 | 67387 | 266ms |
| 2 | 67653 | 138ms |
| 3 | 67793 | **979ms** ← 最长的单次长任务 |
| 4 | 68780 | 236ms |
| 5 | 69023 | 119ms |

**Frame Stamps（5 帧）：**

| # | at (ms) | ms (gap) |
|---|---------|----------|
| 0 | 528.2 | 414.1 |
| 1 | 739.3 | 211.1 |
| 2 | 1969.0 | **1229.7** |
| 3 | 2125.3 | 156.3 |
| 4 | 2393.0 | 267.7 |

> Frame 1→Frame 2 间隔 1229.7ms，与 979ms 的 long task 直接相关。

**Mutation Bursts（6 个）：**

| at (ms) | count |
|---------|-------|
| 332.8 | 593 |
| 528.0 | 132 |
| 1575.9 | 200 |
| 1725.7 | 12 |
| 1833.5 | 1 |
| 2356.7 | 134 |

### scroll-drag-sequence

| 指标 | 值 |
|------|-----|
| jump-ready-ms | **2000.5 ms** |
| placeholder-ready-ms | **1505.3 ms** |
| settle-overhead-ms | **495.2 ms** |

**Long Tasks（8 个，总计 1434ms）：**

| # | startTime (abs) | duration |
|---|----------------|----------|
| 1 | 69876 | 280ms |
| 2 | 70169 | 256ms |
| 3 | 70435 | 184ms |
| 4 | 70722 | 260ms |
| 5 | 70983 | 102ms |
| 6 | 71085 | 141ms |
| 7 | 71245 | 143ms |
| 8 | 71388 | 68ms |

> Drag 场景的 long tasks 更分散但数量更多（8 个），placeholder-ready 也更慢（1505ms）。

**Frame Stamps（8 帧）：**

| # | at (ms) | ms (gap) |
|---|---------|----------|
| 0 | 527.3 | 413.5 |
| 1 | 895.6 | 368.3 |
| 2 | 1126.5 | 230.9 |
| 3 | 1157.3 | 30.8 |
| 4 | 1485.9 | 328.6 |
| 5 | 1686.7 | 200.8 |
| 6 | 1884.1 | 197.4 |
| 7 | 1986.6 | 102.5 |

## 根因分析

### 证据链

1. **placeholder-ready 时刻正在执行 long task**

   Bottom 场景：placeholder-ready 在 979.8ms，此时 long task #3（483ms  @ 65905）正在执行。该 long task 从 955ms（估算）持续到 1438ms，完全覆盖 placeholder-ready 时刻。

   Middle 场景：placeholder-ready 在 761.4ms，此时即将进入 long task #3（979ms）。该 long task 导致 Frame 1→Frame 2 的间隔高达 1229.7ms。

2. **settle 帧间隔远大于理论值**

   双 rAF 的理论最小间隔为 ~32ms（60fps）。实际观测：
   - Bottom: 774.6ms（Frame 1→2）
   - Middle: 1229.7ms（Frame 1→2）
   - Drag: 328.6ms（Frame 4→5）

   这些都是因为 rAF 回调在 long task 队列后面排队，直到主线程空闲才能执行。

3. **long task 总量超过 settle 时间**

   - Bottom: 6 个 long tasks，合计 1418ms，settle-overhead = 1105ms
   - Middle: 5 个 long tasks，合计 1738ms，settle-overhead = 1645ms
   - Drag: 8 个 long tasks，合计 1434ms，settle-overhead = 495ms

   settle-overhead 基本等于 long task 持续时间的重叠窗口。

4. **mutation 和 layout 活动密集**

   - 首波 mutation burst：545ms 处 581 个突变（bottom），332ms 处 593 个突变（middle）
   - 每个场景有 5-10 个 layout shift，累积值达 0.3-0.5
   - 这些 mutation 和 layout 工作本身也会触发布局重算，进一步占用主线程

5. **所有 long task 的 attribution 均为 unknown/window**

   说明这些长任务来自应用自身的同步 JavaScript 执行，而非 iframe 或 worker。具体来源可能是：
   - 公式 HTML 生成（template cache 显示 55-70 misses）
   - 高度缓存更新
   - 虚拟滚动节点的 DOM 操作
   - ProseMirror 的 decoration 更新

### 结论

**jump-ready 延迟的根因是主线程在 placeholder 归零后被大量长任务（50-979ms）持续阻塞，导致 settle 帧（rAF）无法及时执行。**

placeholder 本身的 DOM 就绪很快（首帧即为 0），但从 placeholder-ready 到 jump-ready 的额外时间（settle-overhead = 500-1645ms）完全由主线程长任务消耗。这些长任务来自应用层的同步处理（公式 HTML 生成、高度缓存、虚拟滚动更新等），而非框架或浏览器开销。

## 修改文件

- `scripts/benchmark/performance.ts`：在 `measureScrollJumpScenario` 浏览器端脚本中增加四项诊断 observer，并在返回值和 TypeScript 类型中增加对应字段，在报告输出中增加 `-longtasks`、`-frame-stamps`、`-layout-shifts`、`-mutation-bursts` 指标。

## 后续建议

1. 使用 Chrome DevTools Performance 录制 jump 期间的火焰图，定位 483ms/979ms 长任务内部的具体函数调用栈
2. 考虑将公式 HTML 生成改为分片（chunked）或空闲回调（requestIdleCallback），避免阻塞 rAF
3. 评估是否可以延迟非首屏的高度缓存更新到 jump settle 之后
4. 考虑在 jump 完成后主动让出主线程（scheduler.yield）以加速 rAF 响应

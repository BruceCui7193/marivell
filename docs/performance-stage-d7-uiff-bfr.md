# D7 UIFF/BFR 首帧契约 + 模式切换默认优化实现记录

分支：`perf/performance-optimization`
任务：v3 Default Track D7“UIFF/BFR 首帧契约 + 模式切换默认优化”。

## 目标

1. 定义并实现 UIFF 六探针。
2. 定义并实现 BFR 后台完整就绪清单与 `open+10s` 期限。
3. overlay 不参与模式切换就绪关键路径，不允许用遮罩掩盖未就绪内容。
4. 模式切换两向在 Stage 3d 基础上压到优秀目标 `<=700ms`。

## UIFF 六探针

探针同时进入 `scripts/benchmark/performance.ts` 和
`scripts/tests/first-frame-contract.e2e.test.ts`：

| 探针 | 契约 | 实现 |
| --- | --- | --- |
| 光标可落 | 点击视口文本后 selection 存在，偏差 `<=4px` | 通过文本节点 Range 找真实可见字符，真实 mouse click 后回读 `posAtCoords` / `coordsAtPos` |
| 输入回显 | CDP `Input.insertText("x")` `<=100ms` | Playwright CDP session 发送 `Input.insertText`，轮询 PM doc size +1 |
| 视口真实 | 0 placeholder，可见公式全部为真实 `.katex` | 统计视口相交 `.math-inline-node/.math-block-node`、`.katex`、placeholder |
| 滚动稳定 | 连续 10 rAF `scrollTop` 不变，`layout-shift=0` | 程序化滚动到中部，settle 后采样 10 帧并统计 `layout-shift` |
| 无遮罩 | `elementFromPoint` 命中编辑器内容，overlay 从 DOM 移除 | 查询 `.editor-loading` / `.editor-loading--mode-switch`，中心 hit-test 必须命中 `.editor-surface` 或 source textarea |
| 坐标可用 | `posAtCoords` 视口 5 点采样非 null | 对 frame 内 5 个坐标点调用 PM `view.posAtCoords` |

## BFR 清单与期限

新增 `scripts/tests/deferred-work-preemption.e2e.test.ts`，使用
`>200KB` 生成文档触发真实 Worker 公式预渲染队列，验证：

- 高度缓存覆盖全部唯一公式（`>=uniqueCount`）。
- `pendingHeightMeasurements == 0`，placeholder 的视口就绪契约不变。
- 视口外 syntax decoration 无积压：`offscreenSyntaxDecorationCount == 0`，
  Default Track 继续维持视口/selection 局部装饰契约。
- Worker 队列清空：`formulaChunkQueueLength==0`、
  `formulaChunkInFlightCount==0`、`pendingFormulaHtmlChunks==0`。
- 搜索、大纲、stats 可用。
- BFR 在 `document-open-main-start + 10s` 内完成。
- BFR 后 idle 5s 零 long task。
- 用户手势抢占后台：键入后后台公式处理记录 `preemptionSkips` 增长。

EditorShell 新增 benchmark-only `__marivellGetDeferredWorkDiagnostics`，
暴露队列深度、in-flight、pending chunks、scheduled 状态、preemption 计数。

## overlay 移除

- `SourceEditor` 移除 `source-editor--pending` 隐藏遮罩，source 模式挂载后
  不再依赖下一 rAF 移除遮罩才可交互。
- 模式切换不再使用 `editor-loading--mode-switch` DOM；现有就绪路径只保留
  外部文档加载期的 `.editor-loading`，UIFF 判定时该节点必须为 0。
- `toggleSourceModeWithTransition` 不再包一层 rAF 或记录 `overlay-delay`；
  直接执行模式切换并记录 `mode-switch-dispatch`。

## 模式切换优化

- source→visual 的 stats/dirty/outline/`onDocumentChange` 副作用延后到
  `setTimeout(0)`，refs 与 mode-switch cache 仍同步更新，首帧不再等
  outline/stats 同步重算。
- 移除模式切换过渡 rAF。
- 保留 Stage 3d 的 `display:none` visual host 策略，不做离屏 transform。

## 小文件 benchmark 数据

文件：`/tmp/marivell-d7-small.md`（112,639 source bytes，800 个唯一公式）。

| 指标 | 结果 |
| --- | ---: |
| mode-switch-visual-to-source-ms | 109.5 ms |
| mode-switch-source-to-visual-ms | 190.9 ms |
| uiff-click-selection-deviation-px | 0 px |
| uiff-cdp-insert-x-ms | 36.2 ms |
| uiff-viewport-real | true |
| uiff-scroll-stable | true |
| uiff-no-overlay | true |
| uiff-coords-available | true |
| uiff-passed | true |

小文件 BFR 的 Worker 队列已清空；该文件低于 Worker 大文件阈值，因此
`height-cache-coverage` 不代表大文件全量预取路径。大文件 Worker 队列、
高度缓存 100% 与 idle 5s 门禁由
`deferred-work-preemption.e2e.test.ts` 的真实 `>200KB` 文档验证。

## 小文件验证

已通过：

- `npm test`
- `npx tsc --noEmit`
- `git diff --check`
- `scripts/tests/first-frame-contract.e2e.test.ts`：8 passed, 0 failed
- `scripts/tests/deferred-work-preemption.e2e.test.ts`：7 passed, 0 failed
- `scripts/tests/mode-switch-large.e2e.test.ts`：9 passed, 0 failed
- `scripts/tests/caret-alignment.e2e.test.ts`：252 passed, 0 failed
- `scripts/tests/scroll-endpoints.e2e.test.ts`：19 passed, 0 failed
- `scripts/tests/export-hydrate.e2e.test.ts`：14 passed, 0 failed

未运行 `barfoot_ser24.md` 大文件 benchmark；按任务约束等待主代理独占复测。

## 状态

READY_FOR_LARGE_BENCHMARK

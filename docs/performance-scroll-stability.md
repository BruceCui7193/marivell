# 滚动端点与释放后稳定性修复（2026-08-11）

## 1. 修复前失败证据

在 HEAD `bbe6d8e` 上新增 `scripts/tests/scroll-endpoints.e2e.test.ts` 后，
新增测试稳定暴露两类问题：

- 底部端点错误：
  `scrollTop` 已等于 `maxScrollTop`，但视口第一行文本为空、文档末尾标记不可见。
  稳定采样期间 `scrollTop` 仍在变化，`postStableTopChanges=8`，
  `postStableEvents=2`。
- 释放后继续滚动：
  设置 `scrollTop` 并完成首帧后，500ms 采样窗口内仍有新的 `scroll` 事件，
  事件约发生在释放后 110ms。

## 2. 根因

1. `EditorShell` 的 scroll spacer 在 hydration 过程中创建后没有在用户释放滚动前释放。
   旧 spacer 残留在文档末尾，会推高 `scrollHeight`；滚到底部时视口显示的是 spacer
   而不是真实文档末尾。
2. `compensateTopAnchor` 在 hydration 后继续调度 rAF 和 120ms `setTimeout`，
   `followBottomIfAtBottom` 也调度 4 个后续 rAF。这些延迟任务会在用户释放滚动后
   重写 `scrollTop` 并派发新的 scroll 事件。
3. 滚动时暂停的公式高度测量在 120ms 后恢复。大文档里大量占位高度随后被修正，
   浏览器因 `scrollHeight` 变化自动调整 `scrollTop`，造成释放后继续滚动。

## 3. 修复逻辑

- 大跳转/端点滚动仍只调度一个 hydration rAF，但 hydration 内部不再安排后续
  anchor rAF、120ms timeout 或 bottom-follow rAF。
- `hydrateTargetRange` 增加 `drainQueue` 选项，端点/大跳转 hydration 在同一次
  rAF 内排空 hydration queue，避免后续 rAF 继续激活虚拟节点并改变高度。
- 顶部和底部端点同步移除 spacer 和 surface margin，顶部固定 `scrollTop=0`，
  底部固定为当前真实 `maxScrollTop`。
- 中部滚动保持用户 `scrollTop` 不变，仅在 hydration 帧内同步应用 surface
  margin 补偿，避免改变 `scrollTop` 的同时维持视口锚点。
- 滚动事件后不再定时恢复高度测量；高度测量保持暂停，直到下一次明确解除暂停
  （例如模式切换或组件卸载），防止释放后占位高度修正改变布局。

## 4. 新增测试

`scripts/tests/scroll-endpoints.e2e.test.ts` 使用真实 Electron/CDP 启动，覆盖：

- 顶部 -> 中部 -> 顶部：`scrollTop === 0`、文档开头标记可见、连续 rAF 无变化。
- 滚到底部：`scrollTop` 等于当前最大 `scrollTop`、文档末尾标记可见、
  连续 rAF 无变化。
- 设置 `scrollTop` 后释放：连续 500ms/约 30 个 rAF 内 `scrollTop` 不变，
  不产生新 scroll 事件。
- 源码模式与预览模式互相切换：切换完成后连续 500ms 内编辑区无新 scroll 事件、
  `scrollTop` 稳定，并且 source/visual 各自恢复到目标位置。

内联公式测试已强化为“真实 KaTeX 渲染”验收：

- `inline-math-scroll.e2e.test.ts` 对每个可见 inline math 节点断言存在
  `.math-node-preview .katex`，且没有 `.katex-error` 或 placeholder hint。
- `inline-math-lazy.e2e.test.ts` 对初始视口和快速滚动后的视口断言
  `visibleRealKatex === visibleInlineCount`、`visibleNotRealKatex === 0`。

## 5. Benchmark 关键数字

官方大文件一轮：

| 指标 | 值 |
| --- | ---: |
| scrollDriftPx | 0 |
| viewportPlaceholders | 0 |
| inlineMathActivateReadyMs | 6.1 ms |
| inline-math-viewport-katex-ready-ms | 901.4 ms |
| inline-math-viewport-katex-max-frame-ms | 0 ms |
| inline-math-viewport-katex-count | 6 nodes |
| scroll-jump-bottom | 790.4 ms |
| scroll-jump-middle | 1148.9 ms |
| scroll-drag-sequence | 1364.0 ms |

hard gate `scrollDriftPx=0`、`viewportPlaceholders=0`、
`inlineMathActivateReadyMs=6.4 <= 50` 均通过；未修改 `perf-budget.json`。

## 6. 内联公式激活指标定义

既有 `inline-math-activate-ready-ms` / `inline-math-activate-max-frame-ms`
保持原语义：它们测量 hydration/placeholder 准备路径，不等价于“视口内所有公式
都已经是真实 KaTeX”。

新增三个诊断指标，定义如下：

- `inline-math-viewport-katex-ready-ms`：从滚动后首次观察到某个可见 inline math
  节点不是真实 KaTeX（无 `.katex`，或存在 `.katex-error`/placeholder hint），
  到视口内所有可见 inline math 节点都包含真实 `.math-node-preview .katex`
  且无 error/hint 的墙钟时间。
- `inline-math-viewport-katex-max-frame-ms`：等待视口真实 KaTeX 期间，单个
  double-rAF 采样间隔的最大墙钟时间。
- `inline-math-viewport-katex-count`：采样期间视口内可见 inline math 节点数。

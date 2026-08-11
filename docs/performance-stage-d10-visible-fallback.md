# D10 visible viewport fallback

分支：`perf/performance-optimization`
基准文件：`/home/crh/下载/barfoot_ser24/barfoot_ser24.md`

## 根因

大文件的大 jump 使用 cheap ratio center 估算 PM pos。文件高度分布不均匀时，
ratio center 与真实视口中心偏差较大，导致 `hydrateTargetRange`、
`hydrateInlineMathGroupsAroundPosition` 以及 IO 候选范围都基于错误中心，
真实视口内的 virtual node / inline math group 没有在第一个可见帧被激活。

已有 `forceActivateViewport` 和 `activateInlineMathGroupsInViewport` 可以做真实
DOM rect 扫描，但之前只用于 resize / mode-switch，没有接到大 jump fallback。
`runSettleFallbackScan` 仍然使用 cheap center，无法兜底真实视口。

## 实现位置与触发条件

- `src/renderer/components/EditorShell.tsx`
  - 新增 `hydrateVisibleViewportFallback(frame, options)`。
  - 先执行 `forceActivateViewport(frame, 800)`，再执行
    `activateInlineMathGroupsInViewport(frame, 1600)`，不传 position center，
    走真实 DOM 视口扫描。
  - 只在 `runScrollHydration` 的 `largeJump === true` 路径执行；普通滚动帧和
    普通 scrollend settle 不执行。
  - `deferInlineMathHydrationForNextScroll` 为 true 时跳过 inline fallback，
    保留既有 raw-fallback e2e 语义。
  - fallback 写在现有 anchor capture/restore 保护范围内；virtual 和 inline
    fallback 都跳过各自内层 scroll anchor restore，避免与外层补偿重复捕获。
  - 设置 `__marivellVisibleFallbackTimings`，并加入
    `__marivellPhase4Timings.visibleFallbackTimings`。

- `src/renderer/editor/virtualization/activation-controller.ts`
  - `forceActivateViewport` 增加可选 scan stats 和 `skipAnchorRestore`。
  - stats 记录 `scanned / visible / activated`。

- `src/renderer/editor/virtualization/inline-math-group-registry.ts`
  - `activateInlineMathGroupsInViewport` 增加可选 scan stats、
    `allowLayoutRetry` 和 `skipAnchorRestore`。
  - fallback 禁用 layout retry，避免首帧被 rAF 重试推迟。

- `scripts/benchmark/performance.ts`
  - 增加 `scroll-*-visible-fallback` 诊断，不改主指标语义。

## 新增回归

`scripts/tests/render-interaction.test.ts` 新增：

- 构造 `.editor-frame` 和 fake IntersectionObserver。
- 注册 viewport 内/外 virtual nodes。
- 构造两个 inline math paragraph，设置真实 rect。
- 先用错误 center 调用 position-based hydration，确认没有激活。
- 调用 `hydrateVisibleViewportFallback`，断言 viewport 内 virtual node 和
  inline group 激活、viewport 外未激活、扫描/激活计数与诊断字段正确。

## benchmark 前后对比

大文件最终独占复测：

| 指标 | 之前 | 现在 |
| --- | ---: | ---: |
| scroll-jump-bottom | timeout 15000ms | 1169.3ms |
| scroll-jump-middle jump-ready | 2707.9ms | 2296.9ms |
| scroll-drag-sequence jump-ready | 3028.5ms | 1665.6ms |
| first-frame placeholders | 13 / 11 | 0 / 0 / 0 |
| first-frame-ready | false | true |
| scroll drift | 0 | 0 |
| inline-height drift | 0 / 0 | bottom 141 / middle 0 / drag 0 |
| inline-math-activate-ready | n/a | 2.7ms |
| uiff-passed | n/a | true |

fallback 诊断（一次代表运行）：

- bottom: `fallbackMs=10.3ms`，`scannedVirtualNodes=2496`，
  `activatedVirtualNodes=10`，`scannedInlineGroups=2002`，
  `activatedInlineGroups=1`
- middle: `fallbackMs=7.5ms`，`activatedVirtualNodes=5`，
  `activatedInlineGroups=4`
- drag: `fallbackMs=8.9ms`，`activatedVirtualNodes=9`，
  `activatedInlineGroups=2`

## 验证

- `npm test`
- `npx tsc --noEmit`
- `git diff --check`
- `scripts/tests/inline-math-scroll.e2e.test.ts`
- `scripts/tests/scroll-endpoints.e2e.test.ts`
- `scripts/tests/scroll-io.e2e.test.ts`
- `scripts/tests/inline-math-lazy.e2e.test.ts`
- `scripts/tests/first-frame-contract.e2e.test.ts`
- `scripts/tests/caret-alignment.e2e.test.ts`
- `npm run benchmark`（exclusive-run=true）

## 剩余风险

- `scroll-jump-*-jump-ready-ms` 仍远高于 perf-budget 的 200ms；当前数字主要是
  placeholder 归零后的 rAF/settle 等待，不是 fallback 本身（fallback 通常约
  7-11ms）。
- bottom 的 inline-height-drift 仍约 141px。fallback 已让首帧 placeholder 归零，
  但 bottom 附近 anchor 在真实 hydration 后仍会移动；首帧 `coordsAtPos` 返回
  null，补偿需要后续帧补齐，最终 benchmark 仍观察到残余漂移。
- `scrollAvgFrameMs` / `scrollMaxFrameMs` 仍超过预算；本改动没有把这些全量扫描
  接到普通滚动帧，但大文件本身滚动帧仍偏高。
- fallback 在大文件上会扫描 2496 个 virtual registrations 和约 2000 个 inline
  groups；当前单次约 7-11ms，仍需监控极慢设备。

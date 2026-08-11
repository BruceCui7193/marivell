# D3 滚动零变更帧实现记录

分支：`perf/performance-optimization`
任务：v3 Default Track D3“滚动零变更帧”。

## 目标

普通滚动帧不再执行 DOM/style 变更、rect 读取或 `posAtCoords`；
大跳转/端点保留“松手第一帧 0 placeholder / 0 drift”硬门禁；
settle 后保留同步扫描兜底。

## 实现

### MathSyntaxHighlight

- `scroll` 处理器只记录 `scrollTop` 和滚动事件计数，不再直接刷新 viewport。
- 小步滚动只调度 300ms settle 合并；大 delta/端点仍可走立即 rAF。
- `scrollend` 会取消尚未执行的 rAF，并重新调度 settle 合并，避免释放后
  延迟刷新造成额外滚动事件。
- 初始视口和文档变更后仍通过 rAF 补齐 viewport decoration。

### EditorShell

- 滚动事件处理器移除 `scrollHeight/clientHeight` 读取，只记录 `scrollTop`、
  暂停高度测量并调度后续工作。
- 大 delta/端点保留立即 hydration rAF；普通小步滚动延后到
  300ms settle/scrollend 合并。
- `scrollend` 大 burst 分支同步执行 `settle + drain` 并运行 settle 扫描，
  保证松手首帧 placeholder/drift 门禁；普通小步只在 300ms settle 后扫描。
- 锚点恢复的 `scrollTop` 写入改为仅在值变化时执行，避免无变化 setter
  派发多余 scroll 事件。
- settle 扫描使用与常规 hydration 相同的候选范围，避免 `includeAll`
  过度激活块级节点造成锚点 drift。

### Raw to KaTeX fallback 覆盖

恢复 `inline-math-scroll.e2e.test.ts` 的 middle 原断言：
必须观察到 raw placeholder 并走 raw fallback。
另新增独立 `raw-fallback-middle` 场景，使用 benchmark-only
`__marivellSetDeferInlineMathHydrationForNextScroll` 与
`__marivellDeactivateAllInlineMathGroups` 显式构造冷路径，
继续断言 raw placeholder 存在且替换时间 `<=50ms`。

### CSS

`editor.css` 为视觉模式 `.editor-host` 增加独立合成层：

```css
.editor-frame:not(.is-source) .editor-host {
  transform: translateZ(0);
  will-change: transform;
  contain: layout style;
}
```

保留 PM 原生 DOM 和 `contentDOM`，不使用 `content-visibility`/`contain: paint`。

### Benchmark 诊断

`scripts/benchmark/performance.ts` 的 `measureVisualScroll` 增加逐帧诊断：

- `scroll-frame-dom-mutations`：MutationObserver 记录 DOM/style 变更总数；
- `scroll-frame-rect-reads`：`getBoundingClientRect` 调用总数；
- `scroll-frame-posatcoords`：`view.posAtCoords` 调用总数。

均保留 `per-frame` 明细，不改变原有 `scroll-avg-frame` /
`scroll-max-frame` 的测量语义，不修改 `perf-budget.json`。

## 小文件验证

已通过：

- `npm test`
- `npx tsc --noEmit`
- `git diff --check`
- `scripts/tests/scroll-endpoints.e2e.test.ts`
- `scripts/tests/inline-math-scroll.e2e.test.ts`
- `scripts/tests/caret-alignment.e2e.test.ts`
- `scripts/tests/visual-host-dom.e2e.test.ts`
- `scripts/tests/mode-switch-large.e2e.test.ts`

使用 ASCII 临时小文件复测 benchmark 时，20 个普通滚动帧的
`scroll-frame-dom-mutations`、`scroll-frame-rect-reads`、
`scroll-frame-posatcoords` 均为 0。

## 大文件 benchmark（barfoot_ser24.md，两轮）

| 指标 | Round A | Round B |
| --- | ---: | ---: |
| scroll-avg-frame | 63.1ms | 71.1ms |
| scroll-max-frame | 170.2ms | 183.9ms |
| scroll-jump-ready（worst） | 1315.9ms | 1313.9ms |
| scroll-frame-dom-mutations | 0 | 4（仅首帧，其余 19 帧 0） |
| scroll-frame-rect-reads | 0 | 0 |
| scroll-frame-posatcoords | 0 | 0 |
| scrollDriftPx | 0 | 0 |
| viewportPlaceholders | 0 | 0 |
| inline-math-activate-ready-ms | 5.5 | 5.4 |

## 状态

READY_FOR_LARGE_BENCHMARK

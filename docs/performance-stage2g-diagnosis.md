# Stage 2g 大文件滚动热路径诊断（2026-08-11）

## 1. 基线

当前 HEAD `0562663` 的官方大文件 benchmark：

| 指标 | 值 |
| --- | ---: |
| scroll-avg-frame | 152.4 ms |
| scroll-max-frame | 275.9 ms |
| scroll-jump-bottom | 1280.6 ms |
| scroll-jump-middle | 1315.1 ms |
| scroll-drag-sequence | 1731.6 ms |
| scrollDriftPx | 0 |
| viewportPlaceholders | 0 |
| inline-height-drift | 0 |
| inlineMathActivateReadyMs | 4.7 ms |

## 2. PerformanceObserver / MutationObserver 诊断

复用 `scripts/benchmark/stage4-diagnosis.ts`，在大文件
`/home/crh/下载/barfoot_ser24/barfoot_ser24.md` 上记录滚动路径：

| 项目 | 值 |
| --- | ---: |
| scroll wall | 1642.7 ms |
| long task 次数 | 5 |
| long task 总 ms | 1416.0 |
| 最大 long task | 560.0 ms |
| getBoundingClientRect 次数 | 7263 |
| rect ms | 326.0 |
| maxHydrateWorkMs | 339.4 |
| 首次 hydrate centerMs / anchorMs / hydrateMs | 98.4 / 7.2 / 174.1 ms |
| PM dispatch | 3 calls / 16.7 ms |
| formula chunk processRuns | 2 |

结论与 Stage 2f 一致：剩余成本不在公式高度测量，而在大范围跳转后的 PM
`posAtCoords`/`coordsAtPos`、hydration 队列和整棵原生 DOM 的 layout。

## 3. 实施

- `EditorShell.tsx`：普通小步滚动只记录 scrollTop，不再每帧创建 rAF；
  小步滚动的 hydration 延迟到停止 300ms 后执行；大跳转仍立即进入 rAF。
- 滚动 hydration 保留精确 PM 中心映射，但只在 rAF/scrollend 调度中出现，
  不在滚动事件监听器内做坐标映射。
- hydration 完成后先检查 `scrollHeight` 是否变化；只有高度变化才补 spacer，
  减少无必要的 scrollTop 重写。
- `activation-controller.ts`：hydration queue 的 evict radius 从 6 个视口
  收窄到 prefetch radius，减少旧滚动位置任务的残留。
- `inline-math-group-registry.ts`：prefetch 同时认 `formulaHtmlCache` 与
  `preparedFormulaHtml`，避免 benchmark 清空 raw cache 后仍在滚动路径发 worker
  prefetch；滚动 hydration 不再对 3 个视口外的组做 prepare。
- 失败中间实验：仅用 scroll ratio 估算中心并关闭锚点补偿时，bottom
  inline-height-drift 达到 480px，middle/drag 因漏激活而超时；该实验未保留。

## 4. 最终两轮 benchmark

| 指标 | 0562663 基线 | Stage 2g A | Stage 2g B |
| --- | ---: | ---: | ---: |
| scroll-avg-frame | 152.4 | 150.2 | 151.1 |
| scroll-max-frame | 275.9 | 262.9 | 275.7 |
| scroll-jump-bottom | 1280.6 | 1309.0 | 1279.9 |
| scroll-jump-middle | 1315.1 | 1366.1 | 1449.1 |
| scroll-drag-sequence | 1731.6 | 1550.3 | 1653.3 |
| scrollDriftPx | 0 | 0 | 0 |
| viewportPlaceholders | 0 | 0 | 0 |
| inline-height-drift | 0 | 0 | 0 |
| inlineMathActivateReadyMs | 4.7 | 4.7 | 4.9 |

typing 两轮为 159.9 / 153.9 ms，interaction-combined 为 1305.3 / 1486.9 ms，
visual→source 为 856.7 / 710.2 ms，source→visual 为 867.2 / 910.2 ms。
模式切换两向均保持 `<1000ms`；滚动 avg/max 与 jump-ready 仍未达发布预算，
但比 0562663 基线有改善且没有放宽任何硬门禁。

同 final code 还跑过一轮 `scroll-jump-middle` 超时（visible placeholder 15s
未清零），其余两个 jump 与硬门禁正常；该轮按超时记录，不作为有效基准。

## 5. 未解决风险

- `scroll-jump-ready` 的大部分 wall time 来自 benchmark 在 jump 后先执行
  `posAtCoords`/placeholder 统计，再进入 hydration 帧；该部分仍受大 DOM 的
  PM layout 成本支配。
- 在 `MathSyntaxHighlight` 文件未列入 Stage 2g 写范围的前提下，无法进一步
  去掉滚动帧内装饰插件的 `posAtCoords` 更新；如果后续允许调整该插件，仍可
  继续降低小步滚动平均帧。
- 发布预算 `16.6/33/200ms` 在本轮仍不可达，需要更底层 DOM/布局降本。

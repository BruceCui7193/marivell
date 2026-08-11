# Stage 5 性能诊断：D1 全链路成本归因（2026-08-12）

## 1. 结论

D1 三路成本归因已完成。大文件 `/home/crh/下载/barfoot_ser24/barfoot_ser24.md`
上的 wall time 归因如下：

| 路径 | wall ms | long task 总 ms | long task 占 wall | 主要成本 |
| --- | ---: | ---: | ---: | --- |
| typing（5 事务） | 1903.9 | 1526.0 | 80.1% | PM dispatch + 并发 worker/formula 处理 + PM 原生 DOM 更新 |
| scroll-frames（5 大步） | 4664.1 | 4539.0 | 97.3% | queue-hydrate、anchor/center 映射、rect/posAtCoords、DOM/style 变更 |
| katex-ready-warm（5 次跳转） | 5472.8 | 4780.0 | 87.3% | hydration 帧、10,439 次 style 变更、37,399 次 rect 读 |
| katex-ready-cold（1 次深清缓存） | 1382.2 | 1219.0 | 88.2% | 冷缓存 hydration：center/anchor、queue、主线程 KaTeX fallback |

结论：

1. 大文件当前瓶颈不是公式 DOM 注入本身；`dom-inject` p50 约 0.1ms，
   即使 cold 路径单次最大也只有 4.9ms。
2. 滚动和 KaTeX ready 的主要成本集中在 PM 坐标/锚点映射、hydration 队列执行，
   以及随 hydration 产生的大规模 style/DOM 变更。
3. typing 的 decoration rebuild 不是瓶颈：15 次 build 合计约 0.2ms。
   真正的成本是 PM dispatch（5 事务合计 429.2ms）以及 typing 期间仍在推进的
   worker formula 处理（24 条消息、3,580 entries、主线程等待 3,444.1ms）。
4. CDP `Performance.getMetrics` 在本机 Electron 中 layout/recalc 计数仍不可用
   （本次 scroll 甚至出现 `layoutCount=-1`），因此 reflow 范围使用
   MutationObserver、rect 读、style 变更和 DOM 变更作为代理。
5. 官方大跳转 ready 路径没有吃到 Stage 2g 的 300ms scrollend 防抖；
   小步滚动帧可能继承 settle 工作，但该部分需要 D3 单独建帧级测量。

## 2. 执行方式

- 分支：`perf/performance-optimization`
- HEAD：`2e2a51d`
- 新增诊断脚本：`scripts/benchmark/stage5-diagnosis.ts`
- 小文件：
  `/home/crh/文档/Machine_Learning_25D/面向不同车型的2.5D野外地形风险感知路径规划：机器学习与搜索算法双向嵌套完整方案.md`
- 大文件：`/home/crh/下载/barfoot_ser24/barfoot_ser24.md`
- 默认 5 次 typing / 5 个滚动步 / 5 次 KaTeX warm；cold 为 1 次深清缓存。
- 运行命令：

```bash
npx tsx scripts/benchmark/stage5-diagnosis.ts '<small-file>'
npx tsx scripts/benchmark/stage5-diagnosis.ts '<large-file>'
```

原始 JSON：

- `/tmp/marivell-stage5-面向不同车型的2.5D野外地形风险感知路径规划：机器学习与搜索算法双向嵌套完整方案.json`
- `/tmp/marivell-stage5-barfoot_ser24.json`

## 3. 测量口径

Phase 数据来自 benchmark-only 临时插桩，包含：

- `scroll-handler`：scroll 事件回调
- `rAF-schedule`：hydration rAF 调度
- `rAF-trigger`：hydration rAF 总时长
- `center-map` / `anchor-map`：中心/锚点 PM 映射
- `queue-evict` / `queue-scan` / `queue-drain`：hydration queue 路径
- `formula-cache:lookup`：`formulaHtmlCache` / `preparedFormulaHtml` /
  `preparedFormulaFragment` 查找
- `katex:dom-inject`：KaTeX HTML 注入
- `katex:hidden-sample-write/read`：隐藏 sample 写入与读取
- `katex:swap`：占位节点切换为真实预览
- `math-syntax:posAtCoords`：MathSyntaxHighlight viewport 的 `posAtCoords`
- `math-syntax:decoration-build`：decoration map build

表内 `exclusive ms` 是从嵌套 interval 中扣除子 interval 后的近似自有时长，
避免把 `rAF-trigger` 与 `center/anchor/queue` 重复相加。wall 内仍有 PM 原生
DOM、浏览器 layout、style recalc 等未直接插桩成本，因此 exclusive 合计低于 wall。

## 4. KaTeX Ready

### 4.1 大文件 warm（raw cache 清空，prepared 保留）

wall 5472.8ms，5 次跳转，19 个 long task，long task 总 4780ms，最大 658ms。
每次跳转可见公式数 2-3，首帧后均已含 `.katex`，因此 `readyMs=0`；
完整 wall 代表 hydration 帧 + benchmark 等待 + 隐藏 sample 推进。

| 相位 | count | total ms | p50 | p95 | max | exclusive ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| scroll:queue-hydrate | 5 | 949.0 | 178.8 | 237.9 | 237.9 | 901.2 |
| math-syntax:posAtCoords | 7 | 355.8 | 54.1 | 72.3 | 72.3 | 355.8 |
| scroll:rAF-trigger | 5 | 1221.0 | 260.4 | 282.8 | 282.8 | 126.4 |
| katex:hidden-sample-read | 6 | 67.8 | 0.1 | 67.2 | 67.2 | 67.8 |
| scroll:anchor-map | 5 | 58.6 | 12.0 | 13.7 | 13.7 | 58.6 |
| scroll:center-map | 5 | 55.4 | 12.2 | 12.7 | 12.7 | 55.4 |
| katex:dom-inject | 99 | 16.1 | 0.1 | 0.6 | 0.8 | 1.9 |
| math-syntax:decoration-build | 7 | 9.4 | 1.2 | 2.4 | 2.4 | 9.4 |
| katex:swap | 70 | 5.4 | 0.1 | 0.3 | 0.4 | 2.0 |
| formula-cache:lookup | 391 | 13.9 | 0.0 | 0.2 | 0.7 | 3.4 |
| katex:hidden-sample-write | 7 | 0.7 | 0.1 | 0.2 | 0.2 | 0.7 |
| 其余 rAF/handler/evict/scan/drain | - | <1ms | - | - | - | <1ms |

其他计数：

- PM dispatch：7 次 / 40.3ms
- rect 读：37,399 次 / 770.0ms
- `posAtCoords` 总调用：44 次 / 668.2ms
- style 变更：10,439 次；attributes 10,579 次；affected elements 3,159
- preparedFormulaHtml：+3,580；preparedFragments：+88
- height cache coverage：+879；pending height measurements：+3,380

### 4.2 小文件 warm

wall 1493.2ms，3 个 long task，总 283ms。5 次跳转中 2 次视口没有公式，
其余首帧已真实 KaTeX。

| 相位 | count | total ms | p50 | p95 | max | exclusive ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| scroll:queue-hydrate | 5 | 123.1 | 33.3 | 48.4 | 48.4 | 90.4 |
| math-syntax:posAtCoords | 7 | 20.6 | 1.4 | 6.2 | 6.2 | 20.6 |
| scroll:center-map | 5 | 21.1 | 0.8 | 18.3 | 18.3 | 20.5 |
| katex:swap | 14 | 14.9 | 0.2 | 12.0 | 12.0 | 12.4 |
| katex:dom-inject | 36 | 10.2 | 0.2 | 0.7 | 0.8 | 8.8 |
| scroll:rAF-trigger | 5 | 173.6 | 52.9 | 64.2 | 64.2 | 3.5 |
| scroll:anchor-map | 5 | 3.2 | 0.7 | 0.9 | 0.9 | 3.2 |
| katex:hidden-sample-read | 10 | 1.0 | 0.1 | 0.5 | 0.5 | 1.0 |
| 其余相位 | - | <1ms | - | - | - | <1ms |

小文件没有 worker formula 预处理（主线程 parse 路径不产生
`formulaHtmlCache`/`preparedFormulaHtml`），所以公式主要走
`formulaHtmlCache miss -> prepared miss -> 主线程 katex.renderToString fallback`。

### 4.3 大文件 cold（raw + prepared 同时清空）

wall 1382.2ms，3 个 long task，总 1219ms，最大 878ms。这是 worker round-trip
和主线程 fallback 都能暴露的最冷路径。

| 相位 | count | total ms | p50/p95/max | exclusive ms |
| --- | ---: | ---: | ---: | ---: |
| scroll:queue-hydrate | 1 | 379.0 | 379.0 | 324.1 |
| scroll:anchor-map | 1 | 179.0 | 179.0 | 177.5 |
| scroll:center-map | 1 | 116.1 | 116.1 | 111.1 |
| math-syntax:posAtCoords | 2 | 80.9 | 15.3/65.6/65.6 | 80.9 |
| katex:dom-inject | 50 | 32.8 | 0.3/1.7/4.9 | 29.4 |
| scroll:rAF-trigger | 1 | 752.8 | 752.8 | 17.3 |
| katex:swap | 30 | 6.3 | 0.2/0.5/0.6 | 1.3 |
| scroll:queue-scan | 1 | 11.7 | 11.7 | 0.6 |
| scroll:queue-drain | 1 | 10.6 | 10.6 | 0.3 |
| katex:hidden-sample-schedule | 28 | <1ms | - | <1ms |

其他计数：

- `clear-prepared` 清掉 4,909 个 prepared HTML/Fragment keys
- 可见公式 9 个，首帧后全部真实 KaTeX
- rect 读 7,510 次 / 148.6ms
- `posAtCoords` 总调用 10 次 / 337.9ms
- style 变更 243 次；DOM added 156 / removed 255
- 无 worker message 增量；当前 cold 路径由主线程 `katex.renderToString`
  同步 fallback 和 cache seed 承担。

## 5. 滚动帧

### 5.1 大文件 5 个 20% 大步

wall 4664.1ms，8 个 long task，long task 总 4539ms，最大 895ms。

| 帧 | step ms | style 变更 | affected elements | rect 读 | posAtCoords | PM dispatch | math-syntax local build |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 412.9 | 107 | 277 | 28 | 14 | 2 | 2 |
| 1 | 637.0 | 107 | 378 | 14 | 8 | 1 | 1 |
| 2 | 986.5 | 156 | 607 | 14 | 8 | 1 | 1 |
| 3 | 893.8 | 127 | 847 | 14 | 8 | 1 | 1 |
| 4 | 912.5 | 63 | 873 | 14 | 8 | 1 | 1 |

总计：style 652 次，attributes 889 次，DOM added 1,874 / removed 1,661，
affected elements 2,059。rect 读 7,142 次 / 732.8ms；
`posAtCoords` 总 48 次 / 1028.5ms，其中 MathSyntaxHighlight 相位 7 次 / 376.4ms。

| 相位 | count | total ms | p50 | p95 | max | exclusive ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| scroll:queue-hydrate | 6 | 1511.8 | 183.6 | 377.6 | 377.6 | 1474.7 |
| scroll:anchor-map | 6 | 465.9 | 10.3 | 187.8 | 187.8 | 465.7 |
| math-syntax:posAtCoords | 7 | 376.4 | 64.4 | 67.3 | 67.3 | 376.4 |
| scroll:rAF-trigger | 6 | 2472.2 | 276.5 | 651.6 | 651.6 | 261.6 |
| scroll:center-map | 6 | 202.5 | 10.2 | 154.4 | 154.4 | 202.3 |
| math-syntax:decoration-build | 7 | 15.9 | 1.9 | 4.7 | 4.7 | 15.9 |
| katex:dom-inject | 181 | 17.5 | 0.1 | 0.4 | 0.9 | 14.8 |
| katex:swap | 98 | 5.5 | 0.0 | 0.2 | 0.3 | 2.8 |
| scroll:queue-scan / drain | 12 | 15.3 | 1.1 | 2.8 | 2.8 | 3.4 |
| 其余 rAF/handler/evict/cache | - | <2ms | - | - | - | <2ms |

### 5.2 小文件 5 个 20% 大步

wall 661.5ms，4 个 long task，总 505ms，最大 169ms。style 346 次，
affected 451，rect 350 次 / 138.6ms，`posAtCoords` 45 次 / 86.6ms，
PM dispatch 6 次 / 7.3ms。主要相位与大一文件相同，但绝对量低一个数量级。

## 6. Typing

### 6.1 大文件 5 次输入事务

wall 1903.9ms，11 个 long task，总 1526ms，最大 191ms。

| 指标 | 值 |
| --- | ---: |
| PM dispatch | 15 次 / 429.2ms |
| rect 读 | 365 次 / 1.2ms |
| math-syntax decoration-build | 15 次 / 0.2ms，full rebuild 0 |
| attributes / characterData | 11 / 11 |
| childList added / removed | 72 / 0 |
| affected elements | 74 |
| 最大文本 mutation 长度 | 63 chars |
| style 变更 | 0 |
| formula worker messages | 24 条 |
| formula worker entries | 3,580 |
| worker 主线程等待 | 3,444.1ms |
| edit gate skips | 6 |

说明：worker 等待与 typing wall 重叠；它不是纯主线程 CPU，但会显著影响
“输入事务期间主线程可观测活动”。主线程可归因成本以 long task 为主
（80.1% of wall），其中 PM dispatch 占 22.5%。

### 6.2 小文件 5 次输入事务

wall 772.6ms，无 long task。PM dispatch 15 次 / 89.8ms，rect 80 次 / 0.1ms，
decoration build 15 次 / 0.1ms，attributes/characterData 11/11，affected 2。
小文件没有 worker 背景处理，剩余 wall 主要是 5 次插入 + undo + 双 rAF 等待，
不是单次事务的同步主线程成本。

## 7. Benchmark 审计：300ms 防抖与双 rAF

1. 官方 jump 与 Stage 2g 的 300ms scrollend 防抖不冲突：
   大跳转的 `scrollDelta >= 1000` 分支直接 `scheduleHydrationFrame()`，
   300ms 分支只用于小步滚动。本次 stage5 使用 20% 大步，也走 immediate。
2. 官方 KaTeX ready 在 `scrollTop` 设置后只等第一个 rAF 作为 first frame；
   若首帧已全部真实 `.katex`，`readyMs=0`，不会计入后续 double-rAF 采样。
   真正等待时，等待循环使用 double rAF，因此这些采样间隔会计入 `readyMs`。
3. 官方 `scroll-avg-frame` 不等待 300ms settle；但若某帧正好落在 settle
   触发后的 hydration 帧，该帧会被计为慢帧。D3 如果要证明“普通滚动零变更”，
   需要在同一脚本中加帧级 MutationObserver/rect 计数器。
4. 本次诊断未发现 benchmark 把 300ms 防抖直接算进大跳转 ready；
   也未发现 double-rAF 等待在首帧就绪时被虚增。

## 8. 归因与插桩扰动

- 归因通过：大文件三路 long task 占 wall 均 >=80%，且主要相位和
  DOM/style/rect 计数交叉一致。
- 插桩扰动：本次没有单独跑 clean/instrumented A/B。DOM/缓存插桩开销是
  sub-ms 级；`getBoundingClientRect`/dispatch wrapper 会进入被测路径本身。
  严格通过判据建议在 D2 前补一轮同脚本的 clean A/B；当前数据作为 D1 诊断
  结论可接受，不进入 perf-budget。

## 9. 对 D2-D5 的建议

### D2 公式 DOM 注入路径

- 不必假设 `innerHTML` 是主瓶颈。warm 大文件 `dom-inject` 总 16.1ms，
  cold 总 32.8ms，单次 p95 1.7ms。
- 优先比较 prepared fragment 重激活路径，而不是一次性插入：当前
  `preparedFormulaFragment` 命中已避免大量重复 `template.innerHTML`。
- PoC 应同时统计注入后的 style 变更；大文件 warm 有 10,439 次 style 变更，
  如果注入方式能减少 placeholder/active 两套 style 的 churn，收益可能大于
  单纯换 innerHTML。

### D3 滚动零变更帧

- 大文件每大步 63-156 次 style 变更、14 次 rect 读、8 次 posAtCoords；
  若目标是普通滚动帧零变更，必须把 `MathSyntaxHighlight` viewport refresh
  和 EditorShell center/anchor 移出帧内。
- 当前 `math-syntax:posAtCoords` 只占 7 次 / 376.4ms，但 runtime
  `posAtCoords` 总量 48 次 / 1028.5ms，说明 EditorShell/coordinate-service
  也是重要来源。
- style 变更主要来自 hydration 和锚点补偿，不是普通渲染；
  D3 应区分“已稳定区域普通滚动帧”和“hydration 帧”，否则零变更指标会失效。

### D4 跳转即时 hydration

- 大跳转已经 immediate，不存在 300ms 防抖等待；剩余成本在
  `queue-hydrate`（p50 178.8ms）、`center/anchor` 和 PM 坐标映射。
- cold 路径 `rAF-trigger` 752.8ms，其中 `center-map` 116.1ms、
  `anchor-map` 179ms、`queue-hydrate` 379ms；需要减少 PM 坐标读取次数，
  而不是只改调度时机。
- `drainQueue` 已工作；当前 activated 数量不大（warm 5 次共几十个），
  但 DOM/style 变更很大，说明激活本身触发了大量样式写入。

### D5 typing 热路径

- decoration 不是瓶颈：0 次 full rebuild，15 次 incremental build 合计 0.2ms。
- 优先降低 PM dispatch 成本和 typing 期间后台 formula worker 对主线程的可见
  影响；本次 typing wall 内 worker 消息 24 条、wait 3,444ms。
- `contain: layout style` 可以小范围验证，但当前 rect 读只有 365 次且耗时
  1.2ms，D5 的收益应主要来自 dispatch/DOM 更新，而不是 rect。

## 10. 临时改动与工作区

诊断期间添加了 benchmark-only 临时插桩并已回退：

- `src/renderer/perf-stage5.ts`（与其他并发子代理同名文件冲突，已保留对方的
  PoC shim，不回退他人改动）
- `src/renderer/components/EditorShell.tsx`
- `src/renderer/editor/extensions/math-inline.ts`
- `src/renderer/editor/math-render-cache.ts`
- `src/renderer/editor/plugins/math-syntax-highlight.ts`
- `src/renderer/editor/virtualization/activation-controller.ts`
- `src/renderer/editor/virtualization/height-measurer.ts`
- `src/renderer/editor/virtualization/inline-math-group-registry.ts`

本任务新增保留文件：

- `scripts/benchmark/stage5-diagnosis.ts`
- `docs/performance-stage5-diagnosis.md`

未修改 `scripts/benchmark/performance.ts`，未放宽 `perf-budget.json`，
未 commit、未 push。

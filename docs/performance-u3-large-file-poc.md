# U3 坐标引擎大文件 PoC（barfoot_ser24，2026-08-12）

## 1. 结论

本次大文件复测未达到进入 U3.1 flag-gated 产品包裹阶段的条件。当前结论：**继续默认走 PM 原生坐标路径，不把 PoC 代码接入产品路径。**

- `coordsAtPos` 精度门禁失败：600 个采样点 p50/p95 为 `0 / 0.0068359375px`，但 max 为 `974.03125px`；`leftDeltaPx` 有 6 个采样超过 1px，其中 4 个超过 100px。
- 偏移表构建成本不可接受：`build.ms=244,175.5`（约 244 秒），`formulaCharRanges=2,017,533`、`canvasMeasureCalls=1,905,746`、`Range.getClientRects=726,272`。
- 滚动 A/B 均为数百毫秒级，且 PM 原生和原型没有有效差异；这不是 U3 查询路径能单独解决的问题。
- 增量更新比全表重建快约 42 倍，但仍有 `972ms`，离交互预算很远；本次 `insertedChars=0`，真实输入增量路径仍未覆盖。
- 采样到的 `posAtCoords` 精度很好：93 个点 pos 偏差与原生/原型 px 偏差均为 `0 / 0 / 0`，fallback rate 为 `24.73%`，低于小文件的 `56.0%`。但构建成本和 `coordsAtPos` max 已构成硬性阻塞。

## 2. 执行命令与环境

- 分支：`perf/performance-optimization`
- HEAD：`5d0d772e86e1fd3818fb6a079262e8f24fe03228`
- 时间：2026-08-12 约 21:01（Asia/Shanghai）
- Node.js：`v20.19.5`
- npm：`10.8.2`
- OS：Linux x86_64，`7.0.0-28-generic`
- 执行前确认 `/tmp/marivell-benchmark.lock` 不存在，且没有其它 marivell Electron/PoC 进程

执行命令：

```bash
MARIVELL_U3_ALLOW_LARGE=1 npx tsx scripts/benchmark/u3-coord-boundary-poc.ts /home/crh/下载/barfoot_ser24/barfoot_ser24.md
```

原始 JSON：

```text
/tmp/marivell-u3-boundary-poc-1786539709941.json
```

本次未修改默认产品源码、未修改 `perf-budget.json`、未放宽断言、未 commit/push，也没有并行启动第二个 Electron 性能任务。

## 3. 原始数据

### 3.1 环境与整体

| 字段 | 值 |
| --- | ---: |
| `sourceBytes` | 1,361,722 |
| `docSize` | 1,336,667 |
| `blockCount` | 6,753 |
| `lineCount` | 10,835 |
| `cellCount` | 1,321,511 |
| `scrollHeight` | 768,269 |
| `clientHeight` | 615 |
| renderer build | 6,589.2 ms |
| launch | 411 ms |
| visual ready | 4,865 ms |

### 3.2 偏移表构建

| 字段 | 值 |
| --- | ---: |
| `build.ms` | 244,175.5 ms |
| `rectReads` | 0 |
| `clientRectReads` | 726,272 |
| `nativeCoordsCalls` | 0 |
| `textLineSegments` | 40,939 |
| `formulaCharRanges` | 2,017,533 |
| `canvasMeasureCalls` | 1,905,746 |

### 3.3 `coordsAtPos`

600 个采样点。

| 指标 | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| `deltaPx` | 0 | 0.0068359375 | 974.03125 |
| `topDeltaPx` | 0 | 0 | 33.25 |
| `bottomDeltaPx` | 0 | 0 | 46.75 |
| `leftDeltaPx` | 0 | 0.0068359375 | 974.03125 |
| `rightDeltaPx` | 0 | 0.0068359375 | 974.03125 |
| `nativeMs` | 0 | 0 | 0.1000000238 |
| `protoMs` | 0 | 0 | 0.1000000238 |

`leftDeltaPx` 有 6 个值超过 1px，其中 4 个超过 100px；`topDeltaPx` 有 5 个值超过 1px。

### 3.4 `posAtCoords`

93 个采样点。

| 指标 | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| `posDelta` | 0 | 0 | 0 |
| `topDeltaPx` | 0 | 0 | 0 |
| `leftDeltaPx` | 0 | 0 | 0 |
| `maxDeltaPx` | 0 | 0 | 0 |
| `nativeMs` | 9.9000000954 | 11.0999999642 | 11.8999999762 |
| `protoMs` | 0.1000000238 | 0.3999999762 | 1.1000000238 |
| `protoLineMs` | 0.1000000238 | 0.1999999881 | 0.2000000477 |
| `protoFallbackMs` | 0.3000000119 | 0.5 | 1.1000000238 |

| 分类 | 数量 | 值 |
| --- | ---: | ---: |
| `lineHits` | 70 | DOM caret 命中 |
| `domCaretHits` | 70 | DOM caret 命中 |
| `pmFallbacks` | 23 | PM 原生回退 |
| `fallbackRate` | 24.73% | 23 / 93 |
| `targetedLineSamples` | 45 | 真实 line 定向采样 |
| `lineQueryRectReads` | 0 | 原型 line 查询 |
| `lineQueryClientRectReads` | 0 | 原型 line 查询 |
| `lineQueryPmCalls` | 0 | 原型 line 查询 |

23 个回退点按 `posAtCoordsDetails` 统计为 18 个 `gap` + 5 个 `edge`，均为显式边界分类。

### 3.5 滚动 A/B

20 帧。

| 指标 | PM 原生 | 原型 |
| --- | ---: | ---: |
| frame p50 | 441.2999999523 ms | 474.2999999523 ms |
| frame p95 | 521.6999999881 ms | 556 ms |
| frame max | 538.8999999762 ms | 574.1000000238 ms |
| `rectReads` | 323 | 298 |
| `clientRectReads` | 29 | 14 |
| `queryRectReads` | 21 | 15 |
| `queryClientRectReads` | 14 | 0 |
| `queryPmCalls` | - | 15 |
| `queryFallbacks` | - | 15 |
| `queryCaretHits` | - | 5 |

### 3.6 增量更新

| 字段 | 值 |
| --- | ---: |
| `insertedChars` | 0 |
| `pmDelta` | 0 |
| `heightDeltaPx` | 21 |
| `updateMs` | 972 ms |
| `fullRebuildMs` | 41,315.4 ms |
| `rectReads` | 0 |
| `clientRectReads` | 2 |
| `rangeGetClientRects` | 2 |
| `nativeCoordsCalls` | 0 |
| `restoredAfterUndo` | true |

## 4. 只读成本归因

### 4.1 构建成本爆点

构建期成本主要不是普通文本的 line-box 聚合本身，而是公式与逐字符测量：

- `formulaCharRanges=2,017,533`：公式 text 仍按字符创建 `Range` 并读取 rect。这个量级是 244 秒构建的主要嫌疑之一。
- `canvasMeasureCalls=1,905,746`：普通文本段按每个字符前缀调用 Canvas `measureText`。它把文本长度线性放大为测量次数。
- `clientRectReads=726,272`：公式逐字符 Range 以及多行 text node 的二分探测都会触发。
- `cellCount=1,321,511`：偏移表为每个字符位置物化 cell；大文件下内存和 GC 压力很大。

运行中进程监控观察到 Electron renderer RSS 约 2.6 GB（非原始 JSON 持久化字段，未作为正式峰值统计）。这与 132 万 cell、200 万公式字符 Range 和大量 DOM rect 结果的方向一致。

### 4.2 line-box 聚合现状

普通文本已聚合为 40,939 个 line segment，相对 10,835 个逻辑行约 3.78 segments/line；line-box 聚合不是完全缺失，但公式仍保留逐字符 Range。原始 JSON 的 6 个 `lineBoxesPreview` 中，一个大 paragraph（`blockStart=116`）的 `Range.getClientRects` 返回 233 个 DOM boxes；同一 block 的 `partsPreview` 有 120 个 formula part。可见公式 DOM/text 碎片会继续放大 Range 与 box 数量。

### 4.3 `coordsAtPos` 大偏差

`coordsAtPos` p95 仍接近 0，但 max 达到 974px。原始 JSON 没有保存每个采样点对应的 PM position，无法逐点归属；从 600 个采样中 4 个超过 100px 的分布看，这是大文件 wrap/公式密集行上的局部失效，不是整体系统性漂移。即便如此，`<=1px` 门禁要求 max 也必须满足，因此当前原型不能进入产品包裹。

### 4.4 滚动和增量更新

滚动 A/B 的查询侧 rect 数量不大，但两路 frame p50 都超过 400ms，说明大文件滚动成本主要来自编辑器整体 DOM/layout/rAF，而不是坐标引擎查询。U3 原型在小文件上的查询优势没有在大文件帧耗中体现。

增量更新比全表重建快约 42 倍，但 972ms 仍不可接受；本次不是真实字符插入（`insertedChars=0`），只验证了单 block 高度变化后的表维护，真实输入路径仍未测量。

## 5. 是否进入 U3.1 flag-gated 产品包裹

**否。**

满足进入条件的正面证据：

- 采样到的 `posAtCoords` pos 偏差和 px 偏差全部为 0。
- 45 个真实 line 定向采样全部走 DOM caret 探针，`lineQueryPmCalls=0`。
- fallback rate 24.73%，低于小文件 PoC 的 56.0%。

不满足进入条件的关键阻塞：

- `coordsAtPos` max 974px，已直接违反 `<=1px` 门禁。
- 偏移表构建约 244 秒，其中公式逐字符 Range 和 Canvas 逐字符前缀测量达百万级。
- 大文件滚动 frame 400ms+、增量更新 972ms，均远高于 `perf-budget.json` 的交互预算。
- 本次 `insertedChars=0`，真实输入、selection、IME、搜索跳转等价性仍未覆盖。

## 6. 失败回退与下一步建议

- 默认路径保持不变：flag off 时继续全部使用 PM 原生坐标 API，不接入 U3 PoC。
- 先消除公式逐字符 Range：改为公式级/KaTeX box + line-box 映射，或按需惰性计算公式字符锚点，目标是把 `formulaCharRanges` 从百万级降到公式数量级。
- 降低 Canvas 测量：不要对每个文本段的每个字符前缀都调用 `measureText`；按 line segment 聚合并只在需要边界字符时取局部 metric。
- 偏移表不要全量物化 132 万字符 cell：改为 line segment + 稀疏字符/公式 cell，或按视口/块惰性构建。
- 增量更新需要真实插入路径复测；当前 972ms 必须先降到交互预算内，不能以“比全量重建快”作为通过依据。
- 滚动问题需要大文件 DOM/layout 侧优化或视口策略，U3 查询路径不能单独解决。
- 后续用同一命令、同一文件、同一 `perf-budget.json` 和断言复测；在构建成本、`coordsAtPos` max、滚动/增量预算达标前，不进入 flag-gated 产品包裹阶段。

## 7. 产出物

- 新增：本文档
- 原始数据：`/tmp/marivell-u3-boundary-poc-1786539709941.json`

未修改默认产品源码、`perf-budget.json` 或现有测试断言。

# U3.1 坐标引擎行内 line-box PoC（2026-08-12）

## 1. 结论

本次 PoC 把 U3.0 的“逐字符 PM `coordsAtPos` 扫描”替换为“DOM text node / formula node 字符 Range + 行内 y 聚类”，并在构建、增量更新、查询路径上完全移除 PM 坐标调用。

- `coordsAtPos` 精度已达到目标：600 个采样点 p50/p95/max 分别为 `0 / 0.0078 / 0.0078 px`。
- `posAtCoords` 尚未达到目标：48 个视口采样点 p50/p95/max 分别为 `0 / 3 / 21 pos`，残差集中在块间 margin/gap 与视口右侧边界，而不是普通行内 x 映射。
- 查询路径保持零 rect 读取：滚动 A/B 中原型 `queryRectReads=0`、`queryClientRectReads=0`。
- 增量更新保持不读 block rect、不调用 PM 坐标：块高变化 `+109.99px` 后更新 `6.7ms`，rect 读取 `0`。

因此，当前结论是：**值得继续做 U3.1，但还不能直接包裹产品坐标 API**。`coordsAtPos` 和查询性能已经具备 U3.1 包裹条件，`posAtCoords` 还需要一个明确的 block/line gap boundary 语义，或对 gap 查询保留 PM 原生回退。

## 2. 执行方式与范围

- 分支：`perf/performance-optimization`
- HEAD：`acf084705f75708c8f47fb690ecee04bab37a348`
- 小文件：自动生成 `11,336` 字节 Markdown，`docSize=11,078`，`blockCount=163`，`lineCount=227`，`cellCount=10,548`
- 运行命令：

```bash
npx tsx scripts/benchmark/u3-coord-line-box-poc.ts
npx tsx scripts/tests/u3-coord-line-box-poc.e2e.test.ts
```

PoC 使用真实 Electron 启动现有编辑器，页面内只执行原型代码和运行时计数插桩；没有修改默认产品源码、`perf-budget.json` 或现有测试断言。

## 3. 原型机制

1. 遍历 `EditorView.docView`，收集 textblock 与可见 leaf block，记录 PM start/end、DOM 引用、行记录。
2. 行内数据来源改为 DOM Range：
   - text desc 的 text node 按字符 Range 测量精确左右/上下坐标；
   - inlineMath 内容仍按其 DOM text node 测量，保持公式内 caret 位置可用；
   - 对不可见的 text desc DOM element（如 code syntax span）回退到其文本子节点，修复 codeBlock 首尾缺段。
3. 按字符中心的 y 做行聚类，得到每行的 start/end、docTop/docBottom、docLeftStart/docLeftEnd。
4. `coordsAtPos` 使用行/字符表二分回答；`posAtCoords` 先按 y 找 block/line，再按 x 找最近字符边界。
5. 查询路径只读内存表，不调用 `view.coordsAtPos`/`view.posAtCoords`，不读 block rect。

说明：PoC 仍在构建期使用约 `10.7k` 次 DOM 字符 Range，以换取精确坐标；这不是大文件最终形态。下一步应把同一 text node 内的连续字符聚合为线段，用 line-box 分割 + TextMetrics/稀疏锚点控制构建成本。

## 4. 小文件关键数据

### 4.1 构建

| 指标 | 值 |
| --- | ---: |
| renderer build | 7,367.8 ms |
| 块偏移表构建 | 65.6 ms |
| `getBoundingClientRect` | 0 |
| `Range.getClientRects` | 10,711 |
| PM `coordsAtPos`/`posAtCoords` | 0 |

### 4.2 `coordsAtPos` 偏差（600 个位置）

| 轴 | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| top | 0 | 0 | 0 |
| bottom | 0 | 0 | 0 |
| left | 0 | 0.0078 | 0.0078 |
| right | 0 | 0.0078 | 0.0078 |
| max delta | 0 | 0.0078 | 0.0078 |

### 4.3 `posAtCoords` 偏差（48 个视口点）

| 指标 | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| PM pos 偏差 | 0 | 3 | 21 |

残余偏差来自：

1. 块间 margin/gap 的归属语义：同一 gap 在靠近 codeBlock、heading、普通 paragraph 时，PM 会给出不同 boundary pos；
2. 视口最右侧查询点在块上方/下方时，PM 的水平 outside-block 判定与纯垂直 nearest 不一致；
3. textblock 的 block 边界与内容首尾之间还存在 `+1` 级别的 border 位置差异。

### 4.4 单次查询耗时

| 查询 | PM 原生 avg | 原型 avg | PM 原生 p95 | 原型 p95 |
| --- | ---: | ---: | ---: | ---: |
| `coordsAtPos` | 0.0022 ms | 0.0010 ms | 0 | 0 |
| `posAtCoords` | 0.0967 ms | 0.0021 ms | 0.2 ms | 0 |

小文件计时分辨率有限，p95 多落在 `0` 或 `0.1ms` 档，但均值仍显示原型查询约快一个数量级。

### 4.5 滚动帧 A/B（20 帧）

| 路径 | frame p50 | frame p95 | frame max | rect 读取 | query rect 读取 |
| --- | ---: | ---: | ---: | ---: | ---: |
| PM 原生 | 46.7 ms | 58.7 ms | 62.5 ms | 551 | 31 |
| 原型 | 44.6 ms | 51.3 ms | 52.6 ms | 369 | 0 |

帧 wall time 仍由产品本身的滚动、layout、hydration 主导；但原型查询自身已做到零 rect 读取。

### 4.6 块高度变化后的增量更新

| 指标 | 值 |
| --- | ---: |
| 高度变化 | +109.992 px |
| 增量更新耗时 | 6.7 ms |
| 全表重建耗时 | 47.1 ms |
| 增量更新 rect 读取 | 0 |
| 增量更新 `Range.getClientRects` | 140 |
| 增量更新 PM 坐标调用 | 0 |
| 恢复 | 是 |

## 5. 大文件数据缺口

按并行约束，本次 **没有运行** `/home/crh/下载/barfoot_ser24/barfoot_ser24.md`，避免与 D2/D3 等大文件 benchmark 互相污染。

需要主代理独占复测的字段：

- 大文件 DOM line-box 构建耗时与字符 Range 数量；
- 大文件 wrap、公式、空行场景的 `coordsAtPos`/`posAtCoords` 偏差；
- 大文件滚动帧 A/B；
- 大文件块高度变化后的增量更新耗时；
- 大文件 DOM text node 聚合优化后的构建成本。

## 6. 是否值得包裹产品坐标 API

**不建议现在包裹。**

原因：

- `coordsAtPos` 已满足 `<=1px`，且查询路径零 PM 坐标、零 rect 读取；
- `posAtCoords` p95 `3`、max `21`，尚未满足全网格等价性门禁；
- 当前构建期逐字符 DOM Range 成本只适合小文件 PoC，直接进入产品路径会放大构建时间。

建议下一步：

1. 为 block/line gap 建立可复现的 boundary 规则，并用 PM 原生 gap 采样做等价性校准；
2. 对 gap 查询可先保留 PM 原生 fallback，仅对命中真实 line/cell 的查询走原型；
3. 将 text node 字符 Range 聚合为 line-box 线段，减少构建期 rect 读取后再做大文件复测；
4. 在独立 flag `MARIVELL_ULTIMATE_U3=1` 下双跑现有 selection、IME、搜索跳转、坐标、导出等价性门禁。

失败回退路线：

- flag off 时完全走现有 PM 原生坐标路径；
- 若 flag on 引起 selection、IME、搜索跳转、caret 对齐或 placeholder/drift 回归，整 commit/整分支回退；
- 本 PoC 文件、测试与数据保留，不删除失败实验记录。

## 7. 产出物

- 新增：`scripts/benchmark/u3-coord-line-box-poc.ts`
- 新增：`scripts/tests/u3-coord-line-box-poc.e2e.test.ts`
- 新增：本文档

未修改默认产品源码、`perf-budget.json` 和现有测试断言。

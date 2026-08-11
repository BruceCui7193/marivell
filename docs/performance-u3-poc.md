# U3.0 坐标引擎最小 PoC（2026-08-12）

## 1. 结论

U3.0 的“块偏移表 + 行内增量”方向值得继续做 U3.1 原型，但**当前最小实现不能直接包裹产品坐标 API**：

- 查询速度优势明显：小文件上 `posAtCoords` 原型单次查询平均约 `0.001ms`，PM 原生约 `0.085ms`；原型滚动坐标查询路径的 rect 读取为 `0`。
- 增量更新优势明显：把单个块高度增加约 `113.5px` 后，增量更新 `6.8ms`，全表重建 `52.4ms`。
- 精度未达标：`coordsAtPos` 的 top/bottom 偏差为 `0px`，但 left/right p95 `11.6px`、max `30.1px`；`posAtCoords` 的 PM pos 偏差 p50 `1`、p95 `20`、max `77`。

失败回退路线：如果 U3.1 包裹 `view.posAtCoords`/`view.coordsAtPos` 后出现 selection、caret、scroll anchor、placeholder 或 jump drift 回归，立即保持 flag off 并回退到 PM 原生坐标路径，不替换默认行为。

## 2. 执行方式

- 分支：`perf/performance-optimization`
- HEAD：`2e2a51d67d92a3ebddc4068a0292c60f25d157c4`（执行开始时）
- 小文件：自动生成的 `11,336` 字节 Markdown，163 个可见块、427 个行增量
- 运行命令：

```bash
npx tsx scripts/benchmark/u3-poc.ts
npx tsx scripts/tests/u3-coord-poc.e2e.test.ts
```

PoC 使用真实 Electron 启动现有编辑器，页面内只执行原型代码和运行时计数插桩，不修改默认产品行为，不把原型逻辑接入产品路径。

## 3. 原型机制

块偏移表：

- 遍历 `EditorView.docView`，收集 textblock 与可见 leaf block；
- 每个 block 记录 PM start/end、DOM 引用、docTop/docBottom/height、行内增量；
- 行内增量当前用 `view.coordsAtPos` 逐字符扫描生成，记录行 start/end 与左右 caret 坐标；
- `coordsAtPos` 用 block/line 二分和线性插值回答；
- `posAtCoords` 先按 docY 找 block/line，再按 docX 在线内做线性映射；
- 滚动 A/B 中，原型路径只调用偏移表，不调用 PM 坐标，也不读 block rect。

## 4. 小文件关键数据

### 4.1 环境与构建

| 指标 | 值 |
| --- | ---: |
| sourceBytes | 11,336 |
| docSize | 11,078 |
| blockCount | 163 |
| lineCount | 427 |
| clientHeight | 615 px |
| 块偏移表构建 | 61.6 ms |
| 构建期 `getBoundingClientRect` | 2 |
| 构建期 `Range.getClientRects` | 10,776 |
| 构建期 PM `coordsAtPos` 调用 | 10,849 |

当前逐字符行扫描会产生约 `10.8k` 次 PM 坐标调用，小文件可接受，但大文件必须换成 DOM line box 或增量行索引，否则构建成本会放大。

### 4.2 坐标偏差

`coordsAtPos` 采样 240 个位置：

| 轴 | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| top | 0.000 | 0.000 | 0.000 |
| bottom | 0.000 | 0.000 | 0.000 |
| left | 0.000 | 11.625 | 30.051 |
| right | 0.000 | 11.625 | 30.051 |
| max delta | 0.000 | 11.625 | 30.051 |

`posAtCoords` 采样 48 个视口点：

| 指标 | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| PM pos 偏差 | 1 | 20 | 77 |
| 原型 pos 回到原生 coords 的 y 偏差 | 29.953 px | 86.336 px | 112.664 px |

偏差主要来自两个问题：

1. 行内增量按字符线性插值无法表达比例字体、inline math 和 wrap 边界；
2. 块间 margin/gap 和 PM 在行尾坐标的异常返回需要专门的 boundary 语义，当前最近块/最近行 fallback 仍不充分。

### 4.3 单次查询耗时

| 查询 | PM 原生 avg | 原型 avg | PM 原生 p95 | 原型 p95 |
| --- | ---: | ---: | ---: | ---: |
| `coordsAtPos` | 0.003 ms | 0.001 ms | 0.000 ms | 0.000 ms |
| `posAtCoords` | 0.085 ms | 0.001 ms | 0.200 ms | 0.000 ms |

小文件上性能计时分辨率有限，p95 落在 0 或 0.1ms 档，但均值已经显示原型查询路径约一个数量级更快。

### 4.4 滚动帧 A/B

20 帧，每帧在视口中心做坐标查询：

| 路径 | frame p50 | frame p95 | frame max | rect 读取 | clientRects | 查询 rect 读取 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| PM 原生 | 41.6 ms | 46.4 ms | 47.4 ms | 139 | 15 | 56 |
| 偏移表原型 | 42.4 ms | 50.9 ms | 51.1 ms | 110 | 0 | 0 |

帧 wall time 没有显著下降，因为 rAF cadence 和产品本身的 scroll/layout/hydration 仍占主导；但原型查询自身已做到 0 rect 读取，说明滚动帧里的 PM 坐标调用可以继续移除。

### 4.5 块高度变化后的增量更新

| 指标 | 值 |
| --- | ---: |
| 高度变化 | +113.492 px |
| 增量更新耗时 | 6.9 ms |
| 全表重建耗时 | 50.7 ms |
| 增量更新 rect 读取 | 0 |
| 增量更新 clientRects | 140 |
| 恢复 | 是 |

增量更新只重扫被改 block 并平移后续 block 的 offset/pos 字段；当前仍需一次行扫描，后续应改为 DOM line box 更新。

## 5. 大文件数据缺口

按主代理新增并行约束，本次 U3.0 **没有运行** `/home/crh/下载/barfoot_ser24/barfoot_ser24.md`，避免与 D1/其它子代理的大文件 benchmark 互相污染。

需要主代理独占复测的字段：

- 大文件块偏移表构建耗时；
- 大文件 lineCount、构建期 PM 坐标调用数；
- 大文件 `coordsAtPos`/`posAtCoords` 偏差；
- 大文件滚动帧 A/B；
- 大文件块高度变化后的增量更新耗时。

## 6. U3.1 建议

值得继续的方向：

- 把行内增量从“逐字符 PM coords 扫描”换成 DOM line box + 文本节点分段，修复 wrap 与 inline math 的水平偏差；
- 定义 block gap/boundary 语义，使 `posAtCoords` 在 margin、空行、块首尾精确落位；
- 保持查询路径零 PM 坐标、零 block rect 读取；
- 用独立 flag 包裹坐标 API，并跑 U3 等价性门禁。

不建议在以上两个精度问题解决前包裹产品路径。

失败回退：

- flag off 时完全走现有 PM 原生坐标路径；
- 若 flag on 引起 selection、IME、搜索跳转、caret 对齐或 placeholder/drift 回归，整 commit/整分支回退；
- 本 PoC 文件与数据保留，不删除失败实验记录。

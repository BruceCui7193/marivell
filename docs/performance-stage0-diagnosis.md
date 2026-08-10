# Stage 0 性能诊断报告

## 1. 目标与结论

本文档是 `performance-next-phase-plan-v2.md` Stage 0 的执行结果。诊断目标是量化大文件打开、输入、公式插入、Undo/Redo、模式切换、滚动和右键菜单路径的成本来源，不修改业务行为，不改变现有 benchmark 的默认测量语义。

正式基准文件：

`/home/crh/下载/barfoot_ser24/barfoot_ser24.md`

基线 commit：

`f3d99c0 perf: virtualize source editor and stabilize math layout (G1-G3)`

结论：255k DOM 中约 209k 个元素是 `.math-syntax-*` 装饰 span，是当前最明确、占比最大的 DOM 成本；其次是 PM 原生文本 DOM、隐藏 contentDOM 和两个模式宿主同时挂载导致的 DOM 膨胀；第三是 hydration/滚动管线在主线程上的长任务成本，并观察到交互后 `.math-inline-node` DOM 数量异常增长。

## 2. 执行命令与环境

先跑小文件验证脚本：

```bash
npx tsx scripts/benchmark/stage0-diagnosis.ts \
  '/home/crh/文档/Machine_Learning_25D/面向不同车型的2.5D野外地形风险感知路径规划：机器学习与搜索算法双向嵌套完整方案.md'
```

正式诊断：

```bash
npx tsx scripts/benchmark/stage0-diagnosis.ts \
  '/home/crh/下载/barfoot_ser24/barfoot_ser24.md'
```

环境：

- 平台：Linux
- Node.js：v20.19.5
- Electron：41.3.0
- Electron 参数：`--no-sandbox --disable-gpu`
- 分支：`perf/performance-optimization`
- commit：`f3d99c0`
- 基准文件大小：1,361,722 bytes
- 打开阈值：`expectedVisualTextLength=476,603`，实际视觉文本 `853,852` 字符

说明：本诊断脚本是独立新增脚本，`scripts/benchmark/performance.ts` 未修改，`npm run benchmark` 的默认行为不受 Stage 0 影响。诊断脚本内的 MutationObserver/PerformanceObserver 会带来少量开销，因此路径 wall time 是带诊断插桩的相对值；打开时间和 DOM 总数与现有 benchmark 对齐后仍可交叉验证。

## 3. 热点路径耗时

| 路径 | wall ms | long task 次数 | long task 总 ms | 最大 single task ms |
| --- | ---: | ---: | ---: | ---: |
| 打开到视觉就绪 | 10,465.6 | 9 | 7,650 | 4,450 |
| 普通输入 | 706.3 | 5 | 588 | 150 |
| 行内公式插入 | 769.9 | 3 | 321 | 159 |
| Undo | 624.4 | 4 | 517 | 173 |
| Redo | 515.4 | 4 | 519 | 212 |
| 视觉 → 源码 | 1,349.2 | 4 | 927 | 464 |
| 源码 → 视觉 | 2,683.6 | 7 | 2,334 | 1,413 |
| 滚动 top→middle→bottom→middle | 3,735.2 | 10 | 3,797 | 1,167 |
| 右键菜单打开 | 550.4 | 3 | 391 | 160 |

打开路径的 timeline：

| timeline 阶段 | 值 |
| --- | ---: |
| renderer-did-finish-load / document-open-main-start | 0 ms 基准 |
| document-read-end | 11 ms |
| document-open-sent | 15 ms |
| visual-editor-ready | 7,272 ms |

`renderer-render-to-ready` 实测约 7,257 ms，与现有 benchmark 的 7,344 ms 接近。打开 wall 10,465.6 ms 与现有 benchmark 的 10,576 ms 接近。

## 4. Long Task 分布

桶区间为 `(50, 100]`、`(100, 200]`、`(200, 400]`、`(400, 800]`、`>800`。

| 路径 | 50-100 | 100-200 | 200-400 | 400-800 | 800+ |
| --- | ---: | ---: | ---: | ---: | ---: |
| 打开到视觉就绪 | 6 | 0 | 0 | 1 | 2 |
| 普通输入 | 1 | 4 | 0 | 0 | 0 |
| 行内公式插入 | 1 | 2 | 0 | 0 | 0 |
| Undo | 2 | 2 | 0 | 0 | 0 |
| Redo | 2 | 1 | 1 | 0 | 0 |
| 视觉 → 源码 | 1 | 1 | 1 | 1 | 0 |
| 源码 → 视觉 | 1 | 4 | 1 | 0 | 1 |
| 滚动 top→middle→bottom→middle | 0 | 2 | 5 | 2 | 1 |
| 右键菜单打开 | 0 | 3 | 0 | 0 | 0 |

打开路径最贵的两个任务分别为 4,450 ms 和 2,286 ms，合计 6,736 ms，占打开路径 long task 总时间的约 88%。这是打开时全文档初始化/装饰构建成本的最直接证据。

## 5. DOM 分类

### 5.1 初始视觉模式

| 项目 | 数量 |
| --- | ---: |
| 元素总数 | 255,028 |
| 文本节点数 | 311,097 |
| `p` | 6,377 |
| `div` | 2,687 |
| `span` | 242,668 |
| `pre` | 2 |
| `img` | 108 |
| `table` | 2 |
| `svg` | 37 |

| class | 数量 |
| --- | ---: |
| `.math-inline-node` | 5,011 |
| `.math-node-content` | 7,244 |
| `.math-node-preview` | 7,436 |
| `.math-syntax-cmd` | 67,426 |
| `.math-syntax-brace` | 115,703 |
| `.math-syntax-special` | 26,003 |
| `.math-syntax-comment` | 2 |
| `.katex` | 213 |
| `.code-block-node` | 2 |
| `.image-node` | 110 |
| `.mermaid-node` | 0 |
| `.footnote-definition-node` | 0 |
| `.math-syntax-*` 独立元素 | 209,134 |
| `.math-syntax-*` class 出现次数 | 209,134 |

`span` 占元素总数的 95.2%；`.math-syntax-*` 装饰元素占元素总数的 82.0%。

### 5.2 源码模式

进入源码模式后 DOM 分类显著增加：

| 项目 | 数量 |
| --- | ---: |
| 元素总数 | 444,085 |
| 文本节点数 | 353,562 |
| `.math-inline-node` | 5,705 |
| `.math-node-content` | 7,244 |
| `.math-node-preview` | 8,792 |
| `.katex` | 1,564 |
| `.math-syntax-*` 独立元素 | 209,134 |

这说明源码模式下隐藏的视觉 host 仍然挂载在 DOM 中，源码分类包含源码视图与隐藏视觉 DOM 两部分，不是只统计源码视图。

### 5.3 模式切换后回到视觉模式

| 项目 | 数量 |
| --- | ---: |
| 元素总数 | 514,175 |
| 文本节点数 | 367,842 |
| `.math-inline-node` | 5,951 |
| `.math-node-content` | 7,244 |
| `.math-node-preview` | 9,290 |
| `.katex` | 2,053 |
| `.math-syntax-*` 独立元素 | 209,134 |

与初始视觉 255,028 元素相比，模式往返后 DOM 增长到 514,175。两个模式宿主都常驻 DOM，加上公式 hydration 状态在交互后继续膨胀，这是模式切换路径和后续滚动/右键菜单路径变慢的重要背景。

## 6. DOM 变更量

MutationObserver 统计仅作诊断参考：

| 路径 | childList added | childList removed | attributes | characterData |
| --- | ---: | ---: | ---: | ---: |
| 打开到视觉就绪 | 6,889 | 61 | 162 | 3 |
| 普通输入 | 96 | 0 | 10,386 | 2 |
| 行内公式插入 | 151 | 0 | 2,850 | 0 |
| Undo | 102 | 1 | 3,189 | 0 |
| Redo | 55 | 0 | 2 | 0 |
| 视觉 → 源码 | 867 | 91 | 720 | 9 |
| 源码 → 视觉 | 397 | 3 | 2,776 | 5 |
| 滚动 top→middle→bottom→middle | 74 | 19 | 1,505 | 0 |
| 右键菜单打开 | 103 | 0 | 1,718 | 0 |

普通输入只有一次字符输入，却产生 10,386 次 attribute mutation，是语法装饰随每次事务映射/重建的直接表现。

## 7. 前三个成本源

### 成本源 1：全文档 `MathSyntaxHighlight` 装饰 span

数据支撑：

- 初始视觉 DOM 中 `.math-syntax-*` 装饰元素为 209,134 个，占元素总数的 82.0%。
- 其中 `.math-syntax-brace` 115,703、`.math-syntax-cmd` 67,426、`.math-syntax-special` 26,003。
- 输入路径 wall 706.3 ms，其中 long task 总时间 588 ms；一次输入产生 10,386 次 attribute mutation。
- 打开路径最贵的 4,450 ms long task 与全量初始化装饰构建高度相关。

对应 Stage 1：Scoped MathSyntaxHighlight 必须优先落地。

### 成本源 2：PM 原生文本 DOM、隐藏 contentDOM 与双宿主 DOM 膨胀

数据支撑：

- 初始视觉总 DOM 节点约 566k（255,028 元素 + 311,097 文本节点）。
- 源码模式元素数 444,085，隐藏视觉 host 仍挂载。
- 模式往返后回到视觉元素数 514,175，文本节点 367,842。
- 源码 → 视觉 wall 2,683.6 ms，long task 总时间 2,334 ms，最大 single task 1,413 ms。
- 视觉 → 源码 wall 1,349.2 ms，long task 总时间 927 ms，最大 single task 464 ms。

对应 Stage 3：只有先把 DOM 和隐藏 decoration 降下来，模式切换才可能自然变快；不应在 255k 以上 DOM 时再常驻离屏视觉 host。

### 成本源 3：hydration/滚动与交互后 DOM 数量不稳定

数据支撑：

- 滚动 top→middle→bottom→middle wall 3,735.2 ms，10 个 long task，总 3,797 ms，最大 1,167 ms。
- `.math-inline-node` 数量从初始 5,011，到输入/公式插入/Undo/Redo/模式切换后变为 5,951；仅一次 `insertInlineMath` 的 DOM 计数变化为 25，不符合“插入一个公式”的预期。
- 右键菜单打开 wall 550.4 ms，3 个 long task，总 391 ms，明显受整个 DOM 树影响。

这提示两件事：滚动 hydration 仍在主线程承担大量长任务；交互/模式切换后可能产生重复或残留的 inline math NodeView DOM。Stage 1/2 应增加硬约束：`.math-inline-node` 的 document 查询数量不得持续高于 PM doc 中的 inlineMath 节点数，且任意一轮编辑/Undo/Redo/模式切换后必须回落，不能只增不减。

## 8. 对后续 Stage 的建议

### Stage 1

- 优先做 `MathSyntaxHighlight` 局部化，非编辑、离屏公式不生成 `.math-syntax-*` span。
- 把 `syntaxDecorationSpanCount` 加入硬门禁：Stage 1 后必须显著低于 209,134，且作为趋势指标持续记录。
- 在输入路径加入断言：一次普通输入不得触发全文档 DecorationSet 重建，attribute mutation 数量应大幅下降。

### Stage 2

- 滚动先解决“拖到哪停在哪、激活不改变物理高度”，再谈更快的 hydration。
- 将 hydration 调度完全移出 typing 热路径；当前输入路径的 10,386 次 attribute mutation 说明热路径仍被全文档副作用污染。
- 增加 `.math-inline-node` 数量与 PM 模型节点数一致性检查，先定位并修复交互后 DOM 只增不减的问题，再继续优化。

### Stage 3

- 模式切换优化必须等 Stage 1/2 降低 DOM 后再做。
- 当前源码模式元素 444,085、模式往返后视觉 514,175，证明双宿主 DOM 是真实成本；不要通过离屏常驻加大内存压力。
- 建议把“模式切换后 DOM 元素数不得高于切换前一定比例”加入诊断门禁，防止隐藏 host 或 hydration 状态继续膨胀。

## 9. 验证与工作区

已运行：

- `npx tsc --noEmit`：通过
- `git diff --check`：通过
- 小文件 Stage 0 诊断：通过
- 大文件正式 Stage 0 诊断：通过

工作区当前未提交文件：

- `docs/performance-next-phase-plan-v2.md`（执行本 Stage 前已存在）
- `scripts/benchmark/stage0-diagnosis.ts`（本 Stage 新增）
- `docs/performance-stage0-diagnosis.md`（本 Stage 新增）

现有 `scripts/benchmark/performance.ts` 与 `src/renderer` 业务代码未修改。

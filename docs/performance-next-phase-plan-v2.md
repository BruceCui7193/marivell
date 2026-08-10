# Next Phase Plan v2: Large Markdown Release Line

本方案是对 `performance-next-phase-plan.md` 的下一阶段补充。它不是为了继续堆缓存，而是根据当前基准和一次失败实验，把“大文件流畅”改成可重复执行的长期工程标准。

## 1. 规划层

### 1.1 当前基线

默认基准文件：`/home/crh/下载/barfoot_ser24/barfoot_ser24.md`

当前已提交基线：`f3d99c0 perf: virtualize source editor and stabilize math layout (G1-G3)`

当前关键指标：

| 指标 | 当前值 |
| --- | ---: |
| visual-open | 10576 ms |
| renderer-render-to-ready | 7344 ms |
| markdown-parse | 2882.7 ms |
| document-dom-node-count | 255028 |
| paragraph-node-count | 6377 |
| inline-math-node-count | 5011 |
| inline-math-preview-active | 170 |
| inline-math-preview-placeholder | 4841 |
| interaction-typing | 302.5 ms |
| interaction-combined | 2444.5 ms |
| mode-switch-source-to-visual | 2948.1 ms |
| mode-switch-visual-to-source | 1288.5 ms |
| scroll-avg-frame | 181.2 ms |
| scroll-max-frame | 491.9 ms |
| scroll-jump-bottom | 1792.6 ms |
| scroll-jump-middle | 1592.1 ms |
| scroll-drag-sequence | 2574.9 ms |

当前已通过的硬门禁：

- `scrollDriftPx = 0`
- `viewportPlaceholders = 0`
- `inlineMathActivateReadyMs = 3.2`
- `inlineMathActivateMaxFrameMs = 3.4`
- 块级公式不裁剪、行内公式基线对齐测试通过

上一轮失败实验已经回退，结论必须保留：

- 候选滚动优化把 scroll-avg 从 181ms 降到 136ms、scroll-max 从 492ms 降到 401ms、drag 从 2574ms 降到 2043ms。
- 但 drag 后出现 `viewportPlaceholders = 1`、`inlineHeightDrift = 116px`，破坏硬门禁，因此整体回退到 `f3d99c0`。
- 结论：滚动优化不能继续在“先滚动、后激活、再补偿”的管线里叠加补丁；必须先解决拖拽期间文档高度物理稳定。

### 1.2 根因判断

1. KaTeX 懒渲染已经避免了公式 HTML 爆炸，但 255k DOM 节点仍然存在。当前瓶颈已经变成 PM 基础 DOM、隐藏 contentDOM、syntax decoration span、以及整树 style/layout/commit 成本。
2. `MathSyntaxHighlight` 在初始化时对整篇文档的行内公式生成 DecorationSet，并在每次事务中映射整棵装饰集。这是打开、输入、模式切换三个路径上最可疑的全局成本源。
3. 源码模式使用 `display: none` 隐藏视觉 host，切回可视化时需要重新 layout 整棵 DOM。这是 `source→visual` 2.9s 的最可能主因；不能靠“离屏常驻 255k 节点”解决，因为那是把成本转成长期内存和 GC 压力。
4. 行内公式从 placeholder 激活为 KaTeX 后，行高和上下延伸会改变，这是 drag 116px 漂移的直接来源。必须让激活不改变已滚动位置的文档物理高度。
5. React NodeView 当前数量较少，不是第一优先；只有 trace 证明 React commit 是主耗时后才值得逐个改写。

### 1.3 发布目标

| 指标 | 发布线目标 |
| --- | ---: |
| visual-open | < 5000 ms |
| renderer-render-to-ready | < 4000 ms |
| interaction-typing | < 100 ms |
| interaction-combined | < 1500 ms |
| mode-switch-source-to-visual | < 1000 ms |
| mode-switch-visual-to-source | < 1000 ms |
| scroll-avg-frame | <= 16.6 ms |
| scroll-max-frame | <= 33 ms |
| scroll-jump-ready | < 200 ms |
| scroll-drift | 0 px |
| viewport-placeholders | 0 |
| inline-math-activate-ready | <= 50 ms |
| inline-math-activate-max-frame | <= 4 ms |
| DOM 节点数 | 先降到 100k 以下，再以真实布局为准优化，不追求破坏底线的 15k |

### 1.4 架构底线

以下约束不可破坏：

1. 保持单一 ProseMirror 实例，不允许拆分多个编辑器。
2. 普通段落、列表项、表格等结构必须保留原生文本 DOM，不允许卸载离屏 `<p>`。
3. `inlineMath` 的 contentDOM 必须始终存在，以保留选区、IME、复制粘贴、坐标计算。
4. 不在 inline/inline-block 公式上使用 `content-visibility` 或 `contain: paint`；这些能力只允许用于块级容器。
5. 不默认切换 MathML。KaTeX 仍是默认渲染后端。
6. 不在每次按键时把整份 AST/JSON 从 worker 传回主线程。
7. 测试只允许补充更严格断言，不允许删除或放宽现有断言。
8. 不允许以“看起来更快”为由牺牲导出、搜索、大纲、脚注、复制粘贴、模式切换、Undo/Redo 等功能。
9. 每个 Stage 必须独立 commit，改动可回退；发生回归时优先回退到上一基线，而不是继续叠补丁。

### 1.5 阶段划分

- Stage 0：诊断与基准。先量化 255k DOM 的组成和每条热点路径的主耗时。
- Stage 1：Scoped MathSyntaxHighlight。去掉全文档 syntax decoration，保留编辑态/视口内局部装饰。
- Stage 2：滚动锁高与双缓冲 hydration。让滚动条拖到哪停到哪，激活不产生高度漂移。
- Stage 3：模式切换与布局。DOM 降低后再处理 `source→visual` 的 layout 成本。
- Stage 4：条件性 React NodeView 优化。只有 profiling 证明后再动手。
- Stage 5：发布门禁。完整回归、暴力测试、三次 benchmark。

## 2. 细节设计层

### 2.1 Stage 0：诊断与基准

#### 2.1.1 目标

确认 255k DOM 中哪些节点最多、哪些路径最贵，并留下可复现的基准，避免后续凭感觉优化。

#### 2.1.2 执行内容

1. 在 benchmark 或独立诊断脚本中新增 DOM 分类统计：
   - 元素总数、文本节点数。
   - 按标签统计：`p`、`div`、`span`、`pre`、`img`、`table`、`svg`。
   - 按 class 统计：`.math-inline-node`、`.math-node-content`、`.math-node-preview`、`.math-syntax-cmd`、`.math-syntax-brace`、`.math-syntax-special`、`.math-syntax-comment`、`.katex`、`.code-block-node`、`.image-node`、`.mermaid-node`、`.footnote-definition-node`。
   - decoration span 数量：通过 `document.querySelectorAll('.math-syntax-*').length` 统计。
2. 使用 PerformanceObserver 或 CDP trace 记录以下路径：
   - 打开文件到视觉就绪。
   - 一次普通输入。
   - 一次行内公式插入。
   - 一次 Undo/Redo。
   - 滚动条 top → middle → bottom → middle。
   - `source→visual` 与 `visual→source`。
   - 右键菜单打开。
3. 每个路径输出主线程 long task 次数、超过 50ms 的 task 分布、DOM 变更量。
4. 结果写入 `docs/performance-benchmark.md` 或新的 `docs/performance-stage0-diagnosis.md`。

#### 2.1.3 验收

- 明确找出前三个成本源，并有数据支撑。
- 不改业务行为，不新增会影响编辑性能的常驻逻辑。
- 允许只加诊断 instrumentation 的 commit；如果 instrumentation 本身导致性能明显下降，必须默认关闭。

### 2.2 Stage 1：Scoped MathSyntaxHighlight

#### 2.2.1 目标

把全文档 syntax decoration 改成“编辑态/视口内局部装饰”，目标是显著减少隐藏 span、打开时间、输入时间和模式切换时间。

#### 2.2.2 设计约束

1. 非编辑、离屏的行内公式只保留 PM 必需的原始文本节点，不生成 `.math-syntax-*` span。
2. 公式获得焦点、进入编辑态、或进入视口附近时，才允许为该公式注入 syntax decoration。
3. 任何 typing 事务都不得触发全文档 DecorationSet 重建或全量 `map`。
4. `contentDOM` 必须继续存在，不能被 `display: none` 或卸载替代。
5. 公式预览、选中、点击进入编辑、光标定位、复制粘贴行为必须保持现状。

#### 2.2.3 实现方向

`src/renderer/editor/plugins/math-syntax-highlight.ts`：

1. 移除初始化时的 `buildDecorationsForDoc(state.doc)` 全量调用。
2. 插件状态改为保存“当前需要装饰的局部范围”或“当前活跃公式位置集合”。
3. 装饰范围来源：
   - 当前 selection 是否落在 inlineMath 内；
   - 当前视口中心附近的 inlineMath 范围；
   - 显式编辑态公式。
4. 更新时机：
   - 滚动停止或 rAF 合并后；
   - selection 变化后；
   - 用户真正编辑公式内容时。
5. 事务 apply 时：
   - 如果 `tr.changedRange` 不触及 inlineMath，直接复用旧 DecorationSet；
   - 只有 changedRange 触及公式时，才重建局部装饰。
6. 增加诊断计数：全量构建次数、局部构建次数、装饰 span 总数。

`src/renderer/editor/extensions/math-inline.ts`：

1. 不改变 contentDOM 结构和激活逻辑。
2. 确保 `is-editing` 状态下 syntax decoration 正常显示。
3. 确保点击公式后先进入编辑态，再触发该公式的装饰刷新。

#### 2.2.4 测试

新增或加强：

- `pure-logic.test.ts`：syntax tokenizer 单测必须保留。
- 新增 e2e：
  - 打开大文档后非编辑态/离屏公式不包含 `.math-syntax-*`。
  - 点击进入公式编辑后对应公式包含 syntax span，其他公式不包含。
  - 滚动到含公式区域后，视口内公式允许有局部装饰，离屏公式不膨胀。
  - 源码/预览切换后无 selection marker 泄漏。
  - 复制粘贴公式仍保持 `$...$` 与原始 LaTeX。
  - 光标可进入公式、可退出公式。
- 全量回归：`npm test`、`npm run test:e2e`、`npx tsc --noEmit`、`git diff --check`。

#### 2.2.5 验收指标

- DOM 节点总数明显下降，记录 Stage 0 与 Stage 1 对比。
- visual-open、typing、source→visual、visual→source 不得回归。
- 所有硬门禁继续通过。
- 允许新增大文件 DOM 数预算，但不允许放宽已有门禁。

### 2.3 Stage 2：滚动锁高与双缓冲 hydration

#### 2.3.1 目标

让滚动条“拖到哪就停在哪、松手第一帧就是最终效果、0 drift、0 placeholder”，同时不破坏选区、IME、公式编辑和模式切换。

#### 2.3.2 核心模型

新增 `ScrollStabilizer` 或类似服务，职责：

1. 滚动开始时捕获：
   - `scrollTop`；
   - `scrollHeight`；
   - 是否在底部；
   - 当前视口顶部 PM 锚点；
   - 当前视口中心 PM 位置。
2. 在拖拽/高速滚动期间锁定文档总高度：
   - 使用顶部/底部 spacer 吸收所有 hydration 高度变化；
   - 保证浏览器滚动条滑块在鼠标下方物理稳定；
   - 不修改真实文档内容高度，只补偿 spacer。
3. 滚动停止后进入“收尾”阶段：
   - 等待视口内 hydration 全部完成；
   - 用双 rAF 校准真实 scrollHeight；
   - 释放 spacer 时重新测量锚点，确保 0 drift；
   - 如果 `scrollend` 不可靠，使用滚动事件时间戳和 rAF 判定停止。

#### 2.3.3 Hydration 调度

1. 调度完全移出 typing 热路径：
   - 打字事务只处理 changedRange；
   - 视口扫描、prefetch、activate 由滚动事件/rAF/`requestIdleCallback` 驱动。
2. 使用 PM position 索引和 LIFO 距离队列：
   - 只保留视口中心 ±2 屏任务；
   - 超过 4 屏的任务直接 evict；
   - 不调用大量 `getBoundingClientRect` 做全量扫描。
3. 块级公式：
   - 允许在隐藏测量层预渲染和缓存高度；
   - 激活时使用已准备的 DocumentFragment 在单帧内替换 placeholder；
   - 激活不得被裁剪，块级 wrapper 允许 `content-visibility`，但必须保证真实高度可用。
4. 行内公式：
   - 不允许依赖脱离段落上下文的通用 DocumentFragment 测量来保证零漂移；
   - 需要上下文感知的高度预留，或在该段落内创建隐藏 sample 测量真实 KaTeX 后再替换；
   - placeholder 到 KaTeX 的切换必须在一帧内完成，不能先显示错误高度再重排；
   - 保持 `vertical-align: baseline` 和 `$a$` 与普通文本底部对齐。
5. 段落级分组继续作为基础：
   - 不允许为每个公式挂 IntersectionObserver；
   - 以段落为单位批量激活；
   - 保持 `.math-inline-node` 不添加 `content-visibility` / `contain: paint`。

#### 2.3.4 测试

新增或加强：

- e2e：连续拖动 top → bottom → middle，断言：
  - 松手后第一帧 `viewportPlaceholders = 0`；
  - `scrollDriftPx = 0`；
  - `inlineHeightDrift = 0`；
  - 滚动条不跳回；
  - 目标位置内容真实可见。
- e2e：块级高矩阵不裁剪，inline 高公式不裁剪且基线对齐。
- e2e：拖拽后立即输入、Ctrl+A、跨段选择、源码/预览切换仍正常。
- e2e：滚动后导出 PDF/长图仍强制 hydrate，无 placeholder。
- 暴力测试：大文件连续滚动、极快滚动、滚动中切换源码模式。

#### 2.3.5 验收指标

- 硬门禁全部通过。
- 滚动 avg/max 和 jump-ready 相比 `f3d99c0` 必须明显下降。
- 不能出现“先 placeholder 再补渲染”的可见闪烁。
- 不允许通过牺牲 `source→visual` 或 typing 来换滚动。

### 2.4 Stage 3：模式切换与布局

#### 2.4.1 目标

在 DOM 和滚动优化完成后，解决 `source→visual` 剩余的全量 layout 成本。

#### 2.4.2 原则

1. 默认不采用“源码模式常驻离屏视觉 DOM”。
2. 先保持现有 `display: none` 方案，利用 Stage 1/2 降低 DOM 和布局成本。
3. 如果 DOM 降到合理水平后仍超预算，再按 trace 决定：
   - 对块级段落使用 `content-visibility: auto` 和准确的 `contain-intrinsic-size`；
   - 或缓存最近视口布局；
   - 或限制首次可见范围，滚动时增量补齐。
4. 不允许卸载普通段落，不允许把段落替换成无文本 placeholder。

#### 2.4.3 实现方向

1. 复用现有 `ModeSwitchCache` 和 fast-path：
   - 源码未变时不重新 parse；
   - 源码局部变化时只替换 changed block；
   - 切回视觉后先恢复原视觉 selection 和 scroll ratio。
2. 增加首帧测量：
   - `source→visual` 必须从正确滚动位置开始，不能先跳到顶部再回来；
   - 视觉首帧文本、公式、光标位置必须正确。
3. 如果使用 `content-visibility`：
   - 只允许块级元素；
   - 每个块需要可校验的高度或 `contain-intrinsic-size`；
   - 必须搭配锚点补偿，不能产生 jump。

#### 2.4.4 测试

- 已有 caret alignment e2e 全部保留。
- 新增大文件：源码模式编辑后切回视觉，断言编辑可见、光标位置正确、首帧滚动位置正确。
- 新增：连续来回切换多次不产生 marker 泄漏、不丢失内容、不触发全量 parse。
- 新增：切换后 Undo/Redo 只影响用户编辑，不清空文件。

#### 2.4.5 验收指标

- `source→visual < 1000ms`、`visual→source < 1000ms`。
- 无 marker 泄漏、无内容篡改。
- 所有既有模式切换测试通过。

### 2.5 Stage 4：条件性 React NodeView 优化

#### 2.5.1 触发条件

只有 trace 证明下列一项成立时才执行：

- React commit 时间占打开/模式切换/输入的显著比例；
- 某类 NodeView 的更新次数和 DOM 替换成本成为瓶颈。

#### 2.5.2 执行范围

按顺序逐个处理：

1. `CodeBlockView`
2. `ImageView`
3. `MermaidBlockView`
4. `FootnoteDefinitionView`
5. HTML block NodeView

每个改造保持：

- 与现有 schema、NodeView 交互、选择、复制粘贴、拖拽一致；
- 编辑器失焦、主题变化、图片路径变化等行为一致；
- 不引入新的 React 依赖或删减现有功能。

#### 2.5.3 验收

- 对应 e2e 全部通过。
- 对比改造前后 trace，确认 React commit 时间下降。
- 如果收益不足以抵消回归风险，保留原实现并记录原因。

### 2.6 Stage 5：发布门禁

最终验收顺序：

1. `npm test`
2. `npm run test:e2e`
3. `npx tsc --noEmit`
4. `git diff --check`
5. `npm run benchmark`
6. 连续三次 benchmark，至少两次达到发布预算
7. 更新 `docs/performance-benchmark.md` 和本方案文档
8. 按用户要求决定是否 push

发布候选只有在以上全部通过后才产生。

## 3. 分析测试层

### 3.1 硬约束测试

以下断言不得被删除或放宽：

- 大文件打开后源码/预览切换无 selection marker 泄漏。
- 打开文件后立即 Ctrl+Z 不清空文件。
- 源码模式编辑切回可视化后编辑可见、位置正确。
- 行内公式 `$a$` 与普通文本 `a` 底部偏差 <= 1px。
- 高矩阵/高公式不裁剪、overflow 可见、基线对齐。
- 滚动条拖到哪停在哪，松手 0 drift、0 placeholder。
- 导出 PDF/长图前强制 hydrate，导出内容完整。
- 搜索、大纲、脚注跳转两阶段执行，目标位置准确。
- 复制粘贴公式/代码块保持正确包裹语义。
- 图片粘贴、源码模式、预览模式、Undo/Redo 全部稳定。
- 不存在 `MDEDITORSELECTIONSTARTTOKEN` / `MDEDITORSELECTIONENDTOKEN` 泄漏。

### 3.2 暴力测试场景

除已有 fixtures 外，必须持续加入：

1. 超大论文文件：大量块级公式、行内公式、表格、代码块、图片、脚注。
2. 连续滚动条 top → bottom → middle → top，且中间随机暂停。
3. 滚动中立即切换源码模式，再切回预览。
4. 滚动到中部后立即输入、Ctrl+A、跨段拖选。
5. 在源码模式编辑公式，然后切回预览，检查公式渲染和光标。
6. 大量重复 Undo/Redo、复制粘贴、模式切换。
7. 空文件粘贴图片，切源码再切回。
8. 包含 literal token 的文件，确保不会被误替换。
9. 修改文件后外部程序改文件、未保存关闭提示。
10. 窗口 resize、主题切换、字体缩放后重新测量公式高度。
11. 导出 PDF/长图包含离屏公式、代码、图片、mermaid、脚注。
12. 英文/中文语言环境下侧栏和菜单文案正确。

### 3.3 性能指标

`perf-budget.json` 只允许新增真实门禁，不允许放宽现有门禁。

新增建议：

- `documentDomNodeCount`：Stage 0 记录，Stage 1 后作为趋势指标，初期不设死门禁。
- `syntaxDecorationSpanCount`：Stage 1 后必须显著下降。
- `longTaskCount`：打开、typing、滚动、模式切换各路径的长任务计数。
- `scrollDragReadyMs`：从松手到第一帧 0 placeholder 的时间。
- `scrollDragDriftPx`：拖拽松手后的锚点漂移。
- `sourceToVisualFirstFrameMs`：切回视觉首帧就绪时间。
- `visualToSourceFirstFrameMs`：切到源码首帧就绪时间。

### 3.4 子代理任务分配

#### 3.4.1 子代理通用约束

- 模型固定为 `deepseek-v4-flash`，reasoning effort 使用 `xhigh`，除非用户明确改口。
- 每个子代理只允许修改分配给自己的文件，禁止顺手改测试脚本作弊。
- 必须先读当前基线，再动手；不得从旧版本复制逻辑。
- 每项任务必须给出：修改文件清单、测试命令、前后数字、是否 commit。
- 如果出现回归，优先回退到最近基线，禁止通过删断言通过测试。
- MCP 视觉只能作为辅助，不能作为唯一证据；细节必须用 DOM/坐标探针验证。
- 完成后必须说明工作区是否干净、当前 commit hash。
- 如果子代理 complete 但没有回复，主代理应向其发送“继续”或让其补交最终结果。

#### 3.4.2 子代理 A：Stage 1

写范围：

- `src/renderer/editor/plugins/math-syntax-highlight.ts`
- `src/renderer/editor/extensions/math-inline.ts`
- 对应测试文件
- `scripts/benchmark/performance.ts`（只允许加诊断，不改变现有测量语义）

验收：

- 非编辑/离屏公式无 syntax span。
- 编辑态公式语法高亮正常。
- typing 不再全量重建 decoration。
- `npm test`、`test:e2e`、`tsc`、`git diff --check` 通过。
- benchmark 相比 `f3d99c0` 无回归。

#### 3.4.3 子代理 B：Stage 2

写范围：

- `src/renderer/components/EditorShell.tsx`
- `src/renderer/editor/virtualization/activation-controller.ts`
- `src/renderer/editor/virtualization/inline-math-group-registry.ts`
- `src/renderer/editor/virtualization/height-measurer.ts`
- `src/renderer/editor/extensions/math-inline.ts`
- `src/renderer/styles/editor.css`
- 对应 e2e 测试

验收：

- drag 0 drift、0 placeholder、无滚动条跳回。
- block math 不裁剪，inline math 基线对齐。
- 所有既有硬门禁通过。
- benchmark 滚动指标明显优于 `f3d99c0`。
- 必须先跑小文件，再跑大文件。

#### 3.4.4 子代理 C：Stage 3

写范围：

- `src/renderer/components/EditorShell.tsx`
- `src/renderer/components/EditorViewport.tsx` 或对应视图组件
- `src/renderer/styles/editor.css`
- 模式切换测试文件

验收：

- `source→visual`、`visual→source` 达到预算。
- 首帧滚动位置正确。
- 无 marker 泄漏、无内容篡改。
- 不采用源码模式常驻离屏视觉 DOM，除非用户明确批准。

#### 3.4.5 子代理 D：Stage 4（条件触发）

写范围：

- `src/renderer/editor/node-views/*`
- 对应扩展与测试

验收：

- trace 显示 React commit 时间下降。
- 相关功能 e2e 全部通过。
- 如果收益不足，保留原实现并给出证据。

### 3.5 主代理约束

1. 主代理负责统筹、审查、验证、commit，不替子代理写实现代码。
2. 子代理运行期间要耐心等待，不因等待时间长就亲自下场。
3. 收到子代理结果后先审查 diff，重点检查测试是否被放宽、是否只改了测试来通过。
4. 主代理可以独立运行测试和 benchmark 验证，但不得把验证结果当成子代理未完成工作的替代品。
5. 每个 Stage 完成后按阶段 commit，commit message 标明 Stage 和改动范围。
6. 不执行 `git reset --hard`、`git checkout --` 等破坏性命令；需要回退时先确认范围。
7. 如果用户要求 push，先确认当前分支和工作区干净，再 push。
8. 如果发现方案需要调整，先停下与用户讨论，不继续硬执行旧计划。

## 4. Git 与版本管理

1. 每个 Stage 一个独立 commit，避免“一坨大改动”。
2. 每个 commit 必须只包含该 Stage 的文件，测试和文档可随 Stage 提交。
3. `perf-report.json` 保持 gitignore，不提交。
4. 如果 Stage 失败：
   - 优先回退该 Stage 的 commit；
   - 在文档中记录失败原因和候选数字；
   - 不删除失败记录，因为它能防止下次重复踩坑。
5. 发布候选只在最终验收通过后产生；发布前是否需要 push 由用户决定。

## 5. 最终验收

1. 所有硬约束测试通过。
2. 所有暴力测试通过。
3. 发布预算连续三次 benchmark 至少两次达标。
4. `docs/performance-benchmark.md` 记录最终结果。
5. 本方案文档记录每个 Stage 的实际结果、失败实验和回退 commit。

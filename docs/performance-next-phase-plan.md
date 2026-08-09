# Next Phase Plan: Large Markdown Smooth Release Line

## 1. 规划层

### 1.1 目标

本阶段的目标不是继续堆缓存，而是把大型 Markdown 文档在真实交互中的卡顿来源系统性移除，最终达到可发布、可复现的流畅线。

默认基准文件：`/home/crh/下载/barfoot_ser24/barfoot_ser24.md`

当前关键指标：

| 指标 | 当前参考值 |
| --- | ---: |
| visual-open | 约 13.9s |
| renderer-render-to-ready | 约 10.9s |
| markdown-parse | 约 2.85s |
| interaction typing | 约 718ms |
| interaction combined | 约 5.9s |
| source→visual | 约 3.6s |
| visual→source | 约 7.9s |
| scroll-avg-frame | 约 81ms |
| scroll-max-frame | 约 457ms |

本阶段目标：

| 指标 | 发布线目标 |
| --- | ---: |
| visual-open | < 5s |
| renderer-render-to-ready | < 4s |
| interaction typing | < 100ms |
| interaction combined | < 1.5s |
| source→visual | < 1s |
| visual→source | < 1s |
| scroll-avg-frame | <= 16.6ms |
| scroll-max-frame | <= 33ms |
| scroll-jump bottom/middle/drag | 首帧 0 placeholder，0 drift |
| 功能回归 | npm test、test:e2e、tsc、benchmark 全部通过 |

### 1.2 架构约束

以下约束是本阶段不可破坏的底线：

1. 保持单一 ProseMirror 实例。不允许拆分多个编辑器。
2. 普通段落、列表项、表格等结构必须保留原生文本 DOM。不允许把离屏 `<p>` 卸载成无文本的 placeholder。
3. 行内公式可以懒渲染 KaTeX preview，但 PM 的 `inlineMath` contentDOM 必须始终存在，以保留选区、IME、复制粘贴、坐标计算。
4. 不默认切换 MathML。KaTeX 仍是默认渲染后端，MathML 最多作为可选实验项。
5. 不在每次按键时把整份 AST/JSON 从 worker 传回主线程。
6. 搜索、大纲、脚注、导出等跳转和捕获必须使用“强制激活 + 等待稳定 + 二次测量/导出”的流程。
7. 测试只允许补充更严格的断言，不允许为了通过而移除已有功能断言。

### 1.3 阶段划分

- Phase A：性能仪器化和预算门禁。先把 DOM 节点数、KaTeX 节点数、公式就绪率、滚动漂移等变成可测指标。
- Phase B：行内公式懒渲染。保留段落 DOM，只卸载离屏 KaTeX preview，并完成高度缓存和首帧预渲染。
- Phase C：交互热路径优化。把编辑事务限定到 changed range 和视口范围，清理 React NodeView 热点。
- Phase D：模式切换增量解析。源码未变时不做整文件 parse/serialize；源码局部变化时走增量映射。
- Phase E：滚动管线重构。用位置索引和 rAF 任务队列替代滚动时的全量扫描。
- Phase F：导出、搜索、大纲、脚注的强制 hydrate 与两阶段跳转。
- Phase G：发布门禁。跑完整回归、e2e、暴力测试、性能预算并记录报告。

## 2. 细节设计层

### 2.1 性能仪器化

`scripts/benchmark/performance.ts` 需要新增以下指标：

- `document-dom-node-count`：`document.querySelectorAll('*').length`
- `paragraph-node-count`：`document.querySelectorAll('.editor-surface p').length`
- `katex-node-count`：`document.querySelectorAll('.math-node-preview .katex').length`
- `inline-math-node-count`：`document.querySelectorAll('.math-inline-node').length`
- `inline-math-preview-active`：当前已渲染 KaTeX 的 inline math 数量
- `inline-math-preview-placeholder`：当前仍为轻量占位的 inline math 数量
- `scroll-first-frame-ready`：快速滚动停止后的首帧是否无占位
- `inline-height-drift`：inline math 从占位切换为完整 KaTeX 后当前视口顶部锚点偏移
- `mode-switch-no-reparse`：source→visual 是否走了缓存/增量路径，而不是全量 parse

每个指标都必须在报告中输出，并写入 `perf-report.json`。

新增 `perf-budget.json`：

```json
{
  "visualOpenMs": 5000,
  "rendererReadyMs": 4000,
  "typingMs": 100,
  "interactionCombinedMs": 1500,
  "modeSwitchSourceToVisualMs": 1000,
  "modeSwitchVisualToSourceMs": 1000,
  "scrollAvgFrameMs": 16.6,
  "scrollMaxFrameMs": 33,
  "scrollJumpReadyMs": 200,
  "scrollDriftPx": 0,
  "viewportPlaceholders": 0
}
```

### 2.2 行内公式分组懒渲染

这是 Phase B 的核心。

#### 2.2.1 不做什么

- 不删除离屏段落。
- 不把 paragraph 换成 placeholder NodeView。
- 不隐藏或移除 `inlineMath` 的 contentDOM。
- 不在滚动到目标时才异步 render KaTeX。

#### 2.2.2 数据结构

新增 `InlineMathGroupRegistry`：

```ts
interface InlineMathGroup {
  id: string;
  paragraph: HTMLElement;
  firstPmPos: number;
  lastPmPos: number;
  formulas: Set<InlineMathRegistration>;
  active: boolean;
  requested: boolean;
  heightKnown: boolean;
}
```

注册规则：

- 每个包含 inline math 的 paragraph 最多一个 group。
- 公式 NodeView 创建时加入所在 paragraph 的 group。
- 公式 NodeView destroy 时从 group 移除。
- group 为空时注销。
- 所有 group 按 `firstPmPos` 排序，提供二分查找。

#### 2.2.3 激活状态

每个 inline math 有四种状态：

- `raw-placeholder`：显示轻量 monospace `$latex$`，保留尺寸和 PM contentDOM。
- `prepared`：KaTeX HTML 已生成并缓存，尚未插入 DOM。
- `active`：preview 已插入完整 KaTeX HTML。
- `editing`：用户正在编辑公式，始终 active，且不能降级。

默认初始状态是 `raw-placeholder`。

#### 2.2.4 激活流程

滚动或跳转时：

1. 通过 `posAtCoords` 或滚动比例估算视口中心 PM pos。
2. 从 group 索引中找出中心 group。
3. 以中心 group 为锚点，向前后各取一组公式，作为 prefetch window。
4. prefetch window 内缺失的 KaTeX HTML 优先由 worker 生成。
5. 下一帧开始前，把 viewport window 内 `prepared` 的公式 HTML 同步插入 DOM。
6. 首帧必须已经显示完整 KaTeX，不允许出现“先 raw 后 KaTeX”的视觉闪烁。

快速拖动时：

- 使用 `scrollTop` 目标值更新 center group。
- 废弃所有距离过远的 pending 任务。
- 每个 rAF 只激活有限数量，单帧预算 <= 4ms。
- 如果目标区域公式还没有 HTML，首帧至少显示 raw placeholder，但必须立即后台渲染并在 50ms 内替换；该场景必须有单独指标跟踪。

#### 2.2.5 高度稳定

行内公式必须沿用 block math 的 height cache：

- key 使用 `getFormulaHeightKey(latex, 'no')`，覆盖宽度、主题、缩放、字体版本。
- `raw-placeholder` 必须设置与真实公式一致的 `min-height` / `line-height`。
- 未测量公式在激活前先进入隐藏测量层测量。
- 激活时如果高度与占位不同，不允许直接改变 DOM 高度；先更新缓存并做 scrollTop 补偿。
- 同一会话中，已激活 inline formula 默认不 deactivate，避免来回滚动时反复 FOUC。

#### 2.2.6 NodeView 更新规则

`math-inline.ts` 的 update 需要改为：

- 节点 text 未变化时不触发任何 preview 更新。
- 节点不在 viewport window 内时只更新内部 metadata，不渲染 preview。
- 节点激活后才渲染当前最新 latex。
- 节点正在编辑时强制 active。
- 不影响 `contentDOM`、Backspace、ArrowLeft/Right、InputRule、复制粘贴等现有行为。

### 2.3 滚动管线

当前 `hydrateVisibleAroundRatio` 会扫描全部 virtual nodes，并读取大量 `getBoundingClientRect`，这是长任务来源之一。

Phase E 需要：

1. 把 block math、inline math group、image、mermaid 统一进“按 PM pos 排序的 hydration index”。
2. 滚动事件只调度 rAF，不在 scroll handler 内同步扫描。
3. rAF 内先丢弃过期任务，再处理当前视口中心附近任务。
4. 使用 `scrollend` / idle 补齐 prefetch window。
5. 拖拽滚动条时继续锁定总 scrollHeight，用 spacer 消化占位到真实高度之间的差值。
6. 每次滚动后记录 viewport 顶部锚点 PM pos，下一次激活/降级时以该锚点补偿。

### 2.4 交互热路径

Phase C 需要：

1. 所有 decoration 插件都只重建 `transaction.changedRange()` 附近的 decoration。
2. 大文件编辑时，搜索、大纲、行号、统计更新必须完全移出 typing 热路径。
3. 离屏 inline math group 不因全局事务更新而重渲染。
4. React NodeView 中仍明显占用成本的组件改成 vanilla NodeView，优先检查 code block、footnote、image。
5. 每条命令 benchmark 必须能区分“PM 事务时间”和“DOM 渲染时间”。

### 2.5 模式切换增量解析

Phase D 需要：

1. 新增 `ModeSwitchCache`：

```ts
interface ModeSwitchCache {
  sourceText: string;
  canonicalVisualMarkdown?: string;
  pmVersion: number;
  sourceToPmAnchor?: Map<string, number>;
}
```

2. source→visual 时：

- 如果源码未变，直接使用现有 PM 文档，只映射 selection，禁止全量 `setContent`。
- 如果源码局部变化，先判断变化是否跨块。未跨块时把源编辑转成 PM transaction，只更新 changed range。
- 如果跨块结构变化，再回退到 worker 全量 parse；该回退路径必须有指标统计。

3. visual→source 时：

- 如果没有视觉编辑，直接使用缓存 source 文本和 selection，不重新 serialize。
- 如果有视觉编辑，只序列化 changed range，并尽量复用旧 source 中未变化部分。

### 2.6 导出、搜索、大纲、脚注

所有跳转必须两阶段：

1. `forceActivate` 目标 group 和相邻 group，并等待激活完成。
2. 重新测量目标 DOM，再执行最终滚动/选中。

导出 PDF 和长图前：

1. 调用 `forceHydrateAll()`。
2. 等待 inline math 和 block math 全部 active。
3. 等一帧稳定后再导出。
4. 导出完成后恢复虚拟化。

### 2.7 文件级职责

建议改动范围：

- `src/renderer/editor/extensions/math-inline.ts`
- `src/renderer/editor/virtualization/activation-controller.ts`
- `src/renderer/editor/virtualization/inline-math-group-registry.ts`（新增）
- `src/renderer/editor/virtualization/height-cache.ts`
- `src/renderer/editor/virtualization/height-measurer.ts`
- `src/renderer/editor/position-map.ts`
- `src/renderer/editor/markdown.worker.ts`
- `src/renderer/components/EditorShell.tsx`
- `src/renderer/editor/plugins/math-syntax-highlight.ts`
- `scripts/benchmark/performance.ts`
- `scripts/tests/*`

## 3. 分析测试层

### 3.1 硬约束测试

以下测试必须全部通过：

1. 现有 `npm test`、`npm run test:e2e`、`npx tsc --noEmit`。
2. `caret-alignment.e2e.test.ts` 必须继续通过，不允许为性能放宽 PM 位置断言。
3. 新增 `inline-math-lazy.e2e.test.ts`：
   - 打开包含大量 inline math 的文档。
   - 视口内公式必须 active。
   - 离屏公式允许 placeholder，但不得丢 contentDOM。
   - 光标进入离屏公式时必须先激活再编辑。
4. 新增 `inline-math-scroll.e2e.test.ts`：
   - top → middle → bottom 快速拖动。
   - 停止后首帧视口内无 placeholder。
   - 顶部锚点 drift 必须为 0。
5. 新增 `mode-switch-incremental.e2e.test.ts`：
   - 源码未变切换必须走 fast path。
   - 段落内编辑切换后内容和光标必须正确。
   - 跨块编辑允许回退全量 parse，但不能丢内容或泄漏 marker。
6. 新增 `export-hydrate.e2e.test.ts`：
   - PDF 导出和长图导出前强制 hydrate。
   - 导出结果包含所有公式，不包含占位符。
7. 新增 `selection-ime-violence.test.ts`：
   - 跨段落鼠标拖拽选区。
   - Ctrl+A、Ctrl+C、Ctrl+V。
   - 中文 IME 在含未激活公式的段落中输入。
   - 在公式内编辑时切换源码模式再切回。

### 3.2 暴力测试

继续扩展 `mode-switch-violence.test.ts` 和 `feature-violence.test.ts`：

- 随机源码偏移 + 随机编辑长度 + 随机切换次数。
- 每轮后检查 marker leak、内容稳定性、PM selection 与 source selection 是否一致。
- 公式内容包含 `\frac`、`\sqrt`、矩阵、对齐环境、`\tag`、转义字符。
- 文档中同时混入大量图片、表格、代码块、Mermaid、脚注、HTML block。
- 在快速滚动中触发导出。
- 在激活队列未完成时触发 undo/redo。
- 在窗口 resize / zoom / 主题切换时激活公式。
- 文件名和内容包含 `MDEDITORSELECTIONSTARTTOKEN` 等字面 token。
- 粘贴超大文本、图片、公式后再模式切换。

所有暴力测试的断言只允许增加，不允许把失败改成忽略。

### 3.3 性能软约束

性能测试不是一次通过即可，需要连续 3 次 benchmark：

- 3 次中至少 2 次满足预算。
- 单次最低分不能低于预算 30% 以上。
- 每次必须记录 DOM node count、KaTeX node count、scroll drift、mode-switch path。
- 如果 inline math lazy 后滚动仍超标，先分析 DOM 数量，再决定是否继续优化表格/文本段落；禁止直接卸载段落绕过。

### 3.4 子代理任务分配

主代理保留统筹权：整合代码、审查测试是否作弊、运行最终全量验证、决定是否回退。

子代理统一使用 `deepseek-v4-flash`，reasoning effort 使用 `xhigh`。每个子代理只允许修改指定文件，完成后必须报告：

为减少主代理上下文消耗，Agent B-F 每个实现代理在交付前必须自行运行 `npm test`、`npm run test:e2e`、`npx tsc --noEmit`、`git diff --check`；如果失败，先自己修到通过再汇报。主代理不重复逐条运行，只做合并后的最终验收。禁止把失败测试留给主代理。共享工作区时必须串行调度全量测试；只有使用独立 fork 时才能并行运行。

- 修改文件列表
- 运行过的测试命令和结果
- 是否有测试被改动及原因
- 是否新增 debug 代码

#### 主代理统筹约束

主代理的任务是统筹和验收，不是替子代理写代码。以下约束写入本阶段执行规则：

- 子代理运行期间，主代理不得抢先修改该子代理负责的文件，也不得因等待时间较长而“下场亲自干活”。
- 子代理未返回前，主代理只做不冲突的统筹工作：审查其他已返回 Agent 的 diff、整理测试结果、更新计划状态、准备下一步指令。
- 等待时要有耐心，使用较长超时；不要因为几分钟没有输出就误判失败、提前收尾或重复派发同一个任务。
- 如果子代理结果不满意，先给出具体返工意见，让同一 Agent 返工；不要立刻另起 Agent 重做同一件事。
- 只有子代理明确无法继续、任务范围失控或返回了明显作弊实现时，主代理才能接管；接管后必须在最终说明中写明原因。
- 主代理不得在共享工作区里与正在运行的子代理同时执行全量测试或修改同一文件；共享工作区必须串行，独立 fork 才能并行。
- 主代理必须审查子代理的测试改动，禁止通过删断言、放宽断言、跳过测试或 mock 掉真实渲染来换取通过。
- 主代理应要求子代理报告失败命令的完整错误，而不是只报告“失败”；返工信息必须包含可复现证据。
- 主代理应在收到每个 Agent 交付后及时关闭不再需要的 Agent，避免并发计数被已完成 Agent 占满。
- 主代理在最终验收前不轻易接受“时间不够”作为未跑测试的理由；Agent B-F 的 npm test、test:e2e、tsc 必须自跑并汇报。

#### 版本管理与防白干

- 每个阶段开始前，主代理先记录当前分支、最近 commit、`git status --short` 和 `git diff --stat`，作为本次工作的基线。
- 如果工作区已有用户改动，不允许 `git stash`、`git reset --hard`、`git checkout -- .`、`git clean -fd`，也不允许把这些改动当作“可以丢弃的临时内容”。
- 子代理默认不提交、不推送、不合并，只交代码和报告；用户已确认阶段验收通过后可直接 commit，由主代理统一负责 commit，避免多个子代理制造混乱历史。
- 主代理应把当前 `git diff` 和未跟踪文件清单保存到仓库外（例如 `/tmp/marivell-baseline.diff` 和 `git ls-files --others --exclude-standard`），防止上下文压缩或 Agent 异常后丢失状态。
- 共享工作区必须串行：一个子代理返回前，不派发下一个会改动同一文件的子代理；不跑会修改仓库状态的命令。
- 独立 fork 返回后，主代理应先用 `git diff --stat`、`git diff --check` 和 `git status` 审查，再决定如何合入；不要盲目全量覆盖当前工作区。
- 每次整合前检查是否出现计划外文件改动；发现后先定位来源，不直接删除或还原。
- 用户已确认采用“效果变好、无功能回归即可 commit”的策略：每个 Phase 通过对应测试后默认独立 commit，方便后续 `git revert` 或 `git log` 定位；只有最终验收通过后才作为 release 候选。
- 回退优先使用 `git revert` 或从已保存 commit/补丁恢复，绝不使用 `git reset --hard`。
- benchmark、`perf-report.json`、临时 out/profile 目录应明确是否纳入 git；默认不提交临时产物，避免污染版本历史。
- 主代理最终报告必须包含：基线 commit、本阶段 commit、关键文件列表、测试/benchmark 结果、是否有未提交用户改动。

#### 额外执行建议

- 主代理应把每个 Agent 的验收标准写进派发消息，不只写“实现某个功能”，还要写清文件范围、禁止事项、测试命令和交付格式。
- 不建议一次并行派发所有实现 Agent。先让 Agent A 和 Agent B 落地指标与 inline math lazy，主代理验证后再并行派发 C/D/E/F。
- Agent B 交付后，主代理应先跑一次完整 `npm test` 和 `npm run test:e2e`，确认没有把架构搞坏，再进入后续阶段。
- benchmark 必须与全量测试分开执行，不要在跑 npm test 的同时跑 benchmark，避免互相制造长任务污染数据。
- 性能预算不满足时，优先做 profile 定位瓶颈，再决定是继续优化还是回退；不要通过放宽预算来“达成目标”。
- jsdom 单测只能验证逻辑，不能验证滚动、IME、导出、选区视觉连续性；这些必须放到真实 Electron e2e。
- 子代理返回的测试摘要应包含测试名/命令，不能只报数字；主代理抽查关键断言，防止“测试通过但断言变弱”。
- 如果主代理上下文接近压缩，不要重新全量扫描仓库，优先读取本计划文档、Agent 的最终报告和当前 git diff。
- 每个阶段通过测试后默认直接 commit，不必等最终验收；commit message 需标明阶段或改动范围，release 候选仍只在最终验收通过后产生。

#### Agent A：Benchmark 仪器化

- 范围：`scripts/benchmark/performance.ts`、`perf-budget.json`
- 任务：新增 DOM/KaTeX/inline formula/scroll drift/mode-switch path 指标；输出 perf-report。
- 验证：`npm run benchmark`、`npx tsc --noEmit`。
- 禁止：修改业务代码来制造好看的数字。

#### Agent B：Inline Math Lazy

- 范围：`math-inline.ts`、新增 inline math group registry、height-measurer 扩展。
- 任务：实现 raw-placeholder/prepared/active 状态机、group 注册、worker prefetch、首帧激活。
- 验证：相关单测 + `npm run test:e2e` + benchmark DOM 指标。
- 禁止：删除 contentDOM、破坏公式编辑/复制粘贴/输入规则。

#### Agent C：交互热路径

- 范围：math-syntax-highlight、search-highlight、node-views、EditorShell 中编辑同步逻辑。
- 任务：changedRange 约束、避免离屏重渲染、React NodeView 转 vanilla。
- 验证：`npm test`、`npm run test:e2e`、benchmark interaction 指标。
- 禁止：用缓存掩盖功能错误。

#### Agent D：模式切换增量

- 范围：EditorShell、position-map、markdown.worker。
- 任务：ModeSwitchCache、source 未变 fast path、段落内增量 transaction、跨块回退指标。
- 验证：caret-alignment e2e、mode-switch violence、benchmark mode-switch 指标。
- 禁止：在未变时走全量 parse 或全量 setContent。

#### Agent E：滚动管线

- 范围：activation-controller、EditorShell、hydration-queue。
- 任务：位置索引、rAF 合并、任务废弃、spacer 高度锁定、scrollend prefetch。
- 验证：inline-math-scroll e2e、scroll benchmark。
- 禁止：把 placeholder 当作“已渲染”来通过测试。

#### Agent F：导出与跳转

- 范围：导出代码、EditorShell 搜索/大纲/脚注跳转、forceHydrateAll。
- 任务：强制 hydrate、等待稳定、两阶段跳转、导出后恢复。
- 验证：export-hydrate e2e、现有导出测试。
- 禁止：跳过导出前的完整 hydrate。

### 3.5 最终验收顺序

1. Agent A 先落地指标和预算。
2. Agent B 实现 inline math lazy，主代理审查后再进入后续 Agent。
3. Agent C/D/E/F 在不相交文件范围内并行推进。
4. 主代理合并后运行：
   - `npm test`
   - `npm run test:e2e`
   - `npx tsc --noEmit`
   - `git diff --check`
   - `npm run benchmark`
5. 3 次 benchmark 达到预算后，才允许进入发布流程。

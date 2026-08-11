# performance-next-phase-plan-v3

## 0. 愿景与原则

用户对“性能很好”的定义不可退让：

1. 加载、编辑、各类操作时间极致的短；
2. CPU、内存、GPU 等负载足够低；
3. 不破坏任何现有功能和硬约束；
4. 不再零散打补丁，而是做深入、甚至独创的底层优化。

v3 的核心变化：上一版把 `scroll 16.6/33ms`、`jump 200ms`、`DOM <10k` 等当作“终极但另议”的远期目标，本版正式把它们纳入 v3 的验收路线，由底层架构实验承担，而不是降低标准。

铁律：

- 硬功能门禁三档一致、永不放宽：`scrollDriftPx=0`、`viewportPlaceholders=0`、`inline-height-drift=0`、无 marker 泄漏、公式基线偏差 <=1px、高公式不裁剪、导出强制 hydrate、复制粘贴语义正确、打开后立即 Ctrl+Z 不清空。
- `perf-budget.json` 只增不改松，测试只允许加严断言。
- 每个 Stage 独立 commit；回归优先回退，失败实验数据保留。

## 1. 当前状态与关键结论

### 1.1 当前量级

基于最新文档与 benchmark：

| 指标 | 当前最佳 |
| --- | ---: |
| visual-open | ~4,964ms |
| renderer-ready | ~3,733ms |
| typing | ~145-155ms |
| interaction-combined | ~1,270-1,417ms |
| mode-switch visual->source | ~536-700ms |
| mode-switch source->visual | ~790-950ms |
| scroll-avg | ~150ms |
| scroll-max | ~263-360ms |
| jump-ready | ~790-1,450ms |
| 视口真实 KaTeX ready | ~901ms（6 个可见节点） |
| visual host DOM | ~45,967 |
| source mode visual host DOM | ~24,573 |

### 1.2 已确认的瓶颈事实

- 公式 HTML 已在 Worker 中预渲染并缓存（约 4,780 条，chunk 处理约 30ms），900ms 的真实 KaTeX ready 不是主线程同步执行 KaTeX JS。
- `inline-math-viewport-katex-max-frame-ms=0` 说明 6 个可见公式一旦开始注入，单帧内即可完成；900ms 主要花在滚动停止判定、hydration 调度、队列等待或缓存同步。
- 滚动帧剩余成本主要是 `MathSyntaxHighlight` 的 viewport `posAtCoords`、PM 坐标/layout 和大 DOM 的 layout，而不是公式高度测量。
- React NodeView 不是主瓶颈（Stage 4a），因此默认轨不再以 React 重构为主。
- `content-visibility` 用于段落、`left:-10000px` 离屏 host 已被验证会破坏 PM 坐标或导致严重回归，后续实验必须绕开这些已证伪路径。

## 2. 三档目标

语义：

- 合格：发布底线，hard gate，发布必须全部满足。
- 优秀：Default Track 目标。
- 终极：Ultimate Track 目标，v3 必须持续逼近并用真实 benchmark 验证。

| 指标 | 合格 | 优秀 | 终极 |
| --- | ---: | ---: | ---: |
| visual-open | <=5,000ms | <=3,500ms | <=1,500ms |
| renderer-ready | <=4,000ms | <=2,800ms | <=1,000ms |
| typing | <=150ms | <=100ms | <=33ms |
| interaction-combined | <=1,500ms | <=1,000ms | <=500ms |
| mode-switch 两向 | <=1,000ms | <=700ms | <=300ms |
| scroll-avg | <=150ms（不回归） | <=50ms | <=16.6ms |
| scroll-max | <=300ms | <=100ms | <=33ms |
| jump-ready | <=800ms | <=400ms | <=200ms |
| 视口真实 KaTeX ready | <=300ms | <=150ms | <=50ms |
| visual host DOM | <=60k | <=40k | <=15k |
| source host DOM | <=30k | <=25k | <=10k |
| idle CPU（10s） | 基线后定值 | <=3% | <=1% |
| idle long task（10s） | =0 | =0 | =0 |
| heap 3 次模式切换循环增量 | <=10MB 且回落 | <=5MB | <=2MB |
| GPU 进程会话增长 | 基线后定值 | <=50MB | <=20MB |

## 3. 双轨架构

### 3.1 Default Track

- 分支：`perf/performance-optimization`。
- 低风险、可直接合并。
- 保持单一 PM 实例、不卸载普通 `<p>`、inlineMath contentDOM 常在、inline 元素不用 `content-visibility`/`contain:paint`。
- 目标：达到“优秀”档，并为 Ultimate Track 提供诊断基线和公共基建。

### 3.2 Ultimate Track

- 每个实验一条独立分支：`perf/ultimate-u<n>-<slug>`。
- 使用 feature flag：`MARIVELL_ULTIMATE_U<n>=1`；flag off 时行为必须与 Default Track 等价。
- 每个实验必须有四件套：最小 PoC、功能等价性门禁、失败回退、量化合并判据。
- Ultimate Track 可以突破默认轨的实现约束，但不能破坏默认轨背后的能力：selection、IME、复制粘贴、搜索跳转、坐标、导出、Undo/Redo、无 marker 泄漏。

### 3.3 功能等价性门禁

新增 `scripts/tests/ultimate-equivalence.e2e.test.ts`，对每个 Ultimate 实验以 flag on/off 双跑：

- selection：视口内、跨视口、全选后 anchor/focus 一致；
- IME：composition 输入正常上屏；
- 复制粘贴：视口内、视口外、跨虚拟区复制语义一致；
- 搜索跳转：命中后滚动就位，偏差 <=1px；
- 坐标：`posAtCoords`/`coordsAtPos` 与未虚拟化偏差 <=1px；
- 导出：无 placeholder；
- 模式切换、Undo/Redo、marker：现有全套断言一致。

任一项不通过则禁止合并。

## 4. Default Track

### D1 全链路成本归因诊断

- 任务：拆解 900ms KaTeX ready、滚动帧、typing 三条路径的成本。
- 写范围：新建 `scripts/benchmark/stage5-diagnosis.ts`；`performance.ts` 只加诊断字段；产品文件只允许 benchmark-gated 临时插桩，结束即回退。
- 通过：每条路径给出 >=80% 成本归因；插桩扰动 <5%。
- 失败：关闭插桩重测，不进入下一阶段。

### D2 公式 DOM 注入路径 PoC

- 任务：对比 `innerHTML`、`insertAdjacentHTML`、`template+cloneNode`、`Range.createContextualFragment`、JSON+createElement、`setHTMLUnsafe`。
- 场景：一次性插入与重激活循环（热路径）。
- 决策：重激活 p95 为主判据；赢家至少快 15%；一次性插入回归 >20% 一票否决。
- 写范围：PoC 脚本、`virtualization/` 注入工具、对应 e2e。

### D3 滚动零变更帧

- 任务：普通滚动帧零 DOM/style 变更、零 layout 读取。
- 重点：把 `MathSyntaxHighlight` 的 viewport 刷新移出滚动帧；滚动事件只记录 scrollTop；settle 后同步扫描兜底。
- 写范围：`math-syntax-highlight.ts`、`EditorShell.tsx`、`activation-controller.ts`、`editor.css`、滚动 e2e。
- 通过：scroll-avg <=50ms、max <=100ms；滚动帧 rect 读=0；硬门禁全绿。

### D4 跳转即时 hydration

- 任务：取消大跳转/端点的 300ms 防抖等待，同 rAF 内立即 hydrate 视口集合；注入走 D2 赢家路径。
- 写范围：`activation-controller.ts`、`inline-math-group-registry.ts`、`EditorShell.tsx`、jump e2e。
- 通过：jump <=400ms、katex-ready <=150ms；drift/placeholder 不回归。

### D5 typing 热路径优化

- 任务：输入路径零全文档 decoration 重建、零 rect 读；对块级容器试验 `contain: layout style`。
- 写范围：`math-syntax-highlight.ts`、`math-inline.ts`、`editor.css`、typing/caret e2e。
- 通过：typing <=100ms；caret-alignment 不回归。

### D6 窗口化 IO 安全网

- 任务：用位置索引选候选（窗口参数化，实测 300/500/1000），IO 只观察未 hydrate 占位节点，entry 只入队；大跳转同步路径兜底。
- 写范围：`EditorShell.tsx`、`activation-controller.ts`、`inline-math-group-registry.ts`、`scroll-io.e2e.test.ts`。
- 通过：每帧开销 p95 <=1ms；hard 门禁全绿。

### D7 UIFF/BFR 首帧契约

- 任务：实现 CDP 探针式“用户可交互首帧”与“后台完整就绪”；overlay 从就绪关键路径移除。
- 写范围：`performance.ts`、模式切换组件、两个新 e2e。
- 通过：光标可落、输入回显、视口真实、滚动稳定、无遮罩、坐标可用；mode-switch <=700ms。

### D8 资源基线

- 任务：实现 `scripts/benchmark/resource-metrics.ts`，跑 3 轮基线，给出门禁建议值。
- 写范围：benchmark、资源 e2e、主进程桥接。
- 通过：3 轮稳定、数值可解释。

### D9 发布门禁

- 主代理执行：`npm test`、`npm run test:e2e`、`npx tsc --noEmit`、`git diff --check`、`npm run benchmark` 连续三次至少两次通过合格档。
- 输出优秀/终极档达成度报告。

## 5. Ultimate Track

### U1 块级虚拟化或等价替代

- 分支：`perf/ultimate-u1-block-virtualization`
- 目标：DOM <=15k、scroll 16.6ms、open <=1,500ms。
- 机制：不用 `content-visibility`；使用高度占位 + 合成坐标服务 + 模型驱动剪贴板。
- PoC：块偏移表、坐标偏差、Slice vs DOM 序列化一致性、窗口化后 DOM 数、posAtCoords 命中率。
- 风险：跨虚拟区选区、Ctrl+A、搜索命中虚拟区、高度未命中。
- 合并：等价性套件全过 + 三档 benchmark 达标后才合并。

### U2 公式渲染后端降维

- 分支：`perf/ultimate-u2-formula-backend`
- 目标：katex-ready <=50ms、公式 DOM 骤降。
- 机制：非编辑态公式单节点化（OffscreenCanvas/位图或 SVG）；编辑态保留 KaTeX HTML；失败自动回退 HTML。
- PoC：节点数、注入耗时、基线、高矩阵裁剪、DPR 清晰度、像素 diff、内存。
- 预计合并：高置信，但必须满足全部门禁。

### U3 滚动与坐标计算底层化

- 分支：`perf/ultimate-u3-coord-engine`
- 目标：scroll 16.6/33ms、typing <=33ms、jump <=200ms。
- 机制：块偏移表 + 行内增量维护，包裹 `posAtCoords`/`coordsAtPos`；编辑层独立合成层，滚动帧零变更。
- PoC：坐标偏差 <=1px、查询 p95 <=0.5ms、滚动帧 rect 读=0。
- 合并：坐标引擎精度证明后合并；合成器滚动部分无论整体是否合并都优先并入默认轨。

### U4 模式切换极速化

- 分支：`perf/ultimate-u4-mode-switch`
- 目标：两向 <=300ms。
- 机制：在 Stage 3a/3c/3d 降本后的 host 上重试 `transform` 离屏 + 独立合成层，避免 `left` 定位的 layout 回归。
- 前置：U4.0 PoC 必须先证明 visual->source 无回归。
- 回退：flag off -> `display:none`（Stage 3d 现行为）。

### U5 CPU/内存/GPU 极致治理

- 分支：`perf/ultimate-u5-resource-governance`
- 目标：idle CPU <=1%、heap 增量 <=2MB、GPU 增长 <=20MB、idle long task=0。
- 机制：计时器清零审计、后台工作迁入 rIC/Worker、合成层精简、Worker 队列深度治理。
- 合并：资源指标最终成为 hard gate。

### 依赖与顺序

```
D1 -> D2 -> D3 -> D4 -> D5 -> D6 -> D7 -> D9
U3.0 -> U1
U2 可与默认轨并行
U4 可与默认轨并行，U4.0 先行
D8 -> U5
```

## 6. 资源门禁

所有资源指标最终都进入 hard gate，不只做趋势：

- idle CPU：主进程 `app.getAppMetrics()` renderer CPU% + rAF gap；
- long task：`PerformanceObserver('longtask')` + LoAF；
- heap：`performance.memory` + CDP `Runtime.getHeapUsage`；
- DOM：TreeWalker + `Memory.getDOMCounters`；
- Worker：响应元数据 `queueMs/processMs` + 队列深度；
- GPU：`app.getAppMetrics()` GPU 进程内存。

D8 先采 3 轮基线，D9/U5 强制为 hard gate。

## 7. 执行与子代理约束

- 子代理模型固定 `deepseek-v4-flash`，reasoning effort `xhigh`。
- `fork_context: false`，不继承主对话上下文；禁止嵌套子代理。
- 写范围隔离；禁止删断言、放宽门禁、修改 perf-budget 变松。
- 独立阶段优先并行：D1、D8、U3.0-PoC 在写范围隔离时可以先并行；D2 依赖 D1，U1 依赖 U3.0 和剪贴板等价手段。
- 每个 Stage 独立 commit；失败实验保留文档；Ultimate 未达合并判据只保留隔离分支。
- 主代理负责统筹、审查、验证、commit；子代理负责实现和自测，但自测结果不作为唯一证据。

## 8. 首个执行窗口

在用户批准后，优先启动：

1. D1：全链路成本归因诊断，为所有后续阶段提供数据；
2. U3.0-PoC：坐标引擎最小验证，是 U1 的前置，也是滚动/跳转终极目标的关键路径；
3. D8 可以并行采集资源基线。

这三个任务写范围隔离，可以并行派发。

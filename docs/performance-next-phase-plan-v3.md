# performance-next-phase-plan-v3

## 0. 愿景与不可退让原则

用户定义的“性能很好”是：

1. 加载、编辑、各类操作时间极致的短；
2. CPU、内存、GPU 等负载足够低；
3. 不破坏任何现有功能和硬约束；
4. 不再零散打补丁，而是做深入、甚至独创的底层优化。

本计划不再把“终极性能”当作远期免责声明。`16.6/33/200ms`、DOM 数量、模式切换、资源负载等终极目标全部进入 v3 的验收路线，由独立的底层架构实验承担并验证。

铁律：

- 硬功能门禁三档一致、永不放宽。
- `perf-budget.json` 只增不改松；测试只允许加严。
- 每个 Stage 独立 commit；失败实验保留数据与文档。
- 高风险实验必须在独立分支和 feature flag 下验证；未经等价性门禁不得合并。
- 子代理只负责实现和自测，主代理负责审查、复测、提交与把关。

## 1. 仓库现状与关键证据

### 1.1 当前分支与基线

- 分支：`perf/performance-optimization`
- 当前已提交：
  - `4d8bb58` Stage 2h：滚动端点与释放后稳定性修复
  - `bbe6d8e` Stage 2g：滚动 hydration 延迟与 prefetch churn 治理
  - `0562663` Stage 2f：公式高度空闲预取
  - `689f29b` Stage 2e：typing 与滚动中心优化
  - `9f4c329` Stage 3d：模式切换 <1s

### 1.2 当前 benchmark 量级

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
| scroll-jump-ready | ~790-1,450ms |
| 视口真实 KaTeX ready | ~901ms（6 个可见节点） |
| visual host DOM | ~45,967 |
| source mode visual host DOM | ~24,573 |

### 1.3 已确认的根因

1. 900ms 的真实 KaTeX ready 不是主线程同步执行 KaTeX JS。现有 Worker 已预渲染约 4,780 条公式 HTML，chunk 处理约 30ms；`inline-math-viewport-katex-max-frame-ms=0` 说明一旦开始注入，6 个公式单帧完成，剩余时间主要是滚动停止判定、hydration 调度、队列等待和缓存同步。
2. 滚动帧成本主要来自 `MathSyntaxHighlight` 的 viewport `posAtCoords`、PM 坐标/layout 和大量 DOM 的浏览器 layout，而不是公式高度测量。
3. React NodeView 不是主瓶颈（Stage 4a 已证明），默认轨不需要以 React 重构为主。
4. `content-visibility` 用于段落、`left:-10000px` 离屏 host 已被验证会破坏 PM 坐标或造成严重回归；后续实验必须绕开这些已证伪路径。
5. 当前模式切换两向已稳定 <1,000ms，但距离 <300ms 还需要低层布局/host 策略，而不是继续堆 overlay 和 rAF。

### 1.4 必须保留的功能契约

以下能力在 Default Track 与 Ultimate Track 中都必须可验证：

- selection：视口内、跨视口、Ctrl+A；
- IME：中文/日文等 composition 输入；
- 复制粘贴：视口内、视口外、跨虚拟区、公式/代码块包裹语义；
- 搜索/大纲/脚注跳转；
- `posAtCoords`/`coordsAtPos` 光标坐标；
- PDF/长图导出；
- Undo/Redo；
- 无 `MDEDITORSELECTION*` marker 泄漏；
- 打开文件后立即 Ctrl+Z 不清空。

## 2. 三档目标与测量契约

### 2.1 指标语义

- 合格：发布底线，hard gate，发布必须全部满足。
- 优秀：Default Track 目标。
- 终极：Ultimate Track 目标，v3 必须持续逼近并最终用真实 benchmark 验证。

### 2.2 目标表

| 指标 | 当前最佳 | 合格 | 优秀 | 终极 |
| --- | ---: | ---: | ---: | ---: |
| visual-open | ~4,964ms | <=5,000ms | <=3,500ms | <=1,500ms |
| renderer-ready | ~3,733ms | <=4,000ms | <=2,800ms | <=1,000ms |
| typing | ~145-155ms | <=150ms | <=100ms | <=33ms |
| interaction-combined | ~1,270-1,417ms | <=1,500ms | <=1,000ms | <=500ms |
| mode-switch 两向 | ~536-950ms | <=1,000ms | <=700ms | <=300ms |
| scroll-avg | ~150ms | <=150ms（不回归） | <=50ms | <=16.6ms |
| scroll-max | ~263-360ms | <=300ms | <=100ms | <=33ms |
| jump-ready | ~790-1,450ms | <=800ms | <=400ms | <=200ms |
| 视口真实 KaTeX ready | ~901ms | <=300ms | <=150ms | <=50ms |
| visual host DOM | ~45,967 | <=60,000 | <=40,000 | <=15,000 |
| source host DOM | ~24,573 | <=30,000 | <=25,000 | <=10,000 |
| idle CPU（10s） | 未采集 | 基线定值 | <=3% | <=1% |
| idle long task（10s） | 未采集 | 0 | 0 | 0 |
| heap 3 循环增量 | 未采集 | <=10MB 且回落 | <=5MB | <=2MB |
| GPU 进程会话增长 | 未采集 | 基线定值 | <=50MB | <=20MB |

### 2.3 测量契约

所有 benchmark 默认使用：

- 大文件：`/home/crh/下载/barfoot_ser24/barfoot_ser24.md`
- 小文件：`/home/crh/文档/Machine_Learning_25D/面向不同车型的2.5D野外地形风险感知路径规划：机器学习与搜索算法双向嵌套完整方案.md`
- 滚动场景：wheel 连续滚动、scrollbar drag、jump
- 首次打开包含 Worker 解析、字体与本地图片加载，不含网络下载
- 硬件基线：当前开发机，记录 CPU/RAM/Chromium 版本，不允许只报“更快”而不报条件

新增指标必须写入 `perf-report.json` 趋势区；只有稳定可复测的才进入 `perf-budget.json`。

## 3. 双轨架构

### 3.1 Default Track

- 分支：`perf/performance-optimization`
- 低风险、可合并。
- 保持单一 PM 实例、不卸载普通 `<p>`、inlineMath contentDOM 常在、inline 元素不用 `content-visibility`/`contain:paint`。
- 目标：达到“优秀”档，并为 Ultimate Track 提供诊断基线和公共基建。

### 3.2 Ultimate Track

- 每个实验一条独立分支：`perf/ultimate-u<n>-<slug>`
- feature flag：`MARIVELL_ULTIMATE_U<n>=1`
- flag off 时行为必须与 Default Track 等价。
- 每个实验必须有：
  1. 最小 PoC；
  2. 功能等价性门禁；
  3. 失败回退；
  4. 量化合并判据。
- Ultimate Track 可以突破默认轨实现约束，但不能破坏 §1.4 能力契约。

### 3.3 功能等价性门禁

新增 `scripts/tests/ultimate-equivalence.e2e.test.ts`，对每个 Ultimate 实验以 flag on/off 双跑：

| 能力 | 探针 |
| --- | --- |
| selection | 视口内点击、跨视口拖选、Ctrl+A，anchor/focus 一致 |
| IME | compositionstart/update/end 上屏一致 |
| 复制粘贴 | 视口内、视口外、跨虚拟区，LaTeX/代码包裹语义一致 |
| 搜索跳转 | 命中目标后滚动就位，偏差 <=1px |
| 坐标 | 全页采样网格偏差 <=1px |
| 导出 | PDF/长图无 placeholder |
| 模式切换/Undo/Redo/marker | 现有全套断言一致 |

任一项不通过则禁止合并。

## 4. Default Track 阶段明细

### D1 全链路成本归因诊断

#### 目标

把 900ms 真实 KaTeX ready、滚动帧、typing 三条路径拆到可执行优化粒度。

#### 任务

1. 为 KaTeX ready 增加全链路时间戳：
   `scrollTop 设置 -> scroll handler -> hydration rAF 调度 -> rAF 触发 -> 中心/锚点映射 -> 队列/evict -> 缓存三态查找 -> DOM 注入 -> 隐藏 sample 测量 -> swap -> 首帧 .katex -> benchmark 观察全量`
2. 记录滚动帧内：
   - DOM/style 变更次数；
   - `MathSyntaxHighlight` 的 `posAtCoords` 调用；
   - PM dispatch 次数；
   - rect 读取次数；
   - long task 分布。
3. 记录 typing 事务内：
   - decoration map 重建；
   - rect 读取；
   - dispatch；
   - reflow 范围。
4. 审计 benchmark 是否把 Stage 2g 的 300ms scrollend 防抖和双 rAF 采样算进 ready。

#### 写范围

- 新建：`scripts/benchmark/stage5-diagnosis.ts`
- 允许加诊断字段：`scripts/benchmark/performance.ts`
- 产品文件仅允许 benchmark-gated 临时插桩，任务结束必须回退。

#### 通过/失败/回退

- 通过：三路成本归因 >=80%，插桩扰动 <5%。
- 失败：扰动 >5% 则默认关闭插桩重测；归因不足则补测，不进入 D2。

#### 产出

- `docs/performance-stage5-diagnosis.md`
- 三路相位表、原始数据、结论。

### D2 公式 DOM 注入路径 PoC 与应用

#### 目标

找到大文档公式注入的最优路径，不假设 `innerHTML` 是最终答案。

#### 任务

1. 对比：
   - `innerHTML`
   - `insertAdjacentHTML`
   - `<template>+cloneNode`
   - `Range.createContextualFragment`
   - JSON 树 + `createElement`
   - `setHTMLUnsafe`（feature-detect）
2. 两场景：
   - 一次性插入；
   - 重激活循环：插入 -> deactivate -> 从缓存重插，10 轮。
3. 语料：200 条分层真实公式 + 全量 4,780 条。
4. 公平协议：5 次预热 + 20 次测量，取 median/p95，round-robin 交错，独立 BrowserWindow，记录 heap 与 long task。
5. 不依赖本环境为 0 的 CDP layout 计数。

#### 写范围

- 新建：`scripts/benchmark/dom-injection-poc.ts`
- 允许：`src/renderer/editor/virtualization/` 注入工具、对应 e2e。

#### 通过/失败/回退

- 通过：重激活 p95 比现状快 >=15%；一次性插入回归 <=20%；应用后 katex-ready <=300ms，单帧激活 <=4ms，硬门禁全绿。
- 失败：无赢家则保留现状，归档“不触发”记录。

### D3 滚动零变更帧

#### 目标

普通滚动帧零 DOM/style 变更、零 layout 读取。

#### 任务

1. `MathSyntaxHighlight` viewport 装饰刷新移出滚动帧，只在 scrollend/rAF 合并后执行。
2. 滚动事件处理器只记录 scrollTop；装饰、锚点、hydration 全部延后。
3. 编辑内容层提升为独立合成层。
4. 保留 settle 后同步扫描兜底：0 placeholder、0 drift。
5. 新增滚动帧诊断指标：`scroll-frame-dom-mutations`、`scroll-frame-rect-reads`、`scroll-frame-posatcoords`。

#### 写范围

- `src/renderer/editor/plugins/math-syntax-highlight.ts`
- `src/renderer/components/EditorShell.tsx`
- `src/renderer/editor/virtualization/activation-controller.ts`
- `src/renderer/styles/editor.css`
- 滚动相关 e2e

#### 通过/失败/回退

- 通过：scroll-avg <=50ms、max <=100ms；滚动帧 DOM/style 变更=0、rect 读=0；硬门禁全绿。
- 失败：任一硬门禁回归，整 commit 回退。

### D4 跳转即时 hydration 与调度修复

#### 目标

消除大跳转/端点的 300ms 防抖等待，让视口在单个 rAF 内 ready。

#### 任务

1. 大跳转/端点取消 300ms scrollend 防抖。
2. 同一 rAF 内用已缓存 HTML + `drainQueue` 立即 hydrate 视口集合。
3. 跳转目标 LIFO 提权。
4. 注入走 D2 赢家路径。
5. 保留 <=50ms 同步 fallback。

#### 写范围

- `src/renderer/editor/virtualization/activation-controller.ts`
- `src/renderer/editor/virtualization/inline-math-group-registry.ts`
- `src/renderer/components/EditorShell.tsx`
- jump 相关 e2e

#### 通过/失败/回退

- 通过：jump <=400ms、katex-ready <=150ms，drift/placeholder 不回归。
- 失败：drift/placeholder 回归则回退。

### D5 typing 热路径优化

#### 目标

输入路径零全文档 decoration 重建、零 rect 读，只触 changedRange。

#### 任务

1. 普通输入只更新 changedRange。
2. 对块级容器试验 `contain: layout style`，不在 inline 公式上使用。
3. 新增 typing 诊断：`typing-decoration-rebuilds`、`typing-rect-reads`。

#### 写范围

- `src/renderer/editor/plugins/math-syntax-highlight.ts`
- `src/renderer/editor/extensions/math-inline.ts`
- `src/renderer/styles/editor.css`
- typing/caret e2e

#### 通过/失败/回退

- 通过：typing <=100ms；caret-alignment、基线、裁剪门禁全绿。
- 失败：caret-alignment 失败则撤销 contain。

### D6 窗口化 IO 安全网

#### 目标

用低成本 IO 预触发视口 hydration，但不引入 16k 观察器税。

#### 任务

1. 用位置索引选候选窗口（参数化 300/500/1000，实测后取最优）。
2. 单一 IntersectionObserver，只观察未 hydrate 占位节点。
3. IO entry 只入队，大跳转同步路径与 settle 后扫描兜底不变。
4. 新增 `scroll-io-overhead` A/B：匀速滚动 300 帧。

#### 写范围

- `src/renderer/components/EditorShell.tsx`
- `src/renderer/editor/virtualization/activation-controller.ts`
- `src/renderer/editor/virtualization/inline-math-group-registry.ts`
- 新增 `scripts/tests/scroll-io.e2e.test.ts`

#### 通过/失败/回退

- 通过：每帧开销 p95 <=1ms，观察数达最优档，硬门禁全绿。
- 失败：整 commit 回退。

### D7 UIFF/BFR 首帧契约

#### 目标

定义并实现“用户可交互首帧”与“后台完整就绪”，禁止用遮罩掩盖未就绪。

#### 任务

1. UIFF 六探针：
   - 光标可落：点击后 selection 存在且偏差 <=4px；
   - 输入回显：`insertText("x")` <=100ms；
   - 视口真实：0 placeholder，可见公式真实 `.katex`；
   - 滚动稳定：连续 10 rAF scrollTop 不变，layout-shift=0；
   - 无遮罩：`elementFromPoint` 命中内容，overlay 从 DOM 移除；
   - 坐标可用：`posAtCoords` 5 点采样非 null。
2. BFR 清单：
   - 高度缓存 100%；
   - 视口外 decoration；
   - 搜索/大纲/stats；
   - Worker 队列清空；
   - idle 5s 零 long task；
   - 期限：open+10s，手势抢占后台。
3. 模式切换在 Stage 3d 基础上压到 <=700ms。

#### 写范围

- `scripts/benchmark/performance.ts`
- 模式切换相关组件
- 新增 `scripts/tests/first-frame-contract.e2e.test.ts`
- 新增 `scripts/tests/deferred-work-preemption.e2e.test.ts`

### D8 资源基线

#### 目标

采集资源指标的三轮基线，给出门禁建议值。

#### 任务

1. 实现 `scripts/benchmark/resource-metrics.ts`。
2. 采集：
   - renderer CPU%（`app.getAppMetrics()` + rAF gap）；
   - long task（PerformanceObserver + LoAF）；
   - JS heap（`performance.memory` + `Runtime.getHeapUsage`）；
   - DOM（TreeWalker + `Memory.getDOMCounters`）；
   - Worker queue/process；
   - GPU 进程内存。
3. 跑 3 轮，输出分布、p50/p95/max、门禁建议值。

#### 写范围

- `scripts/benchmark/`
- 主进程采样桥接
- 新增 `scripts/tests/resource-baseline.e2e.test.ts`

### D9 发布门禁

主代理执行：

1. `npm test`
2. `npm run test:e2e`
3. `npx tsc --noEmit`
4. `git diff --check`
5. `npm run benchmark` 连续三次，至少两次通过合格档全集
6. 输出优秀/终极档达成度报告
7. 更新 `docs/performance-benchmark.md`

## 5. Ultimate Track 阶段明细

### U1 块级虚拟化或等价替代

#### 目标与分支

- 目标：DOM <=15k、scroll 16.6ms、open <=1,500ms。
- 分支：`perf/ultimate-u1-block-virtualization`
- flag：`MARIVELL_ULTIMATE_U1=1`

#### 机制

1. 窗口化块级 DOM：视口 ±N 屏与选区覆盖范围保持真实 DOM，其余使用高度精确占位。
2. 合成坐标服务：对虚拟区位置回答 `posAtCoords`/`coordsAtPos`，真实 DOM 区直通 PM。
3. 模型驱动剪贴板：复制序列化从 PM doc Slice 生成，不依赖 DOM 走查。

#### PoC 字段

- 块偏移表构建耗时；
- 偏移表 vs 真实 rect 偏差 p50/p95/max；
- Slice vs DOM 序列化一致率；
- 窗口化后 DOM 节点数；
- `posAtCoords` 命中率与回退次数；
- 小步滚动帧 A/B。

#### 等价性与风险

- 必须保留：跨虚拟区选区、Ctrl+A、搜索命中、IME、复制粘贴。
- 失败回退：flag off -> 全量 DOM。
- 合并判据：等价性套件全过；DOM <=15k；scroll avg/max/jump 达标；3 轮 benchmark 稳定。

### U2 公式渲染后端降维

#### 目标与分支

- 目标：katex-ready <=50ms、公式 DOM 骤降。
- 分支：`perf/ultimate-u2-formula-backend`
- flag：`MARIVELL_ULTIMATE_U2=1`

#### 机制

1. 非编辑态公式单节点化：OffscreenCanvas 位图或 SVG。
2. 编辑态/焦点公式保留 KaTeX HTML。
3. 渲染失败自动回退 HTML，不允许新增 `katex-error`。

#### PoC 字段

- 每公式 DOM 节点数对比；
- 单节点注入 p50/p95；
- 基线偏差；
- 高矩阵裁剪；
- DPR 1/1.5/2 清晰度；
- 像素 diff；
- 内存增量；
- 导出路径高分辨率验证。

#### 合并判据

- DOM 降 >=60%；
- 注入 p95 <=2ms；
- 基线 <=1px；
- 高矩阵不裁剪；
- katex-ready <=50ms；
- 导出 e2e 全过。

### U3 滚动与坐标计算底层化

#### 目标与分支

- 目标：scroll 16.6/33ms、typing <=33ms、jump <=200ms。
- 分支：`perf/ultimate-u3-coord-engine`
- flag：`MARIVELL_ULTIMATE_U3=1`

#### 机制

1. 块偏移表 + 块内行偏移增量维护；
2. 包裹 `view.posAtCoords`/`view.coordsAtPos`；
3. 编辑层独立合成层，滚动帧零变更。

#### PoC 字段

- 坐标引擎 vs PM 原生偏差全网格；
- 单次查询 p50/p95；
- 偏移表增量更新耗时；
- 滚动帧 rect 读计数；
- 滚动帧 A/B。

#### 合并判据

- 坐标偏差 <=1px；
- 查询 p95 <=0.5ms；
- 滚动帧 rect 读=0；
- caret/搜索/跳转 e2e 全过。

### U4 模式切换极速化

#### 目标与分支

- 目标：两向 <=300ms。
- 分支：`perf/ultimate-u4-mode-switch`
- flag：`MARIVELL_ULTIMATE_U4=1`

#### 机制

1. 在 Stage 3a/3c/3d 降本后的 host 上重试 `transform` 离屏 + 独立合成层。
2. 布局只算一次，切换 = 合成器 transform 交换 + 单 rAF 恢复选区/滚动。
3. idle 预热目标模式 host。

#### PoC

对比 `display:none` / `left` 定位 / `transform` 三种方案：

- 两向切换耗时；
- LayoutDuration 增量；
- host 内存与 GC；
- 重复切换 10 轮内存斜率；
- 首帧滚动位置；
- caret 对齐。

#### 前置与回退

- U4.0 必须先证明 visual->source 无回归；
- 回退：flag off -> `display:none`（Stage 3d）。

### U5 CPU/内存/GPU 极致治理

#### 目标与分支

- 目标：idle CPU <=1%、heap 增量 <=2MB、GPU 增长 <=20MB、idle long task=0。
- 分支：`perf/ultimate-u5-resource-governance`
- flag：`MARIVELL_ULTIMATE_U5=1`

#### 机制

1. 计时器清零审计：枚举所有后台 `setTimeout`/`setInterval`/rAF，迁入 rIC/Worker。
2. 合成层精简：审计 `will-change` 和层提升。
3. Worker 队列深度上限，输入/滚动路径零同步等待。
4. 手势到来即抢占后台。

#### PoC 字段

- idle 10s long task 与 rAF gap；
- renderer/GPU CPU%；
- heap 斜率；
- 合成层数量与 GPU 内存；
- Worker 队列深度 p95；
- Worker process p95。

## 6. 资源门禁

所有资源指标最终都进入 hard gate：

| 指标 | 采集接口 | 合格 | 优秀 | 终极 |
| --- | --- | ---: | ---: | ---: |
| idle CPU | `app.getAppMetrics()` renderer CPU% + rAF gap | 基线定值 | <=3% | <=1% |
| long task | `PerformanceObserver('longtask')` + LoAF | idle 10s=0 | 各路径收紧 | 近零 |
| heap | `performance.memory` + `Runtime.getHeapUsage` | <=10MB 且回落 | <=5MB | <=2MB |
| DOM | TreeWalker + `Memory.getDOMCounters` | <=60k/<=30k | <=40k/<=25k | <=15k/<=10k |
| Worker | 响应元数据 queueMs/processMs | 输入/滚动零 long task | 队列 p95 <=16 | 队列近零 |
| GPU | `app.getAppMetrics()` GPU 内存 | 基线定值 | <=50MB | <=20MB |

D8 先采 3 轮基线，D9 与 U5 强制为 hard gate。

## 7. 子代理任务书模板

每个子代理任务必须包含：

1. 目标；
2. 背景与当前基线；
3. 允许写范围；
4. 禁止写范围；
5. 必须保留的功能与测试；
6. 实施步骤；
7. 验证命令；
8. 通过/失败判据；
9. 回退方式；
10. 产出物；
11. 报告格式；
12. 最终 git status。

## 8. 并行策略

### 8.1 可以并行

- D1、D8、U3.0-PoC：写范围基本隔离。
- D8 与 D3-D7：资源基线不依赖其它优化。
- U2 与默认轨：独立分支。
- U4 与默认轨：独立分支，U4.0 先行。

### 8.2 必须串行

- D2 依赖 D1。
- D3-D7 依赖 D1 的结论。
- U1 依赖 U3.0 坐标引擎和模型驱动剪贴板。
- D9 依赖全部默认轨阶段。

## 9. Git 与版本管理

- Default Track 每个 Stage 独立 commit。
- Ultimate Track 每个实验独立分支，分支内每阶段独立 commit。
- 失败实验保留文档与数据，不删除。
- `perf-report.json` gitignore。
- 回退优先整 commit/整分支回退，不使用破坏性 git 命令。
- flag 默认 off；合并后等价性测试保留进 CI。

## 10. 最终验收

1. v2 硬约束与暴力测试全部保留并继续扩充。
2. `npm run benchmark` 连续三次，至少两次通过合格档全集。
3. 输出优秀/终极档达成度报告。
4. Ultimate Track 已合并实验的等价性测试全部进 CI。
5. `docs/performance-benchmark.md` 记录最终结果与失败实验。
6. 是否 push 由用户决定。

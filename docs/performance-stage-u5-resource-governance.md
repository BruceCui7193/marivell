# U5 CPU/内存/GPU 极致治理实现记录

分支：`perf/performance-optimization`
任务：v3 U5“CPU/内存/GPU/后台 idle 极致治理”。
约束：不提交、不 push；不修改 `perf-budget.json`；不跑
`barfoot_ser24.md` 大文件 benchmark。

## 1. 范围与产出

本阶段在允许写范围内完成：

- `src/renderer/components/EditorShell.tsx`
- `src/renderer/editor/virtualization/height-measurer.ts`
- `src/renderer/styles/editor.css`
- `scripts/benchmark/resource-metrics.ts`
- `scripts/tests/resource-baseline.e2e.test.ts`
- 新增 `scripts/benchmark/resource-governance-audit.ts`
- 新增 `docs/performance-stage-u5-resource-governance.md`

`src/renderer/editor/virtualization/inline-math-group-registry.ts` 已阅读，
未做行为改动；其预取请求仍由 EditorShell 的 Worker 队列统一治理。

## 2. 后台计时器审计与处理

### 2.1 本轮实际迁移

| 原调度 | 位置 | 本轮处理 |
| --- | --- | --- |
| `scheduleIdleWork` 固定 `setTimeout` | EditorShell | 改为 `requestIdleCallback({ timeout })`，无 rIC 时回退 `setTimeout` |
| source preview 60ms | EditorShell | 迁入 rIC，timeout 120ms |
| visual meta sync 260ms | EditorShell | 迁入 rIC，timeout 260ms |
| visual document sync 1400ms | EditorShell | 保持 `scheduleIdleWork`，现在实际走 rIC |
| scroll settle 300ms | EditorShell | 迁入 rIC，timeout 360ms |
| formula HTML 处理 | EditorShell | 已是 rIC，保留 |
| height measurement | height-measurer | 已是 rIC，新增手势暂停位 |

### 2.2 必须常驻或保留的调度

以下仍保留同步/帧内语义，不迁移到 idle：

- `skipNextDocChangeTimer`（0ms）：必须在下一次任务边界清除，避免程序化加载被误判为用户编辑。
- `applySideEffects`（0ms）：模式切换首帧后的副作用边界。
- 滚动 hydration rAF、锚点补偿 rAF、模式切换恢复 rAF：需要跟随帧提交。
- 搜索输入回焦 50ms：属于用户交互路径。
- source gutter/highlight transform：由 SourceEditor 内 rAF/滚动同步驱动。

### 2.3 全 renderer 常驻调度枚举

除 EditorShell 外，审计范围内还有：

- `App.tsx`：一次性 rAF 启用 EditorShell。
- `SourceEditor.tsx`：高亮防抖 `setTimeout` 24/60/80ms，本轮未在写范围。
- `icons.tsx`：rIC + 回退 timeout。
- `liquid-glass.ts`：rAF 合并刷新 + 420ms settle；本轮不修改，避免破坏 liquid glass。
- `Toolbar.tsx`：布局 rAF。
- `activation-controller.ts`：pending activation / hydration rAF。
- `coordinate-service.ts`：有限 tick rAF。
- `math-syntax-highlight.ts`：scrollend 防抖 + rAF，D3 契约路径。

## 3. 手势抢占

- 保留 D7 的 `preemptionSkips`、`lastPreemptedAt` 计数。
- `keydown/pointerdown/input` 继续记录 `lastEditorInteractionAtRef`。
- 新增 `height-measurer.setHeightMeasurementInteractionPaused(true)`，手势后
  1400ms 内暂停离屏公式高度测量；恢复由 rIC 调度。
- 公式 HTML 处理继续在近 1500ms 交互窗口内跳过并重排，避免 typing/滚动路径
  被后台处理抢占。

## 4. Worker 队列深度与背压

### 4.1 新增诊断字段

`__marivellFormulaChunkDiagnostics` 与
`__marivellGetDeferredWorkDiagnostics` 现在暴露：

- `queueDepth` / `formulaChunkQueueDepth`
- `inFlightCount` / `formulaChunkInFlightCount`
- `pendingFormulaHtmlChunks`
- `formulaHtmlProcessingScheduled`
- `formulaChunkPumpThrottled`
- `formulaChunkPumpThrottleCount`
- `maxFormulaChunkQueueDepth`
- `maxPendingFormulaHtmlChunks`

`scripts/benchmark/resource-metrics.ts` 已把上述字段写入
`WorkerDiagnostics`、快照、idle/activity 汇总和 metric rows。

### 4.2 背压策略

- `FORMULA_CHUNK_MAX_IN_FLIGHT = 2` 保持 Worker 在途上限。
- 新增 `FORMULA_CHUNK_MAX_PENDING_HTML_CHUNKS = 6`。
- 当主线程待处理 HTML chunk 达到 6 个时，暂停继续向 Worker 发送新 chunk。
- 当 rIC 消费到 <=4 个 pending chunk 时恢复 pump。
- `workerQueueEmpty` 语义不变：queue、in-flight、pending HTML、
  processing scheduled 全部为 0 才算清空，BFR 断言继续生效。
- 小文件低于 Worker 阈值，因此本轮小文件 queue/pending 全为 0；大文件队列
  p95 留给主代理独占复测。

## 5. 合成层/GPU 治理

### 5.1 本轮 CSS 改动

- `.editor-host` 保留 `transform: translateZ(0)`、`will-change: transform`、
  `contain: layout style`，D3 合成层滚动优化不破坏。
- editor 内容层新增守卫：`.editor-host .editor-surface`、
  `.ProseMirror`、`.math-node-preview`、`.katex` 不额外提升，
  显式 `will-change: auto; transform: none`。
- source 模式的 `.source-editor__gutter-window` 和
  `.source-editor__highlight-content` 去掉常驻 `will-change`。
- source 模式下隐藏的 toolbar 元素由 27 个 transform 降至 5 个，
  避免 22 个隐藏按钮持续携带 transform 提升。
- liquid glass 相关 `will-change: opacity` 与 `[data-liquid-glass]`
  规则未修改。

### 5.2 小文件合成层审计

运行：

```bash
npx tsx scripts/benchmark/resource-governance-audit.ts
```

| 模式 | elements | will-change | transform | backdrop-filter | CDP layer count | GPU working set |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| visual | 5,917 | 2 | 5 | 4 | 15 | 171.78 MB |
| source | 4,577 | 1 | 5 | 4 | 21 | 177.34 MB |

CDP `LayerTree` 的 bounds/backingStore 在本次 Electron 会话中返回 0，
因此 layer count 只作为数量趋势，不作为绝对面积。

## 6. 资源门禁候选

本阶段不修改 `perf-budget.json`。候选建议值写入文档，待主代理大文件复测后决定：

| 指标 | 候选门禁 |
| --- | --- |
| idle long task | 10s/30s = 0 |
| idle rAF gap | p95 <= 20ms |
| idle 30s heap delta | <= 2MB 且可回落 |
| 会话 heap 增量 | <= 10MB |
| 小文件 TreeWalker DOM | <= 9,000 |
| 小文件 CDP DOM | <= 15,000 |
| GPU 会话增长 | <= 20MB |
| idle CPU | <= 6% 趋势，终极 <=1% |
| Worker queue depth | p95 <= 16 chunks |
| Worker pending HTML | <= 6 chunks |
| Worker process p95 | 大文件复测后定 |

## 7. 小文件资源数据

文件：`/home/crh/文档/Machine_Learning_25D/面向不同车型的2.5D野外地形风险感知路径规划：机器学习与搜索算法双向嵌套完整方案.md`
（67,878 bytes）。`RESOURCE_ROUNDS=1` 单轮实测：

| 指标 | 结果 |
| --- | ---: |
| open heap | 15.44 MB |
| open DOM TreeWalker/CDP | 8,535 / 10,581 |
| open GPU | 170.47 MB |
| idle10 renderer CPU | 3.09% |
| idle10 rAF p95 | 17.00 ms |
| idle10 long task / LoAF | 0 / 0 |
| idle10 heap delta | 0.98 MB |
| idle10 DOM delta | 0 |
| mode-switch 3 cycles | 666 ms |
| scroll round trip | 572 ms |
| idle30 CPU 10s 窗口 | 2.30% / 3.69% / 2.00% |
| idle30 rAF p95 | 17.20 ms |
| idle30 long task / LoAF | 0 / 0 |
| idle30 heap delta | -3.37 MB |
| final heap | 14.37 MB |
| final DOM TreeWalker/CDP | 9,659 / 20,202 |
| final GPU | 177.70 MB |
| Worker queue/pending | 全 0（小文件未触发 Worker 预取） |

小文件 idle CPU 单轮为 3.09%，仍未达到终极目标 1%；本轮不据此放宽门禁，
候选 idle CPU 仍保持 <=6%，终极目标由后续大文件复测继续跟踪。

## 8. 验证

- `npm test`：通过
- `npx tsc --noEmit`：通过
- `git diff --check`：通过
- `resource-baseline.e2e.test.ts`：13 passed
- `resource-governance-audit.ts`：可运行

后续仍需按任务书验证 `first-frame-contract`、`deferred-work-preemption`、
`scroll-endpoints`。

## 9. 状态

READY_FOR_LARGE_BENCHMARK

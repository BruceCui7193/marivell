# D8 资源基线采集报告

## 范围与约束

- 分支：`perf/performance-optimization`
- 基线文件（小文件，仅此文件）：
  `/home/crh/文档/Machine_Learning_25D/面向不同车型的2.5D野外地形风险感知路径规划：机器学习与搜索算法双向嵌套完整方案.md`
- 文件大小：67,878 bytes，2,161 行
- 流程：打开 -> idle 10s -> 3 次完整模式切换循环 -> 一轮 top->bottom->middle 滚动 -> idle 30s 采样
- idle 采样时长：idle 10s 实际按 10s 执行，idle 30s 按 30s 执行，未缩短
- 并行约束：本报告只含小文件数据；未跑 `barfoot_ser24.md`，大文件 Worker 队列、大文件 DOM/CPU/GPU 缺口留给主代理后续独占复测
- `perf-budget.json` 未修改；未新增 hard gate

## 硬件基线

- CPU：13th Gen Intel Core i7-13650HX，20 线程
- RAM：23 GiB（采样时系统约 9.9 GiB 已用）
- Electron：41.3.0
- 启动参数：真实 Electron，`--no-sandbox`，不传 `--disable-gpu`，以便采集 GPU 进程

## 采集接口

| 指标 | 接口 |
| --- | --- |
| renderer CPU% / GPU 内存 | 新增只读 IPC `benchmark:app-metrics`，返回 `app.getAppMetrics()` 与 `rendererProcessId` |
| rAF gap | renderer 内 rAF loop 采集相邻帧间隔 |
| long task | `PerformanceObserver('longtask')` |
| LoAF | `PerformanceObserver('long-animation-frame')`，仅当 `supportedEntryTypes` 支持时采集 |
| JS heap | renderer `performance.memory` + CDP `Runtime.getHeapUsage` |
| DOM | `TreeWalker` 分类计数 + CDP `Memory.getDOMCounters` |
| Worker | 现有 `__marivellFormulaChunkDiagnostics`（`waitMs/processMs/processRuns/messages/entries`）与 `__marivellGetInlineMathHeightPrefetchStats`（`pendingHeightMeasurements` 等） |

现有 Worker 诊断接口存在，但小文件低于 200,000 字大文件 Worker 阈值，因此本轮 `waitMs/processMs` 均为 0；当前没有暴露队列深度字段，只记录可采集字段。

## 3 轮基线数据

### Open / Final

| 指标 | R1 | R2 | R3 | p50 | p95 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| open heap used (MB) | 13.20 | 13.31 | 13.30 | 13.30 | 13.31 | 13.31 |
| open DOM TreeWalker nodes | 7,024 | 7,018 | 7,018 | 7,018 | 7,024 | 7,024 |
| open DOM CDP nodes | 7,406 | 7,468 | 7,494 | 7,468 | 7,494 | 7,494 |
| open GPU working set (MB) | 165.86 | 166.38 | 166.23 | 166.23 | 166.38 | 166.38 |
| final heap used (MB) | 13.25 | 13.86 | 13.12 | 13.25 | 13.86 | 13.86 |
| final DOM TreeWalker nodes | 8,581 | 8,248 | 8,581 | 8,581 | 8,581 | 8,581 |
| final DOM CDP nodes | 14,072 | 13,709 | 14,072 | 14,072 | 14,072 | 14,072 |
| final GPU working set (MB) | 179.63 | 180.00 | 177.94 | 179.63 | 180.00 | 180.00 |

### Idle 10s

| 指标 | R1 | R2 | R3 | p50 | p95 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| renderer CPU (%) | 2.99 | 2.69 | 2.59 | 2.69 | 2.99 | 2.99 |
| rAF gap (ms) | p95 17.20 | p95 17.50 | p95 17.30 | 16.70 | 17.40 | 22.30 |
| long task count | 0 | 0 | 0 | 0 | 0 | 0 |
| LoAF count | 0 | 0 | 0 | 0 | 0 | 0 |
| heap delta (MB) | 0.66 | 0.61 | 0.88 | 0.66 | 0.88 | 0.88 |
| DOM TreeWalker delta | -3 | 0 | 0 | 0 | 0 | 0 |

### 3 次模式切换循环

| 指标 | R1 | R2 | R3 | p50 | p95 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 总耗时 (ms) | 725 | 540 | 764 | 725 | 764 | 764 |
| renderer CPU (%) | 122.76 | 112.96 | 123.04 | 122.76 | 123.04 | 123.04 |
| rAF gap (ms) | p95 114.00 | p95 61.30 | p95 109.20 | 16.30 | 109.20 | 114.50 |
| long task count | 5 | 3 | 5 | 5 | 5 | 5 |
| long task total (ms) | 369 | 181 | 364 | 364 | 369 | 369 |
| long task duration (ms) | 101 | 75 | 101 | 70 | 101 | 101 |
| LoAF count | 4 | 4 | 5 | 4 | 5 | 5 |
| LoAF max (ms) | 189.50 | 83.70 | 182.90 | 182.90 | 189.50 | 189.50 |
| heap delta (MB) | 5.82 | 6.78 | 5.67 | 5.82 | 6.78 | 6.78 |

CPU% 用累计 CPU 秒折算，多核进程可以超过 100%。

### 一轮 top->bottom->middle 滚动

| 指标 | R1 | R2 | R3 | p50 | p95 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 总耗时 (ms) | 440 | 464 | 454 | 454 | 464 | 464 |
| renderer CPU (%) | 63.64 | 81.90 | 63.88 | 63.88 | 81.90 | 81.90 |
| rAF gap (ms) | p95 38.30 | p95 100.70 | p95 43.20 | 16.60 | 52.30 | 116.60 |
| long task count | 1 | 2 | 1 | 1 | 2 | 2 |
| long task total (ms) | 53 | 182 | 54 | 54 | 182 | 182 |
| long task duration (ms) | 53 | 108 | 54 | 54 | 108 | 108 |
| LoAF count | 2 | 3 | 2 | 2 | 3 | 3 |
| LoAF max (ms) | 65.00 | 120.10 | 67.40 | 67.40 | 120.10 | 120.10 |
| heap delta (MB) | -10.24 | -9.17 | -10.23 | -10.23 | -9.17 | -9.17 |

滚动阶段 heap 为负主要来自 GC 回落。

### Idle 30s

CPU 按 10s 窗口采样，每轮 3 个窗口。

| 指标 | R1 | R2 | R3 | p50 | p95 | max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| renderer CPU 10s 窗口 (%) | 1.80/4.29/2.80 | 2.99/3.79/2.60 | 1.70/3.99/2.30 | 2.80 | 4.29 | 4.29 |
| rAF gap (ms) | p95 17.10 | p95 17.00 | p95 17.50 | 16.70 | 17.30 | 50.30 |
| long task count | 0 | 0 | 0 | 0 | 0 | 0 |
| LoAF count | 0 | 0 | 0 | 0 | 0 | 0 |
| heap delta (MB) | -3.81 | -4.66 | -3.90 | -3.90 | -3.81 | -3.81 |
| DOM TreeWalker delta | 0 | 0 | 0 | 0 | 0 | 0 |

### Worker 后台负载

小文件三轮中 `formulaChunks.waitMs`、`processMs`、`processRuns`、`messages`、`entries` 增量均为 0；`pendingHeightMeasurements` 结束均为 0。这符合小文件未进入大文件 Worker 预取路径的预期，不能作为 Worker 门禁依据。

## 趋势

- idle CPU：R1 2.99%、R2 2.69%、R3 2.59%（10s）；30s 10s 窗口最高 4.29%。无上升趋势。
- idle long task/LoAF：三轮均为 0。
- idle rAF gap：p50 稳定约 16.7ms，p95 17.0-17.5ms；偶发 22-50ms，无单调恶化。
- DOM：open 稳定约 7,018-7,024，final 8,248-8,581；CDP 计数约高 60-70%，主要来自浏览器内部节点/事件对象差异。
- heap：idle 10s 每次小幅上升 0.6-0.9MB；idle 30s 全部回落，未观察到持续泄漏。
- GPU working set：open 后约 166MB，final 约 178-180MB，会话增长 11.71-13.77MB。
- Worker：本轮不可用，因为小文件不触发 Worker 公式预取。

## 门禁建议值

建议仅在 D9 或主代理补跑隔离大文件后正式写入 `perf-budget.json`；当前不写入，也不作为 hard gate。

| 指标 | 建议门禁 | 本轮依据 | 是否建议 hard gate |
| --- | ---: | --- | --- |
| idle long task | 10s/30s = 0 | 三轮均为 0 | 是，可 hard gate |
| idle rAF gap | p95 <= 20ms | p95 17.0-17.5ms | 是，可 hard gate |
| idle 30s heap delta | <= 2MB 且可回落 | 全部为负 | 是，可 hard gate |
| 会话 heap 增量 | <= 10MB | final-open p95 0.55MB | 是，可 hard gate |
| 小文件 DOM TreeWalker | <= 9,000 nodes | final 8,581 | 是，仅限小文件基线 |
| 小文件 CDP DOM | <= 15,000 nodes | final 14,072 | 是，仅限小文件基线 |
| GPU 会话增长 | <= 20MB | p95 13.77MB | 暂趋势，补 3 轮后定 |
| idle CPU | <= 6% | 30s 10s 窗口 p95 4.29% | 暂趋势，需隔离复测 |
| 模式切换/滚动 long task | 记录趋势，不设绝对值 | 模式 101ms、滚动 108ms p95 | 暂趋势 |
| Worker queue/process | 趋势 | 小文件不可采集 | 暂趋势，等大文件独占复测 |

## 运行方式

```bash
# 单轮 e2e
npx tsx scripts/tests/resource-baseline.e2e.test.ts

# 3 轮采集
RESOURCE_ROUNDS=3 npx tsx scripts/benchmark/resource-metrics.ts
```

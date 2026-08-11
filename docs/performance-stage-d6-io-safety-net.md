# D6 窗口化 IO 安全网实现记录

分支：`perf/performance-optimization`
任务：v3 Default Track D6“窗口化 IO 安全网”。

## 目标

1. 用 PM 位置索引选择 ±3 视口候选窗口。
2. 单一 `IntersectionObserver` 只观察未 hydrate 的占位节点。
3. IO entry 只把节点高优先级放入现有 hydration 队列。
4. 保留大跳转同步路径、settle 后扫描兜底、release 首帧
   `0 placeholder / 0 drift` 硬门禁。

## 实现

### activation-controller.ts

- 保留唯一 observer，root 固定为 `.editor-frame`，只观察未激活的虚拟节点和
  inline math group 占位元素。
- `hydrateTargetRange` 在扫描后调用 `syncPlaceholderIo`，用 PM 位置索引选取
  ±3 视口内的 inactive 候选，并按距离排序后截断到观察数上限。
- IO 回调只执行 `hydrationQueue.enqueue({ id, position, priority: 10 })`，
  再交给既有 pending/rAF 批次或 `hydrateTargetRange` drain；不再直接激活。
- 观察数上限参数化，默认取实测最优档 1000。
- 导出 benchmark 钩子：
  - `__marivellSetIoEnabled`
  - `__marivellSetIoObservationLimit`
  - `__marivellGetIoDiagnostics`
  - `__marivellResetIoDiagnostics`
- `forceHydrateAll` 通过 registry 注册的 inline group target 继续全量兜底。

### inline-math-group-registry.ts

- 每个 inline math group 注册到共享 IO/hydration target，不建立第二个 observer。
- `syncInlineMathIo` 用 inline group PM 位置索引选 ±3 视口候选并传给
  activation-controller 的 `syncPlaceholderIo`。
- `hydrateInlineMathGroupsAroundPosition` 与 `activateInlineMathGroupsInViewport`
  在激活后同步观察候选，大跳转同步路径不变。

### EditorShell.tsx

- 新增 benchmark-only `__marivellSyncIoForTest`，用于参数化观察和 e2e 稳定复测。
- 滚动、settle、scrollend、大跳转路径未改变。

### Benchmark

`scripts/benchmark/performance.ts` 新增 `scroll-io-overhead`：

- 同一文档内先跑 IO off 300 帧，再跑 IO on 300 帧；
- 匀速 `scrollTop += clientHeight * 0.05`；
- 输出 avg/p95/max frame ms、IO entries/enqueues/observed、observer count、
  callback max ms 和 A/B delta。

## 小文件 A/B 数据

文件：`/tmp/marivell-d6-io-small.md`（175,830 source bytes，1200 个唯一公式）

| 档位 | IO on avg | IO off avg | delta avg | on p95 | on max | entries/observed | callback max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 300 | 38.9ms | 38.4ms | +0.5ms | 44.1ms | 169.6ms | 6 / 6 | 0.1ms |
| 500 | 39.7ms | 39.4ms | +0.4ms | 44.0ms | 177.1ms | 6 / 6 | 0.0ms |
| 1000 | 38.8ms | 39.4ms | -0.5ms | 43.5ms | 175.7ms | 6 / 6 | 0.3ms |

结论：小文件三档均只产生 6 个候选观察，IO 每帧开销远低于 1ms 门禁；
取 1000 作为默认观察上限，避免大文件候选窗口被不必要截断，同时仍远低于
16k observer tax。

## 小文件验证

已通过：

- `npm test`
- `npx tsc --noEmit`
- `git diff --check`
- `scripts/tests/scroll-io.e2e.test.ts`：17 passed, 0 failed
- `scripts/tests/scroll-endpoints.e2e.test.ts`：19 passed, 0 failed
- `scripts/tests/inline-math-scroll.e2e.test.ts`：33 passed, 0 failed
- `scripts/tests/caret-alignment.e2e.test.ts`：252 passed, 0 failed
- `scripts/tests/mode-switch-large.e2e.test.ts`：9 passed, 0 failed

未运行 `barfoot_ser24.md` 大文件 benchmark；按任务约束等待主代理独占复测。

## 状态

READY_FOR_LARGE_BENCHMARK

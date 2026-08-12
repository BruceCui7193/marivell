# U2.3 批量单节点 activation 接入 PoC（2026-08-12）

## 1. 结论

U2.3 flag-gated activation 接入已完成隔离验证。默认路径保持 KaTeX HTML；`MARIVELL_ULTIMATE_U2=1` 时，已激活且非编辑/非焦点/非导出的公式经全局 `SingleNodeBatchProcessor` 排入单节点 swap，并保留编辑态、导出、模式切换时的 KaTeX 恢复路径。

验收结果：

| 验证 | 结果 |
| --- | --- |
| `npm test` | 通过 |
| `npx tsc --noEmit` | 通过 |
| `git diff --check` | 通过 |
| flag off `npm run test:e2e` | 全部通过 |
| flag on 新增 activation e2e | 11 passed, 0 failed |
| `npm run benchmark`（默认 flag off） | 运行完成，无 U2 路径参与 |

## 2. 实现方式

### 2.1 Flag

- `src/shared/contracts.ts`：`MarkdownEditorApi.getUltimateU2Enabled()`
- `src/preload/index.ts`：读取 `process.env.MARIVELL_ULTIMATE_U2 === '1'`
- `src/renderer/editor/virtualization/formula-single-node.ts`：`isU2Enabled()`、`resetU2EnabledCacheForTest()`、`setU2EnabledForTest()`

默认返回 false；flag off 时 `math-inline.ts` 不创建 U2 任务，原 KaTeX 路径完全不变。

### 2.2 全局批量控制器

新增 `src/renderer/editor/virtualization/u2-activation-controller.ts`：

- 全局单队列 `SingleNodeBatchProcessor`，参数为 batchSize=12、concurrency=8、maxSwapPerFrame=3。
- 没有 per-formula timer；controller 只在批量处理器内部使用单泵 timer。
- 支持 `cancel` / `restore` / `restoreAll`，节点销毁、编辑态、失焦、mode switch、export force-hydrate 时会取消或恢复。
- 在 `activation-controller.forceHydrateAll()` 中调用 `restoreAllU2SingleNodePreviews()`，确保导出 DOM 回到 KaTeX。
- 在 `forceDeactivateAllVirtualNodes()` 中取消 pending U2 任务。

### 2.3 math-inline 接入

`math-inline.ts` 在 block/inline 激活后调用 `requestU2Swap()`：

- 只有非编辑、非焦点、非选择的 active preview 会请求 swap。
- swap 前保存 `u2TaskId`；`isCurrent()` 校验节点未销毁、preview 仍连接、未进入编辑。
- 编辑态/select/destroy/textChanged/placeholder 均调用 restore/cancel。
- 单节点元素写入 `data-u2-single-node`、`data-u2-latex`、`data-u2-katex-html`、baseline 几何，便于测试与恢复。

### 2.4 Raster 与 baseline

U2 controller 使用 U2.2 的 `lineBoxTrim` 几何：

- inline：从实际 paragraph 的 font-family/font-size/line-height 建隐藏测量行，用 baseline probe 测 `B`，计算 `lineBoxTrim = max(0, KaTeX bottom - text line-box bottom)`。
- 单节点 height = KaTeX height - lineBoxTrim，vertical-align 保持虚拟 baseline 对齐。
- 生成 DPR2 PNG 使用 KaTeX clone → SVG foreignObject → Canvas，单个任务通过批量队列并发执行，不放开 12/8/3 限制。

## 3. Flag off 等价性

flag off 时：

- `isU2Enabled()` 返回 false；
- `math-inline.ts` 的 `requestU2Swap()` 直接 return；
- `activation-controller.forceHydrateAll()` 调用 `restoreAllU2SingleNodePreviews()`，controller 无 pending/swap，开销为空操作。

`npm run test:e2e` 全绿，覆盖 mode switch、caret、inline math scroll/lazy、export hydrate、math layout、syntax scoped、visual host DOM、large mode switch、incremental mode switch、formula height idle、scroll endpoints。

## 4. Flag on activation e2e

新增 `scripts/tests/u2-activation.e2e.test.ts`，11 项断言全部通过：

- viewport 公式最终 swap 成 `data-u2-single-node="1"`；
- swapped preview 内不再有 `.katex`；
- inline `$a$` baseline/bottom vs text line-box <=1px；
- inline `$a$` bottom vs KaTeX <=1px；
- 高 block matrix 不裁剪且 DPR2；
- 编辑态恢复 KaTeX 并移除单节点；
- batch controller pending/queue depth 无泄漏；
- source/visual mode switch 无 marker leak；
- export force-hydrate 后 snapshot 为 KaTeX、无单节点 DOM；
- copy/search 仍基于 source；
- U2 diagnostics 暴露 swap 延迟与队列数据。

### 4.1 轻量性能探针

本次 activation e2e 输出：

| 指标 | 值 |
| --- | ---: |
| requested / completed | 5 / 5 |
| cancelled | 5（编辑/export 恢复） |
| failed | 0 |
| max queue depth | 6 |
| pending after edit restore | 0 |
| queue depth after edit restore | 0 |
| swapReady p50 / p95 / max | 63.8 / 66.2 / 76.7ms |
| KaTeX activation ready | 18.6ms |

小文件探针未触发 4780 公式全量压力；大文件 flag on 的真实 activation 尾延迟仍需后续专用 benchmark。

## 5. 默认 benchmark

`npm run benchmark` 默认 flag off 独占运行完成。关键输出：

| 指标 | 本次 |
| --- | ---: |
| visualOpenMs | 4844ms（budget 5000，pass） |
| rendererReadyMs | 3770ms（budget 4000，pass） |
| typingMs | 144.5ms（budget 100，fail） |
| scrollAvgFrameMs | 44ms（budget 16.6，fail） |
| scrollMaxFrameMs | 98.4ms（budget 33，fail） |
| scrollJumpReadyMs | bottom 1927.5ms；middle/drag timeout |
| inlineMathActivateReadyMs | 5.1ms（budget 50，pass） |
| inline-height-drift | 0px |

本次运行仍有现有 typing/scroll 预算失败和 middle/drag timeout；flag off 下 U2 路径未激活，`inlineMathActivateReadyMs` 与 inline-height-drift 未退化。

## 6. 剩余风险

- U2 swap 的 SVG foreignObject → Canvas 生成仍在主线程，只是通过批量队列限制并发；4780 公式大文件 flag on 的整机延迟需要专用性能验证。
- `lineBoxTrim` 与 product `.math-inline-node` 行盒语义需要在真实大文件滚动/selection 下继续覆盖。
- 当前 flag on 只做了小文件 activation e2e，未跑现有 benchmark 的 flag on 语义。
- 若后续 activation 或整机 benchmark 出现回归，默认路径可直接回退到 KaTeX HTML，flag 不打开时不受影响。

## 7. 文件

新增/修改：

- `src/shared/contracts.ts`
- `src/preload/index.ts`
- `src/renderer/editor/virtualization/formula-single-node.ts`
- `src/renderer/editor/virtualization/u2-activation-controller.ts`
- `src/renderer/editor/virtualization/activation-controller.ts`
- `src/renderer/editor/extensions/math-inline.ts`
- `scripts/tests/u2-activation.e2e.test.ts`
- 本文档

未 commit、未 push、未修改 `perf-budget.json`，未在默认路径启用 U2。

# Performance Constraint Hardening

## 修改的约束文件

- `scripts/tests/test-utils/placeholder.ts`（新增共享 placeholder 语义）
- `scripts/tests/test-utils/exclusive-run.ts`（新增 benchmark 锁等待 helper）
- `scripts/tests/test-utils/markdown.ts`（新增确定性公式密集文档生成 helper）
- `scripts/tests/scroll-io.e2e.test.ts`
- `scripts/tests/scroll-endpoints.e2e.test.ts`
- `scripts/tests/inline-math-scroll.e2e.test.ts`
- `scripts/tests/inline-math-lazy.e2e.test.ts`
- `scripts/tests/first-frame-contract.e2e.test.ts`
- `scripts/tests/lazy-load-multi-position.e2e.test.ts`（新增）
- `scripts/tests/post-release-multi-position.e2e.test.ts`（新增，并含 drag+wheel 压力场景）
- `scripts/benchmark/performance.ts`
- `package.json`

未修改产品源码，未修改 `perf-budget.json`。

## placeholder 语义差异

旧语义把 preview 中“直接文本节点”当作非 placeholder：只要 preview 有非空文本，`viewportPlaceholders` 就可能为 0，即使页面显示的是灰色 LaTeX 代码。

新共享语义由 `marivellCollectVisiblePlaceholderState` 统一提供：

- inline math 必须有真实 `.katex`，并且 preview 中不能有 `.katex-error`、`.math-node-empty-hint`、`.math-node-placeholder-hint`。
- `.math-inline-node--placeholder`、preview 缺失、preview 直接文本、preview 只有 `.math-inline-placeholder-hint` 都算 unrendered/placeholder。
- 明确 error/empty/hint 的最终状态不计入 placeholder 计数，但仍计入 `visibleUnrenderedInlineMathCount`，所以“每个可见 inline math 都是真实 `.katex`”的断言不会被绕过。
- image 必须不是 `.image-node__placeholder`，且可见 `img.image-node__image` 必须 `complete && naturalWidth > 0`。
- block math、mermaid、html、code 仍按原有 placeholder class 计数。

Benchmark 的 `viewportPlaceholders` 现在使用同一套严格判定。记录到的前后数据：

| 指标 | 旧本地报告 `/tmp/marivell-perf-report-current-before-final.json` | 严格语义 benchmark |
| --- | --- | --- |
| bottom first-frame placeholders | 0 | 0 |
| middle first-frame placeholders | 1 | 0 |
| drag first-frame placeholders | 0 | 0 |
| viewportPlaceholders | 1（fail） | 0（pass） |
| inline-math-preview-placeholder | 4841 | 4841 |

strict benchmark 本次未观察到灰色直接文本；语义收紧后首帧仍为 0，说明本次 middle 的差异更像旧报告中的偶发失败，而不是新语义直接导致的稳定数值变化。

## 多位置懒加载测试设计

`lazy-load-multi-position.e2e.test.ts` 使用 `/home/crh/下载/barfoot_ser24/barfoot_ser24.md`，共 17 个位置：

- `0`、`10%`...`90%`、`100%`
- 6 个确定性随机位置：`17.3%`、`28.7%`、`41.3%`、`58.7%`、`72.9%`、`86.1%`

每个位置设置 6s hydration deadline，等待 3 个稳定 rAF 后判定：

- 可见 block/inline/image/mermaid/html/code placeholder 为 0
- 每个可见 inline math 都是真实 `.katex`
- 每个可见 image 都不是 placeholder，且 `complete && naturalWidth > 0`
- 无灰色 LaTeX 直接文本

超时/失败时输出 `scrollTop`、`placeholderDetails`、`__marivellPhase4Timings`、`__marivellPhase4HydrateTimings`、`__marivellVisibleFallbackTimings`、IO 诊断、U2 诊断和 scroll hotpath。

## 多位置释放后稳定性测试设计

`post-release-multi-position.e2e.test.ts` 使用共享 helper 生成的 900 个 section 公式密集文档：每个 section 是 `## Section N`，段落内含 `$x_{N}^2$`。该文件与 `scroll-io` 的 fixture 内容一致，临时生成后清理，不再依赖随机大文件。

测试包含 6 个稳定性位置：`8%`、`25%`、`50%`、`75%`、`93%`、`100%`。

每个位置执行：

1. 尝试真实 scrollbar 拖拽到目标比例
2. 程序化 jump + wheel 序列
3. 以首帧 rAF 为释放基线，监测 1000ms
4. 断言 `scrollTop` 不变、无新 scroll 事件、layout-shift 累计不超过 0.05
5. 再执行一次新滚动，断言 `scrollTop` 能变化，避免“稳定但卡死”

现有 `scroll-endpoints.e2e.test.ts` 的 500ms 后释放断言已提高到 1000ms，没有放宽。

## drag+wheel 压力场景

为复现用户报告的“先拖滚动条，再用鼠标滚轮往一个方向滑一段时间后才出现”的问题，压力场景已改为**单向连续滚轮**：

- 每轮先尝试真实 scrollbar drag 到不同比例
- 随后程序化跳到该轮目标位置
- 共 12 轮，分为 6 轮向下和 6 轮向上
- 向下子场景每轮固定 `wheel(0, 40)` 连续 120 次
- 向上子场景每轮固定 `wheel(0, -40)` 连续 120 次
- 单个子场景内部不反向
- 每轮之间静止 200ms
- 每轮最多等 8s，要求可见 inline math 全部真实 `.katex`、无灰色直接文本、可见图片全部加载完成

每轮输出 `scrollTop`、滚动事件数、剩余 placeholder、可见 inline 总数/真实数/未渲染数、未加载图片、灰色直接文本和 hydration 诊断。

## 实际失败清单

### 真实产品 bug：drag+wheel 后可见 inline math 未激活

`post-release-multi-position.e2e.test.ts` 在确定性公式密集文档上的隔离运行中复现，失败轮次如下：

| 轮次 | 方向 | scrollTop | 滚动事件 | placeholder | 可见 inline | 真实 katex | 未渲染 inline | 未加载图片 | 灰色文本 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 12 | up | 6251 | 1536 | 5 | 5 | 0 | 5 | 0 | 0 |

剩余公式：`x_{28}^2`、`x_{29}^2`、`x_{30}^2`、`x_{31}^2`、`x_{32}^2`。

失败 12 的关键诊断：

- `__marivellPhase4Timings.totalMs=11.3`，`shouldHydrate=true`，`scrollDelta=40`
- `__marivellPhase4HydrateTimings.queueSizeBefore=0`，`queueSizeAfter=0`，`drainedTasks=0`，`scanned=0`，`activated=0`
- `__marivellVisibleFallbackTimings.fallbackMs=0.3`，`activatedInlineGroups=0`，`scannedInlineGroups=88`，`visibleInlineGroups=6`
- IO：`callbackEntries=446`，`enqueuedEntries=416`，`activeSkipEntries=30`，`syncCount=3963`
- U2：`null`（默认关闭）

这些失败不是测试语义改变导致：剩余 DOM 全部是 `math-inline-node--placeholder`，fallback 扫描到了 `88` 个 inline group，但 `activatedInlineGroups=0`。

### 释放后稳定性的真实延迟

`post-release-multi-position.e2e.test.ts` 在确定性公式密集文档上观察到多个位置释放后仍有新 scroll 事件：

| 位置 | scrollTop | 新 scroll 事件 | layout shift 累计 |
| --- | --- | --- | --- |
| 8% | 10829 | 2 | 0.009146411314973735 |
| 25% | 33696 | 1 | 0.0973459034501894 |
| 50% | 67070 | 1 | 0.04665205387271245 |

这属于真实产品行为：稳定窗口内仍有延迟 scroll/layout 活动。

隔离运行结果：21 passed / 4 failed，失败为上述 3 个稳定性位置和 1 个 drag+wheel 压力轮次。

### scroll-io 严格约束暴露的 placeholder 残留

`scroll-io.e2e.test.ts` 单独运行结果为 15 passed / 2 failed：

| 场景 | target scrollTop | 实际 scrollTop | placeholder | 剩余公式 |
| --- | --- | --- | --- | --- |
| disabled IO | 99890 | 99951.5 | 3 | `x_{686}^2`、`x_{687}^2`、`x_{688}^2` |
| re-enabled IO | 33053 | 33114.5 | 4 | `x_{242}^2`...`x_{245}^2` |

两个失败都保持 `drift=0`，说明 scrollTop 稳定，但可见 inline math 仍是 `.math-inline-node--placeholder`。IO disabled 时 `observedCount=0`，re-enabled 后 `observedCount=6`、`callbackEntries=12`、`enqueuedEntries=12`，最终仍有 placeholder 未激活。

### 多位置懒加载结果

`lazy-load-multi-position.e2e.test.ts`：17/17 通过。

- 所有位置 placeholder=0
- 所有位置 unrendered inline=0
- 所有位置 unloaded image=0
- 所有位置 gray direct text=0

这说明没有连续 wheel 压力时，当前产品在任意单次滚动位置的最终 hydration 基本稳定；复现条件集中在“drag + wheel 连续滚动”路径。

## 需要产品修复的问题

1. drag+wheel 连续滚动后，部分可见 inline math 永久停留在 `math-inline-node--placeholder`，即使 hydration 路径已经执行、fallback 已扫描到对应 group，`drainedTasks=0` 且 `activatedInlineGroups` 没有清空视口。
2. 释放后稳定窗口内仍有少量延迟 scroll 事件和 layout shift，说明 scroll-end 判定或稳定器存在晚到活动。
3. `scroll-io` 在 IO 禁用和重新启用后，视口内仍残留 `.math-inline-node--placeholder`；IO 重新启用时 callback/enqueue 已发生，但激活没有覆盖全部可见公式。

这些都不是测试语义放宽造成的，也不是 `perf-budget.json` 阈值问题。

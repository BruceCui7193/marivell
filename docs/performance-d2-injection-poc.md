# D2 公式 DOM 注入路径 PoC（2026-08-12）

## 1. 结论

**`<template>` + `cloneNode` 是本阶段赢家**，且满足预注册判据：

- 重激活 p95：`128.7ms` vs 当前 `innerHTML` 的 `324.9ms`，快约 `60.4%`，超过 `>=15%` 阈值。
- 一次性插入 p95：`8.8ms` vs `innerHTML` 的 `23.1ms`，没有出现 `>20%` 回归，反而更快。
- `setHTMLUnsafe` 在本机 Chromium/Electron 可用并已实测，但重激活 p95 仍为 `299.8ms`，不如 template-clone。

因此 D4 应优先走“已缓存 HTML 模板 + `cloneNode`”注入路径，而不是继续把缓存 HTML 重新交给 `innerHTML` 或 `createContextualFragment` 解析。

## 2. 执行方式

- 分支：`perf/performance-optimization`
- HEAD：`acf084705f75708c8f47fb690ecee04bab37a348`
- 语料来源：`/home/crh/下载/barfoot_ser24/barfoot_ser24.md`（只提取公式，未跑大文件 benchmark）
- 运行命令：

```bash
npx tsx scripts/benchmark/dom-injection-poc.ts
npx tsx scripts/tests/dom-injection-poc.e2e.test.ts
```

PoC 启动真实 Electron，但只在小占位 Markdown 页面中运行独立 iframe 测试，不修改默认产品路径，不引用任何产品注入代码。

## 3. 语料

从 Barfoot 大文件中用产品现有 `parseMarkdown` + `collectFormulaIndex` 提取到 `4,780` 个唯一公式，并用 KaTeX 渲染全部公式后按 HTML 大小分层：

| 字段 | 值 |
| --- | ---: |
| sourceBytes | 1,361,722 |
| totalUnique | 4,780 |
| selected | 200 |
| inline | 100 |
| block | 100 |
| HTML-size quartile | 50 / 50 / 50 / 50 |
| selected formula HTML bytes | 1,048,079 |

没有运行 `barfoot_ser24.md` 大文件打开/滚动/模式切换 benchmark。

## 4. 公平协议

- 每次方法使用独立 hidden iframe（独立页面上下文）和独立缓存状态。
- 7 种注入方法各跑 5 次预热 + 20 次测量。
- 测量轮按 rotating round-robin 交错，减少顺序和 GC 偏差。
- 一次性插入：空容器一次性注入 200 条公式。
- 重激活：每个测量样本执行 10 轮“插入 -> 移除 -> 从缓存重插”，共 20 个样本。
- 记录 median/p95、heap、long task、style/DOM mutation。
- 不使用本机不可靠的 CDP layout/paint 计数器。
- `performance.memory` 通过 `--enable-precise-memory-info` 开启；本机可用。
- `setHTMLUnsafe` feature-detect；本机支持并实测。

## 5. 结果

单位：`ms`。重激活样本为 10 轮总耗时，因此数值明显高于单轮注入。

| 方法 | 一次性 p50 | 一次性 p95 | 重激活 p50 | 重激活 p95 | 重激活 long task ms | DOM mutation 一次性/重激活 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| innerHTML（现状） | 21.7 | 23.1 | 248.5 | 324.9 | 5,151 | 1 / 20 |
| insertAdjacentHTML | 22.0 | 23.8 | 245.8 | 281.7 | 5,023 | 1 / 20 |
| template + cloneNode | 7.3 | 8.8 | 90.3 | 128.7 | 1,938 | 200 / 2,010 |
| Range.createContextualFragment | 20.6 | 21.9 | 231.9 | 252.5 | 4,785 | 1 / 20 |
| JSON 树 + createElement | 21.1 | 24.0 | 238.7 | 283.3 | 4,922 | 200 / 2,010 |
| JSON 树 + Fragment 批处理 | 22.1 | 24.3 | 251.9 | 313.0 | 5,204 | 1 / 20 |
| setHTMLUnsafe | 20.2 | 28.7 | 234.6 | 299.8 | 4,811 | 1 / 20 |

所有方法 style mutation 均为 `0`：当前 KaTeX HTML 语料没有触发 `style` attribute mutation。DOM mutation 为 MutationObserver 在 iframe 内采集的 childList/class 计数，批处理与逐节点方法表现出不同粒度的记录，不作为 style recalc 替代指标。

## 6. Heap 与 long task

- `performance.memory.usedJSHeapSize` 可用；PoC 开始前与结束后均为 `17,224,979` bytes，会话增量 `0`。
- 各样本内 `heapDelta` 中位数也为 `0`，说明短时间同步注入没有出现可观测的 JS heap 增长；DOM/模板内存变化需要后续 D4 做持续多轮趋势测量。
- 重激活场景每次 10 轮样本通常形成 1 个 long task，template-clone 的 long task 总耗时最低（`1,938ms`），`innerHTML` 为 `5,151ms`。

## 7. 对 D4/D5 的说明

D4：

- 在 hydration 激活路径使用按公式 key 缓存的 `HTMLTemplateElement`，注入时只 `template.content.cloneNode(true)` 并 append 到 preview/contentDOM。
- 不要把 4,780 个模板一次性提前解析。建议首次激活某公式时惰性构建模板，并用 LRU Map 封顶。
- 封顶建议沿用当前 `PREPARED_FORMULA_FRAGMENT_LIMIT = 2400` 的数量上限，同时增加字节预算保护；例如数量 `<=2400` 且总模板 HTML 不超过约 `48MB`，超过时逐出 oldest。
- 命中时提升 LRU；失手时由 `preparedFormulaHtml` 构建模板后插入，避免重复 `template.innerHTML`。
- 若未来改为“一组视口公式合并为一个模板”的批量注入，LRU key 应为公式组而非单公式，并同样限制数量和字节数。
- 本 PoC 只证明注入段收益；D4 的 900ms KaTeX ready 还包含 queue/anchor/PM 坐标等成本，集成后必须重新测 `katex-ready` 与单帧激活，不能只按注入快 60% 外推总收益。

D5：

- typing 热路径不是公式注入主路径，本阶段没有为 D5 引入任何改动或新依赖。
- 若 D4 的模板缓存会占用额外内存，应在 D5 回归中观察 typing 后 idle heap 是否回落。

## 8. 文件与验证

新增：

- `scripts/benchmark/dom-injection-poc.ts`
- `scripts/tests/dom-injection-poc.e2e.test.ts`

原始 JSON：`/tmp/marivell-d2-dom-injection-1786469920495.json`

验证：

- `npx tsx scripts/benchmark/dom-injection-poc.ts`：成功
- `npx tsx scripts/tests/dom-injection-poc.e2e.test.ts`：60 passed, 0 failed
- `npx tsc --noEmit`、`git diff --check`：见最终报告

未修改产品路径；未 commit；未 push。

# U2.2 批量生成 + 单节点表示 + 精确 baseline PoC（2026-08-12）

## 1. 结论

**本阶段 PoC 硬门禁已全部通过。** 通过显式 `lineBoxTrim`，单节点元素不再复刻 KaTeX `.katex` 行盒，而是用自身的 width/height + vertical-align 参与普通文本行盒；`$a$` 的 baseline、KaTeX bottom、普通文本 line-box bottom 均达到 0px。

| 判据 | 结果 | 是否通过 |
| --- | ---: | --- |
| 单队列批量，batchSize=12、并发=8、同帧 swap<=3 | 18 batches / 207 tasks，失败 0 | 通过 |
| 不再每公式一个 setTimeout | active timers max=1，per-formula calls=0.0097 | 通过 |
| 视口/锚点优先 | 首 12 个 swap 全部为 priority0 | 通过 |
| 单节点 DOM | KaTeX p50=60，candidate 恒为 1 | 通过 |
| 注入 p95 | canvas 0.5ms，bitmap 0.1ms | 通过 |
| inline `$a$` baseline | 0.000px | 通过 |
| inline `$a$` bottom vs KaTeX | 0.000px | 通过 |
| inline `$a$` bottom vs 普通文本 line-box | 0.000px | 通过 |
| 高公式不裁剪 | crop covered 207/207，candidate crop detected 0 | 通过 |
| 块级固定高度 | height delta p50=0px，content not cropped | 通过 |
| 编辑恢复/复制/搜索/导出 | 通过 | 通过 |

本 PoC 未接入 activation，未改变默认产品行为，未修改 `perf-budget.json`。

## 2. 执行方式与范围

- 分支：`perf/performance-optimization`
- HEAD：`26fd229`
- 语料：`/home/crh/下载/barfoot_ser24/barfoot_ser24.md`
- 样本：207 = 200 分层公式 + 7 个受控公式（inline `a`/`x`/`x^2`/`sqrt`/`frac`，block matrix/sum）
- 只考察 `canvas-raster` 与 `bitmap-data-url`，未再评估 `svg-viewbox`

```bash
npm test
npx tsc --noEmit
git diff --check
npx tsx scripts/tests/u2-batch-baseline-poc.e2e.test.ts
npm run test:e2e
```

`npm run benchmark` 未运行。U2.2 e2e 独占运行，使用 `/tmp/marivell-benchmark.lock`，等待其他性能任务释放，不杀外部进程；`npm run test:e2e` 为既有完整 Electron 回归套件。

## 3. Baseline 公式

定义：

- `B`：普通文本行的 alphabetic baseline，用零高 inline-block baseline probe 测量。
- `T`：KaTeX `.katex` 内容盒顶部。
- `H`：KaTeX `.katex` 内容盒高度。
- `W`：KaTeX `.katex` 内容盒宽度。
- `B_k = B - T`：公式 baseline 相对内容盒顶部的偏移。

单节点 `<canvas>`/`<img>` 没有内部文本 baseline，CSS 中 replaced element 的 baseline 按 bottom margin edge 处理。为把公式虚拟 baseline 放到 `B`：

```text
trim = max(0, scaledKaTeXBottom - textLineBoxBottom)
H' = max(1, H - trim)
descender = H' - B_k
vertical-align = -(descender) = B_k - H'
```

因此：

```text
top = B + vertical-align + H' = B - B_k
baseline = top + B_k = B
bottom = B + descender = textLineBoxBottom
```

其中 `textLineBoxBottom` 使用同字号/行高的普通文本测量；`lineBoxTrim` 只去掉 KaTeX 行盒相对普通文本行盒的额外 padding，不改变 `B_k`。块级公式使用固定的 `width=W`、`height=H`、`overflow: visible`，不按包围盒 center 对齐。

## 4. 关键数据

### 4.1 DOM、字节、注入

| 指标 | KaTeX HTML | canvas-raster | bitmap-data-url |
| --- | ---: | ---: | ---: |
| DOM p50 | 60 | 1 | 1 |
| DOM p95 | 575 | 1 | 1 |
| 序列化字节 p50 | 1,969 | 6,454 | 6,454 |
| 序列化字节 p95 | 20,147 | 57,474 | 57,474 |
| 注入 p50 | - | 0.1ms | 0.0ms |
| 注入 p95 | - | 0.5ms | 0.1ms |

两种表示使用同一份 DPR2 PNG payload，因此序列化字节相同；DOM 与像素表现也一致。

### 4.2 Baseline

| 指标 | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| inline bottom vs trimmed KaTeX | 0.00px | 0.00px | 0.35px |
| inline center vs trimmed KaTeX | 1.00px | 1.00px | 1.00px |
| inline virtual baseline | 0.00px | 0.00px | 0.35px |
| `$a$` vs 文本 line-box bottom | 0.00px | 0.00px | 0.00px |

受控 `$a$` 在 3 组字号/字族/line-height 下均为 baseline 0px、trimmed KaTeX bottom 0px、普通文本 line-box bottom 0px。actual glyph descent 与文本 line-box 不是同一度量，PoC 的硬门禁采用 CSS line-box bottom。

### 4.3 高公式与块级

| 指标 | 值 |
| --- | ---: |
| overflow 样本 | 167/207 |
| crop covered | 207/207 |
| candidate crop detected | 0/207 |
| overflowTopMax | 48.52px |
| overflowBottomMax | 5.27px |
| 受控高矩阵 crop | 无 |
| block fixed height delta p50/p95 | 0.00 / 0.00px |

### 4.4 DPR 清晰度

| 指标 | p50 |
| --- | ---: |
| DPR2 scale | 2.07 |
| DPR1 vs DPR2 mean abs diff | 1.72 |
| diff ratio | 5.4% |
| clarity ratio | 1.015 |

### 4.5 批量队列

| 指标 | canvas-raster | bitmap-data-url |
| --- | ---: | ---: |
| wall | 832.2ms | 792.2ms |
| batches | 18 | 18 |
| tasks / failed | 207 / 0 | 207 / 0 |
| batch size / concurrency | 12 / 8 | 12 / 8 |
| 同帧 swap max | 3 | 3 |
| generation p50/p95 | 0.3 / 3.1ms | 1.1 / 2.0ms |
| swap p50/p95 | 15.5 / 61.1ms | 29.9 / 38.8ms |
| batch p50/p95 | 37.8 / 62.4ms | 36.9 / 69.3ms |

计时器：active max=1，total calls=2，per-formula calls=0.0097。首 12 个 swap 均为 viewport/anchor priority0。

### 4.6 内存与 DOM

`performance.memory.usedJSHeapSize` 在本会话始终为 40,079,468 bytes，未观察到增量；DOM 从 608 到 cleanup 后 650。该 API 不覆盖 decoded image/GPU 内存。

### 4.7 保留能力

| 能力 | 结果 |
| --- | --- |
| 编辑恢复 KaTeX HTML | `.katex` present，7 nodes |
| 导出 DPR2/原始 HTML | present / katex |
| 复制 | `$x+y$` 保留 |
| 搜索 | 编辑器 docText 与 source search 均命中 |
| Markdown round-trip | 通过 |

## 5. 剩余风险与 U2.3 前提

本 PoC 已达到隔离接入门槛：baseline、KaTeX bottom、文本 line-box bottom、高矩阵不裁剪、DPR、批量、单节点 DOM 与能力语义均有 e2e 断言。

仍需要在 U2.3 activation 接入时验证，而不是由本 PoC 外推：

- activation 路径的 `katex-ready <=50ms` 整机指标；
- 大文件滚动、锚点、selection、编辑态切换的等价性；
- `lineBoxTrim` 在真实 `.math-inline-node` 产品样式中是否需要在 preview 层额外应用。

若 U2.3 任一硬门禁回归，继续保留 KaTeX HTML 默认路径并整分支回退。

## 6. 产出物与验证

新增/修改：

- `src/renderer/editor/virtualization/formula-single-node.ts`
- `scripts/benchmark/u2-batch-baseline-poc.ts`
- `scripts/tests/u2-batch-baseline-poc.e2e.test.ts`
- 本文档

原始 JSON：`/tmp/marivell-u2b-final-1786543752648.json`

验证：

- `npm test`：全部通过
- `npx tsc --noEmit`：通过
- `git diff --check`：无输出
- 新增 e2e：28 passed, 0 failed
- `npm run test:e2e`：全部通过

未 commit、未 push、未运行 `npm run benchmark`、未修改 `perf-budget.json`、未接入 activation。

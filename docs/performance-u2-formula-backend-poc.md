# U2 公式渲染后端单节点化最小 PoC（2026-08-12）

## 1. 结论

**当前不建议直接进入 U2.1 activation 接入。** 单节点表示在 DOM 骤降和注入耗时上达到了 U2 方向，但位图/SVG 的序列化字节比 KaTeX HTML 更大，基线偏移和像素一致性仍未达到接入门槛，且 activation 路径的 `katex-ready <=50ms` 尚未实测。

| 判据 | PoC 结果 | 是否通过 |
| --- | ---: | --- |
| DOM 降 >=60% | KaTeX p50 60 节点，单节点恒为 1 | 通过 |
| 单节点注入 p95 <=2ms | bitmap/svg p95 0.1ms，canvas p95 0.5ms | 通过 |
| 基线 <=1px | bottom p50 46.8px，p95 55.6px | 未通过 |
| 高公式不裁剪 | 162/200 个源溢出样本，fit-to-width 后 crop covered | 通过 |
| 复制/搜索/编辑/导出保留 | 原型 API 与真实编辑器 copy/search 探针通过 | 通过 |
| katex-ready <=50ms | 未做 activation 集成，不能外推 | 未测 |

失败回退路线：保持 `MARIVELL_ULTIMATE_U2` 默认 off；非编辑态继续走现有 KaTeX HTML。若后续接入后复制、搜索、编辑、导出、坐标或滚动出现回归，整 commit/整分支回退到当前默认路径，并保留本 PoC 文件、测试与原始 JSON。

## 2. 执行方式与范围

- 分支：`perf/performance-optimization`
- HEAD：`a231a61b1c3ba058c19284e13170f356bfb82d54`
- 语料：`/home/crh/下载/barfoot_ser24/barfoot_ser24.md`，只提取公式，未运行大文件打开/滚动/模式切换 benchmark
- 运行命令：

```bash
npx tsx scripts/benchmark/u2-formula-backend-poc.ts
npx tsx scripts/tests/u2-formula-backend-poc.e2e.test.ts
```

PoC 使用真实 Electron 41.3.0（Chromium 146.0.7680.188），启动现有编辑器并只运行独立原型代码；没有修改默认产品源码、`perf-budget.json` 或现有测试断言。

## 3. 语料与候选表示

| 字段 | 值 |
| --- | ---: |
| sourceBytes | 1,361,722 |
| totalUnique | 4,780 |
| selected | 200 |
| inline | 100 |
| block | 100 |
| HTML-size quartile | 50 / 50 / 50 / 50 |

候选表示：

1. `canvas-raster`：单个 `<canvas>`，把 DPR2 PNG drawImage 到 canvas。
2. `bitmap-data-url`：单个 `<img>`，src 为 DPR2 PNG data URL。
3. `svg-viewbox`：单个 `<img>`，src 为带固定 viewBox 的 SVG data URL，内部嵌入同一张高分辨率 PNG。

超大公式（原始 content box 最宽约 15,890 CSS px）在语料捕获阶段使用 fit-to-width 缩放，并把捕获 cell 扩大到内容包围盒，因此候选栅格不裁剪；正式接入仍需定义这些超宽公式的容器策略。

## 4. 关键数据

### 4.1 DOM 与字节

| 表示 | DOM p50 | DOM p95 | DOM max | serialized bytes p50 | serialized bytes avg |
| --- | ---: | ---: | ---: | ---: | ---: |
| KaTeX HTML | 60 | 597 | 1,206 | 2,036 | 5,256 |
| canvas-raster | 1 | 1 | 1 | 8,966 | 29,385 |
| bitmap-data-url | 1 | 1 | 1 | 6,562 | 21,876 |
| svg-viewbox | 1 | 1 | 1 | 8,966 | 29,385 |

单节点化使 DOM 从 p50 60 降到 1，但 DPR2 PNG data URL 和 SVG 包裹使序列化字节明显大于 KaTeX HTML。当前数据不支持“位图一定更省内存/字节”的假设。

### 4.2 单公式注入耗时

每个表示 5 轮预热 + 200 公式 × 20 次测量，共 4,000 个样本：

| 表示 | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| katex-html | 0.0ms | 0.5ms | 2.1ms |
| canvas-raster | 0.1ms | 0.5ms | 1.6ms |
| bitmap-data-url | 0.0ms | 0.1ms | 0.9ms |
| svg-viewbox | 0.0ms | 0.1ms | 1.1ms |

bitmap 和 svg 的 p95 明显低于 KaTeX HTML，满足 U2 的单节点注入目标。

### 4.3 基线偏移

| 指标 | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| bottom delta | 46.80px | 55.65px | 180.03px |
| center delta | 16.38px | 31.16px | 98.02px |
| line-bottom delta | 7.59px | 33.19px | 33.19px |

当前用 KaTeX wrapper 与单节点元素在相同文本行中的包围盒 bottom/center 对齐作为基线近似，不是真正的字体 baseline API。即便考虑近似误差，单节点元素仍与 KaTeX 的 vertical-align/line-box 语义明显不一致，不能直接替换。

### 4.4 高公式裁剪

- 200 个样本中有 162 个检测到内容超出 KaTeX preview box。
- overflowTopMax 48.52px，overflowBottomMax 5.02px，overflowLeft/RightMax 约 2,168px。
- 使用 fit-to-width + content-sized capture cell 后，DPR2 栅格覆盖所有公式内容，`candidateCropCovered=true`。

结论：裁剪本身可以绕过，但“超大公式如何落进容器”和“高公式 baseline/vertical-align”仍是 U2.1 的必须前置。

### 4.5 DPR 清晰度与像素 diff

| 指标 | avg | p50 | p95 |
| --- | ---: | ---: | ---: |
| DPR2 scale | 2.12 | 2.07 | 2.42 |
| DPR1.5 scale | 1.59 | 1.55 | 1.82 |
| DPR1 vs DPR2 downscaled mean abs diff | 2.26 | 1.72 | 6.13 |
| DPR1 vs DPR2 diff ratio | 6.6% | 5.4% | 19.7% |
| clarity ratio | 1.012 | 1.015 | 1.076 |

像素 diff：

| 表示 | mean abs diff avg | mean abs diff p95 | diff ratio p95 |
| --- | ---: | ---: | ---: |
| canvas-raster | 0 | 0 | 0 |
| bitmap-data-url | 0 | 0 | 0 |
| svg-viewbox | 16.23 | 43.80 | 28.4% |

canvas 和直接 data URL 与源 KaTeX 栅格逐像素一致；SVG data URL 再编码会引入可观的 alpha/颜色差异，不适合作为无损单节点表示。

### 4.6 内存

`performance.memory.usedJSHeapSize` 可用；本会话 before/after images、injection、cleanup 均为 `51,972,554` bytes，JS heap 未观察到增量。该 API 不反映 decoded image/DOM/GPU 内存，因此本 PoC 的内存结论只覆盖 JS heap，完整内存趋势需要 CDP DOM counters 或 Electron process metrics。

## 5. 保留能力验证

| 能力 | 探针结果 |
| --- | --- |
| 复制粘贴 | 真实编辑器 copy 事件输出 `$x+y$` |
| 搜索 | 原型 source metadata 命中，真实编辑器 docText 命中 `u2SearchTokenAlpha` |
| 编辑态回 KaTeX | 单节点恢复 KaTeX HTML，`.katex` 存在 |
| 导出 | 候选可返回 DPR2 data URL 或原始 HTML；markdown-to-html 仍输出 KaTeX |
| Markdown round-trip | `parseMarkdownFragment(serializeSingleNodeFormula(...))` 可重新序列化 |

## 6. U2.1 建议

值得继续的方向：

- 只把 `bitmap-data-url` 或 `canvas-raster` 视为注入候选；`svg-viewbox` 当前像素不一致，不推荐。
- 先解决单节点 inline/block 的 baseline 语义：可以继续用 KaTeX 高度缓存设置行高，再比较真实 caret/selection 坐标，而不是只比包围盒。
- 对超宽公式定义 fit-to-width viewBox 与容器宽度策略，避免 15,000px 级 DOM/捕获。
- 用 CDP DOM counters/Electron process metrics 补充 DOM/GPU 内存趋势。
- 在独立 flag 下跑 U2 activation 等价性门禁后再测 `katex-ready`。

失败回退：

- flag off 时完全走现有 KaTeX HTML 路径。
- 接入后任一 selection、IME、复制、搜索、坐标、导出、模式切换或滚动硬门禁回归，整 commit/整分支回退。
- 本 PoC 文件、测试、原始 JSON 与本文档保留，不删除失败实验记录。

## 7. 产出物与验证

新增：

- `scripts/benchmark/u2-formula-backend-poc.ts`
- `scripts/tests/u2-formula-backend-poc.e2e.test.ts`
- `src/renderer/editor/virtualization/formula-single-node.ts`
- 本文档

原始 JSON：`/tmp/marivell-u2-formula-backend-1786475365164.json`

验证：

- `npx tsx scripts/benchmark/u2-formula-backend-poc.ts`：成功
- `npx tsx scripts/tests/u2-formula-backend-poc.e2e.test.ts`：23 passed, 0 failed
- `npx tsc --noEmit`：成功
- `git diff --check`：无输出

未修改默认产品源码、`perf-budget.json` 或现有测试断言；未 commit；未 push。

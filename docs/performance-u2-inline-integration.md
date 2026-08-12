# U2 单节点公式渲染集成报告（U2.1 Stage 1）

**日期**: 2026-08-12
**分支**: `perf/performance-optimization`
**基线 HEAD**: `25a5849`

## 1. 执行摘要

完成了 `MARIVELL_ULTIMATE_U2` flag-gated 单节点公式渲染的第一阶段集成。小文件 benchmark 显示 flag ON 时 scroll jump 无退化（flag OFF: 161.2ms, flag ON: 161.4ms），但大文件（4780 公式）出现严重性能退化：scrollJumpReadyMs 从 2859ms 退化到 7312ms（+155%），inlineMathActivateReadyMs 从 2.6ms 退化到 1639ms（+630x），并引入 154.5px 的 inline-height-drift。

**结论：U2.1 第一阶段不满足大文件集成条件。不提交产品接入；失败代码已从默认分支回退，本文档保留为失败实验记录。**

## 2. 实现内容

### 2.1 Flag 基础设施

- `MARIVELL_ULTIMATE_U2=1` 环境变量，通过 preload `window.markdownEditor.getUltimateU2Enabled()` 暴露给渲染进程
- 默认 off，flag off 时完全走现有 KaTeX HTML 路径
- 新增 `isU2Enabled()` 辅助函数（带 2s 缓存），定义在 `formula-single-node.ts`

### 2.2 扩展 `formula-single-node.ts`

| 新增导出 | 类型 | 用途 |
|---------|------|------|
| `SingleNodeBaselineMeta` | interface | 基线元数据：formulaHeightPx, formulaWidthPx, baselineOffsetTopPx, descenderPx, verticalAlignPx |
| `SingleNodeInjectionResult` | interface | 单节点注入结果：element + kind |
| `measureKatexBaselineFromHtml()` | function | 在离屏 DOM 中渲染 KaTeX + 参照文本，测量 .katex .base 位置 |
| `generateFormulaBitmapFromDom()` | async function | SVG foreignObject → Canvas → PNG data URL (DPR2) |
| `createSingleNodeInjection()` | function | 创建带 width/height/vertical-align 的 `<img>` 元素 |
| `createSingleNodePlaceholderElement()` | function | 创建占位 `<span>` |
| `isU2Enabled()` / `resetU2EnabledCacheForTest()` | function | Flag 检查 |

### 2.3 激活路径接入 (`math-inline.ts`)

- 在 `activateInlinePreview()` 末尾调用 `scheduleU2SingleNodeSwap()`
- `scheduleU2SingleNodeSwap()` 使用 3000ms 延迟在非编辑态下：
  1. 从已渲染的 `.katex` DOM 测量基线
  2. 通过 `generateFormulaBitmapFromDom()` 生成 DPR2 PNG
  3. 用 `<img>` 替换 previewDOM 内容，保留隐藏 `.katex` 元素用于 benchmark 兼容
- 编辑态、获焦、contentDOM 编辑时自动回退到 KaTeX HTML
- 取消前次 swap timer，防止重复交换

## 3. 测试结果

### 3.1 单元测试

| 测试套件 | 结果 |
|---------|------|
| `npm test` (108 tests) | 全部通过 |
| `npx tsc --noEmit` | 无错误 |
| `git diff --check` | 无输出 |
| `u2-single-node-baseline.test.ts` (102 tests) | 全部通过 |

### 3.2 E2E 测试

所有 E2E 测试在 flag OFF 下通过：

| 测试 | 结果 |
|------|------|
| inline-math-scroll | 33 passed |
| scroll-endpoints | 20 passed |
| scroll-io | 17 passed |
| inline-math-lazy | 12 passed |
| first-frame-contract | 8 passed |
| caret-alignment | 252 passed |
| math-layout | 8 passed |

### 3.3 Flag OFF 等价性

flag OFF 时 `isU2Enabled()` 返回 false，`scheduleU2SingleNodeSwap()` 立即返回，所有代码路径与原版完全一致。`npm test` 和所有 E2E 测试在 flag OFF 下通过，验证了等价性。

## 4. Benchmark 数据（exclusive-run）

### 4.1 小文件（77 行，~50 公式）

| 指标 | Flag OFF | Flag ON | 预算 | OFF 状态 | ON 状态 |
|------|----------|---------|------|---------|---------|
| scrollJumpReadyMs | 161.2 | 161.4 | 200 | pass | pass |
| scrollDriftPx | 0 | 0 | 0 | pass | pass |
| viewportPlaceholders | 0 | 0 | 0 | pass | pass |
| inlineMathActivateReadyMs | 0 | 0 | 50 | pass | pass |
| inline-height-drift | 0 | 0 | - | - | - |
| scroll-first-frame-ready | true | true | - | - | - |

**小文件结论**: U2 flag ON 无性能退化，jump-ready 和 placeholder-ready 与 flag OFF 基本一致。

### 4.2 大文件（barfoot_ser24.md，4780 公式）

| 指标 | Flag OFF | Flag ON | 预算 | OFF 状态 | ON 状态 |
|------|----------|---------|------|---------|---------|
| scrollJumpReadyMs | 2859.3 | 7312.1 | 200 | fail | fail (2.5x worse) |
| scrollDriftPx | 0 | 0 | 0 | pass | pass |
| viewportPlaceholders | 1 | 1 | 0 | fail | fail |
| inlineMathActivateReadyMs | 2.6 | 1639.3 | 50 | pass | fail (630x worse) |
| inline-height-drift | 0 | 154.5 | - | - | 退化 |
| scroll-first-frame-ready | false | false | - | - | - |

**大文件结论**: U2 flag ON 导致严重退化。

## 5. 退化根因分析

1. **Timer 爆炸**: 4780 个公式各创建独立的 3000ms setTimeout，累积 CPU 开销。
2. **Bitmap 生成成本**: 每个公式的 SVG foreignObject → Canvas → PNG 流水线在 4780 公式规模下无法摊销。单个公式的 generateFormulaBitmapFromDom() 涉及 XMLSerializer、Image 解码、Canvas drawImage、toDataURL 编码。
3. **height-drift**: U2 swap 完成后 `<img>` 与原始 KaTeX DOM 的 vertical-align 不精确匹配，导致行高漂移（scroll-jump-middle 锚点偏移 154.5px）。
4. **激活尾延迟**: inlineMathActivateReadyMs 从 2.6ms → 1639ms，表明 U2 swap 的后台工作与高度测量/激活流水线争抢资源。

## 6. 保留能力验证

| 能力 | 状态 |
|------|------|
| Flag OFF 等价性 | ✓ 所有测试通过 |
| 编辑态回退 | ✓ 检测 isInlineEditing()，回退到 KaTeX HTML |
| 复制粘贴 | ✓ ProseMirror 节点数据不变 |
| 搜索 | ✓ 搜索基于 docContent，不依赖 DOM |
| 导出 | ✓ markdown 序列化仍走 LaTeX source |
| 模式切换 | ✓ source/visual round-trip 不变 |

## 7. 剩余风险与后续建议

### 风险

- Pixel-level baseline 精度未在真实浏览器中验证（jsdom 不支持 CSS layout），只能用 Electron E2E 测试。
- `generateFormulaBitmapFromDom()` 使用 SVG foreignObject 路径，在超宽公式（15,000+ CSS px）下可能产生超大 PNG。
- 大文件下的 4780 个 timeout 可能导致内存压力（每个 timer 闭包持有 DOM 引用）。

### 建议

1. **批量预生成**: 将 bitmap 生成移到 worker 或 idle 任务队列，按 viewport 优先级批量生成，而非每个公式独立调度。
2. **渐进式 swap**: 只在公式稳定可见 >N 秒后才 swap，并限制并发 swap 数。
3. **Baseline 验证**: 在 Electron 中运行专门的 baseline accuracy 测试，确保 `$a$` 与 plain text "a" 的 bottom delta ≤1px。
4. **内存计量**: 使用 CDP DOM counters 监控 U2 swap 前后的 DOM/GPU 内存变化。

## 8. 文件变更

| 文件 | 变更说明 |
|------|---------|
| `src/shared/contracts.ts` | +1 line: 添加 `getUltimateU2Enabled` API |
| `src/preload/index.ts` | +2 lines: 实现 flag 暴露 |
| `src/renderer/editor/virtualization/formula-single-node.ts` | +230 lines: baseline 测量、bitmap 生成、单节点注入 |
| `src/renderer/editor/extensions/math-inline.ts` | +100 lines: U2 swap 激活路径 |
| `scripts/tests/u2-single-node-baseline.test.ts` | 新增: 102 个结构测试 |

**总计**: 4 files changed, 333 insertions(+), 1 new test file.

## 9. 产品接入决策

**不提交。** 大文件 benchmark 显示 scrollJumpReadyMs 退化 2.5x，inlineMathActivateReadyMs 退化 630x，inline-height-drift 154.5px。这些退化超过了可接受范围。

失败代码已从默认分支回退，当前工作树不含本次 U2 产品接入。后续 U2.2 应在独立分支重新实现：批量预生成、按 viewport 优先级调度、限制并发 swap，并在 Electron 中先验证 baseline ≤1px。

# D4 跳转即时 hydration 与模板注入实现记录

分支：`perf/performance-optimization`
任务：v3 Default Track D4“跳转即时 hydration 与调度修复 + 模板注入”。

## 目标

1. 公式激活优先使用按公式 key 缓存的 `HTMLTemplateElement`，注入只执行
   `template.content.cloneNode(true)`。
2. 模板未命中时保留现有 `preparedFormulaHtml` / `innerHTML` 回退路径。
3. 大跳转和端点不等待 300ms scrollend 防抖，rAF 内 drain 视口集合。
4. benchmark 增加模板缓存与 KaTeX 注入诊断字段，不修改 `perf-budget.json`。

## 实现

### 公式模板缓存

新增 `src/renderer/editor/virtualization/formula-template-cache.ts`：

- 按公式 key 惰性创建 `HTMLTemplateElement`；注入时返回
  `template.content.cloneNode(true)`。
- LRU Map 封顶：数量 `<=2400`，总 HTML 字节 `<=48MB`。
- 字节数使用 `TextEncoder` 计算 UTF-8 字节，非浏览器环境回退到 UTF-16
  估算。
- 同一 key 再次传入不同 HTML 时重建模板，避免旧模板污染新文档/缓存清空。
- 导出 hit/miss、bytes、count、evictions、injectCount 以及
  inject p50/p95/max 诊断。

### 激活路径接入

`inline-math-group-registry.ts`：

- `getPreparedInlineFormulaFragment` 先走模板缓存；模板 clone 失败或 HTML
  不可用时才回退现有 `preparedFormulaFragments` 与 `innerHTML` 构建路径。
- 测试重置同时清理模板缓存，避免跨用例污染。

`extensions/math-inline.ts`：

- inline/block NodeView 的 `renderPreview` 激活路径全部优先使用模板 clone。
- 冷渲染 `buildPreviewFragment` 在 `katex.renderToString` 后也写入模板缓存，
  再次激活不再重复解析 HTML。
- 注入耗时统一记录到 `recordKatexInjectMs`，供 benchmark 输出 p50/p95/max。

### 调度修复

`EditorShell.tsx`：

- 大 delta/端点仍走 rAF 调度并在同一帧 `drainQueue`。
- `scrollend` 现在对“大 burst 或端点”都取消 300ms 防抖并立即执行
  `settle + drain + fallback scan`；只有普通小步滚动保留 300ms settle。
- 既有 settle 后同步扫描、raw fallback 测试、anchor compensation 逻辑保留。

### Benchmark 诊断

`scripts/benchmark/performance.ts` 新增字段：

- `template-cache-hits`
- `template-cache-misses`
- `template-bytes`
- `katex-inject-p50-ms`
- `katex-inject-p95-ms`
- `katex-inject-max-ms`

字段同时输出到每个 jump scenario 和汇总区；未改 `perf-budget.json`。

## 小文件验证

已通过：

- `npm test`
- `npx tsc --noEmit`
- `git diff --check`
- `scripts/tests/inline-math-scroll.e2e.test.ts`：33 passed, 0 failed
- `scripts/tests/scroll-endpoints.e2e.test.ts`：19 passed, 0 failed
- `scripts/tests/mode-switch-large.e2e.test.ts`：9 passed, 0 failed
- `scripts/tests/caret-alignment.e2e.test.ts`：252 passed, 0 failed
- `scripts/tests/export-hydrate.e2e.test.ts`：14 passed, 0 failed

## 模板缓存小文件 benchmark 数据

使用生成的 ASCII 小文件（1200 个唯一公式、170,939 source bytes）运行
`scripts/benchmark/performance.ts`：

注：仓库指定的中文小文件路径在该 benchmark 的 text-only visual-open gate 下
30s 未达到文本长度阈值；本次模板缓存字段使用同量级 ASCII 小文件采集，未运行
`barfoot_ser24.md` 大文件 benchmark。

| 字段 | bottom | middle | drag | 汇总 |
| --- | ---: | ---: | ---: | ---: |
| template-cache-hits | 0 | 0 | 0 | 0 |
| template-cache-misses | 30 | 31 | 33 | 94 |
| template-bytes | 43,422 | 78,545 | 115,934 | 115,934 |
| katex-inject-p50-ms | 0.2 | 0.1 | 0.1 | 0.2 |
| katex-inject-p95-ms | 0.5 | 0.4 | 0.3 | 0.5 |
| katex-inject-max-ms | 1.4 | 0.6 | 0.6 | 1.4 |

小文件 jump 全部满足：

- 首帧 placeholder=0
- drift=0
- inline-math-activate-ready <=5.5ms
- viewport KaTeX ready=0ms

## 状态

READY_FOR_LARGE_BENCHMARK

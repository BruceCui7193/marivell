# Stage D5 typing 热路径优化（2026-08-12）

## 1. 目标与结论

D5 目标是让普通文本输入只做 changedRange 局部的 decoration 更新，并消除
typing 路径上的 PM rect/坐标读取。实现后小文件 5 次输入事务（每次插入 + undo +
双 rAF）诊断结果：

| 指标 | Stage 5 小文件基线 | D5 小文件结果 |
| --- | ---: | ---: |
| PM dispatch | 15 次 / 89.8ms | 12 次 / 9.4ms |
| rect 读取 | 80 次 / 0.1ms | 0 次 / 0ms |
| coordsAtPos | 未单独统计 | 0 次 / 0ms |
| math-syntax full rebuild | 0 | 0 |
| math-syntax local rebuild（本次普通文本 changedRange 内无公式 span） | - | 0 |
| long task | 0 | 0 |
| 5 次事务 wall（含 rAF 等待） | 772.6ms | 855.3ms |

说明：wall 主要包含 5 次 insert + 5 次 undo 和每次后的双 rAF 等待；dispatch
的同步主线程耗时从 89.8ms 降到 9.4ms，且 rect/坐标读取归零。本次普通文本输入点
位于文档第一个 textblock，changedRange 内没有需要新建的 math-syntax span，
因此 local rebuild 为 0；full rebuild 为 0 证明没有发生全文档 decoration 重建。

## 2. 实现逻辑

### 2.1 MathSyntaxHighlight 不再在 typing 时触发 viewport 重建

`src/renderer/editor/plugins/math-syntax-highlight.ts` 中，普通小范围
`docChanged` 仍通过 `tr.changedRange()` 计算局部范围，并只 remove/add 该范围
内的 decoration。原来“changedRange 与 viewport range 相交就触发 viewport
refresh”的路径已移除；viewport range 只通过 `tr.mapping` 映射到新位置。

这样 typing 不会在事务后再次 dispatch viewport meta、不会调用
`posAtCoords`，也不会重建 viewport decoration。

### 2.2 消灭 PM typing 路径的 rect 读取

PM 在 selection 更新时会做两类高成本读取：

- `scrollToSelection`：通过 `coordsAtPos` 和 `scrollRectIntoView` 读取大量
  Range/Element rect。
- `storeScrollPos` / `resetScrollPos`：仅当 ProseMirror 根元素没有 inline
  `overflow-anchor` 样式时执行，会扫描视口附近元素并读取 rect。

D5 做了两处对应处理：

1. 在 MathSyntaxHighlight 的 plugin view 创建时给 ProseMirror 根元素设置
   `overflow-anchor: none`，让 PM 跳过 scroll-preservation 扫描。这是 PM 源码
   检查的 inline style，单靠 `.editor-frame { overflow-anchor: none }` 不会命中。
2. 对普通小范围文档变更，若新 selection 落在 changedRange 内，则由
   `handleScrollToSelection` 直接返回 true，跳过 PM 默认的 `coordsAtPos` +
   `scrollRectIntoView`。大范围粘贴、off-screen 跳转等仍走 PM 默认滚动。

### 2.3 decoration 诊断语义

`fullBuildCount` 现在只在真正从 ranges 重建 decoration set 时递增；增量 add
继续计入 `localBuildCount`。`MathSyntaxDiagnostics` 增加 `viewportFrom` /
`viewportTo`，便于脚本确认 typing 期间 viewport 范围状态。

### 2.4 块级容器 contain 实验

保留当前分支 D3 已有的块级容器实验：

```css
.editor-frame:not(.is-source) .editor-host {
  transform: translateZ(0);
  will-change: transform;
  contain: layout style;
}
```

该规则只作用于 `.editor-host` 块级容器，没有用于 inline 公式，也没有新增
`content-visibility` 或 `contain: paint`。`caret-alignment.e2e` 252 项断言全部
通过，因此保留该 contain；未触发回退。

## 3. 新增诊断脚本

`scripts/benchmark/typing-hotpath-diagnosis.ts` 独立于
`scripts/benchmark/performance.ts`，不修改 D4 待用的 benchmark 文件。

运行方式：

```bash
npx tsx scripts/benchmark/typing-hotpath-diagnosis.ts '<small-file.md>'
```

记录指标：

- MathSyntaxHighlight full/local decoration rebuild 次数；
- Element/Range rect 读取次数与首批调用栈；
- PM `dispatch` 次数与耗时；
- `coordsAtPos` / `posAtCoords` 次数与耗时；
- long task 分布；
- 每次 insert/undo 的独立计数。

本次原始 JSON：

```text
/tmp/marivell-typing-hotpath-面向不同车型的2.5D野外地形风险感知路径规划：机器学习与搜索算法双向嵌套完整方案.json
```

## 4. 验证

- `npm test`：通过（unit + fixtures）。
- `npx tsc --noEmit`：通过。
- `git diff --check`：通过。
- `caret-alignment.e2e.test.ts`：252 passed。
- `math-layout.e2e.test.ts`：8 passed。
- `math-syntax-scoped.e2e.test.ts`：16 passed。
- `editor-history.test.ts`、`mode-edit.test.ts`：随 `npm test` 通过。

未运行 `barfoot_ser24.md` 大文件 benchmark，等待主代理后续独占复测。

结论：`READY_FOR_LARGE_BENCHMARK`。

# Stage 4a 性能诊断报告：React NodeView 成本

## 1. 结论

Stage 4b **不触发**。

大文件 `/home/crh/下载/barfoot_ser24/barfoot_ser24.md` 中，React NodeView 只在打开阶段初始化 112 个节点（CodeBlock 2、ImageView 110），主线程 React 工作合计约 29.3ms；在普通输入、行内公式插入、Undo/Redo、模式切换和大范围滚动路径中，NodeView 更新次数与 React commit 次数均为 0。React commit 不是打开、模式切换或输入的主瓶颈。

当前大文件的主要成本仍然是 worker/parse 等待、PM 原生 DOM 更新、以及模式切换/滚动时的 layout/测量工作。

## 2. 执行方式

- 分支：`perf/performance-optimization`
- commit：`7c5a399`
- 文件：`/home/crh/下载/barfoot_ser24/barfoot_ser24.md`
- 诊断脚本：`scripts/benchmark/stage4-diagnosis.ts`
- 运行命令：

```bash
npx tsx scripts/benchmark/stage4-diagnosis.ts '/home/crh/下载/barfoot_ser24/barfoot_ser24.md'
```

诊断包含三类测量：

1. `PerformanceObserver('longtask')` 记录每个路径的 long task 分布。
2. 临时 benchmark-gated 插桩记录 PM `EditorView.dispatch`、Tiptap `ReactRenderer.render`、`ReactNodeView.update/select/deselect/destroy`、组件 render 次数、`getBoundingClientRect`/`getComputedStyle`、worker 消息等待、公式渲染和隐藏高度测量。
3. MutationObserver 统计全局 DOM 变更以及 NodeView 根节点的 added/removed/attributes 数量。

CDP `Performance.getMetrics` 在本机 Electron 会话中返回的 layout/paint 计数为 0 或接近 0，无法用于本诊断；因此 layout 成本改用 layout 读取插桩与 long task 交叉验证。带完整插桩的原始 JSON 保存于 `/tmp/marivell-stage4-barfoot_ser24.instrumented.json`；后续复跑脚本可得到未插桩路径的 long task/DOM/滚动 hydration 数据。

## 3. 路径耗时与成本分解

| 路径 | wall ms | long task 次数 | long task 总 ms | 最大 task ms |
| --- | ---: | ---: | ---: | ---: |
| 打开到视觉就绪 | 4993.7 | 9 | 2231.0 | 958.0 |
| 普通输入 | 531.7 | 2 | 150.0 | 82.0 |
| 行内公式插入 | 514.8 | 4 | 416.0 | 152.0 |
| Undo | 329.2 | 3 | 285.0 | 107.0 |
| Redo | 363.7 | 3 | 286.0 | 131.0 |
| visual→source | 2058.3 | 4 | 1738.0 | 1389.0 |
| source→visual | 1029.1 | 3 | 798.0 | 501.0 |
| 大范围滚动 | 2671.1 | 6 | 2593.0 | 1020.0 |

### 3.1 PM dispatch / NodeView / React

| 路径 | PM dispatch 次数 | PM dispatch ms | React render 调用 | React render ms | NodeView update 次数 | NodeView component render |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 打开 | 14 | 672.1 | 112 | 2.9 | 0 | codeBlock 2, image 110 |
| 普通输入 | 3 | 12.5 | 0 | 0.0 | 0 | 0 |
| 行内公式插入 | 2 | 84.9 | 0 | 0.0 | 0 | 0 |
| Undo | 1 | 81.4 | 0 | 0.0 | 0 | 0 |
| Redo | 1 | 86.2 | 0 | 0.0 | 0 | 0 |
| visual→source | 3 | 9.2 | 0 | 0.0 | 0 | 0 |
| source→visual | 5 | 13.5 | 0 | 0.0 | 0 | 0 |
| 大范围滚动 | 2 | 8.8 | 0 | 0.0 | 0 | 0 |

React 打开路径中另有 `flushSync` 调用 112 次、合计 26.4ms。这些调用来自 NodeView 初始化，与 `rendererRenderMs` 有重叠，实际 NodeView 初始化总成本约 29.3ms。

### 3.2 Layout 读取、worker、公式与高度测量

| 路径 | getBoundingClientRect 次数 | rect ms | worker post/message | worker wait ms | KaTeX fallback ms | height flush ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 打开 | 226 | 0.3 | 7/5 | 6960.8 | 未在就绪窗口采样 | 未在就绪窗口采样 |
| 普通输入 | 370 | 0.5 | 5/5 | 546.4 | 0.0 | 0.8 |
| 行内公式插入 | 368 | 4.3 | 0/1 | 201.4 | 1.9 | 4.5 |
| Undo | 360 | 12.3 | 0/0 | 0.0 | 0.0 | 12.6 |
| Redo | 179 | 0.3 | 0/0 | 0.0 | 0.0 | 0.3 |
| visual→source | 59713 | 31.2 | 0/0 | 0.0 | 0.0 | 0.4 |
| source→visual | 2518 | 4.4 | 0/0 | 0.0 | 0.0 | 0.0 |
| 大范围滚动 | 7248 | 152.8 | 0/0 | 0.0 | 0.0 | 0.0 |

说明：

- worker wait ms 是主线程从 `postMessage` 到收到响应的墙钟等待，包含 Worker 内 parse/KaTeX 时间，不代表主线程 CPU。
- 打开阶段在 `visual-editor-ready` 时公式高度模块尚未被采样到，后续输入路径可稳定采样。
- 打开阶段 long task 合计 2231ms，而 PM dispatch 只占 672ms；其余主要为 PM 原生 DOM 构建、decoration、layout/React 外层 App 更新等。

### 3.3 滚动 hydration

在未插桩复跑中，`scroll-top-middle-bottom-middle` 的现有 hydration 诊断显示：

| 项目 | 值 |
| --- | ---: |
| scroll wall | 2580.6 ms |
| long task 总 ms | 2522.0 ms |
| 最大 long task | 969.0 ms |
| hydrateRunCount | 2 |
| maxHydrateWorkMs | 839.9 ms |
| 第一次 hydrate totalMs | 839.9 ms |
| centerMs / anchorMs / hydrateMs | 265.1 / 76.1 / 425.4 ms |
| activatedBlocks / activatedInlineGroups | 1 / 2 |
| 最终 hydrate scan / activate | 1.1 / 1.0 ms |
| inlineMathActivationReadyMs / MaxFrameMs | 0.5 / 2.0 ms |

这说明大范围滚动的主要成本发生在第一次 hydration 调度与 PM 坐标/锚点/layout 读取，而不是 React NodeView。

## 4. NodeView 数量与 DOM 替换

初始视觉模式：

| NodeView | PM model | DOM | active | placeholder |
| --- | ---: | ---: | ---: | ---: |
| CodeBlockView | 2 | 2 | 0 | 4 个 class 出现（2 个 wrapper + 2 个 pre） |
| ImageView | 110 | 110 | 0 | 110 |
| MermaidBlockView | 0 | 0 | 0 | 0 |
| FootnoteDefinitionView | 0 | 0 | 0 | 0 |
| HTML block NodeView | 0 | 0 | 0 | 0 |

模式往返后数量不变：model 仍为 112，DOM 仍为 112。

各路径 NodeView 根节点的 DOM 替换：

| 路径 | codeBlock added/removed | image added/removed | mermaid | footnote | html |
| --- | ---: | ---: | ---: | ---: | ---: |
| 打开 | 2/0 | 110/0 | 0/0 | 0/0 | 0/0 |
| 普通输入 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| 行内公式插入 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| Undo/Redo | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| visual→source | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| source→visual | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| 大范围滚动 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |

结论：当前文件中只有 CodeBlock 和 Image 是实际存在的 React NodeView；所有交互路径都未触发它们的 NodeView update、component render 或 DOM 替换。

## 5. 是否触发 Stage 4b

不触发。

数据依据：

1. 打开阶段 React NodeView 初始化约 29.3ms，占 `visual-open` 4993.7ms 的 0.6%。
2. 输入、Undo/Redo、模式切换、滚动的 React NodeView render/update 均为 0。
3. 打开阶段 PM dispatch 672.1ms、worker/parse 等待 6960.8ms、long task 2231ms 都远大于 React 成本。
4. mode-switch 的主要成本是 59713 次 layout 读取和 1738ms long task，而不是 NodeView。
5. 滚动主要成本是 7248 次 layout 读取和 2593ms long task，NodeView 无更新。

如果未来需要继续优化，应按当前数据优先处理：

1. Stage 3 的布局/模式切换策略，尤其是 `visual→source` 的 layout 读取和长任务。
2. worker/parse 与公式预取等待，打开路径仍可见约 7s 主线程等待。
3. 滚动 hydration/layout 读取，而非 React NodeView。
4. 若之后仍要处理 NodeView，当前只有 ImageView 有足够数量（110），优先验证 ImageView 激活/懒加载；CodeBlock 仅 2 个，收益很小。

## 6. 临时改动与工作区

诊断运行期间添加了 benchmark-only 的临时插桩：

- `src/renderer/perf-stage4.ts`
- `src/renderer/main.tsx`
- `src/renderer/editor/extensions/math-inline.ts`
- `src/renderer/editor/virtualization/height-measurer.ts`
- `src/renderer/editor/node-views/CodeBlockView.tsx`
- `src/renderer/editor/node-views/ImageView.tsx`
- `src/renderer/editor/node-views/MermaidBlockView.tsx`
- `src/renderer/editor/node-views/FootnoteDefinitionView.tsx`

这些临时改动已回退，不留影响默认行为的常驻逻辑。保留文件：

- `scripts/benchmark/stage4-diagnosis.ts`
- `docs/performance-stage4-diagnosis.md`
- `docs/performance-benchmark.md`
- `docs/performance-next-phase-plan-v2.md`

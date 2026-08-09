# Marivell 性能优化长期路线图（2026）

> 本文是研究方案，不包含代码改动。当前基线见 [performance-benchmark.md](performance-benchmark.md)。
> 状态：**基于五项对比实验与全功能盲区二次审计的最终候选路线**。实验结论见 1.3，功能矩阵与红线见 1.4 / 3.11，后续 Phase 实现必须按该结论落地并跑完整回归。

## 0. 决策门槛

在把“单 ProseMirror + 视口节点虚拟化”确定为长期路线前，必须先完成以下实验并满足门槛：

| 实验 | 通过门槛 |
| --- | --- |
| Vanilla JS NodeView vs React NodeView | 通过（有保留）：Vanilla 比 React 更快，但差距不足以解决瓶颈；两者在 2,314 公式下都建立约 72 万 DOM 节点 |
| 占位 NodeView 坐标验证 | `content-visibility` 实测失败：`coordsAtPos` 坐标偏移数千 px；改用稳定高度占位 NodeView 后仍需 Phase 0 交互回归 |
| Scoped Decorations vs 全量 DecorationSet | 通过：全量 `DecorationSet.map()+changedRange` 在 10k 行内公式下约 0.3ms，优于视口范围朴素重建 |
| Worker 传输成本 | 通过：AST/HTML 传输不是主瓶颈；不要传输全部公式 HTML，按视口/索引传输即可 |
| MathML/Temml 视觉对比 | 不通过：MathML 矩阵未正确加粗，字体/间距/符号比例也有差异；继续使用 KaTeX HTML |

方案已按实测收紧为最终候选；是否可用仍由后续 Phase 的完整交互回归和 benchmark 门禁决定。

## 1. 瓶颈归因

当前大文件基线：1.36 MB、16,565 行、2,429 个块级公式。

| 指标 | 当前大文件基线 | 主要嫌疑 |
| --- | ---: | --- |
| markdown-parse | 16,058 ms | 全量 remark 解析 + 占位符恢复的 O(公式数 × 文本节点) |
| renderer-render-to-ready | 28,722 ms | 2,429 个公式节点同步执行 KaTeX、全量 DOM 建立 |
| interaction typing/bold/heading/list/math/table/code/image/footnote | 3,250-5,678 ms | 每次事务全量重建 MathSyntaxHighlight 装饰集 |
| undo/redo | 3,250-3,743 ms | 同样的全量装饰重建 + 大文档 DOM diff |
| combined | 16,673 ms | 上述成本叠加 |
| scroll-avg-frame | 157 ms | 所有块都参与 layout/paint，玻璃效果也增加合成成本 |
| scroll-max-frame | 438 ms | 进入大量公式/大块渲染区域 |
| context-menu-open | 787 ms | 在超大文档上创建/定位菜单、采样背景、重建弹层 |

我们自己做的 CPU profile 显示，解析阶段最热的是 `restoreLeakedMathText` 和
`splitTextWithMathPlaceholders`：它们对每个文本节点遍历全部公式占位符。只做
“无占位符快速返回”这一处修复，实测可把当前大文件 parse 从约 16 s 降到约 3 s。
这说明很多瓶颈不是“需要神级优化”，而是算法复杂度从 O(N) 变成了 O(N × M)。

## 1.1 实测证据与关键结论

为了不凭感觉设计，先给出可复现的实测证据：

| 实测项 | 结果 |
| --- | --- |
| KaTeX `renderToString` 渲染大文件全部 2,314 个唯一块级公式 | 约 678 ms |
| KaTeX `renderToString` 渲染 2,503 个唯一行内公式 | 约 146 ms |
| KaTeX HTML 输出平均大小 | 约 10.3 KB/公式 |
| KaTeX MathML-only 输出平均大小 | 约 2.1 KB/公式，约为 HTML 的 1/5 |
| 当前大文件 open-total | 约 28.7 s |

结论非常重要：

1. **公式的 LaTeX 解析/HTML 生成不是 28 s 的主因。** 把所有唯一公式在 Node 中渲染一遍也不到 1 s。
2. 28 s 主要花在“把 2,400+ 公式的 KaTeX DOM、16k 个块全部挂进单个 ProseMirror 编辑器，并让浏览器 layout/paint”。
3. 每次编辑 3.2-5.7 s 的主因更接近“插件对整篇文档做 O(n) 遍历/重建 decoration”，而不是 KaTeX 本身。
4. 因此不能靠“公式懒渲染后慢慢补”解决；那只会把问题从打开时推迟到滚动时，用户看到的仍是伪快。
5. 真正底层解法是：**先消除 O(n) 插件遍历，再大幅减少公式 DOM，最后在单一 ProseMirror 实例内实现“完整 PM 状态 + 视口节点虚拟化”。**

同类项目证据：

- BlockNote 在“很多块、总文本量并不大”时出现输入延迟，原因是多个插件每次 keystroke 都全文档遍历；修复方式是 `transaction.changedRange()` 局部遍历 + 增量 `DecorationSet.map()`，10k blocks 时仍约 30-50 ms/keystroke。
- Lexical 社区对 300-1000 页文档给出的结论也是：单个 editor 的 DOM/EditorState 过大，应采用“Document Model + Chunk Engine + Viewport Virtualization + 多个轻量编辑器”。

## 1.2 外部审核结论与本方案的大修方向

方案已经过外部审核，主要结论是：瓶颈归因准确，但“Chunked Editor（多 ProseMirror 实例）”属于高风险架构，可能破坏选区、IME、Undo/Redo；`content-visibility` 也可能破坏 ProseMirror 的坐标计算；MathML 替换和 React Compiler 都不应作为首选。

我们接受这些核心审核意见，不对该部分做反驳。长期方案大修如下：

1. **保持单一 ProseMirror/Tiptap 实例**，不再拆成多个独立编辑器。
2. 采用“单 PM + 视口节点虚拟化”：所有节点保留在 PM 文档中，离屏复杂节点用轻量占位 NodeView，进入视口前激活为完整 NodeView。
3. **不依赖 `content-visibility: auto`** 做 PM 坐标所依赖的布局；视口虚拟化使用有确定高度的占位节点，避免 `coordsAtPos` / `posAtCoords` 返回不可靠结果。
4. 公式默认保留 KaTeX 视觉输出；Worker 预生成 KaTeX HTML 字符串，MathML/Temml 只做对比实验，不作为默认替换。
5. React Compiler / React 19 不作为性能关键路径，优先把高频公式、代码块等 NodeView 改成纯 Vanilla JS。
6. 增量解析器不作为必选架构，先修复当前 O(N×M) 算法问题；只有实验证明 net win 后才引入。
7. 增加必要的对比实验，再决定最终长期方案。

## 1.3 五项对比实验实测结果

五项实验已实际运行，数据如下：

### 实验 1：Vanilla JS NodeView vs React NodeView

在 JSDOM 中用真实 Tiptap `ReactNodeViewRenderer` 和 vanilla NodeView 挂载 2,314 个块级公式（KaTeX HTML 共约 26.9 MB）：

| 指标 | React NodeView | Vanilla NodeView |
| --- | ---: | ---: |
| 挂载 | 20,346.8 ms | 17,570.7 ms |
| DOM 节点 | 720,236 | 720,236 |
| Node heap 增量 | 2,865 MB | 2,705 MB |
| 单次事务更新均值 | 2.13 ms | 1.73 ms |
| 单次事务更新最大 | 12.8 ms | 8.79 ms |
| destroy | 2,490.1 ms | 1,500.1 ms |

结论：Vanilla 比 React 更快、更省内存，但两者都会因为完整 KaTeX DOM 爆炸（约 72 万节点、2.7 GB JSDOM heap）而无法解决大文件打开/滚动问题。因此 Vanilla JS NodeView 值得做，但不是主解药；主解药必须是减少同时挂载的公式 DOM。

### 实验 2：ProseMirror 坐标与 `content-visibility`

在真实 Electron 中加载 1.3 MB 大文件后给 `.editor-surface > *` 注入 `content-visibility: auto; contain-intrinsic-size: auto 100px`：

| 文档位置 | 基线 `coordsAtPos` top | 注入 CSS 后 top |
| ---: | ---: | ---: |
| 25% | 195,483.9 px | 188,045.5 px |
| 50% | 392,035.2 px | 380,787.6 px |
| 75% | 600,198.1 px | 589,857.0 px |
| 末尾 | 796,446.1 px | 782,673.3 px |

结论：`content-visibility` 会直接改变 PM 的坐标映射，偏移数千像素，足以破坏光标、搜索、大纲、右键定位。最终方案不依赖它，改用确定高度的占位 NodeView。

### 实验 3：Decoration 全量重建 vs 增量 `map + changedRange`

在 JSDOM 中构造 2,400 和 10,000 个行内公式节点（对应 9,600 / 40,000 条 syntax decoration）：

| 实现 | 2,400 公式 keystroke | 10,000 公式 keystroke |
| --- | ---: | ---: |
| 无 decoration（基线） | 5.8 ms | 21.3 ms |
| 当前全量重建 | 8.5 ms | 43.8 ms |
| `DecorationSet.map()+changedRange` | 0.2 ms | 0.3 ms |
| 朴素视口范围重建 | 33-40 ms | 35-40 ms |

结论：当前全量重建会随公式数上涨；`map + changedRange` 利用 PM 树形 DecorationSet，只递归受影响子节点，因此在大文档下几乎不随全文档公式数增长。朴素“只维护视口 decoration”反而因为 `find/remove/add` 重建树而更慢，不采用。

### 实验 4：Worker 传输成本

对当前大文件实测 structured clone / 预渲染成本：

| 数据 | 大小 | 传输或生成耗时 |
| --- | ---: | ---: |
| Markdown 源码字符串 | 1.36 MB | 25.9 ms |
| 解析后 JSON AST | 2.74 MB | 58.6 ms |
| 全部公式 HTML Map | 29.1 MB | 116.6 ms |
| 视口约 50 个公式 HTML | 287 KB | 25.3 ms |
| markdown-parse 当前实现 | - | 约 16.2 s |
| KaTeX 渲染 2,314 个唯一块公式 | - | 约 588-910 ms |

结论：Worker 传输 JSON AST 或少量公式 HTML 不是主瓶颈；不要为了“省传输”去传整个 29 MB 公式 HTML。可以把解析和公式预渲染放 Worker，但主线程仍需先消除 O(N×M) parse 和 DOM 爆炸。

### 实验 5：KaTeX HTML vs MathML 视觉

用 Chrome 截图对比 9 个复杂公式的 KaTeX HTML 和 KaTeX MathML-only 输出，并由 MCP 复查：

- HTML：矩阵、`aligned`、求和、极限、分数、根号均正常。
- MathML：**矩阵中该加粗的数学符号没有加粗**，`aligned` 多行积分公式在 `=` 与 `∫` 之间有明显间距问题，字体、符号比例和上下标间距也与 HTML 有差异。
- MathML 的优势是输出体积约 KaTeX HTML 的 1/5，但视觉未达到默认替换门槛。

结论：保留 KaTeX HTML 作为默认公式输出；MathML/Temml 只保留为后续可选实验，不进入主路线。

## 1.4 功能盲区二次审计：Gemini 4 项 + 全功能矩阵新增清单

### 1.4.0 先纠正盲区 1 的前提

当前 Marivell 的 PDF、长图、Pandoc 导出都先把 PM 文档序列化为 Markdown，再在独立隐藏渲染窗口里用 `markdownToExportHtmlFragment` 渲染，不直接截取编辑器 DOM。所以视口虚拟化本身不会让导出文件变成占位框。真正要保证的是：保存、模式切换、导出、剪贴板永远从完整 PM 模型取数；若未来新增“打印当前视图/截图当前编辑器”这类 DOM 捕获路径，必须 Force Hydrate 并等待完成。

### 1.4.1 Gemini 提出的 4 项盲区

1. **导出/打印 Force Hydrate**：当前导出是 model-based，风险较低；但未来任何 DOM 截图/print 路径必须全量激活并等待。现有导出窗口已经等待图片、字体、Mermaid 完成，这个等待模式可复用为 Force Hydrate 契约。
2. **ArrowDown/PageDown 穿越占位区**：PM 上下键依赖 `coordsAtPos`，占位高度必须可靠，且展开导致的高度变化需要滚动补偿。
3. **大纲/脚注/搜索跳转二次偏移**：跳转必须两阶段：先激活目标及相邻节点，再按真实 `getBoundingClientRect()` 滚动。
4. **拖拽框选/Ctrl+A**：原生 DOM 选区会因占位节点没有完整文本而断裂，需要 PM Selection Decoration 或拖拽期间实时激活。

### 1.4.2 全功能矩阵二次扫描后新增的盲区

| 功能/子系统 | 当前行为 | 虚拟化风险 | 方案 |
| --- | --- | --- | --- |
| 导出 PDF/长图/Pandoc | Markdown → 独立窗口渲染 | 当前无直接风险；未来 DOM 导出/print 会有 | 保持 model 导出契约；任何 DOM 捕获前 forceHydrate + await ready |
| ArrowDown/PageDown/Home/End | PM `coordsAtPos` | 估算高度与真实高度不同，光标跳变 | 见 3.11.2 和 3.11.6 |
| 大纲/脚注/搜索跳转 | `scrollIntoView` + `domAtPos` | 目标附近 placeholder 展开改变高度 | 两阶段定位：先 activate，再真实测量滚动 |
| 鼠标拖拽框选/Ctrl+A | 原生 DOM selection | 占位无文本，高亮断裂 | PM Selection Decoration + 拖拽过程实时激活 |
| 点击/双击/三击/右键 | `posAtCoords` / DOM target | placeholder 坐标不准 | 坐标服务在 `posAtCoords`/`coordsAtPos` 前先激活目标区 |
| 图片粘贴/图片菜单 | `coordsAtPos(info.pos)` | 图片未激活时菜单错位 | 插入/滚动后强制激活目标节点再定位菜单 |
| Math completion | `coordsAtPos(state.to)` | caret 在公式内但 node 未激活 | caret 进入 node 时先 activate |
| IME/拼音输入 | contenteditable | 非叶子 contentDOM 被卸载会断字 | 非叶子不拆 contentDOM；composing 节点禁止降级 |
| Code block | React NodeView + contentDOM | language draft/menu 状态丢失 | 有焦点/菜单不降级；草稿落 attrs 或保持 active |
| Mermaid | React NodeView 异步 SVG | 高度未知、异步旧结果覆盖 | 激活前预渲染/版本号；高度缓存按 code+width |
| Image | `img` loading | 滚动到未加载图片空白 | preload 完成后再进入视口；错误态保留 |
| HTML block | atom innerHTML | 离屏隐藏不影响 model，但复制/选择需保 attrs | placeholder 保留 `data-html`；DOM 导出契约 |
| Table | PM table + CellSelection | 虚拟化会破坏列选择/表格导航 | 禁止虚拟化表格，直到专项矩阵测试通过 |
| Inline math | 非叶子 text node | 行内布局、选区、换行复杂 | 暂不虚拟化 inline；先只虚拟化块级公式 |
| Footnote definition | React NodeView non-leaf | 标签 input/contentDOM 状态 | 保留 contentDOM；有焦点不降级 |
| Source/preview switch | 固定 420ms overlay + ratio scroll restore | 大文档未就绪、虚拟化高度改变 | 等待完整 PM model + viewport ready；anchor restore |
| Open/reload/external change | `replaceEditorContent` | 旧 NodeView registry 未清 | 全量 reset；restore selection 后激活目标 |
| Undo/redo | PM history | activation state 进 history/错位 | 生命周期不进入事务；位置随 mapping 更新 |
| Search highlight | `props.decorations` 全量重建 | 搜索全量 decoration 仍 O(n) | search 也改 plugin state + `map+changedRange` |
| 统计/大纲/字数 | PM model | 无 DOM 风险 | 保持 model-based，并加 invariant 测试 |
| 设置/主题/玻璃 | UI 外层 | 主题变化影响节点高度 | theme/zoom/resize/font ready 后失效高度缓存 |

## 2. 目标

目标不是把 1.3 MB 文档当成“小文档”，而是让首屏可用、编辑响应进入人眼无感范围：

| 指标 | 当前 | 阶段目标 | 最终目标 |
| --- | ---: | ---: | ---: |
| markdown-parse | 16,058 ms | ≤ 1,000 ms | ≤ 50-100 ms |
| renderer-render-to-ready | 28,722 ms | ≤ 3,000 ms | 完整模型就绪 ≤ 300 ms，当前视口同步渲染，离屏节点预加载 |
| interaction typing | 5,459 ms | ≤ 100 ms | ≤ 16 ms |
| interaction bold/heading/list/math/table/code/image/footnote | 3.2-5.7 s | ≤ 100 ms | ≤ 16-50 ms |
| undo/redo | 3.2-3.7 s | ≤ 100 ms | ≤ 16-50 ms |
| combined 5 步 | 16.7 s | ≤ 500 ms | ≤ 100-200 ms |
| scroll-avg-frame | 157 ms | ≤ 16 ms | ≤ 8-10 ms |
| scroll-max-frame | 438 ms | ≤ 32 ms | ≤ 16-20 ms |
| context-menu-open | 787 ms | ≤ 100 ms | ≤ 16-50 ms |

“毫秒级别”不等于所有 1.3 MB 内容同时秒开，也不等于后台慢慢补全。正确目标是：完整文档模型先建立，当前视口永远显示最终渲染结果；用户滚动/跳转前目标节点区域已 ready，不允许看到未渲染公式。

## 3. 2026 年的可行技术栈

### 3.1 增量解析器

当前 `remark/unified` 是“全量重建 AST”。2026 年的编辑器更适合增量语法树：

- `@lezer/markdown`：CodeMirror 使用的增量 Markdown 解析器，输入变更时只重解析受影响区域。
- `tree-sitter-markdown` + `web-tree-sitter`：增量解析系统，可编译到 WASM，在 Web Worker 中维护语法树。
- `markdown-wasm`：速度极快，但输出 HTML 而不是 AST，不能直接替代现有 ProseMirror 文档构建；适合只读预览、首屏 HTML、导出或缓存层。

长期架构建议：

1. 维护一份“原始 Markdown”作为 canonical 数据，永远不要为了内部解析而改写用户文件。
2. 增量解析器在 Worker 中维护 Markdown AST 和偏移表。
3. 通过 source map 把 Markdown 偏移映射到 ProseMirror 位置，只把变化子树转换成 Tiptap JSON/事务。
4. 打开文件时先用缓存/快速 HTML 渲染首屏，Worker 后台构建完整 ProseMirror 文档。

### 3.2 Worker 化重计算

以下几项都可以移出主线程：

- Markdown 解析、序列化、大纲、字数统计。
- KaTeX `renderToString`。
- 源码语法高亮。
- Mermaid 图生成/导出。
- 公式缓存预计算。

现代 Electron/Chromium 支持：

- `Web Worker` + `Comlink`/transferable objects。
- `OffscreenCanvas`：Mermaid、导出长图等可以离屏绘制。
- `scheduler.postTask` / `scheduler.yield`：把主线程剩余长任务切成可中断小片。
- `requestIdleCallback`：后台补全不抢交互帧。

### 3.3 公式渲染：全量预渲染 HTML/MathML，当前视口禁止延迟

实测证明公式解析本身不到 1 s，所以不需要“滚动到才渲染”。真正的问题是公式 DOM 太大且塞进单个巨型编辑器。

方案：

1. 打开文件时，Worker 用 `katex.renderToString` 或 Temml/MathML 预渲染全部唯一公式，预计 <1 s。
2. 公式结果按原文 hash 缓存；再次打开直接复用。
3. 不默认切换 MathML-only；实测矩阵加粗、间距和符号比例不达标。MathML 体积优势保留为后续实验，但不作为主路线。
4. 当前视口内的公式必须在显示前同步插入 DOM；离屏公式使用占位 NodeView 和稳定高度，禁止依赖 `content-visibility: auto` 维持 PM 坐标。
5. 不允许“用户滚动到中间后公式才出现”；目标节点区域在进入视口前必须完成公式 DOM 插入。
6. 公式 NodeView 始终保留可编辑 contentDOM，preview 只是渲染投影。

KaTeX 官方明确支持 `renderToString`；Temml 是轻量 TeX-to-MathML 转换器，适合作为 MathML 渲染候选。是否切换必须以截图对比和渲染测试为准，不能只看性能。

### 3.4 不再每次事务全量重建装饰

ProseMirror 官方指南明确建议：大量 decorations 时不要把 `DecorationSet.create` 放在每次 redraw；应把装饰集放进 plugin state，事务中 `map` 映射，只改受影响区间。

当前 `MathSyntaxHighlight` 的 `apply` 在 `docChanged` 时对整篇文档重新 `buildDecorationsForDoc`，这是大文件每次编辑都 3 s+ 的最直接嫌疑。

BlockNote 在大文件优化中验证过同类问题：多个插件每次 keystroke 全文档遍历，修复为 `transaction.changedRange()` 局部处理 + 增量 `DecorationSet.map()` 后，10k blocks 约降到 30-50 ms/keystroke。

应改成：

```text
init: 建立一次完整 DecorationSet
apply: set.map(tr.mapping, tr.doc)
       + 只对 transaction.changedRange() 涉及的区间增删 decoration
```

实验结论：`DecorationSet.map()` 在 PM 的树形实现里只递归受影响的子节点，因此在真实多块文档中并不是 O(所有公式)；10,000 个行内公式、40,000 条 decoration 的 `map + changedRange` 实测约 0.3ms。反而“只重建视口范围”的朴素实现因为要 `find/remove/add` 重建树，实测 35-40ms，明显更差。最终做法是：

- 保留完整 `DecorationSet`，每次事务先 `set.map(tr.mapping, tr.doc)`。
- 只对 `transaction.changedRange()` 范围内的公式重新 tokenize 并增删 decoration。
- 数学语法高亮如果能在 NodeView 内用 CSS/类名实现，仍优先使用，避免 decoration 的树维护成本。
- 搜索高亮也使用同样的 `map + changedRange` 策略；不要建立独立“视口 decoration 集”。

### 3.5 Tiptap / React 集成优化

Tiptap 官方性能指南已经明确：

- 把编辑器隔离在独立组件，避免无关 state 重渲染。
- 默认 `useEditor` 会在每次 change 重渲染，应使用 `shouldRerenderOnTransaction: false`。
- 用 `useEditorState` 只订阅必要状态。
- React NodeView 是同步创建、大量实例时很贵，官方建议高数量节点使用普通 HTML DOM。

当前代码已经设置 `shouldRerenderOnTransaction: false`，但还需要：

- 升级到当前 Tiptap 3.x 和 React 19，但 React Compiler / memoization 不作为性能关键路径；优先减少 NodeView 数量和 DOM 节点。
- 把高数量节点从 React NodeView 改为 vanilla NodeView；数学公式已经是 vanilla，代码块/图表如果数量大也应改造。

Tiptap 官方也公开过针对 Claude 大界面性能问题的调查：每键两次渲染、重复扩展名、每次更新都转 Markdown 是常见原因。我们的编辑器已经避免每次键都转 Markdown，但要继续审计 React 重渲染。

### 3.6 浏览器级渲染跳过不作为主方案

`content-visibility: auto` 可以跳过离屏内容的 layout/paint，但 ProseMirror 的光标定位依赖 `coordsAtPos` / `posAtCoords`，离屏尺寸不可靠会造成坐标崩塌。实验已经实测失败：在 1.3 MB 大文件中给 `.editor-surface > *` 注入 `content-visibility: auto` 后，`coordsAtPos` 在 25%-末尾位置偏移 5,000-14,000 px。
- 主方案仍是：单 PM + 稳定高度占位 NodeView，离屏复杂节点在 DOM 层替换为轻量占位。
- 如果未来只想在非 PM 的静态容器上使用，可以单独评估，但不能依赖它保证编辑坐标。

### 3.7 弹层与右键菜单

当前右键菜单 787 ms，很可能是自定义 portal 弹层在超大文档上重新建立、定位并做玻璃背景采样。

方案：

- 使用原生 `Popover API`，菜单进入 top layer，减少和编辑器 DOM 的耦合。
- 复用预创建的菜单 DOM，不在每次打开时重新构建整个菜单。
- 定位只依赖事件坐标和视口，不要遍历/测量整篇编辑器。
- 大文档下降低或关闭菜单玻璃效果；滚动时暂停玻璃采样，停止滚动 100 ms 后恢复。
- 右键菜单的逻辑和键盘 `Ctrl+V`、剪贴板等保持一致，避免测试分支差异。

### 3.8 真正的可视化快：单 ProseMirror + 视口节点虚拟化

“首屏先用源码模式”和“滚动后公式才渲染”都是伪快。真正的目标仍是：

1. 打开后直接进入可视化模式。
2. 完整 ProseMirror 文档状态在可交互前建立。
3. 当前视口显示给用户前，必须是最终渲染结果。
4. 用户滚动/跳转/搜索到任何位置，目标节点必须已经准备好，不能出现“文字在但公式没渲染”。
5. 源码模式只是用户主动选择的视图，不是打开大文件的退路。

实现采用 **单一 ProseMirror 实例 + 视口节点虚拟化**：

```text
Canonical Markdown / ProseMirror Document（完整状态，唯一事实来源）
        |
Viewport Node Virtualization（只激活视口附近的复杂 NodeView）
        |
Vanilla JS NodeView（公式/代码块/图片/Mermaid 等高频重节点）
        |
轻量占位 NodeView（离屏复杂节点，使用稳定/缓存高度）
        |
Incremental Decorations（map + changedRange）
```

关键约束：

- 绝对不拆成多个 ProseMirror 实例，避免破坏全局 Selection、IME、Undo/Redo。
- 离屏复杂节点仍然存在于 PM 文档，但在 DOM 层用占位 NodeView 代替完整渲染。
- 占位节点必须有可靠高度：优先使用已测量高度缓存；未知高度用同类型节点默认高度估算。
- 节点进入视口前必须激活为完整 NodeView；用户看到该节点时，它已经是最终渲染结果。
- 公式/代码块/图片等节点离开视口后可降级回占位，控制 DOM 和内存规模。

## 3.9 功能与交互实时性审计

性能优化必须先把“功能不受影响”作为硬约束。以下逐个审查上面方案对功能、编辑实时性、
选择/光标、复制粘贴、搜索跳转、弹层行为、视觉一致性的影响。

| 方案 | 主要功能/实时性风险 | 修改后的结论 |
| --- | --- | --- |
| 增量解析器 | 自定义 Markdown 语法覆盖可能不足；保存时可能被规范化改写；解析结果和 remark 不一致 | 不能直接替换现有 parser。先做 dual-parser 对照测试，所有 fixture、渲染交互测试、markdown 往返测试通过后才切换；长期保留 remark 作为 fallback |
| Worker 解析/公式预渲染 | 异步结果可能过期；公式先显示占位再“闪出”，编辑公式时 preview 可能与内容不同步 | Worker 只做后台任务，绝不进入输入事务关键路径。主线程保留同步 KaTeX fallback；公式获得焦点、被搜索/跳转、被复制时强制渲染目标公式 |
| content-visibility | 实测破坏 ProseMirror `coordsAtPos` / `posAtCoords`，`coordsAtPos` 偏移数千像素 | 不进入主方案；主方案是单 PM + 稳定高度占位 NodeView |
| windowed rendering / 手工虚拟滚动 | 极易破坏 contenteditable 的 selection、IME、剪贴板、右键、Undo/Redo、跨块选择 | 不作为主方案；只有占位 NodeView 实验通过完整交互矩阵后才考虑 |
| 增量 DecorationSet | mapping 错误会导致搜索/公式高亮错位，甚至 DOM decoration 丢失 | 必须用事务 mapping 并加专用测试；小文档/调试模式可回退到全量重建；不能只追求快而牺牲高亮正确性 |
| Tiptap 3 / React 19 / React Compiler | 升级可能破坏现有扩展、NodeView、ref、事件、剪贴板行为 | 作为独立迁移，不混入性能优化。每次升级必须跑完整 render-interaction 和真实 Electron 回归 |
| Popover API | 菜单层级、主题玻璃、i18n、快捷键、右键行为可能与现有实现不同 | 先做 feature flag；保留现有 portal 实现作为 fallback；视觉和交互测试通过后再默认启用 |
| 大文档降级玻璃效果 | 如果强制关闭，用户看到的界面变化属于功能/外观回退 | 不要默认关闭。改为滚动期间暂停采样、停止滚动后恢复；或提供设置项，让用户决定 |
| 解析/JSON 缓存 | 外部修改文件、mtime 不变、Undo/Redo 历史、版本切换时可能读到旧内容 | 缓存 key 必须包含文件 hash + mtime + 当前会话版本；缓存只作为加速，不能替代 canonical Markdown 读取和保存 |
| editable-ready 拆分 | 如果 ProseMirror 状态还没完整建立就让视觉模式可编辑，用户可能点击到占位块、光标丢失、编辑被覆盖 | 视觉模式必须等完整 PM/Canonical Model 建立后才开放；单 PM 的视口节点虚拟化只影响 DOM 渲染，不允许用源码模式充当首屏 |

## 3.10 红线

1. 用户输入必须在主线程同步进入 ProseMirror 事务；任何 Worker、异步解析、调度器都不能出现在 keystroke 关键路径上。
2. 保存、模式切换、导出必须使用 canonical Markdown；缓存和增量解析不得改写用户文件格式。
3. 公式的 contentDOM 必须始终可编辑；preview 懒渲染不能破坏光标、Backspace、Enter、复制、右键、焦点编辑。
4. 搜索、跳转到行、大纲定位、复制粘贴命中离屏区域时，必须强制渲染并滚动到目标，保证光标和选区正确。
5. 任何性能改动必须通过现有 `npm test`、render-interaction 测试和 benchmark；大文件性能不能以破坏功能为代价。
6. 所有可能改变视觉/交互行为的降级（玻璃、Popover、公式异步渲染）都必须默认关闭或由用户显式开启。
7. 禁止虚拟化 Table/CellSelection，直到专项表格交互矩阵通过。
8. 禁止卸载非叶子节点的 contentDOM；placeholder 只能替换预览/装饰/高亮 DOM。
9. 有焦点、选区、IME composing、打开子菜单的节点禁止降级为 placeholder。
10. 保存、模式切换、导出必须始终从完整 PM 模型取数；任何新增 DOM 截图/print 路径必须先 forceHydrate。
11. Inline math 首轮不虚拟化；先验证块级公式/代码/图片/Mermaid/HTML 块。
12. 滚动恢复必须用锚点，不能只用 `scrollTop / scrollHeight` 比例。

## 3.11 视口节点虚拟化的功能保持设计

这不是拆多个编辑器，而是在单一 ProseMirror 实例内管理“完整节点”和“轻量占位节点”。

### 3.11.1 节点生命周期

每个复杂节点有三种状态：

- `placeholder`：离屏，DOM 是一个带稳定高度的轻量占位。
- `pending`：即将进入视口，Worker 正在准备 HTML/资源。
- `active`：完整 NodeView 已挂载，用户可以编辑、选择、复制。

状态迁移规则：

- 节点进入预加载范围时，先进入 `pending`，准备完成后切到 `active`。
- 节点进入视口前必须已完成 `active`，否则不允许出现在可见区域。
- 节点离开视口足够远后，可以降级回 `placeholder`，释放 DOM/内存；有焦点、选区、IME composing 或打开子菜单的节点禁止降级。
- 搜索/跳转/大纲定位目标节点时，直接强制 `pending -> active`，完成后再移动光标/滚动。

### 3.11.2 坐标与光标安全

ProseMirror 依赖 `coordsAtPos` / `posAtCoords`。为了避免 `content-visibility` 导致离屏节点尺寸不可靠：

- 占位 NodeView 必须有确定高度：优先用已缓存高度，未知时用同类型默认高度；缓存 key 必须包含 nodeType、内容 hash、宽度、主题、zoom、字体版本。
- 激活/降级时保持占位高度和完整节点高度一致；高度变化发生在视口内时用锚点滚动补偿，不能只改比例。
- 光标进入节点前先激活，再设置 selection。
- 禁止依赖 `content-visibility: auto` 跳过 PM 节点的 layout。

### 3.11.3 公式真正就绪

- 打开文件时，Worker 预渲染全部唯一公式 HTML 字符串并缓存。
- 当前视口/预加载范围内的公式 NodeView 必须在显示前插入 HTML。
- 公式获得焦点、被搜索/跳转/复制时，强制同步渲染。
- 公式 contentDOM 始终可编辑，preview 只是渲染投影。
- 默认保留 KaTeX 视觉输出；MathML/Temml 只做对比实验。

### 3.11.4 增量 DecorationSet

- 保留完整 `DecorationSet`，不单独维护视口 decoration；实测 `map + changedRange` 在 10k 行内公式场景约 0.3ms。
- 插件 apply 先 `set.map(tr.mapping, tr.doc)`，再只处理 `transaction.changedRange()` 涉及的区间。
- 不采用“只重建视口范围”的朴素实现；它需要 `find/remove/add` 重建树，实测反而更慢。
- 如果 NodeView 内用 CSS/类名能实现高亮，就优先不用 ProseMirror decoration。

### 3.11.5 全局交互仍走单 PM

- 跨节点选区、IME、Undo/Redo、复制粘贴仍由同一个 ProseMirror 实例处理。
- 视口虚拟化只影响 DOM 渲染，不改变 PM 的全局 document/selection/history。
- 右键菜单定位使用 PM 的 coordsAtPos，不遍历整篇 DOM。

### 3.11.6 激活控制器与坐标服务

所有依赖 PM 坐标/DOM 测量的功能必须走同一个“激活控制器”，不能各自临时判断：

- `coordsAtPos` / `posAtCoords` / `domAtPos` / `scrollIntoView` 前，先对目标位置前后预加载范围执行 `forceActivate()`。
- 图片菜单、Math completion、右键、点击、拖放、搜索跳转、大纲跳转、脚注跳转统一走该服务。
- 激活采用批量调度：一次事务只激活视口前后 N 个节点，不要在一个 rAF 里同步渲染上千个复杂 NodeView。
- 激活/降级必须带版本号；节点编辑后，旧 Worker 渲染结果不得覆盖新内容。
- 降级规则：有焦点、有选区、IME composing、有打开的 NodeView 子菜单/弹层的节点禁止降级。

### 3.11.7 高度缓存与滚动补偿

- 高度缓存按 `(nodeType, code/content hash, widthBucket, theme, zoom, fontVersion)` 存储。
- 已激活节点记录真实高度；降级为 placeholder 时必须使用该真实高度。
- 未激活节点使用同类型默认高度，但任何进入视口/跳转路径都必须先激活再定位。
- `window.resize`、zoom、主题切换、`document.fonts.ready` 后，失效所有高度缓存并重新测量当前视口。
- Mermaid 等异步高度：先隐藏渲染并拿到真实高度，再允许进入视口；失败时保留错误态而不是空白。
- 高度变化时，若目标在视口内，用锚点 `scrollTop` 补偿；补偿只能针对当前视口锚点，不能只改比例。

### 3.11.8 选区与剪贴板保持

- PM 的 `Ctrl+C` / `Ctrl+V` / 拖拽复制始终基于 PM Document Slice，不依赖占位 DOM。
- 鼠标拖拽跨占位区时，用 PM Selection Decoration 绘制虚拟高亮；如果仍走原生选区，则在拖拽过程中实时激活触摸到的占位节点。
- `Ctrl+A` 必须显示整篇选区高亮，即使大多数节点是占位。
- 非叶子节点（code block、footnote definition、inline math）的 contentDOM 不能被 placeholder 替换；placeholder 只能替换装饰/预览/高亮 DOM。
- 剪贴板 debug 和自定义序列化继续用 PM 模型，禁用 `document.getSelection()` 回退到 DOM 内容。

### 3.11.9 导出/打印契约

- PDF、长图、Pandoc 默认保持 model-based 导出：`getExportPayload()` 必须先 flush 完整 PM 模型，再交给独立渲染窗口。
- 不允许新增从编辑器 DOM 直接截图的导出路径；如未来必须做“打印当前视图”，必须先全量 `forceHydrate()`、等待图片/字体/Mermaid/KaTeX，再执行 capture/print，完成后恢复虚拟化。
- 导出渲染窗口已等待 images、fonts、mermaid；这一等待逻辑复用为全局 ready 门禁。

### 3.11.10 打开/保存/模式切换的锚点恢复

- 保存和导出只依赖 PM 模型，虚拟化不会丢数据；但 `flushVisualSync()` 必须在任何 save/export/mode-switch 前执行。
- 滚动恢复不能只存 `scrollTop / scrollHeight` 比例，必须同时存“锚点节点类型 + 内容/位置 + 节点内偏移”。
- source → visual 模式切换必须等完整 PM 模型和当前视口 ready 后才隐藏切换遮罩，不能依赖固定 420ms。
- 外部 reload / open / `replaceEditorContent()` 必须清空激活注册表、高度缓存、搜索 decoration 和 NodeView 临时状态，再恢复旧 selection 并激活目标节点。

### 3.11.11 搜索与替换

- 搜索匹配和统计继续从 PM model 计算，占位节点不影响命中。
- SearchHighlight 不能继续在 `props.decorations` 里每次全量 `DecorationSet.create`；改为 plugin state 持有完整 DecorationSet，事务中 `map(tr.mapping, tr.doc)` 并只重建 `transaction.changedRange()`。
- 搜索跳转必须走 3.11.6 的激活控制器；`domAtPos` 拿到占位 div 后不能直接 `scrollIntoView` 结束，必须等真实节点就绪再定位。
- 替换命中离屏节点时，PM 事务直接更新 model；激活注册表要按新位置重算，不能依赖旧 NodeView 位置。

### 3.11.12 不虚拟化清单

以下模块在专项测试通过前禁止加入 placeholder 机制：

- Table / CellSelection / 列操作。
- Inline math 的首轮实现；先只虚拟化块级公式。
- 正在编辑/选中/聚焦/IME composing 的任意节点。
- 已打开语言菜单、图片菜单、公式补全、脚注编辑弹层的节点。
- 依赖原生 `contenteditable` 语义的文本块（paragraph、heading、list item、blockquote）。

## 3.12 已完成对比实验与结论

这五个实验已实际执行，完整数据和结论见 1.3：

### 实验 1：Vanilla JS NodeView vs React NodeView

- 将 2,400 个公式/大量代码块分别用 React NodeView 和 Vanilla JS NodeView 实现。
- 对比：首屏 DOM 挂载耗时、每次事务更新耗时、内存占用。
- 结论用于决定是否把所有高频 NodeView 改成 Vanilla JS。

### 实验 2：ProseMirror `coordsAtPos` 与视口占位高度

- 在 16k 块长文档中，给复杂节点使用稳定高度占位 NodeView。
- 测试连续 `DownArrow` 穿越离屏区域、大纲跳转、搜索跳转、右键定位。
- 验证占位高度不会导致光标跳变或坐标错乱。

### 实验 3：Scoped Decorations vs 全量 DecorationSet

- 对比三组实现：
  1. 当前全量 `buildDecorationsForDoc`
  2. 全文档 `DecorationSet.map()` + changedRange
  3. 只维护当前视口/挂载节点的 decoration
- 测量 16k 块下的 keystroke 延迟、CPU、内存。

### 实验 4：Worker 传输成本

- 对比：
  1. Worker 返回完整 JSON AST，主线程建树
  2. Worker 返回公式 HTML 字符串 Map
  3. 只返回当前视口所需 HTML
- 测量 `postMessage` structured clone 耗时、主线程解析/建树耗时、首屏可交互时间。
- 如果传输 HTML 字符串比传 AST 便宜，就把“主线程建 ProseMirror 树”和“公式 HTML 渲染”拆开。

### 实验 5：MathML/Temml 视觉与性能对比

- 对同一批复杂公式分别用 KaTeX HTML、KaTeX MathML-only、Temml 渲染。
- 截图对比大型矩阵、`aligned`、矩阵、求和、极限、分数、根号。
- 同时测 DOM 节点数、layout/paint、内存。
- 只有视觉无明显差异且性能明显更好，才考虑替换；否则继续使用 KaTeX。

## 4. 分阶段实施计划

### Phase -1：对比实验已完成

1. 五个对比实验已执行，结论见 1.3；长期路线已按证据收紧。
2. 用现有 benchmark 和 render-interaction 测试作为基线。
3. 最终架构：单 PM + 稳定高度占位 NodeView + Vanilla JS 高频 NodeView + `DecorationSet.map()+changedRange`，不默认 MathML，不依赖 `content-visibility`。
4. 后续 Phase 实现每完成一层，必须跑完整 benchmark/render-interaction；若出现新的数据推翻结论，再调整路线。

### Phase 0：先消除算法级复杂度，同时搭 Canonical Model 骨架

优先级最高，风险最低：

1. Markdown 占位符恢复/拆分加快速路径，避免 O(N × M)。
2. `MathSyntaxHighlight` 改为增量 DecorationSet mapping；SearchHighlight 同步改 plugin state + `map+changedRange`。
3. 大型文档下禁用非必要 decoration 和 spellcheck。
4. 做稳定高度占位 NodeView 原型，并把 `content-visibility` 作为 A/B 实验项，不进入主方案；同时落地激活控制器、高度缓存、滚动补偿和导出 model 契约。
5. 用现有 benchmark 跑小文件/大文件，验证 parse 和 interaction 是否立刻下降。
6. 建立 Block Model：把 Markdown 解析结果拆成稳定 block 列表，并给 block 分配稳定 ID、原文偏移、类型。
7. 先让 Block Model 只作为只读投影/索引存在，不改变当前编辑行为，为分块编辑器铺路。

预期：parse 16 s → 约 3 s，interaction 3-5 s → 显著下降；同时获得真正分块所需的模型基础。

### Phase 1：Worker + 公式 HTML 缓存 + 节点预加载

1. 建立“后台 Worker 管线”，解析/序列化/公式 HTML 只做后台，不阻塞输入事务。
2. 按文件 hash + mtime + 会话版本缓存 Canonical Document/Node 索引到内存和 IndexedDB。
3. 按公式原文 hash 缓存 HTML；用户滚动/跳转前预加载目标节点，目标节点进入视口前必须 ready。
4. KaTeX `renderToString` 在 Worker 预计算，主线程只注入 HTML；当前视口公式必须同步就绪，公式被焦点/搜索/复制时强制同步 fallback。
5. `scheduler.postTask` 切分后台任务，用户输入优先级永远最高。

预期：当前视口始终是完整渲染结果，滚动/跳转不再出现“公式还没出来”。

### Phase 2：局部解析 + 节点范围映射

1. 先修复当前 O(N×M) 占位符处理；只有实验证明增量解析 net win 后才引入 Lezer/tree-sitter。
2. 维护 Markdown offset ↔ ProseMirror position 映射，用于搜索/跳转/大纲。
3. 编辑时后台结果必须带版本号，旧结果不可覆盖新编辑。
4. 保留原始 Markdown canonical 语义，保存/模式切换始终使用用户当前内容。
5. 搜索、跳转、大纲、复制粘贴基于 PM 文档 + 节点索引，不遍历整篇 DOM。

预期：编辑和 parse 都进入毫秒级，且任意位置都能被立即定位。

### Phase 3：单 PM + 视口节点虚拟化

1. 保持单一 ProseMirror/Tiptap 实例，不拆多个编辑器。
2. 为公式、代码块、图片、Mermaid 等复杂节点实现 Vanilla JS NodeView。
3. 复杂节点离屏时使用稳定高度占位 NodeView，进入视口前激活完整 NodeView。
4. 搜索/跳转/大纲强制激活目标节点，并在显示前完成公式渲染。
5. 插件只处理 `transaction.changedRange()`，decoration 只维护视口可见区间。
6. 原生 Popover API 用 feature flag 迁移，保留现有 portal fallback。
7. 玻璃效果只在滚动期间暂停采样并恢复，不做默认视觉回退。
8. 源码模式保留为“用户主动选择的视图”，但绝不是打开大文件时的伪快退路。

预期：大文件在完整可视化模式下首屏可用，滚动任意位置时目标节点已经 ready。

### Phase 4：真实高度 + 拖拽目标补水 + 零漂移

目标不再是“帧率数字好看”，而是满足两个使用约束：

- 软约束：用户把滚动条拖到任意位置后，目标视口应尽快 ready；延迟越短越好。
- 硬约束：无论 placeholder 补水、节点激活/降级、公式高度变化，都不能让用户视口跳走；`scrollTop` / 视口顶部锚点漂移必须为 0。

明确禁止“静态 AST 高度预测”。字体、行高、margin collapse、宽度折行、DPR 会造成每节点 1-5px 偏差，2400+ 公式会累积成数千像素，直接违反硬约束。高度只能来自真实 DOM 测量。

#### 4A：真实 DOM 高度测量与公式 HTML 全量后台就绪

1. 新建隐藏测量层，不使用 Shadow DOM；必须复用 `.editor-surface` 的字体、CSS 变量、宽度、缩放和 KaTeX 样式。
2. Worker 打开大文件后，在后台渲染全部唯一公式 HTML，并分块回传；主线程只负责缓存，不阻塞 render-ready。
3. 测量采用批量写-读分离：
   - 一个 rAF 内批量写入 50 个待测节点；
   - 下一帧/微任务批量读取 `getBoundingClientRect().height`；
   - 写入高度缓存并清空测量层，避免 Layout Thrashing。
4. 图片高度来自预加载后的自然尺寸/宽高比；Mermaid 高度来自后台渲染 SVG 后的真实测量；HTML block、code block 也纳入同一真实测量路径。
5. 高度缓存 key 继续包含 nodeType、内容 hash、宽度 bucket、theme、zoom、fontVersion；resize、zoom、theme、`document.fonts.ready` 后重测当前视口。
6. 在测量完成前，NodeView 不能假装 placeholder 高度可靠；目标视口内的节点必须等测量完成或直接 active。

#### 4B：拖拽目标补水、任务撤销与零漂移锚定

1. 新建 LIFO 距离优先 hydration 队列：
   - 任务权重按到当前视口中心的距离排序；
   - 滚动目标变化后，P0 始终是当前目标视口 ±1 屏；
   - 距离超过 2 屏的旧任务立即取消/evict，不再浪费 worker 和主线程。
2. 双缓冲补水：
   - 目标视口内的公式先在 `DocumentFragment` 中完成 KaTeX HTML 注入；
   - 当前帧 paint 前同步替换 placeholder；
   - 用户看到的第一个 Paint 帧必须是最终渲染，不允许“空白 → 公式”FOUC。
3. 滚动条拖动期间：
   - 显式关闭浏览器原生 `overflow-anchor`，避免与自定义补水逻辑冲突；
   - 如仍有未测量高度窗口，可用 PM 模型外的顶部/底部 spacer 暂时锁定总 `scrollHeight`，松手后释放并校正；spacer 不能进入 PM 模型，不能污染坐标。
4. 锚点校正：
   - 任何激活/降级/高度变化前，先用 PM 位置记录当前视口顶部锚点；
   - DOM 更新后在同一帧恢复锚点；
   - 不做 smooth scroll 补偿，确保零漂移。
5. 搜索、大纲、脚注跳转继续走两阶段：先强制激活目标区域，再按真实 `getBoundingClientRect()` 定位。

#### 4C：按需处理剩余 DOM 热点

如果 4A/4B 后仍无法满足拖拽帧率/零空白，瓶颈大概率在未虚拟化的 inline math、表格或普通文本 DOM。届时增加轻量行内渲染/视口化小阶段，不在 4A/4B 里强行塞入复杂改造。

#### Phase 4 验收

- `scroll-jump-bottom`：一次性拖到底部，停止后第一帧视口内复杂节点不能是 placeholder。
- `scroll-jump-middle`：从底部拖回 50%，停止后第一帧目标视口 ready。
- `scroll-drag-sequence`：Top → Bottom → Middle 连续拖拽，最终目标视口 ready，`scrollTop` 漂移为 0px。
- 拖拽过程中主线程不出现 >50ms Long Task 是目标；若被 inline math 等剩余 DOM 卡住，转入 4C，不能降低“零空白/零漂移”硬约束。

### Phase 5：性能预算和发布回归门禁

1. 扩展现有 benchmark，加入性能预算文件与 Phase 4 新滚动场景。
2. `npm test` 继续跑暴力渲染交互回归。
3. 新增 trace/profile 测试：长任务、layout、paint、worker 时间。
4. 大文件不通过预算就禁止 release。

## 5. 风险和边界

- `markdown-wasm` 不能替代自定义 ProseMirror AST，只能作为预览/缓存层。
- `tree-sitter-markdown` 对 GFM、脚注、数学、Mermaid 的覆盖需要验证/扩展。
- `content-visibility` 不作为 PM 坐标依赖；只有实验证明坐标安全后才可用于非关键静态区域。
- KaTeX Worker 渲染需要和主线程加载同一份字体/CSS/macros，否则视觉不一致。
- 增量 Decorations 必须正确 map 事务，否则搜索/公式高亮会出现错位。
- Popover API 在 Electron 内可用，但现有玻璃效果可能需要降级或包装。
- 性能优化必须以现有暴力渲染测试为兜底；任何可能“更快但坏掉”的改动都会被拦下。
- 异步渲染必须带版本号/取消机制，旧任务结果不能覆盖新用户编辑。
- 视觉编辑模式不应在 ProseMirror 状态未就绪时开放；若使用占位 NodeView，必须验证光标、选择、搜索、剪贴板。
- 不依赖 `content-visibility: auto` 维持 PM 坐标；占位节点必须有确定高度。
- Worker 与主线程之间的大对象传输成本必须先实验，不能假设 Worker 一定净赚。
- MathML/Temml 只能作为视觉对比实验，不能直接替换 KaTeX。
- 单 PM 实例是硬约束；任何“多编辑器分块”方案都不得作为最终架构。

## 6. 验证方式

- 小文件先跑通，再跑大文件：`npm run benchmark`。
- 渲染回归：`npm test`，重点看 render-interaction.test.ts。
- 性能预算：每个关键指标设置 P95/最大值，超限即失败。
- 用 Chrome DevTools Performance trace 检查 Long Tasks、Layout/Paint、Worker。
- 用 React DevTools Profiler 检查编辑器无关组件是否重渲染。

## 参考来源

- Tiptap Integration Performance: https://tiptap.dev/docs/guides/performance
- Tiptap 团队关于 Claude 界面性能问题：https://news.ycombinator.com/item?id=41036078
- ProseMirror Decorations 指南：https://prosemirror.net/docs/guide/#view.decorations
- MDN content-visibility：https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility
- MDN Intersection Observer：https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API
- MDN Popover API：https://developer.mozilla.org/en-US/docs/Web/API/Popover_API
- MDN Scheduler.postTask：https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/postTask
- MDN Scheduler.yield：https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield
- MDN OffscreenCanvas：https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas
- KaTeX renderToString：https://katex.org/docs/api.html
- markdown-wasm：https://github.com/rsms/markdown-wasm
- @lezer/markdown：https://www.npmjs.com/package/@lezer/markdown
- tree-sitter-markdown：https://github.com/tree-sitter-grammars/tree-sitter-markdown
- React Compiler：https://react.dev/learn/react-compiler
- BlockNote large-document typing issue：https://github.com/TypeCellOS/BlockNote/issues/2595
- BlockNote plugin traversal optimization：https://github.com/TypeCellOS/BlockNote/pull/2600
- Lexical chunked multi-editor proposal：https://github.com/facebook/lexical/issues/8743
- Lexical large document performance issue：https://github.com/facebook/lexical/issues/7422
- Temml：https://github.com/ronkok/Temml

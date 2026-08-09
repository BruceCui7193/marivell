# Marivell 性能优化微观执行计划

> 本文由 `docs/performance-roadmap.md` 的宏观方案细化而来，作为后续改代码的约束。
> 状态：Phase 0/1/2 已完成并验证；Phase 3 已完成：块级公式/图片/Mermaid/HTML block/code block 占位、坐标激活、公式 HTML 索引与后台分块预取、插入公式预览立即激活。性能预算门禁仍属于 Phase 4，结果见 `docs/performance-benchmark.md`。

## 0. 总原则

1. 保持单一 ProseMirror/Tiptap 实例，不拆多个编辑器。
2. 任何优化必须先满足功能正确性，再谈性能。
3. 保存、模式切换、导出、剪贴板始终以完整 PM 模型为准，禁止从虚拟化 DOM 取数。
4. 非叶子节点的 `contentDOM` 禁止被占位逻辑卸载。
5. 有焦点、选区、IME composing 或打开子菜单的节点禁止降级为 placeholder。
6. 不默认切 MathML，不依赖 `content-visibility: auto`。
7. 每个 Phase 必须跑 `npm test`、`npx tsc --noEmit`、`git diff --check`，有性能预期时跑 `npm run benchmark`。
8. 大文件性能目标以 `docs/performance-benchmark.md` 和 `docs/performance-roadmap.md` 中的预算为准。

## 1. Phase 0：消除算法级复杂度和建立安全骨架

首批已完成：1.1 Markdown 占位符快路径、1.2 MathSyntaxHighlight 增量、1.3 SearchHighlight 增量。对应测试和 benchmark 结果已记录。

目标：先把当前可明确归因的 O(N×M) 和全量 decoration 成本降下来，不做视口虚拟化。

### 1.1 Markdown 占位符快路径

文件：`src/renderer/editor/markdown.ts`

问题：

- `restoreLeakedMathText(value, placeholders)` 对每个文本/属性字符串遍历全部 math placeholder。
- `splitTextWithMathPlaceholders(text, placeholders)` 对每个文本节点排序并遍历全部 placeholder key。
- `getBlockMathPlaceholder(node, placeholders)` 对每个 paragraph 用 `[...placeholders.keys()].find(...)` 遍历全部 key。

改法：

- 新增 `hasMathPlaceholderToken(value: string): boolean`，只检查当前占位符私有字符 `\uE001` 和前缀 `\uE000MDMATH_`；任何遍历前先快速返回。
- `restoreLeakedMathText` 在无 token 时直接返回原值。
- `splitTextWithMathPlaceholders` 在无 token 时直接返回 `[{ type: 'text', text }]`。
- `getBlockMathPlaceholder` 先检查 paragraph 文本是否包含 token，不包含则直接返回 null。
- `restoreLeakedMathTokens` 保持递归，但每个字符串只在实际含 token 时进入替换；不能改变语义。
- 对 `normalizeMathDelimiters` 的 code placeholder 恢复保持现有行为；如后续 profile 显示仍热点，再单独优化。

约束：

- 不允许把内部 token 改成与用户文本可能冲突的普通字符串；继续使用私有字符 token。
- 必须保留 `tests/fixtures/markdown/literal-tokens.md`、`tricky.md` 等字面 token 测试。
- `parseMarkdown` / `serializeMarkdown` 必须保持 round-trip 稳定。

验收：

- 新增纯逻辑测试：包含 0 个、1 个、多个 math placeholder 的文本；无 token 时不应遍历 placeholder map。
- 现有 `npm test` 全部通过。
- 大文件 `markdown-parse` 应明显低于基线 16,058ms（目标不设具体值，Phase 0 先验证正确性并记录）。

### 1.2 MathSyntaxHighlight 增量 DecorationSet

文件：`src/renderer/editor/plugins/math-syntax-highlight.ts`

问题：

- `apply` 在每次 `docChanged` 都 `buildDecorationsForDoc(newState.doc)`，大文档每次 keystroke 都全量重建。

改法：

- plugin state 从 `DecorationSet` 直接持有完整 decoration set。
- `init` 建立一次完整 `DecorationSet`。
- `apply` 中：
  1. 若 `docChanged`，先 `old.map(tr.mapping, tr.doc)`；
  2. 用 `tr.changedRange(tr.before)` 得到变化区间；
  3. 从映射后的 set 中移除该区间内旧 decoration；
  4. 对该区间调用范围化 tokenize/build；
  5. 用 `DecorationSet.add` 加回新 decoration。
- 非 `docChanged` 的 selection/meta 事务只 `map` 或原样返回。
- `decorations(state)` 返回 plugin state 中的 set，不再每次重建。
- 保持现有 class 名和 DOM 高亮效果不变。

约束：

- 必须验证 inline math 内文本编辑、插入、删除、undo/redo 后高亮仍正确。
- 不允许用“关闭语法高亮”代替正确性修复；大文档仍可高亮。
- 如果 `changedRange` 的实现导致某些边界 decoration 丢失，优先加测试修到正确，不能回退全量重建作为最终方案。

验收：

- 新增或扩展现有测试：在 10k 行内公式文档中执行插入事务，验证 decoration 数量和位置正确、耗时不随全文档增长。
- 现有 render-interaction、mode-edit、math-clipboard、history 测试通过。
- 大文件 interaction 应显著低于基线 3.2-5.7s。

### 1.3 SearchHighlight 增量 DecorationSet

文件：`src/renderer/editor/plugins/search-highlight.ts`

问题：

- `props.decorations` 每次 view update 都重新 `DecorationSet.create(state.doc, search.matches)`。

改法：

- plugin state 增加 `set: DecorationSet`，初始化按当前 search matches 建立。
- `apply` 优先处理 `setSearchHighlights` / `clearSearchHighlights` meta：用新 search 状态全量重建 set。
- 普通 `docChanged` 事务：只 `set.map(tr.mapping, tr.doc)`，不要用旧 search matches 重建 changed range；React 侧在 `visualSearchRevision` 变化后通过 meta 全量重建，避免旧 matches 位置错位。
- `props.decorations` 只返回 plugin state 中的 set。
- 外部 API `setSearchHighlights` / `clearSearchHighlights` 的签名保持不变。

约束：

- 搜索匹配仍从 PM model 计算；不依赖 DOM。
- 高亮 class、当前项 class、替换命中行为必须不变。
- 搜索关闭后必须清空 decoration。

验收：

- 现有搜索相关测试通过；新增替换/undo/redo 后高亮不残留、不错位的测试。
- `npm test` 通过。

### 1.4 大文档降级和 benchmark 门禁

- `EditorShell` 已按大文档关闭 spellcheck；不要再次引入“源码模式先开”的伪快。
- 确保 `scripts/benchmark/performance.ts` 保留大文件和小文件基线；每次 Phase 提交都记录 `perf-report.json` 或更新 `docs/performance-benchmark.md`。
- 本 Phase 不实现 placeholder，因此不触碰导出、搜索跳转、拖拽选区等 3.11 风险面。

## 2. Phase 1：Worker 预渲染、公式缓存与节点预加载

### 2.1 首批实现：Worker 公式 HTML 预渲染缓存

本批只做“公式渲染从主线程移动到 Worker 预生成 + 主线程缓存复用”，不做占位节点。

1. 新建 `src/renderer/editor/math-render-cache.ts`，维护 `Record<key, html>` 内存缓存。
   - key = `display + '\u0000' + latex`，display 只区分 `'yes'` / `'no'`。
   - 提供 `getFormulaCacheKey`、`seedFormulaHtmlCache`、`getCachedFormulaHtml`、`clearFormulaHtmlCache`。
2. 扩展 `src/renderer/editor/markdown.worker.ts`：
   - 请求增加 `includeFormulaHtml?: boolean`。
   - 仅当需要时遍历解析后的 JSON，收集唯一公式 key，用 `katex.renderToString` 生成 HTML。
   - 响应增加 `formulaHtml?: Record<string, string>`。
   - 单个公式渲染失败时跳过该项，主线程保留同步 fallback。
3. `EditorShell.tsx`：
   - 打开/重载大文件时先 `clearFormulaHtmlCache()`，worker 返回后只在 active load 内 `seedFormulaHtmlCache`。
   - source preview 请求默认不预渲染公式 HTML，避免 stale 结果污染缓存。
4. `math-inline.ts`：
   - NodeView 渲染前先查缓存；命中则直接 `innerHTML = cachedHtml`。
   - 未命中仍同步 `katex.renderToString` 并写回缓存，绝不显示空白。
5. 新增测试：
   - 缓存模块 get/seed/clear。
   - 预置缓存 HTML 后，编辑器加载对应公式，DOM 中出现该 HTML 标记。
6. 验证：`npm test`、`npx tsc --noEmit`、`git diff --check`，并跑大文件 benchmark 对比 `renderer-render-to-ready`。

## 2. Phase 1：Worker 预渲染、公式缓存与节点预加载

### 2.2 第二批实现：图片/Mermaid 预加载与缓存生命周期

1. 图片预加载：在 ImageView 挂载前先创建 `Image` 对象预加载 resolved source；只有 `complete` 或 `load` 后再显示当前视口图片，失败保留错误态。
2. Mermaid 预加载：维护模块级 `Map<codeHash, Promise<svg>>`，避免相同代码重复渲染；编辑/主题/窗口大小变化时使缓存失效。
3. 公式缓存生命周期：`clearFormulaHtmlCache` 在 active visual load 时调用；新增按文件 key 和 LRU 上限，避免长期会话里不同文件之间缓存膨胀。
4. 版本号：worker 返回的公式 HTML 必须携带请求/会话版本，只有 active load 且版本匹配时才 seed，旧结果不得覆盖。
5. 新 benchmark 指标：`formula-html-count`、`formula-html-bytes`、`image-preload-count`、`mermaid-cache-hit-rate`（能采集时加入 `scripts/benchmark/performance.ts`）。

### 2.3 第三批实现：图片懒加载与预加载缓存

1. 新建 `src/renderer/editor/image-preload.ts`：
   - `preloadImageSource(src: string): Promise<void>`，用 `new Image()` 预加载并缓存已请求 URL。
   - LRU 上限 200，失败也记录为已处理，避免反复失败重试。
2. 修改 `ImageView.tsx`：
   - `<img>` 增加 `loading="lazy"` 和 `decoding="async"`。
   - NodeView 挂载后，用 IntersectionObserver（rootMargin 约 600px）在图片接近视口时调用预加载；不支持 IntersectionObserver 或资源为 data/base64 时立即预加载。
   - 不阻塞首屏渲染；预加载只是让接近视口的图片提前进入浏览器缓存。
3. 新增测试：图片 NodeView 在 jsdom 中仍渲染 `<img loading="lazy">`，预加载缓存模块支持 URL 去重/清空。
4. 验证：`npm test`、`npx tsc --noEmit`、`git diff --check`，并跑大文件 benchmark 确认不回归。

### 2.4 第四批实现：缓存版本号与 Mermaid 高度缓存

1. `EditorShell.tsx` 增加公式缓存 generation：
   - active visual load 开始时递增 generation 并清空公式缓存。
   - worker 返回后只有当前 generation 仍匹配且 load 仍 active 才 seed，防止 stale 结果覆盖。
2. 新建 `src/renderer/editor/mermaid-cache.ts`：
   - key = `${theme}\u0000${code}`。
   - `getCachedMermaidHeight(theme, code)` / `setCachedMermaidHeight(theme, code, height)` / `clearMermaidHeightCache()`。
3. `MermaidBlockView.tsx`：
   - SVG 渲染完成后测量 preview 高度并写入高度缓存。
   - 后续相同 code + theme 渲染时先读取缓存高度作为初始布局参考，避免明显跳动。
4. 新增测试：cache generation 不 seed 旧版本（如可测则测）；mermaid height cache get/set/clear。
5. 验证：`npm test`、`npx tsc --noEmit`、`git diff --check`。

目标：把解析、公式 HTML 生成移出主线程，建立完整公式 HTML 缓存，但不做 DOM 占位。

文件：`src/renderer/editor/markdown.worker.ts`、`src/renderer/components/EditorShell.tsx`、`src/renderer/editor/extensions/math-inline.ts`、`src/shared/contracts.ts`

计划：

1. 在 worker 中维护 `Map<latexHash, katexHtml>`；解析和公式渲染共用一次 source 扫描。
2. 主线程打开大文件时先同步建立 PM 模型（解析可 worker），再按视口插入公式 HTML；未就绪公式不得出现在可见区域。
3. 公式渲染结果带版本号；节点编辑后旧渲染结果不得覆盖。
4. 增加公式缓存清理策略（按文件 hash + mtime + 会话版本，LRU 上限）。
5. 图片/Mermaid 资源预加载：图片进入视口前开始加载；Mermaid 离屏预渲染并缓存高度。
6. 新增 benchmark 指标：首屏公式就绪率、滚动到公式无占位率、worker 队列延迟。

验收：

- 打开大文件时当前视口所有公式最终渲染，滚动进入公式前已 ready。
- 编辑公式后缓存失效，不允许闪回旧公式。
- 所有导出/保存仍从 model 取数，不受 worker 状态影响。

## 3. Phase 2：局部解析与节点范围映射

目标：为增量解析和锚点跳转建立模型层，但不改变编辑路径。

文件：`src/renderer/editor/markdown.ts`、`src/renderer/editor/selection-markers.ts`、`src/renderer/editor/search.ts`、`src/renderer/utils/document.ts`、`src/renderer/components/EditorShell.tsx`

### 3.1 Phase 2A：Block Model + Outline 不依赖 DOM + 滚动锚点

1. 新建 `src/renderer/editor/block-model.ts`：
   - `BlockModelItem`：稳定 `id`、`type`、`pmPos`、`line`、`text`。
   - `buildBlockModelFromEditor(editor)`：遍历 PM 文档顶层 block，生成稳定 ID（如 `block-${index}-${type}-${shortHash}`）。
   - `getBlockAtPos(model, pos)`：返回 pos 所在或之前最近的 block。
2. 新建 `src/renderer/editor/scroll-anchor.ts`：
   - `ScrollAnchor`：`{ pmPos, offsetTop }`。
   - `captureVisualScrollAnchor(frame, editor)`：用 `posAtCoords` 取视口顶部锚点。
   - `restoreVisualScrollAnchor(frame, editor, anchor)`：内容就绪后用 `coordsAtPos` 恢复滚动。
3. 修改 `EditorShell.tsx`：
   - `handleNavigateOutline` 直接使用 outline 的 PM `start` 位置跳转，不再优先 `querySelectorAll('[data-outline-index]')`。
   - `extractOutlineFromEditor` 的 heading id 使用 Block Model 稳定 ID。
   - 文件切换时的视觉滚动记忆从 `number` 比例改为 `ScrollAnchor`；source 模式暂时保留比例 fallback。
   - `pendingScrollRestoreRef` 兼容 `ScrollAnchor | number`。
4. 测试：
   - Block Model 稳定 ID、pmPos、类型。
   - Outline jump 不需要 DOM 查询（通过纯函数/单元测试覆盖）。
   - Scroll anchor capture/restore 在 jsdom 中不抛错，并尽量验证 pmPos 往返。
5. 验证：`npm test`、`npx tsc --noEmit`、`git diff --check`。

### 3.2 Phase 2B：Markdown↔PM 映射与 Source 滚动锚点

1. 新建 `src/renderer/editor/position-map.ts`：
   - `markdownOffsetToPmPos(markdown, content, offset)`：用现有 selection marker 机制把 markdown offset 插入成唯一 marker，parse 后在 JSON 中定位 marker，返回对应 PM position；调用方负责缓存。
   - 本批先实现 source→visual 方向；visual→source 继续复用现有 mode-switch marker 流程。
2. 扩展 `src/renderer/editor/scroll-anchor.ts`：
   - `SourceScrollAnchor { markdownOffset: number; offsetTop: number }`。
   - `captureSourceScrollAnchor(textarea)` / `restoreSourceScrollAnchor(textarea, anchor)`。
3. 修改 `EditorShell.tsx`：
   - `scrollMemoryRef` 值类型扩展为 `ScrollAnchor | SourceScrollAnchor | number`。
   - source 模式文件切换保存 `SourceScrollAnchor`，visual 模式保存 `ScrollAnchor`，不再只用比例。
   - `pendingScrollRestoreRef` 支持 source anchor；启动时 source 模式用 `restoreSourceScrollAnchor`。
4. 后台增量解析版本沿用现有 request id / formula generation，不新增重复机制。
5. 测试：
   - `markdownOffsetToPmPos` 对普通段落、heading、math、image 的简单文档返回有效 PM position。
   - source scroll anchor capture/restore 在 jsdom 中不抛错。
6. 验证：现有 mode-switch、search、outline、history 测试全通过；大文件 benchmark 无回归。

验收：

- 模式切换、外部 reload、跳转后的光标/滚动位置准确。
- 大文件 outline 跳转不依赖 `querySelectorAll` 遍历全部 DOM。
- 增量解析仅作为加速，若覆盖错误就 fallback 全量 remark。

## 4. Phase 3：单 PM + 视口节点虚拟化

实施顺序（同一 Phase 内的代码批次，不再拆成独立 Phase）：

- **3A 虚拟化核心 + 块级公式**：Height Cache、Activation Controller、NodeView Registry，先只把块级公式改为稳定高度 placeholder；inline math 不虚拟化。
- **3B 坐标/跳转 + 其他复杂节点**：Coordinate Service、两阶段跳转，再把代码块、图片、Mermaid、HTML block 接入 placeholder。
- **3C 选区/剪贴板/导出与验收**：
  1. EditorShell 的搜索跳转、大纲跳转、图片菜单、Math completion 统一调用 `forceActivateAtPosition`；视觉模式插入行间公式后，只要选区/焦点在节点内，NodeView 必须立即激活并显示预览，不能只等 IntersectionObserver。
  2. 拖拽跨占位区用 `forceActivateAtCoords` 实时激活经过的占位节点；`Ctrl+A` 保持完整选区高亮。
  3. 导出保持 model-based；若未来新增 DOM 截图/print，先全量 `forceHydrate()`。
  4. 公式 HTML 改为索引 + 视口 chunk 请求，当前视口/预加载范围必须 ready。
  5. 跑完整交互矩阵和 benchmark，确认无功能回归。

目标：在单一 PM 实例内实现稳定高度 placeholder，不拆多编辑器，不依赖 `content-visibility`。

文件：

- 新建 `src/renderer/editor/virtualization/activation-controller.ts`
- 新建 `src/renderer/editor/virtualization/height-cache.ts`
- 新建 `src/renderer/editor/virtualization/coordinate-service.ts`
- 新建 `src/renderer/editor/virtualization/node-view-registry.ts`
- 修改 `src/renderer/editor/extensions/math-inline.ts`
- 修改 `src/renderer/editor/extensions/code-block.ts`
- 修改 `src/renderer/editor/extensions/mermaid-block.ts`
- 修改 `src/renderer/editor/extensions/editable-image.ts`
- 修改 `src/renderer/editor/extensions/html-block.ts`
- 修改 `src/renderer/components/EditorShell.tsx`

### 4.1 NodeView Registry 与 Activation Controller

1. registry 记录每个复杂节点的状态：`placeholder / pending / active`、PM position、node type、content hash、height key。
2. 状态迁移：
   - 进入预加载范围先 `pending`，准备完成后再 `active`。
   - 节点进入视口前必须已完成 `active`，用户看到时不能是未渲染公式/图片/Mermaid。
   - 离屏足够远后降级回 `placeholder`；有焦点、选区、IME composing、打开子菜单/弹层的节点禁止降级。
3. 调度：
   - 用 IntersectionObserver + preload buffer 批量激活，一次 rAF 不激活上千个复杂 NodeView。
   - 激活/降级带版本号；节点编辑后旧 Worker 结果不得覆盖。
4. 搜索/大纲/脚注/图片菜单/Math completion 等目标跳转统一调用 `forceActivate()`。

### 4.2 Coordinate Service

1. 包装 `coordsAtPos`、`posAtCoords`、`domAtPos`、`scrollIntoView`。
2. 调用前先 force activate 目标区域，避免占位坐标错位。
3. 点击/双击/拖放/右键/图片菜单/公式补全都走同一服务，不能各自临时判断。
4. 目标跳转采用两阶段：先 activate，再按真实 `getBoundingClientRect()` 滚动。

### 4.3 Height Cache 与滚动补偿

1. key = `(nodeType, content hash, widthBucket, theme, zoom, fontVersion)`。
2. 已激活节点记录真实高度；降级 placeholder 使用该高度。
3. `resize`、zoom、theme、`document.fonts.ready` 后失效缓存并重测当前视口。
4. 高度变化时用锚点滚动补偿，不能只改 scrollTop 比例。
5. Mermaid 使用 Phase 1 渲染/高度缓存；图片使用 Phase 1 懒加载/预加载缓存。

### 4.4 NodeView 改造

1. 首轮可虚拟化：块级公式、代码块、图片、Mermaid、HTML block。
2. 首轮不虚拟化：Table/CellSelection、inline math、普通文本块。
3. 非叶子节点只替换预览/装饰 DOM，contentDOM 必须保留。
4. 代码块离屏可保留纯文本 contentDOM、去掉语法高亮 DOM；有焦点/语言菜单不降级。
5. 导出保持 model-based；未来 DOM 截图/print 必须先全量 `forceHydrate()`。

### 4.5 验收

- 大文件滚动目标：avg ≤ 16ms、max ≤ 32ms 作为 Phase 4 门禁；Phase 3 必须保证当前视口/预加载范围公式完整。
- 视觉模式插入行间公式后预览立即显示 latex；render-interaction 与 benchmark 都必须覆盖该体验。
- `DownArrow`、PageDown、搜索跳转、大纲跳转、右键、复制粘贴、图片菜单、Math completion 全部通过交互测试。
- 任何占位展开不得出现未渲染公式/图片/Mermaid。

## 5. Phase 4：性能预算与发布回归门禁

目标：把大文件性能预算变成发布硬门禁，防止后续改动回退。

文件：`package.json`、`scripts/benchmark/performance.ts`、新增 `perf-budget.json`

计划：

1. 将大文件关键指标写入 `perf-budget.json`：open、parse、interaction、scroll、context-menu。
2. `npm run benchmark` 增加 `--check-budget`，或新增 `npm run perf:check`，超预算即失败。
3. 发布脚本/CI 必须串行跑 `npm test`、`npx tsc --noEmit`、`npm run perf:check`。
4. 失败时保留 `perf-report.json` 和必要 trace，方便定位。
5. 大文件至少重复跑 2 次，不能以单次幸运数据作为通过依据。

验收：

- 发布流程必须通过 `npm test`、`npx tsc --noEmit`、`npm run perf:check`。
- 大文件不达标不允许 release。

## 6. 禁止事项（所有 Phase 通用）

- 禁止使用多 ProseMirror 实例。
- 禁止默认切换到 MathML/Temml。
- 禁止依赖 `content-visibility: auto` 维持 PM 坐标。
- 禁止把源码模式当作大文件首屏伪快方案。
- 禁止卸载非叶子 contentDOM。
- 禁止虚拟化 Table/CellSelection。
- 禁止用 DOM 内容替代 PM 模型保存/导出/剪贴板。
- 禁止未经验证就提交性能改动；每个 Phase 必须跑对应验收清单。

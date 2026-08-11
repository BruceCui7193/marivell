# U3.2 坐标引擎 boundary PoC（2026-08-12）

## 1. 结论

本次 PoC 在 U3.1 line-box 原型之上补齐了 `posAtCoords` 的 block gap、视口右侧边界、block 首尾 border 和 wrap/inline math 边界处理，并把构建期逐字符 Range 聚合为 line-box 线段 + Canvas TextMetrics。

- `coordsAtPos`：600 个采样点 p50/p95/max 分别为 `0.004 / 0.008 / 0.620 px`，满足 `<=1px`。
- `posAtCoords`：75 个采样点（48 个视口网格点 + 27 个真实 line/cell 点）pos 偏差 p50/p95/max 为 `0 / 0 / 0`，原生 `coordsAtPos` 映射的 px 偏差同样为 `0 / 0 / 0`。
- 构建期 `Range.getClientRects` 从 U3.1 的 `10,711` 降到 `1,982`，PM 坐标调用仍为 `0`。
- 真实 line/cell 查询 `33/33` 全部走 DOM caret 探针，`lineQueryRectReads=0`、`lineQueryClientRectReads=0`、`lineQueryPmCalls=0`。
- 视口网格中 `42/75` 个点落在 gap/edge，按设计回退到 PM 原生，fallback rate `56.0%`；这些查询是显式边界查询，不是普通 line/cell 查询。

结论：**值得进入 U3.1 的 flag-gated 产品包裹阶段，但不建议默认替换 PM 坐标 API。** 小文件精度和查询路径已经达到门禁，gap/edge 的 PM 回退保证正确性；大文件构建成本和产品级 selection/IME/搜索跳转等价性仍需主代理独占复测后才能放量。

## 2. 执行方式与范围

- 分支：`perf/performance-optimization`
- HEAD：`1423118dc1d10744f35e73bc664a20568832daf6`
- 小文件：自动生成 `11,336` 字节 Markdown，`docSize=11,078`，`blockCount=163`，`lineCount=227`，`cellCount=10,874`
- 运行命令：

```bash
npx tsx scripts/benchmark/u3-coord-boundary-poc.ts
npx tsx scripts/tests/u3-coord-boundary-poc.e2e.test.ts
```

PoC 使用真实 Electron 启动现有编辑器，页面内只执行原型代码和运行时计数插桩。没有修改默认产品源码、`perf-budget.json` 或现有测试断言。

## 3. 原型机制

1. 遍历 `EditorView.docView` 收集 textblock 与可见 leaf block，记录 PM start/end、DOM 引用、行记录。
2. 普通文本段用 line-box 聚合：
   - 每个 text node 一次 `Range.getClientRects()` 获取真实 line boxes；
   - 对多行 text node 用 prefix Range 二分找 line break offset，并补偿 Chromium 在“下一行首个字符包含进 prefix 时才切换 rect”的边界偏移；
   - 行内 caret x 用同字体的 Canvas `measureText` prefix width + line box left/right 锚点生成；
   - 公式字符仍保留逐字符 Range，作为 inline math 的精确锚点。
3. `coordsAtPos` 使用 line/字符表二分回答，保持零 PM 坐标、零 block rect 读取。
4. `posAtCoords` 采用混合策略：
   - 命中真实 line/cell 且 x 在线内时，使用 `caretPositionFromPoint` + `view.docView.posFromDOM`，与 PM 的 caret 来源一致；
   - block margin/gap、block 首尾 border、视口右侧 outside-block 水平判定、空 line/leaf 无法无 PM 回答时，显式回退 `view.posAtCoords`；
   - 查询路径只对 gap/edge 产生 PM 回退。

## 4. 小文件关键数据

### 4.1 构建

| 指标 | 值 |
| --- | ---: |
| renderer build | 6,957.8 ms |
| 块偏移表构建 | 62.4 ms |
| `getBoundingClientRect` | 0 |
| `Range.getClientRects` | 1,982 |
| U3.1 逐字符 Range 基线 | 10,711 |
| text line segments | 983 |
| formula char ranges | 3,504 |
| canvas `measureText` 调用 | 28,279 |
| PM `coordsAtPos`/`posAtCoords` | 0 |

### 4.2 `coordsAtPos` 偏差（600 个位置）

| 轴 | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| top | 0 | 0 | 0 |
| bottom | 0 | 0 | 0 |
| left | 0.0039 | 0.0078 | 0.6201 |
| right | 0.0039 | 0.0078 | 0.6201 |
| max delta | 0.0039 | 0.0078 | 0.6201 |

### 4.3 `posAtCoords` 偏差（75 个点）

| 指标 | p50 | p95 | max |
| --- | ---: | ---: | ---: |
| PM pos 偏差 | 0 | 0 | 0 |
| 原生/原型 `coordsAtPos` top 偏差 | 0 | 0 | 0 |
| 原生/原型 `coordsAtPos` left 偏差 | 0 | 0 | 0 |
| max px 偏差 | 0 | 0 | 0 |

查询分类：

| 分类 | 数量 | 处理 |
| --- | ---: | --- |
| line/cell hit | 33 | DOM caret 探针，零 PM、零 rect |
| gap/edge fallback | 42 | PM 原生 |
| fallback rate | 56.0% | 视口网格 + 定向 line 点合计 |

### 4.4 单次查询耗时

| 查询 | PM 原生 avg | 原型 avg | 原型 line avg | 原型 fallback avg |
| --- | ---: | ---: | ---: | ---: |
| `coordsAtPos` | 0.0038 ms | 0.0004 ms | - | - |
| `posAtCoords` | 0.0955 ms | 0.0109 ms | 0.0037 ms | 0.0150 ms |

小文件计时分辨率有限，p95 多落在 `0` 或 `0.1ms` 档；均值仍显示原型查询明显更快。

### 4.5 滚动帧 A/B（20 帧）

| 路径 | frame p50 | frame p95 | frame max | query rect | query clientRects | PM fallback |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| PM 原生 | 45.2 ms | 53.3 ms | 54.7 ms | 33 | 13 | - |
| 原型 | 43.0 ms | 47.3 ms | 47.8 ms | 22 | 0 | 19 |

原型滚动中心点在该次运行中 `19/20` 帧落在 gap/edge，因此 PM fallback 调用被显式记录；`queryClientRectReads=0` 说明原型自身没有 Range client rect 读取，22 次 `getBoundingClientRect` 全部来自 PM fallback 的 block 判定。

### 4.6 块高度变化后的增量更新

| 指标 | 值 |
| --- | ---: |
| 高度变化 | +109.992 px |
| 增量更新耗时 | 8.5 ms |
| 全表重建耗时 | 53.9 ms |
| 增量更新 rect 读取 | 0 |
| 增量更新 `Range.getClientRects` | 30 |
| 增量更新 PM 坐标调用 | 0 |
| 恢复 | 是 |

## 5. 边界语义说明

- 块间 margin/gap：offset table 将 y 不在任何 line 内的查询归类为 gap，直接 PM 回退，避免继续猜测不同 block 类型的前/后 boundary pos。
- 视口右侧边界：即使 y 命中 line，x 超出 line 水平范围时归类为 edge 并 PM 回退，覆盖 PM 的 outside-block 判定。
- block 首尾 border：与 gap/edge 共用 PM 回退，不把 block 的 `pmStart/pmEnd` 硬编码成统一 boundary。
- 行内 wrap：普通文本段的 line start 使用 Range 二分 + Chromium 偏移补偿；内部 x 使用 TextMetrics，实测 `coordsAtPos` max `0.62px`。
- inline math：公式字符继续保留精确 Range 锚点；`posAtCoords` 在真实 line/cell 中优先使用与 PM 相同的 `caretPositionFromPoint` 来源。

## 6. 大文件数据缺口

按任务约束，本次**没有运行** `/home/crh/下载/barfoot_ser24/barfoot_ser24.md`。

需要主代理独占复测：

- 大文件 line-box 构建耗时、`Range.getClientRects`、canvas `measureText` 调用数；
- 大文件 wrap、公式、空行、长代码块的 `coordsAtPos`/`posAtCoords` 偏差；
- 大文件 gap/edge fallback rate 与滚动帧 A/B；
- 大文件块高度变化后的增量更新耗时；
- flag-gated 产品包裹后的 selection、IME、搜索跳转、导出等价性门禁。

## 7. 是否进入 U3.1 产品包裹阶段

**建议：在小文件门禁通过、且以 `MARIVELL_ULTIMATE_U3=1` flag 包裹的前提下，进入 U3.1 产品包裹阶段。**

依据：

- `coordsAtPos` p95/max `0.008/0.620px`，`posAtCoords` pos 和 px 偏差 p95/max 均为 `0`；
- 真实 line/cell 查询已经做到零 PM、零 rect；
- gap/edge 只有 `56.0%` fallback，且 fallback 是明确分类后的显式路线；
- 构建期 Range 调用已从 `10,711` 降到 `1,982`，适合作为小文件原型进入 flag 包裹验证。

不建议默认开启或直接替换默认 PM 坐标路径，原因是大文件构建成本、产品交互等价性和 fallback rate 在不同文档中的分布仍缺少复测。

失败回退路线：

- flag off 时完全走现有 PM 原生坐标路径；
- flag on 后若 selection、IME、搜索跳转、caret 对齐或 placeholder/drift 回归，整 commit/整分支回退；
- 若大文件构建期成本或 gap/edge fallback rate 不可接受，保留当前混合策略或退回 U3.1 全 PM 回退；
- 本 PoC 文件、测试与数据保留，不删除失败实验记录。

## 8. 产出物

- 新增：`scripts/benchmark/u3-coord-boundary-poc.ts`
- 新增：`scripts/tests/u3-coord-boundary-poc.e2e.test.ts`
- 新增：本文档

未修改默认产品源码、`perf-budget.json` 和现有测试断言。

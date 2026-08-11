# U4.0 模式切换 Host 策略 PoC

## 结论

**不进入 U4.1。**

`transform` 离屏 + 独立合成层在 source 模式保持 host layout active，
会把小文件 `visual->source` 中位数从 `display:none` 的约 `56-63ms`
推到约 `86-106ms`，超过本 PoC 定义的 `1.1x + 10ms` 不劣于门禁。
虽然 `source->visual` 未明显劣化，`U4.0` 的硬性前置条件是
`visual->source` 不劣于 `display:none` 基线；该条件不成立。

回退路线保持现状：不修改产品源码，默认轨继续使用 `display:none` host。
未来若再尝试 U4.1，需要先解决“source 模式 host layout active 导致
visual->source 额外 layout/style/long task”的成本，再以完整等价性门禁复测。

## 方法与范围

- 真实 Electron + 自动生成小 Markdown，未跑 `barfoot_ser24.md`。
- 文档：55,563 bytes，280 个 section，含 inline math、block math、code block。
- 每种策略独立 BrowserWindow、独立 profile，10 轮完整切换。
- 策略仅由 PoC 脚本注入临时 CSS 实现，不改产品源码、`perf-budget.json`、
  现有测试断言。
- `display:none`：保持产品现有基线。
- `left:-10000px`：`position:absolute; left:-10000px; visibility:hidden;
  pointer-events:none`。
- `transform` 候选：`position:absolute; transform:translate3d(-10000px,0,0);
  visibility:hidden; pointer-events:none; will-change:transform;
  contain:layout style paint`。

## 关键数据（小文件，10 轮，中位数/p95）

| 策略 | visual->source ms | source->visual ms | visual->source LayoutDuration p50 | source->visual LayoutDuration p50 |
| --- | ---: | ---: | ---: | ---: |
| display:none | 55.7 / 71.9 | 137.9 / 178.9 | 0.0162 | 0.0904 |
| left:-10000px | 90.5 / 146.9 | 145.6 / 184.5 | 0.0332 | 0.0984 |
| transform 候选 | 85.5 / 108.6 | 139.5 / 159.0 | 0.0332 | 0.0750 |

判定阈值：

- `visual->source`：`55.7 * 1.1 + 10 = 71.3ms`；
  transform 为 `85.5ms`，**不通过**。
- `source->visual`：`137.9 * 1.1 + 10 = 161.7ms`；
  transform 为 `139.5ms`，通过但不足以进入 U4.1。

## 内存、GC、long task、行为

| 策略 | source host layout | source host DOM 节点 | visual host DOM 节点 | 10 轮 heap 斜率 MB/轮 | forced GC 后 heap 增量 MB |
| --- | --- | ---: | ---: | ---: | ---: |
| display:none | false | 3,596 | 3,823 | +0.061 | +1.79 |
| left:-10000px | true | 3,596 | 4,937 | +0.052 | +1.88 |
| transform 候选 | true | 3,596 | 4,937 | +0.034 | +1.86 |

long task：

| 策略 | visual->source count / total / max | source->visual count / total / max |
| --- | ---: | ---: |
| display:none | 1 / 59ms / 59ms | 16 / 1,072ms / 91ms |
| left:-10000px | 11 / 717ms / 92ms | 22 / 1,566ms / 124ms |
| transform 候选 | 10 / 639ms / 97ms | 18 / 1,271ms / 104ms |

功能探针全部通过：

- 10 轮 `source->visual` 均走 fast path，`fullParseDelta=0`。
- 无 `MDEDITORSELECTION` marker 泄漏。
- caret 映射偏差 `0`，`posAtCoords` 回映射偏差 `<=8`，caret coords 在 frame 内。
- 首帧滚动位置：visual->source 保持 `0.70`；source->visual 保持约 `0.72`
  （最后一轮为 caret 对齐验证使用 `0.42`）。

## 失败归因与 U4.1 前置

两个离屏策略都让 visual host 在 source 模式下继续参与 layout。
小文件上额外成本已经可见：visual->source 中位数约慢 `30-35ms`，
`LayoutDuration` 约翻倍，long task 数量从 1 增至 10-11。
transform 没有解决这个主要成本，只是在 source->visual 侧略好于
`left` 定位。

U4.1 若要继续，至少需要先实现一种不触发完整 source 模式 host layout 的
合成层保留策略，并且必须重新满足：

1. small file `visual->source` p50 不劣于 `display:none` 基线；
2. large file 缺口用真实 `barfoot_ser24.md` 复测（本次明确未跑）；
3. caret/滚动/marker/undo-redo/full-parse 等价性硬门禁全绿；
4. flag off 行为与默认轨一致，失败整体回退到 `display:none`。

## 验证记录

```bash
npx tsx scripts/benchmark/u4-mode-switch-poc.ts
# 成功，10 轮 x 3 策略；最终 decision.enterU41=false

npx tsx scripts/tests/u4-mode-switch-poc.e2e.test.ts
# 35 passed, 0 failed

npx tsc --noEmit
# 通过

git diff --check
# 通过
```

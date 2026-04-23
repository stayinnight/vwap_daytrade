# B2-lite 日内震荡过滤器 — 实验失败记录

**实验日期**：2026-04-22 ~ 2026-04-23
**最终决定**：**不上线**，`config.filters.enableChoppiness` 保持 `false`

---

## 1. 当前现状（this is where we landed）

代码已**完整集成**但**默认关闭**：

- `src/core/indicators/choppiness.ts`：纯函数 `scoreChoppiness`（满分 70：穿越频率 40 + 带内时长比 30 三档加权）
- `src/strategy/vwapStrategy.ts`：`canOpen` 第 9 参 `chopScore`（默认 `null`），`onBar` 在启用时算分传入
- `src/backtest/runner.ts`：完全对齐实盘口径，trade log 写入 `entryChopScore` 快照
- `src/backtest/runChopExperiment.ts`：二维网格驱动脚本（3W × 5T + baseline = 16 次回测）
- `src/backtest/runChopSplitValidation.ts`：分段验证（防过拟合）
- `src/backtest/inspectBadCase.ts`：bad_case 复盘（CRDO/INTC/MRVL）
- `src/backtest/smokeChoppiness.ts`：7 个 smoke case
- `src/utils/logger.ts`：`createWriteStream → appendFileSync` EMFILE 修复（连带正面修复，**这条对实盘也有效**）

**对线上行为的影响**：零。`enableChoppiness=false` 时 `canOpen` 短路（`!isChopEnabled || ...` 第一段 true），`onBar` 短路不算分（`filters.enableChoppiness ? ... : null`），相当于代码不存在。

---

## 2. 设计假设

bad_case (`examples/bad_case/`) 三张图（CRDO / INTC / MRVL）的共性：日内反复在 VWAP 附近来回，每次擦过 VWAP 触发开仓 → 止损 → 反向开仓 → 再止损，一天 10+ 次进出。

假设：30 分钟滚动窗口下，"震荡日"的 K 线分布有可识别特征——VWAP 穿越频繁 + 长时间贴在 VWAP 附近。如果能给出"震荡程度"评分，低分时禁开仓应该能减少假突破，提升 per-trade R / 胜率。

详见 `docs/superpowers/specs/2026-04-22-b2-lite-choppiness-filter-design.md`（v3）。

---

## 3. 实测结果

### 3.1 一年样本网格回测（Task 7）

回测周期：2025-04-11 → 2026-04-10，81 标的，总耗时 6589s。

| 关键数字 | baseline | 候选最优 W30_T20 | 变化 |
|---|---|---|---|
| trade 数 | 28688 | 22055 | **-23%** |
| cumR | 1805.0 | 1447.5 | **-19.8%** |
| 胜率 | 38.6% | 38.6% | **±0.0%** |
| 平均 R | 0.063 | 0.066 | +5% |
| 中位 R | -0.346 | -0.339 | +0.007 |

候选最优的筛选规则是"cumR 跌幅 < 20%（spec 评估口径硬上限）后按 avgR 降序"。15 个 (W, T) 组合中只有 W30_T20 和 W30_T15 这 2 个过门槛，且 avgR 提升都 ≤ 5%。

**真正高 avgR 的配置 cumR 跌幅都过大**：W15_T30 avgR=0.090 但 cumR -73%，W20_T35 avgR=0.090 但 cumR -80%。

详见 `data/backtest/results/chop_experiment_summary.md`。

### 3.2 分段验证（Task 8，关键证据）

把 W30_T20 trade 按 entryTimestamp 切前后两半（中点 2025-11-03）：

| 分段 | trades | cumR | 胜率 | 平均R |
|---|---|---|---|---|
| baseline-front | 14247 | 1172 | 39.2% | 0.082 |
| baseline-back | 14441 | 633 | 37.9% | 0.044 |
| chop_W30_T20-front | 11027 | 967 | 39.3% | **0.088** |
| chop_W30_T20-back | 11028 | 481 | 37.8% | **0.044** |

- 前段 avgR 提升：**+0.0054**（0.082→0.088）
- 后段 avgR 提升：**−0.0002**（0.044→0.044，基本归零）

按 spec §7.3 判定标准（"后段提升 < 前段一半 → 过拟合"），**触发过拟合警告**。整个 5% 的 avgR 提升完全集中在前 6 个月，后 6 个月毫无提升。

### 3.3 bad_case 复盘（Task 9）

| 票 | 震荡日 | base trades | base cumR | cand trades | cand cumR | 净效果 |
|---|---|---|---|---|---|---|
| CRDO | 97 | 671 | **−10.6R** | 512 (-24%) | **−2.3R** | +8.3R ✓ |
| INTC | 59 | 379 | **+13.1R** | 293 (-23%) | **−0.5R** | **−13.6R ✗** |
| MRVL | 72 | 447 | **+55.0R** | 343 (-23%) | **+83.7R** | +28.7R ✓ |

三只票合计 +23.4R 是正向的，但 **INTC 上反向**——baseline 上 INTC 本来在赚钱（+13R），过滤器把那些赚钱的 trade 也砍掉了，最终变成 -0.5R。

---

## 4. 为什么否决

按 spec 评估口径"per-trade R / 胜率优先 + cumR 跌幅 < 20%"看：

1. **胜率 0 改善**——震荡评分**没有区分赢/输 trade 的能力**。砍掉 23% 的 trade 但留下来的 trade 胜率与 baseline 完全一样（38.6%）。这意味着评分不是"识别坏 trade"，而是"均匀采样砍 23%"。
2. **avgR 提升完全是过拟合**——后 6 个月毫无 avgR 提升，5% 的整体提升全部集中在前段。spec 明文判定为过拟合。
3. **bad_case 效果不稳定**——MRVL 上 work（+28.7R），INTC 上反向（-13.6R），CRDO 微弱减亏。如果指标真在识别"震荡 vs 趋势"，效果应该是单调的。
4. **真信号可能在哪**：INTC vs MRVL 反向 + 胜率不变 = 评分可能在间接相关于"波动率"或"带宽"而非"震荡"，导致它在不同票上表现两极。

---

## 5. 如何启用震荡过滤（如果未来想试）

### 5.1 启用（最小改动）

修改 `src/config/strategy.config.ts`：

```typescript
filters: {
  // ...其他字段
  enableChoppiness: true,  // ← false 改 true
},

choppiness: {
  windowBars: 30,                     // 候选最优 W
  bandAtrRatios: [0.1, 0.2, 0.3],    // 不变
  scoreThreshold: 20,                  // 候选最优 T (默认 25 偏严)
},
```

修改后立刻 `npm run build:watch` + `npm run start:watch` 即可。**不需要改任何业务代码**。

**警告**：默认 T=25 是 spec 的初始猜测，**不是回测验证过的最优**。回测验证后 W30_T20 是仅有的勉强候选——但已经被分段验证标记为过拟合。如果你坚持开，建议至少用 W30_T20。

### 5.2 临时回测验证（不改 config，用 CLI flag）

不改 config 永久开启，可以用 CLI flag 跑单次回测看效果：

```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts \
  my_label trailing \
  --filter-choppiness=on --chop-window=30 --chop-threshold=20
```

注意：`--chop-window` / `--chop-threshold` **必须配合 `--filter-choppiness=on`**，否则 runner 会 exit 1（footgun 检查）。

### 5.3 完全卸下震荡过滤（彻底回退）

不需要——`enableChoppiness=false` 默认状态下整套代码完全旁路，没有运行时开销。代码留在仓库里方便未来调试或做 B2 完整版的起点。

---

## 6. 下次重做的方向假设（如果要再尝试）

按本次实验结果反推，下次设计时应改进：

1. **加方向感知**：当前 chopScore 不区分"上震下不震"还是真震荡。INTC vs MRVL 的反向结果暗示这一点很关键。下次应该把单边趋势（哪怕反复穿 VWAP）排除在"震荡"之外。
2. **避免单一窗口**：W=30 + W=15 比较的结果显示 W=15 把 trade 砍得更狠但 cumR 跌得也更猛——单窗口很难区分"短期震荡"和"长期震荡"。可考虑两窗口投票。
3. **B3 路线**（B2-lite spec 提过的备选）：09:35 trend score（已在线上）+ 09:45/10:00 二次成色升级（B1）+ 滚动评分（B2）的组合。本次只做 B2，结果是 isolated 信号不强，组合可能解决。
4. **重新审视"震荡"定义**：本次假设是"VWAP 穿越频繁 + 贴 VWAP 久"，但 INTC 反向说明这两个特征在某些票上反而是赚钱信号（密集触发好的反转）。可能要加成分股特性维度。

---

## 7. 文件索引

**实验产物**（保留供后续查阅）：

- `data/backtest/results/chop_experiment_summary.md` ← 二维网格回测报告（**关键阅读文档**）
- `data/backtest/results/chop_baseline.json` ← baseline 28688 trades 完整 trade log
- `data/backtest/results/chop_W{30,20,15}_T{15,20,25,30,35}.json` ← 15 个网格点的完整 trade log（可重复跑分段/bad_case 分析）
- `data/backtest/results/chop_experiment.log` ← 完整回测日志（含每根 K 触发情况）

**设计 / 计划 / 实验脚本**：

- `docs/superpowers/specs/2026-04-22-b2-lite-choppiness-filter-design.md` ← 设计 spec v3
- `docs/superpowers/plans/2026-04-23-b2-lite-choppiness-filter.md` ← 实现计划（10 task）
- `src/backtest/runChopExperiment.ts` ← 重跑网格的入口
- `src/backtest/runChopSplitValidation.ts` ← 重跑分段验证：`npx ts-node --transpile-only src/backtest/runChopSplitValidation.ts <label>`
- `src/backtest/inspectBadCase.ts` ← 重跑 bad_case：`npx ts-node --transpile-only src/backtest/inspectBadCase.ts <label>`

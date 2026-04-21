# 趋势检测 v4c 调参实验设计（Trend Detector v4c Tuning Experiments）

**Goal:** v4c 三个新指标（九/十/十一）和总门槛 55 都是"脑袋定的默认值"，从未做过消融或阈值扫实验。本设计定义一个**分阶段实验矩阵**，用最少的回测次数诊断每个新指标的净贡献、探测指标十一疑似方向错误、并在优化后的指标组合上找最优总门槛。

**Non-goals:**
- 不碰指标一~八（前代迭代已充分调过）
- 不改入场/出场策略逻辑
- 不引入新指标
- 不重跑 v4b 对比（stale 数据刷新留到文档更新阶段）

---

## 一、背景

### 1.1 当前状态

v4c 已完整落地并提交（见 commit `4a35689` ~ `a8c441f`）。一年回测 `smoke_v4c.json` 性能：

| 方案 | trades | winRate | avgR | cumR | maxDD | ratio |
|---|---|---|---|---|---|---|
| baseline (sl=0.1，无 detector) | 32443 | 38.0% | 0.0312 | 1011.6 | 279.9 | 3.61 |
| **v4c baseline (score≥55, sl=0.1)** | **20495** | **38.3%** | **0.0639** | **1310.6** | **95.2** | **13.77** |

对 baseline：trades -37%、cumR +30%、maxDD -66%、ratio +282%。

### 1.2 诊断暴露的问题

`analyzeTrendWeights.ts smoke_v4c` 的分桶表显示：

- **指标九 todayRangePctValue**：阈值 0.01 方向对（下面 103 trades avgR 负），但命中后 avgR 在 0.053~0.084 基本持平，**区分力弱**。
- **指标十 priorDayRangePctValue**：阈值 0.025 位置没毛病，但过了阈值后 avgR 反而走弱（非单调）。
- **指标十一 prevRangePctAvg7Value**：**单调方向可能反了** —— [0.010, 0.020) avgR=0.144 最强、[0.050, 0.080] 只剩 0.037。低波动档反而更好。
- **总分桶**：强单调 ✓（83% 递增），140+ 桶 avgR=0.218 —— 总分方向对，总门槛偏松。

### 1.3 为什么现在做

- 三个新指标的阈值/方向/权重**从未实证过**，都是 plan 拍的脑袋值。
- 总门槛 55 同样是从 v4b 继承，没有在 170-max 新公式下重新扫过。
- 不做这个实验，TREND.md 里"v4c 性能"就无法说服自己"真的是最优配置"。

---

## 二、实验矩阵

### 阶段一：消融（ablation） —— 测每个新指标的净贡献

基线 = v4c 当前版（3 指标全开、门槛 55）。每个实验**单独禁用一个指标**（`maxScore=0`，等同该指标永远 0 分），其他保持不变。

| # | label | 变更 |
|---|---|---|
| 0 | `smoke_v4c` | v4c baseline（已有，不重跑） |
| 1 | `abl_no9` | 禁用指标九 |
| 2 | `abl_no10` | 禁用指标十 |
| 3 | `abl_no11` | 禁用指标十一 |

**判读规则**：对每个实验 i，计算 Δratio = ratio(i) - ratio(0)。Δratio > 0 说明"少了它更好"→ 该指标净贡献为负。

### 阶段一·B：指标十一方向探索（条件触发）

**触发条件**：当 `abl_no11`（禁用十一）的 ratio 比 v4c baseline 高，说明当前方向有负贡献。此时尝试两种变体：

| # | label | 变更 |
|---|---|---|
| 4 | `ind11_reverse` | 指标十一改反向：`prevRangePctAvg7 < 0.025` 给 10 分 |
| 5 | `ind11_range` | 指标十一改区间档：`prevRangePctAvg7 ∈ [0.010, 0.050)` 给 10 分 |

**不触发**的情况：`abl_no11` ratio 比 baseline 低 → 当前方向是对的，直接保留，跳过阶段一·B。

**判读规则**：`ind11_reverse` 或 `ind11_range` 的 ratio 若 ≥ `abl_no11`，说明反向/区间档比彻底禁用更优 → 保留。否则彻底禁用。

### 阶段二：总门槛粗扫

基线 = 阶段一胜出版本（例如"3 指标全开"或"禁用指标十一"或"指标十一反向"）。只扫总门槛。

| # | label | 变更 |
|---|---|---|
| 6 | `thr_65` | 门槛 55 → 65 |
| 7 | `thr_75` | 门槛 55 → 75 |
| 8 | `thr_85` | 门槛 55 → 85 |

### 阶段二·B：门槛细扫（条件触发）

粗扫结果决定：
- 如果 ratio **峰值出现在某个中间点**（如 75 比 65 和 85 都高）→ 在峰值 ±5 加 2~3 个点（70、80）
- 如果 ratio **单调上升到 85 仍未拐头** → 加 95、105 继续扫
- 如果 ratio **单调下降** → 不加点

### 总实验量

- **必跑**：3（消融）+ 3（粗扫）= **6 组**
- **最多**：+2（方向）+ 3（细扫）= **11 组**
- 每组一年回测约 2-4 分钟，总耗时 20-45 分钟。

---

## 三、评估口径

### 主指标

**ratio = cumR / maxDD**（v4c 当前 13.77）

### 硬约束

**cumR ≥ 1048**（v4c 的 80%）。跌破此约束的配置即便 ratio 更高也**不采纳**。

### 报告字段（每组必须输出）

| 字段 | 说明 |
|---|---|
| label | 实验标签 |
| trades | 总交易笔数 |
| winRate | 胜率 % |
| avgR | 平均 R-multiple |
| cumR | 累计 R-multiple |
| maxDD | 最大回撤（R） |
| ratio | cumR / maxDD |
| Δratio | vs v4c baseline |
| ΔcumR% | vs v4c baseline（用于硬约束检查） |

### 决策树

```
每阶段跑完 → 按主指标排名 → 过滤掉违反硬约束的 → 选剩余 ratio 最高者作为下阶段起点。
如果所有候选都违反硬约束 → 保留 v4c baseline 作为该阶段输出。
```

---

## 四、技术实现

### 4.1 需要新增的 CLI flag

现有 `runner.ts` 已有 `--filter-trend=on|off` 和 `--trend-threshold=N`。本次新增：

| flag | 作用 | 取值 |
|---|---|---|
| `--disable-trend-ind=N[,N...]` | 禁用一个或多个指标（`maxScore=0`） | `9`、`10`、`11`、`9,10`、`9,11` 等 |
| `--ind11-mode=forward\|reverse\|range` | 指标十一评分模式 | 默认 `forward`（当前行为） |

### 4.2 禁用指标实现

在 `trendDetector.ts` 里，三个新指标的阈值表是模块级常量（`TODAY_RANGE_PCT_TIERS` 等）。"禁用"的干净做法：

- 方案 A：把阈值表 monkey-patch 成空数组 `[]`。for-loop 空转、分数永远为 0。
- 方案 B：在阈值表里加 `maxScore: number` 字段，runner 动态置 0。

**推荐方案 A** —— 零侵入 trendDetector 的评分逻辑，runner 里用 try/finally 保护恢复。和现有 runner 改 `config.filters` 单例的套路一致。

### 4.3 指标十一方向模式实现

在 `trendDetector.ts` 加模块级变量 `let IND11_MODE: 'forward' | 'reverse' | 'range' = 'forward'` 和对应的阈值常量：

```ts
const PREV_RANGE_PCT_AVG_REVERSE_TIERS = [{ pct: 0.025, score: 10 }]; // < 0.025 给分
const PREV_RANGE_PCT_AVG_RANGE_TIERS = [                              // [0.010, 0.050) 给分
    { minPct: 0.010, maxPct: 0.050, score: 10 }
];
```

`scoreTrendDay` 里指标十一的段落根据 `IND11_MODE` 切换计算逻辑。runner 在跑实验前 set、跑完 restore。

### 4.4 runner 改动范围

- 新增两个 flag 解析（~20 行）
- 新增 patch/restore 函数（~20 行）
- 调用时机：在 `main()` 里 parse flag 后、主循环前 patch；跑完后 restore（放 finally）
- 影响面：仅 `runner.ts`。`trendDetector.ts` 加 3 行（`IND11_MODE` 变量 + 两组备用阈值常量 + 指标十一段 if 分支）。

### 4.5 实验脚本

不写实验脚本（YAGNI）。6~11 个实验用 shell 命令手动跑足够：

```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts abl_no9 trailing 0 0.1 \
  --filter-trend=on --disable-trend-ind=9
```

跑完后写一个汇总脚本（或 inline node 脚本）读所有 JSON 出对比表。

---

## 五、风险与约束

### 5.1 单例状态泄漏

`trendDetector.ts` 的模块常量 patch 后，如果 runner 没在 finally 里恢复，后续实验会读到脏数据。对策：

- patch/restore 封装成一个函数，用 `try/finally` 调用
- 每次 runner 启动都从头 patch（不依赖前次 restore）

### 5.2 precompute 与模块变量的耦合

`precomputeTrendBaselinesForSymbol` 读 `TREND_RANGE_PCT_AVG_LOOKBACK` 常量，但**不**读 `IND11_MODE`、不读 `*_TIERS`。它只负责算数据，评分才用 TIERS。所以 patch `*_TIERS` 不影响 precompute，没问题。

### 5.3 方向模式 (reverse/range) 的硬约束风险

反向/区间档会让更多"低波动日"拿到 10 分，可能让一些垃圾日越过门槛 55。观察 trades 数是否显著上涨、avgR 是否下跌，如有则说明该方向不对。

### 5.4 实验数量爆炸

矩阵严格按"阶段 + 条件触发"推进，不提前跑 full grid。每阶段结果出来再决定是否进入下一阶段。最差情况 11 组可控。

---

## 六、成功标准

实验结束后必须得出以下之一的结论：

1. **v4c baseline 已是最优**：所有实验配置的 ratio 都没超过 13.77 或违反硬约束。保留现状。
2. **发现更优配置**：某配置 ratio > 13.77 且 cumR ≥ 1048。该配置成为新 v4c 生产版，更新代码默认值 + TREND.md 文档。
3. **部分指标应禁用**：某消融实验显著优于 baseline，对应指标 `maxScore=0` 写回代码作为默认。

同时必须产出：

- 对比表格（11 行以内）
- 每个阶段的判读理由（为什么进/不进下一阶段）
- 更新 TREND.md 第 188-195 行的性能表（目前挂的是 v4b 数）

---

## 七、文件影响面

| 文件 | 动作 |
|---|---|
| `src/backtest/runner.ts` | 加 2 个 flag + patch/restore |
| `src/core/trendDetector.ts` | 加 `IND11_MODE` 变量、2 组备用阈值常量、指标十一段 if 分支 |
| `docs/superpowers/specs/2026-04-19-trend-v4c-experiments-design.md` | 新建（本文件） |
| `docs/superpowers/plans/2026-04-19-trend-v4c-experiments.md` | 下一步由 writing-plans 生成 |
| `references/TREND.md` | 实验结束后更新性能表和 v4c 小节 |

实验产出（不纳入 git）：

- `data/backtest/results/abl_no{9,10,11}.json`
- `data/backtest/results/ind11_{reverse,range}.json`（条件）
- `data/backtest/results/thr_{65,75,85,...}.json`

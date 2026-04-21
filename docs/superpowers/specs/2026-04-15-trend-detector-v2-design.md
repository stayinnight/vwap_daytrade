# 趋势日 Detector v2 — 设计规格

**日期**:2026-04-15
**作者**:zeng.516 + Claude Opus
**基于**:v1 spec `2026-04-14-trend-detector-design.md`、v1 plan `2026-04-14-trend-detector.md`、v1 实验数据 `data/backtest/report_trend.md`
**Scope**:基于 v1 实验数据,重新设计评价窗口 + 权重/阈值

---

## 1. v1 的问题(从数据出发)

v1 实验跑完后(`data/backtest/report_trend.md`),发现三件事:

1. **✅ 评分公式有强区分度**:≥80 分桶 avgR=0.143 vs <30 桶 avgR=0.019 (比值 7.5×)。说明 TREND.md 的 5 指标启发式有信号
2. **⚠️ 绝对 cumR 砍得过狠**:1933R → 250R (-87%)。门槛 60 过严,高分日机会稀缺
3. **⚠️ 09:30–09:44 窗口贡献 22.5% 总 R**:436R 被方案 A"禁前 15 分钟"直接丢掉,avgR=0.041 甚至高于主段 0.031

v2 针对前两个问题做**两类改动**:
- **方向 2**(结构性):缩短评价窗口,提前开放交易
- **方向 1**(参数性):基于新窗口下的数据重新调权重/阈值

---

## 2. 方向 2:缩短评价窗口

### 2.1 时间改动

| 项 | v1 | v2 |
|---|---|---|
| 评价窗口 | 09:30–09:44 (15 根 bar) | **09:30–09:34 (5 根 bar)** |
| 打分触发时刻 | 09:45 | **09:35** |
| 禁交易窗口 | 09:30–09:44(因为 detector undefined) | **09:30–09:34**(等同于 config.noTradeAfterOpenMinutes=5) |
| 09:35–09:44 状态 | 禁交易 | **正常交易 + detector 门控** |

### 2.2 RVOL 基线改动

| 项 | v1 | v2 |
|---|---|---|
| `RVOL_LOOKBACK_DAYS` | 20 | **5** |
| RVOL 有效天数下限 | 10(半数) | **3**(半数,ceil(5/2)=3) |
| 预期预热期(RVOL) | 前 10-11 天 null | 前 3 天 null(ATR 仍是 7 天,成为 binding) |

### 2.3 Opening Drive 改动

`driveAtr = |price_0934 - open_0930| / prevAtr`

- `open_0930` 仍是 window[0].open(09:30 那根 bar 开盘)
- `price_0934` 改为 window[window.length - 1].close = 09:34 那根 bar 的收盘(窗口最后一根,触发前 1 分钟)
- **实现上不需要改代码** —— `scoreTrendDay` 里已经是 `window[window.length - 1].close`,只要传入的 window 是 5 根就自动对了

### 2.4 VWAP 控制力改动

计算方式不变(累积 VWAP,每根 close 站上/站下统计),但样本数从 15 → 5。

**注意**:5 个样本下"100% 站一侧"很容易发生 —— 5/5 比 15/15 概率高 ~3×。需要观察实验后 vwap 指标的分布是否虚高,如果是,考虑提升 `VWAP_FULL_SCORE` 的触发门槛(例如要求 5/5 + prevClose 也在一侧)。但 v2-base 先不改,保留观察数据。

### 2.5 Range Expansion 改动

`range = max(window.high) - min(window.low)`,阈值 `> prevAtr * 0.6`,触发 10 分。

5 根 bar 的 range 统计量比 15 根 bar 的小 —— 平均需要 3× 的波动强度才能触发 `> 0.6 ATR`。这会让 Range 指标**更稀有但更严格**,v2 下它的"给分率"会下降。观察后再决定是否调阈值(例如降到 0.4 ATR)。

### 2.6 Gap 改动

不变。Gap 只用 `window[0].open` 和 `baseline.prevClose`,和窗口长度无关。

### 2.7 实现侧改动清单

- `src/core/trendDetector.ts`:`OPENING_WINDOW_MINUTES = 5`,`RVOL_LOOKBACK_DAYS = 5`
- `src/backtest/runner.ts`:无代码改动(常量驱动)
- smoke script (`smokeTrendDetector.ts`):Case 4 构造的 25 天测试需要改成 10 天(或者保留 25 天,正好验证更长 lookback 也 work),case 1/2/3 的 window 要从 15 根改成 5 根,相应的手算预期也要改

---

## 3. 方向 1:权重/阈值重新设计

### 3.1 步骤

分四步,顺序严格。

**Step A — 数据采集增强**:
v1 的 `BacktestTrade.entryDayScore` 只记录 total,v2 需要额外记录 details(5 个指标的原始数值和分数)。新增字段:

```ts
interface BacktestTrade {
    ...
    entryDayScore?: number | null;
    /** 入场当日该票的评分明细(5 指标分数 + raw values)。运行时 detector 打分后写入 */
    entryDayScoreDetail?: TrendScore | null;
}
```

`Position` 和 `closeTrade` 也要同步写 detail 字段。

**Step B — 跑 v2-base recordonly**:
label = `trend_v2_recordonly_sl010`,5 分钟窗口 + **v1 的原始权重/阈值不变**,detector off 只记录分数。
这是 Step C 诊断的输入。

**Step C — 诊断脚本 `analyzeTrendWeights.ts`**:
读 `trend_v2_recordonly_sl010.json`,按每个指标的 **raw value** 做分桶统计:

每个指标单独来看:
- **Gap**:按 gapPct 分位数桶(10 段),算每桶 avgR / winRate / trade 数
- **RVOL**:同上,按 rvolValue 分位数桶
- **Drive**:同上,按 driveAtr 分位数桶
- **VWAP 控制力**:按 vwapControlRatio 分桶
- **Range**:按 rangeValue / prevAtr 比值分桶

产出形如:
```
=== RVOL (rvolValue) ===
  分位段             trade 数   avgR    winRate
  p0  - p10  (<0.8)  5000       0.015   35%
  p10 - p20  (0.8-1) 4800       0.018   36%
  ...
  p90 - p100 (>3)    2000       0.085   42%
  单调性: 强  最陡拐点: p80 (值 2.0)
```

**解读规则**(v1 未做,v2 新增):
- **强单调 + 明显拐点** → 该指标是"好预测因子",阈值卡在拐点上,权重加大
- **弱单调 / 曲线平坦** → 该指标是"弱预测因子",权重降低甚至归零
- **非单调**(U 型、反向) → 该指标本身有问题,可能公式错了或语义反了,重新思考

**Step D — 手调权重**:
基于 Step C 的诊断,**你(用户)手调**一组新权重/阈值。我会把诊断表摆在你面前,你来决定:
- 5 个指标的权重从 `[20, 30, 25, 15, 10]`(总分 100)调到什么组合(总分仍保持 100 以便门槛 60 语义不变)
- 每个指标的 3 档阈值往哪调
- 或者干脆删掉某个指标(权重归零)

调好之后写入 `trendDetector.ts` 的常量块,并**加注释说明**"v2 手调,基于 trend_v2_recordonly_sl010 诊断"。

**Step E — 跑 v2-tuned 实验**:
label = `trend_v2_tuned_sl010`,5 分钟窗口 + 手调后的权重/阈值,detector on。

### 3.2 实验矩阵(4 组)

| # | label | 窗口 | 权重/阈值 | detector | 用途 |
|---|---|---|---|---|---|
| 1 | `baseline_loose_sl010` | - | - | off | v1 已有,对照组 |
| 2 | `trend_v2_recordonly_sl010` | 5 分钟 | v1 原值 | off | v2 结构的 recordonly(Step C 诊断输入) |
| 3 | `trend_v2_score60_sl010` | 5 分钟 | v1 原值 | on | 看"只改窗口不调权重"的效果 |
| 4 | `trend_v2_tuned_sl010` | 5 分钟 | v2 手调值 | on | 终极对照 |

**重要**:组 3 是可选的诊断组 —— 如果你想知道"缩短窗口本身是好是坏",组 3 vs 组 2 就能告诉你。也可以跳过,直接从组 2 → 手调 → 组 4。

### 3.3 成功标准

两个层次:

**层次 1(方向 2 单独的成功)**:
- 组 3(v2-base + detector on)的 cumR 应显著 > 组 1(250R v1 的 ratio 对照)
- 或者 cumR÷maxDD 保持 ≥ 7.80(v1 ratio)
- **如果组 3 的 ratio < 7.80**,说明缩短窗口本身没帮助,方向 2 失败,需要重新思考窗口长度

**层次 2(方向 1 手调成功)**:
- 组 4(v2-tuned)的 cumR÷maxDD ≥ 组 3 × 1.05(至少 5% 改进)
- 组 4 的 cumR 绝对值 > 组 3(手调的目标是放大 alpha 不是缩小)
- **如果组 4 没有比组 3 好**,说明手调没抓到本质,回到 Step C 再看数据

**整体成功**:组 4 同时满足 ratio ≥ 7.80 和 cumR > 500(v1 的 2 倍)

---

## 4. 不做的事(v2 仍然 YAGNI)

- 不做方向性评分(多头版 / 空头版)
- 不做全局选股池
- 不做 walk-forward 样本外验证(v1 都没做,v2 不加)
- 不做实盘侧 hook
- 不自动拟合权重(手调为主)
- 不删除指标结构(5 个指标保持,权重可以调成 0 但不物理删除)

---

## 5. 文件改动清单

| 文件 | 类型 | 改动 |
|---|---|---|
| `src/core/trendDetector.ts` | 修改 | `OPENING_WINDOW_MINUTES: 15→5`, `RVOL_LOOKBACK_DAYS: 20→5`, Step D 后更新权重/阈值常量 |
| `src/backtest/types.ts` | 修改 | `BacktestTrade` 加 `entryDayScoreDetail?: TrendScore \| null` |
| `src/backtest/runner.ts` | 修改 | `Position.entryDayScoreDetail`, `newPos` 填入, `closeTrade` 写入 trade log |
| `src/backtest/smokeTrendDetector.ts` | 修改 | Case 1-3 的 window 改成 5 根,手算期望值重算 |
| `src/backtest/analyzeTrendWeights.ts` | **新建** | 诊断脚本,输出 5 指标分桶统计 |
| `src/backtest/reportTrend.ts` | 修改 | 主表 + 分组表增加 v2 label 读取 |
| `references/BACKTEST.md` | 修改 | §6 加"批次 C"小节记录 v2 实验 |

---

## 6. 实施顺序(高层)

1. 先做方向 2 的代码改动(步骤 2.7):改常量 + 改 smoke script + 测 smoke 通过
2. 加 `entryDayScoreDetail` 字段(Step A)
3. 跑实验组 2(`trend_v2_recordonly_sl010`)
4. 跑实验组 3(`trend_v2_score60_sl010`)—— 可选但建议,评估"只改窗口"的效果
5. 写 `analyzeTrendWeights.ts`,生成诊断表(Step C)
6. **停下来讨论诊断表**,手调权重(Step D)
7. 把新权重写入 `trendDetector.ts`,跑实验组 4(`trend_v2_tuned_sl010`)
8. 更新 `reportTrend.ts` 加入 v2 labels
9. 生成 `report_trend_v2.md`,review
10. 更新 BACKTEST.md §6 批次 C

**步骤 6 是必停点** —— 我不会在没有你确认权重之前自动跑组 4。

---

## 7. 已知风险

### 7.1 5 分钟窗口的信噪比低于 15 分钟

5 根 bar 的统计量方差大,评分区分度可能下降。如果组 3 的分组表显示"高分桶和低分桶的 avgR 差距缩小"(v1 是 7.5×,如果降到 3× 以下),说明信号被稀释了。

**对策**:方向 1 手调是补偿 —— 权重调整后,即使单指标区分度下降,组合评分的区分度可能能提高。

### 7.2 VWAP 控制力指标在 5 根 bar 下虚高

5/5 站一侧的概率 ≈ 2 × (0.5^5) × 增幅 ≈ 6-10%,比 15/15 的约 0.006% 高 3 个数量级。这意味着 VWAP 控制力的"满分率"会从 v1 的罕见变成 v2 的常见,稀释 15 分的信号价值。

**对策**:Step C 的诊断会立刻暴露这个 —— 如果 vwapControlRatio 分桶的 avgR 几乎没差异,就在 Step D 手调时把 VWAP 权重降低。

### 7.3 Range 指标在 5 分钟下几乎打不到分

5 根 bar 的 range 很小,`> 0.6 ATR` 难触发。可能整年只有极少数日子的 Range 得 10 分。

**对策**:Step C 诊断会暴露 Range 的触发率。如果触发率 < 5%,手调时降低阈值(比如从 0.6 → 0.3)或降低权重。

### 7.4 Gap 不受窗口变化影响,但实际占比会变大

因为其他 4 个指标的"平均打分"可能降低,Gap 在总分里的相对重要性上升。这不是 bug,是副作用,Step C 会自然反映。

### 7.5 RVOL 前 5 天基线的噪音

5 天均值的方差 >> 20 天均值。连续几天停牌 + 一两天数据异常就能把 baseline 带偏。`trendDetector.ts` 的 `ceil(5/2)=3` 有效天数下限会过滤掉"3 天有效以上"的情况,但最坏情况是 "3 天里 2 天成交量异常,1 天正常" → rvolBaseline 虚高或虚低,当日 RVOL 分数失真。

**对策**:v2 不做额外过滤,观察 Step C 诊断的 RVOL 单调性是否仍然有区分度。如果 RVOL 的分桶曲线乱了(比如非单调),再考虑加更稳健的 baseline 算法(例如 median 替代 mean)。

### 7.6 v2 的变量太多,混淆诊断

v2 同时动了窗口长度、RVOL lookback、指标阈值、权重。如果组 4 表现比 v1 好,我们无法分清是"窗口"的功劳还是"权重"的功劳。

**对策**:组 2/3 都保留 v1 原始权重,专门用来隔离窗口变化的效应;组 4 在组 3 基础上只变权重。按列对比能分清每个变量的贡献。

---

## 8. 后续 v3 候选(不在本 spec)

- 方向性评分(B 方案回归)
- Walk-forward 样本外验证
- 实盘侧接入
- 自动权重拟合(线性回归 / LightGBM)

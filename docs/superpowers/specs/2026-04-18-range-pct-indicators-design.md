---
date: 2026-04-18
status: draft
---

# 趋势评分系统 · 补充 3 个"日内百分比波动"指标

## 一、背景与目标

当前 `trendDetector` 的 8 个指标里，只有指标五（Range Expansion）和指标六（ATR%）度量波动：

- 指标五：`(5min high - low) / prevAtr`，分母是**昨日 ATR 美元**
- 指标六：`ATR(7) / prevClose`，分母是**昨日收盘价**，且 ATR 含 overnight gap

两者都带 gap 分量，且口径不直观。用户希望补一个**纯日内、排除 gap**的视角：看 K 线在**价格上的百分比波动**（"日内油水"）。

本次追加 3 个独立指标（先实验，不合并），各给 10 分、单档阈值。目的是在 `analyzeTrendWeights.ts` 的诊断上对比这三个维度的区分力，再决定是否合并、裁剪或调权。

## 二、新增指标

所有指标都**排除 overnight gap**（分子用单日 high-low，不用 True Range）。

### 指标九 · Today Opening Range%（10 分）

```text
todayRangePct = (5min_high - 5min_low) / window[0].open
```

| 条件 | 分数 |
|---|---|
| > 1.0% | 10 |
| else | 0 |

分母用 `window[0].open`（09:30 那根 bar 的 open，和现有指标一 Gap 的 open 口径一致）。

### 指标十 · Prior Day Range%（10 分）

```text
priorDayRangePct = (prevDay.high - prevDay.low) / prevClose
```

| 条件 | 分数 |
|---|---|
| > 2.5% | 10 |
| else | 0 |

数据来源：`baseline.prevDayOHLC`（已有字段，指标八 Prior Day Shape 已在用）。

### 指标十一 · Prior Range% Avg (7 day)（10 分）

```text
prevRangePctAvg7 = mean((dailyHigh - dailyLow) / dailyClose) over last 7 days
```

| 条件 | 分数 |
|---|---|
| > 2.5% | 10 |
| else | 0 |

窗口和指标六 ATR(7) 对齐，用前 7 天（不含当日）。和指标六的区别：**排除 gap**（分子不含 overnight 跳空）。在大多数标的上与指标六高相关，在 gap 频发的标的（小盘、财报日）上表现差异。

## 三、数据结构改动

### 3.1 `TrendBaseline` 新增一个字段

```ts
export interface TrendBaseline {
    prevClose: number;
    prevAtr: number;
    prevAtrShort: number;
    rvolBaseline: number;
    prevDayOHLC: CandleOHLC;
    prevRangePctAvg7: number; // ← 新增：前 7 日日内 range% 均值（排除 gap）
}
```

### 3.2 `TrendScore` 和 `TrendScoreDetails` 扩字段

`TrendScore` 新增 3 个主分字段：

```ts
export interface TrendScore {
    total: number;
    gap: number;
    rvol: number;
    drive: number;
    vwap: number;
    range: number;
    atrPct: number;
    openingShape: number;
    priorDayShape: number;
    todayRangePct: number;     // ← 新增
    priorDayRangePct: number;  // ← 新增
    prevRangePctAvg7: number;  // ← 新增
    details: TrendScoreDetails;
}
```

`TrendScoreDetails` 新增 3 个诊断字段：

```ts
export interface TrendScoreDetails {
    // 原有字段略...
    todayRangePctValue: number;     // ← (5min high - low) / open
    priorDayRangePctValue: number;  // ← (prevDay.high - prevDay.low) / prevClose
    prevRangePctAvg7Value: number;  // ← 前 7 日日内 range% 均值
}
```

诊断字段命名用 `XxxValue` 后缀是为了和主分字段 `XxxScore` 风格区分（虽然主分没带 Score 后缀，但这三个新指标命名上 Value 后缀更清晰地表达"连续诊断值 vs 阶梯化主分"）。

## 四、阈值常量

在 `src/core/trendDetector.ts` 顶部常量块新增：

```ts
// 指标九：今日开盘 5min 日内百分比波动
const TODAY_RANGE_PCT_TIERS = [
    { pct: 0.01, score: 10 },
];

// 指标十：昨日单日日内百分比波动
const PRIOR_DAY_RANGE_PCT_TIERS = [
    { pct: 0.025, score: 10 },
];

// 指标十一：前 7 日日内百分比波动均值
const PREV_RANGE_PCT_AVG_TIERS = [
    { pct: 0.025, score: 10 },
];

export const TREND_RANGE_PCT_AVG_LOOKBACK = 7;
```

`TREND_RANGE_PCT_AVG_LOOKBACK` 导出是为了后续可能做 `--trend-range-avg-period=N` CLI flag 时方便外部引用。暂不加 CLI flag，保持 YAGNI。

## 五、`scoreTrendDay` 主函数集成

在现有指标八（Prior Day Shape）之后、`return` 之前追加三段：

```ts
// ====== 指标九：Today Opening Range% ======
const todayRangePctValue = window[0].open > 0
    ? (highMax - lowMin) / window[0].open
    : 0;
let todayRangePct = 0;
for (const tier of TODAY_RANGE_PCT_TIERS) {
    if (todayRangePctValue > tier.pct) {
        todayRangePct = tier.score;
        break;
    }
}

// ====== 指标十：Prior Day Range% ======
const priorDayRangePctValue = baseline.prevClose > 0
    ? (baseline.prevDayOHLC.high - baseline.prevDayOHLC.low) / baseline.prevClose
    : 0;
let priorDayRangePct = 0;
for (const tier of PRIOR_DAY_RANGE_PCT_TIERS) {
    if (priorDayRangePctValue > tier.pct) {
        priorDayRangePct = tier.score;
        break;
    }
}

// ====== 指标十一：Prev Range% Avg(7d) ======
const prevRangePctAvg7Value = baseline.prevRangePctAvg7;
let prevRangePctAvg7 = 0;
for (const tier of PREV_RANGE_PCT_AVG_TIERS) {
    if (prevRangePctAvg7Value > tier.pct) {
        prevRangePctAvg7 = tier.score;
        break;
    }
}
```

注意：`highMax / lowMin` 已在 Range 指标里计算，这里复用。

`return` 的 `total` 累加 3 项：

```ts
total: gap + rvol + drive + vwap + range + atrPctScore
     + openingShapeResult.score + priorDayShapeResult.score
     + todayRangePct + priorDayRangePct + prevRangePctAvg7,
```

## 六、`precomputeTrendBaselinesForSymbol` 新增均值计算

在现有 `for (let i = 0; i < daily.length; i++)` 循环里，RVOL 基线之后、构造 `out[dayKey]` 之前插入：

```ts
// 前 7 日日内 range%（排除 gap）均值。用现有 daily[] 数组，零新增外部依赖。
// 有效天数不足 TREND_RANGE_PCT_AVG_LOOKBACK 时放弃（返回 null），保持和 RVOL 一致的严谨语义。
if (i < TREND_RANGE_PCT_AVG_LOOKBACK) {
    out[dayKey] = null;
    continue;
}
let rangePctSum = 0;
let rangePctCnt = 0;
for (let k = i - TREND_RANGE_PCT_AVG_LOOKBACK; k < i; k++) {
    const d = daily[k];
    if (d.close > 0 && d.high > d.low) {
        rangePctSum += (d.high - d.low) / d.close;
        rangePctCnt++;
    }
}
if (rangePctCnt < Math.ceil(TREND_RANGE_PCT_AVG_LOOKBACK / 2)) {
    out[dayKey] = null;
    continue;
}
const prevRangePctAvg7 = rangePctSum / rangePctCnt;
```

然后塞进 baseline：

```ts
out[dayKey] = {
    prevClose,
    prevAtr,
    prevAtrShort,
    rvolBaseline,
    prevDayOHLC: { ... },
    prevRangePctAvg7, // ← 新增
};
```

**严谨性要求**：数据不足直接返回 null，和现有 RVOL、ATR 的失败路径一致，不做部分基线。

## 七、`scoreTrendDay` 的前置校验

已有校验：`rvolBaseline <= 0 / prevClose / prevAtr / prevAtrShort` 不合法时返回 null。

新增校验（防御性，对齐现有 `prevAtr / prevAtrShort` 校验风格；§6 precompute 正确时一定 > 0）：

```ts
if (!Number.isFinite(baseline.prevRangePctAvg7) || baseline.prevRangePctAvg7 < 0) return null;
```

允许 0（死水票 7 天均值可能极小但非负），不允许负数（数据异常）。

## 八、下游改动

### 8.1 `src/backtest/runner.ts`

**零改动**。只消费 `score.total`（`src/backtest/runner.ts:811`）。

### 8.2 `src/index.ts`

**零改动**。同样只消费 `score.total`（`src/index.ts:286`、`src/index.ts:347`）。

### 8.3 `src/backtest/smokeTrendDetector.ts`

- Case 1（高分票）：构造数据时补 `prevRangePctAvg7`，断言 `total` 加 30 分上限（命中则 +30）
- Case 2（低分票）：新指标阈值都过不了 → `+0`，`total < TREND_SCORE_THRESHOLD` 断言继续成立
- Case 3（边界）：同 Case 2
- Case 4（precompute）：新增断言至少一个 dayKey 的 baseline 包含 `prevRangePctAvg7 > 0`

### 8.4 `src/backtest/analyzeTrendWeights.ts`

这是诊断脚本，`summarize()` 按指标分位输出 cumR 分桶。需要新增 3 个分位统计（命中 vs 未命中的 cumR 对比），用法和 `openingShape` 一致。

### 8.5 `src/backtest/reportTrend.ts`

报告生成器，加 3 行分项。

### 8.6 `references/TREND.md`

- 第 2 节加三条指标说明
- 总分上限 140 → **170**，实际最高 130 → **160**（Prior Day Shape 仍禁用）
- 第 3 节公式追加 3 项
- 附录历史演进加一行 v4c

## 九、门槛策略

**门槛 `TREND_SCORE_THRESHOLD` 保持 55 不动**。

理由：总分上限从 140 升到 170（+21%），但新增 3 个指标权重只占新总分的 17%，对历史通过率的"稀释"有限。实验阶段先让新指标"为过线添砖"，通过 `analyzeTrendWeights.ts` 看每个新指标的命中率和区分力，再决定：

- 某个新指标区分力好 → 提高其权重或档位
- 区分力差（和已有指标强相关，cumR 对比无意义）→ 剔除，恢复 140 上限
- 三个都有用但冗余 → 合并成 max-of-three（回到之前讨论过的 A 方案）
- 门槛需要上调以维持同等通过率 → 改 `TREND_SCORE_THRESHOLD`

诊断阶段预期跑一年样本，对比当前 baseline（9779 trades, 910.7 cumR）的通过数和质量。

## 十、测试计划

1. **Smoke**（`smokeTrendDetector.ts`）：更新 4 个 case，`TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test npx ts-node --transpile-only` 运行
2. **全量回测**：一年样本，门槛 55 不变，对比新旧：trades、winRate、avgR、cumR、maxDD、cumR÷maxDD
3. **诊断**：`analyzeTrendWeights.ts` 单独看三个新指标的命中率 + 命中时的 cumR

## 十一、风险和缓解

| 风险 | 概率 | 缓解 |
|---|---|---|
| 指标十一和指标六高度相关（线性相关 > 0.9），等于双倍权重 | 中 | 分开打分保留诊断数据；后续根据相关性决定是否剔除其一 |
| 指标九阈值 1.0% 过松，几乎所有票都命中 | 低 | 诊断时看命中率，> 80% 就收紧到 1.2% |
| 三个指标合起来 +30 分，把门槛变得过松（通过率大涨） | 中 | 门槛维持 55 做 A/B；若通过率翻倍、cumR 下降，上调门槛到 65 |
| `precomputeTrendBaselinesForSymbol` 因"前 7 天有效样本不足"返回 null 的比例上升 | 低 | 7 天门槛比 RVOL 的 5 天还严 1 天，但样本长度通常足够；监控 null 比例 |
| 诊断字段 `prevRangePctAvg7Value` 和主分字段 `prevRangePctAvg7` 命名冲突 | 低 | 已在 §3.2 明确用 `Value` 后缀区分；实现时按此写 |

## 十二、范围外（Non-goals）

- 不改 `TREND_SCORE_THRESHOLD`（诊断后再调）
- 不做 A/B 合并（先 B 方案独立打分做实验，和用户约定）
- 不加 CLI flag 覆盖阈值（YAGNI，有需要再加）
- 不改 `src/backtest/runner.ts` 和 `src/index.ts`（零 downstream 改动）
- 不改指标一~八的任何逻辑

## 十三、文件改动清单

| 文件 | 改动 |
|---|---|
| `src/core/trendDetector.ts` | 3 组阈值常量、`TrendBaseline` +1 字段、`TrendScore`/`Details` +3+3 字段、`scoreTrendDay` +3 段、`precompute` 循环 +7 天均值、`scoreTrendDay` 新 null 校验 |
| `src/backtest/smokeTrendDetector.ts` | 4 个 case 补新字段；Case 1 total 上限更新；Case 4 新增断言 |
| `src/backtest/analyzeTrendWeights.ts` | 新增 3 个指标的命中率 + cumR 分桶输出 |
| `src/backtest/reportTrend.ts` | 报告加 3 行分项 |
| `references/TREND.md` | 加 9/10/11 小节、总分表更新、公式段落追加、附录 v4c |

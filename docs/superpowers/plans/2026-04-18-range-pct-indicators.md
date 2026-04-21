# 日内百分比波动指标实现计划（Trend Detector v4c）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `src/core/trendDetector.ts` 新增 3 个独立的"日内百分比波动"指标（指标九/十/十一），各 10 分、单档阈值。总分上限 140 → 170，门槛维持 55。spec: `docs/superpowers/specs/2026-04-18-range-pct-indicators-design.md`。

**Architecture:** 3 组阈值常量 + `TrendBaseline` 加 `prevRangePctAvg7` 字段 + `TrendScore`/`Details` 加 3 主分 + 3 诊断字段。`scoreTrendDay` 在现有指标八后追加 3 段计算。`precomputeTrendBaselinesForSymbol` 用现有 `daily[]` 数组计算 7 天均值，零新增依赖。下游 `runner.ts` / `index.ts` 零改动（只消费 `total`），`types.ts` 扩 optional 字段向后兼容。

**Tech Stack:** TypeScript、无新增依赖、测试走现有 smoke 脚本风格（手写 assert）。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/core/trendDetector.ts` | 修改 | 加 3 组阈值常量 + `TREND_RANGE_PCT_AVG_LOOKBACK` 导出；扩 `TrendBaseline` / `TrendScore` / `TrendScoreDetails`；`scoreTrendDay` 追加 3 段 + 1 条前置校验；`precomputeTrendBaselinesForSymbol` 加 7 天均值 |
| `src/backtest/types.ts` | 修改 | `BacktestTrade.entryDayScoreDetail` 扩 3 optional 主分 + 3 optional 诊断字段 |
| `src/backtest/runner.ts` | 修改 | `entryDayScoreDetail` 写入处补 3 个主分字段（details 通过引用自动带上诊断字段） |
| `src/backtest/smokeTrendDetector.ts` | 修改 | 4 个 case 的 baseline 字面量补 `prevRangePctAvg7`；Case 1 总分重算；Case 4 新增 `prevRangePctAvg7 > 0` 断言 |
| `src/backtest/analyzeTrendWeights.ts` | 修改 | 新增 3 个指标的命中率 + cumR 分桶；总分桶上限 141 → 171 |
| `src/backtest/reportTrend.ts` | 修改 | 分数分桶边界适配到 170 |
| `references/TREND.md` | 修改 | 加指标九/十/十一小节；第三节公式追加 3 项；总分 140 → 170；附录加 v4c |

---

## Task 1：给 `TrendBaseline` 加 `prevRangePctAvg7` 字段（纯数据扩展）

**Files:**
- Modify: `src/core/trendDetector.ts`（`TrendBaseline` 接口 + `precomputeTrendBaselinesForSymbol`）
- Modify: `src/backtest/smokeTrendDetector.ts`（4 个 case 字面量）

这一步只扩数据流，不加评分逻辑；smoke 依然绿。

- [ ] **Step 1: 扩 `TrendBaseline` 接口**

修改 `src/core/trendDetector.ts` 第 129-135 行：

```ts
/** 某支票某一天用的历史基准(前 1 日 close/ATR + 前 RVOL_LOOKBACK_DAYS 天同窗口成交量均值) */
export interface TrendBaseline {
    prevClose: number;
    prevAtr: number; // 7 日 ATR,用于 Range 指标
    prevAtrShort: number; // 短周期 ATR,用于指标六 ATR%(可配置)
    rvolBaseline: number; // 前 N 天 (RVOL_LOOKBACK_DAYS) 同窗口 (OPENING_WINDOW_MINUTES 根) 成交量均值
    prevDayOHLC: CandleOHLC;
    prevRangePctAvg7: number; // 前 TREND_RANGE_PCT_AVG_LOOKBACK 天日内 (high-low)/close 均值(排除 gap)
}
```

- [ ] **Step 2: 加常量 `TREND_RANGE_PCT_AVG_LOOKBACK`**

修改 `src/core/trendDetector.ts` 第 126 行附近（`TREND_ATR_SHORT_PERIOD_DEFAULT` 之后）：

```ts
/** 指标六 ATR% 用的 ATR 天数 —— 想反映"最近几天波动率"可调短,默认和 Range 同步 */
export const TREND_ATR_SHORT_PERIOD_DEFAULT = 7;
/** 指标十一:前 N 天日内 (high-low)/close 均值的窗口,默认 7 天和 ATR 对齐 */
export const TREND_RANGE_PCT_AVG_LOOKBACK = 7;
```

- [ ] **Step 3: 在 `precomputeTrendBaselinesForSymbol` 里算 7 天均值**

修改 `src/core/trendDetector.ts` 第 427-440 行附近（RVOL 基线 `if (rvolBaseline <= 0)` 之后、`out[dayKey] = {...}` 之前）插入：

```ts
        // 前 TREND_RANGE_PCT_AVG_LOOKBACK 天的日内 (high-low)/close 均值(排除 gap)
        // 用已有 daily[] 数组,零新增依赖
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

然后修改 `src/core/trendDetector.ts` 第 429-440 行的 `out[dayKey] = {...}`，加上新字段：

```ts
        out[dayKey] = {
            prevClose,
            prevAtr,
            prevAtrShort,
            rvolBaseline,
            prevDayOHLC: {
                open: prevDay.open,
                high: prevDay.high,
                low: prevDay.low,
                close: prevDay.close,
            },
            prevRangePctAvg7,
        };
```

- [ ] **Step 4: 补 4 个 smoke case 的 baseline 字面量**

修改 `src/backtest/smokeTrendDetector.ts` 第 53-59 行（Case 1）：

```ts
    const baseline: TrendBaseline = {
        prevClose: 100,
        prevAtr: 4,
        prevAtrShort: 4,
        rvolBaseline: 3000,
        prevDayOHLC: { open: 98, high: 101, low: 97, close: 100 },
        prevRangePctAvg7: 0.04, // 大于 0.025 阈值,命中指标十一
    };
```

修改 `src/backtest/smokeTrendDetector.ts` 第 100-106 行（Case 2）：

```ts
    const baseline: TrendBaseline = {
        prevClose: 100,
        prevAtr: 2,
        prevAtrShort: 2,
        rvolBaseline: 10000,
        prevDayOHLC: { open: 99.5, high: 100.5, low: 99, close: 100 },
        prevRangePctAvg7: 0.015, // 小于 0.025 阈值,不命中指标十一
    };
```

修改 `src/backtest/smokeTrendDetector.ts` 第 141-147 行（Case 3）：

```ts
    const baseline: TrendBaseline = {
        prevClose: 100,
        prevAtr: 2,
        prevAtrShort: 2,
        rvolBaseline: 10000,
        prevDayOHLC: { open: 99.5, high: 100.5, low: 99, close: 100 },
        prevRangePctAvg7: 0.015, // 小于 0.025 阈值,不命中指标十一
    };
```

Case 4 构造 25 天数据，`precompute` 会自动算出 `prevRangePctAvg7`，无需手工填。

- [ ] **Step 5: 编译 + 跑 smoke 验证数据流通**

Run:
```bash
npx tsc --noEmit
```

Expected: 编译通过。

Run:
```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/smokeTrendDetector.ts
```

Expected: 全部 PASS。注意：Case 1 的 total 断言仍是 100，Case 2/3 仍是 `total < 55`，因为指标九/十/十一还没接入 `scoreTrendDay`。

- [ ] **Step 6: 提交**

```bash
git add src/core/trendDetector.ts src/backtest/smokeTrendDetector.ts
git commit -m "feat(trend): add prevRangePctAvg7 field to TrendBaseline

$(echo 'Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2：加 3 组阈值常量

**Files:**
- Modify: `src/core/trendDetector.ts`（阈值常量块）

- [ ] **Step 1: 加常量**

在 `src/core/trendDetector.ts` 第 33-34 行附近（`ATR_PCT_TIERS` 之后、`// ====== Candle Shape 指标阈值` 之前）插入：

```ts
// 指标九:今日开盘 5min 日内百分比波动 (high-low)/open
const TODAY_RANGE_PCT_TIERS = [
    { pct: 0.01, score: 10 },
];
// 指标十:昨日单日日内百分比波动 (prevDay.high-prevDay.low)/prevClose
const PRIOR_DAY_RANGE_PCT_TIERS = [
    { pct: 0.025, score: 10 },
];
// 指标十一:前 TREND_RANGE_PCT_AVG_LOOKBACK 天日内 (high-low)/close 均值
const PREV_RANGE_PCT_AVG_TIERS = [
    { pct: 0.025, score: 10 },
];
```

- [ ] **Step 2: 编译**

Run: `npx tsc --noEmit`
Expected: 通过（常量未使用不会报红，ts-node 也不会 warn）。

- [ ] **Step 3: 提交**

```bash
git add src/core/trendDetector.ts
git commit -m "feat(trend): add threshold constants for range% indicators

$(echo 'Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3：扩 `TrendScore` / `TrendScoreDetails`

**Files:**
- Modify: `src/core/trendDetector.ts`

这一步故意让编译**先报红** —— `scoreTrendDay` 返回的对象此时会缺 6 个新字段，下一个 task 补齐。

- [ ] **Step 1: 扩 `TrendScoreDetails`**

修改 `src/core/trendDetector.ts` 第 137-154 行（当前 `TrendScoreDetails` 接口），在尾部加 3 个字段：

```ts
export interface TrendScoreDetails {
    gapPct: number;
    rvolValue: number;
    driveAtr: number;
    vwapControlRatio: number;
    vwapControlSide: 'long' | 'short' | 'none';
    rangeValue: number;
    atrPct: number; // prevAtrShort / prevClose
    // Candle Shape 诊断字段
    openingBodyRatio: number;
    openingShadowRatio: number;
    openingBodyAtr: number;
    openingShapeTier: CandleShapeResult['tier'];
    priorDayBodyRatio: number;
    priorDayShadowRatio: number;
    priorDayBodyAtr: number;
    priorDayShapeTier: CandleShapeResult['tier'];
    // 日内百分比波动诊断字段(指标九/十/十一)
    todayRangePctValue: number;
    priorDayRangePctValue: number;
    prevRangePctAvg7Value: number;
}
```

- [ ] **Step 2: 扩 `TrendScore`**

修改 `src/core/trendDetector.ts` 第 156-167 行：

```ts
export interface TrendScore {
    total: number; // 0–170(实际最高 160,priorDayShape 禁用)
    gap: number;
    rvol: number;
    drive: number;
    vwap: number;
    range: number;
    atrPct: number;
    openingShape: number;
    priorDayShape: number;
    todayRangePct: number;
    priorDayRangePct: number;
    prevRangePctAvg7: number;
    details: TrendScoreDetails;
}
```

- [ ] **Step 3: 确认编译报红**

Run: `npx tsc --noEmit`

Expected: **编译失败**。报错在 `src/core/trendDetector.ts` 第 310 行附近的 `return {...}`，提示 `TrendScore` 缺 `todayRangePct / priorDayRangePct / prevRangePctAvg7`，`TrendScoreDetails` 缺 `todayRangePctValue / priorDayRangePctValue / prevRangePctAvg7Value`。**这是预期的红**，下一个 task 就是补上。

**不提交**（保持 uncommitted 状态进入 Task 4，让 Task 4 一次性落下完整 commit）。

---

## Task 4：在 `scoreTrendDay` 里接入三个指标（核心逻辑）

**Files:**
- Modify: `src/core/trendDetector.ts`（`scoreTrendDay` 函数体）

- [ ] **Step 1: 加前置校验**

修改 `src/core/trendDetector.ts` 第 193-197 行（现有 `if` 校验块），在尾部追加一行：

```ts
    if (window.length !== OPENING_WINDOW_MINUTES) return null;
    if (baseline.rvolBaseline <= 0) return null;
    if (!Number.isFinite(baseline.prevClose) || baseline.prevClose <= 0) return null;
    if (!Number.isFinite(baseline.prevAtr) || baseline.prevAtr <= 0) return null;
    if (!Number.isFinite(baseline.prevAtrShort) || baseline.prevAtrShort <= 0) return null;
    if (!Number.isFinite(baseline.prevRangePctAvg7) || baseline.prevRangePctAvg7 < 0) return null;
```

注意：允许 `prevRangePctAvg7 === 0`（死水票），不允许负数或 NaN。

- [ ] **Step 2: 在指标八之后追加 3 段计算**

修改 `src/core/trendDetector.ts` 第 308-309 行（紧接 `priorDayShapeResult` 计算完、`return {` 之前）插入：

```ts
    // ====== 指标九:Today Opening Range% ======
    // (highMax - lowMin) 已在指标五里算好,window[0].open 已在开头拿到
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

    // ====== 指标十:Prior Day Range% (排除 gap) ======
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

    // ====== 指标十一:Prev Range% Avg (TREND_RANGE_PCT_AVG_LOOKBACK 天均值) ======
    const prevRangePctAvg7Value = baseline.prevRangePctAvg7;
    let prevRangePctAvg7 = 0;
    for (const tier of PREV_RANGE_PCT_AVG_TIERS) {
        if (prevRangePctAvg7Value > tier.pct) {
            prevRangePctAvg7 = tier.score;
            break;
        }
    }
```

- [ ] **Step 3: 更新 `return` 对象**

修改 `src/core/trendDetector.ts` 第 310-339 行的 `return {...}`：

```ts
    return {
        total:
            gap + rvol + drive + vwap + range + atrPctScore +
            openingShapeResult.score + priorDayShapeResult.score +
            todayRangePct + priorDayRangePct + prevRangePctAvg7,
        gap,
        rvol,
        drive,
        vwap,
        range,
        atrPct: atrPctScore,
        openingShape: openingShapeResult.score,
        priorDayShape: priorDayShapeResult.score,
        todayRangePct,
        priorDayRangePct,
        prevRangePctAvg7,
        details: {
            gapPct,
            rvolValue,
            driveAtr,
            vwapControlRatio,
            vwapControlSide,
            rangeValue,
            atrPct,
            openingBodyRatio: openingShapeResult.bodyRatio,
            openingShadowRatio: openingShapeResult.shadowRatio,
            openingBodyAtr: openingShapeResult.bodyAtr,
            openingShapeTier: openingShapeResult.tier,
            priorDayBodyRatio: priorDayShapeResult.bodyRatio,
            priorDayShadowRatio: priorDayShapeResult.shadowRatio,
            priorDayBodyAtr: priorDayShapeResult.bodyAtr,
            priorDayShapeTier: priorDayShapeResult.tier,
            todayRangePctValue,
            priorDayRangePctValue,
            prevRangePctAvg7Value,
        },
    };
```

- [ ] **Step 4: 编译**

Run: `npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 5: 跑 smoke（预期 Case 1 失败）**

Run:
```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/smokeTrendDetector.ts
```

Expected: **Case 1 assertion 失败**，因为：
- Case 1 baseline `prevRangePctAvg7 = 0.04 > 0.025`，指标十一命中 +10
- Case 1 window 5min range ≈ 2.1 / open 102.5 ≈ 2.05% > 1.0%，指标九命中 +10
- Case 1 `prevDayOHLC` high-low = 4 / prevClose 100 = 4% > 2.5%，指标十命中 +10
- Total 从 100 应该变成 **130**。

Case 2/3 的 `total < 55` 断言应仍然成立（指标九/十/十一都没命中）。记录 smoke 实际输出用于 Task 5。

- [ ] **Step 6: 不提交**，进入 Task 5 一起修 smoke。

---

## Task 5：修 smoke Case 1 的 total 断言 + Case 4 新断言

**Files:**
- Modify: `src/backtest/smokeTrendDetector.ts`

- [ ] **Step 1: 更新 Case 1 assertion block（加 3 个主分断言、total 改 130）**

修改 `src/backtest/smokeTrendDetector.ts` 第 81-91 行的 assertion 块：

```ts
    const score = scoreTrendDay(window, baseline);
    assert(score !== null, 'case1: score should not be null');
    console.log('  case1 score:', JSON.stringify(score));
    assert(score!.gap === 25, `case1 gap expected 25, got ${score!.gap}`);
    assert(score!.rvol === 40, `case1 rvol expected 40, got ${score!.rvol}`);
    assert(score!.drive === 0, `case1 drive expected 0, got ${score!.drive}`);
    assert(score!.vwap === 5, `case1 vwap expected 5, got ${score!.vwap}`);
    assert(score!.range === 15, `case1 range expected 15, got ${score!.range}`);
    assert(score!.atrPct === 15, `case1 atrPct expected 15, got ${score!.atrPct}`);
    assert(score!.openingShape === 0, `case1 openingShape expected 0, got ${score!.openingShape}`);
    assert(score!.priorDayShape === 0, `case1 priorDayShape expected 0, got ${score!.priorDayShape}`);
    assert(score!.todayRangePct === 10, `case1 todayRangePct expected 10, got ${score!.todayRangePct}`);
    assert(score!.priorDayRangePct === 10, `case1 priorDayRangePct expected 10, got ${score!.priorDayRangePct}`);
    assert(score!.prevRangePctAvg7 === 10, `case1 prevRangePctAvg7 expected 10, got ${score!.prevRangePctAvg7}`);
    assert(score!.total === 130, `case1 total expected 130, got ${score!.total}`);
    console.log('  case1 PASS');
```

**解释 case1 新指标命中**：
- 指标九：`(highMax - lowMin) / open ≈ 2.1 / 102.5 ≈ 0.0205 > 0.01` → 10 分
- 指标十：`(101 - 97) / 100 = 0.04 > 0.025` → 10 分
- 指标十一：`prevRangePctAvg7 = 0.04 > 0.025` → 10 分

- [ ] **Step 2: 更新 Case 1 注释**

修改 `src/backtest/smokeTrendDetector.ts` 第 45-50 行注释：

```ts
// ============================================================
// Case 1: 高分样本(总分 130)
// gap 2.5% (25) + RVOL ~4.17 (40) + drive 归零 (0) + VWAP 全站上 (5)
// + range 0.525 ATR (15) + atrPct 0.04 (15) + Opening/PriorDay Shape (0+0)
// + todayRangePct 2.05% (10) + priorDayRangePct 4% (10) + prevRangePctAvg7 0.04 (10)
// ============================================================
```

- [ ] **Step 3: Case 4 新增 `prevRangePctAvg7` 断言**

修改 `src/backtest/smokeTrendDetector.ts` 第 197-206 行末尾（`console.log('  case4 PASS')` 之前）追加：

```ts
    assert(lastDayBaseline!.prevRangePctAvg7 >= 0, 'prevRangePctAvg7 >= 0');
    assert(Number.isFinite(lastDayBaseline!.prevRangePctAvg7), 'prevRangePctAvg7 finite');
```

注意：Case 4 里每天都构造相同 `high=101, low=99, close=100.8`，`(high-low)/close = 2/100.8 ≈ 0.0198`，所以 `prevRangePctAvg7` 应为 `0.0198`，大于 0 有限数。

- [ ] **Step 4: 跑 smoke 验证全部 PASS**

Run:
```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/smokeTrendDetector.ts
```

Expected: `✅ trendDetector smoke all pass`。

- [ ] **Step 5: 提交（合并 Task 3 + 4 + 5 的改动）**

```bash
git add src/core/trendDetector.ts src/backtest/smokeTrendDetector.ts
git commit -m "feat(trend): add range% indicators 9/10/11 to scoreTrendDay

- Indicator 9: today opening 5min (high-low)/open
- Indicator 10: prior day (high-low)/prevClose (gap excluded)
- Indicator 11: prev 7d mean (high-low)/close
- Each 10 points, single-tier, max total 140 -> 170

$(echo 'Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 6：扩 `BacktestTrade.entryDayScoreDetail` 和 runner 写入

**Files:**
- Modify: `src/backtest/types.ts`
- Modify: `src/backtest/runner.ts`

下游消费者（`analyzeTrendWeights.ts`、`reportTrend.ts`）需要能从 trade 结果里读到新指标。旧 JSON 结果无新字段 → 用 optional 保持向后兼容。

- [ ] **Step 1: 扩 `types.ts`**

修改 `src/backtest/types.ts` 第 50-69 行：

```ts
    entryDayScoreDetail?: {
        gap: number; rvol: number; drive: number; vwap: number; range: number;
        atrPct?: number; // optional(旧 json 不存在)
        openingShape?: number;   // optional(旧 json 不存在)
        priorDayShape?: number;  // optional(旧 json 不存在)
        todayRangePct?: number;      // optional(v4c 新增)
        priorDayRangePct?: number;   // optional(v4c 新增)
        prevRangePctAvg7?: number;   // optional(v4c 新增)
        details: {
            gapPct: number; rvolValue: number; driveAtr: number;
            vwapControlRatio: number; vwapControlSide: string; rangeValue: number;
            atrPct: number;
            // optional: Shape 诊断(旧 json 没有)
            openingBodyRatio?: number;
            openingShadowRatio?: number;
            openingBodyAtr?: number;
            openingShapeTier?: string;
            priorDayBodyRatio?: number;
            priorDayShadowRatio?: number;
            priorDayBodyAtr?: number;
            priorDayShapeTier?: string;
            // optional: 日内百分比波动诊断(v4c 新增,旧 json 没有)
            todayRangePctValue?: number;
            priorDayRangePctValue?: number;
            prevRangePctAvg7Value?: number;
        };
    } | null;
```

- [ ] **Step 2: 扩 runner 写入处**

修改 `src/backtest/runner.ts` 第 652-665 行：

```ts
                        entryDayScoreDetail:
                            scoreNow && typeof scoreNow === 'object'
                                ? {
                                    gap: scoreNow.gap,
                                    rvol: scoreNow.rvol,
                                    drive: scoreNow.drive,
                                    vwap: scoreNow.vwap,
                                    range: scoreNow.range,
                                    atrPct: scoreNow.atrPct,
                                    openingShape: scoreNow.openingShape,
                                    priorDayShape: scoreNow.priorDayShape,
                                    todayRangePct: scoreNow.todayRangePct,
                                    priorDayRangePct: scoreNow.priorDayRangePct,
                                    prevRangePctAvg7: scoreNow.prevRangePctAvg7,
                                    details: scoreNow.details,
                                }
                                : null,
```

`details` 是引用，`scoreNow.details` 已经包含 3 个新 `*Value` 字段（Task 4 已扩），不用单独列出。

- [ ] **Step 3: 编译**

Run: `npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 4: 提交**

```bash
git add src/backtest/types.ts src/backtest/runner.ts
git commit -m "feat(backtest): wire range% indicators into BacktestTrade result

$(echo 'Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 7：扩诊断脚本 `analyzeTrendWeights.ts`

**Files:**
- Modify: `src/backtest/analyzeTrendWeights.ts`

加 3 个新指标的分桶诊断 + 更新总分桶上限。

- [ ] **Step 1: 新增 3 个分桶诊断块**

修改 `src/backtest/analyzeTrendWeights.ts` 第 218 行附近（"总分分桶" 之前）插入：

```ts
    // 11. Today Range% (v4c 新增)
    const todayRpTrades = trades.filter(
        t => typeof t.entryDayScoreDetail.details.todayRangePctValue === 'number'
    );
    if (todayRpTrades.length === 0) {
        console.log('\n=== Today Range% (todayRangePctValue) === 跳过:旧 json 无字段,请重跑 recordonly');
    } else {
        const edges = [0, 0.003, 0.006, 0.01, 0.015, 0.02, 0.03, 0.05];
        printTable(
            `Today Range% (todayRangePctValue) [${todayRpTrades.length} trades]`,
            bucketize(todayRpTrades, t => t.entryDayScoreDetail.details.todayRangePctValue!, edges)
        );
    }

    // 12. Prior Day Range% (v4c 新增)
    const priorRpTrades = trades.filter(
        t => typeof t.entryDayScoreDetail.details.priorDayRangePctValue === 'number'
    );
    if (priorRpTrades.length === 0) {
        console.log('\n=== Prior Day Range% (priorDayRangePctValue) === 跳过:旧 json 无字段');
    } else {
        const edges = [0, 0.01, 0.02, 0.025, 0.035, 0.05, 0.08];
        printTable(
            `Prior Day Range% (priorDayRangePctValue) [${priorRpTrades.length} trades]`,
            bucketize(priorRpTrades, t => t.entryDayScoreDetail.details.priorDayRangePctValue!, edges)
        );
    }

    // 13. Prev Range% Avg(7d) (v4c 新增)
    const prevRpAvgTrades = trades.filter(
        t => typeof t.entryDayScoreDetail.details.prevRangePctAvg7Value === 'number'
    );
    if (prevRpAvgTrades.length === 0) {
        console.log('\n=== Prev Range% Avg7 (prevRangePctAvg7Value) === 跳过:旧 json 无字段');
    } else {
        const edges = [0, 0.01, 0.02, 0.025, 0.035, 0.05, 0.08];
        printTable(
            `Prev Range% Avg7 (prevRangePctAvg7Value) [${prevRpAvgTrades.length} trades]`,
            bucketize(prevRpAvgTrades, t => t.entryDayScoreDetail.details.prevRangePctAvg7Value!, edges)
        );
    }
```

- [ ] **Step 2: 更新总分桶上限和累加逻辑**

修改 `src/backtest/analyzeTrendWeights.ts` 第 222-231 行：

```ts
    // 总分分桶(和 reportTrend 的分组表呼应)
    const totalEdges = [0, 15, 30, 45, 60, 75, 90, 105, 120, 140, 171];
    printTable('总分 (total)', bucketize(
        trades,
        t => t.entryDayScoreDetail.gap + t.entryDayScoreDetail.rvol +
             t.entryDayScoreDetail.drive + t.entryDayScoreDetail.vwap +
             t.entryDayScoreDetail.range + (t.entryDayScoreDetail.atrPct ?? 0) +
             (t.entryDayScoreDetail.openingShape ?? 0) +
             (t.entryDayScoreDetail.priorDayShape ?? 0) +
             (t.entryDayScoreDetail.todayRangePct ?? 0) +
             (t.entryDayScoreDetail.priorDayRangePct ?? 0) +
             (t.entryDayScoreDetail.prevRangePctAvg7 ?? 0),
        totalEdges
    ));
```

注意：`?? 0` 让旧 JSON 文件（没有这 3 个字段）依然能跑诊断，不会把 undefined 当 NaN。

- [ ] **Step 3: 编译**

Run: `npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 4: 提交**

```bash
git add src/backtest/analyzeTrendWeights.ts
git commit -m "feat(backtest): add range% indicators to analyzeTrendWeights

$(echo 'Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 8：更新 `reportTrend.ts` 分数桶边界

**Files:**
- Modify: `src/backtest/reportTrend.ts`

现有 `SCORE_BUCKETS` 是为 100 分总分设计的（`0 ≤ s < 30 / 30~60 / 60~80 / 80~100`），对 170 分总分不合理。

- [ ] **Step 1: 更新 `SCORE_BUCKETS`**

修改 `src/backtest/reportTrend.ts` 第 104-110 行：

```ts
const SCORE_BUCKETS: ScoreBucket[] = [
    { label: 'null (无基线)', match: s => s === null },
    { label: '0 ≤ s < 30', match: s => s !== null && s >= 0 && s < 30 },
    { label: '30 ≤ s < 55', match: s => s !== null && s >= 30 && s < 55 },
    { label: '55 ≤ s < 85', match: s => s !== null && s >= 55 && s < 85 },
    { label: '85 ≤ s < 115', match: s => s !== null && s >= 85 && s < 115 },
    { label: '115 ≤ s ≤ 170', match: s => s !== null && s >= 115 && s <= 170 },
];
```

分桶边界说明：
- `0~30`：绝大多数低分票
- `30~55`：低于门槛的灰色区
- `55~85`：刚过门槛（当前 `TREND_SCORE_THRESHOLD = 55`）
- `85~115`：稳定命中多个指标
- `115~170`：高分（原 8 指标上限 140、+ 3 新指标 30）

- [ ] **Step 2: 编译**

Run: `npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
git add src/backtest/reportTrend.ts
git commit -m "chore(backtest): rebucket reportTrend score ranges for 170-max total

$(echo 'Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 9：跑回测端到端验证

**Files:** 无修改，纯运行验证。

- [ ] **Step 1: 跑一小段样本确认 runner 不崩**

Run（1 个月样本）：
```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts \
  --start=2026-03-01 --end=2026-03-31 \
  --filter-trend=on --label=smoke_v4c
```

Expected: 正常跑完，输出 `data/backtest/results/smoke_v4c.json`，`cumR` 和 `trades` 数看起来合理（和旧 `trend_v2_tuned_sl010` 的同时段数据量级相当）。

- [ ] **Step 2: 跑诊断脚本验证分桶**

Run:
```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/analyzeTrendWeights.ts smoke_v4c
```

Expected:
- 看到新的 "Today Range% / Prior Day Range% / Prev Range% Avg7" 三个分桶表
- 总分桶上限到 171
- 每个分桶 `trades > 0`（1 个月样本应该有足够交易）

- [ ] **Step 3: 不需要提交**，这一步是验证不是改动。如果发现问题回到前面的 task 修复。

---

## Task 10：更新 `references/TREND.md` 文档

**Files:**
- Modify: `references/TREND.md`

- [ ] **Step 1: 更新评分系统总分**

修改 `references/TREND.md` 第 22-29 行：

```markdown
# 二、评分系统

指标 = 6 个"传统量能/波动率"指标（指标一~六） + 2 个"K 线身形"指标（指标七、八） + 3 个"日内百分比波动"指标（指标九~十一）。

当前生产配置下**禁用了指标三（Opening Drive）和指标八（Prior Day Shape）**，以及指标七的两个子档（长影线型、满实体型）。代码保留，通过阈值设高或 `maxScore=0` 实现"禁用但便于恢复"。

总分上限 **170**，实际最高 **160**（Prior Day Shape 被禁用）。
```

- [ ] **Step 2: 在指标八末尾（第 120 行附近的分隔线之前）加入指标九/十/十一三小节**

在 `references/TREND.md` 第 120 行（`---` 分隔线之前）插入：

```markdown
## 指标九：Today Opening Range%（10 分）

```js
todayRangePct = (5min_high - 5min_low) / window[0].open
```

| Range% | 分数 |
| ---- | ---- |
| > 1.0% | 10 |
| else | 0 |

排除 overnight gap，纯日内视角。和指标五（Range / prevAtr）的区别：分母用当日开盘价而非昨日 ATR，在"绝对百分比空间"这个维度上补一个视角。

## 指标十：Prior Day Range%（10 分）

```js
priorDayRangePct = (prevDay.high - prevDay.low) / prevClose
```

| Range% | 分数 |
| ---- | ---- |
| > 2.5% | 10 |
| else | 0 |

昨日单日日内波动率（排除 gap）。用前一日 OHLC 已有字段，零新增计算。

## 指标十一：Prev Range% Avg (7 day)（10 分）

```js
prevRangePctAvg7 = mean((dailyHigh - dailyLow) / dailyClose)  // 前 7 天
```

| Range% Avg | 分数 |
| ---- | ---- |
| > 2.5% | 10 |
| else | 0 |

前 7 天日内波动率均值，排除 gap。和指标六 ATR% 的区别：ATR 含 overnight 跳空，本指标纯日内。高相关但在 gap 频发标的上行为分叉。窗口长度常量 `TREND_RANGE_PCT_AVG_LOOKBACK = 7`。
```

- [ ] **Step 3: 更新第三节公式**

修改 `references/TREND.md` 第 123-129 行：

```markdown
# 三、最终评分公式

```js
score = gap(25) + rvol(40) + drive(0) + vwap(5) + range(30)
      + atrPct(15) + openingShape(15) + priorDayShape(0)
      + todayRangePct(10) + priorDayRangePct(10) + prevRangePctAvg7(10)
// 总分上限 = 170,实际最高 160(priorDayShape 禁用)
```
```

- [ ] **Step 4: 在附录历史演进表末尾加一行**

修改 `references/TREND.md` 第 184-185 行：

```markdown
| v4b | Opening Shape 只留 long-kline 档（阈值 0.6）；Prior Day Shape 全禁用；门槛 45 → 55 |
| **v4c（当前）** | 新增指标九/十/十一（3 个独立的日内百分比波动指标，各 10 分）；总分 140 → 170；门槛维持 55（诊断后再调） |
```

并修改前一行的 **v4b（当前）** 去掉加粗和 "当前" 标记。

- [ ] **Step 5: 提交**

```bash
git add references/TREND.md
git commit -m "docs(trend): document range% indicators (v4c)

$(echo 'Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 11：最终全量验证

**Files:** 无修改。

- [ ] **Step 1: 完整 smoke**

Run:
```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/smokeTrendDetector.ts
```

Expected: `✅ trendDetector smoke all pass`。

- [ ] **Step 2: 全量编译检查**

Run: `npx tsc --noEmit`
Expected: 0 errors。

- [ ] **Step 3: `npm run build` 通过**

Run: `npm run build`
Expected: 构建到 `dist/`，无报错。

- [ ] **Step 4: 总结**

用户需要的后续动作（不属于本 plan 范围，由用户决定）：
- 跑一年样本对比（和当前 `910.7 cumR / 42.4 maxDD` baseline）
- 用 `analyzeTrendWeights.ts` 诊断三个新指标的区分力
- 根据诊断决定：合并 / 调权 / 调阈值 / 调门槛

---

## 提交计划总结

| Task | 提交信息 |
|---|---|
| 1 | feat(trend): add prevRangePctAvg7 field to TrendBaseline |
| 2 | feat(trend): add threshold constants for range% indicators |
| 3+4+5 | feat(trend): add range% indicators 9/10/11 to scoreTrendDay |
| 6 | feat(backtest): wire range% indicators into BacktestTrade result |
| 7 | feat(backtest): add range% indicators to analyzeTrendWeights |
| 8 | chore(backtest): rebucket reportTrend score ranges for 170-max total |
| 10 | docs(trend): document range% indicators (v4c) |

Task 9 和 11 只是验证，无提交。

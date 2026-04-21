# Trend Detector v5 — 权重 / 阈值重分配实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在一年样本（2025-04 ~ 2026-04）上，通过"离线重打分 + greedy 网格搜"给 11 个趋势指标重新分配阈值和权重并重扫门槛，目标 `cumR÷maxDD` 高于当前 v4c-tuned 的 16.15，硬约束 `cumR ≥ 1170.9`（相对当前 1232.5 下降不超过 5%）。

**Architecture:** (1) 先跑一次 `trend_recordonly_v5_seed`（detector 关、所有信号都成交，但写完整 `entryDayScoreDetail`）作为所有离线实验的种子数据；(2) 新增一个纯函数 `rescoreTrade.ts`（把"从 details 原始值 + 参数 → 总分"的逻辑抽出来，`trendDetector.ts` 和离线脚本共享）；(3) 新增 `rescoreTrend.ts` CLI：读种子 json + 参数配置 → 输出 summary；(4) 新增 `gridSearchTrend.ts`：三阶段 greedy（阈值→权重→门槛）搜索，硬约束过滤，输出 top-10；(5) top 候选用 `runner.ts` 实跑确认；(6) 选定后把 `*_TIERS` 常量、`*_SCORE` 常量、`TREND_SCORE_THRESHOLD` 改成 v5 值，更新 smoke 断言和 `references/TREND.md`。

**Tech Stack:** TypeScript、no new deps。复用 `analyzeTrendWeights.ts:bucketize/quantileEdges`、`reportTrend.ts:summarize`、`BacktestTrade.entryDayScoreDetail`。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/core/trendDetector.ts` | 修改 | 抽 `scoreTrendFromDetails()` 纯函数 + 常量 export；Task 8 更新阈值/权重/门槛值 |
| `src/core/trendDetector.test-utils.ts` | **（不新建）** | — |
| `src/backtest/rescoreTrend.ts` | 新建 | CLI：读 recordonly json + 参数 JSON → 输出 summary（trades/winRate/avgR/cumR/maxDD/ratio） |
| `src/backtest/smokeRescoreTrend.ts` | 新建 | 2 个 case：（a）默认参数 rescore 的 summary 等于 v4c-tuned 实跑结果；（b）阈值改动后 summary 按预期变化 |
| `src/backtest/gridSearchTrend.ts` | 新建 | 三阶段 greedy 搜索，读 seed json，输出 `data/backtest/grid_search_v5.json` + 控制台 top-10 表 |
| `src/backtest/smokeTrendDetector.ts` | 修改 | Task 8 末尾更新 case 1/7/8 的期望值 |
| `references/TREND.md` | 修改 | Task 9 更新 §5 性能表、§一、二 阈值、附录版本行 |
| `docs/superpowers/plans/2026-04-19-trend-v5-weight-tuning.md` | 新建（本文件） | — |

---

## Task 1：跑 `trend_recordonly_v5_seed`（一年种子数据）

**Files:** 无代码改动，纯运行。

**目的：** 拿到一份"detector 关、所有信号都成交、每笔带 `entryDayScoreDetail`"的一年回测，后续所有离线重打分以它为输入。

- [ ] **Step 1: 检查现有 v4c-tuned 结果作为 baseline 锚点**

Run:
```bash
ls /Users/bytedance/workspace/vwap_daytrade/data/backtest/results/smoke_v4c.json
```

Expected: 文件存在（这是当前 v4c-tuned cumR 1232.5 / ratio 16.15 的结果）。若不存在，继续但需要在 Task 2 里用其他已存在的 v4c 结果做对比。

- [ ] **Step 2: 跑 recordonly 种子**

Run:
```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts \
  trend_recordonly_v5_seed trailing 0 0.1 \
  --filter-trend=off
```

Expected: 3-5 分钟跑完，产出 `data/backtest/results/trend_recordonly_v5_seed.json`，`trades` 数量约 32000+（对照 TREND.md §5 "无 detector baseline" 的 32443）。

- [ ] **Step 3: 确认 trade 里有完整 details**

Run:
```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only -e "
const fs = require('fs');
const j = JSON.parse(fs.readFileSync('data/backtest/results/trend_recordonly_v5_seed.json','utf8'));
console.log('trades:', j.trades.length);
const withDetail = j.trades.filter(t => t.entryDayScoreDetail && t.entryDayScoreDetail.details);
console.log('with details:', withDetail.length);
console.log('sample:', JSON.stringify(withDetail[0]?.entryDayScoreDetail?.details, null, 2));
"
```

Expected: `trades` 约 32000+，`with details` ≈ `trades`（除预热期标的外），sample 输出含全部 11 个 `*Value` 字段（`gapPct`、`rvolValue`、`driveAtr`、`vwapControlRatio`、`rangeValue`、`atrPct`、`openingBodyAtr`、`openingShapeTier`、`priorDayBodyAtr`、`priorDayShapeTier`、`todayRangePctValue`、`priorDayRangePctValue`、`prevRangePctAvg7Value`）。

- [ ] **Step 4: 不提交（json 结果不入 git）**

Run:
```bash
cd /Users/bytedance/workspace/vwap_daytrade && git status --short | grep -c trend_recordonly || true
```

Expected: 0（`data/backtest/results/*.json` 应被 `.gitignore` 忽略；如果没有，下一步检查 .gitignore）。

---

## Task 2：在 `trendDetector.ts` 里抽出 `scoreTrendFromDetails()` 纯函数

**Files:**
- Modify: `src/core/trendDetector.ts`（在 `scoreTrendDay` 之后、`precomputeTrendBaselinesForSymbol` 之前插入新函数）

**目的：** 把"从 11 个 details 原始数值 + 参数 → 总分"的逻辑独立成可复用函数，让 `rescoreTrend.ts` 不重复实现打分，避免离线/实盘口径漂移。**保持 `scoreTrendDay` 默认行为完全不变**。

- [ ] **Step 1: 先读 `scoreTrendDay` 现有分数累加逻辑**

Read `src/core/trendDetector.ts:256-469`（整个 `scoreTrendDay` 函数体）。确认心智模型：每个指标都是"读一个原始值 → 按 TIERS 从高到低匹配第一个满足的档 → 加分"。

- [ ] **Step 2: 在 `src/core/trendDetector.ts` 第 128 行 `TREND_SCORE_THRESHOLD` 定义之前添加 `TrendScoreParams` 类型**

找到 `export const TREND_SCORE_THRESHOLD = 70;` 这一行（约 L129）。**在这一行之前**插入：

```ts
/** 评分参数 —— 所有 11 个指标的阈值和权重 + 门槛。共享给 scoreTrendDay 和 rescoreTrade。 */
export interface TrendScoreParams {
    gapTiers: { pct: number; score: number }[];
    rvolTiers: { v: number; score: number }[];
    driveTiers: { atr: number; score: number }[];
    vwapFullScore: number;
    vwapPartialScore: number;
    vwapPartialRatio: number;
    rangeTiers: { atr: number; score: number }[];
    atrPctTiers: { pct: number; score: number }[];
    openingShapeMaxScore: number;
    openingShapeThresholds: CandleShapeThresholds;
    priorDayShapeMaxScore: number;
    priorDayShapeThresholds: CandleShapeThresholds;
    todayRangePctTiers: { pct: number; score: number }[];
    priorDayRangePctTiers: { pct: number; score: number }[];
    prevRangePctAvgTiers: { pct: number; score: number }[];
    /** 评分门槛。注意不是 TrendScoreParams 内部用,是 rescore/runner 比较总分时用。放一起方便序列化传参。 */
    scoreThreshold: number;
}

/** 默认参数 = 当前生产 v4c-tuned 配置。这是 rescore 的 fallback 和 smoke 的对照。 */
export const DEFAULT_TREND_SCORE_PARAMS: TrendScoreParams = {
    gapTiers: [{ pct: 0.02, score: 25 }],
    rvolTiers: [{ v: 2, score: 40 }, { v: 1.5, score: 20 }],
    driveTiers: [],
    vwapFullScore: 5,
    vwapPartialScore: 5,
    vwapPartialRatio: 0.8,
    rangeTiers: [{ atr: 1.0, score: 30 }, { atr: 0.5, score: 15 }],
    atrPctTiers: [{ pct: 0.025, score: 15 }],
    openingShapeMaxScore: 15,
    openingShapeThresholds: {
        longShadowRatio: 1.01,
        fullBodyRatio: 1.01,
        fullBodyMinTotalPct: 0.003,
        longKlineBodyAtr: 0.6,
        maxScore: 15,
    },
    priorDayShapeMaxScore: 0,
    priorDayShapeThresholds: {
        longShadowRatio: 0.65,
        fullBodyRatio: 0.75,
        fullBodyMinTotalPct: 0.01,
        longKlineBodyAtr: 0.8,
        maxScore: 0,
    },
    todayRangePctTiers: [{ pct: 0.01, score: 10 }],
    priorDayRangePctTiers: [{ pct: 0.025, score: 10 }],
    prevRangePctAvgTiers: [{ pct: 0.025, score: 10 }],
    scoreThreshold: 70,
};
```

- [ ] **Step 3: 在 `scoreTrendDay` 函数结尾之后（约 L469 `}`）添加 `rescoreFromDetails` 函数**

```ts
/**
 * 从 `TrendScoreDetails` + `TrendScoreParams` 直接算总分(不需要 bar window 和 baseline)。
 *
 * 用途:离线重打分 —— 拿已有 BacktestTrade.entryDayScoreDetail.details 的 11 个原始值,
 * 套不同参数组合快速算分,供 gridSearchTrend.ts 网格搜索。
 *
 * 和 scoreTrendDay 的一致性保证:对同一份 details + 同一份参数,两者必须给出完全一致的分项分数。
 * smokeRescoreTrend.ts 的 case A 用 recordonly json 的每条 trade 做 rescore(默认参数),总分必须
 * 等于该 trade 自带的 `entryDayScoreDetail.gap+rvol+drive+...` 之和。
 *
 * 注意:openingShape 和 priorDayShape 的 tier 判定需要 bodyRatio/bodyAtr/shadowRatio,都在 details 里。
 */
export function rescoreFromDetails(
    details: TrendScoreDetails,
    params: TrendScoreParams
): {
    total: number;
    gap: number; rvol: number; drive: number; vwap: number; range: number;
    atrPct: number; openingShape: number; priorDayShape: number;
    todayRangePct: number; priorDayRangePct: number; prevRangePctAvg7: number;
} {
    // 1. Gap
    let gap = 0;
    for (const tier of params.gapTiers) {
        if (details.gapPct > tier.pct) { gap = tier.score; break; }
    }
    // 2. RVOL
    let rvol = 0;
    for (const tier of params.rvolTiers) {
        if (details.rvolValue > tier.v) { rvol = tier.score; break; }
    }
    // 3. Drive
    let drive = 0;
    for (const tier of params.driveTiers) {
        if (details.driveAtr > tier.atr) { drive = tier.score; break; }
    }
    // 4. VWAP
    let vwap = 0;
    if (details.vwapControlRatio === 1) {
        vwap = params.vwapFullScore;
    } else if (details.vwapControlRatio >= params.vwapPartialRatio) {
        vwap = params.vwapPartialScore;
    }
    // 5. Range
    // 注意:details.rangeValue 是绝对值(high-low),需要除以 prevAtr 才是 atr ratio。
    // 但 details 里没有 prevAtr,只有 rangeValue。为保证 rescore 准确,Task 7 的 gridSearch
    // 会用 rangeValue 除以另一个派生量,或者在 Task 5 给 details 补 `rangeAtrRatio` 字段。
    // 这里约定:scoreTrendDay 已在 rangeTiers 中按 atr ratio 比较,所以 details 需要包含 rangeAtrRatio。
    // Task 5 会在 TrendScoreDetails 里补 `rangeAtrRatio` 并更新 runner trade 的 details 写入。
    let range = 0;
    const rangeAtrRatio = details.rangeAtrRatio ?? 0;
    for (const tier of params.rangeTiers) {
        if (rangeAtrRatio > tier.atr) { range = tier.score; break; }
    }
    // 6. ATR%
    let atrPctScore = 0;
    for (const tier of params.atrPctTiers) {
        if (details.atrPct > tier.pct) { atrPctScore = tier.score; break; }
    }
    // 7. Opening Shape —— 用 details 里已算好的 tier
    // details.openingShapeTier: 'long-shadow' | 'full-body' | 'long-kline' | 'none'
    // Shape tier 判定依赖 bodyRatio / bodyAtr / shadowRatio 阈值,改这些阈值会改 tier。
    // Task 6 的 rescore 只支持"改 maxScore",不支持"改 shape 子阈值"(避免复现整个 scoreCandleShape)。
    const openingShape = details.openingShapeTier !== 'none' ? params.openingShapeMaxScore : 0;
    // 8. Prior Day Shape
    const priorDayShape = details.priorDayShapeTier !== 'none' ? params.priorDayShapeMaxScore : 0;
    // 9. Today Range%
    let todayRangePct = 0;
    for (const tier of params.todayRangePctTiers) {
        if ((details.todayRangePctValue ?? 0) > tier.pct) { todayRangePct = tier.score; break; }
    }
    // 10. Prior Day Range%
    let priorDayRangePct = 0;
    for (const tier of params.priorDayRangePctTiers) {
        if ((details.priorDayRangePctValue ?? 0) > tier.pct) { priorDayRangePct = tier.score; break; }
    }
    // 11. Prev Range% Avg
    let prevRangePctAvg7 = 0;
    for (const tier of params.prevRangePctAvgTiers) {
        if ((details.prevRangePctAvg7Value ?? 0) > tier.pct) { prevRangePctAvg7 = tier.score; break; }
    }

    return {
        total: gap + rvol + drive + vwap + range + atrPctScore +
               openingShape + priorDayShape +
               todayRangePct + priorDayRangePct + prevRangePctAvg7,
        gap, rvol, drive, vwap, range, atrPct: atrPctScore,
        openingShape, priorDayShape,
        todayRangePct, priorDayRangePct, prevRangePctAvg7,
    };
}
```

- [ ] **Step 4: 编译**

Run: `cd /Users/bytedance/workspace/vwap_daytrade && npx tsc --noEmit`

Expected: 报错 `Property 'rangeAtrRatio' does not exist on type 'TrendScoreDetails'` —— 这是预期的，Task 5 补该字段。

- [ ] **Step 5: 暂不编译通过，进入 Task 5 前先做 Task 3/4 其他无依赖变更**

跳到 Task 3。Task 5 会把 rangeAtrRatio 补齐，使编译通过。

---

## Task 3：给 `runner.ts` 加 recordonly 输出 rangeAtrRatio 的准备

**Files:**
- Modify: `src/core/trendDetector.ts`（仅 `TrendScoreDetails` 类型和 `scoreTrendDay` 中 details 构造）

**目的：** 让 `details` 带上 `rangeAtrRatio`，Task 2 的 `rescoreFromDetails` 才能正确重打分 Range 指标。同时保证向后兼容（旧 json 没此字段时 fallback）。

- [ ] **Step 1: 在 `TrendScoreDetails` 接口加 `rangeAtrRatio` 可选字段**

找到 `src/core/trendDetector.ts:194-215` 的 `TrendScoreDetails` 接口。在 `rangeValue: number;` 这一行之后加：

```ts
    /** (v5 新增) rangeValue / prevAtr,用于离线 rescore 时复用 rangeTiers.atr 阈值 */
    rangeAtrRatio: number;
```

- [ ] **Step 2: 在 `scoreTrendDay` 的 return details 里写入 `rangeAtrRatio`**

找到 `src/core/trendDetector.ts:452-467` 的 `details: { ... }` 对象字面量。在 `rangeValue,` 这一行之后加：

```ts
            rangeAtrRatio,
```

（`rangeAtrRatio` 变量已在 L338 算好：`const rangeAtrRatio = baseline.prevAtr > 0 ? rangeValue / baseline.prevAtr : 0;`）

- [ ] **Step 3: 修同文件 `BacktestTrade` 类型的 `details` 定义（如果存在跨文件引用则跳过本步）**

Read `src/backtest/types.ts:58-75`。在 `rangeValue: number;` 之后加：

```ts
            rangeAtrRatio?: number; // v5 新增,旧 json 不存在
```

- [ ] **Step 4: 编译**

Run: `cd /Users/bytedance/workspace/vwap_daytrade && npx tsc --noEmit`

Expected: 通过（Task 2 的 `rangeAtrRatio` 引用现在有类型了，前提是用 `?? 0` fallback，已写入 Step 3 代码块）。

- [ ] **Step 5: 跑 smoke 验证默认行为不变**

Run:
```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/smokeTrendDetector.ts
```

Expected: 现有 8 cases 全 PASS（Task 2、3 没动任何分数）。最后 `✅ trendDetector smoke all pass`。

- [ ] **Step 6: 提交**

```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
git add src/core/trendDetector.ts src/backtest/types.ts
git commit -m "$(cat <<'EOF'
refactor(trend): add rescoreFromDetails + rangeAtrRatio for offline regrading

- Extract TrendScoreParams + DEFAULT_TREND_SCORE_PARAMS so
  offline rescore shares the same shape with production.
- Add rescoreFromDetails() that replays scoring from
  TrendScoreDetails + params (no bar window or baseline needed).
- Extend TrendScoreDetails with rangeAtrRatio (= rangeValue / prevAtr)
  so rescore can reuse rangeTiers.atr thresholds without recomputing.
- No behavior change: scoreTrendDay output unchanged for existing inputs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4：重跑 seed 让新 `rangeAtrRatio` 字段落进 trade 数据

**Files:** 无代码改动，纯运行。

**目的：** Task 1 的 seed json 不含新字段 `rangeAtrRatio`，Task 2 的 rescore 会用 `?? 0` fallback，导致 Range 指标重打分为 0，污染网格搜。必须重跑 seed。

- [ ] **Step 1: 重跑种子**

Run:
```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts \
  trend_recordonly_v5_seed trailing 0 0.1 \
  --filter-trend=off
```

Expected: 覆盖上次的 json。

- [ ] **Step 2: 确认新字段落盘**

Run:
```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only -e "
const j = JSON.parse(require('fs').readFileSync('data/backtest/results/trend_recordonly_v5_seed.json','utf8'));
const t = j.trades.find(t => t.entryDayScoreDetail);
console.log('has rangeAtrRatio:', typeof t.entryDayScoreDetail.details.rangeAtrRatio);
console.log('value:', t.entryDayScoreDetail.details.rangeAtrRatio);
"
```

Expected: `has rangeAtrRatio: number`，value 是个正浮点数。

- [ ] **Step 3: 跑 v4c 对照实跑（拿到硬约束锚点）**

Run:
```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts \
  v4c_tuned_anchor trailing 0 0.1 \
  --filter-trend=on --trend-threshold=70
```

Expected: 约 3 分钟跑完，产出 `v4c_tuned_anchor.json`，trades ≈ 16209、cumR ≈ 1232.5、maxDD ≈ 76.3。**记下 cumR 实际值 × 0.95 作为硬约束 `CUM_R_MIN`**（预期 1170.9 ± 小幅波动）。

- [ ] **Step 4: 不提交**

---

## Task 5：新建 `rescoreTrend.ts` 离线重打分 CLI

**Files:**
- Create: `src/backtest/rescoreTrend.ts`

**目的：** CLI 工具。读 seed json + 一组参数（可选 JSON 配置文件，默认用 `DEFAULT_TREND_SCORE_PARAMS`），输出 summary（trades/winRate/avgR/cumR/maxDD/ratio）。是 Task 6 smoke 和 Task 7 网格搜的引擎。

- [ ] **Step 1: 创建 `src/backtest/rescoreTrend.ts`**

```ts
/**
 * 离线重打分 CLI。
 *
 * 读 data/backtest/results/<seed>.json(recordonly,带完整 entryDayScoreDetail.details),
 * 套一组 TrendScoreParams 重算每笔 trade 的总分,过滤 < threshold 的 trade,算 summary。
 *
 * 跑法:
 *   # 默认参数(等于 v4c-tuned)
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/rescoreTrend.ts trend_recordonly_v5_seed
 *
 *   # 指定参数 JSON(字段和 TrendScoreParams 一一对应)
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/rescoreTrend.ts trend_recordonly_v5_seed ./tmp/params.json
 */
import * as fs from 'fs';
import * as path from 'path';
import { BacktestResult, BacktestTrade } from './types';
import {
    rescoreFromDetails,
    TrendScoreParams,
    DEFAULT_TREND_SCORE_PARAMS,
} from '../core/trendDetector';

export interface RescoreSummary {
    label: string;
    threshold: number;
    totalCandidates: number; // seed 里总 trade 数
    passed: number;          // 分数 >= threshold 的 trade 数
    nullScore: number;       // detail 缺失(预热期)的 trade 数 -> 放行
    winRate: number;
    avgR: number;
    cumR: number;
    maxDD: number;
    ratio: number;           // cumR / maxDD
}

export function rescoreTrades(
    trades: BacktestTrade[],
    params: TrendScoreParams
): RescoreSummary {
    let passCount = 0;
    let nullCount = 0;
    let sumR = 0;
    let wins = 0;
    const passed: BacktestTrade[] = [];

    for (const t of trades) {
        const det = t.entryDayScoreDetail?.details;
        if (!det) {
            // 预热期 / 无基线 -> 生产行为是"放行",rescore 也放行
            nullCount++;
            passed.push(t);
            sumR += t.rMultiple;
            if (t.rMultiple > 0) wins++;
            continue;
        }
        const score = rescoreFromDetails(det as any, params);
        if (score.total >= params.scoreThreshold) {
            passCount++;
            passed.push(t);
            sumR += t.rMultiple;
            if (t.rMultiple > 0) wins++;
        }
    }

    const n = passed.length;
    const sorted = [...passed].sort((a, b) => a.entryTimestamp - b.entryTimestamp);
    let peak = 0, acc = 0, maxDD = 0;
    for (const t of sorted) {
        acc += t.rMultiple;
        if (acc > peak) peak = acc;
        const dd = peak - acc;
        if (dd > maxDD) maxDD = dd;
    }

    return {
        label: '',
        threshold: params.scoreThreshold,
        totalCandidates: trades.length,
        passed: passCount,
        nullScore: nullCount,
        winRate: n > 0 ? wins / n : 0,
        avgR: n > 0 ? sumR / n : 0,
        cumR: sumR,
        maxDD,
        ratio: maxDD > 0 ? sumR / maxDD : 0,
    };
}

function main() {
    const seedLabel = process.argv[2];
    const paramsPath = process.argv[3];
    if (!seedLabel) {
        console.error('Usage: rescoreTrend.ts <seed-label> [params.json]');
        process.exit(1);
    }
    const seedPath = path.resolve(process.cwd(), `data/backtest/results/${seedLabel}.json`);
    const raw: BacktestResult = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    let params: TrendScoreParams = DEFAULT_TREND_SCORE_PARAMS;
    if (paramsPath) {
        params = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), paramsPath), 'utf8'));
    }
    const summary = rescoreTrades(raw.trades, params);
    summary.label = seedLabel + (paramsPath ? `+${path.basename(paramsPath)}` : '');

    console.log(`=== Rescore: ${summary.label} ===`);
    console.log(`  threshold      : ${summary.threshold}`);
    console.log(`  total          : ${summary.totalCandidates}`);
    console.log(`  passed         : ${summary.passed} (+${summary.nullScore} null-score passthrough)`);
    console.log(`  winRate        : ${(summary.winRate * 100).toFixed(2)}%`);
    console.log(`  avgR           : ${summary.avgR.toFixed(4)}`);
    console.log(`  cumR           : ${summary.cumR.toFixed(2)}`);
    console.log(`  maxDD          : ${summary.maxDD.toFixed(2)}`);
    console.log(`  ratio          : ${summary.ratio.toFixed(2)}`);
}

// 只在直接执行时跑 main,被 import 时不跑
if (require.main === module) {
    main();
}
```

- [ ] **Step 2: 编译**

Run: `cd /Users/bytedance/workspace/vwap_daytrade && npx tsc --noEmit`

Expected: 通过。

- [ ] **Step 3: 跑默认参数 rescore**

Run:
```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/rescoreTrend.ts trend_recordonly_v5_seed
```

Expected: 1-2 秒输出 summary。**关键验证**：输出的 `cumR / maxDD / ratio` 与 Task 4 Step 3 的 `v4c_tuned_anchor.json` 实跑结果偏差 < 2%（允许浮点/边界细微差异）。如果偏差超过 5%，说明 rescore 打分逻辑和实际 runner 门控逻辑不一致，返回 Task 2 查 bug。

- [ ] **Step 4: 对比 rescore 和实跑**

Run:
```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only -e "
const fs = require('fs');
function stats(p) {
  const j = JSON.parse(fs.readFileSync(p,'utf8'));
  const t = j.trades;
  const wins = t.filter(x=>x.rMultiple>0).length;
  const sumR = t.reduce((s,x)=>s+x.rMultiple,0);
  let peak=0, dd=0, cum=0;
  const sorted = [...t].sort((a,b)=>a.entryTimestamp-b.entryTimestamp);
  for(const x of sorted){ cum+=x.rMultiple; if(cum>peak)peak=cum; if(peak-cum>dd)dd=peak-cum; }
  return { trades: t.length, winRate: wins/t.length, cumR: sumR, maxDD: dd, ratio: dd>0?sumR/dd:0 };
}
console.log('anchor (run):', stats('data/backtest/results/v4c_tuned_anchor.json'));
"
```

记下 anchor 数值，Step 3 的 rescore 输出应与此数值近似（rescore 的 `passed + nullScore` 应接近 anchor 的 `trades`；`cumR` / `ratio` 应接近）。

- [ ] **Step 5: 提交**

```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
git add src/backtest/rescoreTrend.ts
git commit -m "$(cat <<'EOF'
feat(backtest): add rescoreTrend.ts offline trend score regrader

- Reads recordonly seed json and replays scoring with arbitrary
  TrendScoreParams so grid search can explore thresholds/weights
  without rerunning backtests (~1s per combination vs ~3min).
- Emits summary: threshold / passed / winRate / cumR / maxDD / ratio.
- Pure offline: uses BacktestTrade.entryDayScoreDetail.details raw values.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6：给 rescore 写 smoke（离线 / 实跑对齐验证）

**Files:**
- Create: `src/backtest/smokeRescoreTrend.ts`

**目的：** 保证 `rescoreFromDetails` 的结果和实际 `scoreTrendDay` 完全一致。如果某一笔 trade 的 rescore 总分 ≠ 它自带的 `entryDayScoreDetail.total`，说明离线打分和生产有口径差，网格搜的结果不可信。

- [ ] **Step 1: 创建 `src/backtest/smokeRescoreTrend.ts`**

```ts
/**
 * rescoreFromDetails 的 smoke 验证。
 *
 * 跑法:
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/smokeRescoreTrend.ts
 *
 * Case A: 对 seed json 里的每条 trade,rescore(默认参数) 的分项分必须等于该 trade 自带的分项。
 * Case B: 把 gapTiers 的阈值从 0.02 改到 0.05,原本命中的 gap trade 应该重打成 0 分。
 */
import * as fs from 'fs';
import * as path from 'path';
import { BacktestResult } from './types';
import {
    rescoreFromDetails,
    DEFAULT_TREND_SCORE_PARAMS,
    TrendScoreParams,
} from '../core/trendDetector';
import { rescoreTrades } from './rescoreTrend';

function assert(cond: boolean, msg: string) {
    if (!cond) throw new Error('ASSERT FAIL: ' + msg);
}

const SEED_PATH = path.resolve(
    process.cwd(),
    'data/backtest/results/trend_recordonly_v5_seed.json'
);

function loadSeed(): BacktestResult {
    return JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
}

// ============================================================
// Case A: 默认参数 rescore 每条 trade 的分项 === trade 自带分项
// ============================================================
(function caseDefaultMatchesProduction() {
    console.log('Running case A: default rescore == production scoring');
    const seed = loadSeed();
    let checked = 0;
    let mismatches = 0;
    for (const t of seed.trades) {
        const d = t.entryDayScoreDetail;
        if (!d || !d.details) continue;
        if (typeof (d.details as any).rangeAtrRatio !== 'number') {
            // seed 必须是 Task 4 重跑过的版本
            throw new Error('Seed missing rangeAtrRatio - rerun Task 4 to regenerate seed');
        }
        const rescored = rescoreFromDetails(d.details as any, DEFAULT_TREND_SCORE_PARAMS);
        // 验证分项逐一匹配
        const expected = {
            gap: d.gap, rvol: d.rvol, drive: d.drive, vwap: d.vwap, range: d.range,
            atrPct: d.atrPct ?? 0,
            openingShape: d.openingShape ?? 0,
            priorDayShape: d.priorDayShape ?? 0,
            todayRangePct: d.todayRangePct ?? 0,
            priorDayRangePct: d.priorDayRangePct ?? 0,
            prevRangePctAvg7: d.prevRangePctAvg7 ?? 0,
        };
        const fields: Array<keyof typeof expected> = [
            'gap','rvol','drive','vwap','range','atrPct',
            'openingShape','priorDayShape',
            'todayRangePct','priorDayRangePct','prevRangePctAvg7',
        ];
        for (const k of fields) {
            if (rescored[k] !== expected[k]) {
                mismatches++;
                if (mismatches <= 3) {
                    console.error(`  MISMATCH trade#${checked} field=${k} expected=${expected[k]} got=${rescored[k]}`);
                    console.error(`    details: ${JSON.stringify(d.details)}`);
                }
            }
        }
        checked++;
    }
    console.log(`  checked ${checked} trades, mismatches=${mismatches}`);
    assert(mismatches === 0, `caseA: ${mismatches} mismatches found, see logs above`);
    console.log('  case A PASS');
})();

// ============================================================
// Case B: 改 gapTiers 阈值,命中率变化符合预期
// ============================================================
(function caseTighterGap() {
    console.log('Running case B: tighter gap threshold reduces pass count');
    const seed = loadSeed();
    const base = rescoreTrades(seed.trades, DEFAULT_TREND_SCORE_PARAMS);

    // 把 gap 阈值从 0.02 改到 0.05(更严)
    const tighter: TrendScoreParams = {
        ...DEFAULT_TREND_SCORE_PARAMS,
        gapTiers: [{ pct: 0.05, score: 25 }],
    };
    const tight = rescoreTrades(seed.trades, tighter);

    console.log(`  base passed=${base.passed}, cumR=${base.cumR.toFixed(1)}`);
    console.log(`  tight passed=${tight.passed}, cumR=${tight.cumR.toFixed(1)}`);

    // 更严的 gap 必然减少通过数(因为有些 trade 原本靠 gap 25 分凑过门槛)
    // 但不是所有 trade 都依赖 gap,所以只要 tight.passed < base.passed 即可
    assert(tight.passed < base.passed, `caseB: tighter gap should reduce passed count (base=${base.passed} tight=${tight.passed})`);
    console.log('  case B PASS');
})();

console.log('\n✅ rescoreTrend smoke all pass');
```

- [ ] **Step 2: 跑 smoke**

Run:
```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/smokeRescoreTrend.ts
```

Expected: `case A PASS` + `case B PASS` + `✅ rescoreTrend smoke all pass`。

**如果 Case A 失败**：说明 rescore 口径和生产不一致。常见 bug：
1. VWAP 判断（Task 2 的 `=== 1` 应该用 `longRatio === 1 || shortRatio === 1`，details 里是 `vwapControlRatio = max(longRatio, shortRatio)`，所以 `=== 1` 等价 —— 正确）
2. rangeAtrRatio fallback 为 0（seed 必须是 Task 4 重跑的）
3. Shape tier 判定位置不同（生产用 `scoreCandleShape` 的 tier 字段，rescore 用 details.openingShapeTier —— 应该一致，如果不一致看 `scoreCandleShape` 是否被改过）

按 console 报错的 field 和 details 逆推修。

- [ ] **Step 3: 提交**

```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
git add src/backtest/smokeRescoreTrend.ts
git commit -m "$(cat <<'EOF'
test(backtest): smoke that rescoreFromDetails matches production scoring

- Case A: rescore(default params) on every trade in seed reproduces
  the trade's own entryDayScoreDetail breakdown exactly.
- Case B: tightening gapTiers threshold reduces pass count as expected.

Gatekeeper for the v5 grid search — if this breaks, offline regrading
cannot be trusted.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7：新建 `gridSearchTrend.ts` 三阶段 greedy 搜索

**Files:**
- Create: `src/backtest/gridSearchTrend.ts`

**目的：** 自动化搜索。阶段 A 扫阈值（单参数每次只动一个），阶段 B 重分配权重，阶段 C 扫门槛。硬约束 `cumR ≥ CUM_R_MIN`（从 CLI 传入）过滤，输出 top-10 按 ratio 降序。

**输入：** seed label + CUM_R_MIN
**输出：** 控制台 top-10 表 + `data/backtest/grid_search_v5.json`（含所有通过硬约束的组合）

- [ ] **Step 1: 创建 `src/backtest/gridSearchTrend.ts`**

```ts
/**
 * v5 权重/阈值网格搜索(三阶段 greedy)。
 *
 * 跑法:
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/gridSearchTrend.ts \
 *     trend_recordonly_v5_seed 1170.9
 *
 * 流程:
 *   A. 阈值扫(从 DEFAULT_TREND_SCORE_PARAMS 出发,每个指标独立扫 3 个候选,选 ratio 最高且 cumR >= CUM_R_MIN 的)
 *      -> 得到 bestThresholds
 *   B. 权重扫(阈值固定在 bestThresholds,按 ΔavgR 重分配权重 —— 实现为尝试 3 种权重方案)
 *      -> 得到 bestWeights
 *   C. 门槛扫(阈值 + 权重固定,扫 thresholds 7 个点)
 *      -> 得到 bestScoreThreshold
 *
 * 输出 top-10 按 ratio 降序 + baseline 参考行,便于人工挑选最终候选给 runner 实跑。
 */
import * as fs from 'fs';
import * as path from 'path';
import { BacktestResult } from './types';
import {
    DEFAULT_TREND_SCORE_PARAMS,
    TrendScoreParams,
} from '../core/trendDetector';
import { rescoreTrades, RescoreSummary } from './rescoreTrend';

interface Candidate {
    name: string;
    params: TrendScoreParams;
    summary: RescoreSummary;
}

function clone(p: TrendScoreParams): TrendScoreParams {
    return JSON.parse(JSON.stringify(p));
}

// ============================================================
// 阶段 A: 阈值扫(每次只动一个指标的阈值,greedy)
// ============================================================

// 每个指标的候选阈值表(在当前阈值基础上 +/- 一档,外加一个"更严/更宽"极端值)
// 格式: (params, candidateValue) => 新 params
type ThresholdCandidate = {
    indicator: string;
    apply: (p: TrendScoreParams) => TrendScoreParams;
};

function thresholdCandidates(): ThresholdCandidate[] {
    const out: ThresholdCandidate[] = [];

    // Gap: 0.015 / 0.025 / 0.03
    for (const pct of [0.015, 0.025, 0.03]) {
        out.push({
            indicator: `gap@${pct}`,
            apply: (p) => ({ ...clone(p), gapTiers: [{ pct, score: 25 }] }),
        });
    }
    // RVOL 高档: v=1.8 / 2.2 / 2.5
    for (const v of [1.8, 2.2, 2.5]) {
        out.push({
            indicator: `rvolHi@${v}`,
            apply: (p) => ({
                ...clone(p),
                rvolTiers: [{ v, score: 40 }, { v: 1.5, score: 20 }],
            }),
        });
    }
    // RVOL 低档: v=1.3 / 1.7
    for (const v of [1.3, 1.7]) {
        out.push({
            indicator: `rvolLo@${v}`,
            apply: (p) => ({
                ...clone(p),
                rvolTiers: [{ v: 2, score: 40 }, { v, score: 20 }],
            }),
        });
    }
    // Range 高档: atr=0.8 / 1.2
    for (const atr of [0.8, 1.2]) {
        out.push({
            indicator: `rangeHi@${atr}`,
            apply: (p) => ({
                ...clone(p),
                rangeTiers: [{ atr, score: 30 }, { atr: 0.5, score: 15 }],
            }),
        });
    }
    // Range 低档: atr=0.4 / 0.6
    for (const atr of [0.4, 0.6]) {
        out.push({
            indicator: `rangeLo@${atr}`,
            apply: (p) => ({
                ...clone(p),
                rangeTiers: [{ atr: 1.0, score: 30 }, { atr, score: 15 }],
            }),
        });
    }
    // ATR%: 0.02 / 0.03
    for (const pct of [0.02, 0.03]) {
        out.push({
            indicator: `atrPct@${pct}`,
            apply: (p) => ({ ...clone(p), atrPctTiers: [{ pct, score: 15 }] }),
        });
    }
    // Today Range%: 0.008 / 0.012 / 0.015
    for (const pct of [0.008, 0.012, 0.015]) {
        out.push({
            indicator: `todayRP@${pct}`,
            apply: (p) => ({ ...clone(p), todayRangePctTiers: [{ pct, score: 10 }] }),
        });
    }
    // Prior Day Range%: 0.02 / 0.03
    for (const pct of [0.02, 0.03]) {
        out.push({
            indicator: `priorRP@${pct}`,
            apply: (p) => ({ ...clone(p), priorDayRangePctTiers: [{ pct, score: 10 }] }),
        });
    }
    // Prev Range% Avg: 0.02 / 0.03
    for (const pct of [0.02, 0.03]) {
        out.push({
            indicator: `avgRP@${pct}`,
            apply: (p) => ({ ...clone(p), prevRangePctAvgTiers: [{ pct, score: 10 }] }),
        });
    }

    return out;
}

function phaseAThresholdSweep(
    seed: BacktestResult,
    cumRMin: number
): { params: TrendScoreParams; candidates: Candidate[] } {
    let best = clone(DEFAULT_TREND_SCORE_PARAMS);
    const baseSum = rescoreTrades(seed.trades, best);
    let bestRatio = baseSum.ratio;
    const candidates: Candidate[] = [
        { name: 'baseline (default)', params: clone(best), summary: baseSum },
    ];

    // 每轮扫所有候选,选最好的且满足硬约束的,固化进 best
    // 最多 3 轮(避免死循环),每轮若无改进则提前停
    for (let round = 1; round <= 3; round++) {
        let roundBest: Candidate | null = null;
        for (const c of thresholdCandidates()) {
            const p = c.apply(best);
            const s = rescoreTrades(seed.trades, p);
            candidates.push({ name: `A.r${round}.${c.indicator}`, params: p, summary: s });
            if (s.cumR < cumRMin) continue;
            if (s.ratio > (roundBest?.summary.ratio ?? bestRatio)) {
                roundBest = { name: c.indicator, params: p, summary: s };
            }
        }
        if (!roundBest || roundBest.summary.ratio <= bestRatio) {
            console.log(`[phaseA] round ${round}: no improvement, stop`);
            break;
        }
        console.log(`[phaseA] round ${round}: picked ${roundBest.name} ratio=${roundBest.summary.ratio.toFixed(2)} (was ${bestRatio.toFixed(2)})`);
        best = roundBest.params;
        bestRatio = roundBest.summary.ratio;
    }
    return { params: best, candidates };
}

// ============================================================
// 阶段 B: 权重重分配(3 个预设方案 + 当前权重)
// ============================================================

function phaseBWeightSweep(
    seed: BacktestResult,
    base: TrendScoreParams,
    cumRMin: number
): { params: TrendScoreParams; candidates: Candidate[] } {
    const candidates: Candidate[] = [];

    // 方案 0: 当前权重(base,已带阶段 A 阈值)
    const s0 = rescoreTrades(seed.trades, base);
    candidates.push({ name: 'B.keep', params: clone(base), summary: s0 });

    // 方案 α: 把 Range/RVOL 加重 5 分,Gap/VWAP 减 5 分(试"强动量倾向")
    const alpha = clone(base);
    alpha.rvolTiers = [{ v: alpha.rvolTiers[0].v, score: 45 }, { v: alpha.rvolTiers[1].v, score: 22 }];
    alpha.rangeTiers = [{ atr: alpha.rangeTiers[0].atr, score: 35 }, { atr: alpha.rangeTiers[1].atr, score: 17 }];
    alpha.gapTiers = [{ pct: alpha.gapTiers[0].pct, score: 20 }];
    alpha.vwapFullScore = 3;
    alpha.vwapPartialScore = 3;
    const sA = rescoreTrades(seed.trades, alpha);
    candidates.push({ name: 'B.alpha (rvol/range +, gap/vwap -)', params: alpha, summary: sA });

    // 方案 β: Day-range% 加重(日内波动信号),Shape 减重
    const beta = clone(base);
    beta.todayRangePctTiers = [{ pct: beta.todayRangePctTiers[0].pct, score: 15 }];
    beta.priorDayRangePctTiers = [{ pct: beta.priorDayRangePctTiers[0].pct, score: 15 }];
    beta.prevRangePctAvgTiers = [{ pct: beta.prevRangePctAvgTiers[0].pct, score: 15 }];
    beta.openingShapeMaxScore = 5;
    beta.openingShapeThresholds = { ...beta.openingShapeThresholds, maxScore: 5 };
    const sB = rescoreTrades(seed.trades, beta);
    candidates.push({ name: 'B.beta (rangePct +, shape -)', params: beta, summary: sB });

    // 方案 γ: 禁用 openingShape,把 15 分匀给 RVOL
    const gamma = clone(base);
    gamma.openingShapeMaxScore = 0;
    gamma.openingShapeThresholds = { ...gamma.openingShapeThresholds, maxScore: 0 };
    gamma.rvolTiers = [{ v: gamma.rvolTiers[0].v, score: 50 }, { v: gamma.rvolTiers[1].v, score: 25 }];
    const sG = rescoreTrades(seed.trades, gamma);
    candidates.push({ name: 'B.gamma (shape off, rvol ++)', params: gamma, summary: sG });

    // 选满足硬约束且 ratio 最高的
    const filtered = candidates.filter(c => c.summary.cumR >= cumRMin);
    if (filtered.length === 0) {
        console.log('[phaseB] no weight scheme passes hard constraint, keep base weights');
        return { params: base, candidates };
    }
    const bestW = filtered.reduce((a, b) => b.summary.ratio > a.summary.ratio ? b : a);
    console.log(`[phaseB] picked ${bestW.name} ratio=${bestW.summary.ratio.toFixed(2)}`);
    return { params: bestW.params, candidates };
}

// ============================================================
// 阶段 C: 门槛扫(阈值 + 权重固定,扫 7 个点)
// ============================================================

function phaseCThresholdSweep(
    seed: BacktestResult,
    base: TrendScoreParams,
    cumRMin: number
): { params: TrendScoreParams; candidates: Candidate[] } {
    // 计算当前 base 的总分上限(11 个指标各自 max)
    const maxTotal =
        base.gapTiers[0]?.score ?? 0 +
        (base.rvolTiers[0]?.score ?? 0) +
        (base.driveTiers[0]?.score ?? 0) +
        base.vwapFullScore +
        (base.rangeTiers[0]?.score ?? 0) +
        (base.atrPctTiers[0]?.score ?? 0) +
        base.openingShapeMaxScore +
        base.priorDayShapeMaxScore +
        (base.todayRangePctTiers[0]?.score ?? 0) +
        (base.priorDayRangePctTiers[0]?.score ?? 0) +
        (base.prevRangePctAvgTiers[0]?.score ?? 0);

    // 扫 maxTotal 的 [35%, 65%] 范围内 7 个点
    const thresholds: number[] = [];
    for (let pct = 0.35; pct <= 0.65; pct += 0.05) {
        thresholds.push(Math.round(maxTotal * pct));
    }
    const candidates: Candidate[] = [];
    for (const th of thresholds) {
        const p = { ...clone(base), scoreThreshold: th };
        const s = rescoreTrades(seed.trades, p);
        candidates.push({ name: `C.thr=${th}`, params: p, summary: s });
    }
    const filtered = candidates.filter(c => c.summary.cumR >= cumRMin);
    if (filtered.length === 0) {
        console.log('[phaseC] no threshold passes hard constraint, keep base');
        return { params: base, candidates };
    }
    const bestT = filtered.reduce((a, b) => b.summary.ratio > a.summary.ratio ? b : a);
    console.log(`[phaseC] picked threshold=${bestT.params.scoreThreshold} ratio=${bestT.summary.ratio.toFixed(2)}`);
    return { params: bestT.params, candidates };
}

// ============================================================
// 主
// ============================================================

function main() {
    const seedLabel = process.argv[2];
    const cumRMinRaw = process.argv[3];
    if (!seedLabel || !cumRMinRaw) {
        console.error('Usage: gridSearchTrend.ts <seed-label> <cumR-min>');
        process.exit(1);
    }
    const cumRMin = Number(cumRMinRaw);
    const seedPath = path.resolve(
        process.cwd(),
        `data/backtest/results/${seedLabel}.json`
    );
    const seed: BacktestResult = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    console.log(`seed=${seedLabel} trades=${seed.trades.length} cumRMin=${cumRMin}`);

    const allCandidates: Candidate[] = [];

    console.log('\n=== Phase A: Threshold Sweep ===');
    const a = phaseAThresholdSweep(seed, cumRMin);
    allCandidates.push(...a.candidates);

    console.log('\n=== Phase B: Weight Redistribution ===');
    const b = phaseBWeightSweep(seed, a.params, cumRMin);
    allCandidates.push(...b.candidates);

    console.log('\n=== Phase C: Score Threshold Sweep ===');
    const c = phaseCThresholdSweep(seed, b.params, cumRMin);
    allCandidates.push(...c.candidates);

    // Top-10 按 ratio 降序,过滤硬约束
    const filtered = allCandidates.filter(c => c.summary.cumR >= cumRMin);
    filtered.sort((x, y) => y.summary.ratio - x.summary.ratio);
    const top = filtered.slice(0, 10);

    console.log('\n=== Top 10 (by ratio, cumR >= ' + cumRMin + ') ===');
    console.log('name'.padEnd(50), 'passed'.padStart(7), 'winR'.padStart(6), 'cumR'.padStart(8), 'maxDD'.padStart(7), 'ratio'.padStart(7));
    for (const t of top) {
        console.log(
            t.name.padEnd(50),
            String(t.summary.passed).padStart(7),
            (t.summary.winRate * 100).toFixed(1).padStart(5) + '%',
            t.summary.cumR.toFixed(1).padStart(8),
            t.summary.maxDD.toFixed(1).padStart(7),
            t.summary.ratio.toFixed(2).padStart(7),
        );
    }

    // 持久化完整结果
    const outPath = path.resolve(process.cwd(), 'data/backtest/grid_search_v5.json');
    fs.writeFileSync(outPath, JSON.stringify({
        seedLabel,
        cumRMin,
        bestParams: c.params,
        top,
        allCandidates: allCandidates.map(ac => ({ name: ac.name, summary: ac.summary })),
    }, null, 2));
    console.log(`\nFull results: ${path.relative(process.cwd(), outPath)}`);
    console.log('\nNext: pick top-N candidates, write their params to JSON, rerun runner.ts to confirm.');
}

if (require.main === module) {
    main();
}
```

- [ ] **Step 2: 编译**

Run: `cd /Users/bytedance/workspace/vwap_daytrade && npx tsc --noEmit`

Expected: 通过。

- [ ] **Step 3: 跑网格搜**

Run:
```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/gridSearchTrend.ts \
  trend_recordonly_v5_seed 1170.9
```

Expected: 30-60 秒跑完（约 50~80 组合 × 每组 1 秒）。输出：
- Phase A/B/C 各自的 picked 日志
- Top 10 表
- 写入 `data/backtest/grid_search_v5.json`

**判读：**
- 如果 Top 10 里最高 ratio > 16.15，记下前 3 名的 params（从 JSON 里 copy）作为 Task 8 实跑候选
- 如果 Top 10 最高 ratio <= 16.15（即三阶段 greedy 找不到比当前好的），说明样本/参数空间不足以带来提升，**跳过 Task 8 的代码改动**，只合并 Task 5-7 的工具代码，Task 9 的文档里记录"v5 网格搜未找到 ratio 提升，v4c-tuned 保留"

- [ ] **Step 4: 提交 gridSearchTrend.ts（结果 json 不提交）**

```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
git add src/backtest/gridSearchTrend.ts
git commit -m "$(cat <<'EOF'
feat(backtest): three-phase greedy grid search for trend v5 tuning

Phase A: per-indicator threshold sweep, greedy (one parameter at a time).
Phase B: 3 preset weight redistribution schemes (alpha/beta/gamma).
Phase C: score threshold sweep over [0.35, 0.65] of new max total.
All phases enforce hard constraint cumR >= CUM_R_MIN.

Outputs top-10 by ratio and persists full candidate list to
data/backtest/grid_search_v5.json for manual selection.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8：实跑候选 + 选定最优 + 写入代码

**Files:**
- Modify: `src/core/trendDetector.ts`（改 `*_TIERS`、`*_SCORE`、`TREND_SCORE_THRESHOLD` 为选定值）
- Modify: `src/backtest/smokeTrendDetector.ts`（更新 case 1/7/8 的期望值）

**目的：** 把 Task 7 的最优候选落到生产代码，且用 runner 实跑确认离线/实跑一致。

**仅在 Task 7 Step 3 的判读显示"ratio 提升 > baseline"才执行本 Task。**

- [ ] **Step 1: 从 `data/backtest/grid_search_v5.json` 取 top-3 的 params**

Run:
```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only -e "
const j = JSON.parse(require('fs').readFileSync('data/backtest/grid_search_v5.json','utf8'));
for (let i = 0; i < Math.min(3, j.top.length); i++) {
  const c = j.top[i];
  console.log('=== Top', i+1, c.name, 'ratio=', c.summary.ratio.toFixed(2), '===');
}
console.log('bestParams:', JSON.stringify(j.bestParams, null, 2));
"
```

记下 top-3 的 name 和 bestParams。

- [ ] **Step 2: 手动实跑 top-1（确认离线 ≈ 实跑）**

由于 runner 没有"从 JSON 读 params"的接口，对 top-1 直接在 `trendDetector.ts` 里改常量后跑 runner。先用一个临时分支或 git stash 隔离。

**暂时修改** `src/core/trendDetector.ts` 顶部的常量 L13-45，把 top-1 params 里的 `gapTiers/rvolTiers/rangeTiers/...` 值写进去。具体编辑命令根据 top-1 的实际内容，格式保持不变。

**同时修改** `TREND_SCORE_THRESHOLD = 70` 为 top-1 的 `scoreThreshold` 值。

**暂时修改** `src/backtest/smokeTrendDetector.ts` case 1 的 `assert(score!.total === 130, ...)` —— 用 top-1 params 里的各分项算新总分（例如 rvol 若改成 45/22 则 case 1 rvol 应该是 45 而不是 40，case 1 总分会变）。

**若 case 1 新总分不等于你算出来的值**：说明 smoke 构造的 window/baseline 对新阈值有不同响应（比如新 gap 阈值让 gap 归 0）。此时重调 smoke 输入或更新 assert 值，两种都可以。

- [ ] **Step 3: 编译 + smoke + runner 实跑**

```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
npx tsc --noEmit && \
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/smokeTrendDetector.ts && \
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts \
  v5_top1 trailing 0 0.1 --filter-trend=on
```

Expected: tsc 通过、smoke 全 PASS、runner 跑完产出 `v5_top1.json`。

- [ ] **Step 4: 对比 rescore 预测 vs runner 实跑**

Run:
```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only -e "
const fs = require('fs');
function stats(p) {
  const j = JSON.parse(fs.readFileSync(p,'utf8'));
  const t = j.trades;
  const wins = t.filter(x=>x.rMultiple>0).length;
  const sumR = t.reduce((s,x)=>s+x.rMultiple,0);
  const sorted = [...t].sort((a,b)=>a.entryTimestamp-b.entryTimestamp);
  let peak=0, dd=0, cum=0;
  for(const x of sorted){ cum+=x.rMultiple; if(cum>peak)peak=cum; if(peak-cum>dd)dd=peak-cum; }
  return { trades: t.length, winRate: wins/t.length, cumR: sumR, maxDD: dd, ratio: dd>0?sumR/dd:0 };
}
const gs = JSON.parse(fs.readFileSync('data/backtest/grid_search_v5.json','utf8'));
const predicted = gs.top[0].summary;
const actual = stats('data/backtest/results/v5_top1.json');
console.log('predicted:', predicted);
console.log('actual   :', actual);
console.log('cumR   drift:', ((actual.cumR - predicted.cumR) / predicted.cumR * 100).toFixed(2), '%');
console.log('ratio  drift:', ((actual.ratio - predicted.ratio) / predicted.ratio * 100).toFixed(2), '%');
"
```

Expected: `cumR drift` 和 `ratio drift` 绝对值 < 2%。若 > 5%，说明离线 rescore 有 bug，回 Task 6 的 smoke 看 Case A 是否漏了某个 case。

- [ ] **Step 5: 若 top-1 实跑不合格（cumR < CUM_R_MIN 或 ratio < 16.15），revert 代码改动并试 top-2**

```bash
# 若 top-1 失败
cd /Users/bytedance/workspace/vwap_daytrade && \
git checkout src/core/trendDetector.ts src/backtest/smokeTrendDetector.ts
# 然后按 Step 2 重试 top-2
```

若 top-3 都失败，fallback 到 baseline（不改代码），进入 Task 9 记录"v5 未采用"。

- [ ] **Step 6: 最终选定后提交**

```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
git add src/core/trendDetector.ts src/backtest/smokeTrendDetector.ts
git commit -m "$(cat <<'EOF'
feat(trend): apply v5 weights/thresholds from grid search

Grid-searched top candidate on 1y recordonly seed:
- <填写具体变化,如 "rvolTiers: 2→2.2 / 1.5→1.5 (score 40/20→45/22)">
- <"rangeTiers atr=0.5→0.6">
- <"TREND_SCORE_THRESHOLD: 70→X">
- cumR hard constraint >= 1170.9 satisfied
- Smoke case 1/7/8 assertions updated to match new scoring

Performance (1y): cumR=<X> maxDD=<Y> ratio=<Z>
vs v4c-tuned     : cumR=1232.5 maxDD=76.3 ratio=16.15

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9：更新文档

**Files:**
- Modify: `references/TREND.md`

- [ ] **Step 1: 更新 §1 (评价窗口) 和 §2 (每个指标的阈值/权重)**

如果 Task 8 改了阈值或权重，对应 §2 的 tier 表、总分小结（"总分上限 170"那行）都要更新。例如：

```markdown
## 指标二:Relative Volume(45 分,权重最高)

| RVOL | 分数 |
| ---- | ---- |
| > 2.2 | 45 |
| > 1.5 | 22 |
| else | 0 |
```

- [ ] **Step 2: 更新 §5 性能表**

在表末追加 v5 行：

```markdown
| 方案 | trades | winRate | avgR | cumR | maxDD | cumR÷maxDD |
|---|---|---|---|---|---|---|
| ... existing rows ... |
| **v5 权重调优(当前)** | <X> | <%> | <X> | <X> | <X> | <X> |
```

数字从 Task 8 Step 4 的 actual 对象读。

- [ ] **Step 3: 更新附录版本表**

```markdown
| v4c-tuned | 消融实验确认指标九/十/十一均净正向贡献;门槛 55 → 70 |
| **v5 (当前)** | 三阶段 greedy 网格搜索重分配权重/阈值;cumR 降幅 < 5% 约束下 ratio 从 16.15 → <X> |
```

- [ ] **Step 4: 如果 Task 8 fallback 到 baseline（未采用 v5）**

改 §5 不加新行，附录加一行：

```markdown
| v5 实验 | 网格搜未找到 ratio 提升超过 16.15 的配置,保留 v4c-tuned |
```

工具代码（rescoreTrend / gridSearchTrend / smokeRescoreTrend）仍然合并，作为后续调参的工具沉淀。

- [ ] **Step 5: 提交**

```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
git add references/TREND.md
git commit -m "$(cat <<'EOF'
docs(trend): record v5 tuning results in TREND.md

- Update §2 indicator tier tables for any threshold/weight changes
- Add v5 row to §5 performance table (1y 2025-04~2026-04)
- Append v5 entry to appendix version history

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10：最终验证

**Files:** 无代码改动。

- [ ] **Step 1: 全量 smoke**

```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/smokeTrendDetector.ts && \
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/smokeRescoreTrend.ts
```

Expected: 两个 smoke 都 PASS。

- [ ] **Step 2: tsc + build**

```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
npx tsc --noEmit && \
npm run build
```

Expected: 0 errors。

- [ ] **Step 3: 总结**

在对话里给出最终对比表：

```
                  trades   winRate   cumR    maxDD    ratio
v4c-tuned (锚点)   16209    38.9%    1232.5   76.3   16.15
v5 (当前)          <X>      <%>      <X>      <X>    <X>
硬约束下界          —        —        1170.9   —       —
```

加一段说明：
- 最终选中的 params 是什么（阈值/权重/门槛 vs v4c 的 diff）
- 实际 ratio 提升 / cumR 变化
- 网格搜跑了多少组合、哪个阶段贡献最大
- 后续建议（实盘是否需要同步调整 RVOL baseline 粗糙问题）

---

## 提交计划总结

| Task | 提交信息 |
|---|---|
| 3 | refactor(trend): add rescoreFromDetails + rangeAtrRatio for offline regrading |
| 5 | feat(backtest): add rescoreTrend.ts offline trend score regrader |
| 6 | test(backtest): smoke that rescoreFromDetails matches production scoring |
| 7 | feat(backtest): three-phase greedy grid search for trend v5 tuning |
| 8 | feat(trend): apply v5 weights/thresholds from grid search（若采用） |
| 9 | docs(trend): record v5 tuning results in TREND.md |

Task 1/2/4/10 无提交（纯跑回测 / Task 2 只编辑不单独提交，合并到 Task 3）。

---

## Self-Review 检查

**1. Spec 覆盖**
- 提高 ratio → Task 7 三阶段 greedy 搜索 ✓
- cumR 约束 -5% → Task 7 每阶段 `filter(s.cumR >= cumRMin)` ✓
- 一年样本 → Task 1 recordonly 种子 + Task 4 v4c anchor ✓
- 权重 + 阈值都改 → Task 7 阶段 A（阈值）+ 阶段 B（权重）+ 阶段 C（门槛）✓
- 落地到生产代码 → Task 8 ✓
- 文档 → Task 9 ✓

**2. 占位符扫描**
- 无 TBD/TODO/fill in details。
- Task 7 的候选阈值表是固定值（不是占位符）。Task 8 Step 2 的 "具体编辑命令根据 top-1 的实际内容" 是有意的 —— grid 出来的值无法预知，需要执行时根据实际选择编辑。

**3. 类型一致性**
- `TrendScoreParams` 在 Task 2 定义 / Task 5 消费 / Task 7 使用，字段签名一致。
- `RescoreSummary` 在 Task 5 定义 / Task 6 smoke 不直接用 / Task 7 `Candidate.summary` 引用，类型路径清晰。
- `rescoreFromDetails` 签名在 Task 2/5/6 一致。
- `rangeAtrRatio` 在 Task 3 加到 `TrendScoreDetails` 和 `BacktestTrade.details`，Task 2 的 rescore 用 `?? 0` 消费。

# 趋势日 Detector + 回测门控 v1 — 设计规格

**日期**:2026-04-14
**作者**:zeng.516 + Claude Opus
**Scope**:仅回测路径。实盘侧落地待回测结论确认后另起 spec。
**参考**:
- `references/TREND.MD` — 评分公式和指标定义原文
- `references/BACKTEST.md` — 回测系统现状、已知偏差、主要结论
- `src/backtest/runner.ts` / `src/strategy/vwapStrategy.ts` — 被改动的两个主文件

---

## 1. 目标

给现有回测系统加一个"趋势日评分"入场门控,验证假设:

> 突破策略在"当日趋势强"的票上期望收益更高;如果能在开盘 15 分钟结束时(09:45)用一组日内指标判断"今天是不是趋势日",并且只在趋势分数高于阈值的票上开仓,整体 cumR / maxDD / expectancy 会更好。

本 spec 只做:
- 纯函数 detector 模块(回测和未来实盘可共用)
- 回测 runner 的预计算、09:45 打分、信号门控、trade log 扩字段
- 三组实验 + 两张对比报告,足以回答"评分是否有区分度 + 总体是否带来 alpha 增益"

本 spec **不做**:
- 方向性评分
- 全局选股池(前 N 日轮换)
- 阈值参数化(先硬编码常量,留一个总开关)
- 实盘侧 hook
- walk-forward / 样本外切分

---

## 2. 评分公式(来自 TREND.md)

在 09:45 那一刻,对每支票算下面 5 个指标,合计总分 0–100,门槛 60。

### 指标一:Gap Filter (20分)

```
gapPct = |open - prevClose| / prevClose
```

| gapPct | 分 |
|---|---|
| > 2% | 20 |
| > 1% | 10 |
| else | 0 |

### 指标二:Relative Volume (30分) — 最重要

```
RVOL = 今日 09:30–09:45 成交量 / 过去 20 个交易日同窗口平均
```

| RVOL | 分 |
|---|---|
| > 3 | 30 |
| > 2 | 20 |
| > 1.5 | 10 |
| else | 0 |

### 指标三:Opening Drive (25分)

```
drive = |price_0945 - open| / prevAtr
```

其中 `price_0945` = 09:44 那根 bar 的 close(**最后一根"窗口内已收盘"的 bar**,index 14,若 09:30 为 index 0)。语义上这就是"09:45 那一刻拿到的最新价",和"09:45 触发的打分"时间点一致,不能用 index 15(09:45 那根 bar 还没收盘)。

| drive | 分 |
|---|---|
| > 0.8 ATR | 25 |
| > 0.5 ATR | 15 |
| > 0.3 ATR | 8 |
| else | 0 |

### 指标四:VWAP 控制力 (15分)

取 09:30–09:45 的 15 根 bar(1 分钟),计算每根的 VWAP(从 09:30 开始累积的当日 VWAP),统计每根 bar 的 close 站上/站下 VWAP 的比例:

- 若某方向占比 = 100%(15/15):15 分
- 若某方向占比 ≥ 80%(12/15 或更多):8 分
- 否则:0 分

**注意**:这是方向无关的"控制力强度",不区分多头/空头。方案锁定 A(方向无关门控),方向本身不进入打分。

### 指标五:Range Expansion (10分)

```
range = max(high_0930..0945) - min(low_0930..0945)
```

| 条件 | 分 |
|---|---|
| range > prevAtr × 0.6 | 10 |
| else | 0 |

### 门槛

```
score ≥ 60 → 允许该票当日开仓
score < 60 → 该票当日禁开仓
```

### 指标不可用的处理

- **前 20 个交易日预热期**:RVOL 基线不足,`scoreTrendDay` 返回 `null`,回测侧把"分数 null"视为"**放行**"(不门控),避免丢掉样本头部的对照数据
- **09:30–09:45 之间**:分数还没算出来,`dayScoreMap[symbol] === undefined`,视为"**禁止开仓**"(当 `enableTrendDetector=true` 时);detector 关闭时现有行为不变
- **prevAtr / prevClose 缺失**(样本第 1 天):`scoreTrendDay` 返回 `null`,按上面"放行"处理

---

## 3. 模块设计

### 3.1 新增:`src/core/trendDetector.ts`

放在 `src/core/` 下是为了未来实盘 `vwapStrategy` 能直接 import,不和 `src/backtest/` 耦合。

纯函数,无 I/O。两个导出:

```ts
// 某支票某一天用的历史基准(前 20 天的 09:30–09:45 成交量均值 + 前一日 ATR/close)
export interface TrendBaseline {
    prevClose: number;
    prevAtr: number;
    rvolBaseline: number; // 前 20 天同窗口成交量均值
}

export interface TrendScore {
    total: number;        // 0–100
    gap: number;
    rvol: number;
    drive: number;
    vwap: number;
    range: number;
    details: {
        gapPct: number;
        rvolValue: number;
        driveAtr: number;
        vwapControlRatio: number;
        vwapControlSide: 'long' | 'short' | 'none';
        rangeValue: number;
    };
}

// 给定一支票的全部 bar 和目标 dayKey,算出该日使用的基准
// 读"前 1 日"的 close/ATR 和"前 20 日同窗口"的成交量均值
// 若历史不足,返回 null
export function calcTrendBaseline(
    bars: SerializedBar[],
    dayKey: string
): TrendBaseline | null;

// 给定 09:30–09:45 的 15 根 bar + baseline,返回评分
// bars 必须严格包含这 15 根(不多不少),按时间正序
// 若 bars.length !== 15 或 baseline 为 null 返回 null
export function scoreTrendDay(
    firstFifteenMinutes: SerializedBar[],
    baseline: TrendBaseline
): TrendScore | null;
```

评分阈值和分数作为**文件顶部常量块**,单点修改:

```ts
// ====== Scoring thresholds — tuned by hand per TREND.md, see spec §2 ======
const GAP_TIERS = [{ pct: 0.02, score: 20 }, { pct: 0.01, score: 10 }];
const RVOL_TIERS = [{ v: 3, score: 30 }, { v: 2, score: 20 }, { v: 1.5, score: 10 }];
const DRIVE_TIERS = [{ atr: 0.8, score: 25 }, { atr: 0.5, score: 15 }, { atr: 0.3, score: 8 }];
const VWAP_FULL = 15;
const VWAP_PARTIAL = 8;
const VWAP_PARTIAL_RATIO = 0.8;
const RANGE_ATR_RATIO = 0.6;
const RANGE_SCORE = 10;
export const TREND_SCORE_THRESHOLD = 60;
export const RVOL_LOOKBACK_DAYS = 20;
export const OPENING_WINDOW_MINUTES = 15;
```

**"15 根 bar"的语义细节**:intraday 09:30 开盘的第一根 bar 的 timestamp 对应 09:30,09:44 对应 09:44,09:45 的 bar(index 15)是**不包含在窗口内的**,它只是"09:45 判断的触发时刻"。因此窗口实际是 09:30–09:44 闭区间,15 根 bar。这个语义要在函数注释里写清楚。

### 3.2 改动:`src/backtest/runner.ts`

#### 3.2.1 预计算阶段(startup)

在现有 `aggregateDaily` / `precomputeAtrByDay` 之后加一步:

```ts
// 对每支票:算出每个交易日的 TrendBaseline
const trendBaselineBySymbol: Record<string, Record<string, TrendBaseline | null>> = {};
for (const { symbol, bars } of allData) {
    const days = uniqueDayKeys(bars);
    trendBaselineBySymbol[symbol] = {};
    for (const dayKey of days) {
        trendBaselineBySymbol[symbol][dayKey] = calcTrendBaseline(bars, dayKey);
    }
}
```

为了效率,`calcTrendBaseline` 内部应该**支持按 dayKey 查表而不是每次重扫**。实际实现可以:
1. 先把 `bars` 按 dayKey 分组(一次性),得到 `Record<dayKey, SerializedBar[]>`
2. 对每个 dayKey 用前 20 个 dayKey 的"09:30–09:45 窗口 volume 之和 / 20"算 rvolBaseline
3. 前一日 OHLC 聚合 + `technicalindicators.atr` 算 prevAtr

可以把这套预处理封装成一个 helper `precomputeTrendBaselinesForSymbol(bars): Record<dayKey, TrendBaseline | null>`,放在 runner 或 trendDetector 里都行(倾向 runner 侧,因为 BacktestMarket 是回测专属的数据组织)。

#### 3.2.2 主循环注入 detector

新增两个状态变量:

```ts
// 当日分数,日切清空
const dayScoreMap: Record<string, TrendScore | null | undefined> = {};
```

主循环的日切逻辑里清空:

```ts
if (dayKey !== currentDayKey) {
    // ...现有逻辑...
    for (const sym of Object.keys(dayScoreMap)) delete dayScoreMap[sym];
}
```

在"逐标的处理"里,在**信号检测分支之前**,判断是否到了打分时刻:

```ts
// 打分时刻定义:当 minutesSinceOpen >= 15(即 09:45 已到),
// 且该票当日还没打过分。此时窗口包含 09:30–09:44 的 15 根已收盘 bar。
const minutesSinceOpen = (timeGuard.getTradeProgressMinutes() as any).minutesSinceOpen;
const alreadyScored = dayScoreMap[symbol] !== undefined;
if (minutesSinceOpen >= 15 && !alreadyScored) {
    const baseline = trendBaselineBySymbol[symbol]?.[dayKey];
    if (baseline) {
        // 取当日 09:30–09:44 的 15 根 bar
        // 用 "当日首根 intraday bar 的 index" + offset [0..14] 读
        // 当日首根 intraday bar 的 index 可以在预处理阶段算好:
        //   Record<symbol, Record<dayKey, number>>
        const firstBarIdx = firstIntradayBarIndexBySymbol[symbol][dayKey];
        const window: SerializedBar[] = [];
        for (let k = 0; k < 15; k++) {
            const b = market.getBarAt(symbol, firstBarIdx + k);
            if (b) window.push(b);
        }
        dayScoreMap[symbol] = window.length === 15
            ? scoreTrendDay(window, baseline)
            : null; // 数据不完整 → 放行
    } else {
        dayScoreMap[symbol] = null; // 没基线 → 放行
    }
}
```

**firstIntradayBarIndexBySymbol 预计算**:在 `loadAllData` 之后遍历 bars,对每个新 dayKey 记第一次出现的 index。这个映射加上 `trendBaselineBySymbol` 一起在 startup 阶段算好。

**实现注意**:`getMinutesSinceOpen` 已经存在(`timeGuard.getTradeProgressMinutes()` 的 monkey-patched 版本),可以直接用。用 `>= 15` 的阈值而不是 `=== 15`,是因为要容忍"半分钟浮点"和"跳过某些 bar"的边界情况 —— 只要打分一次就锁住(用 `alreadyScored` 短路)。

#### 3.2.3 信号门控

在现有"canOpen 返回 dir 之后、设置 pendingEntry 之前"插入门控:

```ts
if (dir) {
    if (config.filters.enableTrendDetector) {
        const scoreInfo = dayScoreMap[symbol];
        if (scoreInfo === undefined) {
            // 09:45 之前,detector 还没打分 → 禁止
            // (注意:这会让 09:30–09:44 的所有信号被拦,这是方案 A 的预期行为)
        } else if (scoreInfo === null) {
            // 没有基线(样本头 20 天或前一日数据缺失)→ 放行
            pendingEntry[symbol] = dir;
        } else if (scoreInfo.total >= TREND_SCORE_THRESHOLD) {
            pendingEntry[symbol] = dir;
        }
        // 其余情况(分数 < 阈值)→ 拦截,不设 pendingEntry
    } else {
        pendingEntry[symbol] = dir;
    }
}
```

#### 3.2.4 trade log 扩字段

不论 `enableTrendDetector` 开关状态,每次 `closeTrade` 都把"入场当日的 dayScore"写进 trade:

```ts
// Position 新增
interface Position {
    // ...
    entryDayScore: number | null; // 入场当日该票的 detector 分数,null 表示没基线
}

// 创建 Position 时
const newPos: Position = {
    // ...
    entryDayScore: dayScoreMap[symbol]?.total ?? null,
};

// closeTrade 写到 BacktestTrade
trades.push({
    // ...
    entryDayScore: pos.entryDayScore,
});
```

#### 3.2.5 CLI flag

新增一个 flag,走现有 `parseFilterFlag` 模式:

```ts
const trend = parseFilterFlag('filter-trend');
if (trend !== undefined) filterOverride.enableTrendDetector = trend;
```

用法:

```bash
# 开 detector(门槛 60)
runner.ts trend_score60_sl010 trailing --filter-trend=on

# 关 detector 但记录分数(用于分组表)
runner.ts trend_recordonly_sl010 trailing
# ↑ 注意:分数是在主循环里无条件算的(为了 trade log 字段),
#    只是门控开关控制是否用它来拦截。所以"关 detector"自动就是"记录不门控"。
```

### 3.3 改动:`src/backtest/types.ts`

```ts
export interface BacktestTrade {
    // ...现有字段...
    entryDayScore: number | null; // 新增
}
```

**向后兼容**:旧的 result json 里没有这个字段,读脚本用 `trade.entryDayScore ?? null` 兼容。

### 3.4 改动:`src/config/strategy.config.ts`

```ts
filters: {
    enableRsiFilter: false,
    enableVolumeFilter: false,
    enableEntryPhaseFilter: false,
    enableIndexTrendFilter: false,
    enableTrendDetector: false, // 新增,默认关
},
```

`vwapStrategy.canOpen` **不读这个字段**,门控在 runner 侧。原因:detector 需要"当日 09:45 的状态",这是 runner 主循环的领域,而 `canOpen` 是无状态的纯信号函数 —— 它不知道"当前 bar 是几点"。把门控放到 runner 里更干净,也和现有 runner 已经承担"时段/强平"等时间逻辑的做法一致。

未来实盘版本接入时,会由 `vwapStrategy.onBar` 在调 `canOpen` 之前先读 `dayScoreMap`,那是下一个 spec 的事。

### 3.5 新增或改动:报告

推荐**新增** `src/backtest/reportTrend.ts` 而不是改 `report.ts`。理由:
- `report.ts` 现在承载 4 组固定比较(baseline / fixed / 双假设 / 按标的),加 trend 会让它进一步膨胀
- trend 实验是一次性验证,跑完可能就不再跑,独立脚本好回收
- `reportTrend.ts` 可以复用 `report.ts` 里的 `summarizeTrades` 之类的 helper,如果这些函数不是 export 的就顺便 export 一下

`reportTrend.ts` 产出 `data/backtest/report_trend.md`,包含:

**主表(A + B)**:

| label | trades | winRate | avgR | expectancy | cumR | maxDD | cumR÷maxDD |
|---|---|---|---|---|---|---|---|
| baseline_loose_sl010 | | | | | | | |
| trend_recordonly_sl010 | | | | | | | |
| trend_score60_sl010 | | | | | | | |

**分组表(C)** — 读 `trend_recordonly_sl010`(门控关,但记录分数),按 entryDayScore 分桶:

| 分数桶 | trades | winRate | avgR | expectancy | cumR |
|---|---|---|---|---|---|
| null(无基线) | | | | | |
| 0 ≤ s < 30 | | | | | |
| 30 ≤ s < 60 | | | | | |
| 60 ≤ s < 80 | | | | | |
| 80 ≤ s ≤ 100 | | | | | |

**补充统计**:09:30–09:44 这段时间的 trade 数、R 贡献(用于评估"丢掉这段的代价")

### 3.6 改动:`references/BACKTEST.md`

- 第 3.2 节 runner CLI 文档补 `--filter-trend=on|off`
- 第 6 节末尾补"实验待跑 — 趋势日 detector"占位,等结论跑出来后填
- 第 7 节"怎么加新的回测实验"其实已经覆盖了 detector 这种类型的改造,不用改

---

## 4. 实验计划

三组 label,都跑一年样本:

1. `baseline_loose_sl010` — **已有**,不重跑(是当前 config 下的对照组 `baseline_1y_sl010.json`)
2. `trend_recordonly_sl010` — 新跑,`--filter-trend=off`(detector 关,但 trade log 记录分数)
3. `trend_score60_sl010` — 新跑,`--filter-trend=on`(detector 开,门槛 60)

**重要**:`baseline_1y_sl010.json` 里没有 `entryDayScore` 字段。报告里读 baseline 时需要兼容这个字段为 undefined。

跑完后生成 `report_trend.md`,人工 review 主表 + 分组表,做决策:
- 如果分组表显示**分数 ≥ 80 桶的 cumR / expectancy 显著好于 < 30 桶** → 评分公式有区分度,下一步讨论"是否调门槛"
- 如果**分组表没区分度** → 评分公式失败,回去改公式(指标选择 / 阈值 / 权重),而不是推进落地
- 如果**有区分度但主表里 trend_score60 的 cumR÷maxDD 没提升** → 可能是门槛太低或太高,参考分组表调阈值重跑

---

## 5. 已知风险与边界

### 5.1 09:30–09:44 禁开仓的代价

方案 A 的副作用。实现完成后,跑 `trend_recordonly_sl010` 并用 `entryTimestamp` 筛出这段的 trade,算总 R。如果这段的 cumR 是 +200R 而 detector 增益是 +100R,那整体是 -100R,方案 A 就要重评估。

规避方法:分组表同时按"入场时段"分桶(已有 `phaseAtEntry`,但'early' 包含 0–30min,需要再细分一下,或在 reportTrend 里自己用 `entryTimestamp` 算 minutesSinceOpen)。

### 5.2 评分公式是启发式,不是拟合出来的

5 个指标和阈值都是 TREND.md 手调的,不是从你的 46 支票样本回归出来的。这是 C 分组表存在的理由:它的直接产出就是"公式有没有区分度"的答案。如果没有,不是 detector 方向错了,而是需要换公式(或换到你样本里有区分度的指标)。

### 5.3 单日单次打分,不再更新

09:45 锁死,之后不更新。某天前 15 分钟平淡但 10:30 才启动的趋势会被误杀。v1 不处理,记录为未来改进项(可能的 v2:每 30 分钟重算一次分数)。

### 5.4 RVOL 基线的"同窗口"语义

"前 20 天同窗口"默认用 UTC 日期 + "当日 intraday 前 15 根 bar"。美股 DST 切换时 UTC 日期和美东日期始终对齐盘中时段(09:30–16:00 美东一定在同一个 UTC 日),所以这个语义是稳的。但**如果某天停牌 / 半日市 / 数据缺失少于 15 根**,这一天对 RVOL 基线的贡献是不完整的。v1 处理:`calcTrendBaseline` 遇到某日少于 15 根就跳过该日不纳入均值(但仍计入 "20 天"预热期),如果 20 天里少于一半(10 天)有有效窗口,返回 null。

### 5.5 跨样本 ATR 差异

参考 BACKTEST.md §4.5。在一年样本起点(2025-04-11)的前 7 天仍在 ATR 预热期,加上 RVOL 的 20 天预热,前 20+ 个交易日的 detector 会返回 null(→ 放行)。样本头部的行为和旧 baseline 差不多,这段时间的 trade 不应该被算作 detector 的功劳或代价。

---

## 6. 实施步骤(给写 plan 的人)

1. 新建 `src/core/trendDetector.ts`:写 `calcTrendBaseline` + `scoreTrendDay` + 常量块,单元可测的纯函数
2. 改 `src/config/strategy.config.ts`:加 `filters.enableTrendDetector: false`
3. 改 `src/backtest/types.ts`:给 `BacktestTrade` 加 `entryDayScore: number | null`
4. 改 `src/backtest/runner.ts`:
   - 导入 `calcTrendBaseline` / `scoreTrendDay` / `TREND_SCORE_THRESHOLD`
   - 新增 `precomputeTrendBaselinesBySymbol`(或在 runner 里直接 inline)
   - 主循环加 `dayScoreMap`、日切清空、09:45 打分、信号门控
   - `Position` 加 `entryDayScore`,`closeTrade` 写入 trade
   - CLI 加 `--filter-trend` flag
5. 新建 `src/backtest/reportTrend.ts`:生成 `report_trend.md`(主表 + 分组表 + 时段分布表)
6. 跑两组实验:`trend_recordonly_sl010`、`trend_score60_sl010`
7. 运行 `reportTrend.ts`,review 报告
8. 改 `references/BACKTEST.md`:补 CLI flag 文档 + 实验结论

测试侧:`trendDetector.ts` 是纯函数,容易用 ts-node 写一个一次性 smoke script 验证 5 个指标在构造样本上的分数是否符合预期(项目没有 jest 基础设施,不做形式化 unit test)。smoke script 放 `src/backtest/smokeTrendDetector.ts`,跑完即弃。

---

## 7. 成功标准

1. 两个回测实验都跑通,产出 `data/backtest/results/trend_*.json`
2. `report_trend.md` 三张表都有数据
3. 分组表能直接回答"评分有没有区分度"(主观判断,不是数值门槛)
4. `trend_score60_sl010` 主表上的 cumR÷maxDD ≥ `baseline_loose_sl010` 的 90%(即使没涨太多,也不能显著变差;如果显著变差,说明门控砍掉了有价值的票,方案要修)

---

## 8. 后续 v2 可能改进(不在本 spec)

- 方向性评分(把方案 B 加回来)
- 多次打分(09:45 + 10:15 + 11:00 动态更新)
- 评分阈值参数化 + 网格扫描
- 实盘侧 hook(`vwapStrategy.onBar` 读 `dayScoreMap`)
- Walk-forward:2025-04 到 2025-10 训练评分公式,2025-10 到 2026-04 样本外验证

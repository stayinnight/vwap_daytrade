# 趋势日 Detector 回测门控 v1 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给现有回测系统加一个"09:45 趋势日评分"模块,按分数门控入场信号,并跑 3 组实验验证评分公式是否有区分度以及整体风险调整收益是否提升。

**Architecture:** 新增一个纯函数评分模块 `src/core/trendDetector.ts`(未来实盘可复用),在 `runner.ts` 主循环里做 ① 启动时预计算每支票每天的历史基准(前 20 天成交量均值 + 前一日 ATR/close)、② 每个交易日 `minutesSinceOpen >= 15` 时对每支票打分、③ 信号产生时按分数门控、④ trade log 不论门控开关始终写入 `entryDayScore` 字段。报告侧新增 `reportTrend.ts` 生成主表(A+B)和分数分组表(C)。

**Tech Stack:** TypeScript + ts-node(CommonJS 模式)、`technicalindicators`(已有)、lowdb(不涉及)、longport(不涉及,runner 已经绕开副作用接口)

**Spec:** `docs/superpowers/specs/2026-04-14-trend-detector-design.md`

**Reference:** `references/BACKTEST.md`, `references/TREND.MD`

---

## 背景速览(给零上下文的工程师)

- 回测系统是**分钟级向量化**,读 `data/backtest/raw/{symbol}.json` 里的 bar,用 `runner.ts` 主循环推进,每 tick 调 `VWAPStrategy.canOpen()` 做信号判断,runner 自管仓位和撮合
- 所有回测脚本必须用这个前缀:`TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test npx ts-node --transpile-only ...`
- 项目**没有 jest**,package.json 里的 jest 段是空配置。测试靠"一次性 ts-node smoke script"
- 项目没有 lint 脚本,pre-commit hook 里有 `dts lint` 但是我们不依赖它
- 一次完整回测(一年样本,46 支 + QQQ)3–6 分钟
- 代码和注释以中文为主,保持语言一致
- 现有 `config.filters.*` 有 4 个开关(RSI / 量比 / 分时段 / 指数),runner CLI 通过 `--filter-xxx=on|off` 解析。我们加第 5 个:`enableTrendDetector`
- **重要惯例**:runner 在 `runBacktest()` 结尾必须恢复所有临时改动的 `config.*` 字段(因为是单例),这个 plan 里要继承

---

## 文件结构与职责

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/core/trendDetector.ts` | 新建 | 纯函数:`calcTrendBaseline`、`scoreTrendDay`、评分常量块、门槛常量 |
| `src/backtest/smokeTrendDetector.ts` | 新建(实现后跑完即可,不删除) | ts-node smoke 脚本,构造输入验证 5 个指标的打分是否符合预期 |
| `src/config/strategy.config.ts` | 修改 | `filters` 加 `enableTrendDetector: false` |
| `src/backtest/types.ts` | 修改 | `BacktestTrade` 加 `entryDayScore: number \| null` |
| `src/backtest/runner.ts` | 修改 | 预计算 trend baseline + firstIntradayBarIndex、主循环注入打分 / 门控、Position 扩字段、CLI flag |
| `src/backtest/reportTrend.ts` | 新建 | 生成 `data/backtest/report_trend.md`(主表 + 分数分组表 + 09:30–09:44 时段贡献表) |
| `references/BACKTEST.md` | 修改 | §3.2 CLI 文档补 `--filter-trend`,§6 补实验结论占位 |

**决策说明**:
- `trendDetector.ts` 放在 `src/core/` 而不是 `src/backtest/` 因为未来实盘 `vwapStrategy` 会直接 import。现在不写实盘路径,但位置要对
- `reportTrend.ts` 独立于 `report.ts`,避免已经有 4 组对比的 report.ts 继续膨胀
- smoke script 不走 jest,是"ts-node 跑一个 main 函数、assert 失败就 throw"的最小形式

---

## Task 0:准备工作区快照

**Files:**
- 无改动,只确认 git 状态

- [ ] **Step 1:确认当前分支和工作区状态**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
git status
git log --oneline -5
```

预期:当前在 `feat/dev` 分支,最新 commit 是 spec 提交 `docs: 趋势日 detector 回测门控 v1 设计规格`(commit c8e410b)。工作区里 AGENTS.md/CLAUDE.md/README.md 等既有未提交改动可以先不管,它们和本 plan 无关。

- [ ] **Step 2:快速 smoke-check 现有回测能跑通(可选但推荐)**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts smoke_pre_plan trailing 2>&1 | tail -20
```

预期:看到 `[runner] 完成 smoke_pre_plan 交易数=...` 和一个输出 json 路径。如果报错,先修,不能在坏地基上盖楼。

如果回测跑完产生了 `data/backtest/results/smoke_pre_plan.json`,留着或删掉都行,不影响后续。

---

## Task 1:新建 `trendDetector.ts` 骨架 + 常量 + 类型

**Files:**
- Create: `src/core/trendDetector.ts`

- [ ] **Step 1:创建文件 + 常量块 + 类型定义**

写入文件完整内容(不要实现函数体,先留桩,下一个 task 填):

```typescript
/**
 * 趋势日评分系统(Trend Day Detector)
 *
 * 在每个交易日 09:45 对每支票打一次分(0–100),分数 >= 门槛(60)时才允许当日开仓。
 * 本模块是**纯函数**,不读文件、不调网络、不依赖 longport,方便回测和未来实盘共用。
 *
 * 5 个指标的定义、分数阈值、样本设计参考:
 *   references/TREND.MD
 *   docs/superpowers/specs/2026-04-14-trend-detector-design.md
 */
import { SerializedBar } from '../backtest/types';
import { atr as ta_atr } from 'technicalindicators';

// ====== 评分阈值 —— 手调,单点修改,见 spec §2 ======
const GAP_TIERS = [
    { pct: 0.02, score: 20 },
    { pct: 0.01, score: 10 },
];
const RVOL_TIERS = [
    { v: 3, score: 30 },
    { v: 2, score: 20 },
    { v: 1.5, score: 10 },
];
const DRIVE_TIERS = [
    { atr: 0.8, score: 25 },
    { atr: 0.5, score: 15 },
    { atr: 0.3, score: 8 },
];
const VWAP_FULL_SCORE = 15;
const VWAP_PARTIAL_SCORE = 8;
const VWAP_PARTIAL_RATIO = 0.8;
const RANGE_ATR_RATIO = 0.6;
const RANGE_SCORE = 10;

export const TREND_SCORE_THRESHOLD = 60;
export const RVOL_LOOKBACK_DAYS = 20;
export const OPENING_WINDOW_MINUTES = 15;
/** ATR 天数,和 strategy.config.atrPeriod 对齐(=7) */
const ATR_PERIOD = 7;

/** 某支票某一天用的历史基准(前 1 日 close/ATR + 前 20 日同窗口成交量均值) */
export interface TrendBaseline {
    prevClose: number;
    prevAtr: number;
    rvolBaseline: number; // 前 20 天 09:30–09:44 成交量均值
}

export interface TrendScoreDetails {
    gapPct: number;
    rvolValue: number;
    driveAtr: number;
    vwapControlRatio: number;
    vwapControlSide: 'long' | 'short' | 'none';
    rangeValue: number;
}

export interface TrendScore {
    total: number; // 0–100
    gap: number;
    rvol: number;
    drive: number;
    vwap: number;
    range: number;
    details: TrendScoreDetails;
}

/**
 * 给定一支票的全部分钟 bar + 目标 dayKey(UTC YYYY-MM-DD),
 * 算出该日打分要用的历史基准。
 *
 * 若历史不足(前 1 日不存在 / 前 N 日 ATR 算不出 / 前 20 日有效窗口不足 10 天),
 * 返回 null —— runner 侧把 null 视为"放行"(不门控)。
 *
 * 为避免被重复调用时每次都扫整支,在 precomputeTrendBaselinesForSymbol() 里
 * 做了一次性的 dayKey 分组预处理。本函数只做"查表"风格的拼装。
 */
export function calcTrendBaseline(
    bars: SerializedBar[],
    dayKey: string
): TrendBaseline | null {
    throw new Error('not implemented');
}

/**
 * 给定一支票在当日的 09:30–09:44 这 15 根分钟 bar + baseline,返回评分。
 *
 * window 必须严格是 15 根(不多不少),时间正序。
 * 若 window.length !== 15 或 baseline.rvolBaseline <= 0 返回 null。
 *
 * 5 个指标:
 *   Gap (20)   : |open - prevClose| / prevClose
 *   RVOL (30)  : sum(window.volume) / rvolBaseline
 *   Drive (25) : |window[last].close - window[0].open| / prevAtr
 *   VWAP (15)  : 15 根 bar 的累积 VWAP 被 close 站上/站下的比例
 *   Range (10) : (max high - min low) > prevAtr * 0.6
 *
 * 注意:使用 window[0].open 作为"open",这是 09:30 那根 bar 的开盘,
 *       和 prevClose 比是 overnight gap;使用 window[last].close 作为"price_0945",
 *       这是 09:44 那根 bar 的收盘,也就是"09:45 那一刻的最新价"。
 */
export function scoreTrendDay(
    window: SerializedBar[],
    baseline: TrendBaseline
): TrendScore | null {
    throw new Error('not implemented');
}

/**
 * 一次性对一支票预计算每个 dayKey 的 baseline。
 *
 * 返回 `Record<dayKey, TrendBaseline | null>`,runner 里对每支票调一次、
 * 整段回测期间只查表,不重扫。
 */
export function precomputeTrendBaselinesForSymbol(
    bars: SerializedBar[]
): Record<string, TrendBaseline | null> {
    throw new Error('not implemented');
}
```

- [ ] **Step 2:验证 ts-node 能解析该文件(不跑逻辑,只看语法 / 类型)**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' \
  npx ts-node --transpile-only -e "require('./src/core/trendDetector.ts'); console.log('ok');"
```

预期输出:`ok`。如果报"Cannot find module './backtest/types'"或路径问题,说明 TS 相对路径写错了(检查 `import { SerializedBar } from '../backtest/types'`)。

- [ ] **Step 3:commit**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
git add src/core/trendDetector.ts
git commit -m "$(cat <<'EOF'
feat: trendDetector 骨架 — 常量、类型与函数桩

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2:实现 `calcTrendBaseline` + `precomputeTrendBaselinesForSymbol`

**Files:**
- Modify: `src/core/trendDetector.ts`

- [ ] **Step 1:在 trendDetector.ts 顶部加一个内部 helper `aggregateDailyForTrend`**

这个 helper 做两件事:按 UTC 日期分组 + 聚合每日 OHLC(和 `runner.ts` 里的 `aggregateDaily` 职责相同但我们**不**复用 —— trendDetector 要保持独立于 backtest 目录,两处各自维护一份)。

在文件末尾(所有 export 之后)加:

```typescript
interface DailyOHLC {
    dayKey: string;
    open: number;
    high: number;
    low: number;
    close: number;
    openingVolume: number; // 09:30–09:44 共 15 根 bar 的 volume 之和
}

/** 按 UTC 日期分组、聚合每日 OHLC 和"开盘窗口成交量" */
function aggregateDailyForTrend(bars: SerializedBar[]): DailyOHLC[] {
    const byDay: Record<string, {
        open: number | null;
        high: number;
        low: number;
        close: number;
        openingVolume: number;
        openingBarCount: number;
        firstTs: number;
    }> = {};
    // 先按 day 分组
    for (const b of bars) {
        const key = new Date(b.timestamp).toISOString().slice(0, 10);
        if (!byDay[key]) {
            byDay[key] = {
                open: null,
                high: b.high,
                low: b.low,
                close: b.close,
                openingVolume: 0,
                openingBarCount: 0,
                firstTs: b.timestamp,
            };
        }
        const d = byDay[key];
        if (b.high > d.high) d.high = b.high;
        if (b.low < d.low) d.low = b.low;
        d.close = b.close; // 按 bar 顺序推进,最后一根即收盘
        if (b.timestamp < d.firstTs) d.firstTs = b.timestamp;
    }
    // 第二遍:找每天的"当日首根 bar 的 open"和"前 15 根 volume 之和"
    // 先把每天的 bar 按时间排序一次
    const barsByDay: Record<string, SerializedBar[]> = {};
    for (const b of bars) {
        const key = new Date(b.timestamp).toISOString().slice(0, 10);
        (barsByDay[key] ??= []).push(b);
    }
    for (const key of Object.keys(barsByDay)) {
        const dayBars = barsByDay[key].sort((a, b) => a.timestamp - b.timestamp);
        byDay[key].open = dayBars[0].open;
        const n = Math.min(OPENING_WINDOW_MINUTES, dayBars.length);
        let sum = 0;
        for (let i = 0; i < n; i++) sum += dayBars[i].volume;
        byDay[key].openingVolume = sum;
        byDay[key].openingBarCount = n;
    }
    // 转成数组 + 时间正序
    return Object.keys(byDay)
        .sort()
        .map(key => ({
            dayKey: key,
            open: byDay[key].open ?? 0,
            high: byDay[key].high,
            low: byDay[key].low,
            close: byDay[key].close,
            openingVolume: byDay[key].openingBarCount >= OPENING_WINDOW_MINUTES
                ? byDay[key].openingVolume
                : 0, // 不足 15 根标记为 0(后面算 RVOL 时会跳过)
        }));
}
```

- [ ] **Step 2:实现 `precomputeTrendBaselinesForSymbol`**

用这段替换现有的桩:

```typescript
export function precomputeTrendBaselinesForSymbol(
    bars: SerializedBar[]
): Record<string, TrendBaseline | null> {
    const out: Record<string, TrendBaseline | null> = {};
    const daily = aggregateDailyForTrend(bars);
    if (daily.length === 0) return out;

    // 先算每日日线 ATR 序列(参考 runner.precomputeAtrByDay):
    // atrSeries[k] 对应 daily[k + ATR_PERIOD] 的"用前 ATR_PERIOD 天算出的 ATR"
    // 即 "第 i 天开盘能拿到的 ATR" = atrSeries[i - ATR_PERIOD - 1]  (i > ATR_PERIOD)
    const atrSeries =
        daily.length > ATR_PERIOD
            ? ta_atr({
                  high: daily.map(d => d.high),
                  low: daily.map(d => d.low),
                  close: daily.map(d => d.close),
                  period: ATR_PERIOD,
              })
            : [];

    for (let i = 0; i < daily.length; i++) {
        const dayKey = daily[i].dayKey;

        // 基本预热:i === 0 没有前一日
        if (i === 0) {
            out[dayKey] = null;
            continue;
        }
        const prevDay = daily[i - 1];
        const prevClose = prevDay.close;

        // prevAtr:需要 i > ATR_PERIOD + 1
        if (i <= ATR_PERIOD + 1) {
            out[dayKey] = null;
            continue;
        }
        const prevAtr = atrSeries[i - ATR_PERIOD - 2]; // "前一天"那天用的 ATR
        if (prevAtr === undefined || !Number.isFinite(prevAtr) || prevAtr <= 0) {
            out[dayKey] = null;
            continue;
        }

        // RVOL 基线:前 RVOL_LOOKBACK_DAYS 天(不含当日)的 openingVolume 均值
        // 只计入 openingVolume > 0 的天(openingVolume === 0 = 当日 bar 不足 15 根)
        // 若有效天数 < 10(半数),放弃
        const from = Math.max(0, i - RVOL_LOOKBACK_DAYS);
        const to = i; // 不含
        let sum = 0;
        let cnt = 0;
        for (let k = from; k < to; k++) {
            if (daily[k].openingVolume > 0) {
                sum += daily[k].openingVolume;
                cnt++;
            }
        }
        if (cnt < Math.ceil(RVOL_LOOKBACK_DAYS / 2)) {
            out[dayKey] = null;
            continue;
        }
        const rvolBaseline = sum / cnt;
        if (rvolBaseline <= 0) {
            out[dayKey] = null;
            continue;
        }

        out[dayKey] = { prevClose, prevAtr, rvolBaseline };
    }

    return out;
}
```

- [ ] **Step 3:实现 `calcTrendBaseline`(单日接口,内部复用 precompute 缓存是 overkill,这里直接转调)**

用这段替换现有的桩:

```typescript
export function calcTrendBaseline(
    bars: SerializedBar[],
    dayKey: string
): TrendBaseline | null {
    // 单日接口。调用方如果是 runner,应该用 precomputeTrendBaselinesForSymbol
    // 一次性拿到全部 dayKey 的映射,效率更高。
    // 这里提供单日版主要给未来实盘 / 单元测试调用。
    const all = precomputeTrendBaselinesForSymbol(bars);
    return all[dayKey] ?? null;
}
```

- [ ] **Step 4:语法验证**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' \
  npx ts-node --transpile-only -e "require('./src/core/trendDetector.ts'); console.log('ok');"
```

预期:`ok`

- [ ] **Step 5:commit**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
git add src/core/trendDetector.ts
git commit -m "$(cat <<'EOF'
feat: calcTrendBaseline + precomputeTrendBaselinesForSymbol

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3:实现 `scoreTrendDay`

**Files:**
- Modify: `src/core/trendDetector.ts`

- [ ] **Step 1:实现函数体**

替换现有桩:

```typescript
export function scoreTrendDay(
    window: SerializedBar[],
    baseline: TrendBaseline
): TrendScore | null {
    if (window.length !== OPENING_WINDOW_MINUTES) return null;
    if (baseline.rvolBaseline <= 0) return null;
    if (!Number.isFinite(baseline.prevClose) || baseline.prevClose <= 0) return null;
    if (!Number.isFinite(baseline.prevAtr) || baseline.prevAtr <= 0) return null;

    const open = window[0].open;
    const price0945 = window[window.length - 1].close;

    // ====== 指标一:Gap ======
    const gapPct = Math.abs(open - baseline.prevClose) / baseline.prevClose;
    let gap = 0;
    for (const tier of GAP_TIERS) {
        if (gapPct > tier.pct) {
            gap = tier.score;
            break;
        }
    }

    // ====== 指标二:RVOL ======
    let windowVol = 0;
    for (const b of window) windowVol += b.volume;
    const rvolValue = windowVol / baseline.rvolBaseline;
    let rvol = 0;
    for (const tier of RVOL_TIERS) {
        if (rvolValue > tier.v) {
            rvol = tier.score;
            break;
        }
    }

    // ====== 指标三:Opening Drive ======
    const driveAtr = Math.abs(price0945 - open) / baseline.prevAtr;
    let drive = 0;
    for (const tier of DRIVE_TIERS) {
        if (driveAtr > tier.atr) {
            drive = tier.score;
            break;
        }
    }

    // ====== 指标四:VWAP 控制力 ======
    // 从 09:30 累积的当日 VWAP,每根 bar 的 close vs 同时刻 VWAP
    let cumTurnover = 0;
    let cumVolume = 0;
    let longCount = 0;
    let shortCount = 0;
    for (const b of window) {
        cumTurnover += b.turnover;
        cumVolume += b.volume;
        if (cumVolume <= 0) continue;
        const vwap = cumTurnover / cumVolume;
        if (b.close > vwap) longCount++;
        else if (b.close < vwap) shortCount++;
        // 平价不计入任何一边
    }
    const total = window.length;
    const longRatio = longCount / total;
    const shortRatio = shortCount / total;
    let vwap = 0;
    let vwapControlRatio = Math.max(longRatio, shortRatio);
    let vwapControlSide: 'long' | 'short' | 'none' =
        longRatio > shortRatio ? 'long' : shortRatio > longRatio ? 'short' : 'none';
    if (longRatio === 1 || shortRatio === 1) {
        vwap = VWAP_FULL_SCORE;
    } else if (longRatio >= VWAP_PARTIAL_RATIO || shortRatio >= VWAP_PARTIAL_RATIO) {
        vwap = VWAP_PARTIAL_SCORE;
    }

    // ====== 指标五:Range Expansion ======
    let highMax = window[0].high;
    let lowMin = window[0].low;
    for (const b of window) {
        if (b.high > highMax) highMax = b.high;
        if (b.low < lowMin) lowMin = b.low;
    }
    const rangeValue = highMax - lowMin;
    const range = rangeValue > baseline.prevAtr * RANGE_ATR_RATIO ? RANGE_SCORE : 0;

    return {
        total: gap + rvol + drive + vwap + range,
        gap,
        rvol,
        drive,
        vwap,
        range,
        details: {
            gapPct,
            rvolValue,
            driveAtr,
            vwapControlRatio,
            vwapControlSide,
            rangeValue,
        },
    };
}
```

- [ ] **Step 2:语法验证**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' \
  npx ts-node --transpile-only -e "require('./src/core/trendDetector.ts'); console.log('ok');"
```

预期:`ok`

- [ ] **Step 3:commit**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
git add src/core/trendDetector.ts
git commit -m "$(cat <<'EOF'
feat: scoreTrendDay —— 5 指标 0~100 分评分实现

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4:写 smoke script 验证 5 个指标的打分

**Files:**
- Create: `src/backtest/smokeTrendDetector.ts`

这是 TDD 替代品 —— 项目没有 jest,但我们仍然要对纯函数的关键 case 做 assert 式验证。smoke script 一次性跑完、assert 全过 = 绿灯。

- [ ] **Step 1:创建 smoke 脚本**

写入文件完整内容:

```typescript
/**
 * trendDetector 的 smoke 验证脚本。
 *
 * 跑法:
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/smokeTrendDetector.ts
 *
 * 设计:构造若干小样本(历史 + 当日 15 根 bar),人工算出应得分数,
 * 调 scoreTrendDay / precomputeTrendBaselinesForSymbol 验证输出匹配。
 *
 * 不是形式化 unit test,但它的 assert 失败就 throw,适合回归用。
 */
import { SerializedBar } from './types';
import {
    scoreTrendDay,
    precomputeTrendBaselinesForSymbol,
    TrendBaseline,
    TREND_SCORE_THRESHOLD,
    OPENING_WINDOW_MINUTES,
} from '../core/trendDetector';

function assert(cond: boolean, msg: string) {
    if (!cond) {
        throw new Error('ASSERT FAIL: ' + msg);
    }
}

function approxEq(a: number, b: number, eps = 1e-6) {
    return Math.abs(a - b) < eps;
}

/** 构造一根 bar 的辅助 */
function bar(ts: number, o: number, h: number, l: number, c: number, vol: number): SerializedBar {
    return {
        timestamp: ts,
        open: o,
        high: h,
        low: l,
        close: c,
        volume: vol,
        turnover: ((o + c) / 2) * vol, // 粗略的 turnover,scoreTrendDay VWAP 用
        tradeSession: 0,
    };
}

function ts(dayKey: string, hh: number, mm: number) {
    // 把 UTC 日期的 HH:MM 转成时间戳
    return Date.parse(`${dayKey}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
}

// ============================================================
// Case 1:满分样本
// gap 2.5% (20)、RVOL 3.5 (30)、drive 1.0 ATR (25)、
// VWAP 全站上 (15)、range > 0.6 ATR (10) = 100
// ============================================================
(function caseFullScore() {
    const baseline: TrendBaseline = {
        prevClose: 100,
        prevAtr: 2,
        rvolBaseline: 10000, // 前 20 天均值
    };
    const window: SerializedBar[] = [];
    // open = 102.5 (gap +2.5%), price_0944 = 104.5 (drive = 2/2 = 1.0 ATR)
    // 每根 bar volume = 2500 * 15/15 / 某个系数让 sum / 10000 > 3.5
    // sum / 10000 > 3.5 → sum > 35000,每根 >= 2334
    for (let i = 0; i < OPENING_WINDOW_MINUTES; i++) {
        // 构造每根 close 逐步上升 & 都高于 cum VWAP(open 一直是窗口最低点)
        const o = 102.5 + i * 0.1;
        const c = 102.5 + (i + 1) * 0.1;
        const h = Math.max(o, c) + 0.05;
        const l = Math.min(o, c) - 0.05;
        window.push(bar(0, o, h, l, c, 2500));
    }
    // 修正 window[0].open = 102.5(gap 测量点)
    window[0].open = 102.5;
    // 修正 window[last].close → 让 drive = 1.0
    window[window.length - 1].close = 104.5;
    // range: highMax = 104.55, lowMin = 102.45, range = 2.1 > 0.6 * 2 = 1.2 ✓

    const score = scoreTrendDay(window, baseline);
    assert(score !== null, 'case1: score should not be null');
    console.log('  case1 full score:', JSON.stringify(score));
    assert(score!.gap === 20, `case1 gap expected 20, got ${score!.gap}`);
    assert(score!.rvol === 30, `case1 rvol expected 30, got ${score!.rvol}`);
    assert(score!.drive === 25, `case1 drive expected 25, got ${score!.drive}`);
    assert(score!.vwap === 15, `case1 vwap expected 15, got ${score!.vwap}`);
    assert(score!.range === 10, `case1 range expected 10, got ${score!.range}`);
    assert(score!.total === 100, `case1 total expected 100, got ${score!.total}`);
    console.log('  case1 PASS');
})();

// ============================================================
// Case 2:零分样本
// gap 0.5%、RVOL 0.8、drive 0.1 ATR、VWAP 没占比超过 80%、range 小
// ============================================================
(function caseZeroScore() {
    const baseline: TrendBaseline = {
        prevClose: 100,
        prevAtr: 10, // 大 ATR 让 drive/range 都拿不到分
        rvolBaseline: 10000,
    };
    const window: SerializedBar[] = [];
    for (let i = 0; i < OPENING_WINDOW_MINUTES; i++) {
        // close 在 100.5 附近震荡,让 VWAP 站上站下比例 ~ 50/50
        const c = i % 2 === 0 ? 100.55 : 100.45;
        const o = i % 2 === 0 ? 100.45 : 100.55;
        window.push(bar(0, o, 100.6, 100.4, c, 500));
    }
    window[0].open = 100.5; // gap = 0.5% < 1%
    window[window.length - 1].close = 100.51; // drive ~ 0.001

    const score = scoreTrendDay(window, baseline);
    assert(score !== null, 'case2: not null');
    console.log('  case2 zero score:', JSON.stringify(score));
    assert(score!.gap === 0, `case2 gap expected 0, got ${score!.gap}`);
    assert(score!.rvol === 0, `case2 rvol expected 0, got ${score!.rvol}`);
    assert(score!.drive === 0, `case2 drive expected 0, got ${score!.drive}`);
    // vwap 可能拿到 0 或 8,看 50/50 是否打破 —— 这里允许 0 或 8
    assert(score!.vwap === 0, `case2 vwap expected 0, got ${score!.vwap}`);
    assert(score!.range === 0, `case2 range expected 0, got ${score!.range}`);
    assert(score!.total === 0, `case2 total expected 0, got ${score!.total}`);
    console.log('  case2 PASS');
})();

// ============================================================
// Case 3:门槛附近 (60 分)
// gap 1.5% (10) + rvol 2.1 (20) + drive 0.6 ATR (15) + vwap 0 + range 1.0 ATR (10) = 55
// → 55 < 60,门槛拦截
// 再加 vwap 全站上 (15) → 70 → 通过
// ============================================================
(function caseThreshold() {
    const baseline: TrendBaseline = {
        prevClose: 100,
        prevAtr: 2,
        rvolBaseline: 10000,
    };
    // 3a:vwap 混乱(50/50),总分 55
    const win3a: SerializedBar[] = [];
    for (let i = 0; i < OPENING_WINDOW_MINUTES; i++) {
        const o = i % 2 === 0 ? 101.49 : 101.51;
        const c = i % 2 === 0 ? 101.51 : 101.49;
        win3a.push(bar(0, o, c + 0.5, o - 0.5, c, 1400));
    }
    win3a[0].open = 101.5; // gap 1.5%
    win3a[win3a.length - 1].close = 102.7; // drive = 1.2 / 2 = 0.6 ATR
    // range: high=102.7+0.5, low=101-0.5 (因为最后一根 low = c - 0.5 = 102.2)
    // 实际 low 要看所有 bar:窗口 low 约 101 (win3a[0] open=101.5 但 l=100.99)
    // 手动核一下:for i=0 bar l = 101.49 - 0.5 = 100.99
    // range ≈ (102.7 + 0.5) - 100.99 = 2.21 > 0.6 * 2 = 1.2 ✓
    // RVOL: sum = 1400*15 = 21000 / 10000 = 2.1 > 2 → 20 分

    const score3a = scoreTrendDay(win3a, baseline);
    assert(score3a !== null, 'case3a: not null');
    console.log('  case3a score:', score3a!.total, JSON.stringify(score3a));
    assert(score3a!.total < TREND_SCORE_THRESHOLD, `case3a should be below threshold 60`);
    console.log('  case3a PASS (below threshold)');
})();

// ============================================================
// Case 4:precomputeTrendBaselinesForSymbol
// 构造 25 天的虚假 bars (每天 15 根 + 1 根晚期),看预计算结果
// ============================================================
(function casePrecompute() {
    const bars: SerializedBar[] = [];
    // 25 天,每天 09:30–09:45 + 一根 15:59 收盘(为了让 aggregateDailyForTrend 的 close 正确)
    // 用 UTC ts = dayBase + minute
    for (let day = 0; day < 25; day++) {
        const dayKey = `2026-01-${String(day + 1).padStart(2, '0')}`;
        for (let min = 0; min < 15; min++) {
            bars.push(bar(ts(dayKey, 14, 30 + min), 100, 101, 99, 100.5, 1000));
        }
        // 收盘一根(避免 high/low/close 被 09:30–09:45 以外的逻辑影响)
        bars.push(bar(ts(dayKey, 19, 59), 100.5, 101.5, 99.5, 100.8, 500));
    }

    const out = precomputeTrendBaselinesForSymbol(bars);
    const keys = Object.keys(out).sort();
    console.log('  precompute days:', keys.length);
    // 前几天是 null(预热期),后面应该有 baseline
    assert(out[keys[0]] === null, 'precompute: day0 should be null (no prev day)');
    // ATR 预热 = ATR_PERIOD + 1 天,之后还要 RVOL 预热 10 天有效,大概 day 10+ 才出
    const lastDayBaseline = out[keys[keys.length - 1]];
    assert(lastDayBaseline !== null, 'precompute: last day should have baseline');
    console.log('  last day baseline:', JSON.stringify(lastDayBaseline));
    assert(lastDayBaseline!.rvolBaseline > 0, 'rvolBaseline > 0');
    assert(lastDayBaseline!.prevClose > 0, 'prevClose > 0');
    assert(lastDayBaseline!.prevAtr >= 0, 'prevAtr >= 0');
    console.log('  case4 PASS');
})();

console.log('\n✅ trendDetector smoke all pass');
```

- [ ] **Step 2:跑 smoke script**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/smokeTrendDetector.ts
```

预期输出末尾有:`✅ trendDetector smoke all pass`。

**如果某个 case fail**:先 console.log 出实际 score,对照 spec §2 的公式手算一遍确认是 smoke case 构造错了还是实现错了。常见错因:
- gap 用了 `>=` 而不是 `>`(spec 写的是 `>`)
- vwap 控制力把"平价"(close == vwap)算进了 longCount
- RVOL 对 turnover 求和而不是 volume

修完再跑,直到全部 pass。

- [ ] **Step 3:commit**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
git add src/backtest/smokeTrendDetector.ts
git commit -m "$(cat <<'EOF'
test: trendDetector smoke 验证脚本(5 指标 + precompute)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5:`strategy.config.ts` 加 `enableTrendDetector` 字段

**Files:**
- Modify: `src/config/strategy.config.ts:99-104`

- [ ] **Step 1:编辑 filters 块**

把现有:

```ts
  filters: {
    enableRsiFilter: false,
    enableVolumeFilter: false,
    enableEntryPhaseFilter: false,
    enableIndexTrendFilter: false,
  },
```

改为:

```ts
  filters: {
    enableRsiFilter: false,
    enableVolumeFilter: false,
    enableEntryPhaseFilter: false,
    enableIndexTrendFilter: false,
    //   - enableTrendDetector   : 09:45 趋势日评分门控(见 src/core/trendDetector.ts)
    enableTrendDetector: false,
  },
```

同时要把上方的注释块也更新,把 `filters` 注释中"入场过滤总开关"那一段的列表补上 trend detector:

找到文件中这一段(约 85–98 行):

```ts
  //   - enableRsiFilter        : RSI 阈值 (rsiBuyThreshold / rsiSellThreshold)
  //   - enableVolumeFilter     : 量比阈值 (volumeEntryThreshold)
  //   - enableEntryPhaseFilter : 分时段 "价格段 vs 主段" 规则 (entryFilterSchedule)
  //                              false 时 = 整天只看价格突破 (loose)
  //                              true  时 = 早盘/尾盘价格段、主段严格
  //                              注意:开关只影响 RSI/量比是否在"主段"被校验,
  //                                    只有当 enableRsiFilter 或 enableVolumeFilter
  //                                    同时为 true 时才有实际过滤行为
  //   - enableIndexTrendFilter : 指数斜率方向门控 (indexTrendFilter.*)
```

在 `enableIndexTrendFilter` 那一行后面加:

```ts
  //   - enableIndexTrendFilter : 指数斜率方向门控 (indexTrendFilter.*)
  //   - enableTrendDetector    : 09:45 趋势日评分门控 (src/core/trendDetector.ts)
  //                              <60 分的票当日禁开仓; 只在回测 runner 里生效,
  //                              实盘侧未接入
```

- [ ] **Step 2:验证 import 没问题**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only -e "const c = require('./src/config/strategy.config').default; console.log(c.filters);"
```

预期输出里包含 `enableTrendDetector: false`。

- [ ] **Step 3:commit**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
git add src/config/strategy.config.ts
git commit -m "$(cat <<'EOF'
feat: strategy.config.filters 新增 enableTrendDetector(默认关)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6:`BacktestTrade` 加 `entryDayScore` 字段

**Files:**
- Modify: `src/backtest/types.ts`

- [ ] **Step 1:编辑 BacktestTrade**

把现有的 `BacktestTrade` 接口:

```ts
/** 单笔回测成交记录。 */
export interface BacktestTrade {
    symbol: string;
    side: 'Buy' | 'Sell';
    entryTimestamp: number;
    entryPrice: number;
    exitTimestamp: number;
    exitPrice: number;
    exitReason: 'TP' | 'SL' | 'ForceClose';
    /** 开仓时的初始风险(= |entry - stop|),用于计算 R multiple */
    initialRisk: number;
    rMultiple: number;
    /**
     * 开仓时的时段标签:
     *   early – 早盘只看价格段
     *   main  – 主交易段(带 RSI/量比)
     *   late  – 尾盘只看价格段
     */
    phaseAtEntry: 'early' | 'main' | 'late' | 'unknown';
    /** 出场所在 bar 内是否同时触及 TP 和 SL(仅 fixed 模式有意义) */
    ambiguousExit: boolean;
}
```

在 `ambiguousExit` 后面加一行:

```ts
    ambiguousExit: boolean;
    /**
     * 入场当日该票的趋势日评分(0–100)。null 表示:
     *   - 该交易日处于 RVOL 预热期(前 ~20 天)或其他 baseline 缺失情况
     *   - 或 detector 模块本身关闭(runner 运行时没有填)
     * 旧 result json 里不存在此字段,读脚本应用 `t.entryDayScore ?? null` 兼容。
     */
    entryDayScore: number | null;
}
```

- [ ] **Step 2:语法验证**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' \
  npx ts-node --transpile-only -e "require('./src/backtest/types.ts'); console.log('ok');"
```

预期:`ok`

**不 commit**:这一步本身不可用,要 runner 改完一起 commit(因为 runner 的 `trades.push` 里必须同时提供这个字段,否则 TS 报错)。下一个 task 完成后合并 commit。

---

## Task 7:runner 预计算 trend baseline + firstIntradayBarIndex

**Files:**
- Modify: `src/backtest/runner.ts`

这个 task 只做"预计算阶段" —— 在现有 `atrByDayBySymbol` 计算处旁边加上 trend 相关的预计算。

- [ ] **Step 1:导入 trendDetector**

在文件顶部的 import 块(第 36–53 行附近),现有 imports 之后加:

```ts
import {
    precomputeTrendBaselinesForSymbol,
    scoreTrendDay,
    TrendBaseline,
    TrendScore,
    TREND_SCORE_THRESHOLD,
    OPENING_WINDOW_MINUTES,
} from '../core/trendDetector';
```

- [ ] **Step 2:在 `runBacktest` 里加预计算**

找到这段(大约 345–351 行):

```ts
    // 日线 ATR 预计算
    const atrByDayBySymbol: Record<string, Record<string, number | null>> = {};
    for (const { symbol, bars } of allData) {
        const days = aggregateDaily(bars);
        atrByDayBySymbol[symbol] = precomputeAtrByDay(days);
    }
    const atrMap: Record<string, number> = {};
```

在这段**之后**加:

```ts
    // Trend detector 预计算(和 ATR 预计算同一位置,职责对称)
    // baselineBySymbol[symbol][dayKey] = TrendBaseline | null
    // firstIntradayBarIndexBySymbol[symbol][dayKey] = 该 symbol 在当日首根 bar 的 index
    //                                                 (在 allData[i].bars 里的位置)
    // 这两个一起让主循环在 "09:45 触发"时 O(1) 查表,不重扫 bars
    const trendBaselineBySymbol: Record<string, Record<string, TrendBaseline | null>> = {};
    const firstIntradayBarIndexBySymbol: Record<string, Record<string, number>> = {};
    for (const { symbol, bars } of allData) {
        trendBaselineBySymbol[symbol] = precomputeTrendBaselinesForSymbol(bars);
        const m: Record<string, number> = {};
        for (let i = 0; i < bars.length; i++) {
            const k = new Date(bars[i].timestamp).toISOString().slice(0, 10);
            if (m[k] === undefined) m[k] = i;
        }
        firstIntradayBarIndexBySymbol[symbol] = m;
    }
    console.log(`[runner] 预计算 trend baseline 完成`);
```

- [ ] **Step 3:语法验证**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' \
  npx ts-node --transpile-only -e "require('./src/backtest/runner.ts')" 2>&1 | head -10
```

这个命令会尝试加载 runner(包括 longport 初始化),可能会失败在别的地方但**不应该**有 TypeScript 编译错 —— 看输出里有没有 `TS` 开头的错误。如果只有运行时错误(比如 longport 凭证问题)但没有类型错,就是 OK 的。

更精确的方法:

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
npx tsc --noEmit src/backtest/runner.ts 2>&1 | grep -E "error TS" | head -20
```

(`tsc` 会编译不会执行,只输出类型错误)预期:无 `error TS` 输出,或只有和本 task 无关的既有错误。

- [ ] **Step 4:暂不 commit**,继续 Task 8 一起 commit(类型系统要求 Position 改完才能无错)

---

## Task 8:runner 主循环 —— 09:45 打分、Position 扩字段

**Files:**
- Modify: `src/backtest/runner.ts`

- [ ] **Step 1:给 `Position` interface 加字段**

找到现有(约 225–236 行):

```ts
interface Position {
    symbol: string;
    side: OrderSide;
    entryPrice: number;
    entryTimestamp: number;
    stopPrice: number;
    tpPrice: number | null; // fixed 模式专有
    stopDistance: number | null; // trailing 模式专有
    initialRisk: number;
    phaseAtEntry: BacktestTrade['phaseAtEntry'];
}
```

末尾加一个字段:

```ts
interface Position {
    symbol: string;
    side: OrderSide;
    entryPrice: number;
    entryTimestamp: number;
    stopPrice: number;
    tpPrice: number | null; // fixed 模式专有
    stopDistance: number | null; // trailing 模式专有
    initialRisk: number;
    phaseAtEntry: BacktestTrade['phaseAtEntry'];
    /** 入场当日该票的评分(detector 关闭时记录的也是打分结果,null 表示没基线) */
    entryDayScore: number | null;
}
```

- [ ] **Step 2:`closeTrade` 写入 trade log**

找到现有 `closeTrade` 函数(约 392–418 行),在 `trades.push({...})` 里加 `entryDayScore: pos.entryDayScore` 字段。改后:

```ts
        trades.push({
            symbol: pos.symbol,
            side: pos.side === OrderSide.Buy ? 'Buy' : 'Sell',
            entryTimestamp: pos.entryTimestamp,
            entryPrice: pos.entryPrice,
            exitTimestamp: exitTs,
            exitPrice,
            exitReason: reason,
            initialRisk: pos.initialRisk,
            rMultiple,
            phaseAtEntry: pos.phaseAtEntry,
            ambiguousExit,
            entryDayScore: pos.entryDayScore,
        });
```

- [ ] **Step 3:声明 dayScoreMap 状态变量并处理日切**

在主循环前(约 423 行,`let processedTicks = 0;` 之前)加:

```ts
    // Trend detector 每日状态:symbol -> TrendScore(打过分) | null(没基线) | undefined(未打分)
    const dayScoreMap: Record<string, TrendScore | null | undefined> = {};
    const trendDetectorEnabled = config.filters.enableTrendDetector;
```

在主循环的日切逻辑里(现有约 429–439 行),把 `dayScoreMap` 也清空。现有代码:

```ts
        if (dayKey !== currentDayKey) {
            currentDayKey = dayKey;
            for (const { symbol } of allData) {
                const v = atrByDayBySymbol[symbol]?.[dayKey];
                if (v !== null && v !== undefined) atrMap[symbol] = v;
            }
            // 新交易日:清空所有状态(前一天的残留不会带过来)
            strategy.states = {};
            for (const sym of Object.keys(positions)) delete positions[sym];
            for (const sym of Object.keys(pendingEntry)) delete pendingEntry[sym];
        }
```

在最后两行 delete 之后加:

```ts
            for (const sym of Object.keys(dayScoreMap)) delete dayScoreMap[sym];
```

- [ ] **Step 4:在"逐标的处理"开头加 09:45 打分逻辑**

找到现有"逐标的处理"循环(约 462 行):

```ts
        // 逐标的处理
        for (const { symbol, index } of tickMap[ts]) {
            // 先推进 market 让 getQuote 反映当前 bar(注意:是本 bar 收盘后的累积状态)
            market.advanceTo(symbol, index);
            const currBar = market.getBarAt(symbol, index)!;
```

在 `const currBar = ...` 之后、`// ========== 1. 已有持仓:先处理出场 ==========` 之前加:

```ts
            // ========== 0. Trend detector 09:45 打分(每票每日一次)==========
            // 条件:minutesSinceOpen >= 15 且该票今日还没打分过
            // 无论 detector 开关都要打分 —— 关闭时只是不用它做门控,但要写进 trade log
            if (dayScoreMap[symbol] === undefined && minutesSinceOpen >= OPENING_WINDOW_MINUTES) {
                const baseline = trendBaselineBySymbol[symbol]?.[dayKey];
                if (!baseline) {
                    dayScoreMap[symbol] = null; // 没基线 → 放行
                } else {
                    const firstIdx = firstIntradayBarIndexBySymbol[symbol]?.[dayKey];
                    if (firstIdx === undefined) {
                        dayScoreMap[symbol] = null;
                    } else {
                        const win: SerializedBar[] = [];
                        for (let k = 0; k < OPENING_WINDOW_MINUTES; k++) {
                            const b = market.getBarAt(symbol, firstIdx + k);
                            if (b) win.push(b);
                        }
                        dayScoreMap[symbol] =
                            win.length === OPENING_WINDOW_MINUTES
                                ? scoreTrendDay(win, baseline)
                                : null;
                    }
                }
            }
```

**注意**:这里用到了外层循环里已经算出的 `minutesSinceOpen` 变量(来自 `const progress = (timeGuard.getTradeProgressMinutes() as any); const minutesSinceOpen = progress.minutesSinceOpen;`),这个变量在逐标的循环里是**通用的**(不因 symbol 变化),可以直接用。如果 grep 不到,说明你在错的位置插代码了 —— 应该在"逐标的处理 for 循环里,`market.advanceTo` 和 `currBar` 读取之后"这个 scope。

- [ ] **Step 5:在创建 Position 的地方填 entryDayScore**

找到现有创建 Position 的地方(约 556 行左右的 `const newPos: Position = {...}`)。有两处,都要改:

第一处,在 "2. 没有持仓 & 有待成交入场" 分支里:

```ts
                    const newPos: Position = {
                        symbol,
                        side,
                        entryPrice,
                        entryTimestamp: ts,
                        stopPrice,
                        tpPrice,
                        stopDistance,
                        initialRisk,
                        phaseAtEntry: getPhaseAtTs(ts),
                    };
```

改为:

```ts
                    const scoreNow = dayScoreMap[symbol];
                    const newPos: Position = {
                        symbol,
                        side,
                        entryPrice,
                        entryTimestamp: ts,
                        stopPrice,
                        tpPrice,
                        stopDistance,
                        initialRisk,
                        phaseAtEntry: getPhaseAtTs(ts),
                        entryDayScore:
                            scoreNow && typeof scoreNow === 'object'
                                ? scoreNow.total
                                : null,
                    };
```

(`scoreNow` 可能是 `undefined`(还没打分)/ `null`(没基线)/ `TrendScore` 对象。只有是对象时才取 `.total`,其他情况写 null。)

- [ ] **Step 6:信号分支加 detector 门控**

找到现有"3. 信号检测"分支末尾(约 670–674 行):

```ts
                    const dir = strategy.canOpen(
                        symbol,
                        preBars as any,
                        vwap,
                        a,
                        rsi,
                        volumeRatio,
                        indexSlope
                    );
                    if (dir) {
                        pendingEntry[symbol] = dir;
                    }
```

改为:

```ts
                    const dir = strategy.canOpen(
                        symbol,
                        preBars as any,
                        vwap,
                        a,
                        rsi,
                        volumeRatio,
                        indexSlope
                    );
                    if (dir) {
                        if (trendDetectorEnabled) {
                            const scoreInfo = dayScoreMap[symbol];
                            // undefined = 09:45 前未打分 → 禁止
                            // null      = 没基线(预热期)→ 放行
                            // object    = 有分数,按门槛判断
                            if (scoreInfo === null) {
                                pendingEntry[symbol] = dir;
                            } else if (
                                scoreInfo &&
                                typeof scoreInfo === 'object' &&
                                scoreInfo.total >= TREND_SCORE_THRESHOLD
                            ) {
                                pendingEntry[symbol] = dir;
                            }
                            // 其余情况(undefined 或分数 < 阈值)→ 不设置 pendingEntry,信号被拦截
                        } else {
                            pendingEntry[symbol] = dir;
                        }
                    }
```

- [ ] **Step 7:类型验证**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
npx tsc --noEmit src/backtest/runner.ts 2>&1 | grep -E "error TS" | head -20
```

预期:没有新引入的 error TS。如果报 `Property 'entryDayScore' is missing` 说明某处 Position 没填,对照 Step 5。

- [ ] **Step 8:跑一次 smoke 回测(detector 关闭)确认 runner 无回归**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts smoke_task8 trailing 2>&1 | tail -15
```

预期:跑完,trades 数和 baseline_loose_sl010 (59015 左右) 相近(可能略有不同因为 ATR/等是否不稳定)。关键:**不报错、能写 json**。

快速看一下 trade log 里有没有 entryDayScore 字段:

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
node -e "const r = require('./data/backtest/results/smoke_task8.json'); console.log('fields:', Object.keys(r.trades[0])); console.log('sample scores:', r.trades.slice(0, 5).map(t => t.entryDayScore));"
```

预期:`fields` 列表包含 `entryDayScore`。`sample scores` 前 5 个会是 `null`(因为样本头部在预热期)或小数字。

- [ ] **Step 9:commit Task 6 + 7 + 8**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
git add src/backtest/types.ts src/backtest/runner.ts
git commit -m "$(cat <<'EOF'
feat: runner 集成 trend detector(09:45 打分 + 入场门控)

- BacktestTrade.entryDayScore 新字段,不论开关始终记录
- runBacktest 预计算 trendBaselineBySymbol + firstIntradayBarIndexBySymbol
- 主循环:minutesSinceOpen >= 15 时对每票打一次分(dayScoreMap)
- canOpen 返回 dir 后,若 enableTrendDetector 则按分数门控
- Position 扩字段 entryDayScore,closeTrade 写入 trade log

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9:runner CLI flag `--filter-trend`

**Files:**
- Modify: `src/backtest/runner.ts`(CLI 段和 RunnerOptions)

- [ ] **Step 1:`RunnerOptions.filters` 类型扩展**

找到(约 115–120 行):

```ts
    filters?: Partial<{
        enableRsiFilter: boolean;
        enableVolumeFilter: boolean;
        enableEntryPhaseFilter: boolean;
        enableIndexTrendFilter: boolean;
    }>;
```

改为:

```ts
    filters?: Partial<{
        enableRsiFilter: boolean;
        enableVolumeFilter: boolean;
        enableEntryPhaseFilter: boolean;
        enableIndexTrendFilter: boolean;
        enableTrendDetector: boolean;
    }>;
```

- [ ] **Step 2:CLI 解析加 `--filter-trend`**

找到(约 777–785 行):

```ts
    const filterOverride: RunnerOptions['filters'] = {};
    const rsi = parseFilterFlag('filter-rsi');
    const vol = parseFilterFlag('filter-volume');
    const phase = parseFilterFlag('filter-entry-phase');
    const idx = parseFilterFlag('filter-index');
    if (rsi !== undefined) filterOverride.enableRsiFilter = rsi;
    if (vol !== undefined) filterOverride.enableVolumeFilter = vol;
    if (phase !== undefined) filterOverride.enableEntryPhaseFilter = phase;
    if (idx !== undefined) filterOverride.enableIndexTrendFilter = idx;
```

在末尾加:

```ts
    const trend = parseFilterFlag('filter-trend');
    if (trend !== undefined) filterOverride.enableTrendDetector = trend;
```

- [ ] **Step 3:Usage 字符串加 flag 提示**

找到(约 761–766 行):

```ts
        console.error(
            'Usage: runner.ts <label> <trailing|fixed> [tp] [sl] [SLFirst|TPFirst]\n' +
                '  [--stop-atr=N]\n' +
                '  [--filter-rsi=on|off] [--filter-volume=on|off]\n' +
                '  [--filter-entry-phase=on|off] [--filter-index=on|off]\n'
        );
```

改为:

```ts
        console.error(
            'Usage: runner.ts <label> <trailing|fixed> [tp] [sl] [SLFirst|TPFirst]\n' +
                '  [--stop-atr=N]\n' +
                '  [--filter-rsi=on|off] [--filter-volume=on|off]\n' +
                '  [--filter-entry-phase=on|off] [--filter-index=on|off]\n' +
                '  [--filter-trend=on|off]\n'
        );
```

- [ ] **Step 4:在 `runBacktest` 保存/恢复 filters 的现有代码不用改**

现有代码(约 290–293 行):

```ts
    // 临时覆盖 filters 开关(canOpen 里每个过滤分支都读 config.filters)
    const savedFilters = { ...config.filters };
    if (opts.filters) {
        config.filters = { ...config.filters, ...opts.filters };
    }
```

`{...config.filters}` 和 `{...config.filters, ...opts.filters}` 都会**自动包含** `enableTrendDetector` 字段,所以无需改动。

但**注意**:`trendDetectorEnabled` 在 Task 8 里被读为 `const trendDetectorEnabled = config.filters.enableTrendDetector;`,**这一行必须在** `config.filters = { ...config.filters, ...opts.filters }` **之后** —— 检查一下顺序。如果 Task 8 加在"主循环前"的位置,它是在 filters override 之后的,OK。如果不确定,验证方法:用 `grep -n 'trendDetectorEnabled' src/backtest/runner.ts` 看它的行号是否大于 `savedFilters = { ...config.filters }` 的行号。

- [ ] **Step 5:Smoke 验证 CLI flag 工作**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts smoke_trend_off trailing --filter-trend=off 2>&1 | tail -10
```

预期:runner 输出里的 `filters=...` 显示 `"enableTrendDetector":false`,跑完 OK。

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts smoke_trend_on trailing --filter-trend=on 2>&1 | tail -10
```

预期:`filters=...` 里显示 `"enableTrendDetector":true`,跑完 OK。**trades 数应该显著少于 smoke_trend_off**(因为 detector 在拦截 < 60 分的信号 + 09:30–09:44 区间)。记下这两个数字,后面用作一致性检查。

- [ ] **Step 6:commit**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
git add src/backtest/runner.ts
git commit -m "$(cat <<'EOF'
feat: runner CLI 新增 --filter-trend=on|off

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10:新建 `reportTrend.ts` 生成对比报告

**Files:**
- Create: `src/backtest/reportTrend.ts`

- [ ] **Step 1:创建脚本**

写入文件完整内容:

```typescript
/**
 * 趋势日 detector 实验报告生成器。
 *
 * 读 data/backtest/results/baseline_loose_sl010.json (对照)
 *   + data/backtest/results/trend_recordonly_sl010.json (detector 关但记录分数)
 *   + data/backtest/results/trend_score60_sl010.json   (detector 开)
 *
 * 输出 data/backtest/report_trend.md,包含:
 *   1. 主表(A + B)  : trades / winRate / avgR / expectancy / cumR / maxDD / cumR÷maxDD
 *   2. 分数分组表(C): 读 trend_recordonly,按 entryDayScore 分桶统计
 *   3. 09:30–09:44 时段贡献表:量化方案 A"禁前 15 分钟"的代价
 *
 * 跑法:
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/reportTrend.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { BacktestResult, BacktestTrade } from './types';

const RESULT_DIR = path.resolve(process.cwd(), 'data/backtest/results');
const REPORT_PATH = path.resolve(process.cwd(), 'data/backtest/report_trend.md');

function loadResult(label: string): BacktestResult | null {
    const p = path.join(RESULT_DIR, `${label}.json`);
    if (!fs.existsSync(p)) {
        console.warn(`[reportTrend] 缺失 ${p},跳过`);
        return null;
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

interface Summary {
    label: string;
    trades: number;
    winRate: number;
    avgR: number;
    expectancy: number;
    cumR: number;
    maxDD: number;
    ratio: number; // cumR / maxDD
}

function summarize(label: string, trades: BacktestTrade[]): Summary {
    const n = trades.length;
    if (n === 0) {
        return { label, trades: 0, winRate: 0, avgR: 0, expectancy: 0, cumR: 0, maxDD: 0, ratio: 0 };
    }
    let sumR = 0;
    let wins = 0;
    for (const t of trades) {
        sumR += t.rMultiple;
        if (t.rMultiple > 0) wins++;
    }
    const cumR = sumR;
    const avgR = sumR / n;
    const winRate = wins / n;
    const expectancy = avgR;

    // 最大回撤:按 entryTimestamp 排序后累计 R 曲线的最大 drawdown
    const sorted = [...trades].sort((a, b) => a.entryTimestamp - b.entryTimestamp);
    let peak = 0;
    let acc = 0;
    let maxDD = 0;
    for (const t of sorted) {
        acc += t.rMultiple;
        if (acc > peak) peak = acc;
        const dd = peak - acc;
        if (dd > maxDD) maxDD = dd;
    }
    const ratio = maxDD > 0 ? cumR / maxDD : 0;
    return { label, trades: n, winRate, avgR, expectancy, cumR, maxDD, ratio };
}

function fmt(n: number, d = 2): string {
    if (!Number.isFinite(n)) return '-';
    return n.toFixed(d);
}

function pct(n: number): string {
    return (n * 100).toFixed(1) + '%';
}

function renderSummaryTable(rows: Summary[]): string {
    const header = '| label | trades | winRate | avgR | expectancy | cumR | maxDD | cumR÷maxDD |';
    const sep = '|---|---|---|---|---|---|---|---|';
    const lines = [header, sep];
    for (const r of rows) {
        lines.push(
            `| ${r.label} | ${r.trades} | ${pct(r.winRate)} | ${fmt(r.avgR, 4)} | ${fmt(r.expectancy, 4)} | ${fmt(r.cumR, 1)} | ${fmt(r.maxDD, 1)} | ${fmt(r.ratio, 2)} |`
        );
    }
    return lines.join('\n');
}

// ============================================================
// 分数分组表(C)
// ============================================================
interface ScoreBucket {
    label: string;
    match: (s: number | null) => boolean;
}

const SCORE_BUCKETS: ScoreBucket[] = [
    { label: 'null (无基线)', match: s => s === null },
    { label: '0 ≤ s < 30', match: s => s !== null && s >= 0 && s < 30 },
    { label: '30 ≤ s < 60', match: s => s !== null && s >= 30 && s < 60 },
    { label: '60 ≤ s < 80', match: s => s !== null && s >= 60 && s < 80 },
    { label: '80 ≤ s ≤ 100', match: s => s !== null && s >= 80 && s <= 100 },
];

function renderBucketTable(trades: BacktestTrade[]): string {
    const lines = ['| 分数桶 | trades | winRate | avgR | expectancy | cumR |', '|---|---|---|---|---|---|'];
    for (const bucket of SCORE_BUCKETS) {
        const subset = trades.filter(t => bucket.match(t.entryDayScore ?? null));
        const s = summarize(bucket.label, subset);
        lines.push(
            `| ${bucket.label} | ${s.trades} | ${pct(s.winRate)} | ${fmt(s.avgR, 4)} | ${fmt(s.expectancy, 4)} | ${fmt(s.cumR, 1)} |`
        );
    }
    return lines.join('\n');
}

// ============================================================
// 09:30–09:44 时段贡献(评估方案 A 代价)
// ============================================================
function renderEarlyWindowTable(trades: BacktestTrade[]): string {
    // minutesSinceOpen < 15 的 trade
    function minutesSinceOpen(ts: number): number {
        const dtf = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
        });
        const parts = dtf.formatToParts(new Date(ts));
        let h = 0, m = 0;
        for (const p of parts) {
            if (p.type === 'hour') h = Number(p.value);
            if (p.type === 'minute') m = Number(p.value);
        }
        const now = h * 60 + m;
        const open = 9 * 60 + 30;
        return now - open;
    }

    const early = trades.filter(t => minutesSinceOpen(t.entryTimestamp) < 15);
    const late = trades.filter(t => minutesSinceOpen(t.entryTimestamp) >= 15);
    const lines = [
        '| 区段 | trades | winRate | avgR | cumR | 占比 |',
        '|---|---|---|---|---|---|',
    ];
    const total = trades.length || 1;
    for (const [label, subset] of [['09:30–09:44', early], ['09:45–close', late]] as const) {
        const s = summarize(label, subset);
        lines.push(
            `| ${label} | ${s.trades} | ${pct(s.winRate)} | ${fmt(s.avgR, 4)} | ${fmt(s.cumR, 1)} | ${pct(subset.length / total)} |`
        );
    }
    return lines.join('\n');
}

// ============================================================
// 主
// ============================================================
function main() {
    const baseline = loadResult('baseline_loose_sl010');
    const recordOnly = loadResult('trend_recordonly_sl010');
    const trendOn = loadResult('trend_score60_sl010');

    const sections: string[] = [];
    sections.push('# 趋势日 Detector 实验报告\n');
    sections.push(`生成时间:${new Date().toISOString()}\n`);
    sections.push('Spec: `docs/superpowers/specs/2026-04-14-trend-detector-design.md`\n');

    // 1. 主表
    sections.push('## 1. 主表(A + B)\n');
    const rows: Summary[] = [];
    if (baseline) rows.push(summarize('baseline_loose_sl010', baseline.trades));
    if (recordOnly) rows.push(summarize('trend_recordonly_sl010', recordOnly.trades));
    if (trendOn) rows.push(summarize('trend_score60_sl010', trendOn.trades));
    sections.push(renderSummaryTable(rows));
    sections.push('');
    sections.push('**成功标准**:`trend_score60_sl010` 的 cumR÷maxDD ≥ `baseline_loose_sl010` × 90%\n');

    // 2. 分数分组表
    sections.push('## 2. 分数分组(C)\n');
    if (recordOnly) {
        sections.push('**数据源**:`trend_recordonly_sl010`(门控关,所有信号都成交,记录分数)\n');
        sections.push(renderBucketTable(recordOnly.trades));
    } else {
        sections.push('(缺失 trend_recordonly_sl010.json)\n');
    }
    sections.push('');

    // 3. 09:30–09:44 时段贡献
    sections.push('## 3. 09:30–09:44 时段贡献(评估方案 A 禁开仓代价)\n');
    if (baseline) {
        sections.push('### baseline_loose_sl010\n');
        sections.push(renderEarlyWindowTable(baseline.trades));
    }
    sections.push('');
    if (recordOnly) {
        sections.push('### trend_recordonly_sl010\n');
        sections.push(renderEarlyWindowTable(recordOnly.trades));
    }
    sections.push('');

    fs.writeFileSync(REPORT_PATH, sections.join('\n'));
    console.log(`[reportTrend] 已写入 ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();
```

- [ ] **Step 2:验证 `reportTrend.ts` 能加载(暂不跑实际实验,数据还没有)**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
npx tsc --noEmit src/backtest/reportTrend.ts 2>&1 | grep -E "error TS" | head -20
```

预期:无新 TS 错误。

- [ ] **Step 3:commit**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
git add src/backtest/reportTrend.ts
git commit -m "$(cat <<'EOF'
feat: reportTrend.ts —— 趋势日 detector 实验报告生成器

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11:跑三组实验

**Files:**
- 无代码改动,只跑 runner

前置条件:`data/backtest/raw/` 下的所有 symbol + QQQ 数据已在,并且 Task 8/9 已验证 runner 能跑通。

- [ ] **Step 1:跑 `trend_recordonly_sl010`(detector 关,记录分数)**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts trend_recordonly_sl010 trailing 2>&1 | tail -25
```

预期:3–6 分钟,输出 `[runner] 完成 trend_recordonly_sl010 交易数=XXXXX`。这个交易数应该和现有 `baseline_loose_sl010`(约 59015)**几乎一样**(数据、逻辑都没变化,只是多记录一个字段)。

如果这两个数字差距 > 1%,说明 Task 8 的改动引入了意外的行为变化 —— 停下来 grep `entryDayScore` 或对照 diff,调查原因。

- [ ] **Step 2:验证 trend_recordonly 的分数字段有内容**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
node -e "
const r = require('./data/backtest/results/trend_recordonly_sl010.json');
const scores = r.trades.map(t => t.entryDayScore);
const nulls = scores.filter(s => s === null).length;
const nonNulls = scores.filter(s => s !== null);
const avg = nonNulls.reduce((a, b) => a + b, 0) / Math.max(1, nonNulls.length);
console.log('total trades:', r.trades.length);
console.log('null scores:', nulls);
console.log('non-null count:', nonNulls.length);
console.log('avg non-null score:', avg.toFixed(2));
console.log('min/max:', Math.min(...nonNulls), Math.max(...nonNulls));
"
```

预期:
- non-null 占多数(样本头 20 天是 null,剩下的有分数)
- avg 在 20–60 之间(具体看样本,没有固定期待值)
- min 接近 0,max 接近或等于 100

如果全部是 null,说明 baseline 预计算挂了 —— 去 trendDetector.ts 的 `precomputeTrendBaselinesForSymbol` 里加 console.log 调试。

- [ ] **Step 3:跑 `trend_score60_sl010`(detector 开)**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts trend_score60_sl010 trailing --filter-trend=on 2>&1 | tail -25
```

预期:3–6 分钟,输出的 `filters=...` 里有 `enableTrendDetector:true`,交易数显著少于 recordonly(可能 1/3 到 1/2)。

- [ ] **Step 4:确认 baseline_loose_sl010 还在,是有效对照组**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
node -e "
const r = require('./data/backtest/results/baseline_loose_sl010.json');
console.log('baseline trades:', r.trades.length);
console.log('entryDayScore field:', r.trades[0].entryDayScore);
"
```

预期:trades 数是 59015 左右,`entryDayScore` 为 `undefined`(旧文件没这个字段)。reportTrend.ts 使用 `t.entryDayScore ?? null` 方式读,应该兼容。

---

## Task 12:生成报告并 review

**Files:**
- 跑 `reportTrend.ts`,查看 `data/backtest/report_trend.md`

- [ ] **Step 1:跑 reportTrend**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/reportTrend.ts
```

预期:输出 `[reportTrend] 已写入 data/backtest/report_trend.md`

- [ ] **Step 2:查看报告**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
cat data/backtest/report_trend.md
```

人工 review 三张表:

**主表检查**(回答成功标准):
- `trend_score60_sl010.ratio >= baseline_loose_sl010.ratio * 0.9`?
- 如果是 → detector 在风险调整层面不差于 baseline,继续看分组表决定是否"有增益"
- 如果否 → detector 砍掉了有价值的交易,需要调整(不在本 plan 范围,作为 v2 讨论)

**分组表检查**(回答评分是否有区分度):
- ≥ 80 分桶的 expectancy 是否显著大于 < 30 分桶的?
- cumR 分布是否往高分桶倾斜?
- 如果有区分度 → 评分公式有信息量
- 如果没区分度 → 评分公式本身失败,需要换指标或换阈值(不在本 plan 范围)

**09:30–09:44 时段表**:
- 这段时间的 cumR 占全天 cumR 的比例是多少?
- 如果是正值且占比大(例如 > 20%),方案 A 的"禁前 15 分钟"代价可能抵消 detector 的增益

**这一步不需要自动化判断**,只要报告生成出来,由人工(用户)决定结论。

- [ ] **Step 3:不 commit 报告文件**(它是 derived data,留在工作区供讨论)

`data/backtest/report_trend.md` 和 `data/backtest/results/trend_*.json` 都不进 git,和现有 `report.md` / `results/*.json` 的惯例一致(看 `.gitignore` 应该已经忽略了)。

如果 `.gitignore` 没忽略,这一步什么都不做,跳过。

---

## Task 13:更新 `references/BACKTEST.md` 文档

**Files:**
- Modify: `references/BACKTEST.md`

- [ ] **Step 1:§3.2 CLI 签名段补 flag**

找到文档中的 "§3.2 跑回测" 的 CLI 签名部分,把 flag 列表里加一行 `[--filter-trend=on|off]`。

现有:

```
**--flag 参数**(任选覆盖 `config.stopAtrRatio` / `config.filters.*`,未指定则沿用 config):
- `--stop-atr=N`:trailing 模式的初始止损宽度(ATR 倍数),默认读 `config.stopAtrRatio`
- `--filter-rsi=on|off`:启用/禁用 RSI 阈值过滤
- `--filter-volume=on|off`:启用/禁用 量比阈值过滤
- `--filter-entry-phase=on|off`:启用/禁用 分时段 "价格段 vs 主段" 规则
- `--filter-index=on|off`:启用/禁用 指数斜率方向门控
```

末尾加一行:

```
- `--filter-trend=on|off`:启用/禁用 趋势日评分门控(见 `src/core/trendDetector.ts`、`docs/superpowers/specs/2026-04-14-trend-detector-design.md`)
```

- [ ] **Step 2:§3.2 用法举例补一条**

在现有举例末尾加:

```bash
# 趋势日 detector(09:45 按分数门控,< 60 分禁开仓)
runner.ts trend_score60_sl010 trailing --filter-trend=on
```

- [ ] **Step 3:§6 结论段补"实验待填"占位**

在"§6. 主要结论"的末尾或合适位置,加一小节:

```markdown
### 批次 B:趋势日 Detector 实验(2026-04-14 开始)

Spec: `docs/superpowers/specs/2026-04-14-trend-detector-design.md`
Plan: `docs/superpowers/plans/2026-04-14-trend-detector.md`

已跑:
- `trend_recordonly_sl010`:detector 关但记录分数
- `trend_score60_sl010`:detector 开,门槛 60

结果文件:`data/backtest/results/trend_*.json`,对比报告:`data/backtest/report_trend.md`

**待补**:跑完后把主表 + 分组表的关键数字抄进来,和 baseline_loose_sl010 对比。
```

- [ ] **Step 4:commit**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
git add references/BACKTEST.md
git commit -m "$(cat <<'EOF'
docs: BACKTEST.md 补 --filter-trend CLI + 批次 B 实验占位

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Plan Self-Review(写完后执行过的 checklist)

1. **Spec 覆盖**:
   - §2 评分公式 5 个指标 → Task 3 全部实现 + Task 4 smoke 验证 ✓
   - §3.1 trendDetector 模块 → Task 1–3 ✓
   - §3.2.1 runner 预计算 → Task 7 ✓
   - §3.2.2 09:45 打分 → Task 8 Step 4 ✓
   - §3.2.3 信号门控 → Task 8 Step 6 ✓
   - §3.2.4 trade log 扩字段 → Task 6 + Task 8 Step 1/2/5 ✓
   - §3.2.5 CLI flag → Task 9 ✓
   - §3.3 types.ts → Task 6 ✓
   - §3.4 config.ts → Task 5 ✓
   - §3.5 reportTrend.ts → Task 10(含主表 + 分组表 + 时段表) ✓
   - §3.6 BACKTEST.md → Task 13 ✓
   - §4 实验计划 3 组 → Task 11 跑 2 组(baseline 已有) + Task 12 生成报告 ✓
   - §5.1 09:30–09:44 代价评估 → reportTrend 的时段表 + Task 12 Step 2 指导 review ✓
   - §5.4 RVOL 基线的半数门槛 → Task 2 Step 2 `cnt < Math.ceil(RVOL_LOOKBACK_DAYS / 2)` ✓
   - §7 成功标准 → Task 12 Step 2 指导判断 ✓

2. **Placeholder 扫描**:无 "TODO/TBD"、无"写点测试"、无"类似 Task N"。所有代码步骤都有完整代码。

3. **类型一致性**:
   - `TrendBaseline` / `TrendScore` / `TrendScoreDetails` 在 Task 1 定义,Task 2/3/4/7/8 一致使用
   - `entryDayScore: number | null` 在 Task 6 和 Task 8 一致
   - `dayScoreMap: Record<string, TrendScore | null | undefined>` 在 Task 8 Step 3 定义,Step 4/5/6 读取时用"三态判断"一致
   - `TREND_SCORE_THRESHOLD` / `OPENING_WINDOW_MINUTES` 常量在 Task 1 定义,Task 7/8 import 使用 ✓

4. **任务颗粒度**:每个 Task 3–9 个 step,每个 step ≤ 10 分钟。Task 1–9 都有单独 commit(只有 Task 6 因为类型依赖和 Task 7/8 合并 commit)。

---

## 已知风险与逃生舱

1. **`aggregateDailyForTrend` 可能漏算非 intraday 的 bar**:`SerializedBar.tradeSession` 有多个值(Intraday/PreMarket/PostMarket),但 `scoreTrendDay` 的"09:30–09:44 开盘窗口"要的是 intraday。检查点:Task 2 Step 1 的 helper 没有按 `tradeSession` 过滤 —— 如果 raw 数据里混有盘前盘后 bar,这一步就会把它们也算进"当日首根 bar"。**规避**:观察 `data/backtest/raw/COIN.US.json` 的 `bars[0]` 看 `tradeSession` 是不是 0(Intraday)。如果是 0 且只有 intraday,就没问题;如果混合,需要在 `aggregateDailyForTrend` 里先过滤 `tradeSession === 0`(或 `=== TradeSession.Intraday`)。

   **Task 2 Step 1 如何验证**:跑完 Task 4 smoke script 之后,用 node REPL 对 COIN.US 跑一次 precompute,看前几天的 rvolBaseline 是否合理(RVOL 15 分钟窗口的量应该在百万级,不是亿级)。

2. **`tsc --noEmit` 单文件可能报无关错误**:TypeScript 的 `--noEmit` 单文件模式会检查其 import 的所有文件,如果其他文件本来就有 TS 错误(旧代码),我们的 verify 步会误报。**应对**:如果 grep 到 error TS,先对照 runner.ts 的最新 commit 确认它们是不是我们引入的。如果不是,ignore。

3. **smoke script 的 Case 3a 分数可能边界**:RVOL 2.1 / 阈值 2.0 很接近,浮点误差可能把它推到 1.999999 → 0 分。**应对**:Case 3a 只断言"< 60",不断言具体分数,已经留了 buffer。

4. **报告表格的 maxDD 算法偏简**:`summarize()` 用的是"按 entryTimestamp 排序累计 R 曲线",和 `report.ts` 里的算法保持一致(从 `src/backtest/report.ts` 里可以 grep 确认)。如果你想更严格,用 trade 的实现结果时序需要另外建模,v1 不做。

---

## 完成后的产出

- 两个新文件 + 一个 smoke script + 一个 reportTrend.ts + 4 个文件修改
- 两组新回测结果(trend_recordonly_sl010, trend_score60_sl010)
- 一份报告(`data/backtest/report_trend.md`)
- 文档更新(`references/BACKTEST.md`)

预期 commit 数量:约 9 个(Task 1, 2, 3, 4, 5, 8(含 6/7), 9, 10, 13)

/**
 * 趋势日评分系统(Trend Day Detector)
 *
 * 每个交易日 09:35 对每支票打一次分(0–170),分数 >= TREND_SCORE_THRESHOLD 时才允许当日开仓。
 * 本模块是**纯函数**(除 v4c 实验用的 IND9/10/11 动态开关外),不读文件、不调网络、不依赖 longport,方便回测和实盘共用。
 *
 * 指标定义和阈值说明见 references/TREND.md。
 */
import { SerializedBar } from '../backtest/types';
import { atr as ta_atr } from 'technicalindicators';

// ====== 评分阈值 —— 参数集中在此,见 references/TREND.md 每条指标的选型 ======
const GAP_TIERS = [
    { pct: 0.02, score: 25 },
];
const RVOL_TIERS = [
    { v: 2, score: 40 },
    { v: 1.3, score: 20 },
];
// Opening Drive 归零:5 分钟窗口下方向尚未确定,值等同随机。保留结构便于未来恢复。
const DRIVE_TIERS: { atr: number; score: number }[] = [];
// VWAP 控制力:只给 5 分,因为 ratio=1.0 在 5 根 bar 上太容易偶然发生。
const VWAP_FULL_SCORE = 5;
const VWAP_PARTIAL_SCORE = 5;
const VWAP_PARTIAL_RATIO = 0.8;
const RANGE_TIERS = [
    { atr: 1.0, score: 30 },
    { atr: 0.5, score: 15 },
];
// ATR% 底部筛选:过滤跨日波动率 < 3% 的死水票。单档足够。
const ATR_PCT_TIERS = [
    { pct: 0.03, score: 15 },
];
// 指标九:今日开盘 5min 日内百分比波动 (high-low)/open
const TODAY_RANGE_PCT_TIERS = [
    { pct: 0.008, score: 10 },
];
// 指标十:昨日单日日内百分比波动 (prevDay.high-prevDay.low)/prevClose
const PRIOR_DAY_RANGE_PCT_TIERS = [
    { pct: 0.025, score: 10 },
];
// 指标十一:前 TREND_RANGE_PCT_AVG_LOOKBACK 天日内 (high-low)/close 均值
const PREV_RANGE_PCT_AVG_TIERS = [
    { pct: 0.025, score: 10 },
];

// ====== v4c 调参实验用的动态开关(默认保持生产行为) ======

/** 指标九(今日开盘 Range%)是否启用 */
let IND9_ENABLED = true;
/** 指标十(昨日 Range%)是否启用 */
let IND10_ENABLED = true;

/** 指标十一模式:forward = 高波动给分(当前),reverse = 低波动给分,range = 区间给分,off = 禁用 */
export type Ind11Mode = 'forward' | 'reverse' | 'range' | 'off';
let IND11_MODE: Ind11Mode = 'forward';

// 指标十一反向:prevRangePctAvg7 < 阈值给分(低波动更优)
const PREV_RANGE_PCT_AVG_REVERSE_TIERS = [
    { pct: 0.025, score: 10 },
];
// 指标十一区间:prevRangePctAvg7 ∈ [min, max) 给分(排除极端)
const PREV_RANGE_PCT_AVG_RANGE_TIER = { min: 0.010, max: 0.050, score: 10 };

// ====== Setters(runner 用于覆盖默认行为,每次 runBacktest 结束恢复默认) ======

export function setTrendIndicator9Enabled(enabled: boolean): void {
    IND9_ENABLED = enabled;
}
export function setTrendIndicator10Enabled(enabled: boolean): void {
    IND10_ENABLED = enabled;
}
export function setTrendIndicator11Mode(mode: Ind11Mode): void {
    IND11_MODE = mode;
}
/** 一次性恢复所有实验覆盖,供 runner finally 调用 */
export function resetTrendExperimentFlags(): void {
    IND9_ENABLED = true;
    IND10_ENABLED = true;
    IND11_MODE = 'forward';
}

// ====== Candle Shape 指标阈值(K 线身形,见 references/TREND.md)======

/** K 线 OHLC 数据(被 TrendBaseline 和 scoreCandleShape 共用) */
export interface CandleOHLC {
    open: number;
    high: number;
    low: number;
    close: number;
}

export interface CandleShapeThresholds {
    longShadowRatio: number;     // 长影: shadows/total ≥ 该值
    fullBodyRatio: number;       // 满实体: body/total ≥ 该值
    fullBodyMinTotalPct: number; // 满实体: total/open ≥ 该值(死水 K 闸)
    longKlineBodyAtr: number;    // 超长 K: body/prevAtr ≥ 该值
    maxScore: number;            // 命中任一档给的分
}

export interface CandleShapeResult {
    score: number;
    tier: 'long-shadow' | 'full-body' | 'long-kline' | 'none';
    bodyRatio: number;    // body / (high - low)
    shadowRatio: number;  // 1 - bodyRatio
    bodyAtr: number;      // body / prevAtr
}

// Opening Shape:只保留 long-kline 档(bodyAtr >= 0.6)。其余两档的阈值设 1.01
// 不可达,等同禁用 —— 保留代码结构便于未来恢复。
export const OPENING_SHAPE_THRESHOLDS: CandleShapeThresholds = {
    longShadowRatio: 1.01,
    fullBodyRatio: 1.01,
    fullBodyMinTotalPct: 0.003,
    longKlineBodyAtr: 0.6,
    maxScore: 15,
};

// Prior Day Shape:整个指标 maxScore=0 禁用。昨日形态无论哪档都是负贡献
// (昨日强势延续 → 次日回调)。threshold 字段保留原值便于未来恢复。
export const PRIOR_DAY_SHAPE_THRESHOLDS: CandleShapeThresholds = {
    longShadowRatio: 0.65,
    fullBodyRatio: 0.75,
    fullBodyMinTotalPct: 0.01,
    longKlineBodyAtr: 0.8,
    maxScore: 0,
};

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

/** 默认参数 = 当前生产 v5-tuned 配置。这是 rescore 的 fallback 和 smoke 的对照。 */
export const DEFAULT_TREND_SCORE_PARAMS: TrendScoreParams = {
    gapTiers: [{ pct: 0.02, score: 25 }],
    rvolTiers: [{ v: 2, score: 40 }, { v: 1.3, score: 20 }],
    driveTiers: [],
    vwapFullScore: 5,
    vwapPartialScore: 5,
    vwapPartialRatio: 0.8,
    rangeTiers: [{ atr: 1.0, score: 30 }, { atr: 0.5, score: 15 }],
    atrPctTiers: [{ pct: 0.03, score: 15 }],
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
    todayRangePctTiers: [{ pct: 0.008, score: 10 }],
    priorDayRangePctTiers: [{ pct: 0.025, score: 10 }],
    prevRangePctAvgTiers: [{ pct: 0.025, score: 10 }],
    scoreThreshold: 70,
};

export const TREND_SCORE_THRESHOLD = 70;

/**
 * K 线身形评分(纯函数)。
 *
 * max-of-three:三档独立判定,命中任一档给 maxScore。
 * tier 用固定优先级(long-kline > full-body > long-shadow)归类,仅作诊断字段。
 *
 * 边界保护:total/prevAtr/open 非正 → score=0 tier='none'。
 *
 * 详见 references/TREND.md 指标七/八。
 */
export function scoreCandleShape(
    k: CandleOHLC,
    prevAtr: number,
    t: CandleShapeThresholds
): CandleShapeResult {
    const total = k.high - k.low;
    if (!(total > 0) || !(prevAtr > 0) || !(k.open > 0)) {
        return { score: 0, tier: 'none', bodyRatio: 0, shadowRatio: 0, bodyAtr: 0 };
    }
    const body = Math.abs(k.close - k.open);
    const bodyRatio = body / total;
    const shadowRatio = 1 - bodyRatio;
    const bodyAtr = body / prevAtr;

    const isLongShadow = shadowRatio >= t.longShadowRatio;
    const isFullBody =
        bodyRatio >= t.fullBodyRatio && total / k.open >= t.fullBodyMinTotalPct;
    const isLongKline = bodyAtr >= t.longKlineBodyAtr;

    let tier: CandleShapeResult['tier'] = 'none';
    if (isLongKline) tier = 'long-kline';
    else if (isFullBody) tier = 'full-body';
    else if (isLongShadow) tier = 'long-shadow';

    const score = tier === 'none' ? 0 : t.maxScore;
    return { score, tier, bodyRatio, shadowRatio, bodyAtr };
}

export const RVOL_LOOKBACK_DAYS = 5;
export const OPENING_WINDOW_MINUTES = 5;
/** Range 指标用的 ATR 天数,和 strategy.config.atrPeriod 对齐(=7) */
const ATR_PERIOD = 7;
/** 指标六 ATR% 用的 ATR 天数 —— 想反映"最近几天波动率"可调短,默认和 Range 同步 */
export const TREND_ATR_SHORT_PERIOD_DEFAULT = 7;
/**
 * 指标十一:前 N 天日内 (high-low)/close 均值的窗口,默认 7 天和 ATR 对齐。
 *
 * **注意约束**:本值必须 <= ATR_PERIOD(=7)。precomputeTrendBaselinesForSymbol
 * 里的 range 循环依赖上游 ATR 守卫(i > ATR_PERIOD)保证索引不越界。
 * 若将本值改大,需要恢复独立的 `if (i < TREND_RANGE_PCT_AVG_LOOKBACK)` 守卫。
 */
export const TREND_RANGE_PCT_AVG_LOOKBACK = 7;

/** 某支票某一天用的历史基准(前 1 日 close/ATR + 前 RVOL_LOOKBACK_DAYS 天同窗口成交量均值) */
export interface TrendBaseline {
    prevClose: number;
    prevAtr: number; // 7 日 ATR,用于 Range 指标
    prevAtrShort: number; // 短周期 ATR,用于指标六 ATR%(可配置)
    rvolBaseline: number; // 前 N 天 (RVOL_LOOKBACK_DAYS) 同窗口 (OPENING_WINDOW_MINUTES 根) 成交量均值
    prevDayOHLC: CandleOHLC;
    prevRangePctAvg7: number; // 前 TREND_RANGE_PCT_AVG_LOOKBACK 天日内 (high-low)/close 均值(排除 gap)
}

export interface TrendScoreDetails {
    gapPct: number;
    rvolValue: number;
    driveAtr: number;
    vwapControlRatio: number;
    vwapControlSide: 'long' | 'short' | 'none';
    rangeValue: number;
    rangeAtrRatio: number;
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

/**
 * 给定一支票在当日的 09:30–09:34 这 5 根分钟 bar + baseline,返回评分。
 *
 * window 必须严格是 5 根(不多不少),时间正序。
 * 若 window.length !== 5 或 baseline.rvolBaseline <= 0 返回 null。
 *
 * 11 个指标(其中 2 个当前权重为 0,结构保留):
 *   Gap (25)               : |open - prevClose| / prevClose
 *   RVOL (40)              : sum(window.volume) / rvolBaseline
 *   Drive (0)              : |window[last].close - window[0].open| / prevAtr [已归零]
 *   VWAP (5)               : 5 根 bar close vs 累积 VWAP 的控制比
 *   Range (30)             : (max high - min low) / prevAtr
 *   ATR% (15)              : prevAtrShort / prevClose
 *   Opening Shape (15)     : 开盘 5 分钟合成 K 线身形(仅 long-kline 档生效)
 *   Prior Day Shape(0)     : 昨日日线 K 身形 [已禁用]
 *   Today Range% (10)      : (highMax - lowMin) / window[0].open
 *   Prior Day Range% (10)  : (prevDayOHLC.high - prevDayOHLC.low) / prevClose [排除 gap]
 *   Prev Range% Avg7 (10)  : 前 7 天 (dailyHigh - dailyLow) / dailyClose 均值
 *
 * 注意:使用 window[0].open 作为"open",这是 09:30 那根 bar 的开盘,
 *       和 prevClose 比是 overnight gap;使用 window[last].close 作为"price0935",
 *       这是 09:34 那根 bar 的收盘,也就是"09:35 那一刻的最新价"。
 */
export function scoreTrendDay(
    window: SerializedBar[],
    baseline: TrendBaseline
): TrendScore | null {
    if (window.length !== OPENING_WINDOW_MINUTES) return null;
    if (baseline.rvolBaseline <= 0) return null;
    if (!Number.isFinite(baseline.prevClose) || baseline.prevClose <= 0) return null;
    if (!Number.isFinite(baseline.prevAtr) || baseline.prevAtr <= 0) return null;
    if (!Number.isFinite(baseline.prevAtrShort) || baseline.prevAtrShort <= 0) return null;
    if (!Number.isFinite(baseline.prevRangePctAvg7) || baseline.prevRangePctAvg7 < 0) return null;

    const open = window[0].open;
    const price0935 = window[window.length - 1].close;

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
    const driveAtr = Math.abs(price0935 - open) / baseline.prevAtr;
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
        const vwapHere = cumTurnover / cumVolume;
        if (b.close > vwapHere) longCount++;
        else if (b.close < vwapHere) shortCount++;
        // 平价不计入任何一边
    }
    const total = window.length;
    const longRatio = longCount / total;
    const shortRatio = shortCount / total;
    let vwap = 0;
    const vwapControlRatio = Math.max(longRatio, shortRatio);
    const vwapControlSide: 'long' | 'short' | 'none' =
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
    const rangeAtrRatio = baseline.prevAtr > 0 ? rangeValue / baseline.prevAtr : 0;
    let range = 0;
    for (const tier of RANGE_TIERS) {
        if (rangeAtrRatio > tier.atr) {
            range = tier.score;
            break;
        }
    }

    // ====== 指标六:短周期 ATR / 前收 ======
    // 用 prevClose 作分母,反映"这只票最近几天的跨日波动率"(每天同一分母基准,和 gap 大小脱钩)。
    const atrPct = baseline.prevClose > 0 ? baseline.prevAtrShort / baseline.prevClose : 0;
    let atrPctScore = 0;
    for (const tier of ATR_PCT_TIERS) {
        if (atrPct > tier.pct) {
            atrPctScore = tier.score;
            break;
        }
    }

    // ====== 指标七:Opening Shape ======
    const openingK: CandleOHLC = {
        open: window[0].open,
        close: price0935,    // 已在上文定义 = window[last].close
        high: highMax,       // Range 指标算出的
        low: lowMin,
    };
    const openingShapeResult = scoreCandleShape(
        openingK,
        baseline.prevAtr,
        OPENING_SHAPE_THRESHOLDS
    );

    // ====== 指标八:Prior Day Shape ======
    const priorDayShapeResult = scoreCandleShape(
        baseline.prevDayOHLC,
        baseline.prevAtr, // 共用 prevAtr 当尺子(7 日 ATR,昨日权重约 14%,偏保守可接受)
        PRIOR_DAY_SHAPE_THRESHOLDS
    );

    // ====== 指标九:Today Opening Range% ======
    // (highMax - lowMin) 已在指标五里算好,window[0].open 已在开头拿到
    const todayRangePctValue = window[0].open > 0
        ? (highMax - lowMin) / window[0].open
        : 0;
    let todayRangePct = 0;
    if (IND9_ENABLED) {
        for (const tier of TODAY_RANGE_PCT_TIERS) {
            if (todayRangePctValue > tier.pct) {
                todayRangePct = tier.score;
                break;
            }
        }
    }

    // ====== 指标十:Prior Day Range% (排除 gap) ======
    const priorDayRangePctValue = baseline.prevClose > 0
        ? (baseline.prevDayOHLC.high - baseline.prevDayOHLC.low) / baseline.prevClose
        : 0;
    let priorDayRangePct = 0;
    if (IND10_ENABLED) {
        for (const tier of PRIOR_DAY_RANGE_PCT_TIERS) {
            if (priorDayRangePctValue > tier.pct) {
                priorDayRangePct = tier.score;
                break;
            }
        }
    }

    // ====== 指标十一:Prev Range% Avg (TREND_RANGE_PCT_AVG_LOOKBACK 天均值) ======
    const prevRangePctAvg7Value = baseline.prevRangePctAvg7;
    let prevRangePctAvg7 = 0;
    if (IND11_MODE === 'forward') {
        for (const tier of PREV_RANGE_PCT_AVG_TIERS) {
            if (prevRangePctAvg7Value > tier.pct) {
                prevRangePctAvg7 = tier.score;
                break;
            }
        }
    } else if (IND11_MODE === 'reverse') {
        for (const tier of PREV_RANGE_PCT_AVG_REVERSE_TIERS) {
            if (prevRangePctAvg7Value < tier.pct) {
                prevRangePctAvg7 = tier.score;
                break;
            }
        }
    } else if (IND11_MODE === 'range') {
        const r = PREV_RANGE_PCT_AVG_RANGE_TIER;
        if (prevRangePctAvg7Value >= r.min && prevRangePctAvg7Value < r.max) {
            prevRangePctAvg7 = r.score;
        }
    }
    // IND11_MODE === 'off' 时 prevRangePctAvg7 保持 0

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
            rangeAtrRatio,
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
}

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

/**
 * 一次性对一支票预计算每个 dayKey 的 baseline。
 *
 * 返回 `Record<dayKey, TrendBaseline | null>`,runner 里对每支票调一次、
 * 整段回测期间只查表,不重扫。
 */
export function precomputeTrendBaselinesForSymbol(
    bars: SerializedBar[],
    shortAtrPeriod: number = TREND_ATR_SHORT_PERIOD_DEFAULT
): Record<string, TrendBaseline | null> {
    const out: Record<string, TrendBaseline | null> = {};
    const daily = aggregateDailyForTrend(bars);
    if (daily.length === 0) return out;

    const high = daily.map(d => d.high);
    const low = daily.map(d => d.low);
    const close = daily.map(d => d.close);

    // 日线 ATR 序列:atrSeries[k] 对应 daily[k + ATR_PERIOD]
    const atrSeries =
        daily.length > ATR_PERIOD
            ? ta_atr({ high, low, close, period: ATR_PERIOD })
            : [];
    // 短周期 ATR 序列:atrShortSeries[k] 对应 daily[k + shortAtrPeriod]
    // 若 shortAtrPeriod === ATR_PERIOD,复用避免重复算
    const atrShortSeries =
        shortAtrPeriod === ATR_PERIOD
            ? atrSeries
            : daily.length > shortAtrPeriod
                ? ta_atr({ high, low, close, period: shortAtrPeriod })
                : [];

    for (let i = 0; i < daily.length; i++) {
        const dayKey = daily[i].dayKey;

        // 第 0 天没有前一日
        if (i === 0) {
            out[dayKey] = null;
            continue;
        }
        const prevDay = daily[i - 1];
        const prevClose = prevDay.close;

        // prevAtr 需要 i > ATR_PERIOD(即至少第 ATR_PERIOD+1 天才能拿到前一日收盘时的 ATR)
        // 索引对齐 runner.ts::precomputeAtrByDay: atrSeries[i - period - 1]
        if (i <= ATR_PERIOD) {
            out[dayKey] = null;
            continue;
        }
        const prevAtr = atrSeries[i - ATR_PERIOD - 1];
        if (prevAtr === undefined || !Number.isFinite(prevAtr) || prevAtr <= 0) {
            out[dayKey] = null;
            continue;
        }

        // 短 ATR 需要 i > shortAtrPeriod
        if (i <= shortAtrPeriod) {
            out[dayKey] = null;
            continue;
        }
        const prevAtrShort = atrShortSeries[i - shortAtrPeriod - 1];
        if (prevAtrShort === undefined || !Number.isFinite(prevAtrShort) || prevAtrShort <= 0) {
            out[dayKey] = null;
            continue;
        }

        // RVOL 基线:前 RVOL_LOOKBACK_DAYS 天(不含当日)的 openingVolume 均值
        // 只计入 openingVolume > 0 的天;有效天数不足一半则放弃
        const from = Math.max(0, i - RVOL_LOOKBACK_DAYS);
        let sum = 0;
        let cnt = 0;
        for (let k = from; k < i; k++) {
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

        // 前 TREND_RANGE_PCT_AVG_LOOKBACK 天的日内 (high-low)/close 均值(排除 gap)
        // 用已有 daily[] 数组,零新增依赖;ATR_PERIOD=7=TREND_RANGE_PCT_AVG_LOOKBACK,
        // 上游 ATR 守卫已保证 i > 7,无需再加索引守卫。
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
    }

    return out;
}

interface DailyOHLC {
    dayKey: string;
    open: number;
    high: number;
    low: number;
    close: number;
    openingVolume: number; // 09:30–09:34 共 5 根 bar 的 volume 之和(若不足 5 根记为 0)
}

/** 按 UTC 日期分组、聚合每日 OHLC 和"开盘窗口成交量" */
function aggregateDailyForTrend(bars: SerializedBar[]): DailyOHLC[] {
    if (bars.length === 0) return [];

    // 按 day 分组并排序
    const barsByDay: Record<string, SerializedBar[]> = {};
    for (const b of bars) {
        const key = new Date(b.timestamp).toISOString().slice(0, 10);
        (barsByDay[key] ??= []).push(b);
    }
    const out: DailyOHLC[] = [];
    const dayKeys = Object.keys(barsByDay).sort();
    for (const key of dayKeys) {
        const dayBars = [...barsByDay[key]].sort((a, b) => a.timestamp - b.timestamp);
        const open = dayBars[0].open;
        let high = dayBars[0].high;
        let low = dayBars[0].low;
        const close = dayBars[dayBars.length - 1].close;
        for (const b of dayBars) {
            if (b.high > high) high = b.high;
            if (b.low < low) low = b.low;
        }
        // 前 OPENING_WINDOW_MINUTES 根 bar 的 volume 之和;不足时记为 0(下游跳过)
        let openingVolume = 0;
        if (dayBars.length >= OPENING_WINDOW_MINUTES) {
            for (let i = 0; i < OPENING_WINDOW_MINUTES; i++) {
                openingVolume += dayBars[i].volume;
            }
        }
        out.push({ dayKey: key, open, high, low, close, openingVolume });
    }
    return out;
}

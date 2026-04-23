/**
 * Backtest runner
 *
 * 设计要点（和实盘对齐的部分用 >> 标注）：
 *
 * >> 入场信号：直接复用 VWAPStrategy.canOpen() 这一纯信号函数，不调 onBar/open/managePosition —
 *    避免触发 longport 的 placeOrder / getAccountEquity 等副作用接口。
 *
 * >> 指标计算：calcVWAP / calcRSI / calcVolume 全部 1:1 复用。BacktestMarket 返回的伪 quote
 *    的 turnover/volume 已经是当日累积值，和 realTimeMarket.getQuote 语义一致。
 *
 * >> 时段切换：canOpen 里通过 timeGuard.getTradeProgressMinutes() 读 new Date() 判断早盘/主段/尾盘。
 *    回测里 monkey-patch 这个方法，让它返回基于"当前 bar 美东时间"的分钟差。
 *
 * >> ATR：实盘用"前一交易日日线 ATR"，回测里同样 —— 从分钟 K 聚合出每天的 OHLC，
 *    在每个新的交易日开始前用前 N 日日线 ATR 更新到 atrMap。
 *
 * 撮合规则：
 *   - 信号在 bar t 产生，成交价 = bar[t+1].open（entry bar）。
 *   - fixed 模式：bar 的 [low, high] 区间判 TP/SL，同根 K 同时触及用 ambiguousResolution
 *     决定先判哪个，成交价 = 被触发的价位（限价成交假设）。
 *   - trailing 模式：用 bar.close 近似 tick，逐根更新 stopPrice；SL 触发判断放在下一根 bar
 *     的 low/high 区间内（实盘是 5s tick，回测是 1min，是已知偏差）。
 *   - 尾盘强平：在 "收盘前 closeTimeMinutes 分钟" 的第一根 bar 就强平，成交价 = 该 bar.close。
 *
 * 回测不模拟 daily drawdown 风控 —— 简化。
 *
 * 用法：
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/runner.ts <label> <exitMode> [tp] [sl] [resolution]
 *
 *   例：
 *     npx ts-node ... src/backtest/runner.ts baseline trailing
 *     npx ts-node ... src/backtest/runner.ts fixed_0.5_0.35_SLFirst fixed 0.5 0.35 SLFirst
 */
import { initTradeEnv } from '../core/env';
initTradeEnv();

import * as fs from 'fs';
import * as path from 'path';
import { OrderSide } from 'longport';

import config from '../config/strategy.config';
import { getAllSymbols } from '../config/symbolPools';
import { BacktestMarket } from './backtestMarket';
import { SerializedBar, BacktestTrade, BacktestResult } from './types';
import VWAPStrategy from '../strategy/vwapStrategy';
import SymbolState from '../core/state';
import { RiskManager } from '../core/risk';
import { calcVWAP } from '../core/indicators/vwap';
import { calcRSI } from '../core/indicators/rsi';
import { calcVolume } from '../core/indicators/volume';
import { timeGuard } from '../core/timeGuard';
import { atr as ta_atr } from 'technicalindicators';
import { scoreChoppiness } from '../core/indicators/choppiness';
import {
    precomputeTrendBaselinesForSymbol,
    scoreTrendDay,
    TrendBaseline,
    TrendScore,
    TREND_SCORE_THRESHOLD,
    OPENING_WINDOW_MINUTES,
    setTrendIndicator9Enabled,
    setTrendIndicator10Enabled,
    setTrendIndicator11Mode,
    resetTrendExperimentFlags,
    Ind11Mode,
} from '../core/trendDetector';

// ======================================================================
// Monkey-patch timeGuard：让 canOpen 里的 getTradeProgressMinutes 返回
// "当前 bar 所在美东时间" 的进度，而不是真实 new Date()。
// ======================================================================
let currentBarTs: number = 0;
const realGetTradeProgressMinutes = timeGuard.getTradeProgressMinutes.bind(
    timeGuard
);
(timeGuard as any).getTradeProgressMinutes = function () {
    if (!currentBarTs) return realGetTradeProgressMinutes();
    // 美股盘中：09:30 – 16:00 美东时间
    // UTC 时间戳直接用 Intl.DateTimeFormat 取美东的 HH:mm
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
    const parts = dtf.formatToParts(new Date(currentBarTs));
    const map: Record<string, number> = {};
    for (const p of parts) {
        if (p.type === 'hour' || p.type === 'minute' || p.type === 'second') {
            map[p.type] = Number(p.value);
        }
    }
    const nowSec = map.hour * 3600 + map.minute * 60 + map.second;
    const beginSec = 9 * 3600 + 30 * 60; // 09:30
    const endSec = 16 * 3600; // 16:00
    return {
        minutesSinceOpen: (nowSec - beginSec) / 60,
        minutesToClose: (endSec - nowSec) / 60,
        beginSec,
        endSec,
        nowSec,
    };
};

// ======================================================================
// 类型和常量
// ======================================================================
type ExitMode = 'trailing' | 'fixed';
type AmbiguousResolution = 'SLFirst' | 'TPFirst';

interface RunnerOptions {
    label: string;
    exitMode: ExitMode;
    takeProfitAtrRatio?: number;
    stopLossAtrRatio?: number;
    ambiguousResolution?: AmbiguousResolution;
    /**
     * 覆盖 trailing 模式的初始止损宽度（ATR 倍数）。默认读 config.stopAtrRatio。
     * 实际撮合时 runner 自己读 config.stopAtrRatio，所以这里通过临时改 config
     * 让 canOpen 和撮合的 SL 计算保持一致。
     */
    stopAtrRatio?: number;
    /**
     * 覆盖过滤开关（对应 config.filters 的四个字段）。未指定的维度沿用
     * config.filters 当前值，runBacktest 结束时恢复。
     */
    filters?: Partial<{
        enableRsiFilter: boolean;
        enableVolumeFilter: boolean;
        enableEntryPhaseFilter: boolean;
        enableIndexTrendFilter: boolean;
        enableTrendDetector: boolean;
        enableChoppiness: boolean;
    }>;
    /** 覆盖趋势日门槛(默认走 TREND_SCORE_THRESHOLD) */
    trendThreshold?: number;
    /** 覆盖指标六 ATR% 的短 ATR 周期(默认 TREND_ATR_SHORT_PERIOD_DEFAULT=7) */
    trendAtrShortPeriod?: number;
    /** 覆盖 choppiness.windowBars，runBacktest 结束时恢复 */
    chopWindowBars?: number;
    /** 覆盖 choppiness.scoreThreshold，runBacktest 结束时恢复 */
    chopScoreThreshold?: number;
    /** v4c 调参实验:禁用哪些新指标(9=今日Range%, 10=昨日Range%, 11=前7天Range%均值) */
    disableTrendIndicators?: number[];
    /** v4c 调参实验:指标十一评分模式,默认 forward(维持当前生产行为) */
    ind11Mode?: Ind11Mode;
    /**
     * 个股 VWAP 斜率入场过滤（在 canOpen 之后做二次过滤）。
     * - trend：顺势，slope 方向与入场方向一致且 ≥ threshold 才放行
     * - revert：逆势（均值回归），|slope| ≥ threshold 且方向相反才放行
     * - momentum：趋势强度，|slope| ≥ threshold 才放行（不限方向，过滤震荡）
     * threshold 单位为 bps（slope/vwap * 10000）
     */
    slopeFilter?: {
        mode: 'trend' | 'revert' | 'momentum';
        threshold: number;
    };
}

const RAW_DIR = path.resolve(process.cwd(), 'data/backtest/raw');
const RESULT_DIR = path.resolve(process.cwd(), 'data/backtest/results');

// ======================================================================
// 数据加载
// ======================================================================
interface LoadedData {
    symbol: string;
    bars: SerializedBar[];
}

function loadAllData(): LoadedData[] {
    const out: LoadedData[] = [];
    for (const symbol of getAllSymbols()) {
        const p = path.join(RAW_DIR, `${symbol}.json`);
        if (!fs.existsSync(p)) {
            console.warn(`[runner] 缺失数据文件：${p}，跳过`);
            continue;
        }
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        out.push({ symbol, bars: data.bars });
    }
    return out;
}

// ======================================================================
// 交易日聚合 & 日线 ATR 预计算
//
// 从分钟 K 聚合每日 OHLC（high=max, low=min, close=last bar close）
// 然后用 technicalindicators 的 atr 算出"到某一交易日为止"的 ATR 序列。
// Runner 在每个交易日开始时查表更新 atrMap[symbol]。
// ======================================================================
interface DayBar {
    dayKey: string; // UTC YYYY-MM-DD（和 BacktestMarket.tradingDayKey 一致）
    high: number;
    low: number;
    close: number;
}

function aggregateDaily(bars: SerializedBar[]): DayBar[] {
    const byDay: Record<string, DayBar> = {};
    for (const b of bars) {
        const key = new Date(b.timestamp).toISOString().slice(0, 10);
        if (!byDay[key]) {
            byDay[key] = {
                dayKey: key,
                high: b.high,
                low: b.low,
                close: b.close,
            };
        } else {
            const d = byDay[key];
            if (b.high > d.high) d.high = b.high;
            if (b.low < d.low) d.low = b.low;
            d.close = b.close; // 按 bar 顺序推进，最后一根就是收盘
        }
    }
    return Object.values(byDay).sort((a, b) =>
        a.dayKey.localeCompare(b.dayKey)
    );
}

/**
 * 为某个标的预计算"每个交易日开盘时应使用的 ATR"。
 * 实盘里 preloadATR 在交易日初始化时用"前 N 日"日线算 ATR，
 * 所以第 i 天使用的 ATR = atr(dailyBars[0..i-1])，长度 atrPeriod。
 * 只有历史 >= atrPeriod+1 天时才有效，早期天数返回 null。
 */
function precomputeAtrByDay(
    dayBars: DayBar[]
): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    const period = config.atrPeriod;
    if (dayBars.length <= period) {
        // 不够算，全部 null
        for (const d of dayBars) out[d.dayKey] = null;
        return out;
    }
    // 一次性算出到最后一天为止的完整 atr 序列
    const atrSeries = ta_atr({
        high: dayBars.map(d => d.high),
        low: dayBars.map(d => d.low),
        close: dayBars.map(d => d.close),
        period,
    });
    // atr(period, values) 返回长度 = values.length - period
    // atrSeries[k] 对应 dayBars[k+period]
    // 第 i 天使用"前 i 天"数据算的 ATR = atrSeries[i - period - 1]  （需要 i > period）
    for (let i = 0; i < dayBars.length; i++) {
        if (i <= period) {
            out[dayBars[i].dayKey] = null;
        } else {
            // 使用前一天计算出的 ATR（"开盘前一晚"的状态）
            out[dayBars[i].dayKey] = atrSeries[i - period - 1] ?? null;
        }
    }
    return out;
}

// ======================================================================
// 持仓状态（runner 自己管，不依赖 VWAPStrategy.open/managePosition）
// ======================================================================
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
    entryDayScoreDetail: BacktestTrade['entryDayScoreDetail'];
    /** 入场时的 chopScore 快照，写入 BacktestTrade.entryChopScore */
    entryChopScore: BacktestTrade['entryChopScore'];
}

// ======================================================================
// 时段判断（和 canOpen 里的 entryFilterSchedule 完全对齐）
// ======================================================================
function getPhaseAtTs(ts: number): BacktestTrade['phaseAtEntry'] {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
    });
    const parts = dtf.formatToParts(new Date(ts));
    let h = 0;
    let m = 0;
    for (const p of parts) {
        if (p.type === 'hour') h = Number(p.value);
        if (p.type === 'minute') m = Number(p.value);
    }
    const nowSec = h * 3600 + m * 60;
    const beginSec = 9 * 3600 + 30 * 60;
    const endSec = 16 * 3600;
    const minutesSinceOpen = (nowSec - beginSec) / 60;
    const minutesToClose = (endSec - nowSec) / 60;
    const schedule = config.entryFilterSchedule;
    if (minutesSinceOpen <= schedule.rsiVolumeDisabledUntilOpenMinutes) {
        return 'early';
    }
    if (minutesToClose <= schedule.rsiVolumeDisabledBeforeCloseMinutes) {
        return 'late';
    }
    return 'main';
}

// ======================================================================
// 主回测循环
// ======================================================================
export { RunnerOptions };
export async function runBacktest(opts: RunnerOptions): Promise<BacktestResult> {
    console.log(`\n[runner] === ${opts.label} ===`);
    console.log(
        `  exitMode=${opts.exitMode} tp=${opts.takeProfitAtrRatio ?? '-'} sl=${opts.stopLossAtrRatio ?? '-'} resolution=${opts.ambiguousResolution ?? '-'}`
    );
    if (opts.trendAtrShortPeriod !== undefined) {
        console.log(`  trendAtrShortPeriod=${opts.trendAtrShortPeriod} trendThreshold=${opts.trendThreshold ?? 'default'}`);
    }

    // 临时覆盖 config 让 canOpen 走正确的 exitMode 分支（目前 canOpen 里没读 exitMode，
    // 但未来如果加了也不会出错）
    const savedExitMode = config.exitMode;
    config.exitMode = opts.exitMode;

    // 临时覆盖 trailing 模式的初始止损宽度（runner 撮合从 config.stopAtrRatio 读）
    const savedStopAtrRatio = config.stopAtrRatio;
    if (opts.stopAtrRatio != null) {
        config.stopAtrRatio = opts.stopAtrRatio;
    }

    // 临时覆盖 filters 开关（canOpen 里每个过滤分支都读 config.filters）
    const savedFilters = { ...config.filters };
    if (opts.filters) {
        config.filters = { ...config.filters, ...opts.filters };
    }

    // 临时覆盖 choppiness 配置（runner finally 恢复）
    const savedChoppiness = { ...config.choppiness };
    if (opts.chopWindowBars !== undefined) {
        config.choppiness.windowBars = opts.chopWindowBars;
    }
    if (opts.chopScoreThreshold !== undefined) {
        config.choppiness.scoreThreshold = opts.chopScoreThreshold;
    }

    // v4c 调参实验 flags:按 opts 覆盖指标启用状态 / 指标十一模式
    // 结尾用 resetTrendExperimentFlags() 恢复默认(和 config.filters save/restore 一样是 best-effort,
    // throw 路径会泄漏 —— 本次任务不修 existing 的 best-effort 模式以避免 scope creep)
    if (opts.disableTrendIndicators && opts.disableTrendIndicators.length > 0) {
        for (const n of opts.disableTrendIndicators) {
            if (n === 9) setTrendIndicator9Enabled(false);
            else if (n === 10) setTrendIndicator10Enabled(false);
            else if (n === 11) setTrendIndicator11Mode('off');
            else console.warn(`[runner] unknown --disable-trend-ind value: ${n}, ignored`);
        }
    }
    if (opts.ind11Mode && opts.ind11Mode !== 'forward') {
        setTrendIndicator11Mode(opts.ind11Mode);
    }

    const indexEnabled = config.filters.enableIndexTrendFilter;
    const indexSymbol = config.indexTrendFilter.indexSymbol;

    console.log(
        `  filters=${JSON.stringify(config.filters)}  ` +
            `stopAtrRatio=${config.stopAtrRatio}` +
            (opts.slopeFilter
                ? `  slopeFilter=${opts.slopeFilter.mode}@${opts.slopeFilter.threshold}bps`
                : '')
    );

    // 加载所有数据
    const allData = loadAllData();
    console.log(`[runner] 加载 ${allData.length} 支标的`);

    // 初始化市场和策略
    const market = new BacktestMarket(config.emaSlopePeriod);
    for (const { symbol, bars } of allData) {
        market.loadBars(symbol, bars);
    }

    // 加载指数数据（如果启用）
    let indexBars: SerializedBar[] | null = null;
    let indexTimestampToIndex: Map<number, number> | null = null;
    if (indexEnabled) {
        const indexPath = path.resolve(RAW_DIR, `${indexSymbol}.json`);
        if (!fs.existsSync(indexPath)) {
            throw new Error(
                `indexFilter 已启用但缺失 ${indexSymbol} 数据：${indexPath}`
            );
        }
        const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        indexBars = indexData.bars;
        market.loadBars(indexSymbol, indexBars!);
        indexTimestampToIndex = new Map();
        for (let i = 0; i < indexBars!.length; i++) {
            indexTimestampToIndex.set(indexBars![i].timestamp, i);
        }
        console.log(
            `[runner] 加载指数 ${indexSymbol} ${indexBars!.length} 根`
        );
    }

    // dailyRisk 只为了让 canOpen 里 dailyRisk.canTrade() 返回 true
    const dailyRisk = new RiskManager(1); // 阈值设成 100% 不会被触发
    dailyRisk.startEquity = 1_000_000;
    dailyRisk.tradingHalted = false;
    const strategy = new VWAPStrategy(config, dailyRisk);
    // strategy.states 用来承载 canOpen 里的 getState
    strategy.states = {};

    // 日线 ATR 预计算
    const atrByDayBySymbol: Record<string, Record<string, number | null>> = {};
    for (const { symbol, bars } of allData) {
        const days = aggregateDaily(bars);
        atrByDayBySymbol[symbol] = precomputeAtrByDay(days);
    }
    const atrMap: Record<string, number> = {};

    // Trend detector 预计算(和 ATR 预计算同一位置,职责对称)
    // baselineBySymbol[symbol][dayKey] = TrendBaseline | null
    // firstIntradayBarIndexBySymbol[symbol][dayKey] = 该 symbol 在当日首根 bar 的 index
    //                                                 (在 allData[i].bars 里的位置)
    const trendBaselineBySymbol: Record<string, Record<string, TrendBaseline | null>> = {};
    const firstIntradayBarIndexBySymbol: Record<string, Record<string, number>> = {};
    for (const { symbol, bars } of allData) {
        trendBaselineBySymbol[symbol] = precomputeTrendBaselinesForSymbol(bars, opts.trendAtrShortPeriod);
        const m: Record<string, number> = {};
        for (let i = 0; i < bars.length; i++) {
            const k = new Date(bars[i].timestamp).toISOString().slice(0, 10);
            if (m[k] === undefined) m[k] = i;
        }
        firstIntradayBarIndexBySymbol[symbol] = m;
    }
    console.log(`[runner] 预计算 trend baseline 完成`);

    // 全标的时间轴：把所有 bar 按时间戳排序合并，每个时间戳对应一组 (symbol, barIndex)
    // 由于所有标的都是 390 根/天、时间对齐，可以简化成：按时间戳分组。
    const tickMap: Record<number, Array<{ symbol: string; index: number }>> = {};
    for (const { symbol, bars } of allData) {
        for (let i = 0; i < bars.length; i++) {
            const ts = bars[i].timestamp;
            (tickMap[ts] ??= []).push({ symbol, index: i });
        }
    }
    const timestamps = Object.keys(tickMap)
        .map(Number)
        .sort((a, b) => a - b);
    console.log(`[runner] 时间轴长度 ${timestamps.length} ticks`);

    // 当前日（UTC 日期键），用于在日切时刷新 ATR
    let currentDayKey: string | null = null;

    // 持仓 & trade log
    const positions: Record<string, Position> = {};
    const trades: BacktestTrade[] = [];
    // 待在 "下一根 bar 的 open" 成交的入场意图：symbol -> { side, chopScore }
    const pendingEntry: Record<string, { side: OrderSide; chopScore: BacktestTrade['entryChopScore'] }> = {};

    const tp_r = opts.takeProfitAtrRatio ?? 0.5;
    const sl_r = opts.stopLossAtrRatio ?? 0.35;
    const ambiguous: AmbiguousResolution = opts.ambiguousResolution ?? 'SLFirst';
    const forceCloseMinutes = config.closeTimeMinutes;
    const noTradeAfterOpenMinutes = config.noTradeAfterOpenMinutes;
    const noTradeBeforeCloseMinutes = config.noTradeBeforeCloseMinutes;

    // canOpen 需要的 bar 窗口长度（和实盘 defaultBarLength 对齐）
    // 当 enableChoppiness=true 时，还要保证窗口足够容纳 choppiness.windowBars 根
    const barWindow = Math.max(
        10,
        config.breakVolumePeriod + config.postVolumePeriod + 2,
        config.filters.enableChoppiness ? config.choppiness.windowBars : 0
    );

    // ======================================================================
    // 辅助：记录一笔完结交易
    // ======================================================================
    function closeTrade(
        pos: Position,
        exitTs: number,
        exitPrice: number,
        reason: BacktestTrade['exitReason'],
        ambiguousExit: boolean
    ) {
        const dir = pos.side === OrderSide.Buy ? 1 : -1;
        const pnl = dir * (exitPrice - pos.entryPrice);
        const rMultiple = pos.initialRisk > 0 ? pnl / pos.initialRisk : 0;
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
            entryDayScoreDetail: pos.entryDayScoreDetail,
            entryChopScore: pos.entryChopScore,
        });
        delete positions[pos.symbol];
        // 重置策略里的 state，允许同日再次开仓
        strategy.states[pos.symbol] = new SymbolState();
    }

    // ======================================================================
    // 主循环
    // ======================================================================
    // Trend detector 每日状态:symbol -> TrendScore(打过分) | null(没基线) | undefined(未打分)
    const dayScoreMap: Record<string, TrendScore | null | undefined> = {};
    const trendDetectorEnabled = config.filters.enableTrendDetector;
    let processedTicks = 0;
    for (const ts of timestamps) {
        currentBarTs = ts;
        const dayKey = new Date(ts).toISOString().slice(0, 10);

        // 日切：更新 ATR 并清空持仓状态（等同于实盘每日 states.clear）
        if (dayKey !== currentDayKey) {
            currentDayKey = dayKey;
            for (const { symbol } of allData) {
                const v = atrByDayBySymbol[symbol]?.[dayKey];
                if (v !== null && v !== undefined) atrMap[symbol] = v;
            }
            // 新交易日：清空所有状态（前一天的残留不会带过来）
            strategy.states = {};
            for (const sym of Object.keys(positions)) delete positions[sym];
            for (const sym of Object.keys(pendingEntry)) delete pendingEntry[sym];
            for (const sym of Object.keys(dayScoreMap)) delete dayScoreMap[sym];
        }

        // 推进指数游标（必须在逐标的处理之前，让本 ts 的 postQuote 包含当前 bar）
        if (indexEnabled && indexTimestampToIndex) {
            const idx = indexTimestampToIndex.get(ts);
            if (idx !== undefined) {
                market.advanceTo(indexSymbol, idx);
            }
        }

        const progress = (timeGuard.getTradeProgressMinutes() as any);
        const minutesSinceOpen = progress.minutesSinceOpen;
        const minutesToClose = progress.minutesToClose;

        // 是否"允许交易时段"（和 isInStrategyTradeTime 对齐）
        const inTradeWindow =
            minutesSinceOpen >= noTradeAfterOpenMinutes &&
            minutesToClose >= noTradeBeforeCloseMinutes;

        // 是否尾盘强平时段（和 isForceCloseTime 对齐）
        const isForceCloseWindow = minutesToClose <= forceCloseMinutes;

        // 逐标的处理
        for (const { symbol, index } of tickMap[ts]) {
            // 先推进 market 让 getQuote 反映当前 bar（注意：是本 bar 收盘后的累积状态）
            market.advanceTo(symbol, index);
            const currBar = market.getBarAt(symbol, index)!;

            // ========== 0. Trend detector 09:45 打分(每票每日一次)==========
            // 条件:minutesSinceOpen >= OPENING_WINDOW_MINUTES 且该票今日还没打分过
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

            // ========== 1. 已有持仓：先处理出场 ==========
            const pos = positions[symbol];
            if (pos) {
                if (isForceCloseWindow) {
                    closeTrade(pos, ts, currBar.close, 'ForceClose', false);
                    continue;
                }

                if (opts.exitMode === 'fixed') {
                    const slHit =
                        pos.side === OrderSide.Buy
                            ? currBar.low <= pos.stopPrice
                            : currBar.high >= pos.stopPrice;
                    const tpHit =
                        pos.tpPrice !== null &&
                        (pos.side === OrderSide.Buy
                            ? currBar.high >= pos.tpPrice
                            : currBar.low <= pos.tpPrice);
                    if (slHit && tpHit) {
                        // 同根 K 同时触及：按 resolution 决定
                        if (ambiguous === 'SLFirst') {
                            closeTrade(pos, ts, pos.stopPrice, 'SL', true);
                        } else {
                            closeTrade(pos, ts, pos.tpPrice!, 'TP', true);
                        }
                        continue;
                    } else if (slHit) {
                        closeTrade(pos, ts, pos.stopPrice, 'SL', false);
                        continue;
                    } else if (tpHit) {
                        closeTrade(pos, ts, pos.tpPrice!, 'TP', false);
                        continue;
                    }
                } else {
                    // trailing 模式：先判是否触发，再用 bar.close 更新 stop
                    const hit =
                        pos.side === OrderSide.Buy
                            ? currBar.low <= pos.stopPrice
                            : currBar.high >= pos.stopPrice;
                    if (hit) {
                        closeTrade(pos, ts, pos.stopPrice, 'SL', false);
                        continue;
                    }
                    // 用 bar.close 模拟 tick，按 stopDistance 上移/下移 stopPrice
                    if (pos.stopDistance !== null) {
                        const c = currBar.close;
                        if (pos.side === OrderSide.Buy) {
                            pos.stopPrice = Math.max(
                                pos.stopPrice,
                                c - pos.stopDistance
                            );
                        } else {
                            pos.stopPrice = Math.min(
                                pos.stopPrice,
                                c + pos.stopDistance
                            );
                        }
                    }
                }
            }

            // ========== 2. 没有持仓 & 有待成交入场：在 bar.open 成交 ==========
            if (!positions[symbol] && pendingEntry[symbol]) {
                const { side, chopScore: entryChop } = pendingEntry[symbol];
                delete pendingEntry[symbol];
                const entryPrice = currBar.open;
                const a = atrMap[symbol];
                if (a && a > 0) {
                    let stopPrice: number;
                    let tpPrice: number | null = null;
                    let stopDistance: number | null = null;
                    if (opts.exitMode === 'fixed') {
                        stopPrice =
                            side === OrderSide.Buy
                                ? entryPrice - sl_r * a
                                : entryPrice + sl_r * a;
                        tpPrice =
                            side === OrderSide.Buy
                                ? entryPrice + tp_r * a
                                : entryPrice - tp_r * a;
                    } else {
                        const slRatio = config.stopAtrRatio;
                        stopPrice =
                            side === OrderSide.Buy
                                ? entryPrice - slRatio * a
                                : entryPrice + slRatio * a;
                        stopDistance = Math.abs(entryPrice - stopPrice);
                    }
                    const initialRisk = Math.abs(entryPrice - stopPrice);
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
                        entryChopScore: entryChop,
                    };
                    positions[symbol] = newPos;
                    // 同步 strategy.states 让 canOpen 里 state.position 非空，避免重复进
                    const st = strategy.getState(symbol);
                    st.position = side;
                    st.entryPrice = entryPrice;
                    st.qty = 1;

                    // 入场后同根 bar 内立即检查 TP/SL —— 入场价是 open，
                    // bar 的 high/low 范围里的任意价格都可能触及。
                    // 这对 fixed 模式非常重要（否则 "持仓 < 1 bar" 的快速出场会被漏掉）。
                    if (opts.exitMode === 'fixed') {
                        const slHit =
                            side === OrderSide.Buy
                                ? currBar.low <= stopPrice
                                : currBar.high >= stopPrice;
                        const tpHit =
                            tpPrice !== null &&
                            (side === OrderSide.Buy
                                ? currBar.high >= tpPrice
                                : currBar.low <= tpPrice);
                        if (slHit && tpHit) {
                            if (ambiguous === 'SLFirst') {
                                closeTrade(newPos, ts, stopPrice, 'SL', true);
                            } else {
                                closeTrade(newPos, ts, tpPrice!, 'TP', true);
                            }
                        } else if (slHit) {
                            closeTrade(newPos, ts, stopPrice, 'SL', false);
                        } else if (tpHit) {
                            closeTrade(newPos, ts, tpPrice!, 'TP', false);
                        }
                    } else {
                        // trailing 模式：入场同根 bar 内也可能直接扫损
                        const slHit =
                            side === OrderSide.Buy
                                ? currBar.low <= stopPrice
                                : currBar.high >= stopPrice;
                        if (slHit) {
                            closeTrade(newPos, ts, stopPrice, 'SL', false);
                        } else if (stopDistance !== null) {
                            const c = currBar.close;
                            newPos.stopPrice =
                                side === OrderSide.Buy
                                    ? Math.max(stopPrice, c - stopDistance)
                                    : Math.min(stopPrice, c + stopDistance);
                        }
                    }
                }
            }

            // ========== 3. 信号检测（为"下一根 bar"准备入场意图）==========
            if (!positions[symbol] && inTradeWindow && !isForceCloseWindow) {
                // 构造 preBars：截取到当前 index，模拟 closedBars.slice(0, -1) 之后
                // 再往前取足够长度
                const fromIdx = Math.max(0, index - barWindow + 1);
                const windowBars = market
                    .getBarAt(symbol, 0) === undefined
                        ? []
                        : (() => {
                              const arr: SerializedBar[] = [];
                              for (let k = fromIdx; k <= index; k++) {
                                  const b = market.getBarAt(symbol, k);
                                  if (b) arr.push(b);
                              }
                              return arr;
                          })();
                // 转成 Candlestick 形状（canOpen 只读 close/high/low/volume）
                const fakeBars = toFakeCandles(windowBars);

                // 实盘里 onBar 做 `closedBars.slice(0, -1)` 丢最后一根；
                // 回测里"当前 bar 已经收盘"，所以不丢，直接当作已收盘的全窗口。
                const preBars = fakeBars;

                // 计算策略指标
                const quote = market.getQuote(symbol);
                const vwap = calcVWAP(quote);
                const a = atrMap[symbol];
                const rsi = calcRSI(preBars as any, config.rsiPeriod);
                const volume = calcVolume(preBars as any);
                const volumeRatio =
                    volume && volume.pastVolume > 0
                        ? volume.recentVolume / volume.pastVolume
                        : null;

                if (a && a > 0 && Number.isFinite(vwap)) {
                    // 指数斜率：从 BacktestMarket 的 EMA 斜率追踪器读取
                    let indexSlope: number | null = null;
                    if (indexEnabled) {
                        indexSlope = market.getSlope(indexSymbol);
                    }

                    const symbolSlope = market.getSlope(symbol);

                    // 日内震荡评分（B2-lite，仅在启用时算，与 onBar 完全对齐）
                    const chopScore = config.filters.enableChoppiness
                        ? scoreChoppiness(
                              fakeBars.slice(-config.choppiness.windowBars),
                              vwap,
                              a,
                              {
                                  windowBars: config.choppiness.windowBars,
                                  bandAtrRatios: config.choppiness.bandAtrRatios,
                              },
                          )
                        : null;

                    let dir = strategy.canOpen(
                        symbol,
                        preBars as any,
                        vwap,
                        a,
                        rsi,
                        volumeRatio,
                        indexSlope,
                        symbolSlope,
                        chopScore,
                    );

                    // 个股 VWAP 斜率二次过滤（实验用，和 canOpen 内的 enableSlopeMomentum 独立）
                    if (dir && opts.slopeFilter) {
                        const slopeBps =
                            symbolSlope !== null && vwap > 0
                                ? (symbolSlope / vwap) * 10000
                                : null;

                        if (opts.slopeFilter.mode === 'trend') {
                            // 顺势：slope 方向与 dir 一致且 ≥ threshold
                            const th = opts.slopeFilter.threshold;
                            if (slopeBps !== null) {
                                if (dir === OrderSide.Buy && slopeBps < th) dir = null;
                                else if (dir === OrderSide.Sell && slopeBps > -th) dir = null;
                            }
                            // slopeBps === null (warmup) → 放行
                        } else if (opts.slopeFilter.mode === 'revert') {
                            // 逆势：|slope| ≥ threshold 且方向相反
                            const th = opts.slopeFilter.threshold;
                            if (slopeBps === null) {
                                dir = null; // 无斜率数据不做逆势
                            } else if (dir === OrderSide.Buy && slopeBps > -th) {
                                dir = null; // 做多要求 slope 大幅为负（超跌）
                            } else if (dir === OrderSide.Sell && slopeBps < th) {
                                dir = null; // 做空要求 slope 大幅为正（超涨）
                            }
                        } else {
                            // momentum：|slope| ≥ threshold 才放行（过滤震荡）
                            const th = opts.slopeFilter.threshold;
                            if (slopeBps === null || Math.abs(slopeBps) < th) {
                                dir = null;
                            }
                        }
                    }

                    if (dir) {
                        const chopSnapshot: BacktestTrade['entryChopScore'] = chopScore
                            ? {
                                  total: chopScore.total,
                                  crossings: chopScore.crossings,
                                  bandRatio: chopScore.bandRatio,
                                  details: chopScore.details,
                              }
                            : null;
                        if (trendDetectorEnabled) {
                            const scoreInfo = dayScoreMap[symbol];
                            // undefined = 09:45 前未打分 → 禁止
                            // null      = 没基线(预热期)→ 放行
                            // object    = 有分数,按门槛判断
                            const threshold = opts.trendThreshold ?? TREND_SCORE_THRESHOLD;
                            if (scoreInfo === null) {
                                pendingEntry[symbol] = { side: dir, chopScore: chopSnapshot };
                            } else if (
                                scoreInfo &&
                                typeof scoreInfo === 'object' &&
                                scoreInfo.total >= threshold
                            ) {
                                pendingEntry[symbol] = { side: dir, chopScore: chopSnapshot };
                            }
                            // 其余情况(undefined 或分数 < 阈值)→ 不设置 pendingEntry,信号被拦截
                        } else {
                            pendingEntry[symbol] = { side: dir, chopScore: chopSnapshot };
                        }
                    }
                }
            }
        }

        processedTicks++;
        if (processedTicks % 5000 === 0) {
            console.log(
                `  [progress] ${processedTicks}/${timestamps.length} ticks, trades=${trades.length}`
            );
        }
    }

    // 结尾：如果还有持仓（不应该，因为每日 force close）
    for (const sym of Object.keys(positions)) {
        const pos = positions[sym];
        const lastBar = market.getBarAt(sym, market.getBarCount(sym) - 1)!;
        closeTrade(pos, lastBar.timestamp, lastBar.close, 'ForceClose', false);
    }

    // 恢复 config
    config.exitMode = savedExitMode;
    config.stopAtrRatio = savedStopAtrRatio;
    config.filters = savedFilters;
    config.choppiness = { ...config.choppiness, ...savedChoppiness };
    resetTrendExperimentFlags();

    const result: BacktestResult = {
        label: opts.label,
        exitMode: opts.exitMode,
        takeProfitAtrRatio: opts.takeProfitAtrRatio ?? null,
        stopLossAtrRatio: opts.stopLossAtrRatio ?? null,
        ambiguousResolution: opts.ambiguousResolution ?? null,
        startDate: new Date(timestamps[0]).toISOString().slice(0, 10),
        endDate: new Date(timestamps[timestamps.length - 1])
            .toISOString()
            .slice(0, 10),
        symbolCount: allData.length,
        totalTrades: trades.length,
        trades,
    };

    if (!fs.existsSync(RESULT_DIR)) {
        fs.mkdirSync(RESULT_DIR, { recursive: true });
    }
    const outPath = path.join(RESULT_DIR, `${opts.label}.json`);
    fs.writeFileSync(outPath, JSON.stringify(result));
    console.log(
        `[runner] 完成 ${opts.label}  交易数=${trades.length}  -> ${path.relative(process.cwd(), outPath)}`
    );
    return result;
}

/**
 * 把 SerializedBar 转成一个 "duck-typed Candlestick"，只实现 canOpen/calcRSI/calcVolume
 * 里用到的 close.toNumber() / high.toNumber() / low.toNumber() / volume。
 */
function toFakeCandles(bars: SerializedBar[]): any[] {
    return bars.map(b => ({
        open: { toNumber: () => b.open },
        close: { toNumber: () => b.close },
        high: { toNumber: () => b.high },
        low: { toNumber: () => b.low },
        volume: b.volume,
        turnover: { toNumber: () => b.turnover },
        timestamp: new Date(b.timestamp),
        tradeSession: b.tradeSession,
    }));
}

// ======================================================================
// CLI
// ======================================================================
async function main() {
    const argv = process.argv.slice(2);
    // 分离位置参数和 --flag 参数
    const positional: string[] = [];
    const flags: Record<string, string | boolean> = {};
    for (const a of argv) {
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
            else flags[a.slice(2)] = true;
        } else {
            positional.push(a);
        }
    }
    const [label, exitMode, tp, sl, resolution] = positional;
    if (!label || !exitMode) {
        console.error(
            'Usage: runner.ts <label> <trailing|fixed> [tp] [sl] [SLFirst|TPFirst]\n' +
                '  [--stop-atr=N]\n' +
                '  [--filter-rsi=on|off] [--filter-volume=on|off]\n' +
                '  [--filter-entry-phase=on|off] [--filter-index=on|off]\n' +
                '  [--filter-trend=on|off] [--trend-threshold=N] [--trend-atr-period=N]\n' +
                '  [--filter-choppiness=on|off] [--chop-window=N] [--chop-threshold=N]\n' +
                '  [--disable-trend-ind=9[,10,11]] [--ind11-mode=forward|reverse|range|off]\n' +
                '  [--slope-mode=trend|revert] [--slope-threshold=N(bps)]\n'
        );
        process.exit(1);
    }

    // --filter-xxx=on|off → opts.filters.enableXxx
    const parseFilterFlag = (k: string): boolean | undefined => {
        const v = flags[k];
        if (v === 'on' || v === true) return true;
        if (v === 'off') return false;
        return undefined;
    };
    const filterOverride: RunnerOptions['filters'] = {};
    const rsi = parseFilterFlag('filter-rsi');
    const vol = parseFilterFlag('filter-volume');
    const phase = parseFilterFlag('filter-entry-phase');
    const idx = parseFilterFlag('filter-index');
    const trend = parseFilterFlag('filter-trend');
    if (rsi !== undefined) filterOverride.enableRsiFilter = rsi;
    if (vol !== undefined) filterOverride.enableVolumeFilter = vol;
    if (phase !== undefined) filterOverride.enableEntryPhaseFilter = phase;
    if (idx !== undefined) filterOverride.enableIndexTrendFilter = idx;
    if (trend !== undefined) filterOverride.enableTrendDetector = trend;
    const chop = parseFilterFlag('filter-choppiness');
    if (chop !== undefined) filterOverride.enableChoppiness = chop;

    // --slope-mode + --slope-threshold → opts.slopeFilter
    const slopeMode = flags['slope-mode'] as string | undefined;
    const slopeThreshold = flags['slope-threshold'] as string | undefined;
    const slopeFilter: RunnerOptions['slopeFilter'] =
        slopeMode === 'trend' || slopeMode === 'revert' || slopeMode === 'momentum'
            ? { mode: slopeMode, threshold: Number(slopeThreshold ?? 0) }
            : undefined;

    const trendThresholdFlag = flags['trend-threshold'] as string | undefined;
    const trendAtrPeriodFlag = flags['trend-atr-period'] as string | undefined;
    // v4c 实验 flags
    const disableTrendIndRaw = flags['disable-trend-ind'] as string | undefined;
    let disableTrendIndicators: number[] | undefined;
    if (disableTrendIndRaw) {
        const tokens = String(disableTrendIndRaw).split(',').map(s => s.trim()).filter(s => s.length > 0);
        const parsed = tokens.map(t => Number(t));
        const invalid = tokens.filter((_t, i) => !Number.isInteger(parsed[i]) || ![9, 10, 11].includes(parsed[i]));
        if (invalid.length > 0 || parsed.length === 0) {
            console.error(`[runner] invalid --disable-trend-ind=${disableTrendIndRaw}, invalid tokens: [${invalid.join(',')}]; expected comma-separated list of 9/10/11`);
            process.exit(1);
        }
        disableTrendIndicators = parsed;
    }
    const ind11ModeFlag = flags['ind11-mode'] as string | undefined;
    let ind11Mode: Ind11Mode | undefined;
    if (ind11ModeFlag) {
        if (['forward', 'reverse', 'range', 'off'].includes(ind11ModeFlag)) {
            ind11Mode = ind11ModeFlag as Ind11Mode;
        } else {
            console.error(`[runner] invalid --ind11-mode=${ind11ModeFlag}, expected forward|reverse|range|off`);
            process.exit(1);
        }
    }
    // 互斥检查:--disable-trend-ind=11 和 --ind11-mode=(非 off) 冲突
    if (disableTrendIndicators?.includes(11) && ind11Mode && ind11Mode !== 'off') {
        console.error(
            `[runner] --disable-trend-ind=11 conflicts with --ind11-mode=${ind11Mode}; pick one`
        );
        process.exit(1);
    }
    const opts: RunnerOptions = {
        label,
        exitMode: exitMode as ExitMode,
        takeProfitAtrRatio: tp ? Number(tp) : undefined,
        stopLossAtrRatio: sl ? Number(sl) : undefined,
        ambiguousResolution:
            resolution === 'TPFirst' ? 'TPFirst' : 'SLFirst',
        stopAtrRatio:
            flags['stop-atr'] !== undefined
                ? Number(flags['stop-atr'])
                : undefined,
        filters:
            Object.keys(filterOverride).length > 0 ? filterOverride : undefined,
        slopeFilter,
        trendThreshold:
            trendThresholdFlag !== undefined ? Number(trendThresholdFlag) : undefined,
        trendAtrShortPeriod:
            trendAtrPeriodFlag !== undefined ? Number(trendAtrPeriodFlag) : undefined,
        disableTrendIndicators,
        ind11Mode,
        chopWindowBars:
            flags['chop-window'] !== undefined
                ? Number(flags['chop-window'])
                : undefined,
        chopScoreThreshold:
            flags['chop-threshold'] !== undefined
                ? Number(flags['chop-threshold'])
                : undefined,
    };

    // 一致性检查：--chop-window / --chop-threshold 必须配合 --filter-choppiness=on
    if (
        (opts.chopWindowBars !== undefined || opts.chopScoreThreshold !== undefined) &&
        opts.filters?.enableChoppiness !== true
    ) {
        console.error(
            '[runner] --chop-window / --chop-threshold 需要配合 --filter-choppiness=on 才会生效\n' +
            '         请加上 --filter-choppiness=on 或移除 chop-* 覆盖参数'
        );
        process.exit(1);
    }

    await runBacktest(opts);
}

// 仅作为 CLI 直接执行时跑 main()，被 import 时不执行
if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch(e => {
            console.error(e);
            process.exit(1);
        });
}

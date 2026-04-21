/**
 * BacktestMarket
 *
 * 复刻 src/core/realTimeMarket.ts 中 Market 类在回测里对 VWAPStrategy 暴露的能力：
 *   - getQuote(symbol)  返回当前 bar 的"伪 SecurityQuote"，其中 turnover/volume
 *     是**当日累积值**，和实盘 quote 字段语义对齐 —— calcVWAP 因此可以 1:1 复用。
 *   - getPostQuote(symbol)  返回最近 QUOTE_LENGTH 根的伪 quote 序列（新的在前、旧的在后）。
 *   - getSlope(symbol)  返回 EMA 平滑 VWAP 的斜率（和 realTimeMarket.Market 同接口）。
 *
 * 关键不变式：
 *   1. 每个 (symbol, 美东交易日) 的累积 turnover / volume 从 0 开始，跨日重置。
 *   2. 当前 bar 的 `lastDone` = bar.close（回测只有 bar 粒度）。
 *   3. getQuote 只对"已经 advance 到"的 bar 生效，未推进则返回最后一次已知值。
 *   4. advanceTo 每推进一根 bar，就 push 一个快照到 postQuotes[symbol] 的头部，
 *      维持最多 QUOTE_LENGTH 个，并更新 EMA 斜率追踪器。
 */
import { Decimal, SecurityQuote, SecurityQuote as SQ } from 'longport';
import type { SerializedBar } from './types';
import { VWAPSlopeTracker } from '../core/indicators/vwap';

export interface QuoteSnapshot {
    symbol: string;
    lastDone: Decimal;
    turnover: Decimal; // 当日累积
    volume: number;    // 当日累积（注意 SecurityQuote.volume 是 number）
    timestamp: Date;
}

/**
 * 返回 bar 所属的"美东交易日"字符串（YYYY-MM-DD）。
 * longport 给回的 timestamp 是 UTC 毫秒；美股盘中固定落在美东 09:30–16:00，
 * 换算成 UTC 后永远不会跨 UTC 日界（EST 14:30–21:00，EDT 13:30–20:00），
 * 所以直接用 UTC 日作为分组键即可 —— 不需要关心 DST。
 */
function tradingDayKey(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10);
}

class BacktestMarket {
    /** 和 realTimeMarket.Market.QUOTE_LENGTH 保持一致：最多缓存 60 个历史 quote */
    private static QUOTE_LENGTH = 60;

    /** 每个标的的 bar 时间序列（升序） */
    private bars: Record<string, SerializedBar[]> = {};
    /** 游标：bars[symbol] 中下一次 advance 要消费的 index */
    private cursor: Record<string, number> = {};
    /** 最近一次推进后的快照（提供给 getQuote） */
    private lastSnapshot: Record<string, QuoteSnapshot> = {};
    /** 当前累积状态 (symbol -> { dayKey, cumTurnover, cumVolume }) */
    private dayState: Record<
        string,
        { dayKey: string; cumTurnover: number; cumVolume: number }
    > = {};
    /** 历史 quote 序列（新的在前、旧的在后），供 getPostQuote 返回 */
    private postQuotes: Record<string, QuoteSnapshot[]> = {};
    /** EMA-VWAP 斜率追踪器 */
    private slopeTrackers: Record<string, VWAPSlopeTracker> = {};
    private emaSlopePeriod: number;

    constructor(emaSlopePeriod: number) {
        this.emaSlopePeriod = emaSlopePeriod;
    }

    loadBars(symbol: string, bars: SerializedBar[]) {
        this.bars[symbol] = bars;
        this.cursor[symbol] = 0;
        delete this.lastSnapshot[symbol];
        delete this.dayState[symbol];
        this.postQuotes[symbol] = [];
        this.slopeTrackers[symbol] = new VWAPSlopeTracker(this.emaSlopePeriod);
    }

    /**
     * 推进 symbol 的游标，让它 getQuote 反映 bar[index] 的状态。
     * 会把从上一个 index+1 到 index 之间所有 bar 的 turnover/volume
     * 按日累积规则吃掉（正常调用场景 index 是连续递增的，但保险起见允许跳过）。
     */
    advanceTo(symbol: string, index: number) {
        const bars = this.bars[symbol];
        if (!bars || index < 0 || index >= bars.length) return;

        let i = this.cursor[symbol] ?? 0;
        while (i <= index) {
            const bar = bars[i];
            const key = tradingDayKey(bar.timestamp);
            const state = this.dayState[symbol];
            if (!state || state.dayKey !== key) {
                // 跨日：重置 EMA 斜率追踪器
                this.slopeTrackers[symbol]?.reset();
                this.dayState[symbol] = {
                    dayKey: key,
                    cumTurnover: bar.turnover,
                    cumVolume: bar.volume,
                };
            } else {
                state.cumTurnover += bar.turnover;
                state.cumVolume += bar.volume;
            }
            i++;
        }
        this.cursor[symbol] = index + 1;

        const bar = bars[index];
        const st = this.dayState[symbol];
        const snap: QuoteSnapshot = {
            symbol,
            lastDone: new Decimal(bar.close),
            turnover: new Decimal(st.cumTurnover),
            volume: st.cumVolume,
            timestamp: new Date(bar.timestamp),
        };
        this.lastSnapshot[symbol] = snap;

        // 更新 EMA-VWAP 斜率
        const cumVol = st.cumVolume;
        if (cumVol > 0) {
            const vwap = st.cumTurnover / cumVol;
            this.slopeTrackers[symbol]?.update(vwap);
        }

        // 维护历史 quote 序列（和 realTimeMarket 一致：新的在前，旧的在后）
        const arr = (this.postQuotes[symbol] ??= []);
        arr.unshift(snap);
        if (arr.length > BacktestMarket.QUOTE_LENGTH) {
            arr.pop();
        }
    }

    /**
     * 供 VWAPStrategy 调用 —— 和 realTimeMarket.Market.getQuote 同名同签名。
     * 返回的对象是 duck-typed 的 SecurityQuote，只保证 lastDone / turnover /
     * volume / symbol / timestamp 这几个策略实际用到的字段。用 `as unknown as`
     * 强转绕过 longport native class 的 nominal 类型检查。
     */
    getQuote(symbol: string): SecurityQuote {
        const snap = this.lastSnapshot[symbol];
        if (!snap) {
            // 策略在 advance 之前调用：返回一个零值快照，volume=0 会让 calcVWAP=NaN，
            // 策略自身会因为 preBars 不足等条件不进场。
            return {
                symbol,
                lastDone: new Decimal(0),
                turnover: new Decimal(0),
                volume: 0,
                timestamp: new Date(0),
            } as unknown as SecurityQuote;
        }
        return snap as unknown as SQ;
    }

    /**
     * ��回最近 QUOTE_LENGTH 根的历史 quote 序列（新的在前）。
     * 和 realTimeMarket.Market.getPostQuote 顺序一致。
     */
    getPostQuote(symbol: string): SecurityQuote[] {
        const arr = this.postQuotes[symbol];
        if (!arr || arr.length === 0) return [];
        return arr as unknown as SecurityQuote[];
    }

    /** ���取 symbol 的 EMA-VWAP 斜率（null = warmup 中或无数据） */
    getSlope(symbol: string): number | null {
        return this.slopeTrackers[symbol]?.getSlope() ?? null;
    }

    // ============ 回测内部辅助 ============
    getBarAt(symbol: string, index: number): SerializedBar | undefined {
        return this.bars[symbol]?.[index];
    }

    getBarCount(symbol: string): number {
        return this.bars[symbol]?.length ?? 0;
    }
}

export { BacktestMarket };

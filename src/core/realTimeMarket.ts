import strategyConfig from "../config/strategy.config";
import { getAllSymbols } from "../config/symbolPools";
import { getQuote } from "../longbridge/market";
import { SecurityQuote } from "longport";
import { timeGuard } from "./timeGuard";
import { logger } from "../utils/logger";
import { calcVWAP, VWAPSlopeTracker } from "./indicators/vwap";

/** 
 * 注意⚠️：行情管理的历史行情会有延迟，只能用来进行历史数据分析，不能作为实时交易的根据，要获取实时行情请使用直接调用API的方法
 * 
 * 行情管理：
 * 1. 管理过往包括一分钟k线数据、过往实时行情，每30s更新一次
 * 2. 不受开盘和收盘的特殊时间段的约束
 * 3. 支持获取当前的实时行情
 */
class Market {
    private postQuotes: Record<string, SecurityQuote[]> = {}; // 记录过往的行情数据
    private marketQuotes: Record<string, SecurityQuote> = {}; // 记录实时行情
    private slopeTrackers: Record<string, VWAPSlopeTracker> = {}; // EMA-VWAP 斜率追踪器

    private UPDATE_INTERVAL = 60000; // 1 min 更新一次行情数据
    private QUOTE_LENGTH = 60; // 1 min 一个实时行情

    constructor() {
        // 需要缓存历史 quote 的标的列表：交易标的 +（可选）指数标的
        const watchSymbols = new Set<string>(getAllSymbols());
        const indexSymbol = strategyConfig.indexTrendFilter.indexSymbol;
        if (strategyConfig.filters.enableIndexTrendFilter && indexSymbol) {
            watchSymbols.add(indexSymbol);
        }

        const period = strategyConfig.emaSlopePeriod;
        watchSymbols.forEach(symbol => {
            this.postQuotes[symbol] = [];
            this.slopeTrackers[symbol] = new VWAPSlopeTracker(period);
        });
    }

    start() {
        logger.info('🚀 行情管理启动');
        this.updateQuote();
        // 1 min 更新一次行情数据
        setInterval(() => {
            if (timeGuard.isInTradeTime()) {
                void this.updateQuote();
            }
        }, this.UPDATE_INTERVAL);
    }

    async updateQuote() {
        logger.info('🚀 更新行情数据');
        const symbolsSet = new Set<string>(getAllSymbols());
        const indexSymbol = strategyConfig.indexTrendFilter.indexSymbol;
        if (strategyConfig.filters.enableIndexTrendFilter && indexSymbol) {
            symbolsSet.add(indexSymbol);
        }
        const quotes = await getQuote([...symbolsSet]);

        for (const quote of quotes) {
            const newQuote = [quote, ...this.postQuotes[quote.symbol]];
            if (newQuote.length > this.QUOTE_LENGTH) {
                newQuote.pop();
            }
            this.postQuotes[quote.symbol] = newQuote;

            // 更新 EMA-VWAP 斜率
            const vwap = calcVWAP(quote);
            this.slopeTrackers[quote.symbol]?.update(vwap);
        }
    }

    /**
     * 每次循环都要调用，获取标的的实时行情
     * @param symbols 标的代码
     * @returns 
     */
    async initMarketQuote(symbols: string[]) {
        const quotes = await getQuote(symbols);
        quotes.forEach(q => {
            this.marketQuotes[q.symbol] = q;
        });
        return quotes;
    }

    getPostQuote(symbol: string) {
        return this.postQuotes[symbol];
    }

    getQuote(symbol: string) {
        return this.marketQuotes[symbol];
    }

    /** 获取 symbol 的 EMA-VWAP 斜率（null = warmup 中或无数据） */
    getSlope(symbol: string): number | null {
        return this.slopeTrackers[symbol]?.getSlope() ?? null;
    }

    /** 每日重置所有 EMA 斜率追踪器（新交易日开始时调用） */
    resetDailyState() {
        for (const tracker of Object.values(this.slopeTrackers)) {
            tracker.reset();
        }
    }
}

export {
    Market,
}

/**
 * 回测模块共享类型定义。
 */

/** 序列化后的分钟 K（由 fetchHistory 写入 json 文件）。 */
export interface SerializedBar {
    timestamp: number; // UTC ms
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    turnover: number;
    tradeSession: number;
}

/** 单笔回测成交记录。 */
export interface BacktestTrade {
    symbol: string;
    side: 'Buy' | 'Sell';
    entryTimestamp: number;
    entryPrice: number;
    exitTimestamp: number;
    exitPrice: number;
    exitReason: 'TP' | 'SL' | 'ForceClose';
    /** 开仓时的初始风险（= |entry - stop|），用于计算 R multiple */
    initialRisk: number;
    rMultiple: number;
    /**
     * 开仓时的时段标签：
     *   early – 早盘只看价格段
     *   main  – 主交易段（带 RSI/量比）
     *   late  – 尾盘只看价格段
     */
    phaseAtEntry: 'early' | 'main' | 'late' | 'unknown';
    /** 出场所在 bar 内是否同时触及 TP 和 SL（仅 fixed 模式有意义） */
    ambiguousExit: boolean;
    /**
     * 入场当日该票的趋势日评分(0–100)。null 表示:
     *   - 该交易日处于 RVOL 预热期(前 ~20 天)或其他 baseline 缺失情况
     *   - 或 detector 模块本身关闭(runner 运行时没有填)
     * 旧 result json 里不存在此字段,读脚本应用 `t.entryDayScore ?? null` 兼容
     * (字段声明为 optional,兼容旧结果文件反序列化)。
     */
    entryDayScore?: number | null;
    /**
     * 入场当日该票的评分明细(5 指标分数 + raw values)。
     * 运行时 detector 打分后写入。旧 result json 不存在此字段。
     */
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
            rangeAtrRatio?: number; // optional(旧 json 没有)
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
}

/** 一次回测 run 的完整输出。 */
export interface BacktestResult {
    label: string;
    exitMode: 'trailing' | 'fixed';
    takeProfitAtrRatio: number | null;
    stopLossAtrRatio: number | null;
    ambiguousResolution: 'SLFirst' | 'TPFirst' | null;
    startDate: string;
    endDate: string;
    symbolCount: number;
    totalTrades: number;
    trades: BacktestTrade[];
}

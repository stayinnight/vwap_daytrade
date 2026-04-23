/**
 * B2-lite 日内震荡评分（纯函数）
 *
 * 设计文档：docs/superpowers/specs/2026-04-22-b2-lite-choppiness-filter-design.md
 *
 * 评分组成（满分 70）：
 *   - 指标 1：VWAP 穿越频率（权重 40）
 *   - 指标 2：带内时长比（权重 30，三档独立加权）
 *
 * 跨 windowBars 评分可比：指标 1 用频率（次数 / (N-1)），指标 2 是百分比。
 *
 * 实盘 / 回测共用本函数，禁止读取 longport 任何接口、禁止读取文件 / 时间戳。
 */
import { Candlestick } from 'longport';

export interface ChoppinessParams {
    windowBars: number;
    bandAtrRatios: number[]; // 例如 [0.1, 0.2, 0.3]
}

export interface ChoppinessScore {
    total: number;       // 0–70
    crossings: number;   // 分项分（满分 40）
    bandRatio: number;   // 分项分（满分 30）
    details: {
        crossingCount: number;     // 实际穿越次数（保留无信息损失）
        crossingRate: number;      // crossingCount / (N - 1)，0–1，跨 window 可比
        inBandRatios: number[];    // 各档实际带内比例 0–1，与 bandAtrRatios 同序
    };
}

// ====== 分档表 ======
// 指标 1：穿越频率分档（频率越低分越高，跨 window 共用）
const CROSSING_RATE_TIERS: { maxRate: number; score: number }[] = [
    { maxRate: 0.05, score: 40 },
    { maxRate: 0.15, score: 25 },
    { maxRate: 0.25, score: 10 },
    // > 0.25 → 0
];

// 指标 2：每档带内比例分档（每档独立打分，最高 10）
const BAND_TIER_SCORES: { maxRatio: number; score: number }[] = [
    { maxRatio: 0.3, score: 10 },
    { maxRatio: 0.5, score: 6 },
    { maxRatio: 0.7, score: 3 },
    // > 0.7 → 0
];

/**
 * 入参 bars 是最近 windowBars 根已收盘 K（按时间正序，0 最旧、N-1 最新）。
 * vwap 是当根 K 时刻的累计 VWAP（单一数值，所有 N 根都和它比）。
 * atr 是当日 ATR。
 *
 * 返回 null 的条件：
 *   - bars.length < windowBars（warmup）
 *   - atr <= 0
 *   - vwap <= 0 或非有限数
 */
export function scoreChoppiness(
    bars: Candlestick[],
    vwap: number,
    atr: number,
    params: ChoppinessParams,
): ChoppinessScore | null {
    const N = params.windowBars;
    if (bars.length < N) return null;
    if (!(atr > 0)) return null;
    if (!Number.isFinite(vwap) || vwap <= 0) return null;

    // 取最后 N 根（防御性切片：bars 长度 > N 时只用最近 N 根）
    const barWindow = bars.slice(-N);

    // ====== 指标 1：VWAP 穿越频率 ======
    // spec: side[i] === 0（close 等于 vwap，极少）按"无变化"处理，跳过该次比对。
    // 实现：side === 0 时不更新 prevSide，下一根非零 side 仍和"上一个非零 side"比。
    let crossingCount = 0;
    let prevSide = 0;
    for (let i = 0; i < N; i++) {
        const close = barWindow[i].close.toNumber();
        const side = close > vwap ? 1 : close < vwap ? -1 : 0;
        if (i > 0 && side !== 0 && prevSide !== 0 && side !== prevSide) {
            crossingCount++;
        }
        if (side !== 0) prevSide = side;
    }
    const crossingRate = N > 1 ? crossingCount / (N - 1) : 0;

    let crossingsScore = 0;
    for (const tier of CROSSING_RATE_TIERS) {
        if (crossingRate <= tier.maxRate) {
            crossingsScore = tier.score;
            break;
        }
    }

    // ====== 指标 2：带内时长比（三档独立加权）======
    const inBandRatios: number[] = [];
    let bandRatioScore = 0;
    for (const k of params.bandAtrRatios) {
        const bandWidth = k * atr;
        let inBandCount = 0;
        for (let i = 0; i < N; i++) {
            const close = barWindow[i].close.toNumber();
            if (Math.abs(close - vwap) <= bandWidth) inBandCount++;
        }
        const ratio = inBandCount / N;
        inBandRatios.push(ratio);

        let score = 0;
        for (const tier of BAND_TIER_SCORES) {
            if (ratio <= tier.maxRatio) {
                score = tier.score;
                break;
            }
        }
        bandRatioScore += score;
    }

    return {
        total: crossingsScore + bandRatioScore,
        crossings: crossingsScore,
        bandRatio: bandRatioScore,
        details: {
            crossingCount,
            crossingRate,
            inBandRatios,
        },
    };
}

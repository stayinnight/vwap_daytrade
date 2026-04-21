/**
 * 标的特征深度分析 V2：加入量比、趋势、突破跟随率
 *
 * 目标：找出"赢家 vs 输家"的结构性特征，用于沉淀选股规则。
 *
 * 新增的客观指标：
 *   A. 开盘量比（openVolumeRatio）：开盘前 15 min 总量 / 日均每 15 min 量
 *       —— 刻画"开盘是不是被放量驱动"
 *   B. 日内趋势持续性（trendPersistence）：一天内价格在 VWAP 同一侧的占比
 *       —— 越高越"trending"，越低越"choppy"
 *   C. 突破跟随率（breakoutFollowThrough）：价格穿越 VWAP 后 5 min 内继续同向的概率
 *       —— 直接刻画"突破是真突破还是假突破"。这是最贴近策略信号质量的指标
 *   D. 开盘 15 min 反转率（openingReversalRate）：开盘前 15 min 的方向
 *       在后续 60 min 被反转的频率
 *   E. 收盘相对 VWAP 偏离：收盘价 / 收盘 VWAP - 1 的绝对值
 *       —— 是否容易尾盘偏离 VWAP
 *
 * 输出：data/backtest/symbol_analysis_v2.md
 */
import * as fs from 'fs';
import * as path from 'path';
import { BacktestResult, SerializedBar, BacktestTrade } from './types';

const RAW_DIR = path.resolve(process.cwd(), 'data/backtest/raw');
const RESULT_DIR = path.resolve(process.cwd(), 'data/backtest/results');
const OUT_PATH = path.resolve(
    process.cwd(),
    'data/backtest/symbol_analysis_v2.md'
);

interface PriceFeatures {
    symbol: string;
    avgClose: number;
    avgDailyAtrPct: number;
    avgDailyTurnover: number;
    // 新增：
    avgOpenVolumeRatio: number;       // 开盘 15min 量 / 日均每 15min 量
    avgTrendPersistence: number;      // 同一侧占比（>0.5 表示偏 trending）
    avgBreakoutFollowThrough: number; // 突破 VWAP 后 5min 继续同向概率
    avgOpeningReversalRate: number;   // 开盘 15min 方向被后续 60min 反转的频率
    avgCloseVsVwapDeviation: number;  // 收盘价相对 VWAP 的偏离 %
    avgTrendDirection: number;        // 日内 close-open 的方向比例：+表示偏多, -表示偏空
}

function computeFeatures(symbol: string): PriceFeatures {
    const raw = JSON.parse(
        fs.readFileSync(path.join(RAW_DIR, `${symbol}.json`), 'utf8')
    );
    const bars: SerializedBar[] = raw.bars;

    // 按 UTC 日分组
    const byDay: Record<string, SerializedBar[]> = {};
    for (const b of bars) {
        const k = new Date(b.timestamp).toISOString().slice(0, 10);
        (byDay[k] ??= []).push(b);
    }
    const days = Object.keys(byDay).sort();

    let sumClose = 0;
    let sumAtrPct = 0;
    let sumTurnover = 0;
    let sumOpenVolRatio = 0;
    let sumTrendPersist = 0;
    let sumBreakoutFT = 0;
    let sumOpeningReversal = 0;
    let sumCloseVsVwap = 0;
    let sumTrendDir = 0;
    let n = 0;

    for (const key of days) {
        const dayBars = byDay[key];
        if (dayBars.length < 300) continue;

        const close = dayBars[dayBars.length - 1].close;
        const open = dayBars[0].open;
        const high = Math.max(...dayBars.map(b => b.high));
        const low = Math.min(...dayBars.map(b => b.low));
        if (close <= 0) continue;

        const totalTurnover = dayBars.reduce((a, b) => a + b.turnover, 0);
        const totalVolume = dayBars.reduce((a, b) => a + b.volume, 0);
        const dayVwap = totalTurnover / totalVolume;

        // === A. 开盘量比：前 15 根量 / 日均每 15 根量 ===
        const first15Vol = dayBars
            .slice(0, 15)
            .reduce((a, b) => a + b.volume, 0);
        const avgPer15 = (totalVolume / dayBars.length) * 15;
        const openVolRatio = avgPer15 > 0 ? first15Vol / avgPer15 : 0;
        sumOpenVolRatio += openVolRatio;

        // === B. 日内趋势持续性：累积 VWAP 和 close 的相对关系 ===
        // 定义：一天里每根 K 的 close 相对于"当时的累积 VWAP"，在上方还是下方
        // 占优的那一侧比例 = max(aboveCount, belowCount) / total
        let cumT = 0;
        let cumV = 0;
        let above = 0;
        let below = 0;
        for (const b of dayBars) {
            cumT += b.turnover;
            cumV += b.volume;
            const vwap = cumV > 0 ? cumT / cumV : b.close;
            if (b.close > vwap) above++;
            else if (b.close < vwap) below++;
        }
        const persist = Math.max(above, below) / dayBars.length;
        sumTrendPersist += persist;

        // === C. 突破跟随率：检测每次 close 穿越 VWAP，看之后 5 根 K 是不是同向 ===
        cumT = 0;
        cumV = 0;
        const vwapSeries: number[] = [];
        for (const b of dayBars) {
            cumT += b.turnover;
            cumV += b.volume;
            vwapSeries.push(cumV > 0 ? cumT / cumV : b.close);
        }
        let breakoutCount = 0;
        let breakoutSuccess = 0;
        for (let i = 1; i < dayBars.length - 5; i++) {
            const prevAbove = dayBars[i - 1].close > vwapSeries[i - 1];
            const currAbove = dayBars[i].close > vwapSeries[i];
            if (prevAbove !== currAbove) {
                breakoutCount++;
                // 后 5 根看是否继续同向
                const breakoutPrice = dayBars[i].close;
                const after5 = dayBars[i + 5].close;
                if (currAbove && after5 > breakoutPrice) breakoutSuccess++;
                else if (!currAbove && after5 < breakoutPrice) breakoutSuccess++;
            }
        }
        if (breakoutCount > 0) {
            sumBreakoutFT += breakoutSuccess / breakoutCount;
        } else {
            sumBreakoutFT += 0.5; // 无突破按中性
        }

        // === D. 开盘方向反转率 ===
        // 开盘前 15 min 的方向 = sign(close_15 - open)
        // 后续 60 min 的方向 = sign(close_75 - close_15)
        // 反转 = 两个符号相反
        if (dayBars.length > 75) {
            const dir1 = Math.sign(dayBars[14].close - dayBars[0].open);
            const dir2 = Math.sign(dayBars[74].close - dayBars[14].close);
            if (dir1 !== 0 && dir2 !== 0 && dir1 !== dir2) {
                sumOpeningReversal += 1;
            }
        }

        // === E. 收盘相对 VWAP 偏离 ===
        const closeDev = Math.abs((close - dayVwap) / dayVwap) * 100;
        sumCloseVsVwap += closeDev;

        // === F. 日内大方向 ===
        sumTrendDir += Math.sign(close - open);

        // 基础特征
        sumClose += close;
        sumAtrPct += ((high - low) / close) * 100;
        sumTurnover += totalTurnover;
        n++;
    }

    const d = Math.max(1, n);
    return {
        symbol,
        avgClose: sumClose / d,
        avgDailyAtrPct: sumAtrPct / d,
        avgDailyTurnover: sumTurnover / d,
        avgOpenVolumeRatio: sumOpenVolRatio / d,
        avgTrendPersistence: sumTrendPersist / d,
        avgBreakoutFollowThrough: sumBreakoutFT / d,
        avgOpeningReversalRate: sumOpeningReversal / d,
        avgCloseVsVwapDeviation: sumCloseVsVwap / d,
        avgTrendDirection: sumTrendDir / d,
    };
}

interface StrategyFeatures {
    trades: number;
    winRate: number;
    cumR: number;
    firstHalfR: number;
    secondHalfR: number;
    stableWinner: boolean;
    stableLoser: boolean;
    flipped: boolean;
    earlyR: number;
}

function computeStrategy(
    symbol: string,
    trades: BacktestTrade[]
): StrategyFeatures {
    const sym = trades.filter(t => t.symbol === symbol);
    if (sym.length === 0) {
        return {
            trades: 0, winRate: 0, cumR: 0,
            firstHalfR: 0, secondHalfR: 0,
            stableWinner: false, stableLoser: false, flipped: false,
            earlyR: 0,
        };
    }
    const rs = sym.map(t => t.rMultiple);
    const wins = rs.filter(r => r > 0).length;
    const cum = rs.reduce((a, b) => a + b, 0);
    const sorted = [...sym].sort((a, b) => a.entryTimestamp - b.entryTimestamp);
    const mid = Math.floor(sorted.length / 2);
    const firstHalfR = sorted.slice(0, mid).reduce((a, t) => a + t.rMultiple, 0);
    const secondHalfR = sorted.slice(mid).reduce((a, t) => a + t.rMultiple, 0);
    return {
        trades: sym.length,
        winRate: (wins / sym.length) * 100,
        cumR: cum,
        firstHalfR,
        secondHalfR,
        stableWinner: firstHalfR > 0 && secondHalfR > 0,
        stableLoser: firstHalfR < 0 && secondHalfR < 0,
        flipped:
            (firstHalfR > 0 && secondHalfR < 0) ||
            (firstHalfR < 0 && secondHalfR > 0),
        earlyR: sym
            .filter(t => t.phaseAtEntry === 'early')
            .reduce((a, t) => a + t.rMultiple, 0),
    };
}

// 简单 Pearson 相关系数
function correlation(x: number[], y: number[]): number {
    const n = x.length;
    const mx = x.reduce((a, b) => a + b, 0) / n;
    const my = y.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let dx2 = 0;
    let dy2 = 0;
    for (let i = 0; i < n; i++) {
        const a = x[i] - mx;
        const b = y[i] - my;
        num += a * b;
        dx2 += a * a;
        dy2 += b * b;
    }
    const denom = Math.sqrt(dx2 * dy2);
    return denom > 0 ? num / denom : 0;
}

function main() {
    const baseline: BacktestResult = JSON.parse(
        fs.readFileSync(path.join(RESULT_DIR, 'baseline.json'), 'utf8')
    );
    const symbols = Array.from(new Set(baseline.trades.map(t => t.symbol))).sort();

    const rows = symbols.map(s => {
        const p = computeFeatures(s);
        const st = computeStrategy(s, baseline.trades);
        return { ...p, ...st };
    });

    const winners = rows.filter(r => r.stableWinner);
    const losers = rows.filter(r => r.stableLoser);
    const flippers = rows.filter(r => r.flipped);

    function avg<K extends keyof (typeof rows)[0]>(
        list: typeof rows,
        key: K
    ): number {
        if (list.length === 0) return 0;
        const sum = list.reduce((a, r) => a + (r[key] as unknown as number), 0);
        return sum / list.length;
    }

    // 计算每个特征和 cumR 的相关系数（全样本）
    const cumRs = rows.map(r => r.cumR);
    const featureKeys: Array<{
        key: keyof (typeof rows)[0];
        label: string;
        digits: number;
    }> = [
        { key: 'avgClose', label: '均价 $', digits: 2 },
        { key: 'avgDailyAtrPct', label: '日 ATR%', digits: 2 },
        { key: 'avgDailyTurnover', label: '日均换手 $', digits: 0 },
        { key: 'avgOpenVolumeRatio', label: '开盘量比', digits: 2 },
        { key: 'avgTrendPersistence', label: '趋势持续性', digits: 3 },
        { key: 'avgBreakoutFollowThrough', label: '突破跟随率', digits: 3 },
        { key: 'avgOpeningReversalRate', label: '开盘反转率', digits: 3 },
        { key: 'avgCloseVsVwapDeviation', label: '收盘偏 VWAP %', digits: 2 },
        { key: 'avgTrendDirection', label: '日内多空倾向', digits: 3 },
    ];
    const correlations = featureKeys.map(f => {
        const xs = rows.map(r => r[f.key] as unknown as number);
        return { ...f, corr: correlation(xs, cumRs) };
    });

    const lines: string[] = [];
    const push = (s: string) => lines.push(s);

    push('# 标的盈亏特征深度分析 V2（量比 + 趋势 + 突破跟随率）');
    push('');
    push(`- 样本：${rows.length} 支票 × 32 交易日 × baseline trailing`);
    push(
        '- 所有特征都是**跨日平均**，不依赖策略信号；目的是找"选股规则"而不是"过滤信号"。'
    );
    push('');

    push('## 1. 全特征与 cumR 的相关系数（按绝对值排序）');
    push('');
    push('| 特征 | 相关系数 | 解读 |');
    push('|---|---|---|');
    const sortedCorr = [...correlations].sort(
        (a, b) => Math.abs(b.corr) - Math.abs(a.corr)
    );
    for (const c of sortedCorr) {
        const direction =
            c.corr > 0.3
                ? '**正相关（越高越赚）**'
                : c.corr < -0.3
                ? '**负相关（越高越亏）**'
                : '弱相关';
        push(
            `| ${c.label} | ${c.corr >= 0 ? '+' : ''}${c.corr.toFixed(3)} | ${direction} |`
        );
    }
    push('');
    push(
        '> 相关系数 |r| > 0.3 有方向指示意义，|r| > 0.5 有较强指示，|r| < 0.2 基本是噪音。'
    );
    push('');

    push('## 2. 稳定赢家 vs 稳定输家：新特征对比');
    push('');
    push(
        `| 特征 | 赢家 (${winners.length}) | 输家 (${losers.length}) | 差值 | 方向 |`
    );
    push('|---|---|---|---|---|');
    for (const c of featureKeys) {
        const aw = avg(winners, c.key);
        const al = avg(losers, c.key);
        const diff = aw - al;
        const better = diff > 0 ? '赢家更高' : diff < 0 ? '输家更高' : '持平';
        const fmtNum = (n: number) => n.toFixed(c.digits);
        push(
            `| ${c.label} | ${fmtNum(aw)} | ${fmtNum(al)} | ${
                diff >= 0 ? '+' : ''
            }${fmtNum(diff)} | ${better} |`
        );
    }
    push('');

    push('## 3. 按"突破跟随率"排序 —— 这是策略最核心的指标');
    push('');
    push(
        '> 突破跟随率 = 价格穿越当时累积 VWAP 后 5 min 内继续同向的概率。0.5 = 随机，>0.55 = 真突破占多数。'
    );
    push('');
    push(
        '| 标的 | 跟随率 | cumR | 稳定性 | 胜率 | early R | 开盘量比 | 趋势持续性 |'
    );
    push('|---|---|---|---|---|---|---|---|');
    const byFT = [...rows].sort(
        (a, b) => b.avgBreakoutFollowThrough - a.avgBreakoutFollowThrough
    );
    for (const r of byFT) {
        const tag = r.stableWinner
            ? '✅'
            : r.stableLoser
            ? '❌'
            : r.flipped
            ? '🔄'
            : '➖';
        push(
            `| ${r.symbol} | ${r.avgBreakoutFollowThrough.toFixed(
                3
            )} | ${r.cumR.toFixed(2)} | ${tag} | ${r.winRate.toFixed(
                1
            )}% | ${r.earlyR.toFixed(1)} | ${r.avgOpenVolumeRatio.toFixed(
                2
            )} | ${r.avgTrendPersistence.toFixed(3)} |`
        );
    }
    push('');

    push('## 4. 按"开盘量比"排序 —— 大开盘量是好还是坏');
    push('');
    push('| 标的 | 开盘量比 | cumR | 稳定性 | early R |');
    push('|---|---|---|---|---|');
    const byVol = [...rows].sort(
        (a, b) => b.avgOpenVolumeRatio - a.avgOpenVolumeRatio
    );
    for (const r of byVol) {
        const tag = r.stableWinner ? '✅' : r.stableLoser ? '❌' : r.flipped ? '🔄' : '➖';
        push(
            `| ${r.symbol} | ${r.avgOpenVolumeRatio.toFixed(2)} | ${r.cumR.toFixed(
                2
            )} | ${tag} | ${r.earlyR.toFixed(1)} |`
        );
    }
    push('');

    push('## 5. 按"趋势持续性"排序 —— 偏 trending 还是偏 choppy');
    push('');
    push(
        '> 趋势持续性 = 一天内 close 相对当时 VWAP 在同一侧的占比。>0.65 = 偏 trending，<0.55 = 偏 choppy。'
    );
    push('');
    push('| 标的 | 持续性 | cumR | 稳定性 | early R |');
    push('|---|---|---|---|---|');
    const byTrend = [...rows].sort(
        (a, b) => b.avgTrendPersistence - a.avgTrendPersistence
    );
    for (const r of byTrend) {
        const tag = r.stableWinner ? '✅' : r.stableLoser ? '❌' : r.flipped ? '🔄' : '➖';
        push(
            `| ${r.symbol} | ${r.avgTrendPersistence.toFixed(3)} | ${r.cumR.toFixed(
                2
            )} | ${tag} | ${r.earlyR.toFixed(1)} |`
        );
    }
    push('');

    // ===== 关键推论：找阈值 =====
    // 策略：假设"跟随率 > median" 是好票，回看赢家/输家的分布
    const medianFT = [...rows]
        .map(r => r.avgBreakoutFollowThrough)
        .sort((a, b) => a - b)[Math.floor(rows.length / 2)];
    const topFT = rows.filter(r => r.avgBreakoutFollowThrough >= medianFT);
    const botFT = rows.filter(r => r.avgBreakoutFollowThrough < medianFT);
    const sumR = (l: typeof rows) => l.reduce((a, r) => a + r.cumR, 0);

    push('## 6. 阈值筛选模拟');
    push('');
    push(`中位数突破跟随率 = ${medianFT.toFixed(3)}`);
    push('');
    push('| 筛选规则 | 入围数 | 合计 cumR | 赢家占比 |');
    push('|---|---|---|---|');
    push(
        `| 跟随率 >= ${medianFT.toFixed(3)}（上半） | ${topFT.length} | ${sumR(
            topFT
        ).toFixed(2)} | ${(
            (topFT.filter(r => r.stableWinner).length / topFT.length) *
            100
        ).toFixed(0)}% |`
    );
    push(
        `| 跟随率 < ${medianFT.toFixed(3)}（下半） | ${botFT.length} | ${sumR(
            botFT
        ).toFixed(2)} | ${(
            (botFT.filter(r => r.stableWinner).length / botFT.length) *
            100
        ).toFixed(0)}% |`
    );
    push('');

    // 组合筛选
    const combo1 = rows.filter(
        r =>
            r.avgBreakoutFollowThrough >= medianFT &&
            r.avgTrendPersistence >= 0.58
    );
    const combo2 = rows.filter(
        r =>
            r.avgBreakoutFollowThrough < medianFT ||
            r.avgTrendPersistence < 0.55
    );
    push(
        '| 组合：跟随率 >= 中位 AND 趋势持续性 >= 0.58 | ' +
            combo1.length +
            ' | ' +
            sumR(combo1).toFixed(2) +
            ' | ' +
            (
                (combo1.filter(r => r.stableWinner).length /
                    Math.max(1, combo1.length)) *
                100
            ).toFixed(0) +
            '% |'
    );
    push(
        '| 组合：跟随率 < 中位 OR 趋势持续性 < 0.55 | ' +
            combo2.length +
            ' | ' +
            sumR(combo2).toFixed(2) +
            ' | ' +
            (
                (combo2.filter(r => r.stableWinner).length /
                    Math.max(1, combo2.length)) *
                100
            ).toFixed(0) +
            '% |'
    );
    push('');

    push('## 7. 每只票的完整特征矩阵');
    push('');
    push(
        '| 标的 | cumR | 稳 | 胜率 | ATR% | 开盘量比 | 趋势持 | 突破跟随 | 开盘反转 | 收盘偏VWAP% |'
    );
    push('|---|---|---|---|---|---|---|---|---|---|');
    const ordered = [...rows].sort((a, b) => b.cumR - a.cumR);
    for (const r of ordered) {
        const tag = r.stableWinner ? '✅' : r.stableLoser ? '❌' : r.flipped ? '🔄' : '➖';
        push(
            `| ${r.symbol} | ${r.cumR.toFixed(2)} | ${tag} | ${r.winRate.toFixed(
                1
            )}% | ${r.avgDailyAtrPct.toFixed(2)}% | ${r.avgOpenVolumeRatio.toFixed(
                2
            )} | ${r.avgTrendPersistence.toFixed(
                3
            )} | ${r.avgBreakoutFollowThrough.toFixed(
                3
            )} | ${r.avgOpeningReversalRate.toFixed(
                3
            )} | ${r.avgCloseVsVwapDeviation.toFixed(2)}% |`
        );
    }
    push('');

    fs.writeFileSync(OUT_PATH, lines.join('\n'));
    console.log(
        `[analyze v2] 写入 ${path.relative(process.cwd(), OUT_PATH)}  (${
            lines.length
        } lines)`
    );
    // 控制台简报
    console.log('\n=== 相关系数摘要 ===');
    sortedCorr.forEach(c =>
        console.log(
            `${c.label.padEnd(18, ' ')}  r=${c.corr >= 0 ? '+' : ''}${c.corr.toFixed(
                3
            )}`
        )
    );
}

main();

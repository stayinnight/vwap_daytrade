/**
 * 趋势日 Detector v2 诊断脚本:分析 5 个指标各自的区分力。
 *
 * 输入: data/backtest/results/trend_v2_recordonly_sl010.json
 * 输出: stdout 打印诊断表,按指标分桶看 avgR / winRate / trade 数
 *
 * 跑法:
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/analyzeTrendWeights.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { BacktestResult, BacktestTrade } from './types';

// 可通过 CLI 传 label 覆盖:npx ts-node analyzeTrendWeights.ts trend_v3_recordonly_sl010
const RESULT_LABEL = process.argv[2] || 'trend_v2_recordonly_sl010';
const RESULT_PATH = path.resolve(
    process.cwd(),
    `data/backtest/results/${RESULT_LABEL}.json`
);

interface TradeWithDetail extends BacktestTrade {
    entryDayScoreDetail: NonNullable<BacktestTrade['entryDayScoreDetail']>;
}

function loadTrades(): TradeWithDetail[] {
    console.log(`加载结果: ${RESULT_PATH}`);
    const raw: BacktestResult = JSON.parse(fs.readFileSync(RESULT_PATH, 'utf8'));
    return raw.trades.filter(
        (t): t is TradeWithDetail => t.entryDayScoreDetail != null
    );
}

interface BucketStat {
    label: string;
    trades: number;
    avgR: number;
    winRate: number;
    cumR: number;
}

function bucketize(
    trades: TradeWithDetail[],
    getValue: (t: TradeWithDetail) => number,
    bucketEdges: number[]
): BucketStat[] {
    const stats: BucketStat[] = [];
    for (let i = 0; i < bucketEdges.length - 1; i++) {
        const lo = bucketEdges[i];
        const hi = bucketEdges[i + 1];
        const isLast = i === bucketEdges.length - 2;
        const subset = trades.filter(t => {
            const v = getValue(t);
            return isLast ? v >= lo && v <= hi : v >= lo && v < hi;
        });
        const n = subset.length;
        const sumR = subset.reduce((s, t) => s + t.rMultiple, 0);
        const wins = subset.filter(t => t.rMultiple > 0).length;
        stats.push({
            label: `[${lo.toFixed(3)}, ${isLast ? hi.toFixed(3) + ']' : hi.toFixed(3) + ')'}`,
            trades: n,
            avgR: n > 0 ? sumR / n : 0,
            winRate: n > 0 ? wins / n : 0,
            cumR: sumR,
        });
    }
    return stats;
}

function quantileEdges(values: number[], numBuckets: number): number[] {
    const sorted = [...values].sort((a, b) => a - b);
    const edges: number[] = [sorted[0]];
    for (let i = 1; i < numBuckets; i++) {
        const idx = Math.floor((i / numBuckets) * sorted.length);
        const v = sorted[idx];
        if (v !== edges[edges.length - 1]) {
            edges.push(v);
        }
    }
    edges.push(sorted[sorted.length - 1]);
    return edges;
}

function printTable(name: string, stats: BucketStat[]) {
    console.log(`\n=== ${name} ===`);
    console.log(
        '  分桶'.padEnd(28) +
            'trades'.padStart(8) +
            'avgR'.padStart(10) +
            'winRate'.padStart(10) +
            'cumR'.padStart(10)
    );
    for (const s of stats) {
        console.log(
            `  ${s.label.padEnd(26)}${String(s.trades).padStart(8)}${s.avgR.toFixed(4).padStart(10)}${(s.winRate * 100).toFixed(1).padStart(9)}%${s.cumR.toFixed(1).padStart(10)}`
        );
    }
    // 单调性判断:avgR 是否从第一桶到最后一桶大致递增
    const avgRs = stats.filter(s => s.trades > 0).map(s => s.avgR);
    let monotoneUp = 0;
    for (let i = 1; i < avgRs.length; i++) {
        if (avgRs[i] > avgRs[i - 1]) monotoneUp++;
    }
    const monoRatio = avgRs.length > 1 ? monotoneUp / (avgRs.length - 1) : 0;
    const monoLabel =
        monoRatio >= 0.8
            ? '强单调 ✓'
            : monoRatio >= 0.5
                ? '弱单调 ~'
                : '无单调 ✗';
    console.log(`  单调性: ${monoLabel} (${(monoRatio * 100).toFixed(0)}% 递增)`);
}

function main() {
    const trades = loadTrades();
    console.log(`加载 ${trades.length} 条有 detail 的 trades`);
    if (trades.length === 0) {
        console.error(`没有带 detail 的 trades,请先跑 ${RESULT_LABEL}`);
        process.exit(1);
    }

    const NUM_BUCKETS = 10;

    // 1. Gap
    const gapVals = trades.map(t => t.entryDayScoreDetail.details.gapPct);
    const gapEdges = quantileEdges(gapVals, NUM_BUCKETS);
    printTable('Gap (gapPct)', bucketize(trades, t => t.entryDayScoreDetail.details.gapPct, gapEdges));

    // 2. RVOL
    const rvolVals = trades.map(t => t.entryDayScoreDetail.details.rvolValue);
    const rvolEdges = quantileEdges(rvolVals, NUM_BUCKETS);
    printTable('RVOL (rvolValue)', bucketize(trades, t => t.entryDayScoreDetail.details.rvolValue, rvolEdges));

    // 3. Drive
    const driveVals = trades.map(t => t.entryDayScoreDetail.details.driveAtr);
    const driveEdges = quantileEdges(driveVals, NUM_BUCKETS);
    printTable('Opening Drive (driveAtr)', bucketize(trades, t => t.entryDayScoreDetail.details.driveAtr, driveEdges));

    // 4. VWAP Control
    const vwapVals = trades.map(t => t.entryDayScoreDetail.details.vwapControlRatio);
    const vwapEdges = quantileEdges(vwapVals, NUM_BUCKETS);
    printTable('VWAP Control (vwapControlRatio)', bucketize(trades, t => t.entryDayScoreDetail.details.vwapControlRatio, vwapEdges));

    // 5. Range
    const rangeVals = trades.map(t => t.entryDayScoreDetail.details.rangeValue);
    const rangeEdges = quantileEdges(rangeVals, NUM_BUCKETS);
    printTable('Range Expansion (rangeValue)', bucketize(trades, t => t.entryDayScoreDetail.details.rangeValue, rangeEdges));

    // 6. ATR% (prevAtr / price0934):指标六候选,诊断阶段无分数
    // 过滤掉旧结果里缺失该字段的 trade,避免把 undefined 当 0 污染分桶
    const atrPctTrades = trades.filter(
        t => typeof t.entryDayScoreDetail.details.atrPct === 'number'
    );
    if (atrPctTrades.length === 0) {
        console.log('\n=== ATR% (atrPct) === 跳过:结果文件中没有 atrPct 字段,请重跑 recordonly');
    } else {
        const atrPctVals = atrPctTrades.map(t => t.entryDayScoreDetail.details.atrPct);
        const atrPctEdges = quantileEdges(atrPctVals, NUM_BUCKETS);
        printTable(
            `ATR% (atrPct) [${atrPctTrades.length} trades]`,
            bucketize(atrPctTrades, t => t.entryDayScoreDetail.details.atrPct, atrPctEdges)
        );
    }

    // 7. Opening Shape —— body/total 占比
    const openingBrTrades = trades.filter(
        t => typeof t.entryDayScoreDetail.details.openingBodyRatio === 'number'
    );
    if (openingBrTrades.length === 0) {
        console.log('\n=== Opening bodyRatio === 跳过:旧 json 无字段,请重跑 recordonly');
    } else {
        const edges = [0, 0.2, 0.35, 0.5, 0.65, 0.75, 0.85, 1.0];
        printTable(
            `Opening bodyRatio [${openingBrTrades.length} trades]`,
            bucketize(openingBrTrades, t => t.entryDayScoreDetail.details.openingBodyRatio!, edges)
        );
    }

    // 8. Opening bodyAtr —— body / prevAtr
    const openingBaTrades = trades.filter(
        t => typeof t.entryDayScoreDetail.details.openingBodyAtr === 'number'
    );
    if (openingBaTrades.length === 0) {
        console.log('\n=== Opening bodyAtr === 跳过:旧 json 无字段');
    } else {
        const edges = [0, 0.1, 0.2, 0.4, 0.6, 1.0, 2.0];
        printTable(
            `Opening bodyAtr [${openingBaTrades.length} trades]`,
            bucketize(openingBaTrades, t => t.entryDayScoreDetail.details.openingBodyAtr!, edges)
        );
    }

    // 9. PriorDay bodyRatio
    const priorBrTrades = trades.filter(
        t => typeof t.entryDayScoreDetail.details.priorDayBodyRatio === 'number'
    );
    if (priorBrTrades.length === 0) {
        console.log('\n=== PriorDay bodyRatio === 跳过:旧 json 无字段');
    } else {
        const edges = [0, 0.2, 0.35, 0.5, 0.65, 0.75, 0.85, 1.0];
        printTable(
            `PriorDay bodyRatio [${priorBrTrades.length} trades]`,
            bucketize(priorBrTrades, t => t.entryDayScoreDetail.details.priorDayBodyRatio!, edges)
        );
    }

    // 10. PriorDay bodyAtr
    const priorBaTrades = trades.filter(
        t => typeof t.entryDayScoreDetail.details.priorDayBodyAtr === 'number'
    );
    if (priorBaTrades.length === 0) {
        console.log('\n=== PriorDay bodyAtr === 跳过:旧 json 无字段');
    } else {
        const edges = [0, 0.2, 0.4, 0.8, 1.2, 2.0, 3.0];
        printTable(
            `PriorDay bodyAtr [${priorBaTrades.length} trades]`,
            bucketize(priorBaTrades, t => t.entryDayScoreDetail.details.priorDayBodyAtr!, edges)
        );
    }

    // 11. Today Range% (v4c 新增)
    const todayRpTrades = trades.filter(
        t => typeof t.entryDayScoreDetail.details.todayRangePctValue === 'number'
    );
    if (todayRpTrades.length === 0) {
        console.log('\n=== Today Range% (todayRangePctValue) === 跳过:旧 json 无字段,请重跑 recordonly');
    } else {
        const edges = [0, 0.003, 0.006, 0.01, 0.015, 0.02, 0.03, 0.05];
        printTable(
            `Today Range% (todayRangePctValue) [${todayRpTrades.length} trades]`,
            bucketize(todayRpTrades, t => t.entryDayScoreDetail.details.todayRangePctValue!, edges)
        );
    }

    // 12. Prior Day Range% (v4c 新增)
    const priorRpTrades = trades.filter(
        t => typeof t.entryDayScoreDetail.details.priorDayRangePctValue === 'number'
    );
    if (priorRpTrades.length === 0) {
        console.log('\n=== Prior Day Range% (priorDayRangePctValue) === 跳过:旧 json 无字段');
    } else {
        const edges = [0, 0.01, 0.02, 0.025, 0.035, 0.05, 0.08];
        printTable(
            `Prior Day Range% (priorDayRangePctValue) [${priorRpTrades.length} trades]`,
            bucketize(priorRpTrades, t => t.entryDayScoreDetail.details.priorDayRangePctValue!, edges)
        );
    }

    // 13. Prev Range% Avg(7d) (v4c 新增)
    const prevRpAvgTrades = trades.filter(
        t => typeof t.entryDayScoreDetail.details.prevRangePctAvg7Value === 'number'
    );
    if (prevRpAvgTrades.length === 0) {
        console.log('\n=== Prev Range% Avg7 (prevRangePctAvg7Value) === 跳过:旧 json 无字段');
    } else {
        const edges = [0, 0.01, 0.02, 0.025, 0.035, 0.05, 0.08];
        printTable(
            `Prev Range% Avg7 (prevRangePctAvg7Value) [${prevRpAvgTrades.length} trades]`,
            bucketize(prevRpAvgTrades, t => t.entryDayScoreDetail.details.prevRangePctAvg7Value!, edges)
        );
    }

    // 总分分桶(和 reportTrend 的分组表呼应)
    const totalEdges = [0, 15, 30, 45, 60, 75, 90, 105, 120, 140, 171];
    printTable('总分 (total)', bucketize(
        trades,
        t => t.entryDayScoreDetail.gap + t.entryDayScoreDetail.rvol +
             t.entryDayScoreDetail.drive + t.entryDayScoreDetail.vwap +
             t.entryDayScoreDetail.range + (t.entryDayScoreDetail.atrPct ?? 0) +
             (t.entryDayScoreDetail.openingShape ?? 0) +
             (t.entryDayScoreDetail.priorDayShape ?? 0) +
             (t.entryDayScoreDetail.todayRangePct ?? 0) +
             (t.entryDayScoreDetail.priorDayRangePct ?? 0) +
             (t.entryDayScoreDetail.prevRangePctAvg7 ?? 0),
        totalEdges
    ));

    console.log('\n诊断完成。请根据上方分桶表的单调性和拐点手调权重/阈值。');
}

main();

/**
 * 离线重打分 CLI。
 *
 * 读 data/backtest/results/<seed>.json(recordonly,带完整 entryDayScoreDetail.details),
 * 套一组 TrendScoreParams 重算每笔 trade 的总分,过滤 < threshold 的 trade,算 summary。
 *
 * 跑法:
 *   # 默认参数(等于 v4c-tuned)
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/rescoreTrend.ts trend_recordonly_v5_seed
 *
 *   # 指定参数 JSON(字段和 TrendScoreParams 一一对应)
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/rescoreTrend.ts trend_recordonly_v5_seed ./tmp/params.json
 */
import * as fs from 'fs';
import * as path from 'path';
import { BacktestResult, BacktestTrade } from './types';
import {
    rescoreFromDetails,
    TrendScoreParams,
    DEFAULT_TREND_SCORE_PARAMS,
} from '../core/trendDetector';

export interface RescoreSummary {
    label: string;
    threshold: number;
    totalCandidates: number; // seed 里总 trade 数
    passed: number;          // 分数 >= threshold 的 trade 数
    nullScore: number;       // detail 缺失(预热期)的 trade 数 -> 放行
    winRate: number;
    avgR: number;
    cumR: number;
    maxDD: number;
    ratio: number;           // cumR / maxDD
}

export function rescoreTrades(
    trades: BacktestTrade[],
    params: TrendScoreParams
): RescoreSummary {
    let passCount = 0;
    let nullCount = 0;
    let sumR = 0;
    let wins = 0;
    const passed: BacktestTrade[] = [];

    for (const t of trades) {
        const det = t.entryDayScoreDetail?.details;
        if (!det) {
            // 预热期 / 无基线 -> 生产行为是"放行",rescore 也放行
            nullCount++;
            passed.push(t);
            sumR += t.rMultiple;
            if (t.rMultiple > 0) wins++;
            continue;
        }
        const score = rescoreFromDetails(det as any, params);
        if (score.total >= params.scoreThreshold) {
            passCount++;
            passed.push(t);
            sumR += t.rMultiple;
            if (t.rMultiple > 0) wins++;
        }
    }

    const n = passed.length;
    const sorted = [...passed].sort((a, b) => a.entryTimestamp - b.entryTimestamp);
    let peak = 0, acc = 0, maxDD = 0;
    for (const t of sorted) {
        acc += t.rMultiple;
        if (acc > peak) peak = acc;
        const dd = peak - acc;
        if (dd > maxDD) maxDD = dd;
    }

    return {
        label: '',
        threshold: params.scoreThreshold,
        totalCandidates: trades.length,
        passed: passCount,
        nullScore: nullCount,
        winRate: n > 0 ? wins / n : 0,
        avgR: n > 0 ? sumR / n : 0,
        cumR: sumR,
        maxDD,
        ratio: maxDD > 0 ? sumR / maxDD : 0,
    };
}

function main() {
    const seedLabel = process.argv[2];
    const paramsPath = process.argv[3];
    if (!seedLabel) {
        console.error('Usage: rescoreTrend.ts <seed-label> [params.json]');
        process.exit(1);
    }
    const seedPath = path.resolve(process.cwd(), `data/backtest/results/${seedLabel}.json`);
    const raw: BacktestResult = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    let params: TrendScoreParams = DEFAULT_TREND_SCORE_PARAMS;
    if (paramsPath) {
        params = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), paramsPath), 'utf8'));
    }
    const summary = rescoreTrades(raw.trades, params);
    summary.label = seedLabel + (paramsPath ? `+${path.basename(paramsPath)}` : '');

    console.log(`=== Rescore: ${summary.label} ===`);
    console.log(`  threshold      : ${summary.threshold}`);
    console.log(`  total          : ${summary.totalCandidates}`);
    console.log(`  passed         : ${summary.passed} (+${summary.nullScore} null-score passthrough)`);
    console.log(`  winRate        : ${(summary.winRate * 100).toFixed(2)}%`);
    console.log(`  avgR           : ${summary.avgR.toFixed(4)}`);
    console.log(`  cumR           : ${summary.cumR.toFixed(2)}`);
    console.log(`  maxDD          : ${summary.maxDD.toFixed(2)}`);
    console.log(`  ratio          : ${summary.ratio.toFixed(2)}`);
}

// 只在直接执行时跑 main,被 import 时不跑
if (require.main === module) {
    main();
}

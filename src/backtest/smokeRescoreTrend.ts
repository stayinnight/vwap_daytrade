/**
 * rescoreFromDetails 的 smoke 验证。
 *
 * 跑法:
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/smokeRescoreTrend.ts
 *
 * Case A: 对 seed json 里的每条 trade,rescore(默认参数) 的分项分必须等于该 trade 自带的分项。
 * Case B: 把 gapTiers 的阈值从 0.02 改到 0.05,原本命中的 gap trade 应该重打成 0 分。
 */
import * as fs from 'fs';
import * as path from 'path';
import { BacktestResult } from './types';
import {
    rescoreFromDetails,
    DEFAULT_TREND_SCORE_PARAMS,
    TrendScoreParams,
} from '../core/trendDetector';
import { rescoreTrades } from './rescoreTrend';

function assert(cond: boolean, msg: string) {
    if (!cond) throw new Error('ASSERT FAIL: ' + msg);
}

const SEED_PATH = path.resolve(
    process.cwd(),
    'data/backtest/results/trend_recordonly_v5_seed.json'
);

function loadSeed(): BacktestResult {
    return JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
}

// ============================================================
// Case A: 默认参数 rescore 每条 trade 的分项 === trade 自带分项
// ============================================================
(function caseDefaultMatchesProduction() {
    console.log('Running case A: default rescore == production scoring');
    const seed = loadSeed();
    let checked = 0;
    let mismatches = 0;
    for (const t of seed.trades) {
        const d = t.entryDayScoreDetail;
        if (!d || !d.details) continue;
        if (typeof (d.details as any).rangeAtrRatio !== 'number') {
            // seed 必须是 Task 4 重跑过的版本
            throw new Error('Seed missing rangeAtrRatio - rerun Task 4 to regenerate seed');
        }
        const rescored = rescoreFromDetails(d.details as any, DEFAULT_TREND_SCORE_PARAMS);
        // 验证分项逐一匹配
        const expected = {
            gap: d.gap, rvol: d.rvol, drive: d.drive, vwap: d.vwap, range: d.range,
            atrPct: d.atrPct ?? 0,
            openingShape: d.openingShape ?? 0,
            priorDayShape: d.priorDayShape ?? 0,
            todayRangePct: d.todayRangePct ?? 0,
            priorDayRangePct: d.priorDayRangePct ?? 0,
            prevRangePctAvg7: d.prevRangePctAvg7 ?? 0,
        };
        const fields: Array<keyof typeof expected> = [
            'gap','rvol','drive','vwap','range','atrPct',
            'openingShape','priorDayShape',
            'todayRangePct','priorDayRangePct','prevRangePctAvg7',
        ];
        for (const k of fields) {
            if (rescored[k] !== expected[k]) {
                mismatches++;
                if (mismatches <= 3) {
                    console.error(`  MISMATCH trade#${checked} field=${k} expected=${expected[k]} got=${rescored[k]}`);
                    console.error(`    details: ${JSON.stringify(d.details)}`);
                }
            }
        }
        checked++;
    }
    console.log(`  checked ${checked} trades, mismatches=${mismatches}`);
    assert(mismatches === 0, `caseA: ${mismatches} mismatches found, see logs above`);
    console.log('  case A PASS');
})();

// ============================================================
// Case B: 改 gapTiers 阈值,命中率变化符合预期
// ============================================================
(function caseTighterGap() {
    console.log('Running case B: tighter gap threshold reduces pass count');
    const seed = loadSeed();
    const base = rescoreTrades(seed.trades, DEFAULT_TREND_SCORE_PARAMS);

    // 把 gap 阈值从 0.02 改到 0.05(更严)
    const tighter: TrendScoreParams = {
        ...DEFAULT_TREND_SCORE_PARAMS,
        gapTiers: [{ pct: 0.05, score: 25 }],
    };
    const tight = rescoreTrades(seed.trades, tighter);

    console.log(`  base passed=${base.passed}, cumR=${base.cumR.toFixed(1)}`);
    console.log(`  tight passed=${tight.passed}, cumR=${tight.cumR.toFixed(1)}`);

    // 更严的 gap 必然减少通过数(因为有些 trade 原本靠 gap 25 分凑过门槛)
    // 但不是所有 trade 都依赖 gap,所以只要 tight.passed < base.passed 即可
    assert(tight.passed < base.passed, `caseB: tighter gap should reduce passed count (base=${base.passed} tight=${tight.passed})`);
    console.log('  case B PASS');
})();

console.log('\n✅ rescoreTrend smoke all pass');

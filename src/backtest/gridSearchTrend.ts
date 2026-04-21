/**
 * v5 权重/阈值网格搜索(三阶段 greedy)。
 *
 * 跑法:
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/gridSearchTrend.ts \
 *     trend_recordonly_v5_seed 1170.9
 *
 * 流程:
 *   A. 阈值扫(从 DEFAULT_TREND_SCORE_PARAMS 出发,每个指标独立扫 3 个候选,选 ratio 最高且 cumR >= CUM_R_MIN 的)
 *      -> 得到 bestThresholds
 *   B. 权重扫(阈值固定在 bestThresholds,按 ΔavgR 重分配权重 —— 实现为尝试 3 种权重方案)
 *      -> 得到 bestWeights
 *   C. 门槛扫(阈值 + 权重固定,扫 thresholds 7 个点)
 *      -> 得到 bestScoreThreshold
 *
 * 输出 top-10 按 ratio 降序 + baseline 参考行,便于人工挑选最终候选给 runner 实跑。
 */
import * as fs from 'fs';
import * as path from 'path';
import { BacktestResult } from './types';
import {
    DEFAULT_TREND_SCORE_PARAMS,
    TrendScoreParams,
} from '../core/trendDetector';
import { rescoreTrades, RescoreSummary } from './rescoreTrend';

interface Candidate {
    name: string;
    params: TrendScoreParams;
    summary: RescoreSummary;
}

function clone(p: TrendScoreParams): TrendScoreParams {
    return JSON.parse(JSON.stringify(p));
}

// ============================================================
// 阶段 A: 阈值扫(每次只动一个指标的阈值,greedy)
// ============================================================

// 每个指标的候选阈值表(在当前阈值基础上 +/- 一档,外加一个"更严/更宽"极端值)
// 格式: (params, candidateValue) => 新 params
type ThresholdCandidate = {
    indicator: string;
    apply: (p: TrendScoreParams) => TrendScoreParams;
};

function thresholdCandidates(): ThresholdCandidate[] {
    const out: ThresholdCandidate[] = [];

    // Gap: 0.015 / 0.025 / 0.03
    for (const pct of [0.015, 0.025, 0.03]) {
        out.push({
            indicator: `gap@${pct}`,
            apply: (p) => ({ ...clone(p), gapTiers: [{ pct, score: 25 }] }),
        });
    }
    // RVOL 高档: v=1.8 / 2.2 / 2.5
    for (const v of [1.8, 2.2, 2.5]) {
        out.push({
            indicator: `rvolHi@${v}`,
            apply: (p) => ({
                ...clone(p),
                rvolTiers: [{ v, score: 40 }, { v: 1.5, score: 20 }],
            }),
        });
    }
    // RVOL 低档: v=1.3 / 1.7
    for (const v of [1.3, 1.7]) {
        out.push({
            indicator: `rvolLo@${v}`,
            apply: (p) => ({
                ...clone(p),
                rvolTiers: [{ v: 2, score: 40 }, { v, score: 20 }],
            }),
        });
    }
    // Range 高档: atr=0.8 / 1.2
    for (const atr of [0.8, 1.2]) {
        out.push({
            indicator: `rangeHi@${atr}`,
            apply: (p) => ({
                ...clone(p),
                rangeTiers: [{ atr, score: 30 }, { atr: 0.5, score: 15 }],
            }),
        });
    }
    // Range 低档: atr=0.4 / 0.6
    for (const atr of [0.4, 0.6]) {
        out.push({
            indicator: `rangeLo@${atr}`,
            apply: (p) => ({
                ...clone(p),
                rangeTiers: [{ atr: 1.0, score: 30 }, { atr, score: 15 }],
            }),
        });
    }
    // ATR%: 0.02 / 0.03
    for (const pct of [0.02, 0.03]) {
        out.push({
            indicator: `atrPct@${pct}`,
            apply: (p) => ({ ...clone(p), atrPctTiers: [{ pct, score: 15 }] }),
        });
    }
    // Today Range%: 0.008 / 0.012 / 0.015
    for (const pct of [0.008, 0.012, 0.015]) {
        out.push({
            indicator: `todayRP@${pct}`,
            apply: (p) => ({ ...clone(p), todayRangePctTiers: [{ pct, score: 10 }] }),
        });
    }
    // Prior Day Range%: 0.02 / 0.03
    for (const pct of [0.02, 0.03]) {
        out.push({
            indicator: `priorRP@${pct}`,
            apply: (p) => ({ ...clone(p), priorDayRangePctTiers: [{ pct, score: 10 }] }),
        });
    }
    // Prev Range% Avg: 0.02 / 0.03
    for (const pct of [0.02, 0.03]) {
        out.push({
            indicator: `avgRP@${pct}`,
            apply: (p) => ({ ...clone(p), prevRangePctAvgTiers: [{ pct, score: 10 }] }),
        });
    }

    return out;
}

function phaseAThresholdSweep(
    seed: BacktestResult,
    cumRMin: number
): { params: TrendScoreParams; candidates: Candidate[] } {
    let best = clone(DEFAULT_TREND_SCORE_PARAMS);
    const baseSum = rescoreTrades(seed.trades, best);
    let bestRatio = baseSum.ratio;
    const candidates: Candidate[] = [
        { name: 'baseline (default)', params: clone(best), summary: baseSum },
    ];

    // 每轮扫所有候选,选最好的且满足硬约束的,固化进 best
    // 最多 3 轮(避免死循环),每轮若无改进则提前停
    for (let round = 1; round <= 3; round++) {
        let roundBest: Candidate | null = null;
        for (const c of thresholdCandidates()) {
            const p = c.apply(best);
            const s = rescoreTrades(seed.trades, p);
            candidates.push({ name: `A.r${round}.${c.indicator}`, params: p, summary: s });
            if (s.cumR < cumRMin) continue;
            if (s.ratio > (roundBest?.summary.ratio ?? bestRatio)) {
                roundBest = { name: c.indicator, params: p, summary: s };
            }
        }
        if (!roundBest || roundBest.summary.ratio <= bestRatio) {
            console.log(`[phaseA] round ${round}: no improvement, stop`);
            break;
        }
        console.log(`[phaseA] round ${round}: picked ${roundBest.name} ratio=${roundBest.summary.ratio.toFixed(2)} (was ${bestRatio.toFixed(2)})`);
        best = roundBest.params;
        bestRatio = roundBest.summary.ratio;
    }
    return { params: best, candidates };
}

// ============================================================
// 阶段 B: 权重重分配(3 个预设方案 + 当前权重)
// ============================================================

function phaseBWeightSweep(
    seed: BacktestResult,
    base: TrendScoreParams,
    cumRMin: number
): { params: TrendScoreParams; candidates: Candidate[] } {
    const candidates: Candidate[] = [];

    // 方案 0: 当前权重(base,已带阶段 A 阈值)
    const s0 = rescoreTrades(seed.trades, base);
    candidates.push({ name: 'B.keep', params: clone(base), summary: s0 });

    // 方案 α: 把 Range/RVOL 加重 5 分,Gap/VWAP 减 5 分(试"强动量倾向")
    const alpha = clone(base);
    alpha.rvolTiers = [{ v: alpha.rvolTiers[0].v, score: 45 }, { v: alpha.rvolTiers[1].v, score: 22 }];
    alpha.rangeTiers = [{ atr: alpha.rangeTiers[0].atr, score: 35 }, { atr: alpha.rangeTiers[1].atr, score: 17 }];
    alpha.gapTiers = [{ pct: alpha.gapTiers[0].pct, score: 20 }];
    alpha.vwapFullScore = 3;
    alpha.vwapPartialScore = 3;
    const sA = rescoreTrades(seed.trades, alpha);
    candidates.push({ name: 'B.alpha (rvol/range +, gap/vwap -)', params: alpha, summary: sA });

    // 方案 β: Day-range% 加重(日内波动信号),Shape 减重
    const beta = clone(base);
    beta.todayRangePctTiers = [{ pct: beta.todayRangePctTiers[0].pct, score: 15 }];
    beta.priorDayRangePctTiers = [{ pct: beta.priorDayRangePctTiers[0].pct, score: 15 }];
    beta.prevRangePctAvgTiers = [{ pct: beta.prevRangePctAvgTiers[0].pct, score: 15 }];
    beta.openingShapeMaxScore = 5;
    beta.openingShapeThresholds = { ...beta.openingShapeThresholds, maxScore: 5 };
    const sB = rescoreTrades(seed.trades, beta);
    candidates.push({ name: 'B.beta (rangePct +, shape -)', params: beta, summary: sB });

    // 方案 γ: 禁用 openingShape,把 15 分匀给 RVOL
    const gamma = clone(base);
    gamma.openingShapeMaxScore = 0;
    gamma.openingShapeThresholds = { ...gamma.openingShapeThresholds, maxScore: 0 };
    gamma.rvolTiers = [{ v: gamma.rvolTiers[0].v, score: 50 }, { v: gamma.rvolTiers[1].v, score: 25 }];
    const sG = rescoreTrades(seed.trades, gamma);
    candidates.push({ name: 'B.gamma (shape off, rvol ++)', params: gamma, summary: sG });

    // 选满足硬约束且 ratio 最高的
    const filtered = candidates.filter(c => c.summary.cumR >= cumRMin);
    if (filtered.length === 0) {
        console.log('[phaseB] no weight scheme passes hard constraint, keep base weights');
        return { params: base, candidates };
    }
    const bestW = filtered.reduce((a, b) => b.summary.ratio > a.summary.ratio ? b : a);
    console.log(`[phaseB] picked ${bestW.name} ratio=${bestW.summary.ratio.toFixed(2)}`);
    return { params: bestW.params, candidates };
}

// ============================================================
// 阶段 C: 门槛扫(阈值 + 权重固定,扫 7 个点)
// ============================================================

function phaseCThresholdSweep(
    seed: BacktestResult,
    base: TrendScoreParams,
    cumRMin: number
): { params: TrendScoreParams; candidates: Candidate[] } {
    // 计算当前 base 的总分上限(11 个指标各自 max)
    const maxTotal =
        (base.gapTiers[0]?.score ?? 0) +
        (base.rvolTiers[0]?.score ?? 0) +
        (base.driveTiers[0]?.score ?? 0) +
        base.vwapFullScore +
        (base.rangeTiers[0]?.score ?? 0) +
        (base.atrPctTiers[0]?.score ?? 0) +
        base.openingShapeMaxScore +
        base.priorDayShapeMaxScore +
        (base.todayRangePctTiers[0]?.score ?? 0) +
        (base.priorDayRangePctTiers[0]?.score ?? 0) +
        (base.prevRangePctAvgTiers[0]?.score ?? 0);

    // 扫 maxTotal 的 [35%, 65%] 范围内 7 个点
    const thresholds: number[] = [];
    for (let pct = 0.35; pct <= 0.65; pct += 0.05) {
        thresholds.push(Math.round(maxTotal * pct));
    }
    const candidates: Candidate[] = [];
    for (const th of thresholds) {
        const p = { ...clone(base), scoreThreshold: th };
        const s = rescoreTrades(seed.trades, p);
        candidates.push({ name: `C.thr=${th}`, params: p, summary: s });
    }
    const filtered = candidates.filter(c => c.summary.cumR >= cumRMin);
    if (filtered.length === 0) {
        console.log('[phaseC] no threshold passes hard constraint, keep base');
        return { params: base, candidates };
    }
    const bestT = filtered.reduce((a, b) => b.summary.ratio > a.summary.ratio ? b : a);
    console.log(`[phaseC] picked threshold=${bestT.params.scoreThreshold} ratio=${bestT.summary.ratio.toFixed(2)}`);
    return { params: bestT.params, candidates };
}

// ============================================================
// 主
// ============================================================

function main() {
    const seedLabel = process.argv[2];
    const cumRMinRaw = process.argv[3];
    if (!seedLabel || !cumRMinRaw) {
        console.error('Usage: gridSearchTrend.ts <seed-label> <cumR-min>');
        process.exit(1);
    }
    const cumRMin = Number(cumRMinRaw);
    const seedPath = path.resolve(
        process.cwd(),
        `data/backtest/results/${seedLabel}.json`
    );
    const seed: BacktestResult = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    console.log(`seed=${seedLabel} trades=${seed.trades.length} cumRMin=${cumRMin}`);

    const allCandidates: Candidate[] = [];

    console.log('\n=== Phase A: Threshold Sweep ===');
    const a = phaseAThresholdSweep(seed, cumRMin);
    allCandidates.push(...a.candidates);

    console.log('\n=== Phase B: Weight Redistribution ===');
    const b = phaseBWeightSweep(seed, a.params, cumRMin);
    allCandidates.push(...b.candidates);

    console.log('\n=== Phase C: Score Threshold Sweep ===');
    const c = phaseCThresholdSweep(seed, b.params, cumRMin);
    allCandidates.push(...c.candidates);

    // Top-10 按 ratio 降序,过滤硬约束
    const filtered = allCandidates.filter(c => c.summary.cumR >= cumRMin);
    filtered.sort((x, y) => y.summary.ratio - x.summary.ratio);
    const top = filtered.slice(0, 10);

    console.log('\n=== Top 10 (by ratio, cumR >= ' + cumRMin + ') ===');
    console.log('name'.padEnd(50), 'passed'.padStart(7), 'winR'.padStart(6), 'cumR'.padStart(8), 'maxDD'.padStart(7), 'ratio'.padStart(7));
    for (const t of top) {
        console.log(
            t.name.padEnd(50),
            String(t.summary.passed).padStart(7),
            (t.summary.winRate * 100).toFixed(1).padStart(5) + '%',
            t.summary.cumR.toFixed(1).padStart(8),
            t.summary.maxDD.toFixed(1).padStart(7),
            t.summary.ratio.toFixed(2).padStart(7),
        );
    }

    // 持久化完整结果
    const outPath = path.resolve(process.cwd(), 'data/backtest/grid_search_v5.json');
    fs.writeFileSync(outPath, JSON.stringify({
        seedLabel,
        cumRMin,
        bestParams: c.params,
        top,
        allCandidates: allCandidates.map(ac => ({ name: ac.name, summary: ac.summary })),
    }, null, 2));
    console.log(`\nFull results: ${path.relative(process.cwd(), outPath)}`);
    console.log('\nNext: pick top-N candidates, write their params to JSON, rerun runner.ts to confirm.');
}

if (require.main === module) {
    main();
}

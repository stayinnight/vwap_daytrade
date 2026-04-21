/**
 * trendDetector 的 smoke 验证脚本。
 *
 * 跑法:
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/smokeTrendDetector.ts
 *
 * 构造几个小样本,assert 打分符合预期。失败就 throw。
 */
import { SerializedBar } from './types';
import {
    scoreTrendDay,
    precomputeTrendBaselinesForSymbol,
    TrendBaseline,
    TREND_SCORE_THRESHOLD,
    OPENING_WINDOW_MINUTES,
    scoreCandleShape,
    OPENING_SHAPE_THRESHOLDS,
    PRIOR_DAY_SHAPE_THRESHOLDS,
    setTrendIndicator9Enabled,
    setTrendIndicator10Enabled,
    setTrendIndicator11Mode,
    resetTrendExperimentFlags,
} from '../core/trendDetector';

function assert(cond: boolean, msg: string) {
    if (!cond) {
        throw new Error('ASSERT FAIL: ' + msg);
    }
}

function bar(ts: number, o: number, h: number, l: number, c: number, vol: number): SerializedBar {
    return {
        timestamp: ts,
        open: o,
        high: h,
        low: l,
        close: c,
        volume: vol,
        turnover: ((o + c) / 2) * vol,
        tradeSession: 0,
    };
}

function ts(dayKey: string, hh: number, mm: number) {
    return Date.parse(`${dayKey}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
}

// ============================================================
// Case 1: 高分样本(总分 130)
// gap 2.5% (25) + RVOL ~4.17 (40) + drive 归零 (0) + VWAP 全站上 (5)
// + range 0.525 ATR (15) + atrPct 0.04 (15) + Opening/PriorDay Shape (0+0)
// + todayRangePct 2.05% (10) + priorDayRangePct 4% (10) + prevRangePctAvg7 0.04 (10)
// ============================================================
(function caseFullScore() {
    console.log('Running case 1: full score');
    const baseline: TrendBaseline = {
        prevClose: 100,
        prevAtr: 4,
        prevAtrShort: 4,
        rvolBaseline: 3000,
        prevDayOHLC: { open: 98, high: 101, low: 97, close: 100 },
        prevRangePctAvg7: 0.04, // 大于 0.025 阈值,命中指标十一
    };
    const window: SerializedBar[] = [];
    for (let i = 0; i < OPENING_WINDOW_MINUTES; i++) {
        // 每根 bar 的 close 都略高于当前累计 VWAP,保证 close > vwap(长侧 100% 占比)
        const o = 102.5 + i * 0.1;
        const c = 102.5 + (i + 1) * 0.1;
        const h = Math.max(o, c) + 0.05;
        const l = Math.min(o, c) - 0.05;
        window.push(bar(0, o, h, l, c, 2500));
    }
    // 锁死关键点:
    window[0].open = 102.5; // gap = 2.5% > 2% -> 25 分
    window[window.length - 1].close = 104.5; // drive 归零 -> 0 分
    window[window.length - 1].high = 104.55; // 同步拉高 high,确保 range 覆盖到 104.55
    // RVOL = 5 * 2500 / 3000 = 4.17 > 2 -> 40 分
    // range: highMax ≈ 104.55, lowMin ≈ 102.45, range ≈ 2.1, rangeAtrRatio=2.1/4=0.525 > 0.5 -> 15 分
    // VWAP: 每根 close 都在累计 VWAP 上方 -> 5 分
    // atrPct: prevAtrShort/prevClose = 4/100 = 0.04 > 0.025 -> 15 分
    // total = 25 + 40 + 0 + 5 + 15 + 15 + 0 + 0 + 10 + 10 + 10 = 130

    const score = scoreTrendDay(window, baseline);
    assert(score !== null, 'case1: score should not be null');
    console.log('  case1 score:', JSON.stringify(score));
    assert(score!.gap === 25, `case1 gap expected 25, got ${score!.gap}`);
    assert(score!.rvol === 40, `case1 rvol expected 40, got ${score!.rvol}`);
    assert(score!.drive === 0, `case1 drive expected 0, got ${score!.drive}`);
    assert(score!.vwap === 5, `case1 vwap expected 5, got ${score!.vwap}`);
    assert(score!.range === 15, `case1 range expected 15, got ${score!.range}`);
    assert(score!.atrPct === 15, `case1 atrPct expected 15, got ${score!.atrPct}`);
    assert(score!.openingShape === 0, `case1 openingShape expected 0, got ${score!.openingShape}`);
    assert(score!.priorDayShape === 0, `case1 priorDayShape expected 0, got ${score!.priorDayShape}`);
    assert(score!.todayRangePct === 10, `case1 todayRangePct expected 10, got ${score!.todayRangePct}`);
    assert(score!.priorDayRangePct === 10, `case1 priorDayRangePct expected 10, got ${score!.priorDayRangePct}`);
    assert(score!.prevRangePctAvg7 === 10, `case1 prevRangePctAvg7 expected 10, got ${score!.prevRangePctAvg7}`);
    assert(score!.total === 130, `case1 total expected 130, got ${score!.total}`);
    console.log('  case1 PASS');
})();

// ============================================================
// Case 2: 低分样本(total < 门槛)
// atrPct = prevAtrShort/prevClose = 2/100 = 0.02 < 0.025 -> 0 分
// ============================================================
(function caseLowScore() {
    console.log('Running case 2: low score');
    const baseline: TrendBaseline = {
        prevClose: 100,
        prevAtr: 2,
        prevAtrShort: 2,
        rvolBaseline: 10000,
        prevDayOHLC: { open: 99.5, high: 100.5, low: 99, close: 100 },
        prevRangePctAvg7: 0.015, // 小于 0.025 阈值,不命中指标十一
    };
    const window: SerializedBar[] = [];
    for (let i = 0; i < OPENING_WINDOW_MINUTES; i++) {
        // 在 100.45–100.55 之间震荡,长短占比大致各半,VWAP 都拿不到 8 分
        const o = i % 2 === 0 ? 100.45 : 100.55;
        const c = i % 2 === 0 ? 100.55 : 100.45;
        window.push(bar(0, o, 100.6, 100.4, c, 500));
    }
    window[0].open = 100.5; // gap = 0.5% < 1% -> 0 分
    window[window.length - 1].close = 100.51; // drive ≈ 0.001 -> 0 分
    // RVOL = 5 * 500 / 10000 = 0.25 < 1.3 -> 0 分
    // range: highMax=100.6, lowMin=100.4, rangeValue=0.2, rangeAtrRatio=0.1 < 0.5 -> 0 分
    // atrPct = 2/100.51 ≈ 0.0199 < 0.03 -> 0 分

    const score = scoreTrendDay(window, baseline);
    assert(score !== null, 'case2: not null');
    console.log('  case2 score:', JSON.stringify(score));
    assert(score!.gap === 0, `case2 gap expected 0, got ${score!.gap}`);
    assert(score!.rvol === 0, `case2 rvol expected 0, got ${score!.rvol}`);
    assert(score!.drive === 0, `case2 drive expected 0, got ${score!.drive}`);
    assert(score!.range === 0, `case2 range expected 0, got ${score!.range}`);
    assert(score!.atrPct === 0, `case2 atrPct expected 0, got ${score!.atrPct}`);
    // Shape 指标加入后 total 可能不是 0,但仍应远低于门槛
    assert(score!.total < TREND_SCORE_THRESHOLD, `case2 total expected < ${TREND_SCORE_THRESHOLD}, got ${score!.total}`);
    console.log('  case2 PASS');
})();

// ============================================================
// Case 3: 低于门槛(验证门槛语义)
// 多个指标部分命中(range/openingShape/todayRangePct),但总分仍 < TREND_SCORE_THRESHOLD。
// 具体各指标贡献由运行时 JSON.stringify 打印。
// ============================================================
(function caseBelowThreshold() {
    console.log('Running case 3: below threshold');
    const baseline: TrendBaseline = {
        prevClose: 100,
        prevAtr: 2,
        prevAtrShort: 2,
        rvolBaseline: 10000, // 大基线让 RVOL=0.7<1.3->0 分
        prevDayOHLC: { open: 99.5, high: 100.5, low: 99, close: 100 },
        prevRangePctAvg7: 0.015, // 小于 0.025 阈值,不命中指标十一
    };
    const win: SerializedBar[] = [];
    for (let i = 0; i < OPENING_WINDOW_MINUTES; i++) {
        // 震荡让 VWAP 拿 0 分(长短交替)
        const o = i % 2 === 0 ? 101.49 : 101.51;
        const c = i % 2 === 0 ? 101.51 : 101.49;
        win.push(bar(0, o, c + 0.5, o - 0.5, c, 1400));
    }
    win[0].open = 101.5; // gap = 1.5% < 2% -> 0 分
    win[win.length - 1].close = 102.7; // drive 归零 -> 0 分
    win[win.length - 1].high = Math.max(win[win.length - 1].high, 102.7); // keep high >= close after override
    // RVOL = 5 * 1400 / 10000 = 0.7 < 1.3 -> 0 分
    // VWAP:震荡 -> 0 分
    // range: highMax≈102.01, lowMin≈100.99, range≈1.02, rangeAtrRatio=1.02/2=0.51 > 0.5 -> 15 分
    // total 由多个指标贡献,仍 < TREND_SCORE_THRESHOLD,具体值由 smoke 运行时打印

    const score = scoreTrendDay(win, baseline);
    assert(score !== null, 'case3: not null');
    console.log('  case3 score:', JSON.stringify(score));
    assert(
        score!.total < TREND_SCORE_THRESHOLD,
        `case3 total expected < ${TREND_SCORE_THRESHOLD}, got ${score!.total}`
    );
    console.log('  case3 PASS (below threshold, total=' + score!.total + ')');
})();

// ============================================================
// Case 4: precomputeTrendBaselinesForSymbol
// 构造 25 个 UTC 交易日,每天 OPENING_WINDOW_MINUTES 根 intraday + 1 根日末 bar,看预计算结果
// ============================================================
(function casePrecompute() {
    console.log('Running case 4: precompute');
    const bars: SerializedBar[] = [];
    for (let day = 0; day < 25; day++) {
        const dayKey = `2026-01-${String(day + 1).padStart(2, '0')}`;
        for (let min = 0; min < OPENING_WINDOW_MINUTES; min++) {
            bars.push(bar(ts(dayKey, 14, 30 + min), 100, 101, 99, 100.5, 1000));
        }
        // 一根日末 bar 让 aggregateDailyForTrend 的 close 合理
        bars.push(bar(ts(dayKey, 19, 59), 100.5, 101.5, 99.5, 100.8, 500));
    }

    const out = precomputeTrendBaselinesForSymbol(bars);
    const keys = Object.keys(out).sort();
    console.log('  precompute days:', keys.length);
    assert(keys.length === 25, `case4 expected 25 days, got ${keys.length}`);
    assert(out[keys[0]] === null, 'case4: day 0 should be null (no prev day)');

    // ATR 预热 = ATR_PERIOD=7 + 1(i > 7 才算 ATR),RVOL 需要 10 天有效,所以 day 10 开始应该有 baseline
    const lastDayBaseline = out[keys[keys.length - 1]];
    assert(
        lastDayBaseline !== null,
        'case4: last day should have baseline (after 24 days of history)'
    );
    console.log('  case4 last day baseline:', JSON.stringify(lastDayBaseline));
    assert(lastDayBaseline!.rvolBaseline > 0, 'rvolBaseline > 0');
    assert(lastDayBaseline!.prevClose > 0, 'prevClose > 0');
    assert(lastDayBaseline!.prevAtr >= 0, 'prevAtr >= 0');
    assert(lastDayBaseline!.prevAtrShort >= 0, 'prevAtrShort >= 0');
    assert(lastDayBaseline!.prevRangePctAvg7 >= 0, 'prevRangePctAvg7 >= 0');
    assert(Number.isFinite(lastDayBaseline!.prevRangePctAvg7), 'prevRangePctAvg7 finite');
    console.log('  case4 PASS');
})();

// ============================================================
// Case 5: scoreCandleShape 单元测试(Opening 阈值)
// ============================================================
(function caseShapeOpening() {
    console.log('Running case 5: scoreCandleShape (Opening)');
    const t = OPENING_SHAPE_THRESHOLDS;
    const prevAtr = 2.0; // 任意正数,足以让 bodyAtr 可算

    // 5a. 十字星:body=0,shadowRatio=1 -> long-shadow/full-body 阈值 1.01 不可达,bodyAtr=0 < 0.6 -> none
    let r = scoreCandleShape({ open: 100, high: 101, low: 99, close: 100 }, prevAtr, t);
    assert(r.tier === 'none', `5a tier none (longShadowRatio=1.01 unreachable), got ${r.tier}`);
    assert(r.score === 0, `5a score 0, got ${r.score}`);

    // 5b. 长上影小阳线:total=2, body=0.1, bodyRatio=0.05 -> shadowRatio<1.01, bodyAtr=0.05<0.6 -> none
    r = scoreCandleShape({ open: 100, high: 102, low: 100, close: 100.1 }, prevAtr, t);
    assert(r.tier === 'none', `5b tier none (all thresholds unreachable), got ${r.tier}`);
    assert(r.score === 0, `5b score 0, got ${r.score}`);

    // 5c. 大阳线:body=1 ATR,超过 0.6 -> long-kline(优先级最高)
    // open=100, close=102, high=102.1, low=99.9, total=2.2, body=2, bodyAtr=1.0
    r = scoreCandleShape({ open: 100, high: 102.1, low: 99.9, close: 102 }, prevAtr, t);
    assert(r.tier === 'long-kline', `5c tier long-kline, got ${r.tier}`);
    assert(r.score === 15, `5c score 15, got ${r.score}`);

    // 5d. 中阳线:body 占比高、body<0.6 ATR -> fullBodyRatio=1.01 不可达, bodyAtr=0.3<0.6 -> none
    // open=100, close=100.6, high=100.65, low=99.95, total=0.7, body=0.6, bodyRatio=0.857,
    // total/open=0.007 >= 0.003, bodyAtr=0.3 < 0.6
    r = scoreCandleShape({ open: 100, high: 100.65, low: 99.95, close: 100.6 }, prevAtr, t);
    assert(r.tier === 'none', `5d tier none (fullBodyRatio=1.01 unreachable, bodyAtr<0.6), got ${r.tier}`);
    assert(r.score === 0, `5d score 0, got ${r.score}`);

    // 5e. 死水小阳线:body 比例 OK 但 total/open < 0.3% -> none
    // open=100, close=100.002, high=100.0025, low=99.9995, total=0.003, total/open=3e-5
    r = scoreCandleShape(
        { open: 100, high: 100.0025, low: 99.9995, close: 100.002 },
        prevAtr,
        t
    );
    assert(r.tier === 'none', `5e tier none, got ${r.tier}`);
    assert(r.score === 0, `5e score 0, got ${r.score}`);

    // 5f. 极小 K:total=0 -> none
    r = scoreCandleShape({ open: 100, high: 100, low: 100, close: 100 }, prevAtr, t);
    assert(r.tier === 'none', `5f tier none, got ${r.tier}`);
    assert(r.score === 0, `5f score 0, got ${r.score}`);

    console.log('  case5 PASS');
})();

// ============================================================
// Case 6: scoreCandleShape 单元测试(Prior Day 阈值 - asymmetry check)
//
// PriorDay 阈值更严:fullBodyMinTotalPct 1%(vs Opening 0.3%)、
// longKlineBodyAtr 0.8(vs Opening 0.4)。下面三个样本专门覆盖
// Opening vs PriorDay 会给不同 tier 的 K 线。
// ============================================================
(function caseShapePriorDay() {
    console.log('Running case 6: scoreCandleShape (Prior Day asymmetry)');
    const prevAtr = 2.0;
    const tO = OPENING_SHAPE_THRESHOLDS;
    const tP = PRIOR_DAY_SHAPE_THRESHOLDS;

    // 6a. Opening:long-kline(bodyAtr=0.6>=0.6),PriorDay:full-body 命中但 maxScore=0
    // open=100, close=101.2, high=101.3, low=99.9
    // total=1.4, body=1.2, bodyRatio=0.857, bodyAtr=0.6, total/open=0.014
    {
        const k = { open: 100, high: 101.3, low: 99.9, close: 101.2 };
        const rO = scoreCandleShape(k, prevAtr, tO);
        const rP = scoreCandleShape(k, prevAtr, tP);
        assert(rO.tier === 'long-kline', `6a Opening tier long-kline, got ${rO.tier}`);
        assert(rP.tier === 'full-body', `6a PriorDay tier full-body, got ${rP.tier}`);
        assert(rP.score === 0, `6a PriorDay score 0 (maxScore=0), got ${rP.score}`);
    }

    // 6b. 中阳线 total/open < 1% -> Opening: fullBodyRatio=1.01 不可达, bodyAtr=0.3<0.6 -> none
    // open=100, close=100.6, high=100.65, low=99.95
    // total=0.7, body=0.6, bodyRatio=0.857, bodyAtr=0.3, total/open=0.007
    {
        const k = { open: 100, high: 100.65, low: 99.95, close: 100.6 };
        const rO = scoreCandleShape(k, prevAtr, tO);
        const rP = scoreCandleShape(k, prevAtr, tP);
        assert(rO.tier === 'none', `6b Opening tier none (fullBodyRatio=1.01 unreachable, bodyAtr<0.6), got ${rO.tier}`);
        assert(rO.score === 0, `6b Opening score 0, got ${rO.score}`);
        assert(rP.tier === 'none', `6b PriorDay tier none (stricter fullBodyMinTotalPct), got ${rP.tier}`);
        assert(rP.score === 0, `6b PriorDay score 0, got ${rP.score}`);
    }

    // 6c. 超大阳线 bodyAtr>=0.8 -> 两边都 long-kline;但 PriorDay maxScore=0
    // open=100, close=102, high=102.1, low=99.9
    // bodyAtr=1.0 >= 0.8(PriorDay) 和 0.6(Opening)
    {
        const k = { open: 100, high: 102.1, low: 99.9, close: 102 };
        const rO = scoreCandleShape(k, prevAtr, tO);
        const rP = scoreCandleShape(k, prevAtr, tP);
        assert(rO.tier === 'long-kline', `6c Opening tier long-kline, got ${rO.tier}`);
        assert(rP.tier === 'long-kline', `6c PriorDay tier long-kline, got ${rP.tier}`);
        assert(rP.score === 0, `6c PriorDay score 0 (maxScore=0), got ${rP.score}`);
    }

    console.log('  case6 PASS');
})();

// ============================================================
// Case 7: indicator 9/10 disabled via setter
// 用 Case 1 同样的输入,但禁用指标九和十 -> total 130 应该掉到 110
// ============================================================
{
    console.log('Running case 7: indicators 9/10 disabled');
    setTrendIndicator9Enabled(false);
    setTrendIndicator10Enabled(false);
    try {
        const baseline: TrendBaseline = {
            prevClose: 100,
            prevAtr: 4,
            prevAtrShort: 4,
            rvolBaseline: 3000,
            prevDayOHLC: { open: 98, high: 101, low: 97, close: 100 },
            prevRangePctAvg7: 0.04,
        };
        const window: SerializedBar[] = [];
        for (let i = 0; i < OPENING_WINDOW_MINUTES; i++) {
            const o = 102.5 + i * 0.1;
            const c = 102.5 + (i + 1) * 0.1;
            const h = Math.max(o, c) + 0.05;
            const l = Math.min(o, c) - 0.05;
            window.push(bar(0, o, h, l, c, 2500));
        }
        window[0].open = 102.5;
        window[window.length - 1].close = 104.5;
        window[window.length - 1].high = 104.55;
        const score = scoreTrendDay(window, baseline);
        assert(score !== null, 'case7: score should not be null');
        assert(score!.todayRangePct === 0, `case7 ind9 disabled expected 0, got ${score!.todayRangePct}`);
        assert(score!.priorDayRangePct === 0, `case7 ind10 disabled expected 0, got ${score!.priorDayRangePct}`);
        assert(score!.prevRangePctAvg7 === 10, `case7 ind11 (forward default) expected 10, got ${score!.prevRangePctAvg7}`);
        assert(score!.details.todayRangePctValue > 0, 'case7 todayRangePctValue should still be computed');
        assert(score!.details.priorDayRangePctValue > 0, 'case7 priorDayRangePctValue should still be computed');
        assert(score!.gap === 25, `case7 gap expected 25, got ${score!.gap}`);
        assert(score!.rvol === 40, `case7 rvol expected 40, got ${score!.rvol}`);
        assert(score!.vwap === 5, `case7 vwap expected 5, got ${score!.vwap}`);
        assert(score!.range === 15, `case7 range expected 15, got ${score!.range}`);
        assert(score!.atrPct === 15, `case7 atrPct expected 15, got ${score!.atrPct}`);
        assert(score!.total === 110, `case7 total expected 110, got ${score!.total}`);
        console.log('  case7 PASS');
    } finally {
        resetTrendExperimentFlags();
    }
}

// ============================================================
// Case 8: indicator 11 reverse mode
// Case 2 的 baseline prevRangePctAvg7=0.015(<0.025),forward 模式下 0 分,
// reverse 模式应该给 10 分。
// ============================================================
{
    console.log('Running case 8: indicator 11 reverse mode');
    setTrendIndicator11Mode('reverse');
    try {
        const baseline: TrendBaseline = {
            prevClose: 100,
            prevAtr: 2,
            prevAtrShort: 2,
            rvolBaseline: 10000,
            prevDayOHLC: { open: 99.5, high: 100.5, low: 99, close: 100 },
            prevRangePctAvg7: 0.015,
        };
        const window: SerializedBar[] = [];
        for (let i = 0; i < OPENING_WINDOW_MINUTES; i++) {
            const o = i % 2 === 0 ? 100.45 : 100.55;
            const c = i % 2 === 0 ? 100.55 : 100.45;
            window.push(bar(0, o, 100.6, 100.4, c, 500));
        }
        window[0].open = 100.5;
        window[window.length - 1].close = 100.51;
        const score = scoreTrendDay(window, baseline);
        assert(score !== null, 'case8: score should not be null');
        assert(score!.prevRangePctAvg7 === 10, `case8 ind11 reverse expected 10, got ${score!.prevRangePctAvg7}`);
        assert(score!.details.prevRangePctAvg7Value === 0.015, 'case8 prevRangePctAvg7Value mismatch');
        assert(score!.todayRangePct === 0, `case8 todayRangePct expected 0 (ind9 untouched), got ${score!.todayRangePct}`);
        assert(score!.priorDayRangePct === 0, `case8 priorDayRangePct expected 0 (ind10 untouched), got ${score!.priorDayRangePct}`);
        console.log('  case8 PASS');
    } finally {
        resetTrendExperimentFlags();
    }
}

console.log('\n✅ trendDetector smoke all pass');

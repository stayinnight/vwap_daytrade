/**
 * choppiness 评分函数的 smoke 验证。
 *
 * 跑法:
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/smokeChoppiness.ts
 */
import { scoreChoppiness, ChoppinessParams } from '../core/indicators/choppiness';

function assert(cond: boolean, msg: string) {
    if (!cond) throw new Error('ASSERT FAIL: ' + msg);
}

/** 构造 duck-typed Candlestick（只用 close，其他字段不读） */
function makeBars(closes: number[]): any[] {
    return closes.map(c => ({
        close: { toNumber: () => c },
        open: { toNumber: () => c },
        high: { toNumber: () => c },
        low: { toNumber: () => c },
        volume: 0,
        turnover: { toNumber: () => 0 },
        timestamp: new Date(),
        tradeSession: 0,
    }));
}

const PARAMS: ChoppinessParams = {
    windowBars: 30,
    bandAtrRatios: [0.1, 0.2, 0.3],
};

// ============================================================
// Case 1: warmup —— bars 不足时返回 null
// ============================================================
(function caseWarmup() {
    console.log('Running case 1: warmup returns null');
    const bars = makeBars(new Array(29).fill(100));
    const result = scoreChoppiness(bars, 100, 1, PARAMS);
    assert(result === null, `expected null, got ${JSON.stringify(result)}`);
    console.log('  case 1 PASS');
})();

// ============================================================
// Case 2: 防御性输入 —— atr<=0 / vwap<=0 返回 null
// ============================================================
(function caseInvalidInputs() {
    console.log('Running case 2: invalid inputs return null');
    const bars = makeBars(new Array(30).fill(100));
    assert(scoreChoppiness(bars, 100, 0, PARAMS) === null, 'atr=0 should be null');
    assert(scoreChoppiness(bars, 100, -1, PARAMS) === null, 'atr<0 should be null');
    assert(scoreChoppiness(bars, 0, 1, PARAMS) === null, 'vwap=0 should be null');
    assert(scoreChoppiness(bars, NaN, 1, PARAMS) === null, 'vwap=NaN should be null');
    console.log('  case 2 PASS');
})();

// ============================================================
// Case 3: 纯多头单边 —— 30 根全在 VWAP 上方，满分 70
//   crossings=0 → 40 分
//   带外（|close-vwap|=1.0 远大于 0.3*atr=0.3）→ inBand 全 0 → 30 分
// ============================================================
(function caseStrongTrend() {
    console.log('Running case 3: strong long trend → 70/70');
    const bars = makeBars(new Array(30).fill(101)); // close=101，vwap=100，atr=1
    const result = scoreChoppiness(bars, 100, 1, PARAMS);
    assert(result !== null, 'should not be null');
    assert(result!.total === 70, `expected total=70, got ${result!.total}`);
    assert(result!.crossings === 40, `expected crossings=40, got ${result!.crossings}`);
    assert(result!.bandRatio === 30, `expected bandRatio=30, got ${result!.bandRatio}`);
    assert(result!.details.crossingCount === 0, `expected count=0, got ${result!.details.crossingCount}`);
    assert(result!.details.crossingRate === 0, `expected rate=0, got ${result!.details.crossingRate}`);
    console.log('  case 3 PASS');
})();

// ============================================================
// Case 4: 死震荡 —— 上下交替 +1/-1，crossings=29，rate≈1.0 → 0 分
//   close 取 vwap ± 0.05*atr，全在 0.1 带内 → 三档全是 1.0 → 全 0 分
// ============================================================
(function caseDeadChop() {
    console.log('Running case 4: dead chop → 0/70');
    const closes: number[] = [];
    for (let i = 0; i < 30; i++) {
        closes.push(i % 2 === 0 ? 100.05 : 99.95); // ±0.05，atr=1
    }
    const result = scoreChoppiness(makeBars(closes), 100, 1, PARAMS);
    assert(result !== null, 'should not be null');
    assert(result!.total === 0, `expected total=0, got ${result!.total}`);
    assert(result!.details.crossingCount === 29, `expected count=29, got ${result!.details.crossingCount}`);
    assert(result!.details.inBandRatios.every(r => r === 1), `expected all 1, got ${result!.details.inBandRatios}`);
    console.log('  case 4 PASS');
})();

// ============================================================
// Case 5: 一次大反转 —— 前 15 根 +1、后 15 根 -1
//   crossings=1，rate≈0.034 → 40 分（边界示例对齐 spec §3.1）
//   close 距离 vwap=2 远大于 0.3*atr=0.3 → 三档全 0 → 30 分
//   总分 70
// ============================================================
(function caseSingleReversal() {
    console.log('Running case 5: single reversal → 70/70');
    const closes = [
        ...new Array(15).fill(102),
        ...new Array(15).fill(98),
    ];
    const result = scoreChoppiness(makeBars(closes), 100, 1, PARAMS);
    assert(result !== null, 'should not be null');
    assert(result!.details.crossingCount === 1, `expected count=1, got ${result!.details.crossingCount}`);
    assert(result!.crossings === 40, `expected crossings=40, got ${result!.crossings}`);
    assert(result!.total === 70, `expected total=70, got ${result!.total}`);
    console.log('  case 5 PASS');
})();

// ============================================================
// Case 6: close 恰好等于 vwap —— side=0 跳过比对
//   构造序列 +1, 0, -1 重复 10 组（30 根）
//   每组内 +1→0(跳)→-1：因为 0 跳过比对，prevSide 留在 +1，到 -1 时算 1 次穿越
//   组与组之间：上一组末尾 -1 → 下一组开头 +1 算 1 次穿越
//   10 组内 10 次穿越 + 9 个组间 9 次穿越 = 19 次
// ============================================================
(function caseEqualVwap() {
    console.log('Running case 6: close == vwap is skipped');
    const closes: number[] = [];
    for (let i = 0; i < 10; i++) {
        closes.push(101, 100, 99);
    }
    const result = scoreChoppiness(makeBars(closes), 100, 1, PARAMS);
    assert(result !== null, 'should not be null');
    assert(result!.details.crossingCount === 19, `expected count=19, got ${result!.details.crossingCount}`);
    console.log('  case 6 PASS');
})();

// ============================================================
// Case 7: 跨 window 评分可比性 —— 同样的"穿越频率约 40%"在 N=15 和 N=30 都得 0 分
// ============================================================
(function caseWindowComparable() {
    console.log('Running case 7: cross-window comparability');
    // N=30, 大致 12 次切换 → rate ≈ 0.41 > 0.25 → 0 分
    const long = makeBars(
        Array.from({ length: 30 }, (_, i) => i % 5 < 2 ? 101 : 99)
    );
    const r1 = scoreChoppiness(long, 100, 1, { ...PARAMS, windowBars: 30 });
    assert(r1 !== null, 'r1 not null');

    // N=15, 大致 6 次切换 → rate ≈ 0.43 > 0.25 → 0 分
    const short = makeBars(
        Array.from({ length: 15 }, (_, i) => i % 5 < 2 ? 101 : 99)
    );
    const r2 = scoreChoppiness(short, 100, 1, { ...PARAMS, windowBars: 15 });
    assert(r2 !== null, 'r2 not null');

    assert(r1!.crossings === 0, `r1 crossings expected 0, got ${r1!.crossings}`);
    assert(r2!.crossings === 0, `r2 crossings expected 0, got ${r2!.crossings}`);
    console.log('  case 7 PASS');
})();

console.log('\n✅ choppiness smoke all pass');

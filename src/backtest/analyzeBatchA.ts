/**
 * 批次 A 对比分析脚本
 *
 * 读 9 组实验的 results json，按"方向过滤 × stopAtrRatio"两个维度
 * 输出对比表（trades / 胜率 / 期望R / cumR / 多空分解 / 最大回撤 / 时段分布）
 *
 * 用法：
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/analyzeBatchA.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import type { BacktestResult, BacktestTrade } from './types';

const RESULT_DIR = path.resolve(process.cwd(), 'data/backtest/results');

interface Group {
    label: string;
    file: string;
    direction: 'none' | 'index_on' | 'phase_dir';
    stopAtr: number;
}

const GROUPS: Group[] = [
    { label: 'baseline_1y',          file: 'baseline_1y.json',          direction: 'none',      stopAtr: 0.2 },
    { label: 'index_on_1y',          file: 'index_on_1y.json',          direction: 'index_on',  stopAtr: 0.2 },
    { label: 'phase_dir_1y',         file: 'phase_dir_1y.json',         direction: 'phase_dir', stopAtr: 0.2 },
    { label: 'baseline_1y_sl010',    file: 'baseline_1y_sl010.json',    direction: 'none',      stopAtr: 0.1 },
    { label: 'baseline_1y_sl030',    file: 'baseline_1y_sl030.json',    direction: 'none',      stopAtr: 0.3 },
    { label: 'index_on_1y_sl010',    file: 'index_on_1y_sl010.json',    direction: 'index_on',  stopAtr: 0.1 },
    { label: 'phase_dir_1y_sl010',   file: 'phase_dir_1y_sl010.json',   direction: 'phase_dir', stopAtr: 0.1 },
    { label: 'index_on_1y_sl030',    file: 'index_on_1y_sl030.json',    direction: 'index_on',  stopAtr: 0.3 },
    { label: 'phase_dir_1y_sl030',   file: 'phase_dir_1y_sl030.json',   direction: 'phase_dir', stopAtr: 0.3 },
];

interface Metrics {
    label: string;
    direction: string;
    stopAtr: number;
    n: number;
    winRate: number;       // %
    avgR: number;          // 期望 R per trade
    cumR: number;          // 累计 R
    longN: number;
    longCumR: number;
    shortN: number;
    shortCumR: number;
    sl: number;            // SL 出场数
    fc: number;            // ForceClose 出场数
    tp: number;            // TP 出场数（trailing 模式下应为 0）
    early: number;
    main: number;
    late: number;
    maxDDr: number;        // 累计 R 曲线的最大回撤（R 单位）
    profitFactor: number;  // 总盈利 R / |总亏损 R|
}

function loadResult(file: string): BacktestResult | null {
    const p = path.join(RESULT_DIR, file);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as BacktestResult;
}

function computeMetrics(g: Group, r: BacktestResult): Metrics {
    const trades = r.trades;
    const n = trades.length;
    const wins = trades.filter(t => t.rMultiple > 0);
    const winRate = n > 0 ? (wins.length / n) * 100 : 0;
    const cumR = trades.reduce((s, t) => s + t.rMultiple, 0);
    const avgR = n > 0 ? cumR / n : 0;

    const long = trades.filter(t => t.side === 'Buy');
    const short = trades.filter(t => t.side === 'Sell');
    const longCumR = long.reduce((s, t) => s + t.rMultiple, 0);
    const shortCumR = short.reduce((s, t) => s + t.rMultiple, 0);

    const cnt = (arr: BacktestTrade[], k: keyof BacktestTrade, v: any) =>
        arr.filter(t => t[k] === v).length;
    const sl = cnt(trades, 'exitReason', 'SL');
    const fc = cnt(trades, 'exitReason', 'ForceClose');
    const tp = cnt(trades, 'exitReason', 'TP');
    const early = cnt(trades, 'phaseAtEntry', 'early');
    const main = cnt(trades, 'phaseAtEntry', 'main');
    const late = cnt(trades, 'phaseAtEntry', 'late');

    // 最大回撤：把 trades 按 entryTimestamp 排序，构造累计 R 曲线，算 peak-trough
    const sorted = [...trades].sort((a, b) => a.entryTimestamp - b.entryTimestamp);
    let cum = 0, peak = 0, maxDD = 0;
    for (const t of sorted) {
        cum += t.rMultiple;
        if (cum > peak) peak = cum;
        const dd = peak - cum;
        if (dd > maxDD) maxDD = dd;
    }

    // Profit Factor
    const grossWin = trades.filter(t => t.rMultiple > 0).reduce((s, t) => s + t.rMultiple, 0);
    const grossLoss = Math.abs(trades.filter(t => t.rMultiple < 0).reduce((s, t) => s + t.rMultiple, 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : Infinity;

    return {
        label: g.label,
        direction: g.direction,
        stopAtr: g.stopAtr,
        n, winRate, avgR, cumR,
        longN: long.length, longCumR,
        shortN: short.length, shortCumR,
        sl, fc, tp,
        early, main, late,
        maxDDr: maxDD,
        profitFactor,
    };
}

function pad(s: string | number, n: number, right = false): string {
    const str = String(s);
    if (str.length >= n) return str.slice(0, n);
    return right ? str + ' '.repeat(n - str.length) : ' '.repeat(n - str.length) + str;
}

function fmt(x: number, d = 2): string {
    return x.toFixed(d);
}

function printTable(metrics: Metrics[]) {
    console.log('\n========== 总表（按 cumR 降序）==========');
    const sorted = [...metrics].sort((a, b) => b.cumR - a.cumR);
    console.log(
        pad('label', 24, true),
        pad('dir', 10, true),
        pad('sl', 5),
        pad('n', 7),
        pad('win%', 7),
        pad('avgR', 8),
        pad('cumR', 9),
        pad('PF', 6),
        pad('maxDD', 8),
        pad('long(n/R)', 16, true),
        pad('short(n/R)', 16, true),
    );
    for (const m of sorted) {
        console.log(
            pad(m.label, 24, true),
            pad(m.direction, 10, true),
            pad(fmt(m.stopAtr, 1), 5),
            pad(m.n, 7),
            pad(fmt(m.winRate, 1), 7),
            pad(fmt(m.avgR, 4), 8),
            pad(fmt(m.cumR, 1), 9),
            pad(fmt(m.profitFactor, 2), 6),
            pad(fmt(m.maxDDr, 1), 8),
            pad(`${m.longN}/${fmt(m.longCumR, 1)}`, 16, true),
            pad(`${m.shortN}/${fmt(m.shortCumR, 1)}`, 16, true),
        );
    }
}

function printMatrixView(metrics: Metrics[]) {
    console.log('\n========== 3×3 矩阵视图（cumR）==========');
    const dirs: Array<'none' | 'index_on' | 'phase_dir'> = ['none', 'index_on', 'phase_dir'];
    const stops = [0.1, 0.2, 0.3];
    console.log(pad('', 12, true), stops.map(s => pad(`SL=${s}`, 12)).join(''));
    for (const d of dirs) {
        const row = [pad(d, 12, true)];
        for (const s of stops) {
            const m = metrics.find(x => x.direction === d && Math.abs(x.stopAtr - s) < 1e-6);
            row.push(pad(m ? fmt(m.cumR, 1) : '—', 12));
        }
        console.log(row.join(''));
    }

    console.log('\n========== 3×3 矩阵视图（avgR per trade）==========');
    console.log(pad('', 12, true), stops.map(s => pad(`SL=${s}`, 12)).join(''));
    for (const d of dirs) {
        const row = [pad(d, 12, true)];
        for (const s of stops) {
            const m = metrics.find(x => x.direction === d && Math.abs(x.stopAtr - s) < 1e-6);
            row.push(pad(m ? fmt(m.avgR, 4) : '—', 12));
        }
        console.log(row.join(''));
    }

    console.log('\n========== 3×3 矩阵视图（trades 数）==========');
    console.log(pad('', 12, true), stops.map(s => pad(`SL=${s}`, 12)).join(''));
    for (const d of dirs) {
        const row = [pad(d, 12, true)];
        for (const s of stops) {
            const m = metrics.find(x => x.direction === d && Math.abs(x.stopAtr - s) < 1e-6);
            row.push(pad(m ? String(m.n) : '—', 12));
        }
        console.log(row.join(''));
    }
}

function printDirectionalBreakdown(metrics: Metrics[]) {
    console.log('\n========== 多空分解（cumR）==========');
    console.log(
        pad('label', 24, true),
        pad('long_n', 8),
        pad('long_R', 9),
        pad('long_R/n', 10),
        pad('short_n', 8),
        pad('short_R', 9),
        pad('short_R/n', 10),
    );
    for (const m of metrics) {
        const lr = m.longN > 0 ? m.longCumR / m.longN : 0;
        const sr = m.shortN > 0 ? m.shortCumR / m.shortN : 0;
        console.log(
            pad(m.label, 24, true),
            pad(m.longN, 8),
            pad(fmt(m.longCumR, 1), 9),
            pad(fmt(lr, 4), 10),
            pad(fmt(m.shortN, 8), 8),
            pad(fmt(m.shortCumR, 1), 9),
            pad(fmt(sr, 4), 10),
        );
    }
}

function printPhaseBreakdown(metrics: Metrics[]) {
    console.log('\n========== 时段分布 ==========');
    console.log(
        pad('label', 24, true),
        pad('early', 8),
        pad('main', 8),
        pad('late', 8),
        pad('SL', 7),
        pad('FC', 7),
    );
    for (const m of metrics) {
        console.log(
            pad(m.label, 24, true),
            pad(m.early, 8),
            pad(m.main, 8),
            pad(m.late, 8),
            pad(m.sl, 7),
            pad(m.fc, 7),
        );
    }
}

function findings(metrics: Metrics[]): string[] {
    const out: string[] = [];
    const baseline = metrics.find(m => m.label === 'baseline_1y');
    if (!baseline) return out;

    // 1. 最佳组合
    const best = [...metrics].sort((a, b) => b.cumR - a.cumR)[0];
    const worst = [...metrics].sort((a, b) => a.cumR - b.cumR)[0];
    out.push(`最佳组合: ${best.label} (cumR=${fmt(best.cumR, 1)}, vs baseline ${fmt(best.cumR - baseline.cumR, 1)} R)`);
    out.push(`最差组合: ${worst.label} (cumR=${fmt(worst.cumR, 1)}, vs baseline ${fmt(worst.cumR - baseline.cumR, 1)} R)`);

    // 2. stopAtr 维度的单调性（在 direction=none 下）
    const slRow = [0.1, 0.2, 0.3].map(s =>
        metrics.find(m => m.direction === 'none' && Math.abs(m.stopAtr - s) < 1e-6)
    );
    if (slRow[0] && slRow[1] && slRow[2]) {
        out.push(`stopAtr 维度（无方向过滤）: 0.1=${fmt(slRow[0]!.cumR, 1)}, 0.2=${fmt(slRow[1]!.cumR, 1)}, 0.3=${fmt(slRow[2]!.cumR, 1)}`);
        const trend =
            slRow[0]!.cumR < slRow[1]!.cumR && slRow[1]!.cumR < slRow[2]!.cumR ? '单调上升（宽止损更优）' :
            slRow[0]!.cumR > slRow[1]!.cumR && slRow[1]!.cumR > slRow[2]!.cumR ? '单调下降（紧止损更优）' :
            '非单调';
        out.push(`  → ${trend}`);
    }

    // 3. indexFilter 维度
    const idxOff = baseline;
    const idxOn = metrics.find(m => m.label === 'index_on_1y');
    if (idxOff && idxOn) {
        const delta = idxOn.cumR - idxOff.cumR;
        out.push(`indexFilter 效果: off=${fmt(idxOff.cumR, 1)}, on=${fmt(idxOn.cumR, 1)}, Δ=${delta > 0 ? '+' : ''}${fmt(delta, 1)} R (${delta > 0 ? '✅ 有用' : '❌ 有害'})`);
    }

    // 4. phaseDirectional
    const pd = metrics.find(m => m.label === 'phase_dir_1y');
    if (pd && baseline) {
        const delta = pd.cumR - baseline.cumR;
        out.push(`phaseDirectional 效果: ${fmt(pd.cumR, 1)} vs baseline ${fmt(baseline.cumR, 1)}, Δ=${delta > 0 ? '+' : ''}${fmt(delta, 1)} R`);
    }

    // 5. 多空 alpha 分布
    out.push(`多空 alpha 分布:`);
    out.push(`  baseline: 多 +${fmt(baseline.longCumR, 1)} (n=${baseline.longN}) / 空 +${fmt(baseline.shortCumR, 1)} (n=${baseline.shortN})`);
    const longDom = baseline.longCumR > baseline.shortCumR;
    out.push(`  → ${longDom ? '多头主导' : '空头主导'} (差值 ${fmt(Math.abs(baseline.longCumR - baseline.shortCumR), 1)} R)`);

    // 6. 期望 R/trade 最高
    const bestAvg = [...metrics].sort((a, b) => b.avgR - a.avgR)[0];
    out.push(`期望 R/trade 最高: ${bestAvg.label} (${fmt(bestAvg.avgR, 4)} R/trade, n=${bestAvg.n})`);

    // 7. ProfitFactor
    const bestPF = [...metrics].sort((a, b) => b.profitFactor - a.profitFactor)[0];
    out.push(`ProfitFactor 最高: ${bestPF.label} (PF=${fmt(bestPF.profitFactor, 2)})`);

    // 8. maxDD 最小（要看相对值）
    const bestDD = [...metrics]
        .filter(m => m.cumR > 0)
        .sort((a, b) => a.maxDDr / Math.max(a.cumR, 1) - b.maxDDr / Math.max(b.cumR, 1))[0];
    if (bestDD) {
        out.push(`回撤/收益比最优 (cumR>0): ${bestDD.label} (maxDD=${fmt(bestDD.maxDDr, 1)} R, cumR=${fmt(bestDD.cumR, 1)} R, 比 ${fmt(bestDD.maxDDr / bestDD.cumR, 2)})`);
    }

    return out;
}

function main() {
    const metrics: Metrics[] = [];
    const missing: string[] = [];
    for (const g of GROUPS) {
        const r = loadResult(g.file);
        if (!r) {
            missing.push(g.label);
            continue;
        }
        metrics.push(computeMetrics(g, r));
    }

    if (missing.length) {
        console.log(`\n[warn] 缺失结果文件: ${missing.join(', ')}`);
        console.log('       这些组将不在分析中显示\n');
    }

    if (metrics.length === 0) {
        console.error('没有可用的结果文件，退出');
        process.exit(1);
    }

    printTable(metrics);
    printMatrixView(metrics);
    printDirectionalBreakdown(metrics);
    printPhaseBreakdown(metrics);

    console.log('\n========== 关键发现 ==========');
    for (const f of findings(metrics)) {
        console.log('  ' + f);
    }
    console.log();
}

main();

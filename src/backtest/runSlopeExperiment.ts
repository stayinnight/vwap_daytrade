/**
 * VWAP 斜率入场实验：批量跑 A（顺势）+ B（逆势/均值回归）对比 baseline。
 *
 * 用法：
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/runSlopeExperiment.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { runBacktest, RunnerOptions } from './runner';
import { BacktestResult, BacktestTrade } from './types';

const RESULT_DIR = path.resolve(process.cwd(), 'data/backtest/results');
const OUT_PATH = path.resolve(process.cwd(), 'data/backtest/report_slope.md');

// ======================================================================
// 实验矩阵
// ======================================================================
const experiments: RunnerOptions[] = [
    // C0: baseline（无斜率门控）
    {
        label: 'slope_C0_baseline',
        exitMode: 'trailing',
    },
    // C1: 过滤最平的 ~40%
    {
        label: 'slope_C1_momentum_0.1bps',
        exitMode: 'trailing',
        slopeFilter: { mode: 'momentum', threshold: 0.1 },
    },
    // C2: 过滤一半震荡 (~P50)
    {
        label: 'slope_C2_momentum_0.2bps',
        exitMode: 'trailing',
        slopeFilter: { mode: 'momentum', threshold: 0.2 },
    },
    // A3: 顺势，中等门槛（~P72）
    {
        label: 'slope_C3_momentum_0.5bps',
        exitMode: 'trailing',
        slopeFilter: { mode: 'momentum', threshold: 0.5 },
    },
    // C4: 只做强趋势 (~P85)
    {
        label: 'slope_C4_momentum_1.0bps',
        exitMode: 'trailing',
        slopeFilter: { mode: 'momentum', threshold: 1.0 },
    },
];

// ======================================================================
// Stats 计算（和 report.ts 一致）
// ======================================================================
interface Stats {
    trades: number;
    winRate: number;
    avgWinR: number;
    avgLossR: number;
    expectancy: number;
    cumulativeR: number;
    maxDrawdownR: number;
    slPct: number;
    fcPct: number;
}

function computeStats(trades: BacktestTrade[]): Stats {
    if (trades.length === 0) {
        return { trades: 0, winRate: 0, avgWinR: 0, avgLossR: 0, expectancy: 0, cumulativeR: 0, maxDrawdownR: 0, slPct: 0, fcPct: 0 };
    }
    const rs = trades.map(t => t.rMultiple);
    const wins = rs.filter(r => r > 0);
    const losses = rs.filter(r => r <= 0);
    const cum = rs.reduce((a, b) => a + b, 0);

    const ordered = [...trades].sort((a, b) => a.exitTimestamp - b.exitTimestamp);
    let running = 0, peak = 0, maxDD = 0;
    for (const t of ordered) {
        running += t.rMultiple;
        if (running > peak) peak = running;
        const dd = peak - running;
        if (dd > maxDD) maxDD = dd;
    }

    const byReason: Record<string, number> = {};
    trades.forEach(t => { byReason[t.exitReason] = (byReason[t.exitReason] ?? 0) + 1; });

    return {
        trades: trades.length,
        winRate: (wins.length / trades.length) * 100,
        avgWinR: wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0,
        avgLossR: losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0,
        expectancy: cum / trades.length,
        cumulativeR: cum,
        maxDrawdownR: maxDD,
        slPct: ((byReason['SL'] ?? 0) / trades.length) * 100,
        fcPct: ((byReason['ForceClose'] ?? 0) / trades.length) * 100,
    };
}

function fmt(n: number, digits = 2): string {
    return Number.isFinite(n) ? n.toFixed(digits) : '-';
}

// ======================================================================
// 多空拆分
// ======================================================================
function splitBySide(trades: BacktestTrade[]) {
    const long = trades.filter(t => t.side === 'Buy');
    const short = trades.filter(t => t.side === 'Sell');
    return { long, short };
}

// ======================================================================
// 主流程
// ======================================================================
async function main() {
    const results: { opts: RunnerOptions; result: BacktestResult }[] = [];

    for (const opts of experiments) {
        console.log(`\n${'='.repeat(60)}`);
        const result = await runBacktest(opts);
        results.push({ opts, result });
    }

    // 生成报告
    const lines: string[] = [];
    lines.push('# VWAP 斜率入场实验报告');
    lines.push('');
    lines.push(`> 生成时间: ${new Date().toISOString().slice(0, 19)}`);
    lines.push(`> EMA period: 10, 样本: ${results[0]?.result.startDate} ~ ${results[0]?.result.endDate}`);
    lines.push('');

    // 总表
    lines.push('## 总表');
    lines.push('');
    lines.push('| 实验组 | 模式 | 阈值(bps) | 交易数 | 胜率% | 期望R | 累计R | 最大回撤R | SL% | FC% |');
    lines.push('|--------|------|----------|--------|-------|-------|-------|----------|-----|-----|');

    for (const { opts, result } of results) {
        const s = computeStats(result.trades);
        const mode = opts.slopeFilter?.mode ?? '-';
        const th = opts.slopeFilter?.threshold?.toString() ?? '-';
        lines.push(
            `| ${opts.label} | ${mode} | ${th} | ${s.trades} | ${fmt(s.winRate)} | ${fmt(s.expectancy, 4)} | ${fmt(s.cumulativeR, 1)} | ${fmt(s.maxDrawdownR, 1)} | ${fmt(s.slPct)} | ${fmt(s.fcPct)} |`
        );
    }

    // 多空拆分表
    lines.push('');
    lines.push('## 多空拆分');
    lines.push('');
    lines.push('| 实验组 | 多-交易数 | 多-胜率% | 多-期望R | 多-累计R | 空-交易数 | 空-胜率% | 空-期望R | 空-累计R |');
    lines.push('|--------|----------|---------|---------|---------|----------|---------|---------|---------|');

    for (const { opts, result } of results) {
        const { long, short } = splitBySide(result.trades);
        const ls = computeStats(long);
        const ss = computeStats(short);
        lines.push(
            `| ${opts.label} | ${ls.trades} | ${fmt(ls.winRate)} | ${fmt(ls.expectancy, 4)} | ${fmt(ls.cumulativeR, 1)} | ${ss.trades} | ${fmt(ss.winRate)} | ${fmt(ss.expectancy, 4)} | ${fmt(ss.cumulativeR, 1)} |`
        );
    }

    // vs baseline 对比
    const baselineStats = computeStats(results[0].result.trades);
    lines.push('');
    lines.push('## vs Baseline 对比');
    lines.push('');
    lines.push('| 实验组 | 交易数变化 | 期望R变化 | 累计R变化 |');
    lines.push('|--------|----------|----------|----------|');

    for (const { opts, result } of results) {
        const s = computeStats(result.trades);
        const tradeDelta = s.trades - baselineStats.trades;
        const expDelta = s.expectancy - baselineStats.expectancy;
        const cumDelta = s.cumulativeR - baselineStats.cumulativeR;
        lines.push(
            `| ${opts.label} | ${tradeDelta >= 0 ? '+' : ''}${tradeDelta} | ${expDelta >= 0 ? '+' : ''}${fmt(expDelta, 4)} | ${cumDelta >= 0 ? '+' : ''}${fmt(cumDelta, 1)} |`
        );
    }

    const md = lines.join('\n');
    fs.writeFileSync(OUT_PATH, md);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`报告已写入: ${path.relative(process.cwd(), OUT_PATH)}`);
    console.log(md);
}

main()
    .then(() => process.exit(0))
    .catch(e => {
        console.error(e);
        process.exit(1);
    });

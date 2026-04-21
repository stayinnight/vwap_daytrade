/**
 * 输出指定回测结果的"按月 cumR 曲线 + 滚动指标"。
 * 用来检查 cumR 不是被某几个月集中贡献（防过拟合）。
 *
 * 用法：
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/monthlyCurve.ts \
 *     baseline_1y baseline_1y_sl010 baseline_1y_sl015
 */
import * as fs from 'fs';
import * as path from 'path';
import type { BacktestResult } from './types';

const RESULT_DIR = path.resolve(process.cwd(), 'data/backtest/results');

interface MonthRow {
    month: string;     // YYYY-MM
    n: number;
    cumR: number;      // 当月 R
    accR: number;      // 累计 R 到当月末
    win: number;       // 当月胜率 %
    longR: number;
    shortR: number;
}

function load(label: string): BacktestResult {
    const p = path.join(RESULT_DIR, `${label}.json`);
    if (!fs.existsSync(p)) {
        console.error(`缺失文件: ${p}`);
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(p, 'utf8')) as BacktestResult;
}

function aggregateByMonth(r: BacktestResult): MonthRow[] {
    const map: Record<string, { trades: typeof r.trades }> = {};
    for (const t of r.trades) {
        const m = new Date(t.entryTimestamp).toISOString().slice(0, 7);
        if (!map[m]) map[m] = { trades: [] };
        map[m].trades.push(t);
    }
    const months = Object.keys(map).sort();
    let acc = 0;
    return months.map(m => {
        const trades = map[m].trades;
        const cumR = trades.reduce((s, t) => s + t.rMultiple, 0);
        acc += cumR;
        const wins = trades.filter(t => t.rMultiple > 0).length;
        const longR = trades.filter(t => t.side === 'Buy').reduce((s, t) => s + t.rMultiple, 0);
        const shortR = trades.filter(t => t.side === 'Sell').reduce((s, t) => s + t.rMultiple, 0);
        return {
            month: m,
            n: trades.length,
            cumR,
            accR: acc,
            win: trades.length > 0 ? (wins / trades.length) * 100 : 0,
            longR,
            shortR,
        };
    });
}

function pad(s: string | number, n: number, right = false): string {
    const str = String(s);
    if (str.length >= n) return str.slice(0, n);
    return right ? str + ' '.repeat(n - str.length) : ' '.repeat(n - str.length) + str;
}
function fmt(x: number, d = 2): string {
    return x.toFixed(d);
}

function printOne(label: string, rows: MonthRow[]) {
    console.log(`\n========== ${label} ==========`);
    console.log(
        pad('month', 9, true),
        pad('n', 6),
        pad('monR', 9),
        pad('accR', 10),
        pad('win%', 7),
        pad('long', 9),
        pad('short', 9),
        pad('bar', 25, true),
    );
    const maxAbs = Math.max(...rows.map(r => Math.abs(r.cumR)), 1);
    for (const r of rows) {
        const barLen = Math.round((Math.abs(r.cumR) / maxAbs) * 20);
        const bar = (r.cumR >= 0 ? '+' : '-').repeat(Math.max(barLen, 1));
        console.log(
            pad(r.month, 9, true),
            pad(r.n, 6),
            pad(fmt(r.cumR, 1), 9),
            pad(fmt(r.accR, 1), 10),
            pad(fmt(r.win, 1), 7),
            pad(fmt(r.longR, 1), 9),
            pad(fmt(r.shortR, 1), 9),
            pad(bar, 25, true),
        );
    }
    // 统计稳健性指标
    const monthlyR = rows.map(r => r.cumR);
    const mean = monthlyR.reduce((a, b) => a + b, 0) / monthlyR.length;
    const variance = monthlyR.reduce((a, b) => a + (b - mean) ** 2, 0) / monthlyR.length;
    const stdev = Math.sqrt(variance);
    const positive = monthlyR.filter(x => x > 0).length;
    const sharpe = stdev > 0 ? mean / stdev : 0;
    const best = Math.max(...monthlyR);
    const worst = Math.min(...monthlyR);
    const top3 = [...monthlyR].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
    const totalR = monthlyR.reduce((a, b) => a + b, 0);
    console.log(
        `  月数=${rows.length}  正月数=${positive}/${rows.length}  ` +
        `月均=${fmt(mean, 1)}R  σ=${fmt(stdev, 1)}R  ` +
        `月Sharpe=${fmt(sharpe, 2)}  最佳=${fmt(best, 1)}  最差=${fmt(worst, 1)}  ` +
        `top3 月占比=${fmt(top3 / totalR * 100, 1)}%`
    );
}

function compare(labels: string[], allRows: Record<string, MonthRow[]>) {
    console.log(`\n========== 累计 R 曲线对比（每月末 accR）==========`);
    const months = Array.from(new Set(Object.values(allRows).flatMap(rs => rs.map(r => r.month)))).sort();
    console.log(pad('month', 9, true), labels.map(l => pad(l, 22)).join(''));
    for (const m of months) {
        const row = [pad(m, 9, true)];
        for (const l of labels) {
            const r = allRows[l].find(x => x.month === m);
            row.push(pad(r ? fmt(r.accR, 1) : '—', 22));
        }
        console.log(row.join(''));
    }
}

function main() {
    const labels = process.argv.slice(2);
    if (labels.length === 0) {
        console.error('Usage: monthlyCurve.ts <label1> [label2] ...');
        process.exit(1);
    }
    const allRows: Record<string, MonthRow[]> = {};
    for (const label of labels) {
        const r = load(label);
        const rows = aggregateByMonth(r);
        allRows[label] = rows;
        printOne(label, rows);
    }
    if (labels.length > 1) compare(labels, allRows);
}

main();

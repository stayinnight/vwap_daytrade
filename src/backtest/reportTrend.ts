/**
 * 趋势日 detector 实验报告生成器。
 *
 * 读 data/backtest/results/baseline_loose_sl010.json (对照)
 *   + data/backtest/results/trend_recordonly_sl010.json (detector 关但记录分数)
 *   + data/backtest/results/trend_score60_sl010.json   (detector 开)
 *
 * 输出 data/backtest/report_trend.md,包含:
 *   1. 主表(A + B)  : trades / winRate / avgR / expectancy / cumR / maxDD / cumR÷maxDD
 *   2. 分数分组表(C): 读 trend_recordonly,按 entryDayScore 分桶统计
 *   3. 09:30–09:44 时段贡献表:量化方案 A"禁前 15 分钟"的代价
 *
 * 跑法:
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/reportTrend.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { BacktestResult, BacktestTrade } from './types';

const RESULT_DIR = path.resolve(process.cwd(), 'data/backtest/results');
const REPORT_PATH = path.resolve(process.cwd(), 'data/backtest/report_trend.md');

function loadResult(label: string): BacktestResult | null {
    const p = path.join(RESULT_DIR, `${label}.json`);
    if (!fs.existsSync(p)) {
        console.warn(`[reportTrend] 缺失 ${p},跳过`);
        return null;
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

interface Summary {
    label: string;
    trades: number;
    winRate: number;
    avgR: number;
    expectancy: number;
    cumR: number;
    maxDD: number;
    ratio: number; // cumR / maxDD
}

function summarize(label: string, trades: BacktestTrade[]): Summary {
    const n = trades.length;
    if (n === 0) {
        return { label, trades: 0, winRate: 0, avgR: 0, expectancy: 0, cumR: 0, maxDD: 0, ratio: 0 };
    }
    let sumR = 0;
    let wins = 0;
    for (const t of trades) {
        sumR += t.rMultiple;
        if (t.rMultiple > 0) wins++;
    }
    const cumR = sumR;
    const avgR = sumR / n;
    const winRate = wins / n;
    const expectancy = avgR;

    // 最大回撤:按 entryTimestamp 排序累计 R 曲线的最大 drawdown
    const sorted = [...trades].sort((a, b) => a.entryTimestamp - b.entryTimestamp);
    let peak = 0;
    let acc = 0;
    let maxDD = 0;
    for (const t of sorted) {
        acc += t.rMultiple;
        if (acc > peak) peak = acc;
        const dd = peak - acc;
        if (dd > maxDD) maxDD = dd;
    }
    const ratio = maxDD > 0 ? cumR / maxDD : 0;
    return { label, trades: n, winRate, avgR, expectancy, cumR, maxDD, ratio };
}

function fmt(n: number, d = 2): string {
    if (!Number.isFinite(n)) return '-';
    return n.toFixed(d);
}

function pct(n: number): string {
    return (n * 100).toFixed(1) + '%';
}

function renderSummaryTable(rows: Summary[]): string {
    const header = '| label | trades | winRate | avgR | expectancy | cumR | maxDD | cumR÷maxDD |';
    const sep = '|---|---|---|---|---|---|---|---|';
    const lines = [header, sep];
    for (const r of rows) {
        lines.push(
            `| ${r.label} | ${r.trades} | ${pct(r.winRate)} | ${fmt(r.avgR, 4)} | ${fmt(r.expectancy, 4)} | ${fmt(r.cumR, 1)} | ${fmt(r.maxDD, 1)} | ${fmt(r.ratio, 2)} |`
        );
    }
    return lines.join('\n');
}

// ============================================================
// 分数分组表(C)
// ============================================================
interface ScoreBucket {
    label: string;
    match: (s: number | null) => boolean;
}

const SCORE_BUCKETS: ScoreBucket[] = [
    { label: 'null (无基线)', match: s => s === null },
    { label: '0 ≤ s < 30', match: s => s !== null && s >= 0 && s < 30 },
    { label: '30 ≤ s < 55', match: s => s !== null && s >= 30 && s < 55 },
    { label: '55 ≤ s < 85', match: s => s !== null && s >= 55 && s < 85 },
    { label: '85 ≤ s < 115', match: s => s !== null && s >= 85 && s < 115 },
    { label: '115 ≤ s ≤ 170', match: s => s !== null && s >= 115 && s <= 170 },
];

function renderBucketTable(trades: BacktestTrade[]): string {
    const lines = ['| 分数桶 | trades | winRate | avgR | expectancy | cumR |', '|---|---|---|---|---|---|'];
    for (const bucket of SCORE_BUCKETS) {
        const subset = trades.filter(t => bucket.match(t.entryDayScore ?? null));
        const s = summarize(bucket.label, subset);
        lines.push(
            `| ${bucket.label} | ${s.trades} | ${pct(s.winRate)} | ${fmt(s.avgR, 4)} | ${fmt(s.expectancy, 4)} | ${fmt(s.cumR, 1)} |`
        );
    }
    return lines.join('\n');
}

// ============================================================
// 09:30–09:44 时段贡献(评估方案 A 代价)
// ============================================================
function renderEarlyWindowTable(trades: BacktestTrade[]): string {
    function minutesSinceOpen(ts: number): number {
        const dtf = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
        });
        const parts = dtf.formatToParts(new Date(ts));
        let h = 0, m = 0;
        for (const p of parts) {
            if (p.type === 'hour') h = Number(p.value);
            if (p.type === 'minute') m = Number(p.value);
        }
        const now = h * 60 + m;
        const open = 9 * 60 + 30;
        return now - open;
    }

    const early = trades.filter(t => minutesSinceOpen(t.entryTimestamp) < 15);
    const late = trades.filter(t => minutesSinceOpen(t.entryTimestamp) >= 15);
    const lines = [
        '| 区段 | trades | winRate | avgR | cumR | 占比 |',
        '|---|---|---|---|---|---|',
    ];
    const total = trades.length || 1;
    for (const [label, subset] of [['09:30–09:44', early], ['09:45–close', late]] as const) {
        const s = summarize(label, subset);
        lines.push(
            `| ${label} | ${s.trades} | ${pct(s.winRate)} | ${fmt(s.avgR, 4)} | ${fmt(s.cumR, 1)} | ${pct(subset.length / total)} |`
        );
    }
    return lines.join('\n');
}

// ============================================================
// 主
// ============================================================
function main() {
    const baseline = loadResult('baseline_loose_sl010');
    const recordOnly = loadResult('trend_recordonly_sl010');
    const trendOn = loadResult('trend_score60_sl010');
    const v2RecordOnly = loadResult('trend_v2_recordonly_sl010');
    const v2Score60 = loadResult('trend_v2_score60_sl010');
    const v2Tuned = loadResult('trend_v2_tuned_sl010');

    const sections: string[] = [];
    sections.push('# 趋势日 Detector 实验报告\n');
    sections.push(`生成时间:${new Date().toISOString()}\n`);
    sections.push('Spec: `docs/superpowers/specs/2026-04-14-trend-detector-design.md`\n');

    // 1. 主表
    sections.push('## 1. 主表(A + B)\n');
    const rows: Summary[] = [];
    if (baseline) rows.push(summarize('baseline_loose_sl010', baseline.trades));
    if (recordOnly) rows.push(summarize('trend_recordonly_sl010', recordOnly.trades));
    if (trendOn) rows.push(summarize('trend_score60_sl010', trendOn.trades));
    if (v2RecordOnly) rows.push(summarize('trend_v2_recordonly_sl010', v2RecordOnly.trades));
    if (v2Score60) rows.push(summarize('trend_v2_score60_sl010', v2Score60.trades));
    if (v2Tuned) rows.push(summarize('trend_v2_tuned_sl010', v2Tuned.trades));
    sections.push(renderSummaryTable(rows));
    sections.push('');
    sections.push('**成功标准**:`trend_score60_sl010` 的 cumR÷maxDD ≥ `baseline_loose_sl010` × 90%\n');

    // 2. 分数分组表
    sections.push('## 2. 分数分组(C)\n');
    if (recordOnly) {
        sections.push('**数据源**:`trend_recordonly_sl010`(门控关,所有信号都成交,记录分数)\n');
        sections.push(renderBucketTable(recordOnly.trades));
    } else {
        sections.push('(缺失 trend_recordonly_sl010.json)\n');
    }
    sections.push('');

    if (v2RecordOnly) {
        sections.push('### v2 分数分组(5 分钟窗口 + 新权重)\n');
        sections.push('**数据源**:`trend_v2_recordonly_sl010`\n');
        sections.push(renderBucketTable(v2RecordOnly.trades));
        sections.push('');
    }

    // 3. 09:30–09:44 时段贡献
    sections.push('## 3. 09:30–09:44 时段贡献(评估方案 A 禁开仓代价)\n');
    if (baseline) {
        sections.push('### baseline_loose_sl010\n');
        sections.push(renderEarlyWindowTable(baseline.trades));
    }
    sections.push('');
    if (recordOnly) {
        sections.push('### trend_recordonly_sl010\n');
        sections.push(renderEarlyWindowTable(recordOnly.trades));
    }
    sections.push('');

    fs.writeFileSync(REPORT_PATH, sections.join('\n'));
    console.log(`[reportTrend] 已写入 ${path.relative(process.cwd(), REPORT_PATH)}`);
}

main();

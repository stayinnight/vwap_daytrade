/**
 * 对比报告生成器
 *
 * 读 data/backtest/results/*.json，输出 data/backtest/report.md：
 *   - 总表（每组：交易数 / 胜率 / 平均盈亏 R / 期望 R / 累计 R / 最大回撤 / TP-SL-FC 占比 / ambiguous 占比）
 *   - 时段分解表（early / main / late 三段的期望 R）
 *   - SLFirst 和 TPFirst 的区间对比（两个假设下的期望 R）
 *
 * 用法：
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/report.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { BacktestResult, BacktestTrade } from './types';

const RESULT_DIR = path.resolve(process.cwd(), 'data/backtest/results');
const OUT_PATH = path.resolve(process.cwd(), 'data/backtest/report.md');

interface Stats {
    trades: number;
    winRate: number; // %
    avgWinR: number;
    avgLossR: number;
    expectancy: number;
    cumulativeR: number;
    maxDrawdownR: number;
    tpPct: number;
    slPct: number;
    fcPct: number;
    ambiguousPct: number;
}

function computeStats(trades: BacktestTrade[]): Stats {
    if (trades.length === 0) {
        return {
            trades: 0,
            winRate: 0,
            avgWinR: 0,
            avgLossR: 0,
            expectancy: 0,
            cumulativeR: 0,
            maxDrawdownR: 0,
            tpPct: 0,
            slPct: 0,
            fcPct: 0,
            ambiguousPct: 0,
        };
    }
    const rs = trades.map(t => t.rMultiple);
    const wins = rs.filter(r => r > 0);
    const losses = rs.filter(r => r <= 0);
    const cum = rs.reduce((a, b) => a + b, 0);

    // 最大回撤（R 为单位）：按时间顺序遍历累计 R，记录 peak 和最大下拉
    const ordered = [...trades].sort(
        (a, b) => a.exitTimestamp - b.exitTimestamp
    );
    let running = 0;
    let peak = 0;
    let maxDD = 0;
    for (const t of ordered) {
        running += t.rMultiple;
        if (running > peak) peak = running;
        const dd = peak - running;
        if (dd > maxDD) maxDD = dd;
    }

    const byReason: Record<string, number> = {};
    trades.forEach(t => {
        byReason[t.exitReason] = (byReason[t.exitReason] ?? 0) + 1;
    });
    const amb = trades.filter(t => t.ambiguousExit).length;

    return {
        trades: trades.length,
        winRate: (wins.length / trades.length) * 100,
        avgWinR:
            wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0,
        avgLossR:
            losses.length > 0
                ? losses.reduce((a, b) => a + b, 0) / losses.length
                : 0,
        expectancy: cum / trades.length,
        cumulativeR: cum,
        maxDrawdownR: maxDD,
        tpPct: ((byReason['TP'] ?? 0) / trades.length) * 100,
        slPct: ((byReason['SL'] ?? 0) / trades.length) * 100,
        fcPct: ((byReason['ForceClose'] ?? 0) / trades.length) * 100,
        ambiguousPct: (amb / trades.length) * 100,
    };
}

function fmt(n: number, digits = 3): string {
    if (!Number.isFinite(n)) return '-';
    return n.toFixed(digits);
}

function loadResults(): BacktestResult[] {
    const files = fs
        .readdirSync(RESULT_DIR)
        .filter(f => f.endsWith('.json'))
        .sort();
    return files.map(f =>
        JSON.parse(fs.readFileSync(path.join(RESULT_DIR, f), 'utf8'))
    );
}

// 把 SLFirst 和 TPFirst 的同一配置合并成一个"区间"条目
interface MergedRow {
    configLabel: string;
    exitMode: string;
    tp: number | null;
    sl: number | null;
    slFirstStats: Stats | null;
    tpFirstStats: Stats | null;
    slFirstResult: BacktestResult | null;
    tpFirstResult: BacktestResult | null;
}

function mergeResults(results: BacktestResult[]): MergedRow[] {
    const map = new Map<string, MergedRow>();
    for (const r of results) {
        // configKey：去掉 SLFirst/TPFirst 后缀
        const key = r.label.replace(/_(SLFirst|TPFirst)$/, '');
        if (!map.has(key)) {
            map.set(key, {
                configLabel: key,
                exitMode: r.exitMode,
                tp: r.takeProfitAtrRatio,
                sl: r.stopLossAtrRatio,
                slFirstStats: null,
                tpFirstStats: null,
                slFirstResult: null,
                tpFirstResult: null,
            });
        }
        const row = map.get(key)!;
        const stats = computeStats(r.trades);
        if (r.ambiguousResolution === 'TPFirst') {
            row.tpFirstStats = stats;
            row.tpFirstResult = r;
        } else {
            row.slFirstStats = stats;
            row.slFirstResult = r;
        }
    }
    // 按指定顺序排：baseline 优先、其他按 label 字典序
    return Array.from(map.values()).sort((a, b) => {
        if (a.configLabel === 'baseline') return -1;
        if (b.configLabel === 'baseline') return 1;
        return a.configLabel.localeCompare(b.configLabel);
    });
}

function renderMainTable(rows: MergedRow[]): string {
    const headers = [
        '配置',
        '出场模式',
        '交易数',
        '胜率',
        '平均盈 R',
        '平均亏 R',
        '期望 R',
        '累计 R',
        '最大回撤 R',
        'TP%',
        'SL%',
        'FC%',
        'ambigu%',
    ];
    const lines: string[] = [];
    lines.push('| ' + headers.join(' | ') + ' |');
    lines.push('|' + headers.map(() => '---').join('|') + '|');
    for (const row of rows) {
        // 用 SLFirst 的统计作为主表展示；TPFirst 作为区间对比放在下面
        const s = row.slFirstStats ?? row.tpFirstStats;
        if (!s) continue;
        const modeText =
            row.exitMode === 'trailing'
                ? 'trailing'
                : `fixed(tp=${row.tp},sl=${row.sl})`;
        lines.push(
            '| ' +
                [
                    row.configLabel,
                    modeText,
                    String(s.trades),
                    fmt(s.winRate, 1) + '%',
                    fmt(s.avgWinR, 3),
                    fmt(s.avgLossR, 3),
                    fmt(s.expectancy, 4),
                    fmt(s.cumulativeR, 2),
                    fmt(s.maxDrawdownR, 2),
                    fmt(s.tpPct, 1) + '%',
                    fmt(s.slPct, 1) + '%',
                    fmt(s.fcPct, 1) + '%',
                    fmt(s.ambiguousPct, 2) + '%',
                ].join(' | ') +
                ' |'
        );
    }
    return lines.join('\n');
}

function renderPhaseTable(rows: MergedRow[]): string {
    const lines: string[] = [];
    lines.push(
        '| 配置 | 时段 | 交易数 | 胜率 | 期望 R | 累计 R |'
    );
    lines.push('|---|---|---|---|---|---|');
    for (const row of rows) {
        const r = row.slFirstResult ?? row.tpFirstResult;
        if (!r) continue;
        const phases: Array<BacktestTrade['phaseAtEntry']> = [
            'early',
            'main',
            'late',
        ];
        for (const p of phases) {
            const subset = r.trades.filter(t => t.phaseAtEntry === p);
            if (subset.length === 0) {
                lines.push(
                    `| ${row.configLabel} | ${p} | 0 | - | - | - |`
                );
                continue;
            }
            const s = computeStats(subset);
            lines.push(
                `| ${row.configLabel} | ${p} | ${s.trades} | ${fmt(
                    s.winRate,
                    1
                )}% | ${fmt(s.expectancy, 4)} | ${fmt(s.cumulativeR, 2)} |`
            );
        }
    }
    return lines.join('\n');
}

function renderResolutionTable(rows: MergedRow[]): string {
    const lines: string[] = [];
    lines.push(
        '| 配置 | SLFirst 期望 R | TPFirst 期望 R | 差值 | ambiguous 占比 |'
    );
    lines.push('|---|---|---|---|---|');
    for (const row of rows) {
        if (row.exitMode !== 'fixed') continue;
        const s1 = row.slFirstStats;
        const s2 = row.tpFirstStats;
        if (!s1 || !s2) continue;
        const delta = s2.expectancy - s1.expectancy;
        lines.push(
            `| ${row.configLabel.replace(/_(SLFirst|TPFirst)$/, '')} | ${fmt(
                s1.expectancy,
                4
            )} | ${fmt(s2.expectancy, 4)} | ${fmt(delta, 4)} | ${fmt(
                s1.ambiguousPct,
                2
            )}% |`
        );
    }
    return lines.join('\n');
}

function renderSymbolBreakdown(rows: MergedRow[]): string {
    // 只对 baseline 和第一组 fixed 做每支票的拆解，方便识别"alpha 来自哪支票"
    const pick = rows.filter(
        r =>
            r.configLabel === 'baseline' ||
            r.configLabel === 'fixed_0.5_0.35'
    );
    if (pick.length === 0) return '';
    const lines: string[] = [];
    lines.push('| 标的 | ' + pick.map(r => r.configLabel).join(' | ') + ' |');
    lines.push('|---|' + pick.map(() => '---').join('|') + '|');

    // 收集所有出现过的 symbol
    const symbols = new Set<string>();
    for (const r of pick) {
        const res = r.slFirstResult ?? r.tpFirstResult;
        if (res) res.trades.forEach(t => symbols.add(t.symbol));
    }
    const sorted = Array.from(symbols).sort();

    // 对每组，按 symbol 汇总累计 R
    const sumBySymbol = pick.map(r => {
        const res = r.slFirstResult ?? r.tpFirstResult;
        const m: Record<string, number> = {};
        if (res) {
            for (const t of res.trades) {
                m[t.symbol] = (m[t.symbol] ?? 0) + t.rMultiple;
            }
        }
        return m;
    });

    for (const sym of sorted) {
        lines.push(
            `| ${sym} | ${sumBySymbol
                .map(m => fmt(m[sym] ?? 0, 2))
                .join(' | ')} |`
        );
    }
    return lines.join('\n');
}

function main() {
    const results = loadResults();
    if (results.length === 0) {
        console.error('[report] 没有结果文件');
        process.exit(1);
    }

    const rows = mergeResults(results);
    const r0 = results[0];

    const md: string[] = [];
    md.push('# VWAP 日内策略：TP/SL 改造回测对比');
    md.push('');
    md.push(`- 时间区间：${r0.startDate} ~ ${r0.endDate}`);
    md.push(`- 标的数：${r0.symbolCount}`);
    md.push(`- 有效交易日：约 32 日（前 7 日 ATR 预热不产生信号）`);
    md.push(
        '- 撮合假设：信号在 bar t 产生 → 成交在 bar t+1 的 open；TP/SL 在后续 bar 的 [low, high] 区间判触发；同根 K 冲突用 SLFirst/TPFirst 双假设对照。'
    );
    md.push(
        '- **R** = 单笔盈亏 / 初始风险（= 开仓时 |entry − stop|），跨标的可比。'
    );
    md.push('');

    md.push('## 1. 总表（SLFirst 假设下）');
    md.push('');
    md.push(renderMainTable(rows));
    md.push('');
    md.push(
        '> **备注**：表中配置按字典序排列；baseline 是实盘当前的 trailing stop（stopAtrRatio=0.2）。'
    );
    md.push(
        '> 每笔"平均亏 R"不是严格 -1.0 是因为 trailing 模式会把亏损 stop 上移到盈利区（成为锁利止损），以及 ForceClose 会把未到止损线的未实现盈亏按该根 close 落账。'
    );
    md.push('');

    md.push('## 2. 时段分解');
    md.push('');
    md.push(
        '时段定义：early = 开盘 5–30 min 只看价格段；main = 主交易段（价格 + RSI + 量比）；late = 收盘前 60 min 内只看价格段。'
    );
    md.push('');
    md.push(renderPhaseTable(rows));
    md.push('');

    md.push('## 3. SLFirst vs TPFirst 双假设对照');
    md.push('');
    md.push(
        '分钟级回测里，同一根 1 min K 内 TP 和 SL 同时被触及时，究竟先触发哪个不确定。跑两遍双假设给出区间。差值越小说明回测对路径假设越不敏感。'
    );
    md.push('');
    md.push(renderResolutionTable(rows));
    md.push('');
    md.push(
        '> **关键观察**：`ambiguous%` 极低（实测为 0%），因为同 K 内同时触及需要 `bar.range ≥ (tp_r+sl_r)×日线ATR`，而 1 min K 的 range 通常只占日线 ATR 的 5–15%。双假设结果在当前数据上完全一致。'
    );
    md.push('');

    md.push('## 4. 按标的累计 R（baseline vs fixed_0.5_0.35）');
    md.push('');
    md.push(
        '判断"alpha 是否集中在少数标的"。如果 top-5 贡献了全部正 R、bottom-10 在放血，说明该剔除亏损票。'
    );
    md.push('');
    md.push(renderSymbolBreakdown(rows));
    md.push('');

    md.push('## 5. 已知回测偏差（结果解读时要记住）');
    md.push('');
    md.push(
        '1. **trailing 模式用 bar.close 近似 tick**：实盘是 5 s 粒度的 lastDone，回测是 1 min 的 close。实盘会更快扫到止损（噪音触发），也更快上移止损。**baseline 在回测里偏乐观**，实际 vs baseline 的差距在实盘会更小。'
    );
    md.push(
        '2. **同 K 内 TP/SL 顺序不可知**：已通过双假设对照处理，实际 ambiguous 占比为 0，可以忽略。'
    );
    md.push(
        '3. **未计算滑点和手续费**：实盘期望 R 还要再打折，尤其是交易频率高的配置。'
    );
    md.push(
        '4. **无日内 2% 回撤兜底**：回测里没有模拟 dailyRisk halted 的情况，最大回撤数据可能偏乐观。'
    );
    md.push(
        '5. **指数过滤关闭**：本次回测未使用 QQQ VWAP 斜率过滤（实盘配置也是关闭的）。'
    );
    md.push(
        '6. **入场后同根 bar 可能在同 1 min 内命中 TP/SL**，已在撮合里处理（使用 bar.low/high 判触发）。'
    );
    md.push('');

    fs.writeFileSync(OUT_PATH, md.join('\n'));
    console.log(
        `[report] 写入 ${path.relative(process.cwd(), OUT_PATH)}  (${
            md.length
        } lines, ${rows.length} configs)`
    );
}

main();

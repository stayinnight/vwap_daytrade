/**
 * 按标的分析盈亏特征
 *
 * 从 baseline 回测结果 + 原始分钟 K 里，为每支票算出：
 *   - 行情特征：均价、日线 ATR、ATR%/价格、日 range、日均成交额
 *   - 策略特征：signalRate（46 支中的相对信号密度）、胜率、平均 R、trailing 锁利次数
 *   - **稳健性指标**：把 32 个交易日切两段，分别算累积 R —— 前后两段一致为正/负才算"结构性"
 *
 * 再用散点图式的排序展示，看：
 *   1) 哪些票前后两段都盈利（稳定赚钱）
 *   2) 哪些票前后两段都亏损（结构性亏损）
 *   3) 哪些票前后反复（信号是噪音）
 *
 * 最后尝试找出盈利票 vs 亏损票的特征差异：
 *   - ATR% 分布
 *   - 日均换手
 *   - 开盘 30 分钟 range / 全日 range 的比例（开盘波动占比）
 *   - 收盘 60 分钟 range / 全日 range 的比例
 *
 * 输出：data/backtest/symbol_analysis.md
 *
 * 用法：
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/analyzeSymbols.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { BacktestResult, SerializedBar, BacktestTrade } from './types';

const RAW_DIR = path.resolve(process.cwd(), 'data/backtest/raw');
const RESULT_DIR = path.resolve(process.cwd(), 'data/backtest/results');
const OUT_PATH = path.resolve(process.cwd(), 'data/backtest/symbol_analysis.md');

// ============ 行情特征 ============
interface PriceFeatures {
    symbol: string;
    avgClose: number;          // 均价
    avgDailyAtrPct: number;    // 日 ATR / 均价 × 100（波动百分比）
    avgDailyRangePct: number;  // 日 range / 均价 × 100
    avgDailyTurnover: number;  // 日均换手（turnover，美元）
    openWindowRangeShare: number;  // 开盘 30 min 的 range / 全日 range（开盘活跃度）
    closeWindowRangeShare: number; // 收盘 60 min 的 range / 全日 range
}

function computePriceFeatures(symbol: string): PriceFeatures {
    const raw = JSON.parse(
        fs.readFileSync(path.join(RAW_DIR, `${symbol}.json`), 'utf8')
    );
    const bars: SerializedBar[] = raw.bars;

    // 按 UTC 日分组（和 BacktestMarket 一致）
    const byDay: Record<string, SerializedBar[]> = {};
    for (const b of bars) {
        const k = new Date(b.timestamp).toISOString().slice(0, 10);
        (byDay[k] ??= []).push(b);
    }
    const days = Object.keys(byDay).sort();

    let sumClose = 0;
    let sumRange = 0;
    let sumRangePct = 0;
    let sumTurnover = 0;
    let sumOpenShare = 0;
    let sumCloseShare = 0;
    let n = 0;
    const dailyRanges: number[] = [];

    for (const key of days) {
        const dayBars = byDay[key];
        if (dayBars.length < 300) continue; // 不完整的日跳过

        const high = Math.max(...dayBars.map(b => b.high));
        const low = Math.min(...dayBars.map(b => b.low));
        const close = dayBars[dayBars.length - 1].close;
        const range = high - low;
        if (range <= 0 || close <= 0) continue;

        // 前 30 根 和 后 60 根（根数近似，不做 DST 精确对齐）
        const first30 = dayBars.slice(0, 30);
        const last60 = dayBars.slice(-60);
        const r30 =
            Math.max(...first30.map(b => b.high)) -
            Math.min(...first30.map(b => b.low));
        const r60 =
            Math.max(...last60.map(b => b.high)) -
            Math.min(...last60.map(b => b.low));

        sumClose += close;
        sumRange += range;
        sumRangePct += (range / close) * 100;
        sumTurnover += dayBars.reduce((a, b) => a + b.turnover, 0);
        sumOpenShare += r30 / range;
        sumCloseShare += r60 / range;
        dailyRanges.push(range);
        n++;
    }

    // 近似日 ATR = 日 range 的均值（简化，不做 True Range）
    const atr = dailyRanges.reduce((a, b) => a + b, 0) / Math.max(1, n);
    const avgClose = sumClose / Math.max(1, n);

    return {
        symbol,
        avgClose,
        avgDailyAtrPct: (atr / avgClose) * 100,
        avgDailyRangePct: sumRangePct / Math.max(1, n),
        avgDailyTurnover: sumTurnover / Math.max(1, n),
        openWindowRangeShare: sumOpenShare / Math.max(1, n),
        closeWindowRangeShare: sumCloseShare / Math.max(1, n),
    };
}

// ============ 策略特征 ============
interface StrategyFeatures {
    trades: number;
    winRate: number;
    avgR: number;
    cumR: number;
    maxR: number;
    minR: number;
    firstHalfR: number;  // 前 16 日
    secondHalfR: number; // 后 16 日
    stableWinner: boolean;  // 前后半段都 > 0
    stableLoser: boolean;   // 前后半段都 < 0
    flipped: boolean;       // 前后半段符号相反
    earlyR: number;
    mainR: number;
    lateR: number;
}

function computeStrategyFeatures(
    symbol: string,
    trades: BacktestTrade[]
): StrategyFeatures {
    const sym = trades.filter(t => t.symbol === symbol);
    if (sym.length === 0) {
        return {
            trades: 0, winRate: 0, avgR: 0, cumR: 0, maxR: 0, minR: 0,
            firstHalfR: 0, secondHalfR: 0,
            stableWinner: false, stableLoser: false, flipped: false,
            earlyR: 0, mainR: 0, lateR: 0,
        };
    }
    const rs = sym.map(t => t.rMultiple);
    const wins = rs.filter(r => r > 0).length;
    const cum = rs.reduce((a, b) => a + b, 0);

    // 前后两段切分（按 entryTimestamp 中位数）
    const sorted = [...sym].sort((a, b) => a.entryTimestamp - b.entryTimestamp);
    const mid = Math.floor(sorted.length / 2);
    const firstHalfR = sorted
        .slice(0, mid)
        .reduce((a, t) => a + t.rMultiple, 0);
    const secondHalfR = sorted
        .slice(mid)
        .reduce((a, t) => a + t.rMultiple, 0);
    const stableWinner = firstHalfR > 0 && secondHalfR > 0;
    const stableLoser = firstHalfR < 0 && secondHalfR < 0;
    const flipped =
        (firstHalfR > 0 && secondHalfR < 0) ||
        (firstHalfR < 0 && secondHalfR > 0);

    const phaseR = (p: BacktestTrade['phaseAtEntry']) =>
        sym.filter(t => t.phaseAtEntry === p).reduce((a, t) => a + t.rMultiple, 0);

    return {
        trades: sym.length,
        winRate: (wins / sym.length) * 100,
        avgR: cum / sym.length,
        cumR: cum,
        maxR: Math.max(...rs),
        minR: Math.min(...rs),
        firstHalfR,
        secondHalfR,
        stableWinner,
        stableLoser,
        flipped,
        earlyR: phaseR('early'),
        mainR: phaseR('main'),
        lateR: phaseR('late'),
    };
}

// ============ 分析 ============
function main() {
    const baseline: BacktestResult = JSON.parse(
        fs.readFileSync(path.join(RESULT_DIR, 'baseline.json'), 'utf8')
    );

    const symbols = Array.from(new Set(baseline.trades.map(t => t.symbol))).sort();
    const rows = symbols.map(s => {
        const pf = computePriceFeatures(s);
        const sf = computeStrategyFeatures(s, baseline.trades);
        return { ...pf, ...sf };
    });

    // 按 cumR 排序，分三档
    const winners = rows.filter(r => r.cumR > 3).sort((a, b) => b.cumR - a.cumR);
    const losers = rows.filter(r => r.cumR < -5).sort((a, b) => a.cumR - b.cumR);
    const mid = rows
        .filter(r => r.cumR >= -5 && r.cumR <= 3)
        .sort((a, b) => b.cumR - a.cumR);

    // 稳健性：前后两段一致的"真赢家"/"真输家"
    const stableWinners = rows.filter(r => r.stableWinner && r.cumR > 0);
    const stableLosers = rows.filter(r => r.stableLoser && r.cumR < 0);
    const flippers = rows.filter(r => r.flipped);

    // 特征均值对比
    function avg(list: typeof rows, key: keyof (typeof rows)[0]): number {
        if (list.length === 0) return 0;
        const s = list.reduce((a, r) => a + (r[key] as number), 0);
        return s / list.length;
    }

    const lines: string[] = [];
    const push = (s: string) => lines.push(s);

    push('# 标的盈亏特征分析（基于 baseline 回测）');
    push('');
    push(`- 样本：${rows.length} 支票 × 32 交易日 × baseline trailing`);
    push('- 稳定赢家 = 前 16 日和后 16 日累积 R 都 > 0');
    push('- 稳定输家 = 前 16 日和后 16 日累积 R 都 < 0');
    push('- 翻盘 = 前后半段符号相反（样本不足/信号随机）');
    push('');

    push('## 1. 三类标的的稳健性分布');
    push('');
    push(
        `| 类别 | 数量 | 总累积 R | 平均每票 R |`
    );
    push('|---|---|---|---|');
    const sumR = (list: typeof rows) =>
        list.reduce((a, r) => a + r.cumR, 0);
    push(
        `| 稳定赢家 | ${stableWinners.length} | ${sumR(stableWinners).toFixed(
            2
        )} | ${(sumR(stableWinners) / Math.max(1, stableWinners.length)).toFixed(2)} |`
    );
    push(
        `| 稳定输家 | ${stableLosers.length} | ${sumR(stableLosers).toFixed(
            2
        )} | ${(sumR(stableLosers) / Math.max(1, stableLosers.length)).toFixed(2)} |`
    );
    push(
        `| 翻盘 | ${flippers.length} | ${sumR(flippers).toFixed(2)} | ${(
            sumR(flippers) / Math.max(1, flippers.length)
        ).toFixed(2)} |`
    );
    push(
        `| 其他（接近 0） | ${
            rows.length - stableWinners.length - stableLosers.length - flippers.length
        } | - | - |`
    );
    push('');

    push('## 2. 特征均值对比：稳定赢家 vs 稳定输家');
    push('');
    push(
        `| 特征 | 稳定赢家 (${stableWinners.length}) | 稳定输家 (${stableLosers.length}) | 差值 |`
    );
    push('|---|---|---|---|');
    const cmpFeatures: Array<{ label: string; key: keyof (typeof rows)[0]; digits: number; unit?: string }> = [
        { label: '均价', key: 'avgClose', digits: 2, unit: '$' },
        { label: '日波动 ATR%', key: 'avgDailyAtrPct', digits: 2, unit: '%' },
        { label: '日 range%', key: 'avgDailyRangePct', digits: 2, unit: '%' },
        { label: '日均换手', key: 'avgDailyTurnover', digits: 0, unit: '$' },
        { label: '开盘 30min range 占比', key: 'openWindowRangeShare', digits: 3, unit: '' },
        { label: '收盘 60min range 占比', key: 'closeWindowRangeShare', digits: 3, unit: '' },
        { label: '信号数/票', key: 'trades', digits: 0, unit: '' },
        { label: '胜率%', key: 'winRate', digits: 1, unit: '%' },
        { label: '最大 R', key: 'maxR', digits: 2, unit: '' },
        { label: '最小 R', key: 'minR', digits: 2, unit: '' },
        { label: 'early 段 R', key: 'earlyR', digits: 2, unit: '' },
        { label: 'main 段 R', key: 'mainR', digits: 2, unit: '' },
        { label: 'late 段 R', key: 'lateR', digits: 2, unit: '' },
    ];
    for (const c of cmpFeatures) {
        const aw = avg(stableWinners, c.key);
        const al = avg(stableLosers, c.key);
        const fmtNum = (n: number) => {
            if (c.unit === '$' && c.digits === 0) {
                return '$' + Math.round(n).toLocaleString();
            }
            if (c.unit === '$') return '$' + n.toFixed(c.digits);
            if (c.unit === '%') return n.toFixed(c.digits) + '%';
            return n.toFixed(c.digits);
        };
        const dPct = al !== 0 ? ((aw - al) / Math.abs(al)) * 100 : 0;
        push(
            `| ${c.label} | ${fmtNum(aw)} | ${fmtNum(al)} | ${
                aw > al ? '+' : ''
            }${(aw - al).toFixed(c.digits)} (${dPct >= 0 ? '+' : ''}${dPct.toFixed(0)}%) |`
        );
    }
    push('');

    push('## 3. 稳定赢家名单（前后两段都盈利）');
    push('');
    push(
        '| 标的 | cumR | 前16日 | 后16日 | 胜率 | 日ATR% | 日均换手 | early | main | late |'
    );
    push('|---|---|---|---|---|---|---|---|---|---|');
    for (const r of stableWinners.sort((a, b) => b.cumR - a.cumR)) {
        push(
            `| ${r.symbol} | ${r.cumR.toFixed(2)} | ${r.firstHalfR.toFixed(
                1
            )} | ${r.secondHalfR.toFixed(1)} | ${r.winRate.toFixed(
                1
            )}% | ${r.avgDailyAtrPct.toFixed(2)}% | $${Math.round(
                r.avgDailyTurnover / 1e6
            )}M | ${r.earlyR.toFixed(1)} | ${r.mainR.toFixed(
                1
            )} | ${r.lateR.toFixed(1)} |`
        );
    }
    push('');

    push('## 4. 稳定输家名单（前后两段都亏损）');
    push('');
    push(
        '| 标的 | cumR | 前16日 | 后16日 | 胜率 | 日ATR% | 日均换手 | early | main | late |'
    );
    push('|---|---|---|---|---|---|---|---|---|---|');
    for (const r of stableLosers.sort((a, b) => a.cumR - b.cumR)) {
        push(
            `| ${r.symbol} | ${r.cumR.toFixed(2)} | ${r.firstHalfR.toFixed(
                1
            )} | ${r.secondHalfR.toFixed(1)} | ${r.winRate.toFixed(
                1
            )}% | ${r.avgDailyAtrPct.toFixed(2)}% | $${Math.round(
                r.avgDailyTurnover / 1e6
            )}M | ${r.earlyR.toFixed(1)} | ${r.mainR.toFixed(
                1
            )} | ${r.lateR.toFixed(1)} |`
        );
    }
    push('');

    push('## 5. 翻盘标的名单（前后两段符号相反 —— 样本不够稳定）');
    push('');
    push('| 标的 | cumR | 前16日 | 后16日 | 备注 |');
    push('|---|---|---|---|---|');
    for (const r of flippers.sort((a, b) => b.cumR - a.cumR)) {
        const flavor = r.firstHalfR > 0 ? '先盈后亏' : '先亏后盈';
        push(
            `| ${r.symbol} | ${r.cumR.toFixed(2)} | ${r.firstHalfR.toFixed(
                1
            )} | ${r.secondHalfR.toFixed(1)} | ${flavor} |`
        );
    }
    push('');

    push('## 6. 全部标的一览（按 cumR 降序）');
    push('');
    push(
        '| 标的 | cumR | 稳定性 | 胜率 | 日ATR% | 日均换手 | 均价 | 信号数 |'
    );
    push('|---|---|---|---|---|---|---|---|');
    const sorted = [...rows].sort((a, b) => b.cumR - a.cumR);
    for (const r of sorted) {
        const tag = r.stableWinner
            ? '✅赢家'
            : r.stableLoser
            ? '❌输家'
            : r.flipped
            ? '🔄翻盘'
            : '➖中性';
        push(
            `| ${r.symbol} | ${r.cumR.toFixed(2)} | ${tag} | ${r.winRate.toFixed(
                1
            )}% | ${r.avgDailyAtrPct.toFixed(2)}% | $${Math.round(
                r.avgDailyTurnover / 1e6
            )}M | $${r.avgClose.toFixed(0)} | ${r.trades} |`
        );
    }
    push('');

    fs.writeFileSync(OUT_PATH, lines.join('\n'));
    console.log(
        `[analyze] 写入 ${path.relative(process.cwd(), OUT_PATH)}  (${
            lines.length
        } lines)`
    );

    // 再控制台打印一个简报
    console.log(
        `\n稳定赢家 ${stableWinners.length} 支 合计 ${sumR(stableWinners).toFixed(2)}R`
    );
    console.log(
        `稳定输家 ${stableLosers.length} 支 合计 ${sumR(stableLosers).toFixed(2)}R`
    );
    console.log(
        `翻盘     ${flippers.length} 支 合计 ${sumR(flippers).toFixed(2)}R`
    );
    console.log(
        `中性     ${
            rows.length - stableWinners.length - stableLosers.length - flippers.length
        } 支`
    );
}

main();

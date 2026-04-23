/**
 * B2-lite bad_case 复盘：对比 CRDO / INTC / MRVL 在 baseline vs 最优配置下
 * 每个交易日的 trade 数 / cumR，挑震荡日确认过滤效果。
 *
 * 跑法:
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/inspectBadCase.ts <bestLabel>
 */
import * as fs from 'fs';
import * as path from 'path';
import { BacktestResult, BacktestTrade } from './types';

const SYMBOLS = ['CRDO.US', 'INTC.US', 'MRVL.US'];

const label = process.argv[2];
if (!label) {
  console.error('Usage: inspectBadCase.ts <bestLabel>');
  process.exit(1);
}

function load(name: string): BacktestResult {
  return JSON.parse(
    fs.readFileSync(
      path.resolve(process.cwd(), `data/backtest/results/${name}.json`),
      'utf8'
    )
  );
}
const baseline = load('chop_baseline');
const candidate = load(label);

function dayKey(ts: number) {
  return new Date(ts).toISOString().slice(0, 10);
}

interface DayStat {
  day: string;
  trades: number;
  cumR: number;
}

function aggBySymDay(trades: BacktestTrade[], sym: string): DayStat[] {
  const m: Record<string, DayStat> = {};
  for (const t of trades) {
    if (t.symbol !== sym) continue;
    const k = dayKey(t.entryTimestamp);
    m[k] ??= { day: k, trades: 0, cumR: 0 };
    m[k].trades++;
    m[k].cumR += t.rMultiple;
  }
  return Object.values(m).sort((a, b) => a.day.localeCompare(b.day));
}

for (const sym of SYMBOLS) {
  console.log(`\n=== ${sym} ===`);
  const base = aggBySymDay(baseline.trades, sym);
  const cand = aggBySymDay(candidate.trades, sym);
  const candMap = Object.fromEntries(cand.map((d) => [d.day, d]));

  const bad = base.filter((d) => d.trades >= 3);
  console.log(`  疑似震荡日（baseline trades >= 3）: ${bad.length} 天`);
  console.log(
    `  | 日期 | base trades | base cumR | cand trades | cand cumR | 减少 |`
  );
  console.log(`  |---|---|---|---|---|---|`);
  for (const d of bad) {
    const c = candMap[d.day] ?? { trades: 0, cumR: 0 };
    const reduce = d.trades - c.trades;
    console.log(
      `  | ${d.day} | ${d.trades} | ${d.cumR.toFixed(2)} | ${
        c.trades
      } | ${c.cumR.toFixed(2)} | -${reduce} |`
    );
  }

  const baseSum = base.reduce(
    (s, d) => ({ trades: s.trades + d.trades, cumR: s.cumR + d.cumR }),
    { trades: 0, cumR: 0 }
  );
  const candSum = cand.reduce(
    (s, d) => ({ trades: s.trades + d.trades, cumR: s.cumR + d.cumR }),
    { trades: 0, cumR: 0 }
  );
  console.log(
    `  total: base trades=${baseSum.trades} cumR=${baseSum.cumR.toFixed(
      2
    )} | cand trades=${candSum.trades} cumR=${candSum.cumR.toFixed(2)}`
  );
}

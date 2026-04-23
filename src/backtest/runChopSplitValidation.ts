/**
 * B2-lite 候选配置的分段验证（防过拟合）。
 *
 * 拿 Task 7 的最优配置回测结果，按 entryTimestamp 切前后两半，
 * 分别算 per-trade R / 胜率 / cumR，对比"前半段调参 vs 后半段验证"。
 *
 * 跑法:
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/runChopSplitValidation.ts <bestLabel>
 *   例：
 *     npx ts-node ... src/backtest/runChopSplitValidation.ts chop_W30_T25
 */
import * as fs from 'fs';
import * as path from 'path';
import { BacktestResult, BacktestTrade } from './types';

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function stat(name: string, trades: BacktestTrade[]) {
  const rs = trades.map((t) => t.rMultiple);
  const wins = rs.filter((r) => r > 0).length;
  return {
    name,
    n: trades.length,
    cumR: rs.reduce((s, r) => s + r, 0),
    winRate: trades.length > 0 ? wins / trades.length : 0,
    avgR: trades.length > 0 ? rs.reduce((s, r) => s + r, 0) / trades.length : 0,
    medianR: median(rs),
  };
}

const label = process.argv[2];
if (!label) {
  console.error(
    'Usage: runChopSplitValidation.ts <label>  (e.g. chop_W30_T25)'
  );
  process.exit(1);
}

const candidatePath = path.resolve(
  process.cwd(),
  `data/backtest/results/${label}.json`
);
const baselinePath = path.resolve(
  process.cwd(),
  `data/backtest/results/chop_baseline.json`
);
if (!fs.existsSync(candidatePath)) {
  console.error(`missing ${candidatePath}, run runChopExperiment.ts first`);
  process.exit(1);
}

const candidate: BacktestResult = JSON.parse(
  fs.readFileSync(candidatePath, 'utf8')
);
const baseline: BacktestResult = JSON.parse(
  fs.readFileSync(baselinePath, 'utf8')
);

// 找时间中点（用 candidate 的 trade 时间分布算）
const allTs = candidate.trades
  .map((t) => t.entryTimestamp)
  .sort((a, b) => a - b);
if (allTs.length === 0) {
  console.error('candidate has no trades, abort');
  process.exit(1);
}
const midTs = allTs[Math.floor(allTs.length / 2)];
console.log(`分段中点: ${new Date(midTs).toISOString().slice(0, 10)}`);

const splitFront = (trades: BacktestTrade[]) =>
  trades.filter((t) => t.entryTimestamp < midTs);
const splitBack = (trades: BacktestTrade[]) =>
  trades.filter((t) => t.entryTimestamp >= midTs);

const baseFront = stat('baseline-front', splitFront(baseline.trades));
const baseBack = stat('baseline-back', splitBack(baseline.trades));
const candFront = stat(`${label}-front`, splitFront(candidate.trades));
const candBack = stat(`${label}-back`, splitBack(candidate.trades));

const rows = [baseFront, baseBack, candFront, candBack];
console.log('\n| 分段 | trades | cumR | 胜率 | 平均R | 中位R |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(
    `| ${r.name} | ${r.n} | ${r.cumR.toFixed(1)} | ${(r.winRate * 100).toFixed(
      1
    )}% | ${r.avgR.toFixed(3)} | ${r.medianR.toFixed(3)} |`
  );
}

// 过拟合判定：候选配置在前后段的 avgR 提升幅度对比
const gainFront = candFront.avgR - baseFront.avgR;
const gainBack = candBack.avgR - baseBack.avgR;
console.log(`\n前段 avgR 提升: ${gainFront.toFixed(4)}`);
console.log(`后段 avgR 提升: ${gainBack.toFixed(4)}`);
if (gainFront > 0 && gainBack < gainFront / 2) {
  console.log(
    `\n⚠️  过拟合警告：后段提升 < 前段一半。建议回设计阶段降复杂度。`
  );
} else if (gainBack > 0) {
  console.log(`\n✅  分段验证通过：候选配置在后段仍有正提升。`);
} else {
  console.log(`\n❌  后段无正提升：候选配置不可上线。`);
}

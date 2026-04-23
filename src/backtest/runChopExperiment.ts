/**
 * B2-lite 二维网格回测：3 windows × 5 thresholds + 1 baseline = 16 次。
 *
 * 跑法:
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/runChopExperiment.ts
 *
 * 输出:
 *   - 16 个 result json 在 data/backtest/results/chop_W{window}_T{threshold}.json
 *     (baseline 文件名 chop_baseline.json)
 *   - 控制台打印 5 张 3×5 热力表（trades / cumR / 胜率 / 平均R / 中位R）
 *   - 摘要 markdown 写到 data/backtest/results/chop_experiment_summary.md
 */
import * as fs from 'fs';
import * as path from 'path';
import { runBacktest, RunnerOptions } from './runner';
import { BacktestTrade } from './types';

const RESULT_DIR = path.resolve(process.cwd(), 'data/backtest/results');

const WINDOWS = [30, 20, 15];
const THRESHOLDS = [15, 20, 25, 30, 35];

interface Stat {
  label: string;
  window: number | null; // null = baseline
  threshold: number | null;
  trades: number;
  cumR: number;
  winRate: number;
  avgR: number;
  medianR: number;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function stat(
  label: string,
  window: number | null,
  threshold: number | null,
  trades: BacktestTrade[],
): Stat {
  const rs = trades.map(t => t.rMultiple);
  const wins = rs.filter(r => r > 0).length;
  return {
    label,
    window,
    threshold,
    trades: trades.length,
    cumR: rs.reduce((s, r) => s + r, 0),
    winRate: trades.length > 0 ? wins / trades.length : 0,
    avgR: trades.length > 0 ? rs.reduce((s, r) => s + r, 0) / trades.length : 0,
    medianR: median(rs),
  };
}

async function main() {
  const stats: Stat[] = [];
  const t0 = Date.now();

  // Baseline
  console.log('\n=== Running baseline (enableChoppiness=false) ===');
  const baselineOpts: RunnerOptions = {
    label: 'chop_baseline',
    exitMode: 'trailing',
    filters: { enableChoppiness: false },
  };
  const baselineResult = await runBacktest(baselineOpts);
  stats.push(stat('baseline', null, null, baselineResult.trades));

  // 二维网格
  for (const w of WINDOWS) {
    for (const t of THRESHOLDS) {
      const label = `chop_W${w}_T${t}`;
      console.log(`\n=== Running ${label} (elapsed ${Math.round((Date.now() - t0) / 1000)}s) ===`);
      const opts: RunnerOptions = {
        label,
        exitMode: 'trailing',
        filters: { enableChoppiness: true },
        chopWindowBars: w,
        chopScoreThreshold: t,
      };
      const result = await runBacktest(opts);
      stats.push(stat(label, w, t, result.trades));
    }
  }

  // ====== 输出热力表 ======
  function buildHeatmap(
    title: string,
    getValue: (s: Stat) => number,
    format: (v: number) => string,
  ): string {
    let out = `\n### ${title}\n\n`;
    out += '| W \\ T | ' + THRESHOLDS.map(t => `**${t}**`).join(' | ') + ' |\n';
    out += '|---' + '|---'.repeat(THRESHOLDS.length) + '|\n';
    for (const w of WINDOWS) {
      const row: string[] = [`**${w}**`];
      for (const t of THRESHOLDS) {
        const s = stats.find(s => s.window === w && s.threshold === t)!;
        row.push(format(getValue(s)));
      }
      out += '| ' + row.join(' | ') + ' |\n';
    }
    const b = stats.find(s => s.label === 'baseline')!;
    out += `\n_Baseline: ${format(getValue(b))}_\n`;
    return out;
  }

  let report = `# B2-lite 二维网格回测报告\n\n`;
  report += `日期: ${new Date().toISOString().slice(0, 10)}\n\n`;
  report += `回测周期: ${baselineResult.startDate} → ${baselineResult.endDate}\n`;
  report += `标的数: ${baselineResult.symbolCount}\n`;
  report += `总耗时: ${Math.round((Date.now() - t0) / 1000)}s\n\n`;
  report += `---\n`;

  report += buildHeatmap('总交易数', s => s.trades, v => v.toFixed(0));
  report += buildHeatmap('cumR (总 R 数)', s => s.cumR, v => v.toFixed(1));
  report += buildHeatmap('胜率', s => s.winRate, v => (v * 100).toFixed(1) + '%');
  report += buildHeatmap('平均 R / trade', s => s.avgR, v => v.toFixed(3));
  report += buildHeatmap('中位 R / trade', s => s.medianR, v => v.toFixed(3));

  // 找候选最优（per-trade R 优先，cumR 跌幅 < 20%）
  report += `\n---\n\n## 候选最优配置\n\n`;
  report += `按 spec 评估口径：per-trade R / 胜率优先，cumR 跌幅 < 20%。\n\n`;
  const baseline = stats.find(s => s.label === 'baseline')!;
  const candidates = stats
    .filter(s => s.label !== 'baseline')
    .filter(s => baseline.cumR === 0 || s.cumR >= baseline.cumR * 0.8)
    .sort((a, b) => b.avgR - a.avgR);
  report += `\n通过 cumR 门槛的配置（按 avgR 降序）:\n\n`;
  report += `| 配置 | trades | cumR | cumR% | 胜率 | 平均R | 中位R |\n`;
  report += `|---|---|---|---|---|---|---|\n`;
  for (const s of candidates.slice(0, 5)) {
    const cumPct =
      baseline.cumR !== 0
        ? ((s.cumR / baseline.cumR) * 100).toFixed(1) + '%'
        : 'N/A';
    report += `| ${s.label} | ${s.trades} | ${s.cumR.toFixed(1)} | ${cumPct} | ${(s.winRate * 100).toFixed(1)}% | ${s.avgR.toFixed(3)} | ${s.medianR.toFixed(3)} |\n`;
  }

  const outPath = path.join(RESULT_DIR, 'chop_experiment_summary.md');
  fs.writeFileSync(outPath, report);
  console.log('\n\n' + report);
  console.log(
    `\n[chop-experiment] 报告写入 ${path.relative(process.cwd(), outPath)}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });

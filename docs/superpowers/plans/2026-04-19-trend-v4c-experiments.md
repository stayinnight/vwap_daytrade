# Trend Detector v4c 调参实验实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `runner.ts` 加两个 flag（`--disable-trend-ind`、`--ind11-mode`），给 `trendDetector.ts` 加一组 setter + 指标十一的 mode 分支，然后按 spec 分阶段跑 6~11 组一年回测，出对比表决定最终配置。spec: `docs/superpowers/specs/2026-04-19-trend-v4c-experiments-design.md`。

**Architecture:** 在 `trendDetector.ts` 暴露 3 个 setter（`setTrendIndicator9Enabled` / `setTrendIndicator10Enabled` / `setTrendIndicator11Mode`），默认值保持当前行为（全开、forward 方向）。runner 在每次 `runBacktest` 顶部按 CLI flag 调 setter；底部按现有 `savedXxx` 恢复模式恢复到默认。实验脚本用 shell，汇总用 inline node。

**Tech Stack:** TypeScript、无新增依赖、手写 node 脚本汇总结果。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/core/trendDetector.ts` | 修改 | 加 module-level mode 变量 + 3 个 setter + 指标九/十 enabled 守卫 + 指标十一 mode 分支 |
| `src/backtest/runner.ts` | 修改 | parse 2 个新 flag → 调 setter → 顶部 save default / 底部 restore |
| `src/backtest/smokeTrendDetector.ts` | 修改 | 加 2 个新 case：指标禁用 + 指标十一 reverse 模式 |
| `docs/superpowers/plans/2026-04-19-trend-v4c-experiments.md` | 新建（本文件） | — |
| `references/TREND.md` | 实验后更新 | 性能表 + v4c 变化说明 |

---

## Task 1：给 `trendDetector.ts` 加 module-level mode 变量和 setter

**Files:**
- Modify: `src/core/trendDetector.ts`（在现有阈值常量块之后、`scoreTrendDay` 之前）

目标：引入可变状态 + setter 接口，**不改变默认行为**（默认全开、forward）。

- [ ] **Step 1: 在现有阈值常量块之后添加 mode 变量和反向/区间阈值常量**

在 `src/core/trendDetector.ts` 第 45 行（`const PREV_RANGE_PCT_AVG_TIERS = [...];` 之后）插入：

```ts
// ====== v4c 调参实验用的动态开关(默认保持生产行为) ======

/** 指标九(今日开盘 Range%)是否启用 */
let IND9_ENABLED = true;
/** 指标十(昨日 Range%)是否启用 */
let IND10_ENABLED = true;

/** 指标十一模式:forward = 高波动给分(当前),reverse = 低波动给分,range = 区间给分,off = 禁用 */
export type Ind11Mode = 'forward' | 'reverse' | 'range' | 'off';
let IND11_MODE: Ind11Mode = 'forward';

// 指标十一反向:prevRangePctAvg7 < 阈值给分(低波动更优)
const PREV_RANGE_PCT_AVG_REVERSE_TIERS = [
    { pct: 0.025, score: 10 },
];
// 指标十一区间:prevRangePctAvg7 ∈ [min, max) 给分(排除极端)
const PREV_RANGE_PCT_AVG_RANGE_TIER = { min: 0.010, max: 0.050, score: 10 };

// ====== Setters(runner 用于覆盖默认行为,每次 runBacktest 结束恢复默认) ======

export function setTrendIndicator9Enabled(enabled: boolean): void {
    IND9_ENABLED = enabled;
}
export function setTrendIndicator10Enabled(enabled: boolean): void {
    IND10_ENABLED = enabled;
}
export function setTrendIndicator11Mode(mode: Ind11Mode): void {
    IND11_MODE = mode;
}
/** 一次性恢复所有实验覆盖,供 runner finally 调用 */
export function resetTrendExperimentFlags(): void {
    IND9_ENABLED = true;
    IND10_ENABLED = true;
    IND11_MODE = 'forward';
}
```

- [ ] **Step 2: 改指标九段落 —— 加 `IND9_ENABLED` 守卫**

修改 `src/core/trendDetector.ts` 第 342-353 行（指标九段落）：

```ts
    // ====== 指标九:Today Opening Range% ======
    // (highMax - lowMin) 已在指标五里算好,window[0].open 已在开头拿到
    const todayRangePctValue = window[0].open > 0
        ? (highMax - lowMin) / window[0].open
        : 0;
    let todayRangePct = 0;
    if (IND9_ENABLED) {
        for (const tier of TODAY_RANGE_PCT_TIERS) {
            if (todayRangePctValue > tier.pct) {
                todayRangePct = tier.score;
                break;
            }
        }
    }
```

注意：`todayRangePctValue` **无论 enabled 与否都要算**,因为 details 里要输出诊断值。

- [ ] **Step 3: 改指标十段落 —— 加 `IND10_ENABLED` 守卫**

修改 `src/core/trendDetector.ts` 第 355-365 行（指标十段落）：

```ts
    // ====== 指标十:Prior Day Range% (排除 gap) ======
    const priorDayRangePctValue = baseline.prevClose > 0
        ? (baseline.prevDayOHLC.high - baseline.prevDayOHLC.low) / baseline.prevClose
        : 0;
    let priorDayRangePct = 0;
    if (IND10_ENABLED) {
        for (const tier of PRIOR_DAY_RANGE_PCT_TIERS) {
            if (priorDayRangePctValue > tier.pct) {
                priorDayRangePct = tier.score;
                break;
            }
        }
    }
```

- [ ] **Step 4: 改指标十一段落 —— 加 mode 分支**

修改 `src/core/trendDetector.ts` 第 367-375 行（指标十一段落）：

```ts
    // ====== 指标十一:Prev Range% Avg (TREND_RANGE_PCT_AVG_LOOKBACK 天均值) ======
    const prevRangePctAvg7Value = baseline.prevRangePctAvg7;
    let prevRangePctAvg7 = 0;
    if (IND11_MODE === 'forward') {
        for (const tier of PREV_RANGE_PCT_AVG_TIERS) {
            if (prevRangePctAvg7Value > tier.pct) {
                prevRangePctAvg7 = tier.score;
                break;
            }
        }
    } else if (IND11_MODE === 'reverse') {
        for (const tier of PREV_RANGE_PCT_AVG_REVERSE_TIERS) {
            if (prevRangePctAvg7Value < tier.pct) {
                prevRangePctAvg7 = tier.score;
                break;
            }
        }
    } else if (IND11_MODE === 'range') {
        const r = PREV_RANGE_PCT_AVG_RANGE_TIER;
        if (prevRangePctAvg7Value >= r.min && prevRangePctAvg7Value < r.max) {
            prevRangePctAvg7 = r.score;
        }
    }
    // IND11_MODE === 'off' 时 prevRangePctAvg7 保持 0
```

- [ ] **Step 5: 编译**

Run: `npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 6: 跑现有 smoke 确认默认行为不变**

Run:
```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/smokeTrendDetector.ts
```

Expected: `✅ trendDetector smoke all pass`（现有 6 cases 全绿 —— 默认 forward 模式行为完全一致）。

- [ ] **Step 7: 提交**

```bash
git add src/core/trendDetector.ts
git commit -m "$(cat <<'EOF'
feat(trend): add experiment flags for v4c indicator 9/10/11 tuning

- IND9_ENABLED / IND10_ENABLED toggle indicators 9 and 10
- IND11_MODE: forward (current) / reverse / range / off
- Defaults preserve v4c production behavior
- Exposes setters + resetTrendExperimentFlags for runner use

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2：给 smoke 加两个新 case 覆盖 disabled / reverse 模式

**Files:**
- Modify: `src/backtest/smokeTrendDetector.ts`

Task 1 没改默认行为就不能验证新 setter 实际生效。这一步补齐。

- [ ] **Step 1: 先读 smoke 文件头部找到 import 段**

Read `src/backtest/smokeTrendDetector.ts` 第 1-20 行。

- [ ] **Step 2: 扩 import**

在 `src/backtest/smokeTrendDetector.ts` 的 `from '../core/trendDetector'` 这一行中追加三个 export：

```ts
import {
    scoreTrendDay,
    precomputeTrendBaselinesForSymbol,
    scoreCandleShape,
    OPENING_SHAPE_THRESHOLDS,
    PRIOR_DAY_SHAPE_THRESHOLDS,
    TrendBaseline,
    setTrendIndicator9Enabled,
    setTrendIndicator10Enabled,
    setTrendIndicator11Mode,
    resetTrendExperimentFlags,
} from '../core/trendDetector';
```

（如果 import 列表和上面有偏差,保留现有的、只加后 4 个。）

- [ ] **Step 3: 在文件末尾 `✅ trendDetector smoke all pass` 之前添加 Case 7 和 Case 8**

找到 `console.log('\n✅ trendDetector smoke all pass');`，在它之前插入：

```ts
// ============================================================
// Case 7: indicator 9/10 disabled via setter
// 用 Case 1 同样的输入,但禁用指标九和十 -> total 130 应该掉到 110
// ============================================================
{
    console.log('Running case 7: indicators 9/10 disabled');
    setTrendIndicator9Enabled(false);
    setTrendIndicator10Enabled(false);
    try {
        const window = [
            { open: 102.5, close: 102.8, high: 103.0, low: 102.3, volume: 2500, turnover: 256250, timestamp: 0, tradeSession: 'Normal' },
            { open: 102.8, close: 103.1, high: 103.3, low: 102.6, volume: 2500, turnover: 257500, timestamp: 60000, tradeSession: 'Normal' },
            { open: 103.1, close: 103.4, high: 103.6, low: 102.9, volume: 2500, turnover: 258750, timestamp: 120000, tradeSession: 'Normal' },
            { open: 103.4, close: 103.7, high: 103.9, low: 103.2, volume: 2500, turnover: 260000, timestamp: 180000, tradeSession: 'Normal' },
            { open: 103.7, close: 104.0, high: 104.4, low: 103.5, volume: 2500, turnover: 261250, timestamp: 240000, tradeSession: 'Normal' },
        ];
        const baseline: TrendBaseline = {
            prevClose: 100,
            prevAtr: 4,
            prevAtrShort: 4,
            rvolBaseline: 3000,
            prevDayOHLC: { open: 98, high: 101, low: 97, close: 100 },
            prevRangePctAvg7: 0.04,
        };
        const score = scoreTrendDay(window, baseline);
        assert(score !== null, 'case7: score should not be null');
        assert(score!.todayRangePct === 0, `case7 ind9 disabled expected 0, got ${score!.todayRangePct}`);
        assert(score!.priorDayRangePct === 0, `case7 ind10 disabled expected 0, got ${score!.priorDayRangePct}`);
        assert(score!.prevRangePctAvg7 === 10, `case7 ind11 (forward default) expected 10, got ${score!.prevRangePctAvg7}`);
        // 诊断值还应该算出来(即便没评分)
        assert(score!.details.todayRangePctValue > 0, 'case7 todayRangePctValue should still be computed');
        assert(score!.details.priorDayRangePctValue > 0, 'case7 priorDayRangePctValue should still be computed');
        assert(score!.total === 110, `case7 total expected 110, got ${score!.total}`);
        console.log('  case7 PASS');
    } finally {
        resetTrendExperimentFlags();
    }
}

// ============================================================
// Case 8: indicator 11 reverse mode
// Case 2 的 baseline prevRangePctAvg7=0.015(<0.025),forward 模式下 0 分,
// reverse 模式应该给 10 分。
// ============================================================
{
    console.log('Running case 8: indicator 11 reverse mode');
    setTrendIndicator11Mode('reverse');
    try {
        const window = [
            { open: 100, close: 100.1, high: 100.2, low: 99.9, volume: 2500, turnover: 250000, timestamp: 0, tradeSession: 'Normal' },
            { open: 100.1, close: 100.0, high: 100.2, low: 99.9, volume: 2500, turnover: 250250, timestamp: 60000, tradeSession: 'Normal' },
            { open: 100.0, close: 100.1, high: 100.15, low: 99.95, volume: 2500, turnover: 250250, timestamp: 120000, tradeSession: 'Normal' },
            { open: 100.1, close: 100.05, high: 100.15, low: 100.0, volume: 2500, turnover: 250375, timestamp: 180000, tradeSession: 'Normal' },
            { open: 100.05, close: 100.1, high: 100.15, low: 100.0, volume: 2500, turnover: 250250, timestamp: 240000, tradeSession: 'Normal' },
        ];
        const baseline: TrendBaseline = {
            prevClose: 100,
            prevAtr: 2,
            prevAtrShort: 2,
            rvolBaseline: 10000,
            prevDayOHLC: { open: 99.5, high: 100.5, low: 99, close: 100 },
            prevRangePctAvg7: 0.015,
        };
        const score = scoreTrendDay(window, baseline);
        assert(score !== null, 'case8: score should not be null');
        assert(score!.prevRangePctAvg7 === 10, `case8 ind11 reverse expected 10, got ${score!.prevRangePctAvg7}`);
        assert(score!.details.prevRangePctAvg7Value === 0.015, 'case8 prevRangePctAvg7Value mismatch');
        console.log('  case8 PASS');
    } finally {
        resetTrendExperimentFlags();
    }
}
```

注意：每个 case 都用 `try/finally` 确保 flag 恢复，即便 assert 失败也不会污染后续 case。

- [ ] **Step 4: 跑 smoke 验证全 PASS**

Run:
```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/smokeTrendDetector.ts
```

Expected: 全部 8 cases PASS, 最后 `✅ trendDetector smoke all pass`。

- [ ] **Step 5: 提交**

```bash
git add src/backtest/smokeTrendDetector.ts
git commit -m "$(cat <<'EOF'
test(trend): smoke coverage for indicator 9/10 disable + ind11 reverse

- case 7: disable indicator 9 and 10 via setter, expect total 130 -> 110
- case 8: ind11 reverse mode gives 10 points when prevRangePctAvg7 < 0.025

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3：给 runner 加两个 CLI flag + setter 调用

**Files:**
- Modify: `src/backtest/runner.ts`

- [ ] **Step 1: 读 runner 现有 main 和 runBacktest 两处**

Read `src/backtest/runner.ts` 第 896-990 行（CLI main）和第 301-330 行（runBacktest 顶部 save 区）以便理解 pattern。

- [ ] **Step 2: 给 `RunnerOptions` 加两个新字段**

找到 `RunnerOptions` 接口定义（Grep `interface RunnerOptions` 或 `export.*RunnerOptions`，大约在 90~130 行）。在字段列表末尾添加：

```ts
    /** v4c 调参实验:禁用哪些新指标(9=今日Range%, 10=昨日Range%, 11=前7天Range%均值) */
    disableTrendIndicators?: number[];
    /** 指标十一评分模式,默认 forward */
    ind11Mode?: 'forward' | 'reverse' | 'range' | 'off';
```

- [ ] **Step 3: 在 `runBacktest` 顶部 save + patch**

在 `src/backtest/runner.ts` 第 322 行 `const savedFilters = { ...config.filters };` 之后追加：

```ts
    // v4c 调参实验:按 opts 覆盖指标启用状态 / 指标十一模式
    // 无 try/finally —— 跟现有 config.filters 一样,结尾统一 resetTrendExperimentFlags
    if (opts.disableTrendIndicators && opts.disableTrendIndicators.length > 0) {
        for (const n of opts.disableTrendIndicators) {
            if (n === 9) setTrendIndicator9Enabled(false);
            else if (n === 10) setTrendIndicator10Enabled(false);
            else if (n === 11) setTrendIndicator11Mode('off');
            else console.warn(`[runner] unknown --disable-trend-ind value: ${n}, ignored`);
        }
    }
    if (opts.ind11Mode && opts.ind11Mode !== 'forward') {
        // 注意:如果同时指定 disableTrendIndicators 含 11 和 ind11Mode,后者会覆盖前者为非 off。
        // 目前不考虑这种组合,CLI 会在 Step 7 里加互斥检查。
        setTrendIndicator11Mode(opts.ind11Mode);
    }
```

- [ ] **Step 4: 在 `runBacktest` 末尾 restore**

找到 `config.filters = savedFilters;` 那一行（约 851 行）。在它**之后**追加：

```ts
    // 恢复 v4c 实验 flag 到默认(全开、forward)
    resetTrendExperimentFlags();
```

- [ ] **Step 5: 扩 import**

在 `src/backtest/runner.ts` 顶部找到现有 `from '../core/trendDetector'` 的 import。追加 4 个 export：

```ts
import {
    scoreTrendDay,
    precomputeTrendBaselinesForSymbol,
    TrendBaseline,
    TREND_ATR_SHORT_PERIOD_DEFAULT,
    TREND_RANGE_PCT_AVG_LOOKBACK,
    setTrendIndicator9Enabled,
    setTrendIndicator10Enabled,
    setTrendIndicator11Mode,
    resetTrendExperimentFlags,
} from '../core/trendDetector';
```

（具体现有 import 可能不是以上清单,只需**加上**后 4 个,保留现有其他 import。）

- [ ] **Step 6: 在 `main()` 里 parse 两个新 flag**

找到 `main()` 里现有 `const trendThresholdFlag = flags['trend-threshold'] as string | undefined;`（约 953 行）。在它之后插入：

```ts
    // v4c 实验 flags
    const disableTrendIndRaw = flags['disable-trend-ind'] as string | undefined;
    let disableTrendIndicators: number[] | undefined;
    if (disableTrendIndRaw) {
        disableTrendIndicators = String(disableTrendIndRaw)
            .split(',')
            .map(s => Number(s.trim()))
            .filter(n => Number.isInteger(n) && [9, 10, 11].includes(n));
        if (disableTrendIndicators.length === 0) {
            console.error(`[runner] invalid --disable-trend-ind=${disableTrendIndRaw}, expected comma-separated list of 9/10/11`);
            process.exit(1);
        }
    }
    const ind11ModeFlag = flags['ind11-mode'] as string | undefined;
    let ind11Mode: 'forward' | 'reverse' | 'range' | 'off' | undefined;
    if (ind11ModeFlag) {
        if (['forward', 'reverse', 'range', 'off'].includes(ind11ModeFlag)) {
            ind11Mode = ind11ModeFlag as any;
        } else {
            console.error(`[runner] invalid --ind11-mode=${ind11ModeFlag}, expected forward|reverse|range|off`);
            process.exit(1);
        }
    }
    // 互斥检查:--disable-trend-ind=11 和 --ind11-mode=(非 off) 冲突
    if (disableTrendIndicators?.includes(11) && ind11Mode && ind11Mode !== 'off') {
        console.error(
            `[runner] --disable-trend-ind=11 conflicts with --ind11-mode=${ind11Mode}; pick one`
        );
        process.exit(1);
    }
```

- [ ] **Step 7: 把新字段塞进 `opts`**

找到构造 `opts` 的对象字面量（`const opts: RunnerOptions = {` 处，约 955 行）。在其他字段之后加：

```ts
        disableTrendIndicators,
        ind11Mode,
```

- [ ] **Step 8: 更新 CLI usage 字符串**

找到 `console.error('Usage: runner.ts <label>...'`（约 914-922 行），把整段替换成：

```ts
        console.error(
            'Usage: runner.ts <label> <trailing|fixed> [tp] [sl] [SLFirst|TPFirst]\n' +
                '  [--stop-atr=N]\n' +
                '  [--filter-rsi=on|off] [--filter-volume=on|off]\n' +
                '  [--filter-entry-phase=on|off] [--filter-index=on|off]\n' +
                '  [--filter-trend=on|off] [--trend-threshold=N] [--trend-atr-period=N]\n' +
                '  [--disable-trend-ind=9[,10,11]] [--ind11-mode=forward|reverse|range|off]\n' +
                '  [--slope-mode=trend|revert] [--slope-threshold=N(bps)]\n'
        );
```

- [ ] **Step 9: 编译**

Run: `npx tsc --noEmit`
Expected: 通过。

- [ ] **Step 10: 跑一个小实验验证 flag 生效**

Run:
```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts \
  verify_flag_parse trailing 0 0.1 \
  --filter-trend=on --disable-trend-ind=9
```

Expected: 能跑完（就算交易数和 `smoke_v4c` 不一样也行,这一步只要 runner 启动和跑完无报错）,输出 `data/backtest/results/verify_flag_parse.json`。

- [ ] **Step 11: 清理 verify 文件**

Run: `rm data/backtest/results/verify_flag_parse.json`

- [ ] **Step 12: 提交**

```bash
git add src/backtest/runner.ts
git commit -m "$(cat <<'EOF'
feat(backtest): add --disable-trend-ind / --ind11-mode CLI flags

Wires the trendDetector experiment setters from runner:
- --disable-trend-ind=9[,10,11] disables one or more v4c range% indicators
- --ind11-mode=forward|reverse|range|off switches indicator 11 scoring
- Mutually exclusive: --disable-trend-ind=11 + --ind11-mode=(not off) rejected
- runBacktest saves/restores via resetTrendExperimentFlags tail call

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4：跑阶段一消融（3 实验）

**Files:** 无代码改动，纯运行。

- [ ] **Step 1: 跑 `abl_no9`（禁用指标九）**

```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts \
  abl_no9 trailing 0 0.1 \
  --filter-trend=on --disable-trend-ind=9
```

Expected: 正常跑完，约 2-4 分钟，产出 `data/backtest/results/abl_no9.json`。

- [ ] **Step 2: 跑 `abl_no10`（禁用指标十）**

```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts \
  abl_no10 trailing 0 0.1 \
  --filter-trend=on --disable-trend-ind=10
```

Expected: 产出 `abl_no10.json`。

- [ ] **Step 3: 跑 `abl_no11`（禁用指标十一）**

```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts \
  abl_no11 trailing 0 0.1 \
  --filter-trend=on --disable-trend-ind=11
```

Expected: 产出 `abl_no11.json`。

- [ ] **Step 4: 跑汇总脚本**

Run 以下一次性 inline node 脚本（不 persist）：

```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only -e "
const fs = require('fs');
function stats(path){
  const j = JSON.parse(fs.readFileSync(path,'utf8'));
  const t = j.trades;
  const wins = t.filter(x=>x.rMultiple>0).length;
  const sumR = t.reduce((s,x)=>s+x.rMultiple,0);
  let peak=0, dd=0, cum=0;
  for(const x of t){ cum+=x.rMultiple; if(cum>peak)peak=cum; if(peak-cum>dd)dd=peak-cum; }
  return { trades: t.length, winRate: wins/t.length, avgR: sumR/t.length, cumR: sumR, maxDD: dd, ratio: sumR/dd };
}
const base = stats('data/backtest/results/smoke_v4c.json');
const labels = ['abl_no9','abl_no10','abl_no11'];
const fmt = n => typeof n === 'number' ? n.toFixed(n > 10 ? 1 : 4) : String(n);
console.log('label           trades   winRate   avgR     cumR      maxDD    ratio    dRatio   dCumR%');
console.log('smoke_v4c (base)', [base.trades, (base.winRate*100).toFixed(1)+'%', fmt(base.avgR), fmt(base.cumR), fmt(base.maxDD), fmt(base.ratio), '-', '-'].join(' '));
for (const l of labels) {
  const s = stats('data/backtest/results/'+l+'.json');
  const dRatio = s.ratio - base.ratio;
  const dCumR = (s.cumR - base.cumR) / base.cumR * 100;
  console.log(l.padEnd(16), [s.trades, (s.winRate*100).toFixed(1)+'%', fmt(s.avgR), fmt(s.cumR), fmt(s.maxDD), fmt(s.ratio), fmt(dRatio), fmt(dCumR)+'%'].join(' '));
}
"
```

Expected: 输出 4 行对比表（baseline + 3 消融）。

- [ ] **Step 5: 判读**

根据表格按 spec 第三节决策树：

1. 过滤掉 `cumR < 1048` 的实验（硬约束）
2. 剩余中选 `ratio` 最高者作为阶段一胜出版
3. 如果没有一组 ratio > 13.77 → 胜出版 = baseline（全开）
4. **如果 `abl_no11` 通过硬约束且 ratio > baseline** → 进入 Task 5（方向探索）；否则跳过 Task 5 直接进 Task 6

把判读写到对话里，**不写到文件**（这一步是决策，不是提交）。

- [ ] **Step 6: 不提交**（实验产出 `.json` 已在 `.gitignore` 或不纳入 git）

Run: `ls -la data/backtest/results/abl_no*.json`（确认文件存在即可）。

---

## Task 5：阶段一·B 指标十一方向探索（条件触发）

**Files:** 无代码改动。

**只有当 Task 4 Step 5 判定要做此步才执行,否则跳到 Task 6。**

- [ ] **Step 1: 跑 `ind11_reverse`**

```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts \
  ind11_reverse trailing 0 0.1 \
  --filter-trend=on --ind11-mode=reverse
```

Expected: 产出 `ind11_reverse.json`。

- [ ] **Step 2: 跑 `ind11_range`**

```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts \
  ind11_range trailing 0 0.1 \
  --filter-trend=on --ind11-mode=range
```

Expected: 产出 `ind11_range.json`。

- [ ] **Step 3: 汇总对比（含 abl_no11）**

Run 和 Task 4 Step 4 类似的脚本，但把 labels 换成 `['abl_no11','ind11_reverse','ind11_range']`，基线依旧 `smoke_v4c`。

- [ ] **Step 4: 判读**

三者按 ratio 排序（过滤硬约束），选最高者作为"指标十一最终配置"。可能结果：

- `ind11_reverse` 最高 → 最终方向用 reverse
- `ind11_range` 最高 → 最终方向用 range
- `abl_no11` 最高 → 彻底禁用
- 都没超 baseline → 回退到原 forward（跳过指标十一的变更）

把胜出配置记录下来,用于 Task 6 的门槛扫实验。

---

## Task 6：阶段二门槛粗扫（3 实验）

**Files:** 无代码改动。

**命令模板**（在阶段一 + 阶段一·B 胜出配置基础上扫门槛）：

下面假设"阶段一·B 胜出版"是"指标十一 reverse"。**实际执行时替换成 Task 4/5 判读得出的 flag 组合**（可能是 `--disable-trend-ind=11` 或 `--ind11-mode=range` 或什么都不加即全默认）。

- [ ] **Step 1: 跑 `thr_65`**

```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts \
  thr_65 trailing 0 0.1 \
  --filter-trend=on --trend-threshold=65 \
  [阶段一胜出 flag]
```

Expected: 产出 `thr_65.json`。

- [ ] **Step 2: 跑 `thr_75`**

```bash
[同上,换 --trend-threshold=75 label=thr_75]
```

- [ ] **Step 3: 跑 `thr_85`**

```bash
[同上,换 --trend-threshold=85 label=thr_85]
```

- [ ] **Step 4: 汇总对比**

把 Task 4 Step 4 脚本的 labels 换成 `['thr_65','thr_75','thr_85']`，和阶段一胜出版（新 baseline）对比。
注意：如果阶段一胜出版 ≠ `smoke_v4c`，baseline 应该换成阶段一·B 胜出的 json。

- [ ] **Step 5: 判读**

- 如果 ratio **峰值在 65 或 75**（即 55 < thr_65, thr_65 > thr_75, thr_75 > thr_85 等三明治形态）→ 进入 Task 7 细扫
- 如果 ratio **单调上升到 85** → Task 7 向更高扫（95、105）
- 如果 ratio **单调下降** → 保留 55,阶段二结束,跳到 Task 8

---

## Task 7：阶段二·B 门槛细扫（条件触发）

**Files:** 无代码改动。

**只有 Task 6 Step 5 判定要做才执行。**

- [ ] **Step 1: 根据 Task 6 结果跑 2-3 个细扫点**

如果峰值在 75：跑 70、80
如果峰值在 65：跑 60、70
如果单调上升：跑 95、105

命令模板同 Task 6 Step 1，换 label 和 `--trend-threshold=N`。

- [ ] **Step 2: 汇总 + 判读**

用 Task 4 Step 4 脚本风格汇总,选最终门槛值。

---

## Task 8：更新 TREND.md 文档

**Files:**
- Modify: `references/TREND.md`

实验结束后,更新文档反映最终配置。

- [ ] **Step 1: 更新第五节性能表**

修改 `references/TREND.md` 第 188-195 行的性能表。新增一行"**v4c（实验后）**"，填入实验选中的最终配置的一年数据。原 v4b 那行可以保留作历史对比,也可以删除。

例如（具体数值用实际实验结果）：

```markdown
# 五、性能（一年样本 2025-04 ~ 2026-04）

| 方案 | trades | winRate | avgR | cumR | maxDD | cumR÷maxDD |
|---|---|---|---|---|---|---|
| 无 detector baseline | 32443 | 38.0% | 0.031 | 1011.6 | 279.8 | 3.62 |
| v4c 初版（score ≥ 55） | 20495 | 38.3% | 0.064 | 1310.6 | 95.2 | 13.77 |
| **v4c 调参后（...）** | ... | ... | ... | ... | ... | ... |
```

- [ ] **Step 2: 更新附录版本表**

修改 `references/TREND.md` 附录"历史演进"的表格末尾,添加实验后的变化说明（如果有）。例如：

```markdown
| v4c | 新增指标九/十/十一（3 个独立的日内百分比波动指标，各 10 分）；总分 140 → 170；门槛维持 55 |
| **v4c-tuned（当前）** | 消融诊断后:[具体选择,如"禁用指标十一"/"指标十一改 reverse"/"门槛 55 → 75"]; cumR XX / ratio XX |
```

- [ ] **Step 3: 如果最终实验选中"禁用某指标"或"指标十一改 mode"作为默认,更新代码**

这是**可选**的收尾:如果实验结果显示"禁用指标十一"是默认最优,应把 `trendDetector.ts` 的 `IND11_MODE` 默认值改成 `'off'`（而不是 forward）。

**判断规则**:
- 如果实验选中 = forward（原默认） → 代码不用改
- 如果实验选中 = 其他 → 改 `trendDetector.ts` 第 X 行（Task 1 Step 1 插入的那行）把默认值改掉,**并更新** Task 1 Step 6 原来验证"默认行为不变"的 smoke case（case 1-6）的期望值。

如需代码改动:具体 edit 命令由执行者根据实际最优配置决定,不在本 plan 预写。

- [ ] **Step 4: 提交文档更新**

```bash
git add references/TREND.md
[如果也改了 src/core/trendDetector.ts, 也加上]
git commit -m "$(cat <<'EOF'
docs(trend): update v4c performance + experiment findings

- Refresh 一年 performance table with v4c actual (was stale v4b numbers)
- Add appendix entry for v4c tuning experiment outcome

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9：最终验证

**Files:** 无修改。

- [ ] **Step 1: 全量 smoke**

```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/smokeTrendDetector.ts
```

Expected: 全部 PASS（包括 Task 2 加的 case 7、8）。

- [ ] **Step 2: 全量 tsc**

Run: `npx tsc --noEmit`
Expected: 0 errors。

- [ ] **Step 3: `npm run build` 通过**

Run: `npm run build`
Expected: 构建到 `dist/`，无报错。

- [ ] **Step 4: 总结实验结果**

在对话里给出一张最终对比表,覆盖所有跑过的实验,加一段文字总结:

- 选中的最终配置是什么
- 相对 v4c baseline (cumR 1310.6 / ratio 13.77) 改进多少
- 哪些指标/参数被保留、哪些被调整或禁用
- 对用户的建议后续动作（如果有）

---

## 提交计划总结

| Task | 提交信息 |
|---|---|
| 1 | feat(trend): add experiment flags for v4c indicator 9/10/11 tuning |
| 2 | test(trend): smoke coverage for indicator 9/10 disable + ind11 reverse |
| 3 | feat(backtest): add --disable-trend-ind / --ind11-mode CLI flags |
| 4, 5, 6, 7 | 无提交（纯跑实验 + 判读） |
| 8 | docs(trend): update v4c performance + experiment findings |

Task 9 是最终验证,无提交。

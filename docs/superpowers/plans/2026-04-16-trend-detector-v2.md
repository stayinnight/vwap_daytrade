# 趋势日 Detector v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 v1 的 15 分钟评价窗口缩短到 5 分钟(09:30–09:34),打分提前到 09:35,RVOL 基线改为前 5 天;给 trade log 加 detail 字段;写诊断脚本分析每个指标的区分力;基于诊断手调权重后跑终极实验组。

**Architecture:** 改 `trendDetector.ts` 的两个常量即可完成"方向 2"(结构性改动);给 `BacktestTrade` / `Position` / `closeTrade` 加 `entryDayScoreDetail` 字段完成数据采集增强;新建 `analyzeTrendWeights.ts` 诊断脚本从 recordonly 数据做 5 指标分桶统计;**Step D(手调权重)是必停点**,等用户确认后才跑终极实验。

**Tech Stack:** TypeScript + ts-node(CommonJS 模式)、`technicalindicators`(已有）

**Spec:** `docs/superpowers/specs/2026-04-15-trend-detector-v2-design.md`

---

## 背景速览(给零上下文的工程师)

- v1 已落地:趋势日评分模块 `src/core/trendDetector.ts`(纯函数,5 指标 0–100 分)+ 回测 runner 集成(09:45 打分,分数门控)
- v1 发现:评分有 7.5× 区分度,但门控太严(1933R → 250R)。09:30–09:44 窗口贡献 22.5% 总 R 被丢
- v2 核心改动:评价窗口从 15 分钟缩到 5 分钟(09:30–09:34),打分提前到 09:35,保留 09:35–09:44 的交易窗口;RVOL 基线从前 20 天改为前 5 天;跑诊断后手调权重
- **所有回测脚本必须用**:`TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test npx ts-node --transpile-only ...`
- 代码和注释以中文为主,保持语言一致
- 项目没有 jest,测试靠 smoke script
- runner.ts 当前 892 行,trendDetector.ts 320 行
- **working tree 有未提交改动**(AGENTS.md, CLAUDE.md, vwapStrategy.ts, realTimeMarket.ts, fetchHistory.ts 等),subagent 只 `git add` 指定文件,不碰其他

---

## 文件结构与职责

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/core/trendDetector.ts` | 修改 | 常量: `OPENING_WINDOW_MINUTES 15→5`, `RVOL_LOOKBACK_DAYS 20→5`;Task 8 后更新权重/阈值常量 |
| `src/backtest/types.ts` | 修改 | `BacktestTrade` 加 `entryDayScoreDetail?: TrendScore \| null` |
| `src/backtest/runner.ts` | 修改 | `Position` 加 `entryDayScoreDetail`,`newPos` 填入,`closeTrade` 写入 |
| `src/backtest/smokeTrendDetector.ts` | 修改 | Case 1-3 window 改 5 根,手算期望值重算 |
| `src/backtest/analyzeTrendWeights.ts` | **新建** | 诊断脚本:读 recordonly,按 5 指标 raw value 分桶统计 avgR/winRate |
| `src/backtest/reportTrend.ts` | 修改 | 加载 v2 labels,生成 report_trend_v2.md |
| `references/BACKTEST.md` | 修改 | §6 加"批次 C"v2 实验记录 |

---

## Task 0: 提交 v2 spec

**Files:**
- Stage: `docs/superpowers/specs/2026-04-15-trend-detector-v2-design.md`

- [ ] **Step 1: Commit spec**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
git add docs/superpowers/specs/2026-04-15-trend-detector-v2-design.md
git commit -m "$(cat <<'EOF'
docs: 趋势日 detector v2 设计规格

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 1: 修改 trendDetector.ts 常量(方向 2 核心)

**Files:**
- Modify: `src/core/trendDetector.ts`

这是 v2 方向 2 的**全部代码改动** —— 只改两个常量值,所有下游逻辑(runner 的打分触发条件、precompute 的 RVOL lookback 窗口、scoreTrendDay 的 window 长度校验)都是常量驱动,自动生效。

- [ ] **Step 1: 修改两个常量**

找到 `src/core/trendDetector.ts` 第 36–37 行:

```ts
export const RVOL_LOOKBACK_DAYS = 20;
export const OPENING_WINDOW_MINUTES = 15;
```

改为:

```ts
export const RVOL_LOOKBACK_DAYS = 5;
export const OPENING_WINDOW_MINUTES = 5;
```

- [ ] **Step 2: 语法验证**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' \
  npx ts-node --transpile-only -e "require('./src/core/trendDetector.ts'); console.log('ok');"
```

预期:`ok`

- [ ] **Step 3: Sanity check precompute(COIN.US 一支票)**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' \
  npx ts-node --transpile-only -e "
const fs = require('fs');
const { precomputeTrendBaselinesForSymbol, RVOL_LOOKBACK_DAYS, OPENING_WINDOW_MINUTES } = require('./src/core/trendDetector');
console.log('RVOL_LOOKBACK_DAYS:', RVOL_LOOKBACK_DAYS, 'OPENING_WINDOW_MINUTES:', OPENING_WINDOW_MINUTES);
const data = JSON.parse(fs.readFileSync('data/backtest/raw/COIN.US.json', 'utf8'));
const out = precomputeTrendBaselinesForSymbol(data.bars);
const keys = Object.keys(out).sort();
const nulls = keys.filter(k => out[k] === null).length;
const nonNulls = keys.filter(k => out[k] !== null).length;
console.log('total days:', keys.length, 'null:', nulls, 'nonNull:', nonNulls);
const firstNon = keys.find(k => out[k] !== null);
console.log('first nonNull day:', firstNon, JSON.stringify(out[firstNon]));
"
```

预期:
- `RVOL_LOOKBACK_DAYS: 5 OPENING_WINDOW_MINUTES: 5` — 确认常量生效
- `null` 数量应 < v1 的 10(因为 RVOL 预热从 10 天降到 3 天,ATR 7 天仍是 binding → ~8 天 null)
- `nonNull` 约 242-243
- `rvolBaseline` 值的量级应比 v1 小(v1 是 ~436k,这是 15 分钟量;v2 是 5 分钟量 → 预期 ~150k)
- 如果 `rvolBaseline` 量级仍然 ~400k+,说明常量没生效 —— 停下检查

- [ ] **Step 4: Commit**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
git add src/core/trendDetector.ts
git commit -m "$(cat <<'EOF'
feat: trendDetector v2 —— 评价窗口 15→5 分钟, RVOL 基线 20→5 天

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

`git show --stat HEAD` 确认只有 `src/core/trendDetector.ts`。

---

## Task 2: 更新 smoke script 适配 5 根 bar 窗口

**Files:**
- Modify: `src/backtest/smokeTrendDetector.ts`

v1 的 smoke script 里 case 1-3 构造了 15 根 bar 的 window,现在要改成 5 根。需要重算每个 case 的指标预期值。

- [ ] **Step 1: 重写 caseFullScore(100 分)**

找到 `caseFullScore` 函数(约第 46-79 行)。把循环从 `OPENING_WINDOW_MINUTES`(已变成 5)生成 5 根 bar,并调整手算:

- Gap: prevClose=100, window[0].open=102.5 → gapPct=2.5% > 2% → 20 分 (不变)
- RVOL: 5 × 2500 = 12500, rvolBaseline=10000 → rvol=1.25 → > 1 但 < 1.5 → **0 分**

问题:v1 的 RVOL 用 `15 × 2500 = 37500 / 10000 = 3.75 > 3 → 30分`。缩到 5 根后 `5 × 2500 = 12500 / 10000 = 1.25 < 1.5 → 0 分`,Case 1 的 RVOL 拿不到分了。需要调整 volume 或 rvolBaseline。

把 volume 从 2500 调到 7000:`5 × 7000 = 35000 / 10000 = 3.5 > 3 → 30 分`。或把 rvolBaseline 从 10000 调到 3000:`5 × 2500 = 12500 / 3000 = 4.17 > 3 → 30 分`。用后者更干净(不影响其他指标的 turnover 计算)。

同时:Drive 原来是 `|104.5 - 102.5| / 2 = 1.0 > 0.8 → 25 分`。5 根 bar 的 window[last] close 要 explicitly set 到 104.5(和 v1 一样的思路):window 只有 5 根,close 从 102.6 到 103.0(5 步,每步 0.1),最后 `window[4].close = 104.5`(override)。drive = |104.5 - 102.5| / 2 = 1.0 → 25 分。OK。

VWAP:5 根 bar close 单调上升,cum_turnover/cum_volume 应该小于 close → 5/5 longCount → 15 分。需要验证 turnover 计算:`((o+c)/2)*vol`,5 根 bar 的 turnover 会随 close 上升而上升,cum_vwap 是加权平均价,在 close 单调上升时会 lag behind → 每根 close > cum_vwap ✓。

Range:5 根 bar 的 highMax ≈ 104.55, lowMin ≈ 102.45 → range ≈ 2.1 > 0.6 × 2 = 1.2 → 10 分。

新的完整 caseFullScore:

```typescript
(function caseFullScore() {
    console.log('Running case 1: full score');
    const baseline: TrendBaseline = {
        prevClose: 100,
        prevAtr: 2,
        rvolBaseline: 3000, // 调低以让 5 根 bar × 2500 vol 能拿到 RVOL 30 分
    };
    const window: SerializedBar[] = [];
    for (let i = 0; i < OPENING_WINDOW_MINUTES; i++) {
        const o = 102.5 + i * 0.1;
        const c = 102.5 + (i + 1) * 0.1;
        const h = Math.max(o, c) + 0.05;
        const l = Math.min(o, c) - 0.05;
        window.push(bar(0, o, h, l, c, 2500));
    }
    window[0].open = 102.5; // gap = 2.5% > 2% → 20
    window[window.length - 1].close = 104.5; // drive = |104.5 - 102.5| / 2 = 1.0 → 25
    // RVOL = 5 * 2500 / 3000 = 4.17 > 3 → 30
    // VWAP: 5/5 all above → 15
    // range: highMax ≈ 104.55, lowMin ≈ 102.45, range ≈ 2.1 > 1.2 → 10

    const score = scoreTrendDay(window, baseline);
    assert(score !== null, 'case1: score should not be null');
    console.log('  case1 score:', JSON.stringify(score));
    assert(score!.gap === 20, `case1 gap expected 20, got ${score!.gap}`);
    assert(score!.rvol === 30, `case1 rvol expected 30, got ${score!.rvol}`);
    assert(score!.drive === 25, `case1 drive expected 25, got ${score!.drive}`);
    assert(score!.vwap === 15, `case1 vwap expected 15, got ${score!.vwap}`);
    assert(score!.range === 10, `case1 range expected 10, got ${score!.range}`);
    assert(score!.total === 100, `case1 total expected 100, got ${score!.total}`);
    console.log('  case1 PASS');
})();
```

- [ ] **Step 2: 重写 caseZeroScore(0 分)**

```typescript
(function caseZeroScore() {
    console.log('Running case 2: zero score');
    const baseline: TrendBaseline = {
        prevClose: 100,
        prevAtr: 10,
        rvolBaseline: 10000,
    };
    const window: SerializedBar[] = [];
    for (let i = 0; i < OPENING_WINDOW_MINUTES; i++) {
        const o = i % 2 === 0 ? 100.45 : 100.55;
        const c = i % 2 === 0 ? 100.55 : 100.45;
        window.push(bar(0, o, 100.6, 100.4, c, 500));
    }
    window[0].open = 100.5; // gap = 0.5% < 1% → 0
    window[window.length - 1].close = 100.51; // drive ≈ 0.001 → 0
    // RVOL = 5 * 500 / 10000 = 0.25 < 1.5 → 0
    // VWAP: alternating → 0 (5 根里最多 3:2 = 60%, < 80%)
    // range: 100.6 - 100.4 = 0.2, 0.6 * 10 = 6 → 0

    const score = scoreTrendDay(window, baseline);
    assert(score !== null, 'case2: not null');
    console.log('  case2 score:', JSON.stringify(score));
    assert(score!.gap === 0, `case2 gap expected 0, got ${score!.gap}`);
    assert(score!.rvol === 0, `case2 rvol expected 0, got ${score!.rvol}`);
    assert(score!.drive === 0, `case2 drive expected 0, got ${score!.drive}`);
    assert(score!.vwap === 0, `case2 vwap expected 0, got ${score!.vwap}`);
    assert(score!.range === 0, `case2 range expected 0, got ${score!.range}`);
    assert(score!.total === 0, `case2 total expected 0, got ${score!.total}`);
    console.log('  case2 PASS');
})();
```

注意:5 根 bar 交替 close 的 VWAP 控制力 —— 5 根 bar 模式 `[high, low, high, low, high]` 给出 longCount=3, shortCount=2 → longRatio=3/5=0.6 < 0.8 → 0 分。OK。

- [ ] **Step 3: 重写 caseBelowThreshold(< 60)**

```typescript
(function caseBelowThreshold() {
    console.log('Running case 3: below threshold');
    const baseline: TrendBaseline = {
        prevClose: 100,
        prevAtr: 2,
        rvolBaseline: 3000,
    };
    const win: SerializedBar[] = [];
    for (let i = 0; i < OPENING_WINDOW_MINUTES; i++) {
        const o = i % 2 === 0 ? 101.49 : 101.51;
        const c = i % 2 === 0 ? 101.51 : 101.49;
        win.push(bar(0, o, c + 0.5, o - 0.5, c, 1400));
    }
    win[0].open = 101.5; // gap = 1.5% > 1% → 10
    win[win.length - 1].close = 102.7; // drive = |102.7 - 101.5| / 2 = 0.6 > 0.5 → 15
    // RVOL = 5 * 1400 / 3000 = 2.33 > 2 → 20
    // VWAP: alternating → 0
    // range: highMax ~ 103.2, lowMin ~ 100.99 → 2.21 > 1.2 → 10
    // total ≈ 10 + 20 + 15 + 0 + 10 = 55 < 60

    const score = scoreTrendDay(win, baseline);
    assert(score !== null, 'case3: not null');
    console.log('  case3 score:', JSON.stringify(score));
    assert(
        score!.total < TREND_SCORE_THRESHOLD,
        `case3 total expected < ${TREND_SCORE_THRESHOLD}, got ${score!.total}`
    );
    console.log('  case3 PASS (below threshold, total=' + score!.total + ')');
})();
```

- [ ] **Step 4: 调整 casePrecompute(Case 4)**

Case 4 构造了 25 天 × (15 根 intraday + 1 根日末)。v2 只需要改"15 根"为"5 根"即可。但现有代码用了 `for (let min = 0; min < 15; min++)`,这里的 15 是 hard-coded 数字不是常量(因为 smoke 是独立测试,不依赖 OPENING_WINDOW_MINUTES 来决定构造几根 bar —— 但改成用常量更好)。把 `min < 15` 改成 `min < OPENING_WINDOW_MINUTES`(已 import)。

另外:RVOL lookback 改成 5 天后,`ceil(5/2) = 3`,所以第一个有 baseline 的日子会更早。Case 4 原来 assert `out[keys[0]] === null`(day 0)和 `lastDayBaseline !== null`(day 24),这些断言在新参数下仍然成立,不用改。

只需要改第 156 行:

找到:
```ts
        for (let min = 0; min < 15; min++) {
```

改为:
```ts
        for (let min = 0; min < OPENING_WINDOW_MINUTES; min++) {
```

- [ ] **Step 5: 跑 smoke 脚本**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/smokeTrendDetector.ts
```

预期末尾:`✅ trendDetector smoke all pass`

如果 Case 1 VWAP 不是 15:检查 5 根 bar 的 cumTurnover / cumVolume 是否始终 < close。如果 Case 2 VWAP 不是 0:检查 5 根 bar 交替下 longRatio 是否 < 0.8。如果 Case 3 total >= 60:检查 range 或 RVOL 的实际值。

**如果任何 case fail**:打印 score details,手算核对,修 test 构造(不改 trendDetector.ts)。如果是 trendDetector.ts 的 bug(不太可能,v1 已经跑通过),report BLOCKED。

- [ ] **Step 6: Commit**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
git add src/backtest/smokeTrendDetector.ts
git commit -m "$(cat <<'EOF'
test: smoke script 适配 v2 五分钟窗口

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 给 BacktestTrade / Position / closeTrade 加 detail 字段

**Files:**
- Modify: `src/backtest/types.ts`
- Modify: `src/backtest/runner.ts`

v1 只记录了 `entryDayScore`(total 分),v2 还需要 5 个指标的 raw value(gapPct, rvolValue, driveAtr, vwapControlRatio, rangeValue)以及各指标的分数(gap, rvol, drive, vwap, range),用于 Step C 诊断。最简洁的做法:把完整 `TrendScore` 对象写进去。

- [ ] **Step 1: types.ts 加字段**

在 `src/backtest/types.ts` 的 `BacktestTrade` interface 里,`entryDayScore` 之后加:

```ts
    entryDayScore?: number | null;
    /**
     * 入场当日该票的评分明细(5 指标分数 + raw values)。
     * 运行时 detector 打分后写入。旧 result json 不存在此字段。
     */
    entryDayScoreDetail?: {
        gap: number; rvol: number; drive: number; vwap: number; range: number;
        details: {
            gapPct: number; rvolValue: number; driveAtr: number;
            vwapControlRatio: number; vwapControlSide: string; rangeValue: number;
        };
    } | null;
```

不直接 `import TrendScore`,因为 types.ts 是底层类型文件,不应引入 `src/core/` 的依赖。用 inline 结构体描述(duck type),runner 侧负责从 `TrendScore` 赋值。

- [ ] **Step 2: runner.ts — Position 加字段**

找到 `interface Position`(runner.ts 约 234-246 行):

```ts
    /** 入场当日该票的评分(detector 关闭时记录的也是打分结果,null 表示没基线) */
    entryDayScore: number | null;
}
```

在 `entryDayScore` 之后加:

```ts
    entryDayScore: number | null;
    entryDayScoreDetail: BacktestTrade['entryDayScoreDetail'];
}
```

- [ ] **Step 3: runner.ts — newPos 填入 detail**

找到创建 Position 的地方(runner.ts 约 614-628 行):

```ts
                    const scoreNow = dayScoreMap[symbol];
                    const newPos: Position = {
                        ...
                        entryDayScore:
                            scoreNow && typeof scoreNow === 'object'
                                ? scoreNow.total
                                : null,
                    };
```

在 `entryDayScore:` 之后加:

```ts
                        entryDayScore:
                            scoreNow && typeof scoreNow === 'object'
                                ? scoreNow.total
                                : null,
                        entryDayScoreDetail:
                            scoreNow && typeof scoreNow === 'object'
                                ? {
                                    gap: scoreNow.gap,
                                    rvol: scoreNow.rvol,
                                    drive: scoreNow.drive,
                                    vwap: scoreNow.vwap,
                                    range: scoreNow.range,
                                    details: scoreNow.details,
                                }
                                : null,
```

- [ ] **Step 4: runner.ts — closeTrade 写入 trade log**

找到 `closeTrade` 里的 `trades.push({...})`(runner.ts 约 440 行):

```ts
            entryDayScore: pos.entryDayScore,
        });
```

在 `entryDayScore` 后面加:

```ts
            entryDayScore: pos.entryDayScore,
            entryDayScoreDetail: pos.entryDayScoreDetail,
        });
```

- [ ] **Step 5: 跑 smoke 回测验证无回归**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts smoke_v2_detail trailing 2>&1 | tail -15
```

预期:跑完,看到 `[runner] 预计算 trend baseline 完成`,trade 数输出。trade 数会和 v1 不同(因为窗口从 15 分钟改成 5 分钟了,之前 09:35–09:44 禁开仓的信号现在放行了),这是预期的。

然后确认 detail 字段:

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
node -e "
const r = require('./data/backtest/results/smoke_v2_detail.json');
console.log('trades:', r.trades.length);
console.log('fields:', Object.keys(r.trades[0]).join(', '));
const withDetail = r.trades.filter(t => t.entryDayScoreDetail != null);
console.log('has detail:', withDetail.length, '/', r.trades.length);
if (withDetail.length > 0) {
  console.log('sample detail:', JSON.stringify(withDetail[0].entryDayScoreDetail));
}
"
```

预期:
- `fields` 包含 `entryDayScoreDetail`
- `has detail` > 0(大多数 trade 有 detail)
- `sample detail` 有 gap/rvol/drive/vwap/range + details 子对象

- [ ] **Step 6: Commit**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
git add src/backtest/types.ts src/backtest/runner.ts
git commit -m "$(cat <<'EOF'
feat: trade log 加 entryDayScoreDetail(5 指标明细)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 跑实验组 2 和 3

**Files:** 无代码改动,只跑 runner

- [ ] **Step 1: 跑 `trend_v2_recordonly_sl010`(detector off,记录分数)**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts trend_v2_recordonly_sl010 trailing 2>&1 | tail -15
```

预期:3-6 分钟,完成后 trades 数应该和 `baseline_loose_sl010`(59015)一致(detector off 不门控)。记录实际数。

- [ ] **Step 2: 验证分数分布**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
node -e "
const r = require('./data/backtest/results/trend_v2_recordonly_sl010.json');
const scores = r.trades.map(t => t.entryDayScore).filter(s => s != null);
const nulls = r.trades.length - scores.length;
console.log('trades:', r.trades.length, 'null scores:', nulls, 'non-null:', scores.length);
console.log('avg score:', (scores.reduce((a,b)=>a+b,0) / scores.length).toFixed(1));
console.log('min/max:', Math.min(...scores), Math.max(...scores));
// 分布
const buckets = [0,30,60,80,101];
for (let i=0; i<buckets.length-1; i++){
  const n = scores.filter(s => s >= buckets[i] && s < buckets[i+1]).length;
  console.log('  '+buckets[i]+'-'+(buckets[i+1]-1)+':', n);
}
// 检查 detail
const withDetail = r.trades.filter(t => t.entryDayScoreDetail != null);
console.log('has detail:', withDetail.length);
"
```

预期:分布会和 v1 不同(5 分钟窗口下分数整体可能偏低,因为 VWAP 更容易虚高但 Drive/Range 更难得分)。关键是**不是全 0 或全 null**。

- [ ] **Step 3: 跑 `trend_v2_score60_sl010`(detector on,门槛 60)**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts trend_v2_score60_sl010 trailing --filter-trend=on 2>&1 | tail -15
```

预期:trades 数 < 组 2 的 trades 数(门控在拦截)。

---

## Task 5: 新建诊断脚本 `analyzeTrendWeights.ts`

**Files:**
- Create: `src/backtest/analyzeTrendWeights.ts`

这个脚本从 `trend_v2_recordonly_sl010.json` 读每笔 trade 的 `entryDayScoreDetail`,对 5 个指标各自做分桶统计,输出诊断表。

- [ ] **Step 1: 创建文件**

```typescript
/**
 * 趋势日 Detector v2 诊断脚本:分析 5 个指标各自的区分力。
 *
 * 输入: data/backtest/results/trend_v2_recordonly_sl010.json
 * 输出: stdout 打印诊断表,按指标分桶看 avgR / winRate / trade 数
 *
 * 跑法:
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/analyzeTrendWeights.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { BacktestResult, BacktestTrade } from './types';

const RESULT_PATH = path.resolve(
    process.cwd(),
    'data/backtest/results/trend_v2_recordonly_sl010.json'
);

interface TradeWithDetail extends BacktestTrade {
    entryDayScoreDetail: NonNullable<BacktestTrade['entryDayScoreDetail']>;
}

function loadTrades(): TradeWithDetail[] {
    const raw: BacktestResult = JSON.parse(fs.readFileSync(RESULT_PATH, 'utf8'));
    return raw.trades.filter(
        (t): t is TradeWithDetail => t.entryDayScoreDetail != null
    );
}

interface BucketStat {
    label: string;
    trades: number;
    avgR: number;
    winRate: number;
    cumR: number;
}

function bucketize(
    trades: TradeWithDetail[],
    getValue: (t: TradeWithDetail) => number,
    bucketEdges: number[]
): BucketStat[] {
    const stats: BucketStat[] = [];
    for (let i = 0; i < bucketEdges.length - 1; i++) {
        const lo = bucketEdges[i];
        const hi = bucketEdges[i + 1];
        const isLast = i === bucketEdges.length - 2;
        const subset = trades.filter(t => {
            const v = getValue(t);
            return isLast ? v >= lo && v <= hi : v >= lo && v < hi;
        });
        const n = subset.length;
        const sumR = subset.reduce((s, t) => s + t.rMultiple, 0);
        const wins = subset.filter(t => t.rMultiple > 0).length;
        stats.push({
            label: `[${lo.toFixed(3)}, ${isLast ? hi.toFixed(3) + ']' : hi.toFixed(3) + ')'}`,
            trades: n,
            avgR: n > 0 ? sumR / n : 0,
            winRate: n > 0 ? wins / n : 0,
            cumR: sumR,
        });
    }
    return stats;
}

function quantileEdges(values: number[], numBuckets: number): number[] {
    const sorted = [...values].sort((a, b) => a - b);
    const edges: number[] = [sorted[0]];
    for (let i = 1; i < numBuckets; i++) {
        const idx = Math.floor((i / numBuckets) * sorted.length);
        const v = sorted[idx];
        if (v !== edges[edges.length - 1]) {
            edges.push(v);
        }
    }
    edges.push(sorted[sorted.length - 1]);
    return edges;
}

function printTable(name: string, stats: BucketStat[]) {
    console.log(`\n=== ${name} ===`);
    console.log(
        '  分桶'.padEnd(28) +
            'trades'.padStart(8) +
            'avgR'.padStart(10) +
            'winRate'.padStart(10) +
            'cumR'.padStart(10)
    );
    for (const s of stats) {
        console.log(
            `  ${s.label.padEnd(26)}${String(s.trades).padStart(8)}${s.avgR.toFixed(4).padStart(10)}${(s.winRate * 100).toFixed(1).padStart(9)}%${s.cumR.toFixed(1).padStart(10)}`
        );
    }
    // 单调性判断:avgR 是否从第一桶到最后一桶大致递增
    const avgRs = stats.filter(s => s.trades > 0).map(s => s.avgR);
    let monotoneUp = 0;
    for (let i = 1; i < avgRs.length; i++) {
        if (avgRs[i] > avgRs[i - 1]) monotoneUp++;
    }
    const monoRatio = avgRs.length > 1 ? monotoneUp / (avgRs.length - 1) : 0;
    const monoLabel =
        monoRatio >= 0.8
            ? '强单调 ✓'
            : monoRatio >= 0.5
                ? '弱单调 ~'
                : '无单调 ✗';
    console.log(`  单调性: ${monoLabel} (${(monoRatio * 100).toFixed(0)}% 递增)`);
}

function main() {
    const trades = loadTrades();
    console.log(`加载 ${trades.length} 条有 detail 的 trades`);
    if (trades.length === 0) {
        console.error('没有带 detail 的 trades,请先跑 trend_v2_recordonly_sl010');
        process.exit(1);
    }

    const NUM_BUCKETS = 10;

    // 1. Gap
    const gapVals = trades.map(t => t.entryDayScoreDetail.details.gapPct);
    const gapEdges = quantileEdges(gapVals, NUM_BUCKETS);
    printTable('Gap (gapPct)', bucketize(trades, t => t.entryDayScoreDetail.details.gapPct, gapEdges));

    // 2. RVOL
    const rvolVals = trades.map(t => t.entryDayScoreDetail.details.rvolValue);
    const rvolEdges = quantileEdges(rvolVals, NUM_BUCKETS);
    printTable('RVOL (rvolValue)', bucketize(trades, t => t.entryDayScoreDetail.details.rvolValue, rvolEdges));

    // 3. Drive
    const driveVals = trades.map(t => t.entryDayScoreDetail.details.driveAtr);
    const driveEdges = quantileEdges(driveVals, NUM_BUCKETS);
    printTable('Opening Drive (driveAtr)', bucketize(trades, t => t.entryDayScoreDetail.details.driveAtr, driveEdges));

    // 4. VWAP Control
    const vwapVals = trades.map(t => t.entryDayScoreDetail.details.vwapControlRatio);
    const vwapEdges = quantileEdges(vwapVals, NUM_BUCKETS);
    printTable('VWAP Control (vwapControlRatio)', bucketize(trades, t => t.entryDayScoreDetail.details.vwapControlRatio, vwapEdges));

    // 5. Range
    const rangeVals = trades.map(t => t.entryDayScoreDetail.details.rangeValue);
    const rangeEdges = quantileEdges(rangeVals, NUM_BUCKETS);
    printTable('Range Expansion (rangeValue)', bucketize(trades, t => t.entryDayScoreDetail.details.rangeValue, rangeEdges));

    // 总分分桶(和 reportTrend 的分组表呼应)
    const totalEdges = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 101];
    printTable('总分 (total)', bucketize(
        trades,
        t => t.entryDayScoreDetail.gap + t.entryDayScoreDetail.rvol +
             t.entryDayScoreDetail.drive + t.entryDayScoreDetail.vwap +
             t.entryDayScoreDetail.range,
        totalEdges
    ));

    console.log('\n诊断完成。请根据上方分桶表的单调性和拐点手调权重/阈值。');
}

main();
```

- [ ] **Step 2: 语法验证**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' \
  npx ts-node --transpile-only -e "require('./src/backtest/analyzeTrendWeights.ts')" 2>&1 | head -5
```

可能会报"缺失 trend_v2_recordonly_sl010.json"(如果 Task 4 的结果文件名和脚本里硬编码的不一致)。只要没有 TS 编译错就行。

- [ ] **Step 3: Commit**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
git add src/backtest/analyzeTrendWeights.ts
git commit -m "$(cat <<'EOF'
feat: analyzeTrendWeights.ts —— 5 指标区分力诊断脚本

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 跑诊断脚本,输出诊断表

**Files:** 无代码改动

前置条件:Task 4 已跑完 `trend_v2_recordonly_sl010.json`(detector off,有 detail)。

- [ ] **Step 1: 跑诊断**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/analyzeTrendWeights.ts 2>&1 | tee data/backtest/trend_v2_diagnosis.txt
```

预期:6 张分桶表(5 指标 + 1 总分),每张有 ~10 行。

- [ ] **Step 2: 检查诊断表并输出关键信号**

逐表看:
1. **Gap**:如果高分桶 avgR >> 低分桶 → Gap 有用,保留权重
2. **RVOL**:如果高分桶 avgR >> 低分桶 → RVOL 有用(v1 已证明强)
3. **Drive**:如果高分桶 avgR >> 低分桶 → Drive 有用
4. **VWAP**:如果曲线平坦 → VWAP 控制力无区分力(预期 5 分钟窗口下虚高,可能没用)
5. **Range**:如果触发率极低 → Range 在 5 分钟窗口下不可用

**把诊断表完整输出给用户看**。这是 spec §6 的"必停点"。

---

## ⏸️ 必停点:用户手调权重

Task 6 完成后,暂停执行。把诊断表呈现给用户,等待用户决定:
- 5 个指标各自的新权重(总分仍 100)
- 各档阈值是否需要调整
- 是否删掉某个指标(权重归零)

**用户确认新权重后才继续 Task 7。**

---

## Task 7: 写入新权重/阈值

**Files:**
- Modify: `src/core/trendDetector.ts`

- [ ] **Step 1: 更新常量块**

找到 `src/core/trendDetector.ts` 第 14-33 行的常量块:

```ts
const GAP_TIERS = [
    { pct: 0.02, score: 20 },
    { pct: 0.01, score: 10 },
];
const RVOL_TIERS = [
    { v: 3, score: 30 },
    { v: 2, score: 20 },
    { v: 1.5, score: 10 },
];
const DRIVE_TIERS = [
    { atr: 0.8, score: 25 },
    { atr: 0.5, score: 15 },
    { atr: 0.3, score: 8 },
];
const VWAP_FULL_SCORE = 15;
const VWAP_PARTIAL_SCORE = 8;
const VWAP_PARTIAL_RATIO = 0.8;
const RANGE_ATR_RATIO = 0.6;
const RANGE_SCORE = 10;
```

替换为用户手调后的新值。**这一步的具体代码取决于用户的诊断决定,无法预写。** Implementer 从 controller 传入的 prompt 里拿到确切的新值。

同时:门槛 `TREND_SCORE_THRESHOLD` 也可能调。如果用户没改,保持 60。

- [ ] **Step 2: 跑 smoke**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/smokeTrendDetector.ts
```

**注意:smoke 的 assertion 是基于旧权重手算的。新权重下 Case 1 的 total 可能不再是 100(因为 tier 阈值和分数都变了)。**

如果 smoke 的 case 1/2/3 的 assert 需要更新,更新 smoke 的 expected 值以匹配新权重下的手算结果。具体:
- 对 Case 1:用新的 tier 数据重新推算 5 个指标各给多少分,更新 assert
- 对 Case 2:同上(应该还是 0 分,除非阈值降到极低)
- 对 Case 3:只断言 `total < TREND_SCORE_THRESHOLD`,不断言具体值

- [ ] **Step 3: Commit**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
git add src/core/trendDetector.ts src/backtest/smokeTrendDetector.ts
git commit -m "$(cat <<'EOF'
feat: trendDetector v2 手调权重(基于诊断表)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: 跑终极实验组 4

**Files:** 无代码改动

- [ ] **Step 1: 跑 `trend_v2_tuned_sl010`(新权重 + detector on)**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts trend_v2_tuned_sl010 trailing --filter-trend=on 2>&1 | tail -15
```

预期:完成,记录 trades 数和 cumR(从 json 读)。

- [ ] **Step 2: 快速看关键指标**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
node -e "
const labels = [
  'baseline_loose_sl010',
  'trend_v2_recordonly_sl010',
  'trend_v2_score60_sl010',
  'trend_v2_tuned_sl010',
];
for (const l of labels) {
  try {
    const r = require('./data/backtest/results/' + l + '.json');
    const cumR = r.trades.reduce((s,t) => s + t.rMultiple, 0);
    const wins = r.trades.filter(t => t.rMultiple > 0).length;
    const sorted = [...r.trades].sort((a,b) => a.entryTimestamp - b.entryTimestamp);
    let peak = 0, acc = 0, maxDD = 0;
    for (const t of sorted) { acc += t.rMultiple; if(acc>peak)peak=acc; const dd=peak-acc; if(dd>maxDD)maxDD=dd; }
    const ratio = maxDD > 0 ? cumR / maxDD : 0;
    console.log(l + ':', 'trades=' + r.trades.length,
      'winRate=' + (wins/r.trades.length*100).toFixed(1) + '%',
      'cumR=' + cumR.toFixed(1),
      'maxDD=' + maxDD.toFixed(1),
      'ratio=' + ratio.toFixed(2));
  } catch(e) { console.log(l + ': (missing)'); }
}
"
```

预期:4 行输出。核心判断:
- 组 4 的 ratio ≥ 7.80(v1 达到的值)?
- 组 4 的 cumR > 500(v1 的 250R × 2)?
- 组 4 的 cumR > 组 3 的 cumR?(手调比旧权重好)

---

## Task 9: 更新 reportTrend.ts 支持 v2 labels + 生成报告

**Files:**
- Modify: `src/backtest/reportTrend.ts`

- [ ] **Step 1: 扩展 reportTrend 加载 v2 labels**

在 `reportTrend.ts` 的 `main()` 函数里,加载更多 result 文件。

找到:

```ts
    const baseline = loadResult('baseline_loose_sl010');
    const recordOnly = loadResult('trend_recordonly_sl010');
    const trendOn = loadResult('trend_score60_sl010');
```

在后面加:

```ts
    const v2RecordOnly = loadResult('trend_v2_recordonly_sl010');
    const v2Score60 = loadResult('trend_v2_score60_sl010');
    const v2Tuned = loadResult('trend_v2_tuned_sl010');
```

- [ ] **Step 2: 主表加 v2 行**

找到主表 `rows` 构造部分:

```ts
    if (baseline) rows.push(summarize('baseline_loose_sl010', baseline.trades));
    if (recordOnly) rows.push(summarize('trend_recordonly_sl010', recordOnly.trades));
    if (trendOn) rows.push(summarize('trend_score60_sl010', trendOn.trades));
```

后面加:

```ts
    if (v2RecordOnly) rows.push(summarize('trend_v2_recordonly_sl010', v2RecordOnly.trades));
    if (v2Score60) rows.push(summarize('trend_v2_score60_sl010', v2Score60.trades));
    if (v2Tuned) rows.push(summarize('trend_v2_tuned_sl010', v2Tuned.trades));
```

- [ ] **Step 3: 分组表加 v2 版本**

在 Section 2 的末尾,加一个 v2 recordonly 的分组:

```ts
    if (v2RecordOnly) {
        sections.push('### v2 分数分组(5 分钟窗口)\n');
        sections.push('**数据源**:`trend_v2_recordonly_sl010`\n');
        sections.push(renderBucketTable(v2RecordOnly.trades));
        sections.push('');
    }
```

- [ ] **Step 4: 生成报告**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/reportTrend.ts
```

查看:

```bash
cat data/backtest/report_trend.md
```

- [ ] **Step 5: Commit**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
git add src/backtest/reportTrend.ts
git commit -m "$(cat <<'EOF'
feat: reportTrend 支持 v2 labels + v2 分组表

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: 更新 BACKTEST.md 文档

**Files:**
- Modify: `references/BACKTEST.md`

- [ ] **Step 1: §6 加"批次 C"小节**

在批次 B 之后(约 BACKTEST.md 末尾),加:

```markdown
### 批次 C:趋势日 Detector v2 实验(2026-04-16 跑)

Spec: `docs/superpowers/specs/2026-04-15-trend-detector-v2-design.md`
Plan: `docs/superpowers/plans/2026-04-16-trend-detector-v2.md`
详细报告: `data/backtest/report_trend.md`(更新后包含 v2 数据)

v2 改动:评价窗口 15 分钟 → 5 分钟(09:30–09:34),RVOL 基线 20 天 → 5 天。

四组对照(一年样本):

| label | trades | winRate | avgR | cumR | maxDD | cumR÷maxDD |
|---|---|---|---|---|---|---|
| baseline_loose_sl010 (对照) | ... | ... | ... | ... | ... | ... |
| trend_v2_recordonly_sl010 (v2 门控关) | ... | ... | ... | ... | ... | ... |
| trend_v2_score60_sl010 (v2 门控开 旧权重) | ... | ... | ... | ... | ... | ... |
| trend_v2_tuned_sl010 (v2 门控开 新权重) | ... | ... | ... | ... | ... | ... |

**待补**:跑完后填入实际数据和诊断发现。

**v2 权重调整依据**:见 `data/backtest/trend_v2_diagnosis.txt`(分桶诊断表)。
```

**注意**:表格的 `...` 占位符要在 Task 8 完成后填入实际数字。但如果 Task 10 先做(Task 8 还没跑完),先用 `...` 占位,后续手动填。

- [ ] **Step 2: Commit**

```bash
cd /Users/bytedance/workspace/strategy/vwap_daytrade
git add references/BACKTEST.md
git commit -m "$(cat <<'EOF'
docs: BACKTEST.md 补批次 C — v2 趋势日 detector 实验

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Plan Self-Review

**1. Spec coverage:**
- §2.1 时间改动 → Task 1(常量改动)✓
- §2.2 RVOL 基线改动 → Task 1(`RVOL_LOOKBACK_DAYS 20→5`)✓
- §2.3–§2.6 各指标的变化 → 全部由常量驱动,无额外代码 ✓
- §2.7 实现侧改动清单 → Task 1 + Task 2(smoke)+ Task 3(detail 字段)✓
- §3.1 Step A(数据采集增强)→ Task 3 ✓
- §3.1 Step B(跑 recordonly)→ Task 4 Step 1 ✓
- §3.1 Step C(诊断脚本)→ Task 5 + Task 6 ✓
- §3.1 Step D(手调权重)→ 必停点 + Task 7 ✓
- §3.1 Step E(跑 tuned)→ Task 8 ✓
- §3.2 实验矩阵 4 组 → Task 4(组 2+3)+ Task 8(组 4)+ 组 1 已有 ✓
- §3.3 成功标准 → Task 8 Step 2 指导判断 ✓
- §5 文件改动清单 → 全部覆盖 ✓

**2. Placeholder scan:** Task 7 Step 1 有"具体代码取决于用户的诊断决定,无法预写" —— 这是 spec 必停点的自然结果,不是 placeholder。Task 10 的表格 `...` 是明确标注的待填占位,可接受。无 TBD/TODO。

**3. Type consistency:**
- `entryDayScoreDetail` 在 types.ts 定义为 `{ gap, rvol, drive, vwap, range, details: {...} } | null`
- runner.ts Position 用 `BacktestTrade['entryDayScoreDetail']` 引用,一致
- runner.ts newPos 构造从 `scoreNow.gap/rvol/drive/vwap/range/details` 赋值,一致
- analyzeTrendWeights.ts 用 `t.entryDayScoreDetail.details.gapPct` 等,一致
- `OPENING_WINDOW_MINUTES` 在 trendDetector.ts 定义,smoke script 和 runner.ts 都 import 使用,一致

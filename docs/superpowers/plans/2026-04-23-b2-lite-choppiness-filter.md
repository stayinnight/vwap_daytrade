# B2-lite 日内震荡过滤器 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `VWAPStrategy.canOpen` 加一层"日内滚动震荡评分"过滤器（30 根 K 滚动窗口，2 个指标，满分 70），过滤掉反复在 VWAP 附近来回触发开仓的票，回测验证后用 per-trade R / 胜率指标决定是否上线。

**Architecture:** 新增一个纯函数 `scoreChoppiness`（参考已有 `trendDetector` 模式），实盘和回测共用。在 `canOpen` 里加 `chopOk` 判定与现有过滤器并联。回测 runner 同步集成，给每条 trade 记录 `entryChopScore` 用于事后分析。配置开关 `filters.enableChoppiness` 默认 false，AB 切回旧行为。

**Tech Stack:** TypeScript, ts-node, longport SDK 类型, technicalindicators（已用），现有 backtest runner 工具链。

**Spec:** `docs/superpowers/specs/2026-04-22-b2-lite-choppiness-filter-design.md` (v3, commit abac578)

---

## 文件结构

| 文件 | 操作 | 责任 |
|---|---|---|
| `src/core/indicators/choppiness.ts` | 新建 | 纯函数 `scoreChoppiness` + 接口类型 |
| `src/backtest/smokeChoppiness.ts` | 新建 | 单元 smoke 测试（仿 `smokeRescoreTrend.ts`，自带 assert） |
| `src/config/strategy.config.ts` | 修改 | 新增 `filters.enableChoppiness` + `choppiness` 配置块 |
| `src/strategy/vwapStrategy.ts` | 修改 | `canOpen` 加 `chopScore` 参数、`chopOk` 判定、日志；`onBar` 算 chopScore 传入 |
| `src/backtest/types.ts` | 修改 | `BacktestTrade` 加 `entryChopScore` optional 字段 |
| `src/backtest/runner.ts` | 修改 | 回测循环算 `chopScore` 并传给 canOpen；加 `--filter-choppiness` / `--chop-window` / `--chop-threshold` CLI flags；trade 记录 chopScore；finally 恢复 |
| `src/backtest/runChopExperiment.ts` | 新建 | 二维网格驱动脚本（3 windows × 5 thresholds + baseline = 16 次回测），输出对比报告 |
| `src/backtest/runChopSplitValidation.ts` | 新建 | Task 8 分段验证脚本 |
| `src/backtest/inspectBadCase.ts` | 新建 | Task 9 bad_case 复盘脚本 |
| `references/B2-LITE.md` | 新建（仅 Task 10 上线时） | 上线参数与回测结论记录 |
| `CLAUDE.md` | 修改（仅 Task 10 上线时） | 在主要结论加一行 |

---

## Task 1：新建 `choppiness.ts` 纯函数 + 类型

**Files:**
- Create: `src/core/indicators/choppiness.ts`

- [ ] **Step 1: 创建文件，写接口和函数骨架**

```typescript
/**
 * B2-lite 日内震荡评分（纯函数）
 *
 * 设计文档：docs/superpowers/specs/2026-04-22-b2-lite-choppiness-filter-design.md
 *
 * 评分组成（满分 70）：
 *   - 指标 1：VWAP 穿越频率（权重 40）
 *   - 指标 2：带内时长比（权重 30，三档独立加权）
 *
 * 跨 windowBars 评分可比：指标 1 用频率（次数 / (N-1)），指标 2 是百分比。
 *
 * 实盘 / 回测共用本函数，禁止读取 longport 任何接口、禁止读取文件 / 时间戳。
 */
import { Candlestick } from 'longport';

export interface ChoppinessParams {
    windowBars: number;
    bandAtrRatios: number[]; // 例如 [0.1, 0.2, 0.3]
}

export interface ChoppinessScore {
    total: number;       // 0–70
    crossings: number;   // 分项分（满分 40）
    bandRatio: number;   // 分项分（满分 30）
    details: {
        crossingCount: number;     // 实际穿越次数（保留无信息损失）
        crossingRate: number;      // crossingCount / (N - 1)，0–1，跨 window 可比
        inBandRatios: number[];    // 各档实际带内比例 0–1，与 bandAtrRatios 同序
    };
}

// ====== 分档表 ======
// 指标 1：穿越频率分档（频率越低分越高，跨 window 共用）
const CROSSING_RATE_TIERS: { maxRate: number; score: number }[] = [
    { maxRate: 0.05, score: 40 },
    { maxRate: 0.15, score: 25 },
    { maxRate: 0.25, score: 10 },
    // > 0.25 → 0
];

// 指标 2：每档带内比例分档（每档独立打分，最高 10）
const BAND_TIER_SCORES: { maxRatio: number; score: number }[] = [
    { maxRatio: 0.3, score: 10 },
    { maxRatio: 0.5, score: 6 },
    { maxRatio: 0.7, score: 3 },
    // > 0.7 → 0
];

/**
 * 入参 bars 是最近 windowBars 根已收盘 K（按时间正序，0 最旧、N-1 最新）。
 * vwap 是当根 K 时刻的累计 VWAP（单一数值，所有 N 根都和它比）。
 * atr 是当日 ATR。
 *
 * 返回 null 的条件：
 *   - bars.length < windowBars（warmup）
 *   - atr <= 0
 *   - vwap <= 0 或非有限数
 */
export function scoreChoppiness(
    bars: Candlestick[],
    vwap: number,
    atr: number,
    params: ChoppinessParams,
): ChoppinessScore | null {
    const N = params.windowBars;
    if (bars.length < N) return null;
    if (!(atr > 0)) return null;
    if (!Number.isFinite(vwap) || vwap <= 0) return null;

    // 取最后 N 根（防御性切片：bars 长度 > N 时只用最近 N 根）
    const window = bars.slice(-N);

    // ====== 指标 1：VWAP 穿越频率 ======
    // spec: side[i] === 0（close 等于 vwap，极少）按"无变化"处理，跳过该次比对。
    // 实现：side === 0 时不更新 prevSide，下一根非零 side 仍和"上一个非零 side"比。
    let crossingCount = 0;
    let prevSide = 0;
    for (let i = 0; i < N; i++) {
        const close = window[i].close.toNumber();
        const side = close > vwap ? 1 : close < vwap ? -1 : 0;
        if (i > 0 && side !== 0 && prevSide !== 0 && side !== prevSide) {
            crossingCount++;
        }
        if (side !== 0) prevSide = side;
    }
    const crossingRate = N > 1 ? crossingCount / (N - 1) : 0;

    let crossingsScore = 0;
    for (const tier of CROSSING_RATE_TIERS) {
        if (crossingRate <= tier.maxRate) {
            crossingsScore = tier.score;
            break;
        }
    }

    // ====== 指标 2：带内时长比（三档独立加权）======
    const inBandRatios: number[] = [];
    let bandRatioScore = 0;
    for (const k of params.bandAtrRatios) {
        const bandWidth = k * atr;
        let inBandCount = 0;
        for (let i = 0; i < N; i++) {
            const close = window[i].close.toNumber();
            if (Math.abs(close - vwap) <= bandWidth) inBandCount++;
        }
        const ratio = inBandCount / N;
        inBandRatios.push(ratio);

        let score = 0;
        for (const tier of BAND_TIER_SCORES) {
            if (ratio <= tier.maxRatio) {
                score = tier.score;
                break;
            }
        }
        bandRatioScore += score;
    }

    return {
        total: crossingsScore + bandRatioScore,
        crossings: crossingsScore,
        bandRatio: bandRatioScore,
        details: {
            crossingCount,
            crossingRate,
            inBandRatios,
        },
    };
}
```

- [ ] **Step 2: 验证 TS 编译通过**

Run:
```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
  TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only -e "import { scoreChoppiness } from './src/core/indicators/choppiness'; console.log(typeof scoreChoppiness);"
```

Expected: `function`

- [ ] **Step 3: 不 commit，等 Task 2 写完 smoke 测试后一起 commit**

理由：纯函数没有 smoke 测试是无效保护，宁可一并提交。

---

## Task 2：写 smoke 测试覆盖核心路径

**Files:**
- Create: `src/backtest/smokeChoppiness.ts`

仿照 `src/backtest/smokeRescoreTrend.ts` 的"自带 assert + console.log + ts-node 直接跑"模式（项目无 jest，CLAUDE.md 已警告）。

- [ ] **Step 1: 写 7 个核心 case**

```typescript
/**
 * choppiness 评分函数的 smoke 验证。
 *
 * 跑法:
 *   TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
 *     npx ts-node --transpile-only src/backtest/smokeChoppiness.ts
 */
import { scoreChoppiness, ChoppinessParams } from '../core/indicators/choppiness';

function assert(cond: boolean, msg: string) {
    if (!cond) throw new Error('ASSERT FAIL: ' + msg);
}

/** 构造 duck-typed Candlestick（只用 close，其他字段不读） */
function makeBars(closes: number[]): any[] {
    return closes.map(c => ({
        close: { toNumber: () => c },
        open: { toNumber: () => c },
        high: { toNumber: () => c },
        low: { toNumber: () => c },
        volume: 0,
        turnover: { toNumber: () => 0 },
        timestamp: new Date(),
        tradeSession: 0,
    }));
}

const PARAMS: ChoppinessParams = {
    windowBars: 30,
    bandAtrRatios: [0.1, 0.2, 0.3],
};

// ============================================================
// Case 1: warmup —— bars 不足时返回 null
// ============================================================
(function caseWarmup() {
    console.log('Running case 1: warmup returns null');
    const bars = makeBars(new Array(29).fill(100));
    const result = scoreChoppiness(bars, 100, 1, PARAMS);
    assert(result === null, `expected null, got ${JSON.stringify(result)}`);
    console.log('  case 1 PASS');
})();

// ============================================================
// Case 2: 防御性输入 —— atr<=0 / vwap<=0 返回 null
// ============================================================
(function caseInvalidInputs() {
    console.log('Running case 2: invalid inputs return null');
    const bars = makeBars(new Array(30).fill(100));
    assert(scoreChoppiness(bars, 100, 0, PARAMS) === null, 'atr=0 should be null');
    assert(scoreChoppiness(bars, 100, -1, PARAMS) === null, 'atr<0 should be null');
    assert(scoreChoppiness(bars, 0, 1, PARAMS) === null, 'vwap=0 should be null');
    assert(scoreChoppiness(bars, NaN, 1, PARAMS) === null, 'vwap=NaN should be null');
    console.log('  case 2 PASS');
})();

// ============================================================
// Case 3: 纯多头单边 —— 30 根全在 VWAP 上方，满分 70
//   crossings=0 → 40 分
//   带外（|close-vwap|=1.0 远大于 0.3*atr=0.3）→ inBand 全 0 → 30 分
// ============================================================
(function caseStrongTrend() {
    console.log('Running case 3: strong long trend → 70/70');
    const bars = makeBars(new Array(30).fill(101)); // close=101，vwap=100，atr=1
    const result = scoreChoppiness(bars, 100, 1, PARAMS);
    assert(result !== null, 'should not be null');
    assert(result!.total === 70, `expected total=70, got ${result!.total}`);
    assert(result!.crossings === 40, `expected crossings=40, got ${result!.crossings}`);
    assert(result!.bandRatio === 30, `expected bandRatio=30, got ${result!.bandRatio}`);
    assert(result!.details.crossingCount === 0, `expected count=0, got ${result!.details.crossingCount}`);
    assert(result!.details.crossingRate === 0, `expected rate=0, got ${result!.details.crossingRate}`);
    console.log('  case 3 PASS');
})();

// ============================================================
// Case 4: 死震荡 —— 上下交替 +1/-1，crossings=29，rate≈1.0 → 0 分
//   close 取 vwap ± 0.05*atr，全在 0.1 带内 → 三档全是 1.0 → 全 0 分
// ============================================================
(function caseDeadChop() {
    console.log('Running case 4: dead chop → 0/70');
    const closes: number[] = [];
    for (let i = 0; i < 30; i++) {
        closes.push(i % 2 === 0 ? 100.05 : 99.95); // ±0.05，atr=1
    }
    const result = scoreChoppiness(makeBars(closes), 100, 1, PARAMS);
    assert(result !== null, 'should not be null');
    assert(result!.total === 0, `expected total=0, got ${result!.total}`);
    assert(result!.details.crossingCount === 29, `expected count=29, got ${result!.details.crossingCount}`);
    assert(result!.details.inBandRatios.every(r => r === 1), `expected all 1, got ${result!.details.inBandRatios}`);
    console.log('  case 4 PASS');
})();

// ============================================================
// Case 5: 一次大反转 —— 前 15 根 +1、后 15 根 -1
//   crossings=1，rate≈0.034 → 40 分（边界示例对齐 spec §3.1）
//   close 距离 vwap=2 远大于 0.3*atr=0.3 → 三档全 0 → 30 分
//   总分 70
// ============================================================
(function caseSingleReversal() {
    console.log('Running case 5: single reversal → 70/70');
    const closes = [
        ...new Array(15).fill(102),
        ...new Array(15).fill(98),
    ];
    const result = scoreChoppiness(makeBars(closes), 100, 1, PARAMS);
    assert(result !== null, 'should not be null');
    assert(result!.details.crossingCount === 1, `expected count=1, got ${result!.details.crossingCount}`);
    assert(result!.crossings === 40, `expected crossings=40, got ${result!.crossings}`);
    assert(result!.total === 70, `expected total=70, got ${result!.total}`);
    console.log('  case 5 PASS');
})();

// ============================================================
// Case 6: close 恰好等于 vwap —— side=0 跳过比对
//   构造序列 +1, 0, -1 重复 10 组（30 根）
//   每组内 +1→0(跳)→-1：因为 0 跳过比对，prevSide 留在 +1，到 -1 时算 1 次穿越
//   组与组之间：上一组末尾 -1 → 下一组开头 +1 算 1 次穿越
//   10 组内 10 次穿越 + 9 个组间 9 次穿越 = 19 次
// ============================================================
(function caseEqualVwap() {
    console.log('Running case 6: close == vwap is skipped');
    const closes: number[] = [];
    for (let i = 0; i < 10; i++) {
        closes.push(101, 100, 99);
    }
    const result = scoreChoppiness(makeBars(closes), 100, 1, PARAMS);
    assert(result !== null, 'should not be null');
    assert(result!.details.crossingCount === 19, `expected count=19, got ${result!.details.crossingCount}`);
    console.log('  case 6 PASS');
})();

// ============================================================
// Case 7: 跨 window 评分可比性 —— 同样的"穿越频率约 40%"在 N=15 和 N=30 都得 0 分
// ============================================================
(function caseWindowComparable() {
    console.log('Running case 7: cross-window comparability');
    // N=30, 大致 12 次切换 → rate ≈ 0.41 > 0.25 → 0 分
    const long = makeBars(
        Array.from({ length: 30 }, (_, i) => i % 5 < 2 ? 101 : 99)
    );
    const r1 = scoreChoppiness(long, 100, 1, { ...PARAMS, windowBars: 30 });
    assert(r1 !== null, 'r1 not null');

    // N=15, 大致 6 次切换 → rate ≈ 0.43 > 0.25 → 0 分
    const short = makeBars(
        Array.from({ length: 15 }, (_, i) => i % 5 < 2 ? 101 : 99)
    );
    const r2 = scoreChoppiness(short, 100, 1, { ...PARAMS, windowBars: 15 });
    assert(r2 !== null, 'r2 not null');

    assert(r1!.crossings === 0, `r1 crossings expected 0, got ${r1!.crossings}`);
    assert(r2!.crossings === 0, `r2 crossings expected 0, got ${r2!.crossings}`);
    console.log('  case 7 PASS');
})();

console.log('\n✅ choppiness smoke all pass');
```

- [ ] **Step 2: 跑 smoke 测试**

Run:
```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
  TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/smokeChoppiness.ts
```

Expected: 7 个 case 全部 PASS，最后输出 `✅ choppiness smoke all pass`。

如果 case 6 的 `crossingCount` 与预期不符，是 spec "side===0 跳过" 的实现细节没对齐——需要回 Task 1 调 `prevSide` 维护逻辑（spec 原话：side[i] === 0 时跳过该次比对）。

- [ ] **Step 3: Commit**

```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
  git add src/core/indicators/choppiness.ts src/backtest/smokeChoppiness.ts && \
  git commit -m "feat: 新增 B2-lite 日内震荡评分函数 scoreChoppiness

纯函数，实盘和回测共用。满分 70：
- 指标 1：VWAP 穿越频率（权重 40，跨 window 可比）
- 指标 2：带内时长比（权重 30，三档独立加权 0.1/0.2/0.3 ATR）

附 7 个 smoke case：warmup / 防御性输入 / 强趋势 / 死震荡 /
单次大反转 / close==vwap 跳过 / 跨 window 评分可比性。

Spec: docs/superpowers/specs/2026-04-22-b2-lite-choppiness-filter-design.md (v3)"
```

---

## Task 3：扩展 config + StrategyConfig 类型

**Files:**
- Modify: `src/config/strategy.config.ts:116-123`（filters 块）+ 134 行后插入 choppiness 配置块

- [ ] **Step 1: 在 filters 加 enableChoppiness 字段**

找到现有 `filters: { ... }` 块，加一行：

```typescript
filters: {
    enableRsiFilter: false,
    enableVolumeFilter: false,
    enableEntryPhaseFilter: false,
    enableIndexTrendFilter: false,
    enableTrendDetector: true,
    enableSlopeMomentum: false,
    enableChoppiness: false, // B2-lite 日内震荡过滤；默认关闭，AB 切回旧行为
},
```

- [ ] **Step 2: 在 filters 块下方加 choppiness 配置块**

在 `slopeMomentumThreshold` 那一行之后（约 134 行），加：

```typescript
// ========================
// 日内震荡过滤（B2-lite，仅在 filters.enableChoppiness=true 时生效）
// 评分组成：VWAP穿越频率(40) + 带内时长比(30，三档加权) = 满分 70
// 评分跨 windowBars 可比（指标 1 用频率而非次数，指标 2 是百分比）
// ========================
choppiness: {
    windowBars: 30,                    // 滚动窗口（根 K），回测扫 30/20/15
    bandAtrRatios: [0.1, 0.2, 0.3],   // 三档带宽
    scoreThreshold: 25,                // 总分 < 阈值禁开仓（0–70）
},
```

- [ ] **Step 3: 验证 TS 类型**

Run:
```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
  TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only -e "import config from './src/config/strategy.config'; console.log(config.filters.enableChoppiness, config.choppiness.windowBars, config.choppiness.scoreThreshold);"
```

Expected: `false 30 25`

`StrategyConfig` 类型定义在 `src/interface/config.ts` 是 `typeof strategyConfig`，自动包含新字段，不用手改。

- [ ] **Step 4: Commit**

```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
  git add src/config/strategy.config.ts && \
  git commit -m "feat: config 新增 enableChoppiness 开关 + choppiness 参数块

默认 enableChoppiness=false，对线上零影响。
- windowBars: 30
- bandAtrRatios: [0.1, 0.2, 0.3]
- scoreThreshold: 25"
```

---

## Task 4：接入 `vwapStrategy.canOpen` + `onBar`

**Files:**
- Modify: `src/strategy/vwapStrategy.ts`

- [ ] **Step 1: 在文件顶部 import**

文件第 22-23 行附近（紧跟其他 indicator 的 import）加：

```typescript
import { scoreChoppiness, ChoppinessScore } from "../core/indicators/choppiness";
```

- [ ] **Step 2: 给 canOpen 加参数 + 判定 + 日志**

修改 `canOpen` 签名（127-136 行），最后加一个参数：

```typescript
canOpen(
    symbol: string,
    preBars: Candlestick[],
    vwap: number,
    atr: number,
    rsi: number | null,
    volumeRatio: number | null,
    indexSlope: number | null,
    symbolSlope: number | null,
    chopScore: ChoppinessScore | null,  // 新增
)
```

在 `momentumOk` 计算之后（约 263 行后），加 chopOk 判定：

```typescript
// 10) 日内震荡评分过滤（B2-lite）
const isChopEnabled = filters.enableChoppiness;
const chopThreshold = this.config.choppiness.scoreThreshold;
const chopOk =
    !isChopEnabled ||
    chopScore === null || // warmup 期放行
    chopScore.total >= chopThreshold;

const chopRule = !isChopEnabled
    ? '震荡过滤=关闭'
    : `阈值total>=${chopThreshold}`;
const chopResult = !isChopEnabled
    ? '不参与'
    : chopScore === null
        ? '跳过(warmup)'
        : chopOk
            ? '通过'
            : '不通过';
const chopValueStr = chopScore === null
    ? 'null'
    : `${chopScore.total}/70 (穿越=${chopScore.crossings}/40 带内=${chopScore.bandRatio}/30)`;
```

把 `logEntryPriceTriggerOnce` 的 params 接口扩展（约 79-99 行），加三个字段：`chopValueStr`, `chopRule`, `chopResult`。然后两处调用处（多/空）都传入。修改 `logEntryPriceTriggerOnce` 内部 `logger.info` 模板末尾，在 `poolRule` 行前插入：

```typescript
`  震荡评分: ${params.chopValueStr} ${params.chopRule} 结果=${params.chopResult}\n` +
```

修改最终判定逻辑（约 372-390 行）的 `allow` 计算，把 `chopOk` 加到 `&&` 链里：

```typescript
if (longPriceTrigger) {
    const allow =
        allowLong &&
        (shouldCheckIndicators ? longRsiOk && volumeOk : true) &&
        slopeOkLong &&
        momentumOk &&
        chopOk;  // 新增
    if (allow) dir = OrderSide.Buy;
} else if (shortPriceTrigger) {
    const allow =
        allowShort &&
        (shouldCheckIndicators ? shortRsiOk && volumeOk : true) &&
        slopeOkShort &&
        momentumOk &&
        chopOk;  // 新增
    if (allow) dir = OrderSide.Sell;
}
```

同步修改两处 `logEntryPriceTriggerOnce` 内 `allow` 字段的 `longEntryAllow` / `shortEntryAllow` 计算（约 277-281 行 / 322-326 行），同样加 `&& chopOk`。

- [ ] **Step 3: 在 onBar 里算 chopScore 并传入**

在 `onBar` 方法里（约 404-471 行），找到现有的 `symbolSlope` 计算之后、调 `canOpen` 之前，加：

```typescript
// 日内震荡评分（B2-lite，仅在启用时算）
const chopScore = filters.enableChoppiness
    ? scoreChoppiness(
          closedBars.slice(-this.config.choppiness.windowBars),
          vwap,
          atr,
          {
              windowBars: this.config.choppiness.windowBars,
              bandAtrRatios: this.config.choppiness.bandAtrRatios,
          },
      )
    : null;
```

注意用 `closedBars`（不是 `preBars`）—— `preBars` 只取了 `rsiPeriod + 1` 根，不够 30 根。

修改 `canOpen` 调用：

```typescript
const dir = this.canOpen(
    symbol,
    preBars,
    vwap,
    atr,
    rsi,
    volumeRatio,
    indexSlope,
    symbolSlope,
    chopScore,  // 新增
);
```

- [ ] **Step 4: 验证编译 + 默认开关下行为不变**

Run:
```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
  TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only -e "
import VWAPStrategy from './src/strategy/vwapStrategy';
import { RiskManager } from './src/core/risk';
import config from './src/config/strategy.config';
const s = new VWAPStrategy(config, new RiskManager(0.02));
console.log('strategy ok, enableChoppiness=', config.filters.enableChoppiness);
"
```

Expected: `strategy ok, enableChoppiness= false`

- [ ] **Step 5: Commit**

```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
  git add src/strategy/vwapStrategy.ts && \
  git commit -m "feat: VWAPStrategy 接入 B2-lite 震荡评分过滤

- canOpen 增加 chopScore 参数，与 RSI/量比/动量过滤器并联
- onBar 在 enableChoppiness=true 时算 scoreChoppiness 并传入
- 入场触发日志增加震荡评分行（total/70 + 分项分 + 阈值 + 结果）
- 用 closedBars（非 preBars）保证窗口够 30 根
- 默认 enableChoppiness=false，对线上零影响"
```

---

## Task 5：扩展 BacktestTrade 类型

**Files:**
- Modify: `src/backtest/types.ts`

- [ ] **Step 1: 在 BacktestTrade 加 entryChopScore 字段**

在 `BacktestTrade` 接口的 `entryDayScoreDetail` 字段之后（约 78 行前的 `}` 之前），加：

```typescript
    /**
     * 入场当日该 trade 的 B2-lite 震荡评分快照（成交那一刻）。
     * - 数值 = 评分对象（total / 分项分 / details）
     * - null = 评分关闭，或 warmup 期未评分
     * - 旧 result json 不存在此字段，读脚本应用 `t.entryChopScore ?? null` 兼容
     */
    entryChopScore?: {
        total: number;
        crossings: number;
        bandRatio: number;
        details: {
            crossingCount: number;
            crossingRate: number;
            inBandRatios: number[];
        };
    } | null;
```

- [ ] **Step 2: 验证编译**

Run:
```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
  TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only -e "
import { BacktestTrade } from './src/backtest/types';
const t: BacktestTrade = {
    symbol: 'X', side: 'Buy', entryTimestamp: 0, entryPrice: 0,
    exitTimestamp: 0, exitPrice: 0, exitReason: 'TP',
    initialRisk: 1, rMultiple: 0, phaseAtEntry: 'main', ambiguousExit: false,
    entryChopScore: null,
};
console.log('type ok');
"
```

Expected: `type ok`

- [ ] **Step 3: 不 commit，等 Task 6 一起 commit**

理由：单独的类型扩展没有调用方就是 dead code。

---

## Task 6：runner 接入 chopScore + CLI flag

**Files:**
- Modify: `src/backtest/runner.ts`

- [ ] **Step 1: import scoreChoppiness**

在文件顶部 import 区（约 50-67 行）加：

```typescript
import { scoreChoppiness } from '../core/indicators/choppiness';
```

- [ ] **Step 2: 在 RunnerOptions 加字段**

修改 `RunnerOptions.filters` 类型（约 129-135 行），加一个字段：

```typescript
filters?: Partial<{
    enableRsiFilter: boolean;
    enableVolumeFilter: boolean;
    enableEntryPhaseFilter: boolean;
    enableIndexTrendFilter: boolean;
    enableTrendDetector: boolean;
    enableChoppiness: boolean;  // 新增
}>;
```

在 `RunnerOptions` 接口里加两个独立 override 字段（约 140 行后的 `disableTrendIndicators?` 之前）：

```typescript
/** 覆盖 choppiness.windowBars，runBacktest 结束时恢复 */
chopWindowBars?: number;
/** 覆盖 choppiness.scoreThreshold，runBacktest 结束时恢复 */
chopScoreThreshold?: number;
```

- [ ] **Step 3: 在 runBacktest 开头 save + override choppiness 配置**

紧跟 `savedFilters` 那段（约 331-334 行）之后，加：

```typescript
// 临时覆盖 choppiness 配置（runner finally 恢复）
const savedChopWindow = config.choppiness.windowBars;
const savedChopThreshold = config.choppiness.scoreThreshold;
if (opts.chopWindowBars !== undefined) {
    config.choppiness.windowBars = opts.chopWindowBars;
}
if (opts.chopScoreThreshold !== undefined) {
    config.choppiness.scoreThreshold = opts.chopScoreThreshold;
}
```

在末尾恢复 config 的位置（约 873-876 行）加：

```typescript
config.choppiness.windowBars = savedChopWindow;
config.choppiness.scoreThreshold = savedChopThreshold;
```

- [ ] **Step 4: 修改 pendingEntry 类型支持携带 chopScore**

修改 `pendingEntry` 类型（约 448 行）：

```typescript
const pendingEntry: Record<string, { side: OrderSide; chopScore: BacktestTrade['entryChopScore'] }> = {};
```

- [ ] **Step 5: 在回测主循环算 chopScore + 设置 pendingEntry**

找到信号检测段（约 744-796 行），在 `symbolSlope` 计算之后、`canOpen` 调用之前，加：

```typescript
// 日内震荡评分（B2-lite，仅在启用时算，与 onBar 完全对齐）
const chopScore = config.filters.enableChoppiness
    ? scoreChoppiness(
          fakeBars.slice(-config.choppiness.windowBars),
          vwap,
          a,
          {
              windowBars: config.choppiness.windowBars,
              bandAtrRatios: config.choppiness.bandAtrRatios,
          },
      )
    : null;
```

修改 `strategy.canOpen` 调用（约 787-796 行）：

```typescript
let dir = strategy.canOpen(
    symbol,
    preBars as any,
    vwap,
    a,
    rsi,
    volumeRatio,
    indexSlope,
    symbolSlope,
    chopScore,  // 新增
);
```

修改设置 pendingEntry 的两处（约 840-851 行）：

```typescript
const chopSnapshot: BacktestTrade['entryChopScore'] = chopScore
    ? {
          total: chopScore.total,
          crossings: chopScore.crossings,
          bandRatio: chopScore.bandRatio,
          details: chopScore.details,
      }
    : null;
if (trendDetectorEnabled) {
    const scoreInfo = dayScoreMap[symbol];
    const threshold = opts.trendThreshold ?? TREND_SCORE_THRESHOLD;
    if (scoreInfo === null) {
        pendingEntry[symbol] = { side: dir, chopScore: chopSnapshot };
    } else if (
        scoreInfo &&
        typeof scoreInfo === 'object' &&
        scoreInfo.total >= threshold
    ) {
        pendingEntry[symbol] = { side: dir, chopScore: chopSnapshot };
    }
} else {
    pendingEntry[symbol] = { side: dir, chopScore: chopSnapshot };
}
```

- [ ] **Step 6: 在 Position 接口里加 entryChopScore 字段**

修改 `Position` 接口（约 259-272 行）末尾加：

```typescript
/** 入场时的 chopScore 快照，写入 BacktestTrade.entryChopScore */
entryChopScore: BacktestTrade['entryChopScore'];
```

- [ ] **Step 7: 在创建 Position 时记录 chopScore 快照**

修改读 pendingEntry 的位置（约 634-636 行）：

```typescript
if (!positions[symbol] && pendingEntry[symbol]) {
    const { side, chopScore: entryChop } = pendingEntry[symbol];
    delete pendingEntry[symbol];
    // ... 后续代码不变 ...
```

在创建 newPos 时（约 662-693 行）`entryDayScoreDetail` 之后加：

```typescript
entryChopScore: entryChop,
```

- [ ] **Step 8: 在 closeTrade 写入 trade log**

`closeTrade` 函数里（约 466-494 行）trades.push 的对象加一行：

```typescript
trades.push({
    // ... 现有字段 ...
    entryDayScore: pos.entryDayScore,
    entryDayScoreDetail: pos.entryDayScoreDetail,
    entryChopScore: pos.entryChopScore,  // 新增
});
```

- [ ] **Step 9: 加 CLI flags**

修改 `main()` 函数。Usage 错误信息里（约 941-948 行）加：

```
'  [--filter-choppiness=on|off] [--chop-window=N] [--chop-threshold=N]\n'
```

在 `parseFilterFlag` 调用区（约 960-969 行）加：

```typescript
const chop = parseFilterFlag('filter-choppiness');
if (chop !== undefined) filterOverride.enableChoppiness = chop;
```

在 opts 构造区（约 1011-1031 行）加两个字段：

```typescript
chopWindowBars:
    flags['chop-window'] !== undefined
        ? Number(flags['chop-window'])
        : undefined,
chopScoreThreshold:
    flags['chop-threshold'] !== undefined
        ? Number(flags['chop-threshold'])
        : undefined,
```

- [ ] **Step 10: 用 baseline 跑一次回测验证不破坏现状**

Run:
```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
  TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts smoke_baseline trailing
```

Expected:
- 命令成功退出
- 输出包含 `[runner] 完成 smoke_baseline 交易数=...`
- `data/backtest/results/smoke_baseline.json` 生成
- 由于 `enableChoppiness=false` 默认未启用，trade 数应当与 commit 之前的 baseline 一致（相对偏差 < 1%；如果有差就是 bug）

如有差异，对比上一次 baseline 文件，定位是不是 chopScore 误算导致 canOpen 多拒了某些信号。

- [ ] **Step 11: 用 enableChoppiness=on 跑一次冒烟验证 chopScore 写入了 trade**

Run:
```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
  TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts smoke_chop_on trailing --filter-choppiness=on --chop-threshold=25
```

Expected: 完成。然后查 trade log：

```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
  node -e "
const r = require('./data/backtest/results/smoke_chop_on.json');
const withChop = r.trades.filter(t => t.entryChopScore != null);
console.log('total trades:', r.trades.length, '| with chopScore:', withChop.length);
if (withChop.length > 0) {
    const sample = withChop[0];
    console.log('sample:', JSON.stringify(sample.entryChopScore, null, 2));
}
"
```

Expected: 大部分 trade 的 entryChopScore 不为 null（warmup 期 trade 才会是 null）；sample 输出 total / crossings / bandRatio / details 字段齐全。

- [ ] **Step 12: Commit**

```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
  git add src/backtest/types.ts src/backtest/runner.ts && \
  git commit -m "feat: backtest runner 集成 B2-lite 震荡评分

- BacktestTrade 加 entryChopScore optional 字段（旧 json 兼容）
- runner 主循环算 chopScore 并传给 canOpen（与 onBar 口径完全对齐）
- pendingEntry 同时存 side + chopScore，成交时写入 Position 和 trade log
- CLI flag: --filter-choppiness=on|off / --chop-window=N / --chop-threshold=N
- RunnerOptions 加 chopWindowBars / chopScoreThreshold，finally 恢复 config

冒烟验证：
- baseline 不变（enableChoppiness=false 默认未启用）
- on 模式 trade log 内 entryChopScore 字段齐全"
```

---

## Task 7：写网格搜索驱动脚本

**Files:**
- Create: `src/backtest/runChopExperiment.ts`

- [ ] **Step 1: 写驱动脚本**

```typescript
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
import { BacktestResult, BacktestTrade } from './types';

const RESULT_DIR = path.resolve(process.cwd(), 'data/backtest/results');

const WINDOWS = [30, 20, 15];
const THRESHOLDS = [15, 20, 25, 30, 35];

interface Stat {
    label: string;
    window: number | null;       // null = baseline
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

function stat(label: string, window: number | null, threshold: number | null, trades: BacktestTrade[]): Stat {
    const rs = trades.map(t => t.rMultiple);
    const wins = rs.filter(r => r > 0).length;
    return {
        label, window, threshold,
        trades: trades.length,
        cumR: rs.reduce((s, r) => s + r, 0),
        winRate: trades.length > 0 ? wins / trades.length : 0,
        avgR: trades.length > 0 ? rs.reduce((s, r) => s + r, 0) / trades.length : 0,
        medianR: median(rs),
    };
}

async function main() {
    const stats: Stat[] = [];

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
            console.log(`\n=== Running ${label} ===`);
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
    function buildHeatmap(title: string, getValue: (s: Stat) => number, format: (v: number) => string): string {
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
    report += `标的数: ${baselineResult.symbolCount}\n\n`;
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
        .filter(s => s.cumR >= baseline.cumR * 0.8)
        .sort((a, b) => b.avgR - a.avgR);
    report += `\n通过 cumR 门槛的配置（按 avgR 降序）:\n\n`;
    report += `| 配置 | trades | cumR | cumR% | 胜率 | 平均R | 中位R |\n`;
    report += `|---|---|---|---|---|---|---|\n`;
    for (const s of candidates.slice(0, 5)) {
        const cumPct = baseline.cumR !== 0 ? (s.cumR / baseline.cumR * 100).toFixed(1) + '%' : 'N/A';
        report += `| ${s.label} | ${s.trades} | ${s.cumR.toFixed(1)} | ${cumPct} | ${(s.winRate * 100).toFixed(1)}% | ${s.avgR.toFixed(3)} | ${s.medianR.toFixed(3)} |\n`;
    }

    const outPath = path.join(RESULT_DIR, 'chop_experiment_summary.md');
    fs.writeFileSync(outPath, report);
    console.log('\n\n' + report);
    console.log(`\n[chop-experiment] 报告写入 ${path.relative(process.cwd(), outPath)}`);
}

main().then(() => process.exit(0)).catch(e => {
    console.error(e);
    process.exit(1);
});
```

- [ ] **Step 2: 跑驱动脚本**

注意：这一步会跑 16 次回测，**总耗时可能 30 分钟到数小时**（取决于现有 baseline 单次回测的时长 + 数据量）。

Run:
```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
  TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runChopExperiment.ts 2>&1 | tee data/backtest/results/chop_experiment.log
```

Expected:
- 16 次回测全部完成（每次输出 `[runner] 完成 chop_xxx 交易数=...`）
- 最后输出 markdown 报告（控制台 + 写入 `data/backtest/results/chop_experiment_summary.md`）
- 报告包含 5 张热力表 + 候选最优配置表

如果中途 OOM 或报错，可以拆成几次跑（手动改 WINDOWS / THRESHOLDS 数组）。

- [ ] **Step 3: 人工 review 报告**

打开 `data/backtest/results/chop_experiment_summary.md`，按 spec 评估口径检查：

1. **平均 R / trade 表**：是否有明显高于 baseline 的格子？
2. **胜率表**：是否同步提升？
3. **总交易数**：减少幅度合理吗？（应该至少 -10%，否则过滤太弱）
4. **cumR 表**：候选配置 cumR 跌幅是否在 20% 内？

如果 **没有任何配置同时满足"per-trade R 提升 + cumR 跌幅 < 20%"**：
- → 回到 spec 第 9 节风险表，可能需要降阈值再扫一轮（如扫 10/15/20）或重新审视指标 2 三档加权设计。

如果 **有候选配置**：进入 Task 8 分段验证。

- [ ] **Step 4: Commit 实验报告**

```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
  git add src/backtest/runChopExperiment.ts data/backtest/results/chop_experiment_summary.md data/backtest/results/chop_experiment.log && \
  git commit -m "feat: B2-lite 二维网格回测脚本 + 一年样本实验结果

3 windows (30/20/15) × 5 thresholds (15/20/25/30/35) + baseline = 16 次回测。

输出 5 张 3×5 热力表（trades / cumR / 胜率 / 平均R / 中位R）+ 候选最优配置表。
按 spec 评估口径筛选：per-trade R 优先 + cumR 跌幅 < 20%。

详见 data/backtest/results/chop_experiment_summary.md。"
```

---

## Task 8：分段验证（防过拟合）

**前置依赖**：Task 7 找到候选最优配置 (W*, T*)。如果 Task 7 没出候选，跳过本任务并回到设计阶段。

**Files:**
- Create: `src/backtest/runChopSplitValidation.ts`

- [ ] **Step 1: 写分段验证脚本**

```typescript
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
    const rs = trades.map(t => t.rMultiple);
    const wins = rs.filter(r => r > 0).length;
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
    console.error('Usage: runChopSplitValidation.ts <label>  (e.g. chop_W30_T25)');
    process.exit(1);
}

const candidatePath = path.resolve(process.cwd(), `data/backtest/results/${label}.json`);
const baselinePath = path.resolve(process.cwd(), `data/backtest/results/chop_baseline.json`);
if (!fs.existsSync(candidatePath)) {
    console.error(`missing ${candidatePath}, run runChopExperiment.ts first`);
    process.exit(1);
}

const candidate: BacktestResult = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
const baseline: BacktestResult = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

// 找时间中点（用 candidate 的 trade 时间分布算）
const allTs = candidate.trades.map(t => t.entryTimestamp).sort((a, b) => a - b);
if (allTs.length === 0) {
    console.error('candidate has no trades, abort');
    process.exit(1);
}
const midTs = allTs[Math.floor(allTs.length / 2)];
console.log(`分段中点: ${new Date(midTs).toISOString().slice(0, 10)}`);

const splitFront = (trades: BacktestTrade[]) => trades.filter(t => t.entryTimestamp < midTs);
const splitBack = (trades: BacktestTrade[]) => trades.filter(t => t.entryTimestamp >= midTs);

const baseFront = stat('baseline-front', splitFront(baseline.trades));
const baseBack = stat('baseline-back', splitBack(baseline.trades));
const candFront = stat(`${label}-front`, splitFront(candidate.trades));
const candBack = stat(`${label}-back`, splitBack(candidate.trades));

const rows = [baseFront, baseBack, candFront, candBack];
console.log('\n| 分段 | trades | cumR | 胜率 | 平均R | 中位R |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) {
    console.log(`| ${r.name} | ${r.n} | ${r.cumR.toFixed(1)} | ${(r.winRate * 100).toFixed(1)}% | ${r.avgR.toFixed(3)} | ${r.medianR.toFixed(3)} |`);
}

// 过拟合判定：候选配置在前后段的 avgR 提升幅度对比
const gainFront = candFront.avgR - baseFront.avgR;
const gainBack = candBack.avgR - baseBack.avgR;
console.log(`\n前段 avgR 提升: ${gainFront.toFixed(4)}`);
console.log(`后段 avgR 提升: ${gainBack.toFixed(4)}`);
if (gainFront > 0 && gainBack < gainFront / 2) {
    console.log(`\n⚠️  过拟合警告：后段提升 < 前段一半。建议回设计阶段降复杂度。`);
} else if (gainBack > 0) {
    console.log(`\n✅  分段验证通过：候选配置在后段仍有正提升。`);
} else {
    console.log(`\n❌  后段无正提升：候选配置不可上线。`);
}
```

- [ ] **Step 2: 用 Task 7 选出的最优 label 跑分段验证**

Run（替换 `<label>` 为 Task 7 选出的最优）：

```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
  TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runChopSplitValidation.ts <label>
```

Expected: 输出 4 行表格 + 过拟合判定。

- [ ] **Step 3: Commit**

```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
  git add src/backtest/runChopSplitValidation.ts && \
  git commit -m "feat: B2-lite 分段验证脚本（防过拟合）

把 chop_W{W}_T{T}.json 的 trades 按 entryTimestamp 切前后两半，
对比 baseline 的同样切法，看候选配置在前/后段的 avgR 提升是否对称。

判定：后段提升 < 前段一半 → 过拟合警告。"
```

---

## Task 9：bad_case 复盘

**Files:**
- Create: `src/backtest/inspectBadCase.ts`

- [ ] **Step 1: 写复盘脚本**

bad_case 的票是 CRDO / INTC / MRVL，对应 examples/bad_case/ 三张图。脚本"列出这三个 symbol 在 baseline 和候选配置下的所有 trade，按入场日聚合"，挑震荡日（baseline trades >= 3）对比。

```typescript
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
    return JSON.parse(fs.readFileSync(
        path.resolve(process.cwd(), `data/backtest/results/${name}.json`), 'utf8'
    ));
}
const baseline = load('chop_baseline');
const candidate = load(label);

function dayKey(ts: number) {
    return new Date(ts).toISOString().slice(0, 10);
}

interface DayStat { day: string; trades: number; cumR: number; }

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
    const candMap = Object.fromEntries(cand.map(d => [d.day, d]));

    const bad = base.filter(d => d.trades >= 3);
    console.log(`  疑似震荡日（baseline trades >= 3）: ${bad.length} 天`);
    console.log(`  | 日期 | base trades | base cumR | cand trades | cand cumR | 减少 |`);
    console.log(`  |---|---|---|---|---|---|`);
    for (const d of bad) {
        const c = candMap[d.day] ?? { trades: 0, cumR: 0 };
        const reduce = d.trades - c.trades;
        console.log(`  | ${d.day} | ${d.trades} | ${d.cumR.toFixed(2)} | ${c.trades} | ${c.cumR.toFixed(2)} | -${reduce} |`);
    }

    const baseSum = base.reduce((s, d) => ({ trades: s.trades + d.trades, cumR: s.cumR + d.cumR }), { trades: 0, cumR: 0 });
    const candSum = cand.reduce((s, d) => ({ trades: s.trades + d.trades, cumR: s.cumR + d.cumR }), { trades: 0, cumR: 0 });
    console.log(`  total: base trades=${baseSum.trades} cumR=${baseSum.cumR.toFixed(2)} | cand trades=${candSum.trades} cumR=${candSum.cumR.toFixed(2)}`);
}
```

- [ ] **Step 2: 跑复盘**

```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
  TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/inspectBadCase.ts <bestLabel>
```

Expected: 三张表（每个 symbol 一张），列出"疑似震荡日"的 trade 数对比。

**人工判断**：候选配置是不是在这些震荡日把 trade 数减少了一大半但没把"赚钱日"也拦掉？

- [ ] **Step 3: Commit**

```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
  git add src/backtest/inspectBadCase.ts && \
  git commit -m "feat: B2-lite bad_case 复盘脚本

对比 CRDO/INTC/MRVL 在 baseline vs 最优配置下每个交易日的
trade 数和 cumR，确认震荡日的过滤效果。"
```

---

## Task 10：根据回测结果决定上线参数

**Files:**
- Modify: `src/config/strategy.config.ts`（如决定上线）
- Create: `references/B2-LITE.md`（如决定上线）
- Modify: `CLAUDE.md`（如决定上线）

- [ ] **Step 1: 三个判定路径**

根据 Task 7-9 结果选其一：

**路径 A：直接上线**（理想情况）
- Task 7 找到候选 (W*, T*)
- Task 8 分段验证通过
- Task 9 bad_case 显著改善
→ 进入 Step 2

**路径 B：用更保守参数上线**
- Task 7 候选 cumR 跌幅 > 15% 但 per-trade R 显著提升
- Task 8 后段提升弱但仍正
→ 用候选 (W*, T*) 但把 threshold 再调严一档（如 T* → T*+5），跑一次单点回测确认（用 runner 直接 `--filter-choppiness=on --chop-window=W* --chop-threshold=新值`），进入 Step 2

**路径 C：不上线，回 spec**
- Task 7 没找到任何 cumR 跌幅 < 20% 且 per-trade R 提升的配置
- Task 8 严重过拟合
→ 不修改 enableChoppiness（保持 false），把实验报告留作记录，回到 spec 第 9 节风险表评估是否需要重新设计指标。**结束本计划**，记录学到的经验。

- [ ] **Step 2: 修改 config 上线参数（路径 A/B 才走这步）**

修改 `src/config/strategy.config.ts`：

```typescript
filters: {
    // ...
    enableChoppiness: true,  // 上线
},
choppiness: {
    windowBars: <W*>,        // Task 7-8 选定
    bandAtrRatios: [0.1, 0.2, 0.3],
    scoreThreshold: <T*>,    // Task 7-8 选定
},
```

- [ ] **Step 3: 写 references/B2-LITE.md（参考 references/TREND.md / BACKTEST.md 风格）**

```markdown
# B2-lite 日内震荡过滤器

## 决策记录

- 上线日期：YYYY-MM-DD
- 配置：windowBars=<W*>, scoreThreshold=<T*>, bandAtrRatios=[0.1, 0.2, 0.3]
- 一年样本回测结果：trade 数 X→Y (-Z%)，cumR W→V (-U%)，平均 R 从 A→B (+C)，胜率从 D%→E%
- 分段验证：前段 avgR 提升=X，后段=Y，比值 Y/X = Z
- bad_case 复盘：CRDO/INTC/MRVL 震荡日 trade 数减少 X%

## 实现位置

- 评分函数：src/core/indicators/choppiness.ts
- 实盘集成：src/strategy/vwapStrategy.ts (canOpen + onBar)
- 回测集成：src/backtest/runner.ts
- 实验脚本：src/backtest/runChopExperiment.ts / runChopSplitValidation.ts / inspectBadCase.ts
- 设计文档：docs/superpowers/specs/2026-04-22-b2-lite-choppiness-filter-design.md

## 切回旧行为

把 config.filters.enableChoppiness 改回 false 即可。
评分函数本身保留（开关关闭时跳过算分，零成本）。

## 关键参数说明

windowBars 越小：
- warmup 越短（窗口够数越早，过滤越早开始）
- 评分对短期波动越敏感
- 跨 window 评分仍可比（指标 1 用频率）

scoreThreshold 越高：
- 过滤越严，trade 数下降越多
- per-trade 质量提升越多
- cumR 下降风险越大
```

- [ ] **Step 4: 修改 CLAUDE.md 添加引用**

在 CLAUDE.md 的"## 回测系统"段末尾"主要结论"小节添加一行（仿照已有的 batch A 描述）：

```markdown
- **B2-lite 上线**: enableChoppiness=true, windowBars=<W*>, scoreThreshold=<T*>，详见 references/B2-LITE.md
```

- [ ] **Step 5: Commit 上线**

```bash
cd /Users/bytedance/workspace/vwap_daytrade && \
  git add src/config/strategy.config.ts references/B2-LITE.md CLAUDE.md && \
  git commit -m "feat: B2-lite 日内震荡过滤上线 (W=<W*>, T=<T*>)

回测结果：
- 一年样本 trade X→Y (-Z%)
- cumR W→V (-U%)
- 平均 R A→B (+C)
- 胜率 D%→E%
- 分段验证后段提升=Y，前段比值 Z (>0.5 不过拟合)
- bad_case CRDO/INTC/MRVL 震荡日 trade 减少 X%

详见 references/B2-LITE.md。
切回旧行为：filters.enableChoppiness = false。"
```

---

## Self-Review Notes

完成全部 task 后做一次复盘：

**Spec coverage 检查**

| Spec 章节 | 对应 task |
|---|---|
| §3.1 指标 1 穿越频率 | Task 1 |
| §3.2 指标 2 带内时长比 | Task 1 |
| §3.3 总分门槛 | Task 1 + Task 4 |
| §4 时序 / warmup | Task 1（返回 null）+ Task 4（传 closedBars）|
| §5 配置项 | Task 3 |
| §6.1 choppiness.ts | Task 1 |
| §6.2 canOpen 集成 | Task 4 |
| §6.3 onBar 集成 | Task 4 |
| §6.4 runner 集成 | Task 5 + Task 6 |
| §7.1 二维网格 | Task 7 |
| §7.2 分段验证 | Task 8 |
| §7.3 bad_case 复盘 | Task 9 |

全部覆盖。

**Placeholders 检查**

spec 评估口径"per-trade R / 胜率优先 + cumR 跌幅 < 20%"在 Task 7 报告 / Task 10 决策路径中均已具体化为可执行判定。`<W*>` / `<T*>` 是回测产出的实际值，不是占位符（实施时由 Task 7 输出代入）。

**Type 一致性**

- `ChoppinessScore` 接口在 Task 1 / 4 / 5 / 6 全程一致
- `ChoppinessParams` 接口同样
- `BacktestTrade.entryChopScore` 字段在 Task 5 定义、Task 6 写入、Task 7-9 读取，字段名一致

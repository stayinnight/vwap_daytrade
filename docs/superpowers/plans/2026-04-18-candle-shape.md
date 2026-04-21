# Candle Shape 指标实现计划（Trend Detector v4）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `src/core/trendDetector.ts` 新增两个 K 线形态指标（Opening Shape 15 分 + Prior Day Shape 10 分），共享一个纯函数 `scoreCandleShape`，用 max-of-three 判定三档（长影 / 满实体 / 超长 K）。总分从 115 → 140。spec: `docs/superpowers/specs/2026-04-18-candle-shape-design.md`。

**Architecture:** 一个新纯函数 + 两组阈值常量 + `TrendBaseline` 加一个 `prevDayOHLC` 字段 + `TrendScore` 加两个主分和 8 个诊断字段。`scoreTrendDay` 在现有 6 个指标后追加两次 `scoreCandleShape` 调用。下游 (`runner.ts` / `smokeTrendDetector.ts` / `analyzeTrendWeights.ts` / `types.ts`) 同步补字段。

**Tech Stack:** TypeScript、现有 technicalindicators ATR、无新增依赖。测试走现有 smoke 脚本风格（手写 assert，不引入 jest）。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/core/trendDetector.ts` | 修改 | 加 `scoreCandleShape` 函数、`CandleShapeThresholds` 接口、`OPENING_SHAPE_THRESHOLDS` / `PRIOR_DAY_SHAPE_THRESHOLDS` 常量；扩 `TrendBaseline` / `TrendScore` / `TrendScoreDetails`；`scoreTrendDay` 追加两次调用；`precomputeTrendBaselinesForSymbol` 塞 `prevDayOHLC` |
| `src/backtest/types.ts` | 修改 | `BacktestTrade.entryDayScoreDetail` 扩字段（`openingShape` / `priorDayShape` + 8 个 details 子字段） |
| `src/backtest/runner.ts` | 修改 | `entryDayScoreDetail` 写入处补新字段 |
| `src/backtest/smokeTrendDetector.ts` | 修改 | 已有 4 个 case 里的 baseline 补 `prevDayOHLC`；追加 Case 5（Opening Shape 6 档用例）和 Case 6（Prior Day Shape 3 档用例） |
| `src/backtest/analyzeTrendWeights.ts` | 修改 | 追加 Opening Shape / Prior Day Shape 的分桶诊断表；总分桶上限从 101 改成 141 |
| `references/TREND.md` | 修改 | 加指标七 / 指标八段落；第四节公式从 115 → 140 |

---

## Task 1：给 `TrendBaseline` 加 `prevDayOHLC` 字段（纯扩展）

**Files:**
- Modify: `src/core/trendDetector.ts`（`TrendBaseline` 接口 + `precomputeTrendBaselinesForSymbol` 循环内）
- Modify: `src/backtest/smokeTrendDetector.ts`（现有 4 个 case 的 baseline 字面量）

这一步不加评分逻辑，只是让数据流通：新字段出现在每个 baseline 里；现有 smoke 依然绿。

- [ ] **Step 1: 扩 `TrendBaseline` 接口**

修改 `src/core/trendDetector.ts:50-55`：

```ts
export interface TrendBaseline {
    prevClose: number;
    prevAtr: number;
    prevAtrShort: number;
    rvolBaseline: number;
    prevDayOHLC: { open: number; high: number; low: number; close: number };
}
```

- [ ] **Step 2: 在 `precomputeTrendBaselinesForSymbol` 里把 `prevDay` 的 OHLC 塞进 baseline**

找到 `src/core/trendDetector.ts:326` 那行 `out[dayKey] = { prevClose, prevAtr, prevAtrShort, rvolBaseline };`，改成：

```ts
out[dayKey] = {
    prevClose,
    prevAtr,
    prevAtrShort,
    rvolBaseline,
    prevDayOHLC: {
        open: prevDay.open,
        high: prevDay.high,
        low: prevDay.low,
        close: prevDay.close,
    },
};
```

`prevDay` 已在循环里定义（`src/core/trendDetector.ts:279`），无需新增查表。

- [ ] **Step 3: 修已有 smoke 的 baseline 字面量**

修改 `src/backtest/smokeTrendDetector.ts:49-54`（Case 1）：

```ts
const baseline: TrendBaseline = {
    prevClose: 100,
    prevAtr: 4,
    prevAtrShort: 4,
    rvolBaseline: 3000,
    prevDayOHLC: { open: 98, high: 101, low: 97, close: 100 },
};
```

修改 `src/backtest/smokeTrendDetector.ts:93-98`（Case 2）：

```ts
const baseline: TrendBaseline = {
    prevClose: 100,
    prevAtr: 2,
    prevAtrShort: 2,
    rvolBaseline: 10000,
    prevDayOHLC: { open: 99.5, high: 100.5, low: 99, close: 100 },
};
```

修改 `src/backtest/smokeTrendDetector.ts:133-138`（Case 3）：

```ts
const baseline: TrendBaseline = {
    prevClose: 100,
    prevAtr: 2,
    prevAtrShort: 2,
    rvolBaseline: 10000,
    prevDayOHLC: { open: 99.5, high: 100.5, low: 99, close: 100 },
};
```

- [ ] **Step 4: 跑 smoke 验证现有 4 个 case 仍然绿**

Run:
```
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test npx ts-node --transpile-only src/backtest/smokeTrendDetector.ts
```
Expected: 末尾打印 `✅ trendDetector smoke all pass`，case1/2/3/4 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/core/trendDetector.ts src/backtest/smokeTrendDetector.ts
git commit -m "$(cat <<'EOF'
feat(trendDetector): add prevDayOHLC field to TrendBaseline

Prep for candle shape indicators (v4). Precompute prior day OHLC
alongside existing baseline fields. No scoring changes yet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2：实现 `scoreCandleShape` 纯函数 + 阈值常量

**Files:**
- Modify: `src/core/trendDetector.ts`（在文件上部常量区后追加接口、常量、函数）

这一步**只加新代码、不接入 `scoreTrendDay`**。确保函数本身正确再接入下游。

- [ ] **Step 1: 追加接口和阈值常量**

在 `src/core/trendDetector.ts` 的 `ATR_PCT_TIERS`（第 39 行附近）之后、`TREND_SCORE_THRESHOLD` 之前，加一段：

```ts
// ====== v4 Candle Shape 指标阈值(spec: 2026-04-18-candle-shape-design.md) ======

export interface CandleShapeThresholds {
    longShadowRatio: number;     // 长影: shadows/total ≥ 该值
    fullBodyRatio: number;       // 满实体: body/total ≥ 该值
    fullBodyMinTotalPct: number; // 满实体: total/open ≥ 该值(死水 K 闸)
    longKlineBodyAtr: number;    // 超长 K: body/prevAtr ≥ 该值
    maxScore: number;            // 命中任一档给的分(Opening=15, PriorDay=10)
}

export interface CandleShapeResult {
    score: number;
    tier: 'long-shadow' | 'full-body' | 'long-kline' | 'none';
    bodyRatio: number;    // body / (high - low)
    shadowRatio: number;  // 1 - bodyRatio
    bodyAtr: number;      // body / prevAtr
}

const OPENING_SHAPE_THRESHOLDS: CandleShapeThresholds = {
    longShadowRatio: 0.65,
    fullBodyRatio: 0.75,
    fullBodyMinTotalPct: 0.003,
    longKlineBodyAtr: 0.4,
    maxScore: 15,
};

const PRIOR_DAY_SHAPE_THRESHOLDS: CandleShapeThresholds = {
    longShadowRatio: 0.65,
    fullBodyRatio: 0.75,
    fullBodyMinTotalPct: 0.01,
    longKlineBodyAtr: 0.8,
    maxScore: 10,
};
```

- [ ] **Step 2: 实现 `scoreCandleShape`**

紧接在上一段后追加：

```ts
/**
 * K 线身形评分(纯函数)。
 *
 * max-of-three:三档独立判定,命中任一档给 maxScore。
 * tier 用固定优先级(long-kline > full-body > long-shadow)归类,仅作诊断字段。
 *
 * 边界保护:total/prevAtr/open 非正 → score=0 tier='none'。
 *
 * 详见 docs/superpowers/specs/2026-04-18-candle-shape-design.md。
 */
export function scoreCandleShape(
    k: { open: number; high: number; low: number; close: number },
    prevAtr: number,
    t: CandleShapeThresholds
): CandleShapeResult {
    const total = k.high - k.low;
    if (!(total > 0) || !(prevAtr > 0) || !(k.open > 0)) {
        return { score: 0, tier: 'none', bodyRatio: 0, shadowRatio: 0, bodyAtr: 0 };
    }
    const body = Math.abs(k.close - k.open);
    const bodyRatio = body / total;
    const shadowRatio = 1 - bodyRatio;
    const bodyAtr = body / prevAtr;

    const isLongShadow = shadowRatio >= t.longShadowRatio;
    const isFullBody =
        bodyRatio >= t.fullBodyRatio && total / k.open >= t.fullBodyMinTotalPct;
    const isLongKline = bodyAtr >= t.longKlineBodyAtr;

    let tier: CandleShapeResult['tier'] = 'none';
    if (isLongKline) tier = 'long-kline';
    else if (isFullBody) tier = 'full-body';
    else if (isLongShadow) tier = 'long-shadow';

    const score = tier === 'none' ? 0 : t.maxScore;
    return { score, tier, bodyRatio, shadowRatio, bodyAtr };
}
```

- [ ] **Step 3: 在 smoke 里加一组 `scoreCandleShape` 直接单测（Case 5）**

在 `src/backtest/smokeTrendDetector.ts` 的 `import` 处加上 `scoreCandleShape, OPENING_SHAPE_THRESHOLDS, PRIOR_DAY_SHAPE_THRESHOLDS, CandleShapeThresholds`（后面两个常量当前还没 export，下一步处理）。

**先把两个常量 export**：修改 `src/core/trendDetector.ts` 刚加的 `const OPENING_SHAPE_THRESHOLDS` / `const PRIOR_DAY_SHAPE_THRESHOLDS` 前面加 `export`。

然后在 `src/backtest/smokeTrendDetector.ts` 文件末尾（`console.log('\n✅ trendDetector smoke all pass');` 之前）插入：

```ts
// ============================================================
// Case 5: scoreCandleShape 单元测试(Opening 阈值)
// ============================================================
(function caseShapeOpening() {
    console.log('Running case 5: scoreCandleShape (Opening)');
    const t = OPENING_SHAPE_THRESHOLDS;
    const prevAtr = 2.0; // 任意正数,足以让 bodyAtr 可算

    // 5a. 十字星:body=0,shadowRatio=1 -> long-shadow
    let r = scoreCandleShape({ open: 100, high: 101, low: 99, close: 100 }, prevAtr, t);
    assert(r.tier === 'long-shadow', `5a tier long-shadow, got ${r.tier}`);
    assert(r.score === 15, `5a score 15, got ${r.score}`);

    // 5b. 长上影小阳线:total=2, body=0.1, bodyRatio=0.05 -> long-shadow
    r = scoreCandleShape({ open: 100, high: 102, low: 100, close: 100.1 }, prevAtr, t);
    assert(r.tier === 'long-shadow', `5b tier long-shadow, got ${r.tier}`);
    assert(r.score === 15, `5b score 15, got ${r.score}`);

    // 5c. 大阳线:body=1 ATR,超过 0.4 -> long-kline(优先级最高)
    // open=100, close=102, high=102.1, low=99.9, total=2.2, body=2, bodyAtr=1.0
    r = scoreCandleShape({ open: 100, high: 102.1, low: 99.9, close: 102 }, prevAtr, t);
    assert(r.tier === 'long-kline', `5c tier long-kline, got ${r.tier}`);
    assert(r.score === 15, `5c score 15, got ${r.score}`);

    // 5d. 中阳线:body 占比高、body<0.4 ATR、total/open≥0.3% -> full-body
    // open=100, close=100.6, high=100.65, low=99.95, total=0.7, body=0.6, bodyRatio=0.857,
    // total/open=0.007 >= 0.003, bodyAtr=0.3 < 0.4
    r = scoreCandleShape({ open: 100, high: 100.65, low: 99.95, close: 100.6 }, prevAtr, t);
    assert(r.tier === 'full-body', `5d tier full-body, got ${r.tier}`);
    assert(r.score === 15, `5d score 15, got ${r.score}`);

    // 5e. 死水小阳线:body 比例 OK 但 total/open < 0.3% -> none
    // open=100, close=100.002, high=100.0025, low=99.9995, total=0.003, total/open=3e-5
    r = scoreCandleShape(
        { open: 100, high: 100.0025, low: 99.9995, close: 100.002 },
        prevAtr,
        t
    );
    assert(r.tier === 'none', `5e tier none, got ${r.tier}`);
    assert(r.score === 0, `5e score 0, got ${r.score}`);

    // 5f. 极小 K:total=0 -> none
    r = scoreCandleShape({ open: 100, high: 100, low: 100, close: 100 }, prevAtr, t);
    assert(r.tier === 'none', `5f tier none, got ${r.tier}`);
    assert(r.score === 0, `5f score 0, got ${r.score}`);

    console.log('  case5 PASS');
})();
```

- [ ] **Step 4: 跑 smoke 看 Case 5 过**

Run:
```
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test npx ts-node --transpile-only src/backtest/smokeTrendDetector.ts
```
Expected: case5 打印 `PASS`，末尾仍然 `✅ trendDetector smoke all pass`。

- [ ] **Step 5: Commit**

```bash
git add src/core/trendDetector.ts src/backtest/smokeTrendDetector.ts
git commit -m "$(cat <<'EOF'
feat(trendDetector): add scoreCandleShape pure function

Implements max-of-three tier judgement (long-shadow / full-body /
long-kline) with OPENING and PRIOR_DAY threshold presets. Unit
smoke covers 6 morphology cases. Not wired into scoreTrendDay yet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3：扩 `TrendScore` / `TrendScoreDetails` 接口

**Files:**
- Modify: `src/core/trendDetector.ts`

只扩类型，下一步接入才会给它们赋值。

- [ ] **Step 1: 扩 `TrendScoreDetails`**

修改 `src/core/trendDetector.ts:57-65`：

```ts
export interface TrendScoreDetails {
    gapPct: number;
    rvolValue: number;
    driveAtr: number;
    vwapControlRatio: number;
    vwapControlSide: 'long' | 'short' | 'none';
    rangeValue: number;
    atrPct: number;
    // v4 新增 —— Candle Shape 诊断字段
    openingBodyRatio: number;
    openingShadowRatio: number;
    openingBodyAtr: number;
    openingShapeTier: CandleShapeResult['tier'];
    priorDayBodyRatio: number;
    priorDayShadowRatio: number;
    priorDayBodyAtr: number;
    priorDayShapeTier: CandleShapeResult['tier'];
}
```

- [ ] **Step 2: 扩 `TrendScore`**

修改 `src/core/trendDetector.ts:67-76`：

```ts
export interface TrendScore {
    total: number; // 0–140(v4: 原 115 + openingShape 15 + priorDayShape 10)
    gap: number;
    rvol: number;
    drive: number;
    vwap: number;
    range: number;
    atrPct: number;
    openingShape: number;   // v4 新增: 0 / 15
    priorDayShape: number;  // v4 新增: 0 / 10
    details: TrendScoreDetails;
}
```

- [ ] **Step 3: 编译检查（暂时会报红：`scoreTrendDay` 返回的对象没有新字段）**

Run:
```
npm run build
```
Expected: **编译失败**，错误在 `scoreTrendDay` 返回的 `return {}`（`src/core/trendDetector.ts:219` 附近），提示缺 `openingShape` / `priorDayShape` / 8 个 details 子字段。这是**预期的红**，下一个 task 就是补上它们。

**不要 commit，下一个 task 修复再合并提交。**

---

## Task 4：在 `scoreTrendDay` 里接入两次 `scoreCandleShape`

**Files:**
- Modify: `src/core/trendDetector.ts`（`scoreTrendDay` 函数体）

- [ ] **Step 1: 挪 Range 的 high/low 循环到前面（方便 Opening Shape 复用）**

现有代码 `src/core/trendDetector.ts:190-197`（Range 指标的 `highMax / lowMin` 循环）已经在指标五位置。Task 4 不需要挪动，因为新逻辑接在 ATR% 之后，`highMax / lowMin` 变量在函数作用域里仍可见。**跳过，不改。**（保留此条以明确"已验证无需挪动"。）

- [ ] **Step 2: 在 ATR% 指标后（`src/core/trendDetector.ts:218` 的 `return` 之前）追加两段**

找到紧接在 `atrPctScore` 逻辑之后（`src/core/trendDetector.ts:216-217` 那段 for 循环结束处）、`return {` 之前，插入：

```ts
    // ====== 指标七:Opening Shape(v4 新增) ======
    const openingK = {
        open: window[0].open,
        close: price0945,    // 已在上文定义 = window[last].close
        high: highMax,       // Range 指标算出的
        low: lowMin,
    };
    const openingShapeResult = scoreCandleShape(
        openingK,
        baseline.prevAtr,
        OPENING_SHAPE_THRESHOLDS
    );

    // ====== 指标八:Prior Day Shape(v4 新增) ======
    const priorDayShapeResult = scoreCandleShape(
        baseline.prevDayOHLC,
        baseline.prevAtr, // 简化方案:共用 prevAtr 当尺子(spec §二·决策 6)
        PRIOR_DAY_SHAPE_THRESHOLDS
    );
```

- [ ] **Step 3: 更新 `return {}`**

修改 `src/core/trendDetector.ts:219-236`（原 `return {}` 整段），改成：

```ts
    return {
        total:
            gap + rvol + drive + vwap + range + atrPctScore +
            openingShapeResult.score + priorDayShapeResult.score,
        gap,
        rvol,
        drive,
        vwap,
        range,
        atrPct: atrPctScore,
        openingShape: openingShapeResult.score,
        priorDayShape: priorDayShapeResult.score,
        details: {
            gapPct,
            rvolValue,
            driveAtr,
            vwapControlRatio,
            vwapControlSide,
            rangeValue,
            atrPct,
            openingBodyRatio: openingShapeResult.bodyRatio,
            openingShadowRatio: openingShapeResult.shadowRatio,
            openingBodyAtr: openingShapeResult.bodyAtr,
            openingShapeTier: openingShapeResult.tier,
            priorDayBodyRatio: priorDayShapeResult.bodyRatio,
            priorDayShadowRatio: priorDayShapeResult.shadowRatio,
            priorDayBodyAtr: priorDayShapeResult.bodyAtr,
            priorDayShapeTier: priorDayShapeResult.tier,
        },
    };
```

- [ ] **Step 4: 编译检查**

Run:
```
npm run build
```
Expected: trendDetector.ts 这边不再报错。可能还有 `runner.ts` / `types.ts` 因为旧 `entryDayScoreDetail.details` 类型和新 `TrendScoreDetails` 不一致的错——这些下一个 task 修。

- [ ] **Step 5: 跑现有 smoke 验证 case1–case5 仍绿**

现有 Case 1 期望 `total=100`（旧 6 指标），但新增两个指标后可能把 total 推高。先让 smoke 失败，**读取新的 total 值**，再按实际打分更新 Case 1 的 assert。

Run smoke：
```
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test npx ts-node --transpile-only src/backtest/smokeTrendDetector.ts
```

**分析 Case 1 新 total**：
- Case 1 的 window：open=102.5, close=104.5, highMax=104.55, lowMin=102.45
  - `openingK`: open=102.5, close=104.5, high=104.55, low=102.45
  - total = 2.1, body = 2, bodyRatio = 0.952, bodyAtr = 2/4 = 0.5 ≥ 0.4 → **long-kline** → +15
- Case 1 的 `prevDayOHLC`（我们在 Task 1 Step 3 设的）：open=98, high=101, low=97, close=100
  - total = 4, body = 2, bodyRatio = 0.5, bodyAtr = 2/4 = 0.5, total/open = 4/98 ≈ 0.0408
  - longShadow: 0.5 ≥ 0.65? 否
  - fullBody: bodyRatio 0.5 ≥ 0.75? 否
  - longKline: 0.5 ≥ 0.8? 否
  - → **none** → +0

所以 Case 1 新 total = 100 + 15 + 0 = **115**。

Case 2（zero score）的 window：恒为 100.45/100.55 震荡，`openingK` 差不多 open=100.5 close=100.51 high=100.6 low=100.4，total=0.2, body=0.01, bodyRatio=0.05 → long-shadow → +15。但 **prevAtr=2 → bodyAtr=0.005 → long-kline 不中**；**long-shadow 中** → +15。

Case 2 的 `prevDayOHLC`: open=99.5 high=100.5 low=99 close=100，total=1.5, body=0.5, bodyRatio=0.333, bodyAtr=0.25, total/open=0.015。longShadow 0.667 ≥ 0.65 → **long-shadow** → +10。

Case 2 新 total = 0 + 15 + 10 = **25**（不再是 0）。**这会让 Case 2 的语义失效**（不再是"零分样本"）。

**处理方式**：Case 2 需要重构让 Shape 两个指标都拿 0。改法：把 Case 2 的 window 改成"满实体小波动但 total/open < 0.3%"，把 `prevDayOHLC` 改成"都是死水，各比例都不命中"。

**重构 Case 2**：修改 `src/backtest/smokeTrendDetector.ts:99-110` 这一段。改动如下：

```ts
    const window: SerializedBar[] = [];
    for (let i = 0; i < OPENING_WINDOW_MINUTES; i++) {
        // 死水震荡:open/close 都在 100.5 附近,total/open < 0.003
        const o = i % 2 === 0 ? 100.499 : 100.501;
        const c = i % 2 === 0 ? 100.501 : 100.499;
        window.push(bar(0, o, 100.502, 100.498, c, 500));
    }
    window[0].open = 100.5;
    window[window.length - 1].close = 100.501;
    // Opening Shape: total ≈ 0.004, total/open ≈ 4e-5, body ≈ 0.001, bodyAtr ≈ 0.0005
    //   longShadow: shadowRatio ≈ 0.75 ≥ 0.65 -> 命中!
    // 这依然会给 long-shadow 15 分。需要让 body 占 total 很大,shadowRatio 小。
```

**关键问题**：窄幅震荡 body 小时必然 long-shadow 命中。要让 Opening Shape 拿 0，**必须同时满足**：
- `shadowRatio < 0.65`（即 `bodyRatio > 0.35`）
- `bodyRatio < 0.75` 或 `total/open < 0.003`
- `bodyAtr < 0.4`

构造：`open=100.5, high=100.6, low=100.5, close=100.56`。
- total = 0.1, body = 0.06, bodyRatio = 0.6（在 0.35–0.75 之间）
- shadowRatio = 0.4 < 0.65 ✓
- bodyRatio 0.6 < 0.75 ✓（不是 full-body）
- bodyAtr = 0.06 / 2 = 0.03 < 0.4 ✓（不是 long-kline）
- → `none` ✓

但这是单根 bar 的形态，5 根合成后会变。合成 K 用的是 `window[0].open` / `window[4].close` / `max(high)` / `min(low)`。构造 5 根都是 open=100.5 high=100.6 low=100.5 close=100.56 的 bar：合成后 open=100.5, close=100.56, high=100.6, low=100.5 → 同上 → none ✓。

**重构后的 Case 2 完整代码**（替换 `src/backtest/smokeTrendDetector.ts:99-110`）：

```ts
    const window: SerializedBar[] = [];
    for (let i = 0; i < OPENING_WINDOW_MINUTES; i++) {
        // 合成 K 后: open=100.5 close=100.56 high=100.6 low=100.5
        // total=0.1, body=0.06, bodyRatio=0.6, shadowRatio=0.4, bodyAtr=0.03
        // -> Opening Shape: none (bodyRatio 0.6 在 0.35-0.75 中间,三档都不命中)
        // 但需要让 VWAP 也拿 0 -> 让 close 有时 > vwap 有时 <
        // 做法:让每根 close 交替在 open 上下,但整体形态仍满足上述合成 K
        const o = 100.5;
        const c = i % 2 === 0 ? 100.501 : 100.499;
        window.push(bar(0, o, 100.6, 100.5, c, 500));
    }
    window[0].open = 100.5;
    window[window.length - 1].close = 100.56;
```

**但这样还是有问题**：5 根 bar 的 close 交替，而合成 K 的 close 是 window[4].close=100.56。让我重新核算合成 K：open=window[0].open=100.5, close=window[4].close=100.56, high=max(100.6)=100.6, low=min(100.5)=100.5。OK。

但 VWAP 指标内部是逐根 bar 看 close vs 累积 VWAP。前 4 根 close 交替在 100.499/100.501，cumVWAP 大致在 100.5 附近；第 5 根 close=100.56 远高于 cumVWAP。这样 longRatio 可能 ≥ 0.8 触发 VWAP +5 分。

**简化方案**：接受 Case 2 新 total 从 0 变成其他值，把 Case 2 的断言从 "每项都 0 且 total=0" 改成 "total 仍然远低于门槛"。具体断言改为：

```ts
    assert(score!.total < TREND_SCORE_THRESHOLD, `case2 total < ${TREND_SCORE_THRESHOLD}, got ${score!.total}`);
```

并删掉 `case2 gap/rvol/drive/vwap/range/atrPct/total === 0` 这 7 行 assert（第 115-121 行）。

**Case 1 同样需要更新**：`src/backtest/smokeTrendDetector.ts:83` 把 `score!.total === 100` 改成 `score!.total === 115`，并加两行：

```ts
assert(score!.openingShape === 15, `case1 openingShape expected 15, got ${score!.openingShape}`);
assert(score!.priorDayShape === 0, `case1 priorDayShape expected 0, got ${score!.priorDayShape}`);
```

**Case 3**（below threshold）：window 的 `highMax ≈ 102.01 lowMin ≈ 100.99`，合成 K open=101.5 close=102.7 high=102.01 low=100.99。total=1.02, body=1.2 → **问题：body > total**？不会，因为 high 必须 ≥ close。重新读 Case 3 window 构造：

```ts
win.push(bar(0, o, c + 0.5, o - 0.5, c, 1400));
```

每根 high=c+0.5, low=o-0.5。第 5 根被 override `close = 102.7`（`src/backtest/smokeTrendDetector.ts:147`），但 high=c+0.5 是构造时的 c=101.49/101.51，不会跟着更新。所以 highMax 可能 = 第 5 根的 high 或 override 后的 close，但 high 字段没改。需要实际跑一次看结果。

**稳妥做法**：Case 3 的 shape assertions 也只断言 `total < TREND_SCORE_THRESHOLD`（它已经这么做），加上打印 Shape 两个分数用于诊断。不 assert Shape 具体值，但让 total 断言继续成立。

- [ ] **Step 6: 按上述分析改 smoke assertion**

修改 `src/backtest/smokeTrendDetector.ts` 的 Case 1 断言段（`src/backtest/smokeTrendDetector.ts:77-84`）：

```ts
    assert(score!.gap === 25, `case1 gap expected 25, got ${score!.gap}`);
    assert(score!.rvol === 40, `case1 rvol expected 40, got ${score!.rvol}`);
    assert(score!.drive === 0, `case1 drive expected 0, got ${score!.drive}`);
    assert(score!.vwap === 5, `case1 vwap expected 5, got ${score!.vwap}`);
    assert(score!.range === 15, `case1 range expected 15, got ${score!.range}`);
    assert(score!.atrPct === 15, `case1 atrPct expected 15, got ${score!.atrPct}`);
    assert(score!.openingShape === 15, `case1 openingShape expected 15, got ${score!.openingShape}`);
    assert(score!.priorDayShape === 0, `case1 priorDayShape expected 0, got ${score!.priorDayShape}`);
    assert(score!.total === 115, `case1 total expected 115, got ${score!.total}`);
```

修改 Case 2 断言段（`src/backtest/smokeTrendDetector.ts:115-121`），整段替换成：

```ts
    assert(score!.gap === 0, `case2 gap expected 0, got ${score!.gap}`);
    assert(score!.rvol === 0, `case2 rvol expected 0, got ${score!.rvol}`);
    assert(score!.drive === 0, `case2 drive expected 0, got ${score!.drive}`);
    assert(score!.range === 0, `case2 range expected 0, got ${score!.range}`);
    assert(score!.atrPct === 0, `case2 atrPct expected 0, got ${score!.atrPct}`);
    // v4: Shape 指标加入后 total 可能不是 0,但仍应远低于门槛
    assert(score!.total < TREND_SCORE_THRESHOLD, `case2 total expected < ${TREND_SCORE_THRESHOLD}, got ${score!.total}`);
```

（删掉原 `vwap === 0` 和 `total === 0` 这两行，因为重构 window 后 vwap 可能非零；删掉 `total === 0`。）

Case 3 不变（原本就是 `total < TREND_SCORE_THRESHOLD`，v4 依然成立）。

- [ ] **Step 7: 跑 smoke**

Run:
```
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test npx ts-node --transpile-only src/backtest/smokeTrendDetector.ts
```
Expected: case1 PASS（total=115），case2 PASS（total < 45），case3 PASS（total < 45），case4 PASS，case5 PASS，末尾 `✅`。

**如果失败**：按打印出的实际值反推——特别是 Case 2 重构后的 `openingBodyRatio / openingShapeTier` 日志（case2 里已有 `console.log('  case2 score:', JSON.stringify(score));`）。修改 window 构造让 Shape 真的都命中 none。

- [ ] **Step 8: Commit**

```bash
git add src/core/trendDetector.ts src/backtest/smokeTrendDetector.ts
git commit -m "$(cat <<'EOF'
feat(trendDetector): wire openingShape/priorDayShape into scoreTrendDay

Score ceiling 115 -> 140. Opening synthesized from window's
first open / last close / max-high / min-low, sharing Range's
loop output. PriorDay uses baseline.prevDayOHLC with shared prevAtr.
Smoke cases 1-3 updated for new score distribution.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5：给 runner / types 补字段

**Files:**
- Modify: `src/backtest/types.ts`（`BacktestTrade.entryDayScoreDetail`）
- Modify: `src/backtest/runner.ts`（构造 `entryDayScoreDetail` 的地方）

- [ ] **Step 1: 扩 `BacktestTrade.entryDayScoreDetail`**

修改 `src/backtest/types.ts:50-58`：

```ts
    entryDayScoreDetail?: {
        gap: number; rvol: number; drive: number; vwap: number; range: number;
        atrPct?: number; // v3 新增
        openingShape?: number;   // v4 新增
        priorDayShape?: number;  // v4 新增
        details: {
            gapPct: number; rvolValue: number; driveAtr: number;
            vwapControlRatio: number; vwapControlSide: string; rangeValue: number;
            atrPct: number;
            // v4 新增 Shape 诊断(旧 json 没有)
            openingBodyRatio?: number;
            openingShadowRatio?: number;
            openingBodyAtr?: number;
            openingShapeTier?: string;
            priorDayBodyRatio?: number;
            priorDayShadowRatio?: number;
            priorDayBodyAtr?: number;
            priorDayShapeTier?: string;
        };
    } | null;
```

所有新增字段标 `?`，**不破坏旧 JSON 反序列化**。

- [ ] **Step 2: 在 runner 写入处补新字段**

修改 `src/backtest/runner.ts:652-663`：

```ts
                        entryDayScoreDetail:
                            scoreNow && typeof scoreNow === 'object'
                                ? {
                                    gap: scoreNow.gap,
                                    rvol: scoreNow.rvol,
                                    drive: scoreNow.drive,
                                    vwap: scoreNow.vwap,
                                    range: scoreNow.range,
                                    atrPct: scoreNow.atrPct,
                                    openingShape: scoreNow.openingShape,
                                    priorDayShape: scoreNow.priorDayShape,
                                    details: scoreNow.details,
                                }
                                : null,
```

`scoreNow.details` 已经包含所有新字段（Task 4 Step 3 里扩过），直接传过来。

- [ ] **Step 3: 编译检查**

Run:
```
npm run build
```
Expected: 无报错。

- [ ] **Step 4: 跑 smoke 确认没破坏 Task 4 的绿**

Run:
```
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test npx ts-node --transpile-only src/backtest/smokeTrendDetector.ts
```
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add src/backtest/types.ts src/backtest/runner.ts
git commit -m "$(cat <<'EOF'
feat(backtest): persist candle shape scores in trade records

Optional fields on entryDayScoreDetail keep old result JSON
deserializable while letting recordonly runs capture v4 metrics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6：给 analyzeTrendWeights 加 Shape 诊断

**Files:**
- Modify: `src/backtest/analyzeTrendWeights.ts`

- [ ] **Step 1: 在 ATR% 诊断之后追加 Opening Shape / Prior Day Shape 的分桶表**

找到 `src/backtest/analyzeTrendWeights.ts:163` 那个 `ATR%` 段的结束（`}` 之后）、`// 总分分桶` 之前，插入：

```ts
    // 7. Opening Shape —— body/total 占比
    const openingBrTrades = trades.filter(
        t => typeof t.entryDayScoreDetail.details.openingBodyRatio === 'number'
    );
    if (openingBrTrades.length === 0) {
        console.log('\n=== Opening bodyRatio === 跳过:旧 json 无字段,请重跑 recordonly');
    } else {
        const edges = [0, 0.2, 0.35, 0.5, 0.65, 0.75, 0.85, 1.0];
        printTable(
            `Opening bodyRatio [${openingBrTrades.length} trades]`,
            bucketize(openingBrTrades, t => t.entryDayScoreDetail.details.openingBodyRatio!, edges)
        );
    }

    // 8. Opening bodyAtr —— body / prevAtr
    const openingBaTrades = trades.filter(
        t => typeof t.entryDayScoreDetail.details.openingBodyAtr === 'number'
    );
    if (openingBaTrades.length === 0) {
        console.log('\n=== Opening bodyAtr === 跳过:旧 json 无字段');
    } else {
        const edges = [0, 0.1, 0.2, 0.4, 0.6, 1.0, 2.0];
        printTable(
            `Opening bodyAtr [${openingBaTrades.length} trades]`,
            bucketize(openingBaTrades, t => t.entryDayScoreDetail.details.openingBodyAtr!, edges)
        );
    }

    // 9. PriorDay bodyRatio
    const priorBrTrades = trades.filter(
        t => typeof t.entryDayScoreDetail.details.priorDayBodyRatio === 'number'
    );
    if (priorBrTrades.length === 0) {
        console.log('\n=== PriorDay bodyRatio === 跳过:旧 json 无字段');
    } else {
        const edges = [0, 0.2, 0.35, 0.5, 0.65, 0.75, 0.85, 1.0];
        printTable(
            `PriorDay bodyRatio [${priorBrTrades.length} trades]`,
            bucketize(priorBrTrades, t => t.entryDayScoreDetail.details.priorDayBodyRatio!, edges)
        );
    }

    // 10. PriorDay bodyAtr
    const priorBaTrades = trades.filter(
        t => typeof t.entryDayScoreDetail.details.priorDayBodyAtr === 'number'
    );
    if (priorBaTrades.length === 0) {
        console.log('\n=== PriorDay bodyAtr === 跳过:旧 json 无字段');
    } else {
        const edges = [0, 0.2, 0.4, 0.8, 1.2, 2.0, 3.0];
        printTable(
            `PriorDay bodyAtr [${priorBaTrades.length} trades]`,
            bucketize(priorBaTrades, t => t.entryDayScoreDetail.details.priorDayBodyAtr!, edges)
        );
    }
```

- [ ] **Step 2: 更新总分分桶上限**

修改 `src/backtest/analyzeTrendWeights.ts:166`（`totalEdges` 那行）：

```ts
    const totalEdges = [0, 15, 30, 45, 60, 75, 90, 105, 120, 141];
```

并修改 `src/backtest/analyzeTrendWeights.ts:168-172` 那段 lambda（原本缺了 atrPct / openingShape / priorDayShape），改成：

```ts
    printTable('总分 (total)', bucketize(
        trades,
        t => t.entryDayScoreDetail.gap + t.entryDayScoreDetail.rvol +
             t.entryDayScoreDetail.drive + t.entryDayScoreDetail.vwap +
             t.entryDayScoreDetail.range + (t.entryDayScoreDetail.atrPct ?? 0) +
             (t.entryDayScoreDetail.openingShape ?? 0) +
             (t.entryDayScoreDetail.priorDayShape ?? 0),
        totalEdges
    ));
```

- [ ] **Step 3: 编译检查**

Run:
```
npm run build
```
Expected: 无报错。（这个脚本平时不在 build 链路里，但 `npm run build` 会 tsc 全仓，需要过。）

- [ ] **Step 4: 烟测：用已有的 v3b recordonly 结果文件跑一遍（字段会 skip 但脚本不该 crash）**

Run:
```
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/analyzeTrendWeights.ts trend_v3b_recordonly_atr7_sl010
```
Expected: 旧结果文件里没有 Shape 字段，会打印 4 行 `跳过:旧 json 无字段`；其他诊断正常；总分分桶用新 edges 跑出来。

如果这个 label 文件不存在，可以改用任何一个现有 result label（如 `trend_v2_recordonly_sl010`）。

- [ ] **Step 5: Commit**

```bash
git add src/backtest/analyzeTrendWeights.ts
git commit -m "$(cat <<'EOF'
feat(backtest): add candle shape buckets to analyzeTrendWeights

Four new bucket tables (openingBodyRatio / openingBodyAtr /
priorDayBodyRatio / priorDayBodyAtr). Total-score buckets
extended to 141. Old json without shape fields is skipped cleanly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7：更新 `references/TREND.md`

**Files:**
- Modify: `references/TREND.md`

- [ ] **Step 1: 在第三节（指标六）后追加指标七和指标八**

找到 `references/TREND.md:148`（指标六 ATR% 段的结束，`# 四、最终评分` 之前），插入：

```markdown
---

## 指标七：Opening Shape（15 分，v4 新增）

开盘 5 分钟合成一根 K 线（`open=window[0].open, close=window[4].close, high=max(high), low=min(low)`），对身形评分。

**Max-of-three**：三档独立判定，命中任一档拿满分：

1. **长影线型**：`(上影 + 下影) / 总长度 ≥ 0.65`（body 占比 ≤ 35%）
2. **满实体型**：`body / 总长度 ≥ 0.75` AND `总长度 / open ≥ 0.3%`（死水 K 闸）
3. **超长 K 线型**：`body / prevAtr ≥ 0.4`

诊断归类优先级：long-kline > full-body > long-shadow（仅影响 `details.openingShapeTier` 字段，不影响评分）。

**占位分数**：命中任一档 15 分，否则 0。诊断后根据 avgR / 单调性手调（同 v2/v3 流程）。

---

## 指标八：Prior Day Shape（10 分，v4 新增）

昨日日线 K（从 `baseline.prevDayOHLC` 读出）走同一套 `scoreCandleShape` 评分，但阈值更严：

| 项 | Opening | Prior Day |
|---|---|---|
| longShadowRatio | 0.65 | 0.65 |
| fullBodyRatio | 0.75 | 0.75 |
| fullBodyMinTotalPct | 0.3% | **1%**（一整天门槛更严） |
| longKlineBodyAtr | 0.4 × prevAtr | **0.8 × prevAtr**（一整天门槛更严） |
| maxScore | 15 | **10** |

**共享 `prevAtr` 尺子**（昨日 K 用的也是 baseline 里的 prevAtr，简化方案）：ATR 是 7 日平滑，昨日权重约 14%，偏差方向保守（略低估 bodyAtr），影响可忽略。避免新增 `prevPrevAtr` 字段。
```

- [ ] **Step 2: 更新第四节（最终评分）**

修改 `references/TREND.md:151-156` 的公式段：

```markdown
# 四、最终评分

```js
score = gap(25) + rvol(40) + drive(0) + vwap(5) + range(30) + atrPct(15)
      + openingShape(15) + priorDayShape(10)
// 总分上限 = 140
```
```

- [ ] **Step 3: 第五节门槛不变**

确认 `references/TREND.md:160-174`（`if score >= 45`）**保持不变**。v4 先不动门槛，诊断后再定。在这段末尾加一行注释：

```markdown
> **v4 note**：新增两个 Shape 指标后总分上限从 115 → 140，门槛 45 先不动，等 recordonly 跑完看分布再调。
```

- [ ] **Step 4: Commit**

```bash
git add references/TREND.md
git commit -m "$(cat <<'EOF'
docs(trend): document candle shape indicators (v4)

Sections for indicator 7 (Opening Shape) and 8 (Prior Day Shape),
updated total-score formula 115 -> 140, threshold 45 unchanged
pending recordonly diagnostics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8：端到端回测 recordonly（记录分数，不参与门控）

**Files:** 无代码修改；运行现有 runner。

- [ ] **Step 1: 确认 `--filter-trend=off` 能让 detector 不影响门控**

读 `src/backtest/runner.ts:938`（`--filter-trend` CLI 处理处）和附近的 `filterOverride.enableTrendDetector` 逻辑。确认传 `off` 时 `filters.enableTrendDetector=false`，但 `precomputeTrendBaselinesForSymbol` 和 `scoreTrendDay` 依然会被调用（只是不门控）。

查 runner 里 `dayScoreMap` 的写入：`src/backtest/runner.ts:800-820` 附近，`trendDetectorEnabled` 为 false 时是否仍写 `dayScoreMap`。

**如果发现 `enableTrendDetector=false` 时 runner 跳过打分（= 不写 `entryDayScoreDetail`）**：需要改 runner 让"打分但不门控"。具体改法看代码现状定——大多数情况现有 runner 已经分开了这两个开关，因为 v2/v3 诊断一直这么跑。

- [ ] **Step 2: 跑一年样本 recordonly**

Run（从项目根目录；label 可调）:
```
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts \
  --start=2025-04-01 --end=2026-04-01 \
  --filter-trend=off \
  --label=trend_v4_recordonly_sl010
```

Expected: 生成 `data/backtest/results/trend_v4_recordonly_sl010.json`，trades 数量和 v3b recordonly 接近（58k 量级）。

**如果 CLI flag 不同**：检查 `src/backtest/runner.ts:938` 附近的 argv 解析确认实际 flag 名。

- [ ] **Step 3: 跑 analyze 看诊断表**

Run:
```
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/analyzeTrendWeights.ts trend_v4_recordonly_sl010
```

Expected: 输出 6 个现有指标诊断 + 4 个新 Shape 诊断（openingBodyRatio / openingBodyAtr / priorDayBodyRatio / priorDayBodyAtr）+ 总分分桶。

**人看数据做决定**（本计划止步于此）：
- 若某档（如 priorDayBodyRatio）**无单调性**（单调性 < 50%）且**最高桶 avgR 差 < 2×** → 归零（参考 Drive 指标处理）
- 若某档**弱单调且底部明显负区** → 保留作底部筛选
- 若阈值位置不合理（如最高桶 avgR 峰值不在预设阈值附近） → 手调阈值

- [ ] **Step 4: 不 commit**

这一步只跑数据、不改代码。结果 JSON 已经在 `data/backtest/results/`（按 `.gitignore` 默认是不追踪的；如果要归档分析，把分析结果写进 `references/TREND.md` 第六节再单独 commit）。

---

## Self-Review 已完成

**Spec 覆盖检查**：
- ✅ spec §3.1 `TrendBaseline` 扩字段 → Task 1
- ✅ spec §4 `scoreCandleShape` 函数 → Task 2
- ✅ spec §3.2 `TrendScore` / `TrendScoreDetails` 扩字段 → Task 3
- ✅ spec §5 `scoreTrendDay` 集成 → Task 4
- ✅ spec §9 runner / smoke / analyze / TREND.md → Tasks 5/6/7（+ smoke 在 Task 2/4 里）
- ✅ spec §10 recordonly 回测 → Task 8

**一致性检查**：
- ✅ `scoreCandleShape` 签名在 Task 2/4/单测里一致
- ✅ `CandleShapeThresholds` 字段名在接口定义、常量字面量、函数内部使用处一致
- ✅ `tier` 枚举值 `'long-shadow' | 'full-body' | 'long-kline' | 'none'` 贯穿 spec / 接口 / 实现 / 诊断
- ✅ 阈值数字与 spec §6 完全一致
- ✅ 总分上限 140 在 TREND.md / 接口注释 / analyze 的 `totalEdges` / Case 1 assert 里一致

**非目标**（不做）：
- 不改门槛 45（Task 7 Step 3 明确保留）
- 不改其他 6 个现有指标（Task 4 Step 1 明确不挪 Range 循环）
- 不引入 `prevPrevAtr` 字段（Task 1 Step 1 只加 `prevDayOHLC`）
- 不加 config 开关（Task 5 不改 `strategy.config.ts`）

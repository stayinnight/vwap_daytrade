# Candle Shape 指标设计（Trend Detector v4）

**日期**：2026-04-18
**上一版本**：`2026-04-15-trend-detector-v2-design.md`（v2/v3/v3b，见 `references/TREND.md`）
**目标文件**：`src/core/trendDetector.ts`、`src/backtest/runner.ts`、`src/index.ts`、`src/backtest/smokeTrendDetector.ts`、`src/backtest/analyzeTrendWeights.ts`、`references/TREND.md`

---

## 一、动机

现有 6 个指标（Gap / RVOL / Drive / VWAP / Range / ATR%）**全部是"波动率 / 量能"类**，没有指标看 **K 线形态**。

用户目标：系统想要**高波动率**或**日内趋势很强**的票，具体偏好三类"好形态"：

1. **长影线型**：影线很长、占 K 线很大部分 → 日内波动大、反复跑、"油水多"
2. **满实体型**：影线很小、K 线饱满 → 日内单边趋势
3. **超长 K 线型**：K 线非常长、body 绝对值大 → 趋势极强

这三类形态在**开盘 5 分钟**（预测当日）和**昨日日线**（判断延续性）两个时间尺度上都有意义。

本设计新增两个指标：**Opening Shape**（15 分）和 **Prior Day Shape**（10 分），共享一个纯函数 `scoreCandleShape`，用 max-of-three 判定三档。总分从 115 → 140。

---

## 二、关键设计决策（brainstorm 已敲定）

| # | 决策 | 选项 | 理由 |
|---|---|---|---|
| 1 | 开盘窗口的 K 线怎么构造 | **合成一根 5 分钟 K** | 和昨日日线 K 对称；合成 K 用 `window[0].open` / `window[4].close` / `max(high)` / `min(low)` |
| 2 | 三类形态如何合分 | **max-of-three** | 语义重叠（超长 K ≈ 满实体），叠加会重复计分；max 语义干净 |
| 3 | 长影线怎么定义 | **总影线 / 总长度**（不区分上下） | 用户目标是"有油水"，只要 body 小就够，不必区分冲高回落 vs 双影拉锯 |
| 4 | 满实体怎么定义 | **`body/total ≥ 0.75` AND `total/open ≥ 0.3%`** | 纯比例会让"死水 K"（极窄整理）拿高分；加 `total/open` 最小闸，**不引入 ATR**（职责干净） |
| 5 | 超长 K 的尺子 | **`body / prevAtr`** | 唯一必须引入外部尺子的一档（"body 绝对值大"本质就是"相对波动率大"） |
| 6 | 昨日 K 的 ATR 基准 | **简化方案：共用 `prevAtr`** | 新增 `prevPrevAtr` 字段改动大；ATR 是 7 日平滑，昨日权重 ≈ 14%，偏差方向保守（略低估），可接受 |
| 7 | Range 指标是否合并 | **保留 Range，新增 Shape 两指标** | 职责不同：Range 看 total（全长），Shape 看 body（实体）；重叠只发生在"超长 K"档，是正反馈冗余；合并会丢诊断独立性和调参自由度 |
| 8 | 权重 | **Opening 15 + PriorDay 10**，max-of-three 每档命中即给满分 | 占位值，诊断后再调；Opening 权重高于 PriorDay 因为前者是当日实时信号、后者是静态特征 |
| 9 | 阈值策略 | **方式 1：占位阈值 → recordonly → 诊断后手调** | 和现有系统工作流一致（v2/v3 所有阈值都是诊断驱动的） |

---

## 三、数据结构变更

### 3.1 `TrendBaseline` 新增 `prevDayOHLC`

```ts
export interface TrendBaseline {
    prevClose: number;
    prevAtr: number;
    prevAtrShort: number;
    rvolBaseline: number;
    prevDayOHLC: { open: number; high: number; low: number; close: number }; // 新增
}
```

`aggregateDailyForTrend` 现在就在算 `daily[i-1]` 的 OHLC（作为 `DailyOHLC` 内部字段），`precomputeTrendBaselinesForSymbol` 只需把它顺手塞进 baseline，**零新增计算**。

### 3.2 `TrendScore` 新增两个主分 + 诊断字段

```ts
export interface TrendScoreDetails {
    // ...现有字段
    openingBodyRatio: number;     // body / (high - low)
    openingShadowRatio: number;   // 1 - bodyRatio
    openingBodyAtr: number;       // body / prevAtr
    priorDayBodyRatio: number;
    priorDayShadowRatio: number;
    priorDayBodyAtr: number;
    openingShapeTier: 'long-shadow' | 'full-body' | 'long-kline' | 'none';
    priorDayShapeTier: 'long-shadow' | 'full-body' | 'long-kline' | 'none';
}

export interface TrendScore {
    total: number;  // 0–140（原 115 + 15 + 10）
    gap: number;
    rvol: number;
    drive: number;
    vwap: number;
    range: number;
    atrPct: number;
    openingShape: number;   // 0 / 15
    priorDayShape: number;  // 0 / 10
    details: TrendScoreDetails;
}
```

---

## 四、共享评分函数

```ts
interface CandleShapeThresholds {
    longShadowRatio: number;
    fullBodyRatio: number;
    fullBodyMinTotalPct: number;
    longKlineBodyAtr: number;
    maxScore: number;
}

interface CandleShapeResult {
    score: number;
    tier: 'long-shadow' | 'full-body' | 'long-kline' | 'none';
    bodyRatio: number;
    shadowRatio: number;
    bodyAtr: number;
}

function scoreCandleShape(
    k: { open: number; high: number; low: number; close: number },
    prevAtr: number,
    t: CandleShapeThresholds
): CandleShapeResult;
```

### 内部逻辑（max-of-three）

```
total = high - low
body = |close - open|

// 边界保护: total<=0 / prevAtr<=0 / open<=0 → score=0 tier='none'

bodyRatio = body / total
shadowRatio = 1 - bodyRatio
bodyAtr = body / prevAtr

// 三档独立判定
isLongShadow = shadowRatio >= t.longShadowRatio
isFullBody   = bodyRatio >= t.fullBodyRatio
             AND (total / open) >= t.fullBodyMinTotalPct
isLongKline  = bodyAtr >= t.longKlineBodyAtr

// 命中任一档 → maxScore；否则 0
score = (isLongShadow || isFullBody || isLongKline) ? t.maxScore : 0

// tier 优先级(用于诊断归类,不影响评分):
// long-kline > full-body > long-shadow
// 理由: 超长 K 需要绝对尺度,信号最强;满实体次之;长影最弱
if (isLongKline) tier = 'long-kline'
else if (isFullBody) tier = 'full-body'
else if (isLongShadow) tier = 'long-shadow'
else tier = 'none'
```

### 为什么独立判定 + max，而不是 else-if

- else-if 让"评分依赖判定顺序"，以后调阈值时行为非线性
- 独立判定 + max 语义干净：命中任一档就拿满分，多档命中不重复拿分
- `tier` 字段只影响诊断归类（后续分析"命中这档的票贡献多少 avgR"），不影响评分

---

## 五、`scoreTrendDay` 主函数集成

### 5.1 合成开盘 5 分钟 K

```ts
const openingK = {
    open:  window[0].open,
    close: window[window.length - 1].close,
    high:  highMax,  // 复用 Range 指标已算的 highMax
    low:   lowMin,   // 复用 Range 指标已算的 lowMin
};
```

**实现注意**：现有 `scoreTrendDay` 里 Range 指标的 `highMax / lowMin` 循环要挪到 Shape 指标之前，让 Shape 能复用，避免重复遍历。

### 5.2 两次 `scoreCandleShape` 调用

```ts
// ====== 指标七: Opening Shape (v4 新增) ======
const openingShape = scoreCandleShape(
    openingK,
    baseline.prevAtr,
    OPENING_SHAPE_THRESHOLDS
);

// ====== 指标八: Prior Day Shape (v4 新增) ======
const priorDayShape = scoreCandleShape(
    baseline.prevDayOHLC,
    baseline.prevAtr,  // 简化方案: 昨日也用 prevAtr 当尺子
    PRIOR_DAY_SHAPE_THRESHOLDS
);
```

### 5.3 返回结构

```ts
return {
    total: gap + rvol + drive + vwap + range + atrPctScore
           + openingShape.score + priorDayShape.score,
    // ...现有字段
    openingShape: openingShape.score,
    priorDayShape: priorDayShape.score,
    details: {
        // ...现有字段
        openingBodyRatio: openingShape.bodyRatio,
        openingShadowRatio: openingShape.shadowRatio,
        openingBodyAtr: openingShape.bodyAtr,
        openingShapeTier: openingShape.tier,
        priorDayBodyRatio: priorDayShape.bodyRatio,
        priorDayShadowRatio: priorDayShape.shadowRatio,
        priorDayBodyAtr: priorDayShape.bodyAtr,
        priorDayShapeTier: priorDayShape.tier,
    },
};
```

---

## 六、占位阈值

```ts
const OPENING_SHAPE_THRESHOLDS: CandleShapeThresholds = {
    longShadowRatio: 0.65,        // 影线 ≥ 65% (body ≤ 35%)
    fullBodyRatio: 0.75,          // body ≥ 75%
    fullBodyMinTotalPct: 0.003,   // total ≥ 0.3% 开盘价 (死水 K 闸)
    longKlineBodyAtr: 0.4,        // body ≥ 0.4 × prevAtr
    maxScore: 15,
};

const PRIOR_DAY_SHAPE_THRESHOLDS: CandleShapeThresholds = {
    longShadowRatio: 0.65,        // 同 opening
    fullBodyRatio: 0.75,          // 同 opening
    fullBodyMinTotalPct: 0.01,    // total ≥ 1% 开盘价 (一整天门槛更严)
    longKlineBodyAtr: 0.8,        // body ≥ 0.8 × prevAtr (一整天门槛更严)
    maxScore: 10,
};
```

**PriorDay 阈值更严的原因**：一整天时间窗口下"走出大身形"本来就更容易，用和 5 分钟相同的门槛会让 PriorDay 给太多"平庸昨日"打高分、失去区分力。

---

## 七、门槛和 config

- `TREND_SCORE_THRESHOLD` **保持 45**（总分从 115 → 140，门槛暂时不动，诊断后再定）
- `filters.enableTrendDetector` **保持不变**（总开关足够，不加新开关）

---

## 八、重叠处理

| 指标对 | 是否重叠 | 如何处理 |
|---|---|---|
| Opening Shape "超长 K" 档 ↔ Range | **部分重叠**（超长 K 必然 Range 也高） | 接受冗余 —— 又长又满的大阳线本来就该被系统"确信地喜欢"，正反馈 |
| Opening Shape "长影" 档 ↔ Range | **部分重叠**（长影必然 total 大 → Range 高） | 接受冗余 —— Range 说"波动够"，Shape 说"波动是来回跑"，维度互补 |
| Opening Shape "满实体" 档 ↔ Range | **不重叠** | 满实体不要求 total 大（只要求 body 比例高 + total/open ≥ 0.3%） |
| Prior Day Shape ↔ ATR% | **不重叠** | ATR% 是 7 日平滑波动率水平；Prior Day Shape 是昨日单根 K 形态，正交 |

**Range 为什么不合并到 Shape**（brainstorm 里讨论过，记在这里免得以后回归）：
1. Range 看 total（全长），Shape 看 body（实体），物理上不同
2. 合并后丢失诊断独立性（没法回答"长影票贡献多少 alpha" vs "超长 K 票贡献多少 alpha"）
3. 合并后丢失权重自由度（关不掉其中一个）

---

## 九、其他文件的改动

### `src/backtest/runner.ts`
- `TrendScore` 接口 import 同步更新
- 日志 / CSV 导出字段加两列：`openingShape` / `priorDayShape`
- 若有 tier 诊断需求，再加 `openingShapeTier` / `priorDayShapeTier`

### `src/index.ts`
- 实盘主循环调用无变化（`score.total` 上限变了，日志自然跟上）
- 无须新增 config 开关

### `src/backtest/smokeTrendDetector.ts`
- 加 6-8 个已知 K 形态用例，断言 `tier` 和 `score`：
  - 十字星（body=0）→ `long-shadow`, score=maxScore
  - 长上影小阳线（body 小）→ `long-shadow`
  - 大阳线（body 大、影小、body > 0.4 ATR）→ `long-kline`
  - 中阳线（body 大比例、body < 0.4 ATR、total/open ≥ 0.3%）→ `full-body`
  - 死水小阳线（body 大比例、total/open < 0.3%）→ `none`
  - 极小 K（total ≈ 0）→ `none`
  - PriorDay 阈值版：中阳线需要 total/open ≥ 1%、body ≥ 0.8 ATR 才命中相应档

### `src/backtest/analyzeTrendWeights.ts`
- 加两个新指标的分桶诊断，参照现有 Range / ATR% 的输出格式
- 分桶建议：
  - `openingBodyRatio`：[0, 0.2, 0.35, 0.5, 0.65, 0.75, 0.85, 1.0]
  - `openingBodyAtr`：[0, 0.1, 0.2, 0.4, 0.6, 1.0, 2.0]
  - PriorDay 同理，但 `priorDayBodyAtr` 顶档到 3.0

### `references/TREND.md`
- 在第三节（评分系统）加入指标七、指标八的描述
- 在第四节（最终评分）把公式更新到 0-140
- 第六节（实验数据）留待 recordonly 跑完后补

---

## 十、测试 & 验证计划

1. **单元 smoke**（立即）：`smokeTrendDetector.ts` 扩展，6-8 个用例，断言 tier/score
2. **回测 recordonly**（阈值初定后）：关掉门控（阈值降到 -1），跑一年样本，导出含新字段的结果 JSON
3. **诊断**（数据到手后）：用 `analyzeTrendWeights.ts` 对 `openingShape` / `priorDayShape` 的分桶做 avgR / 单调性分析
4. **门控实跑**（诊断后）：根据结果调阈值（某档单调性差或 avgR 负 → 归零或砍档，照 Drive 指标 v2 的处理方式），重跑 score ≥ 45 的 full run 看 cumR / ratio

---

## 十一、非目标（out of scope）

- **不**改 Range 指标（保留）
- **不**改其他 5 个现有指标（Gap / RVOL / Drive / VWAP / ATR%）
- **不**引入新的 config 开关
- **不**改门槛 45（诊断后再决定）
- **不**引入 `prevPrevAtr` 字段（简化方案用 `prevAtr`）
- **不**新增独立的总开关来单独关掉身形指标（等到诊断后如果某档效果差，通过阈值设高或归零来关，和现有 Drive 指标 v2 的处理一致）

---

## 十二、风险与回退

| 风险 | 概率 | 回退方案 |
|---|---|---|
| 新指标加总后 score=45 门槛过松，放进更多票但 cumR/ratio 反而降 | 中 | 诊断后把门槛调到 50-60 之间 |
| Shape 指标在 recordonly 下无单调性（像 Drive 那样） | 中 | 把对应档的 maxScore 调成 0（等同关掉） |
| `total/open` 的 `open` 分母指代歧义（是今日 open 还是昨日 open） | 低 | 明确：`scoreCandleShape(k, ...)` 内部用的是**传入的 `k.open`**。Opening 调用时 `k.open = window[0].open`（今日开盘），PriorDay 调用时 `k.open = baseline.prevDayOHLC.open`（昨日开盘）。不会混 |
| 合成开盘 K 的 `window[0].open` 被盘前集合竞价污染 | 低 | 现有 `scoreTrendDay` 已经在用这个 open 算 Gap，和 Gap 指标保持一致 |
| 新增 `prevDayOHLC` 字段破坏现有 smoke 测试 | 低 | `smokeTrendDetector.ts` 构造 baseline 的地方同步加上新字段 |

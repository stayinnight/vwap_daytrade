# B2-lite 日内震荡过滤器 — 设计方案

**日期**：2026-04-22
**作者**：zeng.516（与 Claude 协作）
**状态**：设计阶段，待实现
**目标**：在 `canOpen` 入场判定上加一层"日内滚动震荡评分"，过滤掉反复在 VWAP 附近来回的票，提升 per-trade R / 胜率。

---

## 1. 背景与问题

### 1.1 现状

`src/strategy/vwapStrategy.ts` 的入场逻辑核心是价格穿越 VWAP（`vwapBandAtrRatio = 0`，任何擦过 VWAP 的 K 线都触发）。出场后没有 cooldown / 当日入场次数限制，`SymbolState` 也没有相应字段。

现有过滤器：
- `enableTrendDetector = true` —— 09:35 一次性日级评分（`src/core/trendDetector.ts`）
- `enableRsiFilter / enableVolumeFilter / enableEntryPhaseFilter / enableIndexTrendFilter / enableSlopeMomentum` —— **全部 false**，一年回测样本下都是负贡献

### 1.2 bad_case 复盘

`examples/bad_case/` 下三张图（CRDO / INTC / MRVL）的共性：

- 09:35 trend score 通过了（评分高反映"波动率/活跃度"，不保证单边）
- 全天反复在 VWAP 附近来回，B/S 标记一个挨一个
- 每次价格擦过 VWAP → 触发开仓 → 止损 → 反向开仓 → 再止损
- 一只票一天 10+ 次进出

### 1.3 问题本质

日级 trend score 通过的票，**日内**可能依然没有方向。当前过滤器都是日级或入场瞬间的一次性判定，**没有反映"过去 N 分钟价格行为是否震荡"的滚动信号**。

---

## 2. 目标与约束

### 2.1 目标

每根已收盘 K 线触发一次"日内震荡评分"，分数低于阈值时**该时刻禁开仓**（不影响出场、不影响已有持仓）。

**评估口径**（用户明确选择）：**per-trade R / 胜率优先，可容忍 cumR 略降**。

### 2.2 显式约束

- cumR 跌幅 < 20%（硬上限）
- 不影响 `managePosition` 出场逻辑
- 默认 `filters.enableChoppiness = false`，保留 AB 切回旧行为的能力
- 实盘 / 回测共用同一份纯函数评分（参考 `trendDetector` 模式）
- 不引入新的 npm 依赖

### 2.3 不做什么（明确剔除）

- ❌ 持仓后用 chopScore 提前出场（只管入场）
- ❌ 方向感知（"上震下不震"）
- ❌ 实盘自动开关（默认 false，AB 验证后人工切 true）
- ❌ 给 `SymbolState` 加新字段（评分无状态）
- ❌ 修改累计 VWAP / ATR 的计算方式

---

## 3. 评分组成（3 个指标，满分 100）

每根已收盘 K 线触发一次评分。输入：**最近 30 根已收盘 1 分钟 bar + 当日累计 VWAP（单一数值，当根 K 时刻）+ 当日 ATR**。

**分数越高越趋势，越低越震荡。**

### 3.1 指标 1：VWAP 穿越次数（权重 40）

**直觉**：过去 30 分钟价格穿过 VWAP 几次。震荡票每隔几分钟穿一次，趋势票穿 0–1 次就走开。

**算法**（用单一 VWAP，所有 30 根 bar 都和"当根时刻的累计 VWAP"比较）：

```
side[i] = sign(bars[i].close - vwap)        // +1 / -1 / 0

crossings = 0
for i in 1..29:
  if side[i] != 0 and side[i-1] != 0 and side[i] != side[i-1]:
    crossings += 1
```

`side[i] === 0`（close 恰好等于 vwap，极少）按"无变化"处理，跳过该次比对。

**分档**（值越小分越高）：

| crossings | 分数 |
|---|---|
| 0–1 | 40 |
| 2–3 | 25 |
| 4–5 | 10 |
| ≥ 6 | 0 |

**边界示例**：
- 30 根全在 VWAP 上方 → crossings = 0 → 40 分
- 前 15 根 +1、后 15 根 −1 → crossings = 1 → 40 分（一次大反转也判趋势）
- +1, −1, +1, −1, ... → crossings ≈ 29 → 0 分

### 3.2 指标 2：带内时长比（权重 30，三档独立加权）

**直觉**：过去 30 分钟价格"贴 VWAP"贴得多紧。

**算法**：

```
inBand_01 = count(i in [0..29]) where |close[i] - vwap| <= 0.1 * atr) / 30
inBand_02 = count(i in [0..29]) where |close[i] - vwap| <= 0.2 * atr) / 30
inBand_03 = count(i in [0..29]) where |close[i] - vwap| <= 0.3 * atr) / 30
```

天然满足 `inBand_01 ≤ inBand_02 ≤ inBand_03`。

**分档**（每档独立打分，满分 10，三档加和最高 30）：

| ratio | 0.1 带分数 | 0.2 带分数 | 0.3 带分数 |
|---|---|---|---|
| ≤ 0.3 | 10 | 10 | 10 |
| 0.3–0.5 | 6 | 6 | 6 |
| 0.5–0.7 | 3 | 3 | 3 |
| > 0.7 | 0 | 0 | 0 |

**含义**：
- 三档全走出（都 ≤ 0.3）→ 30 分（明确趋势）
- 0.3 带 ≤ 0.3 但 0.1 带 > 0.7 → 0 + 6 + 10 = 16 分（说明价格大部分时间在 0.1 带内紧贴 VWAP，是死磨）
- 三档都 > 0.7 → 0 分（一直贴着 VWAP）

能区分"严贴 VWAP 死磨"和"宽幅震但不死磨"，前者扣分更狠。

### 3.3 指标 3：滚动 Range / ATR（权重 30）

**直觉**：30 分钟内价格走出多少幅度（相对于今天的 ATR）。趋势日 Range 扩张，震荡日 Range 收窄。

**算法**：

```
range30 = max(bars[i].high) - min(bars[i].low)   for i in [0..29]
ratio   = range30 / atr
```

`atr` 是当日 ATRManager 给的值（已经是 7 日历史 ATR）。

**分档**（值越大分越高）：

| ratio | 分数 |
|---|---|
| ≥ 1.0 | 30 |
| 0.6–1.0 | 20 |
| 0.3–0.6 | 10 |
| < 0.3 | 0 |

### 3.4 总分与门槛

```
total = crossingsScore + bandRatioScore + rangeScore   // 0–100
canEnter = total >= CHOP_SCORE_THRESHOLD               // 默认 35
```

**阈值 35 的初始直觉**：3 个指标各拿次低档约能到 25 + (6+6+6) + 10 = 53。35 大约对应"1 个指标跌到底 + 其他两个中等"。**真实阈值靠回测网格搜索定**（25 / 30 / 35 / 40 / 45），spec 只给起点。

---

## 4. 时序与 warmup

- **触发时机**：`onBar` 每根新收盘 K 线都重算（与 `canOpen` 同节奏）
- **窗口大小**：30 根已收盘 1 分钟 bar（`closedBars.slice(-30)`）
- **冷启动**：当日 `closedBars.length < 30` 时**直接放行**（评分返回 `null`，`canOpen` 视同未启用）
  - 等价于每天 09:30–10:00 评分不生效
  - 这一段由 09:35 trend score 覆盖，是有意取舍
- **依赖数据**：`vwap`（已有 `calcVWAP(quote)`）、`atr`（已有 ATRManager 当日值）、`closedBars`（onBar 已有），**无新外部依赖**

---

## 5. 配置项

`src/config/strategy.config.ts` 新增：

```typescript
filters: {
  // ...现有字段
  enableChoppiness: false, // 默认关闭，AB 切回旧行为
},

// ========================
// 日内震荡过滤（B2-lite，仅在 filters.enableChoppiness=true 时生效）
// 评分组成：VWAP穿越次数(40) + 带内时长比(30，三档加权) + 滚动Range/ATR(30)
// ========================
choppiness: {
  windowBars: 30,           // 滚动窗口（根 K）
  bandAtrRatios: [0.1, 0.2, 0.3], // 三档带宽
  scoreThreshold: 35,       // 总分 < 阈值禁开仓（0–100）
},
```

不和 `vwapBandAtrRatio`（入场带宽）合并：那是入场触发用的，故意是 0；这里是评分用的"带内"判定，两套独立语义。

---

## 6. 模块结构

### 6.1 新增：`src/core/indicators/choppiness.ts`（纯函数）

```typescript
export interface ChoppinessParams {
  windowBars: number;
  bandAtrRatios: number[]; // 例如 [0.1, 0.2, 0.3]
}

export interface ChoppinessScore {
  total: number;             // 0–100
  crossings: number;         // 分项分（满分 40）
  bandRatio: number;         // 分项分（满分 30）
  range: number;             // 分项分（满分 30）
  details: {
    crossingCount: number;       // 实际穿越次数
    inBandRatios: number[];      // 各档实际带内比例 0–1，与 bandAtrRatios 同序
    rangeAtrRatio: number;       // 实际 Range / ATR
  };
}

/**
 * 入参 bars 是最近 windowBars 根已收盘 K（按时间正序）。
 * 不足 windowBars 根 / atr <= 0 / vwap <= 0 → 返回 null。
 */
export function scoreChoppiness(
  bars: Candlestick[],
  vwap: number,
  atr: number,
  params: ChoppinessParams,
): ChoppinessScore | null;
```

**为什么入参用 `Candlestick`**：实盘走 longport 类型；回测 runner 已有 `Candlestick → SerializedBar` 转换。trendDetector 用 SerializedBar 是因为它跨日聚合需要 timestamp 做日期分组；choppiness 是日内滚动，不需要日期感知，吃 Candlestick 更省事。如果 runner 那边只持有 SerializedBar，可在 runner 里做一个轻量适配（只用到 high / low / close 字段）。

### 6.2 修改：`src/strategy/vwapStrategy.ts`

- `canOpen` 签名增加 `chopScore: ChoppinessScore | null` 参数
- 增加 `chopOk` 判定，与现有过滤器并联（与 RSI / 量比 / 动量同级）：

  ```
  chopOk =
    !filters.enableChoppiness ||
    chopScore === null ||                // warmup 期放行
    chopScore.total >= cfg.scoreThreshold
  ```

- 入场触发日志增加一行：
  ```
  震荡评分: total=X (穿越=Y/40 带内=Z/30 范围=W/30) 阈值=N 结果=通过/不通过
  ```

### 6.3 修改：`src/strategy/vwapStrategy.ts::onBar`

```typescript
const chopScore = filters.enableChoppiness
  ? scoreChoppiness(
      closedBars.slice(-cfg.windowBars),
      vwap,
      atr,
      { windowBars: cfg.windowBars, bandAtrRatios: cfg.bandAtrRatios },
    )
  : null;
```

注意用 `closedBars`（不是 `preBars`）—— `preBars` 只取了 `rsiPeriod + 1` 根，不够 30 根。

### 6.4 修改：`src/backtest/runner.ts`

- 在回放循环里同步调 `scoreChoppiness`（runner 仿写了 canOpen，必须对齐口径）
- 给每条 trade 记录 `entryChopScore`（成交那一刻的总分 + 三个 details），用于事后分析"被震荡过滤拦掉的票本来 R 是多少"
- runner finally 恢复 `config.filters.enableChoppiness`（与现有 `stopAtrRatio` / `exitMode` 同模式）

### 6.5 不动

- `src/core/state.ts` —— choppiness 是无状态判定，无需新字段
- `managePosition` —— 不影响出场
- 累计 VWAP / ATR 的计算方式 —— 完全复用

---

## 7. 回测验证方案

### 7.1 第一步：基准 + 阈值单变量扫描

在现有一年样本上（`enableTrendDetector = true` 保持开启作为同基线）跑：

| 配置 | enableChoppiness | scoreThreshold | windowBars |
|---|---|---|---|
| baseline | false | — | — |
| chop-25 | true | 25 | 30 |
| chop-30 | true | 30 | 30 |
| chop-35 | true | 35 | 30 |
| chop-40 | true | 40 | 30 |
| chop-45 | true | 45 | 30 |

对比指标（按优先级）：

1. **per-trade R 均值 / 中位数**（首要）
2. **胜率**（首要）
3. **总 cumR**（不能跌超 20%）
4. **总 trade 数**（确认确实在过滤）
5. **被拦截 trade 的"假想 R"**（如果让它入场，回测出场后会赚多少）—— 衡量过滤准确度

### 7.2 第二步：window 敏感度（按需）

固定第一步胜出的阈值，扫 `windowBars ∈ {15, 20, 30, 45, 60}`。

用户表态：30 分钟暂时 OK，**第一步先不做这步**。

### 7.3 第三步：分段验证（防过拟合）

把一年样本切前 6 / 后 6 个月。第一步在前 6 个月调参，胜出参数在后 6 个月跑一次验证。

**判定**：如果后 6 个月 per-trade R 涨幅 < 前 6 个月的一半，认定过拟合 → 回到设计阶段降复杂度（例如砍掉指标 2 的三档加权，回退到单档）。

### 7.4 第四步：bad_case 复盘

挑 CRDO / INTC / MRVL 在 bad_case 图对应的具体交易日，确认在新配置下：

- 被禁开仓的 trade 数显著下降
- 没有把"真正赚钱的 trade"也拦掉

---

## 8. 落地步骤（实现顺序）

1. 写 `src/core/indicators/choppiness.ts` + 单元测试
   - case：纯多头单边、纯震荡、warmup 不足、atr=0、close 恰好等于 vwap、宽窄带组合
2. `strategy.config.ts` 加字段（默认 `enableChoppiness=false`，对线上零影响）
3. 接入 `vwapStrategy.canOpen` + `onBar`
4. 接入 `runner.ts`，trade 记录 chopScore details
5. 跑第一步网格搜索，产出对比表（保留为 markdown 报告）
6. 根据结果决定是否进入第三步分段验证 / bad_case 复盘 / 上线

---

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 过拟合一年样本 | 第三步分段验证 |
| 与 trendDetector 双门槛叠加导致交易雪崩 | baseline 已含 trendDetector=on，所有对比都在它之上做差 |
| 30 根窗口跨越收盘后/盘前 | onBar 已 filter `TradeSession.Intraday`，`closedBars` 都是日内 K |
| 实盘 / 回测口径漂移 | 纯函数 `scoreChoppiness` 共用 |
| warmup 期（前 30 分钟）放行可能错入震荡仓 | 接受。trendDetector 覆盖开盘 5 分钟。如 bad_case 集中在前 30 分钟，再加 warmup 内的特殊规则 |
| Candlestick / SerializedBar 类型不一致 | `scoreChoppiness` 只用 high/low/close，runner 侧做 duck-type 适配即可 |

---

## 10. 决策记录（关键岔路口）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 评分形态 | B2-lite 实时滚动（每根 K 重算） | 用户明确选择；B1 单点升级抓不住"上午震下午突破"等形态 |
| 评估口径 | per-trade R / 胜率优先 | 用户明确选择 |
| 指标数量 | 3 个（vs 完整版 4–5 个） | lite 版控制过拟合风险与调参成本 |
| 窗口大小 | 30 根 | 用户初选；后续可按敏感度实验调整 |
| 指标 1 用单一 VWAP（vs 逐根 VWAP） | 单一 | 30 分钟内 VWAP 变化小；和实盘 `calcVWAP(quote)` 对齐，无需维护 VWAP 历史序列 |
| 指标 2 多档处理 | 选项 a：三档独立加权 10+10+10 | 能区分"严贴 VWAP 死磨"和"宽幅震不死磨"，前者扣分更狠 |
| 默认阈值 | 35（先跑 25–45 网格） | 直觉对应"1 个指标跌底 + 其他中等"；最终值靠回测定 |
| 是否新增 SymbolState 字段 | 否 | 评分无状态 |
| 是否影响出场 | 否 | 仅入场判定 |
| 默认开关 | `enableChoppiness=false` | 与其他 filters 一致，保留 AB 切回 |

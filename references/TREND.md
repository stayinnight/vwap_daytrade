# 趋势日检测模块（Trend Day Detector）

每个交易日 09:35 对每支票打一次分，分数 ≥ `TREND_SCORE_THRESHOLD` 才允许当日开仓。

实现代码：`src/core/trendDetector.ts`（纯函数，回测 + 实盘共用）
实盘集成：`src/index.ts`
回测集成：`src/backtest/runner.ts`（CLI flag `--filter-trend=on|off`、`--trend-threshold=N`）

---

# 一、评价窗口

| 项 | 值 |
|---|---|
| 评价窗口 | 09:30–09:34（5 根 bar） |
| 打分时刻 | 09:35 |
| RVOL 基线 | 前 5 天同窗口均值 |
| 禁交易窗口 | 09:30–09:34（等同于 `config.noTradeAfterOpenMinutes=5`） |

---

# 二、评分系统

指标 = 6 个"传统量能/波动率"指标（指标一~六） + 2 个"K 线身形"指标（指标七、八） + 3 个"日内百分比波动"指标（指标九~十一）。

当前生产配置下**禁用了指标三（Opening Drive）和指标八（Prior Day Shape）**，以及指标七的两个子档（长影线型、满实体型）。代码保留，通过阈值设高或 `maxScore=0` 实现"禁用但便于恢复"。

总分上限 **170**，实际最高 **160**（Prior Day Shape 被禁用）。

## 指标一：Gap Filter（25 分）

```js
gapPct = abs(open - prevClose) / prevClose
```

| Gap  | 分数 |
| ---- | ---- |
| > 2% | 25 |
| else | 0 |

## 指标二：Relative Volume（40 分，权重最高）

```js
RVOL = 今日前 5 分钟成交量 / 前 5 天平均前 5 分钟成交量
```

| RVOL | 分数 |
| ---- | ---- |
| > 2 | 40 |
| > 1.3 | 20 |
| else | 0 |

> 实盘版的 RVOL baseline 用"前 5 天日线 volume 均值 × 5/390"近似，比回测版粗糙但信号方向一致，实盘结果会偏宽松。

## 指标三：Opening Drive（0 分，已归零）

```js
drive = abs(price_0934 - open) / prevAtr
```

归零：5 分钟窗口下方向尚未确定，drive 值等同随机。代码保留 `DRIVE_TIERS = []`，未来可通过填阈值快速恢复。

## 指标四：VWAP 控制力（5 分）

09:30–09:34 的 5 根 bar 统计每根 close 站在累积 VWAP 上方/下方的比例。

| 条件 | 分数 |
| ---- | ---- |
| 占比 ≥ 80%（4/5 以上站一侧） | 5 |
| else | 0 |

## 指标五：Range Expansion（30 分，主力信号）

```js
rangeAtrRatio = (前 5 分钟 high - low) / prevAtr
```

| Range | 分数 |
| ---- | ---- |
| > 1.0 ATR | 30 |
| > 0.5 ATR | 15 |
| else | 0 |

## 指标六：ATR%（15 分，底部筛选）

```js
atrPct = prevAtrShort / prevClose
```

用前收（`prevClose`）作分母，反映"这只票最近几天的跨日波动率"。`prevAtrShort` 默认周期 7 天（`TREND_ATR_SHORT_PERIOD_DEFAULT`），和 Range 指标共用 ATR，回测时可通过 `--trend-atr-period=N` 改变。

| ATR% | 分数 |
| ---- | ---- |
| > 3.0% | 15 |
| else | 0 |

作用：过滤跨日波动率 < 3.0% 的"死水票"。

## 指标七：Opening Shape（15 分）

开盘 5 分钟合成一根 K 线（`open=window[0].open, close=window[4].close, high=max(high), low=min(low)`），对身形打分。

**Max-of-three**（三档独立判定，命中任一档给满分）：

| 档 | 条件 | 状态 |
|---|---|---|
| 长影线型 | `(上影 + 下影) / 总长度 ≥ longShadowRatio` | **禁用**（阈值设 1.01 不可达） |
| 满实体型 | `body / 总长度 ≥ fullBodyRatio` AND `总长度 / open ≥ fullBodyMinTotalPct` | **禁用** |
| 超长 K 线型 | `body / prevAtr ≥ 0.6` | **生效**（唯一活档） |

命中 → 15 分；否则 0。

诊断字段 `details.openingShapeTier` 归类优先级：long-kline > full-body > long-shadow（仅影响归类标签，不影响评分）。

## 指标八：Prior Day Shape（0 分，已禁用）

昨日日线 K（从 `baseline.prevDayOHLC` 读出）走同一个 `scoreCandleShape` 函数打分，阈值更严（`fullBodyMinTotalPct=1%`、`longKlineBodyAtr=0.8`）。

当前 `maxScore=0` 整个指标禁用 —— 昨日形态对次日是**反向信号**（昨日强势延续 → 次日回调）。代码保留计算和诊断字段输出便于未来恢复。

## 指标九：Today Opening Range%（10 分）

```js
todayRangePct = (5min_high - 5min_low) / window[0].open
```

| Range% | 分数 |
| ---- | ---- |
| > 0.8% | 10 |
| else | 0 |

排除 overnight gap，纯日内视角。和指标五（Range / prevAtr）的区别：分母用当日开盘价而非昨日 ATR，在"绝对百分比空间"这个维度上补一个视角。

## 指标十：Prior Day Range%（10 分）

```js
priorDayRangePct = (prevDay.high - prevDay.low) / prevClose
```

| Range% | 分数 |
| ---- | ---- |
| > 2.5% | 10 |
| else | 0 |

昨日单日日内波动率（排除 gap）。用前一日 OHLC 已有字段，零新增计算。

## 指标十一：Prev Range% Avg (7 day)（10 分）

```js
prevRangePctAvg7 = mean((dailyHigh - dailyLow) / dailyClose)  // 前 7 天
```

| Range% Avg | 分数 |
| ---- | ---- |
| > 2.5% | 10 |
| else | 0 |

前 7 天日内波动率均值，排除 gap。和指标六 ATR% 的区别：ATR 含 overnight 跳空，本指标纯日内。高相关但在 gap 频发标的上行为分叉。窗口长度常量 `TREND_RANGE_PCT_AVG_LOOKBACK = 7`。

---

# 三、最终评分公式

```js
score = gap(25) + rvol(40) + drive(0) + vwap(5) + range(30)
      + atrPct(15) + openingShape(15) + priorDayShape(0)
      + todayRangePct(10) + priorDayRangePct(10) + prevRangePctAvg7(10)
// 总分上限 = 170,实际最高 160(priorDayShape 禁用)
```

---

# 四、交易规则

```text
if score >= TREND_SCORE_THRESHOLD (= 70):
    允许当日开仓

if score < TREND_SCORE_THRESHOLD:
    当日禁开仓(该票所有信号被拦截)

if baseline 不可用(预热期 / 数据缺失):
    放行(不门控)
```

---

# 五、性能（一年样本 2025-04 ~ 2026-04）

| 方案 | trades | winRate | avgR | cumR | maxDD | cumR÷maxDD |
|---|---|---|---|---|---|---|
| 无 detector baseline | 32443 | 38.0% | 0.031 | 1011.6 | 279.8 | 3.62 |
| v4c 初版（score ≥ 55） | 20495 | 38.3% | 0.064 | 1310.6 | 95.2 | 13.77 |
| v4c 调参后（score ≥ 70） | 16209 | 38.9% | 0.076 | 1232.5 | 77.6 | 15.88 |
| **v5 调参后（score ≥ 70）** | **17434** | **39.1%** | **0.077** | **1346.2** | **74.0** | **18.18** |

对比 baseline：trades -46%、maxDD -74%、ratio +402%。对比 v4c-tuned：trades +8%、maxDD -5%、ratio +14%。

调参实验（消融 + 门槛扫）见 `docs/superpowers/plans/2026-04-19-trend-v4c-experiments.md`。

---

# 六、相关文件

| 文件 | 职责 |
|---|---|
| `src/core/trendDetector.ts` | 纯函数评分模块（常量 + 类型 + 3 个导出函数） |
| `src/index.ts` | 实盘集成（初始化 baseline → 09:35 打分 → 交易前过滤） |
| `src/backtest/runner.ts` | 回测集成（预计算 + 主循环打分门控 + CLI flag） |
| `src/backtest/smokeTrendDetector.ts` | Smoke 验证脚本 |
| `src/backtest/analyzeTrendWeights.ts` | 指标区分力诊断脚本 |
| `src/backtest/reportTrend.ts` | 实验报告生成器（含 `summarize()` 工具） |
| `src/config/strategy.config.ts` | `filters.enableTrendDetector`（总开关） |

---

# 附录：历史演进

本模块经历了四次迭代。每次迭代都由 recordonly 诊断驱动手调。

| 版本 | 主要变化 |
|---|---|
| v1 | 15 分钟窗口、5 指标、RVOL 10 天基线 |
| v2 | 缩到 5 分钟窗口、RVOL 5 天基线、Drive 归零、VWAP 降权 |
| v3 | 新增 ATR%（6 指标） |
| v3b | ATR% 分母 09:34 快照价 → `prevClose`（语义更干净） |
| v4 | 新增 Opening Shape / Prior Day Shape（8 指标，上限 140） |
| v4b | Opening Shape 只留 long-kline 档（阈值 0.6）；Prior Day Shape 全禁用；门槛 45 → 55 |
| v4c | 新增指标九/十/十一（3 个独立的日内百分比波动指标，各 10 分）；总分 140 → 170；门槛维持 55 |
| v4c-tuned | 消融实验确认指标九/十/十一均净正向贡献；门槛 55 → 70（ratio 13.77 → 15.88，cumR -6%） |
| **v5（当前）** | 三阶段 greedy 网格搜索（基于 recordonly seed 离线 rescore）调 3 个阈值：RVOL 低档 v 1.5→1.3、ATR% 0.025→0.03、todayRange% 0.01→0.008；权重/门槛不变。硬约束 cumR ≥ 95% v4c 下 ratio 15.88 → 18.18 |

详细决策和诊断数据见各版本的 spec 和 plan（`docs/superpowers/specs/` 和 `docs/superpowers/plans/`）。

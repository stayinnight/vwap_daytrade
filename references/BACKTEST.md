# 回测系统参考

本文件描述 `src/backtest/` 下的分钟级向量化回测系统。目标读者：未来重跑回测、调参、加新对照组、写分析脚本的人（或 agent）。

实盘策略代码见 `AGENTS.md` / `CLAUDE.md`，本文件只覆盖**回测**相关的模块、约束和踩坑点。

---

## 1) 设计目标与边界

**做什么**：
- 在历史 1 分钟 K 上快速比较不同策略配置（出场模式、方向过滤、时段规则等）的相对优劣
- 产出每笔 trade 的 R multiple 和时段/方向分解，输出 markdown 报告
- 支撑一次性的"假设验证"型回测，不追求生产级精度

**不做什么**：
- **不做 tick 级 / 秒级重放**，只用 1 分钟 K 的 OHLCV + turnover
- **不模拟滑点和手续费**（实盘期望 R 要打折）
- **不模拟日内回撤兜底**（回测里 dailyRisk 被设成 100% 永不触发）
- **不提供"生产级基建"**，是一次性 ROI 工具 —— 不要过度抽象

分钟级近似有两个已知偏差，解读结果时必须记住：
1. **trailing 模式用 bar.close 近似 5 s tick** —— 实盘扫损更频繁、锁利更快，baseline 在回测里**偏乐观**
2. **同根 K 内 TP 和 SL 都被触及时顺序不可知** —— 用 SLFirst / TPFirst 双假设对照处理，实测 ambiguous 占比在所有现有配置下为 0%

---

## 2) 目录结构

```
src/backtest/
  fetchHistory.ts       # 拉历史分钟 K，落盘到 data/backtest/raw/{symbol}.json
  backtestMarket.ts     # 实现 Market 接口的回测版，duck-type SecurityQuote
  runner.ts             # 主循环 + 撮合 + CLI
  report.ts             # 对比报告生成器（产出 data/backtest/report.md）
  analyzeSymbols.ts     # 按标的盈亏特征分析 V1（前后半段稳健性）
  analyzeSymbolsV2.ts   # 按标的盈亏特征分析 V2（加入量比、趋势、突破跟随率）
  types.ts              # SerializedBar / BacktestTrade / BacktestResult

data/backtest/
  raw/{symbol}.json           # 分钟 K 原始数据，46 支 × 约 2.1 MB / 支
  raw/QQQ.US.json             # 指数数据（供 indexTrendFilter 使用）
  results/{label}.json        # 每组回测的 trade 明细
  report.md                   # 总表 / 时段分解 / 双假设对照 / 按标的 R
  report_p0.md                # P0 一轮的专项报告（indexTrendFilter 颠覆性发现）
  symbol_analysis.md          # 每支票稳健性 V1 报告
  symbol_analysis_v2.md       # V2 报告（含 9 个特征与 cumR 的相关系数）
```

---

## 3) 怎么运行

### 3.1 拉数据（一次性）

```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/fetchHistory.ts           # 拉全部 symbols
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/fetchHistory.ts COIN.US   # 拉单支
```

- 默认时间区间是 `fetchHistory.ts` 顶部的 `DEFAULT_START` / `DEFAULT_END`，可用 `--since=YYYY-MM-DD` / `--until=YYYY-MM-DD` CLI flag 覆盖（见下）
- longport `historyCandlesticksByDate` **单次上限约 1000 根**（2.5 个盘中日），脚本用 `WINDOW_DAYS=2` 的窗口滚动拉取，每窗口之间 `sleep(150ms)` 防速率限制
- 46 支 × **12 个月**约 **585 MB**（含 QQQ.US），约 **30–60 分钟**拉完。整支拉取时偶尔会触发单支 `request timeout`（约 8/45 概率），脚本会把失败标的列在 `失败清单` 末尾，**单支重拉**几乎都能成功
- 已有 json 文件存在时**会自动按 timestamp 去重合并**，所以 `--since=2025-04-11 --until=2026-02-11` 跑完后再 `--since=2026-02-12 --until=2026-04-10` 是等价于一次性拉一年的结果。要做时间区间扩展，**优先用增量拉取**而不是全量重跑
- **QQQ.US 不在 `config.symbols` 里**（runner 单独加载供 indexTrendFilter 用），全量批次跑不会覆盖它，必须显式 `fetchHistory.ts QQQ.US --since=...` 单独补
- **TRADE_ENV=test 必须设置**，否则 `initTradeEnv()` 拿不到 longport 凭证

`fetchHistory.ts` CLI 完整签名：

```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/fetchHistory.ts \
  [SYMBOL.US] [--since=YYYY-MM-DD] [--until=YYYY-MM-DD]

# 全部标的，默认区间
src/backtest/fetchHistory.ts

# 单支，默认区间
src/backtest/fetchHistory.ts COIN.US

# 单支，自定义区间（增量拉旧数据）
src/backtest/fetchHistory.ts COIN.US --since=2025-04-11 --until=2026-02-11

# 全部标的，自定义区间
src/backtest/fetchHistory.ts --since=2025-04-11 --until=2026-02-11
```

### 3.2 跑回测

```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts \
  <label> <trailing|fixed> [tp] [sl] [SLFirst|TPFirst] \
  [--stop-atr=N] \
  [--filter-rsi=on|off] [--filter-volume=on|off] \
  [--filter-entry-phase=on|off] [--filter-index=on|off]
```

**位置参数**：
- `label`：结果文件名（`data/backtest/results/{label}.json`）
- `trailing` / `fixed`：出场模式
- `tp` / `sl`：仅 fixed 模式用的 ATR 倍数
- `SLFirst` / `TPFirst`：同根 K 内 TP/SL 冲突时谁先触发，默认 SLFirst

**--flag 参数**（任选覆盖 `config.stopAtrRatio` / `config.filters.*`，未指定则沿用 config）：
- `--stop-atr=N`：trailing 模式的初始止损宽度（ATR 倍数），默认读 `config.stopAtrRatio`
- `--filter-rsi=on|off`：启用/禁用 RSI 阈值过滤
- `--filter-volume=on|off`：启用/禁用 量比阈值过滤
- `--filter-entry-phase=on|off`：启用/禁用 分时段 "价格段 vs 主段" 规则
- `--filter-index=on|off`：启用/禁用 指数斜率方向门控
- `--filter-trend=on|off`：启用/禁用 趋势日评分门控（见 `src/core/trendDetector.ts`、`docs/superpowers/specs/2026-04-14-trend-detector-design.md`）

旧版一次性实验 flag (`--index` / `--long-only` / `--short-only` / `--reverse-index` / `--phase-directional` / `--entry-mode` / `--epsilon` / `--when-unavail`) 已经删除；方向性/分时段类实验已被一年样本证伪。

举例：

```bash
# baseline（和实盘最接近 — 当前 config 下 filters 全部关闭，等价于"全天只看价格"）
runner.ts baseline trailing

# 固定 TP/SL 实验
runner.ts fixed_0.5_0.35_SLFirst fixed 0.5 0.35 SLFirst

# 回滚对照：开旧的 RSI + 量比 + 分时段规则
runner.ts legacy_filters trailing --filter-rsi=on --filter-volume=on --filter-entry-phase=on

# 单独测 RSI 过滤
runner.ts rsi_only trailing --filter-rsi=on

# 旧 P0 实验：开 QQQ 指数过滤
runner.ts with_index trailing --filter-index=on

# 调止损宽度
runner.ts sl_narrow trailing --stop-atr=0.1

# 趋势日 detector（09:45 按分数门控，< 60 分禁开仓）
runner.ts trend_score60_sl010 trailing --filter-trend=on
```

单次回测机器时间：**3–6 min**（45 支 × ~252 日 × 390 分钟 ≈ 4.4M bar）。短样本（2 个月）只需 30 s – 1 min。

### 3.3 生成对比报告

```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/report.ts
```

读 `data/backtest/results/*.json` 合并双假设（`_SLFirst` / `_TPFirst`），输出到 `data/backtest/report.md`。包含：
- 总表：交易数 / 胜率 / 平均盈亏 R / 期望 R / 累计 R / 最大回撤 / TP-SL-FC 占比
- 时段分解表
- SLFirst vs TPFirst 双假设对照
- 按标的 cumR 对比（baseline vs fixed_0.5_0.35）

### 3.4 按标的分析

```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/analyzeSymbols.ts     # V1
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/analyzeSymbolsV2.ts   # V2
```

V1 和 V2 都读 `results/baseline.json`（硬编码），如果你想分析别的 label 需要改源码里的文件名。

---

## 4) 关键实现要点

### 4.1 跨语言一致性：不重写策略逻辑

**最重要的设计决策**：runner 直接 `import VWAPStrategy` 和实盘相同的 `canOpen()` 做信号判断，**不翻译成 Python 或另写一份**。这避免了"两份真相"的维护地狱。

代价：策略代码里 `onBar` / `open` / `managePosition` 会调用 `placeOrder` / `getAccountEquity` 等 longport 副作用接口，所以 runner **只调 `canOpen`（纯信号函数），自己管仓位和撮合**。

### 4.2 BacktestMarket：duck-type SecurityQuote

longport 的 `SecurityQuote` 是 native class 无法 `new`，`calcVWAP(quote)` 读的是 `quote.turnover.toNumber() / quote.volume`。解决方案：

- `BacktestMarket.getQuote(symbol)` 返回一个 duck-typed 对象，只实现策略实际用到的 5 个字段：`symbol / lastDone / turnover / volume / timestamp`
- 用 `as unknown as SecurityQuote` 强转绕过 longport native class 的 nominal 类型检查
- **turnover 和 volume 是按日累积的**（和实盘 `quote.turnover` 的语义对齐），跨日自动重置
- `getPostQuote(symbol)` 返回最近 `QUOTE_LENGTH=60` 根的历史伪 quote 序列，**新的在前、旧的在后**，和 `realTimeMarket.Market.getPostQuote` 顺序一致（`calcVWAPSlope` 内部 `.reverse()` 后做线性回归）

### 4.3 交易日键用 UTC 日，不用美东日

美股盘中分钟 K 的 UTC 时间戳永远不会跨 UTC 日界（EST 14:30–21:00、EDT 13:30–20:00），所以 **BacktestMarket 直接用 UTC 日期作为交易日分组键**，不需要处理 DST。这条约束在其他交易所不成立，移植时要小心。

### 4.4 时段切换：monkey-patch timeGuard

`canOpen` 里调用 `timeGuard.getTradeProgressMinutes()` 判断早盘/主段/尾盘，而 `timeGuard` 读的是 `new Date()`（实时系统时间）。回测里 **runner 在主循环每个 tick 前把全局变量 `currentBarTs` 设为当前 bar 的时间戳，并 monkey-patch `timeGuard.getTradeProgressMinutes` 返回基于该时间戳的美东进度**。

这样策略代码不用改，回测的早盘/主段/尾盘判断和实盘一致。

### 4.5 ATR 预计算：从分钟 K 聚合日线

实盘 `ATRManager.preloadATR()` 在交易日开始前拉日线算 ATR，回测为了避免额外网络请求，**从分钟 K 聚合每日 OHLC**（high=max、low=min、close=最后一根 close），然后用 `technicalindicators.atr` 算每日 ATR，在每个交易日开始时查表更新 `atrMap[symbol]`。

**需要 `atrPeriod + 1 = 8` 天预热**，所以一个 N 天样本里只有 N-8 个有效交易日产生信号。在 2 个月样本（~40 日）里这是 20% 的损失，在一年样本（~252 日）里只剩 3%。

**重要副作用：ATR 序列依赖样本起点**。在 `2026-02-12` 起跑得到的 ATR 数列，和在 `2025-04-11` 起跑跑到 `2026-02-12` 当日得到的 ATR 数列是**不一样的** —— 后者是滚动 7 日 ATR 的真实历史值，前者是从样本起点重新累计的。因此**用一年回测切片到旧 2 个月区间 ≠ 旧 2 个月独立回测**：trade 数量、入场时机、initialRisk、rMultiple 都会不同。这不是 bug，是预热长度对 ATR 的真实影响。**长样本回测的 ATR 更准确**，要做"跨样本对比结论是否稳健"的实验时，统一用一年数据为基准。

### 4.6 撮合假设

- **入场**：信号在 bar `t` 产生（策略读的是已收盘的 bars[0..t]），成交价 = `bar[t+1].open`（模拟实盘"信号后下一个 tick 成交"）
- **入场后同根 bar 立即检查 TP/SL**：入场价是 open，bar 的 high/low 之间的任意价格都可能触及 TP/SL，不检查会漏掉"< 1 bar 就走完"的交易
- **fixed 出场**：用 bar 的 `[low, high]` 判 TP/SL，同根 K 冲突用 `ambiguousResolution` 决定先判哪个，成交价 = 被触发的价位
- **trailing 出场**：用 bar.low/high 判 SL 触发，`bar.close` 近似 tick 更新 `stopPrice`
- **尾盘强平**：`minutesToClose <= closeTimeMinutes` 的第一根 bar 强平，成交价 = 该 bar 的 close

### 4.7 runner 主循环粒度

按"全标的时间轴合并"推进 —— 所有标的的 bar 按 timestamp 分组成 `tickMap`，每个时间戳遍历一次所有有数据的标的。由于 46 支票都是 390 根/天且时间戳严格对齐，**本质上按分钟推进**。

日切时（UTC 日期变化）：
1. 刷新每支票的 ATR 为"前 N 日日线 ATR"
2. **清空所有 position 和 strategy state**（等同于实盘每日尾盘强平 + 开盘重建）

---

## 5) 容易踩的坑（按严重程度排序）

### 5.1 ts-node 的 ESM/CJS 切换

项目 `tsconfig.json` 里 `module: ESNext`，但回测脚本走 CommonJS 更方便。所有回测脚本必须用：

```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only ...
```

少了 `TS_NODE_COMPILER_OPTIONS` 会报 `Cannot use import statement outside a module`。

### 5.2 runner 修改 config 必须恢复

runner 为了让 `canOpen` 读到正确的 `exitMode` / `indexTrendFilter.*`，会**直接赋值 `config` 字段**（因为 `strategy.config.ts` export 的是一个单例对象，运行时可变）。每次 `runBacktest()` 结束必须恢复原值，否则串跑多组会互相污染。目前 runner 里已经保存了 `savedExitMode` / `savedIndexFilter` 并在末尾恢复。

### 5.3 SymbolState 新增字段要容忍 undefined

和实盘一致 —— `lowdb` 反序列化旧数据时新字段会是 `undefined`。回测里虽然没用 `lowdb`，但策略代码共享，新字段必须走 `?? defaultValue` 形式访问。

### 5.4 `calcVWAPSlope` 的输入顺序

**新的在前、旧的在后**。`BacktestMarket.advanceTo` 里用 `arr.unshift(snap)` + `arr.pop()` 维持这个顺序。写错成时间正序会让斜率符号反过来，整个指数过滤失效（而且不会报错 —— 是"静默错位"）。

### 5.5 `fetchHistory` 的单次上限

`historyCandlesticksByDate` 单次最多返回 1000 根，**且是从 `end` 向前截取**。一次拉满 2 个月会得到末尾 2.5 天而不是整段。脚本用 `WINDOW_DAYS=2` 按日期窗口滚动拉取并用 `Set<timestamp>` 去重合并，修改时不要回退成"一口气拉"的写法。

### 5.6 runner 和 config.symbols 同步

runner 通过 `loadAllData()` 根据 `config.symbols` 加载数据。**如果你在 config 里删除了某支票但 `data/backtest/raw/` 下还有它的 json，回测会自动跳过它**（因为 `loadAllData` 只 loop config.symbols）。但反过来如果 config 里加了新票而 raw 目录没有，会报 `缺失数据文件` 警告并跳过 —— 要手动先跑 `fetchHistory.ts <新票>`。

### 5.7 时段边界的微妙差异

`getPhaseAtTs` 和 `canOpen` 里的 `isEarlyPriceOnly / isLatePriceOnly` 用的是**相同的 schedule**，但分别在不同调用栈里算。`p0_phase_directional` 之所以实际 +58.4R 而不是理论 +60.7R，有 27 笔"漏网"信号就来自两处判断的边界对齐略有偏差（分钟数是浮点，`<= 30` 和 `< 30` 的差异）。这是已知限制，可接受。

---

## 6) 主要结论（更新时间：批次 A 落地后）

**当前 config 落地（可通过 `config.filters.*` 一键回滚）**：

- `stopAtrRatio` = 0.1（原 0.2）
- `filters.enableRsiFilter` = false（关 RSI 阈值）
- `filters.enableVolumeFilter` = false（关量比阈值）
- `filters.enableEntryPhaseFilter` = false（关分时段规则）
- `filters.enableIndexTrendFilter` = false（关指数方向门控）

组合效果（vs 旧 baseline_1y = SL=0.2 + legacy filters on）：

| 组合 | cumR | maxDD | 多头 R | 空头 R |
|---|---|---|---|---|
| 旧 baseline (SL=0.2 + legacy filters on) | +675 | 178 | +510 | +165 |
| 只改 SL→0.1 | +1012 | 280 | +605 | +406 |
| 只关 filters (loose) | +869 | 213 | +609 | +260 |
| **当前 config (SL=0.1 + loose)** | **+1934** | 328 | +990 | +943 |

核心发现：RSI + 量比 + 时段过滤器合起来在一年样本下是**强负贡献**，特别**压制了空头 alpha**（+943 → +165）。真相不是"alpha 在空头"也不是"alpha 在多头"，而是 **loose 下多空接近 1:1 都是 alpha 来源，legacy 过滤器破坏了双向突破的平衡**。

验证后仍然成立的硬结论（按可信度降序）：

1. **SOXL 单只 -21.57R**（2 个月样本）：3× 杠杆 ETF 和现货逻辑不同，剔除后 baseline cumR 从 +0.5 → +22.06。**已落地实盘**。一年样本里 SOXL 仍未拉数据（已从 config.symbols 剔除）。
2. **固定 TP/SL 全面输给 trailing**：4 组 fixed 配置累计 R 从 -40 到 -76，证伪"换成固定比例止盈"的改造方向。一年样本未重跑 fixed 系列，结论仍来自 2 个月样本。
3. **`indexTrendFilter` 在 2026-02~04 样本里有害**：因为 QQQ 斜率偏正导致过滤器退化成"只做多"，恰好把 alpha 来源的空头拦住。**已关闭实盘**。一年样本未重跑指数过滤实验。
4. **ambiguousExit 占比 = 0%**：分钟级回测的"同 K 冲突"精度问题在当前参数下不存在，SLFirst 和 TPFirst 结果完全一致。
5. **静态标的特征（ATR%、换手、开盘量比等）无法预测盈亏**：9 个特征和 cumR 的相关系数 |r| 都 < 0.22，选股规则沉淀不出来。基于 2 个月样本，一年样本未重做。

### 批次 B：趋势日 Detector 实验（2026-04-15 跑）

Spec: `docs/superpowers/specs/2026-04-14-trend-detector-design.md`
Plan: `docs/superpowers/plans/2026-04-14-trend-detector.md`
详细报告: `data/backtest/report_trend.md`

三组对照（一年样本，当前 config）：

| label | trades | winRate | avgR | cumR | maxDD | cumR÷maxDD |
|---|---|---|---|---|---|---|
| baseline_loose_sl010 (对照) | 59015 | 37.7% | 0.0328 | 1933.7 | 327.7 | 5.90 |
| trend_recordonly_sl010 (门控关，记录分数) | 59015 | 37.7% | 0.0328 | 1933.7 | 327.7 | 5.90 |
| trend_score60_sl010 (门控开 ≥60 允许) | 3213 | 39.7% | 0.0778 | 250.0 | 32.0 | 7.80 |

分数分组（C —— 评分是否有区分度）：

| 分数桶 | trades | winRate | avgR | cumR |
|---|---|---|---|---|
| null (预热期) | 10921 | 36.9% | 0.0396 | 432.7 |
| 0 ≤ s < 30 | 36628 | 37.5% | 0.0187 | 683.6 |
| 30 ≤ s < 60 | 8580 | 38.7% | 0.0638 | 547.0 |
| 60 ≤ s < 80 | 2027 | 40.2% | 0.0727 | 147.4 |
| 80 ≤ s ≤ 100 | 859 | 40.4% | 0.1432 | 123.0 |

**核心发现**：

1. **✅ 评分公式有强区分度**：≥80 分桶 avgR=0.143，< 30 分桶 avgR=0.019，比值约 **7.5×**。TREND.md 的启发式 5 指标评分在当前样本上确实能区分"好日子"。
2. **✅ cumR÷maxDD 提升 +32%**（5.90 → 7.80），满足成功标准（≥ baseline × 90%）。
3. **⚠️ 但绝对 cumR 砍了 87%**（1933 → 250）。门槛 60 过于严苛，高分日机会稀缺（≥60 仅 4.9% 交易）。
4. **⚠️ 09:30–09:44 窗口贡献 436R（22.5% of total）**。方案 A "detector 触发前整段 15 分钟禁开仓" 的代价显著，avgR=0.041 甚至略高于主段 0.031，说明这段信号质量并不差。

**v2 讨论（未开工）**：
- 放宽门槛到 30 或 40（s 30–60 桶 avgR=0.064 仍是 <30 桶的 ~3×）
- 允许 09:30–09:44 pass-through，只对 09:45 之后做门控
- 单指标门控（只用 RVOL 或 Drive）替代总分门槛，避免 VWAP 控制力等弱信号稀释
- 方向性评分（spec §6 的方案 B），绕过当前"全日方向无关"的限制

**当前 config 保持不变**：`filters.enableTrendDetector = false`，v1 仅作为实验沉淀。实盘侧未接入。

**警示（实盘落地前要记住）**：

- ⚠️ 当前 config 的 +1934R **偏乐观**：(a) trailing 用 bar.close 近似 tick；(b) 无滑点/手续费；(c) 美股一年整体偏多头。实盘落地要**小仓位先跑一段**再放量，不要按年化收益率宣传。
- ⚠️ 上面结论表里的数据是在旧 baseline(SL=0.2 + legacy filters on) 对照下计算的。如果你看到 `data/backtest/results/baseline_1y.json`，它对应的是**旧 config 的状态**，不是当前 config。想跑"当前 config 的 baseline"请用新 flag 跑一次。
- ⚠️ MSTR 一年 -44.77R（legacy filters on 下），比 SOXL -21.57R 还差。**在当前 loose + SL=0.1 下需要重新评估**（因为 loose 可能把空头 alpha 释放出来，翻盘）—— 未剔除。
- 📊 2025-12 和 2026-03 是 baseline_1y_sl010 的两个负月，三种 SL 档位下都亏，推测有结构性环境让突破策略失效（高波动震荡市）—— 未来可以加"市场状态过滤器"。

详细数据见 `data/backtest/report.md`（TP/SL 对比）、`data/backtest/report_p0.md`（历史 P0 实验）、`data/backtest/symbol_analysis*.md`（标的分析），以及批次 A 的实验结果 `data/backtest/results/*_1y*.json`。

### 批次 C：趋势日 Detector v2 实验（2026-04-16 跑）

Spec: `docs/superpowers/specs/2026-04-15-trend-detector-v2-design.md`
Plan: `docs/superpowers/plans/2026-04-16-trend-detector-v2.md`
详细报告: `data/backtest/report_trend.md`（更新后包含 v2 数据）

v2 改动：评价窗口 15 分钟 → 5 分钟（09:30–09:34），RVOL 基线 20 天 → 5 天。
基于 5 指标诊断手调权重：Gap 25, RVOL 40, Drive 归零, VWAP 5, Range 30；门槛 60→40。

四组对照（一年样本）：

| label | trades | winRate | avgR | cumR | maxDD | cumR÷maxDD |
|---|---|---|---|---|---|---|
| baseline_loose_sl010 (对照) | 59015 | 37.7% | 0.0328 | 1933.7 | 327.7 | 5.90 |
| trend_v2_recordonly_sl010 (v2 门控关) | 59015 | 37.7% | 0.0328 | 1933.7 | 327.7 | 5.90 |
| trend_v2_score60_sl010 (v2 旧权重 门控开) | 3115 | 40.8% | 0.1355 | 422.1 | 23.8 | 17.74 |
| trend_v2_tuned_sl010 (v2 新权重 门控开) | 10190 | 39.2% | 0.0856 | 872.4 | 45.2 | **19.28** |

**核心发现**：

1. **✅ v2 结构（5 分钟窗口）本身就大幅提升了 ratio**：v2 旧权重 score60 的 ratio = 17.74，是 v1 score60 (7.80) 的 **2.3×**。原因：缩短禁交易窗口保留了 09:35–09:44 的信号。
2. **✅ 手调权重进一步提升**：v2 tuned ratio = **19.28**，比 v2 旧权重 17.74 再提升 9%，trades 从 3115 扩大到 10190（3.3×）。cumR 从 422 → 872（+107%），maxDD 仅从 23.8 → 45.2。
3. **⚠️ 绝对 cumR 仍低于 baseline**：872 vs 1933（45%）。这是"质量 vs 数量"的权衡——detector 把低质量交易过滤后，单笔 R 提升了 2.6×（0.086 vs 0.033），但机会减少了 5.8×。
4. **关键诊断发现**：Opening Drive 在 5 分钟窗口下无单调性（33%），已归零；VWAP 控制力 ratio=1.0 反而比 0.8 差（5 根 bar 全站一侧是随机噪音），降到 5 分；Range 和 RVOL 是主力信号。

v2 分数分组（新权重下 recordonly 的 entryDayScore 分布 —— 注意此处 entryDayScore 用的是旧权重,因为 recordonly 在手调前跑的）：

| 分数桶 | trades | winRate | avgR | cumR |
|---|---|---|---|---|
| null (预热期) | 0 | - | - | 0.0 |
| 0 ≤ s < 30 | 45077 | 37.4% | 0.022 | 989.5 |
| 30 ≤ s < 60 | 10823 | 37.8% | 0.048 | 522.1 |
| 60 ≤ s < 80 | 2168 | 41.2% | 0.130 | 281.9 |
| 80 ≤ s ≤ 100 | 947 | 40.0% | 0.148 | 140.2 |

**当前 config 保持不变**：`filters.enableTrendDetector = false`，v2 仅作为实验沉淀。

---

## 7) 怎么加新的回测实验

典型流程，以"加一个新的出场规则"为例：

1. **如果新规则是 canOpen 内部的过滤（如 RSI/量比/方向门控）** → 在 `strategy.config.ts` 的 `filters` 对象里加开关字段，在 `canOpen` 里加"开关关闭则短路"的分支，runner 通过 `--filter-xxx=on|off` 自动 pick up。参考现有 `enableRsiFilter` / `enableIndexTrendFilter` 的实现。
2. **如果新规则改变出场撮合**（比如新的移动止损算法）→ 在 `VWAPStrategy.managePosition` 里加一个新的 `exitMode` 分支，默认 `trailing` 保持实盘零影响。runner 里会自动 pick up 新 mode。
3. **如果需要新的数据源**（比如加 VIX）→ 扩展 `fetchHistory.ts` 拉新标的，`BacktestMarket.loadBars` 通用不需要改，在 runner 里加载新数据并推进游标（参考 QQQ 的加载方式）。
4. **跑回测 + 看结果**：`runner.ts new_label trailing --new-flag=on`，手写一个 node -e 看关键指标，或者加到 `report.ts` 里自动化。

**不要做**：不要为了"更通用"而重写 runner 为框架化的 backtester。当前 ~750 行是够用的一次性工具，追求生产级基建会让每一次新实验的成本变高。

---

## 8) 相关文件快速索引

| 文件 | 职责 |
|---|---|
| `src/backtest/runner.ts` | 主回测循环 + 撮合 + CLI |
| `src/backtest/backtestMarket.ts` | 伪 Market，duck-type SecurityQuote |
| `src/backtest/fetchHistory.ts` | 历史数据拉取脚本 |
| `src/backtest/report.ts` | 对比报告生成器 |
| `src/backtest/analyzeSymbols.ts` | 稳健性分析 V1 |
| `src/backtest/analyzeSymbolsV2.ts` | 特征相关性分析 V2 |
| `src/backtest/types.ts` | 共享类型定义 |
| `data/backtest/raw/` | 原始分钟 K 数据 |
| `data/backtest/results/` | 每组回测的 trade 明细 |
| `data/backtest/report.md` | TP/SL 对比报告 |
| `data/backtest/report_p0.md` | indexTrendFilter & 方向性 alpha 报告 |
| `data/backtest/symbol_analysis*.md` | 按标的分析报告 |

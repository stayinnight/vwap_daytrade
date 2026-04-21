# 股票池按方向拆分 —— 设计文档

**日期**：2026-04-17
**背景**：当前 `src/config/strategy.config.ts` 的 `symbols` 是一个扁平列表，默认每只票既可做多也可做空。长桥 OpenAPI 对部分标的不支持做空；当你想加一只"只能做多"的新票时，现有结构没有位置表达这一约束，只能要么不加、要么承担"策略可能对它下空单失败"的风险。

**目标**：把标的池拆成 `longSymbols` 和 `shortSymbols` 两个独立列表（可部分重叠），方向门控下沉到策略层，回测与实盘行为对齐。

---

## 1. 配置层

`src/config/strategy.config.ts`：删除 `symbols` 字段，新增两个独立列表：

```ts
longSymbols: [
  'COIN', 'APP', /* ... 迁移时复制原 symbols 的全部内容 ... */
].map(s => s + '.US'),

shortSymbols: [
  // 子集：只有长桥能做空的票才进来
  /* 首次迁移可以先等于 longSymbols，后续再裁剪 */
].map(s => s + '.US'),
```

**语义**：
- `longSymbols`：允许做多的票。
- `shortSymbols`：允许做空的票。
- 两个列表可以部分重叠（常见情况：大盘蓝筹，多空都能做），也可完全独立。

**容忍规则**：
- `shortSymbols: []` 合法：纯多账户场景。策略层做空分支将整体短路。
- 列表内部重复不报错：读取处统一去重（`Array.from(new Set(...))`），并在启动日志 `warn` 一次。
- 不做"启动时校验某票是否两池都没有"——并集决定系统关注宇宙，既不在 `long` 也不在 `short` 的票根本不会进入系统。

**迁移**：首次切换时把现有 `config.symbols`（45 只）整体复制到 `longSymbols`，`shortSymbols` 由用户按长桥做空支持情况人工挑选。迁移是手工的，本 spec 不提供自动脚本。

---

## 2. 派生 `allSymbols` 与消费点改造

新增 `src/config/symbolPools.ts`，提供三个导出：

```ts
// src/config/symbolPools.ts
import config from './strategy.config';

let cached: string[] | null = null;

export function getAllSymbols(): string[] {
  if (cached) return cached;
  const merged = [...config.longSymbols, ...config.shortSymbols];
  const unique = Array.from(new Set(merged));
  if (unique.length !== merged.length) {
    // 只在首次解析时警告，不要每次读取都 warn
    // 具体 logger 调用在实现阶段用项目现有 logger
  }
  cached = unique;
  return cached;
}

export function canLong(symbol: string): boolean {
  return config.longSymbols.includes(symbol);
}

export function canShort(symbol: string): boolean {
  return config.shortSymbols.includes(symbol);
}
```

**缓存理由**：交易日内池不变；重启才会重新加载。缓存一次避免每轮主循环都做 set 去重。

**查找复杂度**：`canLong`/`canShort` 用 `Array.includes`（O(n)）。n≈50、每分钟每票最多调用 2 次，可忽略。若未来需要，改 `Set` 一行完事。

**消费点替换表**（所有 `config.symbols` 改成 `getAllSymbols()`）：

| 文件 | 行 | 现状 | 改后 |
|---|---|---|---|
| `src/index.ts` | 67 | `createBatchPicker(config.symbols, concurrency)` | `createBatchPicker(getAllSymbols(), concurrency)` |
| `src/index.ts` | 131 | `for (const symbol of config.symbols)` (trendDetector baseline) | `for (const symbol of getAllSymbols())` |
| `src/index.ts` | 173 | `config.symbols.length`（日志） | `getAllSymbols().length` |
| `src/index.ts` | 192 | `market.initMarketQuote(config.symbols)` | `market.initMarketQuote(getAllSymbols())` |
| `src/index.ts` | 199 | `for (const symbol of config.symbols)` (09:35 打分) | `for (const symbol of getAllSymbols())` |
| `src/longbridge/trade.ts` | 52 | `c.stockPositions(config.symbols)` | `c.stockPositions(getAllSymbols())` |
| `src/core/indicators/atr.ts` | 66 | ATR 预加载循环 | `getAllSymbols()` |
| `src/backtest/runner.ts` | 156 | 回测循环 | `getAllSymbols()` |
| `src/backtest/fetchHistory.ts` | 215 | `config.symbols` 作为默认 fallback | `getAllSymbols()` |

**设计原则**：这些消费方（订阅行情、ATR 预加载、持仓查询、趋势打分、回测遍历）都不关心方向，只关心"系统要关注哪些票"。用并集是最合理的抽象。

---

## 3. 方向门控（落在 `canOpen()` 内）

`src/strategy/vwapStrategy.ts` 的 `canOpen()`：

**新增顶部拦截**（现有第 145 行 `let dir = null` 附近）：

```ts
import { canLong, canShort } from '../config/symbolPools';

const allowLong = canLong(symbol);
const allowShort = canShort(symbol);

// 两边都不允许：防御性退出。理论上这种票不会进 getAllSymbols()，
// 但如果外部直接构造 VWAPStrategy 调用仍可能触发。
if (!allowLong && !allowShort) return null;
```

**最终下单分支两处加 guard**（现有 `src/strategy/vwapStrategy.ts:337` 和 `:345`）：

```ts
if (longPriceTrigger) {
    const allow =
        allowLong &&                                    // ← 新增
        (shouldCheckIndicators ? longRsiOk && volumeOk : true) &&
        slopeOkLong &&
        momentumOk;
    if (allow) dir = OrderSide.Buy;
} else if (shortPriceTrigger) {
    const allow =
        allowShort &&                                   // ← 新增
        (shouldCheckIndicators ? shortRsiOk && volumeOk : true) &&
        slopeOkShort &&
        momentumOk;
    if (allow) dir = OrderSide.Sell;
}
```

**日志处理**：在价格触发日志（`logEntryPriceTriggerOnce`）中**保留方向被池禁的情况**的打印，`allow=false`，并在日志里新增 `poolRule` 字段：
- `allowLong=false` 且 `longPriceTrigger` 命中：`poolRule='标的不在做多池'`
- `allowShort=false` 且 `shortPriceTrigger` 命中：`poolRule='标的不在做空池'`

**理由**：池是手动维护的清单，保留触发日志可以在事后复盘"这只票今天多头有突破但被我们拦了，是不是应该加进 long 池"。不想写入代码做静默过滤——静默的规则最难维护。

**回测 runner（重要）**：`src/backtest/runner.ts` 的 `managePosition` 虽然自己仿写撮合，但入场依然走 `strategy.canOpen`。因此 runner 无需改动，方向门控通过 `canOpen` 自动生效，**回测与实盘行为自动对齐**。

---

## 4. 只读 API 与面板展示

### API

新增 `src/routes/pool.ts`，在 `src/routes/index.ts` 挂载到 `/api/pool`：

```
GET /api/pool
Response:
{
  "long":  ["COIN.US", "APP.US", ...],
  "short": ["COIN.US", ...],
  "all":   ["COIN.US", "APP.US", ...]   // 并集，等于 getAllSymbols()
}
```

- 只读，没有 POST。池是配置项，改动必须改代码发版，与现有 `strategy.config.ts` 习惯一致。
- 鉴权延续现状（无鉴权，假设部署在网络隔离环境）。

### 面板

`public/index.html` 新增一段折叠区域：fetch `/api/pool`，渲染两列 `<ul>` 分别展示 long / short 池（第三列可选展示并集）。保持现有无框架风格，只加原生 `fetch` + DOM 操作。

---

## 5. 非目标 / 不做的事情

- **不改现有 `SymbolState` 结构**：方向能力不是标的运行时状态，是配置。无需改 `src/db/collections/states.json`。
- **不迁移 `symbols` 字段**：直接删除，不保留旧别名（避免"究竟以哪个为准"的二义性）。
- **不写迁移脚本**：首次 `symbols → longSymbols` 复制由用户人工完成（44 行，3 分钟）。
- **不加 POST `/api/pool` 编辑接口**：池变动应当经过 code review + 发版。
- **不改 `positionPctPerTrade` 等仓位/风控逻辑**：方向池不影响这些。

---

## 6. 测试与验证策略

- **单元测试**（若实现阶段决定引入）：`symbolPools.ts` 的 `canLong` / `canShort` / `getAllSymbols` 三个函数有清晰输入输出，易测。
- **回测验证**：实现完成后，用现有 `src/backtest/runner.ts` 跑一轮对照——把 `shortSymbols` 设为和 `longSymbols` 相同（= 全部票都能多空）应当与 pre-change 回测结果 **cumR、trades 数完全一致**（验证门控在默认允许下不改变策略行为）。再设 `shortSymbols: []` 跑一轮，应当只剩多头交易、空头记录归零（验证门控确实拦截）。
- **实盘验证**：先部署到 `TRADE_ENV=test`（paper trading），观察一个交易日的日志：(a) 价格触发日志里能看到 `poolRule`; (b) 只有 long 池的票触发做多，只有 short 池的票触发做空；(c) `GET /api/pool` 返回预期内容。

---

## 7. 影响范围总结

| 层 | 文件 | 改动 |
|---|---|---|
| 配置 | `src/config/strategy.config.ts` | 删 `symbols`，加 `longSymbols` / `shortSymbols` |
| 配置 | `src/config/symbolPools.ts` | **新增**：`getAllSymbols` / `canLong` / `canShort` |
| 主循环 | `src/index.ts` | 5 处 `config.symbols` → `getAllSymbols()` |
| 策略 | `src/strategy/vwapStrategy.ts` | `canOpen()` 加方向门控 + 日志字段 |
| 交易 | `src/longbridge/trade.ts` | 1 处 `config.symbols` → `getAllSymbols()` |
| 指标 | `src/core/indicators/atr.ts` | 1 处 `config.symbols` → `getAllSymbols()` |
| 回测 | `src/backtest/runner.ts` | 1 处 `config.symbols` → `getAllSymbols()`（runner 逻辑无需改） |
| 回测 | `src/backtest/fetchHistory.ts` | 1 处 `config.symbols` → `getAllSymbols()` |
| API | `src/routes/pool.ts` | **新增**：GET `/api/pool` |
| API | `src/routes/index.ts` | 挂载 `/api/pool` |
| 面板 | `public/index.html` | 展示两池 |

共计：**新增 2 文件，修改 7 文件**。

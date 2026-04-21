# 股票池按方向拆分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把扁平的 `config.symbols` 拆成 `longSymbols` / `shortSymbols` 两个独立方向池，在 `VWAPStrategy.canOpen()` 内做方向门控，回测自动对齐，并暴露只读 API 与面板展示。

**Architecture:** 配置层新增两个独立数组，新增 `src/config/symbolPools.ts` 模块提供 `getAllSymbols()` / `canLong()` / `canShort()` 三个 helper（并集缓存）。所有 `config.symbols` 消费点（主循环、ATR 预加载、长桥持仓、trendDetector、回测）统一改用 `getAllSymbols()`。`canOpen()` 在最终下单分支前加方向门控 guard，回测 runner 通过复用 `canOpen` 自动获得相同语义。新增 `GET /api/pool` 路由 + 面板折叠区。

**Tech Stack:** TypeScript、`dts-cli`、Koa、longport OpenAPI。项目没接 jest，无 `npm test` 脚本；所有回测脚本必须用 `TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test npx ts-node --transpile-only ...` 跑。

**Spec reference:** `docs/superpowers/specs/2026-04-17-symbol-pool-split-design.md`

---

## 关键约束（在开始之前必读）

1. **验证指令**：本项目没有 `npm test`。本 plan 用"类型检查 + 手工 smoke"代替 jest：
   - 类型检查：`npx tsc --noEmit` —— 任何一步之后都可以单独跑。
   - 编译：`npm run build` —— 验证 `dts-cli` 能打包出 `dist/`。
   - 回测对照：第 9 任务有完整 smoke 脚本。
2. **不要在 `initTradeEnv()` 之前 import `longport`**（CLAUDE.md 硬约束）。`symbolPools.ts` 只 import `./strategy.config`，不会触发 longport，可安全在任何地方 import。
3. **config.symbols 字段被删除**，所有使用处必须同步改完再 build，否则会编译失败。这是好事 —— 编译器会兜底检查"是否漏改了消费点"。

---

## File Structure

**新增文件：**
- `src/config/symbolPools.ts` — helper 模块，导出 `getAllSymbols()` / `canLong()` / `canShort()`。单一职责：方向池的派生视图。
- `src/routes/pool.ts` — Koa 子路由，`GET /` 返回 `{ long, short, all }`。

**修改文件：**
- `src/config/strategy.config.ts` — 删 `symbols`，加 `longSymbols` / `shortSymbols`。
- `src/strategy/vwapStrategy.ts` — `canOpen()` 注入方向门控 + 日志字段 `poolRule`。
- `src/index.ts` — 5 处 `config.symbols` 替换。
- `src/longbridge/trade.ts` — 1 处替换。
- `src/core/indicators/atr.ts` — 1 处替换。
- `src/backtest/runner.ts` — 1 处替换。
- `src/backtest/fetchHistory.ts` — 1 处替换。
- `src/routes/index.ts` — 挂载 `/pool` 子路由。
- `public/index.html` — 新增"股票池"折叠卡片，fetch `/api/pool` 并渲染。

**不改：**
- `src/interface/config.ts`（仅导出 `typeof strategyConfig`，自动同步）。
- `src/db/collections/*`、`src/core/state.ts`（池是配置，不是运行时状态）。

---

## Task 1: 新增 `symbolPools.ts` helper 模块

**Files:**
- Create: `src/config/symbolPools.ts`

这一步先建 helper，但暂不接入。helper 读取的字段（`longSymbols` / `shortSymbols`）要到 Task 2 才存在，所以 Task 1 先用"字段可能不存在、做空值兜底"的写法，Task 2 建好字段后再回来做类型严格化在 Task 3 里一起收尾。

> 写作顺序这么绕，是因为 `StrategyConfig` 类型 = `typeof strategyConfig`，字段必须先在 `strategy.config.ts` 出现，TS 才认。另一种写法是先改 `strategy.config.ts` 再建 helper —— 两种都行。本 plan 先 helper 后 config，因为 helper 是"新增代码、无破坏"，config 是"删字段、会传染编译错"。

- [ ] **Step 1: 创建 `src/config/symbolPools.ts`**

```ts
// src/config/symbolPools.ts
// 方向池派生视图：
// - getAllSymbols(): long ∪ short，系统关注的全部标的
// - canLong(symbol): 是否允许做多
// - canShort(symbol): 是否允许做空
//
// 缓存原因：交易日内池不变，重启才会重新加载。

import config from './strategy.config';
import { logger } from '../utils/logger';

let cachedAll: string[] | null = null;

export function getAllSymbols(): string[] {
    if (cachedAll) return cachedAll;

    const long = (config as any).longSymbols as string[] | undefined;
    const short = (config as any).shortSymbols as string[] | undefined;

    if (!Array.isArray(long) || !Array.isArray(short)) {
        throw new Error(
            '[symbolPools] config.longSymbols / config.shortSymbols 必须为数组，' +
            '检查 src/config/strategy.config.ts'
        );
    }

    const merged = [...long, ...short];
    const unique = Array.from(new Set(merged));
    if (unique.length !== merged.length) {
        logger.warn(
            `[symbolPools] 检测到 longSymbols/shortSymbols 间存在重复标的，` +
            `原始 ${merged.length} → 去重后 ${unique.length}（同一只票在两池出现是正常的，` +
            `此 warn 仅提醒）`
        );
    }

    cachedAll = unique;
    return cachedAll;
}

export function canLong(symbol: string): boolean {
    const long = (config as any).longSymbols as string[] | undefined;
    return Array.isArray(long) && long.includes(symbol);
}

export function canShort(symbol: string): boolean {
    const short = (config as any).shortSymbols as string[] | undefined;
    return Array.isArray(short) && short.includes(symbol);
}

// 仅用于测试：重置缓存
export function __resetSymbolPoolsCacheForTests(): void {
    cachedAll = null;
}
```

说明：临时用 `(config as any)` 绕开类型，Task 3 结束时会删除这些 cast。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: PASS（没有新错误；新文件不会因为旧 `config.symbols` 失败）。

- [ ] **Step 3: 提交**

```bash
git add src/config/symbolPools.ts
git commit -m "feat: add symbolPools helper for direction-aware symbol lists"
```

---

## Task 2: 重构 `strategy.config.ts`，用 `longSymbols` / `shortSymbols` 替换 `symbols`

**Files:**
- Modify: `src/config/strategy.config.ts:20-25`

- [ ] **Step 1: 替换 `symbols` 字段**

把现有（`src/config/strategy.config.ts:20-25`）：

```ts
  symbols: [
    'COIN', 'APP', 'RKLB', 'ORCL', 'IONQ', 'FUTU', 'HOOD', 'TSM', 'MSTR', 'ASTS', 'ADBE',
    'BE', 'HIMS', 'MP', 'TSLA', 'BABA', 'INTC', 'AMD', 'PDD', 'MRVL', 'DELL', 'GEV',
    'SMCI', 'CRDO', 'MU', 'PLTR', 'NFLX', 'LLY', 'LULU', 'CIEN', 'TME', 'NOK', 'NET',
    'SATS', 'LITE', 'WDC', 'RIVN', 'NOW', 'COHR', 'FCX', 'STX', 'VRT', 'JD', 'BX', 'GLW',
  ].map(s => s + '.US'),
```

替换为：

```ts
  // ========================
  // 股票池（按方向拆分）
  // - longSymbols  : 允许做多的票
  // - shortSymbols : 允许做空的票（长桥无法做空的票不要放这里）
  // 两池可以部分重叠；系统关注的全部标的 = 并集（见 src/config/symbolPools.ts）
  // 首次迁移：longSymbols 保持原 symbols 的全部 45 只；shortSymbols 初始化为
  //   同一集合，运行稳定后按长桥做空支持情况逐步裁剪。
  // ========================
  longSymbols: [
    'COIN', 'APP', 'RKLB', 'ORCL', 'IONQ', 'FUTU', 'HOOD', 'TSM', 'MSTR', 'ASTS', 'ADBE',
    'BE', 'HIMS', 'MP', 'TSLA', 'BABA', 'INTC', 'AMD', 'PDD', 'MRVL', 'DELL', 'GEV',
    'SMCI', 'CRDO', 'MU', 'PLTR', 'NFLX', 'LLY', 'LULU', 'CIEN', 'TME', 'NOK', 'NET',
    'SATS', 'LITE', 'WDC', 'RIVN', 'NOW', 'COHR', 'FCX', 'STX', 'VRT', 'JD', 'BX', 'GLW',
  ].map(s => s + '.US'),

  shortSymbols: [
    'COIN', 'APP', 'RKLB', 'ORCL', 'IONQ', 'FUTU', 'HOOD', 'TSM', 'MSTR', 'ASTS', 'ADBE',
    'BE', 'HIMS', 'MP', 'TSLA', 'BABA', 'INTC', 'AMD', 'PDD', 'MRVL', 'DELL', 'GEV',
    'SMCI', 'CRDO', 'MU', 'PLTR', 'NFLX', 'LLY', 'LULU', 'CIEN', 'TME', 'NOK', 'NET',
    'SATS', 'LITE', 'WDC', 'RIVN', 'NOW', 'COHR', 'FCX', 'STX', 'VRT', 'JD', 'BX', 'GLW',
  ].map(s => s + '.US'),
```

（两池初始内容相同 = 保持 pre-change 行为，后续由用户按长桥支持情况手工裁剪 `shortSymbols`）

- [ ] **Step 2: 类型检查（预期会爆出消费点错误）**

Run: `npx tsc --noEmit`
Expected: **FAIL**，报错类似：
```
src/index.ts:67:38 - error TS2339: Property 'symbols' does not exist on type ...
src/longbridge/trade.ts:52:... - error TS2339: ...
src/core/indicators/atr.ts:66:... - error TS2339: ...
src/backtest/runner.ts:156:... - error TS2339: ...
src/backtest/fetchHistory.ts:215:... - error TS2339: ...
```

这是**预期失败**，它帮我们枚举了所有消费点。记录出现错误的行号，Task 3~7 逐个修复。

- [ ] **Step 3: 提交（编译失败也先 commit，下一批任务会修复）**

```bash
git add src/config/strategy.config.ts
git commit -m "feat(config): split symbols into longSymbols / shortSymbols pools"
```

> 这一步是 plan 里唯一"已知编译失败也先 commit"的例外。允许的原因：拆分字段是原子语义变更，和接下来的消费点替换必须能被单独回溯。

---

## Task 3: 严格化 `symbolPools.ts` 类型

**Files:**
- Modify: `src/config/symbolPools.ts`

Task 2 后 `longSymbols` / `shortSymbols` 已进入类型系统，可以把 Task 1 的 `(config as any)` 去掉。

- [ ] **Step 1: 去掉 any cast**

把 `src/config/symbolPools.ts` 改成：

```ts
// src/config/symbolPools.ts
// 方向池派生视图：
// - getAllSymbols(): long ∪ short，系统关注的全部标的
// - canLong(symbol): 是否允许做多
// - canShort(symbol): 是否允许做空
//
// 缓存原因：交易日内池不变，重启才会重新加载。

import config from './strategy.config';
import { logger } from '../utils/logger';

let cachedAll: string[] | null = null;

export function getAllSymbols(): string[] {
    if (cachedAll) return cachedAll;

    const merged = [...config.longSymbols, ...config.shortSymbols];
    const unique = Array.from(new Set(merged));
    if (unique.length !== merged.length) {
        logger.warn(
            `[symbolPools] 检测到 longSymbols/shortSymbols 间存在重复标的，` +
            `原始 ${merged.length} → 去重后 ${unique.length}（同一只票在两池出现是正常的，` +
            `此 warn 仅提醒）`
        );
    }

    cachedAll = unique;
    return cachedAll;
}

export function canLong(symbol: string): boolean {
    return config.longSymbols.includes(symbol);
}

export function canShort(symbol: string): boolean {
    return config.shortSymbols.includes(symbol);
}

// 仅用于测试：重置缓存
export function __resetSymbolPoolsCacheForTests(): void {
    cachedAll = null;
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: `symbolPools.ts` 自身不再有 error（消费点仍 error，等 Task 4~7 修复）。

- [ ] **Step 3: 提交**

```bash
git add src/config/symbolPools.ts
git commit -m "refactor(symbolPools): drop any cast after config field exists"
```

---

## Task 4: 替换 `src/index.ts` 中 5 处 `config.symbols`

**Files:**
- Modify: `src/index.ts:67, 131, 173, 192, 199`

- [ ] **Step 1: 在文件顶部新增 import**

找到现有的 `import config from './config/strategy.config';`（按实际行号），在其后面加一行：

```ts
import { getAllSymbols } from './config/symbolPools';
```

- [ ] **Step 2: 替换第 67 行**

`createBatchPicker(config.symbols, concurrency);` → `createBatchPicker(getAllSymbols(), concurrency);`

- [ ] **Step 3: 替换第 131 行**

`for (const symbol of config.symbols) {` → `for (const symbol of getAllSymbols()) {`

- [ ] **Step 4: 替换第 173 行**

`${validCount}/${config.symbols.length} 支票有效` → `${validCount}/${getAllSymbols().length} 支票有效`

- [ ] **Step 5: 替换第 192 行**

`await market.initMarketQuote(config.symbols);` → `await market.initMarketQuote(getAllSymbols());`

- [ ] **Step 6: 替换第 199 行**

`for (const symbol of config.symbols) {` → `for (const symbol of getAllSymbols()) {`

- [ ] **Step 7: 类型检查**

Run: `npx tsc --noEmit`
Expected: `src/index.ts` 不再报错；其他文件（`trade.ts` / `atr.ts` / `runner.ts` / `fetchHistory.ts`）仍有 error。

- [ ] **Step 8: 提交**

```bash
git add src/index.ts
git commit -m "refactor(index): use getAllSymbols() instead of config.symbols"
```

---

## Task 5: 替换 `src/longbridge/trade.ts`

**Files:**
- Modify: `src/longbridge/trade.ts:52`

- [ ] **Step 1: 顶部加 import**

在 `import config` 后面加：

```ts
import { getAllSymbols } from '../config/symbolPools';
```

- [ ] **Step 2: 替换第 52 行**

`const positions = await c.stockPositions(config.symbols);` → `const positions = await c.stockPositions(getAllSymbols());`

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: `trade.ts` 不再报错。

- [ ] **Step 4: 提交**

```bash
git add src/longbridge/trade.ts
git commit -m "refactor(trade): use getAllSymbols() for stockPositions query"
```

---

## Task 6: 替换 `src/core/indicators/atr.ts`

**Files:**
- Modify: `src/core/indicators/atr.ts:66`

- [ ] **Step 1: 顶部加 import**

在 `import config` 后面加：

```ts
import { getAllSymbols } from '../../config/symbolPools';
```

（路径比 `trade.ts` 多一层 `../`）

- [ ] **Step 2: 替换第 66 行**

`for (const symbol of config.symbols) {` → `for (const symbol of getAllSymbols()) {`

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: `atr.ts` 不再报错。

- [ ] **Step 4: 提交**

```bash
git add src/core/indicators/atr.ts
git commit -m "refactor(atr): use getAllSymbols() for ATR preload loop"
```

---

## Task 7: 替换回测两个文件

**Files:**
- Modify: `src/backtest/runner.ts:156`
- Modify: `src/backtest/fetchHistory.ts:215`

- [ ] **Step 1: `runner.ts` 顶部加 import**

在 `import config` 后面加：

```ts
import { getAllSymbols } from '../config/symbolPools';
```

- [ ] **Step 2: `runner.ts` 第 156 行**

`for (const symbol of config.symbols) {` → `for (const symbol of getAllSymbols()) {`

- [ ] **Step 3: `fetchHistory.ts` 顶部加 import**

同上：

```ts
import { getAllSymbols } from '../config/symbolPools';
```

- [ ] **Step 4: `fetchHistory.ts` 第 215 行**

`const symbols = single ? [single] : config.symbols;` → `const symbols = single ? [single] : getAllSymbols();`

- [ ] **Step 5: 类型检查（全绿）**

Run: `npx tsc --noEmit`
Expected: **0 errors**。整个项目编译通过。

- [ ] **Step 6: 构建 smoke**

Run: `npm run build`
Expected: `dts-cli` 成功打出 `dist/`，无报错。

- [ ] **Step 7: 提交**

```bash
git add src/backtest/runner.ts src/backtest/fetchHistory.ts
git commit -m "refactor(backtest): use getAllSymbols() in runner and fetchHistory"
```

此时：所有 `config.symbols` 已经彻底移除，项目可以编译 + 打包。方向门控还没接入，所以行为等价于"两池都允许全部票" = pre-change 行为。

---

## Task 8: 在 `canOpen()` 加方向门控

**Files:**
- Modify: `src/strategy/vwapStrategy.ts`（多处）

- [ ] **Step 1: 顶部加 import**

在现有 import 区（大约第 22 行 `import { timeGuard } ...` 之后）加：

```ts
import { canLong, canShort } from '../config/symbolPools';
```

- [ ] **Step 2: `logEntryPriceTriggerOnce` 签名新增可选字段 `poolRule`**

找到 `src/strategy/vwapStrategy.ts:78` 附近的 `private logEntryPriceTriggerOnce(params: { ... })`，在对象字面量里加一个可选字段 `poolRule?: string;`：

```ts
private logEntryPriceTriggerOnce(params: {
    symbol: string;
    dirText: '做多' | '做空';
    barTimeStr: string;
    phaseText: string;
    indexRule: string;
    indexResult: string;
    allow: boolean;
    priceLine: string;
    rsi: number | null;
    rsiRule: string;
    rsiResult: string;
    volumeRatio: number | null;
    volRule: string;
    volResult: string;
    key: string;
    poolRule?: string;   // ← 新增
}) {
```

- [ ] **Step 3: 日志输出里追加 poolRule 行（仅在传入时打印）**

在 `logEntryPriceTriggerOnce` 函数体内 `logger.info(...)` 调用中，把模板字符串末尾改为（把原来 `\n` 结尾这行改成下面的拼接）：

原来（参考 `src/strategy/vwapStrategy.ts:98-107`）：

```ts
logger.info(
    `\n🚀【入场触发-价格】${params.symbol} 方向=${params.dirText} 时段=${params.phaseText} K线=${params.barTimeStr}  结论=${params.allow ? '允许入场' : '被拦截'
    }\n` +
    `  价格：${params.priceLine}\n` +
    `  指数：${params.indexRule} 结果=${params.indexResult}\n` +
    `  指标：RSI=${this.fmtMaybe(params.rsi, 2)} ${params.rsiRule} 结果=${params.rsiResult
    }   ` +
    `量比=${this.fmtMaybe(params.volumeRatio, 2)} ${params.volRule} 结果=${params.volResult
    }\n`
);
```

改成：

```ts
logger.info(
    `\n🚀【入场触发-价格】${params.symbol} 方向=${params.dirText} 时段=${params.phaseText} K线=${params.barTimeStr}  结论=${params.allow ? '允许入场' : '被拦截'
    }\n` +
    `  价格：${params.priceLine}\n` +
    `  指数：${params.indexRule} 结果=${params.indexResult}\n` +
    `  指标：RSI=${this.fmtMaybe(params.rsi, 2)} ${params.rsiRule} 结果=${params.rsiResult
    }   ` +
    `量比=${this.fmtMaybe(params.volumeRatio, 2)} ${params.volRule} 结果=${params.volResult
    }\n` +
    (params.poolRule ? `  股票池：${params.poolRule}\n` : '')
);
```

- [ ] **Step 4: `canOpen()` 在 `let dir = null` 之后加方向池读取**

找到 `src/strategy/vwapStrategy.ts:145`（`let dir = null;`），在其**后面**（不是前面，要先确认 state/preBars 基本条件）插入：

```ts
        let dir = null;

        // 方向池门控：这只标的分别是否允许做多 / 做空
        const allowLong = canLong(symbol);
        const allowShort = canShort(symbol);
        // 两边都不允许：防御性退出（理论上不会发生——这种票不会进 getAllSymbols()，
        // 但如果外部直接构造 VWAPStrategy 调用仍可能触发）
        if (!allowLong && !allowShort) return null;
```

- [ ] **Step 5: `canOpen()` 价格触发日志分支（long）加 poolRule + allowLong**

找到 `src/strategy/vwapStrategy.ts:251-290` 附近 `if (longPriceTrigger)` 的日志块，把 `allowLong` 的计算改成包含 `allowLong && ...`，并在日志参数里加 `poolRule`。

原来（参考 `:252-255`）：

```ts
        if (longPriceTrigger) {
            const allowLong =
                (shouldCheckIndicators ? longRsiOk && volumeOk : true) &&
                slopeOkLong &&
                momentumOk;
```

注意：这里已经用了变量名 `allowLong` —— 和我们 Step 4 新加的变量重名！要**重命名**这个局部变量，避免遮蔽。改成：

```ts
        if (longPriceTrigger) {
            const longEntryAllow =
                allowLong &&
                (shouldCheckIndicators ? longRsiOk && volumeOk : true) &&
                slopeOkLong &&
                momentumOk;
```

然后在同一个 `logEntryPriceTriggerOnce({...})` 调用里，把 `allow: allowLong,` 改成 `allow: longEntryAllow,`，并在对象末尾加：

```ts
                poolRule: allowLong ? undefined : '标的不在做多池',
```

- [ ] **Step 6: `canOpen()` 价格触发日志分支（short）同样改**

找到 `src/strategy/vwapStrategy.ts:291-330` 附近 `else if (shortPriceTrigger)` 的日志块，同样：

原来：

```ts
        } else if (shortPriceTrigger) {
            const allowShort =
                (shouldCheckIndicators ? shortRsiOk && volumeOk : true) &&
                slopeOkShort &&
                momentumOk;
```

改成：

```ts
        } else if (shortPriceTrigger) {
            const shortEntryAllow =
                allowShort &&
                (shouldCheckIndicators ? shortRsiOk && volumeOk : true) &&
                slopeOkShort &&
                momentumOk;
```

在同一个 `logEntryPriceTriggerOnce({...})` 里 `allow: allowShort,` 改成 `allow: shortEntryAllow,`，并在对象末尾加：

```ts
                poolRule: allowShort ? undefined : '标的不在做空池',
```

- [ ] **Step 7: `canOpen()` 最终下单判定分支加 guard**

找到 `src/strategy/vwapStrategy.ts:337-353` 的最终判定块。由于 Step 5/6 已经把同名变量重命名，这里要再**改一次**（它们和日志块是独立的两段）：

原来（参考 `:337-353`）：

```ts
        if (longPriceTrigger) {
            const allow =
                (shouldCheckIndicators ? longRsiOk && volumeOk : true) &&
                slopeOkLong &&
                momentumOk;
            if (allow) {
                dir = OrderSide.Buy;
            }
        } else if (shortPriceTrigger) {
            const allow =
                (shouldCheckIndicators ? shortRsiOk && volumeOk : true) &&
                slopeOkShort &&
                momentumOk;
            if (allow) {
                dir = OrderSide.Sell;
            }
        }
```

改成：

```ts
        if (longPriceTrigger) {
            const allow =
                allowLong &&                                     // ← 新增
                (shouldCheckIndicators ? longRsiOk && volumeOk : true) &&
                slopeOkLong &&
                momentumOk;
            if (allow) {
                dir = OrderSide.Buy;
            }
        } else if (shortPriceTrigger) {
            const allow =
                allowShort &&                                    // ← 新增
                (shouldCheckIndicators ? shortRsiOk && volumeOk : true) &&
                slopeOkShort &&
                momentumOk;
            if (allow) {
                dir = OrderSide.Sell;
            }
        }
```

- [ ] **Step 8: 类型检查 + build**

Run: `npx tsc --noEmit && npm run build`
Expected: 全绿，`dist/` 成功。

- [ ] **Step 9: 提交**

```bash
git add src/strategy/vwapStrategy.ts
git commit -m "feat(strategy): add direction pool gating in canOpen()"
```

---

## Task 9: 行为等价 smoke（回测对照）

**Files:**
- 不改代码。

目的：验证"当 `shortSymbols === longSymbols` 时，行为等价于 pre-change"。

- [ ] **Step 1: 确认当前 shortSymbols 是否等于 longSymbols**

查看 `src/config/strategy.config.ts`，两个数组内容应该完全相同（Task 2 的初始化就是这样写的）。如果你已经人工裁剪过，**请先在本地另存一份改回等价版本**，完成 smoke 后再改回来。

- [ ] **Step 2: 跑一遍回测 runner**

Run:
```bash
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts
```

Expected: 运行完成，输出 `cumR` / `trades` 等数字。记录下来（比如贴到注释或 terminal 里）。

- [ ] **Step 3: 切到 main branch 跑同样的回测作为对照（可选）**

如果方便的话：
```bash
git stash push -m "pool-split-wip" -- src/  # 临时把改动藏起来
git checkout main -- src/                    # 恢复 main 的 src/
TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test \
  npx ts-node --transpile-only src/backtest/runner.ts
# 记录数字
git checkout feat/dev -- src/                # 恢复当前分支
git stash pop                                # 恢复未完成的改动
```

Expected: 两边的 `cumR` / `trades` 数字**完全一致**。

如果不完全一致，停下来排查 —— 要么是 `canOpen()` 里 `allowLong`/`allowShort` 变量遮蔽导致逻辑错乱，要么是日志参数没改全。

- [ ] **Step 4: 跑"空头全禁"验证**

临时把 `shortSymbols` 改成 `[]`，再跑一次 runner，记录 trades 数。

Expected: 空头相关交易 **= 0**，只剩多头交易；cumR 只包含多头贡献。

改回原值。

- [ ] **Step 5: 提交（如果有记录的 note 文件）**

如果你把回测结果记到某个 txt/md 里，可以 commit；否则跳过。

---

## Task 10: 新增 `GET /api/pool` 路由

**Files:**
- Create: `src/routes/pool.ts`
- Modify: `src/routes/index.ts`

- [ ] **Step 1: 创建 `src/routes/pool.ts`**

参考 `src/routes/config.ts` 的极简风格：

```ts
// src/routes/pool.ts
// GET /api/pool —— 只读，返回当前方向池配置（long / short / 并集 all）。
// 池变动必须改代码发版，这里不提供 POST。

const Router = require('koa-router');
import { Context } from 'koa';
import Config from '../config/strategy.config';
import { getAllSymbols } from '../config/symbolPools';

const router = new Router();

router.get('/', (ctx: Context) => {
    ctx.body = {
        success: true,
        data: {
            long: Config.longSymbols,
            short: Config.shortSymbols,
            all: getAllSymbols(),
        },
    };
});

export default router;
```

- [ ] **Step 2: 修改 `src/routes/index.ts`，挂载到 `/pool`**

把文件改成：

```ts
const Router = require('koa-router');
import positionRouter  from './position';
import configRouter  from './config';
import poolRouter  from './pool';

const router = new Router({
  prefix: '/api'
});

router.use('/position', positionRouter.routes());
router.use('/config', configRouter.routes());
router.use('/pool', poolRouter.routes());

export default router;
```

- [ ] **Step 3: 类型检查 + build**

Run: `npx tsc --noEmit && npm run build`
Expected: 全绿。

- [ ] **Step 4: 实机 smoke**

另开终端：
```bash
npm run start   # 或 npm run start:watch
```

等启动日志出现 "listening on 3000" 之类字样后：

```bash
curl -s http://localhost:3000/api/pool | jq .
```

Expected 输出形如：
```json
{
  "success": true,
  "data": {
    "long": ["COIN.US", "APP.US", ...],
    "short": ["COIN.US", "APP.US", ...],
    "all": ["COIN.US", "APP.US", ...]
  }
}
```

停掉进程（Ctrl+C）。

- [ ] **Step 5: 提交**

```bash
git add src/routes/pool.ts src/routes/index.ts
git commit -m "feat(routes): add GET /api/pool read-only endpoint"
```

---

## Task 11: 面板展示两池

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: 加一个卡片区域 + fetch 脚本**

在 `public/index.html` 的持仓 card 之后、配置 card 之前（`<!-- ================= 配置展示 =================-->` 之前）插入：

```html
    <!-- ================= 股票池 ================= -->
    <div class="card">
      <h2>股票池（按方向）</h2>
      <div id="pool-container">
        <div class="config-desc">加载中...</div>
      </div>
    </div>
```

然后在文件底部的 `<script>` 标签里（当前是空的 `<!-- Mock API -->`）加入：

```html
  <script>
    (async function loadPool() {
      const box = document.getElementById('pool-container');
      try {
        const res = await fetch('/api/pool');
        const json = await res.json();
        if (!json.success) throw new Error('fail');
        const { long, short, all } = json.data;
        box.innerHTML = `
          <div class="config-item">
            <div class="config-row">
              <span class="config-name">做多池 (${long.length})</span>
            </div>
            <div class="config-desc">${long.join('、')}</div>
          </div>
          <div class="config-item">
            <div class="config-row">
              <span class="config-name">做空池 (${short.length})</span>
            </div>
            <div class="config-desc">${short.join('、') || '（空）'}</div>
          </div>
          <div class="config-item">
            <div class="config-row">
              <span class="config-name">关注总数 (${all.length})</span>
            </div>
            <div class="config-desc">long ∪ short 的并集，系统订阅的全部行情。</div>
          </div>
        `;
      } catch (e) {
        box.innerHTML = `<div class="config-desc">加载失败：${String(e)}</div>`;
      }
    })();
  </script>
```

- [ ] **Step 2: 实机 smoke**

启动服务后访问 `http://localhost:3000/`，确认新卡片出现且列出了 45 只票。

- [ ] **Step 3: 提交**

```bash
git add public/index.html
git commit -m "feat(panel): display direction pools on control panel"
```

---

## Task 12: 最终 end-to-end 校验

**Files:**
- 不改代码。

- [ ] **Step 1: 全量编译**

Run: `npx tsc --noEmit && npm run build`
Expected: 0 error。

- [ ] **Step 2: Grep 确认没有残留 `config.symbols`**

Run 工具：用 Grep 搜 `config\.symbols`（整个项目）。
Expected: 只在**文档和注释**里出现（`references/`、`docs/`），在 `src/` 下应为 0 命中。

如果有，返回对应 Task 修复。

- [ ] **Step 3: 人工 checklist**

确认以下每一项（仅 mental check，无需跑命令）：

- [ ] `src/config/strategy.config.ts` 中 `symbols` 字段已删除
- [ ] `src/config/symbolPools.ts` 三个导出都存在
- [ ] `canOpen()` 内已看到 `allowLong` / `allowShort` 声明 + 最终分支 guard
- [ ] `/api/pool` 返回 long/short/all 三个字段
- [ ] 面板显示 long、short 两列，数字正确

- [ ] **Step 4: 打 tag 或进合并流程**

不再 commit 新内容。按项目节奏走 PR 合并。

---

## Self-Review 结果

**1. Spec 覆盖**：
- 第 1 节（配置层）→ Task 2
- 第 2 节（派生 + 消费点）→ Task 1、3、4、5、6、7
- 第 3 节（方向门控）→ Task 8
- 第 4 节（API + 面板）→ Task 10、11
- 第 5 节（非目标）→ plan 未涉及，对齐
- 第 6 节（测试策略）→ Task 9、12
- 第 7 节（影响范围 11 个文件）→ 逐个对账：新增 2（symbolPools.ts / pool.ts）+ 修改 7（strategy.config.ts / vwapStrategy.ts / index.ts / trade.ts / atr.ts / runner.ts / fetchHistory.ts）+ routes/index.ts + public/index.html = 11 ✓

**2. Placeholder 扫描**：
- 无 TBD/TODO；每一步都给出了完整代码或具体命令。
- Task 9 Step 3 是"可选对照"，但标明了"如果方便的话"并给出完整命令。

**3. 类型一致**：
- `getAllSymbols` / `canLong` / `canShort` 三个函数在 Task 1、3、4、5、6、7、8、10 引用时签名一致。
- `logEntryPriceTriggerOnce` 的 `poolRule?: string` 在 Task 8 的 Step 2 声明、Step 5/6 使用，一致。
- `canOpen()` 内 `allowLong` 变量在 Task 8 Step 4 声明（方法作用域），Step 5/6 把原先的同名局部变量重命名为 `longEntryAllow` / `shortEntryAllow` 避免遮蔽 —— 这是本 plan **最易出错**的一步，执行时特别留意。

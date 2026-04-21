# CLAUDE.md
    
This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

- `npm run build`：用 `dts-cli` 一次性构建到 `dist/`。
- `npm run build:watch`：`dts watch`。
- `npm run start`：以 `TRADE_ENV=test` 启动 `nodemon`，监听 `dist/` 并执行 `node dist/index.js`（见 `nodemon.json`）。策略运行的是编译后的 JS，不是 TS 源码，因此需要同时跑一个 build。
- `npm run start:watch`：并行跑 `build:watch` + `start`，日常开发用这个。
- `npm run start:prod`：`pm2 start pm2.config.js`，设置 `TRADE_ENV=prod`、`NODE_ENV=production`。

测试：`test/index.test.ts` 存在，`package.json` 里声明了 `jest.testEnvironment: node`，但 `dependencies`/`devDependencies` 中并没有 `jest`，也没有 `npm test` 脚本 —— 在声称"测试跑通了"之前必须先确认。`nodemon.json` 忽略 `*.test.ts` / `*.spec.ts`，测试文件变更不会触发重启。

没有接 lint 脚本，`dts lint` 只在 husky 的 pre-commit hook 里引用了一次。

## 架构 —— 需要跨多文件阅读才能理解的部分

**单进程承载两件事**。`src/index.ts` 同时启动策略主循环（`loop()`，一个 `while(true)` + `sleep(5000)`）和 Koa Web 服务（端口 3000），在同一个进程和同一个事件循环中运行。Koa 暴露 `/api` 路由（`src/routes/`，入口 `src/routes/index.ts`，目前有 `config.ts`、`position.ts`）并静态托管根目录的 `public/`（当前只有一个 `public/index.html` 作为简单面板）。绝对不要在主循环里引入阻塞逻辑 —— 它和 API 共用事件循环。没有独立的前端工程，修改 UI 直接改 `public/index.html`。

**交易日生命周期由 `timeGuard` 驱动**。每一轮主循环中，`src/core/timeGuard.ts` 决定：(a) 是否到尾盘强平时间（`isForceCloseTime`），(b) 是否在可交易时段内（`isInStrategyTradeTime`，非交易时段会把 `strategy`/`dailyRisk`/`atrManager`/`inited` 全部重置为 null，让下一个交易日干净地重新初始化），(c) 是否继续正常执行。交易日初始化（`inited` 标志）负责构造 `ATRManager`、`RiskManager`、`VWAPStrategy`，预加载 ATR，并记录当日起始权益。任何"一天只跑一次"的逻辑都要挂到这里。

**策略核心**。`src/strategy/vwapStrategy.ts` 按标的管理信号与持仓，状态键在 `SymbolState`（`src/core/state.ts`）。策略参数（VWAP/ATR/RSI 阈值、交易时间窗口、`maxDailyDrawdown`、`symbols` 等）集中在 `src/config/strategy.config.ts`。`onBar()` 每轮循环会对每个标的拉最新的 1 分钟 K 线后调用；`src/index.ts` 中的 `defaultBarLength` 由 `breakVolumePeriod + postVolumePeriod + 2` 推导（且至少为 10），原因是最后一根 K 线可能未收盘要丢掉，且成交量窗口需要历史 —— 改 K 线窗口相关逻辑时要保留这一约束。

**标的分批**。`src/utils/picker.ts` 的 `createBatchPicker(config.symbols, concurrency=30)` 返回一个每次产出一批标的的函数，**并不是每一轮循环都处理所有标的**。在评估信号延迟时要考虑这一点。

**券商接入（`longport`，长桥 OpenAPI）**：行情在 `src/longbridge/market.ts`，下单/账户/持仓在 `src/longbridge/trade.ts`，共享 client 在 `src/longbridge/client.ts`。`src/core/realTimeMarket.ts` 封装了实时行情缓存（主循环每一轮都会调一次 `market.initMarketQuote`）—— 历史 K 线 API 有延迟，因此实盘读取要走这个封装而不是历史拉取。

**状态持久化**。`lowdb` 通过 `src/db/collections/` 下的集合把数据落到 `./data/`：目前有 `states.json`（`symbol -> SymbolState`）与 `config.json`。尾盘强平时会 `.clear()` 清空 `states` 集合。给 `SymbolState`（`src/core/state.ts`）新增字段时要注意：重启时旧数据会按原样反序列化，新字段必须能容忍 `undefined`。

**环境注入**。`src/core/env.ts` 的 `initTradeEnv()` 会把 `src/config/strategy.config.ts` 里的长桥凭证写入 `process.env`，然后才能使用 `longport`。`TRADE_ENV`（`test` / `prod`）决定使用哪一套凭证。**不要在 `initTradeEnv()` 执行之前 `require`/`import` `longport`**。

## 容易踩的坑

- `src/config/strategy.config.ts` 目前硬编码了 `LONGPORT_APP_KEY` / `LONGPORT_APP_SECRET` / `LONGPORT_ACCESS_TOKEN`。不要在代码里新增密钥；如果用户要求把凭证写进源码，要先提醒风险。
- `src/routes/position.ts` 暴露了 `POST /api/position/close/:symbol` 和 `POST /api/position/closeAll`，**没有任何鉴权**。默认假设部署在网络隔离环境里；新增破坏性接口前要主动跟用户确认。
- 代码和注释以中文为主，修改时尽量保持语言一致。
- 日志同时写到 `./log/YYYY-MM-DD/*.log`（来自 `src/utils/logger.ts`）和 `./logs/pm2*.log`（来自 pm2），两处都可能包含标的/持仓等敏感信息。

## 回测系统

`src/backtest/` 是一个分钟级向量化回测工具，直接 import 实盘的 `VWAPStrategy.canOpen` 做信号判断，自己管仓位和撮合。**完整文档见 `references/BACKTEST.md`**。

动手改策略代码前需要注意的几件事：

- 改 `VWAPStrategy.managePosition`（出场逻辑）时要**同步更新 runner** —— runner 为了避免触发 longport 下单副作用没有复用 `open`/`managePosition`，而是自己仿写了一遍撮合。`src/backtest/runner.ts` 的 `managePosition` 相关代码块要对齐。
- 给 `quote` / `SymbolState` 加新字段时要考虑 `BacktestMarket` 的兼容性 —— 伪 quote 只实现了 5 个字段（`symbol/lastDone/turnover/volume/timestamp`），用到新字段要同步扩展 duck-type。
- 所有回测脚本必须用 `TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test npx ts-node --transpile-only ...` 跑，否则 ESM/CJS 冲突。
- `BacktestMarket.getPostQuote` 的返回顺序必须是"新的在前、旧的在后"（和 `realTimeMarket` 一致，`calcVWAPSlope` 依赖这个顺序）。写反不会报错，是静默错位。
- runner 会**直接修改 `config.exitMode` / `config.stopAtrRatio` / `config.filters`**（因为是单例），每次回测结束必须恢复原值。
- 所有入场过滤器（RSI / 量比 / 分时段 / 指数方向门控）都由 `config.filters.*` 总开关控制。实盘和 runner 都走同一套开关，默认全部 false，等价于"全天只看价格突破"。想回滚到旧行为，改 `config.filters` 对应字段为 true 即可，无需改代码。

主要结论（截至批次 A 落地）：
- **SOXL 已剔除**（2 个月样本单票 -21.57R）
- **stopAtrRatio = 0.1**（原 0.2，一年样本 cumR +50%）
- **`filters.enableRsiFilter` / `enableVolumeFilter` / `enableEntryPhaseFilter` / `enableIndexTrendFilter` 全部 false**（一年样本下都是负贡献；RSI+量比+时段过滤器合起来压制空头 alpha 从 +943 到 +165）
- 固定 TP/SL 全面输给 trailing（未在一年样本重跑）
- 新 baseline (SL=0.1 + loose filters) 一年 cumR ≈ +1934R，22196→59015 trades，多空接近 1:1
- 详见 `references/BACKTEST.md` 第 6 节

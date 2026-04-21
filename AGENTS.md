# AGENTS.md

本文档用于帮助人类开发者/自动化 Agent 快速理解本仓库的整体架构与关键约束，便于开发、重构、测试与排障。

## 1) 项目概览

这是一个基于 TypeScript/Node.js 的日内交易策略服务：

- **策略主循环**：在 `src/index.ts` 内启动并常驻运行（`while (true)` 循环），按固定节奏拉取行情与 K 线，执行 VWAP 策略，并在尾盘/风控触发时强制平仓。
- **交易接入**：通过 `longport`（Longbridge/长桥 OpenAPI）进行行情与交易：
  - 行情与交易时段：`src/longbridge/market.ts`
  - 下单/账户/持仓：`src/longbridge/trade.ts`
  - 客户端上下文：`src/longbridge/client.ts`
- **服务端 API**：同一进程内启动 Koa Web Server（`PORT=3000`），提供 `/api` 路由并静态托管 `public/`：
  - 路由入口：`src/routes/index.ts`
  - 查询配置：`src/routes/config.ts`（`GET /api/config/all`）
  - 手动平仓：`src/routes/position.ts`（`POST /api/position/close/:symbol`、`POST /api/position/closeAll`）
- **状态落库**：用 `lowdb` 将持仓/交易状态落到本地 JSON 文件，避免重启丢状态：
  - DB 封装：`src/db/connect.ts` / `src/db/index.ts`
  - states 集合：`src/db/collections/states.ts`
  - 数据文件目录：`./data/`（例如 `data/states.json`）

### 关键模块如何协作（运行时视角）

- 启动：`src/index.ts` 调用 `initTradeEnv()` 注入长桥鉴权信息到 `process.env`，调用 `timeGuard.initTradeSession()` 拉取并缓存当日交易时段，初始化本地 DB。
- 行情：`src/core/realTimeMarket.ts` 在后台定时拉取行情并缓存（注释中说明历史行情有延迟；实时交易使用循环内直接拉取）。
- 策略：`src/strategy/vwapStrategy.ts` 维护每个标的的 `SymbolState`（`src/core/state.ts`），在 `onBar()` 中计算信号、开仓、以及持仓管理（止损/移动止损）。
- 风控：`src/core/risk.ts` 以账户净值为输入进行“单日最大回撤”控制；`src/core/timeGuard.ts` 控制是否在可交易窗口以及尾盘强平窗口。

### 前端（可选）

- `src/web/` 是一个 Create React App 工程，当前代码主要为**演示/模拟 UI 与数据**（未发现与后端 `/api` 的真实请求调用）。
- 根目录的 `public/index.html` 是被 Koa 静态托管的页面模板/面板雏形。

## 2) 构建与命令

### 根目录（策略服务）

来自 `package.json`：

- `npm run build`：使用 `dts-cli` 构建（脚本为 `dts build`），产物入口在 `dist/index.js`。
- `npm run build:watch`：`dts watch`。
- `npm run start`：以 `TRADE_ENV=test` 启动 `nodemon`（观察 `dist/`，执行 `node dist/index.js`，见 `nodemon.json`）。
- `npm run start:watch`：并行运行 `build:watch` + `start`。
- `npm run start:prod`：使用 `pm2` 启动 `dist/index.js`（见 `pm2.config.js`），并设置 `NODE_ENV=production`、`TRADE_ENV=prod`。

### 前端（`src/web/`）

来自 `src/web/package.json`（CRA 标准脚本）：

- `npm start`、`npm test`、`npm run build`。

## 3) 代码风格（以仓库现有配置为准）

### 格式化

根目录 `package.json` 内置 Prettier 配置：

- `printWidth: 80`
- `semi: true`
- `singleQuote: true`
- `trailingComma: es5`

### TypeScript 编译配置

- 根目录 `tsconfig.json`：继承 `@tsconfig/recommended`，并设置 `module: ESNext`、`moduleResolution: Node`。
- 前端 `src/web/tsconfig.json`：`strict: true`，`noEmit: true`（由 CRA 构建链路处理）。

### 约定与实践（本仓库实际用法）

- “策略服务”与“Web API”运行在同一进程：修改 `src/index.ts` 时注意不要阻塞事件循环（主循环已固定 `sleep(5000)`）。
- 交易状态通过 `SymbolState`（`src/core/state.ts`）与 `lowdb` 持久化：新增状态字段时要同步考虑序列化/反序列化行为与兼容性。

## 4) 测试

- 根目录存在 `test/index.test.ts`，并在 `package.json` 中声明了 `jest.testEnvironment: node`。
- 但根目录 `package.json` 的 `dependencies/devDependencies` **未显式包含 `jest`**；如需运行 `test/` 下测试，请先确认本仓库当前构建链路是否已间接提供 Jest，或需要单独安装。
- `nodemon.json` 默认忽略 `**/*.spec.ts`、`**/*.test.ts`，不会因测试文件变化重启服务。

## 5) 安全

本仓库包含真实交易相关能力，且当前代码中存在需要特别注意的安全点：

- **密钥/Token 管理**：`src/config/strategy.config.ts` 内包含 `LONGPORT_APP_KEY`、`LONGPORT_APP_SECRET`、`LONGPORT_ACCESS_TOKEN` 等敏感信息，并在 `src/core/env.ts` 中注入到 `process.env`。这类敏感信息应避免硬编码与提交到版本库。
- **危险操作接口**：Koa API 暴露了“单标的平仓/全部平仓”接口（`src/routes/position.ts`），代码中未看到鉴权/访问控制逻辑；部署时需确保网络边界（仅内网/本机、反向代理鉴权、IP 白名单等）以降低误操作/被调用风险。
- **落盘数据与日志**：
  - `./data/` 持久化策略状态（例如 `data/states.json`）。
  - `src/utils/logger.ts` 运行时会在 `./log/YYYY-MM-DD/*.log` 生成日志文件；`pm2.config.js` 还会写入 `./logs/pm2.log`、`./logs/pm2-error.log`。
  排障时注意日志中可能出现交易标的、仓位等敏感信息，分享/上传前需脱敏。

## 6) 配置与环境

### 交易环境选择

- 通过环境变量 `TRADE_ENV` 区分 `test`/`prod`（见 `src/core/env.ts`）。
- `npm run start` 固定使用 `TRADE_ENV=test`。
- `pm2.config.js` 的 `env` 默认使用 `TRADE_ENV=prod`。

### 策略参数

- 主要策略参数集中在 `src/config/strategy.config.ts`：
  - 交易标的列表 `symbols`
  - VWAP/ATR/RSI/成交量相关阈值
  - 交易时间窗口参数（开盘后不交易、收盘前不交易、尾盘强平）
  - 风控参数（单日最大回撤、单笔仓位）

### 本地状态与数据目录

- `lowdb` 存储目录为 `./data/`（见 `src/db/connect.ts`），集合目前包含 `states`：
  - 文件：`data/states.json`
  - 数据形态：`symbol -> SymbolState`（`src/core/state.ts`）

## 7) 回测系统

本仓库包含一个基于分钟 K 的向量化回测系统，位于 `src/backtest/`。它直接 import 实盘的 `VWAPStrategy.canOpen()` 做信号判断，自己管仓位和撮合，避免策略逻辑的"双份真相"。

**完整文档见 `references/BACKTEST.md`**，覆盖：
- 目录结构、运行命令（拉数据 / 跑回测 / 生成报告 / 按标的分析）
- 关键实现要点（duck-type SecurityQuote、monkey-patch timeGuard、ATR 预计算、撮合假设、主循环粒度）
- 已知偏差（trailing 用 bar.close 近似 5 s tick；同 K 内 TP/SL 顺序用 SLFirst/TPFirst 双假设对照）
- 容易踩的坑（ts-node ESM/CJS、runner 修改 config 必须恢复、`fetchHistory` 单次上限、`calcVWAPSlope` 输入顺序）
- 主要结论（截至 P0 落地）：SOXL 剔除、固定 TP/SL 被证伪、空头才是 alpha 来源、indexTrendFilter 被证伪、分时段择向是当前最佳规则

关键产出文件：

| 文件 | 内容 |
|---|---|
| `data/backtest/raw/` | 原始分钟 K（fetchHistory 拉取，约 94 MB） |
| `data/backtest/results/` | 每组回测的 trade 明细（JSON，按 label 命名） |
| `data/backtest/report.md` | TP/SL 改造对比报告 |
| `data/backtest/report_p0.md` | indexTrendFilter 与方向性 alpha 深挖报告 |
| `data/backtest/symbol_analysis.md` | 按标的稳健性分析 V1（前后半段一致性） |
| `data/backtest/symbol_analysis_v2.md` | 按标的特征相关性分析 V2（量比/趋势/突破跟随率） |

**重要约束**：

- 回测所有脚本都必须用 `TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS"}' TRADE_ENV=test npx ts-node --transpile-only ...` 的方式跑，否则 ts-node 会按 ESM 解析报错。
- runner 为了让 `canOpen` 读到正确的分支，会**直接修改 `config.exitMode` / `config.indexTrendFilter.*` 等字段**（因为 config 是单例对象）。每次 `runBacktest()` 结束必须恢复原值，串跑多组时尤其要检查。
- `BacktestMarket.getPostQuote` 返回顺序必须是"新的在前、旧的在后"，和 `realTimeMarket.Market.getPostQuote` 严格对齐 —— `calcVWAPSlope` 内部会 `.reverse()` 后做线性回归。写反了不会报错，是静默错位。
- 策略代码新增依赖 `quote` / `state` 的字段时要同步考虑回测兼容性：`BacktestMarket` 的伪 quote 只实现了 `symbol / lastDone / turnover / volume / timestamp` 五个字段，用到新字段需要同步扩展 duck-type。
- 回测不模拟 longport 下单副作用 —— runner 只调 `canOpen`（纯信号函数），不调 `open` / `managePosition`。所以策略里的出场逻辑改动需要**同步**在 runner 的 `managePosition` 仿写代码里更新。


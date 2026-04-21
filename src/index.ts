import config from './config/strategy.config';
import { getAllSymbols } from './config/symbolPools';
import VWAPStrategy from './strategy/vwapStrategy';
import { getMinuteBars, getDailyBars } from './longbridge/market';
import { getAccountEquity, closeAllPositions } from './longbridge/trade';
import { sleep } from './utils/sleep';
import { initTradeEnv } from './core/env';
import { RiskManager } from './core/risk';
import { ATRManager } from './core/indicators/atr';
import { timeGuard } from './core/timeGuard';
import { logger } from './utils/logger';
import { Market } from './core/realTimeMarket';
// import { getBarLength } from './utils';
import { db, initDB } from './db';
import path from 'path';
// const PQueue = require('p-queue');
import router from './routes';
import { createBatchPicker } from './utils/picker';
import {
    scoreTrendDay,
    TrendBaseline,
    TrendScore,
    TREND_SCORE_THRESHOLD,
    OPENING_WINDOW_MINUTES,
    RVOL_LOOKBACK_DAYS,
} from './core/trendDetector';

const PORT = 3000;

const serve = require('koa-static');
const Koa = require('koa');
const app = new Koa();

app
    .use(router.routes())
    .use(router.allowedMethods());

app.use(
    serve(path.join(__dirname, '../public'), {
        index: 'index.html',
    })
);

// 需要多取一些 1min K：最后一根可能未收盘会被丢弃；成交量窗口需要 break+post 的历史。
const defaultBarLength = Math.max(
    10,
    config.breakVolumePeriod + config.postVolumePeriod + 2
);
const concurrency = 30;

async function loop() {
    let strategy: VWAPStrategy | null = null;
    let dailyRisk: RiskManager | null = null;
    let atrManager: ATRManager | null = null;
    let inited = false;

    // ===== 趋势日 Detector 状态(每日重置) =====
    const trendDetectorEnabled = config.filters.enableTrendDetector;
    // 每支票当日的 baseline(初始化时从日线估算)
    let trendBaselineMap: Record<string, TrendBaseline | null> = {};
    // 每支票当日的评分(09:35 打分后填入)
    let dayScoreMap: Record<string, TrendScore | null> = {};
    let trendScored = false; // 当日是否已经打过分

    // 异步行情更新
    const market = new Market();
    // market.start();
    const picker = createBatchPicker(getAllSymbols(), concurrency);

    while (true) {

        await sleep(5000);

        // 进程跨天运行时，定期刷新“是否交易日”（美东日期）
        await timeGuard.refreshTradingDayIfNeeded();

        // 尾盘平仓, 做好清理工作
        if (timeGuard.isForceCloseTime()) {
            await closeAllPositions();
            // 清空持仓状态
            await db?.states?.clear();
            logger.info('[RISK] 📊 尾盘全平');
            continue;
        }

        // 非交易时间，跳过
        if (!timeGuard.isInStrategyTradeTime()) {
            // 非交易时间清空状态
            strategy = null;
            dailyRisk = null;
            atrManager = null;
            inited = false;
            trendBaselineMap = {};
            dayScoreMap = {};
            trendScored = false;
            continue;
        }

        // ===== 正常策略执行 =====
        const trade = async (symbols: string[], market: Market) => {
            const tasks = symbols.map(async symbol => {
                const bars = await getMinuteBars(symbol, defaultBarLength);
                return await strategy?.onBar(
                    symbol,
                    bars,
                    atrManager!.getATR(symbol),
                    market
                );
            });
            await Promise.all(tasks);
        }

        try {
            // ===== 交易日初始化, 每天只执行一次 =====
            if (!inited) {
                market.resetDailyState(); // 重置 EMA 斜率追踪器
                atrManager = new ATRManager();
                dailyRisk = new RiskManager(config.maxDailyDrawdown);
                strategy = new VWAPStrategy(config, dailyRisk);
                // 每次重新拉一遍持仓状态，来初始化持仓状态
                await strategy!.init();
                await atrManager.preloadATR();

                // ===== 趋势日 Detector baseline 初始化 =====
                // 用日线数据估算 RVOL baseline:前 N 天日线 volume 均值 × (窗口分钟数 / 390)
                // 这比回测版(用分钟 K 同窗口精确计算)粗糙,但信号方向一致
                if (trendDetectorEnabled) {
                    logger.info('[TrendDetector] 计算 baseline...');
                    trendBaselineMap = {};
                    dayScoreMap = {};
                    trendScored = false;
                    for (const symbol of getAllSymbols()) {
                        try {
                            const dailyBars = await getDailyBars(symbol, RVOL_LOOKBACK_DAYS + 2);
                            if (!dailyBars || dailyBars.length < 2) {
                                trendBaselineMap[symbol] = null;
                                continue;
                            }
                            // prevClose = 前一日收盘
                            const prevClose = dailyBars[dailyBars.length - 2].close.toNumber();
                            // prevDayOHLC:从同一根 daily bar 取 OHLC(longport BigNumber -> number)
                            const prevDayBar = dailyBars[dailyBars.length - 2];
                            const prevDayOHLC = {
                                open: prevDayBar.open.toNumber(),
                                high: prevDayBar.high.toNumber(),
                                low: prevDayBar.low.toNumber(),
                                close: prevDayBar.close.toNumber(),
                            };
                            if (
                                !Number.isFinite(prevDayOHLC.open) ||
                                !Number.isFinite(prevDayOHLC.high) ||
                                !Number.isFinite(prevDayOHLC.low) ||
                                !Number.isFinite(prevDayOHLC.close)
                            ) {
                                trendBaselineMap[symbol] = null;
                                continue;
                            }
                            // prevAtr = atrManager 已经算好的
                            const prevAtr = atrManager.getATR(symbol);
                            if (!prevAtr || prevAtr <= 0) {
                                trendBaselineMap[symbol] = null;
                                continue;
                            }
                            // RVOL baseline:前 N 天日线 volume 均值 × 窗口占比
                            // 排除最后一天(当日)和倒数第二天(prevClose 来源)
                            // 取前 RVOL_LOOKBACK_DAYS 天(如果不够就用所有可用的)
                            const lookbackBars = dailyBars.slice(0, -1); // 排除当日(可能不完整)
                            const recentBars = lookbackBars.slice(-RVOL_LOOKBACK_DAYS);
                            if (recentBars.length < Math.ceil(RVOL_LOOKBACK_DAYS / 2)) {
                                trendBaselineMap[symbol] = null;
                                continue;
                            }
                            let volSum = 0;
                            for (const b of recentBars) {
                                volSum += typeof b.volume === 'number' ? b.volume : Number(b.volume);
                            }
                            const avgDailyVol = volSum / recentBars.length;
                            // 前 5 分钟占全天约 5/390 ≈ 1.28%
                            const rvolBaseline = avgDailyVol * (OPENING_WINDOW_MINUTES / 390);
                            if (rvolBaseline <= 0) {
                                trendBaselineMap[symbol] = null;
                                continue;
                            }
                            // prevRangePctAvg7:用 recentBars 估算日内波幅均值
                            // 注意:live 路径窗口为 RVOL_LOOKBACK_DAYS=5 天,而回测 precompute 路径为
                            // TREND_RANGE_PCT_AVG_LOOKBACK=7 天。与 live RVOL 的"5/390 近似"同源的快捷实现,
                            // 结果会略偏宽松。如需严格对齐,改用完整 7 天日线并添加 fallback-null 分支。
                            let rangePctSum = 0;
                            let rangePctCnt = 0;
                            for (const b of recentBars) {
                                const h = typeof b.high === 'number' ? b.high : Number(b.high);
                                const l = typeof b.low === 'number' ? b.low : Number(b.low);
                                const cl = typeof b.close === 'number' ? b.close : Number(b.close);
                                if (cl > 0 && h > l) {
                                    rangePctSum += (h - l) / cl;
                                    rangePctCnt++;
                                }
                            }
                            const prevRangePctAvg7 =
                                rangePctCnt > 0 ? rangePctSum / rangePctCnt : 0;
                            trendBaselineMap[symbol] = {
                                prevClose,
                                prevAtr,
                                prevAtrShort: prevAtr, // 简化:和回测默认(shortAtrPeriod=ATR_PERIOD=7)一致
                                rvolBaseline,
                                prevDayOHLC,
                                prevRangePctAvg7,
                            };
                        } catch (e: any) {
                            logger.warn(`[TrendDetector] ${symbol} baseline 计算失败: ${e.message}`);
                            trendBaselineMap[symbol] = null;
                        }
                    }
                    const validCount = Object.values(trendBaselineMap).filter(v => v !== null).length;
                    logger.info(`[TrendDetector] baseline 完成: ${validCount}/${getAllSymbols().length} 支票有效`);
                }

                const { netAssets: startEquity } = await getAccountEquity();
                await dailyRisk?.initDay(startEquity);

                logger.info(`初始化结束`);
                inited = true;
            }

            const { netAssets: equity } = await getAccountEquity();
            // ===== 最高优先级：账户回撤检查 =====
            const shouldStop = dailyRisk!.check(equity);
            if (shouldStop) {
                await closeAllPositions();
                continue;
            }

            // 初始化实时行情信息
            await market.initMarketQuote(getAllSymbols());

            // ===== 趋势日 Detector: 09:35 打分 =====
            if (trendDetectorEnabled && !trendScored) {
                const progress = timeGuard.getTradeProgressMinutes();
                if (progress && progress.minutesSinceOpen >= OPENING_WINDOW_MINUTES) {
                    logger.info('[TrendDetector] 09:35 到达,开始打分...');
                    for (const symbol of getAllSymbols()) {
                        const baseline = trendBaselineMap[symbol];
                        if (!baseline) {
                            dayScoreMap[symbol] = null; // 没 baseline → 放行
                            continue;
                        }
                        try {
                            // 拉当日前 5 根已收盘的 1 分钟 K
                            const bars = await getMinuteBars(symbol, OPENING_WINDOW_MINUTES + 1);
                            // 过滤盘中 bar,去掉最后一根(可能未收盘)
                            const intradayBars = bars.filter(
                                (b: any) => b.tradeSession === 0 || b.tradeSession === 'Intraday'
                            );
                            const closedBars = intradayBars.slice(0, OPENING_WINDOW_MINUTES);
                            if (closedBars.length < OPENING_WINDOW_MINUTES) {
                                dayScoreMap[symbol] = null;
                                continue;
                            }
                            // 转成 scoreTrendDay 需要的 SerializedBar 格式
                            const window = closedBars.map((b: any) => ({
                                timestamp: new Date(b.timestamp).getTime(),
                                open: typeof b.open === 'number' ? b.open : b.open.toNumber(),
                                high: typeof b.high === 'number' ? b.high : b.high.toNumber(),
                                low: typeof b.low === 'number' ? b.low : b.low.toNumber(),
                                close: typeof b.close === 'number' ? b.close : b.close.toNumber(),
                                volume: typeof b.volume === 'number' ? b.volume : Number(b.volume),
                                turnover: typeof b.turnover === 'number' ? b.turnover : b.turnover.toNumber(),
                                tradeSession: 0,
                            }));
                            dayScoreMap[symbol] = scoreTrendDay(window, baseline);
                        } catch (e: any) {
                            logger.warn(`[TrendDetector] ${symbol} 打分失败: ${e.message}`);
                            dayScoreMap[symbol] = null;
                        }
                    }
                    trendScored = true;

                    // ===== 打印详细评分表格 =====
                    const headers = ['标的', 'Gap', 'RVOL', 'Drive', 'VWAP', 'Range', 'ATR%', 'OpShape', 'PDShape', 'TdRng%', 'PdRng%', 'AvgRng%', '总分', '结果',
                        'gapPct', 'rvolVal', 'driveATR', 'vwapRatio', 'rangeVal', 'atrPct', 'opBodyAtr', 'opTier',
                        'tdRngVal', 'pdRngVal', 'avgRngVal'];
                    const rows: string[][] = [];
                    let passCount = 0;
                    let blockCount = 0;
                    let nullCount = 0;

                    // 先收集有分数的票,按总分降序
                    const entries = Object.entries(dayScoreMap)
                        .sort((a, b) => {
                            const sa = a[1] ? (a[1] as TrendScore).total : -1;
                            const sb = b[1] ? (b[1] as TrendScore).total : -1;
                            return sb - sa;
                        });

                    for (const [symbol, score] of entries) {
                        if (score === null || score === undefined) {
                            nullCount++;
                            rows.push([
                                symbol, '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', '放行(无baseline)',
                                '-', '-', '-', '-', '-', '-', '-', '-',
                                '-', '-', '-',
                            ]);
                            continue;
                        }
                        const s = score as TrendScore;
                        const pass = s.total >= TREND_SCORE_THRESHOLD;
                        if (pass) passCount++;
                        else blockCount++;
                        rows.push([
                            symbol,
                            String(s.gap),
                            String(s.rvol),
                            String(s.drive),
                            String(s.vwap),
                            String(s.range),
                            String(s.atrPct),
                            String(s.openingShape),
                            String(s.priorDayShape),
                            String(s.todayRangePct),
                            String(s.priorDayRangePct),
                            String(s.prevRangePctAvg7),
                            String(s.total),
                            pass ? '通过' : '拦截',
                            (s.details.gapPct * 100).toFixed(2) + '%',
                            s.details.rvolValue.toFixed(2),
                            s.details.driveAtr.toFixed(3),
                            s.details.vwapControlRatio.toFixed(2) + '(' + s.details.vwapControlSide + ')',
                            s.details.rangeValue.toFixed(2),
                            (s.details.atrPct * 100).toFixed(2) + '%',
                            s.details.openingBodyAtr.toFixed(3),
                            s.details.openingShapeTier,
                            (s.details.todayRangePctValue * 100).toFixed(2) + '%',
                            (s.details.priorDayRangePctValue * 100).toFixed(2) + '%',
                            (s.details.prevRangePctAvg7Value * 100).toFixed(2) + '%',
                        ]);
                    }

                    // 渲染表格
                    const widths = headers.map((h, i) =>
                        Math.max(h.length, ...rows.map(r => (r[i] ?? '').length))
                    );
                    const line = (l: string, m: string, r: string) =>
                        l + widths.map(w => '─'.repeat(w + 2)).join(m) + r;
                    const fmtRow = (cells: string[]) =>
                        '│' + cells.map((c, i) => ` ${(c ?? '').padEnd(widths[i])} `).join('│') + '│';

                    const table = [
                        line('┌', '┬', '┐'),
                        fmtRow(headers),
                        line('├', '┼', '┤'),
                        ...rows.map(fmtRow),
                        line('└', '┴', '┘'),
                    ].join('\n');

                    logger.info(
                        `\n[TrendDetector] 趋势日评分(门槛=${TREND_SCORE_THRESHOLD})\n` +
                        `  通过: ${passCount} 支 | 拦截: ${blockCount} 支 | 无baseline: ${nullCount} 支(放行)\n` +
                        table
                    );
                }
            }

            const symbols = picker();

            // ===== 趋势日 Detector: 过滤不达标的票 =====
            let filteredSymbols = symbols;
            if (trendDetectorEnabled) {
                filteredSymbols = symbols.filter(symbol => {
                    const score = dayScoreMap[symbol];
                    // null = 没 baseline 或打分失败 → 放行
                    if (score === null || score === undefined) return true;
                    // 有分数 → 按门槛过滤
                    return score.total >= TREND_SCORE_THRESHOLD;
                });
            }

            await trade(filteredSymbols, market);

        } catch (e: any) {
            logger.error(e.message);
        }
    }
}

async function init() {
    // ===== 交易日初始化 =====
    logger.info('🚀 VWAP 日内策略初始化');
    initTradeEnv();
    await timeGuard.initTradeSession();
    // ===== 数据库初始化 =====
    await initDB();
}

init().then(async _ => {
    // 主交易循环
    loop();
    // SERVER START
    app.listen(PORT, () => {
        logger.info(`🚀 VWAP 日内策略启动`);
    });
}).catch((e) =>
    logger.fatal(e.message)
);

process.on('SIGINT', async () => {
    logger.info('SIGINT signal received.');
    process.exit(0);
});

process.on('uncaughtException', async () => {
    logger.info('uncaughtException signal received.');
    process.exit(0);
});

process.on('unhandledRejection', async () => {
    logger.info('unhandledRejection signal received.');
    process.exit(0);
});

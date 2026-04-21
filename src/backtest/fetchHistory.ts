/**
 * 历史分钟 K 拉取脚本（离线运行，不走主循环）
 *
 * 用法：
 *   TRADE_ENV=test npx ts-node src/backtest/fetchHistory.ts
 *   TRADE_ENV=test npx ts-node src/backtest/fetchHistory.ts COIN.US       # 只拉一支
 *   TRADE_ENV=test npx ts-node src/backtest/fetchHistory.ts --since=2025-04-11 --until=2026-02-11
 *   TRADE_ENV=test npx ts-node src/backtest/fetchHistory.ts COIN.US --since=2025-04-11
 *
 * 输出：data/backtest/raw/{symbol}.json
 *
 * 注意：
 * - 使用 historyCandlesticksByDate 按日期区间拉，避免 candlesticks(count=N) 返回最近 N 根的限制。
 * - 只保留 TradeSession.Intraday，和实盘 VWAPStrategy.onBar 对齐。
 * - 每支之间 sleep 防速率限制。
 * - 支持增量合并：已有 json 会被读进来，和本次拉到的 bars 按 timestamp 去重合并，
 *   start/end/barCount 元数据按合并后的实际范围更新。
 */
import { initTradeEnv } from '../core/env';
initTradeEnv();

import * as fs from 'fs';
import * as path from 'path';
import {
    Period,
    AdjustType,
    TradeSessions,
    TradeSession,
    Market,
    NaiveDate,
    Candlestick,
} from 'longport';
import { getQuoteCtx } from '../longbridge/client';
import config from '../config/strategy.config';
import { getAllSymbols } from '../config/symbolPools';
import { sleep } from '../utils/sleep';

// ========================
// 拉取时间区间（美东日历日）
// 默认 2026-02-12 ~ 2026-04-10，可用 --since / --until CLI flag 覆盖
// ========================
const DEFAULT_START = new NaiveDate(2026, 2, 12);
const DEFAULT_END = new NaiveDate(2026, 4, 10);

const OUT_DIR = path.resolve(process.cwd(), 'data/backtest/raw');

interface SerializedBar {
    timestamp: number; // ms
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    turnover: number;
    tradeSession: number;
}

function serializeBar(bar: Candlestick): SerializedBar {
    return {
        timestamp: bar.timestamp.getTime(),
        open: bar.open.toNumber(),
        high: bar.high.toNumber(),
        low: bar.low.toNumber(),
        close: bar.close.toNumber(),
        volume: Number(bar.volume),
        turnover: bar.turnover.toNumber(),
        tradeSession: bar.tradeSession,
    };
}

// longport historyCandlesticksByDate 单次最多返回 ~1000 根，
// 美股每天盘中 390 分钟 K，所以按 2 天窗口滚动拉取最安全。
const WINDOW_DAYS = 2;

function addDays(d: NaiveDate, days: number): NaiveDate {
    const js = new Date(Date.UTC(d.year, d.month - 1, d.day));
    js.setUTCDate(js.getUTCDate() + days);
    return new NaiveDate(
        js.getUTCFullYear(),
        js.getUTCMonth() + 1,
        js.getUTCDate()
    );
}

function compareDate(a: NaiveDate, b: NaiveDate): number {
    if (a.year !== b.year) return a.year - b.year;
    if (a.month !== b.month) return a.month - b.month;
    return a.day - b.day;
}

async function fetchOne(
    symbol: string,
    start: NaiveDate,
    end: NaiveDate
): Promise<SerializedBar[]> {
    const c = await getQuoteCtx();
    const seen = new Set<number>();
    const merged: SerializedBar[] = [];

    let cursor = start;
    while (compareDate(cursor, end) <= 0) {
        const windowEnd = addDays(cursor, WINDOW_DAYS - 1);
        const effectiveEnd =
            compareDate(windowEnd, end) > 0 ? end : windowEnd;
        const bars = await c.historyCandlesticksByDate(
            symbol,
            Period.Min_1,
            AdjustType.NoAdjust,
            cursor,
            effectiveEnd,
            TradeSessions.Intraday
        );
        for (const bar of bars) {
            if (bar.tradeSession !== TradeSession.Intraday) continue;
            const ts = bar.timestamp.getTime();
            if (seen.has(ts)) continue;
            seen.add(ts);
            merged.push(serializeBar(bar));
        }
        cursor = addDays(effectiveEnd, 1);
        // 防速率限制
        await sleep(150);
    }

    merged.sort((a, b) => a.timestamp - b.timestamp);
    return merged;
}

function parseNaiveDate(s: string, flagName: string): NaiveDate {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) {
        throw new Error(
            `${flagName} 需要 YYYY-MM-DD 格式，收到: ${s}`
        );
    }
    return new NaiveDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

interface CliArgs {
    symbol?: string;
    start: NaiveDate;
    end: NaiveDate;
}

function parseCliArgs(argv: string[]): CliArgs {
    let symbol: string | undefined;
    let start = DEFAULT_START;
    let end = DEFAULT_END;
    for (const a of argv) {
        if (a.startsWith('--since=')) {
            start = parseNaiveDate(a.slice('--since='.length), '--since');
        } else if (a.startsWith('--until=')) {
            end = parseNaiveDate(a.slice('--until='.length), '--until');
        } else if (!a.startsWith('--')) {
            symbol = a;
        } else {
            throw new Error(`未知参数: ${a}`);
        }
    }
    if (compareDate(start, end) > 0) {
        throw new Error(
            `--since (${start.toString()}) 不能晚于 --until (${end.toString()})`
        );
    }
    return { symbol, start, end };
}

interface ExistingFile {
    symbol: string;
    start: string;
    end: string;
    barCount: number;
    bars: SerializedBar[];
}

function loadExisting(symbol: string): ExistingFile | null {
    const p = path.join(OUT_DIR, `${symbol}.json`);
    if (!fs.existsSync(p)) return null;
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8')) as ExistingFile;
    } catch (e: any) {
        console.warn(
            `[fetchHistory] 读旧数据失败 ${p}: ${e.message}，按全新写入处理`
        );
        return null;
    }
}

function mergeBars(
    oldBars: SerializedBar[],
    newBars: SerializedBar[]
): SerializedBar[] {
    const seen = new Set<number>();
    const out: SerializedBar[] = [];
    for (const arr of [oldBars, newBars]) {
        for (const b of arr) {
            if (seen.has(b.timestamp)) continue;
            seen.add(b.timestamp);
            out.push(b);
        }
    }
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
}

function tsToDateString(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10);
}

async function main() {
    if (!fs.existsSync(OUT_DIR)) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
    }

    const { symbol: single, start, end } = parseCliArgs(process.argv.slice(2));
    const symbols = single ? [single] : getAllSymbols();

    console.log(
        `[fetchHistory] 拉取 ${symbols.length} 支，区间 ${start.toString()} ~ ${end.toString()}`
    );

    let totalBarsAfterMerge = 0;
    let totalNewBars = 0;
    let successCount = 0;
    const failed: string[] = [];

    for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];
        const prefix = `[${i + 1}/${symbols.length}] ${sym}`;
        try {
            const fetched = await fetchOne(sym, start, end);
            const existing = loadExisting(sym);
            const oldBars = existing?.bars ?? [];
            const oldCount = oldBars.length;
            const merged = mergeBars(oldBars, fetched);
            const added = merged.length - oldCount;
            totalBarsAfterMerge += merged.length;
            totalNewBars += added;

            const mergedStart =
                merged.length > 0
                    ? tsToDateString(merged[0].timestamp)
                    : start.toString();
            const mergedEnd =
                merged.length > 0
                    ? tsToDateString(merged[merged.length - 1].timestamp)
                    : end.toString();

            const outPath = path.join(OUT_DIR, `${sym}.json`);
            fs.writeFileSync(
                outPath,
                JSON.stringify(
                    {
                        symbol: sym,
                        start: mergedStart,
                        end: mergedEnd,
                        barCount: merged.length,
                        bars: merged,
                    },
                    null,
                    0
                )
            );
            successCount++;
            console.log(
                `${prefix}  ✅ 拉到 ${fetched.length} 根，新增 ${added} 根，合并后 ${merged.length} 根 (${mergedStart} ~ ${mergedEnd})`
            );
        } catch (e: any) {
            failed.push(sym);
            console.error(`${prefix}  ❌ ${e.message}`);
        }
        // 防速率限制
        await sleep(250);
    }

    console.log(
        `\n[fetchHistory] 完成：成功 ${successCount}/${symbols.length}，新增 ${totalNewBars} 根，合并后共 ${totalBarsAfterMerge} 根 K`
    );
    if (failed.length) {
        console.log(`[fetchHistory] 失败清单：${failed.join(', ')}`);
    }
}

main()
    .then(() => process.exit(0))
    .catch(e => {
        console.error(e);
        process.exit(1);
    });

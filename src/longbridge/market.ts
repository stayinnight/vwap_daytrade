import { Period, AdjustType, TradeSessions, Market, NaiveDate } from 'longport';
import { getQuoteCtx } from './client';

/**
 * 获取 1 分钟 K 线
 */
async function getMinuteBars(symbol: string, count = 2) {
  const c = await getQuoteCtx();
  const res = await c.candlesticks(
    symbol,
    Period.Min_1,
    count,
    AdjustType.NoAdjust,
    TradeSessions.Intraday
  );
  return res;
}

/**
 * 获取 5 分钟 K 线
 */
async function getFiveMinuteBars(symbol: string, count = 500) {
  const c = await getQuoteCtx();
  const res = await c.candlesticks(
    symbol,
    Period.Min_5,
    count,
    AdjustType.NoAdjust,
    TradeSessions.Intraday
  );
  return res;
}

/**
 * 获取日线 K 线
 */
async function getDailyBars(symbol: string, count = 14) {
  const c = await getQuoteCtx();
  return await c.candlesticks(
    symbol,
    Period.Day,
    count,
    AdjustType.ForwardAdjust,
    TradeSessions.Intraday
  );
}

/**
 * 获取标的实时行情
 */
async function getQuote(symbols: string[]) {
  const c = await getQuoteCtx();
  return await c.quote(symbols);
}

/**
 * 获取当日交易时段
 */
async function getTradeSessions() {
  const c = await getQuoteCtx();
  return await c.tradingSession();
}

/**
 * 获取交易日历（含半日交易日）
 */
async function getTradingDays(market: Market, begin: NaiveDate, end: NaiveDate) {
  const c = await getQuoteCtx();
  return await c.tradingDays(market, begin, end);
}

export {
  getMinuteBars,
  getQuote,
  getFiveMinuteBars,
  getDailyBars,
  getTradeSessions,
  getTradingDays
};

import { Config, QuoteContext, TradeContext } from 'longport';

let quoteCtx: null | Promise<QuoteContext> = null;
let tradeCtx: null | Promise<TradeContext> = null;
let config: null | Config = null;

const getConfig = () => {
  if (!config) {
    config = new Config({
      appKey: process.env.LONGPORT_APP_KEY as string,
      appSecret: process.env.LONGPORT_APP_SECRET as string,
      accessToken: process.env.LONGPORT_ACCESS_TOKEN as string,
      enablePrintQuotePackages: false,
    });
  }
  return config;
}

const getQuoteCtx = () => {
  if (!quoteCtx) {
    quoteCtx = QuoteContext.new(getConfig());
  }
  return quoteCtx;
}

const getTradeCtx = () => {
  if (!tradeCtx) {
    tradeCtx = TradeContext.new(getConfig());
  }
  return tradeCtx;
}

export {
  getQuoteCtx,
  getTradeCtx,
};

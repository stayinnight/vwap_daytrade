import { Decimal, OrderSide, OrderType, TimeInForceType } from 'longport';
import { getTradeCtx } from './client';
import { logger } from '../utils/logger';
import config from '../config/strategy.config'
import { getAllSymbols } from '../config/symbolPools';
import { db } from '../db';

/**
 * 下单
 * @param param0 
 * @returns 
 */
async function placeOrder({ symbol, side, qty }: {
  symbol: string,
  side: OrderSide,
  qty: number
}) {
  const c = await getTradeCtx();
  return c.submitOrder({
    symbol,
    orderType: OrderType.MO,
    submittedQuantity: new Decimal(qty),
    side,
    timeInForce: TimeInForceType.Day,
  });
}

async function getOrderDetail(orderId: string) {
    const c = await getTradeCtx();
    return await c.orderDetail(orderId);
}

/**
 * 获取账户总资产
 * @returns 
 */
async function getAccountEquity() {
  const c = await getTradeCtx();
  const res = await c.accountBalance("USD");
  const json = res[0].toJSON();
  return {
    buyPower: Number(res[0].buyPower),
    netAssets: Number(json.netAssets) || 0,
  }
}

/**
 * 强制平仓所有持仓
 * @returns 
 */
async function closeAllPositions() {
  const c = await getTradeCtx();
  const positions = await c.stockPositions(getAllSymbols());

  for (const pos of positions.channels) {
    for (const c of pos.positions) {
      if (c.availableQuantity.toNumber() === 0) continue;
      const side = c.availableQuantity.toNumber() > 0 ? OrderSide.Sell : OrderSide.Buy;
      
      logger.warn(
        `[FORCE CLOSE] ${c.symbol} qty=${c.availableQuantity}`
      );
      
      await placeOrder({
        symbol: c.symbol,
        side,
        qty: Math.abs(c.availableQuantity.toNumber()),
      });
    }
  }

  // 清空持仓状态
  await db?.states?.clear();
}


export {
  placeOrder,
  getAccountEquity,
  closeAllPositions,
  getOrderDetail,
};

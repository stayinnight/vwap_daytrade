const Router = require('koa-router');
import { Context } from 'koa';
import { closeAllPositions, placeOrder } from '../longbridge/trade';
import { db } from '../db';
import SymbolState from '../core/state';
import { OrderSide } from 'longport';

const router = new Router();

router.post('/close/:symbol', async (ctx: Context) => {
  const { symbol } = ctx.params;
  const state = await db?.states?.getSymbolState(symbol);
  if (!state) {
    ctx.body = { success: false, error: 'Symbol not found' };
    return;
  }
  await placeOrder({
    symbol,
    side: state.position === OrderSide.Buy ? OrderSide.Sell : OrderSide.Buy,
    qty: state.qty,
  });
  await db?.states?.setSymbolState(symbol, new SymbolState());
  ctx.body = { success: true, symbol };
});

router.post('/closeAll', async (ctx: Context) => {
  try {
    await closeAllPositions();
    await db?.states?.clear();
    ctx.body = { success: true };
  } catch (error) {
    ctx.body = { success: false, error: JSON.stringify(error) };
    return;
  }
});

export default router;

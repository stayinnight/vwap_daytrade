import { OrderSide } from 'longport';

class SymbolState {
  buyTraded: boolean;
  sellTraded: boolean;

  position: OrderSide | null;
  entryPrice: number | null;
  qty: number;
  stopDistance: number | null; // 止损距离
  stopPrice: number | null;
  tpPrice: number | null; // 固定止盈价（仅 fixed 模式使用，旧数据反序列化可能为 undefined）
  halfClosed: boolean;
  profitPrice: number | null; // 盈利价格

  constructor(buyTraded: boolean = false, sellTraded: boolean = false) {
    this.buyTraded = buyTraded;
    this.sellTraded = sellTraded;

    this.position = null;      // LONG | SHORT
    this.entryPrice = null;
    this.qty = 0;

    this.stopDistance = null;
    this.stopPrice = null;
    this.tpPrice = null;
    this.halfClosed = false;
    this.profitPrice = null;
  }

  reset() {
    // 每次只重置交易状态，保留已交易方向的记录
    Object.assign(this, new SymbolState(this.buyTraded, this.sellTraded));
  }

  toString() {
    return JSON.stringify({
        buyTraded: this.buyTraded,
        sellTraded: this.sellTraded,
        position: this.position,
        entryPrice: this.entryPrice,
        qty: this.qty,
        stopPrice: this.stopPrice,
        tpPrice: this.tpPrice,
        halfClosed: this.halfClosed,
        stopDistance: this.stopDistance,
        profitPrice: this.profitPrice,
    })
  }
}

export default SymbolState;

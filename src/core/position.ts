function calcPositionSize({
  equity,
  pct,
  price,
}: {
  equity: number,
  pct: number,
  price: number,
}) {
  const capital = equity * pct;
  const qty = Math.floor(capital / price);
  // 计算持仓量是否超出可用资金
  // if (qty <= 0 || qty * price > Math.abs(buyPower)) {
  //   return 0;
  // }
  return qty;
}

export {
  calcPositionSize,
};

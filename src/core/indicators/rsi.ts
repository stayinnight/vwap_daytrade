import { Candlestick } from "longport";
import strategyConfig from "../../config/strategy.config";

/**
 * 计算 RSI（Wilder 原始算法，一次性）
 * @param {number[]} values - 价格数组（时间正序）
 * @param {number} period - RSI 周期
 * @returns {number|null} RSI 值
 */
function calcRSI(bars: Candlestick[], period = strategyConfig.rsiPeriod): number | null {
  if (!Array.isArray(bars) || bars.length < period + 1) {
    return null;
  }

  const values = bars.map(bar => bar.close.toNumber());

  let gainSum = 0;
  let lossSum = 0;

  // period 次涨跌（需要 period + 1 个价格）
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) {
      gainSum += diff;
    } else {
      lossSum += Math.abs(diff);
    }
  }

  const avgGain = gainSum / period;
  const avgLoss = lossSum / period;

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  
  return Number(rsi.toFixed(2));
}


export { calcRSI };
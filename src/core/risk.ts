import { db } from "../db";
import { logger } from "../utils/logger";

/**
 * 单日账户级最大回撤控制
 */
class RiskManager {

  maxDrawdown: number;
  startEquity: number;
  tradingHalted: boolean;

  constructor(maxDrawdown: number) {
    this.maxDrawdown = maxDrawdown;

    this.startEquity = 0;
    this.tradingHalted = false;
  }

  /**
   * 每日开盘时调用一次
   */
  async initDay(equity: number) {
    this.startEquity = equity;
    this.tradingHalted = false;
    logger.debug(`[RISK] 初始化日风险控制，初始净值 ${equity}`);
  }

  /**
   * 每分钟 / 每次循环调用
   */
  check(equity: number) {
    if (this.tradingHalted) return true;

    const drawdown =
      (this.startEquity - equity) / this.startEquity;

    if (drawdown >= this.maxDrawdown) {
      this.tradingHalted = true;

      logger.error(
        `[RISK] ❌ 触发单日最大回撤 ${(drawdown * 100).toFixed(2)}%，当前权益 ${equity.toFixed(2)}， 初始权益 ${this.startEquity.toFixed(2)}`
      );
      logger.fatal('[RISK] 🚨 强制平仓并停止交易');

      return true;
    }

    return false;
  }

  canTrade() {
    return !this.tradingHalted;
  }
}

export {
  RiskManager
}

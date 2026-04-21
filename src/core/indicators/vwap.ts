
/**
 * VWAP & ATR 计算模块
 */
import { SecurityQuote } from "longport";

function calcVWAP(quote: SecurityQuote) {
  return quote.turnover.toNumber() / quote.volume;
}

function calcVWAPBands(vwap: number, atr: number, ratio: number) {
  return {
    upper: vwap + atr * ratio,
    lower: vwap - atr * ratio,
  };
}
/**
 * EMA 平滑 VWAP 斜率追踪器
 *
 * 每 bar 喂入当前 VWAP，内部维护 EMA(VWAP)，斜率 = 本 bar EMA - 上 bar EMA。
 * 比 OLS 线性回归平滑：没有矩形窗口跳变，O(1)/bar。
 */
class VWAPSlopeTracker {
  private alpha: number;
  private prevSmooth: number | null = null;
  private currentSmooth: number | null = null;

  constructor(period: number) {
    this.alpha = 2 / (period + 1);
  }

  /** 喂入当 bar VWAP，返回斜率；首 bar 返回 null（warmup）。NaN 跳过不更新。 */
  update(vwap: number): number | null {
    if (!Number.isFinite(vwap)) return this.getSlope();

    if (this.prevSmooth === null) {
      // 首 bar：seed EMA，无法计算差分
      this.prevSmooth = vwap;
      this.currentSmooth = vwap;
      return null;
    }

    this.prevSmooth = this.currentSmooth!;
    this.currentSmooth = this.alpha * vwap + (1 - this.alpha) * this.prevSmooth;
    return this.currentSmooth - this.prevSmooth;
  }

  /** 每日重置（新交易日开始前调用） */
  reset() {
    this.prevSmooth = null;
    this.currentSmooth = null;
  }

  /** 只读取最新斜率，不更新状态 */
  getSlope(): number | null {
    if (this.prevSmooth === null || this.currentSmooth === null) return null;
    if (this.prevSmooth === this.currentSmooth) return null; // warmup 首 bar
    return this.currentSmooth - this.prevSmooth;
  }
}

export { calcVWAP, calcVWAPBands, VWAPSlopeTracker };

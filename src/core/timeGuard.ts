/**
 * 美股交易时间守卫（使用美东时间）
 */
import { Market, NaiveDate, TradeSession } from 'longport';
import { getTradeSessions, getTradingDays } from '../longbridge/market';
import config from '../config/strategy.config';
import { logger } from '../utils/logger';

type DailyTradeSession = {
  beginTime: string // '09:30:00'
  endTime: string   // '16:00:00'
  tradeSession: 'Intraday'
}

class TimeGuard {
  session: DailyTradeSession = {
    beginTime: '09:30:00',
    endTime: '16:00:00',
    tradeSession: 'Intraday',
  }

  private tradingDayKeyNY: string | null = null;
  private isTradingDayFlag = false;
  private lastTradingDayRefreshAt = 0;

  async initTradeSession() {
    // 启动时强制刷新一次交易日状态（避免周末/节假日也跑策略）
    await this.refreshTradingDayIfNeeded(true);
    const tradeSession = await getTradeSessions();
    const USmarketSession = tradeSession.find((session) => session.toJSON().market === 'US')?.tradeSessions;
    if (!USmarketSession) {
      throw new Error('US market session not found');
    }
    const inTradaySession = USmarketSession.find((session) => session.tradeSession === TradeSession.Intraday);
    if (!inTradaySession) {
      throw new Error('intraday session not found');
    }
    this.session.beginTime = inTradaySession.toJSON().beginTime;
    this.session.endTime = inTradaySession.toJSON().endTime;
  }

  /**
   * 刷新“今天是否交易日”（美东日期）
   * - 仅在日期变更或超过最小刷新间隔时触发远端请求
   * - 请求失败时默认按“非交易日”处理（宁可不交易）
   */
  async refreshTradingDayIfNeeded(force = false) {
    const timeZone = 'America/New_York';
    const { year, month, day, key } = this.getDatePartsInTimeZone(timeZone);
    const now = Date.now();
    const minRefreshMs = 5 * 60 * 1000; // 同一天内最多每 5 分钟刷新一次

    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      // 极端情况：系统 ICU/时区异常
      this.isTradingDayFlag = false;
      logger.warn(`[TIME] invalid NY date parts, treat as CLOSED. key=${key}`);
      return;
    }

    if (!force && this.tradingDayKeyNY === key && now - this.lastTradingDayRefreshAt < minRefreshMs) {
      return;
    }

    this.lastTradingDayRefreshAt = now;
    this.tradingDayKeyNY = key;

    try {
      const begin = new NaiveDate(year, month, day);
      const end = new NaiveDate(year, month, day);
      const days = await getTradingDays(Market.US, begin, end);

      const isTradingDay =
        days.tradingDays.some((d) => this.isSameNaiveDate(d, year, month, day)) ||
        days.halfTradingDays.some((d) => this.isSameNaiveDate(d, year, month, day));

      this.isTradingDayFlag = isTradingDay;
      logger.info(`[TIME] US trading day check NY=${key} => ${isTradingDay ? 'OPEN' : 'CLOSED'}`);
    } catch (e: any) {
      // 请求失败：默认按非交易日处理，防止误跑策略
      this.isTradingDayFlag = false;
      logger.warn(`[TIME] tradingDays fetch failed, treat as CLOSED. err=${e?.message ?? String(e)}`);
    }
  }

  isTradingDay(): boolean {
    const key = this.getDateKeyInTimeZone('America/New_York');
    // 跨日但未刷新时，宁可不交易
    if (this.tradingDayKeyNY !== key) return false;
    return this.isTradingDayFlag;
  }

  /**
    * 是否允许交易
    * @param {number} openDelayMin  开盘后禁止分钟数
    * @param {number} closeAheadMin 收盘前禁止分钟数
  */
  isInStrategyTradeTime(
    session: DailyTradeSession = this.session,
    noTradeAfterOpenMinutes: number = config.noTradeAfterOpenMinutes,
    noTradeBeforeCloseMinutes: number = config.noTradeBeforeCloseMinutes,
  ): boolean {
    if (!this.isTradingDay()) {
      return false;
    }
    const beginSec = this.parseHmsToSeconds(session.beginTime);
    const endSec = this.parseHmsToSeconds(session.endTime);
    if (!Number.isFinite(beginSec) || !Number.isFinite(endSec)) {
      return false;
    }

    // 配置防御
    if (noTradeAfterOpenMinutes < 0 || noTradeBeforeCloseMinutes < 0) {
      return false;
    }

    const start = beginSec + noTradeAfterOpenMinutes * 60;
    const end = endSec - noTradeBeforeCloseMinutes * 60;

    // 防御：配置窗口不合法
    if (start === end) return false;
    if (beginSec <= endSec && start > end) return false;

    const nowSec = this.getTimeSecondsInTimeZone('America/New_York');
    return this.isWithinTimeWindow(nowSec, start, end);
  }

  /**
    * 是否是尾盘全平时间
  */
  isForceCloseTime(
    session: DailyTradeSession = this.session,
    closeMinutes: number = config.closeTimeMinutes,
  ): boolean {
    if (!this.isTradingDay()) {
      return false;
    }
    const endSec = this.parseHmsToSeconds(session.endTime);
    if (!Number.isFinite(endSec)) {
      return false;
    }
    if (closeMinutes <= 0) {
      return false;
    }

    const start = endSec - closeMinutes * 60;
    const nowSec = this.getTimeSecondsInTimeZone('America/New_York');

    // 统一用窗口判断：forceCloseStart ~ end
    return this.isWithinTimeWindow(nowSec, start, endSec);
  }


  /**
    * 是否是交易时间(只更新行情，没有开盘和收盘时间的特殊时间段)
  */
  isInTradeTime(
    session: DailyTradeSession = this.session,
  ): boolean {
    if (!this.isTradingDay()) {
      return false;
    }
    // 只关心美东（NYSE/Nasdaq）时钟，避免受服务器本地时区影响
    const timeZone = 'America/New_York';

    const beginSec = this.parseHmsToSeconds(session.beginTime);
    const endSec = this.parseHmsToSeconds(session.endTime);
    if (!Number.isFinite(beginSec) || !Number.isFinite(endSec)) {
      return false;
    }

    const nowSec = this.getTimeSecondsInTimeZone(timeZone);
    return this.isWithinTimeWindow(nowSec, beginSec, endSec);
  }

  /**
   * 获取当前时间距离开盘/收盘的分钟数（美东时间）。
   * 用于策略在“允许交易窗口”内做更细粒度的时段过滤。
   */
  getTradeProgressMinutes(session: DailyTradeSession = this.session) {
    const beginSec = this.parseHmsToSeconds(session.beginTime);
    const endSec = this.parseHmsToSeconds(session.endTime);
    if (!Number.isFinite(beginSec) || !Number.isFinite(endSec)) {
      return null;
    }

    const nowSec = this.getTimeSecondsInTimeZone('America/New_York');
    const minutesSinceOpen = (nowSec - beginSec) / 60;
    const minutesToClose = (endSec - nowSec) / 60;

    return {
      minutesSinceOpen,
      minutesToClose,
      beginSec,
      endSec,
      nowSec,
    };
  }

  private isWithinTimeWindow(nowSec: number, startSec: number, endSec: number): boolean {
    // 统一窗口判断：支持跨午夜（start > end）
    if (!Number.isFinite(nowSec) || !Number.isFinite(startSec) || !Number.isFinite(endSec)) {
      return false;
    }

    // 归一化到 [0, 86400)
    const clampDay = (v: number) => {
      const mod = v % 86400;
      return mod < 0 ? mod + 86400 : mod;
    };

    const now = clampDay(nowSec);
    const start = clampDay(startSec);
    const end = clampDay(endSec);

    if (start === end) return false;
    if (start < end) {
      return now >= start && now < end;
    }
    // 跨午夜
    return now >= start || now < end;
  }

  private parseHmsToSeconds(time: string): number {
    // 支持 "HH:mm:ss" / "HH:mm"
    if (!time || typeof time !== 'string') return NaN;
    const parts = time.split(':').map((v) => Number(v));
    if (parts.length < 2) return NaN;

    let [h, m, s = 0] = parts;
    // 某些 ICU/locale 在午夜可能返回 24:00:00，这里归一化到 00:00:00
    if (h === 24 && m === 0 && s === 0) {
      h = 0;
    }
    if (
      !Number.isFinite(h) ||
      !Number.isFinite(m) ||
      !Number.isFinite(s) ||
      h < 0 ||
      h > 23 ||
      m < 0 ||
      m > 59 ||
      s < 0 ||
      s > 59
    ) {
      return NaN;
    }
    return h * 3600 + m * 60 + s;
  }

  private getTimeSecondsInTimeZone(timeZone: string): number {
    // Node.js 环境下使用 Intl + IANA timeZone 获取“目标时区的当前时分秒”
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = dtf.formatToParts(new Date());
    const map: Record<string, number> = {};
    for (const p of parts) {
      if (p.type === 'hour' || p.type === 'minute' || p.type === 'second') {
        map[p.type] = Number(p.value);
      }
    }
    const h = map.hour ?? NaN;
    const m = map.minute ?? NaN;
    const s = map.second ?? 0;
    return this.parseHmsToSeconds(`${h}:${m}:${s}`);
  }

  private getDateKeyInTimeZone(timeZone: string): string {
    const { key } = this.getDatePartsInTimeZone(timeZone);
    return key;
  }

  private getDatePartsInTimeZone(timeZone: string): { year: number; month: number; day: number; key: string } {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = dtf.formatToParts(new Date());
    const map: Record<string, number> = {};
    for (const p of parts) {
      if (p.type === 'year' || p.type === 'month' || p.type === 'day') {
        map[p.type] = Number(p.value);
      }
    }
    const year = map.year ?? NaN;
    const month = map.month ?? NaN;
    const day = map.day ?? NaN;
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    const key = `${year}-${mm}-${dd}`;
    return { year, month, day, key };
  }


  private isSameNaiveDate(d: NaiveDate, year: number, month: number, day: number) {
    return d.year === year && d.month === month && d.day === day;
  }

}

export const timeGuard = new TimeGuard();

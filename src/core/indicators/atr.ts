/**
 * 使用日线 K 线计算 ATR(14)
 * ATR = EMA(TR, 14)
 */
import { Candlestick } from 'longport';
import config from '../../config/strategy.config';
import { getAllSymbols } from '../../config/symbolPools';

import { getDailyBars } from "../../longbridge/market";
import { logger } from '../../utils/logger';

import { atr } from 'technicalindicators'
import { ATRInput } from 'technicalindicators/declarations/directionalmovement/ATR';

async function calcATR(dailyBars: Candlestick[]) {
  const input: ATRInput = {
    high: [] as number[],
    low: [] as number[],
    close: [] as number[],
    period: config.atrPeriod,
  }
  dailyBars.forEach((bar, i) => {
    input.high.push(bar.high.toNumber());
    input.low.push(bar.low.toNumber());
    input.close.push(bar.close.toNumber());
  })
  const atrArr = atr(input)
  return atrArr[atrArr.length - 1];
}

class ATRManager {
  private atrMap: Record<string, number> = {};

  async preloadATR() {
    logger.info('📐 计算前一交易日 ATR');

    // 表格打印（避免一行行刷屏，方便快速对比每个标的的 ATR 是否计算成功）
    const headers = ['序号', '标的', '日线数', 'ATR', '状态'];
    const rows: string[][] = [];
    const renderTable = (tableHeaders: string[], tableRows: string[][]) => {
      const widths = tableHeaders.map((h, i) =>
        Math.max(
          h.length,
          ...tableRows.map((r) => (r[i] ?? '').length)
        )
      );

      const line = (l: string, m: string, r: string) =>
        l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;

      const fmtRow = (cells: string[]) =>
        '│' +
        cells
          .map((c, i) => ` ${String(c ?? '').padEnd(widths[i])} `)
          .join('│') +
        '│';

      return [
        line('┌', '┬', '┐'),
        fmtRow(tableHeaders),
        line('├', '┼', '┤'),
        ...tableRows.map(fmtRow),
        line('└', '┴', '┘'),
      ].join('\n');
    };

    for (const symbol of getAllSymbols()) {
      const dailyBars = await getDailyBars(symbol, config.atrPeriod * 2);
      const atr = await calcATR(dailyBars);
      if (atr) {
        this.atrMap[symbol] = atr;
      }

      rows.push([
        String(rows.length + 1),
        symbol,
        String(dailyBars?.length ?? 0),
        atr ? atr.toFixed(2) : '-',
        atr ? 'OK' : '跳过',
      ]);
    }

    logger.info(`\n📐 ATR 预加载结果\n${renderTable(headers, rows)}\n`);
    return this.atrMap;
  }

  getATR(symbol: string) {
    return this.atrMap[symbol];
  }
}

export {
  ATRManager
};

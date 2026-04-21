import { Candlestick } from "longport";

export const calcTopAndLow = (bars: Candlestick[]) => {
    const opens = bars.map((bar) => bar.open.toNumber());
    const closes = bars.map((bar) => bar.close.toNumber());
    return {
        top: Math.max(...opens, ...closes),
        low: Math.min(...opens, ...closes)
    };
}

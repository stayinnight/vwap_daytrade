import { Candlestick } from "longport";
import config from "../../config/strategy.config";

/**
 * 计算成交量，输入k线数组，返回最近5分钟成交量和前10分钟成交量
 */
function calcVolume(bars: Candlestick[]) {
    const total = bars.length;
    if (total <= config.breakVolumePeriod + config.postVolumePeriod) {
        return null;
    }

    const recentVolume = bars
        .slice(-config.breakVolumePeriod)
        .reduce((acc, cur) => acc + cur.volume, 0)
        / config.breakVolumePeriod;
    const pastVolume = bars
        .slice(-config.breakVolumePeriod - config.postVolumePeriod, -config.breakVolumePeriod)
        .reduce((acc, cur) => acc + cur.volume, 0)
        / config.postVolumePeriod;
    return {
        recentVolume,
        pastVolume,
    }
}

export { calcVolume }
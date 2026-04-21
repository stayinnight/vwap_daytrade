// src/config/symbolPools.ts
// 方向池派生视图：
// - getAllSymbols(): long ∪ short，系统关注的全部标的
// - canLong(symbol): 是否允许做多
// - canShort(symbol): 是否允许做空
//
// 缓存原因：交易日内池不变，重启才会重新加载。

import config from './strategy.config';
import { logger } from '../utils/logger';

let cachedAll: string[] | null = null;

export function getAllSymbols(): string[] {
    if (cachedAll) return cachedAll;

    const merged = [...config.longSymbols, ...config.shortSymbols];
    const unique = Array.from(new Set(merged));
    if (unique.length !== merged.length) {
        logger.warn(
            `[symbolPools] 检测到 longSymbols/shortSymbols 间存在重复标的，` +
            `原始 ${merged.length} → 去重后 ${unique.length}（同一只票在两池出现是正常的，` +
            `此 warn 仅提醒）`
        );
    }

    cachedAll = unique;
    return cachedAll;
}

export function canLong(symbol: string): boolean {
    return config.longSymbols.includes(symbol);
}

export function canShort(symbol: string): boolean {
    return config.shortSymbols.includes(symbol);
}

// 仅用于测试：重置缓存
export function __resetSymbolPoolsCacheForTests(): void {
    cachedAll = null;
}

import config from '../config/strategy.config';

export enum Env {
    Text = 'test',
    Prod = 'prod'
}

function injectKeysToProcessEnv (envs: Record<string, string>) {
    Object.keys(envs).forEach(key => {
        process.env[key] = envs[key];
    });
}

export function initTradeEnv () {
    const env = process.env.TRADE_ENV || 'test';
    if (env === Env.Prod) {
        injectKeysToProcessEnv(config.longportConfig[Env.Prod]);
    } else {
        injectKeysToProcessEnv(config.longportConfig[Env.Text]);
    }
}
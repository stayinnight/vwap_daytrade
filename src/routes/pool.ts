// src/routes/pool.ts
// GET /api/pool —— 只读，返回当前方向池配置（long / short / 并集 all）。
// 池变动必须改代码发版，这里不提供 POST。

const Router = require('koa-router');
import { Context } from 'koa';
import Config from '../config/strategy.config';
import { getAllSymbols } from '../config/symbolPools';

const router = new Router();

router.get('/', (ctx: Context) => {
    ctx.body = {
        success: true,
        data: {
            long: Config.longSymbols,
            short: Config.shortSymbols,
            all: getAllSymbols(),
        },
    };
});

export default router;

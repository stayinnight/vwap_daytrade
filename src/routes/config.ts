const Router = require('koa-router');
import { Context } from 'koa';
import Config from '../config/strategy.config';

const router = new Router();

router.get('/all', (ctx: Context) => {
  ctx.body = { success: true, data: Config };
});

export default router;

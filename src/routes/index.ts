const Router = require('koa-router');
import positionRouter  from './position';
import configRouter  from './config';
import poolRouter  from './pool';

const router = new Router({
  prefix: '/api'
});

router.use('/position', positionRouter.routes());
router.use('/config', configRouter.routes());
router.use('/pool', poolRouter.routes());

export default router;

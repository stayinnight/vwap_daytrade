module.exports = {
  apps: [
    {
      name: 'vwap-trader',
      script: 'dist/index.js',

      // 崩溃自动拉起
      autorestart: true,

      // 内存泄漏保护
      max_memory_restart: '5000M',

      // 异常重启延迟（防止抖动）
      restart_delay: 3000,

      // 日志
      out_file: './logs/pm2.log',
      error_file: './logs/pm2-error.log',

      // 生产环境
      env: {
        NODE_ENV: 'production',
        TRADE_ENV: 'prod',
      },
    },
  ],
};

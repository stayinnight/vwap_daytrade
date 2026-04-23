const Config = {
  // ========================
  // 长桥openapi配置
  // ========================
  longportConfig: {
    test: {
      LONGPORT_APP_KEY: "e8c06d148da98f63f04c4eae10db96ac",
      LONGPORT_APP_SECRET: "d8118038165ce555672118f09bd81382629f279d142e5d05023150199fb23213",
      LONGPORT_ACCESS_TOKEN: "m_eyJhbGciOiJSUzI1NiIsImtpZCI6ImQ5YWRiMGIxYTdlNzYxNzEiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJsb25nYnJpZGdlIiwic3ViIjoiYWNjZXNzX3Rva2VuIiwiZXhwIjoxNzgwNTgzNzYyLCJpYXQiOjE3NzI4MDc3NjMsImFrIjoiZThjMDZkMTQ4ZGE5OGY2M2YwNGM0ZWFlMTBkYjk2YWMiLCJhYWlkIjoyMTAwMzQ4NiwiYWMiOiJsYl9wYXBlcnRyYWRpbmciLCJtaWQiOjE4OTMxMDA0LCJzaWQiOiJnNDVZZitOS0Zoak40bUFDSE5Id0h3PT0iLCJibCI6MywidWwiOjAsImlrIjoibGJfcGFwZXJ0cmFkaW5nXzIxMDAzNDg2In0.cErLlWN-l8K7YK1D-WrJPW7DMWhbtB3MyoA5JFVjKDe_v3YT8uo8702fh-s9DiUpZjrTRDUWfQqpBt9srZSFBrsi0B6biKWEttdEgLQgp2DZ0talg5PmWJ-fkWZ5jj0ydC_7ei2nUCcA7asZKBen3yTTsAldJt02KLg7QLRHxxOGJCJUVX2YkgTOrusTRwWNBBaD_lxpzbnlimBidBg9FLbr7IvVzXoXA7Y3KyKUu46Oo0pAJy5Ro2A23T-N4S1wldItVD_LjHKxeTJ8C4f7b-9-Uco0emoOV7hWLJKlz45feZeIdKAHKHq_3Ou_KBRTk6JKDSdKX7mioIVmLtGvf4997TknU95hprBQMt1ceqFOTL-ebMiIZqa4teTDi-OpsHHUdbJLi6W7J1MVvFP9AHq2oz3z2v7HGm41JPiReyEHM4i6PCRjX8g07mKxpCdoUABk8bPRZ4K9JSi3Cpni3yocTkGuGcwttsRHsbWRRKdSRTljvw1Z1YdrLdiSkCsiaU8_aG04y3HDzPAVxPLtlqN3cWKoLMQ83TeqDQJpnSjuboOQdNICRu-QHHSk_JlHBbc5AjyenEtPo4cBv5qV5oZKDF6UeEw-o9bj5XePb2qz2IPP_2aDsrZWDeM1qS-MVN68OD8iMB4wG44vaHSvNenHpg654ZlfNCXjmLlBFPg"
    },
    prod: {
      LONGPORT_APP_KEY: "e8c06d148da98f63f04c4eae10db96ac",
      LONGPORT_APP_SECRET: "d8118038165ce555672118f09bd81382629f279d142e5d05023150199fb23213",
      LONGPORT_ACCESS_TOKEN: "m_eyJhbGciOiJSUzI1NiIsImtpZCI6ImQ5YWRiMGIxYTdlNzYxNzEiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJsb25nYnJpZGdlIiwic3ViIjoiYWNjZXNzX3Rva2VuIiwiZXhwIjoxNzgwNTgzNzYyLCJpYXQiOjE3NzI4MDc3NjMsImFrIjoiZThjMDZkMTQ4ZGE5OGY2M2YwNGM0ZWFlMTBkYjk2YWMiLCJhYWlkIjoyMTAwMzQ4NiwiYWMiOiJsYl9wYXBlcnRyYWRpbmciLCJtaWQiOjE4OTMxMDA0LCJzaWQiOiJnNDVZZitOS0Zoak40bUFDSE5Id0h3PT0iLCJibCI6MywidWwiOjAsImlrIjoibGJfcGFwZXJ0cmFkaW5nXzIxMDAzNDg2In0.cErLlWN-l8K7YK1D-WrJPW7DMWhbtB3MyoA5JFVjKDe_v3YT8uo8702fh-s9DiUpZjrTRDUWfQqpBt9srZSFBrsi0B6biKWEttdEgLQgp2DZ0talg5PmWJ-fkWZ5jj0ydC_7ei2nUCcA7asZKBen3yTTsAldJt02KLg7QLRHxxOGJCJUVX2YkgTOrusTRwWNBBaD_lxpzbnlimBidBg9FLbr7IvVzXoXA7Y3KyKUu46Oo0pAJy5Ro2A23T-N4S1wldItVD_LjHKxeTJ8C4f7b-9-Uco0emoOV7hWLJKlz45feZeIdKAHKHq_3Ou_KBRTk6JKDSdKX7mioIVmLtGvf4997TknU95hprBQMt1ceqFOTL-ebMiIZqa4teTDi-OpsHHUdbJLi6W7J1MVvFP9AHq2oz3z2v7HGm41JPiReyEHM4i6PCRjX8g07mKxpCdoUABk8bPRZ4K9JSi3Cpni3yocTkGuGcwttsRHsbWRRKdSRTljvw1Z1YdrLdiSkCsiaU8_aG04y3HDzPAVxPLtlqN3cWKoLMQ83TeqDQJpnSjuboOQdNICRu-QHHSk_JlHBbc5AjyenEtPo4cBv5qV5oZKDF6UeEw-o9bj5XePb2qz2IPP_2aDsrZWDeM1qS-MVN68OD8iMB4wG44vaHSvNenHpg654ZlfNCXjmLlBFPg"
    },
  },
  // ========================
  // 基础参数 —— 股票池（按方向拆分）
  // - longSymbols  : 允许做多的票
  // - shortSymbols : 允许做空的票（长桥无法做空的票不要放这里）
  // 两池可以部分重叠；系统关注的全部标的 = 并集（见 src/config/symbolPools.ts）
  // 维护提醒：迁移期两份列表内容相同，修改时请同步。
  // ========================
  longSymbols: [
    'COIN', 'APP', 'RKLB', 'ORCL', 'IONQ', 'FUTU', 'HOOD', 'TSM', 'MSTR', 'ASTS', 'ADBE',
    'BE', 'HIMS', 'MP', 'TSLA', 'BABA', 'INTC', 'AMD', 'PDD', 'MRVL', 'DELL', 'GEV',
    'SMCI', 'CRDO', 'MU', 'PLTR', 'NFLX', 'LLY', 'LULU', 'CIEN', 'TME', 'NOK', 'NET',
    'SATS', 'LITE', 'WDC', 'RIVN', 'NOW', 'COHR', 'FCX', 'STX', 'VRT', 'JD', 'BX', 'GLW',
    'TEM', 'RVMD', 'UNH', 'CVX', 'VG', 'COST', 'RDDT', 'SE', 'NKE', 'PBR', 'PFE', 'CRCL',
    'ALAB', 'ARM', 'TSEM', 'AMAT', 'SOFI', 'NBIS', 'CRWV', 'SNDK', 'ASML', 'ALB', 'CRM',
    'VST', 'ONTO', 'GFS', 'RYAAY', 'LYB', 'DOW', 'CF', 'TSCO', 'AGI', 'BEPC', 'OKLO', 'VICR',
    'HPQ'
  ].map(s => s + '.US'),

  shortSymbols: [
    'COIN', 'APP', 'RKLB', 'ORCL', 'IONQ', 'FUTU', 'HOOD', 'TSM', 'MSTR', 'ADBE',
    'BE', 'HIMS', 'MP', 'TSLA', 'BABA', 'INTC', 'AMD', 'PDD', 'MRVL', 'DELL', 'GEV',
    'SMCI', 'CRDO', 'MU', 'PLTR', 'NFLX', 'LLY', 'LULU', 'CIEN', 'TME', 'NOK', 'NET',
    'SATS', 'LITE', 'WDC', 'RIVN', 'NOW', 'COHR', 'FCX', 'STX', 'VRT', 'JD', 'BX', 'GLW',
    'RVMD', 'UNH', 'CVX', 'COST', 'SE', 'NKE', 'PBR', 'PFE', 'ARM', 'TSEM', 'AMAT',
    'ASML', 'ALB', 'CRM', 'VST', 'ONTO', 'GFS', 'RYAAY', 'LYB', 'DOW', 'CF', 'TSCO', 'AGI',
    'BEPC', 'VICR', 'HPQ'
  ].map(s => s + '.US'),

  // ========================
  // VWAP 区间参数
  // ========================
  vwapBandAtrRatio: 0,
  emaSlopePeriod: 10, // EMA 平滑 VWAP 斜率的 span 参数（α = 2/(period+1)）
  stopAtrRatio: 0.1,

  // ========================
  // 出场模式
  // - trailing：移动止损（原线上行为）
  // - fixed：开仓时一次性锁定 TP/SL，期间不更新
  // ========================
  exitMode: 'trailing' as 'trailing' | 'fixed',
  takeProfitAtrRatio: 0.5, // 仅 fixed 模式使用
  stopLossAtrRatio: 0.35,  // 仅 fixed 模式使用

  // ========================
  // ATR 区间参数
  // ========================
  atrPeriod: 7,

  // ========================
  // RSI 区间参数
  // ========================
  rsiPeriod: 5,
  rsiBuyThreshold: 55,
  rsiSellThreshold: 45,

  // ========================
  // 成交量 区间参数
  // ========================
  volumePeriod: 15,
  volumeEntryThreshold: 1.2, // 1.2倍当前成交量
  breakVolumePeriod: 5, // 突破区间
  postVolumePeriod: 10, // 和过去10分钟成交量对比

  // ========================
  // 入场过滤时段配置（分钟）
  // 仅在 filters.enableEntryPhaseFilter=true 时生效
  // ========================
  entryFilterSchedule: {
    // 开盘后第 N 分钟之前：只看价格突破（不看 RSI / 成交量）
    rsiVolumeDisabledUntilOpenMinutes: 30,
    // 收盘前最后 N 分钟：只看价格突破（不看 RSI / 成交量）
    rsiVolumeDisabledBeforeCloseMinutes: 60,
  },

  // ========================
  // 时间限制（美股时间，分钟）
  // ========================
  noTradeAfterOpenMinutes: 5, // 开盘前5分钟不交易
  noTradeBeforeCloseMinutes: 10, // 收盘前20分钟不交易
  closeTimeMinutes: 10, // 尾盘平仓时间

  // ========================
  // 入场过滤总开关
  // 一年样本回测证伪：RSI / 量比 / 分时段 / 指数过滤 全部为负贡献，默认全部关闭。
  // 保留字段以便随时切回旧行为做 AB 对照（见 references/BACKTEST.md 第 6 节）。
  //
  //   - enableRsiFilter        : RSI 阈值 (rsiBuyThreshold / rsiSellThreshold)
  //   - enableVolumeFilter     : 量比阈值 (volumeEntryThreshold)
  //   - enableEntryPhaseFilter : 分时段 "价格段 vs 主段" 规则 (entryFilterSchedule)
  //                              false 时 = 整天只看价格突破 (loose)
  //                              true  时 = 早盘/尾盘价格段、主段严格
  //                              注意：开关只影响 RSI/量比是否在"主段"被校验，
  //                                    只有当 enableRsiFilter 或 enableVolumeFilter
  //                                    同时为 true 时才有实际过滤行为
  //   - enableIndexTrendFilter : 指数斜率方向门控 (indexTrendFilter.*)
  //   - enableTrendDetector    : 09:35 趋势日评分门控 (src/core/trendDetector.ts)
  //                              <40 分的票当日禁开仓; 实盘在 src/index.ts 主循环集成
  // ========================
  filters: {
    enableRsiFilter: false,
    enableVolumeFilter: false,
    enableEntryPhaseFilter: false,
    enableIndexTrendFilter: false,
    enableTrendDetector: true,
    enableSlopeMomentum: false,
    enableChoppiness: false, // B2-lite 日内震荡过滤；默认关闭，AB 切回旧行为
  },

  // ========================
  // 指数趋势过滤参数（仅在 filters.enableIndexTrendFilter=true 时生效）
  // 斜率 > epsilon 才允许做多，< -epsilon 才允许做空
  // ========================
  // ========================
  // 个股 VWAP 斜率动量过滤（仅在 filters.enableSlopeMomentum=true 时生效）
  // |slope/vwap| * 10000 >= threshold(bps) 才允许入场，过滤震荡行情
  // ========================
  slopeMomentumThreshold: 0.3, // bps，对应斜率分布 ~P72

  // ========================
  // 日内震荡过滤（B2-lite，仅在 filters.enableChoppiness=true 时生效）
  // 评分组成：VWAP穿越频率(40) + 带内时长比(30，三档加权) = 满分 70
  // 评分跨 windowBars 可比（指标 1 用频率而非次数，指标 2 是百分比）
  // ========================
  choppiness: {
    windowBars: 30,                    // 滚动窗口（根 K），回测扫 30/20/15
    bandAtrRatios: [0.1, 0.2, 0.3],   // 三档带宽
    scoreThreshold: 25,                // 总分 < 阈值禁开仓（0–70）
  },

  indexTrendFilter: {
    indexSymbol: 'QQQ.US',
    // 斜率容忍区间
    epsilon: 0,
    // 斜率不可用（数据不足等）时的处理：block=禁止开仓，pass=放行
    whenSlopeUnavailable: 'pass' as 'pass' | 'block',
  },

  // ========================
  // 风控
  // ========================
  maxDailyDrawdown: 0.02,
  positionPctPerTrade: 0.2,
};


export default Config;

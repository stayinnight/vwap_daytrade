# Smoke Spec for spec-to-techdoc

## 背景与目标

目前回测 runner 在每次回测结束后需要手动恢复被修改的 `config.exitMode`。如果忘记恢复, 下一次回测会携带污染配置. 目标是让 runner 自动在 finally 块里还原.

## 详细设计

### 关键点 1: 在 runner 入口保存原值快照

在 `src/backtest/runner.ts` 的入口处, 读取 `config.exitMode` / `config.stopAtrRatio` / `config.filters` 三个字段, 存到一个 snapshot 对象.

### 关键点 2: finally 块还原

在 runner 主体外包一层 try / finally, 在 finally 里把 snapshot 写回 config.

### 关键点 3: 单元测试

新增 `src/backtest/__tests__/runner-restore.test.ts`, 断言一次回测结束后 config 三字段值与入口前一致.

## 方案权衡

- 方案 A: 手动提醒用户恢复 → 靠人不可靠
- 方案 B: finally 自动恢复 (采纳) → 对调用方透明
- 方案 C: 改用 config 深拷贝 → 侵入性大, 其他代码依赖单例

## 风险与影响

- 实现风险 · 中: finally 如果自己抛异常会掩盖原异常
- 回归风险 · 低: 现有手动恢复的逻辑保留一段时间并存, 可回滚

# Spec-to-TechDoc Skill — 设计文档

## 背景与目标

### 问题

仓库里已经形成 `docs/superpowers/specs/ → plans/` 的两段式节奏：spec 描述实现、plan 描述执行。但 spec 偏实现视角，不适合直接当作技术方案文档对外分享（评审、接手、对齐）。当前做法是手工把 spec 重写一份，成本高、风格不统一。

### 目标

提供一个 Claude Code skill `spec-to-techdoc`，接受一份 spec 文件作为输入，产出一份飞书 Tech Design 文档，主要满足：

- **从 spec 提炼而非原样搬运**：按需求点拆分 / 双维度定性 / 证据 / 风险的纪律做一次分析，再按技术文档写作规范重组。
- **两步放回审核**：analysis 作为对话内中间产物由用户当场 review，通过后再产出 tech doc 并导入飞书。
- **模板可切换**：内置通用模板（默认）和生活服务 FE 业务模板，可由参数或对话指定。
- **最终产物只落飞书**：tech doc Markdown 写到 `/tmp/` 后委托 `feishu-cli doc import`，文档 URL 返还给用户。analysis 不落盘。

### 非目标

- 不做分享稿、一页纸 summary、Release Note 等其他文档类型。
- 不做双向同步（spec 改了不自动刷 techdoc）。
- 不托管非技术元数据（Meego 地址、UI 稿链接等），业务模板里这类字段保留空占位符由用户在飞书里手填。

## 方案总览

```
spec 文件
   │
   ▼
[Step 1: Analysis]
   └─ 按 references/analysis.md 纪律：
      关键点拆分 → 双维度定性 → 证据 → 风险 → 覆盖表
   └─ 执行模式（按关键点数量自动选择）：
      ≤5 点  → 主 session 完成
      >5 点  → 对每个关键点派 Explore subagent 并行搜证据，主 session 做 coordinator 裁决
   └─ 阈值可用 --agents always|never|auto 覆盖（默认 auto）
   │
   ▼
（对话内 review 断点 —— 用户当场修正定性/证据/风险，不落盘）
   │
   ▼
[Step 2: TechDoc Generation]
   └─ 模板选择：
      参数指定 --template generic|lifeservice → 直接用
      未指定 → 扫描 spec 关键词（channel/bundle/lynx/webview/埋点/gecko 等业务信号）
               命中 → 主动询问用户"拟用 lifeservice 模板"，等确认
               未命中 → 默认 generic
   └─ 占位符填充：基于 audited analysis + spec 原文
   └─ 写作约束：具体动词、术语一致、面向任务（来自飞书写作指南 Part 3）
   └─ 格式约束：Mermaid/表格/Callout 按 feishu-cli-doc-guide 规范（9×9 表格、6 种 Callout、Mermaid 花括号等）
   │
   ▼
[Step 3: 飞书导入]
   └─ 写 /tmp/spec-to-techdoc-<timestamp>.md
   └─ feishu-cli doc import --title "<spec 标题>｜技术方案"
   └─ feishu-cli perm add + perm transfer-owner（按 feishu-cli-write/import 约定）
   └─ 返回文档 URL
```

## 详细设计

### Skill 文件结构

```
~/.claude/skills/spec-to-techdoc/
├── SKILL.md                      # 入口，含 user-invocable: true
├── references/
│   ├── analysis.md               # 从 vwap_daytrade/analysis.md 同步
│   └── techdoc-style.md          # 飞书写作指南 Part 1/3/4/6/7 的提炼
└── templates/
    ├── generic-techdoc.md        # 通用模板（5 段 + 结论先行摘要）
    └── lifeservice-fe.md         # 生活服务 FE 业务模板
```

**SKILL.md** 只写流程、决策树、命令示例。分析纪律和写作规范下沉到 `references/`，模板下沉到 `templates/`，入口文件保持短。

### 参数

```bash
/spec-to-techdoc <spec-path> [options]

options:
  --template generic|lifeservice     # 显式指定模板；未指定则按关键词推断并询问
  --agents always|never|auto         # subagent 策略；auto = 按 ≤5/>5 点分流（默认）
  --agent-threshold N                # 自定义阈值（默认 5）
```

### Step 1: Analysis

严格按 `references/analysis.md` 的六节纪律展开。产物结构化打印到对话（不写文件）：

1. **关键点清单**
   - 每点一行："P1. <一句话做什么 + 边界> | <大小 × 类型>"
2. **逐点展开**
   - 承接层/改动层（判断链路）
   - 证据：`file:line — 说明`，标 `高/中/低` 置信度
   - 风险：按 实现/定性/协作/回归 四类列，标 `高/中/低` 等级
3. **覆盖表**
   - spec 每个原子需求点对应到关键点编号，状态 `已分析 / 待确认 / 上游调整即可`

#### 执行模式

| 关键点数 | 默认行为 | 说明 |
|---|---|---|
| ≤5 | 主 session 完成 | 小 spec 过度工程没意义 |
| >5 | 对每点派一个 Explore subagent 并行搜证据 | 主 session 做 coordinator |

**subagent 任务 prompt 要素**：
- 仅对该关键点下结论，不跨点
- 必须按 `analysis.md` 的"证据要求"和"风险点"章节输出
- 禁止决定最终范围、归属、风险排序（由主 session 裁决）

**Coordinator 裁决规则**（对齐 analysis.md "多 agent 模式补充规则"）：
- 同一文件被多点引用 → 汇总去重
- 置信度冲突 → 取最低
- 定性冲突 → 按证据强度取更保守
- 交叉依赖 → 显式复核

#### 审核断点

打印 analysis 后 skill 停下来等用户反馈。允许的反馈形式：
- `P3 改成小改` → 修正第 3 点定性
- `P5 证据不够` → 重新搜该点
- `继续` / `ok` / `approve` → 进 Step 2
- 没有明确"继续"信号前不得进入 Step 2

### Step 2: TechDoc Generation

#### 模板选择决策树

```
用户显式 --template X
    └→ 用 X

否则扫 spec 关键词：
  lifeservice 信号词 = [channel, bundle, lynx, webview, gecko, 埋点, slardar, tea, bnpm, byted-poi, meego]
  命中任一 → 询问"检测到业务关键词 <list>, 拟用 lifeservice-fe 模板，y/n？"
           y → lifeservice
           n → generic
  未命中 → 默认 generic（不问）
```

#### 模板填充规则

两份模板都采用 `{{...}}` 占位符 + 注释式"填空指令"：

```markdown
## 摘要与核心结论

- **背景**：{{one line from spec.motivation}}
- **结论**：{{from spec.decision + analysis coverage}}
- **核心理由**：{{top 3 from spec.trade-offs}}
- **预计收益/影响**：{{combine spec goals + analysis risks summary}}
```

占位符中的英文说明是 LLM 填空提示，不是给读者看的。填充后所有 `{{...}}` 必须消失；无数据的字段按模板预设（空占位符 / 空表格行）保留。

#### generic 模板结构

基于飞书写作指南 Part 1 + Part 7：

1. 摘要与核心结论（结论先行）
2. 背景与目标
3. 方案总览（含架构图 Mermaid 透传）
4. 详细设计（按关键点组织：每个关键点一小节，含 "承接层 / 改动类型 / 关键接口"）
5. 方案权衡
6. 风险与影响（来自 analysis 风险点章节，按四类归并）

#### lifeservice-fe 模板结构

完整保留业务模板 14 节骨架：需求材料 / 需求背景 / 技术方案（方案设计、埋点设计、兼容评估、接入 Channel 评估、channel 划分与组件复用、影响面评估、性能评估） / 详细排期 / 监控 / 基建 Checklist / 体积 Checklist / 提测 Checklist / 上线 Checklist / 应急措施 / 附录。

skill 可填的字段（来自 spec + analysis）：
- 需求背景 / 技术方案 → 方案设计 / 影响面评估 / 性能评估 / 兼容评估

skill 不可填、保留空占位符的字段：
- 需求材料表（Meego / UI 稿 / MR 等链接）
- 详细排期（日期表格）
- 监控（具体 bid / pid）
- 基建 Checklist 勾选
- 体积 / 提测 / 上线 Checklist
- 应急负责人 / 回滚方案的人名

#### 写作约束

来自飞书写作指南 Part 3，写进 `references/techdoc-style.md`：

- 用具体动词：「调用 X 接口」优先于「与 X 交互」
- 术语一致：从 spec 抽 glossary，全文统一
- 面向任务：多用祈使句，给可执行步骤
- Callout 三类用途：Tip（补充）/ Warning（风险）/ Highlight（结论）

#### 格式约束

全量引用 `feishu-cli-doc-guide` 的 10 条 TL;DR。skill 产出 Markdown 前自检：

- Mermaid 花括号 / `par...and...end` / 换行符 `\n`
- 表格 > 9×9 是否需要人工拆
- Callout 仅 6 种合法 type（NOTE/WARNING/TIP/CAUTION/IMPORTANT/SUCCESS）

### Step 3: 飞书导入

委托现成 skill 能力，不重造：

```bash
# 写 Markdown
写 /tmp/spec-to-techdoc-<timestamp>.md

# 编码校验（来自 feishu-cli-import 的强制步骤）
python3 -c "d=open('<file>','rb').read(); assert b'\xef\xbf\xbd' not in d; d.decode('utf-8')"

# 导入
feishu-cli doc import /tmp/spec-to-techdoc-<timestamp>.md --title "<spec 标题>｜技术方案"

# 权限 + 所有权转移（按 feishu-cli-import 的 CRITICAL 要求）
feishu-cli perm add <doc_id> --doc-type docx --member-type email \
  --member-id zengchuan.000516@gmail.com --perm full_access --notification
feishu-cli perm transfer-owner <doc_id> --doc-type docx --member-type email \
  --member-id zengchuan.000516@gmail.com --notification

# 返回 URL
```

### 错误处理

| 场景 | 处理 |
|---|---|
| spec 文件不存在 | 拒绝执行，提示正确路径 |
| spec 太短（<500 字符）或无明显结构 | 提醒用户这可能不是一份 spec，确认后继续 |
| analysis 阶段用户长时间无响应 | 停留等待，不自动推进 |
| 飞书导入失败 | 保留 `/tmp/` Markdown 路径，打印错误；用户可复用 `feishu-cli-import` 重试 |
| feishu-cli 未登录或 token 过期 | 提示运行 `! feishu-cli auth login`，中止本次流程 |
| Mermaid 语法命中飞书禁忌 | 先在本地用规则 lint 告警；用户确认降级或 skill 自动改写（花括号 → 圆括号） |

## 方案权衡

### 为什么是 skill 而不是独立 CLI

考虑过写一个独立的 `spec-to-techdoc` npm 包，但：
- 核心逻辑（拆关键点、写证据、分配 subagent）本质是 LLM 任务，CLI 壳只会把 LLM 再包一层
- 飞书导入链路已在 `feishu-cli-*` skills 里完整实现，skill 内委托即可
- Claude Code 的 `Skill` + `Agent` 原语天然适合这种"主 session + 子 agent + 分析纪律"的工作流

### 为什么 analysis 不落盘

考虑过落到 `docs/superpowers/analysis/YYYY-MM-DD-*.md`：
- 优点：可重放、可版本化
- 缺点：analysis 是"面向 review 的中间态"，审完立刻消费掉就行。落盘会攒出一大堆和 spec 一一对应的临时产物，污染仓库；且仓库里的 analysis 再次打开价值很低，不如重跑一次
- 结论：不落盘，对话里 review + 审完进 Step 2。如果将来发现某个 analysis 特别有价值，用户可以手动复制保存

### 为什么 subagent 是 auto 而不是默认 always

考虑过所有 spec 都派 subagent：
- 小 spec（2-3 个关键点）起 subagent 开销比收益大，主 session 直接做更快
- 大 spec（>10 点）主 session 一个个 grep 会把 context 打爆
- 5 点阈值是经验值，基于现有 `candle-shape-design.md`（3 点）vs `trend-detector-v2-design.md`（10+ 点）的分布
- 允许 `--agents always|never` 和 `--agent-threshold N` 覆盖

### 为什么模板推断要问而不是静默选

考虑过检测到业务关键词就直接用 lifeservice 模板：
- 关键词检测容易误报（spec 里随口提到 "webview" 不代表这是生活服务需求）
- 模板选错的代价大（生成出来结构完全错，用户要重跑）
- 问一句的成本很低，特别是在 Step 1 审核断点之前

## 风险与影响

### 实现风险

- **中 · analysis 质量依赖 LLM 对 analysis.md 纪律的遵守**：尤其是"证据置信度"和"反证"这类软约束。缓解：subagent prompt 里硬性要求输出格式（"每个结论必须附 file:line + 置信度"），主 session 做 coordinator 时做一道格式校验。
- **中 · Mermaid 透传导致飞书渲染失败**：spec 里的 Mermaid 未必遵循飞书子集。缓解：引入 `feishu-cli-doc-guide` 的 lint 规则，在 Step 2 末尾跑一次检查；严重违规时自动降级为代码块。
- **低 · 模板占位符残留**：LLM 可能漏填。缓解：生成后全局 grep `{{` `}}`，非零则报错重试。

### 协作风险

- **中 · feishu-cli 认证状态漂移**：User Token 2 小时过期、App 权限可能缺失。缓解：Step 3 前先 `feishu-cli auth status` 预检，不通过直接让用户 `auth login`，不要硬跑导入。
- **低 · 业务模板更新**：生活服务 FE 模板原 wiki 会迭代。缓解：模板文件顶部标注"来源 URL + 同步日期"，鼓励定期手动 diff。

### 回归风险

- **低 · 不影响现有 spec/plan 工作流**：skill 只读 spec，不改仓库里任何文件；只写 `/tmp/` 和飞书。

### 定性风险

- 无。

## 需求覆盖映射

| 需求点 | 关键点 | 状态 |
|---|---|---|
| 从 spec 提炼而非原样搬运 | Step 1 Analysis 流程 | 已分析 |
| 两步放回审核 | Step 1 → 审核断点 → Step 2 | 已分析 |
| ≤5 点主 session / >5 点 subagent | Step 1 执行模式表格 | 已分析 |
| analysis 不落盘，tech doc 落飞书 | Step 1 审核断点说明 + Step 3 | 已分析 |
| 支持通用 + 业务两个模板 | Step 2 模板选择决策树 + templates/ 目录 | 已分析 |
| 模板选择未指定时主动询问 | Step 2 模板选择决策树 | 已分析 |
| 业务模板非技术字段保留空占位 | Step 2 lifeservice-fe 填充规则 | 已分析 |
| 遵循飞书写作规范 + 格式约束 | Step 2 写作约束 + 格式约束 | 已分析 |
| 导入走 feishu-cli-import | Step 3 | 已分析 |

# Spec-to-TechDoc Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个名为 `spec-to-techdoc` 的 Claude Code skill，能读取一份 spec 文件，按 `analysis.md` 纪律做提炼，经用户审核后根据选定模板生成飞书技术方案文档。

**Architecture:** 纯 prompt-engineering skill，不包含可执行代码。核心资产是 `SKILL.md`（流程与决策树）、`references/` 下两份参考规范（analysis 纪律 + 写作/格式规范）、`templates/` 下两份技术方案模板（通用 + 生活服务 FE）。飞书导入链路委托现成的 `feishu-cli-import` 能力，skill 本身只生成 Markdown + 做 lint + 调 CLI。

**Tech Stack:** Markdown（skill 文件 / 模板 / 参考）、`feishu-cli`（外部 CLI，用于导入飞书）、Bash（lint 和导入脚本）。无 npm / TS 依赖。

**Spec reference:** `docs/superpowers/specs/2026-04-20-spec-to-techdoc-design.md`

---

## 文件结构

| 路径 | 职责 |
|---|---|
| `~/.claude/skills/spec-to-techdoc/SKILL.md` | skill 入口；含 frontmatter、完整流程、模板决策树、命令示例 |
| `~/.claude/skills/spec-to-techdoc/references/analysis.md` | 分析纪律（从 vwap_daytrade/analysis.md 同步） |
| `~/.claude/skills/spec-to-techdoc/references/techdoc-style.md` | 飞书写作与格式规范（Part 1/3/4/6/7 提炼 + feishu-cli-doc-guide 10 条 TL;DR） |
| `~/.claude/skills/spec-to-techdoc/templates/generic-techdoc.md` | 通用技术方案模板（5 段 + 结论先行） |
| `~/.claude/skills/spec-to-techdoc/templates/lifeservice-fe.md` | 生活服务 FE 业务模板（14 节） |
| `docs/superpowers/fixtures/spec-to-techdoc-smoke-spec.md` | smoke 测试用的最小 spec 样本 |

实现顺序：先 references → 再 templates → 最后 SKILL.md（SKILL.md 需要引用前两者）。冒烟测试作为最后一步，单独跑通全链路。

---

## Task 1：建立 skill 目录骨架

**Files:**
- Create: `~/.claude/skills/spec-to-techdoc/` (dir)
- Create: `~/.claude/skills/spec-to-techdoc/references/` (dir)
- Create: `~/.claude/skills/spec-to-techdoc/templates/` (dir)

- [ ] **Step 1: 创建三个目录**

```bash
mkdir -p ~/.claude/skills/spec-to-techdoc/references \
         ~/.claude/skills/spec-to-techdoc/templates
```

- [ ] **Step 2: 确认目录存在**

```bash
ls -la ~/.claude/skills/spec-to-techdoc/
```

Expected: 输出包含 `references` 和 `templates` 两个子目录，没有其他文件。

- [ ] **Step 3: 此任务不 commit（目录空无内容，提交会失败）。后续任务创建文件时会自动把目录带入 git。**

---

## Task 2：同步 `references/analysis.md`

Skill 分析阶段必须严格遵守 `vwap_daytrade/analysis.md` 的纪律。由于 skill 目录在 `~/.claude/skills/` 下（Claude Code 全局 skill 目录），不能指望 skill 运行时能读到仓库里的 `analysis.md`（skill 被其他项目调用时那份文件不存在）。必须把内容复制到 skill 自己的 `references/` 下。

**Files:**
- Create: `~/.claude/skills/spec-to-techdoc/references/analysis.md`

- [ ] **Step 1: 复制 analysis.md 到 skill 目录**

```bash
cp /Users/bytedance/workspace/vwap_daytrade/analysis.md \
   ~/.claude/skills/spec-to-techdoc/references/analysis.md
```

- [ ] **Step 2: 在文件头加"来源说明"注释**

用 Edit 工具把文件第一行 `# 分析纪律` 前面插入来源说明。

把 `# 分析纪律` 替换为：

```markdown
<!--
来源：https://github.com/<user>/vwap_daytrade/blob/main/analysis.md
同步日期：2026-04-20
说明：本 skill 引用这份分析纪律时使用本地副本，避免跨项目调用时读不到源文件。
若源文件更新，需手动重新同步并修改"同步日期"。
-->

# 分析纪律
```

- [ ] **Step 3: 校验内容与源文件一致（仅首尾）**

```bash
head -5 ~/.claude/skills/spec-to-techdoc/references/analysis.md
tail -5 ~/.claude/skills/spec-to-techdoc/references/analysis.md
```

Expected: 头部有 `<!-- 来源... -->` 注释然后是 `# 分析纪律`；尾部和 `vwap_daytrade/analysis.md` 的尾部一致（以 "## 止步边界" 小节结尾）。

- [ ] **Step 4: Commit（含 Task 1 产生的隐式目录）**

skill 文件不在 vwap_daytrade 仓库内，不需要 `git add`。改为在 vwap_daytrade 仓库里用 commit 信息记录这一步（用一个只改 plan 的 commit 顶替）。

```bash
# 由于 skill 安装路径在 ~/.claude/skills/ 外部，无法通过 git 追踪。
# 本 task 不做 git commit，在 Task 8 的 smoke 验证中统一验证文件存在。
echo "Task 2 完成，skill 文件已落到 ~/.claude/skills/spec-to-techdoc/references/analysis.md"
```

---

## Task 3：编写 `references/techdoc-style.md`

把飞书写作指南（Part 1/3/4/6/7）和 `feishu-cli-doc-guide` 的 10 条 TL;DR 融合成一份"写作 + 格式"参考，给 skill 的 Step 2（TechDoc 生成）作为硬约束。

**Files:**
- Create: `~/.claude/skills/spec-to-techdoc/references/techdoc-style.md`

- [ ] **Step 1: 写入参考文件**

用 Write 工具创建 `~/.claude/skills/spec-to-techdoc/references/techdoc-style.md`，内容如下：

```markdown
<!--
来源：
- 飞书文档《技术文档写作指南》https://bytedance.larkoffice.com/docx/PrxtdOF9cosv1HxiIlncLHtNnZf
- feishu-cli-doc-guide skill（~/.claude/skills/feishu-cli-doc-guide/SKILL.md）
同步日期：2026-04-20
-->

# 技术文档写作与格式规范

Skill `spec-to-techdoc` 在 Step 2 生成 Markdown 前必须按本规范自检。违规项必须修正后才能进入 Step 3 导入飞书。

## 1. 结论先行（硬约束）

所有技术方案文档的第一节必须是"摘要与核心结论"，包含四项：

- **背景**：一句话说明问题
- **结论**：我们建议/决定做什么
- **核心理由**：为什么选这个方案（1-3 条）
- **预计收益/影响**：量化收益 + blast radius

目标：读者在 30 秒内抓住核心要点。

## 2. 语言三原则

1. **使用具体、明确的动词**：用「调用 updateUser 接口」代替「和用户中心服务进行交互」。
2. **保持术语一致性**：同一概念全文使用统一术语（不要一会 UID 一会 userId）。
3. **面向任务，提供指令**：多用祈使句，给可执行步骤或代码。

反模式：冗余被动语态、学生腔（"我们应当注意到"）、干描述没代码示例。

## 3. 风格与调性

本 skill 的产物定位为"技术设计/方案"，调性：**严谨、客观、开放**。

- 充分论证方案合理性
- 主动暴露潜在风险和未知项
- 清晰展示方案间 trade-offs
- 不夸大收益、不隐藏代价

## 4. 飞书格式约束（来自 feishu-cli-doc-guide TL;DR 10 条）

| # | 规则 | 触发检查 |
|---|---|---|
| 1 | Mermaid flowchart 标签禁止 `{}`（会被解析为菱形节点） | 正则扫 `flowchart` 后的 `{.*}` |
| 2 | Mermaid 禁止 `par...and...end`（飞书不支持） | 搜 `\bpar\b` 后有 `and`/`end` |
| 3 | Mermaid 节点标签换行禁止 `\n`，用 `<br/>` | 搜 Mermaid 块内的字面量 `\n` |
| 4 | sequenceDiagram participant ≤ 8，alt 嵌套 ≤ 1 层 | 人工检查 |
| 5 | 方括号标签含冒号时加双引号：`["类型: string"]` | 搜 `\[[^"].*:.*\]` |
| 6 | PlantUML 禁止行首缩进、`skinparam`、可见性标记（`+ - # ~`） | 搜 PlantUML 块内 skinparam |
| 7 | 表格超过 9 行或 9 列会被 CLI 自动拆分（了解即可，不用手拆） | 无需操作 |
| 8 | Callout 仅 6 种合法 type：NOTE / WARNING / TIP / CAUTION / IMPORTANT / SUCCESS | 搜 `> \[!` 后非 6 种 type |
| 9 | 块级公式 `$$...$$` 会降级为行内（了解即可） | 无需操作 |
| 10 | 图片默认自动上传，失败降级为占位块（了解即可） | 无需操作 |

违规优先自动修正（`{}` → `()`），否则报错让用户决定。

## 5. Callout 用法分类

- **Tip**（`> [!TIP]`）：补充说明、最佳实践
- **Warning**（`> [!WARNING]` / `> [!CAUTION]`）：风险、非兼容变更
- **Highlight**（`> [!NOTE]` / `> [!IMPORTANT]` / `> [!SUCCESS]`）：关键结论、设计决策、重要成果

一份 doc 不要滥用超过 5 个 callout，否则都变成了噪声。

## 6. 标题层级

- **H1**：文档大标题（一份 doc 只有一个）
- **H2**：核心 Part（摘要 / 背景 / 详细设计 / 风险 ...）
- **H3**：Part 下的章节
- **H4**：章节内更细分的要点
- 列表层级不宜超过 3 层

## 7. 代码块

- 必须指定语言（`python`/`go`/`json`/`bash`/`diff`）
- 代码示例应完整、可运行，带必要注释
- 展示增删用 `diff` 语言标识

## 8. Lint 校验清单（生成后自检）

skill 生成 Markdown 后必须跑这些检查：

1. 全文搜 `{{` 和 `}}`，零命中 → 占位符全部填完
2. 按上面表格 1/2/3/5/6/8 条规则扫图表块 + callout type
3. 表格行列数统计（仅提示，不拦截）
4. 编码校验：`python3 -c "d=open('<file>','rb').read(); assert b'\xef\xbf\xbd' not in d; d.decode('utf-8')"`
```

- [ ] **Step 2: 确认文件落盘**

```bash
wc -l ~/.claude/skills/spec-to-techdoc/references/techdoc-style.md
```

Expected: 行数在 80-120 之间（和本 task 步骤 1 粘贴的内容匹配）。

---

## Task 4：编写 `templates/generic-techdoc.md`

通用技术方案模板。基于飞书写作指南 Part 1（骨架）和 Part 7（结论先行）。所有需要 LLM 填空的位置用 `{{...}}` 占位符，占位符内部用英文写填空指令（避免和正文中文混淆）。

**Files:**
- Create: `~/.claude/skills/spec-to-techdoc/templates/generic-techdoc.md`

- [ ] **Step 1: 写入模板**

用 Write 工具创建 `~/.claude/skills/spec-to-techdoc/templates/generic-techdoc.md`，内容如下：

````markdown
<!--
模板：通用技术方案（generic）
来源：飞书文档《技术文档写作指南》Part 1 + Part 7
适用：无特定业务前缀要求的通用技术方案
占位符规则：
  - {{...}} 内部为英文填空指令，填完后必须完全删除
  - 占位符说明里出现 "from spec.X" 表示从 spec 原文提炼
  - 占位符说明里出现 "from analysis.X" 表示从 Step 1 审核过的 analysis 结果提炼
-->

# {{spec 标题的可读化版本，如 "Trend Detector V2 技术方案"}}

## 摘要与核心结论

- **背景**：{{one-line problem statement, from spec.motivation or background section}}
- **结论**：{{one-line decision: what we will build, from spec overview}}
- **核心理由**：{{1-3 bullets, top reasons from spec.trade-offs or decision rationale}}
- **预计收益/影响**：{{combine expected gains from spec.goals + blast radius from analysis.risks summary}}

## 背景与目标

### 问题

{{2-4 sentences explaining why this work is needed, from spec.background. 用具体动词, 避免被动语态}}

### 目标

{{bullet list of measurable goals from spec.goals, 每条以动词开头}}

### 非目标

{{bullet list from spec.non-goals if present, 否则写"无明确非目标"}}

## 方案总览

{{2-3 paragraphs describing the high-level approach, from spec overview + analysis 关键点清单的聚合视角}}

{{如果 spec 里有架构/流程 Mermaid, 原样透传（先按 techdoc-style.md 第 4 节 lint）; 否则跳过本段}}

## 详细设计

{{按 analysis 的关键点逐一展开, 每个关键点一个 H3。模板示例如下:}}

### {{关键点 P1 的一句话标题}}

- **改动定性**：{{size × type, e.g., 新增 × 代码}}
- **承接层**：{{file path 或模块名, from analysis.证据}}
- **关键接口/数据结构**：

```{{language}}
{{code snippet from spec or analysis, showing the interface}}
```

- **实现要点**：{{numbered list of 2-5 concrete actions, 面向任务}}

### {{关键点 P2...}}

{{按同一结构展开, 数量由 analysis 决定, 不要硬凑或省略}}

## 方案权衡

{{对比 2-3 个候选方案, from spec.alternatives 或 analysis.反证. 表格或列表均可, 示例表格:}}

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| {{方案 A}} | {{优点要点}} | {{缺点要点}} | {{采纳 / 否决 + 一句理由}} |
| {{方案 B}} | {{...}} | {{...}} | {{...}} |

## 风险与影响

{{from analysis 的风险点章节, 按四类归并; 每条标等级. 只保留 analysis 里真实存在的类别, 空类别整体删除}}

### 实现风险

- **{{高/中/低}} · {{一句话风险}}**：{{详细说明 + 承接文件路径}}

### 协作风险

- **{{高/中/低}} · {{一句话风险}}**：{{详细说明 + 依赖方}}

### 回归风险

- **{{高/中/低}} · {{一句话风险}}**：{{详细说明 + 影响路径}}

### 定性风险

- **{{高/中/低}} · {{一句话风险}}**：{{详细说明 + 证据缺口}}

## 需求覆盖映射

{{from analysis 的覆盖表, 原样搬运}}

| 需求点 | 对应关键点 | 状态 |
|---|---|---|
| {{需求点描述}} | {{P1/P2/...}} | {{已分析 / 待确认 / 上游调整即可}} |
````

- [ ] **Step 2: 校验占位符格式**

```bash
grep -c '{{' ~/.claude/skills/spec-to-techdoc/templates/generic-techdoc.md
grep -c '}}' ~/.claude/skills/spec-to-techdoc/templates/generic-techdoc.md
```

Expected: 两个数字相等（每个 `{{` 配一个 `}}`）。

---

## Task 5：编写 `templates/lifeservice-fe.md`

生活服务 FE 业务模板。完整保留业务 14 节骨架，技术内容字段可由 skill 填充，业务元数据字段保留空占位让用户在飞书里手填。

**Files:**
- Create: `~/.claude/skills/spec-to-techdoc/templates/lifeservice-fe.md`

- [ ] **Step 1: 写入模板**

用 Write 工具创建 `~/.claude/skills/spec-to-techdoc/templates/lifeservice-fe.md`，内容如下：

````markdown
<!--
模板：生活服务 FE 业务模板（lifeservice）
来源：https://bytedance.larkoffice.com/docx/WYqhdWebaoYzZHxJoOwctDqPn4b
同步日期：2026-04-20
说明：
  - 技术内容字段（方案设计、影响面、性能等）由 skill 从 spec + analysis 填充
  - 业务元数据字段（Meego、UI 稿、MR、Channel 量级、Checklist 勾选等）保留空占位由用户手填
  - 不要删除空字段，业务模板完整性是评审前提
-->

# 【技术方案-FE】{{需求名称, from spec 标题}}｜{{today's date YYYY.MM.DD}}

> 估时 >= 3pd 必须写技术方案

> [!WARNING]
> 技术评审完毕后，若需更新技术方案，务必周知关联方并同步变更细节

# 需求材料

> 没有的项删除即可

| 需求 Meego 地址 |  |
| --- | --- |
| 需求稿 |  |
| UI 稿地址 |  |
| 代码仓库地址 |  |
| MR |  |
| 合作方技术文档 |  |
| 埋点文档 |  |
| 测试 case 地址 |  |
| PPE / BOE 地址 |  |
| Cony 包地址 |  |
| 实验地址 |  |
| 发布地址 |  |
| 需求群 | 点击左侧加号，下拉选择群名片 |

# 需求背景

{{2-4 sentences from spec.motivation or background. 说清业务问题与当前痛点, 避免技术细节}}

# 技术方案

## 方案设计

{{从 spec overview + analysis 关键点聚合而成的方案设计说明. 必须覆盖以下要点 (命中则写, 未涉及则注明"本需求不涉及"):}}

1. 业务入口来源枚举、页面入参枚举、页面拼接参数是否合理
2. webview/lynxview 容器选择
3. 地址下发方式（SchemeSDK / channel 分组 / surl）
4. 代码异常 UI 兜底设计
5. 对外交互（页面 url+params / 组件 props / JSB params）
6. 页面组件结构 & UI 图
7. 数据流程图

{{若 spec 有 Mermaid 流程图/架构图, 原样透传}}

## 埋点设计

{{from analysis 关键点中类型含"埋点"的条目. 命中要点按下表列出, 未涉及写"本需求不涉及埋点"}}

1. 新页面是否接入页面级 BTM
2. 埋点方案是否评审
3. 新增埋点字段是否需要服务端额外下发

## 兼容评估

{{from analysis 的回归风险 + 定性风险章节, 聚焦兼容性}}

1. 使用的模块是否有新老版本兼容性问题
2. 页面本身是否有新老版本兼容问题
3. 是否兼容服务端字段为空/异常下发
4. 是否不依赖前后端上线顺序

## 接入 Channel 评估

{{from analysis 中涉及 bundle/channel 的关键点; 若 spec 完全未涉及, 整段保留但注明"本需求不涉及新增 bundle/channel"}}

1. 是否涉及新增 bundle 和 channel，预估量级
2. 新增 channel 的高优/level-1 判断
3. 新增 channel 或 bundle 是否导致 gecko 体积超过 5m
4. 是否为动态组件及体积优化方案

## channel 划分与组件复用

{{from analysis 中"复用/新增组件"的关键点}}

1. 是否涉及新增 bundle/channel 及高优/normal 组判定
2. 是否可复用标准化券组件
3. 新增 bundle/channel 优先级划分

## 影响面评估

{{from analysis 的回归风险章节}}

1. 组件复用：当前组件其余复用场景及本次改动影响
2. 场景投放：当前 bundle 在其余投放渠道的情况
3. 基础依赖：升级 sdk 和依赖对当前组件的影响

## 性能评估

{{from analysis 关键点中涉及性能的条目; 未涉及写"本需求无明显性能风险"}}

1. 数据预取（PrefetchV2）是否需要
2. 长列表是否优化 / 分页 / 预加载
3. web 是否需要离线化
4. 图片模块与尺寸下发

# 详细排期

| 模块/日期 |  |  |  |
| --- | --- | --- | --- |
| 模块 1 |  |  |  |
| 模块 2 |  |  |  |
| 埋点 |  |  |  |
| 联调 |  |  |  |

# 监控

> 1. 全局监控数据是否覆盖
> 1. 接口是否在 Slardar 上配置了监控告警
> 1. Monitor 是否传入了 slardar bid

```javascript
import SlardarLynx from '@byted-poi/logger/esnext/plugins/SlardarLynx';

const Monitor = createMonitorInstance({
  project: '',
  page: '',
  logger: {
    plugins: [SlardarLynx],
    slardarLynx: {
      bid: '',
      pid: ''
    },
  },
});
```

**监控看板地址**：

# 基建 Checklist

| 类型 | SDK/组件 | 是否接入 | 不接入原因 |
| --- | --- | --- | --- |
| 质量/性能监控 | @byted-poi/monitor |  |  |
| 接口请求 | @byted-poi/request |  |  |
| 埋点 (Tea) | @byted-poi/tracker |  |  |
| 配置 (settings/tcc/AB) | @byted-poi/config |  |  |
| 跨端通信 (JSB) | @bridge/life |  |  |
| 环境检测 | @byted-poi/envs |  |  |
| 基础图片组件 | 【生活服务FE】监控图片组件 |  |  |

# 体积 Checklist

- [ ] 判断新需求 pv 量级
- [ ] 接入正确 level 的 channel
- [ ] 动态组件接入包体积优化方案
- [ ] 限制接入的 gecko 大小 5m

# 提测 Checklist

- [ ] 完成双端自测
- [ ] 完成埋点自测
- [ ] 联系 UI 进行视觉还原
- [ ] 周知进行代码 CR

# 上线 Checklist

**验收**

- [ ] UI 验收是否完成
- [ ] 埋点验收是否完成
- [ ] 接口监控是否已经完成配置

**依赖**

- [ ] 是否有 Settings 的配置，配置是否上线
- [ ] 是否有 schemaSDK 规则，规则是否上线
- [ ] 与客户端/Server 是否有依赖及上线先后顺序

**发布**

- [ ] 是否需要灰度发布
- [ ] gecko 在线资源是否发布
- [ ] 抖极/抖火是否需要同步发布
- [ ] 线上回归是否完成

# 应急措施

**应急负责人：**

**回滚方案：**

# 附录

{{optional: 放 spec 里的参考文档链接、相关 MR、benchmark 数据等}}
````

- [ ] **Step 2: 校验占位符格式**

```bash
grep -c '{{' ~/.claude/skills/spec-to-techdoc/templates/lifeservice-fe.md
grep -c '}}' ~/.claude/skills/spec-to-techdoc/templates/lifeservice-fe.md
```

Expected: 两数相等。

- [ ] **Step 3: 校验业务元数据字段保留为空**

```bash
# 需求材料表的值列应为空
grep '| 需求 Meego 地址 |' ~/.claude/skills/spec-to-techdoc/templates/lifeservice-fe.md
```

Expected: 输出 `| 需求 Meego 地址 |  |`（两个竖线之间是两个空格，无内容）。

---

## Task 6：编写 `SKILL.md`

Skill 入口文件。包含 frontmatter、使用说明、两步流程（Analysis + TechDoc）、模板决策树、导入步骤、错误处理。

**Files:**
- Create: `~/.claude/skills/spec-to-techdoc/SKILL.md`

- [ ] **Step 1: 写入 SKILL.md**

用 Write 工具创建 `~/.claude/skills/spec-to-techdoc/SKILL.md`，内容如下：

````markdown
---
name: spec-to-techdoc
description: >-
  从一份 spec 文件提炼并生成飞书技术方案文档。按 references/analysis.md 的纪律
  先做关键点拆分/定性/证据/风险分析, 用户审核后再按选定模板(通用 / 生活服务 FE)
  生成 Markdown 并导入飞书. 当用户请求 "把 spec 转成技术文档"、"生成技术方案"、
  "spec to techdoc"、"把设计文档整理成评审用的方案"、"根据 spec 出一份飞书技术方案"
  时使用.
argument-hint: <spec-path> [--template generic|lifeservice] [--agents always|never|auto] [--agent-threshold N]
user-invocable: true
allowed-tools: Read, Grep, Glob, Write, Bash, Agent
---

# Spec → 飞书技术方案 Skill

从一份 spec 文件生成飞书技术方案文档. 产物风格有两档可选: 通用技术方案 (默认) / 生活服务 FE 业务模板.

## 前置条件

- `feishu-cli` 已安装并登录 (运行 `feishu-cli auth status`, 状态应为"已登录"且未过期).
- User Token 至少带 `docx:document:readonly` 和写入相关 scope (`docx:document`).
- 参数 `<spec-path>` 指向仓库内现存的 spec 文件 (通常在 `docs/superpowers/specs/`).

## 参数

```
/spec-to-techdoc <spec-path> [--template generic|lifeservice] [--agents always|never|auto] [--agent-threshold N]
```

- `--template`: 显式指定模板, 跳过推断. 未指定则按关键词推断并询问.
- `--agents`: subagent 策略. `auto` (默认) 按关键点数分流; `always` 总派 subagent; `never` 总由主 session 做.
- `--agent-threshold`: `auto` 模式下的点数阈值, 默认 5.

## 执行流程

两步走, 中间有审核断点. 决不跳过断点直接出文档.

### Step 1: Analysis (对话内产物, 不落盘)

严格按 `references/analysis.md` 的纪律做. 先读 spec, 再按下面的子步骤展开.

#### 1.1 读 spec

```bash
# 确认文件存在
ls -la <spec-path>
```

用 Read 工具读完整个 spec. 如果文件 <500 字符或没有明显结构 (没有标题/列表), 提示用户"这可能不是一份 spec, 确认继续?" 得到确认后才推进.

#### 1.2 关键点拆分 + 双维度定性

完整遵循 `references/analysis.md` 的"关键点"和"改动定性"两节. 产物格式:

```
## 关键点清单

P1. <一句话做什么 + 边界> | 小改 × 代码
P2. <...> | 新增 × 代码
P3. <...> | 零改动 × 配置
...
```

#### 1.3 决定执行模式

读 `--agents` 参数 (默认 `auto`):

- `auto` + 关键点数 ≤ `--agent-threshold` (默认 5): 主 session 继续做 1.4 和 1.5
- `auto` + 关键点数 > 阈值: 对每个关键点派一个 Explore subagent 并行搜证据, 主 session 做 coordinator
- `always`: 总派 subagent
- `never`: 总由主 session 做

派 subagent 时, 每个 subagent 的 prompt 包含:

1. 完整的 spec 原文
2. 本 subagent 负责的关键点 (仅一个)
3. `references/analysis.md` 中"证据要求"和"风险点"两节的原文
4. 硬性要求: 每个结论附 `file:line — 说明` + 置信度; 不跨关键点下结论; 不决定最终范围/归属/风险排序

#### 1.4 证据搜集 + 风险标注

对每个关键点按 `references/analysis.md` 的"证据要求"和"风险点"章节输出. 格式:

```
## P1: <关键点标题>

**证据**:
- `src/foo.ts:123` — 已有 handleX 函数, 新需求可复用 | 高置信
- `src/bar.ts:45-60` — 缺少 Y 类型定义 | 中置信

**风险**:
- 实现风险 / 中 · 调用方未同步
- 回归风险 / 低 · 影响 Z 路径
```

#### 1.5 Coordinator 裁决 (仅 subagent 模式)

按 `references/analysis.md` 的"多 agent 模式补充规则":

- 候选文件去重 (同文件被多点引用 → 标注关联点)
- 置信度向下对齐
- 交叉依赖复核
- 定性冲突 → 按证据强度取更保守定性

#### 1.6 输出覆盖表

```
## 需求覆盖映射

| 需求点 | 对应关键点 | 状态 |
|---|---|---|
| ... | P1 | 已分析 |
| ... | P2 | 待确认 |
```

spec 里的每个原子需求点都必须出现在表里, 不允许静默消失.

#### 1.7 审核断点

打印完上面 1.2~1.6 的所有内容后, 停下来等用户反馈. 明确告诉用户可以这样回复:

```
- "P3 改成小改"      → 修正该点定性
- "P5 证据不够"      → 重新搜该点证据
- "继续" / "ok" / "approve" → 进 Step 2
```

**没有明确"继续"信号前不得进入 Step 2**. 不要猜用户意图.

### Step 2: TechDoc Generation

#### 2.1 选模板

```
用户显式 --template X → 用 X

否则扫 spec 关键词:
  lifeservice 信号词 = [channel, bundle, lynx, webview, gecko, 埋点, slardar, tea, bnpm, byted-poi, meego]

  命中任一 → 询问 "检测到业务关键词: [list]. 拟用 lifeservice-fe 模板, y/n?"
    y → lifeservice
    n → generic

  未命中 → 默认 generic (不问)
```

#### 2.2 读模板 + 填充

根据选定的模板:

```bash
cat ~/.claude/skills/spec-to-techdoc/templates/generic-techdoc.md
# 或
cat ~/.claude/skills/spec-to-techdoc/templates/lifeservice-fe.md
```

按模板里每个 `{{...}}` 占位符的英文指令填空. 来源:

- `from spec.X` → 从 spec 原文对应段落
- `from analysis.X` → 从 Step 1 审核过的 analysis 结果

填完后全文不能有 `{{` 或 `}}` 残留.

lifeservice 模板的业务元数据字段 (Meego 地址、UI 稿、详细排期、Checklist 勾选、应急负责人等) **不要填**, 保留模板预设的空占位.

#### 2.3 遵守写作 + 格式规范

按 `references/techdoc-style.md`:

- 语言三原则 (具体动词 / 术语一致 / 面向任务)
- 结论先行
- Callout 分类使用
- 飞书格式 10 条

#### 2.4 Lint 检查

生成 Markdown 后, 按 `references/techdoc-style.md` 第 8 节跑:

```bash
TS=$(date +%s)
OUT=/tmp/spec-to-techdoc-$TS.md
# 写入产物后:

# 1. 占位符残留
if grep -q '{{\|}}' "$OUT"; then
  echo "FAIL: 占位符未填完"
  grep -n '{{\|}}' "$OUT"
  exit 1
fi

# 2. Mermaid 花括号 (简化版, 只提示)
if grep -qP 'flowchart.*\{[^"]' "$OUT"; then
  echo "WARN: Mermaid flowchart 标签里可能有未加引号的花括号"
fi

# 3. Callout type 合法性
BAD=$(grep -oP '> \[!\w+\]' "$OUT" | grep -vE '\[!(NOTE|WARNING|TIP|CAUTION|IMPORTANT|SUCCESS)\]' || true)
if [ -n "$BAD" ]; then
  echo "FAIL: 非法 Callout type: $BAD"
  exit 1
fi

# 4. 编码
python3 -c "d=open('$OUT','rb').read(); assert b'\xef\xbf\xbd' not in d, 'U+FFFD found'; d.decode('utf-8')" || { echo "FAIL: 编码异常"; exit 1; }
```

Lint 不通过必须先修 Markdown, 再重跑, 直到通过.

### Step 3: 飞书导入

前置检查:

```bash
feishu-cli auth status
```

若过期或未登录, 提示用户 `! feishu-cli auth login` 后中止本次流程.

导入:

```bash
TITLE="<spec 标题>｜技术方案"  # 从 spec H1 提取

feishu-cli doc import "$OUT" --title "$TITLE"
# 记录返回的 document_id
```

权限 + 所有权 (按 feishu-cli-import 的 CRITICAL 要求):

```bash
DOC_ID=<从上一步输出取>
USER_EMAIL=zengchuan.000516@gmail.com  # 从 CLAUDE.md userEmail 字段读

feishu-cli perm add "$DOC_ID" --doc-type docx --member-type email \
  --member-id "$USER_EMAIL" --perm full_access --notification

feishu-cli perm transfer-owner "$DOC_ID" --doc-type docx --member-type email \
  --member-id "$USER_EMAIL" --notification
```

打印最终 URL:

```
✅ 技术方案文档已生成:
   https://bytedance.larkoffice.com/docx/<DOC_ID>
   模板: <generic|lifeservice>
   关键点数: <N>
```

## 错误处理

| 场景 | 处理 |
|---|---|
| spec 文件不存在 | 拒绝执行, 提示用户检查路径 |
| spec <500 字符或无标题 | 提醒并要求确认再继续 |
| Step 1 审核阶段用户不回复 | 停留等待, 不自动推进 |
| Mermaid 命中飞书禁忌 (花括号等) | 先本地 lint 告警; 能机械改写的 (花括号 → 圆括号) 自动改; 改不了的报错让用户决定 |
| `feishu-cli auth` 过期 / 未登录 | 提示 `! feishu-cli auth login`, 中止本次流程 |
| `doc import` 失败 | 保留 `/tmp/` Markdown 路径给用户, 不自动重试; 建议用户排查后用 `feishu-cli-import` 手动重试 |
| 占位符残留 | Lint 阻断, 必须修完再导入 |

## 设计依据

详见 `docs/superpowers/specs/2026-04-20-spec-to-techdoc-design.md` (in the source project repo).
````

- [ ] **Step 2: 校验 frontmatter 完整**

```bash
head -15 ~/.claude/skills/spec-to-techdoc/SKILL.md
```

Expected: 前 15 行包含完整的 YAML frontmatter (从第一行 `---` 到第二个 `---`), 含 `name`, `description`, `argument-hint`, `user-invocable: true`, `allowed-tools`.

- [ ] **Step 3: 校验所有 references / templates 引用都指向存在的文件**

```bash
for f in \
  ~/.claude/skills/spec-to-techdoc/references/analysis.md \
  ~/.claude/skills/spec-to-techdoc/references/techdoc-style.md \
  ~/.claude/skills/spec-to-techdoc/templates/generic-techdoc.md \
  ~/.claude/skills/spec-to-techdoc/templates/lifeservice-fe.md; do
  [ -f "$f" ] && echo "OK: $f" || echo "MISSING: $f"
done
```

Expected: 4 行全是 `OK:`.

---

## Task 7：创建冒烟测试 fixture

一份精简 spec, 用于后续手动冒烟验证 skill 跑通全链路.

**Files:**
- Create: `docs/superpowers/fixtures/spec-to-techdoc-smoke-spec.md`

- [ ] **Step 1: 创建 fixtures 目录并写入样本 spec**

```bash
mkdir -p /Users/bytedance/workspace/vwap_daytrade/docs/superpowers/fixtures
```

用 Write 工具创建 `/Users/bytedance/workspace/vwap_daytrade/docs/superpowers/fixtures/spec-to-techdoc-smoke-spec.md`:

```markdown
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
```

- [ ] **Step 2: 确认文件存在**

```bash
ls -la /Users/bytedance/workspace/vwap_daytrade/docs/superpowers/fixtures/spec-to-techdoc-smoke-spec.md
```

Expected: 文件存在, 大小 > 0.

- [ ] **Step 3: Commit fixture**

```bash
cd /Users/bytedance/workspace/vwap_daytrade
git add docs/superpowers/fixtures/spec-to-techdoc-smoke-spec.md
git commit -m "$(cat <<'EOF'
test(spec-to-techdoc): add smoke spec fixture

用于 spec-to-techdoc skill 冒烟验证: 3 个关键点 (刚好在 ≤5 主 session 阈值内),
覆盖方案权衡和四类风险里的实现/回归两类.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8：冒烟验证全链路

不写代码, 只做一次人工驱动的端到端调用, 确认 skill 可加载且按预期工作.

**Files:**
- 无新建; 本 task 只运行和检查

- [ ] **Step 1: 验证 skill 文件结构**

```bash
find ~/.claude/skills/spec-to-techdoc -type f | sort
```

Expected: 输出恰好 5 行:

```
/Users/bytedance/.claude/skills/spec-to-techdoc/SKILL.md
/Users/bytedance/.claude/skills/spec-to-techdoc/references/analysis.md
/Users/bytedance/.claude/skills/spec-to-techdoc/references/techdoc-style.md
/Users/bytedance/.claude/skills/spec-to-techdoc/templates/generic-techdoc.md
/Users/bytedance/.claude/skills/spec-to-techdoc/templates/lifeservice-fe.md
```

- [ ] **Step 2: 验证 frontmatter 可被解析**

```bash
python3 -c "
import re
with open('/Users/bytedance/.claude/skills/spec-to-techdoc/SKILL.md') as f:
    content = f.read()
m = re.match(r'^---\n(.*?)\n---\n', content, re.DOTALL)
assert m, 'frontmatter 缺失'
fm = m.group(1)
for key in ['name:', 'description:', 'user-invocable:', 'allowed-tools:']:
    assert key in fm, f'frontmatter 缺少 {key}'
print('OK: frontmatter 完整')
"
```

Expected: 输出 `OK: frontmatter 完整`.

- [ ] **Step 3: 冒烟调用**

在一个新 Claude Code 会话 (或本会话) 里, 运行:

```
/spec-to-techdoc docs/superpowers/fixtures/spec-to-techdoc-smoke-spec.md
```

Skill 应该:

1. 加载并宣告使用 spec-to-techdoc skill
2. 读 fixture spec
3. 产出 3 个关键点 + 双维度定性 + 证据 (对 fixture 里提到的 `src/backtest/runner.ts` 实际 grep 验证) + 风险 + 覆盖表
4. 停下来等用户审核
5. 用户输入 "继续" 后, 按默认 generic 模板生成 Markdown
6. Lint 通过
7. 询问 feishu-cli auth status 后导入飞书, 返回文档 URL

整个过程不应该有占位符残留 / Callout 非法 / 编码异常.

- [ ] **Step 4: 飞书产物抽查**

打开 Step 3 返回的飞书文档 URL, 人工检查:

- 摘要与核心结论四要素齐全
- 详细设计按 3 个关键点展开
- 方案权衡表格有三行对比
- 风险只保留"实现风险"和"回归风险"两类 (fixture 里其他两类是空的, 模板里应已删除空类别)
- 全文无 `{{` `}}`

若以上任一项不符合, 回到对应 Task 修正相关文件.

- [ ] **Step 5: 更新 plan 完成状态**

手动把本 plan 里所有 checkbox 勾上; 或在 commit message 里注明"冒烟通过".

```bash
cd /Users/bytedance/workspace/vwap_daytrade
git log --oneline | head -5
```

Expected: 能看到 Task 7 的 fixture commit 和 spec design commit.

---

## Self-Review

本 plan 写完后, 对照 spec 过一遍:

**Spec 覆盖**: 每个 spec 章节都有对应 task:
- 背景与目标 → Task 1-8 整体目标
- 方案总览 → Task 6 SKILL.md 流程对齐
- Skill 文件结构 → Task 1-7 逐个创建
- Step 1 Analysis → Task 6 SKILL.md 1.1-1.7
- Step 2 TechDoc → Task 6 SKILL.md 2.1-2.4 + Task 4/5 模板
- Step 3 飞书导入 → Task 6 SKILL.md Step 3
- 错误处理 → Task 6 SKILL.md 错误处理表
- 通用 + 生活服务 FE 两份模板 → Task 4 + Task 5
- 模板决策树含业务信号词枚举 → Task 6 2.1
- 业务模板保留空占位 → Task 5 设计意图 + Task 8 Step 4 抽查
- `--agents` / `--template` / `--agent-threshold` 参数 → Task 6 frontmatter + 流程
- 飞书 lint 规则 → Task 3 techdoc-style.md + Task 6 2.4
- 冒烟测试 → Task 7 + 8

**占位符扫描**: plan 中没有 "TBD" / "TODO" / "fill in details"; 每个代码步骤都给出完整代码或完整命令; 没有出现"similar to Task N". Mermaid 规则表里没有凑数的占位.

**类型一致**: `--template generic|lifeservice` 和 `--agents always|never|auto` 在 SKILL.md frontmatter、流程 2.1、错误处理表中用词一致; 文件名 `generic-techdoc.md` / `lifeservice-fe.md` 在 Task 4/5/6/8 里保持一致.

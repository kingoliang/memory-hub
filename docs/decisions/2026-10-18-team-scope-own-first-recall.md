# 决策：团队记忆与「先自己、后团队」的分层检索

日期：2026-10-18 · 状态：已采纳 · 影响：DB schema v3、令牌、检索、MCP 工具、管理界面

## 背景

上游 memory-hub 是**单人单库**模型：所有卡平铺在一张 `cards` 表里，`submitted_by` 只用于
展示署名，**不参与可见性也不参与排序**。要把它变成团队服务，缺三样东西：

1. 库里没有"这张卡属于谁 / 属于哪个团队"的一等字段；
2. 检索没有可见性边界 —— 别人私有卡也会被召回；
3. 用户明确要求：**优先搜自己的记忆，然后再搜团队其它人的记忆**。

## 决策

### 1. 身份三元组与卡片的归属字段

- 令牌（`agent_tokens`）新增 `owner`（人）、`team`（团队命名空间）、`default_visibility`。
- 卡片与隔离卡新增 `owner`、`team`、`visibility ∈ {private, team, public}`。
- 调用者身份 = **令牌决定，不由请求参数决定**（沿用上游"署名不依赖 clientInfo"的原则）。

`owner` 是"人"，不是"进程"：同一个人的多个 agent（claude / codex / pi）互相看得见彼此的
私卡，因为它们共享 `owner`。

### 2. 可见性与层级（tier）

可见性判定（`src/core/scope.js`），顺序敏感：

| 条件 | 结果 tier |
|---|---|
| `card.owner === viewer.owner` | `self`（本人可见，无视 visibility） |
| `visibility === 'private'` 且非本人 | `null`（不可见） |
| `card.team === viewer.team` | `team` |
| `visibility === 'public'` | `public` |
| 其它 | `null` |

**注意**：private + 同团队他人 → 不可见（不是降级为 team）。这是刻意的：private 表示
"只给我自己"。

### 3. 检索排序 = tier 优先，其次才是相关度

排序键：`tierRank(self=0 < team=1 < public=2)` 升序 → `score` 降序 → `mtime` 降序。

**tier 在 score 之前**，所以一条弱命中的自己的卡会排在强命中的团队卡前面。这正是
"先搜自己的，再搜别人的"的机械实现。`scope` 参数控制纳入哪些 tier：

| `scope` | 纳入 |
|---|---|
| `mine` | self |
| `team` | self, team |
| `auto`（默认） | self, team, public |

`auto` 不是"混合打分"，而是"分层填充"：严格按 tier 出结果。

### 4. 向后兼容

- schema v3 迁移：`ALTER TABLE ... ADD COLUMN`，老行 `owner` 回填为 `submitted_by`，
  `team` 默认 `'default'`，`visibility` 默认 `'team'`。老库升级后行为 = 全员同一 team，
  可见性等价于今天（人人可见）。
- 无令牌主体（stdio 无 `MEMORY_HUB_OWNER`）→ `owner=''`，此时 `visibility` 过滤被跳过
  （`owner=''` 视为"本地单机模式"，保持上游语义，不因缺配置而突然看不到卡）。
- `migrate.js` 的指纹用显式列（`path|kind|title|tags|body|status`），新增列不影响对账。

### 5. 为什么不用 tags 编码归属

`tags` 是可被 LLM 改写的内容字段；归属是权限语义，改错 tag 会导致越权可见。故用独立列。

## 影响

- `search()` 增加 `{ viewer, scope }`，默认 `auto` 且 viewer 来自身份。
- `memory_recall` 增加 `scope` 入参，输出按 tier 分组标注 `[自己的]` / `[团队·owner]` / `[公开]`。
- 新增 `memory_whoami` 工具，让 agent 能自查 owner/team/可见范围。
- 管理界面：卡列表显示 owner/team/visibility，令牌表单增加三个字段。

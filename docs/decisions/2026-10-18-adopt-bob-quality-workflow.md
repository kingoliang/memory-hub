# 决策：本项目采用 Bob 质量修复工作流（estate-wide 规程）

日期：2026-10-18 · 状态：已采纳 · 来源：`~/.claude/bob-workflow/decisions/bob-workflow-estate-wide.md`

## 背景

用户要求："这个项目也要使用这个 bob 工作流的方法。"

Bob 工作流是 2026-09-03→09-28 在 loganalysis / mr-quality-gate 上实修出来的一套
**代码质量修复操作规程**（`docs/QUALITY_FIX_PLAYBOOK.zh.md`，v3），并在 2026-09-28
定为 **estate-wide**：一个 playbook + 每个仓库根一份 `CLAUDE.md`，全部项目同法。

## 决策

### 1. 落地三件套

1. `docs/QUALITY_FIX_PLAYBOOK.zh.md` —— 规程全文（v3，原样引入，含实测数据）。
2. `.claude/CLAUDE.md`（仓库根 `CLAUDE.md`）—— 每个 agent 会话开局自动加载的硬约束，
   含 playbook 的三条禁令。
3. `scripts/quality/*.mjs` + `package.json` scripts —— 让规程变成**退出码**：
   `npm run gate` / `mutate` / `complexity` / `deadcode` / `cycles`。

### 2. 三条禁令（写进 `CLAUDE.md`）

- 不许为降 CCN 删守卫代码。
- 不许靠删代码提升变异得分（删前必须走"三项全空"核实程序）。
- 不许下调阈值让构建变绿。

### 3. 阈值是棘轮，不是理想值

`scripts/quality/gate.mjs` 的阈值设在**今日实测值下方**：今天的代码能过，任何回退会失败。
覆盖率分母**按 `git ls-files` 重算**（工具只统计被加载过的文件，未加载的模块不是 0%
而是根本不出现，会虚报约一倍）。

### 4. 修 bug 的动作次序（TDD + 字面量断言）

1. 先写**字面量**期望值的失败测试，确认它在旧代码上确实失败。
2. 最小改动让它通过。
3. 跑变异测试：存活的变异体要么补测试，要么证明确是等价变异体。
4. 期望值**不许从被测模块推导**（镜像测试），断言用**整值**而非子串。
5. 变异测试跑在**副本 / worktree** 上，每个变异体后断言源文件已还原，判定跑两次一致。
6. 覆盖三类变异测试看不见的问题：错误/超时/清理路径、真实依赖的集成测试、
   常驻进程"连续调用 N 次后资源回基线"。

### 5. 决策记录先行

任何非平凡改动先在 `docs/decisions/` 落一份决策记录（本目录），再动代码。

## 影响

- 新增 `CLAUDE.md`、`docs/QUALITY_FIX_PLAYBOOK.zh.md`、`docs/decisions/`、`scripts/quality/`。
- `package.json` 增 `gate` / `mutate` / `complexity` / `deadcode` / `cycles` / `verify`。
- 本项目的团队记忆与经验闸门两个特性**按此规程实现**：先决策记录 → 先写测试（字面量）
  → 再实现 → 变异验证。

## 与上游的关系

上游 memory-hub 已有 368 个测试但**没有覆盖率/变异门禁**，也没有决策目录。
本项目补上门禁，且把三个新模块（`scope.js` / `gate.js` / `migrate` 增量）作为
变异测试的**重点靶区**——它们是权限与准入语义，变异体存活 = 无保护。

# memoryhub · 本仓库的硬规则

上游是 memory-hub（memory-eternal 衍生）。本仓库把它做成**团队记忆 MCP 服务**：
多团队、每团队多人，检索**先自己 → 再本团队 → 最后其它团队的公开卡**；并且只让
「提炼过的、经验性质」的内容入库（日常操作走闸门丢掉）。

操作规程全文见 [`docs/QUALITY_FIX_PLAYBOOK.zh.md`](docs/QUALITY_FIX_PLAYBOOK.zh.md)（v3，estate-wide）。
本文件是每个会话开局必读的那一层：**只放约束，不放教程**。

---

## 三条禁令（来自 playbook §6）

1. **不许为降 CCN 删守卫代码。**
   `if`/`catch` 都是分支；某函数 CCN 高往往是因为它在容错。删掉 catch 让指标好看，代码更脆。
   判断标准是**行为等价性 + 变异得分不降**，不是 CCN 降了多少。

2. **不许靠删代码提升变异得分。**
   删掉功能连同它的测试，得分照样上升。删任何东西之前先走"三项全空"核实程序
   （全仓 grep 含定义文件 / HTML 引用 / package.json 与 .bin 调用），见 playbook 坑一、陷阱二。

3. **不许下调阈值让构建变绿。**
   阈值是**棘轮**，设在今日实测值下方：今天的代码能过，任何回退会失败。改阈值要在
   `scripts/quality/thresholds.json` 里写一行理由。

## 验证纪律

- **先写测试，见红，再实现。** 期望值必须是**字面量**，不许从被测模块推导（镜像测试，坑七）。
- 断言用**整值**（`deepEqual` / `equal`），不用子串 `includes` / `match` 兜（坑八）。
- **验收用变异得分，不是覆盖率。** 覆盖率只用来找"哪些文件根本没人碰"。
- 变异测试跑在**副本**上，每个变异体后断言源文件已还原，判定不一致就重跑（playbook §7）。
- 变异测试看不见的三类问题要单独补：错误/超时/清理路径、真实依赖的集成测试、
  常驻进程连续调用后资源回基线（playbook §8）。
- **改完必须跑全量回归** `npm test`；不许只跑"相关的那几个文件"就收工。

## 决策记录先行

非平凡改动先在 `docs/decisions/` 落一份记录（背景 / 决策 / 影响 / 反面选项），再动代码。
已经落地的见该目录；`docs/import-20261018-legacy-vault.md` 是旧库导入的对账证据。

## 本仓库的具体约定

- **单一事实来源**：可见性与分层只在 `src/core/scope.js`；闸门只在 `src/core/gate.js`。
  别在别处再写一遍 `visibility` 判断或经验正则。
- **归属由令牌决定**，不由请求参数决定（`auth/tokens.js` → `server.js`/`transport/stdio.js` 的 identity）。
- 新增卡片字段要同时照顾：`parseCard` / `rowToCard` / `rowToMarkdown` / `multiStoreQuery` /
  两张表的 INSERT（含 `migrateToQuarantine` 与 `moveCardBetweenStores` 的列清单）。
- schema 变更走 `PRAGMA user_version` 增量迁移，**只加列不重写行**；`migrate.js` 的指纹用显式列，
  加列不影响对账。
- 老库升级后 `owner` 由 `submitted_by` 回填、`team` 默认 `default`、`visibility` 默认 `team`
  —— 升级前后可见性语义必须完全一致。
- 提交信息用 `feat:` / `fix:` / `refactor:` / `perf:` / `test:` / `docs:` / `chore:`；
  密钥不入库、不入日志。
- 默认 home 是 `~/.memory-hub`，数据库文件名沿用 `memory-eternal.db`（零迁移成本）。

## 常用命令

```bash
npm test                  # 全量回归（node:test）
npm run gate              # 覆盖率（分母按 git ls-files 重算）+ 死代码 + 依赖环
npm run complexity        # 复杂度，只报告，永不失败
npm run mutate            # 变异测试靶区（scope.js / gate.js / db 迁移增量）
npm run verify            # gate + test 一把过
```

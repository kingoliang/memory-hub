# memory-hub 决策与 spike 记录（M1、M3）

日期：2026-10-15。依据：`PLAN.md` 第 3、4、6、7、9 节 + 用户补充决策。

## 1. MCP SDK spike 结论（PLAN 3.1「未确认项」）

**结论：采用 v2，不回退 v1。** 版本（npm registry 2026-10-15 实查，已 `--save-exact` 锁定，见 `package-lock.json`）：

| 包 | 版本 | 用途 |
|---|---|---|
| `@modelcontextprotocol/server` | 2.3.1 | `McpServer`、`createMcpHandler`、`serveStdio`（运行时） |
| `@modelcontextprotocol/node` | 2.1.1 | `toNodeHandler`（运行时） |
| `zod` | 4.6.7 | 工具入参校验（运行时；v2 SDK 自带依赖 `zod ^4.2.0`） |
| `@modelcontextprotocol/client` | 2.3.1 | 仅测试（v2 客户端，含 stdio） |
| `@modelcontextprotocol/sdk` | 1.32.1 | 仅测试（v1 客户端，验证 2025 年代兼容） |

PLAN 列的四个未确认项，逐项结果（证据：`tests/e2e/mcp-both-eras.mjs` 的真实运行，以及 spike 脚本输出）：

1. **客户端实际说哪一代协议** —— **仍未确认真实产品**。Claude Code / Codex CLI / DSH 没有在本任务中实连。已验证的是：同一个 `POST /mcp`（`createMcpHandler` 默认 `legacy:'stateless'`）同时被三种 SDK 客户端接受——v2 客户端 `versionNegotiation:{mode:'auto'}`（走 2026-07-28 `server/discover`，服务端工厂 `era=modern`）、v2 客户端默认（走 `initialize`，`era=legacy`，协商到 2025-11-25）、v1 1.32.1 客户端（`initialize`）。三者都完成 `tools/list` + `memory_recall`。
2. **`@modelcontextprotocol/node` 版本** —— 2.1.1（registry 查得）。
3. **工具注册 API / inputSchema** —— `McpServer.registerTool(name, { description, inputSchema: z.object(...) }, handler)`，zod 校验失败返回 `isError:true` 的结果（文本 `Input validation error: ...`）。`tools/list` 产出的 JSON Schema 的 `required`/`properties` 与 v0.10.8 基线一致（`tests/http-auth.test.mjs` 基线兼容用例）。**没有**测试"直接喂 JSON Schema 对象"的形式，因为我们统一用 zod。
4. **`instructions` 与署名** —— `new McpServer(info, { instructions })` 设置；legacy `initialize` 结果与 modern `server/discover` 结果都带出该字段（v1 与 v2 客户端 `getInstructions()` 均读到）。**各客户端是否把它注入模型上下文仍未确认。** 署名不依赖 `clientInfo`：HTTP 用令牌名（工厂拿 `ctx.authInfo`，`handler` 不验令牌，由 `src/server.js` 先验后经 `req.auth` 透传）。

其它 spike 发现：
- `toNodeHandler` 的 `(req, res, parsedBody)` 接受预解析 body，所以我们先读 body、做 scope 预检（`tools/call` 的工具名），再交给 SDK。
- 无状态：每个 HTTP 请求调用一次工厂，`tools/list` 因此天然按调用者 scope 过滤。
- v2 `serveStdio(factory, { legacy:'serve' })` 默认即可服务 2025 年代客户端。
- 客户端 v2 默认模式在 initialize 后会 `GET /mcp` 试开通知流；服务端交给 SDK 处理（无状态，不提供流），客户端容忍。

## 2. 用户已拍板、本实现采用的默认值

- 部署目标 58（本任务不部署）；沉淀只靠 MCP `memory_capture`，不做 hook；DSH 可作为 MCP 客户端（HTTP + 令牌是主路径，**DSH 是否真能外接 MCP 仍未验证**）。
- 蒸馏 LLM：通用 OpenAI 兼容端点 `MEMORY_LLM_BASE_URL / MEMORY_LLM_MODEL / MEMORY_LLM_KEY`；代码里无任何默认地址/模型/密钥；未配置降级为原文卡。生产配置说明见 `docs/deployment-config.md`。
- 异机备份不做；本机备份用 sqlite backup API（Node < 22.16 回退 `VACUUM INTO`）。
- `secret-guard.mjs` 迁移不管。
- PLAN 9.1 推荐默认：`exposeTidyApply=false`、`auditMode=all`（DB `config` 表无记录即待审）、令牌署名只认令牌名、监听 127.0.0.1、Node 24 / 兼容 22、`node:sqlite`、运行时仅 SDK + zod。

## 3. 与 PLAN 不一致或需要注意之处

- **基线工具数**：PLAN 第 7 节写"`mcp-tools-baseline-v0.10.8.json` 的 8 个工具"，实际 fixture 只有 **4 个**（recall / capture / stats / audit_list），另 4 个整理工具来自 fork。测试按 4 + 4 实现。
- **最低 Node 版本是 22.16**（不是 22.0）：整理批次用到 `DatabaseSync.isTransaction`，备份用 `sqlite.backup`。Node 22.14 实测 6 个用例失败；22.16 / 22.22 / 24.14 全绿。
- **`node --test tests/`（PLAN 验收命令）在 Node 22 上不可用**（目录参数被当成模块路径）。改用 `npm test`（glob：`node --test --test-concurrency=1 "tests/**/*.test.mjs"`）。
- `synchronous=NORMAL`（PLAN 标"需评审后定"）：已采用，WAL 下断电最多丢最近几次提交、不会损坏库。待评审确认。
- **`memory_stats` 返回 `vaultDir`（服务器数据目录绝对路径）**：为与上游输出逐字一致而保留；远程 Agent 因此能看到服务器路径。建议后续去掉或换成相对名（需要你确认，因为会改变输出）。
- 令牌名受 `UNIQUE` 约束（schema 约定），**已撤销的令牌名不能复用**；换发请用新名字。
- 认证失败限流按来源 IP：nginx 反代后所有请求来自 127.0.0.1，需设 `MEMORY_HUB_TRUST_PROXY=1` 才按 `X-Forwarded-For` 区分，否则一个客户端打错 10 次会让同机反代下的所有客户端 60 秒内 429。

## 4. 对上游代码做的实质改动（相对 fork HEAD 57c4384）

- `db.js`：`busy_timeout=5000`（PRAGMA，先于 WAL 设置）、`synchronous=NORMAL`；`nextCardId` 改单语句 `UPDATE … RETURNING`（原为 UPDATE + SELECT 两条，多进程会撞号）；`user_version` 0→1 迁移追加 `agent_tokens / write_log / card_revisions / admin_sessions`（旧 7 张表一列不改，测试逐列对比旧实现）；删除 `migrateFromMarkdown`（切断与 vault.js 的循环依赖）；`backupDb` 改 backup API + 副本 integrity_check + 0600；DB 文件 0600。
- `vault.js`：写事务统一 `BEGIN IMMEDIATE`；`writeCard`（选 path + 发号 + 插入）、`appendUpdate`、`mergeIntoCard` 放进同一写事务；删除 graph/图谱缓存/多库/optimize/导出。**修复上游缺陷**：`search()` 在存在 feedback 记录且查询与反馈词互不包含时，`queryTerms(...).some(...)` 因 `queryTerms` 返回 `Set` 抛 `TypeError`（线上 feedback=0，潜伏；旧实现在测试中被复现）。
- `capture.js`：删除 DSH 会话事件解析与 `compressExcerpt`；不再尝试 import `@deepseek-ai/dsh-llm`。
- `capture-run.js`：重写——`submittedBy` 由调用方传入（令牌名），`source` 只是标签；审核状态只由 DB `config` 表 + `submittedBy` 决定（不再读 DSH 共享配置文件或 `MEMORY_AUDIT_*` 环境变量）；新增疑似明文密钥拒绝写入（只报类型）；LLM 由调用方注入。
- `llm-openai.js`：只认 `MEMORY_LLM_*`，**去掉对 `OPENAI_BASE_URL / OPENAI_API_KEY` 的回退**（避免把无关 key 发到不相干端点）。
- `dedup-config.js`：不再读 `$DSH_HOME/memory-eternal-config.json`。删除 `vault-resolve.js`（vaultProfiles 按 PLAN 9.1 #8 删除）。

### 测试迁移
- `tests/core/` 来自上游，仅改 import 路径后入库（基线提交），随后删除依赖已移除功能的用例：图谱/导出/多库聚合/optimize、DSH 会话事件解析、DSH LLM 层 finish 块语义（2 个：适配器错误暴露为 failure、max-tokens；OpenAI 兼容适配器没有这套 finish 块，`finish_reason=length` 映射不在 M1）、`vault-path.test.mjs`（defaultVaultDir 已删）。
- 审核相关用例由环境变量 `MEMORY_AUDIT_MODE` 改为 `setAuditConfig(root,{auditMode})`（DB `config` 表）。
- **R13 已定位**：`vault.test` 的"标题排序跨页全局有序"失败不是产品缺陷，而是用例用了依赖进程 locale 的 `localeCompare`，与实现固定的 `zh-Hans-CN` 拼音序不一致；改用同一个 `TITLE_COLLATOR` 比较。
- `tests/fixtures/legacy/{db,vault,minhash}.js` 是上游旧实现的逐字副本，仅用于"旧实现必败 / 新旧输出一致"的对照测试。

## 5. 真实库验证（只读）
用 58 上 10-15 03:07 的每日备份快照（只读 scp 到本机临时目录，验证后已删除；未把任何卡片内容写入仓库/日志）：新代码打开后 `user_version` 0→1、`integrity_check=ok`、`cards=578 / quarantine=284 / card_sequence.seq=1853`（与快照一致）；38 条查询（30 条取自标题前缀 + 8 条手写，含 2 字中文、英文、无结果）旧/新 `search()` 的 `(path, score)` 序列逐位相同；`tidyPlan` / `tidyLint` 可运行。


---

# M3 决策与实测记录（2026-10-15）

## M3-1 用户已拍板（本里程碑的前提）
- **沉淀只靠 Agent 主动调用 MCP `memory_capture`，不做任何宿主 hook。** Mac 上现有的会话结束 hook 由用户在切换时自己移除；本项目不读取、不修改 `~/.claude/settings.json` 或任何用户全局配置。
- **`tidy apply` 默认不暴露给 Agent**（`exposeTidyApply=false`），只在管理界面/CLI 可用。M3 的管理界面 apply 走独立的 `POST /admin/api/tidy/apply`，与 MCP 开关无关。
- **蒸馏模型沿用 DeepSeek**，部署阶段配置（`docs/deployment-config.md`）；M3 不读不写任何 key。

## M3-2 与 PLAN / 原任务的差异或新增（需要你知道的）
- **schema v2**：`agent_tokens` 去掉整列 UNIQUE，改"仅未撤销令牌名唯一"，使已撤销令牌的名字可复用（原任务允许"风险可控就做迁移"）。迁移、兼容与回滚见 `docs/m3-admin.md`。风险评估：迁移在单事务内、旧代码仍可打开、令牌数据逐列拷贝并有测试；残留风险是复用名字后新旧令牌写的卡共用署名。
- **新增 `MEMORY_HUB_ADMIN_READONLY` 开关**（原任务没有）：为"真实数据快照环境"防误点而加，默认关闭。
- **"设置页"未做**（PLAN 5 节有，原任务 M3 范围没列）。
- 管理接口新增 `POST /card/purge`（永久删除，要输入标题）——PLAN 5 节"软删/恢复/回收站"页的一部分，原任务清单未单列。后续新增 `POST /cards/purge`（回收站「立即删除」：按 paths 或 all+confirm，只作用于回收站内的卡，复用同一物理删除逻辑；确认靠界面二次确认框 + confirm 字段，不要求输入标题）。
- 整理回滚文件使用后改名 `.done`，只能用一次（避免用旧快照覆盖之后的新编辑）。
- 先写红测试再实现：M3 写接口与修复项 a-d 的测试在 `13190bb` 提交时对旧代码失败；**只读保护开关与前端新增的静态检查是实现后补的测试**，不是红测试先行。

## M3-3 真实客户端实测：401 / OAuth 发现（`claude -p` 2.1.295，共 6 次调用，已用完）
环境：scratch 临时项目目录、`--mcp-config`（无 headers 的 HTTP 服务）+ `--strict-mcp-config`、临时数据目录、非默认端口（旧代码 7993 / 新代码 7994）、未改任何全局 Claude 配置。旧代码 = M2 提交 `454a181` 的 worktree。

| | 旧代码（M2） | 新代码（M3） |
|---|---|---|
| 无令牌 401 的响应体 | `{"error":"unauthorized"}`（24 字节，**已带** `WWW-Authenticate: Bearer realm="memory-hub"`） | `{"error":"unauthorized","message":"需要 Bearer 令牌：…"}` + 同样的头 |
| `claude -p` 的 MCP 状态（stream-json init） | `memhub: failed` | `memhub: failed`（相同） |
| 客户端报错（`--debug mcp` 日志） | `Dynamic Client Registration rejected (HTTP 404): {"error":"not found"}` | **同样走 OAuth 动态注册**，实测报错仍是 `Dynamic Client Registration rejected (HTTP 404): {"error":"not found"}`（调用 6 次已用完，**之后加的"OAuth 探测路径 404 带原因说明"没有再用真实 claude 复测**；因为客户端会把响应体原样带进报错，预期报错会带上"本服务不支持 OAuth…请用静态 Bearer 令牌"，但这是推断，不是实测） |
| 每次连接的无令牌请求数 | 2（服务日志 7 条"鉴权失败" = 3 次 claude + 1 次 curl 的 POST，每次 claude 连接 2 条） | 2（日志 7 条"已质询"），**全部不计入失败限流**，0 条"鉴权失败" |

结论：
- `WWW-Authenticate: Bearer realm=…` **无法改善** Claude Code 的行为：这个版本在 401 后无论如何都先做 OAuth 受保护资源发现，回落到把服务器自身当授权服务器并 `POST /register`，所以看到的仍是"Dynamic Client Registration rejected (HTTP 404)"。**没有为此实现 OAuth。** 实际可用的做法是在客户端配置里直接给 `Authorization: Bearer <令牌>` 头（带令牌时不走 OAuth）。
- 确认了问题 b 的根因：一次连接 = 2 个无令牌请求（先探测版本协商、再按 legacy 重连），旧限流把它们都算失败。

## M3-4 其它
- 真实数据快照上的完整 plan→dry-run→apply→rollback（在临时副本上）：`IDENTICAL`，见 `tests/e2e/tidy-roundtrip-on-copy.mjs`；用户查看的 `~/memory-hub-dev` 数据在只读保护下，写请求被 403，指纹不变。

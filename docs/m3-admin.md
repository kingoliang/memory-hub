# M3 管理界面写操作 + 整理

日期：2026-10-15。范围以 PLAN.md 第 5、7 节为准。M1 的 MCP 行为不变；M2 的只读接口不变（仅 cardDetail 的修订多带 `id`，上限 20→50 条）。

## 通用约束
- 所有写接口：必须有登录会话（无会话 401）+ `X-CSRF-Token`（缺失/错误 403 `csrf`）+ 同源 Origin（跨源 403 `forbidden_origin`）；请求体只收 `application/json`（415）、上限 2MB（413）；错误一律 `{error, message, ...附加字段}`。
- 每次写入都写 `write_log`：`actor_type=admin`、`actor_id=session:<会话哈希前 12 位>`（能区分是哪个管理员会话）、`actor_name=admin`、`tool=<HTTP 方法 路径>`、`action=…`；只存参数摘要，不存口令/令牌/正文。待审批准/驳回、软删/恢复同时写既有的 `audit_log`（`changed_by=admin`）。
- 以 `path` 为键。卡片的并发保护用乐观锁：客户端带详情里的 `updatedAt`，服务端在写事务（`BEGIN IMMEDIATE`）里再比对，不一致 409（Agent 在你编辑期间追加了内容也会冲突，不会丢更新）。
- 批量操作：单次上限 `MEMORY_HUB_ADMIN_MAX_BATCH`（默认 50，1~1000），超限整批 400 `batch_too_large`；多条必须 `confirm:true`（否则 400 `confirm_required` 并告知影响条数）；不满足条件的项被跳过并逐条列出；`dryRun:true` 只预演。
- 响应里不出现服务器绝对路径（备份/回滚文件只给文件名）。
- 只读保护：`MEMORY_HUB_ADMIN_READONLY=1` 时所有写接口（登出除外）返回 403 `read_only`，`/session.readOnly=true`，界面标记显示"只读模式"。本机真实数据快照环境默认开启（见 `docs/dev-with-real-data.md`）。**这是本里程碑额外加的保护开关，不在原任务清单里。**

## 新增 API（`/admin/api/*`）

| 方法 路径 | 说明 |
|---|---|
| `PATCH /card` | `{path, expectedUpdatedAt, title?, body?, tags?, kind?}`。旧版本进 `card_revisions`；改 `kind` 同步路径前缀（`02-Projects/…`→`03-Knowledge/…`，重名加 `-2`），修订与反馈跟随新路径并写一条 `audit_log`；返回新 `path/updatedAt/changed`。校验：标题 ≤200、正文 ≤200000、标签 ≤30 个且每个 ≤50 字、kind 枚举；正文含界面的"已遮蔽"标记（卡含疑似密钥时详情显示的是遮蔽文本）→ 拒绝，避免把标记写进库。 |
| `POST /card/rollback` | `{path, revisionId, expectedUpdatedAt}`：回滚到某个历史版本；回滚本身也是一次编辑（会留下被回滚前的版本，可再回滚）。 |
| `DELETE /card?path=` | 软删（进回收站，30 天可恢复；`softDeleteCardSync`，与 `deleteCard` 同语义）。 |
| `POST /card/restore` | `{path}`，仅回收站里的卡。 |
| `POST /card/purge` | `{path, confirmTitle}`：永久删除，仅回收站里的卡，须原样输入标题；同时清理其修订。 |
| `POST /cards/purge` | 回收站「立即删除」（跳过 30 天保留期）：`{paths[], confirm:true}` 或 `{all:true, confirm:true}`（清空回收站）；`dryRun?`。**只删回收站里的卡**，非回收站 / 不存在的逐条进 `skipped`（`reason`: `not_in_recycle` / `not_found`，不删）；`paths` 受 `MEMORY_HUB_ADMIN_MAX_BATCH` 限制，`all` 由服务端取回收站全部卡不受限；缺 `confirm` → 400 `confirm_required`，`paths` 与 `all` 互斥；单事务物理删除（复用 `purgeCardSync`：更新记录/反馈/修订一并清除），每张卡写一条 `write_log`（action=purge，不含正文）。返回 `{affected, skipped, paths}`。 |
| `POST /graph/search` | 图谱蜘蛛搜索（**不改库**，只读模式下可用；仍需会话 + CSRF）：`{q, limit?}` → `{hits:[{path,title,kind,tags,snippet,score,rank}], limit, ms}`。详见 [m4-graph.md](m4-graph.md)。 |
| `POST /graph/summarize` | 图谱 AI 汇总：`{q, paths[≤20]}`，服务端按 path 自读主库正文 → `{summary, points:[{text,refs[path]}], used, skipped, truncated, ms}`；LLM 未配置 503 / 超时 504 / 失败 502。详见 [m4-graph.md](m4-graph.md)。 |
| `POST /cards/batch` | `{action:'delete'\|'restore', paths[], confirm, dryRun?}` |
| `POST /queue/approve` / `POST /queue/reject` | `{paths[], reason?, confirm?, dryRun?}`；单条无需 confirm，多条需要。批准：进 `cards`、可被 recall；驳回：留隔离区并记 `reason`；已驳回的卡可再批准。 |
| `GET /tags/preview?op=rename\|merge\|delete&from=&to=` | 影响卡数（含待审/回收站里的卡）+ 样例路径，不改数据。 |
| `POST /tags/rename` / `merge` / `delete` | `{from,to}` / `{from:[…],to}` / `{tag}` + `confirm:true`（+ 可选 `expectedAffected`，与实际不符 409）。执行前 `VACUUM INTO` 备份并校验 → 单事务改标签 → 自检（沿用 tidy 的 selfCheck + 隔离区 tags 合法性 + 总数不变）→ 失败整批回滚（500 `self_check_failed`）；成功返回备份文件名与回滚文件名（`tags-*.rollback.json`）。 |
| `POST /tidy/apply` | `{planId, confirm, batches?, maxDelete?, threshold?}`。默认 dry-run；`confirm:true` 必须带 `planId`（400 `plan_id_required`），planId 与当前库不符 409 `plan_stale`，计划软删数超 `maxDelete` 400 `max_delete_exceeded`；执行前自动备份，批后自检失败自动回滚该批（500 `self_check_failed`，响应体仍带各批次状态）；同一时刻只允许一个整理/回滚在跑。 |
| `GET /tidy/rollbacks` | 可用的回滚文件（`tidy-*` 与 `tags-*`）。 |
| `POST /tidy/rollback` | `{rollbackFile, confirm:true}`：只接受 `backups/` 里符合 `^(tidy\|tags)-…\.rollback\.json$` 的文件名（不接受路径）；回滚前再备份一次；成功后文件改名 `.done`，只能用一次（再用会拿旧数据覆盖之后的新编辑）。 |
| `POST /tokens` | `{name, scopes[], expiresAt?}`。**明文令牌只在这次响应里返回**，库里只有哈希；列表/日志/审计都没有明文。活跃重名 409。 |
| `PATCH /tokens` | `{tokenId, name?, expiresAt?}`（`expiresAt:null` 清除过期）；改名只影响以后的署名。已撤销的不可改。 |
| `DELETE /tokens?tokenId=` | 撤销，立即生效（`/mcp` 下一次请求即 401）。 |
| `POST /password` | `{oldPassword, newPassword}`：先过来源限流（与登录共用，连错 5 次 429），旧口令错 401，新口令至少 10 字符且不能与旧口令相同；成功后所有会话（含当前）失效。 |

## 页面（M2 页面上增量）
- 卡片详情：编辑（标题/类型/标签/正文，冲突时保留输入并提示重新载入）、历史版本（查看 + "回滚到此版本"）、软删/恢复/永久删（输入标题）、批准/驳回（待审卡）。
- 待审队列：行内批准/驳回，多选批量批准/驳回（驳回理由对话框）。回收站：行内与批量恢复；行内「立即删除」、批量「立即删除所选」与「清空回收站」（均弹确认框写明永久删除 N 张、不可恢复）。卡片列表：按当前状态提供批量软删 / 恢复 / 批准 / 驳回。
- 标签：行内重命名/合并到…/删除，疑似同义组"合并…"；对话框先显示影响卡数与样例，勾选确认后才能执行。
- 整理中心（原"整理预览"）：预览 → 演练 → 输入确认词"整理" → 执行 → 结果（批次、备份、回滚文件）→ 回滚；另列出可用回滚文件。
- 令牌：创建（名称/范围/有效期）→ 弹窗显示明文（持久弹窗，带复制按钮，"仅显示一次"，勾选"已保存"才能关闭）；撤销、改名/改过期。
- 账户：修改管理员口令。
- 所有写按钮在请求进行中禁用并标记 `aria-busy`（`guard()`），真实浏览器里验证"连点两次只发 1 次请求"。左下角标记：`管理模式 · M3`（只读保护开启时显示"只读模式"）。
- CSP 未放宽：仍是 `default-src 'self'; script-src 'self'; style-src 'self'…`，无 `unsafe-*`；前端新增代码同样只经 `dom.js` 创建文本节点（测试扫描全部前端源码禁用 `innerHTML` 等）。

## schema v2：已撤销令牌的名字可复用
`agent_tokens.name` 原为整列 `UNIQUE`。SQLite 不能直接删列约束，所以迁移 1→2 在同一事务里：建新表（无 UNIQUE）→ 拷贝全部行 → 删旧表 → 改名 → 建部分唯一索引 `UNIQUE(name) WHERE revoked_at IS NULL`；令牌 id、哈希、范围、时间戳原样保留。
- 兼容与回滚：`user_version` 1→2；旧代码（`SCHEMA_VERSION=1`）打开 v2 库不再迁移、照常读写（测试用 `tests/fixtures/legacy` 旧实现验证）；回滚代码版本无需回滚库。
- 语义：同名活跃令牌仍被拒（409）；按名字撤销时优先命中活跃那枚；卡片的 `submitted_by` 只存名字，复用名字后新旧令牌写的卡共用同一个署名（详情页的"令牌有效/已吊销"状态按活跃令牌判断）。要严格区分请用新名字。

## 修复项（M1 真实客户端实测发现）
- **a. 401 说明**：无令牌 → `401` + `WWW-Authenticate: Bearer realm="memory-hub"` + JSON `{"error":"unauthorized","message":"需要 Bearer 令牌：…"}`；无效令牌 → `error="invalid_token"` + 不区分原因的"令牌无效（不存在、已过期或已被撤销）"。OAuth 发现/注册探测路径（`/.well-known/oauth-*`、`/register`、`/authorize`、`/token`）仍是 404，但响应体写明"本服务不支持 OAuth / 动态客户端注册，只认静态 Bearer 令牌"。**真实 `claude -p`（2.1.295）实测见 `docs/decisions.md` §M3-3：`WWW-Authenticate` 不能改变客户端行为，客户端仍走 OAuth 动态注册并报 "Dynamic Client Registration rejected (HTTP 404)"；本服务不做 OAuth。**
- **b. 失败限流不重复计数**：没带凭据的请求是标准的 Bearer 质询（RFC 6750），**不计失败**；带了无效凭据的请求每个恰好计一次。实测 Claude Code 每次连接会连发 2 个无令牌请求，旧逻辑把一次连接算成 2 次失败。同机其它客户端因此不会被误挡；猜令牌仍受 60 秒 10 次限流。
- **c. `memory_stats` 路径**：HTTP（远程 Agent）下，所有工具输出里的服务器数据目录/家目录绝对路径统一替换成 `<data-dir>`（含 `memory_audit_list`、整理类输出里的备份路径）；stdio 本地模式保持原样。因此"stdio 与 HTTP 输出逐字一致"的测试对这两处做了归一化（唯一改动的 M1 断言）。
- **d. recall 空结果也写 `write_log` 是设计选择**：`write_log` 审计所有读（含 `memory_recall` 无结果、被拒绝的调用），用于"沉淀活跃度"与异常排查；代价是读多时该表增长较快（只有一行摘要，无正文）。不做改动，测试 `m3-fixes` 固定了这一行为。

## 对 M1/M2 测试的改动（原因）
- `tests/db-schema.test.mjs`：`user_version` 断言 1→2（schema v2）；新增 v1→v2 迁移测试。
- `tests/transports.test.mjs`：见修复 c。
- `tests/admin/api-read.test.mjs`：两处"M2 只读"断言（`tidy/apply` 不存在、card/queue/tokens 写方法 404/405）在 M3 起不再成立，改为只断言预览端点不接受写方法、以及从未设计过的路径仍 404/405；写接口由 `tests/admin-write/*` 覆盖。

## 测试与验收命令
```
npm test                                           # 全部（含 M1/M2）
node --test --test-concurrency=1 "tests/admin-write/*.test.mjs" tests/m3-fixes.test.mjs
node tests/e2e/m3-synthetic-server.mjs 7995 <口令输出文件> &       # 合成数据实例（Ctrl-C/kill 时自动清理）
node tests/e2e/admin-m3-flow.mjs http://127.0.0.1:7995 <口令文件> docs/screenshots/m3   # 真实浏览器实测 + 截图（只含合成数据）
node tests/e2e/tidy-roundtrip-on-copy.mjs <memory-eternal.db>      # 在库副本上跑 plan→dry-run→apply→rollback，输出 IDENTICAL
```

## 没做 / 已知局限
- PLAN 5 节的"设置页"（auditMode、免审、去重阈值、保留天数等）不在本次任务清单，未做。
- 变异测试（Stryker/bob-mutation-tests）未跑。
- 预览接口（`/tidy/preview`）仍只带阈值参数；`/tidy/apply` 的 `planId` 与它一致（同一默认选项）。若改了 `maxTags/synonyms/noiseCategories` 需另行扩展。
- 标签操作按**精确字符串**匹配（`Node.js` 与 `nodejs` 视为不同标签，要合并就用"合并"）。
- 批量操作不单独做备份（软删可恢复）；标签与整理会备份。

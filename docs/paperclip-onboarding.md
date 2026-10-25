# Paperclip 成员上手：memory-hub 项目速览

> 由 Paperclip CEO 代理在任务 KIN-3 中根据 `README.md`、`PLAN.md` 与 `src/` 目录结构整理。

## 项目要点

1. **定位**：memory-hub 是多个 Agent 共用的长期记忆服务——一个 MCP 服务（检索 / 沉淀 / 整理）加一个中文管理界面（审阅、修订、图谱、令牌、审计），让 Claude Code、Codex CLI 等任何接入 MCP 的 Agent 在开始任务前检索到可复用的结论。
2. **来源**：衍生自 EternalNight996/memory-eternal（MIT，基线 v0.10.8），去掉了 DSH 宿主耦合，改为独立进程（`memory-hub serve`），并重做了并发、鉴权与多 Agent 署名。当前版本 0.1.0，M1~M4 里程碑已落地。
3. **技术栈**：Node.js ≥ 22.16（ESM），数据用内置 `node:sqlite`（WAL 单文件，无外部数据库、无原生模块）；运行时依赖只有 `@modelcontextprotocol/server` / `@modelcontextprotocol/node`（MCP TypeScript SDK v2）和 `zod`；测试用 `node:test`；前端 `web/` 是纯静态、零构建、零第三方依赖。
4. **传输与工具**：MCP 支持 Streamable HTTP（无状态，兼容 2025 年代 `initialize` 与 2026-07-28 `server/discover`）和 stdio；工具有 `memory_recall`、`memory_capture`、`memory_stats`、`memory_audit_list`、`memory_tidy_plan`、`memory_tidy_apply`、`memory_lint`、`memory_tag_normalize`，按 `read` / `write` / `tidy:apply` 三级 scope 过滤，破坏性的整理工具默认不暴露。
5. **鉴权与审计**：每个 Agent 一枚 Bearer 令牌（库里只存哈希），署名由服务端按令牌确定、不可伪造；管理界面用 scrypt 口令 + HttpOnly 会话 cookie + CSRF；所有写入都落 `write_log`。新卡默认进待审队列，批准前检索不到。
6. **主要模块（`src/`）**：
   - `server.js`：HTTP 服务（`/mcp`、`/api/ingest`、`/healthz`、`/admin/*`、定时备份/清理）；`config.js` 配置解析与启动护栏；`logger.js`、`instructions.js`。
   - `transport/`：MCP 装配（`mcp-server.js`）与 stdio 传输（`stdio.js`）。
   - `tools/registry.js`：工具定义、scope 元数据、统一 `callTool`。
   - `auth/tokens.js`：令牌创建 / 校验 / 撤销。
   - `core/`：`db`、`vault`（CRUD / 检索 / 图谱）、`capture` + `capture-run`（沉淀管线：剥噪声 → 长度闸 → LLM 蒸馏 → 去重/合并）、`minhash` / `dedup-config`（去重）、`tidy`（整理）、`ingest`（会话文本摄入）、`writelog`、`llm-openai`（OpenAI 兼容蒸馏端点）。
   - `admin/`：管理 API（`handler`、`queries`、`ops`、`auth`、`settings`、`graph`、`graph-search`）。
   - `migrate.js`：旧库对账 / 反向增量。
7. **周边目录**：`bin/memory-hub.mjs` CLI（serve / mcp / token / admin / migrate / backup）；`web/` 管理界面（含知识图谱与"蜘蛛搜索"）；`clients/` 下 DSH 插件和 Pi 扩展两个可选自动沉淀适配器；`deploy/` systemd 单元；`scripts/` 部署、切换演练与验证脚本；`tests/` 用例与 e2e；`PLAN.md` 是第一阶段调研与设计全文。
8. **已知限制**：沉淀无自动兜底（Agent 不调 `memory_capture` 就不入库）；检索是全表扫描后在 JS 中打分，几万张卡时需重新评估索引；服务不做 OAuth，令牌需手工下发与轮换。

## 给 Paperclip 成员的协作约定

- **只走分支 + PR**：每个任务在独立分支上工作（建议命名 `paperclip/<任务号>-<简述>`），改完后 `git push` 并用 `gh pr create --base main` 开 PR，标题以 `[paperclip]` 开头。
- **不推 main**：任何情况下都不要直接向 `main` 提交或推送，也不要 force-push 别人的分支。
- **不合并 PR**：PR 由仓库所有者审阅并合并，Paperclip 成员不要自己点合并、不要开启 auto-merge。
- 不要把密钥、令牌、内部主机地址等敏感信息写进仓库。

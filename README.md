# memory-hub

多个 Agent 共用的长期记忆服务：一个 **MCP 服务**（检索 / 沉淀 / 整理）+ 一个**中文管理界面**（审阅、修订、图谱、令牌、审计）。

把「值得复用的结论」集中沉淀到一处，任何接入了 MCP 的 Agent 都能在开始任务前检索到——包括 Claude Code、Codex CLI、各类 harness 与自建脚本。数据是本地 SQLite 单文件，无外部数据库、无 SaaS 依赖。

> 状态：M1（MCP）～M4（图谱 / 部署 / 切换）已落地并在自建服务器上完成真实切换，管理界面已过真实浏览器验收。仓库处于 0.1.0。

## 与上游的关系

memory-hub 是 [EternalNight996/memory-eternal](https://github.com/EternalNight996/memory-eternal)（MIT，基线 v0.10.8）的衍生作品。`src/core/` 下的存储、检索、去重、沉淀、整理（tidy）模块源自该项目及其本地 fork（上游基础之外增加了 tidy / lint / dedup-merge），在此之上删除了 DSH（DeepSeek Harness）宿主耦合，并重做了并发、鉴权与多 Agent 署名。版权声明见 [`LICENSE`](LICENSE) 与 [`NOTICE.md`](NOTICE.md)。

与原插件的主要差异：

| 维度 | 原 memory-eternal | memory-hub |
|---|---|---|
| 运行形态 | 寄生在 DSH 宿主进程里的插件 | 独立进程（`memory-hub serve`）+ 独立管理界面 |
| 多 Agent | 单一宿主，署名靠 `clientInfo` 自报 | 每 Agent 一枚 Bearer 令牌，署名由服务端按令牌确定 |
| 权限 | 无 | `read` / `write` / `tidy:apply` 三级 scope，`tools/list` 按 scope 过滤 |
| 配置 | DSH 设置服务（schemastery） | 环境变量 + `memory-hub.json` + DB `config` 表 |
| 进程保活 / Web | 宿主 watchdog、iframe 挂载 | systemd（示例见 `deploy/`）+ 自带静态前端 |
| 会话自动沉淀 | 宿主事件 hook | 可选：客户端插件 / hook 调 `POST /api/ingest`（不做宿主 hook） |

## 特性

- **MCP 服务**：HTTP（Streamable HTTP，无状态，同时兼容 2025 年代 `initialize` 与 2026-07-28 `server/discover`）与 stdio 两种传输，共用同一份工具定义与调用实现。
- **主动沉淀**：`memory_capture` 走「剥噪声 → 长度闸 → LLM 蒸馏 → 去重/合并」管线；蒸馏未配置时降级为原文卡，不会丢内容。
- **审核闸门**：新卡默认进待审队列，批准前检索不到；支持按 Agent / kind 免审白名单，规则存在库内、改后立即生效、无需重启。
- **检索**：中文整词 + 字符片段打分（不依赖 FTS 分词），标注摘要、路径与标签；沿用上游召回语义。
- **管理界面**（`web/`，纯静态、零构建、零第三方依赖）：总览 / 卡片 / 待审 / 整理 / 图谱 / 回收站 / 标签 / 健康 / 活跃度 / 令牌 / 审计 / 设置，Swiss 风格，明暗双主题，自托管字体。
- **写操作有护栏**：乐观锁防并发丢更新、修订历史与回滚、批量操作需确认、改前自动 `VACUUM INTO` 备份并自检、`MEMORY_HUB_ADMIN_READONLY` 只读模式。
- **审计**：所有写入（Agent 与管理员）落 `write_log`，含署名、工具、来源 IP 与参数摘要；不含口令、令牌与正文。
- **令牌即身份**：库里只存哈希，明文仅在创建时显示一次；可设过期、可吊销；旧共享令牌支持 `token import-hash` 零改动接管。
- **进程自带运维**：每日自动备份、回收站过期清理、会话过期清理；`GET /healthz` 存活探针。

## 环境要求

- Node.js **>= 22.16**（`node:sqlite`、`sqlite.backup`；实测生产跑 Node 25 亦可）。原生模块为零，不需要编译工具链。
- 运行时依赖仅 3 个包（`@modelcontextprotocol/server`、`@modelcontextprotocol/node`、`zod`）。

## 快速开始

```bash
git clone <repo> memory-hub && cd memory-hub
npm ci --omit=dev

# 数据目录（默认为 ~/.memory-hub）；接管既有 memory-eternal.db 时改用 MEMORY_HUB_DB
export MEMORY_HUB_HOME=~/.memory-hub

# 1) 设置管理界面口令（从 stdin 读，不进 argv / 日志）
memory-hub admin set-password

# 2) 起服务（默认 127.0.0.1:7990）
memory-hub serve
# 浏览器打开 http://127.0.0.1:7990/admin/

# 3) 给每个 Agent 建一枚令牌（明文只打印这一次）
memory-hub token create --name claude-code --scope read,write
```

### 接入 MCP 客户端

HTTP（多机 / 多 Agent 首选）：

```jsonc
{
  "mcpServers": {
    "memory-hub": {
      "type": "http",
      "url": "http://127.0.0.1:7990/mcp",
      "headers": { "Authorization": "Bearer mh_<tokenId>_<secret>" }
    }
  }
}
```

stdio（本机单 Agent，身份取环境变量 `MEMORY_HUB_AGENT`，不经网络与令牌）：

```jsonc
{
  "mcpServers": {
    "memory-hub": {
      "command": "node",
      "args": ["/path/to/memory-hub/bin/memory-hub.mjs", "mcp"],
      "env": { "MEMORY_HUB_HOME": "/home/you/.memory-hub", "MEMORY_HUB_AGENT": "claude-code" }
    }
  }
}
```

服务不做 OAuth / 动态客户端注册，只认静态 Bearer 令牌；客户端探测 `.well-known/*` 得到的 404 响应体会写明这一点。

### 客户端插件（可选，自动沉淀）

不做宿主 hook，沉淀只靠 Agent 主动调 `memory_capture`。若想让会话文本自动流入，可选用仓库内的两个客户端适配器，它们都调同一个 `POST {base}/api/ingest`：

- [`clients/dsh-plugin`](clients/dsh-plugin/README.md)：DSH 插件，每轮结束推送增量文本。
- [`clients/pi-web-extension`](clients/pi-web-extension/README.md)：Pi 扩展（`~/.pi/agent/extensions/`），同样在轮末推送。

摄入接口的协议、状态码、幂等与客户端水位语义见 [`docs/ingest-api.md`](docs/ingest-api.md)。

## MCP 工具与权限

| 工具 | 所需 scope | 说明 |
|---|---|---|
| `memory_recall` | `read` | 按关键词检索相关知识卡，返回标题 / 路径 / 摘要 |
| `memory_capture` | `write` | 沉淀一条自包含知识（一次一个主题，上限 64K 字符） |
| `memory_stats` | `read` | 库概览：总数、分类分布、近期新增 |
| `memory_audit_list` | `read` | 列出待审 / 已驳回卡片（只读，不改变状态） |
| `memory_tidy_plan` | `read` | 整理预览：重复、超长 raw、标签异常 |
| `memory_tidy_apply` | `tidy:apply` | 执行整理（需 `confirm`，先备份后自检）；默认不出现在 `tools/list`，用 `MEMORY_HUB_MCP_EXPOSE_TIDY_APPLY=1` 打开 |
| `memory_lint` | `read` | 结构 / 标签 / 疑似密钥检查 |
| `memory_tag_normalize` | `tidy:apply` | 标签归一（同上，默认隐藏） |

服务还会在 `initialize` / `server/discover` 返回一段 instructions，告诉模型何时 recall、何时 capture、不要存密钥。可用配置文件的 `instructions` 字段覆盖。

工具名、参数与输出格式与上游 v0.10.8 基线一致，便于平滑迁移。

## HTTP 接口

| 路径 | 鉴权 | 说明 |
|---|---|---|
| `POST {base}/mcp` | Bearer 令牌 | MCP Streamable HTTP，无状态 |
| `POST {base}/api/ingest` | Bearer 令牌（需 `write`） | 会话文本摄入 |
| `GET {base}/healthz` | 无 | 存活探针，返回版本 |
| `{base}/admin/` | 管理会话 cookie | 管理界面静态文件 |
| `{base}/admin/api/*` | 管理会话 cookie + CSRF | 管理 API（只读与写接口） |

`base` 取 `MEMORY_HUB_BASE_PATH`（默认空；反向代理在子路径下时设置，如 `/memory`）。

鉴权之外还有 Origin / Host 白名单、认证失败限流（同源 60 秒 10 次 → 429）、请求体上限（`/mcp` 1MB，ingest 默认 256KB）。

## 管理界面

非回环部署必须显式开 `MEMORY_HUB_ALLOW_REMOTE=1` 并同时配置 `MEMORY_HUB_ALLOWED_ORIGINS` / `MEMORY_HUB_ALLOWED_HOSTS`，否则拒绝启动（防 DNS rebinding）。

安全要点：口令以 scrypt 存库；会话 cookie `HttpOnly; SameSite=Strict`（经 https 反代时加 `Secure`）；写接口需 CSRF token + 同源 Origin；登录失败限流。详细约束见 [`docs/m2-admin.md`](docs/m2-admin.md) 与 [`docs/m3-admin.md`](docs/m3-admin.md)。

## 配置

优先级：环境变量 > `$MEMORY_HUB_HOME/memory-hub.json` > 默认值。配置文件须为 `0600`（否则忽略其中的 `llm.key` 并告警）。

常用环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `MEMORY_HUB_HOME` | `~/.memory-hub` | 数据目录（库、备份） |
| `MEMORY_HUB_DB` | — | 直接指向既有 `memory-eternal.db`（文件名必须是 `memory-eternal.db`）实现零迁移接管 |
| `MEMORY_HUB_CONFIG` | `$MEMORY_HUB_HOME/memory-hub.json` | 配置文件路径 |
| `MEMORY_HUB_HOST` / `MEMORY_HUB_PORT` | `127.0.0.1` / `7990` | 监听地址与端口 |
| `MEMORY_HUB_BASE_PATH` | 空 | URL 前缀（反代子路径） |
| `MEMORY_HUB_ALLOW_REMOTE` / `MEMORY_HUB_ALLOWED_ORIGINS` / `MEMORY_HUB_ALLOWED_HOSTS` | — | 非回环监听的三件套 |
| `MEMORY_HUB_TRUST_PROXY` | 关 | 反代后按 `X-Forwarded-For` 区分来源 |
| `MEMORY_HUB_ADMIN_READONLY` | 关 | 管理界面只读模式（所有写接口 403） |
| `MEMORY_HUB_ADMIN_MAX_BATCH` | `50` | 批量操作单次上限（1~1000） |
| `MEMORY_HUB_MCP_EXPOSE_TIDY_APPLY` | 关 | 在 `tools/list` 中暴露 apply 类工具 |
| `MEMORY_HUB_INGEST_MIN_CHARS` / `_COOLDOWN_S` / `_DAILY_QUOTA` / `_MAX_BODY_BYTES` | `300` / `120` / `200` / `256KiB` | 摄入闸门 |
| `MEMORY_HUB_LOG_LEVEL` | `info` | 日志级别（日志走 stderr） |
| `MEMORY_HUB_AGENT` | — | 仅 stdio：自报身份，写进署名 |

蒸馏（DeepSeek 等 OpenAI 兼容端点；`BASE_URL` 与 `MODEL` 缺一则降级为原文卡，不回退到 `OPENAI_*`）：

`MEMORY_LLM_BASE_URL`、`MEMORY_LLM_MODEL`、`MEMORY_LLM_KEY`、可选 `MEMORY_LLM_REASONING_EFFORT` / `MEMORY_LLM_EXTRA_BODY` / `MEMORY_LLM_TIMEOUT_MS`。细节与重试阶梯见 [`docs/deployment-config.md`](docs/deployment-config.md)。

密钥永不进日志：日志只记录是否配置、模型名、key 是否已设置。

## CLI

```
memory-hub serve                                   # 起 HTTP 服务
memory-hub mcp                                     # stdio MCP
memory-hub admin set-password                      # 设置/更换管理口令（从 stdin 读）
memory-hub token create --name N --scope read,write[,tidy:apply] [--expires 14d]
memory-hub token list [--json]
memory-hub token revoke <name|tokenId>
memory-hub token import-hash --name N --scope ... (--from-file <旧令牌文件> | --hash <sha256>)
memory-hub migrate verify --source <旧库或快照> --target <新库> [--allow-target-extra] [--json]
memory-hub migrate reverse --from <新库> --target <旧库> [--execute] [--prune-purged] [--export f.json]
memory-hub backup now
```

`migrate verify` 对账失败退出码为 1，适合放进切换脚本；`migrate reverse` 默认 dry-run。

## 部署

- systemd 用户单元模板：[`deploy/memory-hub.service`](deploy/memory-hub.service)（staging 版 `memory-hub-staging.service`），环境键名清单见 [`deploy/env.keys.txt`](deploy/env.keys.txt)。秘密放 `0600` 的 `EnvironmentFile`，不进仓库、不进命令行。
- 远端导出部署：[`scripts/deploy-remote.sh`](scripts/deploy-remote.sh)（导出 HEAD、`npm ci --omit=dev`、冒烟 import，不碰 systemd / nginx / 数据）。
- 切换与回滚：`scripts/rehearse-cutover.sh`（演练，不碰线上）、`scripts/cutover.sh`（默认 dry-run，`--execute` 才动手）。真实切换手册见 [`docs/deploy-58.md`](docs/deploy-58.md)。
- 本机拿真实数据快照看界面：`scripts/dev-snapshot.sh`，见 [`docs/dev-with-real-data.md`](docs/dev-with-real-data.md)。

## 测试

```bash
npm test        # node:test，tests/**/*.test.mjs（串行，含并发、鉴权、传输、迁移、检索对账等）
```

另有针对性验证脚本（不进 `npm test`）：`scripts/validate/`（MCP 客户端兼容、召回对账、负载、管理台截图）与 `tests/e2e/`。两个客户端适配器各自带独立测试，见其 README。

## 目录结构

```
bin/memory-hub.mjs      CLI 入口
src/server.js           HTTP 服务（/mcp、/api/ingest、/healthz、/admin/*、定时任务）
src/config.js           配置解析 + 启动护栏
src/transport/          MCP 装配与 stdio 传输
src/tools/registry.js   工具定义、scope 元数据、统一 callTool
src/auth/tokens.js      令牌创建 / 校验 / 撤销（只存哈希）
src/core/               db、vault（CRUD/检索/图谱）、capture、dedup、tidy、ingest、migrate 底座
src/admin/              管理 API（handler、queries、ops、auth、settings、graph）
src/migrate.js          旧库对账 / 反向增量
web/                    管理界面（纯静态，零构建）
clients/                DSH 插件、Pi 扩展
deploy/ systemd 单元与环境键名清单
docs/                   设计、部署、接口、界面文档
tests/                  node:test 用例与 e2e
PLAN.md                 第一阶段调研与设计全文（含取舍与证据）
```

## 文档索引

- [`PLAN.md`](PLAN.md)：调研 + 设计 + 里程碑（含逐项证据与不确定性标注）
- [`docs/decisions.md`](docs/decisions.md)：SDK spike 结论与关键决策
- [`docs/deploy-58.md`](docs/deploy-58.md)：并行验证、切换、回滚手册
- [`docs/deployment-config.md`](docs/deployment-config.md)：蒸馏 LLM 配置
- [`docs/ingest-api.md`](docs/ingest-api.md)：摄入接口协议
- [`docs/m2-admin.md`](docs/m2-admin.md) / [`docs/m3-admin.md`](docs/m3-admin.md)：管理界面只读 / 写接口与约束
- [`docs/m4-graph.md`](docs/m4-graph.md)：知识图谱语义与数据模型
- [`docs/ui-design.md`](docs/ui-design.md)：界面设计说明与令牌表

## 已知限制

- 沉淀无自动兜底：Agent 不调 `memory_capture` 就不会入库；可选客户端插件只是把对话文本推给同一条管线。
- 检索是全表扫描后在 JS 里打分，662 张卡下毫秒级；几万张卡需要重新评估索引策略。
- 审核模式默认 `all`（全部待审），Agent 沉淀的卡需人工批准才会被检索到。
- 管理界面为中文；工具输出格式沿用上游基线，未做多语言。
- 服务不做 OAuth，令牌需手工下发与轮换。

## License

MIT，见 [`LICENSE`](LICENSE)。上游版权声明保留，衍生说明见 [`NOTICE.md`](NOTICE.md)。

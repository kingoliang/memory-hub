# memory-hub

面向团队的长期记忆服务：一个 **MCP 服务**（检索 / 沉淀 / 整理）+ 一个**中文管理界面**（审阅、修订、图谱、令牌、审计）。

支持**多个团队、每个团队多人**：检索时**先搜自己的记忆，再搜本团队其他人的，最后才是其它团队公开的**；沉淀前有一道**经验闸门**，只让提炼过、有经验价值的内容入库，跑命令、看文件、状态汇报这类日常操作直接丢掉。

把「值得复用的结论」集中沉淀到一处，任何接入了 MCP 的 Agent 都能在开始任务前检索到——包括 Claude Code、Codex CLI、各类 harness 与自建脚本。数据是本地 SQLite 单文件，无外部数据库、无 SaaS 依赖。

> 状态：M1（MCP）～M4（图谱 / 部署 / 切换）已落地并在自建服务器上完成真实切换，管理界面已过真实浏览器验收。仓库处于 0.1.0。

![知识图谱里的蜘蛛：空闲时在簇间爬行，触手末端始终踩在真实节点上；输入「缓存」回车后逐个踩点收集命中卡片，最后给出 AI 汇总](docs/media/graph-spider.gif)

<sub>管理界面「图谱」页：蜘蛛（倾斜网格圆盘 + 渐细的青色触手）空闲时在簇间爬行，每条触手的末端都踩在真实节点上；输入「缓存」回车后，沿最短巡游路线跨簇踩点收集命中卡片并飞入结果面板，最后由 AI 汇总要点并标注出处。录屏使用合成数据（360 张卡）与本地 LLM 测试桩，录制时逐帧校验触手末端（2242 条全部在节点上），可用 `node scripts/demo/record-spider-gif.mjs docs/media/graph-spider.gif` 复现。</sub>

## 团队记忆：先自己、再本团队、最后其它团队

每枚令牌带一个归属：`owner`（人）、`team`（团队）、新卡默认可见性。同一个人的多个 Agent（Claude Code / Codex / pi…）各发一枚令牌、共享同一个 `owner`；团队数量与每团队人数都不限。

```bash
memory-hub token create --name kingo-claude --scope read,write --owner kingo --team remittance
memory-hub token create --name alice-codex  --scope read,write --owner alice --team remittance
memory-hub token create --name bob-claude   --scope read,write --owner bob   --team payments --visibility public
```

`memory_recall` 的结果按三层排序——**层优先于相关度**，所以自己的弱命中也排在别人的强命中前面：

```text
从记忆核心检索到 4 条相关卡片（先自己的、再团队）：

[自己的记忆] 2 条
### 1. 部署流程-灰度发布检查清单
### 2. 部署流程-回滚脚本

[本团队 · alice] 1 条
### 3. 部署流程-数据库迁移顺序

[其它团队 · bob] 1 条
### 4. 部署流程-支付链路封网窗口
```

| 卡片可见性 | 本人 | 本团队其他人 | 其它团队 |
| --- | --- | --- | --- |
| `private` | ✅ | — | — |
| `team`（默认） | ✅ | ✅ | — |
| `public` | ✅ | ✅ | ✅（排在最后一层） |

- 只想看自己的：`memory_recall` 传 `scope=mine`；只看自己和本团队：`scope=team`；默认 `auto` 三层都给。
- 「本团队没有了再搜其它团队」是靠层排序实现的：本团队的命中永远在前，本团队一条都没有时，结果自然全是其它团队的。
- 归属由**令牌**决定，不由请求参数决定；Agent 可调 `memory_whoami` 自查。stdio 用 `MEMORY_HUB_OWNER` / `MEMORY_HUB_TEAM` / `MEMORY_HUB_VISIBILITY`。
- 管理界面：卡片列表显示 `owner@team`，可按归属 / 团队 / 可见性筛选；单卡可改归属；令牌表单可设三个字段。
- 老库升级（schema v3）只加列不重写行：`owner` 由原署名回填、`team=default`、`visibility=team`，升级前后可见性完全一致。

设计与取舍：[`docs/decisions/2026-10-18-team-scope-own-first-recall.md`](docs/decisions/2026-10-18-team-scope-own-first-recall.md)。

## 经验闸门：只沉淀提炼过的经验

在「剥噪声」与「LLM 蒸馏」之间插了一道闸门，判定 `experience` / `unknown` / `routine`，**`routine` 直接丢，连模型都不调**：

- **启发式**（纯函数）：结论 / 因果 / 取舍 / 踩坑 / 可复用流程 / 路径 / 带单位数值加分；工具输出行占多数、纯状态汇报（「跑了一遍，全绿」）、寒暄减分。
- **LLM 二判**（strict 模式）：启发式拿不准时只问模型一个二元问题；模型不可用时退回启发式，**不会因为模型抖动全放行或丢内容**。
- **只要一段里有一处是经验就放行**，日常部分交给蒸馏压缩。

| 入口 | 默认模式 | 开关 |
| --- | --- | --- |
| `POST /api/ingest`（客户端自动推送） | `strict` | `MEMORY_HUB_GATE_INGEST` |
| `memory_capture`（Agent 显式沉淀） | `heuristic` | `MEMORY_HUB_GATE_CAPTURE`；单次 `force=true` 绕过 |

被丢弃时返回 `skipped` / `gate:routine` 并附上判定依据（`via` / `score` / `signals`），不做静默丢弃；ingest 侧被丢弃的批次不消耗冷却与配额。Pi 扩展还会在本地预筛纯工具输出，连请求都不发（`MEMORY_HUB_PI_PREFILTER=off` 关闭）。

设计与取舍：[`docs/decisions/2026-10-18-experience-gate.md`](docs/decisions/2026-10-18-experience-gate.md)。

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
- **知识图谱 + 蜘蛛搜索**：暗色簇云图谱（`[[链接]]` / 共享标签 / 正文相似三类边）；蜘蛛常驻画布在簇间爬行，回车后沿最短巡游路线踩点收集命中卡片，再由 AI 汇总要点并标注出处（蒸馏 LLM 未配置时只做召回，不汇总）。详见 [`docs/m4-graph.md`](docs/m4-graph.md)。
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
| `memory_recall` | `read` | 按关键词检索相关知识卡，按「自己 → 本团队 → 其它团队」分组返回；`scope` = `auto` / `mine` / `team` |
| `memory_capture` | `write` | 沉淀一条自包含知识（一次一个主题，上限 64K 字符）；先过经验闸门，可传 `visibility` / `force` |
| `memory_whoami` | `read` | 当前身份：令牌名 / owner / team / 默认可见性 |
| `memory_stats` | `read` | 库概览：总数、分类分布、近期新增 |
| `memory_audit_list` | `read` | 列出待审 / 已驳回卡片（只读，不改变状态） |
| `memory_tidy_plan` | `read` | 整理预览：重复、超长 raw、标签异常 |
| `memory_tidy_apply` | `tidy:apply` | 执行整理（需 `confirm`，先备份后自检）；默认不出现在 `tools/list`，用 `MEMORY_HUB_MCP_EXPOSE_TIDY_APPLY=1` 打开 |
| `memory_lint` | `read` | 结构 / 标签 / 疑似密钥检查 |
| `memory_tag_normalize` | `tidy:apply` | 标签归一（同上，默认隐藏） |

服务还会在 `initialize` / `server/discover` 返回一段 instructions，告诉模型何时 recall、何时 capture、不要存密钥。可用配置文件的 `instructions` 字段覆盖。

上游 v0.10.8 基线的工具名与必填参数保持不变（新参数全是可选的）；`memory_recall` 输出多了分层标题行。

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
| `MEMORY_HUB_OWNER` / `MEMORY_HUB_TEAM` / `MEMORY_HUB_VISIBILITY` | 空 / 空 / `team` | 仅 stdio：归属（HTTP 下由令牌决定） |
| `MEMORY_HUB_GATE_INGEST` / `MEMORY_HUB_GATE_CAPTURE` | `strict` / `heuristic` | 经验闸门模式：`off` / `heuristic` / `strict` |

蒸馏（DeepSeek 等 OpenAI 兼容端点；`BASE_URL` 与 `MODEL` 缺一则降级为原文卡，不回退到 `OPENAI_*`）：

`MEMORY_LLM_BASE_URL`、`MEMORY_LLM_MODEL`、`MEMORY_LLM_KEY`、可选 `MEMORY_LLM_REASONING_EFFORT` / `MEMORY_LLM_EXTRA_BODY` / `MEMORY_LLM_TIMEOUT_MS`。细节与重试阶梯见 [`docs/deployment-config.md`](docs/deployment-config.md)。

密钥永不进日志：日志只记录是否配置、模型名、key 是否已设置。

## CLI

```
memory-hub serve                                   # 起 HTTP 服务
memory-hub mcp                                     # stdio MCP
memory-hub admin set-password                      # 设置/更换管理口令（从 stdin 读）
memory-hub token create --name N --scope read,write[,tidy:apply] [--owner 人] [--team 团队] [--visibility private|team|public] [--expires 14d]
memory-hub token list [--json]                     # 文本输出带 owner / team / 可见性
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
- 切换与回滚：`scripts/rehearse-cutover.sh`（演练，不碰线上）、`scripts/cutover.sh`（默认 dry-run，`--execute` 才动手）。
- 本机拿真实数据快照看界面：`scripts/dev-snapshot.sh`，见 [`docs/dev-with-real-data.md`](docs/dev-with-real-data.md)。

## 测试

```bash
npm test        # node:test：tests/**/*.test.mjs + 两个客户端适配器的测试（串行）
npm run gate    # 覆盖率（分母按 git ls-files 重算）+ 死代码报告 + 依赖环，阈值是棘轮
npm run mutate  # 变异测试（靶区：scope.js / gate.js）
npm run complexity  # 复杂度，只报告不失败
npm run verify  # gate + test
```

本仓库按 Bob 质量规程交付：先写字面量期望值的测试见红再实现、用变异得分而不是覆盖率验收、阈值只进不退。三条禁令见 [`CLAUDE.md`](CLAUDE.md)，规程全文见 [`docs/QUALITY_FIX_PLAYBOOK.zh.md`](docs/QUALITY_FIX_PLAYBOOK.zh.md)；变异基线（76% → 91%，剩余存活逐条判定）见 [`docs/decisions/2026-10-18-mutation-baseline.md`](docs/decisions/2026-10-18-mutation-baseline.md)。

另有针对性验证脚本（不进 `npm test`）：`scripts/validate/`（MCP 客户端兼容、召回对账、负载、管理台截图）与 `tests/e2e/`。两个客户端适配器各自带独立测试，见其 README。

演示素材：`scripts/demo/seed-demo.mjs <数据目录>` 生成一份确定性的合成知识库（10 个主题、约 360 张卡，不含任何真实数据）；`scripts/demo/record-spider-gif.mjs <输出.gif>` 在临时目录里用这份数据和本地 LLM 测试桩起服务，录制图谱蜘蛛动画，录制期间逐帧校验触手末端都在节点上，有一条不在就以非零码退出（需要本机 Chrome 与 ffmpeg）。

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
- [`docs/decisions/`](docs/decisions/)：团队分层检索、经验闸门、Bob 质量规程、变异基线的决策记录
- [`docs/import-20261018-legacy-vault.md`](docs/import-20261018-legacy-vault.md)：旧库一次性对账导入（verify 全项 PASS）
- [`docs/deployment-config.md`](docs/deployment-config.md)：蒸馏 LLM 配置
- [`docs/ingest-api.md`](docs/ingest-api.md)：摄入接口协议
- [`docs/m2-admin.md`](docs/m2-admin.md) / [`docs/m3-admin.md`](docs/m3-admin.md)：管理界面只读 / 写接口与约束
- [`docs/m4-graph.md`](docs/m4-graph.md)：知识图谱语义与数据模型
- [`docs/ui-design.md`](docs/ui-design.md)：界面设计说明与令牌表

## 已知限制

- 沉淀无自动兜底：Agent 不调 `memory_capture` 就不会入库；可选客户端插件只是把对话文本推给同一条管线。
- 检索是全表扫描后在 JS 里打分，662 张卡下毫秒级；几万张卡需要重新评估索引策略。
- 审核模式默认 `all`（全部待审），Agent 沉淀的卡需人工批准才会被检索到。
- 从旧单机库升级时 `owner` 只能由原署名回填，往往是 Agent 名而不是人名，需要在管理界面里改回真人。
- 经验闸门的启发式是中文为主的关键词 + 结构信号，纯英文对话会更多落到 `unknown`（strict 模式下交给 LLM 二判）。
- 管理界面为中文；工具输出格式沿用上游基线，未做多语言。
- 服务不做 OAuth，令牌需手工下发与轮换。

## License

MIT，见 [`LICENSE`](LICENSE)。上游版权声明保留，衍生说明见 [`NOTICE.md`](NOTICE.md)。

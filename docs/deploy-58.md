# memory-hub 部署到 58：并行验证实例、切换与回滚手册（M4 阶段一）

日期：2026-10-15。依据 `PLAN.md` 6.3.1 / 6.3.3 / 7（M4）/ 9。本文所有"实测"均来自 2026-10-15 在 58 上的真实命令输出；**正式切换已于 2026-10-15 执行，见第 13 节「切换记录」**；切换前的状态：旧服务（`memory-mcp-http.service`，7990）、nginx、DSH 及其插件、两台机器的客户端配置均未被改动。

> 约定：命令里的 `<...>` 是占位（示例），不是真实值。本文不含任何口令 / 令牌 / 密钥。58 的 tailnet 名 `<server>.<tailnet>.ts.net` 与 IP `<server-tailnet-ip>` 沿用 PLAN 1.9 已有写法。

## 0. 现状一句话

- **并行验证实例 `memory-hub-staging.service` 已在 58 运行**（`127.0.0.1:7991`，不对外），数据是旧库的一致性快照拷贝。验证项 a–g 见第 6 节。
- **切换/回滚脚本** `scripts/cutover.sh`（默认 dry-run，`--execute` 才动手）与**不碰线上的完整演练** `scripts/rehearse-cutover.sh` 已在 58 上演练通过（切换 → 新库产生增量 → 回滚 → 旧服务恢复且能读到增量 → 重新切换，卡一张不少）。
- **切换全程不需要 sudo**：新服务带 `MEMORY_HUB_BASE_PATH=/memory` 接管 `127.0.0.1:7990`，nginx 现有的 `/memory/ → 127.0.0.1:7990` 反代原样可用（见第 4 节）。只有第 4 节的"可选加固"需要 sudo。
- 需要用户做的事：冻结旧写入方（第 7.2 节）、客户端配置（第 8 节）、DSH 插件下线（第 10 节）。

## 1. 58 现状（只读勘察，2026-10-15）

| 项 | 实测结果 |
|---|---|
| 主机 | `<server>`，Ubuntu（内核 6.8.0-53），x86_64；根盘 879G，剩 184G（79%） |
| node | `~/.local/bin/node` = **v25.6.1**（`~/.local/lib/node-v25.6.1-linux-x64`）。≥22.16 ✔，`node:sqlite` 与 `sqlite.backup` 可用 ✔。**非交互 ssh 的 PATH 里没有 node**，脚本里都显式 `export PATH=$HOME/.local/bin:$PATH` |
| npm / 联网装依赖 | npm 11.9.0；registry `https://registry.npmjs.org/` 可达（`npm view zod@4.6.7` 返回 4.6.7；`npm ci --omit=dev` 5 秒装好 6 个包）。运行时依赖仅 `@modelcontextprotocol/server`、`@modelcontextprotocol/node`、`zod`，无需本机打包 |
| systemd --user | 可用：`systemctl --user is-system-running` = running；`loginctl show-user`：**Linger=yes**（用户退出登录后服务仍运行）；`XDG_RUNTIME_DIR=/run/user/1001` |
| 端口 | 7991、7992 空闲（部署前核对）；占用情况：7990 旧 MCP（pid 随时间变化）、7999/8000 旧面板（DSH 子进程）、8787 / 8504 / 19387 / 19390 等为其它服务。80/443 为 nginx |
| nginx | 1.24.0；`/etc/nginx/sites-enabled/dsh-piweb` → `sites-available/dsh-piweb`。`server{listen 80 default_server; server_name _;}`：`location = /dsh-ca.crt`、`location ^~ /memory/`（→ `127.0.0.1:7990`）、`location /`（→ DSH）。`server{listen 443 ssl http2 default_server; server_name _;}`：`location = /piweb`、`^~ /piweb/`（→ 8504）、`= /memory`、`^~ /memory/`（→ 7990）、`/`（→ `<server-tailnet-ip>:3080`）。只读查看，未改 |
| 旧服务 | `memory-mcp-http.service` active（since 10-14 11:13 UTC，NRestarts=0，内存约 72MB），`~/.config/systemd/user/memory-mcp-http.service`，`ExecStart=%h/.local/bin/node %h/.dsh/memory-mcp-http/server.mjs`，`Restart=always`；日志仅 `[memory-mcp] <ip> mcp-http:claude-code/…` 行。**鉴权方式：令牌文件 `~/.dsh/memory-mcp-http/token`（明文，≥32 字符，原样作为 Bearer）** → 见 `token import-hash` |
| 旧库 | `~/.dsh/memory-vault/memory-eternal.db`（WAL）≈5.8MB；快照时 cards=662（kind 分布 business 4 / content 72 / knowledge 78 / mistake 33 / project 404 / prompt 25 / tool 46），quarantine：deleted 253、pending 13（此后线上继续有新待审卡，切换当天重新取基线），`card_sequence.seq`=2101，`user_version`=0。旧插件自带每日备份在 `~/.dsh/memory-vault/backups/` |
| 蒸馏（DSH 现有配置） | `cordis.patch.yml` 的 `llm-deepseek` 条目（`@deepseek-ai/dsh-llm-deepseek-api-key`）有 `baseURL: <LLM 网关地址>`（**不是** `api.deepseek.com`；具体地址见 58 上该文件第 11 行附近）；密钥引用名 `DEEPSEEK_API_KEY`，值在 `~/.dsh/.credentials.yaml` 的 `refs` 下。模型 `deepseek-v4.1-flash` |

## 2. 部署布局

| 位置（58） | 内容 | 权限 |
|---|---|---|
| `~/memory-hub/` | 代码（`git archive HEAD` 导出，**不依赖任何 git 远程**）+ `node_modules`（`npm ci --omit=dev`）+ `REVISION`（部署的提交号） | 默认 |
| `~/memory-hub-data/staging/` | staging 数据目录：`memory-eternal.db`（WAL）、`backups/` | 目录 0700、库 0600 |
| `~/memory-hub-data/snapshots/` | 旧库一致性快照（`legacy-snap-*.db`，供对账用）；`LATEST` 指向最新 | 0700 / 0600 |
| `~/memory-hub-data/prod/`（切换时创建） | 正式数据目录 | 0700 |
| `~/memory-hub-data/cutover/<时间戳>/`（切换时创建） | 切换记录：`final-snapshot.db`、`state.env`；回滚时的增量导出 `rollback-delta-*.json` | 0700 |
| `~/.config/memory-hub/` | `staging.env`（0600）、`staging-admin-password`（0600）；切换准备后还有 `prod.env`、`prod-admin-password` | 目录 0700 |
| `~/.config/systemd/user/memory-hub-staging.service` | staging unit（第 3 节）；切换准备后还有 `memory-hub.service` | — |
| 临时 | `/tmp/memory-hub-*`（用后清理） | — |

重新部署代码：在本机仓库（工作区须干净）运行 `scripts/deploy-remote.sh <user>@<server-ip>`，然后 `systemctl --user restart <unit>`。

查看日志：`journalctl --user -u memory-hub-staging.service -f`（JSON 行；不含口令/令牌/密钥）。

## 3. systemd unit（完整内容）

**staging**（已安装）`~/.config/systemd/user/memory-hub-staging.service`（模板：`deploy/memory-hub-staging.service`）：

```ini
[Unit]
Description=memory-hub (staging, parallel validation instance) on 127.0.0.1:7991
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/memory-hub
EnvironmentFile=%h/.config/memory-hub/staging.env
ExecStart=%h/.local/bin/node %h/memory-hub/bin/memory-hub.mjs serve
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target
```

**正式**（`cutover.sh prepare --execute` 生成）`~/.config/systemd/user/memory-hub.service`（模板：`deploy/memory-hub.service`，`@ENV_FILE@` 替换为 `%h/.config/memory-hub/prod.env`）：

```ini
[Unit]
Description=memory-hub (shared memory MCP + admin UI) on 127.0.0.1:7990, nginx serves /memory/
After=network-online.target tailscaled.service

[Service]
Type=simple
WorkingDirectory=%h/memory-hub
EnvironmentFile=%h/.config/memory-hub/prod.env
ExecStart=%h/.local/bin/node %h/memory-hub/bin/memory-hub.mjs serve
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target
```

实测：`systemctl --user restart` 后 PID 变化、数据与令牌完好；`kill -9` 主进程后 8 秒内被 systemd 拉起（`Restart=on-failure`），数据与令牌完好。

## 4. nginx

**结论：不需要改 nginx。** 现有两处（80 与 443）`location ^~ /memory/` 都是：

```nginx
    location ^~ /memory/ {
        proxy_pass http://127.0.0.1:7990;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Connection "";
        proxy_read_timeout 300s;
        proxy_buffering off;
    }
```

新服务以 `MEMORY_HUB_BASE_PATH=/memory` 监听 `127.0.0.1:7990`，就直接是这个反代的后端：`/memory/mcp`、`/memory/healthz`、`/memory/admin/`。需要配合的服务端设置（已写进 `prod.env`，见第 5 节）：

- `MEMORY_HUB_TRUST_PROXY=1`：按 `X-Forwarded-For` 区分来源（否则同机反代下所有客户端共用一个失败限流桶）、按 `X-Forwarded-Proto` 判断是否 https（决定 cookie 的 `Secure`）。
- `MEMORY_HUB_ALLOWED_HOSTS`：`Host: $host` 会把客户端访问用的主机名带过来，**不在白名单的 Host 一律 403**。默认值含 `<server>.<tailnet>.ts.net`、`<server>`、`<server-tailnet-ip>`。实测：白名单外 → 403，白名单内 → 200。
- `MEMORY_HUB_ALLOWED_ORIGINS`：管理界面登录/写操作的 Origin 白名单（http/https × 上述主机名）。

**可选加固（需要 sudo，人工确认后再应用）：只允许你的机器访问管理界面。** 管理界面经 nginx 的 `/memory/admin/` 暴露给能访问 58:80 的整个 tailnet（口令登录，80 端口是明文 HTTP，仅靠 WireGuard 加密）。如要收窄，在 80 与 443 两个 server 里、`location ^~ /memory/` **之前**各加一段（更长的前缀优先）：

```nginx
    # 示例：<your-tailnet-ip> 换成你自己机器的 tailnet 地址
    location ^~ /memory/admin/ {
        allow <your-tailnet-ip>;
        allow 127.0.0.1;
        deny all;
        proxy_pass http://127.0.0.1:7990;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Connection "";
        proxy_read_timeout 300s;
        proxy_buffering off;
    }
```

应用：先备份 `sudo cp /etc/nginx/sites-available/dsh-piweb /etc/nginx/sites-available/dsh-piweb.bak.$(date +%Y%m%d)`，改完 `sudo nginx -t && sudo systemctl reload nginx`。没有 sudo 的替代：不经 nginx，用 `ssh -L 17990:127.0.0.1:7990 <user>@<server>` 访问 `http://127.0.0.1:17990/memory/admin/`。

## 5. 环境文件键名清单（不含值）

`~/.config/memory-hub/{staging,prod}.env`，权限 0600，目录 0700（同内容见 `deploy/env.keys.txt`）：

| 键 | staging | prod |
|---|---|---|
| `MEMORY_HUB_HOME` | `~/memory-hub-data/staging` | `~/memory-hub-data/prod` |
| `MEMORY_HUB_HOST` | `127.0.0.1` | `127.0.0.1` |
| `MEMORY_HUB_PORT` | `7991` | `7990` |
| `MEMORY_HUB_BASE_PATH` | （空） | `/memory` |
| `MEMORY_HUB_TRUST_PROXY` | — | `1` |
| `MEMORY_HUB_ALLOWED_HOSTS` | — | tailnet 主机名、短名、IP（逗号分隔，不含端口） |
| `MEMORY_HUB_ALLOWED_ORIGINS` | — | 上述主机名的 `http://`、`https://` 形式 |
| `MEMORY_HUB_LOG_LEVEL` | `info` | `info` |
| `NODE_NO_WARNINGS` | `1` | `1` |
| `MEMORY_LLM_BASE_URL` | 蒸馏网关（OpenAI 兼容，不含 `/chat/completions`） | 同 staging（`prepare` 文件到文件拷贝） |
| `MEMORY_LLM_MODEL` | `deepseek-v4.1-flash` | 同 |
| `MEMORY_LLM_KEY` | 来自 DSH 凭据库的 `DEEPSEEK_API_KEY` | 同（文件到文件拷贝，不经终端） |

蒸馏配置的来源与注意：`MEMORY_LLM_BASE_URL` 必须与 DSH 里 `llm-deepseek` 的 `baseURL` 一致。**部署时我先误用 `api.deepseek.com` 试过一次，上游回 401（该 key 不是官方 DeepSeek key），随后改为 DSH 里配置的网关地址，蒸馏链路验证通过**——详见第 11 节"需要你知道的事"。

## 6. 并行验证实例：验证结果（全部对 staging，旧服务只被只读调用）

数据：旧库 sqlite backup API 快照（`backup ok 130 ms`，旧库原件只读打开）→ 拷到 staging 数据目录 → 新代码打开后 schema 0→2。

**a. 对账**（`memory-hub migrate verify --source <快照> --target <staging>`，7 项全 PASS，退出码 0）：`/healthz` → `{"ok":true,"version":"0.1.0","bind":"127.0.0.1"}`；cards 662→662，quarantine `deleted=253,pending=13` 两边相同；kind 分布逐项相同；内容指纹（`sha256(path|kind|title|tags|body|status)`）源 928 = 目标 928，缺 0 多 0；`card_sequence` 2101→2101，MAX(id)=2101；`integrity_check` ok（staging 自身与备份副本也各查一次）；audit_log 1585=1585。验证与压测产生的合成卡已清理后再对账，仍严格相等。

**b. 召回对账**（`scripts/validate/recall-parity.mjs`，54 条查询：30 条取自标题的前缀/中段/英文词 + 24 条手写，含 2 字中文、英文、混合、无结果、空串，每条 2 组参数）：
- (i) 旧实现 `search()`（`tests/fixtures/legacy` 逐字副本）vs 新实现 `search()`，同一份快照的两份拷贝：108 组 `(path, score, 顺序)` **差异 0**；102 组有命中，命中总数 1494。
- (ii) **线上旧 MCP 服务（只读 recall，令牌从文件读、不打印） vs staging 的 `memory_recall`**：54 条文本输出（路径、顺序、摘要）**相同 54、不同 0、HTTP 异常 0**。（MCP 输出不含分数，所以分数只在 (i) 里比。）

**c. MCP SDK 客户端实测**（`scripts/validate/mcp-clients.mjs`，58 上 `/tmp/memory-hub-clients` 装 `@modelcontextprotocol/client@2.3.1`、`@modelcontextprotocol/sdk@1.32.1`，连 `http://127.0.0.1:7991/mcp`）：**25/25 PASS**。覆盖 v2（2026-07-28 `server/discover` 握手）、v2（2025 `initialize` 握手）、v1.32.1 三种客户端各自：读写令牌 `tools/list`（6 个工具）、`memory_recall`、`memory_capture`（合成文本，走蒸馏，`degraded=false`，验证后删除）、`getInstructions()` 非空；只读令牌 `tools/list` 不含 `memory_capture` 且调用被拒（`Insufficient scope: required "write"`）；无令牌 / 已吊销令牌连接被拒（HTTP 401）；裸 HTTP：无令牌 401、吊销 401、只读调写 403。

**蒸馏链路**（合成文本，经 `memory_capture`）：产出卡 `kind=knowledge`、tags 为 5 个蒸馏标签（不是 `content`/`raw`），`degraded:false`；验证后已在 staging 库删除。

**d. 管理界面**（ssh 端口转发 `-L 17991:127.0.0.1:7991` + 本机 headless Chrome，`scripts/validate/admin-shots.mjs`）：登录 → 总览 / 卡片列表（20 行）/ 卡片详情 / 待审队列（13 行 = pending 13）/ 回收站 / 令牌 / 活跃度 7 张截图，控制台与 CSP 问题 0。截图含真实数据，只存在本机 `~/memory-hub-dev/screenshots-58/`，不进仓库。转发进程用完已杀并用 PID 核实退出。另在本机合成数据上验证了管理界面在 `BASE_PATH=/memory` 下可用（7 页截图、0 控制台问题），因为正式环境走这个前缀。

**e. 并发与资源**（`scripts/validate/load.mjs`，合成数据，30 秒；旁观旧服务同时被采样）：

| 场景 | 请求 | 错误 | recall p50 / p95 / max | capture p50 / p95 | 新服务 RSS |
|---|---|---|---|---|---|
| 8 并发（贴近真实使用） | 92 | 0 | 1.15 s / 3.24 s / 5.5 s | 14.6 s / 17.6 s（含一次 LLM 蒸馏调用） | 248→260→257 MB |
| 40 并发（压力） | 176 | 13（7.4%，全为 recall 的 `ECONNRESET`） | 5.2 s / 26.4 s / 29.8 s | 33.8 s / 39.2 s | 257→263→257 MB |

**旧服务延迟（recall，ms，p50 / p95）**：压测前 231 / 263 → 压测中 226 / 238 → 压测后 224 / 234（8 并发那轮）；40 并发那轮 231 / 245 → 229 / 274 → 226 / 245。**旧服务不受影响**（0 错误）。

⚠ **性能发现（需要你知道，见第 11 节）**：单次 recall 本身就要约 230 ms（线上旧服务是同样的数，因为是同一套检索算法逐字沿用），而且在事件循环里同步计算，所以服务吞吐上限约 3–4 次 recall/秒；并发一多，延迟线性堆积；极端堆积时客户端看到 `ECONNRESET`（**推断**为 Node 默认 5 秒 `keepAliveTimeout` 关掉了排队中的 keep-alive 连接，未单独验证）。对"几个 Agent 偶尔查询"的真实负载无碍，但 40 并发是压力测试，不是日常。

**f. 备份**：`memory-hub backup now` 生成 `backups/memory-eternal-<时间>.db`（0600，6.09MB），副本 `integrity_check`=ok，cards 662 / quarantine 266 与库一致；`migrate verify` 备份 vs 库 PASS；用备份在临时目录恢复（拷成库文件 → 新代码打开 → 对账）PASS。**自动备份在跑**：服务内置调度器（无 systemd timer），启动 30 秒后检查，距上次备份超过 24 小时就备份并清理回收站过期项（日志 `每日备份完成`）；保留最近 7 份。⚠ PLAN 验收里的 `backup restore <file> --dry-run` **子命令未实现**，恢复按第 9.3 节手工步骤。

**g. 重启恢复**：`systemctl --user restart` 前后：cards 662 / quarantine 266 / seq 2136 / 令牌 3 条不变；读写令牌 `tools/list`=200，只读令牌调写=403，吊销令牌=401，healthz=200，全部不变。`kill -9` 后自动拉起，同样不变。

**日志泄密检查**（服务 journal 共 106 行）：`mh_` 令牌形状 0；LLM key 全文 0；管理员口令全文 0；三枚测试令牌全文各 0。⚠ 唯一例外：修复前那次误用 `api.deepseek.com` 时，上游 401 的错误体里带 key 的**掩码尾号 4 位**，被写进了 journal（3 处出现 4 字符子串，含其它偶然匹配）。已修复代码（上游错误体进日志前脱敏，有测试），但 journal 里已写的那几行无法单条删除（只能 `journalctl --user --vacuum-*` 影响该用户全部 user 服务日志，我没动）。

## 7. 切换步骤（≤15 分钟窗口；脚本 `scripts/cutover.sh`，在 58 上运行）

通用：所有脚本默认 dry-run；`--execute` 才动手。**脚本不需要 sudo。** 下文 `$C` = `bash ~/memory-hub/scripts/cutover.sh`。

### 7.0 阶段 0：备份现状（切换前一天内做，我或你）

```bash
mkdir -p -m 700 ~/memory-hub-data/pre-cutover-backup && cd ~/memory-hub-data/pre-cutover-backup
cp -p ~/.claude.json claude.json.58 ; cp -p ~/.claude/settings.json claude-settings.json.58 ; cp -p ~/.config/mcp/mcp.json mcp.json.58
cp -p ~/.config/systemd/user/memory-mcp-http.service . ; cp -p ~/.config/systemd/user/memory-eternal-proxy.service .
cp -p /etc/nginx/sites-available/dsh-piweb nginx-dsh-piweb      # 只读复制
cp -p ~/.dsh/profiles/web/cordis.patch.yml ~/.dsh/profiles/web/package.json .
tar czf memory-eternal-plugin.tgz -C ~/.dsh/profiles/web/node_modules memory-eternal   # 旧插件回滚包
chmod 600 *
```
Mac 侧同理备份 `~/.claude.json`、`~/.claude/settings.json`、`~/.codex/config.toml`。

### 7.1 阶段 1：准备（不影响线上）

```bash
$C preflight                 # 只读体检：node、旧库、旧令牌文件长度、持有旧库句柄的进程、nginx /memory/ 目标
$C prepare --execute         # 生成 ~/memory-hub-data/prod、prod.env（蒸馏三项从 staging.env 文件到文件拷贝）、prod-admin-password、memory-hub.service
```
期望：`已生成 …/prod.env（0600）；键：MEMORY_HUB_HOME,…,MEMORY_LLM_KEY；MEMORY_LLM_KEY 是…拷贝的，未显示`；`已写入 …/memory-hub.service 并 daemon-reload（未 enable、未启动）`。

### 7.2 阶段 2：冻结旧写入方（**你来做**；脚本只停旧 MCP 服务）

写入旧库的有：
1. **DSH 内的 memory-eternal 插件**（`autoCapture` 进程内直写库；它还拉起 7999/8000 旧面板，面板有写接口）：在 DSH 里停用该插件并按需重启 DSH（插件清单 `requiresRestart:true`）。**注意：这是切换窗口里最慢的一步。**
2. 58 上 Claude Code 的 `SessionEnd` hook（`…/memory-eternal/hooks/capture.mjs claude`）与 stdio `memory` 条目（`~/.claude.json`、`~/.config/mcp/mcp.json`）——摘掉（第 8.3 节）。
3. Mac 上的 SessionEnd hook（经 HTTP 走旧 7990，旧 7990 一停自然失效，但 hook 会反复报错，建议同时摘掉，第 8.1 节）。

确认冻结（持有旧库句柄的进程应为空，旧 MCP 服务本身由脚本第 1 步停掉）：
```bash
$C preflight | sed -n '/持有旧库/,+4p'
```
期望（冻结前）：`当前持有旧库句柄的进程…pid <DSH 的 pid>`；（冻结后）：`没有进程持有旧库句柄`。

### 7.3 阶段 3：切换

```bash
$C cutover --frozen-ack          # 先 dry-run，看清楚每一步
$C cutover --execute --frozen-ack
```
脚本做的 9 步（每步失败即停；**若新服务尚未启动就失败，会自动重启旧服务**）：

| # | 步骤 | 期望输出（节选，来自 58 上的演练） |
|---|---|---|
| 1 | 停旧 MCP 服务并 `disable`（不卸载、不删文件） | `+ systemctl --user stop memory-mcp-http.service` |
| 2 | 检查无进程持有旧库 | `OK：无进程持有旧库`（否则中止，除非 `--allow-holders`） |
| 3 | 旧库最终快照（backup API，原件只读）+ 快照 vs 旧库原件对账 | `backup ok 138 ms`；`快照 integrity_check=ok sha256=… 大小=…`；`RESULT: PASS` |
| 4 | 拷入 `~/memory-hub-data/prod/` + 对账（新代码尚未打开，应逐项相等） | `RESULT: PASS` |
| 5 | 设管理员口令（从口令文件 stdin）；`token import-hash --name legacy-shared --scope read,write --expires 14d --from-file <旧令牌文件>` | `已导入：legacy-shared（legacy…） scope=read,write 过期=<14 天后>`；`只保存了 sha256；旧令牌明文未被打印或存储。` |
| 6 | 启动 `memory-hub.service`（7990，`/memory`）并 `enable` | `healthz：{"ok":true,"version":"0.1.0","bind":"127.0.0.1"}`（带 `version` = 新服务；旧服务的 healthz 没有 `version`） |
| 7 | 再对账（新代码升级 schema 后，允许新库多出） | `RESULT: PASS` |
| 8 | 冒烟：旧令牌直连 tools/list、带 `Host`/`X-Forwarded-For` 头模拟 nginx、经 nginx(80)、无令牌、管理界面首页 | `HTTP 200`、`HTTP 200`、`HTTP 200`、`HTTP 401`、`HTTP 200` |
| 9 | 写切换记录 `~/memory-hub-data/cutover/<时间戳>/state.env`，`latest` 软链 | `已记录 …/state.env` |

### 7.4 切换后验证（你或我）

```bash
curl -s http://127.0.0.1:7990/memory/healthz                  # {"ok":true,"version":"0.1.0","bind":"127.0.0.1"}
systemctl --user status memory-hub.service --no-pager | head -5   # active (running)
journalctl --user -u memory-hub.service -n 5 --no-pager        # memory-hub listening … "llm":{"configured":true,…}
# Mac 上（令牌来自你自己保管的旧令牌文件，不要打印）：
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $(cat <旧令牌文件>)" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://<server>.<tailnet>.ts.net/memory/mcp    # 200
```
管理界面：`http://<server>.<tailnet>.ts.net/memory/admin/`，口令在 58 的 `~/.config/memory-hub/prod-admin-password`（登录后可在"账户"页改密）。再按手册第 8 节完成客户端侧，并在管理界面"令牌"页为每个客户端创建独立令牌。

### 7.5 阶段 4：观察期（建议 7 天）

旧服务保持 `stop`+`disable`、文件不动；监控 `journalctl --user -u memory-hub.service -p warning`、管理界面"活跃度/审计"；每日备份正常（`ls -l ~/memory-hub-data/prod/backups/`）。`legacy-shared` 令牌 14 天后自动过期，之前换发完独立令牌并 `memory-hub token revoke legacy-shared`。

## 8. 客户端侧：由用户自己做（我没有改任何客户端配置）

先在 58 上为每个客户端创建独立令牌（明文只显示一次，立刻存好）：
```bash
set -a; . ~/.config/memory-hub/prod.env; set +a
node ~/memory-hub/bin/memory-hub.mjs token create --name mac-claude-code --scope read,write --expires 90d 2>/dev/null   # 明文在 stdout
node ~/memory-hub/bin/memory-hub.mjs token create --name mac-codex        --scope read,write --expires 90d 2>/dev/null
node ~/memory-hub/bin/memory-hub.mjs token create --name 58-claude-code   --scope read,write --expires 90d 2>/dev/null
```
（或用管理界面"令牌"页创建。过渡期里 Mac 不改配置也能用旧令牌连上，署名是 `legacy-shared`。）

### 8.1 Mac 的 Claude Code
```bash
claude mcp remove memory -s user                # 旧条目（~/.claude.json 顶层 mcpServers.memory）
claude mcp add --transport http -s user memory \
  http://<server>.<tailnet>.ts.net/memory/mcp \
  --header "Authorization: Bearer <mac-claude-code 的令牌>"
claude mcp list                                  # memory: ✓ Connected
```
URL 不变，所以只换令牌也行；换发后旧令牌即可废弃。**移除旧 SessionEnd hook**：编辑 `~/.claude/settings.json`，删除 `hooks.SessionEnd` 里指向 `…/memory-eternal/hooks/capture.mjs` 的条目（Mac 与 58 各一份；`PreToolUse` 的 `secret-guard.mjs` 见第 10 节，别误删或误留）。

### 8.2 Mac 的 Codex
`~/.codex/config.toml`：
```toml
[mcp_servers.memory]
url = "http://<server>.<tailnet>.ts.net/memory/mcp"
bearer_token_env_var = "MEMORY_HUB_TOKEN"     # 令牌放进环境变量（如 shell profile / 钥匙串导出），不要写进 toml
```
替换原来的 `http_headers = { Authorization = "Bearer …" }`（明文令牌）写法。

### 8.3 58 上的 Claude Code 与 MCP 聚合配置
- `/home/<user>/.claude.json` 的 `mcpServers.memory` 由 stdio 改为 HTTP 回环（避免 stdio 直连 DB 多写入者）：
  `claude mcp add --transport http -s user memory http://127.0.0.1:7990/memory/mcp --header "Authorization: Bearer <58-claude-code 的令牌>"`
- `~/.config/mcp/mcp.json` 的 `memory`（stdio）与 `memory-remote` 两条：同样改成 HTTP + 各自令牌（**谁在读这个文件仍未确认**，改之前先确认）。
- 摘掉 `~/.claude/settings.json` 的 `SessionEnd` hook（沉淀只靠 MCP `memory_capture`）。

### 8.4 撤销旧令牌
全部客户端换完后：`memory-hub token revoke legacy-shared`（立即生效，之后旧令牌 401）。旧令牌明文还留在各客户端配置、shell 历史、`~/.dsh/memory-mcp-http/token` 里，应视为已废弃；旧服务不再运行，该文件可在观察期结束后归档。

## 9. 回滚

### 9.1 脚本回滚（任何阶段，目标 ≤10 分钟）
```bash
$C rollback                       # dry-run：显示新库相对旧库有多少新增/变更卡
$C rollback --execute             # [--prune-purged]：新库里被永久删除的卡也在旧库删除（默认保守，不删）
```
做的事：① 停 `memory-hub.service` 并 `disable`；② 检查无进程持有旧库；③ `migrate reverse --execute`：先用 backup API 给旧库**留底**（`pre-reverse-<时间>.db`，0600，在旧库同目录），再单事务把新库期间新增/变更的卡（含跨表搬家：审批、软删）、card_updates、audit_log、feedback 导回旧库，`card_sequence` 取两边较大值，同时导出增量 JSON（`~/memory-hub-data/cutover/rollback-delta-*.json`，含正文，0600）；回滚后用 `migrate verify` 对账；④ `enable`+启动旧 `memory-mcp-http.service`，检查 healthz 无 `version`、旧令牌 tools/list=200；⑤ 新数据目录改名为 `prod.rolledback-<时间>`（不删）。**旧库 schema 不被升级**（`user_version` 仍为 0，不加新表），旧代码照常读写。

演练（58 上，旧服务替身是线上旧代码 + 副本库）：切换后用旧令牌 capture 一张、批准一张原待审卡、对一张已批准卡追加更新并软删、新增一张已批准卡 → 回滚：`新增 1；变更 1`（含批准与软删）→ **旧服务（线上旧代码）能 recall 到新增的已批准卡**；旧库仍是旧 schema；"回滚前的新库 ⊆ 回滚后的旧库"对账 PASS；旧库回滚后**重新切换**，"回滚前的新库 ⊆ 新的新库"PASS（卡一张不少）。

### 9.2 两种情况的取舍
- **新库未收到任何写入 / 切换窗口很短**：最简——停新服务、起旧服务（脚本在 `reverse` 阶段会显示 `新增 0；变更 0`，等价于什么都不导）。旧库原件在整个切换期间没被新代码碰过。
- **新库已收到写入**：必须 `migrate reverse` 把增量补回旧库，再起旧服务，否则这期间 Agent 沉淀的卡、你在界面上做的审批/编辑会丢失（它们仍保留在 `prod.rolledback-*` 目录与增量 JSON 里，可事后再导）。

### 9.3 手工恢复备份（`backup restore` 子命令未实现）
```bash
systemctl --user stop memory-hub.service
cd ~/memory-hub-data/prod && mkdir -p -m 700 ../prod.before-restore && cp -p memory-eternal.db* ../prod.before-restore/
rm -f memory-eternal.db-wal memory-eternal.db-shm
cp -p backups/memory-eternal-<时间>.db memory-eternal.db && chmod 600 memory-eternal.db
node ~/memory-hub/bin/memory-hub.mjs migrate verify --source backups/memory-eternal-<时间>.db --target . | tail -1    # RESULT: PASS
systemctl --user start memory-hub.service
```

### 9.4 若你已把插件从 DSH 移除后才要回滚
按阶段 0 的备份还原 `package.json`、`cordis.patch.yml` 两处并恢复插件目录（`memory-eternal-plugin.tgz`），重启 DSH；客户端配置与 hook 按第 8 节反向还原。

## 10. DSH 插件下线前的检查清单（**必须先切换、后卸载**）

> ### ⚠ 醒目提示：卸载 DSH 的 memory-eternal 插件会让 `secret-guard.mjs` 失效
> 58 上 `~/.claude/settings.json` 的 `PreToolUse` hook 指向 `…/memory-eternal/hooks/secret-guard.mjs`（阻止 Agent 读凭据文件）。它与记忆无关，却寄居在插件目录里。**卸载插件后，这道保护会悄然失效，或 hook 命令报错影响工具调用（行为未确认）。** 用户已决定 secret-guard 迁移"先不管"——但下线前请二选一：①把脚本拷到独立位置并改 hook 路径；②接受它失效并先把该 hook 条目从 settings.json 删掉。**两者都不做就卸载 = 保护静默消失。**

清单（逐项，顺序重要）：
1. ☐ 切换已完成，新服务稳定运行 ≥ 观察期（建议 7 天）；`legacy-shared` 已撤销或到期。
2. ☐ 旧 `memory-mcp-http.service` 已 stop+disable（脚本做了）；**它的代码与 SDK 都来自 `~/.dsh/profiles/web/node_modules`（`~/.dsh/memory-mcp-http/node_modules` 是指向它的软链）——插件目录一删，旧服务立即启动失败**。所以回滚能力（第 9 节）随插件目录一起消失：卸载前先打好 `memory-eternal-plugin.tgz`（阶段 0）。
3. ☐ **secret-guard**：见上方警示框。
4. ☐ 58 上 Claude Code 的 stdio `memory` 条目、`~/.config/mcp/mcp.json` 的 stdio `memory` 条目已改为 HTTP（卸载后会指向不存在的路径）；SessionEnd hook 已摘除。
5. ☐ DSH 进程内的 `memory_recall` 工具 / 系统提示注入 / 自动沉淀会消失——**DSH 里的 Agent 将失去记忆能力**（`source=deepseek-harness` 的卡约占线上 94.6%，是目前最主要的入库通道）。DSH 能否作为 MCP 客户端接新服务**仍未验证**；沉淀今后只能靠各 Agent 主动调用 `memory_capture`。需要你确认接受。
6. ☐ 从 DSH 移除：`package.json:25` 依赖、`:41` bundle 条目、`cordis.patch.yml:309` 起的 `memory-eternal` 条目（先备份）；重启 DSH。
7. ☐ 旧面板 7999/8000（DSH 子进程，无鉴权写接口）已随插件下线停止；停用并删除 `memory-eternal-proxy.service`（7998 → 7999 的 tailnet 代理）；`tailscale-web-entry.mjs` 里 ME 相关分支可选清理（缺失时代码自带 502，无其它影响）。
8. ☐ 归档（不立即删）：`~/.dsh/memory-eternal-config.json`、`…-config.host.json`、`memory-eternal-capture.jsonl`、`memory-vault/memory-eternal-graph-cache.json`；旧库原件改名 `memory-eternal.db.retired-<日期>` 保留至少一个备份周期。
9. ☐ 还有没有别的机器/设备/程序连旧 MCP——本阶段只核实了 Mac 与 58。

## 11. 已知风险、需要你知道的事、未完成

**需要你拍板 / 知情**
1. **一次误发 key**：蒸馏配置我最初猜了 `api.deepseek.com`（DSH 的 `baseURL` 在 `cordis.patch.yml` 里，我没先读到），把 DSH 凭据库里的 `DEEPSEEK_API_KEY` 发给了 DeepSeek 官方端点一次（直到我改用 DSH 配置的网关地址之前，staging 上的 capture 都是这样发的；journal 里有对应的 401 记录），上游回 401"key invalid"——该 key 并非官方 DeepSeek key（25 字符），很可能是内部网关的 key。风险较低，但如果你想保险起见可以轮换它。
2. **recall 吞吐/延迟**（第 6.e 节）：单次约 230 ms，同步占用事件循环，吞吐上限约 3–4 次/秒；40 并发时延迟堆到 25 秒级并出现 `ECONNRESET`（推断为 keep-alive 5 秒超时，未单独验证）。这是沿用上游检索算法的结果，线上旧服务同样如此。我**没有改代码**（算法优化会碰 PLAN 里"召回对账逐位相同"的约束；`keepAliveTimeout` 调大是一行改动）。建议：先调 `server.keepAliveTimeout`（一行、安全），算法侧按 PLAN 9.1 #12 留给 M5（FTS5 预筛，或缓存每卡 bigram 集合并保证分数不变）。要不要现在做，请你定。
3. **审核模式 `all`**：线上库 `auditMode=all`，所有新沉淀的卡先进待审队列，批准前 `memory_recall` 搜不到。切换后 Agent 沉淀的卡需要你在管理界面批准（或按 PLAN 9.1 #7 配免审）。
4. **管理界面暴露面**：经 nginx 80 端口（明文 HTTP）对整个 tailnet 可达，口令登录；建议用第 4 节的 `allow/deny` 加固（需要 sudo）或只走 ssh 隧道。
5. **DSH 内 Agent 失去记忆能力**（第 10 节 #5）与 **secret-guard**（第 10 节警示框）。
6. **服务 journal 里残留一个 key 尾号**（第 6 节"日志泄密检查"）。

**未完成 / 未验证（明说）**
- **`backup restore` 子命令未实现**（只有 `backup now`）；已给手工恢复步骤并做了一次"备份 → 临时库 → 对账"演练。
- **tidy 干跑 `planId` 与旧代码一致**（PLAN 6.3.2 末项）：旧实现的 tidy 不在 `tests/fixtures/legacy` 里，**未做**。
- **两个不同 Agent 同时 capture+recall 并在管理界面看到两个署名、吊销其中一个立即 401**：本次 SDK 实测用的是同一枚令牌；吊销即时生效已验证（吊销令牌=401），多署名由 M1 测试覆盖，未在 58 上用两枚令牌再演一遍。
- **真实客户端（Mac 的 Claude Code / Codex）连 58 的新服务**：未做（按任务约束不碰客户端配置）；用 SDK 客户端代替。
- **经真实 nginx 的路径**：本阶段不改 nginx、也没有在 7990 上放新服务，所以"经 nginx(80/443) 访问新服务"只在切换脚本第 8 步（切换当天）才会真实走到；演练里用 `Host`/`X-Forwarded-For` 头模拟了 nginx 的转发行为。
- **443 证书对客户端是否可信**（PLAN 9.1 #10）：未确认；Mac 客户端目前走 80 端口明文 HTTP（靠 tailnet 的 WireGuard 加密）。
- **变异测试**（PLAN 7 的通用纪律）：本次新增代码（`import-hash`、`migrate`）先写失败测试再实现，但**没有跑变异测试**；`cutover.sh` 的沙箱测试是脚本写完后补的（调试中靠它发现并修了 4 个缺陷），不是严格的"红测试在先"。
- 异机备份：按决策暂不做。58 是否有机器级备份：未确认。

## 12. 演练与复现

- 单元/集成测试：`npm test`（289 全绿；新增：`tests/token-import-hash.test.mjs`、`tests/migrate.test.mjs`、`tests/cutover-script.test.mjs`、`tests/capture-llm.test.mjs` 的脱敏用例）。
- 在 58 上不碰线上地完整演练：`bash ~/memory-hub/scripts/rehearse-cutover.sh run`（端口 7993，约 1 分钟；结尾 `REHEARSAL PASS` 并自动清理；失败保留现场）。**正式切换前建议再跑一遍**。演练脚本里的"旧服务替身"是线上旧 `server.mjs` 的拷贝 + 副本库 + 随机令牌，用 systemd-run 临时 unit 运行，不碰线上目录。
- 验证脚本：`scripts/validate/{recall-parity,mcp-clients,admin-shots,load}.mjs`。

## 13. 切换记录

**状态：切换已完成（2026-10-15，带 DSH 硬切）。** 新服务 `memory-hub.service`（enabled/active，127.0.0.1:7990，`/memory`）取代旧 `memory-mcp-http.service`（inactive/disabled，unit 与代码未卸载）。`memory-hub-staging.service` 已停止并 disable，数据 `~/memory-hub-data/staging/` 保留。nginx 未改，全程未用 sudo。

**回滚（一条命令，在 58 上）：** `bash ~/memory-hub/scripts/cutover.sh rollback --execute`（新库增量会先 `migrate reverse` 回旧库；旧库原件切换期间只读打开，从未被新代码触碰）。

**时间线与基线（UTC）**

| 项 | 值 |
|---|---|
| 切换批次目录 | `~/memory-hub-data/cutover/20261015T131443Z`（`latest` 软链），快照 sha256 前缀 `d4fd862b0308b0f1`，5996544 字节 |
| 新服务 PID | 切换时 2886913；验证中 `systemctl --user restart` 后 2887875，NRestarts=0 |
| 切换前一刻旧库（13:14:42） | cards=662，MAX(id)=2038，quarantine deleted=253 / pending=21，`card_sequence.seq`=2109，旧库 WAL=4185952 字节（mtime 13:09:11） |
| 最终快照（13:14:43，backup API） | cards=662，MAX(id)=2038，deleted=253 / pending=21，seq=2109，integrity ok |
| 旧令牌 | 以 `legacy-shared`（read,write）仅存哈希导入，2026-10-29T13:15:03Z 过期 |

**窗口期写入（DSH 未冻结，按 `--allow-holders --frozen-ack` 硬切）：** 切换时持有旧库的 DSH 主进程与 7999/8000 旧面板仍在运行。快照之后它们写入旧库的内容**不在新库**，仍留在旧库原件里，需事后补导。观察期（至 13:30）旧库变化：seq 2109→2110，pending 21→22（均为待审队列新增，cards 与 deleted 不变），WAL mtime 13:17:46。粗略速率：12:57→13:30 共 +4 张（约每 8 分钟 1 张，均落入 quarantine pending）。DSH 下线前每多拖一分钟约多 0.1~0.15 张卡落在新库之外。

**验证摘要（均为 58 / Mac 上的真实命令输出）**
- 切换脚本 9 步全部通过：快照 vs 旧库原件、快照 vs 新数据目录、新代码升级 schema 后再对账均 `RESULT: PASS`；旧令牌 tools/list 直连 / 带 Host 头 / 经 nginx(80) 均 200，无令牌 401，管理界面首页 200。
- 经真实 nginx（Mac 经 tailnet 域名）：80 与 443 的 `/memory/healthz`=200、`/memory/admin/`=200、无令牌 tools/list=401、legacy-shared tools/list=200（6 个工具）、memory_recall=200。443 证书对 Mac 的 curl 校验通过（`ssl_verify_result=0`，未加 `-k`）。
- 数据：新库 cards=662、deleted=253、pending=21、seq=2109，与快照逐项相同；新库 integrity_check=ok，`user_version`=2。
- recall：30 条（取自旧库标题前缀）切换前旧服务 vs 切换后新服务（经 nginx 80）响应指纹 30/30 相同；重启后再比 30/30 相同。
- 真实 Claude Code（`claude -p`，`--mcp-config` + `--strict-mcp-config` + `--setting-sources project`，令牌走环境变量）：memory_recall 调用成功，返回 5 条，无 permission denial。
- 重启恢复：`systemctl --user restart` 后 PID 变化，数据、令牌、healthz、recall 均不变。未做 `kill -9`。
- 管理界面：经 nginx 登录，7 页截图（总览/卡片/详情/待审/回收站/令牌/活跃度），控制台问题 0；截图只存本机仓库外目录。
- 观察 15 分钟：新服务 journal ERROR=0、WARN=0；RSS 约 85MB 稳定；401 仅来自验证时的无令牌探测（Mac 与回环），无其它来源客户端的 401。

**未完成（用户侧）：** 冻结/下线 DSH memory-eternal 插件与旧面板、Mac 与 58 的客户端配置、旧 SessionEnd hook 移除、`legacy-shared` 撤销、窗口期旧库新增卡的补导。

# M2 管理界面（只读）说明

日期：2026-10-15。**M3 起已有写接口，见 `docs/m3-admin.md`；本文件描述 M2 交付时的只读状态。** 范围以 PLAN.md 第 5、7 节为准；写操作（编辑/软删/恢复/审批/整理 apply/令牌创建与吊销界面）属 M3，**本里程碑没有任何写接口**（登录/登出除外）。

## 启动与首次设置管理员口令

```
export MEMORY_HUB_HOME=<数据目录>            # 或 MEMORY_HUB_DB 指向既有 memory-eternal.db
memory-hub admin set-password                # 终端：交互输入两次，不回显；管道：读 stdin 第一行。至少 10 个字符
printf '%s\n' "$PW" | memory-hub admin set-password   # 非交互（口令不要写进命令行参数，否则会被拒绝）
memory-hub serve                             # 默认 127.0.0.1:7990
# 浏览器打开 http://127.0.0.1:7990/admin/   （/ 与 /admin 都会 302 到 /admin/；设了 MEMORY_HUB_BASE_PATH 则在该前缀下）
```
- 口令以 scrypt（N=2^16, r=8, p=1，参数写在哈希里）存 DB `config` 表键 `adminPasswordHash`；换口令会使所有既有会话失效；服务无需重启即可生效。
- 未设口令：登录返回 503 并提示该命令；服务启动时打一条 WARN（PLAN 3.3 写的是 ERROR，这里降为 WARN，因为仅用 MCP 的部署是合法的）。
- 会话：cookie `mh_sid`，`HttpOnly; SameSite=Strict; Path={base}/admin`，仅在经 https 反代（`MEMORY_HUB_TRUST_PROXY=1` 且 `X-Forwarded-Proto: https`）时加 `Secure`；空闲 8 小时 / 绝对 7 天过期；库里只存会话 id 的 sha256。
- 登录失败限流：同一来源 15 分钟内 5 次失败 → 429 + Retry-After；全局 40 次。nginx 反代后需 `MEMORY_HUB_TRUST_PROXY=1` 才能按真实来源区分。
- CSRF：非 GET 请求需 `X-CSRF-Token`（= HMAC(会话哈希)，由 `GET /session` 与登录响应给出）+ Origin 同源校验；目前只有 `POST /logout` 用到，M3 写接口直接复用。
- 真实浏览器实测：`node tests/e2e/admin-screenshots.mjs <baseUrl> <口令文件> docs/screenshots/m2`（headless Chrome + CDP，无额外依赖）。

## 页面（#/ 哈希路由，中文）
登录 · 总览 · 卡片（检索/过滤/排序/分页）· 卡片详情 · 待审队列 · 回收站 · 标签 · 整理预览 · 健康报告 · 沉淀活跃度 · 令牌 · 审计日志。

## API（均需会话 cookie；`GET`，除注明）
| 路径 | 说明 |
|---|---|
| `GET /admin/api/graph`（M4） | 知识图谱数据（只读，不含正文），见 `docs/m4-graph.md` |
| `POST /admin/api/login` / `POST /logout`(CSRF) / `GET /session` | 认证；未登录一律 401，body 带 `passwordSet` |
| `/overview` | 总数、kind 分布、隔离区、30 天曲线、vault/备份、署名分布、最近日志、告警 |
| `/facets` | kind / 署名 / 来源 / 状态 / 标签的可选值与计数 |
| `/cards` | `q status kind tag(逗号=AND) agent(__none__=submitted_by 为空) source createdFrom/To updatedFrom/To sort order limit(≤200) offset`；q 与 memory_recall 同一打分 |
| `/card?path=` | 详情：正文、标签、来源、署名令牌状态、更新记录、修订历史、状态流转、写入审计、回收站剩余天数 |
| `/queue` `/recycle` | 待审/驳回；回收站（带 daysLeft） |
| `/tags` | 频次、疑似同义组、一次性标签 |
| `/tidy/preview` | 只调用 tidyPlan；无 apply 入口 |
| `/lint` | tidyLint + 主库不变量 + 备份 |
| `/activity` | 按署名的 capture/recall、最近时间、只读不写/闲置令牌/积压告警 |
| `/tokens` | 名称、范围、创建/过期/最后使用/吊销；无哈希无明文 |
| `/write-log` | write_log 检索（不含参数摘要） |

## 安全要点
- 响应头（含 401/404/错误）：CSP `default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'…`（无 unsafe-*），nosniff，no-referrer，X-Frame-Options DENY，COOP/CORP。`/mcp`、`/healthz` 响应不受影响。
- 疑似明文密钥：详情/摘要/更新记录/修订里命中处替换为 `[已遮蔽:类型]`（`tidy.redactSecrets`，与 detectSecrets 同规则）；整理预览与 lint 只给路径与类型；测试用植入的假密钥/令牌哈希/口令哈希/会话 id 遍历所有端点断言不出现。
- 前端：`dom.js` 只创建文本节点，禁止 on*/style/src 属性，href 仅 http(s)/站内哈希；`markdown.js` 自写子集，没有“原始 HTML”节点类型，链接白名单，解析有界；测试禁用 innerHTML 等并用假 DOM 验证；真实浏览器验证 XSS 卡（`window.__xss` 未触发，0 个 script/img/on* 属性）。

## 沉淀活跃度的数据缺口（如实）
write_log 自 M1 才有；此前的 recall/capture 没有日志（用卡片 submitted_by 反推，页面单独列出）；不记 skipped 的原因、不记 recall 命中数；stdio 身份是自报；审批时延只来自 audit_log。页面底部同样展示这些说明。

## 对 M1 的改动
- 唯一改动的 M1 测试：`tests/http-auth.test.mjs`「非 MCP 路径一律 404」——M2 起 `/admin/api/*` 存在，Agent 令牌访问返回 401（其余未知路径仍 404）。
- `tidy.js` 新增导出 `redactSecrets`；`vault.js` 新增导出 `RECYCLE_RETENTION_DAYS`（=30，调度器与界面共用）；`server.js` 挂管理路由并在定时任务里清理过期会话。MCP 行为未改。

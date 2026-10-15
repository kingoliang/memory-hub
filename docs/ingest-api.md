# 会话文本摄入 API

供客户端插件 / hook 在每轮或会话结束时把对话增量文本推给 hub，由 hub 剥噪声、蒸馏、去重后入库（新卡按库内 `auditMode` 进待审队列）。复用 `memory_capture` 的同一条沉淀管线（`src/core/capture-run.js`），不是第二套逻辑。

## 请求

`POST {basePath}/api/ingest`（`basePath` 取 `MEMORY_HUB_BASE_PATH`；代码默认空，58 上为 `/memory`，即 `/memory/api/ingest`）

```
Authorization: Bearer <令牌>        # scope 需含 write（write 或 tidy:apply）；read-only 令牌 → 403
Content-Type: application/json
```

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `source` | string | 是 | 1~64 字符，如 `dsh` / `pi-web` / `claude-code`；卡片 `source` 记为 `ingest:<source>` |
| `session_id` | string | 是 | 1~200 字符；冷却与幂等按 (令牌, session_id) |
| `text` | string | 是 | ≤ 65536 字符；客户端已拼好的 user/assistant 增量文本，带角色前缀（如 `用户：` / `助手：`） |
| `project` | string | 否 | ≤ 200 字符，仅写日志 |
| `cwd` | string | 否 | ≤ 1024 字符，仅校验，不入库不入日志 |
| `from_seq` / `to_seq` | 非负整数 | 否 | 本批覆盖的消息序号；`from_seq ≤ to_seq`；`to_seq` 用作幂等键 |

请求体上限 256KB（`MEMORY_HUB_INGEST_MAX_BODY_BYTES`）。署名（`submitted_by`）恒为令牌名，管理台待审卡详情已展示署名与令牌状态。

## 响应与状态码

所有业务结果都是 HTTP 200 + JSON `status`；HTTP 非 200 仅用于协议 / 鉴权 / 校验错误与服务端故障。

| HTTP | 场景 | body |
|---|---|---|
| 200 | `captured` | `{"status":"captured","cards":[{"id":123,"action":"created"\|"appended","pending":true}],"degraded"?:true}` |
| 200 | `deferred`（**未处理，不消耗任何东西**） | `{"status":"deferred","reason":"too_short"\|"cooldown"\|"daily_quota"\|"in_progress","retry_after_s"?:N}` |
| 200 | `skipped` | `{"status":"skipped","reason":"noise_only"\|"not_durable"\|"duplicate_pending"\|"unusable"}` |
| 200 | `rejected`（含疑似明文密钥，不回显内容） | `{"status":"rejected","reason":"…类型…"}` |
| 200 | 幂等重放 | 同首次响应 + `"idempotent_replay":true` |
| 400 | 非法 JSON / 字段校验失败 | `{"status":"invalid","reason":"…"}` |
| 401 | 无令牌（带 `WWW-Authenticate` 质询）/ 令牌无效；同一来源失败过多 429 | 与 `/mcp` 完全一致（共用鉴权与限流） |
| 403 | 令牌无 write scope（写 write_log `denied`） | `{"status":"forbidden",…}` |
| 405 | 非 POST | |
| 413 | body 超限 | `{"status":"invalid","reason":"payload too large"}` |
| 502 | `error`：服务端写库失败 / 未预期异常 | `{"status":"error","reason":"write_failed"\|"internal_error"}` |

关于 `error` 用 502 而非 200：处理失败没有消耗任何东西，客户端应**保持水位、稍后重试**；用非 2xx 能让通用 HTTP 客户端 / 反代 / 监控自然识别。注意蒸馏 LLM 超时 / 失败**不是** error——沿用 `memory_capture` 的降级策略，落一张原文卡（`kind=content, tags=["raw"]`）并返回 `captured` + `degraded:true`。未配置 `MEMORY_LLM_*` 时同样每次都是 degraded 原文卡，生产建议先配好蒸馏。

`pending:true` 表示卡在待审队列，批准前不会被 `memory_recall` 搜到；`appended` 表示并入了已有近似卡（阈值 0.62），`id` 为被追加的卡。

## 服务端流程

1. 幂等查询：同 (令牌, session_id, `to_seq`；缺省则为 `text` 的 sha256) 已处理过 → 原样重放，不调 LLM。
2. 噪声剥离：`<system-reminder>`、`<team-*>` / `<teammate>` 广播、`[SCHEDULE REMINDER …]` 块、`[Tool use: …]` 行及其它运行时注入。剥完不足 60 字：有内容被剥掉 → `skipped noise_only`；本来就短 → `deferred too_short`。
3. 最小长度（默认 300，剥噪声后计）：不足 → `deferred too_short`。
4. 疑似明文密钥 → `rejected`（只报类型；不消耗冷却 / 配额，但记账，同批重发会得到同样结论）。
5. 冷却（默认 120s，按 (令牌, session_id)）与 24h 配额（默认 200，按令牌）→ `deferred`，带 `retry_after_s`。同 session 正在处理时的并发请求 → `deferred in_progress`。
6. 蒸馏 / 近邻卡喂模型 / 新建或追加 / 待审判定，全部由 `runStandaloneCapture` 完成。

冷却与配额只统计走过蒸馏的请求（`captured`、`not_durable`、`duplicate_pending`）。每次结果都写 `write_log`（`tool=ingest`，按令牌名归因，只存参数摘要，不存正文）与结构化日志（决策点级别；`deferred` 为 debug）。

## 客户端水位语义

客户端自己持有"已确认水位"（已成功送达并处理的最后一条消息序号），服务端不保存。

| 响应 | 客户端动作 |
|---|---|
| `captured` / `skipped` / `rejected` | **推进水位**到本批 `to_seq` |
| `deferred` | **不推进**；下一轮把 (水位, 最新] 的累积文本一并重发（`retry_after_s` 之前不必重试） |
| 502 / 网络错误 / 超时 | **不推进**，下一轮重发；因幂等键相同（`to_seq` 或文本哈希），已成功的批次不会重复建卡 |
| 400 / 413 | 不要原样重试；检查字段，超限时拆成多批（每批 ≤ 64K 字符） |
| 401 / 403 | 令牌问题，停止并告警 |

重发累积文本时 `to_seq` 会变大，是新的一批；若想让超时重试被识别为同一批，请保持 `to_seq` 不变。

## 示例

```bash
# 令牌通过环境变量引用，不要写进脚本或命令历史
curl -sS -X POST "$MEMORY_HUB_URL/memory/api/ingest" \
  -H "Authorization: Bearer $MEMORY_HUB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "claude-code",
    "session_id": "sess-2026-10-15-a",
    "project": "memory-hub",
    "from_seq": 12,
    "to_seq": 19,
    "text": "用户：这个服务的配置怎么管？\n助手：结论：环境变量优先，其次 memory-hub.json（权限 0600）……（累积到 300 字以上）"
  }'
# 成功示例响应：
# {"status":"captured","cards":[{"id":123,"action":"created","pending":true}]}
# 被挡住示例响应：
# {"status":"deferred","reason":"cooldown","retry_after_s":87}
```

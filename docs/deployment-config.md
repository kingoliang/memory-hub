# 部署配置说明（蒸馏 LLM）

用户决策（2026-10-15 更正）：蒸馏模型**仍使用现在的 DeepSeek**，不换模型。服务端实现不变——只是一个通用的 OpenAI 兼容端点配置，代码里没有任何写死的地址、模型名或密钥。

## 变量

| 变量 | 含义 | 生产取值 |
|---|---|---|
| `MEMORY_LLM_MODEL` | 蒸馏模型名 | `deepseek-v4.1-flash`（来源：PLAN.md 记录的 58 上 `cordis.patch.yml:309-330` 的 `captureProvider: deepseek-official` / `captureModel: deepseek-v4.1-flash`） |
| `MEMORY_LLM_BASE_URL` | OpenAI 兼容端点（不含 `/chat/completions`） | **部署阶段由用户提供**，或由部署人员从 58 现有配置**只读核实**后再填 |
| `MEMORY_LLM_KEY` | API key | **部署阶段由用户提供**或只读核实后填；只能放在 0600 的 `EnvironmentFile` / `memory-hub.json`，不得进仓库、日志、命令行参数 |
| `MEMORY_LLM_REASONING_EFFORT` | 可选。`none`/`low`/`medium`/`high` 或留空；非空时写入请求体 `reasoning_effort`。**留空 = 不传**（兼容不认识该字段的网关） | 58 生产：`none`（推理模型 `deepseek-v4.1-flash` 的思考会吃光 `max_tokens`，导致空输出 / JSON 截断；实测 `none` 后 14/14 成功，耗时 33s→4–6s） |
| `MEMORY_LLM_EXTRA_BODY` | 可选。JSON 对象字符串，原样合并进请求体（如 `{"chat_template_kwargs":{"enable_thinking":false}}`）。**不得含 `model`/`messages`/`stream`/`max_tokens`**（`max_tokens` 由重试阶梯控制）；JSON 非法或含保留字段 → 启动即报错，不静默忽略 | 不设 |
| `MEMORY_LLM_TIMEOUT_MS` | 可选。单次蒸馏调用超时（毫秒），默认 `90000`，范围 1000~600000 | 不设（用默认） |

配置文件等价键（环境变量优先，解析结果在 `config.llmRequest`）：`llm.reasoningEffort` / `llm.extraBody`（对象）/ `llm.timeoutMs`。

蒸馏重试：输出为空 / 撞 `max_tokens` / JSON 截断时，按 `max_tokens` 2000→4000→8000 重试，总共最多 3 次调用；超时**不重试**（单次已等满超时，再试只会让摄入尾延迟翻倍）。全部失败才降级为原文卡，WARN 日志含 `category`（empty/length/truncated/invalid_json/invalid_card/timeout）、`inputChars`、`attempts`、`outBudget`、`finishReason`、`usageIn/usageOut/usageReasoning`，不含原文。

规则：
- `BASE_URL` 与 `MODEL` 缺一则视为未配置，`memory_capture` 降级为原文卡（`kind=content, tags=['raw']`），启动日志会明示"蒸馏未配置"。
- 只认 `MEMORY_LLM_*`，不会回退到 `OPENAI_*` 等通用变量。
- 配置文件方式：`$MEMORY_HUB_HOME/memory-hub.json` 的 `llm.baseUrl / llm.model / llm.key`；文件权限必须是 0600，否则**忽略其中的 `llm.key`** 并告警。环境变量优先于文件。
- 日志只记录"是否配置、模型名、key 是否已设置"，不记录 key；测试用本地 mock 服务验证了 key 不会出现在响应 / 日志 / 库里。

## 待办（M1 范围之外，部署阶段做）
1. 确认 DeepSeek 的 base URL 与 key 的真实来源（用户提供，或在 58 上只读核实配置键位置——**不要打印 key 值**）。
2. 把三个变量写入 58 上 systemd 单元的 0600 `EnvironmentFile`。
3. 部署后用一条真实 `memory_capture` 验证走了蒸馏（返回里没有 `degraded:true`）。

## 会话文本摄入（`POST {basePath}/api/ingest`）

协议见 [ingest-api.md](ingest-api.md)。以下闸门均为非负整数，非法值启动即报错。环境变量优先于配置文件（`memory-hub.json` 的 `ingest.*`）。

| 环境变量 | 配置文件键 | 默认 | 范围 | 含义 |
|---|---|---|---|---|
| `MEMORY_HUB_INGEST_MIN_CHARS` | `ingest.minChars` | `300` | 60~65536 | 剥噪声后的最小字数，不足 → `deferred too_short` |
| `MEMORY_HUB_INGEST_COOLDOWN_S` | `ingest.cooldownS` | `120` | 0~86400 | 同 (令牌, session_id) 两次**实际处理**的最小间隔秒数；0 = 不设冷却 |
| `MEMORY_HUB_INGEST_DAILY_QUOTA` | `ingest.dailyQuota` | `200` | 0~100000 | 每令牌滚动 24h 内实际处理（走过蒸馏）次数上限 |
| `MEMORY_HUB_INGEST_MAX_BODY_BYTES` | `ingest.maxBodyBytes` | `262144`（256KB） | 1024~1048576 | 请求体上限，超出 → 413 |

蒸馏沿用上文 `MEMORY_LLM_*`；去重沿用 `MEMORY_DEDUP_*`（阈值默认 0.62）；待审与否由库内 `auditMode` 决定。

状态存储：冷却 / 配额 / 幂等记录在表 `ingest_log`，首次摄入时 `CREATE TABLE IF NOT EXISTS` 惰性创建（**不改 `user_version`**，旧版本代码打开该库不受影响；记录保留 7 天）。

# 部署配置说明（蒸馏 LLM）

用户决策（2026-10-15 更正）：蒸馏模型**仍使用现在的 DeepSeek**，不换模型。服务端实现不变——只是一个通用的 OpenAI 兼容端点配置，代码里没有任何写死的地址、模型名或密钥。

## 变量

| 变量 | 含义 | 生产取值 |
|---|---|---|
| `MEMORY_LLM_MODEL` | 蒸馏模型名 | `deepseek-v4.1-flash`（来源：PLAN.md 记录的 58 上 `cordis.patch.yml:309-330` 的 `captureProvider: deepseek-official` / `captureModel: deepseek-v4.1-flash`） |
| `MEMORY_LLM_BASE_URL` | OpenAI 兼容端点（不含 `/chat/completions`） | **部署阶段由用户提供**，或由部署人员从 58 现有配置**只读核实**后再填 |
| `MEMORY_LLM_KEY` | API key | **部署阶段由用户提供**或只读核实后填；只能放在 0600 的 `EnvironmentFile` / `memory-hub.json`，不得进仓库、日志、命令行参数 |

规则：
- `BASE_URL` 与 `MODEL` 缺一则视为未配置，`memory_capture` 降级为原文卡（`kind=content, tags=['raw']`），启动日志会明示"蒸馏未配置"。
- 只认 `MEMORY_LLM_*`，不会回退到 `OPENAI_*` 等通用变量。
- 配置文件方式：`$MEMORY_HUB_HOME/memory-hub.json` 的 `llm.baseUrl / llm.model / llm.key`；文件权限必须是 0600，否则**忽略其中的 `llm.key`** 并告警。环境变量优先于文件。
- 日志只记录"是否配置、模型名、key 是否已设置"，不记录 key；测试用本地 mock 服务验证了 key 不会出现在响应 / 日志 / 库里。

## 待办（M1 范围之外，部署阶段做）
1. 确认 DeepSeek 的 base URL 与 key 的真实来源（用户提供，或在 58 上只读核实配置键位置——**不要打印 key 值**）。
2. 把三个变量写入 58 上 systemd 单元的 0600 `EnvironmentFile`。
3. 部署后用一条真实 `memory_capture` 验证走了蒸馏（返回里没有 `degraded:true`）。

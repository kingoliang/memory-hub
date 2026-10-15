# dsh-memory-hub-ingest

DSH（DeepSeek Harness）插件：每轮对话结束时，把本轮新增的 user / assistant 文本推给 memory-hub 的
`POST {base}/api/ingest`（协议见 `docs/ingest-api.md`）。hub 负责剥噪声、闸门、蒸馏、去重、入待审队列。

零依赖（Node 内置 `fetch`），不导出 Config schema（不引入 schemastery）。

## 行为

- 监听 `agent/turn-stopping`。监听器**同步**、不 await 网络、全部 try/catch；真正的发送在后台队列里。
- 增量水位：按 session 在内存里记"已确认 seq"。`captured / skipped / rejected` 推进；`deferred`、5xx、网络错误/超时**不推进**，
  下一轮把累积文本一并重发；`deferred` 带 `retry_after_s` 时窗口内不再请求。`400/413` 丢弃该批并推进（避免卡死）；
  `401/403` 停用插件直到重启并告警；`429` 退避。
- 只取 `user/message`（`source.kind === 'user'`）与 `assistant/message` 的 `text` 块，带 `用户：` / `助手：` 前缀；
  工具输出、reasoning、注入的合成 user 消息不采。超过 `maxChars`（默认 20000）只留尾部。
- 客户端预检：去噪后不足 60 字不发（继续累积）；最小长度 300 / 冷却 / 日配额由 hub 判定。
- 只处理根会话：`session.header.origin === 'subagent'` 或 `delegationDepth > 0` 的会话（含 agent-team 队员）跳过。
  用户手动 fork 的会话（仅有 `parentSession`）照常推送。
- 水位只存内存。进程重启后，第一次见到某会话时基线取"当前轮 `turn/start` 之前"：不重灌历史，
  代价是重启瞬间尚未送达的旧增量丢一次。

## 配置

令牌**只**从环境变量读取，不接受写进 profile。

| 项 | 来源 | 默认 |
|---|---|---|
| 令牌 | 环境变量 `MEMORY_HUB_DSH_TOKEN`（scope 需含 write） | 无；缺失则插件禁用并打一条 WARN |
| 地址 | `config.url` > 环境变量 `MEMORY_HUB_INGEST_URL` > 默认 | `http://127.0.0.1:7990/memory/api/ingest` |
| `enabled` | config | `true` |
| `tokenEnv` | config，令牌所在环境变量名 | `MEMORY_HUB_DSH_TOKEN` |
| `source` | config | `dsh` |
| `timeoutMs` | config | `5000` |
| `minChars` | config，客户端预检字数 | `60` |
| `maxChars` | config，单次文本尾部上限（≤60000） | `20000` |
| `maxQueue` | config，待发会话队列上限，满则丢最旧并 WARN | `50` |
| `concurrency` | config，并发请求数（同一会话始终串行） | `2` |
| `userSourceKinds` | config，哪些 `source.kind` 的 user 消息算真实输入 | `["user"]` |

## 安装（profile 的 insert 条目）

1. 把本目录（`index.js`、`lib/`、`package.json`）放到 DSH 主机上，例如 `~/.dsh/plugins/dsh-memory-hub-ingest/`。
2. 在 profile 的 `cordis.patch.yml` 里追加（绝对路径写法与已有的 `tailscale-web-entry` 一致）：

```yaml
- insert:
    - id: dsh-memory-hub-ingest
      name: /home/<user>/.dsh/plugins/dsh-memory-hub-ingest/index.js
      config:
        url: http://127.0.0.1:7990/memory/api/ingest   # 可省略，走默认
```

3. 令牌通过运行 DSH 的进程环境提供（58 上 `dsh-web.service` 已注入 `MEMORY_HUB_DSH_TOKEN`），**不要**写进 yaml。
4. 重启 DSH。启动日志应出现 `[dsh-memory-hub-ingest] 已启用 → …`；缺令牌则是一条 WARN。

校验（不启动服务）：`DSH_HOME=<临时目录> dsh --profile web --patch overlay.yml --dump-config`，应能看到该条目。

## 与旧 memory-eternal 的关系

旧插件 `memory-eternal` 在 58 的 profile 里已 `disabled: true`，它自己蒸馏并写本地库。本插件把蒸馏交给 hub。
**不要同时启用两者**，否则同一轮对话会被沉淀两次。

## 回滚

从 `cordis.patch.yml` 删掉（或注释）上面的 `insert` 条目并重启 DSH；已入 hub 的卡在管理台待审队列里按需处理。
临时止血不改文件：去掉环境变量 `MEMORY_HUB_DSH_TOKEN` 重启即进入禁用态。

## 测试

```bash
cd clients/dsh-plugin
npm test                # node:test，真实 HTTP 假 hub
npm run smoke           # 本机起真实 memory-hub（临时目录 + stub LLM），喂模拟事件，期望待审队列出现卡
```

# memory-hub-ingest（Pi 扩展）

在每轮 agent 结束时（`agent_end`），把本轮新增的 user / assistant 文本增量推给 memory-hub 的摄入接口
`POST {base}/api/ingest`（协议见 `docs/ingest-api.md`），由 hub 剥噪声、蒸馏、去重后入库（新卡按库内 `auditMode` 进待审队列）。

这是 **Pi 扩展**（`~/.pi/agent/extensions/`，jiti 直接加载 TS，无需编译），不是 PI WEB 插件。pi-web 的会话在 `pi-web-sessiond` 进程内运行，
扩展跑在该进程里，因此直接用全局 `fetch`。

## 文件

```
memory-hub-ingest/index.ts   薄入口：挂 session_start / agent_end / session_shutdown
memory-hub-ingest/core.mjs   全部逻辑（零依赖纯 ESM，便于单测）
tests/                       node:test 单测 + 对真实 hub 的烟测
```

## 安装

1. 准备令牌：在 hub 管理台 / CLI 创建一个带 **write** scope 的专用令牌（建议名字如 `pi-web-ingest`，署名会记在待审卡上）。
2. 把令牌写入 0600 文件（**推荐**，见下文"令牌放哪"）：
   ```bash
   mkdir -p ~/.config/memory-hub && chmod 700 ~/.config/memory-hub
   ( umask 077; read -rs -p "token: " T; printf '%s' "$T" > ~/.config/memory-hub/pi-web-token; unset T )
   ```
3. 拷贝扩展（保持目录结构，目录名即扩展名）：
   ```bash
   mkdir -p ~/.pi/agent/extensions
   cp -r clients/pi-web-extension/memory-hub-ingest ~/.pi/agent/extensions/
   ```
4. 在 pi-web 的任一会话里执行 `/reload`（热加载，无需重启 sessiond，不会打断其它会话）。
   日志里应无 `未配置令牌` 的 WARN；之后每轮结束会看到 `[memory-hub-ingest][INFO] 已摄入 {...}`。

### 令牌放哪（依据）

扩展按顺序读取：环境变量 `MEMORY_HUB_PI_TOKEN` → 令牌文件（`MEMORY_HUB_PI_TOKEN_FILE`，默认 `~/.config/memory-hub/pi-web-token`）。**推荐文件**：

- sessiond 由 systemd 单元 `bash -lc "exec pi-web-sessiond"` 启动，环境只来自单元 `Environment=` 与登录 shell（`~/.profile`）；
  在 58 上 `~/.profile` 没有任何自定义 export，改单元要 `daemon-reload` + **重启 sessiond（会终止所有进行中的会话）**。
- 文件在扩展加载时读取：新增 / 轮换令牌只需改文件 + `/reload`，不重启任何服务；也不依赖 sessiond 是怎么被拉起的（手动启动、`systemd-run` 自更新重启都一致）。
- 令牌不进单元文件 / `systemctl show` / 进程环境（`/proc/<pid>/environ`），降低泄露面。
- 若坚持用环境变量：用 `EnvironmentFile=%h/.config/memory-hub/pi-web.env`（0600）做 systemd drop-in，而不是写进 `~/.profile` 或单元正文。

读不到令牌时扩展进入禁用并 `console.warn` 一次，**绝不打印令牌**（日志、报错里都不含）。

## 配置项

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MEMORY_HUB_PI_TOKEN` | — | Bearer 令牌（优先于文件） |
| `MEMORY_HUB_PI_TOKEN_FILE` | `~/.config/memory-hub/pi-web-token` | 令牌文件 |
| `MEMORY_HUB_INGEST_URL` | `http://127.0.0.1:7990/memory/api/ingest` | 摄入地址（58 上即默认值） |
| `MEMORY_HUB_PI_DEBUG` | 关 | `1` 打开 DEBUG 日志 |

内置常量（`core.mjs` 的 `LIMITS`）：fetch 超时 5s；单次发送保留尾部 20000 字符；去噪后不足 60 字不发；每 session 队列上限 20 批；累积上限 80000 字符；`source` 固定 `pi-web`。

日志全部写 **stderr**（`[memory-hub-ingest][INFO|WARN|ERROR]`，进 sessiond 日志 / journal），不写 stdout，避免污染 `pi --mode json/rpc` 的协议输出。
日志只含 session id、状态、条数、字数，不含对话正文和令牌。

## 行为

- **取文本**：只取 `user` / `assistant` 消息的 `text` 块，加前缀 `用户：` / `助手：`；丢 thinking / toolCall / image / toolResult / 自定义消息；
  剥 `<system-reminder>`、`<team-*>` / `<teammate*>`、`[SCHEDULE REMINDER …]`、`[Tool use: …]`。
- **不阻塞**：handler 只做同步取文本 + 入队并立即返回；请求在后台按 session 串行发送；全部 try/catch，异常只记日志。
- **水位**：内存里的"待确认片段"。`captured / skipped / rejected` → 清掉；`deferred` → 保留并在下一轮累积重发（遵守 `retry_after_s`：
  期间的新一轮只累积；到期会用一个 unref 的定时器做最多 3 次"收尾重试"，避免会话最后一轮被冷却期吞掉）；5xx / 网络错误 / 5s 超时 → 保留，下一轮重发；
  400 / 413 → 丢弃该批（重试不会成功）；401 / 403 → 整个扩展禁用并 WARN（换令牌后 `/reload`）。
- **去重**：不假设 `agent_end.messages` 的语义（实测 pi 1.2.0 只含本次运行的消息，但整段历史也能处理），按消息键（role + timestamp + 文本哈希）去重；
  `from_seq/to_seq` = 消息在会话里的位置序号，同一批内容重发会得到同样的幂等键。
- **重启 / `/reload`**：`session_start` 时把会话里已有消息记为已读，从当前末尾起算，**不重灌历史**。取舍：reload 之前尚未被 hub 确认的累积文本会丢；
  换来的是不会因为重启把整段历史再推一遍、也不依赖任何持久化状态。
- **中止**：本轮含 `stopReason: "aborted"` 的助手消息 → 整轮不推送（半截回答不可靠，用户已表明不要这个结果），且标记已读不再累积。
  出错（`stopReason: "error"`）：只丢该助手消息，用户文本照常。
- **子 agent**：`PI_SUBAGENT_CHILD=1`（pi-subagents 后台 runner 进程）或会话头带 `parentSession` 的子会话 → 不摄入，避免同一工作被重复推送。

## 测试

```bash
cd clients/pi-web-extension
node --test "tests/*.test.mjs"     # Node >= 22.18（需要内置 TS strip-types 以加载 index.ts）；烟测会在临时目录起本仓库 hub + stub LLM
```

不在仓库根的 `npm test` 范围内（根 `package.json` 只扫 `tests/`），未改动 `src/`、`tests/`。

## 回滚

```bash
rm -rf ~/.pi/agent/extensions/memory-hub-ingest
```
然后在会话里 `/reload`。已入库的待审卡在管理台按令牌署名（`pi-web-ingest`）筛选 / 驳回；吊销该令牌即可立即停止一切写入。

## 已知限制

- 水位只在内存里：sessiond 重启 / `/reload` 时，未确认（deferred / 5xx）的累积文本丢失。
- 用户在会话树里回到更早的分支后再 `/reload`，位置序号可能与旧批次重合，hub 会按幂等键重放旧响应，该批不会入库（极少见）。
- 只有 `agent_end` 触发；会话在冷却期内结束的最后一轮靠"收尾重试"定时器补发，若 sessiond 在此之前退出则丢失。
- hub 默认冷却 120s / 每令牌每日 200 次：短问答会被合并成较少的几批，这是预期行为。
- 其它会 spawn 子会话的包（`pi-background-tasks`、`pi-goal` 等）我们只审计了 pi-subagents；若它们的子会话也加载本扩展且既无 `parentSession` 也无 `PI_SUBAGENT_CHILD`，会各自作为独立 session 摄入。

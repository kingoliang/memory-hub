# 决策：经验闸门（只让"提炼过的经验"入库）

日期：2026-10-18 · 状态：已采纳 · 影响：capture / ingest 管线、配置

## 背景

用户要求：

> 一定要是提炼过的内容，而且是真的是经验性质的内容再往 mcp 推送。象一些日常的操作，这种没必要推送。

上游的入库条件是 `MIN_CLEAN_CHARS=60` + `DURABLE_SIGNALS` 正则 + LLM `{"save":false}`。
实测它**拦不住日常操作**：跑一遍 `npm test`、`ls` 一下目录、贴一段测试输出，字数够、也含
"完成/失败"这类词，LLM 往往会 `save:true` 存成一张没什么复用价值的卡。

上游还有第二个入口更松：`POST /api/ingest`（客户端每轮自动推送）。它只在噪声过滤后
就进蒸馏，等于"每轮都可能落一张卡"。

## 决策

在"噪声过滤"与"蒸馏"之间插入一道**闸门**，判定 `experience | unknown | routine`。
`routine` 直接丢，连 LLM 蒸馏都不做（省钱、省库）。

### 两种模式

| 入口 | 默认模式 | 理由 |
|---|---|---|
| `POST /api/ingest` | `strict`（启发式 + LLM） | 自动推送，最容易灌水，必须双闸 |
| MCP `memory_capture` | `heuristic` | agent 是**显式**决定要存，尊重意图，只在明显是日常操作时才拦；`force:true` 可绕过 |

配置：`MEMORY_HUB_GATE_INGEST` / `MEMORY_HUB_GATE_CAPTURE` ∈ `off|heuristic|strict`。

### 启发式闸门（纯函数，`src/core/gate.js`）

给文本打分：经验信号（决策标记、因果关系、权衡取舍、踩坑教训、可复用流程、代码/路径、
具体数值）为正，日常信号（工具输出行占比高、纯状态汇报、寒暄）为负。

- `score >= 2` → `experience`
- `score <= -2` → `routine`
- 其余 → `unknown`

**一个 turn 里只要有一处经验就算经验** —— 所以不做"整段必须是经验"的判定，而是
"有没有经验句"。日常操作部分由蒸馏负责压缩掉。

### LLM 闸门（strict 模式）

只问一个二元问题，temperature 0，输出 `{"keep":bool,"reason":"..."}`。提示词明确列出
"不算经验"的例子（跑命令、看文件、列清单、状态汇报、客套）。LLM 说 `keep:false` → 丢。

LLM 不可用时降级：`strict` 退化为 `heuristic`（**不**因 LLM 缺失而全放行）。启发式说
`unknown` 时，strict 模式下交给 LLM；heuristic 模式下 `unknown` 视为 `experience`（放行，
因为 capture 是显式意图）。

### 为什么不做"客户端预筛 + 服务端不管"

客户端（pi extension / hook）也会做一次廉价预筛以免白发请求，但**判定权在服务端**：
客户端版本会漂移，服务端是唯一权威。客户端预筛只对明显的 routine 生效（如全工具输出、
<300 字符），且不推进 watermark 之外的状态。

### 可观测性

被闸门丢掉的 turn 在 `/api/ingest` 响应里返回 `status:'skipped', reason:'gate:routine'`，
并在 `stats` 里单列 `gate.dropped`。**不做静默丢弃** —— 否则无法判断闸门是不是过严。

## 影响

- `src/core/gate.js`（新）：纯函数 + LLM 调用。
- `capture-run.js`：蒸馏前插入闸门阶段。
- `capture.js captureCard`：接受 `gateMode` / `force`。
- `ingest.js`：`validateIngestBody` 之后调用闸门，routine 返回 `skipped`。
- 配置：`config.js` 增 `gate` 段。
- 测试：`tests/experience-gate.test.mjs`（字面量用例，期望值写死）。

## 反面选项（已否决）

- **只靠调大 `MIN_CLEAN_CHARS`**：长文里的日常操作照样过。
- **只靠 LLM**：每轮都调 LLM 才能判 routine，但启发式已能拦掉大部分纯工具输出；且
  LLM 不可用时不能全放行。
- **只靠关键词 whitelist**：中文经验表达太散，纯 whitelist 会把"我们用 X 是因为 Y"
  这种最该留的句子漏掉。

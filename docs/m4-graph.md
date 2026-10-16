# M4 知识图谱（只读）

管理台新增「记忆 → 图谱」页与 `GET /admin/api/graph`。对标上游 memory-eternal 的"知识图谱"页，语义沿用，不改 schema、不新增依赖、不依赖外网。

## 原版语义（出处）
- 数据：上游 `lib/vault.js` `graph()`（:852，另有内存+磁盘缓存 :810-:850）；路由 `lib/api.js` `case '/graph'`（:325）。
- 节点 = 主库卡片（id=path，title/kind/tags/summary[:80]/updated，`linkCount`=度数）。
- 边三种：`link`（正文 `[[wikilink]]`，按 kind 目录/知识目录/裸名/标题解析，vault.js ~:880）；`tag:<标签>`（共享标签，按共享数取每卡 Top-6，`TAG_TOPK=6`）；`similar`（bigram Jaccard ≥0.42，稀有 gram 倒排 + MinHash/LSH 取候选，每卡至多 1 条，跨 kind 须共享标签）。
- 前端：上游只有压缩后的 `web/app.js`（组件 `eh`/`nh`，源码 `src/client` 未随 fork 提供，**uncertain**）：canvas 力导向；颜色按 kind（project 蓝/knowledge 绿/content 橙/prompt 紫/business 粉/tool 青/mistake 红），半径 9+≤8·度数占比；kind 聚类中心；搜索（标题/kind）定位；kind 图例筛选、Top-24 标签筛选；缩放/平移/框选/右键菜单/导出/全屏；LOD（视口剔除 + 标签预算，`tests/graph-lod.test.mjs`）。

## 数据模型（本实现）
`src/admin/graph.js`。节点 = 主库 `cards` 表中 `status='approved' AND deleted_at IS NULL` 的卡（**隔离区：待审/驳回/回收站不入图**）。边（同一对节点不同类型各一条）：

| type | 判定 | weight |
|---|---|---|
| `link` | 正文 `[[x]]`（解析顺序：`<kind目录>/x.md` → `03-Knowledge/x.md` → `x.md` → 标题 → 文件名） | 3 |
| `tag` | 共享标签，每卡按共享数取 Top-6（候选 ≤6 全连）；附 `tags`（共享标签，≤5） | 共享标签数 |
| `similar` | 正文前 4000 字 bigram Jaccard ≥ 0.42，每卡至多 1 条，跨 kind 须共享标签；附 `sim` | 2 |

与原版差异：标签边 type 统一为 `tag`（共享标签放 `tags` 字段）；wikilink 解析单次命中（原版可能因标题回退多加一条）；相似度只取正文前 4000 字；标题经 `redactSecrets` 遮蔽。

性能：全量建图结果按"指纹"（卡数/最大 updated_at/Σid/Σ标签长/Σ标题长/Σ正文长/audit_log 与 card_updates 水位）缓存在进程内，指纹变即失效；过滤/limit/focus 都在缓存上做。实测 662 卡（58 快照）建图 ≈250ms，命中缓存 ≈5ms。不落盘。

## API
`GET {base}/admin/api/graph`，只读、需管理员会话（未登录 401；Agent 令牌 401；POST 等 405）。`MEMORY_HUB_ADMIN_READONLY=1` 下可访问。

| 参数 | 说明 |
|---|---|
| `kind` | 只要该 kind 的卡 |
| `tag` | 逗号分隔，卡须同时具备全部标签 |
| `types` | `link,tag,similar` 子集 |
| `min_weight` | 1–20，默认 1 |
| `focus` | 卡片 **path**（本管理 API 以 path 为键，不暴露数字 id）；返回焦点 + `depth`（1–3，默认 1）跳邻域；不在图中（不存在/已删/隔离）→ 404 |
| `hide_isolated` | `1` 去掉无边节点 |
| `limit` | 默认 800，最大 2000（超出钳到 2000）；超限按加权度数（边权和）降序截断（焦点必留），`truncated:true` |
| `status` | 仅接受 `approved`（图只含主库），其它值 400 |

处理顺序：kind/tag 选点 → types/min_weight 选边 → focus 邻域 → hide_isolated → limit 截断。

响应：`{ nodes:[{id,title,kind,tags,status,createdAt,updatedAt,degree}], edges:[{source,target,type,weight,tags?,sim?}], truncated, stats:{totalCards,matchedNodes,nodes,edges,isolated,byKind,byType,limit,focus,cached,buildMs} }`。`degree` = 返回边里的出现次数。**不含正文/摘要**；点击节点后前端才请求现有 `GET /admin/api/card?path=` 取摘要。

## 前端
`web/js/views/graph.js`（视图）+ `web/js/graph-core.js`（纯函数：过滤/搜索/力导向/视图变换/命中测试，单测）。零依赖、canvas、自写力导向（O(n²) 斥力，≤1000 节点流畅），无构建、无外网、遵守现有 CSP 与 DOM 助手约束。
交互：滚轮缩放（以光标为锚）、拖空白平移、拖节点、悬停提示与邻居高亮、点击→右侧面板（kind/标签/时间/度数/正文摘要/相邻卡片/「打开卡片详情」/「以此为中心展开」邻域模式 `#/graph?focus=`）；搜索高亮（标题/标签/kind/path）；kind 图例点选过滤；标签下拉；最小权重滑块；边类型开关；隐藏孤立点；最多节点数；适应/重新布局；键盘 `+ - 0 Esc`。颜色按 kind（簇色），大小按度数。
URL：`#/graph?focus=&tag=&kind=&limit=`。

### 暗色霓虹簇云风格
画布恒为近纯黑（`web/graph.css` 覆盖 `.graph-stage`，浅色主题下也保持深色；画布外页头/面板/工具栏仍跟随全站主题）。
- **簇 = 卡片 `kind`**（即主库顶级目录；API 无社区/子目录字段，不改后端）。每簇一个霓虹主题色（项目青 / 知识紫 / 内容黄 / 提示词品红 / 业务橙 / 工具薄荷 / 踩坑红），簇中心确定性打包并留白，簇内力导向（网格近邻斥力 + 弹簧 + 向簇心引力，O(n·k)）。
- 节点是 1–2px 偏白小点，度数前 ~4%（且 ≥3 条关联）为枢纽，用预渲染径向渐变精灵 `drawImage` 发光（不逐点 shadowBlur）；边按簇批量成一条 path，簇内细淡纤维线，跨簇边极淡。缩放行为沿用：节点屏幕半径 ∝ zoom^0.2，线宽/字号屏幕恒定。
- 簇名大号粗体 + 小字 `N cards`；点击簇名或簇区域 → 相机缓动飞到该簇、其余簇变暗、显示该簇枢纽小矩形标签（`标题 · 类型`，描边按类型着色），侧栏列出该簇关联最多的卡；点击节点 → 向邻居辐射流动的点状虚线 + 邻居小矩形标签，其余变暗；点空白 / Esc 恢复。`prefers-reduced-motion` 下无流动/脉动/缓动。
- 调试钩子 `canvas.__mhGraph`（绘制耗时统计、节点屏幕坐标，只读）供自动化测试使用。


## 蜘蛛与蜘蛛搜索
画布里常驻一只蜘蛛（青绿色带网格纹圆环 + 中心品红方块，18 条白色点状虚线触手，末端“踩”在最近的节点上并随移动换脚）。空闲时沿弧线在簇间慢速游走并留拖尾；画布右上缩放栏最后一个按钮可开关（默认开，偏好存浏览器 `localStorage` 的 `mh.graph.spider`）。绘制层只读节点位置、不拦截指针，选中 / 聚焦 / 拖拽时自动调淡；`prefers-reduced-motion` 下蜘蛛静止（不游走、不脉动），搜索结果直接显示不播动画。
实现：`web/js/graph-spider.js`（引擎 + 纯函数 `buildTourPlan` / `nodeStateAt` / `skipState` / `orderPath` / `smoothControl`，有单测）、`web/js/graph-spider-ui.js`（结果面板、飞出卡片、接口调用）；身体为预渲染 sprite，所有触手合成一条 path 一次 stroke，落脚点最近邻按帧分摊。5000 节点（2000 真实 + 复制到 5000 的前端压测）实测单帧约 2ms，60fps。

### 蜘蛛搜索（工具栏「蜘蛛搜索」按钮或在搜索框按回车；输入即过滤的标题搜索保持不变）
1. `POST /admin/api/graph/search` 召回命中卡；同时并行发 `POST /admin/api/graph/summarize`。
2. 巡游是“表演”：**蜘蛛脚踩到命中节点之前，该节点与普通节点外观完全一致**（无高亮 / 标签 / 相机暗示）；踩到的那一刻才高亮（霓虹描边 + 光晕 + 名次角标，其余节点变暗），弹出标题，并把“标题 + 摘要”小卡飞进右侧结果面板。卡片按被踩到的顺序出现，AI 汇总等蜘蛛走完全部命中点后才显示（早到则缓存）。汇总期间蜘蛛原地“思考”，之后平缓回到游走。面板「跳过动画」一次性全部显示。
3. 路线（纯函数，确定性，无随机）：命中节点按簇分组，簇间最近邻 + 2-opt，簇内同样；开场原地“扫描”；干扰节点只取顺路的少量非命中节点（每段 ≤2、总数 ≤6、偏离直线有阈值，时间不够先砍它们）；簇间长跳、簇内短步，每站固定停顿，转向用起飞方向连续的二次贝塞尔并限制转角；总时长 ≤12s（超出则加快步速 / 缩短停顿 / 等比压缩，命中点永不丢）。
4. 点面板卡片或汇总里的引用 `[n]` → 相机飞到该节点并打开侧栏详情（不在当前图中的卡则以它为中心展开）；`×` / Esc 清除搜索。AI 汇总失败只在面板里提示“AI 汇总不可用”，搜索与命中展示不受影响。a11y：搜索框有 label，面板 `role=region`、按钮可键盘操作，汇总完成经 `aria-live` 播报。

### 接口（均需管理员会话 + CSRF + Origin；POST 但不改库，`MEMORY_HUB_ADMIN_READONLY=1` 下仍可用）
| 接口 | 入参 | 出参 |
|---|---|---|
| `POST /admin/api/graph/search` | `{q: 1~200 字符无控制字符, limit?: 1~30（默认 `MEMORY_HUB_GRAPH_SEARCH_TOPN`=12）}` | `{hits:[{path,title,kind,tags,snippet,score,rank}], limit, ms}`；复用 `vault.search`（与 `memory_recall` 同一检索，minScore 2），只含主库 approved 且未删除的卡；标题 / 片段脱敏；不依赖 LLM |
| `POST /admin/api/graph/summarize` | `{q, paths: 1~20 个路径}`（**只收 path**，正文由服务端读主库，忽略前端传的任何正文） | `{summary, points:[{text, refs:[path]}], used:[{path,title}], skipped, truncated, ms}` |
错误：400 校验、401/403 鉴权 / CSRF、404 无可读卡、429 `too_many_requests`（带 `Retry-After`；每会话并发 =1 + 最小间隔，`MEMORY_HUB_GRAPH_SEARCH_MIN_INTERVAL_MS` 默认 400 / `MEMORY_HUB_GRAPH_SUMMARIZE_MIN_INTERVAL_MS` 默认 3000）、503 `llm_not_configured`、504 `llm_timeout`、502 `llm_failed`（响应不含密钥 / 端点 / 内部路径）。
LLM：复用蒸馏的 OpenAI 兼容适配器（`MEMORY_LLM_*`，同一超时配置，上限 60s）；撞 `max_tokens` / 空输出按 2000→4000 重试一次（推理模型思考吃预算，见 commit 73cdaac）。不流式，整体返回（前端用“思考”动画占位）。
安全：卡片正文先 `redactSecrets`，每卡 600~2500 字、总计 ≤12000 字按句界截断（`truncateAtBoundary`）；卡片 / 查询整体转义（`& < > "`）后放进 `<query>` / `<card>` 围栏，系统提示声明围栏内全是数据而非指令。INFO 日志只记操作者 / 数量 / 耗时（`q` 仅前 20 字 + 长度），不记 `q` 全文与卡内容。配置见 [deployment-config.md](deployment-config.md)。
测试：`tests/admin/graph-spider.test.mjs`（后端 15 项）、`tests/admin/graph-spider-plan.test.mjs`（巡游计划纯函数 9 项）。

## 未实现（相对原版）
框选/合并/删除（管理台图谱只读）、右键菜单、导出、全屏、"时间模式"、视口剔除 LOD（改为标签预算 + 隐藏孤立点/最小权重/limit 降噪）、多库聚合、磁盘缓存。

## 测试
`tests/admin/graph.test.mjs`（API：鉴权/结构/不泄露/过滤/limit/focus/边类型/只读/规模）、`tests/admin/graph-core.test.mjs`（纯函数）。截图 `docs/screenshots/m4/`（合成数据 260 卡，非真实数据）。

## 部署
改了 `src/admin/{graph,graph-search,handler}.js`、`src/config.js`、`src/server.js` 与 `web/`：**需重启 hub**；**无 schema 变更**、无新依赖、无新配置。

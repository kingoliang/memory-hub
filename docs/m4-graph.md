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


## 未实现（相对原版）
框选/合并/删除（管理台图谱只读）、右键菜单、导出、全屏、"时间模式"、视口剔除 LOD（改为标签预算 + 隐藏孤立点/最小权重/limit 降噪）、多库聚合、磁盘缓存。

## 测试
`tests/admin/graph.test.mjs`（API：鉴权/结构/不泄露/过滤/limit/focus/边类型/只读/规模）、`tests/admin/graph-core.test.mjs`（纯函数）。截图 `docs/screenshots/m4/`（合成数据 260 卡，非真实数据）。

## 部署
改了 `src/admin/{graph,handler}.js` 与 `web/`：**需重启 hub**；**无 schema 变更**、无新依赖、无新配置。

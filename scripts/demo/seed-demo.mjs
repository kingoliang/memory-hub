// 演示数据：给一台空的 memory-hub 造一份「像真的」合成知识库，用于截图 / 图谱动画 / 本机试用。
// 确定性（固定种子的 PRNG + 固定文案），不含任何真实数据。
//
// 用法：
//   node scripts/demo/seed-demo.mjs <数据目录> [--cards 360]
// 库文件写在该目录下（memory-eternal.db）。卡片全部 approved，带标签与 [[wikilink]]，
// 图谱会自然长出「共享标签 / 链接 / 正文相似」三类边，并按主题成簇。

import { getDb, setAuditConfig, closeDb } from '../../src/core/db.js'
import { writeCard, ensureVault } from '../../src/core/vault.js'

/**
 * 主题：kind 决定颜色；hub 是枢纽卡标题；items 是卫星卡标题（不重复）；pool 是同主题共用的句子（让相似边长出来）。
 * 卫星卡绝大多数沿用主题的 kind，少量是「踩坑 / 知识」穿插，接近真实库的分布。
 */
const TOPICS = [
  {
    kind: 'project', hub: '订单中心拆分', tags: ['订单', '微服务'],
    items: ['边界划分原则', '灰度切流方案', '双写期一致性校验', '回滚开关设计', '接口契约冻结', '旧链路下线顺序', '容量评估口径', '上下游联调清单',
      '影子表比对脚本', '幂等键选型', '分库分表路由', '历史数据迁移批次', '对外 SDK 兼容期', '切流当晚值守安排', '拆分后的告警基线', '读写分离延迟处理'],
    pool: [
      '拆分的第一步是把「谁拥有这份数据」写清楚，写不清楚的边界先不动，避免拆完变分布式单体。',
      '灰度按流量比例与业务线两个维度同时切，任何一次放量都能在五分钟内回滚。',
      '双写期以旧链路为准，新链路影子写，差异落到对账表，差异超过千分之一自动停止放量。',
      '接口契约先冻结字段语义，字段可加不可改，语义变更走新版本号。',
      '容量评估以压测 P99 为准而不是平均值，长尾拖垮下游是最常见的误判。',
      '旧链路下线从读多写少的旁路开始，最后才是主写入路径，每一步留一周观察窗口。',
    ],
  },
  {
    kind: 'project', hub: '数据同步管道', tags: ['数据', '调度'],
    items: ['增量位点管理', '重跑语义与幂等', '脏数据隔离表', '任务依赖图', '延迟水位告警', 'schema 演进规则', '回填资源组隔离', '分区校验规则',
      '小文件合并', '跨机房同步带宽', '维表快照策略', '数据质量巡检'],
    pool: [
      '增量位点必须与数据落在同一个事务里，位点先落而数据后写会静默丢数。',
      '重跑按业务主键覆盖而不是追加，否则一次重跑就多一份重复数据。',
      '脏数据不阻断整批，先写隔离表记录原因，人工修完再回灌。',
      '延迟水位按分区最老位点算，平均值会掩盖个别分区的长期卡死。',
      'schema 只允许加列与放宽类型，删列要等所有下游停止读取之后的版本。',
    ],
  },
  {
    kind: 'knowledge', hub: '缓存一致性', tags: ['缓存', 'Redis'],
    items: ['先更库再删缓存', '空值缓存与过期', '热键打散', '大 key 拆分判据', '过期时间抖动', '本地缓存版本号', '穿透与击穿的区别', '缓存降级策略',
      '布隆过滤器容量估算', '逻辑过期重建', '多级缓存失效顺序', '缓存预热脚本'],
    pool: [
      '先更新数据库再删缓存，比先删缓存再更新数据库少一类竞态；删失败时靠过期时间兜底。',
      '空值也要缓存，但过期时间要短，否则新增数据会被空值长期挡住。',
      '热键加随机后缀拆成多份，读时聚合，写时逐份失效。',
      '过期时间加随机抖动，避免同一批 key 在整点同时失效把数据库打穿。',
      '穿透靠空值缓存与布隆过滤器，击穿靠互斥重建与逻辑过期。',
    ],
  },
  {
    kind: 'knowledge', hub: '前端排版系统', tags: ['前端', '设计'],
    items: ['栅格与断点', '字号阶梯', '行高与间距节奏', '对比度校验', '字体自托管', '深浅主题分别校色', '空状态设计', '宽表格横向滚动', '焦点可见性', '动效时长令牌'],
    pool: [
      '栅格只用于页面骨架，组件内部用间距令牌，两套混用是布局失控的主要原因。',
      '字号阶梯保持固定几档，临时插入中间档会迅速退化成十几种字号并存。',
      '对比度按正文 4.5:1、大字 3:1 校验，改主题令牌后必须重算一遍。',
      '深浅主题分别校色而不是简单反色，深色下的语义色需要提亮并降低饱和度。',
    ],
  },
  {
    kind: 'tool', hub: '本地开发环境', tags: ['工具链', '脚本'],
    items: ['一键起服务脚本', '依赖版本锁定', '环境变量分层', '日志落盘位置', '数据快照导入', '端口占用处理', '调试配置同源', '清理脚本 dry-run', 'pre-commit 钩子', '容器化开发机'],
    pool: [
      '一键起服务的脚本只做编排，不藏业务逻辑，出错时打印失败命令与退出码。',
      '依赖全部锁定到补丁号，本地能跑而 CI 装不上通常是间接依赖漂了。',
      '环境变量按默认值、本地覆盖、密钥文件三层，密钥文件权限 0600 且不进仓库。',
      '清理脚本默认 dry-run，列出将删除的路径与体积，加 --yes 才真正动手。',
    ],
  },
  {
    kind: 'tool', hub: '可观测性建设', tags: ['监控', '日志'],
    items: ['指标命名规范', '告警分级', '日志采样策略', '链路追踪接入', '看板三层结构', '静默规则过期', '值班交接模板', '容量趋势同比', 'SLO 与错误预算', '探针与健康检查'],
    pool: [
      '指标命名统一前缀与单位，标签只放低基数维度，用户 id 进标签是指标爆炸的起点。',
      '告警分级按是否需要立刻动手划分，P1 必须有人半夜起来。',
      '看板分业务结果、服务健康、资源水位三层，混在一张图上没人看得完。',
      '静默规则必须带过期时间，永久静默等于把告警关掉。',
    ],
  },
  {
    kind: 'mistake', hub: '线上事故复盘', tags: ['事故', '排障'],
    items: ['连接池耗尽', '定时任务重叠执行', '配置热更新竞态', '磁盘写满静默丢弃', '重试风暴', '时钟漂移导致乱序', '锁等待超时堆积', '证书过期', 'DNS 缓存未刷新', '慢查询拖垮主库'],
    pool: [
      '直接原因是连接池被慢查询占满，根因是新增报表查询没有走上限控制。',
      '配置热更新读到了写了一半的结构体，改成整份指针原子替换后消失。',
      '上游超时后本端重试把上游压得更慢，改成指数退避加抖动并限制总次数后收敛。',
      '证书过期当天才发现，换成自动续期并在到期前三十天告警。',
    ],
  },
  {
    kind: 'content', hub: '技术写作方法', tags: ['写作', '文档'],
    items: ['结论先行', '背景压成一句话', '术语表', '示例优先于规则', '限制条件单独成节', '按受众分层', '版本与日期标注', '标题的可搜索性'],
    pool: [
      '第一段就写清楚能做什么、不能做什么，读者才能决定要不要往下读。',
      '术语第一次出现时给一句定义，跨团队文档里同一个词常有两套含义。',
      '先给一个能跑的例子再解释参数与边界，比反过来读得快。',
    ],
  },
  {
    kind: 'business', hub: '结算对账', tags: ['结算', '财务'],
    items: ['对账口径对齐', '差异分类规则', '长短款双向处理', '跨天挂账归集', '手续费取整', '币种精度', '人工调账凭证', '对账文件校验和'],
    pool: [
      '对账口径先对齐以谁的流水为准，口径不一致时双方报表都能自证正确。',
      '差异按可解释与不可解释分开，前者自动归类，后者才需要人工介入。',
      '手续费取整规则在合同里写死到小数位与进位方式。',
    ],
  },
  {
    kind: 'prompt', hub: 'Agent 提示词工程', tags: ['Agent', 'LLM'],
    items: ['工具描述写触发条件', '输出格式约束与重试', '失败时的下一步', '上下文预算', '示例选边界情况', '拒答边界', '多轮状态外置', '固定评测集'],
    pool: [
      '工具描述写什么时候调用而不是工具是什么，选错工具多半是触发条件没写清楚。',
      '输出格式用结构化约束并允许解析失败时重试，别指望永远拿到干净的 JSON。',
      '评测集固定并版本化，改提示词后跑同一套用例，否则感觉变好了会骗人。',
    ],
  },
]

const SUFFIX = ['', '', '（实测）', '（决策）', '：踩坑记录', '：命令速查', '（复盘）', '：检查清单']
const EXTRA_TAGS = ['决策', '命令', '清单', '踩坑']

/** mulberry32：小而确定的 PRNG。 */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 生成待写入的卡片（确定性）。总数约为 count。 */
export function buildDemoCards(count = 360) {
  const rand = rng(20261018)
  const pick = (arr) => arr[Math.floor(rand() * arr.length)]
  const cards = []
  const perTopic = Math.max(4, Math.round(count / TOPICS.length) - 1)

  TOPICS.forEach((t, ti) => {
    cards.push({
      kind: t.kind, title: t.hub, tags: [...t.tags, '决策'],
      body: [
        `「${t.hub}」的总览：已确认的结论、被否掉的方案与仍在观察的取舍。`,
        ...t.pool.slice(0, 3),
        `相关：[[${TOPICS[(ti + 1) % TOPICS.length].hub}]]、[[${TOPICS[(ti + 3) % TOPICS.length].hub}]]。`,
      ].join('\n\n'),
    })
    for (let i = 0; i < perTopic; i++) {
      const item = t.items[i % t.items.length]
      const round = Math.floor(i / t.items.length)
      const title = round === 0 ? item : `${item}${SUFFIX[(round * 3 + i) % SUFFIX.length] || '（补充）'}`
      // 大多数沿用主题 kind；少量穿插踩坑 / 知识，接近真实库
      const r = rand()
      const kind = r < 0.78 ? t.kind : r < 0.9 ? 'mistake' : 'knowledge'
      const tags = [t.tags[0]]
      if (rand() < 0.55) tags.push(t.tags[1])
      if (rand() < 0.25) tags.push(pick(EXTRA_TAGS))
      const s1 = t.pool[(i * 2 + 1) % t.pool.length]
      const s2 = t.pool[(i * 3 + 2) % t.pool.length]
      const link = rand() < 0.6 ? `相关：[[${t.hub}]]。` : rand() < 0.5 ? `参见 [[${t.items[(i + 1) % t.items.length]}]]。` : ''
      cards.push({
        kind, title, tags,
        body: [`场景：${t.hub} · ${item}。`, rand() < 0.5 ? s1 : `${s1}${s2}`, `本条记录的是第 ${i + 1} 次遇到时的做法与理由。`, link].filter(Boolean).join('\n\n'),
      })
    }
  })
  return cards
}

/** 把演示卡写入 root。返回写入条数。 */
export async function seedDemoLibrary(root, { cards = 360 } = {}) {
  getDb(root)
  await ensureVault(root)
  setAuditConfig(root, { auditMode: 'none' }) // 演示数据直接进主库，图谱立刻可见
  let n = 0
  for (const c of buildDemoCards(cards)) {
    const r = await writeCard(root, { kind: c.kind, title: c.title, tags: c.tags, body: c.body, source: 'demo', submittedBy: 'demo', status: 'approved' }, { dedup: false })
    if (r.ok) n++
  }
  return n
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2]
  if (!dir) { console.error('用法：node scripts/demo/seed-demo.mjs <数据目录> [--cards N]'); process.exit(2) }
  const i = process.argv.indexOf('--cards')
  const n = await seedDemoLibrary(dir, { cards: i > 0 ? Number(process.argv[i + 1]) : 360 })
  console.log(`已写入 ${n} 张演示卡到 ${dir}`)
  closeDb(dir)
}

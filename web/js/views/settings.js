// 设置：A 审核（运行时可改，存 DB config 表）、B 去重 / C 保留与备份 / E 运行参数（只读，来自环境变量 / 配置文件 / 源码常量）、D 外观（纯前端，localStorage）。
// 只读区只展示脱敏后的有效值：不含密钥、令牌、服务器绝对路径。

import { h } from '../dom.js'
import { get, patch } from '../api.js'
import { pageHead } from '../ui.js'
import { fmtBytes, kindLabel, relTime } from '../format.js'
import { guard, toast, errText } from '../dialogs.js'
import { llmSection } from './settings-llm.js'
import { getTheme, setTheme, THEMES, THEME_LABEL, getAccent, setAccent, ACCENTS, ACCENT_LABEL } from '../theme.js'

const ALL = '__all__'
const yn = (b) => (b ? '开' : '关')

const section = (letter, title, desc, body) => h('section', { class: 'set-sec', 'aria-labelledby': `set-${letter}` }, [
  h('div', { class: 'set-intro' }, [h('div', { class: 'set-letter', 'aria-hidden': 'true' }, letter), h('h2', { id: `set-${letter}` }, title), h('p', { class: 'sub' }, desc)]),
  h('div', { class: 'set-body' }, body),
])

/** 只读键值表：每行 [标签, 值, 来源（环境变量名 / 说明）]。 */
const kv = (rows) => h('dl', { class: 'set-kv' }, rows.map(([label, value, src]) => h('div', null, [
  h('dt', null, [label, src ? h('small', null, src) : null]),
  h('dd', null, String(value)),
])))

const readonlyNote = () => h('p', { class: 'sub' }, '只读：需修改配置文件或环境变量后重启服务；此处仅显示当前生效值。')

export default async function render(ctx) {
  const d = await get('settings')
  ctx.setTitle('设置')
  const a = d.audit

  // ---- A 审核（可写）----
  const modeRadios = d.options.auditModes.map((m) => h('label', { class: 'set-opt' }, [
    h('input', { type: 'radio', name: 'auditMode', value: m, checked: a.mode === m }),
    h('span', null, [
      h('strong', null, m === 'all' ? '先审，受信署名 / 类型免审' : '全部免审'),
      h('small', null, m === 'all' ? '新卡先进待审队列（批准前 memory_recall 搜不到）；下方列表里的署名或类型写入后直接进入主库。（auditMode=all）' : '所有新卡写入后直接进入主库，不经待审。（auditMode=none）'),
    ]),
  ]))
  const checkChips = (name, values, selected, labelOf) => h('div', { class: 'set-chips' }, values.map((v) => h('label', { class: 'set-chip' }, [
    h('input', { type: 'checkbox', name, value: v, checked: selected.includes(v) }),
    labelOf(v),
  ])))
  const agentValues = [...new Set([...d.options.agents, ...a.exemptAgents])]
  const kindValues = [...new Set([...d.options.kinds, ...a.exemptKinds.filter((k) => k === ALL)])]
  const agentChips = agentValues.length
    ? checkChips('auditExemptAgents', agentValues, a.exemptAgents, (v) => (v === ALL ? '全部署名（__all__）' : v))
    : h('p', { class: 'sub' }, '还没有有效令牌；创建令牌后，这里可以勾选免审署名。')
  const kindChips = checkChips('auditExemptKinds', kindValues, a.exemptKinds, (v) => (v === ALL ? '全部类型（__all__）' : `${kindLabel(v)} · ${v}`))
  const err = h('div', { class: 'form-error', role: 'alert', hidden: true })
  const form = h('form', { class: 'set-form', 'aria-label': '审核设置' }, [
    h('fieldset', { class: 'set-group' }, [h('legend', null, 'auditMode'), ...modeRadios,
      a.mode ? null : h('p', { class: 'sub' }, '当前未设置：沿用调用方默认（Agent 经 MCP 沉淀的新卡通常进待审）。选择并保存后即显式生效。')]),
    h('fieldset', { class: 'set-group' }, [h('legend', null, '免审署名（仅「先审」模式生效）'), agentChips]),
    h('fieldset', { class: 'set-group' }, [h('legend', null, '免审类型（仅「先审」模式生效）'), kindChips]),
    err,
  ])
  const checked = (name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value)
  const readForm = () => ({ mode: form.querySelector('input[name="auditMode"]:checked')?.value || null, agents: checked('auditExemptAgents'), kinds: checked('auditExemptKinds') })
  const same = (x, y) => JSON.stringify([...x].sort()) === JSON.stringify([...y].sort())
  const save = h('button', { type: 'button', class: 'btn btn-primary' }, '保存审核设置')
  const reset = h('button', { type: 'button', class: 'btn' }, '还原')
  reset.addEventListener('click', () => ctx.reload())
  save.addEventListener('click', guard([save, reset], async () => {
    err.setAttribute('hidden', '')
    const v = readForm()
    const body = {}
    if (v.mode && v.mode !== a.mode) body.auditMode = v.mode
    if (!same(v.agents, a.exemptAgents)) body.auditExemptAgents = v.agents
    if (!same(v.kinds, a.exemptKinds)) body.auditExemptKinds = v.kinds
    if (!Object.keys(body).length) { toast('warn', a.mode ? '没有改动' : '请先选择审核模式'); return }
    try {
      const r = await patch('settings', body)
      toast('ok', `已保存审核设置（${r.changed.join('、')}），立即对新写入的卡生效`)
      ctx.reload()
    } catch (e) { err.textContent = errText(e); err.removeAttribute('hidden') }
  }))

  // ---- B / C / E 只读 ----
  const ro = d.readonly
  const dd = ro.dedup
  const last = ro.backup.last
  const sectionB = kv([
    ['近似重复阈值', dd.threshold, 'MEMORY_DEDUP_THRESHOLD（默认 0.62）'],
    ['同标题 + 中等正文相似去重', yn(dd.titleAware), 'MEMORY_DEDUP_TITLE_AWARE'],
    ['标题相似度下限', dd.titleSim, 'MEMORY_DEDUP_TITLE_SIM'],
    ['标题命中时正文相似度下限', dd.titleBodyMin, 'MEMORY_DEDUP_TITLE_BODY_MIN'],
    ['命中后合并独特行', yn(dd.merge), 'MEMORY_DEDUP_MERGE'],
    ['检查待审队列里的近似卡', yn(dd.pendingGuard), 'MEMORY_DEDUP_PENDING'],
  ])
  const sectionC = kv([
    ['回收站保留天数', `${ro.recycle.retentionDays} 天`, '源码常量，不可配置'],
    ['自动备份份数', ro.backup.count, '服务运行满 30 秒后首次备份'],
    ['最近一次备份', last ? `${relTime(last.at)} · ${fmtBytes(last.bytes)}` : '尚无备份文件'],
  ])
  const sectionE = kv([
    ['管理界面批量上限', ro.admin.maxBatch, 'MEMORY_HUB_ADMIN_MAX_BATCH'],
    ['管理界面只读保护', yn(ro.admin.readOnly), 'MEMORY_HUB_ADMIN_READONLY'],
    ['摄入：最短字符数', ro.ingest.minChars, 'MEMORY_HUB_INGEST_MIN_CHARS'],
    ['摄入：冷却（秒，0=无）', ro.ingest.cooldownS, 'MEMORY_HUB_INGEST_COOLDOWN_S'],
    ['摄入：每日配额', ro.ingest.dailyQuota, 'MEMORY_HUB_INGEST_DAILY_QUOTA'],
    ['摄入：请求体上限', fmtBytes(ro.ingest.maxBodyBytes), 'MEMORY_HUB_INGEST_MAX_BODY_BYTES'],
    ['MCP 暴露 tidy apply', yn(ro.mcp.exposeTidyApply), 'MEMORY_HUB_MCP_EXPOSE_TIDY_APPLY'],
    ['监听', `${ro.network.host}:${ro.network.port}${ro.network.basePath}`, 'MEMORY_HUB_HOST / _PORT / _BASE_PATH'],
    ['允许非回环监听', yn(ro.network.allowRemote), 'MEMORY_HUB_ALLOW_REMOTE'],
    ['信任反向代理头', yn(ro.network.trustProxy), 'MEMORY_HUB_TRUST_PROXY'],
    ['日志级别', ro.logLevel, 'MEMORY_HUB_LOG_LEVEL'],
  ])

  // ---- D 外观（纯前端）----
  const themeNow = getTheme()
  const accentNow = getAccent()
  const radioSeg = (name, items, current, labelOf, onPick) => h('div', { class: 'set-seg', role: 'radiogroup' }, items.map((v) => h('label', null, [
    h('input', { type: 'radio', name, value: v, checked: v === current, on: { change: () => onPick(v) } }),
    labelOf(v),
  ])))

  return h('div', { class: 'page settings' }, [
    pageHead('10', 'Settings', '设置', '审核规则可在此即时修改；其余运行参数只读展示当前生效值（脱敏）。'),
    section('A', '审核', '决定新卡写入后是否先进入待审队列。保存后立即生效，无需重启；每次保存记入审计日志。', [form,
      h('div', { class: 'set-save' }, [save, reset, h('span', { class: 'sub' }, '保存会记入审计日志。')])]),
    section('L', '蒸馏 LLM', '用于把对话提炼成卡片、经验闸门的 LLM 判定、图谱的 AI 汇总。OpenAI 兼容接口。保存后立即生效，无需重启。', await llmSection(ctx)),
    section('B', '去重与图谱', '阈值越低越容易判为近似重复。', [sectionB, readonlyNote()]),
    section('C', '保留与备份', '回收站清除周期与自动备份。', [sectionC, readonlyNote()]),
    section('D', '外观', '只存于当前浏览器（localStorage），不影响其他设备与用户。', [
      h('fieldset', { class: 'set-group' }, [h('legend', null, '主题'), radioSeg('theme', THEMES, themeNow, (v) => THEME_LABEL[v], (v) => setTheme(v))]),
      h('fieldset', { class: 'set-group' }, [h('legend', null, '强调色'), radioSeg('accent', ACCENTS, accentNow, (v) => ACCENT_LABEL[v], (v) => setAccent(v))]),
    ]),
    section('E', '运行参数', '服务启动时从环境变量 / 配置文件读取的参数。', [sectionE, readonlyNote()]),
  ])
}

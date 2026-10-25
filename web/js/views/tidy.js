// 整理中心：预览（tidyPlan，只读）→ 演练（dry-run）→ 输入确认词 → 执行 → 结果 / 回滚。
// 执行前服务端自动 VACUUM INTO 备份并校验；每批后自检，失败自动回滚该批；planId 过期则拒绝；maxDelete 限制单次软删数。

import { h } from '../dom.js'
import { get, post } from '../api.js'
import { panel, stat, notice, empty, badge, cardLink, icon, table, pageHead } from '../ui.js'
import { fmtNum, secretLabel, fmtDate } from '../format.js'
import { guard, toast, errText, confirmDialog } from '../dialogs.js'

const BATCH_LABEL = { noise: '清理噪声卡（软删）', merge: '合并近似重复（并入独特行，被吸收卡软删）', tags: '标签归一（规范写法写入规范表，之后不再翻转）', snapshots: '快照归入时间线卡（可选，被归入的快照软删）', topics: '合并同主题组（可选，被并入卡软删）' }
/** 可选批次：默认不勾选，只有管理员显式勾选才执行。 */
const OPTIONAL_BATCHES = ['snapshots', 'topics']
const BATCH_STATUS = { applied: ['已提交', 'ok'], rolled_back: ['失败，已整批回滚', 'bad'], skipped: ['跳过', 'mute'], 'dry-run': ['演练', 'accent'] }
const COUNT_LABEL = { removed: '软删', groups: '合并组', series: '快照序列', tagsChanged: '标签变更', canonPinned: '钉入规范表' }
const countsText = (c = {}) => Object.entries(c).filter(([k]) => k in COUNT_LABEL).map(([k, v]) => `${COUNT_LABEL[k]} ${v}`).join(' · ') || '—'

/** 执行结果（含失败时的各批次状态）。 */
export function resultPanel(r, ctx) {
  const rows = (r.batches || []).map((b) => ({ name: b.name, status: b.status, counts: b.counts, error: b.error }))
  return panel(r.dryRun ? '演练结果（库未改动）' : r.ok ? '整理已完成' : '整理未完成（失败的批次已自动回滚）', [
    r.dryRun ? notice('info', `预计软删 ${r.plannedDeletes} 张`, '演练只计算会做什么，没有改动任何数据。确认无误后点"确认执行…"。') : null,
    !r.dryRun && r.ok ? notice('ok', '已完成', `整理后：记忆库 ${r.after?.cards ?? '—'} 张，回收站 ${r.after?.deleted ?? '—'} 张。被软删的卡 30 天内可在回收站恢复。`) : null,
    !r.dryRun && !r.ok ? notice('bad', '有批次失败', '失败批次的改动已全部撤销；已成功的批次仍然有效，可用下方的回滚文件整体还原。') : null,
    table([
      { label: '批次', render: (x) => BATCH_LABEL[x.name] || x.name },
      { label: '状态', render: (x) => badge(BATCH_STATUS[x.status]?.[0] || x.status, BATCH_STATUS[x.status]?.[1] || 'neutral') },
      { label: '数量', render: (x) => countsText(x.counts) },
      { label: '说明', render: (x) => x.error || '—' },
    ], rows, { emptyText: '无批次' }),
    r.backup ? h('p', { class: 'sub' }, ['执行前备份：', h('code', null, r.backup.file), `（已校验 integrity_check=ok，cards=${r.backup.cards}）`]) : null,
    r.rollbackFile ? h('div', { class: 'rollback-line' }, [h('span', { class: 'sub' }, ['回滚文件：', h('code', null, r.rollbackFile)]), rollbackButton(r.rollbackFile, ctx)]) : null,
  ], { cls: 'result-panel' })
}

export function rollbackButton(file, ctx) {
  const b = h('button', { type: 'button', class: 'btn btn-danger-ghost btn-sm' }, '回滚这次整理…')
  b.addEventListener('click', guard(b, async () => {
    if (!(await confirmDialog({ title: '回滚这次整理？', danger: true, confirmText: '回滚', message: '被软删的卡将从回收站恢复，合并/标签改动还原为整理前的值。回滚前服务端会再做一次备份；回滚文件只能使用一次。', lines: [`回滚文件：${file}`] }))) return
    try {
      const r = await post('tidy/rollback', { rollbackFile: file, confirm: true })
      toast('ok', `已回滚：恢复 ${r.restored} 张卡，还原 ${r.reverted} 处正文/标签`)
      ctx.reload()
    } catch (e) { toast('bad', errText(e)) }
  }))
  return b
}

const section = (title, count, body, { open = false, tone = 'neutral', sub } = {}) => h('details', { class: 'fold', open }, [
  h('summary', null, [h('span', { class: 'fold-title' }, title), badge(fmtNum(count), count ? tone : 'mute'), sub ? h('span', { class: 'sub' }, sub) : null]),
  h('div', { class: 'fold-body' }, count ? body : empty('没有需要处理的项')),
])

export default async function render(ctx) {
  const threshold = ctx.params.get('threshold') || ''
  const [d, rbs] = await Promise.all([get('tidy/preview', { threshold, limit: 50 }), get('tidy/rollbacks')])
  ctx.setTitle('整理中心')
  const c = d.counts
  const form = h('form', { class: 'inline-form', on: { submit: (e) => {
    e.preventDefault()
    const v = String(new FormData(e.target).get('threshold') || '').trim()
    ctx.go('#/tidy' + (v ? `?threshold=${encodeURIComponent(v)}` : ''))
  } } }, [
    h('label', null, ['近似重复阈值（0.05–1）', h('input', { type: 'number', name: 'threshold', step: '0.01', min: '0.05', max: '1', value: threshold || String(d.options.threshold) })]),
    h('button', { class: 'btn btn-primary', type: 'submit' }, '重新生成预览'),
  ])
  const more = (k, n) => (d.truncated[k] ? h('p', { class: 'sub' }, `仅显示前 ${n} 项，共 ${c[{ noise: 'noise', duplicates: 'duplicateGroups', topics: 'topicGroups', snapshots: 'snapshotSeries', tags: 'tagChanges', kindMisplaced: 'kindMisplaced', secrets: 'secrets', oversizeRaw: 'oversizeRaw' }[k]]} 项`) : null)
  const topics = d.topics || []
  const snapshots = d.snapshots || []
  return h('div', { class: 'page' }, [
    pageHead('07', 'Tidy', '整理中心', '预览不会修改任何数据。要执行：先演练，再输入确认词，才会真正改库；执行前自动备份，批后自检，失败自动回滚。', h('span', { class: 'lab' }, ['planId ', h('code', null, d.planId), ` · ${fmtNum(d.totals.cards)} 张卡`])),
    h('div', { class: 'stats' }, [
      stat('噪声卡', c.noise, { tone: c.noise ? 'tone-warn' : '' }),
      stat('近似重复组', c.duplicateGroups, { hint: `可吸收 ${c.duplicateAbsorbable} 张` }),
      stat('同主题组', c.topicGroups ?? 0, { hint: `可并入 ${c.topicMembers ?? 0} 张` }),
      stat('快照序列', c.snapshotSeries ?? 0, { hint: `共 ${c.snapshotCards ?? 0} 张` }),
      stat('标签变更', c.tagChanges, { hint: `${d.tags.distinctBefore} → ${d.tags.distinctAfter} 种` }),
      stat('kind 错放', c.kindMisplaced),
      stat('密钥疑似', c.secrets, { tone: c.secrets ? 'tone-bad' : '', hint: '只显示路径与类型' }),
      stat('超大 raw 卡', c.oversizeRaw),
    ]),
    panel('参数', form, { sub: '阈值越低越容易判为近似重复；改完点"重新生成预览"' }),
    execPanel(d, threshold, ctx),
    rollbackList(rbs.items, ctx),
    h('div', { class: 'section-head' }, [h('h2', { class: 'section-title' }, '预览详情'), h('p', { class: 'sub' }, '执行前先看一遍每一类会动到哪些卡')]),
    section('噪声卡（仅 raw 原文卡）', c.noise, [h('ul', { class: 'plain-list' }, d.noise.map((n) => h('li', null, [cardLink(n.path, n.path), ' ', badge(n.reason, 'warn')]))), more('noise', d.noise.length)], { open: c.noise > 0, tone: 'warn', sub: '执行时软删进回收站' }),
    section('近似重复', c.duplicateGroups, [d.duplicates.map((g) => h('div', { class: 'dup-group' }, [
      h('div', { class: 'dup-keep' }, [badge('保留', 'ok'), cardLink(g.canonical.path, g.canonical.title || g.canonical.path)]),
      h('ul', null, g.absorbs.map((a) => h('li', null, [badge('吸收', 'warn'), cardLink(a.path, a.title || a.path), h('span', { class: 'sub' }, ` 相似 ${a.sim} · 独特行 ${a.uniqueLines}`)]))),
    ])), more('duplicates', d.duplicates.length)], { open: c.duplicateGroups > 0, tone: 'warn', sub: '保留最长卡，独特行并入' }),
    section('同主题组（标题 + 正文 + 标签 + 实体）', c.topicGroups ?? 0, [topics.map((g) => h('div', { class: 'dup-group' }, [
      h('div', { class: 'dup-keep' }, [badge('保留', 'ok'), cardLink(g.canonical.path, g.canonical.title || g.canonical.path)]),
      h('ul', null, g.members.map((m) => h('li', null, [badge('同主题', 'accent'), cardLink(m.path, m.title || m.path), h('span', { class: 'sub' }, ` 得分 ${m.score} · 标题 ${m.titleSim} · 正文 ${m.bodySim} · 标签 ${m.tagSim} · 实体 ${m.entitySim}`)]))),
    ])), more('topics', topics.length)], { tone: 'accent', sub: '只报告；勾选可选批次「合并同主题组」才合并' }),
    section('周期性快照序列', c.snapshotSeries ?? 0, [snapshots.map((g) => h('div', { class: 'dup-group' }, [
      h('div', { class: 'dup-keep' }, [badge(g.timeline.existing ? '已有时间线卡' : '时间线卡', 'ok'), cardLink(g.timeline.path, g.timeline.title), h('span', { class: 'sub' }, ` ${g.count} 张 · ${String(g.first || '').slice(0, 10)} ~ ${String(g.last || '').slice(0, 10)}`)]),
      h('ul', null, g.members.map((m) => h('li', null, [cardLink(m.path, m.title || m.path)]))),
    ])), more('snapshots', snapshots.length)], { tone: 'accent', sub: '只报告；勾选可选批次「快照归入时间线卡」才归并' }),
    section('标签归一', c.tagChanges, [
      Object.keys(d.tags.map).length ? h('div', { class: 'tag-map' }, Object.entries(d.tags.map).map(([from, to]) => h('span', { class: 'map-pair' }, [h('span', { class: 'tag' }, from), '→', h('span', { class: 'tag tag-strong' }, to)]))) : null,
      h('ul', { class: 'plain-list' }, d.tags.changes.map((x) => h('li', null, [cardLink(x.path, x.path), h('span', { class: 'sub' }, ` ${x.old.join(', ') || '∅'} → ${x.new.join(', ') || '∅'}`), x.malformed ? badge('tags 非法 JSON', 'bad') : null]))),
      more('tags', d.tags.changes.length),
    ], { tone: 'accent' }),
    section('kind 与路径前缀不一致', c.kindMisplaced, [h('ul', { class: 'plain-list' }, d.kindMisplaced.map((k) => h('li', null, [cardLink(k.path, k.path), h('span', { class: 'sub' }, ` kind=${k.kind}，路径暗示 ${k.expectedKind}`)]))), more('kindMisplaced', d.kindMisplaced.length)], { sub: '只报告，不自动改' }),
    section('明文密钥疑似', c.secrets, [h('ul', { class: 'plain-list' }, d.secrets.map((x) => h('li', null, [icon('lock', 'icon-sm'), cardLink(x.path, x.path), ' ', x.types.map((t) => badge(secretLabel(t), 'bad'))]))), more('secrets', d.secrets.length)], { open: c.secrets > 0, tone: 'bad', sub: '只显示卡路径与类型，从不显示值' }),
    section('超大 raw 卡', c.oversizeRaw, [h('ul', { class: 'plain-list' }, d.oversizeRaw.map((r) => h('li', null, [cardLink(r.path, r.path), h('span', { class: 'sub' }, ` ${fmtNum(r.chars)} 字`)]))), more('oversizeRaw', d.oversizeRaw.length)], { sub: '长会话原文未蒸馏' }),
  ])
}

function execPanel(d, threshold, ctx) {
  const resultHost = h('div', { class: 'result-host', 'aria-live': 'polite' })
  const checks = Object.keys(BATCH_LABEL).map((k) => h('input', { type: 'checkbox', value: k, checked: !OPTIONAL_BATCHES.includes(k), 'aria-label': BATCH_LABEL[k] }))
  const maxDelete = h('input', { type: 'number', min: '0', max: '5000', step: '1', value: '50', 'aria-label': 'maxDelete' })
  const dryBtn = h('button', { type: 'button', class: 'btn btn-primary' }, '演练（dry-run）')
  const goBtn = h('button', { type: 'button', class: 'btn btn-danger', disabled: true }, '确认执行…')
  const all = [dryBtn, goBtn, maxDelete, ...checks]
  let lastDry = null
  // 流程指示：1 选批次 → 2 演练 → 3 确认执行 → 4 结果与回滚（仅反映状态，不改变任何逻辑）
  const stepEls = ['选择批次与上限', '演练（dry-run）', '确认执行', '结果与回滚'].map((l, i) => h('li', { class: 'step' }, [h('span', { class: 'step-n' }, String(i + 1)), h('span', null, l)]))
  const steps = h('ol', { class: 'steps', 'aria-label': '整理流程' }, stepEls)
  const setStep = (n) => stepEls.forEach((el, i) => {
    el.className = 'step' + (i < n ? ' done' : i === n ? ' current' : '')
    if (i === n) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current')
  })
  setStep(0)
  const payload = (extra = {}) => ({
    planId: d.planId, batches: checks.filter((c) => c.checked).map((c) => c.value), maxDelete: Number(maxDelete.value),
    ...(threshold ? { threshold: Number(threshold) } : {}), ...extra,
  })
  const show = (node) => { while (resultHost.firstChild) resultHost.removeChild(resultHost.firstChild); if (node) resultHost.appendChild(node) }
  const fail = (e) => {
    if (e.code === 'plan_stale') show(notice('warn', '计划已过期', '库在你生成预览之后发生了变化（有新卡写入或被改动），为安全起见拒绝执行。请刷新预览后重新演练。'))
    else show(notice('bad', e.code === 'max_delete_exceeded' ? '超过 maxDelete 上限' : '没有执行', errText(e)))
    if (e.extra?.batches) show(resultPanel({ ...e.extra, ok: false, dryRun: false }, ctx))
  }
  const invalidate = () => { lastDry = null; goBtn.disabled = true; setStep(0) }
  for (const c of [...checks, maxDelete]) c.addEventListener('change', invalidate)
  dryBtn.addEventListener('click', guard(all, async () => {
    invalidate()
    if (!payload().batches.length) { show(notice('warn', '请至少勾选一个批次')); return }
    try {
      const r = await post('tidy/apply', payload())
      lastDry = r; show(resultPanel(r, ctx))
      goBtn.disabled = !(r.plannedDeletes > 0 || (r.summary?.tagChanges > 0 && payload().batches.includes('tags')) || (r.summary?.duplicateGroups > 0 && payload().batches.includes('merge'))
        || (r.summary?.topicGroups > 0 && payload().batches.includes('topics')) || (r.summary?.snapshotSeries > 0 && payload().batches.includes('snapshots')))
      setStep(goBtn.disabled ? 1 : 2)
      if (goBtn.disabled) show(notice('info', '没有需要执行的项', '所选批次下计划为空，无需执行。'))
    } catch (e) { fail(e); setStep(1) }
  }))
  goBtn.addEventListener('click', guard(all, async () => {
    if (!lastDry) return
    const p = payload()
    const ok = await confirmDialog({
      title: '确认执行整理？', danger: true, confirmText: '执行整理', requireText: '整理', requireLabel: '请输入「整理」以确认',
      message: '这会真正修改记忆库。执行前自动备份，批后自检，失败自动回滚该批；被软删的卡 30 天内可恢复。',
      lines: [`批次：${p.batches.map((b) => BATCH_LABEL[b]).join('；')}`, `预计软删 ${lastDry.plannedDeletes} 张（上限 maxDelete=${p.maxDelete}）`, `计划 ID：${d.planId}`],
    })
    if (!ok) return
    try {
      const r = await post('tidy/apply', payload({ confirm: true }))
      show(resultPanel(r, ctx)); toast('ok', '整理完成'); lastDry = null; goBtn.disabled = true; setStep(3)
    } catch (e) { fail(e); toast('bad', errText(e)) }
  }))
  return panel('执行整理', [
    steps,
    h('div', { class: 'exec-grid' }, [
      h('fieldset', { class: 'fieldset' }, [h('legend', null, '批次（按顺序执行）'), h('div', { class: 'checks' }, checks.map((c) => h('label', { class: 'check' }, [c, h('span', null, BATCH_LABEL[c.value])])))]),
      h('label', null, ['maxDelete（单次最多软删张数，超出则拒绝执行）', maxDelete]),
    ]),
    h('div', { class: 'edit-actions' }, [dryBtn, goBtn]),
    resultHost,
  ], { sub: '流程：演练 → 确认执行（输入确认词）→ 查看结果与回滚文件' })
}

function rollbackList(items, ctx) {
  if (!items.length) return null
  return panel('可用的回滚文件', table([
    { label: '时间', render: (x) => fmtDate(x.createdAt) },
    { label: '类型', render: (x) => (x.kind === 'tags' ? `标签操作${x.op ? '（' + x.op + '）' : ''}` : '整理') },
    { label: '内容', render: (x) => `软删 ${x.removed} · 合并 ${x.merged} · 标签 ${x.tagsChanged}` },
    { label: '文件', render: (x) => h('code', null, x.file) },
    { label: '', render: (x) => rollbackButton(x.file, ctx) },
  ], items), { sub: '回滚文件只能使用一次，使用后失效' })
}

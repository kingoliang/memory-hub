// 健康报告（memory_lint 同一份指标 + 主库不变量 + 备份）。

import { h } from '../dom.js'
import { get } from '../api.js'
import { panel, stat, badge, notice, cardLink, empty, icon, pageHead, secHead } from '../ui.js'
import { fmtNum, fmtBytes, fmtDate, secretLabel } from '../format.js'

const row = (label, value, tone) => h('li', null, [h('span', null, label), tone ? badge(String(value), tone) : h('strong', null, String(value))])

export default async function render(ctx) {
  const m = await get('lint')
  ctx.setTitle('健康报告')
  const ok = m.integrity === 'ok' && m.invariant.ok
  const issues = [
    m.secretSuspects ? `${m.secretSuspects} 张卡疑似含明文密钥` : null,
    m.tagsMalformed ? `${m.tagsMalformed} 张卡 tags 不是合法 JSON` : null,
    m.kindMisplaced ? `${m.kindMisplaced} 张卡 kind 与路径前缀不一致` : null,
  ].filter(Boolean)
  return h('div', { class: 'page' }, [
    pageHead('08', 'Health', '健康报告', `${fmtNum(m.total)} 张卡 · 重复阈值 ${m.threshold}`),
    h('div', { class: 'g12' }, [
    h('section', { class: 'c12' }, [secHead('A1', '状态'), h('div', { class: 'stack' }, [ok ? notice('ok', '数据库完整性正常', `integrity_check=ok，主库不变量通过（主库 ${fmtNum(m.invariant.mainTotal)} 张全部为 approved）`) : notice('bad', '发现完整性问题', `integrity_check=${m.integrity}；主库违规 ${JSON.stringify(m.invariant.violations)}`),
    issues.length ? notice('warn', '需要关注', issues.join('；')) : null])]),
    h('section', { class: 'c12' }, [secHead('B1', '核心指标'), h('div', { class: 'stats' }, [
      stat('噪声卡', m.noise, { tone: m.noise ? 'tone-warn' : '' }),
      stat('近似重复组', m.duplicateGroups, { hint: `可吸收 ${m.duplicateAbsorbable} 张` }),
      stat('标签种类', m.tagsDistinct, { hint: `仅一次 ${m.tagsSingleton} · 变体组 ${m.tagVariantGroups}` }),
      stat('密钥疑似', m.secretSuspects, { tone: m.secretSuspects ? 'tone-bad' : '' }),
      stat('隔离区', m.quarantine.pending + m.quarantine.rejected + m.quarantine.deleted, { hint: `待审 ${m.quarantine.pending} · 回收 ${m.quarantine.deleted}` }),
      stat('备份', m.backups.count, { hint: m.backups.last ? `最近 ${fmtDate(m.backups.last.at)} · ${fmtBytes(m.backups.last.bytes)}` : '尚无备份' }),
    ])]),
      panel('指标明细', h('ul', { class: 'kv-list' }, [
        row('噪声卡', m.noise, m.noise ? 'warn' : 'ok'),
        row('近似重复组 / 可吸收', `${m.duplicateGroups} / ${m.duplicateAbsorbable}`, m.duplicateGroups ? 'warn' : 'ok'),
        row('标签：种类 / 仅一次', `${m.tagsDistinct} / ${m.tagsSingleton}`),
        row('标签：变体组', m.tagVariantGroups, m.tagVariantGroups ? 'warn' : 'ok'),
        row(`超 ${m.maxTags ?? 4} 个标签的卡`, m.tagsOverMax ?? m.tagsOver4, (m.tagsOverMax ?? m.tagsOver4) ? 'warn' : 'ok'),
        row('同主题组 / 可并入', `${m.topicGroups ?? 0} / ${m.topicMembers ?? 0}`, m.topicGroups ? 'warn' : 'ok'),
        row('周期性快照序列 / 张数', `${m.snapshotSeries ?? 0} / ${m.snapshotCards ?? 0}`, m.snapshotSeries ? 'warn' : 'ok'),
        row('非法 tags', m.tagsMalformed, m.tagsMalformed ? 'bad' : 'ok'),
        row('kind 错放', m.kindMisplaced, m.kindMisplaced ? 'warn' : 'ok'),
        row('超大 raw 卡', m.oversizeRaw.length, m.oversizeRaw.length ? 'warn' : 'ok'),
        row('回收站最早删除', m.recycleOldest ? fmtDate(m.recycleOldest) : '—'),
      ]), { no: 'C1', cls: 'c7' }),
      panel('明文密钥疑似卡', m.secrets.length
        ? h('ul', { class: 'plain-list' }, m.secrets.map((x) => h('li', null, [icon('lock', 'icon-sm'), cardLink(x.path, x.path), ' ', x.types.map((t) => badge(secretLabel(t), 'bad'))])))
        : empty('没有发现'), { no: 'C2', cls: 'c5', sub: '只显示卡路径与类型，不含值' }),
    m.kindMisplacedList.length ? panel('kind 错放', h('ul', { class: 'plain-list' }, m.kindMisplacedList.map((k) => h('li', null, [cardLink(k.path, k.path), h('span', { class: 'sub' }, ` kind=${k.kind} → 路径暗示 ${k.expectedKind}`)]))), { no: 'D1', cls: 'c6' }) : null,
    m.oversizeRaw.length ? panel('超大 raw 卡', h('ul', { class: 'plain-list' }, m.oversizeRaw.map((r) => h('li', null, [cardLink(r.path, r.path), h('span', { class: 'sub' }, ` ${fmtNum(r.chars)} 字（门槛 ${fmtNum(m.rawMaxChars)}）`)]))), { no: 'D2', cls: 'c6' }) : null,
    ]),
  ])
}

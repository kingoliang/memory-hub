// memory-hub · 团队记忆与「先自己、后团队」分层检索
//
// 断言风格（见 docs/QUALITY_FIX_PLAYBOOK.zh.md §2.1 / 坑七）：
//   期望值全部写死为字面量，**不从被测模块推导**；集合断言用 deepEqual 整值比，
//   不用「逐项 includes / 子串 match」——后者对删元素的变异体免疫。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpHome, rmrf, durableText } from './helpers.mjs'
import { closeAllDb, getDb } from '../src/core/db.js'
import { ensureVault, writeCard, search, listCards, countCards } from '../src/core/vault.js'
import { VISIBILITIES, SCOPE_MODES, TIERS, visibleTiers, isVisibility, normalizeViewer, tierOf, rankHits } from '../src/core/scope.js'
import { findTool, callTool } from '../src/tools/registry.js'

const KINGO = { owner: 'kingo', team: 'remittance' }
const ALICE = { owner: 'alice', team: 'remittance' }
const BOB = { owner: 'bob', team: 'payments' }

const card = (owner, team, visibility, extra = {}) => ({ owner, team, visibility, ...extra })

/** 纯工具输出（>120 字符，过得了 capture 的长度闸；启发式只应命中 tool-log）。 */
const TOOL_LOG = [
  '$ npm test', 'PASS 12 tests',
  'ok 1 - 启动服务', 'ok 2 - 校验令牌', 'ok 3 - 剥离噪声', 'ok 4 - 写入卡片',
  'ok 5 - 幂等重放', 'ok 6 - 冷却窗口', 'ok 7 - 每日配额', 'ok 8 - 大 body 拒绝',
  'ok 9 - 去重命中', 'ok 10 - 审核闸门',
].join('\n')

// ─────────────────────────────────────────────────────────── 常量：整值字面量

test('scope 常量是完整集合（顺序即语义：public 最宽）', () => {
  assert.deepEqual(VISIBILITIES, ['private', 'team', 'public'])
  assert.deepEqual(SCOPE_MODES, ['auto', 'mine', 'team'])
  // tier 顺序 = 排序优先级：自己的最先
  assert.deepEqual(TIERS, ['self', 'team', 'public'])
})

test('isVisibility 只认三个字面量', () => {
  assert.deepEqual(
    ['private', 'team', 'public', 'PRIVATE', '', null, undefined, 'shared'].map(isVisibility),
    [true, true, true, false, false, false, false, false],
  )
})

test('visibleTiers：scope → 纳入的 tier 全集合', () => {
  assert.deepEqual(visibleTiers('mine'), ['self'])
  assert.deepEqual(visibleTiers('team'), ['self', 'team'])
  assert.deepEqual(visibleTiers('auto'), ['self', 'team', 'public'])
})

test('normalizeViewer：缺字段补空串，非法值不抛', () => {
  assert.deepEqual(normalizeViewer({ owner: 'kingo', team: 'remittance' }), { owner: 'kingo', team: 'remittance' })
  assert.deepEqual(normalizeViewer({ owner: 'kingo' }), { owner: 'kingo', team: '' })
  assert.deepEqual(normalizeViewer({}), { owner: '', team: '' })
  assert.deepEqual(normalizeViewer(null), { owner: '', team: '' })
  assert.deepEqual(normalizeViewer({ owner: 7, team: null }), { owner: '7', team: '' })
})

// ─────────────────────────────────────────────────────────── tierOf：可见性矩阵

test('tierOf：本人无视 visibility；他人 private 不可见；同团队优先于公开', () => {
  const cases = [
    // 本人（含跨团队）→ 永远是 self
    card('kingo', 'remittance', 'private'),
    card('kingo', 'remittance', 'team'),
    card('kingo', 'other', 'public'),
    card('kingo', '', ''),
    // 同团队他人
    card('alice', 'remittance', 'team'),
    card('alice', 'remittance', 'public'),
    // 同团队他人但私密 → 不可见（不降级为 team）
    card('alice', 'remittance', 'private'),
    // 跨团队
    card('bob', 'payments', 'public'),
    card('bob', 'payments', 'team'),
    card('bob', 'payments', 'private'),
  ]
  assert.deepEqual(cases.map((c) => tierOf(c, KINGO)), [
    'self', 'self', 'self', 'self',
    'team', 'team',
    null,
    'public', null, null,
  ])
})

test('tierOf：没有 viewer（stdio 单机模式）时一切可见且同 tier', () => {
  assert.deepEqual(
    [card('alice', 'remittance', 'private'), card('bob', 'payments', 'public'), card('kingo', 'x', 'team')].map((c) => tierOf(c, null)),
    ['self', 'self', 'self'],
  )
})

test('tierOf：owner 为空串的通配（老库 / 未配置）不因缺字段而丢卡', () => {
  // viewer 有 owner，卡没有 owner → 按 visibility 走；visibility 缺省视为 team
  assert.deepEqual(
    [
      tierOf(card('', 'remittance', 'team'), KINGO),
      tierOf(card('', 'remittance', ''), KINGO),
      tierOf(card('', 'other', 'public'), KINGO),
      tierOf(card('', 'other', 'team'), KINGO),
    ],
    ['team', 'team', 'public', null],
  )
})

// ─────────────────────────────────────────────────────────── rankHits：tier 先于 score

const HITS = [
  { path: 'p-team-strong', score: 50, mtime: 3, owner: 'alice', team: 'remittance', visibility: 'team' },
  { path: 'p-self-weak', score: 2, mtime: 1, owner: 'kingo', team: 'remittance', visibility: 'private' },
  { path: 'p-self-weaker', score: 1, mtime: 9, owner: 'kingo', team: 'remittance', visibility: 'team' },
  { path: 'p-public-mid', score: 9, mtime: 2, owner: 'bob', team: 'payments', visibility: 'public' },
  { path: 'p-hidden', score: 99, mtime: 9, owner: 'alice', team: 'remittance', visibility: 'private' },
]
const ranked = (scope, viewer = KINGO) => rankHits(HITS, viewer, scope).map((h) => `${h.path}:${h.tier}`)

test('rankHits：tier 升序优先，同 tier 内 score 降序，再按时间', () => {
  // 弱命中的自己的卡排在强命中的团队卡前面 —— 这正是「先搜自己」
  assert.deepEqual(ranked('auto'), [
    'p-self-weak:self',
    'p-self-weaker:self',
    'p-team-strong:team',
    'p-public-mid:public',
  ])
})

test('rankHits：scope 控制 tier 白名单', () => {
  assert.deepEqual(ranked('mine'), ['p-self-weak:self', 'p-self-weaker:self'])
  assert.deepEqual(ranked('team'), ['p-self-weak:self', 'p-self-weaker:self', 'p-team-strong:team'])
})

test('rankHits：无 viewer 时退化为纯 score 排序（与旧行为一致）', () => {
  assert.deepEqual(ranked('auto', null), [
    'p-hidden:self',
    'p-team-strong:self',
    'p-public-mid:self',
    'p-self-weak:self',
    'p-self-weaker:self',
  ])
})

test('rankHits：不改入参数组，也不给 hit 加 tier（返回新对象）', () => {
  const input = [{ path: 'a', score: 1, mtime: 0, owner: 'kingo', team: 'remittance', visibility: 'team' }]
  const out = rankHits(input, KINGO, 'auto')
  assert.deepEqual(out.map((h) => h.path), ['a'])
  assert.deepEqual(Object.keys(input[0]), ['path', 'score', 'mtime', 'owner', 'team', 'visibility'])
})

// ─────────────────────────────────────────────────────────── 落库 + 检索集成

async function withVault(fn) {
  const home = tmpHome()
  try {
    await ensureVault(home)
    getDb(home).prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('auditMode','none')").run()
    return await fn(home)
  } finally { closeAllDb(); rmrf(home) }
}

const put = (home, title, c) => writeCard(home, {
  kind: 'knowledge', title, body: `${title} 的正文：统一采用配置方案，原因是部署时不用改代码，步骤是先备份再重启。`,
  status: 'approved', submittedBy: c.owner || 'system', ...c,
}, { dedup: false })

test('writeCard 落 owner/team/visibility，listCards 能按它们过滤', async () => {
  await withVault(async (home) => {
    await put(home, '私卡', card('kingo', 'remittance', 'private'))
    await put(home, '团队卡', card('alice', 'remittance', 'team'))
    await put(home, '公开卡', card('bob', 'payments', 'public'))

    assert.deepEqual(
      (await listCards(home, { owner: 'alice' })).map((c) => c.title),
      ['团队卡'],
    )
    assert.deepEqual(
      (await listCards(home, { team: 'remittance' })).map((c) => c.title).sort(),
      ['团队卡', '私卡'],
    )
    assert.deepEqual(
      (await listCards(home, { visibility: 'public' })).map((c) => c.title),
      ['公开卡'],
    )
    assert.equal(await countCards(home, { visibility: 'private' }), 1)
    const one = (await listCards(home, { owner: 'kingo' }))[0]
    assert.deepEqual(
      { owner: one.owner, team: one.team, visibility: one.visibility },
      { owner: 'kingo', team: 'remittance', visibility: 'private' },
    )
  })
})

test('search：自己的先于团队、团队先于公开；他人私卡不出现在结果里', async () => {
  await withVault(async (home) => {
    await put(home, '部署流程团队版', card('alice', 'remittance', 'team'))
    await put(home, '部署流程自己的弱命中', card('kingo', 'remittance', 'team'))
    await put(home, '部署流程公开版', card('bob', 'payments', 'public'))
    await put(home, '部署流程他人私卡', card('alice', 'remittance', 'private'))

    const titles = (await search(home, '部署流程', { viewer: KINGO, scope: 'auto' })).map((h) => h.title)
    assert.deepEqual(titles, ['部署流程自己的弱命中', '部署流程团队版', '部署流程公开版'])
    assert.deepEqual(
      (await search(home, '部署流程', { viewer: KINGO, scope: 'mine' })).map((h) => h.title),
      ['部署流程自己的弱命中'],
    )
    assert.deepEqual(
      (await search(home, '部署流程', { viewer: KINGO, scope: 'team' })).map((h) => h.title),
      ['部署流程自己的弱命中', '部署流程团队版'],
    )
    // 每条命中带 tier，供渲染层分组标注
    assert.deepEqual(
      (await search(home, '部署流程', { viewer: KINGO, scope: 'auto' })).map((h) => h.tier),
      ['self', 'team', 'public'],
    )
  })
})

test('search：无 viewer 时不过滤可见性（老行为），全部落同一 tier', async () => {
  await withVault(async (home) => {
    await put(home, '甲', card('alice', 'remittance', 'private'))
    await put(home, '乙', card('bob', 'payments', 'public'))
    const hits = await search(home, '正文')
    assert.deepEqual(hits.map((h) => h.title).sort(), ['乙', '甲'])
    assert.deepEqual(hits.map((h) => h.tier), ['self', 'self'])
  })
})

// ─────────────────────────────────────────────────────────── MCP 工具层

test('memory_recall 按 tier 分组标注，自己在前；memory_whoami 暴露归属', async () => {
  await withVault(async (home) => {
    await put(home, '检索一条自己的', card('kingo', 'remittance', 'team'))
    await put(home, '检索一条团队的', card('alice', 'remittance', 'team'))
    const ctx = {
      root: home,
      identity: { type: 'agent', id: 't1', name: 'claude', owner: 'kingo', team: 'remittance', ip: '' },
      config: { dbRoot: home, home }, llm: null, log: { info() {}, warn() {}, error() {}, debug() {} },
    }
    const out = await callTool(findTool('memory_recall'), { query: '检索一条' }, ctx)
    const text = out.content[0].text
    assert.equal(out.isError, undefined)
    assert.deepEqual(
      text.split('\n').filter((l) => /^\[/.test(l)),
      ['[自己的记忆] 1 条', '[团队 · alice] 1 条'],
    )
    assert.deepEqual(
      text.split('\n').filter((l) => /^### /.test(l)).map((l) => l.replace(/^### \d+\. /, '')),
      ['检索一条自己的', '检索一条团队的'],
    )

    const who = await callTool(findTool('memory_whoami'), {}, ctx)
    assert.deepEqual(JSON.parse(who.content[0].text), {
      name: 'claude', owner: 'kingo', team: 'remittance', visibility: 'team', recall_scope: 'auto',
    })
  })
})

test('memory_capture 带 visibility，且默认沿用令牌的 defaultVisibility', async () => {
  await withVault(async (home) => {
    const ctx = (visibility) => ({
      root: home,
      identity: { type: 'agent', id: 't1', name: 'claude', owner: 'kingo', team: 'remittance', visibility, ip: '' },
      config: { dbRoot: home, home, gate: { capture: 'off' } }, llm: null, log: { info() {}, warn() {}, error() {}, debug() {} },
    })
    const t1 = `${durableText('可见性归属甲')}\n结论：默认 team 可见性，因为同团队就该互相看得见；只想给自己就传 visibility=private。`
    const t2 = `${durableText('可见性归属乙')}\n踩坑：两张测试卡正文太像会被去重吞掉，所以必须让正文不同，否则只落一张。`
    assert.equal(t1.length > 120, true)
    assert.equal(t2.length > 120, true)
    await callTool(findTool('memory_capture'), { text: t1 }, ctx('private'))
    await callTool(findTool('memory_capture'), { text: t2, visibility: 'public' }, ctx('private'))
    const rows = getDb(home).prepare('SELECT owner, team, visibility FROM cards ORDER BY id').all()
    assert.deepEqual(rows.map((r) => `${r.owner}|${r.team}|${r.visibility}`), ['kingo|remittance|private', 'kingo|remittance|public'])
  })
})

test('memory_capture：日常操作被闸门挡下；force=true 绕过闸门', async () => {
  await withVault(async (home) => {
    const ctx = {
      root: home,
      identity: { type: 'agent', id: 't1', name: 'claude', owner: 'kingo', team: 'remittance', visibility: 'team', ip: '' },
      config: { dbRoot: home, home, gate: { capture: 'strict' } }, llm: null, log: { info() {}, warn() {}, error() {}, debug() {} },
    }
    assert.deepEqual(JSON.parse((await callTool(findTool('memory_capture'), { text: TOOL_LOG }, ctx)).content[0].text), {
      ok: true, action: 'skipped', reason: 'gate:routine', gate: { verdict: 'routine', via: 'heuristic', score: -2, signals: ['tool-log'] },
    })
    const forced = JSON.parse((await callTool(findTool('memory_capture'), { text: TOOL_LOG, force: true }, ctx)).content[0].text)
    assert.deepEqual({ ok: forced.ok, action: forced.action }, { ok: true, action: 'created' })
    assert.equal(getDb(home).prepare('SELECT COUNT(*) n FROM cards').get().n, 1)
  })
})

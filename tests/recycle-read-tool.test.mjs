// MCP 工具层 · memory_read 的回收站开关与 memory_recall 的回收站提示（GH #15）
//
// 工具层要保证的是「人/agent 看到的输出」：
//   - 默认不带 includeDeleted：回收站卡仍然报原提示，另外补一句「可加 includeDeleted:true」；
//   - 带 includeDeleted:true：返回全文，头部写清「回收站 · 于 <时间> … · 可用 restore 还原」；
//   - recall 的命中数只算在库卡，返回体里另起一句说明回收站里还有几张同主题卡（带路径）；
//   - 权限沿用 read：只有 read scope 的令牌就能读回收站。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rpc, toolText } from './helpers.mjs'
import { withHub } from './hub-helpers.mjs'
import { writeCard, softDeleteCardSync } from '../src/core/vault.js'
import { getDb } from '../src/core/db.js'

const mkCard = (root, title, body) => writeCard(root, { kind: 'knowledge', title, body, status: 'approved', submittedBy: 'fx' }, { dedup: false })

const tidyDelete = (root, rel, keeper) => softDeleteCardSync(getDb(root), rel, {
  changedBy: 'tidy',
  reason: `整理：快照归入时间线 ${keeper}`,
  quarantineReason: `整理：归入时间线 ${keeper}`,
})

const call = async (h, tok, name, args) => {
  const r = await rpc(h.url, tok, 'tools/call', { name, arguments: args })
  return { status: r.status, text: toolText(r), body: r.body }
}

test('memory_read：不带 includeDeleted 时回收站卡报原提示 + 开关提示', async () => {
  await withHub(async (h) => {
    const tok = h.token('a', ['read'])
    const { path: rel } = await mkCard(h.home, '被吸收的快照', '正文只在回收站。')
    tidyDelete(h.home, rel, '03-Knowledge/时间线.md')
    const r = await call(h, tok, 'memory_read', { paths: [rel] })
    assert.match(r.text, /读取失败：这张卡未通过审核或已在回收站，不能读取/)
    assert.match(r.text, /includeDeleted:true/)
  })
})

test('memory_read：includeDeleted=true 返回全文 + 回收站标注（时间 / 归档去向 / restore）', async () => {
  await withHub(async (h) => {
    const tok = h.token('a', ['read'])
    const body = `正文开头。${'完整快照内容。'.repeat(30)}正文结尾。`
    const { path: rel } = await mkCard(h.home, '被吸收的快照', body)
    tidyDelete(h.home, rel, '03-Knowledge/值班网格时间线.md')
    const r = await call(h, tok, 'memory_read', { paths: [rel], includeDeleted: true })
    assert.equal(r.status, 200)
    assert.doesNotMatch(r.text, /读取失败/)
    assert.match(r.text, /回收站 · 于 \d{4}-\d{2}-\d{2} 由整理归入时间线卡 03-Knowledge\/值班网格时间线\.md · 可用 restore 还原/)
    assert.match(r.text, /正文开头。/)
    assert.match(r.text, /正文结尾。/, '长正文要完整返回，不能被摘要替代')
    assert.match(r.text, /已完整返回/)
  })
})

test('memory_read：合并来源（并入保留卡）与普通软删的标注各自正确', async () => {
  await withHub(async (h) => {
    const tok = h.token('a', ['read'])
    const merged = await mkCard(h.home, '被合并卡', '被合并的正文。')
    const plain = await mkCard(h.home, '管理员删掉的卡', '管理员删掉的正文。')
    softDeleteCardSync(getDb(h.home), merged.path, { changedBy: 'tidy', reason: '整理：近重复合并', quarantineReason: '整理：并入 03-Knowledge/保留卡.md' })
    softDeleteCardSync(getDb(h.home), plain.path, { changedBy: 'admin', reason: '管理员软删进回收站', quarantineReason: '移入回收站' })
    const r = await call(h, tok, 'memory_read', { paths: [merged.path, plain.path], includeDeleted: true })
    assert.match(r.text, /由整理并入保留卡 03-Knowledge\/保留卡\.md · 可用 restore 还原/)
    assert.match(r.text, /原因：移入回收站 · 可用 restore 还原/)
  })
})

test('memory_read：待审 / 驳回卡即使 includeDeleted=true 也拒绝，且不出现回收站字样', async () => {
  await withHub(async (h) => {
    const tok = h.token('a', ['read'])
    const p = await writeCard(h.home, { kind: 'knowledge', title: '待审卡', body: '待审正文。', submittedBy: 'x' }, { dedup: false })
    const r = await call(h, tok, 'memory_read', { paths: [p.path], includeDeleted: true })
    assert.match(r.text, /读取失败：这张卡未通过审核或已在回收站，不能读取/)
    assert.doesNotMatch(r.text, /回收站 · 于/)
  })
})

test('memory_read：在库卡与回收站卡混读，在库卡输出不变（不回归）', async () => {
  await withHub(async (h) => {
    const tok = h.token('a', ['read'])
    const alive = await mkCard(h.home, '在库卡', '在库正文。')
    const dead = await mkCard(h.home, '回收站卡', '回收站正文。')
    tidyDelete(h.home, dead.path, '03-Knowledge/时间线.md')
    const r = await call(h, tok, 'memory_read', { paths: [alive.path, dead.path], includeDeleted: true })
    assert.match(r.text, /在库正文。/)
    assert.match(r.text, /回收站正文。/)
    // 在库卡那一段没有回收站标注：只有紧跟回收站卡标题的那一行才该有
    const aliveBlock = r.text.split('\n\n---\n\n')[0]
    assert.doesNotMatch(aliveBlock, /回收站 · 于/)
  })
})

test('memory_recall：命中数只算在库卡，返回体另起一句给出回收站条数与路径', async () => {
  await withHub(async (h) => {
    const tok = h.token('a', ['read'])
    const alive = await mkCard(h.home, 'comboz 值班 网格 时间线', 'comboz 值班 网格 的保留时间线卡正文。')
    const d1 = await mkCard(h.home, 'comboz 值班 网格 快照 2026-10-01', 'comboz 值班 网格 2026-10-01 完整快照。')
    const d2 = await mkCard(h.home, 'comboz 值班 网格 快照 2026-10-02', 'comboz 值班 网格 2026-10-02 完整快照。')
    const other = await mkCard(h.home, '编辑器 快捷键', '编辑器快捷键，与值班网格无关。')
    for (const p of [d1.path, d2.path, other.path]) tidyDelete(h.home, p, '03-Knowledge/值班网格时间线.md')

    const r = await call(h, tok, 'memory_recall', { query: 'comboz 值班 网格' })
    assert.match(r.text, /共命中 1 张/, '回收站卡不进命中数')
    assert.match(r.text, new RegExp(alive.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(r.text, /另有 2 张同主题卡在回收站/)
    assert.match(r.text, /includeDeleted:true/)
    // 提示里给出的是回收站路径，直接照着读得出来
    const hinted = /（如 ([^）]+)）/.exec(r.text)
    assert.ok(hinted, r.text)
    for (const p of hinted[1].split('、')) assert.ok([d1.path, d2.path].includes(p), p)
  })
})

test('memory_recall：库里零命中但回收站有时，仍然给出条数与路径', async () => {
  await withHub(async (h) => {
    const tok = h.token('a', ['read'])
    const d = await mkCard(h.home, 'comboz 值班 网格 快照', 'comboz 值班 网格 的唯一副本。')
    tidyDelete(h.home, d.path, '03-Knowledge/时间线.md')
    const r = await call(h, tok, 'memory_recall', { query: 'comboz 值班 网格' })
    assert.match(r.text, /没有与「comboz 值班 网格」相关的内容/)
    assert.match(r.text, /另有 1 张同主题卡在回收站/)
    assert.match(r.text, new RegExp(d.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
})

test('memory_recall：回收站里没有同主题卡时不出现这句（不凭空加噪音）', async () => {
  await withHub(async (h) => {
    const tok = h.token('a', ['read'])
    await mkCard(h.home, 'comboz 值班 网格', 'comboz 值班 网格 正文。')
    const r = await call(h, tok, 'memory_recall', { query: 'comboz 值班 网格' })
    assert.doesNotMatch(r.text, /在回收站/)
  })
})

test('权限沿用 read：只有 read scope 也能读回收站卡（不需要 tidy:apply）', async () => {
  await withHub(async (h) => {
    const tok = h.token('reader', ['read'])
    const { path: rel } = await mkCard(h.home, '回收站卡', '回收站正文。')
    tidyDelete(h.home, rel, '03-Knowledge/时间线.md')
    const r = await call(h, tok, 'memory_read', { paths: [rel], includeDeleted: true })
    assert.equal(r.status, 200)
    assert.match(r.text, /回收站正文。/)
  })
})

// 记忆核心 · 回收站读路径（GH #15）
//
// 背景：整理（近重复合并 / 快照归入时间线卡）只把「独特行」并进保留卡，被吸收的卡软删进回收站，
// 全文只剩在回收站里。memory_read 以前只读主库，agent 于是拿不到那些完整历史。
//
// 本文件锁定四件事：
//   1. 默认行为不回归：不带 includeDeleted 时回收站卡照旧读不到，提示语不变；
//   2. includeDeleted=true 时回收站卡照常返回全文，并带上删除时间 / 归档去向（保留卡路径）/ restore 提示；
//   3. 待审 / 驳回卡即使 includeDeleted=true 也仍被拒绝（它们没定稿）；
//   4. countDeletedCards 的计数与库内实际条数一致，且用的是与召回相同的严格判定。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ensureVault, writeCard, setCardStatus, readApprovedCard, countDeletedCards, softDeleteCardSync,
} from '../../src/core/vault.js'
import { getDb, closeAllDb } from '../../src/core/db.js'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-recycle-read-'))
after(async () => {
  closeAllDb()
  try { await fs.rm(tmpRoot, { recursive: true, force: true }) } catch { /* Windows 句柄未释放时忽略 */ }
})

let seq = 0
const freshRoot = async () => {
  const root = path.join(tmpRoot, `vault-${seq++}`)
  await ensureVault(root)
  return root
}

/** 写一张 approved 卡（正文互不相同，免得被去重拦下）。 */
const mkCard = (root, title, body) => writeCard(root, { kind: 'knowledge', title, body, status: 'approved', submittedBy: 'fx' }, { dedup: false })

/** 按整理的口径软删（quarantine_reason 就是归档去向的线索）。 */
const tidyDelete = (root, rel, keeper, verb = '归入时间线') => {
  softDeleteCardSync(getDb(root), rel, {
    changedBy: 'tidy',
    reason: `整理：${verb} ${keeper}`,
    quarantineReason: `整理：${verb} ${keeper}`,
  })
}

test('approved 卡：带不带 includeDeleted 都读得到，且没有回收站标注', async () => {
  const root = await freshRoot()
  const { path: rel } = await mkCard(root, '在库卡', '正文：在库里，能直接读。')
  for (const opts of [undefined, { includeDeleted: true }]) {
    const card = readApprovedCard(root, rel, opts)
    assert.equal(card.body, '正文：在库里，能直接读。')
    assert.equal(card.recycle, undefined)
  }
})

test('软删卡：默认仍报 CARD_NOT_APPROVED（提示语不变），并带上状态供调用方提示', async () => {
  const root = await freshRoot()
  const { path: rel } = await mkCard(root, '被吸收的快照', '正文：只在回收站里。')
  tidyDelete(root, rel, '03-Knowledge/时间线.md')
  assert.throws(() => readApprovedCard(root, rel), (e) => {
    assert.equal(e.code, 'CARD_NOT_APPROVED')
    assert.equal(e.status, 'deleted')
    assert.equal(e.message, `卡片未通过审核或已删除，不能读取：${rel}`)
    return true
  })
})

test('软删卡：includeDeleted=true 返回全文 + 删除时间 + 归档去向', async () => {
  const root = await freshRoot()
  const body = `正文：${'完整内容。'.repeat(50)}`
  const { path: rel } = await mkCard(root, '被吸收的快照', body)
  tidyDelete(root, rel, '03-Knowledge/值班网格时间线.md')
  const card = readApprovedCard(root, rel, { includeDeleted: true })
  assert.equal(card.body, body, '必须返回完整正文，不能只剩摘要')
  assert.equal(card.path, rel)
  assert.ok(card.recycle.deletedAt, '要带删除时间')
  assert.match(card.recycle.quarantineReason, /归入时间线 03-Knowledge\/值班网格时间线\.md$/)
})

test('待审 / 驳回卡：includeDeleted=true 也不放行（没定稿）', async () => {
  const root = await freshRoot()
  const pending = await writeCard(root, { kind: 'knowledge', title: '待审卡', body: '待审正文要够长一点点。', submittedBy: 'x' }, { dedup: false })
  const rejected = await writeCard(root, { kind: 'knowledge', title: '驳回卡', body: '驳回正文也要够长一点点。', submittedBy: 'x' }, { dedup: false })
  setCardStatus(root, rejected.path, 'rejected', { changedBy: 'fx' })
  for (const rel of [pending.path, rejected.path]) {
    assert.throws(() => readApprovedCard(root, rel, { includeDeleted: true }), (e) => e.code === 'CARD_NOT_APPROVED')
  }
})

test('不存在的路径：CARD_NOT_FOUND（includeDeleted 不影响）', async () => {
  const root = await freshRoot()
  assert.throws(() => readApprovedCard(root, '03-Knowledge/没有这张卡.md', { includeDeleted: true }), (e) => e.code === 'CARD_NOT_FOUND')
})

test('countDeletedCards：只数回收站里真命中的卡，计数与实际条数一致', async () => {
  const root = await freshRoot()
  const hit1 = await mkCard(root, 'comboz 值班 网格 快照一', 'comboz 值班 网格 2026-10-01 的完整快照正文。')
  const hit2 = await mkCard(root, 'comboz 值班 网格 快照二', 'comboz 值班 网格 2026-10-02 的完整快照正文。')
  const other = await mkCard(root, '编辑器 快捷键', '编辑器快捷键与主题配色，与值班网格无关。')
  const alive = await mkCard(root, '在库里的值班网格卡', 'comboz 值班 网格 的保留时间线卡。')
  tidyDelete(root, hit1.path, '03-Knowledge/时间线.md')
  tidyDelete(root, hit2.path, '03-Knowledge/时间线.md')
  tidyDelete(root, other.path, '03-Knowledge/时间线.md')

  const res = countDeletedCards(root, 'comboz 值班 网格')
  assert.equal(res.total, 2, '只数命中主题的两张，不算无关卡，也不算仍在库里的那两张')
  assert.deepEqual(res.paths.sort(), [hit1.path, hit2.path].sort())
  assert.ok(!res.paths.includes(alive.path), '在库卡不属于回收站计数')

  const db = getDb(root)
  const actual = db.prepare("SELECT COUNT(*) n FROM quarantine WHERE status = 'deleted'").get().n
  assert.equal(actual, 3)
  assert.ok(res.total <= actual)
})

test('countDeletedCards：空查询 / 空回收站都返回 0，不抛错', async () => {
  const root = await freshRoot()
  assert.deepEqual(countDeletedCards(root, ''), { total: 0, paths: [] })
  await mkCard(root, '在库卡', '正文。')
  assert.deepEqual(countDeletedCards(root, '随便什么词'), { total: 0, paths: [] })
})

test('countDeletedCards：软删后立刻可见，restore 后立刻消失（索引按签名失效）', async () => {
  const root = await freshRoot()
  const { path: rel } = await mkCard(root, 'xqzv 回收索引', 'xqzv 回收索引 的正文。')
  assert.equal(countDeletedCards(root, 'xqzv 回收索引').total, 0)
  tidyDelete(root, rel, '03-Knowledge/时间线.md')
  assert.equal(countDeletedCards(root, 'xqzv 回收索引').total, 1)
  const { restoreCard } = await import('../../src/core/vault.js')
  await restoreCard(root, rel)
  assert.equal(countDeletedCards(root, 'xqzv 回收索引').total, 0)
})

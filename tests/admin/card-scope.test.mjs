// M4 · 单卡编辑归属（owner / team / visibility）
//
// 为什么必须有：旧库导入后 owner 只能取 submitted_by（往往是 agent 名，如 deepseek-harness），
// 人要能把它改成真正的人名；也允许清空（清空 = 回到"无主"，老卡语义）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withAdminHub } from './admin-helpers.mjs'
import { loggedIn, rowOf } from '../admin-write/write-helpers.mjs'
import { getDb, closeAllDb } from '../../src/core/db.js'
import { ensureVault, writeCard } from '../../src/core/vault.js'

const put = (home, title, c) => writeCard(home, {
  kind: 'knowledge', title, body: `${title} 的正文：长到足够避开相似度去重带来的意外合并。`,
  status: 'approved', submittedBy: c.owner, ...c,
}, { dedup: false })

async function withCard(fn) {
  return withAdminHub(async (h) => {
    getDb(h.home).prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('auditMode','none')").run()
    await ensureVault(h.home)
    await put(h.home, '待改归属的卡', { owner: 'deepseek-harness', team: 'default', visibility: 'team' })
    closeAllDb()
    const c = await loggedIn(h)
    const card = (await c.get('/admin/api/cards?limit=5')).json.items[0]
    return fn(h, c, card)
  }, { seed: false })
}

const scopeOf = (h, path) => {
  const r = rowOf(h, path)
  return [r.owner, r.team, r.visibility]
}

test('PATCH /card 改归属：落库、changed 字面量、updatedAt 前移', async () => {
  await withCard(async (h, c, card) => {
    const r = await c.patch('/admin/api/card', { path: card.path, expectedUpdatedAt: card.updatedAt, owner: 'kingo', team: 'remittance', visibility: 'private' })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.changed.sort(), ['owner', 'team', 'visibility'])
    assert.deepEqual(scopeOf(h, card.path), ['kingo', 'remittance', 'private'])
    assert.equal(h.db().prepare("SELECT outcome FROM write_log WHERE action = 'edit' ORDER BY id DESC LIMIT 1").get().outcome, 'ok')
  })
})

test('PATCH /card 归属清空成空串（回到"无主"老卡语义）', async () => {
  await withCard(async (h, c, card) => {
    const r = await c.patch('/admin/api/card', { path: card.path, expectedUpdatedAt: card.updatedAt, owner: '', team: '' })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.changed.sort(), ['owner', 'team'])
    assert.deepEqual(scopeOf(h, card.path), ['', '', 'team'])
  })
})

test('PATCH /card 非法归属 → 400 且消息是字面量', async () => {
  await withCard(async (_h, c, card) => {
    const badVis = await c.patch('/admin/api/card', { path: card.path, expectedUpdatedAt: card.updatedAt, visibility: 'shared' })
    assert.equal(badVis.status, 400, badVis.text)
    assert.match(badVis.json.message, /visibility 只能是 private \/ team \/ public/)
    const badOwner = await c.patch('/admin/api/card', { path: card.path, expectedUpdatedAt: card.updatedAt, owner: 'kingo liang' })
    assert.equal(badOwner.status, 400, badOwner.text)
    assert.match(badOwner.json.message, /owner 只能含字母数字/)
  })
})

test('PATCH /card 只给归属也算"有要改的字段"', async () => {
  await withCard(async (_h, c, card) => {
    const r = await c.patch('/admin/api/card', { path: card.path, expectedUpdatedAt: card.updatedAt, team: 'payments' })
    assert.equal(r.status, 200, r.text)
    assert.deepEqual(r.json.changed, ['team'])
  })
})

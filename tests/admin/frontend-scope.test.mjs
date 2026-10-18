// 前端 · 归属展示与归属过滤（多团队、每团队多人的可见语义要落在界面上）
//
// 这里测的是"人看得见"：卡片行要显示 owner@team 与非默认可见性，
// 筛选面板要能按归属/团队/可见性过滤，并且过滤值真的被带进了请求。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDocument, walkNodes, textOf } from './fake-dom.mjs'

async function withFakeDom(fn) {
  const doc = new FakeDocument()
  const prev = { document: globalThis.document, location: globalThis.location, history: globalThis.history, matchMedia: globalThis.matchMedia }
  globalThis.document = doc
  globalThis.location = { href: 'http://localhost/admin/', hash: '#/cards?owner=alice&team=remittance&visibility=private' }
  globalThis.history = { replaceState: () => {} }
  globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {} })
  try { return await fn(doc) } finally {
    globalThis.document = prev.document
    globalThis.location = prev.location
    globalThis.history = prev.history
    globalThis.matchMedia = prev.matchMedia
  }
}

const CARD = (over) => ({
  path: '03-Knowledge/x.md', title: '标题', kind: 'knowledge', tags: [], status: 'approved',
  agent: 'claude', agentFromSource: false, excerpt: '正文', updatedAt: '2026-10-18T00:00:00.000Z',
  secretTypes: [], ...over,
})

test('卡片行显示归属 owner@team 与非默认可见性；无归属的历史卡不显示', async () => {
  await withFakeDom(async () => {
    const { cardRow } = await import('../../web/js/views/cards.js')

    const own = textOf(cardRow(CARD({ owner: 'alice', team: 'remittance', visibility: 'private' })))
    assert.ok(own.includes('alice@remittance'), own)
    assert.ok(own.includes('仅自己'), own)

    const cross = textOf(cardRow(CARD({ owner: 'bob', team: 'payments', visibility: 'public' })))
    assert.ok(cross.includes('bob@payments'), cross)
    assert.ok(cross.includes('跨团队'), cross)

    // 默认 team 可见性不加徽标（不然每行都是噪声）
    const normal = textOf(cardRow(CARD({ owner: 'alice', team: 'remittance', visibility: 'team' })))
    assert.ok(normal.includes('alice@remittance'), normal)
    assert.equal(normal.includes('仅自己') || normal.includes('跨团队'), false)

    // 升级前的老卡：owner/team 都是空串 → 不渲染归属块
    const legacy = textOf(cardRow(CARD({ owner: '', team: '', visibility: 'team' })))
    assert.equal(/@/.test(legacy), false, legacy)
  })
})

test('筛选面板有 归属/团队/可见性 三个条件，且过滤值来自 URL 并被带进请求', async () => {
  await withFakeDom(async () => {
    const urls = []
    globalThis.fetch = async (url) => {
      urls.push(String(url))
      const body = String(url).includes('/facets')
        ? { statuses: [], kinds: [], agents: [], tags: [] }
        : { total: 1, offset: 0, limit: 20, items: [CARD({ owner: 'alice', team: 'remittance', visibility: 'private' })] }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body }
    }
    const { default: render } = await import('../../web/js/views/cards.js')
    const params = new URLSearchParams('owner=alice&team=remittance&visibility=private')
    const root = await render({ params, go: () => {}, reload: () => {}, setTitle: () => {} })

    const labels = [...walkNodes(root)].map((n) => n.attributes?.name).filter(Boolean)
    assert.deepEqual(labels.filter((n) => ['owner', 'team', 'visibility'].includes(n)).sort(), ['owner', 'team', 'visibility'])

    const cardsUrl = urls.find((u) => u.includes('/api/cards'))
    assert.ok(cardsUrl, urls.join('\n'))
    const q = new URL(cardsUrl, 'http://x').searchParams
    assert.deepEqual([q.get('owner'), q.get('team'), q.get('visibility')], ['alice', 'remittance', 'private'])

    // 已生效筛选要显式列出来，人就看得见"现在筛的是什么"
    assert.match(textOf(root), /已筛选：.*归属 alice.*团队 remittance.*可见性 private/s)
  })
})

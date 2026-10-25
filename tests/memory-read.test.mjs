// memory_read 与 memory_recall 新输出（GH #2）：读全文 / 分段 / 待审·驳回·回收站不可读 / 更新记录 / detail=full 预算 / 总命中数。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rpc, toolText } from './helpers.mjs'
import { withHub } from './hub-helpers.mjs'
import { writeCard, appendUpdate, deleteCard, searchCards } from '../src/core/vault.js'
import { RECALL_FULL_BUDGET, MEMORY_READ_DEFAULT_CHARS } from '../src/tools/registry.js'

const call = async (h, tok, name, args) => {
  const r = await rpc(h.url, tok, 'tools/call', { name, arguments: args })
  return { text: toolText(r), isError: !!r.body?.result?.isError }
}
const approved = (home, title, body, extra = {}) => writeCard(home, { kind: 'knowledge', title, tags: ['t1'], body, status: 'approved', submittedBy: 'fx', ...extra }, { dedup: false })

test('memory_read：返回完整正文 + 标签 + 时间 + 更新记录；多张一起读；不存在 / 待审 / 驳回 / 回收站都读不到正文', async () => {
  await withHub(async (h) => {
    const tok = h.token('reader', ['read'])
    const tail = '尾部唯一标记 endmark-71'
    const a = await approved(h.home, '完整卡', `# 完整卡\n\n${'第一段很长的正文。'.repeat(30)}\n\n${tail}`)
    await appendUpdate(h.home, a.path, '后来补充：阈值改成 0.8')
    const b = await approved(h.home, '第二张', '第二张的正文 second-body')
    const pending = await writeCard(h.home, { kind: 'knowledge', title: '待审卡', body: '待审正文 pending-secret-body', status: 'pending', submittedBy: 'fx' }, { dedup: false })
    const rej = await approved(h.home, '驳回卡', '驳回正文 rejected-body')
    h.db().prepare('UPDATE cards SET status = ? WHERE path = ?').run('approved', rej.path)
    const { setCardStatus } = await import('../src/core/vault.js')
    await setCardStatus(h.home, rej.path, 'rejected')
    const del = await approved(h.home, '回收卡', '回收站正文 deleted-body')
    await deleteCard(h.home, del.path)

    const r = await call(h, tok, 'memory_read', { paths: [a.path, b.path] })
    assert.equal(r.isError, false)
    assert.ok(r.text.includes(tail), '全文必须包含正文末尾')
    assert.ok(r.text.includes('后来补充：阈值改成 0.8'), '必须带上追加的更新记录')
    assert.match(r.text, /## 更新记录/)
    assert.match(r.text, /标签：t1/)
    assert.match(r.text, /更新：\d{4}-/)
    assert.ok(r.text.includes('second-body'))
    assert.match(r.text, /已完整返回/)

    for (const p of [pending.path, rej.path, del.path]) {
      const x = await call(h, tok, 'memory_read', { paths: [p] })
      assert.equal(x.isError, true, p)
      assert.match(x.text, /未通过审核或已在回收站/)
      assert.ok(!/pending-secret-body|rejected-body|deleted-body/.test(x.text), '隔离区正文绝不能泄露')
    }
    const nf = await call(h, tok, 'memory_read', { paths: ['03-Knowledge/none.md'] })
    assert.equal(nf.isError, true)
    assert.match(nf.text, /卡片不存在/)
    // 混合：能读的照读，读不了的单独说明，整体不算错误
    const mix = await call(h, tok, 'memory_read', { paths: [b.path, pending.path] })
    assert.equal(mix.isError, false)
    assert.ok(mix.text.includes('second-body') && !mix.text.includes('pending-secret-body'))
    // 参数校验
    assert.equal((await rpc(h.url, tok, 'tools/call', { name: 'memory_read', arguments: { paths: [] } })).body.result?.isError ?? true, true)
    // 审计：读操作记进 write_log
    assert.ok(h.db().prepare("SELECT 1 FROM write_log WHERE tool = 'memory_read' AND action = 'read'").get())
  })
})

test('memory_read 分段：超长卡按 offset / maxChars 读，写明范围与剩余字数，拼起来等于全文', async () => {
  await withHub(async (h) => {
    const tok = h.token('reader', ['read'])
    const body = Array.from({ length: 400 }, (_, i) => `第${i}句内容。`).join('')
    const a = await approved(h.home, '超长卡', body)
    const first = await call(h, tok, 'memory_read', { paths: [a.path] })
    assert.ok(body.length > MEMORY_READ_DEFAULT_CHARS || /已完整返回/.test(first.text))
    let offset = 0
    let joined = ''
    for (let guard = 0; guard < 20; guard++) {
      const r = await call(h, tok, 'memory_read', { paths: [a.path], offset, maxChars: 1000 })
      const m = /本段第 (\d+)~(\d+) 字(?:，还剩 (\d+) 字：用 offset=(\d+) 继续读|，已读完)/.exec(r.text)
      assert.ok(m, r.text.slice(0, 200))
      assert.equal(Number(m[1]), offset + 1)
      joined += r.text.split('\n\n').slice(1).join('\n\n')
      if (!m[3]) break
      assert.equal(Number(m[3]), body.length - Number(m[2]))
      offset = Number(m[4])
    }
    assert.equal(joined, body, '各段拼起来必须等于全文')
    const over = await call(h, tok, 'memory_read', { paths: [a.path], offset: body.length + 5 })
    assert.match(over.text, /已超出全文长度/)
  })
})

test('memory_recall：片段含命中词、写明总命中数与 memory_read 提示；detail=full 附全文且受总预算约束', async () => {
  await withHub(async (h) => {
    const tok = h.token('reader', ['read'])
    const filler = '与查询无关的背景铺垫。'.repeat(60)
    const target = await approved(h.home, '网关超时', `# 网关超时\n\n## 背景\n\n${filler}\n\n**结论**：kestrelgate 网关超时要调到 30 秒。`)
    for (let i = 0; i < 8; i++) await approved(h.home, `网关笔记 ${i}`, `# 网关笔记 ${i}\n\nkestrelgate 网关第 ${i} 条记录。${'填充文字。'.repeat(1500)}`)
    const r = await call(h, tok, 'memory_recall', { query: 'kestrelgate 网关', limit: 3 })
    assert.match(r.text, /^从记忆核心检索到 3 条相关卡片（共命中 9 张，按相关度显示前 3 张）：/)
    assert.match(r.text, /memory_read/)
    assert.match(r.text, /还有 6 张未显示/)
    // 稀有词「超时」只在目标卡里：IDF 加权覆盖率把只沾通用词的 8 张挡掉，片段落在命中处
    const one = await call(h, tok, 'memory_recall', { query: 'kestrelgate 超时' })
    assert.match(one.text, /^从记忆核心检索到 1 条相关卡片（共命中 1 张）：\n\n### 1\. 网关超时/)
    assert.match(one.text, /片段：.*kestrelgate 网关超时要调到 30 秒/)
    assert.ok(!/片段：[^\n]*[#*]/.test(one.text), '片段不应带 Markdown 标记')

    const full = await call(h, tok, 'memory_recall', { query: 'kestrelgate 网关', limit: 5, detail: 'full' })
    assert.ok(full.text.includes(target.path))
    assert.ok(full.text.length < RECALL_FULL_BUDGET + 3000, `detail=full 总长受预算约束：${full.text.length}`)
    assert.match(full.text, /全文已截断：还剩 \d+ 字，用 memory_read 读取后续部分/)
    // 与 search 同一实现：总数一致
    const { total } = await searchCards(h.home, 'kestrelgate 网关', { strict: true })
    assert.match(full.text, new RegExp(`共命中 ${total} 张`))
  })
})

test('图谱蜘蛛搜索与 memory_recall 共用同一检索实现：同查询同顺序，片段取命中处', async () => {
  const { withAdminHub } = await import('./admin/admin-helpers.mjs')
  await withAdminHub(async (h) => {
    const c = h.client()
    assert.equal((await c.login()).status, 200)
    await approved(h.home, '鸢尾流程', `# 鸢尾流程\n\n${'无关铺垫。'.repeat(80)}irisflow 审批要两人确认。`)
    const r = await c.req('POST', '/admin/api/graph/search', { body: { q: 'irisflow 审批' }, withCsrf: true })
    assert.equal(r.status, 200, r.text)
    const { hits, total } = await searchCards(h.home, 'irisflow 审批', { strict: true, limit: 12 })
    assert.deepEqual(r.json.hits.map((x) => x.path), hits.map((x) => x.path))
    assert.equal(r.json.total, total)
    assert.match(r.json.hits[0].snippet, /irisflow 审批要两人确认/)
  }, { env: { MEMORY_HUB_GRAPH_SEARCH_MIN_INTERVAL_MS: '0' } })
})

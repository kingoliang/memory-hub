// 前端 · 设置页 LLM 表单：key 框永远空白（只写不读）；环境变量锁定时全部禁用；read() 只在填了 key 时带 key。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeDocument } from './fake-dom.mjs'

async function withFakeDom(fn) {
  const prev = globalThis.document
  globalThis.document = new FakeDocument()
  try { return await fn() } finally { globalThis.document = prev }
}

test('已配置：回显 baseUrl / model，key 框空白且占位提示「已设置」；不填 key 时 read() 不带 key', async () => {
  await withFakeDom(async () => {
    const { llmForm } = await import('../../web/js/views/settings-llm.js')
    const f = llmForm({ source: 'admin', envLocked: false, baseUrl: 'https://llm.example.test/v1', model: 'm1', keySet: true, reasoningEffort: 'low', timeoutMs: 30000 })
    assert.deepEqual([f.controls.baseUrl.value, f.controls.model.value, f.controls.key.value, f.controls.key.getAttribute('type')], ['https://llm.example.test/v1', 'm1', '', 'password'])
    assert.equal(f.controls.key.getAttribute('placeholder'), '已设置（不显示）· 留空 = 保持不变')
    assert.deepEqual(f.read(), { baseUrl: 'https://llm.example.test/v1', model: 'm1', reasoningEffort: 'low', timeoutMs: 30000 })
    f.controls.key.value = 'sk-new'
    assert.equal(f.read().key, 'sk-new')
    assert.equal(f.locked, false)
  })
})

test('环境变量锁定：所有输入禁用', async () => {
  await withFakeDom(async () => {
    const { llmForm } = await import('../../web/js/views/settings-llm.js')
    const f = llmForm({ source: 'env', envLocked: true, baseUrl: 'https://env.test/v1', model: 'e', keySet: true, reasoningEffort: '', timeoutMs: 90000 })
    assert.equal(f.locked, true)
    assert.deepEqual(Object.values(f.controls).map((c) => c.disabled), [true, true, true, true, true, true])
  })
})

// 展示层 plainExcerpt：剥 Markdown 记号，不误伤 snake_case
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { plainExcerpt } = await import(pathToFileURL(path.join(ROOT, 'web/js/format.js')).href)

test('plainExcerpt：剥掉紧贴中文标点后的 _斜体_ / *斜体*', () => {
  assert.equal(plainExcerpt('结论：_重要_，请注意'), '结论：重要，请注意')
  assert.equal(plainExcerpt('原因，*关键*。'), '原因，关键。')
  assert.equal(plainExcerpt('注意（_此处_）'), '注意（此处）')
})

test('plainExcerpt：保持 snake_case 与普通下划线不被误伤', () => {
  assert.equal(plainExcerpt('字段 user_id 与 max_retry_count'), '字段 user_id 与 max_retry_count')
  assert.equal(plainExcerpt('说明：user_id 和 a_b_c'), '说明：user_id 和 a_b_c')
  assert.equal(plainExcerpt('空格 _斜体_ 仍可剥'), '空格 斜体 仍可剥')
})

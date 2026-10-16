// 合并 / 追加按边界截取：不在句中 / 词中硬切；字面 \n 规整（代码里的不动）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withHub } from './hub-helpers.mjs'
import { MERGE_SECTION_TITLE, truncateAtBoundary, normalizeLiteralEscapes, uniqueLinesAgainst, mergeIntoCard, writeCard } from '../src/core/vault.js'

const S1 = '第一句是完整的结论，说明采用阶梯重试方案并保留诊断日志字段。'
const S2 = '第二句补充原因，推理模型的思考会吃掉输出预算导致内容为空。'

test('句末截取：超限时保留到最后一个完整句子，不加省略号', () => {
  const t = S1 + S2 + '第三句还没写完就会被切掉' .repeat(10)
  const max = S1.length + S2.length + 5
  const out = truncateAtBoundary(t, max)
  assert.equal(out, S1 + S2)
  assert.ok(out.length <= max)
})

test('句末标点后的收尾引号 / 括号一并保留', () => {
  assert.equal(truncateAtBoundary('这是一句话。」后面又有很多很多字符没有结束', 8), '这是一句话。」')
  assert.equal(truncateAtBoundary('这是一句话！）后面又有很多很多字符没有结束', 8), '这是一句话！）')
})

test('无句末标点时按换行边界截取', () => {
  const t = 'A'.repeat(0) + '第一行内容比较长的一段文字没有标点\n第二行内容也比较长的一段文字没有标点\n第三行' + '字'.repeat(50)
  const out = truncateAtBoundary(t, 40)
  assert.ok(!out.includes('第三行'))
  assert.ok(t.startsWith(out.replace(/…$/, '')))
  assert.ok(!out.endsWith('\n'))
})

test('纯长中文无标点：在词边界截取并加「…」，长度不超上限', () => {
  const t = '今天我们讨论了很多问题关于配置中心的改造方案以及调度器的稳定性'.repeat(10)
  const out = truncateAtBoundary(t, 50)
  assert.ok(out.endsWith('…'))
  assert.ok(out.length <= 50)
  const body = out.slice(0, -1)
  // 切点必须落在分词边界：下一个字符与最后一个字符不能属于同一个词
  const seg = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(t.slice(0, 80))]
  assert.ok(seg.some((x) => x.index + x.segment.length === body.length), `切点不在词边界：${body.slice(-6)}`)
})

test('英文：不切在单词中间', () => {
  const t = 'internationalization considerations require careful planning around localization '.repeat(8)
  const out = truncateAtBoundary(t, 47)
  assert.ok(out.endsWith('…'))
  const words = new Set(t.split(/\s+/))
  assert.ok(words.has(out.slice(0, -1).split(/\s+/).pop()), out)
})

test('不超限原样返回；无任何边界才字符硬切并加「…」', () => {
  assert.equal(truncateAtBoundary('短文本', 300), '短文本')
  const blob = 'x'.repeat(500)
  const out = truncateAtBoundary(blob, 100)
  assert.equal(out, 'x'.repeat(99) + '…')
})

test('字面 \\n / \\t 规整成真实换行 / 空白；围栏与行内代码、路径里的不动', () => {
  assert.equal(normalizeLiteralEscapes('第一行\\n第二行\\t末\\r\\n尾'), '第一行\n第二行 末\n尾')
  const code = '说明\\n```js\nconsole.log("a\\nb")\n```\\n行内 `x\\ny` 与路径 C:\\new\\table'
  const out = normalizeLiteralEscapes(code)
  assert.ok(out.startsWith('说明\n```js'))
  assert.ok(out.includes('console.log("a\\nb")'), '围栏代码里的 \\n 必须保留')
  assert.ok(out.includes('`x\\ny`'), '行内代码里的 \\n 必须保留')
  assert.ok(out.includes('C:\\new\\table'), '路径里的反斜杠序列必须保留')
  assert.ok(out.includes('```\n行内'))
})

test('uniqueLinesAgainst：超长行在句界截断（上限仍是 300），字面 \\n 先拆成多行', () => {
  const sentence = '这是一条用于测试的完整结论句子，包含足够多的字数。'
  const long = sentence.repeat(30) // 远超 300，且每句以「。」结尾
  const [l] = uniqueLinesAgainst('无关目标正文内容', long)
  assert.ok(l.length <= 300)
  assert.ok(l.endsWith('。'), `应在句末截断：…${l.slice(-8)}`)
  const lines = uniqueLinesAgainst('无关目标', '- 第一条独立的补充内容足够长\\n- 第二条独立的补充内容足够长')
  assert.equal(lines.length, 2)
  assert.ok(lines.every((x) => !x.includes('\\n')))
})

test('mergeIntoCard 端到端：追加后的正文里没有句中截断、没有字面 \\n', async () => {
  await withHub(async (h) => {
    const r = await writeCard(h.home, { kind: 'knowledge', title: '合并截断测试卡', body: '# 合并截断测试卡\n\n- 目标卡原有的一条内容', status: 'approved', submittedBy: 's' }, { dedup: false })
    const long = '补充说明第一条完整句子，描述了具体的处理步骤与注意事项。'.repeat(20)
    await mergeIntoCard(h.home, r.path, `${long}\\n- 第二条独立补充内容，来自同一次更新。`)
    const body = h.db().prepare('SELECT body FROM cards WHERE path = ?').get(r.path).body
    assert.ok(!body.includes('\\n'))
    const added = body.split(MERGE_SECTION_TITLE)[1].trim().split('\n').filter(Boolean)
    assert.ok(added.length >= 2)
    for (const l of added) assert.ok(/[。…]$|更新。$/.test(l), `行未在边界结束：${l.slice(-10)}`)
    assert.ok(added.every((l) => l.length <= 300))
  })
})

// M2 前端：Markdown 安全渲染、DOM 构造不走 innerHTML、页面渲染 XSS 内容后只产生文本节点
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FakeDocument, walkNodes, textOf } from './fake-dom.mjs'
import { XSS_TITLE, XSS_BODY } from './admin-helpers.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const WEB = path.join(ROOT, 'web')
const jsFiles = () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
  return walk(WEB).filter((f) => f.endsWith('.js'))
}

test('源码禁用 innerHTML / outerHTML / insertAdjacentHTML / document.write / eval / new Function / 内联事件', () => {
  const files = jsFiles()
  assert.ok(files.length >= 8, '应有多个前端模块')
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1')
    for (const re of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\s*\(/, /setAttribute\(\s*['"]on/i, /setAttribute\(\s*['"]style['"]/, /srcdoc/, /createContextualFragment/, /DOMParser/]) {
      assert.ok(!re.test(src), `${path.relative(ROOT, f)} 使用了 ${re}`)
    }
  }
})

test('全部前端文件是 ES module 且不引用外部地址、不引入框架', () => {
  for (const f of jsFiles()) {
    const src = fs.readFileSync(f, 'utf8')
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(src), `${path.relative(ROOT, f)} 引用了外部 URL`)
    assert.ok(!/from\s+['"](?!\.)/.test(src), `${path.relative(ROOT, f)} 只能相对导入`)
  }
  const css = fs.readFileSync(path.join(WEB, 'styles.css'), 'utf8')
  assert.ok(!/@import|url\(\s*['"]?https?:/.test(css), 'CSS 不得引用外部资源')
  assert.match(css, /prefers-color-scheme:\s*dark/, '深色模式跟随系统')
  assert.match(css, /@media[^{]*max-width/, '响应式')
})

test('Markdown 解析：HTML 标签只当文本；javascript: 链接被丢弃；块级结构正确', async () => {
  const { parseMarkdown, safeUrl } = await import('../../web/js/markdown.js')
  const ast = parseMarkdown(XSS_BODY)
  const flat = JSON.stringify(ast)
  assert.ok(flat.includes('<script>window.__xss=1</script>'), '脚本文本应原样作为文本保留，由渲染层 textContent 输出')
  assert.ok(!/"tag"|"html"|"raw"/i.test(flat), 'AST 里不得有原始 HTML 节点')
  const links = []
  ;(function collect(n) { if (Array.isArray(n)) n.forEach(collect); else if (n && typeof n === 'object') { if (n.type === 'link') links.push(n); Object.values(n).forEach(collect) } })(ast)
  assert.ok(links.every((l) => safeUrl(l.href) !== null), '不得保留不安全链接')
  assert.equal(safeUrl('javascript:alert(1)'), null)
  assert.equal(safeUrl('  JaVaScRiPt:alert(1)'), null)
  assert.equal(safeUrl('java\tscript:alert(1)'), null)
  assert.equal(safeUrl('data:text/html;base64,AAAA'), null)
  assert.equal(safeUrl('vbscript:x'), null)
  assert.equal(safeUrl('//evil.example/x'), null)
  assert.equal(safeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.equal(safeUrl('http://example.com'), 'http://example.com')
  assert.equal(safeUrl('/relative'), null)

  const md = parseMarkdown('# 标题\n\n段落 **粗** 与 `代码` 与 [链接](https://example.com)\n\n- a\n- b\n\n```js\nconst x = "<b>";\n```\n\n> 引用')
  assert.deepEqual(md.map((b) => b.type), ['heading', 'paragraph', 'list', 'code', 'quote'])
  assert.equal(md[0].level, 1)
  assert.equal(md[2].items.length, 2)
  assert.equal(md[3].text, 'const x = "<b>";')
})

test('Markdown 解析：超长 / 病态输入不卡死、不抛错（线性时间）', async () => {
  const { parseMarkdown } = await import('../../web/js/markdown.js')
  const t0 = Date.now()
  for (const s of ['*'.repeat(100000), '['.repeat(50000), '`'.repeat(50000), '](('.repeat(30000), '**a'.repeat(30000), '\n'.repeat(100000), '- '.repeat(50000), '> '.repeat(50000), '#'.repeat(100000)]) parseMarkdown(s)
  assert.ok(Date.now() - t0 < 3000, `耗时 ${Date.now() - t0}ms`)
})

async function withFakeDom(fn) {
  const doc = new FakeDocument()
  const prev = globalThis.document
  globalThis.document = doc
  try { return await fn(doc) } finally { globalThis.document = prev }
}

test('DOM 助手 h()：字符串子节点一律是文本节点；属性里的 on* 与 style 被拒绝；href 只允许安全协议', async () => {
  await withFakeDom(async (doc) => {
    const { h } = await import('../../web/js/dom.js')
    const el = h('div', { class: 'x', 'data-k': '<b>' }, '<img src=x onerror=alert(1)>', h('span', null, '<script>1</script>'))
    const nodes = [...walkNodes(el)]
    assert.ok(nodes.every((n) => !['img', 'script'].includes(n.tagName?.toLowerCase())))
    assert.equal(textOf(el), '<img src=x onerror=alert(1)><script>1</script>')
    assert.throws(() => h('div', { onclick: 'alert(1)' }), /不允许/)
    assert.throws(() => h('div', { style: 'x' }), /不允许/)
    assert.throws(() => h('script', {}), /不允许/)
    const a = h('a', { href: 'javascript:alert(1)' }, 'x')
    assert.notEqual(a.attributes.href, 'javascript:alert(1)')
    const ok = h('a', { href: 'https://example.com' }, 'x')
    assert.equal(ok.attributes.href, 'https://example.com')
    assert.match(ok.attributes.rel, /noopener/)
  })
})

test('Markdown 渲染到 DOM：XSS 正文渲染后没有 script / img / on* 属性 / javascript: 链接，文本原样可见', async () => {
  await withFakeDom(async () => {
    const { renderMarkdown } = await import('../../web/js/markdown.js')
    const root = renderMarkdown(XSS_BODY)
    const nodes = [...walkNodes(root)]
    const tags = new Set(nodes.map((n) => n.tagName?.toLowerCase()).filter(Boolean))
    for (const bad of ['script', 'img', 'iframe', 'object', 'embed', 'style', 'svg', 'link']) assert.ok(!tags.has(bad), `渲染产生了 <${bad}>`)
    for (const n of nodes) {
      for (const [k, v] of Object.entries(n.attributes || {})) {
        assert.ok(!/^on/i.test(k), `事件属性 ${k}`)
        assert.ok(!/^\s*javascript:/i.test(String(v)), `危险值 ${k}=${v}`)
      }
    }
    const text = textOf(root)
    assert.ok(text.includes('<script>window.__xss=1</script>'))
    assert.ok(text.includes('<img src=x onerror="window.__xss=2">'))
    assert.ok(text.includes('加粗'))
    assert.ok(tags.has('strong') && tags.has('code'))
    assert.equal(globalThis.__xss, undefined)
  })
})

test('卡片详情页渲染 XSS 卡：标题 / 标签 / 正文都只是文本', async () => {
  await withFakeDom(async () => {
    const { renderCardDetail } = await import('../../web/js/views/card.js')
    const card = {
      path: '03-Knowledge/x.md', title: XSS_TITLE, kind: 'knowledge', tags: ['<b>x</b>', '"><script>1</script>'], status: 'approved', body: XSS_BODY,
      submittedBy: '<i>agent</i>', agent: '<i>agent</i>', source: '<u>src</u>', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z', deletedAt: null,
      signedByToken: null, updates: [{ content: '<script>u</script>', createdAt: '2026-09-02' }], revisions: [{ title: '<img onerror=1>', body: '<script>r</script>', editedBy: '<b>', editedAt: '2026-09-02', tags: [] }],
      history: [{ oldStatus: 'pending', newStatus: 'approved', changedBy: '<b>', reason: '<script>h</script>', createdAt: '2026-09-02' }], redacted: false, secretTypes: [], quarantine: null, retention: null, writes: [],
    }
    const root = renderCardDetail(card)
    const nodes = [...walkNodes(root)]
    const tags = new Set(nodes.map((n) => n.tagName?.toLowerCase()).filter(Boolean))
    for (const bad of ['script', 'img', 'iframe', 'style']) assert.ok(!tags.has(bad), `渲染产生了 <${bad}>`)
    // 允许出现我们自己的静态 SVG 图标，但任何元素的属性名/值都不得带有卡片里的载荷
    for (const n of nodes) {
      for (const [k, v] of Object.entries(n.attributes || {})) {
        assert.ok(!/^on/i.test(k), k)
        assert.ok(!/onerror|<script|javascript:/i.test(String(v)), `${k}=${v}`)
      }
    }
    const text = textOf(root)
    assert.ok(text.includes(XSS_TITLE))
    assert.ok(text.includes('<script>1</script>'))
  })
})

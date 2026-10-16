// 图谱蜘蛛搜索：结果面板（收集篮）+ 卡片飞出动画 + 与后端的交互（graph/search → 巡游收集；graph/summarize → AI 汇总）。
// 只用 dom.js 的 h()（文本节点，无 innerHTML）；动画用 Web Animations（CSP 允许，不写内联 style 属性）。
// 蜘蛛引擎在 graph-spider.js；本模块不碰 canvas。

import { h } from './dom.js'
import { post } from './api.js'

const FLY_MS = 650
const FLY_W = 210

const plain = (t, n) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }

/**
 * @param {{ spider: object, host: HTMLElement, nodeScreen: (id:string)=>({x:number,y:number}|null), hasNode: (id:string)=>boolean,
 *           colorOf: (kind:string)=>string, kindLabel: (k:string)=>string, onFocus: (path:string, inGraph:boolean)=>void, onChange?: ()=>void }} o
 */
export function createSpiderSearch(o) {
  const { spider, host, nodeScreen, hasNode, colorOf, kindLabel, onFocus } = o
  const onChange = o.onChange || (() => {})
  const hook = (name, ...a) => { try { o[name]?.(...a) } catch { /* 相机钩子失败不影响搜索 */ } }
  const flies = new Set() // 进行中的飞行卡片 { el, anim }
  let token = 0
  let hits = []
  let collapsed = false
  let currentFinish = null
  const shown = new Set()

  const status = h('span', { class: 'sp-status sub' })
  const live = h('div', { class: 'sp-live', 'aria-live': 'polite', 'aria-atomic': 'true', role: 'status' })
  const sum = h('div', { class: 'sp-sum' })
  const list = h('ol', { class: 'sp-list', 'aria-label': '蜘蛛收集到的卡片' })
  const body = h('div', { class: 'sp-body' }, [sum, list])
  const toggle = h('button', { type: 'button', class: 'sp-btn', 'aria-expanded': 'true', 'aria-label': '收起结果面板', title: '收起 / 展开', on: { click: () => setCollapsed(!collapsed) } }, '▾')
  const skipBtn = h('button', { type: 'button', class: 'sp-skip', hidden: true, title: '跳过动画，立刻显示全部结果', on: { click: () => api.interrupt() } }, '跳过动画')
  const clearBtn = h('button', { type: 'button', class: 'sp-btn', 'aria-label': '清除搜索', title: '清除搜索（Esc）', on: { click: () => clear() } }, '×')
  const panel = h('section', { class: 'spider-panel', role: 'region', 'aria-label': '蜘蛛搜索结果', hidden: true, tabindex: '-1',
    on: { keydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); clear() } } } }, [
    h('header', { class: 'sp-head' }, [h('strong', { class: 'sp-title' }, '蜘蛛搜索'), status, h('span', { class: 'sp-spacer' }), skipBtn, toggle, clearBtn]),
    body, live,
  ])

  function setCollapsed(v) {
    collapsed = v
    if (v) body.setAttribute('hidden', ''); else body.removeAttribute('hidden')
    toggle.setAttribute('aria-expanded', v ? 'false' : 'true')
    toggle.setAttribute('aria-label', v ? '展开结果面板' : '收起结果面板')
    toggle.textContent = v ? '▸' : '▾'
    hook('onLayout')
  }
  const say = (t) => { live.textContent = ''; live.textContent = t }
  const total = () => hits.length

  function setStatus() {
    status.textContent = hits.length ? `已收集 ${shown.size}/${total()}` : ''
  }

  function item(hit) {
    const inG = hasNode(hit.path)
    const col = colorOf(hit.kind)
    const btn = h('button', { type: 'button', class: 'sp-card' + (inG ? '' : ' sp-off'), title: inG ? '飞到该节点并打开详情' : '该卡不在当前图中（可能被过滤或超出节点上限）：点击将以它为中心展开', on: { click: () => onFocus(hit.path, inG) } }, [
      h('span', { class: 'sp-rank', css: { background: col } }, String(hit.rank)),
      h('span', { class: 'sp-card-main' }, [
        h('span', { class: 'sp-card-title' }, hit.title || hit.path),
        h('span', { class: 'sp-card-snip' }, plain(hit.snippet, 90) || '（无摘要）'),
        h('span', { class: 'sp-card-meta' }, `${kindLabel(hit.kind)} · 相关度 ${hit.score}${inG ? '' : ' · 不在当前图中'}`),
      ]),
    ])
    return h('li', { class: 'sp-item' }, btn)
  }

  function addCard(hit, { fly = false } = {}) {
    if (shown.has(hit.path)) return
    shown.add(hit.path)
    const li = item(hit)
    list.append(li)
    setStatus()
    if (!fly || spider.reduced || typeof li.animate !== 'function') return
    // 飞入：先在节点处放大“展示一下”，再飞到收集篮里它的落点
    const from = nodeScreen(hit.path)
    const hr = host.getBoundingClientRect()
    const lr = li.getBoundingClientRect()
    if (!from || !lr.width) return
    li.style.setProperty('visibility', 'hidden')
    const col = colorOf(hit.kind)
    const el = h('div', { class: 'sp-fly', css: { width: FLY_W + 'px', left: lr.left - hr.left + 'px', top: lr.top - hr.top + 'px', 'border-color': col } }, [
      h('span', { class: 'sp-rank', css: { background: col } }, String(hit.rank)),
      h('span', { class: 'sp-card-main' }, [h('span', { class: 'sp-card-title' }, plain(hit.title, 40)), h('span', { class: 'sp-card-snip' }, plain(hit.snippet, 70))]),
    ])
    host.append(el)
    const cx = lr.left - hr.left + FLY_W / 2; const cy = lr.top - hr.top + (lr.height || 56) / 2
    const dx = from.x - cx; const dy = from.y - cy
    const sx = (lr.width || FLY_W) / FLY_W
    const anim = el.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(.2) rotate(-8deg)`, opacity: 0, offset: 0 },
      { transform: `translate(${dx}px, ${dy - 96}px) scale(1.08) rotate(0deg)`, opacity: 1, offset: 0.2 },
      { transform: `translate(${dx}px, ${dy - 96}px) scale(1) rotate(0deg)`, opacity: 1, offset: 0.36 },
      { transform: `translate(${dx * 0.35}px, ${dy * 0.2 - 40}px) scale(.8) rotate(5deg)`, opacity: 1, offset: 0.7 },
      { transform: `translate(0px, 0px) scale(${sx}) rotate(0deg)`, opacity: 1, offset: 1 },
    ], { duration: FLY_MS, easing: 'cubic-bezier(.3,.7,.25,1)', fill: 'forwards' })
    const fl = { el, anim }
    flies.add(fl)
    const done = () => { flies.delete(fl); el.remove(); li.style.removeProperty('visibility'); li.classList.add('sp-in') }
    anim.onfinish = done
    anim.oncancel = done
  }

  function showLoading(text) { sum.textContent = ''; sum.append(h('p', { class: 'sp-wait sub' }, [h('span', { class: 'sp-dots', 'aria-hidden': 'true' }), text])) }
  function showSummary(out) {
    sum.textContent = ''
    if (!out.ok) {
      const msg = String(out.e?.message || '服务暂时不可用').replace(/^AI 汇总[^：]*：/, '').replace(/（搜索与命中展示不受影响）/, '')
      sum.append(h('div', { class: 'sp-sum-err' }, [h('strong', null, 'AI 汇总不可用'), h('p', { class: 'sub' }, `${msg}。蜘蛛搜索与命中卡片不受影响，可直接点击下方卡片。`)]))
      say('AI 汇总不可用，命中卡片仍可使用')
      return
    }
    const r = out.r
    const byPath = new Map(hits.map((x) => [x.path, x]))
    const chips = (refs) => refs.map((p) => byPath.get(p)).filter(Boolean).map((x) => h('button', { type: 'button', class: 'sp-ref', title: x.title, 'aria-label': `引用第 ${x.rank} 张卡：${x.title}`, on: { click: () => onFocus(x.path, hasNode(x.path)) } }, `[${x.rank}]`))
    sum.append(...[
      h('h4', { class: 'sp-sum-title' }, '搜索结果总结'),
      r.summary ? h('p', { class: 'sp-sum-text' }, r.summary) : null,
      r.points?.length ? h('ul', { class: 'sp-points' }, r.points.map((pt) => h('li', null, [h('span', null, pt.text), ' ', ...chips(pt.refs || [])]))) : null,
      r.truncated ? h('p', { class: 'sub sp-note' }, '部分卡片较长，汇总只读取了开头部分。') : null,
    ].filter(Boolean))
    say(`AI 汇总完成：${r.points?.length || 0} 条要点`)
  }

  /** 立刻清掉所有飞行卡片（取消动画 → oncancel 会还原面板里那张卡的可见性）；再兜底移除残留节点。 */
  function clearFly() {
    for (const fl of [...flies]) { try { fl.anim.cancel() } catch { /* 忽略 */ } fl.el.remove() }
    flies.clear()
    for (const el of host.querySelectorAll?.('.sp-fly') || []) el.remove()
  }

  function clear() {
    token++
    currentFinish = null
    skipBtn.setAttribute('hidden', '')
    spider.on = {}
    spider.clearResults()
    clearFly()
    hits = []; shown.clear()
    list.textContent = ''; sum.textContent = ''; status.textContent = ''
    panel.setAttribute('hidden', '')
    hook('onClear')
    onChange()
  }

  /** 把剩余命中卡一次性放进面板（蜘蛛被关闭 / 减少动画偏好 / 巡游未能开始）。 */
  function flushAll() {
    for (const x of hits) addCard(x)
    spider.collectNow(hits.filter((x) => hasNode(x.path)).map((x) => ({ id: x.path, rank: x.rank, title: x.title })))
  }

  async function run(qRaw) {
    const q = String(qRaw ?? '').trim()
    if (!q) return false
    const my = ++token
    spider.on = {}
    spider.clearResults(); clearFly()
    hits = []; shown.clear(); list.textContent = ''
    panel.removeAttribute('hidden'); setCollapsed(false); hook('onLayout')
    status.textContent = '蜘蛛出动中…'
    showLoading('蜘蛛正在图谱里搜索…')
    onChange()
    let res
    try { res = await post('graph/search', { q }) } catch (e) {
      if (my !== token) return false
      status.textContent = ''
      sum.textContent = ''
      sum.append(h('div', { class: 'sp-sum-err' }, [h('strong', null, e.status === 429 ? '搜索太频繁' : '搜索失败'), h('p', { class: 'sub' }, e.message || '请稍后重试')]))
      say(e.status === 429 ? '搜索太频繁，请稍后再试' : '搜索失败')
      spider.think(1200)
      return false
    }
    if (my !== token) return false
    hits = res.hits || []
    if (!hits.length) {
      status.textContent = '无命中'
      sum.textContent = ''
      sum.append(h('p', { class: 'sub' }, '没有找到相关卡片。换个关键词，或用更短的词试试。'))
      say('没有找到相关卡片')
      spider.think(1400)
      return true
    }
    setStatus()
    say(`找到 ${hits.length} 张相关卡片`)
    showLoading('蜘蛛正在收集卡片，随后会汇总…')
    // AI 汇总与巡游并行：请求立刻发出，巡游结束时若已返回就直接展示
    const sumP = post('graph/summarize', { q, paths: hits.map((x) => x.path) }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }))
    const inGraph = hits.filter((x) => hasNode(x.path))
    const finish = async () => {
      if (my !== token) return
      showLoading('蜘蛛正在阅读并总结…')
      const out = await sumP
      if (my !== token) return
      showSummary(out)
      skipBtn.setAttribute('hidden', '')
      spider.release()
    }
    currentFinish = finish
    const byPath = new Map(hits.map((x) => [x.path, x]))
    const animated = spider.enabled && !spider.reduced && inGraph.length > 0
    hook('onTourStart', inGraph.map((x) => x.path), animated)
    if (animated) {
      spider.on = {
        throw: ({ id }) => { if (my === token && byPath.has(id)) addCard(byPath.get(id), { fly: true }) },
        done: () => { if (my === token) hook('onTourEnd'); if (my === token) setTimeout(() => { for (const x of hits) if (!hasNode(x.path)) addCard(x); finish() }, FLY_MS * 0.5) }, // 让最后一张卡飞完再收尾；不在图里的卡最后列入
      }
      if (spider.startTour(inGraph.map((x) => ({ id: x.path, rank: x.rank, title: x.title })))) { skipBtn.removeAttribute('hidden'); return true }
      spider.on = {}
      hook('onTourStart', inGraph.map((x) => x.path), false)
    }
    flushAll()
    await finish()
    return true
  }

  const api = {
    panel, run, clear,
    get active() { return !panel.hasAttribute('hidden') },
    /** 蜘蛛开关被关掉时调用：把没播完的巡游收尾。 */
    interrupt: () => { if (hits.length && shown.size < hits.length) { spider.on = {}; spider.clearResults(); clearFly(); flushAll(); hook('onTourEnd'); currentFinish?.() } },
    state: () => ({ hits: hits.length, shown: shown.size, active: !panel.hasAttribute('hidden') }),
  }
  return api
}

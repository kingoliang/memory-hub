// 管理界面入口：会话检测 → 登录页 / 外壳 + 哈希路由。原生 ES modules，无构建、无第三方依赖。

import { h, mount, clear } from './js/dom.js'
import * as api from './js/api.js'
import { renderLogin } from './js/views/login.js'
import { icon, loading, errorBlock } from './js/ui.js'
import { fmtNum } from './js/format.js'

const NAV = [
  { group: '概览', items: [['overview', '总览', 'overview']] },
  { group: '记忆', items: [['cards', '卡片', 'cards'], ['queue', '待审队列', 'queue'], ['recycle', '回收站', 'trash'], ['tags', '标签', 'tag']] },
  { group: '维护', items: [['tidy', '整理预览', 'broom'], ['lint', '健康报告', 'heart']] },
  { group: '观测', items: [['activity', '沉淀活跃度', 'pulse'], ['tokens', '令牌', 'key'], ['audit', '审计日志', 'log']] },
]
const VIEWS = {
  overview: () => import('./js/views/overview.js'), cards: () => import('./js/views/cards.js'), card: () => import('./js/views/card.js'),
  queue: () => import('./js/views/queue.js'), recycle: () => import('./js/views/recycle.js'), tags: () => import('./js/views/tags.js'),
  tidy: () => import('./js/views/tidy.js'), lint: () => import('./js/views/lint.js'), activity: () => import('./js/views/activity.js'),
  tokens: () => import('./js/views/tokens.js'), audit: () => import('./js/views/audit.js'),
}

const root = document.getElementById('app')
let shell = null
let navBadges = {}
let renderToken = 0

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '')
  const [name, query = ''] = raw.split('?')
  return { name: name || 'overview', params: new URLSearchParams(query) }
}

function go(hash) {
  if (location.hash === hash) renderRoute()
  else location.hash = hash
}

async function refreshBadges() {
  try {
    const f = await api.get('facets')
    const m = Object.fromEntries(f.statuses.map((s) => [s.status, s.count]))
    navBadges = { queue: m.pending || 0, recycle: m.deleted || 0 }
    for (const [k, el] of Object.entries(shell?.badges || {})) {
      const n = navBadges[k]
      el.textContent = n ? fmtNum(n) : ''
      if (n) el.removeAttribute('hidden'); else el.setAttribute('hidden', '')
    }
  } catch { /* 徽标失败不影响页面 */ }
}

function buildShell() {
  const badges = {}
  const links = {}
  const nav = h('nav', { class: 'nav', 'aria-label': '主导航' }, NAV.map((g) => h('div', { class: 'nav-group' }, [
    h('div', { class: 'nav-title' }, g.group),
    ...g.items.map(([key, label, ic]) => {
      const b = h('span', { class: 'nav-badge', hidden: true })
      badges[key] = b
      const a = h('a', { class: 'nav-link', href: `#/${key}`, 'data-key': key, on: { click: () => root.classList.remove('nav-open') } }, [icon(ic), h('span', null, label), b])
      links[key] = a
      return a
    }),
  ])))
  const view = h('main', { class: 'view', id: 'view', tabindex: '-1' })
  const title = h('div', { class: 'topbar-title' }, '总览')
  const logout = h('button', { class: 'btn btn-ghost', type: 'button', on: { click: async () => {
    try { await api.post('logout') } catch { /* 已过期也无妨 */ }
    api.setCsrf(null)
    showLogin()
  } } }, [icon('logout', 'icon-sm'), '退出'])
  const menu = h('button', { class: 'btn btn-ghost menu-btn', type: 'button', 'aria-label': '菜单', on: { click: () => root.classList.toggle('nav-open') } }, icon('menu'))
  const el = h('div', { class: 'shell' }, [
    h('aside', { class: 'sidebar' }, [
      h('a', { class: 'brand', href: '#/overview' }, [h('span', { class: 'brand-mark' }, 'M'), h('div', null, [h('strong', null, '记忆中枢'), h('span', null, 'Memory Hub')])]),
      nav,
      h('div', { class: 'sidebar-foot' }, [h('span', { class: 'chip-ro' }, '只读模式 · M2')]),
    ]),
    h('div', { class: 'scrim', on: { click: () => root.classList.remove('nav-open') } }),
    h('div', { class: 'main' }, [h('header', { class: 'topbar' }, [menu, title, logout]), view]),
  ])
  return { el, view, title, links, badges }
}

async function renderRoute() {
  if (!shell) return
  const { name, params } = parseHash()
  const key = VIEWS[name] ? name : 'overview'
  const my = ++renderToken
  for (const [k, a] of Object.entries(shell.links)) {
    const active = k === key || (key === 'card' && k === 'cards')
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current')
  }
  mount(shell.view, loading())
  try {
    const mod = await VIEWS[key]()
    const ctx = { params, go, setTitle: (t) => { shell.title.textContent = t; document.title = `${t} · 记忆中枢` } }
    const node = await mod.default(ctx)
    if (my !== renderToken) return
    mount(shell.view, node)
    shell.view.scrollTop = 0
    window.scrollTo(0, 0)
  } catch (e) {
    if (my !== renderToken) return
    if (e?.status === 401) return // onUnauthorized 已切到登录页
    mount(shell.view, errorBlock(e))
  }
  refreshBadges()
}

function showLogin(opts = {}) {
  shell = null
  renderToken++
  document.title = '登录 · 记忆中枢'
  mount(root, renderLogin({ passwordSet: opts.passwordSet !== false, message: opts.message, onSuccess: () => start() }))
  root.className = 'login-root'
}

async function start() {
  try {
    const s = await api.get('session')
    api.setCsrf(s.csrfToken)
  } catch (e) {
    if (e.status === 401) return showLogin({ passwordSet: e.extra?.passwordSet !== false })
    root.className = ''
    return mount(root, h('div', { class: 'page' }, errorBlock(e)))
  }
  root.className = 'app-root'
  shell = buildShell()
  mount(root, shell.el)
  renderRoute()
}

api.setOnUnauthorized((e) => showLogin({ passwordSet: e.extra?.passwordSet !== false, message: '会话已过期，请重新登录' }))
window.addEventListener('hashchange', renderRoute)
start()

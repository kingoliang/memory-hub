// 管理界面入口：会话检测 → 登录页 / 外壳 + 哈希路由。原生 ES modules，无构建、无第三方依赖。

import { h, mount, clear } from './js/dom.js'
import * as api from './js/api.js'
import { renderLogin } from './js/views/login.js'
import { icon, loading, errorBlock } from './js/ui.js'
import { fmtNum } from './js/format.js'
import { getTheme, setTheme, nextTheme, THEME_LABEL, THEME_ICON } from './js/theme.js'

// [路由键, 文字, 图标]。待审 / 回收站的数量徽标由 refreshBadges() 按路由键填充。
const NAV = [
  { group: '概览', items: [['overview', '总览', 'overview']] },
  { group: '记忆', items: [['cards', '卡片', 'cards'], ['queue', '待审队列', 'queue'], ['recycle', '回收站', 'trash'], ['tags', '标签', 'tag'], ['graph', '图谱', 'graph']] },
  { group: '维护', items: [['tidy', '整理中心', 'broom'], ['lint', '健康报告', 'heart'], ['account', '账户', 'lock']] },
  { group: '观测', items: [['activity', '沉淀活跃度', 'pulse'], ['tokens', '令牌', 'key'], ['audit', '审计日志', 'log']] },
]
const GROUP_OF = Object.fromEntries(NAV.flatMap((g) => g.items.map(([k]) => [k, g.group])))
GROUP_OF.card = '记忆'
const LABEL_OF = Object.fromEntries(NAV.flatMap((g) => g.items.map(([k, l]) => [k, l])))
LABEL_OF.card = '卡片详情'
const VIEWS = {
  overview: () => import('./js/views/overview.js'), cards: () => import('./js/views/cards.js'), card: () => import('./js/views/card.js'),
  queue: () => import('./js/views/queue.js'), recycle: () => import('./js/views/recycle.js'), tags: () => import('./js/views/tags.js'), graph: () => import('./js/views/graph.js'),
  tidy: () => import('./js/views/tidy.js'), lint: () => import('./js/views/lint.js'), activity: () => import('./js/views/activity.js'),
  tokens: () => import('./js/views/tokens.js'), audit: () => import('./js/views/audit.js'), account: () => import('./js/views/account.js'),
}

const root = document.getElementById('app')
let shell = null
let readOnly = false
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
      el.setAttribute('aria-label', n ? `${fmtNum(n)} 项${k === 'queue' ? '待处理' : ''}` : '')
      if (n) el.removeAttribute('hidden'); else el.setAttribute('hidden', '')
    }
  } catch { /* 徽标失败不影响页面 */ }
}

function buildShell() {
  const badges = {}
  const links = {}
  const setNav = (open) => {
    root.classList.toggle('nav-open', open)
    menu.setAttribute('aria-expanded', String(open))
    if (open) nav.querySelector('a')?.focus()
    else if (sidebar.contains(document.activeElement)) menu.focus()
  }
  const nav = h('nav', { class: 'nav', 'aria-label': '主导航' }, NAV.map((g) => h('div', { class: 'nav-group' }, [
    h('div', { class: 'nav-title' }, g.group),
    ...g.items.map(([key, label, ic]) => {
      const b = h('span', { class: 'nav-badge', hidden: true })
      badges[key] = b
      const a = h('a', { class: 'nav-link', href: `#/${key}`, 'data-key': key, on: { click: () => setNav(false) } }, [icon(ic), h('span', { class: 'nav-text' }, label), b])
      links[key] = a
      return a
    }),
  ])))
  const view = h('main', { class: 'view', id: 'view', tabindex: '-1' })
  // 面包屑：分组 / 页面（与页内 h1 重复，故对读屏隐藏）；卡片详情页的页面名是卡片标题，过长时省略
  const crumbGroup = h('span', { class: 'crumb-group' })
  const crumbTitle = h('span', { class: 'crumb-title' }, '总览')
  const title = h('div', { class: 'topbar-title', 'aria-hidden': 'true' }, [crumbGroup, h('span', { class: 'crumb-sep' }, '/'), crumbTitle])
  const logout = h('button', { class: 'btn btn-ghost', type: 'button', 'aria-label': '退出登录', on: { click: async () => {
    try { await api.post('logout') } catch { /* 已过期也无妨 */ }
    api.setCsrf(null)
    showLogin()
  } } }, [icon('logout', 'icon-sm'), h('span', { class: 'btn-text' }, '退出')])
  const menu = h('button', { class: 'btn btn-ghost btn-icon menu-btn', type: 'button', 'aria-label': '打开菜单', 'aria-expanded': 'false', on: { click: () => setNav(!root.classList.contains('nav-open')) } }, icon('menu'))
  // 主题：跟随系统 → 浅色 → 深色 循环；按钮名称同时说明"当前"与"点击后"
  let theme = getTheme()
  const themeBtn = h('button', { class: 'btn btn-ghost btn-icon theme-btn', type: 'button' })
  const paintTheme = () => {
    while (themeBtn.firstChild) themeBtn.removeChild(themeBtn.firstChild)
    themeBtn.appendChild(icon(THEME_ICON[theme]))
    themeBtn.setAttribute('aria-label', `主题：${THEME_LABEL[theme]}（点击切换为${THEME_LABEL[nextTheme(theme)]}）`)
    themeBtn.setAttribute('title', `主题：${THEME_LABEL[theme]}`)
  }
  themeBtn.addEventListener('click', () => { theme = nextTheme(theme); setTheme(theme); paintTheme() })
  paintTheme()
  const skip = h('button', { class: 'skip-link', type: 'button', on: { click: () => view.focus() } }, '跳到主要内容')
  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar' }, [
    h('a', { class: 'brand', href: '#/overview', on: { click: () => setNav(false) } }, [h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'M'), h('div', null, [h('strong', null, '记忆中枢'), h('span', null, 'Memory Hub')])]),
    nav,
    h('div', { class: 'sidebar-foot' }, [h('span', { class: readOnly ? 'chip-ro' : 'chip-rw', title: readOnly ? '服务端已禁用所有写操作（MEMORY_HUB_ADMIN_READONLY=1）' : '' }, readOnly ? '只读模式' : '管理模式')]),
  ])
  const el = h('div', { class: 'shell' }, [
    skip,
    sidebar,
    h('div', { class: 'scrim', on: { click: () => setNav(false) } }),
    h('div', { class: 'main' }, [h('header', { class: 'topbar' }, [menu, title, themeBtn, logout]), view]),
  ])
  return { el, view, crumbGroup, crumbTitle, links, badges, closeNav: () => setNav(false) }
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
  shell.view.setAttribute('data-route', key)
  shell.crumbGroup.textContent = key === 'overview' ? '' : GROUP_OF[key] || ''
  mount(shell.view, loading())
  try {
    const mod = await VIEWS[key]()
    const ctx = { params, go, reload: () => renderRoute(), setTitle: (t) => { shell.crumbTitle.textContent = t; document.title = `${t} · 记忆中枢` } }
    const node = await mod.default(ctx)
    if (my !== renderToken) return
    mount(shell.view, node)
    shell.view.scrollTop = 0
    window.scrollTo(0, 0)
    shell.view.focus({ preventScroll: true }) // 路由切换后把焦点交给主内容区（读屏 / 键盘用户）
  } catch (e) {
    if (my !== renderToken) return
    if (e?.status === 401) return // onUnauthorized 已切到登录页
    console.error('页面渲染失败', name, e?.stack || e)
    shell.crumbTitle.textContent = LABEL_OF[key] || ''
    mount(shell.view, h('div', { class: 'page' }, errorBlock(e, () => renderRoute())))
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
    readOnly = !!s.readOnly
  } catch (e) {
    if (e.status === 401) return showLogin({ passwordSet: e.extra?.passwordSet !== false })
    root.className = ''
    return mount(root, h('div', { class: 'page boot-error' }, errorBlock(e, () => start())))
  }
  root.className = 'app-root'
  shell = buildShell()
  mount(root, shell.el)
  renderRoute()
}

api.setOnUnauthorized((e) => showLogin({ passwordSet: e.extra?.passwordSet !== false, message: '会话已过期，请重新登录' }))
window.addEventListener('hashchange', renderRoute)
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && root.classList.contains('nav-open')) shell?.closeNav() })
start()

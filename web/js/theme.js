// 主题切换：跟随系统（默认） / 浅色 / 深色。选择只存在本浏览器的 localStorage，不涉及服务端。
// index.html 里的 theme-init.js 会在首帧前读取同一个键，避免刷新时闪一下错误的主题。
// 存储不可用（隐私模式、被禁用）时静默退化为"跟随系统"。

const KEY = 'mh-theme'
export const THEMES = ['auto', 'light', 'dark']
export const THEME_LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' }
export const THEME_ICON = { auto: 'monitor', light: 'sun', dark: 'moon' }

export function getTheme() {
  try {
    const v = globalThis.localStorage?.getItem(KEY)
    return THEMES.includes(v) ? v : 'auto'
  } catch { return 'auto' }
}

export function applyTheme(mode) {
  const el = globalThis.document?.documentElement
  if (!el) return
  if (mode === 'light' || mode === 'dark') el.setAttribute('data-theme', mode)
  else el.removeAttribute('data-theme')
  globalThis.dispatchEvent?.(new Event('mh-theme')) // 图谱画布读取 CSS 变量绘制，需要主动重绘
}

export function setTheme(mode) {
  try {
    if (mode === 'light' || mode === 'dark') globalThis.localStorage?.setItem(KEY, mode)
    else globalThis.localStorage?.removeItem(KEY)
  } catch { /* 存储不可用：本次会话仍生效 */ }
  applyTheme(mode)
}

// 强调色：红（默认）/ 蓝 / 绿。同样只存 localStorage；通过 html[data-accent] 覆盖 --accent 系令牌（见 styles.css 末尾）。
const ACCENT_KEY = 'mh-accent'
export const ACCENTS = ['red', 'blue', 'green']
export const ACCENT_LABEL = { red: '朱红', blue: '钴蓝', green: '森绿' }

export function getAccent() {
  try {
    const v = globalThis.localStorage?.getItem(ACCENT_KEY)
    return ACCENTS.includes(v) ? v : 'red'
  } catch { return 'red' }
}

export function applyAccent(name) {
  const el = globalThis.document?.documentElement
  if (!el) return
  if (name === 'blue' || name === 'green') el.setAttribute('data-accent', name)
  else el.removeAttribute('data-accent')
  globalThis.dispatchEvent?.(new Event('mh-theme')) // 图谱画布需要重读 CSS 变量
}

export function setAccent(name) {
  try {
    if (name === 'blue' || name === 'green') globalThis.localStorage?.setItem(ACCENT_KEY, name)
    else globalThis.localStorage?.removeItem(ACCENT_KEY)
  } catch { /* 存储不可用：本次会话仍生效 */ }
  applyAccent(name)
}

export const nextTheme = (mode) => THEMES[(THEMES.indexOf(mode) + 1) % THEMES.length]

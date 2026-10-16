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

export const nextTheme = (mode) => THEMES[(THEMES.indexOf(mode) + 1) % THEMES.length]

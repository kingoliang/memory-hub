/* 首帧前应用已保存的主题（经典脚本，无依赖；CSP 只允许同源脚本，所以不能内联）。逻辑与 js/theme.js 保持一致。 */
try {
  var t = localStorage.getItem('mh-theme')
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t)
} catch (e) { /* 存储不可用：跟随系统 */ }

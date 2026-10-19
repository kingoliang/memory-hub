// 接入说明：创建令牌后在同一个弹窗里给出各客户端的配置命令（MCP 地址与令牌已填好，复制即用）。
// 地址由管理界面自身的 URL 推出：管理界面挂在 <前缀>/admin/，MCP 端点就是 <前缀>/mcp（反代前缀也成立）。

import { h } from '../dom.js'
import { icon } from '../ui.js'

/** 由管理界面地址推出 MCP 端点。loc 形如 window.location（取 origin + pathname）。 */
export function mcpEndpoint(loc) {
  const prefix = String(loc.pathname || '/').replace(/\/admin\/?.*$/, '')
  return `${loc.origin}${prefix}/mcp`
}

const PLACEHOLDER = '<你的令牌>'

/** 各客户端的接入命令。token 缺省时用占位符（给「怎么接入」常驻说明用，不含任何真实令牌）。 */
export function howtoSnippets({ url, token, name = 'memory-hub' }) {
  const tok = token || PLACEHOLDER
  void name
  return [
    {
      id: 'claude', title: 'Claude Code',
      code: `claude mcp add --transport http -s user memory-hub \\\n  ${url} \\\n  --header "Authorization: Bearer ${tok}"`,
    },
    {
      id: 'codex', title: 'Codex（~/.codex/config.toml）',
      code: `# 1) 写进 shell 配置（~/.zshrc 等），不要把令牌写进 toml\nexport MEMORY_HUB_TOKEN=${tok}\n\n# 2) ~/.codex/config.toml\n[mcp_servers.memory-hub]\nurl = "${url}"\nbearer_token_env_var = "MEMORY_HUB_TOKEN"`,
    },
    {
      id: 'pi', title: 'pi',
      code: `export MEMORY_HUB_TOKEN=${tok}\npi mcp add memory-hub --url ${url} --bearer-token-env-var MEMORY_HUB_TOKEN`,
    },
    {
      id: 'verify', title: '验证',
      code: '在 Agent 里说：「调用 memory_whoami」\n返回的 owner 应与你登录管理界面的用户名完全一致。',
    },
  ]
}

/** 渲染一段可复制的代码块。 */
function snippetBlock(s) {
  const pre = h('pre', { class: 'howto-code mono' }, s.code)
  const msg = h('span', { class: 'sub', role: 'status' }, '')
  const btn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, [icon('check', 'icon-sm'), '复制'])
  btn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(s.code); msg.textContent = '已复制' } catch { msg.textContent = '浏览器不允许自动复制，请手动选中复制' }
  })
  return h('div', { class: 'howto-item' }, [h('div', { class: 'howto-head' }, [h('strong', null, s.title), h('span', { class: 'inline' }, [msg, btn])]), pre])
}

/** 接入说明面板：made = 刚创建的令牌（带明文）；不传则用占位符。 */
export function howtoPanel({ token, name, loc = globalThis.location } = {}) {
  const url = mcpEndpoint(loc)
  return h('div', { class: 'howto' }, [
    h('p', { class: 'sub' }, ['MCP 地址：', h('code', null, url), '。选你用的客户端，复制下面的命令执行：']),
    ...howtoSnippets({ url, token, name }).map(snippetBlock),
  ])
}

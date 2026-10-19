// 极简假 DOM（仅供测试前端渲染的转义行为）：不解析 HTML，任何字符串只能成为文本节点或属性值。
export class FakeNode {
  constructor(type) { this.nodeType = type; this.children = []; this.parent = null }
  appendChild(c) { c.parent = this; this.children.push(c); return c }
  append(...cs) { for (const c of cs) this.appendChild(typeof c === 'string' ? new FakeText(c) : c) }
  replaceChildren(...cs) { this.children = []; this.append(...cs) }
  get firstChild() { return this.children[0] || null }
  removeChild(c) { this.children = this.children.filter((x) => x !== c) }
}
export class FakeText extends FakeNode {
  constructor(t) { super(3); this.text = String(t) }
  get textContent() { return this.text }
}
export class FakeElement extends FakeNode {
  constructor(tag) {
    super(1); this.tagName = tag.toUpperCase(); this.attributes = {}; this.listeners = {}
    this.classList = { add: (...c) => { this.attributes.class = [this.attributes.class, ...c].filter(Boolean).join(' ') }, remove() {}, toggle() {}, contains: () => false }
    this.style = { setProperty: (k, v) => { (this._style ||= {})[k] = v }, set width(v) { (this._style ||= {}).width = v } }
    this.dataset = {}
  }
  setAttribute(k, v) { this.attributes[k] = String(v) }
  getAttribute(k) { return this.attributes[k] ?? null }
  removeAttribute(k) { delete this.attributes[k] }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f) }
  set className(v) { this.attributes.class = String(v) }
  get className() { return this.attributes.class || '' }
  set textContent(v) { this.children = []; if (v !== '' && v != null) this.appendChild(new FakeText(v)) }
  get textContent() { return this.children.map((c) => c.textContent).join('') }
  set value(v) { this._value = v }
  // 与浏览器一致：没被脚本赋值前，value 取 value 属性（默认值）
  get value() { return this._value ?? this.attributes.value ?? '' }
  get disabled() { return 'disabled' in this.attributes }
  set disabled(v) { if (v) this.attributes.disabled = ''; else delete this.attributes.disabled }
  set href(v) { this.attributes.href = String(v) }
  get href() { return this.attributes.href }
  set title(v) { this.attributes.title = String(v) }
  set hidden(v) { this.attributes.hidden = v }
}
export class FakeDocument {
  createElement(tag) { return new FakeElement(tag) }
  createElementNS(_ns, tag) { return new FakeElement(tag) }
  createTextNode(t) { return new FakeText(t) }
  createDocumentFragment() { return new FakeElement('#fragment') }
  get body() { return (this._body ||= new FakeElement('body')) }
}
export function* walkNodes(n) {
  yield n
  for (const c of n.children || []) yield* walkNodes(c)
}
export const textOf = (n) => n.textContent

// 图谱相机（纯函数，无 DOM）：可见舞台区域、蜘蛛跟随的目标视野规划、临界阻尼平滑。
// 相机状态 cam = { cx, cy, lz, vx, vy, vlz }：cx/cy = “可见区中心”对应的世界坐标，lz = ln(zoom)，v* = 对应速度。
// view（graph.js 里的 {zoom, panX, panY}）由 camToView(cam, box) 得到；box 是舞台里“没被结果面板盖住”的矩形（舞台坐标）。

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

/**
 * 可见舞台区：舞台 (0,0,w,h) 扣掉结果面板矩形 panel（舞台坐标 {x,y,w,h}，没有面板传 null）后，
 * 在“面板左侧 / 上方 / 下方”三块里取面积最大的一块（桌面端面板在右 → 取左侧；窄屏面板在底 → 取上方；面板收起成顶部小条 → 取下方）。
 */
export function visibleBox(w, h, panel, gap = 12) {
  const full = { x: 0, y: 0, w, h }
  if (!panel || panel.w <= 0 || panel.h <= 0) return full
  const px0 = clamp(panel.x, 0, w); const px1 = clamp(panel.x + panel.w, 0, w)
  const py0 = clamp(panel.y, 0, h); const py1 = clamp(panel.y + panel.h, 0, h)
  const cands = [
    { x: 0, y: 0, w: px0 - gap, h },
    { x: 0, y: 0, w, h: py0 - gap },
    { x: 0, y: py1 + gap, w, h: h - py1 - gap },
    { x: px1 + gap, y: 0, w: w - px1 - gap, h },
  ].filter((b) => b.w > 80 && b.h > 80)
  if (!cands.length) return full
  return cands.sort((a, b) => b.w * b.h - a.w * a.h)[0]
}

export const boxCenter = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
export const camToView = (cam, box) => { const z = Math.exp(cam.lz); const c = boxCenter(box); return { zoom: z, panX: c.x - cam.cx * z, panY: c.y - cam.cy * z } }
export const viewToCam = (view, box) => { const c = boxCenter(box); return { cx: (c.x - view.panX) / view.zoom, cy: (c.y - view.panY) / view.zoom, lz: Math.log(view.zoom), vx: 0, vy: 0, vlz: 0 } }
/** 世界点在该相机下的屏幕（舞台）坐标。 */
export function camProject(cam, box, p) { const v = camToView(cam, box); return { x: p.x * v.zoom + v.panX, y: p.y * v.zoom + v.panY } }
export const inBox = (pt, box, pad = 0) => pt.x >= box.x + pad && pt.x <= box.x + box.w - pad && pt.y >= box.y + pad && pt.y <= box.y + box.h - pad

/** 把一组世界点装进可见区（四周留 marginPx 屏幕像素）：返回 { zoom, cx, cy }；zoom 夹在 [zMin, zMax]。 */
export function fitPoints(points, box, { marginPx = 80, zMin = 0.05, zMax = 3 } = {}) {
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity
  for (const p of points) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y) }
  if (!Number.isFinite(x0)) return null
  const bw = Math.max(1, x1 - x0); const bh = Math.max(1, y1 - y0)
  const zFit = Math.min((box.w - 2 * marginPx) / bw, (box.h - 2 * marginPx) / bh)
  return { zoom: clamp(zFit, zMin, zMax), cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 }
}

/**
 * 巡游跟随的目标视野：蜘蛛身体 + 当前目标节点 + 即将到达的 1–2 个目标点（look-ahead）的包围范围。
 * 簇间长跳时这些点跨度大 → 自然拉远（同时看到起点与终点）；簇内小步时跨度小 → 被 zClose 限住，保持较近景别；整体 zoom ∈ [zMin, zMax]。
 */
export function tourTarget({ body, cur, ahead = [], box, marginPx = 90, zMin, zMax, zClose }) {
  const pts = [body]
  if (cur) pts.push(cur)
  for (const a of ahead.slice(0, 2)) pts.push(a)
  const f = fitPoints(pts, box, { marginPx, zMin, zMax: Math.min(zMax, zClose) })
  return f
}

/** 装饰游走的轻微跟随（仅平移）：蜘蛛在可见区中央 60% 内不动；出界后只朝蜘蛛靠近一部分。返回目标中心或 null。 */
export function wanderTarget({ body, cam, box, soft = 0.45 }) {
  const p = camProject(cam, box, body)
  const c = boxCenter(box)
  const inner = { x: c.x - box.w * 0.3, y: c.y - box.h * 0.3, w: box.w * 0.6, h: box.h * 0.6 }
  if (inBox(p, inner)) return null
  return { cx: cam.cx + (body.x - cam.cx) * soft, cy: cam.cy + (body.y - cam.cy) * soft }
}

/** 临界阻尼（精确解）：x → target，ω 越大越快（时间常数 ≈ 1/ω）。返回 [x', v']。 */
function damp(x, v, target, omega, dt) {
  const d0 = x - target
  const e = Math.exp(-omega * dt)
  const tmp = (v + omega * d0) * dt
  return [target + (d0 + tmp) * e, (v - omega * tmp) * e]
}

/**
 * 相机平滑一步：位置 / 对数缩放都用临界阻尼（无超调、速度连续），再叠加速度上限（屏幕平移 ≤ maxPan px/s，缩放 ≤ maxZoom ln/s）。
 * target = { cx?, cy?, zoom? }（缺的维度保持不动）。
 */
export function stepCamera(cam, target, dt, { omega = 7, maxPan = 2800, maxZoom = 1.8 } = {}) {
  dt = clamp(dt, 0, 0.05)
  if (dt === 0) return cam
  const z = Math.exp(cam.lz)
  const out = { ...cam }
  const lim = (cur, next, vmax) => { const d = clamp(next - cur, -vmax * dt, vmax * dt); return [cur + d, d / dt] }
  if (target.cx !== undefined && target.cy !== undefined) {
    const [nx, vx] = damp(cam.cx, cam.vx, target.cx, omega, dt)
    const [ny, vy] = damp(cam.cy, cam.vy, target.cy, omega, dt)
    // 平移速度上限按屏幕像素算（世界速度 × zoom）
    const wvmax = maxPan / z
    const dx = nx - cam.cx; const dy = ny - cam.cy
    const sp = Math.hypot(dx, dy) / dt
    const k = sp > wvmax ? wvmax / sp : 1
    out.cx = cam.cx + dx * k; out.cy = cam.cy + dy * k; out.vx = vx * k; out.vy = vy * k
  }
  if (target.zoom !== undefined) {
    const [nz, vz] = damp(cam.lz, cam.vlz, Math.log(target.zoom), omega, dt)
    const [lz, v2] = lim(cam.lz, nz, maxZoom)
    out.lz = lz; out.vlz = Math.abs(vz) < Math.abs(v2) ? vz : v2
  }
  return out
}

/**
 * 每帧相机决策（graph.js 调用）。st = { on }（“跟随蜘蛛”开关；用户手动拖拽 / 缩放 / 聚焦后置 false，不会自动恢复）。
 * mode：'tour'（巡游，look-ahead 运镜）| 'hold'（走完后停在“全部命中点装进可见区”的视野）| 'wander'（装饰游走，仅轻微平移）| 'off'。
 * 开关关闭 / reduced-motion / mode 为 off 时原样返回同一个 cam 对象（调用方据此判断没有改动）。
 */
export function followStep(st, cam, { dt, mode, focus, box, limits, hold, reduced = false }) {
  if (!st.on || reduced || mode === 'off') return cam
  if (mode === 'tour' && focus) {
    const t = tourTarget({ body: focus.body, cur: focus.cur, ahead: focus.ahead, box, ...limits })
    return t ? stepCamera(cam, t, dt, { omega: 7 }) : cam
  }
  if (mode === 'hold' && hold) return stepCamera(cam, hold, dt, { omega: 5 })
  if (mode === 'wander' && focus) {
    const t = wanderTarget({ body: focus.body, cam, box })
    return t ? stepCamera(cam, { cx: t.cx, cy: t.cy }, dt, { omega: 1.6, maxPan: 500 }) : stepCamera(cam, { cx: cam.cx, cy: cam.cy }, dt, { omega: 3, maxPan: 500 })
  }
  return cam
}

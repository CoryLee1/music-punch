/**
 * 由 public/gesture-punch.html · gesture-chop.html 抽离：按 phase01∈[0,1) 绘制单帧。
 */
const PUNCH_FILL = 'rgba(238,238,242,0.92)'
const PUNCH_BG = '#0a0a0c'
const CHOP_FILL = 'rgba(238,238,242,0.92)'

function rr(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  r = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
  ctx.fill()
}

function drawFist(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.fillStyle = PUNCH_FILL
  const bodyW = s * 0.58
  const bodyH = s * 0.34
  const kr = s * 0.092
  const spacing = bodyW / 4
  const x0 = -bodyW / 2 + spacing / 2
  const topY = -bodyH / 2
  const botY = bodyH / 2
  rr(ctx, -bodyW / 2, topY + kr * 0.35, bodyW, bodyH, s * 0.04)
  for (let i = 0; i < 4; i++) {
    ctx.beginPath()
    ctx.arc(x0 + i * spacing, topY + kr * 0.15, kr, 0, Math.PI * 2)
    ctx.fill()
  }
  const tipR = s * 0.065
  for (let i = 0; i < 4; i++) {
    ctx.beginPath()
    ctx.arc(x0 + i * spacing, botY + kr * 0.25, tipR, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.save()
  ctx.translate(bodyW / 2 + s * 0.01, s * 0.04)
  ctx.rotate(0.12)
  rr(ctx, 0, -s * 0.1, s * 0.1, s * 0.22, s * 0.045)
  ctx.restore()
  ctx.fillStyle = PUNCH_BG
  const grooveW = s * 0.024
  for (let j = 0; j < 3; j++) {
    const gx = x0 + (j + 0.5) * spacing
    const gy1 = topY - kr * 0.15
    const gy2 = botY + tipR * 0.55
    ctx.beginPath()
    ctx.moveTo(gx - grooveW, gy1)
    ctx.lineTo(gx - grooveW, gy2 - grooveW * 1.2)
    ctx.quadraticCurveTo(
      gx,
      gy2 + grooveW * 0.6,
      gx + grooveW,
      gy2 - grooveW * 1.2,
    )
    ctx.lineTo(gx + grooveW, gy1)
    ctx.closePath()
    ctx.fill()
  }
  ctx.beginPath()
  ctx.ellipse(
    bodyW / 2 + s * 0.005,
    s * 0.04,
    s * 0.014,
    s * 0.09,
    0.12,
    0,
    Math.PI * 2,
  )
  ctx.fill()
}

function eio(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

function eob(t: number): number {
  const c = 2.2
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2)
}

function impact(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  p: number,
  s: number,
): void {
  if (p < 0 || p > 1) return
  const a = 0.5 * (1 - p)
  ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`
  ctx.lineWidth = Math.max(1, s * 0.014)
  ctx.lineCap = 'round'
  const count = 6
  const rInner = s * 0.04 + p * s * 0.08
  const rOuter = rInner + s * 0.06 + p * s * 0.1
  for (let i = 0; i < count; i++) {
    const ang = (Math.PI * 2 * i) / count + p * 0.3
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(ang) * rInner, cy + Math.sin(ang) * rInner)
    ctx.lineTo(cx + Math.cos(ang) * rOuter, cy + Math.sin(ang) * rOuter)
    ctx.stroke()
  }
}

export function drawPunchHintFrame(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  s: number,
  phase01: number,
): void {
  const t = phase01
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, s, s)
  const cx = s * 0.5
  const cy = s * 0.5
  const scMin = 0.35
  const scMax = 1.1
  let sc: number
  let ga: number
  let ip: number
  let sx: number
  if (t < 0.12) {
    const p = t / 0.12
    sc = scMin + Math.sin(p * Math.PI) * 0.03
    ga = 0.25 + Math.sin(p * Math.PI) * 0.1
    ip = -1
    sx = 0
  } else if (t < 0.42) {
    const p = eob(Math.min(1, (t - 0.12) / 0.3))
    sc = scMin + (scMax - scMin) * p
    ga = 0.25 + p * 0.55
    ip = -1
    sx = 0
  } else if (t < 0.58) {
    const p = (t - 0.42) / 0.16
    sc = scMax - p * 0.08
    ga = 0.8 * (1 - p * 0.6)
    ip = p
    sx = Math.sin(p * Math.PI * 8) * s * 0.012 * (1 - p)
  } else if (t < 0.78) {
    const p = eio((t - 0.58) / 0.2)
    sc = scMax - 0.08 + (scMin - (scMax - 0.08)) * p
    ga = 0.2 * (1 - p)
    ip = -1
    sx = 0
  } else {
    sc = scMin
    ga = 0
    ip = -1
    sx = 0
  }
  if (ga > 0.01) {
    const ringR = s * 0.22 * sc
    ctx.save()
    ctx.globalAlpha = ga * 0.35
    ctx.beginPath()
    ctx.arc(cx, cy, ringR + s * 0.06, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255,255,255,1)'
    ctx.lineWidth = Math.max(1, s * 0.025)
    ctx.stroke()
    ctx.restore()
    ctx.save()
    ctx.globalAlpha = ga * 0.65
    ctx.beginPath()
    ctx.arc(cx, cy, ringR, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255,255,255,1)'
    ctx.lineWidth = Math.max(1, s * 0.016)
    ctx.stroke()
    ctx.restore()
  }
  if (ip >= 0) impact(ctx, cx, cy, ip, s)
  ctx.save()
  ctx.translate(cx + sx, cy)
  ctx.scale(sc, sc)
  drawFist(ctx, s * 0.55)
  ctx.restore()
}

function drawOpenHand(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.fillStyle = CHOP_FILL
  rr(ctx, -s * 0.01, -s * 0.18, s * 0.27, s * 0.38, s * 0.05)
  const fw = s * 0.063
  const fg = s * 0.018
  const fhs = [s * 0.26, s * 0.33, s * 0.29, s * 0.21]
  const tw = 4 * fw + 3 * fg
  const fy0 = -tw / 2 + s * 0.02
  for (let i = 0; i < 4; i++) {
    const fy = fy0 + i * (fw + fg)
    const fl = fhs[i]!
    rr(ctx, -s * 0.01 - fl + s * 0.015, fy, fl, fw, fw * 0.45)
  }
  ctx.save()
  ctx.translate(s * 0.04, s * 0.19)
  ctx.rotate(0.5)
  rr(ctx, -s * 0.15, -s * 0.034, s * 0.15, s * 0.068, s * 0.032)
  ctx.restore()
  rr(ctx, s * 0.22, -s * 0.09, s * 0.16, s * 0.2, s * 0.04)
}

export function drawChopHintFrame(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  s: number,
  phase01: number,
): void {
  const t = phase01
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, s, s)
  const cy = s * 0.48
  const rX = s * 0.68
  const lX = s * 0.32
  const mX = s * 0.5
  let hx: number
  let hy: number
  let rot: number
  if (t < 0.12) {
    hx = rX
    hy = cy - s * 0.04
    rot = -0.35
  } else if (t < 0.48) {
    const p = eio((t - 0.12) / 0.36)
    hx = rX + (lX - rX) * p
    hy = cy - s * 0.04 + s * 0.08 * p
    rot = -0.35 + 0.55 * p
  } else if (t < 0.62) {
    hx = lX
    hy = cy + s * 0.04
    rot = 0.2
  } else if (t < 0.82) {
    const p = eio((t - 0.62) / 0.2)
    hx = lX + (mX - lX) * p
    hy = cy + s * 0.04 + (cy - (cy + s * 0.04)) * p
    rot = 0.2 * (1 - p)
  } else {
    hx = mX
    hy = cy
    rot = 0
  }

  if (t > 0.1 && t < 0.65) {
    let sa: number
    if (t < 0.15) sa = (t - 0.1) / 0.05
    else if (t < 0.5) sa = 1
    else sa = Math.max(0, 1 - (t - 0.5) / 0.15)
    const prog = Math.min(1, t < 0.48 ? (t - 0.12) / 0.36 : 1)
    const x1 = rX + s * 0.06
    const y1 = cy - s * 0.1
    const x2 = x1 + (lX - s * 0.06 - x1) * prog
    const y2 = y1 + (cy + s * 0.1 - y1) * prog
    const lw = Math.max(1.2, s * 0.016)
    const steps = 12
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps
      const t1 = (i + 1) / steps
      const sx1 = x1 + (x2 - x1) * t0
      const sy1 = y1 + (y2 - y1) * t0
      const sx2 = x1 + (x2 - x1) * t1
      const sy2 = y1 + (y2 - y1) * t1
      ctx.strokeStyle = `rgba(255,255,255,${(sa * 0.4 * (0.1 + t1 * 0.9)).toFixed(3)})`
      ctx.lineWidth = lw * (0.3 + t1 * 0.7)
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(sx1, sy1)
      ctx.lineTo(sx2, sy2)
      ctx.stroke()
    }
  }
  ctx.save()
  ctx.translate(hx, hy)
  ctx.rotate(rot)
  drawOpenHand(ctx, s * 0.48)
  ctx.restore()
}

export function setupHintCanvasDpi(
  canvas: HTMLCanvasElement,
  logicalSize: number,
): number {
  const dpr = window.devicePixelRatio || 1
  canvas.width = logicalSize * dpr
  canvas.height = logicalSize * dpr
  canvas.style.width = `${logicalSize}px`
  canvas.style.height = `${logicalSize}px`
  return dpr
}

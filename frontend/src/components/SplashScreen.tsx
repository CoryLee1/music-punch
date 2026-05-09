import { useEffect, useRef, useCallback, useState } from 'react'

/**
 * 开屏动画 — 移植自 public/begin.html
 * 旋转的 POP PUNCH 球体 + PUNCH 按钮，点击后爆炸。
 *
 * 架构：splash 作为覆盖层叠在主 UI 上方。
 * 爆炸粒子落地后，通过 onComplete 通知父级开始淡隐。
 * 淡隐过程中画布继续绘制（粒子逐渐变透明），营造连贯过渡。
 */
type Props = {
  /** 爆炸粒子全部落地后触发 — 父级开始执行退出过渡 */
  onComplete: () => void
  /** 是否处于退出淡隐阶段 — 为 true 时画布粒子也逐渐淡出 */
  exiting?: boolean
}

const DISPLAY_FONT = "'Space Mono','Courier New',monospace"
const CONST_VEL_X = 0.0006
const CONST_VEL_Y = 0.0012
const GRAVITY_EX = 1.2
const SPHERE_COLOR = '#5bcde8'

export function SplashScreen({ onComplete, exiting }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [btnHidden, setBtnHidden] = useState(false)

  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  const exitingRef = useRef(exiting)
  exitingRef.current = exiting

  /** 主逻辑全部在 effect 中，用 vanilla canvas 驱动 */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let alive = true
    let W = 0
    let H = 0
    let cx = 0
    let cy = 0

    // sphere state
    let sRotX = 0
    let sRotY = Math.PI
    let sVelX = CONST_VEL_X
    let sVelY = CONST_VEL_Y
    let dragging = false
    let lastMX = 0
    let lastMY = 0

    // explosion
    let exploded = false
    let completeFired = false
    type ExParticle = {
      x: number; y: number; vx: number; vy: number
      isChar: boolean; ch: string
      floorY: number; restitution: number; friction: number
      settled: boolean; delay: number
    }
    let explodeParticles: ExParticle[] = []

    // sphere dots
    type SurfDot = {
      theta: number; phi: number; label: string
      shadowCh: string; isShadowAscii: boolean; shadow: number
      flashTimer: number
    }
    let surfaceDots: SurfDot[] = []

    // text particles
    type TextP = {
      homeTheta: number; homePhi: number
      cTheta: number; cPhi: number
      vTheta: number; vPhi: number
    }
    let textParticles: TextP[] = []

    let dragDVelY = 0
    let dragDVelX = 0

    /* helpers */
    function drawStar(cx_: number, cy_: number, outerR: number, innerR: number) {
      ctx!.beginPath()
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 5
        const r = i % 2 === 0 ? outerR : innerR
        const x = cx_ + Math.cos(a) * r
        const y = cy_ + Math.sin(a) * r
        if (i === 0) ctx!.moveTo(x, y); else ctx!.lineTo(x, y)
      }
      ctx!.closePath()
      ctx!.fill()
    }

    function fitText(text: string, maxW: number, maxSize: number) {
      let size = maxSize
      do {
        ctx!.font = `700 ${size}px ${DISPLAY_FONT}`
        if (ctx!.measureText(text).width <= maxW) return size
        size -= 2
      } while (size > 24)
      return size
    }

    function sampleText() {
      const S = 512
      const oc = document.createElement('canvas')
      oc.width = S; oc.height = S
      const o = oc.getContext('2d')!

      o.fillStyle = '#000'
      o.textAlign = 'center'
      o.textBaseline = 'middle'
      const particleSize = 3
      const groupOffsetY = -5 * particleSize

      const popSize = fitText('POP', S * 0.44, Math.floor(S * 0.25))
      o.font = `700 ${popSize}px ${DISPLAY_FONT}`

      const punchSize = fitText('PUNCH', S * 0.70, Math.floor(S * 0.22))
      o.font = `700 ${punchSize}px ${DISPLAY_FONT}`
      const punchY = S * 0.66 + groupOffsetY
      const punchMetrics = o.measureText('PUNCH')
      const punchTop = punchY - (punchMetrics.actualBoundingBoxAscent || punchSize * 0.5)

      o.font = `700 ${popSize}px ${DISPLAY_FONT}`
      const popMetrics = o.measureText('POP')
      const particleGap = 3 * particleSize
      const popY = punchTop - particleGap - (popMetrics.actualBoundingBoxDescent || popSize * 0.12)
      o.fillText('POP', S * 0.50, popY)

      o.font = `700 ${punchSize}px ${DISPLAY_FONT}`
      o.fillText('PUNCH', S * 0.50, punchY)

      drawStar(S * 0.12, S * 0.52 + groupOffsetY, S * 0.055, S * 0.024)
      drawStar(S * 0.88, S * 0.52 + groupOffsetY, S * 0.055, S * 0.024)

      return { data: o.getImageData(0, 0, S, S).data, S }
    }

    function buildDots() {
      surfaceDots = []
      const N = 2000
      const PUNCH = 'PUNCH'
      const ASCII_BLOCKS = ['■', '▪', '▬']
      const ASCII_LETTERS = ['P', 'O', 'N', 'C', 'H', 'M', 'E', 'A', 'T', 'R', 'U']
      const ASCII_MARKS = ['#', '*', '/', '|', '+', '^', '_', '-', ';']
      const ASCII_DOTS = ['·', '.', '•']
      const golden = Math.PI * (3 - Math.sqrt(5))

      for (let i = 0; i < N; i++) {
        const yy = 1 - (i / (N - 1)) * 2
        const phi = Math.acos(Math.max(-1, Math.min(1, yy)))
        const theta = golden * i

        const sx = Math.sin(phi) * Math.sin(theta)
        const sy = Math.cos(phi)
        const lowerMask = Math.max(0, Math.min(1, (sy + 0.08) / 0.46))
        const sideMask = Math.pow(Math.abs(sx), 0.72)
        const shadow = Math.max(0, Math.min(1, (sideMask * 0.58 + lowerMask * 0.68 - 0.24) * lowerMask))

        let isShadowAscii = false
        let shadowCh = '.'
        const pickShadowChar = () => {
          const r = Math.random()
          if (r < 0.30) return ASCII_BLOCKS[Math.floor(Math.random() * ASCII_BLOCKS.length)]
          if (r < 0.50) return ASCII_LETTERS[Math.floor(Math.random() * ASCII_LETTERS.length)]
          if (r < 0.80) return ASCII_MARKS[Math.floor(Math.random() * ASCII_MARKS.length)]
          return ASCII_DOTS[Math.floor(Math.random() * ASCII_DOTS.length)]
        }
        if (shadow > 0.42) {
          isShadowAscii = true
          shadowCh = pickShadowChar()
        } else if (shadow > 0.20 && Math.random() < 0.70) {
          isShadowAscii = true
          shadowCh = pickShadowChar()
        }

        surfaceDots.push({
          theta, phi,
          label: PUNCH[i % PUNCH.length],
          shadowCh, isShadowAscii, shadow,
          flashTimer: 0,
        })
      }

      const { data, S } = sampleText()
      textParticles = []
      const TSTEP = 3
      for (let py = 0; py < S; py += TSTEP) {
        for (let px = 0; px < S; px += TSTEP) {
          if (data[(py * S + px) * 4 + 3] < 60) continue
          const u = px / S
          const v = py / S
          const homeTheta = (u - 0.5) * Math.PI * 0.82
          const homePhi = (0.5 - v) * Math.PI * 0.72 + Math.PI / 2
          const startTheta = homeTheta + (Math.random() - 0.5) * Math.PI * 2
          const startPhi = Math.random() * Math.PI
          textParticles.push({ homeTheta, homePhi, cTheta: startTheta, cPhi: startPhi, vTheta: 0, vPhi: 0 })
          const bt = homeTheta + Math.PI
          textParticles.push({
            homeTheta: bt, homePhi,
            cTheta: bt + (Math.random() - 0.5) * Math.PI * 2,
            cPhi: Math.random() * Math.PI,
            vTheta: 0, vPhi: 0,
          })
        }
      }
    }

    function project(theta: number, phi: number, rx: number, ry: number) {
      let x = Math.sin(phi) * Math.sin(theta)
      let y = Math.cos(phi)
      let z = Math.sin(phi) * Math.cos(theta)
      const cy2 = Math.cos(ry), sy2 = Math.sin(ry)
      const x1 = x * cy2 + z * sy2, z1 = -x * sy2 + z * cy2
      x = x1; z = z1
      const cx2 = Math.cos(rx), sx2 = Math.sin(rx)
      const y1 = y * cx2 - z * sx2, z2 = y * sx2 + z * cx2
      return { x, y: y1, z: z2 }
    }

    /* ── 顶部装饰排版文字（与主界面一致，但颜色极浅） ── */
    const HEADER_FONT = "'Space Mono','Courier New',monospace"
    const ROW1_ITEMS = ['MUSIC PUNCH', 'GESTURAL INTERFACE', 'INTERACTIVE', '700 × 1000 MM', 'INTRODUCTION TYPOGRAPHY', 'MULTIMODAL ENGINE', 'IT/FY/04']
    const ROW2_ITEMS = ['CHARMING LIGATURE', 'AUDIO-VISUAL']
    const ROW3_TEXT = 'IN THE INTRODUCTION COURSE AT THE DEPARTMENT TYPOGRAFIE&SCHRIFTGESTALTUNG, FIRST-YEAR STUDENTS EXPLORE WHAT BALANCE MEANS WHEN TYPE STOPS BEING JUST TEXT. THEY BUILD THEIR OWN GRIDS, CRAFT ZINES THAT FLIRT WITH ORDER AND CHAOS, AND DESIGN FULL CHARACTER SETS PLUS TINY LIGATURES.'

    function drawTypoHeader() {
      const pad = 16
      let yOff = 12

      // Row 1 — space-between
      ctx!.font = `700 10px ${HEADER_FONT}`
      ctx!.textBaseline = 'top'
      ctx!.fillStyle = 'rgba(0, 0, 0, 0.08)'
      const totalGap = W - pad * 2
      // measure all items to distribute space
      const widths = ROW1_ITEMS.map(t => ctx!.measureText(t).width)
      const totalTextW = widths.reduce((a, b) => a + b, 0)
      const gap = ROW1_ITEMS.length > 1 ? (totalGap - totalTextW) / (ROW1_ITEMS.length - 1) : 0
      let xPos = pad
      for (let i = 0; i < ROW1_ITEMS.length; i++) {
        ctx!.fillText(ROW1_ITEMS[i], xPos, yOff)
        xPos += widths[i] + gap
      }
      yOff += 14

      // Row 2 — centered with gap
      ctx!.font = `600 9px ${HEADER_FONT}`
      ctx!.fillStyle = 'rgba(0, 0, 0, 0.06)'
      ctx!.textAlign = 'center'
      const r2Total = ROW2_ITEMS.reduce((a, t) => a + ctx!.measureText(t).width, 0) + 40
      let r2x = (W - r2Total) / 2
      ctx!.textAlign = 'left'
      for (let i = 0; i < ROW2_ITEMS.length; i++) {
        ctx!.fillText(ROW2_ITEMS[i], r2x, yOff)
        r2x += ctx!.measureText(ROW2_ITEMS[i]).width + 40
      }
      yOff += 14

      // Row 3 — paragraph
      ctx!.font = `400 8px ${HEADER_FONT}`
      ctx!.fillStyle = 'rgba(0, 0, 0, 0.05)'
      ctx!.textAlign = 'left'
      // simple wrap: just draw, canvas doesn't auto-wrap, so we draw in one line clipped
      ctx!.fillText(ROW3_TEXT, pad, yOff)

      // reset
      ctx!.textAlign = 'left'
      ctx!.textBaseline = 'top'
    }

    const GRAVITY_FLOW = 0.018
    const FLOW_DAMP = 0.88

    function drawSphere() {
      const R = Math.min(W, H) * 0.38
      if (!dragging) {
        sVelX = CONST_VEL_X; sVelY = CONST_VEL_Y
        sRotY += sVelY; sRotX += sVelX
        const MAX_TILT = 0.75
        if (sRotX > MAX_TILT) { sRotX = MAX_TILT; sVelX = 0 }
        if (sRotX < -MAX_TILT) { sRotX = -MAX_TILT; sVelX = 0 }
      }
      for (const p of textParticles) {
        let dTheta = p.homeTheta - p.cTheta
        let dPhi = p.homePhi - p.cPhi
        while (dTheta > Math.PI) dTheta -= Math.PI * 2
        while (dTheta < -Math.PI) dTheta += Math.PI * 2
        p.vTheta = (p.vTheta + dTheta * GRAVITY_FLOW + dragDVelY) * FLOW_DAMP
        p.vPhi = (p.vPhi + dPhi * GRAVITY_FLOW + dragDVelX) * FLOW_DAMP
        p.cTheta += p.vTheta
        p.cPhi = Math.max(0.01, Math.min(Math.PI - 0.01, p.cPhi + p.vPhi))
      }
      dragDVelY = 0; dragDVelX = 0

      for (const d of surfaceDots) {
        const { x, y, z } = project(d.theta, d.phi, sRotX, sRotY)
        if (z < 0) continue
        const depth = (z + 1) / 2
        const edgeness = 1 - depth
        const asciiFrontMin = 0.04

        ctx!.fillStyle = SPHERE_COLOR
        ctx!.textBaseline = 'middle'; ctx!.textAlign = 'center'

        if (d.flashTimer > 0) {
          d.flashTimer--
          ctx!.globalAlpha = 0.92
          ctx!.font = `700 13px ${DISPLAY_FONT}`
          ctx!.fillText(d.label, cx + x * R, cy + y * R)
        } else if (edgeness > 0.72) {
          ctx!.globalAlpha = 0.3 + edgeness * 0.6
          const fs = edgeness > 0.88 ? 13 : 10
          ctx!.font = `700 ${fs}px ${DISPLAY_FONT}`
          ctx!.fillText(d.label, cx + x * R, cy + y * R)
        } else if (d.isShadowAscii && edgeness > asciiFrontMin) {
          const frontFade = Math.min(1, Math.max(0, (depth - 0.08) / 0.62))
          const shadowAlpha = (0.20 + d.shadow * 0.68) * frontFade
          ctx!.globalAlpha = shadowAlpha
          const fs = d.shadow > 0.42 ? 13 : 10
          ctx!.font = `700 ${fs}px ${DISPLAY_FONT}`
          ctx!.fillText(d.shadowCh, cx + x * R, cy + y * R)
        } else {
          if (Math.random() < 0.0006) d.flashTimer = 6 + Math.floor(Math.random() * 16)
          ctx!.globalAlpha = 0.2 + depth * 0.6
          ctx!.textBaseline = 'top'; ctx!.textAlign = 'left'
          const r = 1.2
          ctx!.beginPath()
          ctx!.arc(cx + x * R, cy + y * R, r, 0, Math.PI * 2)
          ctx!.fill()
        }
        ctx!.textBaseline = 'top'; ctx!.textAlign = 'left'
      }

      for (const p of textParticles) {
        const renderTheta = p.cTheta + (sRotY - Math.PI)
        const { x, y, z } = project(renderTheta, p.cPhi, 0, 0)
        if (z < -0.05) continue
        const sq = 3
        ctx!.globalAlpha = 1.0
        ctx!.fillStyle = SPHERE_COLOR
        ctx!.fillRect(cx + x * R - sq / 2, cy + y * R - sq / 2, sq, sq)
      }
      ctx!.globalAlpha = 1
    }

    function triggerExplosion() {
      if (exploded) return
      exploded = true
      setBtnHidden(true)
      const R = Math.min(W, H) * 0.38
      const CHARS = 'PUNCHME^|!;*A.,_'.split('')
      explodeParticles = []
      for (const d of surfaceDots) {
        const { x, y, z } = project(d.theta, d.phi, sRotX, sRotY)
        if (z < 0) continue
        explodeParticles.push({
            x: cx + x * R, y: cy + y * R, vx: 0, vy: 0,
            isChar: false, ch: d.label,
            floorY: H - 4, restitution: 0.10 + Math.random() * 0.15,
            friction: 0.82 + Math.random() * 0.15,
            settled: false, delay: 0,
          })
      }
      for (const p of textParticles) {
        const rt = p.cTheta + (sRotY - Math.PI)
        const { x, y, z } = project(rt, p.cPhi, 0, 0)
        if (z < -0.05) continue
        explodeParticles.push({
            x: cx + x * R, y: cy + y * R, vx: 0, vy: 0,
            isChar: true, ch: CHARS[Math.floor(Math.random() * CHARS.length)],
            floorY: H - 4, restitution: 0.10 + Math.random() * 0.15,
            friction: 0.82 + Math.random() * 0.15,
            settled: false, delay: 0,
          })
      }
      for (const p of explodeParticles) {
        const dx = p.x - cx, dy = p.y - cy
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const force = (400 + Math.random() * 500) / dist
        const angle = Math.atan2(dy, dx) + (Math.random() - 0.5) * 1.0
        p.vx = Math.cos(angle) * force * (0.3 + Math.random() * 0.6)
        p.vy = Math.sin(angle) * force * (0.2 + Math.random() * 0.5) - Math.random() * 2
        p.delay = Math.floor((dist / 400) * 6 + Math.random() * 4)
      }
    }

    function drawExplosion() {
      let anyMoving = false
      ctx!.font = `700 8px ${DISPLAY_FONT}`
      ctx!.textBaseline = 'middle'; ctx!.textAlign = 'center'
      for (const p of explodeParticles) {
        if (p.delay > 0) { p.delay--; anyMoving = true; continue }
        if (!p.settled) {
          p.vy += GRAVITY_EX
          p.vx *= 0.97 + Math.random() * 0.01
          p.x += p.vx + (Math.random() - 0.5) * 0.08
          p.y += p.vy
          if (p.y >= p.floorY) {
            p.y = p.floorY
            p.vy = -Math.abs(p.vy) * p.restitution
            p.vx *= p.friction
            if (Math.abs(p.vy) < 1.5) p.vy *= 0.3
            if (Math.abs(p.vy) < 0.5 && Math.abs(p.vx) < 0.5) {
              p.settled = true; p.vx = 0; p.vy = 0
            }
          }
          if (p.x < 0) { p.x = 0; p.vx = Math.abs(p.vx) * 0.35 }
          if (p.x > W) { p.x = W; p.vx = -Math.abs(p.vx) * 0.35 }
          anyMoving = true
        }
        ctx!.globalAlpha = p.settled ? 0.4 : 0.85
        ctx!.fillStyle = SPHERE_COLOR
        if (p.isChar) ctx!.fillText(p.ch, p.x, p.y)
        else { ctx!.beginPath(); ctx!.arc(p.x, p.y, 1.5, 0, Math.PI * 2); ctx!.fill() }
      }
      ctx!.globalAlpha = 1; ctx!.textAlign = 'left'; ctx!.textBaseline = 'top'
      if (!anyMoving && !completeFired && alive) {
        completeFired = true
        // 粒子落地后立刻切换
        onCompleteRef.current()
      }
    }

    function draw() {
      if (!alive) return
      ctx!.clearRect(0, 0, W, H)
      // 退出阶段不再绘制白色背景 — 让 CSS opacity 过渡直接透出底层
      if (!exitingRef.current) {
        ctx!.fillStyle = '#ffffff'
        ctx!.fillRect(0, 0, W, H)
      }
      // 装饰排版文字始终绘制（退出阶段也画，跟随淡出）
      drawTypoHeader()
      if (exploded) drawExplosion()
      else drawSphere()
      requestAnimationFrame(draw)
    }

    function resize() {
      W = canvas.width = window.innerWidth
      H = canvas.height = window.innerHeight
      cx = W / 2; cy = H / 2
    }

    /* input handlers */
    const onMouseDown = (e: MouseEvent) => {
      if (exploded) return
      dragging = true; sVelX = 0; sVelY = 0
      lastMX = e.clientX; lastMY = e.clientY
    }
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging) return
      const dx = e.clientX - lastMX, dy = e.clientY - lastMY
      sVelY = dx * 0.003; sVelX = dy * 0.003
      sRotY += sVelY; sRotX = Math.max(-0.75, Math.min(0.75, sRotX + sVelX))
      dragDVelY = -sVelY * 0.2; dragDVelX = -sVelX * 0.2
      lastMX = e.clientX; lastMY = e.clientY
    }
    const onMouseUp = () => { dragging = false }
    const onTouchStart = (e: TouchEvent) => {
      if (exploded) return
      dragging = true; sVelX = 0; sVelY = 0
      lastMX = e.touches[0].clientX; lastMY = e.touches[0].clientY
    }
    const onTouchMove = (e: TouchEvent) => {
      if (!dragging) return
      const dx = e.touches[0].clientX - lastMX, dy = e.touches[0].clientY - lastMY
      sVelY = dx * 0.003; sVelX = dy * 0.003
      sRotY += sVelY; sRotX = Math.max(-0.75, Math.min(0.75, sRotX + sVelX))
      dragDVelY = -sVelY * 0.2; dragDVelX = -sVelX * 0.2
      lastMX = e.touches[0].clientX; lastMY = e.touches[0].clientY
    }
    const onTouchEnd = () => { dragging = false }

    canvas.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    canvas.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: true })
    window.addEventListener('touchend', onTouchEnd)
    window.addEventListener('resize', resize)

    // expose explosion trigger for the button
    ;(canvas as any).__triggerExplosion = triggerExplosion

    // init
    resize()
    const start = () => {
      buildDots()
      draw()
    }
    if (document.fonts?.ready) document.fonts.ready.then(start)
    else start()

    return () => {
      alive = false
      canvas.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      canvas.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('resize', resize)
    }
  }, [])

  const handlePunch = useCallback(() => {
    const canvas = canvasRef.current
    if (canvas && (canvas as any).__triggerExplosion) {
      ;(canvas as any).__triggerExplosion()
    }
  }, [])

  return (
    <div className="splash-screen">
      <canvas
        ref={canvasRef}
        className="splash-canvas"
        style={{ cursor: btnHidden ? 'default' : 'grab' }}
      />
      <div
        ref={wrapRef}
        className={`splash-btn-wrap ${btnHidden ? 'hidden' : ''}`}
      >
        <button ref={btnRef} className="splash-punch-btn" onClick={handlePunch}>
          PUNCH
        </button>
      </div>
    </div>
  )
}

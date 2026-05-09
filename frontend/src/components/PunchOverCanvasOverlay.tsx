import { useEffect, useRef } from 'react'

/**
 * 自 public/music-punch-intro_16_1.html 移植：透明底点阵「PUNCH / OVER」，不遮挡原界面背景；
 * 可点击再次引爆。Boss / 计时结束后全屏展示，自动从中心炸开。
 */
type Props = {
  visible: boolean
  score: number
  comboMax: number
  onDismiss: () => void
  onRestart?: () => void
  autoExplodeDelayMs?: number
}

const CHAR_COLORS = [
  '#00bdd6',
  '#00bdd6',
  '#00bdd6',
  '#00bdd6',
  '#33cade',
  '#66d6e3',
]
const CHARS = `A^|!;*"',._\`~-+=<>?/#$%&`.split('')

const DOT_R = 3.0
const DOT_GAP = 9

type PState = 'dot' | 'char'

type Particle = {
  x: number
  y: number
  ox: number
  oy: number
  vx: number
  vy: number
  ch: string
  color: string
  floorY: number
  restitution: number
  groundFriction: number
  settled: boolean
  delay: number
  state: PState
}

function sampleText(lines: string[], W: number, H: number): ImageData {
  const fontSize = Math.min(W * 0.195, H * 0.27, 140)
  const fontStr = `900 ${fontSize}px 'Arial Black', Arial, sans-serif`

  const oc = document.createElement('canvas')
  oc.width = W
  oc.height = H
  const octx = oc.getContext('2d')!
  octx.font = fontStr
  octx.textBaseline = 'alphabetic'
  const lineH = fontSize * 1.18
  const totalH = lines.length * lineH
  const startY = (H - totalH) / 2 + fontSize * 0.82

  lines.forEach((line, i) => {
    octx.font = fontStr
    const tw = octx.measureText(line).width
    octx.fillStyle = '#000'
    octx.fillText(line, (W - tw) / 2, startY + i * lineH)
  })
  return octx.getImageData(0, 0, W, H)
}

function buildParticles(W: number, H: number): Particle[] {
  const imageData = sampleText(['PUNCH', 'OVER'], W, H)
  const d = imageData.data
  const particles: Particle[] = []
  const radius = 3

  for (let py = DOT_GAP; py < H - DOT_GAP; py += DOT_GAP) {
    for (let px = DOT_GAP; px < W - DOT_GAP; px += DOT_GAP) {
      let totalA = 0
      let count = 0
      for (let sy = -radius; sy <= radius; sy++) {
        for (let sx = -radius; sx <= radius; sx++) {
          const ix = Math.min(W - 1, Math.max(0, px + sx))
          const iy = Math.min(H - 1, Math.max(0, py + sy))
          totalA += d[(iy * W + ix) * 4 + 3]
          count++
        }
      }
      const a = totalA / count
      if (a > 55) {
        const ch = CHARS[Math.floor(Math.random() * CHARS.length)]
        const color =
          CHAR_COLORS[Math.floor(Math.random() * CHAR_COLORS.length)]
        particles.push({
          x: px,
          y: py,
          ox: px,
          oy: py,
          vx: 0,
          vy: 0,
          ch,
          color,
          floorY: H - DOT_R - 2,
          restitution: 0.28 + Math.random() * 0.42,
          groundFriction: 0.58 + Math.random() * 0.28,
          settled: false,
          delay: 0,
          state: 'dot',
        })
      }
    }
  }
  return particles
}

export function PunchOverCanvasOverlay({
  visible,
  score,
  comboMax,
  onDismiss,
  onRestart,
  autoExplodeDelayMs = 100,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hintRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!visible) return

    const canvas = canvasRef.current
    const hintEl = hintRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return

    let alive = true
    const particles: Particle[] = []
    let w = 0
    let h = 0
    let exploded = false
    let animId: number | null = null
    let resetAfterIdleT: ReturnType<typeof setTimeout> | null = null
    let hintFadeT: ReturnType<typeof setTimeout> | null = null

    const clearAnim = () => {
      if (animId != null) {
        cancelAnimationFrame(animId)
        animId = null
      }
    }

    const clearTimers = () => {
      if (resetAfterIdleT != null) {
        clearTimeout(resetAfterIdleT)
        resetAfterIdleT = null
      }
      if (hintFadeT != null) {
        clearTimeout(hintFadeT)
        hintFadeT = null
      }
    }

    const drawFrame = () => {
      ctx.clearRect(0, 0, w, h)
      for (const p of particles) {
        ctx.fillStyle = p.color
        if (p.state === 'dot') {
          const s = DOT_R * 2
          ctx.fillRect(p.x - DOT_R, p.y - DOT_R, s, s)
        } else {
          ctx.font = '8px Courier New, monospace'
          ctx.textBaseline = 'middle'
          ctx.textAlign = 'center'
          ctx.fillText(p.ch, p.x, p.y)
        }
      }
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
    }

    const syncParticlesFromBuild = () => {
      particles.length = 0
      const next = buildParticles(w, h)
      particles.push(...next)
    }

    /** 取容器尺寸（覆盖左侧面板而非全屏） */
    const getContainerSize = () => {
      const parent = canvas.parentElement
      if (parent) return { w: parent.clientWidth, h: parent.clientHeight }
      return { w: window.innerWidth, h: window.innerHeight }
    }

    const resize = () => {
      if (exploded) return
      const sz = getContainerSize()
      w = sz.w
      h = sz.h
      canvas.width = w
      canvas.height = h
      syncParticlesFromBuild()
      drawFrame()
    }

    const loop = () => {
      if (!alive) return
      const GRAVITY = 0.5
      let anyMoving = false

      for (const p of particles) {
        if (p.settled) continue
        if (p.delay > 0) {
          p.delay--
          anyMoving = true
          continue
        }
        p.vy += GRAVITY
        p.vx *= 0.991 + Math.random() * 0.003
        p.x += p.vx + (Math.random() - 0.5) * 0.12
        p.y += p.vy
        if (p.y >= p.floorY) {
          p.y = p.floorY
          p.vy = -Math.abs(p.vy) * p.restitution
          p.vx *= p.groundFriction
          if (Math.abs(p.vy) < 0.8) p.vy *= 0.5
          if (Math.abs(p.vy) < 0.15 && Math.abs(p.vx) < 0.15) {
            p.settled = true
            p.y = p.floorY
            p.vx = 0
            p.vy = 0
          }
        }
        if (p.x < 2) {
          p.x = 2
          p.vx = Math.abs(p.vx) * 0.35
        }
        if (p.x > w - 2) {
          p.x = w - 2
          p.vx = -Math.abs(p.vx) * 0.35
        }
        if (!p.settled) anyMoving = true
      }

      drawFrame()
      if (anyMoving) {
        animId = requestAnimationFrame(loop)
      } else {
        resetAfterIdleT = window.setTimeout(() => {
          if (!alive) return
          exploded = false
          const sz = getContainerSize()
          w = sz.w
          h = sz.h
          canvas.width = w
          canvas.height = h
          syncParticlesFromBuild()
          drawFrame()
          if (hintEl) {
            hintFadeT = window.setTimeout(() => {
              if (!alive || !hintEl) return
              hintEl.style.opacity = '1'
            }, 500)
          }
        }, 2200)
      }
    }

    const explodeAt = (cx: number, cy: number) => {
      if (!alive || exploded) return
      exploded = true
      clearTimers()
      if (hintEl) hintEl.style.opacity = '0'

      for (const p of particles) {
        p.state = 'char'
        const dx = p.ox - cx
        const dy = p.oy - cy
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const force = (650 + Math.random() * 800) / dist
        const angle = Math.atan2(dy, dx) + (Math.random() - 0.5) * 1.1
        p.vx = Math.cos(angle) * force * (0.4 + Math.random() * 0.9)
        p.vy =
          Math.sin(angle) * force * (0.25 + Math.random() * 0.85) -
          Math.random() * 4
        p.x = p.ox
        p.y = p.oy
        p.settled = false
        p.delay = Math.floor((dist / 600) * 14 + Math.random() * 10)
      }
      clearAnim()
      animId = requestAnimationFrame(loop)
    }

    const canvasToLogic = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect()
      const sx = canvas.width / Math.max(1, rect.width)
      const sy = canvas.height / Math.max(1, rect.height)
      return {
        x: (clientX - rect.left) * sx,
        y: (clientY - rect.top) * sy,
      }
    }

    exploded = false
    resize()
    if (hintEl) hintEl.style.opacity = '1'

    const onResize = () => resize()
    window.addEventListener('resize', onResize)

    const onClick = (e: MouseEvent) => {
      const { x, y } = canvasToLogic(e.clientX, e.clientY)
      explodeAt(x, y)
    }
    canvas.addEventListener('click', onClick)

    const autoT = window.setTimeout(() => {
      explodeAt(w / 2, h / 2)
    }, autoExplodeDelayMs)

    return () => {
      alive = false
      window.clearTimeout(autoT)
      window.removeEventListener('resize', onResize)
      canvas.removeEventListener('click', onClick)
      clearAnim()
      clearTimers()
    }
  }, [visible, autoExplodeDelayMs])

  if (!visible) return null

  return (
    <div className="punch-over-fullscreen" role="presentation">
      <canvas ref={canvasRef} className="punch-over-canvas" aria-hidden />
      <div ref={hintRef} className="punch-over-hint">
        <span className="punch-over-hint-en">CLICK TO EXPLODE</span>
        <span className="punch-over-hint-zh">点击引爆</span>
      </div>
      <footer className="punch-over-footer">
        <span className="punch-over-stats">
          // SCORE · {score} · MAX COMBO ×{comboMax}
        </span>
        <div className="punch-over-actions">
          {onRestart && (
            <button
              type="button"
              className="punch-over-restart"
              onClick={onRestart}
            >
              ↻ 重来一次
            </button>
          )}
          <button
            type="button"
            className="punch-over-dismiss"
            onClick={onDismiss}
          >
            // CLOSE
          </button>
        </div>
      </footer>
    </div>
  )
}

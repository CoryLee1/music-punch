import {
  FilesetResolver,
  HandLandmarker,
  type HandLandmarkerResult,
} from '@mediapipe/tasks-vision'
import { useCallback, useEffect, useRef } from 'react'
import type { AppPhase } from './ControlPanel'
import {
  GestureEventDetector,
  openness,
  palmPitchFactorFromOpenness,
  pickPrimaryHand,
  type GestureHit,
} from '../lib/handGestures'
import { PLAYBACK_GAIN, SampleLoopController } from '../lib/samplePlayer'

/* ───── MediaPipe 配置 ───── */
const WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
const HAND_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

/* ───── 手部关键点索引 ───── */
const THUMB = 4
const INDEX = 8

/* ───── 视觉常量 ───── */
const GLYPHS = '○◎□⊠×+✦·—/⊕◇⊹∴Δ⟨⟩'
const GRID_ALPHA = 0.03
/** 品牌色 RGB */
const B = '0, 189, 214'

/* ───── 工具函数 ───── */
function pseudoNoise(i: number, j: number, t: number) {
  return (Math.sin(i * 12.9898 + j * 78.233 + t * 2.399) * 43758.5453) % 1
}

function mapRange(v: number, a: number, b: number, c: number, d: number) {
  return c + ((v - a) / (b - a)) * (d - c)
}

function constrain(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

function nf(n: number, dec: number) {
  return dec <= 0 ? String(Math.round(n)) : n.toFixed(dec)
}

type LM = { x: number; y: number }

/* ═══════════════════════════════════════════════════
   绘制函数 — 全部使用品牌色 rgba(0, 189, 214, α)
   ═══════════════════════════════════════════════════ */

/** 绘制深色背景 + 网格 */
function drawBackground(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = '#241e18'
  ctx.fillRect(0, 0, w, h)

  ctx.strokeStyle = `rgba(${B}, ${GRID_ALPHA})`
  ctx.lineWidth = 0.5
  const gridSize = 60
  for (let x = 0; x < w; x += gridSize) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
  }
  for (let y = 0; y < h; y += gridSize) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke()
  }
}

/** 漂浮字符背景 */
function drawFloatingGlyphs(ctx: CanvasRenderingContext2D, w: number, h: number, frame: number) {
  ctx.textBaseline = 'alphabetic'
  ctx.font = '10px "Space Mono", monospace'
  const t = frame * 0.008
  for (let i = 0; i < 50; i++) {
    const nx = Math.abs(pseudoNoise(i * 0.17 + t, i * 0.03, 0))
    const ny = Math.abs(pseudoNoise(i * 0.19 + 40, i * 0.07 + t, 1))
    ctx.fillStyle = `rgba(${B}, ${0.04 + (i % 5) * 0.012})`
    ctx.fillText(GLYPHS.charAt(i % GLYPHS.length), nx * w, ny * h)
  }
}

/** 中心圆环（idle 呼吸动画） */
function drawIdleRing(ctx: CanvasRenderingContext2D, w: number, h: number, frame: number) {
  const cx = w / 2, cy = h / 2
  const r = 80 + Math.sin(frame * 0.015) * 6
  ctx.strokeStyle = `rgba(${B}, 0.15)`
  ctx.lineWidth = 0.8
  ctx.setLineDash([4, 8])
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()
  ctx.setLineDash([])

  const cr = 10
  ctx.strokeStyle = `rgba(${B}, 0.1)`
  ctx.lineWidth = 0.5
  ctx.beginPath()
  ctx.moveTo(cx - cr, cy); ctx.lineTo(cx + cr, cy)
  ctx.moveTo(cx, cy - cr); ctx.lineTo(cx, cy + cr)
  ctx.stroke()
}

/** 系统头部信息 */
function drawSystemInfo(ctx: CanvasRenderingContext2D, phase: AppPhase, emotion: string, elapsed: number) {
  ctx.font = '10px "Space Mono", monospace'
  ctx.fillStyle = `rgba(${B}, 0.25)`
  ctx.textBaseline = 'top'
  ctx.fillText(`// PHASE: ${phase.toUpperCase()}`, 16, 16)
  if (emotion) ctx.fillText(`// EMOTION: "${emotion.slice(0, 30)}"`, 16, 32)
  if (phase === 'active') {
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
    const ss = String(Math.floor(elapsed) % 60).padStart(2, '0')
    ctx.fillText(`// ELAPSED: ${mm}:${ss}`, 16, emotion ? 48 : 32)
  }
  ctx.textBaseline = 'alphabetic'
}

/** 手部骨架绘制（镜像 x 坐标，与摄像头预览方向一致） */
function drawHandSkeleton(ctx: CanvasRenderingContext2D, landmarks: LM[], w: number, h: number) {
  ctx.fillStyle = `rgba(${B}, 0.6)`
  for (const p of landmarks) {
    ctx.beginPath(); ctx.arc((1 - p.x) * w, p.y * h, 2.5, 0, Math.PI * 2); ctx.fill()
  }

  const connections = [
    [0,1],[1,2],[2,3],[3,4],
    [0,5],[5,6],[6,7],[7,8],
    [0,9],[9,10],[10,11],[11,12],
    [0,13],[13,14],[14,15],[15,16],
    [0,17],[17,18],[18,19],[19,20],
    [5,9],[9,13],[13,17],
  ]
  ctx.strokeStyle = `rgba(${B}, 0.3)`
  ctx.lineWidth = 0.8
  for (const [a, b] of connections) {
    if (a < landmarks.length && b < landmarks.length) {
      ctx.beginPath()
      ctx.moveTo((1 - landmarks[a].x) * w, landmarks[a].y * h)
      ctx.lineTo((1 - landmarks[b].x) * w, landmarks[b].y * h)
      ctx.stroke()
    }
  }
}

/** 捏合构造线 — 拇指和食指之间的关系可视化（镜像） */
function drawPinchConstruct(ctx: CanvasRenderingContext2D, thumb: LM, idx: LM, radius: number, w: number, h: number) {
  const tx = (1 - thumb.x) * w, ty = thumb.y * h
  const ix = (1 - idx.x) * w, iy = idx.y * h
  const mx = (tx + ix) / 2, my = (ty + iy) / 2

  // 连线
  ctx.strokeStyle = `rgba(${B}, 0.4)`
  ctx.lineWidth = 0.6
  ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(ix, iy); ctx.stroke()

  // 中心半径圆
  ctx.strokeStyle = `rgba(${B}, 0.18)`
  ctx.lineWidth = 0.4
  ctx.beginPath(); ctx.arc(mx, my, radius / 2, 0, Math.PI * 2); ctx.stroke()

  // 中心到画布中心的辅助线
  ctx.strokeStyle = `rgba(${B}, 0.12)`
  ctx.lineWidth = 0.3
  ctx.beginPath(); ctx.moveTo(w / 2, h / 2); ctx.lineTo(mx, my); ctx.stroke()
}

/** 手势事件提示（抓/出拳/切） */
function drawGestureCue(ctx: CanvasRenderingContext2D, w: number, cue: { labelZh: string; labelEn: string; t: number }, ageMs: number) {
  const duration = 1200
  const fade = Math.max(0, 1 - ageMs / duration)
  if (fade <= 0) return

  ctx.save()
  ctx.font = '13px "Space Mono", monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const y = 96
  ctx.fillStyle = `rgba(${B}, ${0.15 + 0.55 * fade})`
  ctx.fillText(`// GESTURE · ${cue.labelZh}  /  ${cue.labelEn}`, w / 2, y)
  ctx.lineWidth = 0.6
  ctx.strokeStyle = `rgba(${B}, ${0.25 + 0.45 * fade})`
  ctx.strokeRect(w / 2 - 158, y - 6, 316, 26)
  ctx.restore()
}

/** 手势数据 HUD（镜像坐标） */
function drawDataHUD(
  ctx: CanvasRenderingContext2D,
  thumb: LM, idx: LM, radius: number,
  playbackRate: number, palmOpen: number, palmMul: number,
  w: number, h: number,
) {
  const cx = ((1 - thumb.x) * w + (1 - idx.x) * w) / 2
  const cy = (thumb.y * h + idx.y * h) / 2

  ctx.font = '10px "Space Mono", monospace'
  ctx.fillStyle = `rgba(${B}, 0.7)`
  ctx.fillText(`POS X:${nf(cx, 0)} Y:${nf(cy, 0)}`, cx + 12, cy - 6)
  ctx.fillText(`PINCH_R: ${nf(radius, 1)}`, cx + 12, cy + 8)

  // 底部面板
  ctx.strokeStyle = `rgba(${B}, 0.2)`
  ctx.lineWidth = 0.55
  ctx.strokeRect(10, h - 88, 280, 76)

  ctx.fillStyle = `rgba(${B}, 0.55)`
  ctx.fillText('// TRACE · GESTURE_CONTROLLER', 18, h - 72)
  ctx.fillText(`RADIUS        ${nf(radius, 1)} px`, 18, h - 56)
  ctx.fillText(`PINCH_RATE    ${nf(playbackRate, 2)}`, 18, h - 42)
  ctx.fillText(`PALM_OPEN     ${nf(palmOpen, 3)}  ·  MUL ${nf(palmMul, 3)}`, 18, h - 28)
  ctx.fillText(`GAIN · ${PLAYBACK_GAIN}  (常驻)`, 18, h - 14)
}

/** Loading 状态绘制 */
function drawLoadingState(ctx: CanvasRenderingContext2D, w: number, h: number, frame: number, emotion: string) {
  const cx = w / 2, cy = h / 2
  const angle = frame * 0.04
  const r = 55

  ctx.strokeStyle = `rgba(${B}, 0.1)`; ctx.lineWidth = 1
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke()

  ctx.strokeStyle = `rgba(${B}, 0.55)`; ctx.lineWidth = 1.5
  ctx.beginPath(); ctx.arc(cx, cy, r, angle, angle + Math.PI * 0.6); ctx.stroke()

  const r2 = 35
  ctx.strokeStyle = `rgba(${B}, 0.06)`; ctx.lineWidth = 0.5
  ctx.beginPath(); ctx.arc(cx, cy, r2, 0, Math.PI * 2); ctx.stroke()

  ctx.strokeStyle = `rgba(${B}, 0.35)`; ctx.lineWidth = 1
  ctx.beginPath(); ctx.arc(cx, cy, r2, -angle * 0.7, -angle * 0.7 + Math.PI * 0.4); ctx.stroke()

  ctx.font = '11px "Space Mono", monospace'
  ctx.fillStyle = `rgba(${B}, 0.45)`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText('PARSING EMOTION', cx, cy - 80)

  ctx.font = '13px "Space Mono", monospace'
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'
  const displayEmotion = emotion.length > 24 ? emotion.slice(0, 24) + '…' : emotion
  ctx.fillText(`"${displayEmotion}"`, cx, cy + 80)

  const dots = '.'.repeat(Math.floor(frame / 20) % 4)
  ctx.font = '10px "Space Mono", monospace'
  ctx.fillStyle = `rgba(${B}, 0.3)`
  ctx.fillText(`GENERATING${dots}`, cx, cy + 105)

  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
}

/** 底部提示文字 */
function drawBottomHint(ctx: CanvasRenderingContext2D, w: number, h: number, text: string) {
  ctx.font = '10px "Space Mono", monospace'
  ctx.fillStyle = `rgba(${B}, 0.2)`
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
  ctx.fillText(text, w / 2, h - 16)
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
}

/** 无手势时的提示 */
function drawSignalNull(ctx: CanvasRenderingContext2D, h: number) {
  ctx.font = '10px "Space Mono", monospace'
  ctx.fillStyle = `rgba(${B}, 0.3)`
  ctx.fillText('// SIGNAL: NULL · SHOW HANDS TO CAMERA', 14, h - 18)
}

/** 白闪效果 */
function drawWhiteFlash(ctx: CanvasRenderingContext2D, w: number, h: number, progress: number) {
  const alpha = Math.max(0, 0.9 * (1 - progress))
  ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`
  ctx.fillRect(0, 0, w, h)
}

/** PUNCH OVER 文字 */
function drawPunchOver(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  progress: number, flicker: boolean, fade: boolean, fadeProgress: number,
) {
  ctx.save()
  const bgAlpha = fade ? Math.max(0, 1 - fadeProgress) : 1
  ctx.fillStyle = `rgba(0, 0, 0, ${bgAlpha})`
  ctx.fillRect(0, 0, w, h)

  const scaleT = Math.min(progress / 0.08, 1)
  const eased = scaleT < 1 ? 1 - Math.pow(1 - scaleT, 3) * (1 + 2.5 * (1 - scaleT)) : 1
  const scale = 0.3 + 0.7 * Math.min(eased, 1.15)

  let textAlpha = Math.min(scaleT, 1)
  if (fade) textAlpha *= Math.max(0, 1 - fadeProgress)
  if (flicker) textAlpha *= 0.85 + 0.15 * Math.sin(performance.now() * 0.04)

  ctx.translate(w / 2, h / 2)
  ctx.scale(scale, scale)
  const fontSize = Math.min(w * 0.12, 120)
  ctx.font = `700 ${fontSize}px "Space Mono", "IBM Plex Mono", monospace`
  ctx.fillStyle = `rgba(255, 255, 255, ${textAlpha * 0.9})`
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText('PUNCH OVER', 0, 0)
  ctx.restore()
}

/* ═══════════════════════════════════════════════════
   主组件
   ═══════════════════════════════════════════════════ */

interface GestureStageProps {
  phase: AppPhase
  emotion: string
  elapsed: number
  videoRef: React.RefObject<HTMLVideoElement | null>
  /** 音频控制器（由 App 传入） */
  audioRef: React.RefObject<SampleLoopController | null>
  audioStarted: boolean
  onError?: (msg: string) => void
  onGestureHit?: (hit: GestureHit) => void
  /** PUNCH OVER 相关 */
  showWhiteFlash?: boolean
  showPunchOver?: boolean
  punchOverFlicker?: boolean
  punchOverFade?: boolean
}

export function GestureStage({
  phase,
  emotion,
  elapsed,
  videoRef,
  audioRef,
  audioStarted,
  onError,
  onGestureHit,
  showWhiteFlash = false,
  showPunchOver = false,
  punchOverFlicker = false,
  punchOverFade = false,
}: GestureStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const landmarkerRef = useRef<HandLandmarker | null>(null)
  const rafRef = useRef<number>(0)
  const frameRef = useRef(0)
  const sizeRef = useRef({ w: 800, h: 600 })

  // 手势识别
  const gestureDetectorRef = useRef(new GestureEventDetector())
  const lastGestureCueRef = useRef<{ labelZh: string; labelEn: string; t: number } | null>(null)
  const palmOpenSmoothRef = useRef(0.155)

  // PUNCH OVER 动画时间追踪
  const whiteFlashStartRef = useRef(0)
  const punchOverStartRef = useRef(0)
  const punchOverFadeStartRef = useRef(0)

  useEffect(() => { if (showWhiteFlash) whiteFlashStartRef.current = performance.now() }, [showWhiteFlash])
  useEffect(() => { if (showPunchOver) punchOverStartRef.current = performance.now() }, [showPunchOver])
  useEffect(() => { if (punchOverFade) punchOverFadeStartRef.current = performance.now() }, [punchOverFade])

  // 初始化 MediaPipe HandLandmarker
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const fileset = await FilesetResolver.forVisionTasks(WASM_BASE)
        const lm = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numHands: 2,
        })
        if (!cancelled) landmarkerRef.current = lm
        else lm.close()
      } catch (e) {
        if (!cancelled) onError?.(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
      landmarkerRef.current?.close()
      landmarkerRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 自适应 canvas 尺寸
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      sizeRef.current = { w: Math.round(width), h: Math.round(height) }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // 绘制函数
  const paint = useCallback(
    (result: HandLandmarkerResult | null) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const { w, h } = sizeRef.current
      const dpr = window.devicePixelRatio || 1
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.scale(dpr, dpr)

      const fr = frameRef.current++

      // 1. 背景
      drawBackground(ctx, w, h)
      drawFloatingGlyphs(ctx, w, h, fr)

      // 2. 系统信息
      drawSystemInfo(ctx, phase, emotion, elapsed)

      // 3. 根据 phase 画不同内容
      if (phase === 'idle') {
        drawIdleRing(ctx, w, h, fr)
        drawBottomHint(ctx, w, h, '// INPUT EMOTION BELOW TO BEGIN')
      } else if (phase === 'loading') {
        drawLoadingState(ctx, w, h, fr, emotion)
      } else if (phase === 'active') {
        const hands = result?.landmarks ?? []
        const audio = audioRef.current

        if (hands.length > 0 && audio && audioStarted) {
          const primary = pickPrimaryHand(hands)
          if (primary) {
            // 绘制所有手的骨架
            for (const lm of hands) {
              drawHandSkeleton(ctx, lm, w, h)
            }

            // 捏合距离 → playbackRate
            const thumb = primary[THUMB]
            const indexFinger = primary[INDEX]
            const radius = Math.hypot(
              thumb.x * w - indexFinger.x * w,
              thumb.y * h - indexFinger.y * h,
            )
            drawPinchConstruct(ctx, thumb, indexFinger, radius, w, h)

            const minR = 20, maxR = 220
            let playbackRate = mapRange(radius, minR, maxR, 0.5, 2.0)
            playbackRate = constrain(playbackRate, 0.5, 2.0)

            // 手掌开合 → pitch 倍率
            const oRaw = openness(primary)
            palmOpenSmoothRef.current = palmOpenSmoothRef.current * 0.74 + oRaw * 0.26
            const palmMul = palmPitchFactorFromOpenness(palmOpenSmoothRef.current)

            // 手势事件检测
            let hit: GestureHit | null = null
            try {
              hit = gestureDetectorRef.current.push(primary, performance.now())
            } catch {
              gestureDetectorRef.current.reset()
            }
            if (hit) {
              lastGestureCueRef.current = { labelZh: hit.labelZh, labelEn: hit.labelEn, t: performance.now() }
              onGestureHit?.(hit)
              if (hit.signal !== 'grab') {
                audio.triggerGestureFx(hit.signal)
              }
            }

            // 应用手势到音频
            audio.applyGesture(playbackRate, palmMul)

            // 绘制数据 HUD
            drawDataHUD(ctx, thumb, indexFinger, radius, playbackRate, palmOpenSmoothRef.current, palmMul, w, h)
          }
        } else {
          // 无手势时重置
          gestureDetectorRef.current.reset()
          palmOpenSmoothRef.current = 0.155
          if (audio && audioStarted) {
            audio.applyGesture(undefined)
          }
          drawSignalNull(ctx, h)
        }

        // 手势事件提示
        const cue = lastGestureCueRef.current
        if (cue) {
          drawGestureCue(ctx, w, cue, performance.now() - cue.t)
        }

        // 注：泡泡模块将在这里接入
      }

      // 4. 白闪
      if (showWhiteFlash) {
        const elapsed = performance.now() - whiteFlashStartRef.current
        drawWhiteFlash(ctx, w, h, Math.min(elapsed / 600, 1))
      }

      // 5. PUNCH OVER
      if (showPunchOver) {
        const elapsed = performance.now() - punchOverStartRef.current
        const fadeP = punchOverFade ? Math.min((performance.now() - punchOverFadeStartRef.current) / 1500, 1) : 0
        drawPunchOver(ctx, w, h, Math.min(elapsed / 5000, 1), punchOverFlicker, punchOverFade, fadeP)
      }

      // 6. over 状态
      if (phase === 'over' && !showPunchOver) {
        drawBottomHint(ctx, w, h, '// SESSION ENDED · ENTER NEW EMOTION TO RESTART')
      }
    },
    [phase, emotion, elapsed, audioStarted, showWhiteFlash, showPunchOver, punchOverFlicker, punchOverFade, audioRef, onGestureHit],
  )

  // 渲染循环
  useEffect(() => {
    const loop = () => {
      const video = videoRef.current
      const marker = landmarkerRef.current

      let result: HandLandmarkerResult | null = null
      if (video && marker && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        try {
          result = marker.detectForVideo(video, performance.now())
        } catch {
          // 偶尔帧异常，静默跳过
        }
      }

      paint(result)
      rafRef.current = requestAnimationFrame(loop)
    }

    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [paint, videoRef])

  return (
    <section className="app-stage" ref={containerRef}>
      <div className="stage-canvas-wrap">
        <canvas ref={canvasRef} className="gesture-canvas" />
      </div>
    </section>
  )
}

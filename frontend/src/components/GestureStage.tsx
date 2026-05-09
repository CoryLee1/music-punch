import type { HandLandmarker, HandLandmarkerResult } from '@mediapipe/tasks-vision'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from 'react'
import { createRobustHandLandmarker } from '../lib/mediapipeHandLandmarker'
import {
  GestureEventDetector,
  pickPrimaryHand,
  type GestureHit,
} from '../lib/handGestures'
import {
  PLAYBACK_GAIN,
  SampleLoopController,
  resumeAudioContext,
} from '../lib/samplePlayer'
import {
  startTextMatterWorld,
  type HandProbePoint,
} from '../lib/runTextMatter'
import {
  getDashscopeAsrWsUrl,
  startDashscopeRealtimeAsr,
} from '../lib/dashscopeRealtimeAsr'
import { TechnoScanOverlay } from './TechnoScanOverlay'
import {
  ParticlePunchOverlay,
  type ParticlePunchHandle,
} from './ParticlePunchOverlay'
import type { BeatGestureHintHandle } from './BeatGestureHint'
import sampleBeatsGuide from '../data/sample-beats.json'
import {
  isWithinBeatWindow,
  beatLocalTau,
  beatTimesForBufferDuration,
  countBeatCrossings,
  type SampleBeatMeta,
} from '../lib/beatSync'

const BEATS_META = sampleBeatsGuide as SampleBeatMeta

const W = 640
const H = 480
/** 摄像头/检测用理想分辨率（与画布逻辑尺寸无关） */
const INDEX = 8
const THUMB_TIP = 4
const INDEX_TIP = 8
const MIDDLE_TIP_IDX = 12
const RING_TIP_IDX = 16
const PINKY_TIP = 20
/** 五指指尖拖尾：寿命与点数（每只手 5 条） */
const TIP_GLOW_TRAIL_MAX_AGE_MS = 560
const _TIP_GLOW_TRAIL_MAX_POINTS = 34
/** 拇指、食指、中指、无名指、小指 TIP 序号（与 MediaPipe 一致） */
const FINGER_TIP_INDICES = [
  THUMB_TIP,
  INDEX_TIP,
  MIDDLE_TIP_IDX,
  RING_TIP_IDX,
  PINKY_TIP,
] as const

type TipGlowPoint = { x: number; y: number; t: number }

function emptyHandTipGlowTrails(): TipGlowPoint[][] {
  return FINGER_TIP_INDICES.map(() => [])
}

const _MAX_HANDS_FOR_TIP_GLOW = 2
/** 非击打玩法时：出拳/切手落在主拍 ±该秒内才给背景升半音 */
const BEAT_PITCH_BUMP_WINDOW_SEC = 0.12

function schedulePunchViewportPulse(
  root: HTMLElement | null,
  timerRef: MutableRefObject<ReturnType<typeof window.setTimeout> | null>,
  particleCombo = 0,
): void {
  if (!root) return
  const prev = timerRef.current
  if (prev != null) window.clearTimeout(prev)
  root.classList.remove(
    'is-punch-viewport-zoom',
    'is-punch-viewport-combo-mid',
    'is-punch-viewport-combo-high',
  )
  requestAnimationFrame(() => {
    root.classList.add('is-punch-viewport-zoom')
    if (particleCombo >= 10) root.classList.add('is-punch-viewport-combo-high')
    else if (particleCombo >= 5)
      root.classList.add('is-punch-viewport-combo-mid')
  })
  timerRef.current = window.setTimeout(() => {
    root.classList.remove(
      'is-punch-viewport-zoom',
      'is-punch-viewport-combo-mid',
      'is-punch-viewport-combo-high',
    )
    timerRef.current = null
  }, 560)
}

const TEXT_SCAN_MS = 4400
const TEXT_MATTER_MS = 7600

/** 音频未播放时节拍引导仍与默认 loop 对齐（与 sample-beats.json 同一素材） */
const BEAT_GUIDE_FALLBACK_DURATION_SEC = Math.max(
  0.5,
  typeof sampleBeatsGuide.durationSec === 'number'
    ? sampleBeatsGuide.durationSec
    : 10.33,
)
/** 传给 BeatGestureHint：墙钟回退，与 Tone syncGeneration 区分 */
const BEAT_HINT_SYNC_WALLCLOCK = -1

/** 为 false 时不显示 TECHNO_SCAN 与 Matter 字形掉落画面（原计时与回调照旧） */
const SHOW_TEXT_SEQUENCE_VISUALS = false

/** MediaPipe 手部骨架（与 Tasks 21 关键点索引一致） */
const HAND_CONNECTIONS: [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  [0, 17],
]

const PAL = {
  /** 白色画板底 */
  bg: [255, 255, 255] as const,
  /** 手势骨架/关键点（纯黑） */
  ink: [0, 0, 0] as const,
  /** 装饰线条 / HUD 文字（统一蓝色） */
  deco: [0, 189, 214] as const,
  /** 装饰次级（蓝色降透明度用） */
  decoFaint: [0, 150, 175] as const,
  /** 飘字碎片（淡蓝） */
  ghost: [0, 170, 200] as const,
}

/** 五指指尖拖尾 — 淡蓝 */
const TIP_TRAIL: readonly [number, number, number] = [165, 215, 248]

function nf(n: number, _w: number, dec: number) {
  if (dec <= 0) return String(Math.round(n))
  return n.toFixed(dec)
}

function fract(x: number) {
  return x - Math.floor(x)
}

function pseudoNoise(i: number, j: number, t: number) {
  return fract(Math.sin(i * 12.9898 + j * 78.233 + t * 2.399) * 43758.5453)
}

type LM = { x: number; y: number }

/**
 * 摄像头在 canvas 上水平翻转时，与 MediaPipe 原始图坐标对齐：镜像归一化 x。
 */
function mirrorLandmarksFromCamera(
  landmarks: HandLandmarkerResult['landmarks'] | undefined,
): HandLandmarkerResult['landmarks'] {
  if (!landmarks?.length) return []
  return landmarks.map((hand) =>
    hand.map((p) => ({
      ...p,
      x: 1 - p.x,
    })),
  )
}

function drawGlitchField(
  ctx: CanvasRenderingContext2D,
  frame: number,
  w: number,
  h: number,
): void {
  const glyphs = '01/\\[]{}⟨⟩::xx⊹⌁∴Δ'
  ctx.textBaseline = 'alphabetic'
  ctx.font = '9px "IBM Plex Mono", monospace'
  const t = frame * 0.012
  const cx = w / 2
  const cy = h / 2
  const scale = Math.min(w, h)
  for (let i = 0; i < 95; i++) {
    const nx = pseudoNoise(i * 0.17 + t, i * 0.03, 0)
    const ny = pseudoNoise(i * 0.19 + 40, i * 0.07 + t, 1)
    const dx = (nx - 0.5) * 1.15
    const dy = (ny - 0.5) * 0.95
    const x = cx + dx * scale * 0.62
    const y = cy + dy * scale * 0.52
    ctx.fillStyle = `rgba(${PAL.ghost[0]}, ${PAL.ghost[1]}, ${PAL.ghost[2]}, ${0.05 + (i % 7) * 0.012})`
    ctx.fillText(glyphs.charAt(i % glyphs.length), x, y)
  }
}

function drawSystemHeader(ctx: CanvasRenderingContext2D): void {
  ctx.font = '11px "IBM Plex Mono", monospace'
  ctx.fillStyle = `rgba(${PAL.deco[0]}, ${PAL.deco[1]}, ${PAL.deco[2]}, 0.45)`
  let y = 22
  ctx.fillText('// SYSTEM: MATRIX_VOID · REACT_VITE', 14, y)
  ctx.fillText('// RIPPLE: SAMPLE_RATE_BINDING · TONE_PLAYER', 14, y + 14)
  ctx.fillText('// VISUAL: THIN_MONO · BW_REFERENCE', 14, y + 28)
}

function drawIdleGeometry(
  ctx: CanvasRenderingContext2D,
  frame: number,
  w: number,
  h: number,
): void {
  const cx = w / 2
  const cy = h / 2
  const baseR = (88 * Math.min(w, h)) / 480
  const r = baseR + Math.sin(frame * 0.02) * 4
  ctx.strokeStyle = `rgba(${PAL.deco[0]}, ${PAL.deco[1]}, ${PAL.deco[2]}, 0.42)`
  ctx.lineWidth = 0.6
  ctx.setLineDash([3, 7])
  ctx.beginPath()
  ctx.ellipse(cx, cy, r, r, 0, 0, Math.PI * 2)
  ctx.stroke()
  ctx.setLineDash([])
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 3) {
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6))
    ctx.stroke()
  }
}

function drawStartPrompt(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): void {
  const cx = w / 2
  const cy = h / 2
  ctx.strokeStyle = `rgba(${PAL.deco[0]}, ${PAL.deco[1]}, ${PAL.deco[2]}, 0.7)`
  ctx.lineWidth = 0.75
  ctx.strokeRect(cx - 248, cy - 42, 496, 84)
  ctx.fillStyle = `rgb(${PAL.deco[0]}, ${PAL.deco[1]}, ${PAL.deco[2]})`
  ctx.font = '13px "IBM Plex Mono", monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('[ BG_LOOP · AUTO_START · TAP_PREVIEW_IF_SILENT ]', cx, cy - 14)
  ctx.font = '12px "IBM Plex Mono", monospace'
  ctx.fillStyle = `rgba(${PAL.deco[0]}, ${PAL.deco[1]}, ${PAL.deco[2]}, 0.72)`
  ctx.fillText(
    '背景循环自动尝试播放 · 静音用 // STOP_AUDIO · 停止后可点预览区恢复',
    cx,
    cy + 14,
  )
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

/** 摄像头尚未出帧时提示（RAF 也会在未就绪时 paint，避免整区空白像「没开摄像头」） */
function drawCameraWaiting(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.font = '12px "IBM Plex Mono", monospace'
  ctx.textAlign = 'center'
  ctx.fillStyle = `rgba(${PAL.deco[0]}, ${PAL.deco[1]}, ${PAL.deco[2]}, 0.55)`
  ctx.fillText('// CAMERA · 等待摄像头画面 / 请确认浏览器已授权', w / 2, h / 2 - 8)
  ctx.font = '10px "IBM Plex Mono", monospace'
  ctx.fillText(
    '// 若一直无画面：检查地址栏摄像头权限 · 须 localhost 或 HTTPS',
    w / 2,
    h / 2 + 14,
  )
  ctx.textAlign = 'left'
}

function drawHandConnections(
  ctx: CanvasRenderingContext2D,
  landmarks: LM[],
  w: number,
  h: number,
): void {
  ctx.strokeStyle = `rgba(${PAL.ink[0]}, ${PAL.ink[1]}, ${PAL.ink[2]}, 0.85)`
  ctx.lineWidth = 1.2
  for (const [a, b] of HAND_CONNECTIONS) {
    const pa = landmarks[a]
    const pb = landmarks[b]
    if (!pa || !pb) continue
    ctx.beginPath()
    ctx.moveTo(pa.x * w, pa.y * h)
    ctx.lineTo(pb.x * w, pb.y * h)
    ctx.stroke()
  }
}

/** 五指指尖运动拖尾（淡蓝，配合白色画板） */
function _drawFingerTipGlowTrail(
  ctx: CanvasRenderingContext2D,
  trail: TipGlowPoint[],
  nowMs: number,
): void {
  if (trail.length === 0) return
  const maxAge = TIP_GLOW_TRAIL_MAX_AGE_MS
  const segAlpha = (t0: number, t1: number) => {
    const a0 = Math.max(0, 1 - (nowMs - t0) / maxAge)
    const a1 = Math.max(0, 1 - (nowMs - t1) / maxAge)
    return Math.min(a0, a1)
  }

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (trail.length >= 2) {
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < trail.length; i++) {
        const p0 = trail[i - 1]!
        const p1 = trail[i]!
        const sa = segAlpha(p0.t, p1.t)
        if (sa < 0.02) continue
        const rootWide = 1 - sa
        const [tr, tg, tb] = TIP_TRAIL
        if (pass === 0) {
          ctx.strokeStyle = `rgba(${tr}, ${tg}, ${tb}, ${sa * 0.15})`
          ctx.lineWidth = 7 + sa * 6 + rootWide * 11
        } else {
          ctx.strokeStyle = `rgba(${tr}, ${tg}, ${tb}, ${sa * 0.7})`
          ctx.lineWidth = 1 + sa * 1.65 + rootWide * 2.4
        }
        ctx.beginPath()
        ctx.moveTo(p0.x, p0.y)
        ctx.lineTo(p1.x, p1.y)
        ctx.stroke()
      }
    }
  }

  const head = trail[trail.length - 1]!
  const headAge = Math.max(0, 1 - (nowMs - head.t) / maxAge)
  const [tr, tg, tb] = TIP_TRAIL
  if (headAge > 0.06) {
    const g = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, 14)
    g.addColorStop(0, `rgba(${tr}, ${tg}, ${tb}, ${headAge * 0.35})`)
    g.addColorStop(0.45, `rgba(${tr}, ${tg}, ${tb}, ${headAge * 0.08})`)
    g.addColorStop(1, `rgba(${tr}, ${tg}, ${tb}, 0)`)
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(head.x, head.y, 14, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.restore()
}

function drawHandThin(
  ctx: CanvasRenderingContext2D,
  landmarks: LM[],
  w: number,
  h: number,
): void {
  ctx.strokeStyle = `rgba(${PAL.ink[0]}, ${PAL.ink[1]}, ${PAL.ink[2]}, 0.9)`
  ctx.lineWidth = 1.0
  for (const p of landmarks) {
    const x = p.x * w
    const y = p.y * h
    ctx.beginPath()
    ctx.ellipse(x, y, 3.5, 3.5, 0, 0, Math.PI * 2)
    ctx.stroke()
  }
}

/** 与 legacy-p5 sketch.js 中 drawPinchConstruct 一致 */
function _drawPinchConstruct(
  ctx: CanvasRenderingContext2D,
  thumb: LM,
  indexFinger: LM,
  w: number,
  h: number,
): void {
  const tx = thumb.x * w
  const ty = thumb.y * h
  const ix = indexFinger.x * w
  const iy = indexFinger.y * h
  const cx = (tx + ix) / 2
  const cy = (ty + iy) / 2
  const radius = Math.hypot(tx - ix, ty - iy)

  ctx.strokeStyle = `rgb(${PAL.ink[0]}, ${PAL.ink[1]}, ${PAL.ink[2]})`
  ctx.lineWidth = 0.65
  ctx.beginPath()
  ctx.moveTo(tx, ty)
  ctx.lineTo(ix, iy)
  ctx.stroke()

  ctx.setLineDash([5, 6])
  ctx.beginPath()
  ctx.ellipse(cx, cy, radius, radius, 0, 0, Math.PI * 2)
  ctx.stroke()
  ctx.setLineDash([])

  ctx.strokeStyle = `rgba(${PAL.ink[0]}, ${PAL.ink[1]}, ${PAL.ink[2]}, 0.7)`
  ctx.lineWidth = 0.5
  drawCircleWithX(ctx, cx, cy, 5)

  ctx.fillStyle = `rgb(${PAL.ink[0]}, ${PAL.ink[1]}, ${PAL.ink[2]})`
  ctx.beginPath()
  ctx.ellipse(cx, cy, 2.2, 2.2, 0, 0, Math.PI * 2)
  ctx.fill()
}

function drawCircleWithX(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.ellipse(x, y, r, r, 0, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x - r * 0.65, y - r * 0.65)
  ctx.lineTo(x + r * 0.65, y + r * 0.65)
  ctx.moveTo(x - r * 0.65, y + r * 0.65)
  ctx.lineTo(x + r * 0.65, y - r * 0.65)
  ctx.stroke()
}

/** 与 sketch.js drawDataHUD 布局一致 */
function drawTraceHUD(
  ctx: CanvasRenderingContext2D,
  pinchCx: number,
  pinchCy: number,
  radiusPx: number,
  playbackRate: number,
  volume: number,
  w: number,
  h: number,
): void {
  ctx.strokeStyle = `rgba(${PAL.deco[0]}, ${PAL.deco[1]}, ${PAL.deco[2]}, 0.4)`
  ctx.lineWidth = 0.5
  ctx.beginPath()
  ctx.moveTo(w / 2, h / 2)
  ctx.lineTo(pinchCx, pinchCy)
  ctx.stroke()

  ctx.font = '10px "IBM Plex Mono", monospace'
  ctx.fillStyle = `rgb(${PAL.deco[0]}, ${PAL.deco[1]}, ${PAL.deco[2]})`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(
    `POS X: ${nf(pinchCx, 1, 0)}  Y: ${nf(pinchCy, 1, 0)}`,
    pinchCx + 12,
    pinchCy - 6,
  )
  ctx.fillText(`[ PINCH_R: ${nf(radiusPx, 1, 1)} ]`, pinchCx + 12, pinchCy + 8)
  ctx.fillText(
    `PITCH // VOL  ${nf(playbackRate, 1, 2)}  ·  ${nf(volume, 1, 2)}`,
    14,
    h - 38,
  )

  ctx.strokeStyle = `rgba(${PAL.deco[0]}, ${PAL.deco[1]}, ${PAL.deco[2]}, 0.45)`
  ctx.lineWidth = 0.55
  ctx.strokeRect(10, 52, 280, 74)

  ctx.fillStyle = `rgb(${PAL.deco[0]}, ${PAL.deco[1]}, ${PAL.deco[2]})`
  ctx.fillText('// TRACE · GESTURE_SAMPLE_CONTROLLER', 18, 70)
  ctx.fillText(`RADIUS        ${nf(radiusPx, 1, 1)} px`, 18, 88)
  ctx.fillText(
    `PITCH_FACTOR ${nf(playbackRate, 1, 2)}  (½ ST per hit)`,
    18,
    104,
  )
  ctx.fillText(`AMPLITUDE     ${nf(volume, 1, 2)}`, 18, 120)
}

function drawGestureCue(
  ctx: CanvasRenderingContext2D,
  w: number,
  hit: { labelZh: string; labelEn: string },
  ageMs: number,
): void {
  const fade = Math.max(0, 1 - ageMs / 4200)
  if (fade <= 0) return
  ctx.save()
  ctx.font = '13px "IBM Plex Mono", monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const y = 96
  ctx.fillStyle = `rgba(${PAL.deco[0]}, ${PAL.deco[1]}, ${PAL.deco[2]}, ${0.3 + 0.55 * fade})`
  ctx.fillText(`// GESTURE · ${hit.labelZh}  /  ${hit.labelEn}`, w / 2, y)
  ctx.lineWidth = 0.6
  ctx.strokeStyle = `rgba(${PAL.deco[0]}, ${PAL.deco[1]}, ${PAL.deco[2]}, ${0.3 + 0.45 * fade})`
  ctx.strokeRect(w / 2 - 158, y - 6, 316, 26)
  ctx.restore()
}

function drawSignalNull(ctx: CanvasRenderingContext2D, h: number): void {
  ctx.font = '10px "IBM Plex Mono", monospace'
  ctx.fillStyle = `rgba(${PAL.deco[0]}, ${PAL.deco[1]}, ${PAL.deco[2]}, 0.5)`
  ctx.fillText('// SIGNAL: NULL · NO_HAND', 14, h - 18)
}

/**
 * 节拍同步的动作提示 — 在画布底部中央脉冲显示 PUNCH / CHOP。
 * tau: 0→1 当前拍内进度（0=拍点，1=下一拍点）
 * beatCount: 累计经过的拍数（用于交替 PUNCH / CHOP）
 * 每 2 拍提示一次，让用户有更充裕的反应时间。
 */
function drawBeatActionHint(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  tau: number,
  beatCount: number,
): void {
  // 每 2 拍出一次提示，交替 PUNCH / CHOP
  const slowBeat = Math.floor(beatCount / 2)
  const isPunch = slowBeat % 2 === 0
  const label = isPunch ? 'PUNCH !' : 'CHOP !'
  const zhLabel = isPunch ? '出拳' : '快划'

  // tau 在 [0, 0.6) 期间显示（前 60% 的拍内时间）
  // 只在偶数拍显示（即每2拍一次）
  const isEvenBeat = beatCount % 2 === 0
  if (!isEvenBeat) return
  if (tau > 0.65) return

  // 脉冲效果：拍点处最大，然后衰减
  const pulse = Math.max(0, 1 - tau / 0.65)
  const scale = 1 + pulse * 0.15
  const alpha = 0.2 + pulse * 0.55

  const cx = w / 2
  const cy = h - 80

  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(scale, scale)

  // 主文字
  ctx.font = 'bold 28px "IBM Plex Mono", "Arial Black", monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = `rgba(${PAL.deco[0]}, ${PAL.deco[1]}, ${PAL.deco[2]}, ${alpha})`
  ctx.fillText(label, 0, 0)

  // 中文副标
  ctx.font = '11px "IBM Plex Mono", monospace'
  ctx.fillStyle = `rgba(${PAL.deco[0]}, ${PAL.deco[1]}, ${PAL.deco[2]}, ${alpha * 0.65})`
  ctx.fillText(zhLabel, 0, 22)

  // 节拍条 — 拍点处亮，逐渐收窄
  const barW = 120 * pulse
  ctx.fillStyle = `rgba(${PAL.deco[0]}, ${PAL.deco[1]}, ${PAL.deco[2]}, ${alpha * 0.4})`
  ctx.fillRect(-barW / 2, 34, barW, 2)

  ctx.restore()
}

export type TextPhysicsJob = { id: number; text: string }

type GestureStageProps = {
  textPhysicsJob?: TextPhysicsJob | null
  onTextPhysicsComplete?: () => void
  /** TECHNO_SCAN 结束、进入 Matter 瞬间 — 用于启动 60s 音乐击打回合 */
  onEmotionScanComplete?: () => void
  /** 主循环音频首次成功启动时（自动尝试、摄像头就绪或用户点预览区恢复等） */
  onAudioPlaybackStarted?: () => void
  musicPunchGameActive?: boolean
  musicPunchHandleRef?: RefObject<ParticlePunchHandle | null>
  onMusicPunchSuccessfulHit?: () => void
  /** Boss 第五击击破时由 ParticlePunch 调用（不计入普通 onMusicPunchSuccessfulHit） */
  onBossDefeated?: () => void
  musicPunchHud?: { timeLeft: number; score: number; combo: number } | null
  /** 击打成功计数，用于分数与节拍数字弹跳 */
  musicPunchHitTick?: number
  /** 外部共享的摄像头流 — 避免重复 getUserMedia */
  cameraStream?: MediaStream | null
}

export function GestureStage({
  textPhysicsJob = null,
  onTextPhysicsComplete,
  onEmotionScanComplete,
  onAudioPlaybackStarted,
  musicPunchGameActive = false,
  musicPunchHandleRef,
  onMusicPunchSuccessfulHit,
  onBossDefeated,
  musicPunchHud = null,
  musicPunchHitTick = 0,
  cameraStream = null,
}: GestureStageProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const punchViewportFxTimerRef = useRef<ReturnType<
    typeof window.setTimeout
  > | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const matterCanvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const audioRef = useRef<SampleLoopController | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const landmarkerRef = useRef<HandLandmarker | null>(null)
  const beatGestureHintRef = useRef<BeatGestureHintHandle | null>(null)
  const canvasHostRef = useRef<HTMLDivElement>(null)
  /** 主画布逻辑像素（与 gesture-canvas-host 的 CSS 尺寸一致），避免固定 640×480 被拉宽变糊 */
  const canvasLayoutRef = useRef({ w: W, h: H })
  const _fingertipGlowTrailsRef = useRef<TipGlowPoint[][][]>([
    emptyHandTipGlowTrails(),
    emptyHandTipGlowTrails(),
  ])
  const rafRef = useRef<number>(0)
  const frameRef = useRef(0)
  const gestureDetectorRef = useRef(new GestureEventDetector())
  const lastGestureCueRef = useRef<{
    labelZh: string
    labelEn: string
    t: number
  } | null>(null)
  const sequencePhaseRef = useRef<'idle' | 'scan' | 'matter'>('idle')
  const matterProbeRef = useRef<HandProbePoint>(null)
  const punchComboMirrorRef = useRef(0)
  /** 节拍计数器（用于 beat action hint） */
  const beatHintCountRef = useRef(0)
  const beatHintPrevPosRef = useRef<number | null>(null)

  const [audioStarted, setAudioStarted] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [sampleError, setSampleError] = useState<string | null>(null)
  const [uploadErr, setUploadErr] = useState<string | null>(null)
  const [uploadBusy, setUploadBusy] = useState(false)
  const [clipLabel, setClipLabel] = useState(
    '内置 · sample.wav',
  )
  const [gestureBanner, setGestureBanner] = useState<GestureHit | null>(null)
  const [sequencePhase, setSequencePhase] = useState<
    'idle' | 'scan' | 'matter'
  >('idle')
  sequencePhaseRef.current = sequencePhase
  const audioStartedRef = useRef(false)
  useEffect(() => {
    audioStartedRef.current = audioStarted
  }, [audioStarted])

  const prevAudioStartedRef = useRef(false)
  useEffect(() => {
    if (audioStarted && !prevAudioStartedRef.current) {
      onAudioPlaybackStarted?.()
    }
    prevAudioStartedRef.current = audioStarted
  }, [audioStarted, onAudioPlaybackStarted])

  const musicPunchGameActiveRef = useRef(musicPunchGameActive)
  musicPunchGameActiveRef.current = musicPunchGameActive
  punchComboMirrorRef.current = musicPunchHud?.combo ?? 0
  /** 用户点击 STOP 后为 true：停止自动重试，直至点击预览区或上传新音频 */
  const userStoppedBgRef = useRef(false)

  useEffect(() => {
    if (!musicPunchHitTick) return
    const host = canvasHostRef.current
    if (host) {
      host.classList.remove('is-particle-hit-rumble')
      requestAnimationFrame(() => {
        host.classList.add('is-particle-hit-rumble')
      })
    }
    const tRumble = window.setTimeout(() => {
      host?.classList.remove('is-particle-hit-rumble')
    }, 400)
    return () => {
      window.clearTimeout(tRumble)
    }
  }, [musicPunchHitTick])

  useEffect(() => {
    audioRef.current = new SampleLoopController()
    return () => {
      audioRef.current?.dispose()
      audioRef.current = null
    }
  }, [])

  const tryStartAudio = useCallback(async () => {
    if (audioStartedRef.current || userStoppedBgRef.current) return
    const ctrl = audioRef.current
    if (!ctrl) return
    try {
      await resumeAudioContext()
      await ctrl.start()
      audioStartedRef.current = true
      setAudioStarted(true)
      setSampleError(null)
    } catch (e) {
      audioStartedRef.current = false
      setSampleError(
        e instanceof Error
          ? e.message
          : '背景乐启动失败，将自动重试；若已点 // STOP_AUDIO 请再点预览区恢复。',
      )
    }
  }, [])

  useEffect(() => {
    void tryStartAudio()
  }, [tryStartAudio])

  useEffect(() => {
    const id = window.setInterval(() => {
      if (userStoppedBgRef.current || audioStartedRef.current) return
      void tryStartAudio()
    }, 2200)
    return () => window.clearInterval(id)
  }, [tryStartAudio])

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== 'visible') return
      if (userStoppedBgRef.current || audioStartedRef.current) return
      void tryStartAudio()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [tryStartAudio])

  /** 任意一次点击/按键作为用户手势，再试解锁 Web Audio（与自动重试配合） */
  useEffect(() => {
    const onWake = () => {
      if (userStoppedBgRef.current || audioStartedRef.current) return
      void tryStartAudio()
    }
    window.addEventListener('pointerdown', onWake, { capture: true })
    window.addEventListener('keydown', onWake, { capture: true })
    return () => {
      window.removeEventListener('pointerdown', onWake, { capture: true })
      window.removeEventListener('keydown', onWake, { capture: true })
    }
  }, [tryStartAudio])

  /* ── HandLandmarker 初始化 ── */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const lm = await createRobustHandLandmarker()
        if (!cancelled) landmarkerRef.current = lm
        else lm.close()
      } catch (e) {
        if (!cancelled)
          setModelError(
            e instanceof Error ? e.message : String(e),
          )
      }
    })()
    return () => {
      cancelled = true
      landmarkerRef.current?.close()
      landmarkerRef.current = null
    }
  }, [])

  /* ── 隐藏摄像头 — 使用外部共享的 stream，仅用于手部检测 ── */
  useEffect(() => {
    const video = videoRef.current
    if (!video || !cameraStream) return
    let cancelled = false
    video.srcObject = cameraStream
    video.play().then(() => {
      if (!cancelled) {
        void resumeAudioContext()
        if (!userStoppedBgRef.current) void tryStartAudio()
      }
    }).catch(() => {
      /* 摄像头不可用时静默失败 — 仅影响手部检测 */
    })
    return () => {
      cancelled = true
      video.pause()
      video.srcObject = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraStream])

  useEffect(() => {
    const host = canvasHostRef.current
    if (!host) return

    const applyLayout = (width: number, height: number) => {
      const w = Math.max(2, Math.round(width))
      const h = Math.max(2, Math.round(height))
      canvasLayoutRef.current = { w, h }
      const mc = matterCanvasRef.current
      if (mc && sequencePhaseRef.current !== 'matter') {
        if (mc.width !== w || mc.height !== h) {
          mc.width = w
          mc.height = h
        }
      }
    }

    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (!cr || cr.width < 1 || cr.height < 1) return
      applyLayout(cr.width, cr.height)
    })
    ro.observe(host)
    applyLayout(host.clientWidth, host.clientHeight)

    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const host = canvasHostRef.current
    if (!host) return

    const applyLayout = (width: number, height: number) => {
      const w = Math.max(2, Math.round(width))
      const h = Math.max(2, Math.round(height))
      canvasLayoutRef.current = { w, h }
      const mc = matterCanvasRef.current
      if (mc && sequencePhaseRef.current !== 'matter') {
        if (mc.width !== w || mc.height !== h) {
          mc.width = w
          mc.height = h
        }
      }
    }

    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect
      if (!cr || cr.width < 1 || cr.height < 1) return
      applyLayout(cr.width, cr.height)
    })
    ro.observe(host)
    applyLayout(host.clientWidth, host.clientHeight)

    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!textPhysicsJob) return
    const { text } = textPhysicsJob
    setSequencePhase('scan')

    let matterTeardown: (() => void) | undefined
    let matterTimeoutId: ReturnType<typeof window.setTimeout> | undefined

    const scanTimerId = window.setTimeout(() => {
      setSequencePhase('matter')
      onEmotionScanComplete?.()
      const matterEl = matterCanvasRef.current
      const { w: ww, h: hh } = canvasLayoutRef.current
      if (matterEl && ww > 0 && hh > 0) {
        matterEl.width = ww
        matterEl.height = hh
        matterTeardown = startTextMatterWorld(
          matterEl,
          text,
          () => matterProbeRef.current,
        )
      }
      matterTimeoutId = window.setTimeout(() => {
        matterTeardown?.()
        matterTeardown = undefined
        const mc = matterCanvasRef.current
        if (mc) {
          mc.getContext('2d')?.clearRect(0, 0, mc.width, mc.height)
        }
        setSequencePhase('idle')
        onTextPhysicsComplete?.()
      }, TEXT_MATTER_MS)
    }, TEXT_SCAN_MS)

    return () => {
      window.clearTimeout(scanTimerId)
      if (matterTimeoutId !== undefined) window.clearTimeout(matterTimeoutId)
      matterTeardown?.()
      const mc = matterCanvasRef.current
      if (mc) {
        mc.getContext('2d')?.clearRect(0, 0, mc.width, mc.height)
      }
      setSequencePhase('idle')
    }
  }, [textPhysicsJob?.id, onTextPhysicsComplete, onEmotionScanComplete])

  const wantDashscopeAsr =
    musicPunchGameActive || sequencePhase !== 'idle'

  useEffect(() => {
    if (!wantDashscopeAsr || !musicPunchHandleRef) return

    let stop: (() => void) | undefined
    let cancelled = false

    void (async () => {
      try {
        stop = await startDashscopeRealtimeAsr({
          wsUrl: getDashscopeAsrWsUrl(),
          onResult: ({ text }) => {
            const t = text.trim()
            if (t) musicPunchHandleRef.current?.appendUserTextParticles(t)
          },
          onError: () => {
            /* 服务端未配 DASHSCOPE_API_KEY 等 — 静默 */
          },
        })
        if (cancelled) stop()
      } catch {
        /* 麦克风权限 / 连接失败 */
      }
    })()

    return () => {
      cancelled = true
      stop?.()
    }
  }, [wantDashscopeAsr, musicPunchHandleRef])

  const paint = useCallback(
    (result: HandLandmarkerResult | null, audioOn: boolean) => {
      const c = canvasRef.current
      if (!c) return
      const ctx = c.getContext('2d')
      if (!ctx) return
      const { w, h } = canvasLayoutRef.current
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const bw = Math.max(1, Math.round(w * dpr))
      const bh = Math.max(1, Math.round(h * dpr))
      if (c.width !== bw || c.height !== bh) {
        c.width = bw
        c.height = bh
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      /* 白色画板底 */
      ctx.fillStyle = `rgb(${PAL.bg[0]}, ${PAL.bg[1]}, ${PAL.bg[2]})`
      ctx.fillRect(0, 0, w, h)

      const fr = frameRef.current++
      drawGlitchField(ctx, fr, w, h)
      drawIdleGeometry(ctx, fr, w, h)
      drawSystemHeader(ctx)
      if (!audioOn) drawStartPrompt(ctx, w, h)

      if (!result) drawCameraWaiting(ctx, w, h)

      const hands = mirrorLandmarksFromCamera(result?.landmarks)

      if (sequencePhaseRef.current === 'matter' && hands.length > 0) {
        const primary = pickPrimaryHand(hands)
        if (primary) {
          const tip = primary[INDEX]
          matterProbeRef.current = { x: tip.x * w, y: tip.y * h }
        } else {
          matterProbeRef.current = null
        }
      } else {
        matterProbeRef.current = null
      }

      if (hands.length > 0) {
        for (const lm of hands) {
          drawHandConnections(ctx, lm, w, h)
          drawHandThin(ctx, lm, w, h)
        }

        const primary = pickPrimaryHand(hands)
        const thumb = primary?.[THUMB_TIP]
        const indexFinger = primary?.[INDEX_TIP]

        const wantGesture =
          !!primary &&
          (Boolean(audioRef.current && audioOn) ||
            musicPunchGameActiveRef.current)

        if (wantGesture && primary) {
          let punchGameSphereHit: boolean = false
          let hit: GestureHit | null = null
          try {
            hit = gestureDetectorRef.current.push(primary, performance.now())
          } catch {
            gestureDetectorRef.current.reset()
          }

          if (hit?.signal === 'punch') {
            schedulePunchViewportPulse(
              wrapRef.current,
              punchViewportFxTimerRef,
              punchComboMirrorRef.current,
            )
          }

          if (
            hit &&
            musicPunchGameActiveRef.current &&
            musicPunchHandleRef?.current &&
            (hit.signal === 'punch' || hit.signal === 'chop')
          ) {
            const tip = primary[INDEX]
            const pr = musicPunchHandleRef.current.tryPunch({
              x: tip.x * 2 - 1,
              y: -(tip.y * 2 - 1),
            })
            punchGameSphereHit = pr.hit
          }

          if (hit && audioRef.current && audioOn) {
            const t = performance.now()
            lastGestureCueRef.current = {
              labelZh: hit.labelZh,
              labelEn: hit.labelEn,
              t,
            }
            setGestureBanner(hit)
            if (hit.signal !== 'grab') {
              audioRef.current.triggerGestureFx(hit.signal)
            }
            if (
              (hit.signal === 'punch' || hit.signal === 'chop') &&
              audioRef.current.isLoopPlaying()
            ) {
              const ac = audioRef.current
              const inGame = musicPunchGameActiveRef.current
              const bump = inGame
                ? punchGameSphereHit
                : isWithinBeatWindow(
                    ac.getLoopPlaybackPositionSec(),
                    ac.getBufferDurationSec(),
                    ac.getLoopBeatTimesSec(),
                    BEAT_PITCH_BUMP_WINDOW_SEC,
                  )
              if (bump) ac.bumpBeatPitch(0.5)
            }
          }
        } else {
          gestureDetectorRef.current.reset()
        }

        if (thumb && indexFinger) {
          const pinchCx = ((thumb.x + indexFinger.x) / 2) * w
          const pinchCy = ((thumb.y + indexFinger.y) / 2) * h
          const radiusPx = Math.hypot(
            (thumb.x - indexFinger.x) * w,
            (thumb.y - indexFinger.y) * h,
          )
          const ctrl = audioRef.current
          const playbackRate =
            audioOn && ctrl ? ctrl.getUiPlaybackRate() : 1
          const volume =
            audioOn && ctrl?.isLoopPlaying() ? PLAYBACK_GAIN : 0
          drawTraceHUD(
            ctx,
            pinchCx,
            pinchCy,
            radiusPx,
            playbackRate,
            volume,
            w,
            h,
          )
        }
      } else {
        gestureDetectorRef.current.reset()
        drawSignalNull(ctx, h)
      }

      /* 指尖拖尾绘制已关闭 */

      const cue = lastGestureCueRef.current
      if (cue) {
        drawGestureCue(ctx, w, cue, performance.now() - cue.t)
      }

      const ac = audioRef.current
      const punchGameOn = musicPunchGameActiveRef.current
      if (ac) {
        if (audioOn) {
          ac.updateHandSpatialFx(
            hands.length > 0 ? pickPrimaryHand(hands) : null,
          )
          ac.applyGesture()
        } else {
          ac.updateHandSpatialFx(null)
        }
      }
      if (ac && audioOn && ac.isLoopPlaying()) {
        ac.advanceLoopPlaybackClock()
        const pos = ac.getLoopPlaybackPositionSec()
        let dur = ac.getBufferDurationSec()
        if (dur <= 0.05) dur = BEAT_GUIDE_FALLBACK_DURATION_SEC
        beatGestureHintRef.current?.sync(
          pos,
          dur,
          true,
          ac.getPlaybackSyncGeneration(),
        )
        // ── beat action hint（canvas 上直接绘制 PUNCH/CHOP 提示）──
        const beats = beatTimesForBufferDuration(BEATS_META, dur)
        const tau = beatLocalTau(pos, dur, beats)
        if (beatHintPrevPosRef.current !== null) {
          beatHintCountRef.current += countBeatCrossings(
            beatHintPrevPosRef.current,
            pos,
            dur,
            beats,
          )
        }
        beatHintPrevPosRef.current = pos
        drawBeatActionHint(ctx, w, h, tau, beatHintCountRef.current)
      } else if (punchGameOn) {
        const dur = BEAT_GUIDE_FALLBACK_DURATION_SEC
        const t =
          (performance.now() / 1000) % dur
        beatGestureHintRef.current?.sync(
          t,
          dur,
          true,
          BEAT_HINT_SYNC_WALLCLOCK,
        )
        // ── punch game 模式也用 wall clock 驱动 beat hint ──
        const beats = beatTimesForBufferDuration(BEATS_META, dur)
        const tau = beatLocalTau(t, dur, beats)
        if (beatHintPrevPosRef.current !== null) {
          beatHintCountRef.current += countBeatCrossings(
            beatHintPrevPosRef.current,
            t,
            dur,
            beats,
          )
        }
        beatHintPrevPosRef.current = t
        drawBeatActionHint(ctx, w, h, tau, beatHintCountRef.current)
      } else {
        beatGestureHintRef.current?.sync(0, 0, false, 0)
        beatHintCountRef.current = 0
        beatHintPrevPosRef.current = null
      }
    },
    [],
  )

  /* 渲染循环 — 从隐藏 video 中检测手部，结果传入 paint */
  useEffect(() => {
    const loop = () => {
      const v = videoRef.current
      const marker = landmarkerRef.current
      let result: HandLandmarkerResult | null = null
      if (
        marker &&
        v &&
        v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        v.videoWidth > 0
      ) {
        result = marker.detectForVideo(v, performance.now())
      }
      paint(result, audioStarted)
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [audioStarted, paint])

  const handleFileChange = (list: FileList | null) => {
    const file = list?.[0]
    if (!file) return
    setUploadErr(null)
    setUploadBusy(true)
    void (async () => {
      try {
        const ctrl = audioRef.current
        if (!ctrl) return
        userStoppedBgRef.current = false
        await ctrl.loadFromFile(file)
        setClipLabel(`本地 · ${file.name}`)
        void tryStartAudio()
      } catch (e) {
        setUploadErr(e instanceof Error ? e.message : String(e))
      } finally {
        setUploadBusy(false)
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
    })()
  }

  const onStopPlayback = () => {
    userStoppedBgRef.current = true
    audioRef.current?.stop()
    audioStartedRef.current = false
    setAudioStarted(false)
  }

  const onPreviewPointerDown = () => {
    if (audioStartedRef.current) return
    userStoppedBgRef.current = false
    void tryStartAudio()
  }

  return (
    <div ref={wrapRef} className="gesture-wrap">
      {(modelError || sampleError || uploadErr) && (
        <div className="gesture-errors">
          {modelError && <p>// ERR · VISION: {modelError}</p>}
          {sampleError && <p>// ERR · AUDIO: {sampleError}</p>}
          {uploadErr && <p>// ERR · UPLOAD: {uploadErr}</p>}
        </div>
      )}
      <div className="gesture-toolbar">
        <input
          ref={fileInputRef}
          type="file"
          className="gesture-file-input"
          accept="audio/*,.wav,.mp3,.mpeg,.ogg,.webm,audio/wav"
          aria-label="选择本地音频文件"
          onChange={(e) => handleFileChange(e.target.files)}
        />
        <button
          type="button"
          className="gesture-upload-btn"
          disabled={uploadBusy}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploadBusy ? '// LOADING…' : '// UPLOAD_LOCAL_AUDIO'}
        </button>
        <button
          type="button"
          className="gesture-stop-btn"
          disabled={!audioStarted}
          onClick={onStopPlayback}
          aria-label="停止背景音乐循环"
        >
          // STOP_AUDIO
        </button>
        <span className="gesture-clip-label">{clipLabel}</span>
        <span className="gesture-signal-broadcast" aria-live="polite">
          {gestureBanner
            ? `// LAST_GESTURE · ${gestureBanner.labelZh} · ${gestureBanner.labelEn}`
            : '// LAST_GESTURE · —'}
        </span>
      </div>
      <div
        ref={canvasHostRef}
        className={`gesture-canvas-host${!audioStarted ? ' is-bg-paused' : ''}`}
        aria-label="互动画板"
        onPointerDown={onPreviewPointerDown}
        role="presentation"
      >
        <canvas ref={canvasRef} className="gesture-canvas" />
        <canvas
          ref={matterCanvasRef}
          className={`gesture-matter-canvas${sequencePhase === 'matter' ? ' is-live' : ''}${SHOW_TEXT_SEQUENCE_VISUALS ? '' : ' is-visual-suppressed'}`}
          aria-hidden
        />
        {musicPunchHandleRef ? (
          <ParticlePunchOverlay
            ref={musicPunchHandleRef}
            visible={musicPunchGameActive}
            onSuccessfulHit={onMusicPunchSuccessfulHit}
            onBossDefeated={onBossDefeated}
          />
        ) : null}
        {SHOW_TEXT_SEQUENCE_VISUALS &&
          sequencePhase === 'scan' &&
          textPhysicsJob ? (
          <TechnoScanOverlay hint={textPhysicsJob.text} />
        ) : null}
      </div>
      {/* 隐藏 video — 仅用于 MediaPipe 手部检测，不在画布上显示 */}
      <video
        ref={videoRef}
        className="gesture-video"
        muted
        playsInline
        autoPlay
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: 'none',
          top: 0,
          left: 0,
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
        }}
      />
    </div>
  )
}

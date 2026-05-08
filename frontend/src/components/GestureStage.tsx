import {
  FilesetResolver,
  HandLandmarker,
  type HandLandmarkerResult,
} from '@mediapipe/tasks-vision'
import { useCallback, useEffect, useRef, useState } from 'react'
import { SampleLoopController } from '../lib/samplePlayer'

const W = 640
const H = 480
const THUMB = 4
const INDEX = 8

const WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
const HAND_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

const PAL = {
  bg: [230, 229, 227] as const,
  ink: [28, 28, 30] as const,
  inkFaint: [160, 158, 154] as const,
  ghost: [195, 193, 189] as const,
}

function mapRange(v: number, a: number, b: number, c: number, d: number) {
  return c + ((v - a) / (b - a)) * (d - c)
}

function constrain(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

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

function drawGlitchField(
  ctx: CanvasRenderingContext2D,
  frame: number,
): void {
  const glyphs = '01/\\[]{}⟨⟩::xx⊹⌁∴Δ'
  ctx.textBaseline = 'alphabetic'
  ctx.font = '9px "IBM Plex Mono", monospace'
  const t = frame * 0.012
  for (let i = 0; i < 95; i++) {
    const nx = pseudoNoise(i * 0.17 + t, i * 0.03, 0)
    const ny = pseudoNoise(i * 0.19 + 40, i * 0.07 + t, 1)
    const dx = (nx - 0.5) * 1.15
    const dy = (ny - 0.5) * 0.95
    const x = W / 2 + dx * Math.min(W, H) * 0.62
    const y = H / 2 + dy * Math.min(W, H) * 0.52
    ctx.fillStyle = `rgba(${PAL.ghost[0]}, ${PAL.ghost[1]}, ${PAL.ghost[2]}, ${0.078 + (i % 7) * 0.007})`
    ctx.fillText(glyphs.charAt(i % glyphs.length), x, y)
  }
}

function drawSystemHeader(ctx: CanvasRenderingContext2D): void {
  ctx.font = '11px "IBM Plex Mono", monospace'
  ctx.fillStyle = `rgb(${PAL.inkFaint[0]}, ${PAL.inkFaint[1]}, ${PAL.inkFaint[2]})`
  let y = 22
  ctx.fillText('// SYSTEM: MATRIX_VOID · REACT_VITE', 14, y)
  ctx.fillText('// RIPPLE: SAMPLE_RATE_BINDING · TONE_PLAYER', 14, y + 14)
  ctx.fillText('// VISUAL: GLITCH_BLACK · THIN_STROKE', 14, y + 28)
}

function drawIdleGeometry(ctx: CanvasRenderingContext2D, frame: number): void {
  const cx = W / 2
  const cy = H / 2
  const r = 88 + Math.sin(frame * 0.02) * 4
  ctx.strokeStyle = `rgba(${PAL.ink[0]}, ${PAL.ink[1]}, ${PAL.ink[2]}, 0.35)`
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

function drawStartPrompt(ctx: CanvasRenderingContext2D): void {
  const cx = W / 2
  const cy = H / 2
  ctx.strokeStyle = `rgba(${PAL.ink[0]}, ${PAL.ink[1]}, ${PAL.ink[2]}, 0.9)`
  ctx.lineWidth = 0.75
  ctx.strokeRect(cx - 148, cy - 26, 296, 52)
  ctx.fillStyle = `rgb(${PAL.ink[0]}, ${PAL.ink[1]}, ${PAL.ink[2]})`
  ctx.font = '12px "IBM Plex Mono", monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('[ CLICK_CANVAS :: INIT_AUDIO_STREAM ]', cx, cy)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

function drawHandThin(
  ctx: CanvasRenderingContext2D,
  landmarks: LM[],
  w: number,
  h: number,
): void {
  ctx.strokeStyle = `rgba(${PAL.ink[0]}, ${PAL.ink[1]}, ${PAL.ink[2]}, 0.55)`
  ctx.lineWidth = 0.55
  for (const p of landmarks) {
    const x = p.x * w
    const y = p.y * h
    ctx.beginPath()
    ctx.ellipse(x, y, 3.5, 3.5, 0, 0, Math.PI * 2)
    ctx.stroke()
  }
}

function drawCircleWithX(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
) {
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

function drawPinchConstruct(
  ctx: CanvasRenderingContext2D,
  thumb: LM,
  indexFinger: LM,
  radius: number,
  w: number,
  h: number,
): void {
  const tx = thumb.x * w
  const ty = thumb.y * h
  const ix = indexFinger.x * w
  const iy = indexFinger.y * h
  const cx = (tx + ix) / 2
  const cy = (ty + iy) / 2

  ctx.strokeStyle = `rgb(${PAL.ink[0]}, ${PAL.ink[1]}, ${PAL.ink[2]})`
  ctx.lineWidth = 0.65
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.moveTo(tx, ty)
  ctx.lineTo(ix, iy)
  ctx.stroke()

  ctx.setLineDash([5, 6])
  ctx.beginPath()
  ctx.ellipse(cx, cy, radius / 2, radius / 2, 0, 0, Math.PI * 2)
  ctx.stroke()
  ctx.setLineDash([])

  ctx.strokeStyle = `rgba(${PAL.ink[0]}, ${PAL.ink[1]}, ${PAL.ink[2]}, 0.7)`
  ctx.lineWidth = 0.5
  drawCircleWithX(ctx, cx, cy, 5)

  ctx.fillStyle = `rgb(${PAL.ink[0]}, ${PAL.ink[1]}, ${PAL.ink[2]})`
  ctx.beginPath()
  ctx.ellipse(cx, cy, 1.1, 1.1, 0, 0, Math.PI * 2)
  ctx.fill()
}

function drawDataHUD(
  ctx: CanvasRenderingContext2D,
  thumb: LM,
  indexFinger: LM,
  radius: number,
  playbackRate: number,
  volume: number,
  w: number,
  h: number,
) {
  const tx = thumb.x * w
  const ty = thumb.y * h
  const ix = indexFinger.x * w
  const iy = indexFinger.y * h
  const cx = (tx + ix) / 2
  const cy = (ty + iy) / 2

  ctx.strokeStyle = `rgba(${PAL.ink[0]}, ${PAL.ink[1]}, ${PAL.ink[2]}, 0.4)`
  ctx.lineWidth = 0.5
  ctx.beginPath()
  ctx.moveTo(W / 2, H / 2)
  ctx.lineTo(cx, cy)
  ctx.stroke()

  ctx.font = '10px "IBM Plex Mono", monospace'
  ctx.fillStyle = `rgb(${PAL.ink[0]}, ${PAL.ink[1]}, ${PAL.ink[2]})`
  ctx.fillText(`POS X: ${nf(cx, 1, 0)}  Y: ${nf(cy, 1, 0)}`, cx + 12, cy - 6)
  ctx.fillText(`[ PINCH_R: ${nf(radius, 1, 1)} ]`, cx + 12, cy + 8)
  ctx.fillText(
    `RATE // VOL  ${nf(playbackRate, 1, 2)}  ·  ${nf(volume, 1, 2)}`,
    14,
    H - 38,
  )

  ctx.strokeStyle = `rgba(${PAL.ink[0]}, ${PAL.ink[1]}, ${PAL.ink[2]}, 0.55)`
  ctx.lineWidth = 0.55
  ctx.strokeRect(10, 52, 280, 74)

  ctx.fillText('// TRACE · GESTURE_SAMPLE_CONTROLLER', 18, 70)
  ctx.fillText(`RADIUS        ${nf(radius, 1, 1)} px`, 18, 88)
  ctx.fillText(`RATE_PITCH    ${nf(playbackRate, 1, 2)}  (playbackRate)`, 18, 104)
  ctx.fillText(`AMPLITUDE     ${nf(volume, 1, 2)}`, 18, 120)
}

function drawSignalNull(ctx: CanvasRenderingContext2D): void {
  ctx.font = '10px "IBM Plex Mono", monospace'
  ctx.fillStyle = `rgb(${PAL.inkFaint[0]}, ${PAL.inkFaint[1]}, ${PAL.inkFaint[2]})`
  ctx.fillText('// SIGNAL: NULL · NO_HAND', 14, H - 18)
}

export function GestureStage() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const landmarkerRef = useRef<HandLandmarker | null>(null)
  const audioRef = useRef<SampleLoopController | null>(null)
  const rafRef = useRef<number>(0)
  const frameRef = useRef(0)

  const [audioStarted, setAudioStarted] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [sampleError, setSampleError] = useState<string | null>(null)

  useEffect(() => {
    audioRef.current = new SampleLoopController()
    return () => {
      audioRef.current?.dispose()
      audioRef.current = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const fileset = await FilesetResolver.forVisionTasks(WASM_BASE)
        const lm = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: HAND_MODEL,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 2,
        })
        if (!cancelled) landmarkerRef.current = lm
        else lm.close()
      } catch (e) {
        if (!cancelled) {
          setModelError(e instanceof Error ? e.message : String(e))
        }
      }
    })()
    return () => {
      cancelled = true
      landmarkerRef.current?.close()
      landmarkerRef.current = null
    }
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let stream: MediaStream | null = null
    let cancelled = false

    const isBenignPlayInterrupt = (e: unknown) => {
      if (e instanceof DOMException && e.name === 'AbortError') return true
      const msg =
        e instanceof Error ? e.message : typeof e === 'string' ? e : ''
      return /interrupted|AbortError|new load request/i.test(msg)
    }

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: W, height: H, facingMode: 'user' },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        video.srcObject = stream
        await video.play()
      } catch (e) {
        if (cancelled || isBenignPlayInterrupt(e)) return
        setModelError(e instanceof Error ? e.message : String(e))
      }
    })()

    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
      video.pause()
      video.srcObject = null
      video.removeAttribute('src')
    }
  }, [])

  const paint = useCallback(
    (result: HandLandmarkerResult | null, audioOn: boolean) => {
      const c = canvasRef.current
      const video = videoRef.current
      if (!c || !video) return
      const ctx = c.getContext('2d')
      if (!ctx) return
      const w = video.videoWidth || W
      const h = video.videoHeight || H
      c.width = w
      c.height = h

      ctx.fillStyle = `rgb(${PAL.bg[0]}, ${PAL.bg[1]}, ${PAL.bg[2]})`
      ctx.fillRect(0, 0, w, h)

      ctx.filter = 'sepia(0.08) saturate(0.85) brightness(1.02)'
      ctx.drawImage(video, 0, 0, w, h)
      ctx.filter = 'none'

      ctx.fillStyle = 'rgba(234, 233, 231, 0.55)'
      ctx.fillRect(0, 0, w, h)

      const fr = frameRef.current++
      drawGlitchField(ctx, fr)
      drawSystemHeader(ctx)
      drawIdleGeometry(ctx, fr)
      if (!audioOn) drawStartPrompt(ctx)

      const hands = result?.landmarks ?? []

      if (hands.length > 0 && audioRef.current && audioOn) {
        for (const lm of hands) {
          drawHandThin(ctx, lm, w, h)
          const thumb = lm[THUMB]
          const indexFinger = lm[INDEX]
          const radius = Math.hypot(
            thumb.x * w - indexFinger.x * w,
            thumb.y * h - indexFinger.y * h,
          )
          drawPinchConstruct(ctx, thumb, indexFinger, radius, w, h)

          const minR = 20
          const maxR = 220
          let playbackRate = mapRange(radius, minR, maxR, 0.5, 2.0)
          playbackRate = constrain(playbackRate, 0.5, 2.0)
          const activationThreshold = 25
          const volume = radius > activationThreshold ? 0.6 : 0

          audioRef.current.applyGesture(playbackRate, volume)
          drawDataHUD(
            ctx,
            thumb,
            indexFinger,
            radius,
            playbackRate,
            volume,
            w,
            h,
          )
        }
      } else {
        if (audioRef.current && audioOn) {
          audioRef.current.applyGesture(undefined, 0)
        }
        drawSignalNull(ctx)
      }
    },
    [],
  )

  useEffect(() => {
    const video = videoRef.current
    const lm = landmarkerRef.current
    if (!video || !lm) return

    const loop = () => {
      const v = videoRef.current
      const marker = landmarkerRef.current
      if (!v || !marker || v.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        rafRef.current = requestAnimationFrame(loop)
        return
      }
      const ts = performance.now()
      const result = marker.detectForVideo(v, ts)
      paint(result, audioStarted)
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [audioStarted, paint])

  const onPointerDown = async () => {
    if (audioStarted) return
    try {
      const ctrl = audioRef.current
      if (!ctrl) return
      await ctrl.start()
      setAudioStarted(true)
      setSampleError(null)
    } catch (e) {
      setSampleError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div ref={wrapRef} className="gesture-wrap">
      {(modelError || sampleError) && (
        <div className="gesture-errors">
          {modelError && <p>// ERR · VISION: {modelError}</p>}
          {sampleError && <p>// ERR · AUDIO: {sampleError}</p>}
        </div>
      )}
      <div
        className="gesture-canvas-host"
        onPointerDown={() => void onPointerDown()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            void onPointerDown()
          }
        }}
      >
        <video ref={videoRef} className="gesture-video" muted playsInline />
        <canvas ref={canvasRef} className="gesture-canvas" />
      </div>
    </div>
  )
}

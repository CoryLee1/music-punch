import {
  FilesetResolver,
  HandLandmarker,
  type HandLandmarkerResult,
} from '@mediapipe/tasks-vision'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GestureControls } from '../types/api'

const WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
const HAND_MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

const WRIST = 0
const THUMB_TIP = 4
const INDEX_TIP = 8

type Props = {
  active: boolean
  idle: GestureControls
  onControls: (c: GestureControls) => void
}

export function HandControl({ active, idle, onControls }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const landmarkerRef = useRef<HandLandmarker | null>(null)
  const rafRef = useRef<number>(0)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const defaultIdle = useRef(idle)

  const applySketchMapping = useCallback(
    (result: HandLandmarkerResult, w: number, height: number) => {
      let volume = 0
      let playbackRate = 1
      let pan = 0
      let filterFreq = 1000

      const hands = result.landmarks ?? []
      if (hands.length === 0) {
        onControls(defaultIdle.current)
        return
      }

      for (const lm of hands) {
        const thumb = lm[THUMB_TIP]
        const index = lm[INDEX_TIP]
        const wrist = lm[WRIST]
        const pinchPx = Math.hypot(
          thumb.x * w - index.x * w,
          thumb.y * height - index.y * height,
        )
        const isLeftSide = wrist.x * w < w / 2
        if (isLeftSide) {
          volume = (pinchPx - 20) / (220 - 20)
          volume = Math.min(1, Math.max(0, volume))
          filterFreq = ((height - wrist.y * height) / height) * (8000 - 200) + 200
          filterFreq = Math.min(8000, Math.max(200, filterFreq))
        } else {
          playbackRate = ((height - wrist.y * height) / height) * (2 - 0.5) + 0.5
          playbackRate = Math.min(2, Math.max(0.5, playbackRate))
          pan = wrist.x * 2 - 1
          pan = Math.min(1, Math.max(-1, pan))
        }
      }
      onControls({ volume, playbackRate, pan, filterFreq })
    },
    [onControls],
  )

  useEffect(() => {
    defaultIdle.current = idle
  }, [idle])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const fileset = await FilesetResolver.forVisionTasks(WASM_BASE)
        const handLandmarker = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: HAND_MODEL,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 2,
        })
        if (cancelled) {
          handLandmarker.close()
          return
        }
        landmarkerRef.current = handLandmarker
        setReady(true)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
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
    if (!video || !ready) return

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: 'user' },
          audio: false,
        })
        if (!active) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        video.srcObject = stream
        await video.play()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()

    return () => {
      const stream = video.srcObject as MediaStream | null
      stream?.getTracks().forEach((t) => t.stop())
      video.srcObject = null
    }
  }, [active, ready])

  useEffect(() => {
    const video = videoRef.current
    const meta = landmarkerRef.current
    const canvas = canvasRef.current
    if (!active || !video || !meta || !canvas) return

    const draw = (result: HandLandmarkerResult) => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const w = video.videoWidth
      const h = video.videoHeight
      canvas.width = w
      canvas.height = h
      ctx.save()
      ctx.clearRect(0, 0, w, h)
      ctx.drawImage(video, 0, 0, w, h)
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'
      ctx.fillStyle = 'lime'
      for (const lm of result.landmarks ?? []) {
        for (const p of lm) {
          ctx.beginPath()
          ctx.arc(p.x * w, p.y * h, 5, 0, Math.PI * 2)
          ctx.fill()
        }
        const thumb = lm[THUMB_TIP]
        const index = lm[INDEX_TIP]
        ctx.beginPath()
        ctx.ellipse(
          ((thumb.x + index.x) / 2) * w,
          ((thumb.y + index.y) / 2) * h,
          (Math.hypot(
            thumb.x * w - index.x * w,
            thumb.y * h - index.y * h,
          ) /
            2) *
            0.9,
          (Math.hypot(
            thumb.x * w - index.x * w,
            thumb.y * h - index.y * h,
          ) /
            2) *
            0.9,
          0,
          0,
          Math.PI * 2,
        )
        ctx.stroke()
      }
      ctx.restore()
    }

    const tick = () => {
      if (!active || !meta) return
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        const ts = performance.now()
        const result = meta.detectForVideo(video, ts)
        draw(result)
        if ((result.landmarks?.length ?? 0) === 0) {
          onControls(defaultIdle.current)
        } else {
          applySketchMapping(result, video.videoWidth, video.videoHeight)
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [active, applySketchMapping, onControls, ready])

  return (
    <div className="hand-panel">
      <div className="hand-video-wrap">
        <video ref={videoRef} className="hand-video" muted playsInline />
        <canvas ref={canvasRef} className="hand-canvas" />
      </div>
      <p className="hand-hint">
        {error
          ? `摄像头 / MediaPipe：${error}`
          : !ready
            ? '正在加载手部模型…'
            : '左手：捏合距离 → 音量，手腕高度 → 低通滤波；右手：高度 → 速度（BPM 倍率），左右位置 → 声像。'}
      </p>
    </div>
  )
}

import type { HandLandmarker, HandLandmarkerResult } from '@mediapipe/tasks-vision'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from 'react'
import { createRobustHandLandmarker, releaseRobustHandLandmarker } from '../lib/mediapipeHandLandmarker'
import {
  GestureEventDetector,
  pickPrimaryHand,
  type GestureHit,
} from '../lib/handGestures'
import {
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

  /* ── HandLandmarker 初始化（全局单例，组件卸载时仅递减引用） ── */
  useEffect(() => {
    let cancelled = false
    console.log('[GestureStage] 开始初始化 HandLandmarker...')
    void (async () => {
      try {
        const lm = await createRobustHandLandmarker()
        if (!cancelled) {
          landmarkerRef.current = lm
          setModelError(null)
          console.log('[GestureStage] ✅ HandLandmarker 就绪')
        } else {
          console.log('[GestureStage] HandLandmarker 加载完成但组件已卸载')
        }
      } catch (e) {
        console.error('[GestureStage] ❌ HandLandmarker 加载失败:', e)
        if (!cancelled)
          setModelError(
            e instanceof Error ? e.message : String(e),
          )
      }
    })()
    return () => {
      cancelled = true
      landmarkerRef.current = null
      releaseRobustHandLandmarker()
    }
  }, [])

  /* ── 隐藏摄像头 — 使用外部共享的 stream，仅用于手部检测 ── */
  useEffect(() => {
    const video = videoRef.current
    if (!video || !cameraStream) {
      console.log('[GestureStage] 摄像头 effect: video=', !!video, 'stream=', !!cameraStream)
      return
    }
    let cancelled = false
    console.log('[GestureStage] 正在将 cameraStream 绑定到隐藏 video...')
    video.srcObject = cameraStream
    video.play().then(() => {
      if (!cancelled) {
        console.log('[GestureStage] ✅ 隐藏 video 播放成功, videoWidth=', video.videoWidth, 'readyState=', video.readyState)
        void resumeAudioContext()
        if (!userStoppedBgRef.current) void tryStartAudio()
      }
    }).catch((err) => {
      console.error('[GestureStage] ❌ 隐藏 video 播放失败:', err)
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

      frameRef.current++

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

      } else {
        gestureDetectorRef.current.reset()
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
    let diagLogged = false
    let detectCount = 0
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
        try {
          result = marker.detectForVideo(v, performance.now())
          detectCount++
          if (detectCount === 1) {
            console.log('[GestureStage] ✅ 首次成功检测手部, hands=', result?.landmarks?.length ?? 0)
          }
        } catch (e) {
          if (!diagLogged) {
            console.error('[GestureStage] ❌ detectForVideo 抛出异常:', e)
            diagLogged = true
          }
        }
      } else if (!diagLogged && frameRef.current > 60) {
        // 超过 60 帧（~1 秒）仍无法检测，打印诊断
        console.warn('[GestureStage] ⚠ 无法进入检测循环:', {
          hasMarker: !!marker,
          hasVideo: !!v,
          readyState: v?.readyState ?? -1,
          videoWidth: v?.videoWidth ?? 0,
          srcObject: !!v?.srcObject,
        })
        diagLogged = true
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

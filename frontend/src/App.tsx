import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GestureStage } from './components/GestureStage'
import { ControlPanel } from './components/ControlPanel'
import { EmotionInput } from './components/EmotionInput'
import { SampleLoopController } from './lib/samplePlayer'
import type { AppPhase } from './components/ControlPanel'
import type { GestureHit } from './lib/handGestures'
import './App.css'

const LOADING_DURATION = 2500 // ms，模拟 loading

/* ───── 深色背景动态字符 ───── */
const BG_GLYPHS = '○◎□⊠×+✦·—/⊕◇⊹∴Δ⟨⟩■▪▫◆◈⬡⬢▲▽⊗⊙≡≈∞∅∂∇⌘⌥⏎⏏⎔⎕⌭◌△▷◁▹◃⊿⋮⋯'

function bgNoise(i: number, j: number, t: number) {
  return (Math.sin(i * 12.9898 + j * 78.233 + t * 2.399) * 43758.5453) % 1
}

function DarkBgCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef(0)
  const frameRef = useRef(0)

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const dpr = window.devicePixelRatio || 1
      const w = window.innerWidth
      const h = window.innerHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.scale(dpr, dpr)

      // 清除
      ctx.clearRect(0, 0, w, h)

      const fr = frameRef.current++
      const t = fr * 0.003

      // 1. 漂浮字符
      ctx.font = '11px "Space Mono", monospace'
      ctx.textBaseline = 'alphabetic'
      for (let i = 0; i < 80; i++) {
        const nx = Math.abs(bgNoise(i * 0.13 + t, i * 0.07, 0))
        const ny = Math.abs(bgNoise(i * 0.11 + 50, i * 0.09 + t, 1))
        const alpha = 0.03 + (i % 7) * 0.005
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`
        ctx.fillText(BG_GLYPHS.charAt(i % BG_GLYPHS.length), nx * w, ny * h)
      }

      // 2. 微弱网格
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.015)'
      ctx.lineWidth = 0.5
      const gridSize = 80
      for (let x = gridSize; x < w; x += gridSize) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
      }
      for (let y = gridSize; y < h; y += gridSize) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke()
      }

      // 3. 缓慢移动的扫描线
      const scanY = (fr * 0.3) % (h + 60) - 30
      const scanGrad = ctx.createLinearGradient(0, scanY - 30, 0, scanY + 30)
      scanGrad.addColorStop(0, 'rgba(255, 255, 255, 0)')
      scanGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.012)')
      scanGrad.addColorStop(1, 'rgba(255, 255, 255, 0)')
      ctx.fillStyle = scanGrad
      ctx.fillRect(0, scanY - 30, w, 60)

      // 4. 角落标记
      ctx.font = '8px "Space Mono", monospace'
      ctx.fillStyle = 'rgba(255, 255, 255, 0.04)'
      ctx.textBaseline = 'top'
      ctx.fillText('MUSICPUNCH_SYS v1.0', 16, 16)
      ctx.fillText(`FR:${fr}`, 16, 28)

      ctx.textAlign = 'right'
      ctx.fillText('GESTURAL_INTERFACE', w - 16, 16)
      ctx.textAlign = 'left'

      ctx.textBaseline = 'bottom'
      ctx.fillText('// MULTIMODAL AUDIO-VISUAL ENGINE', 16, h - 16)

      ctx.textAlign = 'right'
      const blinkOn = Math.floor(fr / 40) % 2 === 0
      if (blinkOn) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.05)'
        ctx.fillText('● ACTIVE', w - 16, h - 16)
      }
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [])

  return createPortal(
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        zIndex: 0,
        pointerEvents: 'none',
      }}
    />,
    document.body,
  )
}

export default function App() {
  /* ───── 全局状态 ───── */
  const [apiState, setApiState] = useState<'idle' | 'ok' | 'err'>('idle')
  const [phase, setPhase] = useState<AppPhase>('idle')
  const [emotion, setEmotion] = useState('')
  const [elapsed, setElapsed] = useState(0) // 已运行秒数（正计时）
  const [isPaused, setIsPaused] = useState(false)
  const [cameraReady, setCameraReady] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [showWhiteFlash, setShowWhiteFlash] = useState(false)
  const [showPunchOver, setShowPunchOver] = useState(false)
  const [punchOverFlicker, setPunchOverFlicker] = useState(false)
  const [punchOverFade, setPunchOverFade] = useState(false)

  /* ───── 音频相关 ───── */
  const [audioStarted, setAudioStarted] = useState(false)
  const [clipLabel, setClipLabel] = useState('内置 · sample.wav')
  const [gestureBanner, setGestureBanner] = useState<GestureHit | null>(null)

  /* ───── refs ───── */
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const audioRef = useRef<SampleLoopController | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  /* ───── API 健康检查 ───── */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await fetch('/api/health')
        const j = (await r.json()) as { ok?: boolean }
        if (!cancelled && r.ok && j.ok) setApiState('ok')
        else if (!cancelled) setApiState('err')
      } catch {
        if (!cancelled) setApiState('err')
      }
    })()
    return () => { cancelled = true }
  }, [])

  /* ───── 初始化音频控制器 ───── */
  useEffect(() => {
    audioRef.current = new SampleLoopController()
    return () => {
      audioRef.current?.dispose()
      audioRef.current = null
    }
  }, [])

  /* ───── 初始化摄像头 ───── */
  useEffect(() => {
    let cancelled = false

    const initCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: 'user' },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          try { await videoRef.current.play() } catch { /* benign */ }
          setCameraReady(true)
        }
      } catch (e) {
        if (!cancelled) {
          setErrors((prev) => [...prev.slice(-4), `摄像头: ${e instanceof Error ? e.message : String(e)}`])
        }
      }
    }

    void initCamera()

    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ───── 正计时逻辑（无时间限制） ───── */
  useEffect(() => {
    if (phase !== 'active' || isPaused) {
      if (timerRef.current) clearInterval(timerRef.current)
      return
    }

    timerRef.current = setInterval(() => {
      setElapsed((prev) => prev + 0.1)
    }, 100)

    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [phase, isPaused])

  /* ───── 结束流程 ───── */
  const triggerEnding = useCallback(() => {
    setPhase('ending')
    audioRef.current?.stop()
    setAudioStarted(false)

    setShowWhiteFlash(true)
    setTimeout(() => setShowWhiteFlash(false), 600)

    setTimeout(() => {
      setShowPunchOver(true)
      setTimeout(() => setPunchOverFlicker(true), 400)
      setTimeout(() => {
        setPunchOverFade(true)
        setTimeout(() => {
          setShowPunchOver(false)
          setPunchOverFlicker(false)
          setPunchOverFade(false)
          setPhase('over')
        }, 1500)
      }, 3000)
    }, 800)
  }, [])

  /* ───── 错误管理 ───── */
  const addError = useCallback((msg: string) => {
    setErrors((prev) => [...prev.slice(-4), msg])
  }, [])

  /* ───── 手动停止（触发 PUNCH OVER 结束动画） ───── */
  const handleStop = useCallback(() => {
    if (phase === 'active') triggerEnding()
  }, [phase, triggerEnding])

  /* ───── 情绪提交 → loading → active ───── */
  const handleEmotionSubmit = useCallback(
    async (text: string) => {
      setEmotion(text)
      setPhase('loading')

      try {
        await audioRef.current?.start()
        setAudioStarted(true)
      } catch (e) {
        addError(`音频: ${e instanceof Error ? e.message : String(e)}`)
      }

      setTimeout(() => {
        setPhase('active')
        setElapsed(0)
        setIsPaused(false)
      }, LOADING_DURATION)
    },
    [addError],
  )

  /* ───── 手势命中回调 ───── */
  const handleGestureHit = useCallback((hit: GestureHit) => {
    setGestureBanner(hit)
  }, [])

  /* ───── 音频上传 ───── */
  const handleAudioUpload = useCallback(async (file: File) => {
    try {
      const ctrl = audioRef.current
      if (!ctrl) return
      await ctrl.loadFromFile(file)
      setClipLabel(`本地 · ${file.name}`)
    } catch (e) {
      addError(`上传: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [addError])

  /* ───── 暂停/继续 ───── */
  const handleTogglePause = useCallback(() => {
    setIsPaused((p) => !p)
  }, [])

  /* ───── 重置 ───── */
  const handleReset = useCallback(() => {
    setPhase('idle')
    setEmotion('')
    setElapsed(0)
    setIsPaused(false)
    setErrors([])
    audioRef.current?.stop()
    setAudioStarted(false)
    setGestureBanner(null)
    setClipLabel('内置 · sample.wav')
  }, [])

  const inputDisabled = phase !== 'idle'

  return (
    <div className="app">
      {/* 深色背景动态字符 */}
      <DarkBgCanvas />

      {/* 错误提示 */}
      {errors.length > 0 && (
        <div className="app-errors">
          {errors.map((e, i) => (
            <p key={i}>// ERR · {e}</p>
          ))}
        </div>
      )}

      {/* 主内容区 */}
      <div className="app-main">
        {/* 左侧 2/3 互动区 */}
        <GestureStage
          phase={phase}
          emotion={emotion}
          elapsed={elapsed}
          videoRef={videoRef}
          audioRef={audioRef}
          audioStarted={audioStarted}
          onError={addError}
          onGestureHit={handleGestureHit}
          showWhiteFlash={showWhiteFlash}
          showPunchOver={showPunchOver}
          punchOverFlicker={punchOverFlicker}
          punchOverFade={punchOverFade}
        />

        {/* 右侧 1/3 控制面板 */}
        <ControlPanel
          phase={phase}
          emotion={emotion}
          elapsed={elapsed}
          isPaused={isPaused}
          onTogglePause={handleTogglePause}
          onStop={handleStop}
          onReset={handleReset}
          videoRef={videoRef}
          cameraReady={cameraReady}
          apiState={apiState}
          gestureBanner={gestureBanner}
          clipLabel={clipLabel}
          audioStarted={audioStarted}
        />
      </div>

      {/* 底部输入栏 */}
      <EmotionInput
        disabled={inputDisabled}
        phase={phase}
        onSubmit={handleEmotionSubmit}
        onReset={handleReset}
      />
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GestureStage } from './components/GestureStage'
import { ControlPanel } from './components/ControlPanel'
import { EmotionInput } from './components/EmotionInput'
import type { AppPhase } from './components/ControlPanel'
import type { GestureHit } from './lib/handGestures'
import type { ParticlePunchHandle } from './components/ParticlePunchOverlay'
import './App.css'

const PUNCH_GAME_SEC = 60
const PUNCH_COMBO_BREAK_MS = 1600

type TextPhysicsJob = { id: number; text: string }

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
  /* ───── 原有 UI 状态 ───── */
  const [apiState, setApiState] = useState<'idle' | 'ok' | 'err'>('idle')
  const [phase, setPhase] = useState<AppPhase>('idle')
  const [emotion, setEmotion] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [isPaused, setIsPaused] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [audioStarted, setAudioStarted] = useState(false)
  const [clipLabel, setClipLabel] = useState('内置 · sample.wav')
  const [gestureBanner, setGestureBanner] = useState<GestureHit | null>(null)

  /* ───── 摄像头（右侧面板预览用） ───── */
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [cameraReady, setCameraReady] = useState(false)

  /* ───── Punch 游戏状态 ───── */
  const punchHandleRef = useRef<ParticlePunchHandle>(null)
  const comboBreakTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const [punchPhase, setPunchPhase] = useState<'idle' | 'running' | 'ended'>('idle')
  const [punchScore, setPunchScore] = useState(0)
  const [punchHitTick, setPunchHitTick] = useState(0)
  const [punchCombo, setPunchCombo] = useState(0)
  const [punchComboMax, setPunchComboMax] = useState(0)
  const [punchTimeLeft, setPunchTimeLeft] = useState(PUNCH_GAME_SEC)
  const [textPhysicsJob, setTextPhysicsJob] = useState<TextPhysicsJob | null>(null)

  /* ───── refs ───── */
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

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

  /* ───── 右侧面板摄像头初始化 ───── */
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let cancelled = false
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: { ideal: 'user' } },
          audio: false,
        })
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        video.srcObject = stream
        await video.play()
        if (!cancelled) setCameraReady(true)
      } catch {
        /* 摄像头不可用时静默失败 */
      }
    })()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      video.pause()
      video.srcObject = null
      setCameraReady(false)
    }
  }, [])

  /* ───── 正计时 ───── */
  useEffect(() => {
    if (phase !== 'active' || isPaused) {
      if (timerRef.current) clearInterval(timerRef.current)
      return
    }
    timerRef.current = setInterval(() => setElapsed((prev) => prev + 0.1), 100)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [phase, isPaused])

  /* ───── Punch 游戏逻辑 ───── */
  const startPunchRound = useCallback(() => {
    const tid = comboBreakTimerRef.current
    if (tid != null) window.clearTimeout(tid)
    comboBreakTimerRef.current = null
    setPunchScore(0)
    setPunchTimeLeft(PUNCH_GAME_SEC)
    setPunchHitTick(0)
    setPunchCombo(0)
    setPunchComboMax(0)
    setPunchPhase('running')
  }, [])

  const onPunchHit = useCallback(() => {
    setPunchScore((s) => s + 1)
    setPunchHitTick((k) => k + 1)
    setPunchCombo((c) => {
      const n = c + 1
      setPunchComboMax((m) => Math.max(m, n))
      return n
    })
    const prev = comboBreakTimerRef.current
    if (prev != null) window.clearTimeout(prev)
    comboBreakTimerRef.current = window.setTimeout(() => {
      comboBreakTimerRef.current = null
      setPunchCombo(0)
    }, PUNCH_COMBO_BREAK_MS)
  }, [])

  // Punch 回合倒计时
  useEffect(() => {
    if (punchPhase !== 'running') return
    const t0 = Date.now()
    const id = window.setInterval(() => {
      const el = Math.floor((Date.now() - t0) / 1000)
      const left = Math.max(0, PUNCH_GAME_SEC - el)
      setPunchTimeLeft(left)
      if (left <= 0) { setPunchPhase('ended'); window.clearInterval(id) }
    }, 260)
    return () => window.clearInterval(id)
  }, [punchPhase])

  useEffect(() => {
    if (punchPhase === 'running') return
    const tid = comboBreakTimerRef.current
    if (tid != null) window.clearTimeout(tid)
    comboBreakTimerRef.current = null
  }, [punchPhase])

  const dismissPunchEnded = useCallback(() => setPunchPhase('idle'), [])

  const onTextPhysicsComplete = useCallback(() => setTextPhysicsJob(null), [])

  const submitPhysicsText = useCallback((raw: string) => {
    const text = raw.trim()
    if (!text) return
    setTextPhysicsJob({ id: Date.now(), text })
    punchHandleRef.current?.appendUserTextParticles(text)
  }, [])

  const onEmotionScanComplete = useCallback(() => {
    if (punchPhase !== 'running') startPunchRound()
  }, [punchPhase, startPunchRound])

  const onAudioPlaybackStarted = useCallback(() => {
    setAudioStarted(true)
    if (phase === 'idle') {
      setPhase('active')
      setElapsed(0)
      setIsPaused(false)
    }
    if (punchPhase !== 'running') startPunchRound()
  }, [phase, punchPhase, startPunchRound])

  /* ───── 错误管理 ───── */
  const addError = useCallback((msg: string) => {
    setErrors((prev) => [...prev.slice(-4), msg])
  }, [])

  /* ───── 手动停止 ───── */
  const handleStop = useCallback(() => {
    if (phase === 'active') {
      setPhase('over')
      setAudioStarted(false)
    }
  }, [phase])

  /* ───── 情绪提交 → 发送文字到物理引擎 ───── */
  const handleEmotionSubmit = useCallback(
    (text: string) => {
      setEmotion(text)
      submitPhysicsText(text)
      if (phase === 'idle') {
        setPhase('active')
        setElapsed(0)
        setIsPaused(false)
      }
    },
    [phase, submitPhysicsText],
  )

  /* ───── 手势命中回调 ───── */
  const handleGestureHit = useCallback((hit: GestureHit) => {
    setGestureBanner(hit)
  }, [])

  /* ───── 暂停/继续 ───── */
  const handleTogglePause = useCallback(() => setIsPaused((p) => !p), [])

  /* ───── 重置 ───── */
  const handleReset = useCallback(() => {
    setPhase('idle')
    setEmotion('')
    setElapsed(0)
    setIsPaused(false)
    setErrors([])
    setAudioStarted(false)
    setGestureBanner(null)
    setClipLabel('内置 · sample.wav')
    setPunchPhase('idle')
    setPunchScore(0)
    setPunchCombo(0)
    setPunchComboMax(0)
  }, [])

  const inputDisabled = phase !== 'idle' && phase !== 'over'

  return (
    <div className="app">
      <DarkBgCanvas />

      {errors.length > 0 && (
        <div className="app-errors">
          {errors.map((e, i) => (
            <p key={i}>// ERR · {e}</p>
          ))}
        </div>
      )}

      {/* Punch 回合结束弹窗 */}
      {punchPhase === 'ended' && (
        <div className="punch-game-end-modal" role="dialog">
          <div className="punch-game-end-card">
            <h2 className="punch-end-heading">PUNCH ROUND · 结束</h2>
            <p className="punch-final-score">得分 · {punchScore}</p>
            <p className="punch-final-combo">最大连击 · ×{punchComboMax}</p>
            <button type="button" className="punch-end-dismiss" onClick={dismissPunchEnded}>
              // CLOSE
            </button>
          </div>
        </div>
      )}

      {/* 主内容区 */}
      <div className="app-main">
        {/* 左侧 2/3 互动区 — 新版 GestureStage */}
        <GestureStage
          textPhysicsJob={textPhysicsJob}
          onTextPhysicsComplete={onTextPhysicsComplete}
          onEmotionScanComplete={onEmotionScanComplete}
          onAudioPlaybackStarted={onAudioPlaybackStarted}
          musicPunchGameActive={punchPhase === 'running'}
          musicPunchHandleRef={punchHandleRef}
          onMusicPunchSuccessfulHit={onPunchHit}
          musicPunchHud={
            punchPhase === 'running'
              ? { timeLeft: punchTimeLeft, score: punchScore, combo: punchCombo }
              : null
          }
          musicPunchHitTick={punchHitTick}
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
          apiState={apiState}
          gestureBanner={gestureBanner}
          clipLabel={clipLabel}
          audioStarted={audioStarted}
          videoRef={videoRef}
          cameraReady={cameraReady}
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

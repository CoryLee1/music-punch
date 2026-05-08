import { useCallback, useEffect, useRef, useState } from 'react'
import { GestureStage } from './components/GestureStage'
import { ControlPanel } from './components/ControlPanel'
import { EmotionInput } from './components/EmotionInput'
import { SampleLoopController } from './lib/samplePlayer'
import type { AppPhase } from './components/ControlPanel'
import type { GestureHit } from './lib/handGestures'
import './App.css'

const LOADING_DURATION = 2500 // ms，模拟 loading

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

  /* ───── 停止音频 ───── */
  const handleStopAudio = useCallback(() => {
    audioRef.current?.stop()
    setAudioStarted(false)
  }, [])

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
          onAudioUpload={handleAudioUpload}
          onStopAudio={handleStopAudio}
        />
      </div>

      {/* 底部输入栏 */}
      <EmotionInput
        disabled={inputDisabled}
        onSubmit={handleEmotionSubmit}
      />
    </div>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

import { GestureStage } from './components/GestureStage'
import { ControlPanel } from './components/ControlPanel'
import { EmotionInput } from './components/EmotionInput'
import { PunchOverCanvasOverlay } from './components/PunchOverCanvasOverlay'
import { SmashEasterEgg } from './components/SmashEasterEgg'
import type { AppPhase } from './components/ControlPanel'
import type { GestureHit } from './lib/handGestures'
import type { ParticlePunchHandle } from './components/ParticlePunchOverlay'
import './App.css'

const PUNCH_GAME_SEC = 60
const PUNCH_COMBO_BREAK_MS = 1600

type TextPhysicsJob = { id: number; text: string }

/* ───── Confetti burst on boss defeat ───── */
function PunchConfettiBurst({
  active,
  burstKey,
}: {
  active: boolean
  burstKey: number
}) {
  const pieces = useMemo(
    () =>
      Array.from({ length: 56 }, (_, i) => {
        const seed = (i * 2654435761 + burstKey * 2246822519) >>> 0
        const r1 = (seed % 1000) / 1000
        const r2 = ((seed >>> 8) % 1000) / 1000
        const r3 = ((seed >>> 16) % 1000) / 1000
        const isRibbon = i % 3 !== 0
        const bg = isRibbon
          ? 'rgba(0, 189, 214, 0.88)'
          : 'rgba(42, 40, 52, 0.82)'
        const dx = `${(r2 - 0.5) * 280}px`
        const rot = `${(r3 - 0.5) * 920}deg`
        return {
          id: `${burstKey}-${i}`,
          left: `${r1 * 100}%`,
          delay: `${(i % 18) * 0.026}s`,
          duration: `${2.05 + r3 * 1.5}s`,
          width: 2 + (i % 5),
          height: 11 + (i % 9) * 5,
          bg,
          dx,
          rot,
        }
      }),
    [burstKey],
  )

  if (!active) return null

  return (
    <div className="punch-confetti-layer" aria-hidden>
      {pieces.map((p) => (
        <span
          key={p.id}
          className="punch-confetti-piece"
          style={
            {
              left: p.left,
              background: p.bg,
              width: p.width,
              height: p.height,
              animationDelay: p.delay,
              animationDuration: p.duration,
              ['--punch-confetti-dx' as string]: p.dx,
              ['--punch-confetti-rot' as string]: p.rot,
            } as CSSProperties
          }
        />
      ))}
    </div>
  )
}

/* ───── 装饰排版头部 ───── */
function TypoHeader() {
  return (
    <header className="typo-header" aria-hidden>
      <div className="typo-header-row typo-header-row-1">
        <span>MUSIC PUNCH</span>
        <span>GESTURAL INTERFACE</span>
        <span>INTERACTIVE</span>
        <span>700 × 1000 MM</span>
        <span>INTRODUCTION TYPOGRAPHY</span>
        <span>MULTIMODAL ENGINE</span>
        <span>IT/FY/04</span>
      </div>
      <div className="typo-header-row typo-header-row-2">
        <span>CHARMING LIGATURE</span>
        <span>AUDIO-VISUAL</span>
      </div>
      <div className="typo-header-row typo-header-row-3">
        IN THE INTRODUCTION COURSE AT THE DEPARTMENT TYPOGRAFIE&amp;SCHRIFTGESTALTUNG, FIRST-YEAR STUDENTS EXPLORE WHAT BALANCE MEANS WHEN TYPE STOPS BEING JUST TEXT. THEY BUILD THEIR OWN GRIDS, CRAFT ZINES THAT FLIRT WITH ORDER AND CHAOS, AND DESIGN FULL CHARACTER SETS PLUS TINY LIGATURES.
      </div>
    </header>
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

  /* ───── 画布展开状态 ───── */
  const [expanded, setExpanded] = useState(false)

  /* ───── 摄像头（统一获取，共享给面板预览 + GestureStage 手部检测） ───── */
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null)

  /* ───── Punch 游戏状态 ───── */
  const punchHandleRef = useRef<ParticlePunchHandle>(null)
  const comboBreakTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const [punchPhase, setPunchPhase] = useState<'idle' | 'running' | 'ended'>('idle')
  const [punchScore, setPunchScore] = useState(0)
  const [punchHitTick, setPunchHitTick] = useState(0)
  const [punchCombo, setPunchCombo] = useState(0)
  const [punchComboMax, setPunchComboMax] = useState(0)
  const [punchTimeLeft, setPunchTimeLeft] = useState(PUNCH_GAME_SEC)
  const [punchConfettiActive, setPunchConfettiActive] = useState(false)
  const [punchConfettiKey, setPunchConfettiKey] = useState(0)
  const [textPhysicsJob, setTextPhysicsJob] = useState<TextPhysicsJob | null>(null)

  /* ───── 彩蛋：解压模式 ───── */
  const [easterEggVisible, setEasterEggVisible] = useState(false)

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

  /* ───── 统一摄像头初始化（面板预览 + GestureStage 共享同一 stream） ───── */
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let cancelled = false
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: { ideal: 'user' } },
          audio: false,
        })
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        video.srcObject = stream
        await video.play()
        if (!cancelled) {
          setCameraReady(true)
          setCameraStream(stream)
        }
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
      setCameraStream(null)
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
    punchHandleRef.current?.resetPunchRound()
    setPunchScore(0)
    setPunchTimeLeft(PUNCH_GAME_SEC)
    setPunchHitTick(0)
    setPunchCombo(0)
    setPunchComboMax(0)
    setPunchConfettiActive(false)
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

  const onBossDefeated = useCallback(() => {
    onPunchHit()
    setPunchPhase('ended')
  }, [onPunchHit])

  useEffect(() => {
    if (punchPhase !== 'ended') return
    setPunchConfettiKey((k) => k + 1)
    setPunchConfettiActive(true)
  }, [punchPhase])

  useEffect(() => {
    if (!punchConfettiActive) return
    const t = window.setTimeout(() => setPunchConfettiActive(false), 5200)
    return () => window.clearTimeout(t)
  }, [punchConfettiActive, punchConfettiKey])

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

  const dismissPunchEnded = useCallback(() => {
    setPunchConfettiActive(false)
    setPunchPhase('idle')
  }, [])

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
    /* 音频自动播放成功只记录状态，不启动计时和 Punch 回合；
       等用户输入文字点 PUNCH 后再由 handleEmotionSubmit 触发 */
  }, [])

  /* ───── 手动停止 ───── */
  const handleStop = useCallback(() => {
    if (phase === 'active') {
      setPhase('over')
      setAudioStarted(false)
    }
  }, [phase])

  /* ───── 情绪提交 → 展开画布 + 发送文字到物理引擎 ───── */
  const handleEmotionSubmit = useCallback(
    (text: string) => {
      setEmotion(text)
      submitPhysicsText(text)
      /* 展开画布 */
      if (!expanded) setExpanded(true)
      if (phase === 'idle') {
        setPhase('active')
        setElapsed(0)
        setIsPaused(false)
      }
    },
    [phase, submitPhysicsText, expanded],
  )

  /* ───── 手动切换展开/折叠 ───── */
  const handleToggleExpand = useCallback(() => setExpanded((e) => !e), [])

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
    setPunchConfettiActive(false)
    punchHandleRef.current?.resetPunchRound()
    setExpanded(false)
  }, [])

  const inputDisabled = phase !== 'idle' && phase !== 'over'

  return (
    <div className={`app ${expanded ? 'is-expanded' : 'is-collapsed'}`}>
      {/* 装饰性排版头部 */}
      <TypoHeader />

      {errors.length > 0 && (
        <div className="app-errors">
          {errors.map((e, i) => (
            <p key={i}>// ERR · {e}</p>
          ))}
        </div>
      )}

      {punchPhase === 'ended' ? (
        <PunchOverCanvasOverlay
          visible
          score={punchScore}
          comboMax={punchComboMax}
          onDismiss={dismissPunchEnded}
          autoExplodeDelayMs={120}
        />
      ) : null}

      <PunchConfettiBurst
        active={punchConfettiActive && punchPhase === 'ended'}
        burstKey={punchConfettiKey}
      />

      {/* 主内容区 */}
      <div className="app-main">
        {/* 左侧：互动画布 / 彩蛋模式 + 输入栏（展开态可见） */}
        <div className="app-left">
          {easterEggVisible ? (
            <SmashEasterEgg cameraStream={cameraStream} />
          ) : (
            <GestureStage
              textPhysicsJob={textPhysicsJob}
              onTextPhysicsComplete={onTextPhysicsComplete}
              onEmotionScanComplete={onEmotionScanComplete}
              onAudioPlaybackStarted={onAudioPlaybackStarted}
              musicPunchGameActive={punchPhase === 'running'}
              musicPunchHandleRef={punchHandleRef}
              onMusicPunchSuccessfulHit={onPunchHit}
              onBossDefeated={onBossDefeated}
              musicPunchHud={
                punchPhase === 'running'
                  ? { timeLeft: punchTimeLeft, score: punchScore, combo: punchCombo }
                  : null
              }
              musicPunchHitTick={punchHitTick}
              cameraStream={cameraStream}
            />
          )}
          <EmotionInput
            disabled={inputDisabled}
            phase={phase}
            onSubmit={handleEmotionSubmit}
            onReset={handleReset}
            onToggleExpand={handleToggleExpand}
            isExpanded={expanded}
            onEasterEgg={() => setEasterEggVisible((v) => !v)}
            easterEggActive={easterEggVisible}
          />
        </div>

        {/* 中/右侧：控制面板 + 折叠态输入栏 */}
        <div className="app-center-col">
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
          {/* 折叠态时在面板下方显示输入栏 */}
          {!expanded && (
            <div className="app-collapsed-input">
              <EmotionInput
                disabled={false}
                phase={phase}
                onSubmit={handleEmotionSubmit}
                onReset={handleReset}
                onToggleExpand={handleToggleExpand}
                isExpanded={expanded}
                onEasterEgg={() => setEasterEggVisible((v) => !v)}
                easterEggActive={easterEggVisible}
              />
            </div>
          )}
        </div>
      </div>

    </div>
  )
}

import { useEffect, useRef, useCallback } from 'react'
import * as Tone from 'tone'
import type { GestureHit } from '../lib/handGestures'

/* ───── 类型 ───── */
export type AppPhase = 'idle' | 'loading' | 'active' | 'ending' | 'over'

interface ControlPanelProps {
  phase: AppPhase
  emotion: string
  elapsed: number
  isPaused: boolean
  onTogglePause: () => void
  onStop: () => void
  onReset: () => void
  videoRef: React.RefObject<HTMLVideoElement | null>
  cameraReady: boolean
  apiState: 'idle' | 'ok' | 'err'
  /** 手势/音频相关 */
  gestureBanner?: GestureHit | null
  clipLabel?: string
  audioStarted?: boolean
  onAudioUpload?: (file: File) => void
  onStopAudio?: () => void
}

/* ───── 摄像头 HUD Canvas 叠加 ───── */
function useCameraHUD(cameraReady: boolean) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number>(0)
  const frameRef = useRef(0)

  useEffect(() => {
    if (!cameraReady) return

    const BRAND = [0, 189, 214] as const // 品牌色 #00bdd6
    const BRAND_DIM = [0, 150, 170] as const

    const draw = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      const w = rect.width
      const h = rect.height
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, h)

      const fr = frameRef.current++
      const g = `${BRAND[0]}, ${BRAND[1]}, ${BRAND[2]}`
      const gd = `${BRAND_DIM[0]}, ${BRAND_DIM[1]}, ${BRAND_DIM[2]}`

      // ─── 1. 扫描线叠加 ───
      for (let y = 0; y < h; y += 2) {
        ctx.fillStyle = `rgba(0, 0, 0, 0.08)`
        ctx.fillRect(0, y, w, 1)
      }

      // ─── 2. 移动扫描光带 ───
      const scanY = (fr * 1.2) % (h + 40) - 20
      const scanGrad = ctx.createLinearGradient(0, scanY - 20, 0, scanY + 20)
      scanGrad.addColorStop(0, `rgba(${g}, 0)`)
      scanGrad.addColorStop(0.5, `rgba(${g}, 0.06)`)
      scanGrad.addColorStop(1, `rgba(${g}, 0)`)
      ctx.fillStyle = scanGrad
      ctx.fillRect(0, scanY - 20, w, 40)

      // ─── 3. 四角瞄准框 ───
      const cornerLen = 18
      const cornerOff = 8
      ctx.strokeStyle = `rgba(${g}, 0.6)`
      ctx.lineWidth = 1.5

      // 左上
      ctx.beginPath()
      ctx.moveTo(cornerOff, cornerOff + cornerLen)
      ctx.lineTo(cornerOff, cornerOff)
      ctx.lineTo(cornerOff + cornerLen, cornerOff)
      ctx.stroke()
      // 右上
      ctx.beginPath()
      ctx.moveTo(w - cornerOff - cornerLen, cornerOff)
      ctx.lineTo(w - cornerOff, cornerOff)
      ctx.lineTo(w - cornerOff, cornerOff + cornerLen)
      ctx.stroke()
      // 左下
      ctx.beginPath()
      ctx.moveTo(cornerOff, h - cornerOff - cornerLen)
      ctx.lineTo(cornerOff, h - cornerOff)
      ctx.lineTo(cornerOff + cornerLen, h - cornerOff)
      ctx.stroke()
      // 右下
      ctx.beginPath()
      ctx.moveTo(w - cornerOff - cornerLen, h - cornerOff)
      ctx.lineTo(w - cornerOff, h - cornerOff)
      ctx.lineTo(w - cornerOff, h - cornerOff - cornerLen)
      ctx.stroke()

      // ─── 4. 中心十字准星 ───
      const cx = w / 2
      const cy = h / 2
      const crossR = 14
      const crossGap = 4
      ctx.strokeStyle = `rgba(${g}, 0.3)`
      ctx.lineWidth = 0.8
      // 上
      ctx.beginPath()
      ctx.moveTo(cx, cy - crossR)
      ctx.lineTo(cx, cy - crossGap)
      ctx.stroke()
      // 下
      ctx.beginPath()
      ctx.moveTo(cx, cy + crossGap)
      ctx.lineTo(cx, cy + crossR)
      ctx.stroke()
      // 左
      ctx.beginPath()
      ctx.moveTo(cx - crossR, cy)
      ctx.lineTo(cx - crossGap, cy)
      ctx.stroke()
      // 右
      ctx.beginPath()
      ctx.moveTo(cx + crossGap, cy)
      ctx.lineTo(cx + crossR, cy)
      ctx.stroke()

      // ─── 5. 顶部标签 ───
      ctx.font = '9px "Space Mono", "IBM Plex Mono", monospace'
      ctx.fillStyle = `rgba(${g}, 0.7)`
      ctx.textBaseline = 'top'
      ctx.fillText('■ BIOMETRIC_SYS', cornerOff + 2, cornerOff + 6)

      // 闪烁的 REC 指示灯
      const blinkOn = Math.floor(fr / 30) % 2 === 0
      if (blinkOn) {
        ctx.fillStyle = `rgba(${g}, 0.8)`
        ctx.beginPath()
        ctx.arc(w - cornerOff - 4, cornerOff + 11, 3, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = `rgba(${g}, 0.6)`
        ctx.textAlign = 'right'
        ctx.fillText('REC', w - cornerOff - 12, cornerOff + 6)
        ctx.textAlign = 'left'
      }

      // ─── 6. 底部状态条 ───
      // 底部半透明条
      ctx.fillStyle = `rgba(0, 0, 0, 0.45)`
      ctx.fillRect(0, h - 28, w, 28)
      // 上分隔线
      ctx.strokeStyle = `rgba(${g}, 0.25)`
      ctx.lineWidth = 0.5
      ctx.beginPath()
      ctx.moveTo(0, h - 28)
      ctx.lineTo(w, h - 28)
      ctx.stroke()

      ctx.font = '8px "Space Mono", "IBM Plex Mono", monospace'
      ctx.fillStyle = `rgba(${g}, 0.55)`
      ctx.textBaseline = 'middle'
      ctx.fillText('MULTIMODAL TRACKING ACTIVE', 10, h - 14)

      ctx.textAlign = 'right'
      ctx.fillStyle = `rgba(${gd}, 0.45)`
      ctx.fillText('DELAY', w - 10, h - 14)
      ctx.textAlign = 'left'

      // ─── 7. 细微网格 ───
      ctx.strokeStyle = `rgba(${g}, 0.04)`
      ctx.lineWidth = 0.5
      const gridSize = 24
      for (let x = gridSize; x < w; x += gridSize) {
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h - 28)
        ctx.stroke()
      }
      for (let y = gridSize; y < h - 28; y += gridSize) {
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
      }

      ctx.textBaseline = 'alphabetic'
      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [cameraReady])

  return canvasRef
}

/* ───── 音频波形可视化 ───── */
function useWaveformVisualizer(phase: AppPhase) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const analyserRef = useRef<Tone.Analyser | null>(null)
  const rafRef = useRef<number>(0)

  useEffect(() => {
    if (phase !== 'active') return
    const analyser = new Tone.Analyser('waveform', 128)
    Tone.getDestination().connect(analyser)
    analyserRef.current = analyser

    const draw = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.scale(dpr, dpr)

      const w = rect.width
      const h = rect.height

      ctx.clearRect(0, 0, w, h)

      const values = analyser.getValue() as Float32Array
      const len = values.length

      // 波形 — 绿色
      ctx.strokeStyle = 'rgba(0, 189, 214, 0.45)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let i = 0; i < len; i++) {
        const x = (i / (len - 1)) * w
        const y = (1 - (values[i] + 1) / 2) * h
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()

      // 中线
      ctx.strokeStyle = 'rgba(0, 189, 214, 0.08)'
      ctx.lineWidth = 0.5
      ctx.beginPath()
      ctx.moveTo(0, h / 2)
      ctx.lineTo(w, h / 2)
      ctx.stroke()

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(rafRef.current)
      analyser.dispose()
      analyserRef.current = null
    }
  }, [phase])

  return canvasRef
}

/* ───── 组件 ───── */
export function ControlPanel({
  phase,
  emotion,
  elapsed,
  isPaused,
  onTogglePause,
  onStop,
  onReset,
  videoRef,
  cameraReady,
  apiState,
  gestureBanner,
  clipLabel = '内置 · sample.wav',
  audioStarted = false,
  onAudioUpload,
  onStopAudio,
}: ControlPanelProps) {
  const waveCanvasRef = useWaveformVisualizer(phase)
  const hudCanvasRef = useCameraHUD(cameraReady)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** 格式化已运行时间 mm:ss */
  const formatElapsed = useCallback((s: number) => {
    const total = Math.floor(Math.max(0, s))
    const mm = String(Math.floor(total / 60)).padStart(2, '0')
    const ss = String(total % 60).padStart(2, '0')
    return `${mm}:${ss}`
  }, [])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file && onAudioUpload) {
      void onAudioUpload(file)
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [onAudioUpload])

  return (
    <aside className="app-panel">
      {/* 面板头部 */}
      <div className="panel-header">
        <span className="panel-title">Control</span>
        <span className={`panel-status ${apiState === 'ok' ? 'connected' : ''}`}>
          {apiState === 'ok' ? '● ONLINE' : apiState === 'err' ? '○ OFFLINE' : '…'}
        </span>
      </div>

      {/* 摄像头预览 + HUD 叠加 */}
      <div className="panel-camera">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{ display: cameraReady ? 'block' : 'none' }}
        />
        <canvas ref={hudCanvasRef} className="camera-hud-canvas" />
        {!cameraReady && (
          <div className="panel-camera-overlay">
            <span className="camera-off-label">Awaiting Camera</span>
          </div>
        )}
      </div>

      {/* 手势映射说明 */}
      <div className="panel-gesture-map">
        <div className="gesture-map-row">
          <span className="gesture-map-key">PUNCH</span>
          <span className="gesture-map-eq">=</span>
          <span className="gesture-map-val">DESTROY · 短时加速</span>
        </div>
        <div className="gesture-map-row">
          <span className="gesture-map-key">GRAB</span>
          <span className="gesture-map-eq">=</span>
          <span className="gesture-map-val">CRUSH · 五指收拢</span>
        </div>
        <div className="gesture-map-row">
          <span className="gesture-map-key">CHOP</span>
          <span className="gesture-map-eq">=</span>
          <span className="gesture-map-val">SLASH · 刀手快划</span>
        </div>
        <div className="gesture-map-row">
          <span className="gesture-map-key">PINCH</span>
          <span className="gesture-map-eq">=</span>
          <span className="gesture-map-val">变速 · 拇食指距离</span>
        </div>
        <div className="gesture-map-row">
          <span className="gesture-map-key">PALM</span>
          <span className="gesture-map-eq">=</span>
          <span className="gesture-map-val">音高 · 手掌开合</span>
        </div>
      </div>

      {/* 最近手势事件 */}
      {gestureBanner && (
        <div className="panel-gesture-banner">
          <span className="gesture-banner-label">LAST GESTURE</span>
          <span className="gesture-banner-value">
            {gestureBanner.labelZh} · {gestureBanner.labelEn}
          </span>
        </div>
      )}

      {/* 音频控制 */}
      <div className="panel-audio-controls">
        <span className="audio-label">// AUDIO · {clipLabel}</span>
        <div className="control-row">
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,.wav,.mp3,.ogg,.webm"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          <button
            className="control-btn"
            type="button"
            onClick={() => fileInputRef.current?.click()}
          >
            ↑ Upload
          </button>
          <button
            className="control-btn"
            type="button"
            disabled={!audioStarted}
            onClick={onStopAudio}
          >
            ■ Stop
          </button>
        </div>
      </div>

      {/* 波形可视化 */}
      <div className="panel-visualizer">
        <span className="visualizer-label">Waveform</span>
        <div className="visualizer-canvas">
          <canvas ref={waveCanvasRef} />
        </div>
      </div>

      {/* 运行时间 */}
      <div className="panel-timer">
        <span className="timer-label">Elapsed</span>
        <span className="timer-display">
          {phase === 'active' || phase === 'ending' ? formatElapsed(elapsed) : '--:--'}
        </span>
      </div>

      {/* 控制按钮 */}
      <div className="panel-controls">
        {phase === 'active' && (
          <>
            <div className="control-row">
              <button className="control-btn" onClick={onTogglePause} type="button">
                {isPaused ? '▶ Resume' : '⏸ Pause'}
              </button>
              <button className="control-btn danger" onClick={onStop} type="button">
                ■ Stop
              </button>
            </div>
          </>
        )}
        {(phase === 'over' || phase === 'ending') && (
          <div className="control-row">
            <button className="control-btn primary" onClick={onReset} type="button">
              ↻ Restart
            </button>
          </div>
        )}
      </div>

      {/* 底部信息 */}
      <div className="panel-info">
        {emotion && (
          <div className="info-row">
            <span className="info-key">Emotion</span>
            <span className="info-val">{emotion.length > 20 ? emotion.slice(0, 20) + '…' : emotion}</span>
          </div>
        )}
        <div className="info-row">
          <span className="info-key">Phase</span>
          <span className="info-val">{phase.toUpperCase()}</span>
        </div>
        <div className="info-row">
          <span className="info-key">Gesture</span>
          <span className="info-val">
            {gestureBanner ? `${gestureBanner.labelEn}` : 'IDLE'}
          </span>
        </div>
        <div className="info-row">
          <span className="info-key">Audio</span>
          <span className="info-val">{audioStarted ? 'PLAYING' : 'STOPPED'}</span>
        </div>
      </div>
    </aside>
  )
}

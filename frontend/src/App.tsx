import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { HandControl } from './components/HandControl'
import { MusicEngine } from './lib/musicEngine'
import type { EmotionResponse, GestureControls } from './types/api'

function filterFromBrightness(brightness: number) {
  const b = Math.min(1, Math.max(0, brightness))
  return 220 + b * 5200
}

export default function App() {
  const [text, setText] = useState(
    '加班到很晚，心里有点空，但也还有一点期待明天。',
  )
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [resp, setResp] = useState<EmotionResponse | null>(null)
  const [playing, setPlaying] = useState(false)
  const [camOn, setCamOn] = useState(false)
  const engineRef = useRef<MusicEngine | null>(null)

  const idleControls: GestureControls = useMemo(() => {
    const b = resp?.music.brightness ?? 0.55
    return {
      volume: 0,
      playbackRate: 1,
      pan: 0,
      filterFreq: filterFromBrightness(b),
    }
  }, [resp])

  const onGesture = useCallback((c: GestureControls) => {
    engineRef.current?.applyGesture(c)
  }, [])

  useEffect(() => {
    return () => {
      engineRef.current?.dispose()
      engineRef.current = null
    }
  }, [])

  const submitEmotion = async () => {
    setErr(null)
    setLoading(true)
    try {
      const r = await fetch('/api/emotion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const data = (await r.json()) as EmotionResponse & { error?: string }
      if (!r.ok) {
        throw new Error(data.error ?? '请求失败')
      }
      setResp(data as EmotionResponse)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const startMusic = async () => {
    if (!resp) {
      setErr('请先生成音乐方案')
      return
    }
    setErr(null)
    if (!engineRef.current) {
      engineRef.current = new MusicEngine()
    }
    try {
      await engineRef.current.start(resp.music)
      setPlaying(true)
      setCamOn(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const stopMusic = () => {
    engineRef.current?.stop()
    setPlaying(false)
    setCamOn(false)
  }

  return (
    <div className="app">
      <header className="hero">
        <h1>Music Punch</h1>
        <p className="tagline">
          说出情绪 → AI 解析生成和弦进行 → 用双手（MediaPipe）像{' '}
          <code>sketch.js</code> 一样实时拧音量、滤波、速度与声像。
        </p>
      </header>

      <main className="grid">
        <section className="panel">
          <h2>情绪输入</h2>
          <textarea
            className="textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            placeholder="用自然语言描述你现在的心情…"
          />
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={loading}
              onClick={() => void submitEmotion()}
            >
              {loading ? '解析中…' : '解析情绪并生成音乐参数'}
            </button>
          </div>

          {err ? <p className="error">{err}</p> : null}

          {resp ? (
            <div className="result">
              <div className="meta">
                <span className="pill">{resp.primaryEmotion}</span>
                <span className="pill subtle">来源：{resp.source}</span>
              </div>
              <p className="summary">{resp.summary}</p>
              <ul className="stats">
                <li>
                  BPM <strong>{resp.music.bpm}</strong>
                </li>
                <li>
                  调式 <strong>{resp.music.mode}</strong>（根音 {resp.music.rootNote}）
                </li>
                <li>
                  明暗度 <strong>{resp.music.brightness.toFixed(2)}</strong>
                </li>
                <li>
                  混响湿音 <strong>{resp.music.reverbWet.toFixed(2)}</strong>
                </li>
              </ul>
              <pre className="chords">
                {resp.music.chordProgression
                  .map((c) => c.join(' · '))
                  .join('\n')}
              </pre>
              <div className="row">
                {!playing ? (
                  <button
                    type="button"
                    className="btn accent"
                    onClick={() => void startMusic()}
                  >
                    开始演奏（浏览器需要一次点击启动音频）
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={stopMusic}
                  >
                    停止
                  </button>
                )}
              </div>
            </div>
          ) : null}
        </section>

        <section className="panel stretch">
          <h2>手势控制 · MediaPipe Hands</h2>
          <HandControl
            active={camOn && playing}
            idle={idleControls}
            onControls={onGesture}
          />
          <p className="fineprint">
            模型从 Google CDN 加载；首次使用需允许摄像头权限。旧版 p5 / ml5 示例在{' '}
            <code>legacy/</code> 目录。
          </p>
        </section>
      </main>
    </div>
  )
}

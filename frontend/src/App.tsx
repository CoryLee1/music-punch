import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useState,
} from 'react'
import { GestureStage } from './components/GestureStage'
import './App.css'

type ApiState = 'idle' | 'ok' | 'err'

export default function App() {
  const [api, setApi] = useState<ApiState>('idle')
  const [chatDraft, setChatDraft] = useState('')
  const [chatLines, setChatLines] = useState<string[]>([])
  const [textPhysicsJob, setTextPhysicsJob] = useState<{
    id: number
    text: string
  } | null>(null)

  const onTextPhysicsComplete = useCallback(() => {
    setTextPhysicsJob(null)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await fetch('/api/health')
        const j = (await r.json()) as { ok?: boolean }
        if (!cancelled && r.ok && j.ok) setApi('ok')
        else if (!cancelled) setApi('err')
      } catch {
        if (!cancelled) setApi('err')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  function flushChat() {
    const text = chatDraft.trim()
    if (!text) return
    setChatLines((prev) => [...prev, text])
    setChatDraft('')
    setTextPhysicsJob({ id: Date.now(), text })
  }

  function submitChat(ev: FormEvent) {
    ev.preventDefault()
    flushChat()
  }

  function onChatKeyDown(ev: KeyboardEvent<HTMLTextAreaElement>) {
    if (ev.key !== 'Enter') return
    if (!(ev.metaKey || ev.ctrlKey)) return
    ev.preventDefault()
    flushChat()
  }

  return (
    <div className="app">
      <header className="app-bar">
        <div className="app-bar-title">
          <span className="mark">//</span> MUSIC_PUNCH
        </div>
        <div className="app-bar-meta">
          <span>
            API:{' '}
            {api === 'idle'
              ? '…'
              : api === 'ok'
                ? 'CONNECTED'
                : 'OFFLINE (仅前端可用)'}
          </span>
          <span className="sub">
            后端路由挂载在 <code>/api/*</code>，合作者可在此扩展。
          </span>
        </div>
      </header>

      <main className="app-main">
        <GestureStage
          textPhysicsJob={textPhysicsJob}
          onTextPhysicsComplete={onTextPhysicsComplete}
        />

        <section className="chat-panel" aria-label="文字对话">
          <div className="chat-label">// DIALOG_STREAM · LOCAL_BUFFER</div>
          <div className="chat-log" role="log">
            {chatLines.length === 0 ? (
              <p className="chat-log-empty">
                // 尚无消息 · 发送后先 TECHNO_SCAN 假解析 → 字形落体
              </p>
            ) : (
              chatLines.map((line, i) => (
                <p key={`${i}-${line.slice(0, 24)}`} className="chat-line">
                  // USER: {line}
                </p>
              ))
            )}
          </div>
          <form className="chat-form" onSubmit={submitChat}>
            <textarea
              className="chat-input"
              value={chatDraft}
              onChange={(e) => setChatDraft(e.target.value)}
              onKeyDown={onChatKeyDown}
              placeholder="输入文字…（当前仅保存在本页，可后续对接 /api/chat）"
              rows={3}
              maxLength={4000}
              aria-label="对话输入"
            />
            <div className="chat-actions">
              <span className="chat-hint-inline">Enter 换行 · Cmd/Ctrl+Enter 发送</span>
              <button type="submit" className="chat-send">
                // SEND
              </button>
            </div>
          </form>
        </section>

        <aside className="app-hint">
          <p>
            可用 <code>// UPLOAD_LOCAL_AUDIO</code> 上传本地音频；点击画面启动循环，<code>// STOP_AUDIO</code> 停止。
            摄像头需授权；拇食指距离只映射 <code>playbackRate</code>（越快越高），音量固定常驻。
          </p>
          <p>
            手势识别（先点击画布启动音画流）：五指张开再收拢 → <code>抓</code>（仅界面标记；音高由手掌开合连续控制）。
            手掌拢紧音调变低、五指张开音调变高（与拇食指 pinch 变速相乘）。
            握紧拳由近移远 → <code>出拳</code>（短时加速）；四指刀手快划 → <code>切</code>。
            画布 HUD 中 <code>PALM_OPEN</code> / <code>MUL</code> 为开合与倍率。
          </p>
          <p className="fine">
            在对话区发送文本：会先出现 TECHNO_SCAN 示意「文本→音乐」解析，再在画布区用 Matter.js 让每个字形落体，结束后照常点击画布启动/手势控节奏。
          </p>
          <p className="fine">
            默认循环底音为 <code>piano-beat-boom-bap-mixed-drums_95bpm_Asharp.wav</code>（原 Key 为 A#），出拳叠加 <code>punch-sound-effect-wet_96bpm.wav</code>；仍可将其它素材放到 <code>public/</code> 并用上传替换。
            纯静态原型见 <code>legacy-p5/</code>。
          </p>
        </aside>
      </main>
    </div>
  )
}

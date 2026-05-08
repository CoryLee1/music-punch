import { type FormEvent, type KeyboardEvent, useEffect, useState } from 'react'
import { GestureStage } from './components/GestureStage'
import './App.css'

type ApiState = 'idle' | 'ok' | 'err'

export default function App() {
  const [api, setApi] = useState<ApiState>('idle')
  const [chatDraft, setChatDraft] = useState('')
  const [chatLines, setChatLines] = useState<string[]>([])

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
        <GestureStage />

        <section className="chat-panel" aria-label="文字对话">
          <div className="chat-label">// DIALOG_STREAM · LOCAL_BUFFER</div>
          <div className="chat-log" role="log">
            {chatLines.length === 0 ? (
              <p className="chat-log-empty">// 尚无消息 · 输入后回车或发送</p>
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
            可用 <code>// UPLOAD_LOCAL_AUDIO</code> 上传本地音频；再点击画面启动。
            摄像头需授权；拇食指距离映射 <code>playbackRate</code>（越快越高），过近静音。
          </p>
          <p>
            手势识别（先点击画布启动音画流）：五指张开再收拢 → <code>抓</code>；握紧拳并把拳从近侧移向远处（画面里手变小）→ <code>出拳</code>；
            四指并拢作刀状、在画面前快速平划 → <code>切</code>。识别结果在画布标题区与工具条
            <code>LAST_GESTURE</code> 展示。
          </p>
          <p className="fine">
            默认内置 <code>sample.wav</code>（随仓库分发）。上传仅保存在本机内存，不会发到服务器。
            纯静态原型见 <code>legacy-p5/</code>。
          </p>
        </aside>
      </main>
    </div>
  )
}

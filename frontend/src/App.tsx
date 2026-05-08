import { useEffect, useState } from 'react'
import { GestureStage } from './components/GestureStage'
import './App.css'

type ApiState = 'idle' | 'ok' | 'err'

export default function App() {
  const [api, setApi] = useState<ApiState>('idle')

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
        <aside className="app-hint">
          <p>
            点击画面启动音频 → 摄像头需授权 → 拇食指距离映射{' '}
            <code>playbackRate</code>（越快越高） ，过近静音。
          </p>
          <p className="fine">
            请将 <code>sample.wav</code> 放在 <code>frontend/public/</code> 。
            纯静态原型见 <code>legacy-p5/</code>。
          </p>
        </aside>
      </main>
    </div>
  )
}

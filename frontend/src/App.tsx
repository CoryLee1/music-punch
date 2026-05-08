import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { ParticlePunchHandle } from './components/ParticlePunchOverlay'
import { GestureStage } from './components/GestureStage'
import {
  getDashscopeAsrWsUrl,
  startDashscopeRealtimeAsr,
} from './lib/dashscopeRealtimeAsr'
import './App.css'

type ApiState = 'idle' | 'ok' | 'err'

const PUNCH_GAME_SEC = 60
/** 连续命中粒子后超过此时长未再命中则连击中断 */
const PUNCH_COMBO_BREAK_MS = 2600

const MIC_ICON_SRC = encodeURI('/麦克风,声音,录音,录制声音 1.svg')

/** 无新识别结果达此时长后，自动提交输入框并继续听 */
const VOICE_SILENCE_MS = 1600

function getSpeechRecognitionCtor(): (new () => SpeechRecognition) | null {
  if (typeof window === 'undefined') return null
  return (
    window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null
  )
}

export default function App() {
  const [api, setApi] = useState<ApiState>('idle')
  /** 后端已配置 DASHSCOPE_API_KEY 时使用百炼实时 ASR */
  const [dashscopeAsrReady, setDashscopeAsrReady] = useState(false)
  const [chatDraft, setChatDraft] = useState('')
  const [chatLines, setChatLines] = useState<string[]>([])
  const [voiceListening, setVoiceListening] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const voiceEngineStopRef = useRef<(() => void) | null>(null)
  const voiceBaseRef = useRef('')
  const voiceSessionFinalRef = useRef('')
  const voicePartialRef = useRef('')
  const chatDraftRef = useRef('')
  const dashscopeAsrReadyRef = useRef(false)
  const micPausedRef = useRef(false)
  const [micPaused, setMicPaused] = useState(false)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voiceListeningRef = useRef(false)
  const voiceStartingRef = useRef(false)
  const startVoiceRef = useRef<() => void>(() => {})
  const skipNextWebSpeechEndRef = useRef(false)
  const [textPhysicsJob, setTextPhysicsJob] = useState<{
    id: number
    text: string
  } | null>(null)

  const punchHandleRef = useRef<ParticlePunchHandle>(null)
  const comboBreakTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(
    null,
  )
  const [punchPhase, setPunchPhase] = useState<'idle' | 'running' | 'ended'>(
    'idle',
  )
  const [punchScore, setPunchScore] = useState(0)
  const [punchHitTick, setPunchHitTick] = useState(0)
  const [punchCombo, setPunchCombo] = useState(0)
  const [punchComboMax, setPunchComboMax] = useState(0)
  const [punchTimeLeft, setPunchTimeLeft] = useState(PUNCH_GAME_SEC)
  const punchPhaseRef = useRef(punchPhase)
  useEffect(() => {
    punchPhaseRef.current = punchPhase
  }, [punchPhase])

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

  const onEmotionScanComplete = useCallback(() => {
    if (punchPhaseRef.current !== 'running') {
      startPunchRound()
    }
  }, [startPunchRound])

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

  useEffect(() => {
    if (punchPhase === 'running') return
    const tid = comboBreakTimerRef.current
    if (tid != null) window.clearTimeout(tid)
    comboBreakTimerRef.current = null
  }, [punchPhase])

  useEffect(() => {
    if (punchPhase !== 'running') return
    const t0 = Date.now()
    const id = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - t0) / 1000)
      const left = Math.max(0, PUNCH_GAME_SEC - elapsed)
      setPunchTimeLeft(left)
      if (left <= 0) {
        setPunchPhase('ended')
        window.clearInterval(id)
      }
    }, 260)
    return () => window.clearInterval(id)
  }, [punchPhase])

  const dismissPunchEnded = useCallback(() => {
    setPunchPhase('idle')
  }, [])

  const onTextPhysicsComplete = useCallback(() => {
    setTextPhysicsJob(null)
  }, [])

  const submitPhysicsText = useCallback((raw: string) => {
    const text = raw.trim()
    if (!text) return
    setChatLines((prev) => [...prev, text])
    setTextPhysicsJob({ id: Date.now(), text })
    punchHandleRef.current?.appendUserTextParticles(text)
  }, [])

  useEffect(() => {
    chatDraftRef.current = chatDraft
  }, [chatDraft])

  useEffect(() => {
    dashscopeAsrReadyRef.current = dashscopeAsrReady
  }, [dashscopeAsrReady])

  useEffect(() => {
    micPausedRef.current = micPaused
  }, [micPaused])

  useEffect(() => {
    voiceListeningRef.current = voiceListening
  }, [voiceListening])

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
  }, [])

  const scheduleSilenceAutoSend = useCallback(() => {
    if (micPausedRef.current) return
    clearSilenceTimer()
    silenceTimerRef.current = window.setTimeout(() => {
      silenceTimerRef.current = null
      if (micPausedRef.current) return
      const text = (
        voiceBaseRef.current +
        voiceSessionFinalRef.current +
        voicePartialRef.current
      ).trim()
      if (!text) return
      submitPhysicsText(text)
      setChatDraft('')
      voiceBaseRef.current = ''
      voiceSessionFinalRef.current = ''
      voicePartialRef.current = ''
      if (!dashscopeAsrReadyRef.current) {
        try {
          skipNextWebSpeechEndRef.current = true
          recognitionRef.current?.stop()
        } catch {
          /* noop */
        }
        recognitionRef.current = null
        setVoiceListening(false)
        window.setTimeout(() => {
          if (micPausedRef.current) return
          startVoiceRef.current()
        }, 120)
      }
    }, VOICE_SILENCE_MS)
  }, [clearSilenceTimer, submitPhysicsText])

  const stopVoice = useCallback(() => {
    clearSilenceTimer()
    try {
      voiceEngineStopRef.current?.()
    } catch {
      /* noop */
    }
    voiceEngineStopRef.current = null
    try {
      recognitionRef.current?.stop()
    } catch {
      /* noop */
    }
    recognitionRef.current = null
    setVoiceListening(false)
  }, [clearSilenceTimer])

  const startVoice = useCallback(() => {
    if (micPausedRef.current) return
    if (voiceListeningRef.current || voiceStartingRef.current) return
    setVoiceError(null)
    voiceBaseRef.current = chatDraftRef.current
    voiceSessionFinalRef.current = ''
    voicePartialRef.current = ''

    if (dashscopeAsrReady) {
      voiceStartingRef.current = true
      void (async () => {
        try {
          const stop = await startDashscopeRealtimeAsr({
            wsUrl: getDashscopeAsrWsUrl(),
            onResult: ({ text, sentenceEnd }) => {
              if (micPausedRef.current) return
              if (sentenceEnd) {
                voiceSessionFinalRef.current += text
                voicePartialRef.current = ''
              } else {
                voicePartialRef.current = text
              }
              setChatDraft(
                voiceBaseRef.current +
                  voiceSessionFinalRef.current +
                  voicePartialRef.current,
              )
              scheduleSilenceAutoSend()
            },
            onError: (msg) => {
              setVoiceError(msg)
              voiceEngineStopRef.current = null
              setVoiceListening(false)
              voiceStartingRef.current = false
            },
          })
          voiceEngineStopRef.current = stop
          setVoiceListening(true)
        } catch (e) {
          setVoiceError(e instanceof Error ? e.message : String(e))
          setVoiceListening(false)
        } finally {
          voiceStartingRef.current = false
        }
      })()
      return
    }

    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor) {
      setVoiceError(
        '当前不可用语音识别：请在后端配置 DASHSCOPE_API_KEY 使用阿里云百炼，或使用 Chrome / Edge（桌面端）并允许麦克风的 Web Speech API。',
      )
      return
    }
    const rec = new Ctor()
    rec.lang =
      typeof navigator !== 'undefined' &&
      /zh|cn/i.test(navigator.language || '')
        ? 'zh-CN'
        : 'en-US'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    rec.onstart = () => setVoiceListening(true)
    rec.onerror = (e) => {
      if (e.error === 'aborted' || e.error === 'no-speech') return
      const msg =
        e.error === 'not-allowed'
          ? '麦克风权限被拒绝，请在地址栏允许麦克风后重试。'
          : e.message || e.error
      setVoiceError(msg)
      setVoiceListening(false)
      recognitionRef.current = null
    }
    rec.onend = () => {
      setVoiceListening(false)
      recognitionRef.current = null
      if (skipNextWebSpeechEndRef.current) {
        skipNextWebSpeechEndRef.current = false
        return
      }
      if (
        !micPausedRef.current &&
        !dashscopeAsrReadyRef.current &&
        document.visibilityState === 'visible'
      ) {
        window.setTimeout(() => {
          if (
            micPausedRef.current ||
            voiceListeningRef.current ||
            voiceStartingRef.current
          ) {
            return
          }
          startVoiceRef.current()
        }, 200)
      }
    }
    rec.onresult = (event) => {
      if (micPausedRef.current) return
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i]
        const t = r[0]?.transcript ?? ''
        if (r.isFinal) voiceSessionFinalRef.current += t
        else interim += t
      }
      voicePartialRef.current = interim
      setChatDraft(
        voiceBaseRef.current +
          voiceSessionFinalRef.current +
          voicePartialRef.current,
      )
      scheduleSilenceAutoSend()
    }
    recognitionRef.current = rec
    voiceStartingRef.current = true
    try {
      rec.start()
    } catch {
      setVoiceError('无法启动语音识别（请使用 HTTPS 或 localhost）。')
      setVoiceListening(false)
      recognitionRef.current = null
    } finally {
      voiceStartingRef.current = false
    }
  }, [dashscopeAsrReady, scheduleSilenceAutoSend])

  useEffect(() => {
    startVoiceRef.current = () => {
      void startVoice()
    }
  }, [startVoice])

  useEffect(() => {
    if (micPaused) return
    if (api !== 'ok') return
    const hasAsr = dashscopeAsrReady || getSpeechRecognitionCtor() !== null
    if (!hasAsr) return
    const id = window.setTimeout(() => {
      if (micPausedRef.current) return
      if (voiceListeningRef.current || voiceStartingRef.current) return
      startVoiceRef.current()
    }, 600)
    return () => clearTimeout(id)
  }, [micPaused, api, dashscopeAsrReady])

  const stopMicUser = useCallback(() => {
    micPausedRef.current = true
    setMicPaused(true)
    stopVoice()
  }, [stopVoice])

  const resumeVoiceListening = useCallback(() => {
    setVoiceError(null)
    micPausedRef.current = false
    setMicPaused(false)
  }, [])

  useEffect(() => {
    return () => {
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current)
        silenceTimerRef.current = null
      }
      try {
        voiceEngineStopRef.current?.()
      } catch {
        /* noop */
      }
      voiceEngineStopRef.current = null
      try {
        recognitionRef.current?.abort()
      } catch {
        /* noop */
      }
      recognitionRef.current = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      let dash = false
      let apiOk = false
      try {
        const hr = await fetch('/api/health')
        const hj = (await hr.json()) as {
          ok?: boolean
          service?: string
          asr?: { dashscope?: boolean }
        }
        apiOk = hr.ok && hj.ok === true
        if (!cancelled) {
          if (apiOk) setApi('ok')
          else setApi('err')
        }
        if (apiOk && hj.asr && typeof hj.asr.dashscope === 'boolean') {
          dash = hj.asr.dashscope
        } else if (apiOk) {
          try {
            const sr = await fetch('/api/asr/status')
            const sj = (await sr.json()) as { dashscope?: boolean }
            if (sr.ok) dash = !!sj.dashscope
          } catch {
            /* noop */
          }
        }
      } catch {
        if (!cancelled) setApi('err')
      }
      if (!cancelled) setDashscopeAsrReady(dash)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  function flushChat() {
    clearSilenceTimer()
    const text = chatDraft.trim()
    if (!text) return
    submitPhysicsText(text)
    setChatDraft('')
    voiceBaseRef.current = ''
    voiceSessionFinalRef.current = ''
    voicePartialRef.current = ''
    if (!dashscopeAsrReadyRef.current) {
      try {
        skipNextWebSpeechEndRef.current = true
        recognitionRef.current?.stop()
      } catch {
        /* noop */
      }
      recognitionRef.current = null
      setVoiceListening(false)
      if (!micPausedRef.current) {
        window.setTimeout(() => {
          startVoiceRef.current()
        }, 120)
      }
    }
  }

  function submitChat(ev: FormEvent) {
    ev.preventDefault()
    flushChat()
  }

  function onChatKeyDown(ev: KeyboardEvent<HTMLInputElement>) {
    if (ev.key !== 'Enter') return
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
          <button
            type="button"
            className="punch-round-start-btn"
            disabled={punchPhase === 'running'}
            onClick={startPunchRound}
          >
            // START_60S_PUNCH
          </button>
          <span>
            API:{' '}
            {api === 'idle'
              ? '…'
              : api === 'ok'
                ? 'CONNECTED'
                : 'OFFLINE (仅前端可用)'}
            ；ASR:{' '}
            {dashscopeAsrReady
              ? '百炼实时'
              : api === 'ok'
                ? 'Web Speech'
                : '—'}
          </span>
          <span className="sub">
            后端路由挂载在 <code>/api/*</code>，合作者可在此扩展。
          </span>
        </div>
      </header>

      <main className="app-main">
        {punchPhase === 'ended' ? (
          <div
            className="punch-game-end-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="punch-end-title"
          >
            <div className="punch-game-end-card">
              <h2 id="punch-end-title" className="punch-end-heading">
                PUNCH ROUND · 结束
              </h2>
              <p className="punch-final-score">得分 · {punchScore}</p>
              <p className="punch-final-combo">
                最大连击 · ×{punchComboMax}
              </p>
              <p className="punch-end-hint">
                60 秒内以「出拳」或「切」手势击中场内粒子球并打散的命中次数。发送情绪文
                字并在 TECHNO_SCAN 结束后也会自动开局。
              </p>
              <button
                type="button"
                className="punch-end-dismiss"
                onClick={dismissPunchEnded}
              >
                // CLOSE
              </button>
            </div>
          </div>
        ) : null}

        <GestureStage
          textPhysicsJob={textPhysicsJob}
          onTextPhysicsComplete={onTextPhysicsComplete}
          onMidSequencePhysicsText={submitPhysicsText}
          onEmotionScanComplete={onEmotionScanComplete}
          onAudioPlaybackStarted={startPunchRound}
          musicPunchGameActive={punchPhase === 'running'}
          musicPunchHandleRef={punchHandleRef}
          onMusicPunchSuccessfulHit={onPunchHit}
          musicPunchHud={
            punchPhase === 'running'
              ? {
                  timeLeft: punchTimeLeft,
                  score: punchScore,
                  combo: punchCombo,
                }
              : null
          }
          musicPunchHitTick={punchHitTick}
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
          {voiceError ? (
            <p className="chat-voice-err" role="alert">
              {voiceError}
            </p>
          ) : null}
          <form className="chat-form chat-form--bar" onSubmit={submitChat}>
            <div className="chat-bar-outer">
              <div className="chat-bar-input-frame">
                <input
                  type="text"
                  className="chat-bar-field"
                  value={chatDraft}
                  onChange={(e) => setChatDraft(e.target.value)}
                  onKeyDown={onChatKeyDown}
                  placeholder="Say whatever you're feeling."
                  maxLength={4000}
                  aria-label="情绪或留言输入"
                  autoComplete="off"
                />
                <button type="submit" className="chat-bar-send">
                  SEND
                </button>
              </div>
              <div className="chat-bar-voice-actions">
                {micPaused ? (
                  <button
                    type="button"
                    className="chat-voice-resume"
                    onClick={resumeVoiceListening}
                  >
                    继续监听
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`chat-bar-mic${voiceListening ? ' is-listening' : ''}`}
                  aria-label="停止语音识别"
                  aria-pressed={voiceListening}
                  disabled={micPaused}
                  onClick={stopMicUser}
                >
                  <img
                    className="chat-bar-mic-icon"
                    src={MIC_ICON_SRC}
                    alt=""
                    decoding="async"
                    draggable={false}
                  />
                </button>
              </div>
            </div>
          </form>
        </section>

        <aside className="app-hint">
          <p>
            可用 <code>// UPLOAD_LOCAL_AUDIO</code> 上传本地音频；页面加载后会<strong>自动循环播放</strong>默认 WAV，摄像头就绪后会再试，约每 2s 也会重试直至成功。需要手势解锁时<strong>点一下预览区</strong>即可。只有 <code>// STOP_AUDIO</code> 会静音并暂停自动重试；再点预览区或上传新文件可恢复。
            摄像头需授权。循环乐默认以 <code>playbackRate = 1</code> 播放；手部不再连续调制速率或音量（音量常驻）。
          </p>
          <p>
            手势识别（背景循环见上，自动启动）：五指张开再收拢 → <code>抓</code>（仅界面标记）。<code>出拳</code> 仅触发 punch 采样音效，背景循环 <code>playbackRate</code> 恒为 1；<code>切</code> 不再改变速率。
            握紧拳由近移远 → <code>出拳</code>；四指刀手快划 → <code>切</code>。
            画布 HUD 标明基准速率与增益。
          </p>
          <p className="fine">
            在对话区或序列进行时在画面下方条带输入：会先 TECHNO_SCAN，再 Matter
            落体；中途再发送会用新正文重新开始（旧计时器会取消）。
          </p>
          <p className="fine">
            底部输入条：联网且 ASR 可用时会<strong>自动开始</strong>语音识别；停顿约{' '}
            {Math.round(VOICE_SILENCE_MS / 100) / 10}s 无新识别结果会<strong>自动发送</strong>
            当前文字并继续听。麦克风按钮仅用于<strong>停止</strong>监听，停止后点「继续监听」恢复。
            仍可用 SEND / Enter 手动发送。百炼 / Web Speech 与此前一致。
          </p>
          <p className="fine">
            默认循环底音为 <code>sample.wav</code>，出拳叠加{' '}
            <code>bass-808-shot-bomboclat_C_major.wav</code>；仍可将其它素材放到{' '}
            <code>public/</code> 并用上传替换。
            纯静态原型见 <code>legacy-p5/</code>。
          </p>
          <p>
            <strong>Music Punch 回合（补全 PRD）：</strong>
            情绪文字发送并经过约 4.4s TECHNO_SCAN 后自动进入 60 秒击打回合；亦可点顶栏{' '}
            <code>// START_60S_PUNCH</code> 直接开局。画面叠有三维粒子球（以顶点为粒
            子，主体系小点，少量 <code>@</code> <code>&amp;</code> <code>%</code> 与贴图点缀）。
            在<strong>回合进行中</strong>每次发送输入框文字，会<strong>拆成字符</strong>并
            追加到球面上（多次发送可叠加；上限约 120 字，单次最多约 36 字）。
            食指方向映射射线，「出拳」「切」命中球体时粒子爆散并播放{' '}
            <code>bass-808-shot-bomboclat_C_major.wav</code>。到时弹窗展示得分。
          </p>
        </aside>
      </main>
    </div>
  )
}

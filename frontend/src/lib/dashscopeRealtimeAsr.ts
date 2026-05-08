/** 浏览器侧 → 本仓库 API 代理 → DashScope Fun-ASR（16k PCM） */

function resampleFloat32(
  input: Float32Array,
  inRate: number,
  outRate: number,
): Float32Array {
  if (inRate === outRate) return new Float32Array(input)
  const ratio = inRate / outRate
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio
    const i0 = Math.floor(srcIdx)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const t = srcIdx - i0
    out[i] = input[i0]! * (1 - t) + input[i1]! * t
  }
  return out
}

function floatTo16BitPCM(float32: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(float32.length * 2)
  const view = new DataView(buf)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]!))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buf
}

export function getDashscopeAsrWsUrl(): string {
  const p = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${p}//${window.location.host}/api/asr/stream`
}

export type DashscopeAsrResult = { text: string; sentenceEnd: boolean }

/**
 * 建立 WebSocket，采集麦克风 PCM 并推送；返回停止函数（发送 stop、关麦、关连接）
 */
export async function startDashscopeRealtimeAsr(opts: {
  wsUrl: string
  onResult: (payload: DashscopeAsrResult) => void
  onError: (message: string) => void
}): Promise<() => void> {
  const { wsUrl, onResult, onError } = opts
  const ws = new WebSocket(wsUrl)
  ws.binaryType = 'arraybuffer'

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('语音识别连接失败（WebSocket）'))
  })

  ws.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data !== 'string') return
    try {
      const msg = JSON.parse(ev.data) as
        | { type: 'result'; text: string; sentenceEnd: boolean }
        | { type: 'error'; message: string }
        | { type: 'ready' }
        | { type: 'finished' }
      if (msg.type === 'result') {
        onResult({
          text: msg.text,
          sentenceEnd: msg.sentenceEnd,
        })
      } else if (msg.type === 'error') {
        onError(msg.message)
      }
    } catch {
      /* ignore */
    }
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })

  /** 不设死 16k：交给系统采样率，便于浏览器做 AEC/降噪；发送前再重采样到 16k */
  const ctx = new AudioContext()
  const inRate = ctx.sampleRate
  const source = ctx.createMediaStreamSource(stream)
  /** 削弱扬声器里传来的 BGM 低频能量，减轻「听错歌词」类误识别（不能完全消除空气传导） */
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 200
  hp.Q.value = 0.707
  const proc = ctx.createScriptProcessor(4096, 1, 1)
  proc.onaudioprocess = (e) => {
    if (ws.readyState !== WebSocket.OPEN) return
    const input = e.inputBuffer.getChannelData(0)
    const f32 =
      inRate === 16000
        ? new Float32Array(input)
        : resampleFloat32(input, inRate, 16000)
    ws.send(floatTo16BitPCM(f32))
  }
  const gain = ctx.createGain()
  gain.gain.value = 0
  source.connect(hp)
  hp.connect(proc)
  proc.connect(gain)
  gain.connect(ctx.destination)

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    try {
      proc.disconnect()
      gain.disconnect()
      hp.disconnect()
      source.disconnect()
    } catch {
      /* noop */
    }
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close()
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stop' }))
      }
    } catch {
      /* noop */
    }
    ws.close()
  }
}

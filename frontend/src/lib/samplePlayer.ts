import * as Tone from 'tone'

import type { GestureSignal } from './handGestures'

function readRiffTag(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf, 0, 4)
  return String.fromCharCode(u8[0], u8[1], u8[2], u8[3])
}

const USER_FILE_MAX_BYTES = 40 * 1024 * 1024

/** 手势映射的线性音量下限：拇食指最近时仍保留少量响度（无手传 0 时仍可完全静音） */
export const GESTURE_VOLUME_LINEAR_MIN = 0.14

/**
 * 用 Tone.Player + 解码后的 AudioBuffer，避免 URL 加载失败时仅报 “Unable to decode audio data”。
 * 会先 fetch 并检查 HTTP 与 RIFF 头，再 decodeAudioData。
 */
export class SampleLoopController {
  private player: Tone.Player | null = null
  private readonly gain: Tone.Gain
  /** 用户是否已通过 start() 或其它方式开始过播放（用于上传后决定是否自动续播） */
  private hasStartedPlayback = false
  /** 离散手势触发的短时调制（与捏合控制的 rate/vol 叠加） */
  private fxSignal: GestureSignal | null = null
  private fxEndPerf = 0
  private fxDurationMs = 300

  constructor(private readonly sampleUrl = '/sample.wav') {
    this.gain = new Tone.Gain(0).toDestination()
  }

  private async fetchPcmWav(): Promise<ArrayBuffer> {
    const res = await fetch(this.sampleUrl, { cache: 'no-store' })
    if (!res.ok) {
      throw Error(
        `无法加载「${this.sampleUrl}」（HTTP ${res.status}）。请将有效的 sample.wav 放到 frontend/public/ 目录后刷新页面。`,
      )
    }
    const buf = await res.arrayBuffer()
    if (buf.byteLength < 44) {
      throw Error(
        '音频文件过小或为空。请确认 frontend/public/sample.wav 是完整导出的 WAV。',
      )
    }
    if (readRiffTag(buf) !== 'RIFF') {
      throw Error(
        `「${this.sampleUrl}」不是 WAV（缺少 RIFF 头）。常见原因：未放置 sample.wav，或开发服务器把该路径回退成了 HTML（请检查 public 目录与文件名大小写）。`,
      )
    }
    return buf
  }

  async start(): Promise<void> {
    await Tone.start()

    if (!this.player) {
      try {
        const raw = await this.fetchPcmWav()
        const ctx = Tone.getContext().rawContext
        let audioBuf: AudioBuffer
        try {
          const copy = raw.slice(0)
          audioBuf = await ctx.decodeAudioData(copy)
        } catch {
          throw Error(
            '浏览器无法解码该文件。请改用标准 PCM WAV（如 16-bit、44100Hz 立体声），或用音频软件重新导出后再试。',
          )
        }
        this.player = new Tone.Player(audioBuf).connect(this.gain)
        this.player.loop = true
      } catch (e) {
        this.player?.dispose()
        this.player = null
        throw e
      }
    }

    if (this.player.state !== 'started') {
      this.player.start(0)
    }
    this.hasStartedPlayback = true
    this.gain.gain.rampTo(0.5, 0.06)
  }

  /**
   * 从用户选择的文件解码并替换当前循环；若已在播放则无缝切换并继续播放。
   */
  async loadFromFile(file: File): Promise<void> {
    await Tone.start()
    if (file.size > USER_FILE_MAX_BYTES) {
      throw Error('文件过大，请选择小于 40MB 的音频。')
    }
    const raw = await file.arrayBuffer()
    if (raw.byteLength < 100) {
      throw Error('文件过小，无法作为音频解码。')
    }
    const ctx = Tone.getContext().rawContext
    let audioBuf: AudioBuffer
    try {
      audioBuf = await ctx.decodeAudioData(raw.slice(0))
    } catch {
      throw Error(
        '当前浏览器无法解码此文件。请尝试 WAV、MP3、OGG 等常见格式，或换一段剪辑再试。',
      )
    }

    const wasPlaying =
      this.hasStartedPlayback && this.player?.state === 'started'

    this.player?.stop()
    this.player?.dispose()
    this.player = new Tone.Player(audioBuf).connect(this.gain)
    this.player.loop = true

    if (wasPlaying) {
      this.player.start(0)
      this.gain.gain.rampTo(0.5, 0.06)
    }
  }

  /**
   * 手势识别命中时调用：在一段时间内抬升/压低 playbackRate 与音量，与捏合并行。
   */
  triggerGestureFx(signal: GestureSignal): void {
    if (signal === 'grab') return
    this.fxSignal = signal
    this.fxDurationMs = signal === 'punch' ? 360 : 200
    this.fxEndPerf = performance.now() + this.fxDurationMs
  }

  /**
   * @param palmSpreadMul 手掌张开度推导的倍率（约 0.72～1.32）：拢手偏低音、张开偏高音；与 pinch 的 playbackRate 相乘。
   */
  applyGesture(
    playbackRate: number | undefined,
    volumeLinear: number | undefined,
    palmSpreadMul?: number,
  ): void {
    let r =
      playbackRate != null
        ? Math.min(2, Math.max(0.5, playbackRate))
        : null
    let v =
      volumeLinear != null
        ? Math.min(1, Math.max(0, volumeLinear))
        : null

    if (r != null && palmSpreadMul != null) {
      const m = Math.min(1.38, Math.max(0.62, palmSpreadMul))
      r *= m
      r = Math.min(2.55, Math.max(0.42, r))
    }

    const now = performance.now()
    if (this.fxSignal && now >= this.fxEndPerf) {
      this.fxSignal = null
    }

    if (
      this.fxSignal !== null &&
      r != null &&
      v != null &&
      now < this.fxEndPerf
    ) {
      const phase = Math.max(
        0,
        Math.min(1, (this.fxEndPerf - now) / this.fxDurationMs),
      )
      const punchCurve = phase * phase

      if (this.fxSignal === 'punch') {
        const peakR = Math.min(2.55, r + 1.05)
        r = r + (peakR - r) * punchCurve
        v = Math.min(1, v + 0.48 * punchCurve)
      } else {
        const chopCurve = Math.sin(phase * Math.PI) * phase
        r = Math.min(
          2.45,
          r + 0.5 * chopCurve + 0.09 * Math.sin(phase * Math.PI * 5) * phase,
        )
        v = Math.min(1, v + 0.3 * chopCurve)
      }
    }

    if (this.player && r != null) {
      this.player.playbackRate = r
    }
    if (v != null) {
      const noHandSilence =
        playbackRate == null &&
        volumeLinear !== undefined &&
        volumeLinear <= 0
      const outV = noHandSilence
        ? 0
        : Math.max(GESTURE_VOLUME_LINEAR_MIN, Math.min(1, v))
      this.gain.gain.rampTo(outV, 0.05)
    }
  }

  stop(): void {
    try {
      this.player?.stop()
    } catch {
      /* noop */
    }
    this.gain.gain.value = 0
  }

  dispose(): void {
    this.stop()
    this.player?.dispose()
    this.player = null
    this.hasStartedPlayback = false
    this.fxSignal = null
    this.gain.dispose()
  }
}

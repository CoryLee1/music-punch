import * as Tone from 'tone'

import {
  beatTimesForBufferDuration,
  type SampleBeatMeta,
} from './beatSync'
import sampleBeatsJson from '../data/sample-beats.json'
import type { GestureSignal } from './handGestures'
import {
  chopPoseScore,
  isFistLike,
  palmSpanXY,
  type HandLM,
} from './handGestures'
import { PUNCH_SFX_ENABLED } from './punchSfxConfig'

const SAMPLE_BEATS = sampleBeatsJson as SampleBeatMeta

function spatialSmoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function readRiffTag(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf, 0, 4)
  return String.fromCharCode(u8[0], u8[1], u8[2], u8[3])
}

const USER_FILE_MAX_BYTES = 40 * 1024 * 1024

/** 播放中常驻输出增益（与 start()/loadFromFile 后目标一致），手势不再调制 */
export const PLAYBACK_GAIN = 0.5

/** 默认循环底音 */
export const DEFAULT_LOOP_URL = '/sample.wav'

/**
 * 唤醒 Web Audio：无用户手势时 `resume()` 常失败，上下文会保持 `suspended`。
 * 摄像头 `video.play()`、点击页面等手势后再调用更容易成功。
 */
export async function resumeAudioContext(): Promise<void> {
  await Tone.start()
  const ctx = Tone.getContext().rawContext
  if (ctx.state === 'suspended') {
    await ctx.resume().catch(() => {})
  }
}

const PUNCH_SFX_URL = '/bass-808-shot-bomboclat_C_major.wav'
/** 出拳采样相对主干的响度（0~1） */
const PUNCH_SFX_GAIN = 0.52

/**
 * 用 Tone.Player + 解码后的 AudioBuffer，避免 URL 加载失败时仅报 “Unable to decode audio data”。
 * 会先 fetch 并检查 HTTP 与 RIFF 头，再 decodeAudioData。
 */
export class SampleLoopController {
  private player: Tone.Player | null = null
  private readonly gain: Tone.Gain
  /** 主循环：仅升调不降速（与 Player.playbackRate=1 配合） */
  private readonly loopPitchShift: Tone.PitchShift
  /** 主循环：远拳低通「发闷」+ 高位刀手混响 */
  private readonly loopFilter: Tone.Filter
  private readonly loopReverb: Tone.Reverb
  private reverbImpulseReady = false
  /** 出拳等一次性采样输出（与循环乐分轨） */
  private readonly sfxGain: Tone.Gain
  private punchSfxPlayer: Tone.Player | null = null
  private punchSfxReady: Promise<void> | null = null
  /** 合并并发 start()，避免重复 fetch/解码 */
  private startPromise: Promise<void> | null = null
  /** 用户是否已通过 start() 或其它方式开始过播放（用于上传后决定是否自动续播） */
  private hasStartedPlayback = false
  /** 与 Tone 循环对齐的「源缓冲内时间」（秒）；与真实时间 1:1（升调不改播放速度） */
  private loopPositionSec = 0
  private lastClockPerfMs = 0

  /** 跨过主拍累计的半音；仅在手势「打中」时增加（不再随时间自动涨） */
  private beatPitchSemitones = 0
  /** 与当前缓冲时长对齐后的拍点时间（秒） */
  private beatTimesCached: number[] = []

  /** 与 UI 节拍引导对齐：换轨时递增，避免循环位置跳变导致误累计拍数 */
  private playbackSyncGeneration = 0

  constructor(private readonly sampleUrl = DEFAULT_LOOP_URL) {
    this.gain = new Tone.Gain(0).toDestination()
    this.sfxGain = new Tone.Gain(PUNCH_SFX_GAIN).toDestination()
    this.loopPitchShift = new Tone.PitchShift({
      pitch: 0,
      windowSize: 0.09,
      wet: 1,
    })
    this.loopFilter = new Tone.Filter(20000, 'lowpass')
    this.loopReverb = new Tone.Reverb({ decay: 1.35, wet: 0, preDelay: 0.03 })
    this.loopPitchShift.connect(this.loopFilter)
    this.loopFilter.connect(this.loopReverb)
    this.loopReverb.connect(this.gain)
  }

  private async ensureReverbImpulse(): Promise<void> {
    if (this.reverbImpulseReady) return
    await this.loopReverb.generate()
    this.reverbImpulseReady = true
  }

  private refreshBeatTimesForCurrentBuffer(): void {
    const dur = this.getBufferDurationSec()
    this.beatTimesCached = beatTimesForBufferDuration(SAMPLE_BEATS, dur)
  }

  private async loadPunchSfxBuffer(): Promise<void> {
    if (this.punchSfxPlayer) return
    const res = await fetch(PUNCH_SFX_URL, { cache: 'force-cache' })
    if (!res.ok) {
      console.warn(
        `[Music Punch] 无法加载出拳音效 ${PUNCH_SFX_URL}（HTTP ${res.status}）`,
      )
      return
    }
    const buf = await res.arrayBuffer()
    if (buf.byteLength < 44 || readRiffTag(buf) !== 'RIFF') {
      console.warn(`[Music Punch]「${PUNCH_SFX_URL}」非有效 WAV，已跳过出拳采样`)
      return
    }
    const ctx = Tone.getContext().rawContext
    let audioBuf: AudioBuffer
    try {
      audioBuf = await ctx.decodeAudioData(buf.slice(0))
    } catch {
      console.warn(`[Music Punch] 无法解码「${PUNCH_SFX_URL}」`)
      return
    }
    this.punchSfxPlayer = new Tone.Player(audioBuf).connect(this.sfxGain)
    this.punchSfxPlayer.loop = false
  }

  /** 确保出拳 Wav 已解码；失败时静默 */
  private ensurePunchSfx(): Promise<void> {
    if (this.punchSfxPlayer) return Promise.resolve()
    if (!this.punchSfxReady) {
      this.punchSfxReady = (async () => {
        await Tone.start()
        await this.loadPunchSfxBuffer()
      })()
    }
    return this.punchSfxReady
  }

  private playPunchOneShot(): void {
    if (!PUNCH_SFX_ENABLED) return
    void this.ensurePunchSfx().then(() => {
      const p = this.punchSfxPlayer
      if (!p) return
      try {
        p.stop()
      } catch {
        /* noop */
      }
      try {
        p.start(0)
      } catch {
        /* noop */
      }
    })
  }

  private async fetchPcmWav(): Promise<ArrayBuffer> {
    const res = await fetch(this.sampleUrl, { cache: 'no-store' })
    if (!res.ok) {
      throw Error(
        `无法加载「${this.sampleUrl}」（HTTP ${res.status}）。请将有效的循环 WAV 放到 frontend/public/ 后刷新页面。`,
      )
    }
    const buf = await res.arrayBuffer()
    if (buf.byteLength < 44) {
      throw Error(
        '音频文件过小或为空。请确认 frontend/public/ 下默认循环 WAV 完整。',
      )
    }
    if (readRiffTag(buf) !== 'RIFF') {
      throw Error(
        `「${this.sampleUrl}」不是 WAV（缺少 RIFF 头）。请检查 public 目录与文件名（含 # 时 URL 用 %23）。`,
      )
    }
    return buf
  }

  async start(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise
      return
    }

    this.startPromise = (async () => {
      await resumeAudioContext()
      await this.ensureReverbImpulse()

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
          this.player = new Tone.Player(audioBuf).connect(this.loopPitchShift)
          this.player.loop = true
        } catch (e) {
          this.player?.dispose()
          this.player = null
          throw e
        }
      }

      this.refreshBeatTimesForCurrentBuffer()

      if (this.player.state !== 'started') {
        this.player.start(0)
      }
      this.loopPositionSec = 0
      this.lastClockPerfMs = 0
      this.hasStartedPlayback = true
      this.beatPitchSemitones = 0
      this.applyLoopPitchFromBeats()
      this.gain.gain.rampTo(PLAYBACK_GAIN, 0.06)
      void this.ensurePunchSfx()

      let ac = Tone.getContext().rawContext
      if (ac.state === 'suspended') {
        await ac.resume().catch(() => {})
      }
      if (Tone.getContext().rawContext.state !== 'running') {
        try {
          this.player?.stop()
        } catch {
          /* noop */
        }
        try {
          this.gain.gain.cancelScheduledValues(Tone.now())
        } catch {
          /* noop */
        }
        this.gain.gain.value = 0
        throw Error(
          '浏览器未放行自动播放（音频上下文仍为暂停）。请轻点预览区或页面任意处。',
        )
      }
    })()

    try {
      await this.startPromise
    } catch (e) {
      this.startPromise = null
      throw e
    }
    this.startPromise = null
  }

  /**
   * 从用户选择的文件解码并替换当前循环；若已在播放则无缝切换并继续播放。
   */
  async loadFromFile(file: File): Promise<void> {
    await resumeAudioContext()
    await this.ensureReverbImpulse()
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
    this.player = new Tone.Player(audioBuf).connect(this.loopPitchShift)
    this.player.loop = true
    this.beatPitchSemitones = 0
    this.applyLoopPitchFromBeats()
    this.refreshBeatTimesForCurrentBuffer()

    this.loopPositionSec = 0
    this.lastClockPerfMs = 0

    if (wasPlaying) {
      this.player.start(0)
      this.gain.gain.rampTo(PLAYBACK_GAIN, 0.06)
    }
    this.playbackSyncGeneration += 1
  }

  /** 当前相对原始采样累计抬高多少半音（每次成功击打 +0.5） */
  getBeatPitchSemitones(): number {
    return this.beatPitchSemitones
  }

  /** 与当前 buffer 对齐的主拍时间（秒），供节拍窗判定 */
  getLoopBeatTimesSec(): readonly number[] {
    return this.beatTimesCached
  }

  /**
   * 判定为「打中」后抬高背景音高（默认 0.5 半音，经 PitchShift，节拍速度不变）。
   */
  bumpBeatPitch(deltaSemitones = 0.5): void {
    if (!(deltaSemitones > 0)) return
    this.beatPitchSemitones += deltaSemitones
    this.applyLoopPitchFromBeats()
  }

  private applyLoopPitchFromBeats(): void {
    if (this.player) {
      this.player.playbackRate = 1
    }
    this.loopPitchShift.pitch = this.beatPitchSemitones
  }

  /** 节拍引导：换轨后 generation 变化时应丢弃累计拍状态 */
  getPlaybackSyncGeneration(): number {
    return this.playbackSyncGeneration
  }

  /**
   * 手势命中：仅出拳播放 punch 采样；背景升调由 {@link bumpBeatPitch} 在「打中」时触发。
   */
  triggerGestureFx(signal: GestureSignal): void {
    if (signal === 'grab') return
    if (signal === 'punch') {
      this.playPunchOneShot()
    }
  }

  /**
   * 输出音量固定为 {@link PLAYBACK_GAIN}；按拍累积的 pitch 不因手势被重置。
   */
  applyGesture(_playbackRate?: number | null): void {
    this.applyLoopPitchFromBeats()
    this.gain.gain.rampTo(PLAYBACK_GAIN, 0.05)
  }

  /**
   * 根据主手位姿调制空间感：握拳且手在画面中小（远）→ 低通发闷；
   * 刀手姿态且腕部靠画面上方 → 混响加重，靠下趋近于干声。
   */
  updateHandSpatialFx(lm: HandLM[] | null): void {
    const t = 0.07
    if (!lm || lm.length < 21) {
      this.loopFilter.frequency.rampTo(20000, t)
      this.loopReverb.wet.rampTo(0, t)
      return
    }
    const span = palmSpanXY(lm)
    const fist = isFistLike(lm)
    const chopScore = chopPoseScore(lm)
    const wristY = lm[0]!.y

    let muffle01 = 0
    if (fist) {
      muffle01 = 1 - spatialSmoothstep(span, 0.052, 0.128)
    }
    const minHz = 850
    const maxHz = 20000
    const freq = maxHz - muffle01 * (maxHz - minHz)

    let wet =
      chopScore * (1 - spatialSmoothstep(wristY, 0.36, 0.68))
    wet = Math.max(0, Math.min(0.52, wet))

    this.loopFilter.frequency.rampTo(freq, t)
    this.loopReverb.wet.rampTo(wet, t)
  }

  /** HUD：当前相对原调的音高倍率（≈ 2^(半音/12)，playbackRate 恒为 1） */
  getUiPlaybackRate(): number {
    return Math.pow(2, this.beatPitchSemitones / 12)
  }

  /** 主循环采样是否在播放 */
  isLoopPlaying(): boolean {
    return this.player?.state === 'started'
  }

  /** 当前循环 WAV 时长（秒）；未加载时为 0 */
  getBufferDurationSec(): number {
    const b = this.player?.buffer
    if (!b) return 0
    try {
      const d = b.duration
      if (typeof d === 'number' && d > 0) return d
    } catch {
      /* noop */
    }
    const raw = typeof b.get === 'function' ? b.get() : undefined
    if (raw && typeof raw.duration === 'number' && raw.duration > 0) {
      return raw.duration
    }
    return 0
  }

  /**
   * 当前在循环缓冲内的时间（秒），与真实时间同步（不计 playbackRate；升调由 PitchShift 负责）。
   */
  advanceLoopPlaybackClock(): void {
    if (!this.player || this.player.state !== 'started') return
    const now = performance.now()
    if (this.lastClockPerfMs === 0) {
      this.lastClockPerfMs = now
      return
    }
    const dt = (now - this.lastClockPerfMs) / 1000
    this.lastClockPerfMs = now
    this.loopPositionSec += dt
    const dur = this.getBufferDurationSec()
    if (dur > 0) {
      while (this.loopPositionSec >= dur) this.loopPositionSec -= dur
    }
  }

  getLoopPlaybackPositionSec(): number {
    return this.loopPositionSec
  }

  stop(): void {
    this.loopPositionSec = 0
    this.lastClockPerfMs = 0
    try {
      this.punchSfxPlayer?.stop()
    } catch {
      /* noop */
    }
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
    this.punchSfxPlayer?.dispose()
    this.punchSfxPlayer = null
    this.punchSfxReady = null
    this.startPromise = null
    this.hasStartedPlayback = false
    this.loopPositionSec = 0
    this.lastClockPerfMs = 0
    this.reverbImpulseReady = false
    this.loopReverb.dispose()
    this.loopFilter.dispose()
    this.loopPitchShift.dispose()
    this.gain.dispose()
    this.sfxGain.dispose()
  }
}

import * as Tone from 'tone'
import type { EmotionMusic } from '../types/api'

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n))
}

/**
 * 使用 Tone.js 根据和弦进行生成循环乐句；手势映射与 legacy sketch.js 一致：
 * 音量、滤波、播放速度（通过 BPM 倍率）、声像。
 */
export class MusicEngine {
  private readonly filter: Tone.Filter
  private readonly reverb: Tone.Reverb
  private readonly gain: Tone.Gain
  private readonly panner: Tone.Panner
  private readonly synth: Tone.PolySynth
  private loop: Tone.Loop | null = null
  private chordIndex = 0
  private baseBpm = 88
  private brightnessBaseHz = 1400

  constructor() {
    this.panner = new Tone.Panner(0).toDestination()
    this.reverb = new Tone.Reverb({ decay: 2.8 })
    this.filter = new Tone.Filter(this.brightnessBaseHz, 'lowpass')
    this.filter.Q.value = 1
    this.gain = new Tone.Gain(0)
    this.synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: {
        attack: 0.03,
        decay: 0.35,
        sustain: 0.42,
        release: 1.4,
      },
    })
    this.synth.connect(this.filter)
    this.filter.connect(this.reverb)
    this.reverb.connect(this.gain)
    this.gain.connect(this.panner)
  }

  async start(music: EmotionMusic) {
    await Tone.start()
    await this.reverb.generate()

    Tone.Transport.stop()
    Tone.Transport.cancel()
    this.chordIndex = 0

    this.baseBpm = music.bpm
    Tone.Transport.bpm.value = this.baseBpm
    this.reverb.wet.value = clamp01(music.reverbWet)

    const bright = clamp01(music.brightness)
    this.brightnessBaseHz = 220 + bright * 5200
    this.filter.frequency.value = this.brightnessBaseHz

    if (this.loop) {
      this.loop.dispose()
      this.loop = null
    }

    const chords = music.chordProgression.length
      ? music.chordProgression
      : [['C4', 'E4', 'G4']]

    this.loop = new Tone.Loop((time) => {
      const chord = chords[this.chordIndex % chords.length]
      this.synth.triggerAttackRelease(chord, 'half', time)
      this.chordIndex += 1
    }, '1m')

    this.loop.start(0)
    Tone.Transport.start()
    this.gain.gain.rampTo(0.32, 0.08)
  }

  stop() {
    this.gain.gain.rampTo(0, 0.15)
    Tone.Transport.stop()
    if (this.loop) {
      this.loop.dispose()
      this.loop = null
    }
  }

  /**
   * @param filterFreq 绝对赫兹值（手势实时控制），覆盖 brightness 起点附近的明暗感
   */
  applyGesture(c: {
    volume: number
    playbackRate: number
    pan: number
    filterFreq: number
  }) {
    const vol = clamp01(c.volume) * 0.42
    this.gain.gain.linearRampTo(vol, 0.05)
    Tone.Transport.bpm.value = this.baseBpm * c.playbackRate
    this.panner.pan.linearRampTo(Math.max(-1, Math.min(1, c.pan)), 0.05)
    const hz = Math.max(120, Math.min(10000, c.filterFreq))
    this.filter.frequency.linearRampTo(hz, 0.06)
  }

  dispose() {
    this.stop()
    this.synth.dispose()
    this.filter.dispose()
    this.reverb.dispose()
    this.gain.dispose()
    this.panner.dispose()
  }
}

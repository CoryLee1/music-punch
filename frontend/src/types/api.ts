export type MusicMode = 'major' | 'minor'

export interface EmotionMusic {
  bpm: number
  mode: MusicMode
  rootNote: string
  brightness: number
  reverbWet: number
  chordProgression: string[][]
}

export interface EmotionResponse {
  summary: string
  primaryEmotion: string
  music: EmotionMusic
  source: 'openai' | 'heuristic'
}

export interface GestureControls {
  volume: number
  playbackRate: number
  pan: number
  filterFreq: number
}

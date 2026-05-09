/**
 * 从 frontend/public/sample.wav 读取 PCM，做简易 onset（谱通量）峰检测，输出 src/data/sample-beats.json
 * 运行：node scripts/extract-sample-beats.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const wavPath = path.join(__dirname, '../public/sample.wav')
const outPath = path.join(__dirname, '../src/data/sample-beats.json')

/**
 * 自动 onset 后再稀疏：1 = 保持算法输出；2 = 每隔一拍保留（主拍更慢；仅当算法输出 ≥6 个拍点时启用）
 */
const DISPLAY_BEAT_STRIDE = 2

function readWavMonoPcm(buf) {
  let off = 12
  let sampleRate = 44100
  let channels = 1
  let bits = 16
  let pcmOff = 0
  let pcmSize = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10)
      sampleRate = buf.readUInt32LE(off + 12)
      bits = buf.readUInt16LE(off + 22)
    } else if (id === 'data') {
      pcmOff = off + 8
      pcmSize = size
      break
    }
    off += 8 + size
    off += size % 2
  }
  if (pcmOff === 0 || bits !== 16) {
    throw new Error('需要 16-bit PCM WAV（含 data 块）')
  }
  const bytesPerFrame = (bits / 8) * channels
  const frameCount = Math.floor(pcmSize / bytesPerFrame)
  const samples = new Float32Array(frameCount)
  for (let i = 0; i < frameCount; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) {
      const idx = pcmOff + i * bytesPerFrame + c * 2
      sum += buf.readInt16LE(idx)
    }
    samples[i] = sum / channels / 32768
  }
  return { samples, sampleRate }
}

function fluxIndexFromTimeSec(t, sampleRate, hop, frameSize, fluxLen) {
  const raw = Math.floor((t * sampleRate - frameSize / 2) / hop)
  return Math.max(0, Math.min(raw, fluxLen - 1))
}

/**
 * 在粗糙 onset 基础上做「主拍」稀疏化：电子 loop 里 flux 常会抓到 8/16 分，跟唱/跟动作更适合 ~四分拍一层。
 */
function thinToMainBeats(
  beatTimesSec,
  durationSec,
  sampleRate,
  hop,
  frameSize,
  flux,
) {
  if (beatTimesSec.length < 3) return beatTimesSec

  const strengthAt = (t) => {
    const fi = fluxIndexFromTimeSec(
      t,
      sampleRate,
      hop,
      frameSize,
      flux.length,
    )
    return flux[fi] ?? 0
  }

  /** @type {number[]} */
  const intervals = []
  for (let i = 1; i < beatTimesSec.length; i++) {
    const d = beatTimesSec[i] - beatTimesSec[i - 1]
    if (d > 0.16 && d < 1.4) intervals.push(d)
  }
  if (intervals.length < 2) return beatTimesSec

  intervals.sort((a, b) => a - b)
  let period = intervals[Math.floor(intervals.length * 0.58)]

  let bpm = period > 0.04 ? 60 / period : 0
  while (bpm > 108 && period < 1.05) {
    period *= 2
    bpm = 60 / period
  }

  const minGap = Math.max(0.68, period * 0.75)

  const out = [beatTimesSec[0]]
  for (let i = 1; i < beatTimesSec.length; i++) {
    const t = beatTimesSec[i]
    const last = out[out.length - 1]
    if (t - last >= minGap - 1e-6) {
      out.push(t)
    } else if (strengthAt(t) > strengthAt(last)) {
      out[out.length - 1] = t
    }
  }

  const targetMax = Math.max(4, Math.floor(durationSec / minGap))
  if (out.length > targetMax + 2) {
    const step = Math.ceil(out.length / targetMax)
    const sparse = []
    for (let j = 0; j < out.length; j += step) sparse.push(out[j])
    if (sparse[sparse.length - 1] !== out[out.length - 1])
      sparse.push(out[out.length - 1])
    return sparse
  }

  return out
}

function detectOnsets(samples, sampleRate) {
  const frameSize = 1024
  const hop = 512
  const rms = []
  for (let i = 0; i + frameSize < samples.length; i += hop) {
    let sum = 0
    for (let j = 0; j < frameSize; j++) {
      const x = samples[i + j]
      sum += x * x
    }
    rms.push(Math.sqrt(sum / frameSize))
  }
  /** @type {number[]} */
  const flux = [0]
  for (let i = 1; i < rms.length; i++) {
    const d = rms[i] - rms[i - 1]
    flux.push(d > 0 ? d : 0)
  }
  const mean = flux.reduce((a, b) => a + b, 0) / flux.length
  const variance =
    flux.reduce((a, b) => a + (b - mean) ** 2, 0) / flux.length
  const std = Math.sqrt(variance)
  /** 略提高阈值，少抓细碎 onset；仍偏快时改用下方 DISPLAY_BEAT_STRIDE */
  const thresh = mean + 1.72 * std
  const minPeakSpacingSec = 0.26
  const minHop = Math.floor(minPeakSpacingSec * sampleRate / hop)
  /** @type {number[]} */
  const peaks = []
  for (let i = 2; i < flux.length - 2; i++) {
    if (flux[i] < thresh) continue
    if (flux[i] <= flux[i - 1] || flux[i] <= flux[i + 1]) continue
    if (peaks.length && i - peaks[peaks.length - 1] < minHop) {
      if (flux[i] > flux[peaks[peaks.length - 1]])
        peaks[peaks.length - 1] = i
      continue
    }
    peaks.push(i)
  }
  let beatTimesSec = peaks.map(
    (idx) => (idx * hop + frameSize / 2) / sampleRate,
  )
  const durationSec = samples.length / sampleRate
  beatTimesSec = thinToMainBeats(
    beatTimesSec,
    durationSec,
    sampleRate,
    hop,
    frameSize,
    flux,
  )

  if (
    DISPLAY_BEAT_STRIDE > 1 &&
    beatTimesSec.length >= DISPLAY_BEAT_STRIDE * 3
  ) {
    const decimated = beatTimesSec.filter(
      (_, i) => i % DISPLAY_BEAT_STRIDE === 0,
    )
    if (decimated.length >= 3) {
      beatTimesSec = decimated
    }
  }

  /** 去掉贴循环结尾的拍点，避免与下一圈头拍掐在一起 */
  beatTimesSec = beatTimesSec.filter(
    (t) => t >= 0 && t < durationSec - 0.16,
  )

  /** @type {number[]} */
  const intervals = []
  for (let i = 1; i < Math.min(beatTimesSec.length, 48); i++) {
    intervals.push(beatTimesSec[i] - beatTimesSec[i - 1])
  }
  intervals.sort((a, b) => a - b)
  const med = intervals.length ? intervals[Math.floor(intervals.length / 2)] : 0
  const bpmEstimate =
    med > 0.04
      ? Math.min(200, Math.max(35, Math.round(60 / med)))
      : 0
  return { beatTimesSec, bpmEstimate }
}

const buf = fs.readFileSync(wavPath)
const { samples, sampleRate } = readWavMonoPcm(buf)
const { beatTimesSec, bpmEstimate } = detectOnsets(samples, sampleRate)
const durationSec = samples.length / sampleRate

const json = {
  sourceFile: 'sample.wav',
  sampleRate,
  durationSec: Number(durationSec.toFixed(4)),
  bpmEstimate,
  beatTimesSec: beatTimesSec.map((t) => Number(t.toFixed(4))),
}

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, `${JSON.stringify(json)}\n`)
console.log(
  'wrote',
  outPath,
  'beats:',
  beatTimesSec.length,
  'bpm~',
  bpmEstimate,
  'duration',
  durationSec.toFixed(2) + 's',
)

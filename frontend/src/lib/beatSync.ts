export type SampleBeatMeta = {
  durationSec: number
  beatTimesSec: readonly number[]
  bpmEstimate: number
}

/** 按当前缓冲区时长缩放或退回为等间隔拍子（与用户上传音频时长差过大时） */
export function beatTimesForBufferDuration(
  meta: SampleBeatMeta,
  actualDurSec: number,
): number[] {
  if (actualDurSec <= 0.05) return []
  const baseDur = Math.max(meta.durationSec, 0.001)
  const relErr = Math.abs(actualDurSec - meta.durationSec) / baseDur
  const raw = meta.beatTimesSec
  if (relErr > 0.12 || raw.length < 2) {
    const rawBpm = meta.bpmEstimate > 40 ? meta.bpmEstimate : 120
    const bpm = Math.min(rawBpm, 68)
    const n = Math.max(
      4,
      Math.min(14, Math.round(actualDurSec * (bpm / 60))),
    )
    const step = actualDurSec / n
    return Array.from({ length: n }, (_, i) => i * step)
  }
  const scale = actualDurSec / baseDur
  return raw
    .map((t) => Math.min(actualDurSec - 1e-6, Math.max(0, t * scale)))
    .sort((a, b) => a - b)
}

export function wrapLoopSec(t: number, dur: number): number {
  if (dur <= 0) return 0
  return ((t % dur) + dur) % dur
}

/**
 * 当前 loop 时间是否落在任一主拍 ±halfWindowSec 内（按环上最短弧长）。
 */
export function isWithinBeatWindow(
  tLoop: number,
  durSec: number,
  beatTimes: readonly number[],
  halfWindowSec: number,
): boolean {
  if (durSec <= 0.05 || beatTimes.length === 0 || halfWindowSec <= 0) {
    return false
  }
  const t = wrapLoopSec(tLoop, durSec)
  for (const b of beatTimes) {
    const bt = wrapLoopSec(b, durSec)
    let d = Math.abs(t - bt)
    if (d > durSec / 2) d = durSec - d
    if (d <= halfWindowSec) return true
  }
  return false
}

/** 检测循环位置从 prev 到 curr 经过了多少个拍点（用于累计计数） */
export function countBeatCrossings(
  prev: number,
  curr: number,
  dur: number,
  beatTimes: number[],
): number {
  if (dur <= 0 || beatTimes.length === 0) return 0
  const bt = [...new Set(beatTimes.map((b) => wrapLoopSec(b, dur)))]
    .filter((b) => b >= 0 && b < dur)
    .sort((a, b) => a - b)
  if (bt.length === 0) return 0
  const p = wrapLoopSec(prev, dur)
  const c = wrapLoopSec(curr, dur)
  if (p <= c) return bt.filter((b) => p < b && c >= b).length
  return bt.filter((b) => b > p).length + bt.filter((b) => c >= b).length
}

/**
 * 当前 loop 时刻距离上一拍的时间比例 tau∈[0,1)，下一拍为 1。
 * 用于把音频相位接到手势动画的 0~1 周期。
 */
export function beatLocalTau(
  tLoop: number,
  dur: number,
  beatTimes: number[],
): number {
  if (dur <= 0) return 0
  const t = wrapLoopSec(tLoop, dur)
  const bt = [...new Set(beatTimes.map((b) => wrapLoopSec(b, dur)))]
    .filter((b) => b >= 0 && b < dur)
    .sort((a, b) => a - b)
  if (bt.length === 0) return (t / dur) % 1
  if (bt.length === 1) {
    const b0 = bt[0]!
    return ((t - b0 + dur) % dur) / dur
  }
  let prevIdx = -1
  for (let i = 0; i < bt.length; i++) {
    if (bt[i]! <= t + 1e-9) prevIdx = i
  }
  let t0: number
  let t1: number
  if (prevIdx >= 0 && prevIdx < bt.length - 1) {
    t0 = bt[prevIdx]!
    t1 = bt[prevIdx + 1]!
  } else if (prevIdx === bt.length - 1) {
    t0 = bt[prevIdx]!
    t1 = bt[0]! + dur
  } else {
    t0 = bt[bt.length - 1]! - dur
    t1 = bt[0]!
  }
  const span = Math.max(1e-6, t1 - t0)
  return (t - t0) / span
}

/** 让「打击高峰」落在拍点上：与 HTML 里 ~0.5 周相对齐 */
export function tauToGestureAnimPhase01(tau: number): number {
  return (tau + 0.5) % 1
}

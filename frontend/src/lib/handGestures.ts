/** 归一化图像坐标下的手部关键点（MediaPipe Hand Landmarker） */
export type HandLM = { x: number; y: number; z?: number }

export type GestureSignal = 'grab' | 'punch' | 'chop'

export type GestureHit = { signal: GestureSignal; labelZh: string; labelEn: string }

const LABELS: Record<GestureSignal, { zh: string; en: string }> = {
  grab: { zh: '抓', en: 'GRAB' },
  punch: { zh: '出拳', en: 'PUNCH' },
  chop: { zh: '切', en: 'CHOP' },
}

export function hitFromSignal(signal: GestureSignal): GestureHit {
  const L = LABELS[signal]
  return { signal, labelZh: L.zh, labelEn: L.en }
}

const WRIST = 0
const THUMB_TIP = 4
const INDEX_TIP = 8
const INDEX_PIP = 6
const INDEX_MCP = 5
const MIDDLE_TIP = 12
const MIDDLE_PIP = 10
const RING_TIP = 16
const RING_PIP = 14
const PINKY_TIP = 20
const PINKY_PIP = 18
const PINKY_MCP = 17

function dist2(a: HandLM, b: HandLM): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

function dist(a: HandLM, b: HandLM): number {
  return Math.sqrt(dist2(a, b))
}

/** 食指到小指掌根跨度，近似“手在画面里大小”（近大远小） */
export function palmSpanXY(lm: HandLM[]): number {
  return dist(lm[INDEX_MCP], lm[PINKY_MCP])
}

/** 腕到五指指尖平均距离，张开时大、握拳时小 */
export function openness(lm: HandLM[]): number {
  const wrist = lm[WRIST]
  const tips = [lm[THUMB_TIP], lm[INDEX_TIP], lm[MIDDLE_TIP], lm[RING_TIP], lm[PINKY_TIP]]
  let s = 0
  for (const t of tips) s += dist(wrist, t)
  return s / 5
}

/**
 * 手掌张开度 → 对 pinch 变速的乘法因子：拢手偏低、张开偏高（连续 pitch 感）。
 * `o` 为 {@link openness} 取值；`lo`/`hi` 可按摄像头距离微调。
 */
export function palmPitchFactorFromOpenness(
  o: number,
  lo = 0.08,
  hi = 0.23,
): number {
  const minMul = 0.72
  const maxMul = 1.32
  if (o <= lo) return minMul
  if (o >= hi) return maxMul
  const t = (o - lo) / (hi - lo)
  return minMul + t * (maxMul - minMul)
}

/** 指尖是否相对指节“伸直”（相对腕部更远） */
function fingerExtended(lm: HandLM[], tip: number, pip: number): boolean {
  const wrist = lm[WRIST]
  const dt = dist(lm[tip], wrist)
  const dp = dist(lm[pip], wrist)
  return dt > dp * 1.035
}

/** 五指伸直数量（含拇指简化判据） */
export function countExtendedFingers(lm: HandLM[]): number {
  let n = 0
  if (fingerExtended(lm, INDEX_TIP, INDEX_PIP)) ++n
  if (fingerExtended(lm, MIDDLE_TIP, MIDDLE_PIP)) ++n
  if (fingerExtended(lm, RING_TIP, RING_PIP)) ++n
  if (fingerExtended(lm, PINKY_TIP, PINKY_PIP)) ++n
  const thumbFar = dist(lm[THUMB_TIP], lm[WRIST]) > dist(lm[3], lm[WRIST]) * 1.02
  if (thumbFar) ++n
  return n
}

/** 握拳粗判：伸直指少 + 整体张开度低（略放宽以利出拳） */
export function isFistLike(lm: HandLM[]): boolean {
  const ext = countExtendedFingers(lm)
  const o = openness(lm)
  return ext <= 2 && o < 0.168
}

/** 四指指尖共线程度（越小越像一条“刃”），用于刀手 */
function tipsLineDeviation(lm: HandLM[]): number {
  const p = [lm[INDEX_TIP], lm[MIDDLE_TIP], lm[RING_TIP], lm[PINKY_TIP]]
  let mx = 0
  let my = 0
  for (const q of p) {
    mx += q.x
    my += q.y
  }
  mx /= 4
  my /= 4
  let vx = p[3].x - p[0].x
  let vy = p[3].y - p[0].y
  const L = Math.hypot(vx, vy) || 1e-6
  vx /= L
  vy /= L
  let dev = 0
  for (const q of p) {
    const dx = q.x - mx
    const dy = q.y - my
    const perp = Math.abs(dx * -vy + dy * vx)
    dev += perp
  }
  return dev / 4
}

/** 刀手姿态：多指伸直 + 四指尖近似一线 + 张开度中等 */
export function chopPoseScore(lm: HandLM[]): number {
  const ext = countExtendedFingers(lm)
  if (ext < 3) return 0
  const dev = tipsLineDeviation(lm)
  const o = openness(lm)
  if (o < 0.08 || o > 0.34) return 0
  if (dev > 0.045) return 0
  return Math.min(1, (0.045 - dev) / 0.045) * Math.min(1, (ext - 2) / 2)
}

type FrameSample = {
  t: number
  openness: number
  span: number
  wrist: HandLM
  ext: number
  chop: number
  fist: boolean
}

const HISTORY_MAX = 28
const COOLDOWN_MS = 520

/**
 * 基于短序列与简单运动学触发三种离散事件；带冷却避免连发。
 */
export class GestureEventDetector {
  private history: FrameSample[] = []
  private lastEmitAt = -1e9

  reset(): void {
    this.history = []
    this.lastEmitAt = -1e9
  }

  push(lm: HandLM[], nowMs: number): GestureHit | null {
    const o = openness(lm)
    const span = palmSpanXY(lm)
    const ext = countExtendedFingers(lm)
    const chop = chopPoseScore(lm)
    const fist = isFistLike(lm)

    this.history.push({
      t: nowMs,
      openness: o,
      span,
      wrist: { x: lm[WRIST].x, y: lm[WRIST].y },
      ext,
      chop,
      fist,
    })
    if (this.history.length > HISTORY_MAX) this.history.shift()

    if (nowMs - this.lastEmitAt < COOLDOWN_MS) return null
    if (this.history.length < 6) return null

    const hit =
      this.tryGrab() ?? this.tryPunch() ?? this.tryChop()
    if (hit) this.lastEmitAt = nowMs
    return hit
  }

  /** 抓：此前窗口曾张开，当前收拢（阈值放宽以提高灵敏度） */
  private tryGrab(): GestureHit | null {
    const h = this.history
    if (h.length < 9) return null
    const past = h.slice(-15, -3)
    const cur = h[h.length - 1]
    if (past.length < 4) return null

    const maxO = Math.max(...past.map((f) => f.openness))
    const maxExt = Math.max(...past.map((f) => f.ext))
    const drop = maxO - cur.openness
    if (
      maxExt >= 2 &&
      maxO > 0.118 &&
      drop > 0.018 &&
      cur.ext <= 3 &&
      cur.openness < 0.18
    ) {
      return hitFromSignal('grab')
    }
    return null
  }

  /** 冲拳： mostly握拳 + 手掌跨度缩短（近→远）或“先大后小”轨迹 */
  private tryPunch(): GestureHit | null {
    const h = this.history
    if (h.length < 7) return null
    const last = h.slice(-8)
    if (last.length < 8) return null

    const fistCount = last.filter((f) => f.fist).length
    if (fistCount < 6) return null

    const span0 = last[0].span
    const span1 = last[last.length - 1].span
    if (span0 <= 0.032) return null

    const ratio = span1 / span0
    const mid = last[Math.floor(last.length / 2)].span
    const valley =
      mid < span0 * 0.96 &&
      span1 < span0 * 0.94 &&
      span0 - Math.min(mid, span1) > span0 * 0.04

    if (ratio < 0.93 || valley) return hitFromSignal('punch')
    return null
  }

  /** 切：刀手 + 腕部快速划动 */
  private tryChop(): GestureHit | null {
    const h = this.history
    const win = h.slice(-8)
    if (win.length < 8) return null
    const chopOk = win.filter((f) => f.chop > 0.28).length >= 4
    if (!chopOk) return null

    let maxStep = 0
    for (let i = 1; i < win.length; i++) {
      const dx = win[i].wrist.x - win[i - 1].wrist.x
      const dy = win[i].wrist.y - win[i - 1].wrist.y
      maxStep = Math.max(maxStep, Math.hypot(dx, dy))
    }
    const span =
      Math.hypot(
        win[win.length - 1].wrist.x - win[0].wrist.x,
        win[win.length - 1].wrist.y - win[0].wrist.y,
      ) || 0
    if (maxStep > 0.0085 && span > 0.038) return hitFromSignal('chop')
    return null
  }
}

export function pickPrimaryHand(hands: HandLM[][]): HandLM[] | null {
  if (!hands.length) return null
  if (hands.length === 1) return hands[0]
  let best = hands[0]
  let bestSpan = palmSpanXY(best)
  for (let i = 1; i < hands.length; i++) {
    const s = palmSpanXY(hands[i])
    if (s > bestSpan) {
      best = hands[i]
      bestSpan = s
    }
  }
  return best
}

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

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * 拇指尖–食指尖在归一化图像 XY 上的距离 → 0~1：捏紧偏小、张开偏大。
 * 供音频等连续参数（如混响干湿）使用。
 */
export function thumbIndexSpread01(lm: HandLM[]): number {
  const d = dist(lm[THUMB_TIP], lm[INDEX_TIP])
  return smoothstep(0.028, 0.2, d)
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

/** 指尖是否相对指节“伸直”（相对腕部更远） */
function fingerExtended(lm: HandLM[], tip: number, pip: number): boolean {
  const wrist = lm[WRIST]
  const dt = dist(lm[tip], wrist)
  const dp = dist(lm[pip], wrist)
  return dt > dp * 1.022
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
  return ext <= 3 && o < 0.195
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

/** 四指尖共线：再放宽一档，CHOP 更容易成立 */
const CHOP_LINE_DEV_MAX = 0.078

/** 刀手姿态：多指伸直 + 四指尖近似一线 + 张开度中等 */
export function chopPoseScore(lm: HandLM[]): number {
  const ext = countExtendedFingers(lm)
  if (ext < 2) return 0
  const dev = tipsLineDeviation(lm)
  const o = openness(lm)
  if (o < 0.043 || o > 0.44) return 0
  if (ext < 3 && dev > 0.046) return 0
  if (dev > CHOP_LINE_DEV_MAX) return 0
  const lineQ = Math.min(1, (CHOP_LINE_DEV_MAX - dev) / CHOP_LINE_DEV_MAX)
  const extQ =
    ext >= 3 ? Math.min(1, (ext - 2) / 2) : Math.min(1, (ext - 1) / 2) * 0.72
  return lineQ * extQ
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

const HISTORY_MAX = 24
/** 略短冷却，CHOP/PUNCH 连做时更跟手 */
const COOLDOWN_MS = 275

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
    if (this.history.length < 4) return null

    /** 击打玩法优先：先判拳/刀手，避免「张→收」被 grab 抢走 */
    const hit =
      this.tryPunch() ?? this.tryChop() ?? this.tryGrab()
    if (hit) this.lastEmitAt = nowMs
    return hit
  }

  /** 抓：明确「先张得比较开」再收拢；收紧以减少与冲拳抢判 */
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
      maxExt >= 3 &&
      maxO > 0.128 &&
      drop > 0.026 &&
      cur.ext <= 2 &&
      cur.openness < 0.165
    ) {
      return hitFromSignal('grab')
    }
    return null
  }

  /** 冲拳：较短窗口 + 与刀手姿态互斥，降低延迟与误判 */
  private tryPunch(): GestureHit | null {
    const h = this.history
    if (h.length < 6) return null
    const last = h.slice(-6)
    if (last.length < 6) return null

    const fistCount = last.filter((f) => f.fist).length
    /** 提高「整段像拳」比例，减轻误触 PUNCH */
    if (fistCount < 5) return null

    const tail = last[last.length - 1]!
    const chopAvg =
      last.reduce((s, f) => s + f.chop, 0) / last.length
    /** 更像刀手时优先让给 CHOP（略收紧，减轻误拳） */
    if (tail.chop > 0.15 || chopAvg > 0.095) return null

    const span0 = last[0].span
    const span1 = tail.span
    if (span0 <= 0.025) return null

    const ratio = span1 / span0
    const mid = last[Math.floor(last.length / 2)].span
    const valley =
      mid < span0 * 0.98 &&
      span1 < span0 * 0.93 &&
      span0 - Math.min(mid, span1) > span0 * 0.035

    /** 需更明显收回或更深的「谷形」 */
    const sharpShrink = ratio < 0.936
    if (sharpShrink || valley) return hitFromSignal('punch')
    return null
  }

  /** 切：较短窗口 + 排除「大半程握拳」的误触 */
  private tryChop(): GestureHit | null {
    const h = this.history
    if (h.length < 6) return null
    const win = h.slice(-6)
    if (win.length < 6) return null

    /** 整窗「像拳」不超过 4 帧才允许 CHOP（与 PUNCH 五拳窗错开） */
    if (win.filter((f) => f.fist).length > 4) return null

    const chopStrongMin = 0.12
    const chopLooseMin = 0.065
    const chopStrong = win.filter((f) => f.chop > chopStrongMin).length
    const chopLoose = win.filter((f) => f.chop > chopLooseMin).length
    /** 有一段刀手分 + 至少两帧弱刀手，或一帧强刀手即可 */
    if (chopStrong < 1 && chopLoose < 2) return null

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

    const tail = win.slice(-3)
    let peakStep = 0
    for (let i = 1; i < tail.length; i++) {
      const dx = tail[i].wrist.x - tail[i - 1].wrist.x
      const dy = tail[i].wrist.y - tail[i - 1].wrist.y
      peakStep = Math.max(peakStep, Math.hypot(dx, dy))
    }

    if (
      maxStep > 0.004 &&
      span > 0.0135 &&
      (peakStep > 0.0032 || maxStep > 0.0052)
    ) {
      return hitFromSignal('chop')
    }
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

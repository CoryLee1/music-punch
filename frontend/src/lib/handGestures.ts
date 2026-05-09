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

/** 四指尖共线：略放宽，CHOP 更容易触发 */
const CHOP_LINE_DEV_MAX = 0.09

/** 刀手姿态：多指伸直 + 四指尖近似一线 + 张开度中等 */
export function chopPoseScore(lm: HandLM[]): number {
  const ext = countExtendedFingers(lm)
  if (ext < 2) return 0
  const dev = tipsLineDeviation(lm)
  const o = openness(lm)
  if (o < 0.036 || o > 0.48) return 0
  if (ext < 3 && dev > 0.052) return 0
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

const HISTORY_MAX = 30
/** 全局冷却略拉长，快摆时减轻 PUNCH/CHOP 连环误触 */
const COOLDOWN_MS = 320

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
    if (this.history.length < 5) return null

    /**
     * CHOP 优先于 PUNCH：刀手势与握拳在快动作下易混，先判 CHOP 再收紧 PUNCH。
     * PUNCH 仅认「外冲」（手掌在画面里变大），避免收拳/后撤 span 变小误触发。
     */
    const hit =
      this.tryChop() ?? this.tryPunch() ?? this.tryGrab()
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

  /** 冲拳：须整段保持拳形 + 手掌在画面内明显变大（靠近镜头/冲出），忌「越收越小」误触 */
  private tryPunch(): GestureHit | null {
    const h = this.history
    if (h.length < 9) return null
    const last = h.slice(-8)
    if (last.length < 8) return null

    const fistCount = last.filter((f) => f.fist).length
    /** 绝大部分帧须为拳；尾帧必须仍是拳（出拳末梢） */
    if (fistCount < 7 || !last[last.length - 1].fist) return null

    const tail = last[last.length - 1]!
    const chopAvg =
      last.reduce((s, f) => s + f.chop, 0) / last.length
    if (tail.chop > 0.12 || chopAvg > 0.072) return null

    const spanEarly =
      (last[0].span + last[1].span + last[2].span) / 3
    const spanLate =
      (last[last.length - 1].span +
        last[last.length - 2].span +
        last[last.length - 3].span) /
      3
    if (spanEarly < 0.028) return null

    /** 关键：后半程掌宽须高于前半程（外冲/靠近镜头），排除收拳 span 回落 */
    if (spanLate < spanEarly * 1.028) return null

    /** 手腕在窗内有可见位移，避免静止误触 */
    let wristTravel = 0
    for (let i = 1; i < last.length; i++) {
      const dx = last[i].wrist.x - last[i - 1].wrist.x
      const dy = last[i].wrist.y - last[i - 1].wrist.y
      wristTravel += Math.hypot(dx, dy)
    }
    if (wristTravel < 0.0075) return null

    return hitFromSignal('punch')
  }

  /** 切：较短窗口 + 排除「大半程握拳」的误触 */
  private tryChop(): GestureHit | null {
    const h = this.history
    if (h.length < 6) return null
    const win = h.slice(-6)
    if (win.length < 6) return null

    /** 与 PUNCH 的 7/8 拳窗错开：允许多一帧拳影，仍挡纯冲拳 */
    if (win.filter((f) => f.fist).length > 5) return null

    const chopStrongMin = 0.078
    const chopLooseMin = 0.038
    const chopStrong = win.filter((f) => f.chop > chopStrongMin).length
    const chopLoose = win.filter((f) => f.chop > chopLooseMin).length
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
      maxStep > 0.0024 &&
      span > 0.0085 &&
      (peakStep > 0.002 || maxStep > 0.0036)
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

import { useEffect, useRef, useCallback, type RefObject } from 'react'
import * as Tone from 'tone'
import type { GestureHit } from '../lib/handGestures'

/* ───── 火柴人动画 — 共用骨骼 & 通用渲染 ───── */

/**
 * 17 关节骨骼连接（拳击手 & 劈砍者共用）
 * 0:head 1:neck 2:lShoulder 3:lElbow 4:lFist
 * 5:rShoulder 6:rElbow 7:rFist 8:spine
 * 9:lHip 10:lKnee 11:lAnkle 12:lToe
 * 13:rHip 14:rKnee 15:rAnkle 16:rToe
 */
const STICK_BONES: [number, number][] = [
  [0,1],                          // head → neck
  [1,2],[2,3],[3,4],              // 左臂
  [1,5],[5,6],[6,7],              // 右臂
  [1,8],                          // 躯干
  [8,9],[9,10],[10,11],[11,12],   // 左腿
  [8,13],[13,14],[14,15],[15,16], // 右腿
]

/* ── 拳击手（PUNCH）帧数据 ── */

/** 每帧持续时间 (ms)：防守-蓄力-启动-全伸-保持-回收 */
const BOXER_TIMING = [600, 220, 100, 480, 200, 400]

/** 6 帧出拳动画关节坐标（归一化 0~1），每帧 17 个关节 [x,y] */
const BOXER_FRAMES: [number, number][][] = [
  // 0 — 防守站姿
  [
    [0.48,0.08],[0.48,0.19],
    [0.37,0.23],[0.32,0.15],[0.38,0.10],
    [0.59,0.23],[0.64,0.15],[0.58,0.10],
    [0.48,0.43],
    [0.42,0.47],[0.37,0.62],[0.35,0.77],[0.31,0.81],
    [0.54,0.47],[0.59,0.62],[0.61,0.77],[0.65,0.81],
  ],
  // 1 — 蓄力
  [
    [0.45,0.08],[0.45,0.19],
    [0.35,0.23],[0.29,0.16],[0.35,0.11],
    [0.55,0.23],[0.57,0.30],[0.50,0.24],
    [0.45,0.43],
    [0.39,0.48],[0.32,0.63],[0.28,0.78],[0.24,0.82],
    [0.51,0.48],[0.57,0.62],[0.62,0.77],[0.66,0.81],
  ],
  // 2 — 出拳启动
  [
    [0.42,0.08],[0.42,0.19],
    [0.32,0.23],[0.25,0.17],[0.30,0.11],
    [0.52,0.22],[0.66,0.21],[0.76,0.20],
    [0.42,0.43],
    [0.36,0.48],[0.27,0.63],[0.21,0.79],[0.17,0.83],
    [0.48,0.48],[0.57,0.63],[0.65,0.78],[0.69,0.82],
  ],
  // 3 — 全伸★
  [
    [0.37,0.07],[0.37,0.18],
    [0.27,0.22],[0.19,0.28],[0.24,0.19],
    [0.47,0.21],[0.65,0.20],[0.85,0.19],
    [0.39,0.41],
    [0.32,0.46],[0.21,0.62],[0.13,0.79],[0.07,0.84],
    [0.46,0.46],[0.58,0.63],[0.68,0.79],[0.74,0.84],
  ],
  // 4 — 保持 / 微回
  [
    [0.38,0.07],[0.38,0.18],
    [0.28,0.22],[0.21,0.27],[0.26,0.19],
    [0.48,0.21],[0.63,0.21],[0.79,0.20],
    [0.39,0.41],
    [0.33,0.46],[0.23,0.62],[0.15,0.79],[0.09,0.84],
    [0.45,0.46],[0.57,0.63],[0.66,0.79],[0.72,0.84],
  ],
  // 5 — 回收
  [
    [0.44,0.08],[0.44,0.19],
    [0.34,0.23],[0.28,0.16],[0.34,0.11],
    [0.54,0.23],[0.60,0.18],[0.56,0.13],
    [0.44,0.43],
    [0.38,0.47],[0.33,0.62],[0.30,0.78],[0.26,0.82],
    [0.50,0.47],[0.56,0.62],[0.58,0.77],[0.62,0.81],
  ],
]

/* ── 劈砍者（CHOP）帧数据 ── */

/** 每帧持续时间 (ms)：待机-抬手-蓄势-下劈-劈到底-回收 — 略慢于拳击手 */
const CHOP_TIMING = [720, 280, 140, 540, 260, 460]

/**
 * 6 帧劈砍动画关节坐标（归一化 0~1）
 * 右手从右上方高举划到左下方
 */
const CHOP_FRAMES: [number, number][][] = [
  // 0 — 待机站姿（双臂自然下垂、微弯，右手稍高）
  [
    [0.48,0.08],[0.48,0.19],
    [0.38,0.23],[0.33,0.32],[0.30,0.26],
    [0.58,0.23],[0.63,0.30],[0.66,0.22],
    [0.48,0.43],
    [0.42,0.47],[0.38,0.62],[0.36,0.77],[0.32,0.81],
    [0.54,0.47],[0.58,0.62],[0.60,0.77],[0.64,0.81],
  ],
  // 1 — 抬手蓄力（右手高举到右上方，身体微向左倾）
  [
    [0.46,0.09],[0.46,0.20],
    [0.36,0.24],[0.30,0.30],[0.27,0.24],
    [0.56,0.22],[0.67,0.12],[0.76,0.04],
    [0.46,0.43],
    [0.40,0.48],[0.35,0.63],[0.33,0.78],[0.29,0.82],
    [0.52,0.47],[0.57,0.62],[0.60,0.77],[0.64,0.81],
  ],
  // 2 — 蓄势顶点（右手到达最高点，身体略后仰）
  [
    [0.47,0.10],[0.47,0.21],
    [0.37,0.25],[0.31,0.31],[0.28,0.25],
    [0.57,0.23],[0.70,0.10],[0.80,0.02],
    [0.47,0.44],
    [0.41,0.48],[0.36,0.63],[0.34,0.78],[0.30,0.82],
    [0.53,0.47],[0.58,0.62],[0.61,0.77],[0.65,0.81],
  ],
  // 3 — 下劈中段★（右手快速下挥，经过身前）
  [
    [0.44,0.08],[0.44,0.19],
    [0.34,0.23],[0.28,0.29],[0.25,0.23],
    [0.54,0.22],[0.56,0.30],[0.50,0.36],
    [0.44,0.42],
    [0.38,0.47],[0.33,0.62],[0.30,0.78],[0.26,0.82],
    [0.50,0.46],[0.56,0.62],[0.60,0.77],[0.64,0.81],
  ],
  // 4 — 劈到底★（右手劈到左下方，身体前倾，力量到位）
  [
    [0.42,0.07],[0.42,0.18],
    [0.32,0.22],[0.25,0.28],[0.22,0.22],
    [0.52,0.21],[0.46,0.34],[0.36,0.44],
    [0.42,0.41],
    [0.36,0.46],[0.29,0.62],[0.24,0.79],[0.20,0.83],
    [0.48,0.46],[0.56,0.62],[0.62,0.78],[0.66,0.82],
  ],
  // 5 — 回收（手臂回缩，恢复待机姿态）
  [
    [0.46,0.08],[0.46,0.19],
    [0.36,0.23],[0.31,0.31],[0.28,0.25],
    [0.56,0.23],[0.60,0.26],[0.58,0.19],
    [0.46,0.43],
    [0.40,0.47],[0.36,0.62],[0.34,0.77],[0.30,0.81],
    [0.52,0.47],[0.57,0.62],[0.60,0.77],[0.64,0.81],
  ],
]

/* ───── 通用火柴人动画 hook ───── */

/**
 * 像素风火柴人逐帧动画 Canvas hook（通用）
 * 根据传入的帧数据 & 时序自动循环
 * handShape: 'circle' = 拳套圆形, 'triangle' = 刀手三角形
 */
function useStickFigureAnimation(
  frames: [number, number][][],
  timing: number[],
  handShape: 'circle' | 'triangle' = 'circle',
  paused = false,
  pausedFrame = 0,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef(0)

  useEffect(() => {
    const totalCycle = timing.reduce((a, b) => a + b, 0)
    const t0 = performance.now()

    const draw = () => {
      const canvas = canvasRef.current
      if (!canvas) { rafRef.current = requestAnimationFrame(draw); return }
      const ctx = canvas.getContext('2d')
      if (!ctx) { rafRef.current = requestAnimationFrame(draw); return }

      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) {
        rafRef.current = requestAnimationFrame(draw); return
      }
      const w = rect.width, h = rect.height
      canvas.width = w * dpr; canvas.height = h * dpr
      ctx.scale(dpr, dpr)

      /* ── 决定当前帧（暂停时固定指定帧） ── */
      let idx = pausedFrame
      if (!paused) {
        const cycleT = (performance.now() - t0) % totalCycle
        let acc = 0
        for (let i = 0; i < timing.length; i++) {
          acc += timing[i]
          if (cycleT < acc) { idx = i; break }
        }
      }

      /* ── 像素网格（方形点阵风格） ── */
      const PX = 3              // 每个方块的屏幕尺寸
      const GAP = 1             // 方块间距（以 PX 为单位）
      const STEP = PX + GAP     // 点阵步长
      const cols = Math.floor(w / STEP)
      const rows = Math.floor(h / STEP)
      const pad = 1
      const dCols = cols - pad * 2
      const dRows = rows - pad * 2

      // 浅底
      ctx.fillStyle = '#c8c8c8'
      ctx.fillRect(0, 0, w, h)

      // 画一个方形点阵块
      const putDot = (c: number, r: number, color: string) => {
        if (c >= 0 && c < cols && r >= 0 && r < rows) {
          ctx.fillStyle = color
          ctx.fillRect(c * STEP, r * STEP, PX, PX)
        }
      }

      // 点阵 Bresenham 线（离散方块，天然有间隔）
      const dotLine = (x0: number, y0: number, x1: number, y1: number, color: string) => {
        let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0)
        const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
        let err = dx - dy, cx = x0, cy = y0
        for (let s = 0; s < 500; s++) {
          putDot(cx, cy, color)
          if (cx === x1 && cy === y1) break
          const e2 = 2 * err
          if (e2 > -dy) { err -= dy; cx += sx }
          if (e2 < dx) { err += dx; cy += sy }
        }
      }

      // 点阵 Bresenham 圆轮廓
      const dotCircle = (cx: number, cy: number, r: number, color: string) => {
        let x = r, y = 0, e = 1 - r
        while (x >= y) {
          putDot(cx+x,cy+y,color); putDot(cx-x,cy+y,color)
          putDot(cx+x,cy-y,color); putDot(cx-x,cy-y,color)
          putDot(cx+y,cy+x,color); putDot(cx-y,cy+x,color)
          putDot(cx+y,cy-x,color); putDot(cx-y,cy-x,color)
          y++
          if (e < 0) e += 2 * y + 1
          else { x--; e += 2 * (y - x) + 1 }
        }
      }

      // 缩小到 76%，水平居中，垂直下沉靠近底部文字
      const SC = 0.76
      const OX = (1 - SC) / 2
      const OY = 0.20
      const toG = (nx: number, ny: number): [number, number] => [
        Math.round(pad + (OX + nx * SC) * dCols),
        Math.round(pad + (OY + ny * SC) * dRows),
      ]

      const fr = frames[idx]
      const dotC = 'rgba(0, 0, 0, 0.75)'
      const solidC = 'rgba(0, 0, 0, 0.9)'

      /* ── 1. 骨骼线（点阵） ── */
      for (const [a, b] of STICK_BONES) {
        const [ax, ay] = toG(fr[a][0], fr[a][1])
        const [bx, by] = toG(fr[b][0], fr[b][1])
        dotLine(ax, ay, bx, by, dotC)
      }

      /* ── 2. 头部点阵圆（r=3） ── */
      const [hx, hy] = toG(fr[0][0], fr[0][1])
      dotCircle(hx, hy, 3, solidC)

      /* ── 3. 左手 ── */
      const [lx, ly] = toG(fr[4][0], fr[4][1])
      if (handShape === 'triangle') {
        const [ex, ey] = toG(fr[3][0], fr[3][1])
        const ddx = lx - ex, ddy = ly - ey
        const len = Math.sqrt(ddx * ddx + ddy * ddy) || 1
        const ux = ddx / len, uy = ddy / len
        const ppx = -uy, ppy = ux
        const R = 3
        const tipX = Math.round(lx + ux * R), tipY = Math.round(ly + uy * R)
        const bLx = Math.round(lx - ux * 1 + ppx * 2), bLy = Math.round(ly - uy * 1 + ppy * 2)
        const bRx = Math.round(lx - ux * 1 - ppx * 2), bRy = Math.round(ly - uy * 1 - ppy * 2)
        dotLine(tipX, tipY, bLx, bLy, solidC)
        dotLine(bLx, bLy, bRx, bRy, solidC)
        dotLine(bRx, bRy, tipX, tipY, solidC)
      } else {
        dotCircle(lx, ly, 2, solidC)
      }

      /* ── 4. 右手 ── */
      const [rx, ry] = toG(fr[7][0], fr[7][1])
      if (handShape === 'triangle') {
        const [ex, ey] = toG(fr[6][0], fr[6][1])
        const ddx = rx - ex, ddy = ry - ey
        const len = Math.sqrt(ddx * ddx + ddy * ddy) || 1
        const ux = ddx / len, uy = ddy / len
        const ppx = -uy, ppy = ux
        const R = 3
        const tipX = Math.round(rx + ux * R), tipY = Math.round(ry + uy * R)
        const bLx = Math.round(rx - ux * 1 + ppx * 2), bLy = Math.round(ry - uy * 1 + ppy * 2)
        const bRx = Math.round(rx - ux * 1 - ppx * 2), bRy = Math.round(ry - uy * 1 - ppy * 2)
        dotLine(tipX, tipY, bLx, bLy, solidC)
        dotLine(bLx, bLy, bRx, bRy, solidC)
        dotLine(bRx, bRy, tipX, tipY, solidC)
      } else {
        dotCircle(rx, ry, 2, solidC)
      }

      /* ── 5. 脚部（2×2 点阵块） ── */
      for (const toeI of [12, 16]) {
        const [tx, ty] = toG(fr[toeI][0], fr[toeI][1])
        putDot(tx, ty, solidC)
        putDot(tx + 1, ty, solidC)
        putDot(tx, ty + 1, solidC)
        putDot(tx + 1, ty + 1, solidC)
      }

      /* ── 6. 关节点 ── */
      for (let i = 0; i < fr.length; i++) {
        if (i === 0 || i === 4 || i === 7 || i === 12 || i === 16) continue
        const [gx, gy] = toG(fr[i][0], fr[i][1])
        putDot(gx, gy, 'rgba(0, 0, 0, 0.5)')
      }

      /* ── 7. CRT 扫描线（极淡） ── */
      for (let sy = 0; sy < h; sy += 4) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.04)'
        ctx.fillRect(0, sy, w, 1)
      }

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [frames, timing, paused])

  return canvasRef
}

/* ───── 类型 ───── */
export type AppPhase = 'idle' | 'loading' | 'active' | 'ending' | 'over'

interface ControlPanelProps {
  phase: AppPhase
  emotion: string
  elapsed: number
  isPaused: boolean
  onTogglePause: () => void
  onStop: () => void
  onReset: () => void
  apiState: 'idle' | 'ok' | 'err'
  /** 手势/音频相关 */
  gestureBanner?: GestureHit | null
  clipLabel?: string
  audioStarted?: boolean
  /** 摄像头预览 */
  videoRef?: RefObject<HTMLVideoElement | null>
  cameraReady?: boolean
}


/* ───── 摄像头 HUD ───── */
function useCameraHUD(
  videoRef: RefObject<HTMLVideoElement | null> | undefined,
  cameraReady: boolean,
) {
  const hudCanvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef(0)
  const frameRef = useRef(0)

  useEffect(() => {
    if (!cameraReady) return
    const draw = () => {
      const canvas = hudCanvasRef.current
      const video = videoRef?.current
      if (!canvas || !video || video.videoWidth === 0) {
        rafRef.current = requestAnimationFrame(draw)
        return
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) { rafRef.current = requestAnimationFrame(draw); return }

      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.scale(dpr, dpr)
      const w = rect.width
      const h = rect.height
      ctx.clearRect(0, 0, w, h)

      const fr = frameRef.current++
      // 半透明 HUD 叠加
      ctx.strokeStyle = 'rgba(0, 160, 184, 0.15)'
      ctx.lineWidth = 0.5
      // 角标
      const corner = 10
      // 左上
      ctx.beginPath()
      ctx.moveTo(4, 4 + corner); ctx.lineTo(4, 4); ctx.lineTo(4 + corner, 4)
      ctx.stroke()
      // 右上
      ctx.beginPath()
      ctx.moveTo(w - 4 - corner, 4); ctx.lineTo(w - 4, 4); ctx.lineTo(w - 4, 4 + corner)
      ctx.stroke()
      // 左下
      ctx.beginPath()
      ctx.moveTo(4, h - 4 - corner); ctx.lineTo(4, h - 4); ctx.lineTo(4 + corner, h - 4)
      ctx.stroke()
      // 右下
      ctx.beginPath()
      ctx.moveTo(w - 4 - corner, h - 4); ctx.lineTo(w - 4, h - 4); ctx.lineTo(w - 4, h - 4 - corner)
      ctx.stroke()

      // 中心十字
      const cx = w / 2, cy = h / 2
      ctx.strokeStyle = 'rgba(0, 160, 184, 0.12)'
      ctx.lineWidth = 0.4
      ctx.setLineDash([3, 5])
      ctx.beginPath(); ctx.moveTo(cx - 14, cy); ctx.lineTo(cx + 14, cy); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(cx, cy - 14); ctx.lineTo(cx, cy + 14); ctx.stroke()
      ctx.setLineDash([])

      // 标签
      ctx.font = '7px "IBM Plex Mono", monospace'
      ctx.fillStyle = 'rgba(0, 160, 184, 0.35)'
      ctx.textBaseline = 'top'
      ctx.fillText('CAM', 8, 6)

      // 闪烁录制指示
      if (Math.floor(fr / 30) % 2 === 0) {
        ctx.fillStyle = 'rgba(255, 80, 60, 0.5)'
        ctx.beginPath()
        ctx.arc(w - 10, 10, 2.5, 0, Math.PI * 2)
        ctx.fill()
      }

      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [cameraReady, videoRef])

  return hudCanvasRef
}

/* ───── 音频波形可视化 ───── */
/** 竖条柱状音频可视化 — 类似均衡器 bar 图 */
function useWaveformVisualizer(phase: AppPhase) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const analyserRef = useRef<Tone.Analyser | null>(null)
  const rafRef = useRef<number>(0)

  /** 柱状图参数 */
  const BAR_COUNT = 40
  const BAR_GAP = 2       // px gap between bars
  const MIN_BAR_H = 2     // 最小柱高（idle 时的静态小竖条）
  const GAIN = 2.5

  // 非 active 时画静态小竖条排列
  useEffect(() => {
    if (phase === 'active') return
    const drawIdle = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.scale(dpr, dpr)
      const w = rect.width
      const h = rect.height
      ctx.clearRect(0, 0, w, h)

      const totalBarW = (w - (BAR_COUNT - 1) * BAR_GAP) / BAR_COUNT
      const barW = Math.max(1, totalBarW)
      const cy = h / 2

      ctx.fillStyle = 'rgba(0, 160, 184, 0.35)'
      for (let i = 0; i < BAR_COUNT; i++) {
        const x = i * (barW + BAR_GAP)
        const barH = MIN_BAR_H
        ctx.fillRect(x, cy - barH / 2, barW, barH)
      }
    }
    drawIdle()
    const obs = new ResizeObserver(() => drawIdle())
    if (canvasRef.current) obs.observe(canvasRef.current)
    return () => obs.disconnect()
  }, [phase])

  // active 时接入 Tone.js analyser 画竖条柱状图
  useEffect(() => {
    if (phase !== 'active') return
    const analyser = new Tone.Analyser('waveform', 256)
    Tone.getDestination().connect(analyser)
    analyserRef.current = analyser

    const draw = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.scale(dpr, dpr)

      const w = rect.width
      const h = rect.height
      const cy = h / 2

      ctx.clearRect(0, 0, w, h)

      const values = analyser.getValue() as Float32Array
      const len = values.length
      const samplesPerBar = Math.floor(len / BAR_COUNT)

      const totalBarW = (w - (BAR_COUNT - 1) * BAR_GAP) / BAR_COUNT
      const barW = Math.max(1, totalBarW)

      ctx.fillStyle = 'rgba(0, 160, 184, 0.75)'

      for (let i = 0; i < BAR_COUNT; i++) {
        // 取该段样本的 RMS
        let sum = 0
        const start = i * samplesPerBar
        for (let j = start; j < start + samplesPerBar && j < len; j++) {
          sum += values[j] * values[j]
        }
        const rms = Math.sqrt(sum / samplesPerBar)
        const amplitude = Math.min(1, rms * GAIN)
        const barH = Math.max(MIN_BAR_H, amplitude * (h * 0.9))

        const x = i * (barW + BAR_GAP)
        ctx.fillRect(x, cy - barH / 2, barW, barH)
      }

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(rafRef.current)
      analyser.dispose()
      analyserRef.current = null
    }
  }, [phase])

  return canvasRef
}

/* ───── 组件 ───── */
export function ControlPanel({
  phase,
  emotion,
  elapsed,
  isPaused,
  onTogglePause,
  onStop,
  onReset,
  apiState,
  gestureBanner,
  clipLabel = '内置 · sample.wav',
  audioStarted = false,
  videoRef,
  cameraReady = false,
}: ControlPanelProps) {
  void emotion
  void onReset

  const waveCanvasRef = useWaveformVisualizer(phase)
  const hudCanvasRef = useCameraHUD(videoRef, cameraReady)
  const animPaused = phase === 'active' || phase === 'ending'
  const chopCanvasRef = useStickFigureAnimation(CHOP_FRAMES, CHOP_TIMING, 'triangle', animPaused, 2)
  const boxerCanvasRef = useStickFigureAnimation(BOXER_FRAMES, BOXER_TIMING, 'circle', animPaused, 3)

  /** 格式化已运行时间 mm:ss */
  const formatElapsed = useCallback((s: number) => {
    const total = Math.floor(Math.max(0, s))
    const mm = String(Math.floor(total / 60)).padStart(2, '0')
    const ss = String(total % 60).padStart(2, '0')
    return `${mm}:${ss}`
  }, [])


  return (
    <aside className="app-panel">
      {/* ═══ 区域 1：动作区 ═══ */}
      <section className="panel-zone zone-gesture">
        <div className="zone-header">
          <span className="zone-title">
            [1] Enable Camera
            <span className="zone-title-sub">开启摄像头</span>
          </span>
          <span className={`panel-status ${apiState === 'ok' ? 'connected' : ''}`}>
            {apiState === 'ok' ? '● ONLINE' : apiState === 'err' ? '○ OFFLINE' : '…'}
          </span>
        </div>

        {/* 摄像头预览 */}
        <div className="panel-camera">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transform: 'scaleX(-1)',
              visibility: cameraReady ? 'visible' : 'hidden',
            }}
          />
          <canvas ref={hudCanvasRef} className="camera-hud-canvas" />
          {!cameraReady && (
            <div className="panel-camera-overlay">
              <span className="camera-off-label">Awaiting Camera</span>
            </div>
          )}
          {/* 蓝色取景参考线叠层 */}
          <div className="camera-reticle" aria-hidden>
            {/* 四角括号 */}
            <span className="reticle-corner reticle-tl" />
            <span className="reticle-corner reticle-tr" />
            <span className="reticle-corner reticle-bl" />
            <span className="reticle-corner reticle-br" />
            {/* 三等分参考线 */}
            <span className="reticle-line reticle-h reticle-h1" />
            <span className="reticle-line reticle-h reticle-h2" />
            <span className="reticle-line reticle-v reticle-v1" />
            <span className="reticle-line reticle-v reticle-v2" />
            {/* 中心十字 */}
            <span className="reticle-cross-h" />
            <span className="reticle-cross-v" />
            {/* 标签 */}
            <span className="reticle-tag reticle-tag-tl">REC</span>
            <span className="reticle-tag reticle-tag-br">CAM—01</span>
          </div>
        </div>

        {/* Step 2 标题 */}
        <div className="zone-header zone-header-inner">
          <span className="zone-title">
            [2] Get Ready
            <span className="zone-title-sub">准备出击</span>
          </span>
        </div>

        {/* 双手势像素图 */}
        <div className="panel-gesture-duo">
          <div className="gesture-line-card">
            <canvas ref={chopCanvasRef} className="gesture-line-canvas" />
            <span className="gesture-line-label">CHOP · 快划</span>
          </div>
          <div className="gesture-line-card">
            <canvas ref={boxerCanvasRef} className="gesture-line-canvas" />
            <span className="gesture-line-label">PUNCH · 拳击</span>
          </div>
        </div>

        {/* 最近手势事件 */}
        <div className="panel-gesture-banner">
          <span className="gesture-banner-label">LAST</span>
          <span className="gesture-banner-value">
            {gestureBanner ? `${gestureBanner.labelZh} · ${gestureBanner.labelEn}` : 'IDLE'}
          </span>
        </div>
      </section>

      {/* ═══ 区域 2：音乐区 ═══ */}
      <section className="panel-zone zone-audio">
        <div className="zone-header">
          <span className="zone-title">
            [3] Follow the Beat
            <span className="zone-title-sub">音乐画面一起</span>
          </span>
          <span className="zone-status">{audioStarted ? '▶ PLAYING' : '■ STOPPED'}</span>
        </div>

        <div className="panel-audio-controls">
          <span className="audio-label">// {clipLabel}</span>
          <div className="panel-visualizer">
            <div className="visualizer-canvas">
              <canvas ref={waveCanvasRef} />
            </div>
          </div>
        </div>
      </section>

      {/* ═══ 区域 3：计时区 ═══ */}
      <section className="panel-zone zone-timer">
        <div className="zone-header">
          <span className="zone-title">Timer</span>
          <span className="zone-status">{phase.toUpperCase()}</span>
        </div>

        <div className="panel-timer">
          <span className="timer-display">
            {phase === 'active' || phase === 'ending' ? formatElapsed(elapsed) : '--:--'}
          </span>
        </div>

        <div className="panel-controls">
          {phase === 'active' && (
            <div className="control-row">
              <button className="control-btn" onClick={onTogglePause} type="button">
                {isPaused ? '▶ Resume' : '⏸ Pause'}
              </button>
              <button className="control-btn danger" onClick={onStop} type="button">
                ■ Stop
              </button>
            </div>
          )}
        </div>
      </section>
    </aside>
  )
}

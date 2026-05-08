import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react'
import type { SampleBeatMeta } from '../lib/beatSync'
import {
  beatLocalTau,
  beatTimesForBufferDuration,
  countBeatCrossings,
  tauToGestureAnimPhase01,
} from '../lib/beatSync'
import {
  drawChopHintFrame,
  drawPunchHintFrame,
  setupHintCanvasDpi,
} from '../lib/gestureHintDraw'
import sampleBeatsJson from '../data/sample-beats.json'

const BEATS_META = sampleBeatsJson as SampleBeatMeta

const CANVAS_LOGICAL = 118
const BEATS_PER_MODE = 10

export type BeatGestureHintHandle = {
  sync: (
    playbackSec: number,
    bufferDurSec: number,
    active: boolean,
    syncGeneration: number,
  ) => void
}

export type BeatGestureHintProps = {
  /** 粒子击打成功时递增，触发当前节拍数字弹跳 */
  hitTick?: number
}

export const BeatGestureHint = forwardRef<
  BeatGestureHintHandle,
  BeatGestureHintProps
>(function BeatGestureHint({ hitTick = 0 }, ref) {
    const innerRef = useRef<HTMLDivElement>(null)
    const punchRef = useRef<HTMLCanvasElement>(null)
    const chopRef = useRef<HTMLCanvasElement>(null)
    const dprPunch = useRef(1)
    const dprChop = useRef(1)
    const lastPosRef = useRef<number | null>(null)
    const totalBeatsRef = useRef(0)
    const lastDurRef = useRef(0)
    const lastGenRef = useRef<number | null>(null)
    const modeRef = useRef<HTMLSpanElement>(null)
    const countNowRef = useRef<HTMLSpanElement>(null)
    const beatSyncPopTimerRef = useRef<ReturnType<
      typeof window.setTimeout
    > | null>(null)

    const resizeBoth = () => {
      const pc = punchRef.current
      const cc = chopRef.current
      if (pc) dprPunch.current = setupHintCanvasDpi(pc, CANVAS_LOGICAL)
      if (cc) dprChop.current = setupHintCanvasDpi(cc, CANVAS_LOGICAL)
    }

    useEffect(() => {
      resizeBoth()
      window.addEventListener('resize', resizeBoth)
      return () => window.removeEventListener('resize', resizeBoth)
    }, [])

    useEffect(() => {
      if (!hitTick) return
      const el = innerRef.current
      if (!el) return
      el.classList.remove('is-beat-hit-pop')
      requestAnimationFrame(() => {
        el.classList.add('is-beat-hit-pop')
      })
      const t = window.setTimeout(() => {
        el.classList.remove('is-beat-hit-pop')
      }, 560)
      return () => window.clearTimeout(t)
    }, [hitTick])

    useImperativeHandle(
      ref,
      () => ({
        sync: (playbackSec, bufferDurSec, active, syncGeneration) => {
          const pc = punchRef.current
          const cc = chopRef.current
          if (!pc || !cc) return

          if (!active || bufferDurSec <= 0.05) {
            lastPosRef.current = null
            totalBeatsRef.current = 0
            lastDurRef.current = 0
            lastGenRef.current = null
            const ctxP = pc.getContext('2d')
            const ctxC = cc.getContext('2d')
            ctxP?.clearRect(0, 0, pc.width, pc.height)
            ctxC?.clearRect(0, 0, cc.width, cc.height)
            return
          }

          if (lastGenRef.current !== syncGeneration) {
            lastGenRef.current = syncGeneration
            lastPosRef.current = null
            totalBeatsRef.current = 0
          }

          if (
            lastDurRef.current <= 0 ||
            Math.abs(bufferDurSec - lastDurRef.current) > 0.02
          ) {
            lastDurRef.current = bufferDurSec
            lastPosRef.current = null
            totalBeatsRef.current = 0
          }

          const beats = beatTimesForBufferDuration(BEATS_META, bufferDurSec)
          const pos = playbackSec

          if (lastPosRef.current === null) {
            lastPosRef.current = pos
          } else {
            const crossed = countBeatCrossings(
              lastPosRef.current,
              pos,
              bufferDurSec,
              beats,
            )
            totalBeatsRef.current += crossed
            if (crossed > 0) {
              const el = countNowRef.current
              if (el) {
                const prev = beatSyncPopTimerRef.current
                if (prev != null) window.clearTimeout(prev)
                el.classList.remove('is-beat-sync-pop')
                requestAnimationFrame(() => {
                  el.classList.add('is-beat-sync-pop')
                })
                beatSyncPopTimerRef.current = window.setTimeout(() => {
                  el.classList.remove('is-beat-sync-pop')
                }, 440)
              }
            }
            lastPosRef.current = pos
          }

          const modeIndex =
            Math.floor(totalBeatsRef.current / BEATS_PER_MODE) % 2
          const isPunch = modeIndex === 0

          const tau = beatLocalTau(pos, bufferDurSec, beats)
          const phase = tauToGestureAnimPhase01(tau)

          const ctxP = pc.getContext('2d')
          const ctxC = cc.getContext('2d')
          if (!ctxP || !ctxC) return

          if (isPunch) {
            drawPunchHintFrame(ctxP, dprPunch.current, CANVAS_LOGICAL, phase)
            ctxC.setTransform(dprChop.current, 0, 0, dprChop.current, 0, 0)
            ctxC.clearRect(0, 0, cc.width, cc.height)
          } else {
            drawChopHintFrame(ctxC, dprChop.current, CANVAS_LOGICAL, phase)
            ctxP.setTransform(dprPunch.current, 0, 0, dprPunch.current, 0, 0)
            ctxP.clearRect(0, 0, pc.width, pc.height)
          }

          const modeEl = modeRef.current
          const nEl = countNowRef.current
          const n = (totalBeatsRef.current % BEATS_PER_MODE) + 1
          if (modeEl) modeEl.textContent = isPunch ? 'PUNCH' : 'CHOP'
          if (nEl) nEl.textContent = String(n)
        },
      }),
      [],
    )

    return (
      <div className="beat-gesture-hint">
        <div ref={innerRef} className="beat-gesture-hint-inner">
          <div className="beat-gesture-hint-stack">
            <canvas
              ref={punchRef}
              className="beat-gesture-hint-canvas"
              aria-hidden
            />
            <canvas
              ref={chopRef}
              className="beat-gesture-hint-canvas"
              aria-hidden
            />
          </div>
          <div className="beat-gesture-hint-label" aria-live="polite">
            <span ref={modeRef} className="beat-gesture-hint-mode" />
            <span className="beat-gesture-hint-count">
              <span ref={countNowRef} className="beat-gesture-hint-count-now" />
              <span className="beat-gesture-hint-count-sep">/</span>
              <span className="beat-gesture-hint-count-max">
                {BEATS_PER_MODE}
              </span>
            </span>
          </div>
        </div>
      </div>
    )
  },
)

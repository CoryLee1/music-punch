import { useState, useCallback, useEffect, useRef } from 'react'
import type { HandLandmarker } from '@mediapipe/tasks-vision'
import { createRobustHandLandmarker, releaseRobustHandLandmarker } from '../lib/mediapipeHandLandmarker'
import {
  GestureEventDetector,
  pickPrimaryHand,
  type HandLM,
} from '../lib/handGestures'

/** 可捶打的元素列表，循环轮换 */
const SMASH_ITEMS = [
  { okSrc: '/smash/can-ok.png', hitSrc: '/smash/can-hit.png', label: '易拉罐' },
  { okSrc: '/smash/box-ok.png', hitSrc: '/smash/box-hit.png', label: '纸箱' },
]

/** 每个元素被打多少次后自动切换到下一个 */
const HITS_PER_ITEM = 3

interface SmashEasterEggProps {
  /** 外部共享的摄像头流 — 避免重复 getUserMedia */
  cameraStream?: MediaStream | null
}

/**
 * 解压彩蛋：替换左侧画布区域。
 * 干净白底 + 物品居中，出拳手势 → 切换为被打状态 + 震动动画。
 * 每个元素被打 3 次后自动切换到下一个，两个元素无限循环。
 * 使用外部共享摄像头流 + 独立 MediaPipe 手势检测。
 */
export function SmashEasterEgg({ cameraStream = null }: SmashEasterEggProps) {
  const [isHit, setIsHit] = useState(false)
  const [shaking, setShaking] = useState(false)
  const [, setItemHitCount] = useState(0)
  const [currentItemIdx, setCurrentItemIdx] = useState(0)
  const [gestureStatus, setGestureStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  const shakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const switchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const landmarkerRef = useRef<HandLandmarker | null>(null)
  const gestureDetectorRef = useRef(new GestureEventDetector())
  const rafRef = useRef(0)
  const mountedRef = useRef(true)

  const currentItem = SMASH_ITEMS[currentItemIdx]!

  const triggerHit = useCallback(() => {
    setIsHit(true)
    setShaking(true)

    setItemHitCount((prev) => {
      const next = prev + 1
      if (next >= HITS_PER_ITEM) {
        if (switchTimerRef.current) clearTimeout(switchTimerRef.current)
        switchTimerRef.current = setTimeout(() => {
          setCurrentItemIdx((i) => (i + 1) % SMASH_ITEMS.length)
          setItemHitCount(0)
          setIsHit(false)
        }, 1200)
      }
      return next
    })

    if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current)
    if (recoverTimerRef.current) clearTimeout(recoverTimerRef.current)

    shakeTimerRef.current = setTimeout(() => setShaking(false), 400)
    recoverTimerRef.current = setTimeout(() => setIsHit(false), 1600)
  }, [])

  const handleClick = useCallback(() => triggerHit(), [triggerHit])

  // 加载 MediaPipe 手部模型（全局单例，卸载时递减引用）
  useEffect(() => {
    mountedRef.current = true
    let cancelled = false

    void (async () => {
      try {
        const landmarker = await createRobustHandLandmarker()
        if (cancelled) return          // 单例不需要手动 close
        landmarkerRef.current = landmarker
        if (!cancelled) setGestureStatus(cameraStream ? 'ready' : 'loading')
      } catch {
        if (!cancelled) setGestureStatus('error')
      }
    })()

    return () => {
      cancelled = true
      mountedRef.current = false
      landmarkerRef.current = null     // 清引用但不 close（单例管理）
      releaseRobustHandLandmarker()    // 递减引用计数
      gestureDetectorRef.current.reset()
    }
  }, [])

  // 使用共享的摄像头流 + 手势检测循环
  useEffect(() => {
    const video = videoRef.current
    if (!video || !cameraStream) return
    let cancelled = false

    video.srcObject = cameraStream
    video.play().then(() => {
      if (!cancelled && landmarkerRef.current) {
        setGestureStatus('ready')
      }
    }).catch(() => {
      /* 静默失败 */
    })

    const detect = () => {
      if (cancelled) return
      if (video.readyState >= 2 && landmarkerRef.current) {
        const result = landmarkerRef.current.detectForVideo(video, performance.now())
        if (result.landmarks && result.landmarks.length > 0) {
          const hands = result.landmarks as HandLM[][]
          const primary = pickPrimaryHand(hands)
          if (primary) {
            const hit = gestureDetectorRef.current.push(primary, performance.now())
            if (hit && (hit.signal === 'punch' || hit.signal === 'chop')) {
              triggerHit()
            }
          }
        }
      }
      rafRef.current = requestAnimationFrame(detect)
    }
    rafRef.current = requestAnimationFrame(detect)

    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
      video.pause()
      video.srcObject = null
    }
  }, [cameraStream, triggerHit])

  // cleanup timers
  useEffect(() => {
    return () => {
      if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current)
      if (recoverTimerRef.current) clearTimeout(recoverTimerRef.current)
      if (switchTimerRef.current) clearTimeout(switchTimerRef.current)
    }
  }, [])

  return (
    <div className="smash-stage">
      {/* 隐藏的摄像头视频元素 */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: 'none',
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
        }}
      />

      {/* 手势状态指示 */}
      <div className="smash-stage-status">
        {gestureStatus === 'loading' && '// LOADING GESTURE MODEL...'}
        {gestureStatus === 'ready' && '// GESTURE READY · PUNCH TO SMASH'}
        {gestureStatus === 'error' && '// GESTURE N/A · CLICK TO SMASH'}
      </div>

      {/* 当前可捶打元素 */}
      <div
        className={`smash-stage-target ${shaking ? 'is-shaking' : ''} ${isHit ? 'is-hit' : ''}`}
        onClick={handleClick}
      >
        <img
          src={isHit ? currentItem.hitSrc : currentItem.okSrc}
          alt={currentItem.label}
          className="smash-stage-img"
          draggable={false}
        />
      </div>

      {/* 底部提示 */}
      <div className="smash-stage-hint">
        出拳捶打 · 释放压力
      </div>
    </div>
  )
}

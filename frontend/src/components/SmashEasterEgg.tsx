import { useState, useCallback, useEffect, useRef } from 'react'
import type { HandLandmarker } from '@mediapipe/tasks-vision'
import { createRobustHandLandmarker } from '../lib/mediapipeHandLandmarker'
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

/**
 * 解压彩蛋：替换左侧画布区域。
 * 干净白底 + 物品居中，出拳手势 → 切换为被打状态 + 震动动画。
 * 每个元素被打 3 次后自动切换到下一个，两个元素无限循环。
 * 内嵌独立的摄像头 + MediaPipe 手势检测，不依赖外部 GestureStage。
 */
export function SmashEasterEgg({ cameraStream }: { cameraStream?: MediaStream | null }) {
  const [isHit, setIsHit] = useState(false)
  const [shaking, setShaking] = useState(false)
  const [_itemHitCount, setItemHitCount] = useState(0)   // 当前元素局部打击次数
  const [currentItemIdx, setCurrentItemIdx] = useState(0) // 当前元素索引
  const [gestureStatus, setGestureStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  const shakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const switchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const landmarkerRef = useRef<HandLandmarker | null>(null)
  const gestureDetectorRef = useRef(new GestureEventDetector())
  const rafRef = useRef(0)
  const mountedRef = useRef(true)

  const currentItem = SMASH_ITEMS[currentItemIdx]

  const triggerHit = useCallback(() => {
    setIsHit(true)
    setShaking(true)

    // 局部计数 +1，到达阈值后自动切换元素
    setItemHitCount((prev) => {
      const next = prev + 1
      if (next >= HITS_PER_ITEM) {
        // 延迟切换，让最后一次打击动画播完
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

  // 点击也可以触发（备用交互）
  const handleClick = useCallback(() => triggerHit(), [triggerHit])

  // 启动摄像头 + MediaPipe 手势检测循环
  useEffect(() => {
    mountedRef.current = true
    let cancelled = false

    const init = async () => {
      try {
        // 1. 加载 MediaPipe 手部模型
        const landmarker = await createRobustHandLandmarker()
        if (cancelled) { landmarker.close(); return }
        landmarkerRef.current = landmarker

        // 2. 启动摄像头（优先使用共享流）
        let stream: MediaStream
        if (cameraStream) {
          stream = cameraStream
        } else {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' },
            audio: false,
          })
          if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        }
        streamRef.current = stream

        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play()

        if (!cancelled) setGestureStatus('ready')

        // 3. 检测循环
        const detect = () => {
          if (cancelled || !mountedRef.current) return
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
      } catch {
        if (!cancelled) setGestureStatus('error')
      }
    }

    init()

    return () => {
      cancelled = true
      mountedRef.current = false
      cancelAnimationFrame(rafRef.current)
      if (switchTimerRef.current) clearTimeout(switchTimerRef.current)
      // 只停止自己创建的流，不要停止共享流
      if (!cameraStream && streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
      }
      streamRef.current = null
      landmarkerRef.current?.close()
      landmarkerRef.current = null
      gestureDetectorRef.current.reset()
    }
  }, [triggerHit, cameraStream])

  return (
    <div className="smash-stage">
      {/* 隐藏的摄像头视频元素 */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
      />

      {/* 手势状态指示 */}
      <div className="smash-stage-status">
        {gestureStatus === 'loading' && '🔄 加载手势识别...'}
        {gestureStatus === 'ready' && '✊ 手势识别就绪 · 出拳捶打！'}
        {gestureStatus === 'error' && '⚠ 手势识别不可用，点击捶打'}
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

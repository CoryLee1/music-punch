import {
  FilesetResolver,
  HandLandmarker,
} from '@mediapipe/tasks-vision'

const TASKS_VISION_VER = '0.10.14'

function publicUrl(subPath: string): string {
  const base = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`
  const path = `${base}${subPath.replace(/^\//, '')}`
  if (typeof window === 'undefined') {
    return path
  }
  return new URL(path, window.location.origin).href
}

/**
 * 依次尝试本地 public（npm postinstall 同步）、jsdelivr、unpkg。
 */
function wasmBaseCandidates(): string[] {
  // 部署在子路径时 BASE_URL 很重要；但也加一个根路径兜底，避免 base 配错导致 404。
  const originRoot =
    typeof window === 'undefined'
      ? '/mediapipe-vision-wasm'
      : new URL('/mediapipe-vision-wasm', window.location.origin).href
  return [
    publicUrl('mediapipe-vision-wasm'),
    originRoot,
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VER}/wasm`,
    `https://unpkg.com/@mediapipe/tasks-vision@${TASKS_VISION_VER}/wasm`,
  ]
}

function modelUrlCandidates(): string[] {
  const originModel =
    typeof window === 'undefined'
      ? '/mediapipe-models/hand_landmarker.task'
      : new URL('/mediapipe-models/hand_landmarker.task', window.location.origin)
          .href
  return [
    publicUrl('mediapipe-models/hand_landmarker.task'),
    originModel,
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  ]
}

/**
 * 创建手部 landmarker：多 WASM 源 ×（GPU 失败则 CPU）。
 */
async function createHandLandmarkerOnce(): Promise<HandLandmarker> {
  let lastError: unknown

  for (const wasmBase of wasmBaseCandidates()) {
    let fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>
    try {
      console.log('[MediaPipe] 尝试 WASM:', wasmBase)
      fileset = await FilesetResolver.forVisionTasks(wasmBase)
      console.log('[MediaPipe] ✅ WASM 加载成功')
    } catch (e) {
      console.warn('[MediaPipe] ❌ WASM 加载失败:', wasmBase, e instanceof Error ? e.message : e)
      lastError = e
      continue
    }

    for (const modelAssetPath of modelUrlCandidates()) {
      for (const delegate of ['GPU', 'CPU'] as const) {
        try {
          console.log('[MediaPipe] 尝试模型:', modelAssetPath, '| delegate:', delegate)
          const lm = await HandLandmarker.createFromOptions(fileset, {
            baseOptions: {
              modelAssetPath,
              delegate,
            },
            runningMode: 'VIDEO',
            numHands: 2,
          })
          console.log('[MediaPipe] ✅ HandLandmarker 创建成功 (delegate=' + delegate + ')')
          return lm
        } catch (e) {
          console.warn('[MediaPipe] ❌ 创建失败:', delegate, e instanceof Error ? e.message : e)
          lastError = e
        }
      }
    }
  }

  const hint =
    lastError instanceof Error
      ? lastError.message
      : String(lastError ?? 'unknown')
  throw new Error(
    `MediaPipe 手部模型加载失败（已尝试本地 WASM、CDN 与 GPU/CPU）。详情: ${hint}。请在 frontend 目录执行: npm run sync:mediapipe`,
  )
}

/* ─── 全局单例 + 自动重试 ─── */

/** 全局缓存的 HandLandmarker promise — 保证只创建一次 */
let singletonPromise: Promise<HandLandmarker> | null = null
/** 已解析出的实例引用（方便判断是否已就绪） */
let singletonInstance: HandLandmarker | null = null
/** 当前存活的调用者数量（引用计数，0 时释放实例） */
let refCount = 0
/** 重试次数上限 */
const MAX_RETRIES = 3
/** 重试间隔 (ms) */
const RETRY_DELAY_MS = 2500

async function createWithRetry(): Promise<HandLandmarker> {
  let lastErr: unknown
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const lm = await createHandLandmarkerOnce()
      return lm
    } catch (e) {
      lastErr = e
      console.warn(
        `[MediaPipe] 初始化失败 (第 ${attempt + 1}/${MAX_RETRIES} 次)：`,
        e instanceof Error ? e.message : e,
      )
      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
      }
    }
  }
  throw lastErr
}

/**
 * 获取共享的 HandLandmarker 实例。
 * - 首次调用时创建，后续复用同一 promise（同时支持多组件共享）。
 * - 创建过程带 3 次重试。
 * - 调用者用完后应调用 `releaseRobustHandLandmarker()` 递减引用计数；
 *   当引用归零时实例会被释放，下次获取时重新创建。
 */
export async function createRobustHandLandmarker(): Promise<HandLandmarker> {
  refCount++
  if (singletonInstance) return singletonInstance

  if (!singletonPromise) {
    singletonPromise = createWithRetry().then((lm) => {
      singletonInstance = lm
      return lm
    }).catch((e) => {
      // 创建失败时清理 promise 缓存，以便下次重试
      singletonPromise = null
      throw e
    })
  }

  return singletonPromise
}

/**
 * 递减引用计数。当所有使用者都释放后，关闭 HandLandmarker 实例。
 */
export function releaseRobustHandLandmarker(): void {
  refCount = Math.max(0, refCount - 1)
  if (refCount === 0 && singletonInstance) {
    singletonInstance.close()
    singletonInstance = null
    singletonPromise = null
  }
}

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
  return [
    publicUrl('mediapipe-vision-wasm'),
    `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VER}/wasm`,
    `https://unpkg.com/@mediapipe/tasks-vision@${TASKS_VISION_VER}/wasm`,
  ]
}

function modelUrlCandidates(): string[] {
  return [
    publicUrl('mediapipe-models/hand_landmarker.task'),
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  ]
}

/**
 * 创建手部 landmarker：多 WASM 源 ×（GPU 失败则 CPU）。
 */
export async function createRobustHandLandmarker(): Promise<HandLandmarker> {
  let lastError: unknown

  for (const wasmBase of wasmBaseCandidates()) {
    let fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>
    try {
      fileset = await FilesetResolver.forVisionTasks(wasmBase)
    } catch (e) {
      lastError = e
      continue
    }

    for (const modelAssetPath of modelUrlCandidates()) {
      for (const delegate of ['GPU', 'CPU'] as const) {
        try {
          return await HandLandmarker.createFromOptions(fileset, {
            baseOptions: {
              modelAssetPath,
              delegate,
            },
            runningMode: 'VIDEO',
            numHands: 2,
          })
        } catch (e) {
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

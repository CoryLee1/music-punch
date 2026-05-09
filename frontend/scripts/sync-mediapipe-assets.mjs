/**
 * 将 WASM 同步到 public（同域加载，避免 jsdelivr/Google 被墙导致 MediaPipe 无法初始化）。
 * 可选下载手部 .task 模型到 public，便于离线或弱网。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const wasmSrc = path.join(
  root,
  'node_modules/@mediapipe/tasks-vision/wasm',
)
const wasmDest = path.join(root, 'public/mediapipe-vision-wasm')
const modelDir = path.join(root, 'public/mediapipe-models')
const modelDest = path.join(modelDir, 'hand_landmarker.task')
const modelRemote =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

function main() {
  if (!fs.existsSync(wasmSrc)) {
    console.warn(
      '[sync-mediapipe] 未找到 @mediapipe/tasks-vision/wasm，请先 npm install',
    )
    return
  }
  fs.mkdirSync(path.dirname(wasmDest), { recursive: true })
  fs.rmSync(wasmDest, { recursive: true, force: true })
  fs.cpSync(wasmSrc, wasmDest, { recursive: true })
  console.log('[sync-mediapipe] 已复制 WASM -> public/mediapipe-vision-wasm')
}

async function maybeDownloadModel() {
  fs.mkdirSync(modelDir, { recursive: true })
  if (fs.existsSync(modelDest)) {
    const st = fs.statSync(modelDest)
    if (st.size > 512 * 1024) {
      console.log('[sync-mediapipe] 已存在 hand_landmarker.task，跳过下载')
      return
    }
  }
  try {
    const res = await fetch(modelRemote)
    if (!res.ok) {
      console.warn(
        `[sync-mediapipe] 模型 HTTP ${res.status}，将仅依赖运行时从官方 URL 加载`,
      )
      return
    }
    const buf = Buffer.from(await res.arrayBuffer())
    fs.writeFileSync(modelDest, buf)
    console.log('[sync-mediapipe] 已下载 hand_landmarker.task -> public/mediapipe-models/')
  } catch (e) {
    console.warn(
      '[sync-mediapipe] 模型下载失败（可走 CDN）：',
      e instanceof Error ? e.message : e,
    )
  }
}

main()
await maybeDownloadModel()

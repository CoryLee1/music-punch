import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import { attachAsrWebSocket } from './asrProxy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '.env') })

function dashscopeKey() {
  const raw = process.env.DASHSCOPE_API_KEY
  if (raw == null || raw === '') return ''
  let s = String(raw).trim()
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1).trim()
  if (
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('"') && s.endsWith('"'))
  ) {
    s = s.slice(1, -1).trim()
  }
  return s
}

/** 规范化后的 Key，供鉴权与 /api 判断 */
const resolvedDashscopeApiKey = dashscopeKey()
if (resolvedDashscopeApiKey)
  process.env.DASHSCOPE_API_KEY = resolvedDashscopeApiKey

const app = express()
const PORT = Number(process.env.PORT) || 8787

app.use(cors({ origin: true }))
app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'music-punch-api',
    asr: {
      dashscope: Boolean(resolvedDashscopeApiKey),
      model: process.env.DASHSCOPE_ASR_MODEL || 'fun-asr-realtime',
    },
  })
})

/** 是否已配置百炼 Key（兼容仅请求此路由的客户端） */
app.get('/api/asr/status', (_req, res) => {
  res.json({
    dashscope: Boolean(resolvedDashscopeApiKey),
    model: process.env.DASHSCOPE_ASR_MODEL || 'fun-asr-realtime',
  })
})

/** 预留：合作者在此挂载业务路由 */
app.get('/api/version', (_req, res) => {
  res.json({ version: '0.1.0' })
})

const server = http.createServer(app)
attachAsrWebSocket(server)

server.listen(PORT, () => {
  console.log(`music-punch API http://localhost:${PORT}`)
  if (!resolvedDashscopeApiKey) {
    console.warn(
      '[asr] 未设置 DASHSCOPE_API_KEY，实时语音将回退为浏览器 Web Speech（若可用）',
    )
  }
})

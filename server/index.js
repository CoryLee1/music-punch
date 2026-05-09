import 'dotenv/config'
import http from 'node:http'
import cors from 'cors'
import express from 'express'
import { attachAsrWebSocket } from './asrProxy.js'

const app = express()
const PORT = Number(process.env.PORT) || 8787

app.use(cors({ origin: true }))
app.use(express.json())

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'music-punch-api' })
})

/** 预留：合作者在此挂载业务路由 */
app.get('/api/version', (_req, res) => {
  res.json({ version: '0.1.0' })
})

const server = http.createServer(app)
attachAsrWebSocket(server)

server.listen(PORT, () => {
  console.log(`music-punch API http://localhost:${PORT}`)
  if (process.env.DASHSCOPE_API_KEY) {
    console.log('// ASR: DashScope proxy ws → /api/asr/stream')
  } else {
    console.log('// ASR: 未配置 DASHSCOPE_API_KEY，语音识别不可用')
  }
})

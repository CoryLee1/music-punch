import cors from 'cors'
import express from 'express'

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

app.listen(PORT, () => {
  console.log(`music-punch API http://localhost:${PORT}`)
})

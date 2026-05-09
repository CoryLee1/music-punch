import crypto from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'

const INFERENCE_URL =
  process.env.DASHSCOPE_WS_URL ||
  'wss://dashscope.aliyuncs.com/api-ws/v1/inference/'

const ASR_MODEL = process.env.DASHSCOPE_ASR_MODEL || 'fun-asr-realtime'

/**
 * 可选：[-1,1]，越接近 1 越把「像环境声的内容」判成噪音（可减轻背景乐误触发 ASR，但太大可能吞小声说话）。
 * 不设则走服务端默认。
 */
function optionalSpeechNoiseThreshold() {
  const raw = process.env.DASHSCOPE_ASR_SPEECH_NOISE_THRESHOLD
  if (raw === undefined || raw === '') return {}
  const n = Number(raw)
  if (!Number.isFinite(n) || n < -1 || n > 1) return {}
  return { speech_noise_threshold: n }
}

/**
 * 浏览器 WebSocket → DashScope Fun-ASR 推理链路（API Key 仅在此进程使用）
 * path: /api/asr/stream
 * 客户端：二进制帧 = int16 16kHz mono PCM；文本 {"type":"stop"} 触发 finish-task
 */
export function attachAsrWebSocket(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/api/asr/stream' })

  wss.on('connection', (clientWs) => {
    const apiKey = process.env.DASHSCOPE_API_KEY
    if (!apiKey) {
      safeSend(clientWs, {
        type: 'error',
        message: '服务器未配置环境变量 DASHSCOPE_API_KEY',
      })
      clientWs.close()
      return
    }

    const taskId = crypto.randomUUID().replace(/-/g, '')
    const pendingAudio = []
    let taskStarted = false

    const runTaskMsg = JSON.stringify({
      header: {
        action: 'run-task',
        task_id: taskId,
        streaming: 'duplex',
      },
      payload: {
        task_group: 'audio',
        task: 'asr',
        function: 'recognition',
        model: ASR_MODEL,
        parameters: {
          sample_rate: 16000,
          format: 'pcm',
          ...optionalSpeechNoiseThreshold(),
        },
        input: {},
      },
    })

    const finishTaskMsg = JSON.stringify({
      header: {
        action: 'finish-task',
        task_id: taskId,
        streaming: 'duplex',
      },
      payload: { input: {} },
    })

    function safeSend(ws, obj) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj))
      }
    }

    const upstream = new WebSocket(INFERENCE_URL, {
      headers: {
        Authorization: `bearer ${apiKey}`,
      },
    })

    function flushPending() {
      if (upstream.readyState !== WebSocket.OPEN) return
      for (const buf of pendingAudio) {
        upstream.send(buf)
      }
      pendingAudio.length = 0
    }

    upstream.on('open', () => {
      upstream.send(runTaskMsg)
    })

    upstream.on('message', (data, isBinary) => {
      if (isBinary) return
      let msg
      try {
        const text = typeof data === 'string' ? data : data.toString()
        msg = JSON.parse(text)
      } catch {
        return
      }
      const event = msg.header?.event
      switch (event) {
        case 'task-started':
          taskStarted = true
          flushPending()
          safeSend(clientWs, { type: 'ready' })
          break
        case 'result-generated': {
          const sentence = msg.payload?.output?.sentence
          if (sentence && typeof sentence.text === 'string') {
            safeSend(clientWs, {
              type: 'result',
              text: sentence.text,
              sentenceEnd: !!sentence.sentence_end,
            })
          }
          break
        }
        case 'task-finished':
          safeSend(clientWs, { type: 'finished' })
          break
        case 'task-failed':
          safeSend(clientWs, {
            type: 'error',
            message: msg.header?.error_message || 'task-failed',
          })
          break
        default:
          break
      }
    })

    upstream.on('error', (err) => {
      safeSend(clientWs, {
        type: 'error',
        message: err.message || 'DashScope WebSocket 错误',
      })
      clientWs.close()
    })

    upstream.on('close', () => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close()
      }
    })

    clientWs.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
        if (upstream.readyState === WebSocket.OPEN && taskStarted) {
          upstream.send(buf)
        } else {
          pendingAudio.push(buf)
        }
        return
      }
      try {
        const j = JSON.parse(data.toString())
        if (j.type === 'stop' && upstream.readyState === WebSocket.OPEN) {
          upstream.send(finishTaskMsg)
        }
      } catch {
        /* ignore */
      }
    })

    clientWs.on('close', () => {
      if (upstream.readyState === WebSocket.OPEN) {
        try {
          upstream.send(finishTaskMsg)
        } catch {
          /* noop */
        }
        upstream.close()
      }
    })

    clientWs.on('error', () => {
      upstream.close()
    })
  })
}

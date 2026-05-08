# Music Punch

情绪驱动的生成式音乐小站：**前端 React + Vite**，**后端 Node (Express)**。用户输入自然语言情绪描述，服务端调用 OpenAI（可选）或本地启发式规则，返回 BPM、调式与和弦进行；前端用 **Tone.js** 循环演奏，并通过 **MediaPipe Hand Landmarker** 复现原 `legacy/sketch.js` 的手势映射（左手：捏合音量 + 手腕高度控制低通；右手：高度控制速度、水平位置控制声像）。

## 本地开发

```bash
# 安装根目录与前后端依赖
npm install
cd frontend && npm install && cd ..
cd server && npm install && cd ..

# 同时启动 API (8787) + 前端 (5173)
npm run dev
```

浏览器打开 Vite 提示的地址（一般为 `http://localhost:5173`）。如需 AI 解析，将 `server/.env.example` 复制为 `server/.env` 并填入 `OPENAI_API_KEY`。

## 目录

- `frontend/` — React 界面、Tone、MediaPipe
- `server/` — `/api/emotion` 情绪解析 API
- `legacy/` — 早期 p5 + ml5 手部示例与 `sample.wav`（仅供参考）

## 生产构建（静态前端）

```bash
npm run build
# 将 frontend/dist 交给任意静态托管；API 需单独部署并配置 CORS / 反代
```

## 仓库

<https://github.com/CoryLee1/music-punch>

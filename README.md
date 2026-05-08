# Music Punch

基于**摄像头手势**控制一段循环采样（`sample.wav`）的演示项目：拇食指张合距离映射播放速率（听感上**越快、音高越高**；间距过小则**静音**）。界面是**浅灰底 + 细线 + 等宽字**的数据感风格。

**音频资源**：`frontend/public/sample.wav` **已纳入本 Git 仓库并会推送到 GitHub**，协作者 `git clone` 后即可直接使用；请勿在 `.gitignore` 中排除该文件。若需更换素材，可替换同路径文件并 **commit / push** 更新。

---

## 技术栈一览

| 部分 | 框架 / 运行时 | 主要依赖 |
|------|----------------|----------|
| **前端** | **React 19** + **Vite 5** + **TypeScript** | **@mediapipe/tasks-vision**（Hand Landmarker，浏览器内推理）、**Tone.js**（`Player` 播放/循环/变速）、原生 **Canvas 2D** 绘制 HUD |
| **后端** | **Node.js** + **Express 4** | **cors**（跨域，本地与 SPA 联调） |
| **仓库工具** | npm workspaces 式多包（独立 `package.json`） | **concurrently**（根目录一条命令同时起前后端） |

可选参考：**`legacy-p5/`** 为早期的 **p5.js + p5.sound + ml5.js** 单页原型（不依赖 React），便于对照手势逻辑。

---

## 环境要求

- **Node.js** 建议 **18+**（与当前 Vite / 工具链兼容）
- 浏览器需支持 **WebRTC（摄像头）**、**Web Audio**；模型与 WASM 通过 CDN 加载（见 `GestureStage.tsx` 中的 MediaPipe 地址）

---

## 怎么启动

### 1. 安装依赖

在**仓库根目录**执行（会用到根目录的 `concurrently`；前后端各自还要装一遍依赖）：

```bash
git clone https://github.com/CoryLee1/music-punch.git
cd music-punch

npm install
cd server && npm install && cd ..
cd frontend && npm install && cd ..
```

### 2. 采样文件（已随仓库提供）

默认 **`frontend/public/sample.wav`** 已与代码一同提交；克隆后即可用，无需单独下载。  
开发时由 Vite 托管，浏览器访问 **`http://localhost:5173/sample.wav`** 应能播放该 WAV。  
若你本地替换了别的 `sample.wav`，请确认仍是浏览器可解码的标准 PCM WAV。

### 3. 同时启动前端 + 后端（推荐）

```bash
npm run dev
```

- **前端**：默认 **`http://localhost:5173`**（Vite HMR）
- **后端**：默认 **`http://localhost:8787`**
- Vite 已配置 **代理**：浏览器访问 **`/api/*`** 会转发到 **`http://localhost:8787`**，避免开发环境跨域手工调参。

### 4. 只启动一端（可选）

```bash
# 仅 API
npm run start:api
# 或
cd server && npm run dev

# 仅前端（无 /api 时顶栏会显示 API 离线，手势与本地音频仍可试）
cd frontend && npm run dev
```

### 5. 生产构建（前端静态资源）

```bash
npm run build
# 等价于在 frontend 内: tsc -b && vite build
```

产物在 **`frontend/dist/`**。部署时通常需要：

- 静态托管 **`dist`**
- 独立部署 **Express**，或把 **`/api`** 反代到同一域名下，并保证生产环境 CORS / Cookie 策略与前端一致。

---

## 目录结构（维护时看准入口）

```text
music-punch/
├── package.json          # 根脚本：concurrently 并行 dev / 触发 frontend build
├── frontend/             # React + Vite
│   ├── public/
│   │   └── sample.wav    # 随仓库版本管理（GitHub 上可获取）
│   ├── src/
│   │   ├── App.tsx       # 顶栏、API 状态、布局
│   │   ├── components/
│   │   │   └── GestureStage.tsx   # 摄像头、MediaPipe、画布绘制、点击启动音频
│   │   └── lib/
│   │       └── samplePlayer.ts   # Tone.js Player + Gain，封装 start / applyGesture
│   └── vite.config.ts    # /api → 8787 代理
├── server/
│   ├── index.js          # Express 入口；在此挂载新业务路由
│   └── package.json
└── legacy-p5/            # p5 + ml5 原型（可选）
```

---

## 想加功能时怎么维护

### 前端（`frontend/`）

| 目标 | 建议改哪里 |
|------|------------|
| 手势算法、画布视觉、摄像头生命周期 | **`src/components/GestureStage.tsx`**（MediaPipe 检测循环、`paint()`、手部 landmark 索引与原版 p5 一致：拇指 4、食指 8） |
| 音量、变速、是否用 Tone 效果器（EQ、混响等） | **`src/lib/samplePlayer.ts`**（集中改音频图，避免和业务 UI 缠在一起） |
| 新页面、路由、全局状态 | 在 `src/` 增页面组件；可引入 **React Router**；复杂状态可考虑 **Zustand / Redux**（当前未装，按需 `npm install`） |
| 调用后端新接口 | 在组件或 `src/api/` 下封装 `fetch('/api/...')`（开发走 Vite 代理） |

**注意**：`StrictMode` 下 Effect 会执行两次，清理函数里要停掉 `requestAnimationFrame`、关掉 `HandLandmarker`、`dispose` 音频等，避免双实例泄漏。

### 后端（`server/`）

| 目标 | 建议做法 |
|------|----------|
| 新 REST 接口 | 在 **`server/index.js`** 里 `app.use` / `app.get` / `app.post`；复杂时可拆 **`routes/*.js`** 再 `import` |
| 鉴权 / 会话 | 可中间件校验 Header Token 或 Cookie；生产务必 **HTTPS** |
| 环境变量 | 使用 `process.env`；本地可复制 `.env` + **`dotenv`**（需自行 `npm install dotenv` 并在入口 `load`） |
| 与前端并行开发 | 保持 **`/api`** 前缀；前端继续用相对路径请求即可 |

### 与「legacy-p5」的关系

- **`legacy-p5/`** 不参与 `npm run dev`，仅作参考或离线演示。
- 若两边逻辑要对齐，以 **`GestureStage.tsx` + `samplePlayer.ts`** 为准；p5 版 `sample.rate()` 与 Tone `playbackRate` 在体验上接近（**变速同时变调**）。

---

## 当前内置 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | `{ ok: true, service: 'music-punch-api' }`，供前端探测联调 |
| GET | `/api/version` | `{ version: '0.1.0' }`，占位 |

---

## Git 提交

- **Cursor**：根目录已配置 `.cursor/rules/auto-git-ship.mdc`，Agent 在完成实质性改动后应自动 `commit` + `push`（除非你明确要求不要推送）。
- **本机一键**：`npm run ship -- "feat: 说明"`（将把当前所有变更提交并 `git push`；无变更时会直接退出）。消息可省略，默认为 `chore: sync`。

## 仓库

<https://github.com/CoryLee1/music-punch>

import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 8787;

app.use(cors({ origin: true }));
app.use(express.json({ limit: "32kb" }));

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function rootToMidi(root) {
  let r = String(root || "C").trim().toUpperCase();
  r = r.replace("♯", "#").replace("♭", "B");
  const map = {
    C: 0,
    "C#": 1,
    DB: 1,
    D: 2,
    "D#": 3,
    EB: 3,
    E: 4,
    F: 5,
    "F#": 6,
    GB: 6,
    G: 7,
    "G#": 8,
    AB: 8,
    A: 9,
    "A#": 10,
    BB: 10,
    B: 11,
  };
  return map[r] ?? 0;
}

function midiToNoteName(midi) {
  const n = Math.round(midi);
  const name = NOTE_NAMES[((n % 12) + 12) % 12];
  const oct = Math.floor(n / 12) - 1;
  return `${name}${oct}`;
}

/** I – V – vi – IV 风格进行；小调使用自然小调常见变化 */
function buildProgression(root, mode) {
  const rootMidi = rootToMidi(root);
  const octave = 4;
  const base = 12 * (octave + 1) + rootMidi;
  const majorShape = [
    [0, 4, 7],
    [7, 11, 14],
    [9, 12, 16],
    [5, 9, 12],
  ];
  const minorShape = [
    [0, 3, 7],
    [7, 11, 14],
    [3, 7, 10],
    [8, 12, 15],
  ];
  const shape = mode === "minor" ? minorShape : majorShape;
  return shape.map((intervals) => intervals.map((s) => midiToNoteName(base + s)));
}

function heuristicBlueprint(text) {
  const t = String(text || "").toLowerCase();
  let primary = "calm";
  let bpm = 88;
  let mode = "major";
  let root = "C";
  let brightness = 0.55;
  let reverbWet = 0.35;
  let summary =
    "根据关键词匹配到的情绪模板。配置 OPENAI_API_KEY 可获得更细腻的音乐参数解析。";

  if (/丧|抑郁|绝望|悲伤|难过|心碎|grief|sad|depress|melanchol/.test(t)) {
    primary = "melancholy";
    bpm = 72;
    mode = "minor";
    root = "A";
    brightness = 0.25;
    reverbWet = 0.55;
    summary = "听到很深的低落与沉重，音乐以慢速小调与更长混响托住情绪。";
  } else if (/焦虑|紧张|慌|不安|anxious|nervous|stress/.test(t)) {
    primary = "anxiety";
    bpm = 96;
    mode = "minor";
    root = "D";
    brightness = 0.4;
    reverbWet = 0.45;
    summary = "不安与紧绷感，用略快的小调和不那么明亮的音色表现心神被拉扯。";
  } else if (/愤怒|生气|火大|angry|rage|furious/.test(t)) {
    primary = "anger";
    bpm = 112;
    mode = "minor";
    root = "E";
    brightness = 0.65;
    reverbWet = 0.22;
    summary = "炽烈的怒气，更快节奏、更紧凑的混响与更锐利的滤波起点。";
  } else if (/开心|快乐|兴奋|欣喜|joy|happy|excited|elated/.test(t)) {
    primary = "joy";
    bpm = 108;
    mode = "major";
    root = "C";
    brightness = 0.75;
    reverbWet = 0.28;
    summary = "轻快明亮的能量，大调、偏高速度与更通透的听感。";
  } else if (/平静|放松|治愈|安宁|calm|peace|relaxed|heal/.test(t)) {
    primary = "calm";
    bpm = 80;
    mode = "major";
    root = "F";
    brightness = 0.5;
    reverbWet = 0.42;
    summary = "温柔的平静，较慢速度、柔和的大调和适量的空间感。";
  } else if (/想念|思念|怀旧|nostalg|miss|longing/.test(t)) {
    primary = "nostalgia";
    bpm = 76;
    mode = "minor";
    root = "G";
    brightness = 0.45;
    reverbWet = 0.5;
    summary = "像在回忆里停留，慢速小调与湿润的空间。";
  }

  const chordProgression = buildProgression(root, mode);
  return {
    summary,
    primaryEmotion: primary,
    music: {
      bpm,
      mode,
      rootNote: root,
      brightness,
      reverbWet,
      chordProgression,
    },
    source: "heuristic",
  };
}

async function openAiBlueprint(text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  const body = {
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `你是一个音乐和情绪分析助手。用户会描述当下情绪。请只输出合法 JSON，不要 markdown。
字段：
- summary: string 中文简短共情描述
- primaryEmotion: string 英文小写标签
- music: { bpm: number 60-130, mode: "major"|"minor", rootNote: string 如 C / A / F# , brightness: number 0-1, reverbWet: number 0-1, chordProgression: string[][] 每个和弦是 3 个科学音高如 ["C4","E4","G4"] ，长度 4 个和弦 }
根据情绪为 chordProgression 选择与调性匹配的和弦进行。`,
      },
      { role: "user", content: text },
    ],
    temperature: 0.7,
    response_format: { type: "json_object" },
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI 请求失败 ${res.status}: ${err}`);
  }
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error("OpenAI 返回为空");
  const parsed = JSON.parse(raw);
  if (!parsed.music?.chordProgression) throw new Error("OpenAI JSON 缺少 music.chordProgression");
  return {
    summary: parsed.summary,
    primaryEmotion: parsed.primaryEmotion,
    music: {
      bpm: parsed.music.bpm,
      mode: parsed.music.mode,
      rootNote: parsed.music.rootNote,
      brightness: parsed.music.brightness,
      reverbWet: parsed.music.reverbWet,
      chordProgression: parsed.music.chordProgression,
    },
    source: "openai",
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/emotion", async (req, res) => {
  try {
    const text = req.body?.text ?? "";
    if (typeof text !== "string" || text.trim().length === 0) {
      return res.status(400).json({ error: "请提供非空的情绪描述 text" });
    }
    if (text.length > 2000) {
      return res.status(400).json({ error: "text 过长" });
    }

    let payload = null;
    try {
      payload = await openAiBlueprint(text.trim());
    } catch (e) {
      console.warn("[emotion] OpenAI 不可用，使用启发式:", e?.message || e);
    }
    if (!payload) {
      payload = heuristicBlueprint(text);
    }
    res.json(payload);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "服务器处理失败", detail: String(e?.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`music-punch API http://localhost:${PORT}`);
});

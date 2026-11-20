/**
 * 日语语音合成 - 公开模式(零依赖 Node.js 版,Node >= 18)
 * 部署给公众用: 只能合成语音,不能克隆/删除。
 * 启动: node server.mjs(默认端口 8000,可用 PORT 环境变量覆盖)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8000);

const FISH_API_KEY = process.env.FISH_API_KEY || "";
const FISH_MODEL = process.env.FISH_MODEL || "s2.1-pro-free";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const RATE_LIMIT_PER_HOUR = Number(process.env.TTS_RATE_LIMIT_PER_HOUR || 60);
const FISH_BASE = "https://api.fish.audio";
const GENERATED_DIR = path.join(__dirname, "data", "audio", "generated");

fs.mkdirSync(GENERATED_DIR, { recursive: true });

// ---------- 按 IP 内存限流 ----------
const hits = new Map(); // ip -> [timestamps]
function checkRateLimit(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  hits.set(ip, arr);
  if (arr.length >= RATE_LIMIT_PER_HOUR) {
    throw { status: 429, detail: `请求太频繁了,每小时最多 ${RATE_LIMIT_PER_HOUR} 次,请稍后再试` };
  }
  arr.push(now);
}

// ---------- Fish Audio 调用 ----------
async function fishVoices() {
  const resp = await fetch(`${FISH_BASE}/model?page_size=100&self=true`, {
    headers: { Authorization: `Bearer ${FISH_API_KEY}` },
  });
  if (resp.status !== 200) {
    throw { status: 502, detail: `获取声音列表失败: ${await errText(resp)}` };
  }
  const data = await resp.json();
  return (data.items || []).map((v) => ({
    voice_id: String(v._id),
    title: v.title || "",
    state: String(v.state || "unknown"),
    created_at: v.created_at || null,
  }));
}

async function errText(resp) {
  try {
    const body = await resp.json();
    return body.message || JSON.stringify(body).slice(0, 200);
  } catch {
    return (await resp.text()).slice(0, 200);
  }
}

async function fishSynthesize(text, voiceId) {
  const resp = await fetch(`${FISH_BASE}/v1/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${FISH_API_KEY}`,
      "Content-Type": "application/json",
      model: FISH_MODEL,
    },
    body: JSON.stringify({ text, reference_id: voiceId, format: "mp3", chunk_length: 200 }),
  });
  if (resp.status !== 200) {
    throw { status: 502, detail: `语音合成失败: ${await errText(resp)}` };
  }
  return Buffer.from(await resp.arrayBuffer());
}

// ---------- 声音列表缓存(60 秒) ----------
let voicesCache = { at: 0, items: [] };
async function getVoices() {
  if (Date.now() - voicesCache.at > 60_000) {
    voicesCache = { at: Date.now(), items: await fishVoices() };
  }
  return voicesCache.items;
}

// ---------- OpenAPI(扣子插件定义) ----------
function buildOpenApi(baseUrl) {
  return {
    openapi: "3.0.1",
    info: {
      title: "日语语音合成 VoiceTTS",
      version: "1.0.0",
      description: "使用克隆好的日语声音,把输入的日语文本合成为语音,返回 mp3 音频的公网链接与时长。Bot 可用 Markdown 链接形式把 [音频](url) 展示给用户。",
    },
    servers: [{ url: baseUrl }],
    paths: {
      "/api/v1/synthesize": {
        post: {
          operationId: "synthesize",
          summary: "日语文本合成语音",
          description: "输入日语文本与克隆声音 voice_id,返回 mp3 公网 URL 与时长(秒)。text 最长 500 字。",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["text", "voice_id"],
                  properties: {
                    text: { type: "string", description: "要合成的日语文本,最多 500 字", example: "こんにちは、今日もいい天気ですね。" },
                    voice_id: { type: "string", description: "克隆声音的 ID,可从 voices 工具获取", example: "8f3a1c2e4b5d6f7a8b9c0d1e" },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: "合成成功",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["audio_url", "duration", "voice_id"],
                    properties: {
                      audio_url: { type: "string", description: "mp3 音频的公网可访问 URL", example: `${baseUrl}/audio/generated/5f2a9c1d0e3b4a8f6c7d9e1a.mp3` },
                      duration: { type: "number", description: "音频时长(秒)", example: 4.2 },
                      voice_id: { type: "string", description: "实际使用的克隆声音 ID", example: "8f3a1c2e4b5d6f7a8b9c0d1e" },
                    },
                  },
                },
              },
            },
            400: { description: "参数错误:text 超长、voice_id 缺失或不存在" },
            500: { description: "语音合成失败(配额不足、网络异常、声音模型不可用)" },
          },
        },
      },
      "/api/v1/voices": {
        get: {
          operationId: "voices",
          summary: "获取可用克隆声音列表",
          description: "返回所有已克隆的日语声音,供 Bot 让用户选择 voice_id。",
          responses: {
            200: {
              description: "成功",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["voices"],
                    properties: {
                      voices: {
                        type: "array",
                        items: {
                          type: "object",
                          required: ["voice_id", "title", "state"],
                          properties: {
                            voice_id: { type: "string", description: "克隆声音 ID", example: "8f3a1c2e4b5d6f7a8b9c0d1e" },
                            title: { type: "string", description: "声音名称", example: "私の声" },
                            state: { type: "string", description: "模型状态: trained/training/error", example: "trained" },
                            created_at: { type: "string", format: "date-time", description: "创建时间", example: "2026-08-20T10:00:00Z" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            500: { description: "读取失败" },
          },
        },
      },
    },
  };
}

// ---------- 静态文件 ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveFile(res, filePath, fallbackMime) {
  try {
    const buf = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": fallbackMime || MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ detail: "not found" }));
  }
}

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    throw { status: 400, detail: "请求体必须是 JSON" };
  }
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const ip = req.socket.remoteAddress || "unknown";

  try {
    // 静态资源
    if (p === "/") return serveFile(res, path.join(__dirname, "static", "index.html"));
    if (p.startsWith("/static/")) {
      const f = path.normalize(path.join(__dirname, "static", p.slice(8)));
      if (!f.startsWith(path.join(__dirname, "static"))) return json(res, 403, { detail: "forbidden" });
      return serveFile(res, f);
    }
    if (p.startsWith("/audio/")) {
      const f = path.normalize(path.join(__dirname, "data", "audio", p.slice(7)));
      if (!f.startsWith(path.join(__dirname, "data", "audio"))) return json(res, 403, { detail: "forbidden" });
      return serveFile(res, f);
    }

    if (p === "/api/config") {
      return json(res, 200, { public_mode: true, base_url: PUBLIC_BASE_URL, tts_rate_limit_per_hour: RATE_LIMIT_PER_HOUR });
    }

    if (p === "/api/voices" || p === "/api/v1/voices") {
      const voices = await getVoices();
      return json(res, 200, { voices });
    }

    if (p === "/api/tts" || p === "/api/v1/synthesize") {
      if (req.method !== "POST") return json(res, 405, { detail: "只支持 POST" });
      checkRateLimit(ip);
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      const voiceId = String(body.voice_id || "");
      const maxLen = p === "/api/tts" ? 1000 : 500;
      if (!text) return json(res, 400, { detail: "text 不能为空" });
      if (text.length > maxLen) return json(res, 400, { detail: `text 最长 ${maxLen} 字` });
      if (!voiceId) return json(res, 400, { detail: "voice_id 不能为空" });
      const voices = await getVoices();
      if (!voices.some((v) => v.voice_id === voiceId)) {
        return json(res, 400, { detail: "voice_id 不存在,请先用 voices 工具获取可用声音" });
      }
      const audio = await fishSynthesize(text, voiceId);
      if (p === "/api/tts") {
        res.writeHead(200, { "Content-Type": "audio/mpeg" });
        return res.end(audio);
      }
      const name = crypto.randomUUID().replace(/-/g, "") + ".mp3";
      fs.writeFileSync(path.join(GENERATED_DIR, name), audio);
      const duration = Math.round((audio.length * 8 / 128000) * 100) / 100; // CBR 128kbps 估算
      return json(res, 200, {
        audio_url: `${PUBLIC_BASE_URL}/audio/generated/${name}`,
        duration,
        voice_id: voiceId,
      });
    }

    if (p === "/openapi.json" || p === "/openapi-plugin.json") {
      const spec = buildOpenApi(PUBLIC_BASE_URL);
      if (p === "/openapi-plugin.json") {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": 'attachment; filename="voice-tts-plugin.json"',
        });
      }
      return json(res, 200, spec);
    }

    return json(res, 404, { detail: "not found" });
  } catch (e) {
    if (e && e.status) return json(res, e.status, { detail: e.detail });
    console.error(e);
    return json(res, 500, { detail: String(e && e.message || e) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`voice-tts (public mode) listening on http://0.0.0.0:${PORT}`);
  if (!FISH_API_KEY) console.warn("警告: 未配置 FISH_API_KEY 环境变量,合成会失败!");
});

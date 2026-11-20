/**
 * 日语语音合成 - Cloudflare Worker(公开模式)
 * 日本用户友好: Cloudflare 东京节点 + 同网络调 api.fish.audio + KV 存音频(无需信用卡)。
 *
 * 环境配置:
 *   FISH_API_KEY    (Secret)Fish Audio 的 API Key
 *   FISH_MODEL      (变量)  默认 s2.1-pro-free(免费);付费可用 s2.1-pro
 *   PUBLIC_BASE_URL (变量)  站点根地址,如 https://voice.example.com(不带结尾斜杠)
 *   KV 绑定: AUDIO_KV(存生成的 mp3,key 为 <uuid>.mp3)
 *
 * 注意: KV 写入有最终一致性(最长约 60 秒全局可见)。/audio/<key> 未命中时会返回
 * 自动刷新页面,几秒后音频就绪即可播放。
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    const method = request.method;

    const base = (env.PUBLIC_BASE_URL || url.origin).replace(/\/$/, "");
    const fishKey = env.FISH_API_KEY || "";
    const fishModel = env.FISH_MODEL || "s2.1-pro-free";

    const json = (status, obj, extraHeaders = {}) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          ...extraHeaders,
        },
      });

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    };

    try {
      if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

      // ---------- 首页(内嵌极简页面;完整网页 UI 可选配 Static Assets) ----------
      if (p === "/") {
        return new Response(
          `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>声クローン TTS</title></head>
          <body style="font-family:sans-serif;max-width:640px;margin:3rem auto;padding:0 1rem;line-height:1.8">
          <h1>🎙 日语声音克隆 TTS API</h1>
          <p>サービス稼働中です。クローン音声で日本語テキストを音声合成します。</p>
          <ul>
            <li>声音列表: <a href="/api/v1/voices">GET /api/v1/voices</a></li>
            <li>合成语音: <a href="/openapi.json">POST /api/v1/synthesize</a>(扣子插件定义见 openapi.json)</li>
          </ul>
          </body></html>`,
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders } }
        );
      }

      // ---------- 配置 ----------
      if (p === "/api/config") {
        return json(200, { public_mode: true, base_url: base, tts_rate_limit_per_hour: 60 });
      }

      // ---------- 声音列表(缓存 60 秒) ----------
      if (p === "/api/voices" || p === "/api/v1/voices") {
        const cacheKey = new Request("https://fish.voices.cache/list", request);
        const cache = caches.default;
        let resp = await cache.match(cacheKey);
        if (!resp) {
          const upstream = await fetch("https://api.fish.audio/model?page_size=100&self=true", {
            headers: { Authorization: `Bearer ${fishKey}` },
          });
          if (upstream.status !== 200) {
            throw new HttpError(502, `获取声音列表失败: ${await errText(upstream)}`);
          }
          const data = await upstream.json();
          const voices = (data.items || []).map((v) => ({
            voice_id: String(v._id),
            title: v.title || "",
            state: String(v.state || "unknown"),
            created_at: v.created_at || null,
          }));
          resp = json(200, { voices });
          ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        }
        return resp;
      }

      // ---------- 合成 ----------
      if ((p === "/api/tts" || p === "/api/v1/synthesize") && method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body) throw new HttpError(400, "请求体必须是 JSON");
        const text = String(body.text || "").trim();
        const voiceId = String(body.voice_id || "");
        const maxLen = p === "/api/tts" ? 1000 : 500;
        if (!text) throw new HttpError(400, "text 不能为空");
        if (text.length > maxLen) throw new HttpError(400, `text 最长 ${maxLen} 字`);
        if (!voiceId) throw new HttpError(400, "voice_id 不能为空");

        const upstream = await fetch("https://api.fish.audio/v1/tts", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${fishKey}`,
            "Content-Type": "application/json",
            model: fishModel,
          },
          body: JSON.stringify({ text, reference_id: voiceId, format: "mp3", chunk_length: 200 }),
        });
        if (upstream.status !== 200) {
          throw new HttpError(502, `语音合成失败: ${await errText(upstream)}`);
        }
        const audio = await upstream.arrayBuffer();

        if (p === "/api/tts") {
          return new Response(audio, {
            status: 200,
            headers: { "Content-Type": "audio/mpeg", ...corsHeaders },
          });
        }

        // 存 KV 并返回公网 URL
        const name = crypto.randomUUID().replace(/-/g, "") + ".mp3";
        await env.AUDIO_KV.put(name, audio, {
          metadata: { contentType: "audio/mpeg" },
        });
        const duration = Math.round((audio.byteLength * 8 / 128000) * 100) / 100; // CBR 128kbps 估算
        return json(200, {
          audio_url: `${base}/audio/${name}`,
          duration,
          voice_id: voiceId,
        });
      }

      // ---------- 音频文件(从 KV;未就绪时返回自动刷新页面) ----------
      if (p.startsWith("/audio/") && method === "GET") {
        const key = p.slice("/audio/".length);
        if (!key || key.includes("/")) throw new HttpError(400, "缺少文件名");
        const buf = await env.AUDIO_KV.get(key, "arrayBuffer");
        if (!buf) {
          // KV 最终一致性: 刚生成的音频可能还没同步到当前节点,给浏览器一个自动刷新页
          return new Response(
            `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta http-equiv="refresh" content="2">` +
            `<title>音声準備中…</title></head><body style="font-family:sans-serif;text-align:center;padding-top:4rem;line-height:2">` +
            `<p>🎙 音声を準備しています…(数秒で再生します)</p><p style="color:#888;font-size:0.9rem">自動でリトライ中、そのままお待ちください</p></body></html>`,
            { status: 202, headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders } }
          );
        }
        return new Response(buf, {
          status: 200,
          headers: {
            "Content-Type": "audio/mpeg",
            "Cache-Control": "public, max-age=31536000, immutable",
            ...corsHeaders,
          },
        });
      }

      // ---------- 扣子插件定义 ----------
      if (p === "/openapi.json" || p === "/openapi-plugin.json") {
        const spec = buildOpenApi(base);
        const headers = { ...corsHeaders };
        if (p === "/openapi-plugin.json") {
          headers["Content-Disposition"] = 'attachment; filename="voice-tts-plugin.json"';
        }
        return json(200, spec, headers);
      }

      throw new HttpError(404, "not found");
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { detail: e.detail });
      console.error(e);
      return json(500, { detail: String(e && e.message) || "服务器错误" });
    }
  },
};

class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

async function errText(resp) {
  try {
    const body = await resp.json();
    return body.message || JSON.stringify(body).slice(0, 200);
  } catch {
    return (await resp.text()).slice(0, 200);
  }
}

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
                      audio_url: { type: "string", description: "mp3 音频的公网可访问 URL", example: `${baseUrl}/audio/5f2a9c1d0e3b4a8f6c7d9e1a.mp3` },
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

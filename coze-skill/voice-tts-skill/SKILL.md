---
name: voice-tts
description: 用克隆好的日语声音把日语文本合成为语音。当用户想让某个克隆声音念一段日语、需要生成日语语音或音频链接时使用。也提供已克隆声音列表查询。
---

# 日语声音克隆 TTS 技能

通过 VoiceTTS 网站 API,用已克隆的声音(如 momo voice、ryo voice、emma 等)把日语文本合成为 mp3 语音。

## API 信息

- API 地址: `https://ryomomo.top`
- 无需认证,所有响应均为 JSON

## 执行步骤

1. **查声音列表**:若用户没有指定用哪个声音,先调用 `GET /api/v1/voices`,从返回的 `voices` 数组里取得每个声音的 `voice_id` 和 `title`,把声音列表展示给用户选择。

2. **合成语音**:用户选定声音并给出文本后,调用:

   ```
   POST /api/v1/synthesize
   Content-Type: application/json
   Body: {"text": "<日语文本>", "voice_id": "<选定的voice_id>"}
   ```

3. **回复用户**:从响应中取 `audio_url` 和 `duration`,用 Markdown 链接回复:

   ```
   已合成语音:[🎧 试听](<audio_url>)(时长 <duration> 秒)
   ```

## 注意事项

- `text` 必须是日语,最长 500 字,超过会报 400 错误
- `voice_id` 不存在会返回 400,此时重新用 `GET /api/v1/voices` 查询
- 合成失败(502)一般是上游服务额度或网络问题,把返回的 `detail` 错误信息如实告诉用户
- 本地也提供脚本:`scripts/synthesize.py <voice_id> <text>`、`scripts/list_voices.py`

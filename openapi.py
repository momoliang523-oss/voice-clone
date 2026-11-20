"""扣子(coze.cn)插件 OpenAPI 3.0.1 定义。

servers.url 由 PUBLIC_BASE_URL 动态注入:部署/换隧道域名后重新下载导入即可。
扣子仅支持 OpenAPI 3.0.x,不要输出 3.1。
"""


def build_openapi(base_url: str) -> dict:
    return {
        "openapi": "3.0.1",
        "info": {
            "title": "日语语音合成 VoiceTTS",
            "version": "1.0.0",
            "description": (
                "使用克隆好的日语声音,把输入的日语文本合成为语音,"
                "返回 mp3 音频的公网链接与时长。"
                "Bot 可用 Markdown 链接形式把 [音频](url) 展示给用户。"
            ),
        },
        "servers": [{"url": base_url.rstrip("/")}],
        "paths": {
            "/api/v1/synthesize": {
                "post": {
                    "operationId": "synthesize",
                    "summary": "日语文本合成语音",
                    "description": (
                        "输入日语文本与克隆声音 voice_id,返回 mp3 公网 URL 与时长(秒)。"
                        "text 最长 500 字。"
                    ),
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["text", "voice_id"],
                                    "properties": {
                                        "text": {
                                            "type": "string",
                                            "description": "要合成的日语文本,最多 500 字",
                                            "example": "こんにちは、今日もいい天気ですね。",
                                        },
                                        "voice_id": {
                                            "type": "string",
                                            "description": "克隆声音的 ID,可从 voices 工具获取",
                                            "example": "8f3a1c2e4b5d6f7a8b9c0d1e",
                                        },
                                    },
                                }
                            }
                        },
                    },
                    "responses": {
                        "200": {
                            "description": "合成成功",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "required": ["audio_url", "duration", "voice_id"],
                                        "properties": {
                                            "audio_url": {
                                                "type": "string",
                                                "description": "mp3 音频的公网可访问 URL",
                                                "example": base_url.rstrip("/")
                                                + "/audio/generated/5f2a9c1d0e3b4a8f6c7d9e1a.mp3",
                                            },
                                            "duration": {
                                                "type": "number",
                                                "description": "音频时长(秒)",
                                                "example": 4.2,
                                            },
                                            "voice_id": {
                                                "type": "string",
                                                "description": "实际使用的克隆声音 ID",
                                                "example": "8f3a1c2e4b5d6f7a8b9c0d1e",
                                            },
                                        },
                                    }
                                }
                            },
                        },
                        "400": {
                            "description": "参数错误:text 超长、voice_id 缺失或不存在"
                        },
                        "500": {"description": "语音合成失败(配额不足、网络异常、声音模型不可用)"},
                    },
                }
            },
            "/api/v1/voices": {
                "get": {
                    "operationId": "voices",
                    "summary": "获取可用克隆声音列表",
                    "description": "返回所有已克隆的日语声音,供 Bot 让用户选择 voice_id。",
                    "responses": {
                        "200": {
                            "description": "成功",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "required": ["voices"],
                                        "properties": {
                                            "voices": {
                                                "type": "array",
                                                "items": {
                                                    "type": "object",
                                                    "required": ["voice_id", "title", "state"],
                                                    "properties": {
                                                        "voice_id": {
                                                            "type": "string",
                                                            "description": "克隆声音 ID",
                                                            "example": "8f3a1c2e4b5d6f7a8b9c0d1e",
                                                        },
                                                        "title": {
                                                            "type": "string",
                                                            "description": "声音名称",
                                                            "example": "私の声",
                                                        },
                                                        "state": {
                                                            "type": "string",
                                                            "description": "模型状态: trained/training/error/deleted_remote",
                                                            "example": "trained",
                                                        },
                                                        "created_at": {
                                                            "type": "string",
                                                            "format": "date-time",
                                                            "description": "创建时间",
                                                            "example": "2026-08-20T10:00:00Z",
                                                        },
                                                    },
                                                },
                                            }
                                        },
                                    }
                                }
                            },
                        },
                        "500": {"description": "读取失败"},
                    },
                }
            },
        },
    }

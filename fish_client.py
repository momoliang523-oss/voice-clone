"""Fish Audio API 封装:克隆 / TTS / 列表 / 状态 / 删除。

SDK(fish-audio-sdk 1.3.0)优先,失败走 httpx 直连兜底。
SDK 签名已实测确认:
  voices.create(*, title, voices: list[bytes], visibility="private",
                train_mode="fast", enhance_audio_quality=True) -> Voice
  tts.convert(*, text, reference_id, format="mp3") -> bytes
"""
import logging
import os
from typing import List, Optional

import httpx

logger = logging.getLogger(__name__)

API_BASE = "https://api.fish.audio"
TIMEOUT = 60.0


class FishAPIError(Exception):
    """带 HTTP 状态码的 Fish Audio 错误。"""

    def __init__(self, message: str, status: int = 500):
        super().__init__(message)
        self.status = status


_sdk_client = None


def _sdk():
    global _sdk_client
    if _sdk_client is None:
        from fishaudio import FishAudio

        _sdk_client = FishAudio()  # 自动读 FISH_API_KEY 环境变量
    return _sdk_client


def _headers() -> dict:
    return {"Authorization": f"Bearer {os.environ.get('FISH_API_KEY', '')}"}


def _err_detail(resp: httpx.Response) -> str:
    try:
        return str(resp.json().get("message", resp.text[:200]))
    except Exception:
        return resp.text[:200]


# ---------- 克隆 ----------

def create_voice(file_paths: List[str], title: str) -> dict:
    """上传音频克隆声音,返回 {voice_id, state}。"""
    try:
        client = _sdk()
        audio_bytes = []
        for p in file_paths:
            with open(p, "rb") as f:
                audio_bytes.append(f.read())
        voice = client.voices.create(
            title=title,
            voices=audio_bytes,
            visibility="private",
            train_mode="fast",
            enhance_audio_quality=True,
        )
        return {"voice_id": str(voice.id), "state": str(voice.state)}
    except Exception as e:  # SDK 失败走直连兜底
        logger.warning("SDK create 失败,改用直连: %s", e)
        return _create_voice_raw(file_paths, title)


def _create_voice_raw(file_paths: List[str], title: str) -> dict:
    files = [
        ("voices", (os.path.basename(p), open(p, "rb").read(), "audio/mpeg"))
        for p in file_paths
    ]
    data = {
        "type": "tts",
        "title": title,
        "train_mode": "fast",
        "visibility": "private",
        "enhance_audio_quality": "true",
    }
    resp = httpx.post(
        f"{API_BASE}/model", headers=_headers(), data=data, files=files, timeout=TIMEOUT
    )
    if resp.status_code not in (200, 201):
        raise FishAPIError(f"克隆失败: {_err_detail(resp)}", resp.status_code)
    body = resp.json()
    return {"voice_id": str(body["_id"]), "state": str(body.get("state", "created"))}


# ---------- TTS ----------

# TTS 模型:默认用完全免费的 s2.1-pro-free(SDK 的 Model 类型不支持它,所以走直连)。
# 充值 API 余额后可改为付费模型(音质更好): 在 .env 设 FISH_MODEL=s2.1-pro
FISH_MODEL = os.environ.get("FISH_MODEL", "s2.1-pro-free")


def synthesize(
    text: str, reference_id: str, format: str = "mp3", chunk_length: int = 200
) -> bytes:
    """用克隆声音合成语音,返回音频字节。

    注意: 必须走直连 httpx 并在 model 头指定模型;SDK 的 Model 类型不支持 s2.1-pro-free。
    """
    payload = {
        "text": text,
        "reference_id": reference_id,
        "format": format,
        "chunk_length": chunk_length,
    }
    headers = _headers()
    headers["model"] = FISH_MODEL
    resp = httpx.post(f"{API_BASE}/v1/tts", headers=headers, json=payload, timeout=TIMEOUT)
    if resp.status_code != 200:
        raise FishAPIError(f"语音合成失败: {_err_detail(resp)}", resp.status_code)
    return resp.content


# ---------- 列表 / 状态 / 删除 ----------

def list_models() -> List[dict]:
    """列出自己在 Fish 云端的所有模型 → [{voice_id, title, state}]。"""
    try:
        client = _sdk()
        page = client.voices.list(page_size=100, self_only=True)
        return [
            {"voice_id": str(v.id), "title": v.title, "state": str(v.state)}
            for v in page.items
        ]
    except Exception as e:
        logger.warning("SDK list 失败,改用直连: %s", e)
        return _list_models_raw()


def _list_models_raw() -> List[dict]:
    resp = httpx.get(
        f"{API_BASE}/model",
        headers=_headers(),
        params={"page_size": 100, "self": "true"},
        timeout=TIMEOUT,
    )
    if resp.status_code != 200:
        raise FishAPIError(f"获取云端模型列表失败: {_err_detail(resp)}", resp.status_code)
    items = resp.json().get("items", [])
    return [
        {"voice_id": str(v.get("_id")), "title": v.get("title", ""), "state": str(v.get("state", "unknown"))}
        for v in items
    ]


def get_voice_state(voice_id: str) -> str:
    """查询单个模型状态;云端不存在返回 'deleted'。"""
    try:
        client = _sdk()
        voice = client.voices.get(voice_id)
        return str(voice.state)
    except Exception as e:
        logger.debug("SDK get 失败,改用直连: %s", e)
        return _get_state_raw(voice_id)


def _get_state_raw(voice_id: str) -> str:
    resp = httpx.get(f"{API_BASE}/model/{voice_id}", headers=_headers(), timeout=TIMEOUT)
    if resp.status_code == 404:
        return "deleted"
    if resp.status_code != 200:
        return "unknown"
    return str(resp.json().get("state", "unknown"))


def delete_voice(voice_id: str) -> None:
    """删除云端模型;404 视为已删。"""
    try:
        client = _sdk()
        client.voices.delete(voice_id)
        return
    except Exception as e:
        logger.debug("SDK delete 失败,改用直连: %s", e)
    resp = httpx.delete(f"{API_BASE}/model/{voice_id}", headers=_headers(), timeout=TIMEOUT)
    if resp.status_code not in (200, 204, 404):
        raise FishAPIError(f"删除失败: {_err_detail(resp)}", resp.status_code)

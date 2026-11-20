"""日语声音克隆网站 - FastAPI 应用。

网页 API(/api/*)给浏览器用;插件 API(/api/v1/*)给扣子用,全 JSON。
启动: uvicorn app:app --host 0.0.0.0 --port 8000
"""
import logging
import os
import shutil
import time
from collections import defaultdict
from pathlib import Path
from typing import List
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

import audio_utils
import db
import fish_client
import openapi as openapi_mod

load_dotenv()  # 读取 .env(FISH_API_KEY / PUBLIC_BASE_URL / API_KEY / AUDIO_EXPIRE_DAYS)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("voice-clone")

PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")
API_KEY = os.environ.get("API_KEY", "")
AUDIO_EXPIRE_DAYS = int(os.environ.get("AUDIO_EXPIRE_DAYS", "30"))
# 公开模式: 部署给别人用时设为 1,禁用克隆/删除/同步,并加简单限流
PUBLIC_MODE = os.environ.get("PUBLIC_MODE", "") == "1"
TTS_RATE_LIMIT_PER_HOUR = int(os.environ.get("TTS_RATE_LIMIT_PER_HOUR", "60"))

# 简单的按 IP 内存限流(公开模式下防滥用,重启即清零)
_tts_hits: dict = defaultdict(list)


def _check_rate_limit(ip: str) -> None:
    now = time.time()
    hits = [t for t in _tts_hits[ip] if now - t < 3600]
    _tts_hits[ip] = hits
    if len(hits) >= TTS_RATE_LIMIT_PER_HOUR:
        raise HTTPException(429, f"请求太频繁了,每小时最多 {TTS_RATE_LIMIT_PER_HOUR} 次,请稍后再试")
    hits.append(now)

audio_utils.ensure_dirs()

app = FastAPI(title="日语声音克隆", version="1.0.0")

# FastAPI 自带 /openapi.json 路由会抢先生效,覆盖 openapi 函数使其输出扣子插件定义
app.openapi = lambda: openapi_mod.build_openapi(PUBLIC_BASE_URL)


class TTSRequest(BaseModel):
    text: str
    voice_id: str


@app.exception_handler(fish_client.FishAPIError)
async def fish_error_handler(request: Request, exc: fish_client.FishAPIError):
    return JSONResponse(
        status_code=502,
        content={"detail": str(exc), "fish_status": exc.status},
    )


@app.middleware("http")
async def api_key_middleware(request: Request, call_next):
    """API_KEY 配置后,/api/v1/*(插件接口)校验 X-API-Key 头。"""
    if API_KEY and request.url.path.startswith("/api/v1/"):
        if request.headers.get("X-API-Key") != API_KEY:
            return JSONResponse({"detail": "无效的 API Key"}, status_code=401)
    return await call_next(request)


# 公开模式下禁止的写操作路径(在参数校验之前拦截,确保返回 403 而不是 422)
_PUBLIC_BLOCKED = {"/api/clone", "/api/voices/sync", "/api/audio/cleanup"}


@app.middleware("http")
async def public_mode_middleware(request: Request, call_next):
    if PUBLIC_MODE:
        blocked = request.url.path in _PUBLIC_BLOCKED or (
            request.method == "DELETE" and request.url.path.startswith("/api/voices/")
        )
        if blocked:
            return JSONResponse({"detail": "公开模式下已禁用此功能(仅合成语音可用)"}, status_code=403)
    return await call_next(request)


@app.on_event("startup")
async def startup():
    db.init_db()
    if not audio_utils.ffmpeg_available():
        logger.warning("未检测到 ffmpeg,录音转码将降级为直传原文件(可能被 Fish 拒绝)")
    removed = audio_utils.cleanup_generated(AUDIO_EXPIRE_DAYS)
    if removed:
        logger.info("启动清理: 删除 %d 个过期音频产物", removed)


@app.get("/")
async def index():
    return FileResponse("static/index.html")


@app.get("/api/config")
async def api_config():
    """前端读取:公开模式下隐藏克隆/删除等功能。"""
    return {
        "public_mode": PUBLIC_MODE,
        "base_url": PUBLIC_BASE_URL,
        "tts_rate_limit_per_hour": TTS_RATE_LIMIT_PER_HOUR,
    }


# ---------- 网页 API ----------

@app.post("/api/clone")
async def api_clone(title: str = Form(...), files: List[UploadFile] = File(...)):
    """上传 1~3 个音频,克隆声音。"""
    if not 1 <= len(files) <= 3:
        raise HTTPException(400, "请上传 1~3 个音频文件")
    voice_title = title.strip() or "未命名の声"

    paths: List[Path] = []
    for up in files:
        suffix = Path(up.filename or "audio").suffix.lower() or ".mp3"
        tmp_src = audio_utils.TMP_DIR / f"{uuid4().hex}{suffix}"
        tmp_src.write_bytes(await up.read())
        tmp_mp3 = audio_utils.TMP_DIR / f"{uuid4().hex}.mp3"
        if audio_utils.convert_to_mp3(tmp_src, tmp_mp3):
            tmp_src.unlink(missing_ok=True)
            paths.append(tmp_mp3)
        else:
            paths.append(tmp_src)  # 转码失败,直传原文件兜底

    try:
        result = await run_in_threadpool(fish_client.create_voice, [str(p) for p in paths], voice_title)
    except Exception:
        for p in paths:
            p.unlink(missing_ok=True)
        raise

    voice_id, state = result["voice_id"], result["state"]

    # 保存第一段样本供声音库试听(在清理临时文件之前拷贝)
    sample_dir = audio_utils.SAMPLES_DIR / voice_id
    sample_dir.mkdir(parents=True, exist_ok=True)
    duration = None
    if paths:
        shutil.copy(paths[0], sample_dir / "sample.mp3")
        if paths[0].suffix == ".mp3":  # 原文件兜底时 mutagen 读不出时长
            duration = round(audio_utils.get_duration_mp3(sample_dir / "sample.mp3"), 2) or None
    for p in paths:
        p.unlink(missing_ok=True)

    db.upsert_voice(voice_id, voice_title, state, duration)
    logger.info("克隆成功 voice_id=%s title=%s state=%s", voice_id, voice_title, state)
    return {
        "voice_id": voice_id,
        "title": voice_title,
        "state": state,
        "duration": round(duration, 2) if duration else None,
    }


@app.get("/api/voices")
async def api_voices():
    return {"voices": db.list_voices()}


@app.get("/api/voices/sync")
async def api_voices_sync():
    """从 Fish 云端同步:刷新 state、补入云端新增、标记云端已删。"""
    remote = {m["voice_id"]: m for m in fish_client.list_models()}
    for rid, m in remote.items():
        local = db.get_voice(rid)
        if local is None:
            db.upsert_voice(rid, m["title"], m["state"])
        else:
            db.set_voice_state(rid, m["state"])
    for v in db.list_voices():
        if v["voice_id"] not in remote:
            st = fish_client.get_voice_state(v["voice_id"])
            db.set_voice_state(v["voice_id"], "deleted_remote" if st == "deleted" else st)
    return {"voices": db.list_voices()}


@app.post("/api/tts")
async def api_tts(req: TTSRequest, request: Request):
    """网页合成:返回二进制 mp3。"""
    if PUBLIC_MODE:
        _check_rate_limit(request.client.host if request.client else "unknown")
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "text 不能为空")
    if len(text) > 1000:
        raise HTTPException(400, "text 最长 1000 字")
    if not req.voice_id or not db.get_voice(req.voice_id):
        raise HTTPException(404, "voice_id 不存在")
    audio = await run_in_threadpool(fish_client.synthesize, text, req.voice_id)
    return Response(content=audio, media_type="audio/mpeg")


@app.delete("/api/voices/{voice_id}")
async def api_delete_voice(voice_id: str):
    """删除声音:先删 Fish 云端(404 视为已删),再删本地记录与样本。"""
    if not db.get_voice(voice_id):
        raise HTTPException(404, "voice_id 不存在")
    await run_in_threadpool(fish_client.delete_voice, voice_id)
    db.delete_voice(voice_id)
    shutil.rmtree(audio_utils.SAMPLES_DIR / voice_id, ignore_errors=True)
    return Response(status_code=204)


@app.post("/api/audio/cleanup")
async def api_cleanup():
    removed = audio_utils.cleanup_generated(AUDIO_EXPIRE_DAYS)
    return {"removed": removed}


# ---------- 扣子插件 API(全 JSON) ----------

@app.post("/api/v1/synthesize")
async def v1_synthesize(req: TTSRequest, request: Request):
    """扣子插件工具:返回 mp3 公网 URL + 时长。"""
    if PUBLIC_MODE:
        _check_rate_limit(request.client.host if request.client else "unknown")
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "text 不能为空")
    if len(text) > 500:
        raise HTTPException(400, "text 最长 500 字")
    if not db.get_voice(req.voice_id):
        raise HTTPException(400, "voice_id 不存在,请先用 voices 工具获取可用声音")

    audio = await run_in_threadpool(fish_client.synthesize, text, req.voice_id)
    name = f"{uuid4().hex}.mp3"
    path = audio_utils.GENERATED_DIR / name
    path.write_bytes(audio)
    duration = audio_utils.get_duration_mp3(path)
    return {
        "audio_url": f"{PUBLIC_BASE_URL}/audio/generated/{name}",
        "duration": round(duration, 2),
        "voice_id": req.voice_id,
    }


@app.get("/api/v1/voices")
async def v1_voices():
    """扣子插件工具:可用克隆声音列表。"""
    return {
        "voices": [
            {k: v[k] for k in ("voice_id", "title", "state", "created_at")}
            for v in db.list_voices()
            if v["state"] != "deleted_remote"
        ]
    }


# ---------- 扣子插件定义下载 ----------

@app.get("/openapi-plugin.json")
async def download_openapi():
    spec = openapi_mod.build_openapi(PUBLIC_BASE_URL)
    return JSONResponse(
        content=spec,
        headers={
            "Content-Disposition": 'attachment; filename="voice-tts-plugin.json"'
        },
    )


# ---------- 静态资源(放最后,避免遮蔽 API 路由) ----------

app.mount("/audio", StaticFiles(directory=str(audio_utils.DATA_DIR / "audio")), name="audio")
app.mount("/static", StaticFiles(directory="static"), name="static")

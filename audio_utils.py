"""音频处理:ffmpeg 转码/垫长、mutagen 时长、生成产物清理。"""
import shutil
import subprocess
import time
from pathlib import Path

from mutagen.mp3 import MP3

DATA_DIR = Path("data")
GENERATED_DIR = DATA_DIR / "audio" / "generated"
SAMPLES_DIR = DATA_DIR / "audio" / "samples"
TMP_DIR = DATA_DIR / "tmp"

# Fish Audio 克隆要求每段音频至少 10 秒
MIN_CLONE_SECONDS = 10.0


def ensure_dirs() -> None:
    for d in (GENERATED_DIR, SAMPLES_DIR, TMP_DIR):
        d.mkdir(parents=True, exist_ok=True)


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def _probe_duration(path: Path) -> float:
    """用 ffprobe 读时长(秒),失败返回 0。"""
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True, text=True, timeout=30,
        )
        return float(out.stdout.strip())
    except (ValueError, subprocess.SubprocessError, FileNotFoundError):
        return 0.0


def convert_to_mp3(
    src: Path,
    dst: Path,
    sample_rate: int = 44100,
    bitrate: str = "192k",
    min_seconds: float = MIN_CLONE_SECONDS,
) -> bool:
    """转码为 44.1kHz 单声道 mp3;不足 min_seconds 时循环垫长。失败返回 False。"""
    if not ffmpeg_available():
        return False
    dur = _probe_duration(src)
    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    if 0 < dur < min_seconds:
        cmd += ["-stream_loop", "-1", "-t", str(min_seconds + 2)]
    cmd += [
        "-i", str(src),
        "-vn", "-ac", "1", "-ar", str(sample_rate), "-b:a", bitrate,
        str(dst),
    ]
    try:
        subprocess.run(cmd, capture_output=True, timeout=120)
    except subprocess.SubprocessError:
        return False
    return dst.exists() and dst.stat().st_size > 0


def get_duration_mp3(path: Path) -> float:
    try:
        return float(MP3(str(path)).info.length)
    except Exception:
        return 0.0


def cleanup_generated(days: int = 30) -> int:
    """删除超过 days 天的生成产物,返回删除数量。"""
    if not GENERATED_DIR.exists():
        return 0
    cutoff = time.time() - days * 86400
    removed = 0
    for f in GENERATED_DIR.glob("*.mp3"):
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink()
                removed += 1
        except OSError:
            pass
    return removed

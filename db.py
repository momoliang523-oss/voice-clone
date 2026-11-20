"""本地声音库(SQLite)。

本地记录是声音列表的权威来源,Fish 云端只做状态同步。
"""
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path("data/voices.db")
_lock = threading.Lock()


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _lock, _conn() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS voices (
                voice_id   TEXT PRIMARY KEY,
                title      TEXT NOT NULL,
                state      TEXT NOT NULL DEFAULT 'created',
                duration   REAL,
                created_at TEXT NOT NULL
            )
            """
        )


def upsert_voice(voice_id: str, title: str, state: str, duration: float = None) -> None:
    with _lock, _conn() as conn:
        conn.execute(
            """
            INSERT INTO voices (voice_id, title, state, duration, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(voice_id) DO UPDATE SET
                title = excluded.title,
                state = excluded.state,
                duration = COALESCE(excluded.duration, voices.duration),
                created_at = voices.created_at
            """,
            (voice_id, title, state, duration, _iso_now()),
        )


def list_voices() -> list:
    with _lock, _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM voices ORDER BY created_at DESC, rowid DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_voice(voice_id: str) -> dict:
    with _lock, _conn() as conn:
        row = conn.execute(
            "SELECT * FROM voices WHERE voice_id = ?", (voice_id,)
        ).fetchone()
    return dict(row) if row else None


def set_voice_state(voice_id: str, state: str) -> None:
    with _lock, _conn() as conn:
        conn.execute(
            "UPDATE voices SET state = ? WHERE voice_id = ?", (state, voice_id)
        )


def delete_voice(voice_id: str) -> None:
    with _lock, _conn() as conn:
        conn.execute("DELETE FROM voices WHERE voice_id = ?", (voice_id,))

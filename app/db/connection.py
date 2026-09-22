"""Database connection and storage configuration."""
from __future__ import annotations

import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

_DEFAULT_DATA = Path(__file__).resolve().parent.parent.parent / "data"
DB_PATH = _DEFAULT_DATA / "chat.db"
DB_MAX_BYTES = 3 * 1024**3


def configure_storage(data_dir: Path | str, max_db_bytes: int) -> None:
    global DB_PATH, DB_MAX_BYTES
    root = Path(data_dir).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    DB_PATH = root / "chat.db"
    DB_MAX_BYTES = int(max_db_bytes)
    # Synchronize with app.database facade if loaded
    db_mod = sys.modules.get("app.database")
    if db_mod is not None:
        db_mod.DB_PATH = DB_PATH
        db_mod.DB_MAX_BYTES = DB_MAX_BYTES


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get_connection() -> sqlite3.Connection:
    # Check if app.database.DB_PATH was monkeypatched in tests
    db_mod = sys.modules.get("app.database")
    effective_path = getattr(db_mod, "DB_PATH", DB_PATH) if db_mod else DB_PATH
    effective_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(effective_path, check_same_thread=False, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn

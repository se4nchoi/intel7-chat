"""마디 (Madi) settings, read from MADI_* environment variables.

Defaults match the single-PC prototype, so an unconfigured run behaves as
before. Deployment sets only what differs. Values are read on each call so
tests and a restarted launcher see the current environment.

| Variable              | Default                       | Meaning                                  |
| --------------------- | ----------------------------- | ---------------------------------------- |
| MADI_DATABASE_URL     | (none: hub disabled)          | PostgreSQL connection URL                |
| MADI_DB_POOL_SIZE     | 10                            | Max pooled database connections          |
| MADI_FILE_DIR         | <repo>/data_dev/hub-files     | Where uploaded file bytes are stored     |
| MADI_SESSION_HOURS    | 12                            | Login session lifetime                   |
| MADI_SFU_URL          | (none: screen sharing off)    | LiveKit WSS URL the browser connects to  |
| LIVEKIT_API_KEY       | (none)                        | LiveKit key for media tokens             |
| LIVEKIT_API_SECRET    | (none)                        | LiveKit secret for media tokens          |
| MADI_ALLOWED_HOSTS    | (none)                        | Extra host names the app answers to,     |
|                       |                               | comma-separated (e.g. madi.example.kr)   |

The launcher (prototype_run.py) also reads MADI_HOST, MADI_PORT,
MADI_TLS_CERT and MADI_TLS_KEY.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_FILE_DIR = REPO_ROOT / "data_dev" / "hub-files"


@dataclass(frozen=True)
class Settings:
    database_url: str | None
    db_pool_size: int
    file_dir: Path
    session_hours: int
    sfu_url: str | None
    livekit_api_key: str | None
    livekit_api_secret: str | None

    @property
    def sfu_configured(self) -> bool:
        return bool(self.sfu_url and self.livekit_api_key and self.livekit_api_secret)


def _positive_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise RuntimeError(f"{name} must be a whole number, got {raw!r}") from None
    if value < 1:
        raise RuntimeError(f"{name} must be at least 1, got {value}")
    return value


def settings() -> Settings:
    env = os.environ.get
    file_dir = env("MADI_FILE_DIR", "").strip()
    return Settings(
        database_url=env("MADI_DATABASE_URL") or None,
        db_pool_size=_positive_int("MADI_DB_POOL_SIZE", 10),
        file_dir=Path(file_dir).expanduser().resolve() if file_dir else DEFAULT_FILE_DIR,
        session_hours=_positive_int("MADI_SESSION_HOURS", 12),
        sfu_url=env("MADI_SFU_URL") or None,
        livekit_api_key=env("LIVEKIT_API_KEY") or None,
        livekit_api_secret=env("LIVEKIT_API_SECRET") or None,
    )


def allowed_hosts() -> set[str]:
    return {h.strip().casefold() for h in os.environ.get("MADI_ALLOWED_HOSTS", "").split(",") if h.strip()}

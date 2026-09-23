"""Run an isolated, loopback-only HTTPS prototype beside the live LAN service."""

from __future__ import annotations

import argparse
import os
import secrets
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "bamboochat_dev.json"
DATA_DIR = ROOT / "data_dev"
TLS_DIR = DATA_DIR / "tls"
PG_ENV_PATH = DATA_DIR / "pg-app.env"
LIVEKIT_ENV_PATH = DATA_DIR / "livekit.env"
CERT_PATH = TLS_DIR / "localhost.crt"
KEY_PATH = TLS_DIR / "localhost.key"
HOST = "127.0.0.1"
PORT = 8443


def initialize() -> None:
    """Create credentials and storage only inside this worktree."""
    from app.auth import hash_secret
    from app.config import RoomConfig, save_config
    from app.database import configure_storage, create_user, init_db

    if CONFIG_PATH.exists() or (DATA_DIR / "chat.db").exists():
        raise SystemExit("Prototype configuration or database already exists; refusing to overwrite it.")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    password = "".join(secrets.choice("abcdefghjkmnpqrstuvwxyz23456789") for _ in range(12))
    config = RoomConfig(
        server_name="BambooChat Prototype",
        data_dir=str(DATA_DIR),
        bind_host=HOST,
        port=PORT,
        registration_enabled=False,
    )
    configure_storage(DATA_DIR, config.database_limit_bytes)
    init_db()
    create_user("prototype_admin", hash_secret(password), role="admin")
    save_config(config, CONFIG_PATH)
    credentials_path = DATA_DIR / "prototype-admin.txt"
    credentials_path.write_text(
        f"Local prototype only\nURL: https://{HOST}:{PORT}\n"
        f"Username: prototype_admin\nPassword: {password}\n",
        encoding="utf-8",
    )
    print(f"Prototype initialized. Credentials: {credentials_path}")


def checked_config():
    from app.config import load_config

    if not CONFIG_PATH.exists():
        raise SystemExit("Run `uv run --locked python prototype_run.py --init` first.")
    config = load_config(CONFIG_PATH)
    if (config.data_path != DATA_DIR.resolve() or
            config.bind_host != HOST or config.port != PORT):
        raise SystemExit("Prototype configuration must use its own data_dev directory and 127.0.0.1:8443.")
    return config


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--init", action="store_true", help="Create isolated local data and admin credentials")
    parser.add_argument("--check", action="store_true", help="Check isolation and TLS files without starting")
    parser.add_argument("--init-pg", action="store_true", help="Initialize the isolated PostgreSQL hub schema and demo cohort")
    parser.add_argument("--reload", action="store_true", help="Reload when prototype code changes")
    args = parser.parse_args()

    if args.init:
        initialize()
        return

    checked_config()
    if not PG_ENV_PATH.is_file():
        raise SystemExit(f"Missing prototype PostgreSQL credentials: {PG_ENV_PATH}")
    line = PG_ENV_PATH.read_text(encoding="utf-8").strip()
    if not line.startswith("DATABASE_URL=postgresql://") or "@127.0.0.1:55432/" not in line:
        raise SystemExit("Prototype PostgreSQL must use 127.0.0.1:55432")
    os.environ["BAMBOOCHAT_HUB_DATABASE_URL"] = line.partition("=")[2]
    os.environ["BAMBOOCHAT_HUB_SFU_URL"] = "wss://127.0.0.1:7882"
    if not LIVEKIT_ENV_PATH.is_file():
        raise SystemExit(f"Missing prototype LiveKit credentials: {LIVEKIT_ENV_PATH}")
    for line in LIVEKIT_ENV_PATH.read_text(encoding="utf-8").splitlines():
        key, separator, value = line.partition("=")
        if separator and key in {"LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"}:
            os.environ[key] = value
    if not os.environ.get("LIVEKIT_API_KEY") or not os.environ.get("LIVEKIT_API_SECRET"):
        raise SystemExit("LiveKit API key and secret are required")
    if args.init_pg:
        from app.hub.db import initialize_schema, seed_demo
        initialize_schema()
        print("Prototype hub seeded" if seed_demo(DATA_DIR) else "Prototype hub already initialized")
        return
    if not CERT_PATH.is_file() or not KEY_PATH.is_file():
        raise SystemExit(f"Missing TLS certificate/key in {TLS_DIR}; run scripts/create_prototype_cert.ps1.")
    if args.check:
        print(f"Prototype ready: https://{HOST}:{PORT}; data: {DATA_DIR}; TLS: {CERT_PATH}")
        return

    os.environ["BAMBOOCHAT_CONFIG"] = str(CONFIG_PATH)
    os.environ["BAMBOOCHAT_SESSION_COOKIE"] = "bamboochat_prototype_session"

    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=HOST,
        port=PORT,
        reload=args.reload,
        ssl_certfile=str(CERT_PATH),
        ssl_keyfile=str(KEY_PATH),
        ws_max_size=65536,
        ws_max_queue=16,
        ws_per_message_deflate=False,
        limit_concurrency=60,
        server_header=False,
    )


if __name__ == "__main__":
    main()

"""Persistent room configuration loaded before the FastAPI app starts."""
from __future__ import annotations
import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path

GIB = 1024**3
DEFAULT_CONFIG_PATH = Path(os.getenv("BAMBOOCHAT_CONFIG", "bamboochat.json")).resolve()

@dataclass
class RoomConfig:
    server_name: str = "인텔7기 대나무숲"
    data_dir: str = str((Path(__file__).resolve().parent.parent / "data").resolve())
    bind_host: str = "0.0.0.0"
    port: int = 8000
    attachment_limit_bytes: int = 10 * GIB
    database_limit_bytes: int = 3 * GIB
    per_user_attachment_limit_bytes: int = 2 * GIB
    session_hours: int = 12
    registration_enabled: bool = True
    enrollment_code_hash: str = ""

    @property
    def data_path(self) -> Path:
        return Path(self.data_dir).expanduser().resolve()

def load_config(path: Path | str | None = None) -> RoomConfig:
    config_path = Path(path or os.getenv("BAMBOOCHAT_CONFIG", str(DEFAULT_CONFIG_PATH))).resolve()
    if not config_path.exists():
        return RoomConfig()
    values = json.loads(config_path.read_text(encoding="utf-8"))
    known = RoomConfig.__dataclass_fields__
    return RoomConfig(**{key: value for key, value in values.items() if key in known})

def save_config(config: RoomConfig, path: Path | str | None = None) -> Path:
    config_path = Path(path or os.getenv("BAMBOOCHAT_CONFIG", str(DEFAULT_CONFIG_PATH))).resolve()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = config_path.with_suffix(config_path.suffix + ".tmp")
    temporary.write_text(json.dumps(asdict(config), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(config_path)
    return config_path

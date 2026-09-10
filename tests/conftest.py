"""Global pytest fixtures and environment isolation for BambooChat."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path
import pytest

# Ensure a temporary dummy config is set before any tests import app.main or app.config,
# so that the production bamboochat.json (pointing to BambooChatData) is NEVER loaded during test runs.
_TEST_DATA_DIR = tempfile.mkdtemp(prefix="bamboochat_test_global_")
_TEST_CONFIG_PATH = Path(_TEST_DATA_DIR) / "bamboochat_test.json"
_TEST_CONFIG_PATH.write_text(
    f'{{\n  "server_name": "Test Room",\n  "data_dir": "{_TEST_DATA_DIR.replace(os.sep, "/")}",\n  "port": 8000\n}}\n',
    encoding="utf-8",
)
os.environ["BAMBOOCHAT_CONFIG"] = str(_TEST_CONFIG_PATH)

from app import database


@pytest.fixture(autouse=True)
def global_database_isolation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Ensure every test runs with an isolated database in tmp_path."""
    db_file = tmp_path / "chat.db"
    monkeypatch.setattr(database, "DB_PATH", db_file)
    monkeypatch.setattr(database, "DB_MAX_BYTES", 100 * 1024 * 1024)
    monkeypatch.setenv("BAMBOOCHAT_CONFIG", str(tmp_path / "bamboochat.json"))
    database.init_db()
    yield

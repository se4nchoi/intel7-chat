"""Standalone deployment behavior, without a PostgreSQL server."""
import subprocess
import sys
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.hub import application, db, routes
import madi_run


@pytest.fixture
def academy(monkeypatch, tmp_path):
    build = tmp_path / "dist"
    (build / "assets").mkdir(parents=True)
    (build / "index.html").write_text("<html>academy</html>", encoding="utf-8")
    (build / "assets" / "app-abcd.js").write_text("export {};", encoding="utf-8")
    monkeypatch.setattr(routes, "FRONTEND_BUILD_DIR", build)
    monkeypatch.setenv("MADI_DATABASE_URL", "postgresql://madi:secret@127.0.0.1/madi")
    monkeypatch.setenv("MADI_ALLOWED_HOSTS", "10.10.1.2,madi.academy.local")
    monkeypatch.setenv("MADI_FILE_DIR", str(tmp_path / "files"))
    monkeypatch.setenv("MADI_LOG_FILE", str(tmp_path / "logs" / "madi.log"))
    for name in ("MADI_SFU_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"):
        monkeypatch.delenv(name, raising=False)
    events = []
    monkeypatch.setattr(db, "initialize_schema", lambda: events.append("migrate"))
    monkeypatch.setattr(db, "close_pools", lambda: events.append("close"))
    return events


def test_standalone_import_does_not_load_community_app_or_storage():
    script = """
import sys
import app.hub.application
assert 'app.main' not in sys.modules
assert 'app.database' not in sys.modules
assert 'app.config' not in sys.modules
"""
    subprocess.run([sys.executable, "-c", script], check=True, capture_output=True, text=True)


def test_lifecycle_routes_headers_and_asset_cache(academy):
    with TestClient(application.create_app(), base_url="https://10.10.1.2") as client:
        assert academy == ["migrate"]
        assert client.get("/").text == "<html>academy</html>"
        assert client.get("/health/live").json() == {"status": "ok"}
        assert client.get("/hub").headers["cache-control"] == "no-store"
        asset = client.get("/hub/assets/app-abcd.js")
        assert asset.status_code == 200 and "immutable" in asset.headers["cache-control"]
        assert client.get("/hub/assets/missing.js").headers["cache-control"] == "no-store"
        assert client.get("/api/channels").status_code == 404  # No community endpoints.
        assert "script-src 'self'" in asset.headers["content-security-policy"]
    assert academy == ["migrate", "close"]


def test_pool_cleanup_even_if_migration_fails(academy, monkeypatch):
    def fail():
        raise RuntimeError("database unavailable")
    monkeypatch.setattr(db, "initialize_schema", fail)
    with pytest.raises(RuntimeError, match="database unavailable"):
        with TestClient(application.create_app()):
            pass
    assert academy == ["close"]


def test_unknown_host_rejected_for_http_and_websocket(academy):
    client = TestClient(application.create_app(), base_url="https://foreign.example")
    assert client.get("/health/live").status_code == 400
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/hub/ws/cohorts/1"):
            pass


def test_csp_allows_only_configured_media_host(academy, monkeypatch):
    monkeypatch.setenv("MADI_SFU_URL", "wss://10.10.1.3:8443/media")
    monkeypatch.setenv("LIVEKIT_API_KEY", "key")
    monkeypatch.setenv("LIVEKIT_API_SECRET", "secret")
    response = TestClient(application.create_app()).get("/health/live")
    csp = response.headers["content-security-policy"]
    assert "connect-src 'self' wss://10.10.1.3:8443 https://10.10.1.3:8443" in csp
    assert "unsafe-inline" not in csp.split("script-src")[1]


@pytest.mark.parametrize("name,value,expected", [
    ("MADI_DATABASE_URL", "", "MADI_DATABASE_URL"),
    ("MADI_DATABASE_URL", "sqlite:///madi.db", "PostgreSQL"),
    ("MADI_ALLOWED_HOSTS", "*", "MADI_ALLOWED_HOSTS"),
    ("MADI_ALLOWED_HOSTS", "10.10.1.2:443", "MADI_ALLOWED_HOSTS"),
    ("MADI_SFU_URL", "wss://media.local", "together"),
])
def test_incomplete_config_fails_before_database(academy, monkeypatch, name, value, expected):
    monkeypatch.setenv(name, value)
    with pytest.raises(RuntimeError, match=expected):
        application.create_app()
    assert academy == []


@pytest.mark.parametrize("url", ["ws://10.10.1.2", "wss://user:password@media.local", "wss://media.local/?secret=foo", "wss://media.local:broken", "wss://media.local;'unsafe-inline'"])
def test_invalid_media_urls_rejected(academy, monkeypatch, url):
    monkeypatch.setenv("MADI_SFU_URL", url)
    monkeypatch.setenv("LIVEKIT_API_KEY", "key")
    monkeypatch.setenv("LIVEKIT_API_SECRET", "secret")
    with pytest.raises(RuntimeError, match="MADI_SFU_URL"):
        application.create_app()


def test_check_does_not_connect_or_create_data(academy, capsys, monkeypatch):
    assert madi_run.main(["--check"]) == 0
    assert academy == []
    assert "has not been checked" in capsys.readouterr().out


def test_bootstrap_prompts_and_does_not_log_password(academy, monkeypatch, capsys):
    inputs = iter(["academy_admin", "Administrator"])
    monkeypatch.setattr("builtins.input", lambda _: next(inputs))
    monkeypatch.setattr(madi_run.getpass, "getpass", lambda _: "private-password")
    created = []
    monkeypatch.setattr(db, "bootstrap_admin", lambda *args: created.append(args))
    assert madi_run.main(["--create-admin"]) == 0
    assert created == [("academy_admin", "Administrator", "private-password")]
    assert academy == ["migrate", "close"]
    assert "private-password" not in capsys.readouterr().out


def test_existing_admin_bootstrap_is_refused(academy, monkeypatch):
    queries = []
    class ExistingAdmin:
        def execute(self, query, *args):
            queries.append(query)
            return self
        def fetchone(self):
            return {"exists": 1}
    @contextmanager
    def connect():
        yield ExistingAdmin()
    monkeypatch.setattr(db, "connect", connect)
    with pytest.raises(RuntimeError, match="already exists"):
        db.bootstrap_admin("other", "Other", "password")
    assert "pg_advisory_xact_lock" in queries[0]
    assert not any("INSERT" in query for query in queries)

"""Upload route accepts classroom formats and rejects active downloads."""
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.hub import routes


def test_madi_upload_policy_is_enforced_before_storage(monkeypatch, tmp_path):
    saved = []

    async def cohort(_request, _cohort_id, **_kwargs):
        return {"id": 7, "username": "student"}, {"role": "student", "archived": False}

    async def broadcast(*_args, **_kwargs):
        return None

    monkeypatch.setattr(routes, "_cohort", cohort)
    monkeypatch.setattr(routes, "_broadcast", broadcast)
    monkeypatch.setattr(routes, "settings", lambda: SimpleNamespace(file_dir=tmp_path))
    monkeypatch.setattr(routes.db, "add_file", lambda *args: saved.append(args))
    app = FastAPI()
    app.include_router(routes.router)
    client = TestClient(app, base_url="https://localhost")

    accepted = client.post("/hub/api/cohorts/1/files", files={"upload": ("ladder.gwx", b"PLC bytes", "application/octet-stream")})
    assert accepted.status_code == 201
    assert saved[0][3] == "ladder.gwx"
    assert (tmp_path / accepted.json()["id"]).read_bytes() == b"PLC bytes"

    blocked = client.post("/hub/api/cohorts/1/files", files={"upload": ("lesson.pdf.cmd", b"script", "application/octet-stream")})
    assert blocked.status_code == 415
    assert len(saved) == 1

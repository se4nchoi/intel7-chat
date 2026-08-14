import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import app.database as database
import app.main as main


@pytest.fixture(autouse=True)
def isolated_state(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", str(tmp_path / "chat.db"))
    monkeypatch.setattr(main, "UPLOAD_DIR", tmp_path / "uploads")
    main.connected_clients.clear()
    main.nickname_registry.clear()
    main.message_timestamps.clear()
    main.upload_timestamps.clear()
    yield
    main.connected_clients.clear()
    main.nickname_registry.clear()
    main.message_timestamps.clear()
    main.upload_timestamps.clear()


def request_headers(filename="project.gxw", nickname="Ronaldo"):
    return {
        "origin": "http://testserver",
        "X-Chat-Nickname": nickname,
        "X-File-Name": filename,
        "Content-Type": "application/octet-stream",
    }


def test_ip_suffix_exposes_only_final_two_ipv4_octets():
    assert database.get_ip_suffix("192.168.72.50") == "72.50"
    assert database.get_ip_suffix("not-an-ip") == ""


def test_host_allowlist_accepts_lan_names_and_rejects_public_dns():
    assert main.host_is_allowed("192.168.1.42:8000")
    assert main.host_is_allowed("CLASSROOM-PC:8000")
    assert main.host_is_allowed("classchat.local:8000")
    assert not main.host_is_allowed("evil.example:8000")


def test_recent_messages_include_stable_id_reply_and_no_full_ip():
    database.init_db()
    saved = database.save_message(
        "Ronaldo",
        "**hello**",
        ip="192.168.72.50",
        reply={"nickname": "Mina", "content": "earlier"},
    )
    messages = database.get_recent_messages()

    assert saved["message_id"].startswith("public:")
    assert messages[0]["message_id"] == saved["message_id"]
    assert messages[0]["reply"] == {"nickname": "Mina", "content": "earlier"}
    assert messages[0]["ip_suffix"] == "72.50"
    assert "ip" not in messages[0]
    assert "192.168.72.50" not in json.dumps(messages)


def test_http_security_headers_and_api_docs_disabled():
    with TestClient(main.app) as client:
        response = client.get("/")
        assert response.status_code == 200
        assert response.headers["x-frame-options"] == "DENY"
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.headers["referrer-policy"] == "no-referrer"
        assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
        assert client.get("/docs").status_code == 404
        assert client.get("/openapi.json").status_code == 404
        assert client.get("/", headers={"host": "evil.example"}).status_code == 400


def test_websocket_rejects_cross_origin_connection():
    with TestClient(main.app) as client:
        with pytest.raises(WebSocketDisconnect) as rejected:
            with client.websocket_connect(
                "/ws?nickname=attacker",
                headers={"origin": "http://evil.example"},
            ):
                pass
        assert rejected.value.code == 1008


def test_public_chat_includes_id_partial_ip_markdown_and_reply(monkeypatch):
    monkeypatch.setattr(main, "get_client_ip", lambda _connection: "192.168.72.50")
    with TestClient(main.app) as client:
        with client.websocket_connect(
            "/ws?nickname=Ronaldo",
            headers={"origin": "http://testserver"},
        ) as websocket:
            websocket.receive_json()  # presence
            websocket.receive_json()  # users
            websocket.send_json({
                "type": "chat",
                "content": "**hello**",
                "reply": {"nickname": "Mina", "content": "earlier"},
            })
            message = websocket.receive_json()

    assert message["message_id"].startswith("public:")
    assert message["content"] == "**hello**"
    assert message["reply"] == {"nickname": "Mina", "content": "earlier"}
    assert message["ip_suffix"] == "72.50"
    assert "192.168.72.50" not in json.dumps(message)


def test_gxw_upload_can_be_claimed_and_downloaded(monkeypatch):
    monkeypatch.setattr(main, "get_client_ip", lambda _connection: "192.168.72.50")
    payload = b"GX Works2 classroom project"
    with TestClient(main.app) as client:
        with client.websocket_connect(
            "/ws?nickname=Ronaldo",
            headers={"origin": "http://testserver"},
        ) as websocket:
            websocket.receive_json()
            websocket.receive_json()
            upload = client.post("/api/files", headers=request_headers(), content=payload)
            assert upload.status_code == 201
            attachment = upload.json()
            assert attachment["name"] == "project.gxw"
            assert attachment["previewable"] is False

            websocket.send_json({
                "type": "chat",
                "content": "PLC project",
                "attachment_id": attachment["id"],
            })
            message = websocket.receive_json()
            assert message["attachment"]["id"] == attachment["id"]

        download = client.get(attachment["url"])
        assert download.status_code == 200
        assert download.content == payload
        assert download.headers["content-type"] == "application/octet-stream"
        assert download.headers["content-disposition"].startswith("attachment;")


@pytest.mark.parametrize("filename", ["machine-config.vendorx", "ladder.gwx", "slides.pptx", "lecture.pdf"])
def test_classroom_and_unknown_extensions_are_allowed(monkeypatch, filename):
    monkeypatch.setattr(main, "active_client_matches", lambda _nickname, _ip: True)
    with TestClient(main.app) as client:
        response = client.post(
            "/api/files",
            headers=request_headers(filename),
            content=b"vendor data",
        )
    assert response.status_code == 201
    assert response.json()["name"] == filename


@pytest.mark.parametrize("filename", ["malware.exe", "lesson.pdf.cmd", "page.html", "vector.svg"])
def test_active_or_executable_uploads_are_blocked(monkeypatch, filename):
    monkeypatch.setattr(main, "active_client_matches", lambda _nickname, _ip: True)
    with TestClient(main.app) as client:
        response = client.post(
            "/api/files",
            headers=request_headers(filename),
            content=b"blocked",
        )
    assert response.status_code == 415


def test_upload_rejects_oversized_stream(monkeypatch):
    monkeypatch.setattr(main, "active_client_matches", lambda _nickname, _ip: True)
    monkeypatch.setattr(main, "MAX_UPLOAD_BYTES", 4)
    with TestClient(main.app) as client:
        response = client.post(
            "/api/files",
            headers=request_headers(),
            content=b"12345",
        )
    assert response.status_code == 413
    assert not list(main.UPLOAD_DIR.glob("*"))


def test_valid_image_is_previewable_but_name_cannot_fake_it(monkeypatch):
    monkeypatch.setattr(main, "active_client_matches", lambda _nickname, _ip: True)
    png = b"\x89PNG\r\n\x1a\n" + b"image data"
    with TestClient(main.app) as client:
        valid = client.post(
            "/api/files",
            headers=request_headers("diagram.png"),
            content=png,
        )
        fake = client.post(
            "/api/files",
            headers=request_headers("fake.png"),
            content=b"not an image",
        )
        preview = client.get(valid.json()["url"])
    assert valid.json()["previewable"] is True
    assert fake.json()["previewable"] is False
    assert preview.headers["content-type"].startswith("image/png")
    assert preview.headers["content-disposition"].startswith("inline;")


def test_unclaimed_attachment_can_be_discarded(monkeypatch):
    monkeypatch.setattr(main, "active_client_matches", lambda _nickname, _ip: True)
    with TestClient(main.app) as client:
        upload = client.post(
            "/api/files",
            headers=request_headers(),
            content=b"temporary",
        )
        attachment = upload.json()
        response = client.delete(
            attachment["url"],
            headers={
                "origin": "http://testserver",
                "X-Chat-Nickname": "Ronaldo",
            },
        )
        missing = client.get(attachment["url"])
    assert response.status_code == 204
    assert missing.status_code == 404


def test_cleanup_removes_expired_attachment_file():
    database.init_db()
    main.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    stored_name = "expired.upload"
    (main.UPLOAD_DIR / stored_name).write_bytes(b"old")
    old = (datetime.now(timezone.utc) - timedelta(hours=11)).strftime("%Y-%m-%dT%H:%M:%SZ")
    database.save_attachment({
        "id": "expired",
        "original_name": "old.gxw",
        "stored_name": stored_name,
        "size": 3,
        "sha256": "0" * 64,
        "content_type": "application/octet-stream",
        "previewable": False,
        "uploader_nickname": "Ronaldo",
        "ip": "192.168.72.50",
        "created_at": old,
    })

    main.cleanup_expired_content()

    assert database.get_attachment_record("expired") is None
    assert not (main.UPLOAD_DIR / stored_name).exists()


def test_filename_cleanup_and_reply_limits():
    assert main.clean_original_filename("..%2F..%2Fproject.gwx") == "project.gwx"
    assert main.upload_is_blocked("lesson.PDF.EXE")
    reply = main.clean_reply({"nickname": "n" * 100, "content": "c" * 500})
    assert len(reply["nickname"]) == main.MAX_NICKNAME_LEN
    assert len(reply["content"]) == main.MAX_REPLY_CONTENT_LEN


def test_rate_limit_uses_a_sliding_window():
    for _ in range(main.RATE_LIMIT_MESSAGES):
        assert main.message_rate_allowed("192.168.1.5", now=100.0)
    assert not main.message_rate_allowed("192.168.1.5", now=100.0)
    assert main.message_rate_allowed(
        "192.168.1.5",
        now=100.0 + main.RATE_LIMIT_WINDOW_SECONDS + 0.01,
    )

"""Tests for Iteration 2 — Channel Data & Backend: schema, CRUD, routing, history, migrations."""
import json
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import database, main
from app.auth import (hash_secret, token_hash, validate_channel_description,
                      validate_channel_display_name, validate_channel_name)
from app.config import GIB

ORIGIN = {"origin": "http://testserver"}


@pytest.fixture(autouse=True)
def isolated_state(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", tmp_path / "chat.db")
    monkeypatch.setattr(database, "DB_MAX_BYTES", 3 * GIB)
    monkeypatch.setattr(main, "UPLOAD_DIR", tmp_path / "uploads")
    monkeypatch.setenv("BAMBOOCHAT_CONFIG", str(tmp_path / "bamboochat.json"))
    monkeypatch.setattr(main.CONFIG, "registration_enabled", True)
    monkeypatch.setattr(main.CONFIG, "enrollment_code_hash", "")
    main.connected_clients.clear()
    main.user_registry.clear()
    main.message_timestamps.clear()
    main.upload_timestamps.clear()
    main.login_timestamps.clear()
    main.UPLOAD_DIR.mkdir(parents=True)
    database.init_db()
    yield


def session_client(username="student", role="student"):
    user = database.create_user(username, "not-used-in-session-tests", role=role)
    raw = f"session-token-for-user-{user['id']}"
    expires = "2999-01-01T00:00:00Z"
    database.create_session(token_hash(raw), user["id"], expires)
    client = TestClient(main.app)
    client.cookies.set(main.SESSION_COOKIE, raw)
    return client, user


# ==========================================================================
# 1. Migration v2 & Default Channel
# ==========================================================================

class TestChannelMigration:
    def test_schema_version_is_at_least_2(self):
        with database.get_connection() as conn:
            version = database._get_schema_version(conn)
        assert version >= 2

    def test_default_general_channel_is_seeded(self):
        general = database.get_channel_by_id(1)
        assert general is not None
        assert general["id"] == 1
        assert general["name"] == "general"
        assert general["display_name"] == "전체 채팅"
        assert general["is_default"] is True
        assert len(general["uuid"]) == 32

    def test_messages_table_has_channel_id_and_index(self):
        with database.get_connection() as conn:
            cols = {row[1] for row in conn.execute("PRAGMA table_info(messages)")}
            assert "channel_id" in cols
            indexes = {row[1] for row in conn.execute("PRAGMA index_list(messages)")}
            assert "idx_messages_channel_created" in indexes

    def test_upgrade_from_v0_seeds_default_channel_and_backfills_messages(self, tmp_path, monkeypatch):
        """Simulate upgrade from legacy database: messages without channel_id become channel 1."""
        legacy_db = tmp_path / "legacy_v0_channels.db"
        conn = sqlite3.connect(legacy_db)
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("""CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            normalized_username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'student',
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            last_login TEXT
        )""")
        conn.execute("""CREATE TABLE sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )""")
        conn.execute("""CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nickname TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            ip TEXT NOT NULL DEFAULT '',
            reply_nickname TEXT,
            reply_content TEXT,
            attachment_id TEXT,
            user_id INTEGER
        )""")
        conn.execute("""CREATE TABLE message_attachments (
            message_id INTEGER NOT NULL,
            attachment_id TEXT NOT NULL,
            original_name TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (message_id, attachment_id)
        )""")
        conn.execute("""CREATE TABLE attachments (
            id TEXT PRIMARY KEY, original_name TEXT, stored_name TEXT, size INT, sha256 TEXT,
            content_type TEXT, previewable INT, uploader_nickname TEXT, ip TEXT, owner_token_hash TEXT,
            created_at TEXT, claimed INT, uploader_user_id INT
        )""")
        conn.execute("""CREATE TABLE direct_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, sender_user_id INT, recipient_user_id INT,
            sender_nickname TEXT, recipient_nickname TEXT, content TEXT, created_at TEXT,
            reply_nickname TEXT, reply_content TEXT
        )""")
        conn.execute("""CREATE TABLE direct_message_attachments (
            direct_message_id INT, attachment_id TEXT, original_name TEXT, position INT,
            PRIMARY KEY (direct_message_id, attachment_id)
        )""")

        conn.execute(
            "INSERT INTO users (username, normalized_username, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            ("alice", "alice", "hash_alice", "admin", 1, "2026-08-01T00:00:00Z"),
        )
        conn.execute(
            "INSERT INTO messages (nickname, content, created_at, user_id) VALUES (?, ?, ?, ?)",
            ("alice", "Old legacy message", "2026-08-01T01:00:00Z", 1),
        )
        conn.commit()
        conn.close()

        monkeypatch.setattr(database, "DB_PATH", legacy_db)
        database.init_db()

        with database.get_connection() as c:
            assert database._get_schema_version(c) >= 2
            row = c.execute("SELECT channel_id FROM messages WHERE id=1").fetchone()
            assert row[0] == 1
            default_chan = database.get_channel_by_id(1)
            assert default_chan["name"] == "general"
            assert default_chan["display_name"] == "전체 채팅"


# ==========================================================================
# 2. Channel Validation
# ==========================================================================

class TestChannelValidation:
    def test_valid_channel_names(self):
        assert validate_channel_name("general") == "general"
        assert validate_channel_name("study-qna") == "study-qna"
        assert validate_channel_name("team_project_1") == "team_project_1"
        assert validate_channel_name("질문게시판") == "질문게시판"
        assert validate_channel_name("  Study-Room  ") == "study-room"

    def test_invalid_channel_names(self):
        with pytest.raises(ValueError, match="2~30자"):
            validate_channel_name("a")
        with pytest.raises(ValueError, match="2~30자"):
            validate_channel_name("a" * 31)
        with pytest.raises(ValueError, match="공백"):
            validate_channel_name("study room")
        with pytest.raises(ValueError, match="문자, 숫자"):
            validate_channel_name("study#room")
        with pytest.raises(ValueError, match="문자, 숫자"):
            validate_channel_name("study@room")

    def test_valid_channel_display_names(self):
        assert validate_channel_display_name("전체 채팅") == "전체 채팅"
        assert validate_channel_display_name("  프로젝트   1팀  ") == "프로젝트 1팀"
        assert validate_channel_display_name("Q&A Room") == "Q&A Room"

    def test_invalid_channel_display_names(self):
        with pytest.raises(ValueError, match="표시 이름"):
            validate_channel_display_name("")
        with pytest.raises(ValueError, match="표시 이름"):
            validate_channel_display_name("   ")
        with pytest.raises(ValueError, match="30자"):
            validate_channel_display_name("가" * 31)
        with pytest.raises(ValueError, match="제어 문자"):
            validate_channel_display_name("질문\x00방")

    def test_channel_description_validation(self):
        assert validate_channel_description("") == ""
        assert validate_channel_description("자유롭게 질문하고 답변하는 채널입니다.") == "자유롭게 질문하고 답변하는 채널입니다."
        with pytest.raises(ValueError, match="200자"):
            validate_channel_description("a" * 201)
        with pytest.raises(ValueError, match="제어 문자"):
            validate_channel_description("설명\x00입니다")


# ==========================================================================
# 3. Channel CRUD Endpoints & Database Layer
# ==========================================================================

class TestChannelApi:
    def test_list_channels_returns_default_channel(self):
        client, user = session_client("alice")
        response = client.get("/api/channels", headers=ORIGIN)
        assert response.status_code == 200
        channels = response.json()
        assert len(channels) >= 1
        default = channels[0]
        assert default["id"] == 1
        assert default["name"] == "general"
        assert default["display_name"] == "전체 채팅"
        assert default["is_default"] is True
        assert "message_count" in default

    def test_create_channel_success(self):
        client, user = session_client("bob")
        payload = {
            "name": "homework-help",
            "display_name": "과제 도움방",
            "description": "과제 질문 채널",
        }
        response = client.post("/api/channels", headers=ORIGIN, json=payload)
        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "homework-help"
        assert data["display_name"] == "과제 도움방"
        assert data["description"] == "과제 질문 채널"
        assert data["is_default"] is False
        assert len(data["uuid"]) == 32
        assert data["created_by_user_id"] == user["id"]

    def test_create_channel_duplicate_name_fails(self):
        client, _ = session_client("alice")
        payload = {"name": "general", "display_name": "또 다른 전체"}
        response = client.post("/api/channels", headers=ORIGIN, json=payload)
        assert response.status_code == 409

    def test_create_channel_validation_error(self):
        client, _ = session_client("alice")
        payload = {"name": "a", "display_name": "유효하지 않음"}
        response = client.post("/api/channels", headers=ORIGIN, json=payload)
        assert response.status_code == 400

    def test_get_channel_by_id(self):
        client, _ = session_client("alice")
        chan = database.create_channel("proj-a", "프로젝트 A", "설명")
        response = client.get(f"/api/channels/{chan['id']}", headers=ORIGIN)
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "proj-a"
        assert data["display_name"] == "프로젝트 A"

    def test_get_nonexistent_channel_returns_404(self):
        client, _ = session_client("alice")
        response = client.get("/api/channels/99999", headers=ORIGIN)
        assert response.status_code == 404

    def test_channel_endpoints_require_login(self):
        anon = TestClient(main.app)
        assert anon.get("/api/channels").status_code == 401
        assert anon.post("/api/channels", headers=ORIGIN,
                         json={"name": "test", "display_name": "test"}).status_code == 401
        assert anon.get("/api/channels/1").status_code == 401


# ==========================================================================
# 4. Channel Message Isolation & Paginated History
# ==========================================================================

class TestChannelMessages:
    def test_messages_are_isolated_by_channel(self):
        client, user = session_client("alice")
        chan2 = database.create_channel("team-b", "팀 B")

        # Save message in default channel (1)
        msg1 = database.save_message("alice", "Message in general", user_id=user["id"], channel_id=1)
        # Save message in channel 2
        msg2 = database.save_message("alice", "Message in team B", user_id=user["id"], channel_id=chan2["id"])

        chan1_history = client.get("/api/channels/1/messages", headers=ORIGIN).json()
        chan1_contents = [m["content"] for m in chan1_history["messages"]]
        assert "Message in general" in chan1_contents
        assert "Message in team B" not in chan1_contents

        chan2_history = client.get(f"/api/channels/{chan2['id']}/messages", headers=ORIGIN).json()
        chan2_contents = [m["content"] for m in chan2_history["messages"]]
        assert "Message in team B" in chan2_contents
        assert "Message in general" not in chan2_contents

    def test_channel_message_pagination_with_before_id(self):
        client, user = session_client("alice")
        chan = database.create_channel("paginated-chan", "페이지네이션 채널")

        saved_ids = []
        for i in range(15):
            msg = database.save_message("alice", f"Msg {i}", user_id=user["id"], channel_id=chan["id"])
            saved_ids.append(int(msg["message_id"].split(":")[1]))

        # Request with limit (using before_id)
        midpoint_id = saved_ids[8]
        response = client.get(
            f"/api/channels/{chan['id']}/messages?before_id={midpoint_id}", headers=ORIGIN
        )
        assert response.status_code == 200
        data = response.json()
        received_contents = [m["content"] for m in data["messages"]]
        # Should only contain messages before midpoint
        assert "Msg 7" in received_contents
        assert "Msg 8" not in received_contents
        assert "Msg 14" not in received_contents

    def test_legacy_public_history_endpoint_returns_channel_1(self):
        """GET /api/messages and GET /api/history/public map to default general channel."""
        client, user = session_client("alice")
        chan2 = database.create_channel("chan-2", "채널 2")
        database.save_message("alice", "General Hello", user_id=user["id"], channel_id=1)
        database.save_message("alice", "Secret Chan 2", user_id=user["id"], channel_id=chan2["id"])

        api_msgs = client.get("/api/messages", headers=ORIGIN).json()
        contents = [m["content"] for m in api_msgs]
        assert "General Hello" in contents
        assert "Secret Chan 2" not in contents

        pub_history = client.get("/api/history/public", headers=ORIGIN).json()
        pub_contents = [m["content"] for m in pub_history["messages"]]
        assert "General Hello" in pub_contents
        assert "Secret Chan 2" not in pub_contents


# ==========================================================================
# 5. WebSocket Channel Routing
# ==========================================================================

class TestWebSocketChannelRouting:
    def test_websocket_chat_message_routes_to_specified_channel(self):
        client, user = session_client("alice")
        chan = database.create_channel("frontend-room", "프론트엔드방")

        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            # Consume initial events (presence, users, history, history_ready)
            while True:
                msg = ws.receive_json()
                if msg.get("type") == "history_ready":
                    break

            # Send chat message targeted to channel
            ws.send_json({
                "type": "chat",
                "channel_id": chan["id"],
                "content": "Hello in frontend room!",
            })

            broadcast_msg = ws.receive_json()
            while broadcast_msg.get("type") != "chat":
                broadcast_msg = ws.receive_json()

            assert broadcast_msg["type"] == "chat"
            assert broadcast_msg["content"] == "Hello in frontend room!"
            assert broadcast_msg["channel_id"] == chan["id"]

    def test_websocket_chat_message_defaults_to_channel_1(self):
        client, user = session_client("bob")

        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            while True:
                msg = ws.receive_json()
                if msg.get("type") == "history_ready":
                    break

            # Send chat message without channel_id
            ws.send_json({
                "type": "chat",
                "content": "Default channel message",
            })

            broadcast_msg = ws.receive_json()
            while broadcast_msg.get("type") != "chat":
                broadcast_msg = ws.receive_json()

            assert broadcast_msg["channel_id"] == 1

    def test_websocket_chat_message_to_invalid_channel_returns_error(self):
        client, user = session_client("charlie")

        with client.websocket_connect("/ws", headers=ORIGIN) as ws:
            while True:
                msg = ws.receive_json()
                if msg.get("type") == "history_ready":
                    break

            # Send chat message to non-existent channel
            ws.send_json({
                "type": "chat",
                "channel_id": 99999,
                "content": "Message to nowhere",
            })

            error_msg = ws.receive_json()
            assert error_msg["type"] == "error"
            assert "채널을 찾을 수 없습니다" in error_msg["message"]

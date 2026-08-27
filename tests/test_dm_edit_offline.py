"""Tests for DM Editing & Offline Recipient Delivery."""
import json
import pytest
from fastapi.testclient import TestClient

from app import database, main
from app.auth import token_hash
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


class TestDMEditMigration:
    def test_schema_version_reaches_v6(self):
        with database.get_connection() as conn:
            version = database._get_schema_version(conn)
        assert version >= 6
        assert len(database._MIGRATIONS) >= 6

    def test_direct_messages_has_edited_at(self):
        with database.get_connection() as conn:
            info = conn.execute("PRAGMA table_info(direct_messages)").fetchall()
            cols = {col[1]: col[2] for col in info}
            assert "edited_at" in cols


class TestDMEditingAPI:
    def test_sender_can_edit_dm(self):
        client1, user1 = session_client("alice")
        client2, user2 = session_client("bob")

        dm = database.save_direct_message(user1, user2, "Original DM text")
        dm_id = int(dm["message_id"].replace("dm:", ""))

        res = client1.patch(f"/api/dms/{dm_id}", json={"content": "Updated DM text"}, headers=ORIGIN)
        assert res.status_code == 200
        data = res.json()
        assert data["content"] == "Updated DM text"
        assert data["edited_at"] is not None
        assert data["from_nick"] == "alice"
        assert data["to_nick"] == "bob"

        # Verify persisted in database
        fetched = database.get_direct_message_by_id(dm_id)
        assert fetched["content"] == "Updated DM text"
        assert fetched["edited_at"] == data["edited_at"]

    def test_recipient_cannot_edit_dm(self):
        client1, user1 = session_client("alice")
        client2, user2 = session_client("bob")

        dm = database.save_direct_message(user1, user2, "Original DM text")
        dm_id = int(dm["message_id"].replace("dm:", ""))

        res = client2.patch(f"/api/dms/{dm_id}", json={"content": "Hacked DM"}, headers=ORIGIN)
        assert res.status_code == 403
        assert "본인이 작성한" in res.json()["detail"]

    def test_third_party_and_admin_cannot_edit_dm(self):
        client1, user1 = session_client("alice")
        client2, user2 = session_client("bob")
        client_charlie, user_charlie = session_client("charlie")
        client_admin, user_admin = session_client("admin", role="admin")

        dm = database.save_direct_message(user1, user2, "Alice to Bob secret")
        dm_id = int(dm["message_id"].replace("dm:", ""))

        # Charlie (third party) attempt
        res_charlie = client_charlie.patch(f"/api/dms/{dm_id}", json={"content": "Charlie edit"}, headers=ORIGIN)
        assert res_charlie.status_code == 403

        # Admin attempt (DM confidentiality: even admin cannot modify)
        res_admin = client_admin.patch(f"/api/dms/{dm_id}", json={"content": "Admin edit"}, headers=ORIGIN)
        assert res_admin.status_code == 403

    def test_edit_dm_validation_empty_and_length(self):
        client1, user1 = session_client("alice")
        client2, user2 = session_client("bob")

        dm = database.save_direct_message(user1, user2, "Valid text")
        dm_id = int(dm["message_id"].replace("dm:", ""))

        # Empty content
        res_empty = client1.patch(f"/api/dms/{dm_id}", json={"content": "   "}, headers=ORIGIN)
        assert res_empty.status_code == 400
        assert "메시지 내용" in res_empty.json()["detail"]

        # Content exceeding MAX_CONTENT_LEN (2000)
        res_long = client1.patch(f"/api/dms/{dm_id}", json={"content": "x" * 2001}, headers=ORIGIN)
        assert res_long.status_code == 400
        assert "2000자 이하" in res_long.json()["detail"]

    def test_edit_nonexistent_dm_returns_404(self):
        client1, user1 = session_client("alice")
        res = client1.patch("/api/dms/99999", json={"content": "Hello"}, headers=ORIGIN)
        assert res.status_code == 404


class TestOfflineRecipientDMDelivery:
    def test_websocket_dm_sent_to_offline_recipient_is_saved_and_echoed(self):
        client1, user1 = session_client("alice")
        client2, user2 = session_client("bob")  # bob is created but not connected via websocket

        with client1.websocket_connect("/ws", headers=ORIGIN) as ws1:
            ws1.send_text(json.dumps({
                "type": "dm",
                "to": "bob",
                "content": "Hello offline Bob!",
            }))

            # ws1 should receive presence / echo without error
            received_dm = False
            for _ in range(10):
                msg_text = ws1.receive_text()
                msg = json.loads(msg_text)
                if msg.get("type") == "dm":
                    assert msg["content"] == "Hello offline Bob!"
                    assert msg["from_nick"] == "alice"
                    assert msg["to_nick"] == "bob"
                    received_dm = True
                    break
                elif msg.get("type") == "error":
                    pytest.fail(f"Unexpected error received: {msg}")
            assert received_dm

        # Verify the DM is safely saved in SQLite
        recent = database.get_recent_direct_messages(user2["id"])
        assert len(recent) == 1
        assert recent[0]["content"] == "Hello offline Bob!"
        assert recent[0]["from_nick"] == "alice"

    def test_offline_received_dm_shows_in_recipient_history_on_login(self):
        client1, user1 = session_client("alice")
        client2, user2 = session_client("bob")

        # Alice sends DM to offline Bob
        with client1.websocket_connect("/ws", headers=ORIGIN) as ws1:
            ws1.send_text(json.dumps({
                "type": "dm",
                "to": "bob",
                "content": "Message for later",
            }))
            # Read until echo received
            while True:
                msg = json.loads(ws1.receive_text())
                if msg.get("type") == "dm":
                    break

        # Bob now connects via websocket
        with client2.websocket_connect("/ws", headers=ORIGIN) as ws2:
            received_history_dm = False
            for _ in range(15):
                msg = json.loads(ws2.receive_text())
                if msg.get("type") == "dm" and msg.get("history") is True:
                    assert msg["content"] == "Message for later"
                    assert msg["from_nick"] == "alice"
                    received_history_dm = True
                    break
            assert received_history_dm

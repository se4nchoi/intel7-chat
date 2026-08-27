"""Tests for Iteration 5 — Message Pins (Channel and DM)."""
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


class TestPinSchema:
    def test_schema_version_reaches_v8(self):
        with database.get_connection() as conn:
            version = database._get_schema_version(conn)
        assert version >= 8
        assert len(database._MIGRATIONS) >= 8

    def test_pinned_messages_table_structure(self):
        with database.get_connection() as conn:
            info = conn.execute("PRAGMA table_info(pinned_messages)").fetchall()
            cols = {col[1]: col[2] for col in info}
            assert "id" in cols
            assert "conversation_type" in cols
            assert "conversation_id" in cols
            assert "message_id" in cols
            assert "pinned_by_user_id" in cols
            assert "pinned_at" in cols


class TestChannelPins:
    def test_pin_and_unpin_channel_message(self):
        client_alice, user_alice = session_client("alice")
        client_bob, user_bob = session_client("bob")

        msg = database.save_message("alice", "중요 공지사항입니다!", user_id=user_alice["id"], channel_id=1)
        raw_id = int(msg["message_id"].replace("public:", ""))

        # Initially no pins
        resp = client_bob.get("/api/conversations/channel/1/pins")
        assert resp.status_code == 200
        assert resp.json()["pins"] == []

        # Bob pins Alice's message
        pin_resp = client_bob.post(f"/api/conversations/channel/1/pins/{raw_id}", headers=ORIGIN)
        assert pin_resp.status_code == 200
        pin_data = pin_resp.json()
        assert pin_data["conversation_type"] == "channel"
        assert pin_data["conversation_id"] == "1"
        assert pin_data["message_id"] == raw_id
        assert pin_data["pinned_by"]["id"] == user_bob["id"]
        assert pin_data["message"]["content"] == "중요 공지사항입니다!"
        assert pin_data["message"]["is_pinned"] is True

        # Check list pins
        list_resp = client_alice.get("/api/conversations/channel/1/pins")
        assert list_resp.status_code == 200
        pins = list_resp.json()["pins"]
        assert len(pins) == 1
        assert pins[0]["message_id"] == raw_id

        # Verify recent messages include is_pinned: True
        history = database.get_recent_messages(channel_id=1, current_user_id=user_alice["id"])
        assert len(history) == 1
        assert history[0]["is_pinned"] is True

        # Alice unpins the message
        unpin_resp = client_alice.delete(f"/api/conversations/channel/1/pins/{raw_id}", headers=ORIGIN)
        assert unpin_resp.status_code == 200
        assert unpin_resp.json()["success"] is True

        # Verify list pins is empty
        list_resp2 = client_bob.get("/api/conversations/channel/1/pins")
        assert list_resp2.json()["pins"] == []

        # Verify recent messages include is_pinned: False
        history2 = database.get_recent_messages(channel_id=1, current_user_id=user_alice["id"])
        assert history2[0]["is_pinned"] is False

    def test_pin_non_existent_channel_message_returns_404(self):
        client, user = session_client("alice")
        resp = client.post("/api/conversations/channel/1/pins/999999", headers=ORIGIN)
        assert resp.status_code == 404

    def test_delete_channel_cleans_up_pinned_messages(self):
        client_admin, admin_user = session_client("admin", role="admin")
        chan = database.create_channel("project-x", "Project X", "Test channel")
        chan_id = chan["id"]

        msg = database.save_message("admin", "프로젝트 핀 메시지", user_id=admin_user["id"], channel_id=chan_id)
        raw_id = int(msg["message_id"].replace("public:", ""))

        # Pin the message
        client_admin.post(f"/api/conversations/channel/{chan_id}/pins/{raw_id}", headers=ORIGIN)
        assert len(database.get_pinned_messages("channel", str(chan_id))) == 1

        # Delete the channel
        database.delete_channel(chan_id)

        # Verify pinned_messages for that channel are deleted
        assert len(database.get_pinned_messages("channel", str(chan_id))) == 0
        with database.get_connection() as conn:
            cnt = conn.execute("SELECT COUNT(*) FROM pinned_messages WHERE conversation_type='channel' AND conversation_id=?", (str(chan_id),)).fetchone()[0]
            assert cnt == 0


class TestDMPins:
    def test_dm_participants_can_pin_and_unpin(self):
        client_alice, user_alice = session_client("alice")
        client_bob, user_bob = session_client("bob")
        client_charlie, user_charlie = session_client("charlie")

        dm = database.save_direct_message(user_alice, user_bob, "비밀 프로젝트 링크입니다")
        raw_dm_id = int(dm["message_id"].replace("dm:", ""))

        # Bob pins the DM using partner username
        pin_resp = client_bob.post(f"/api/conversations/dm/alice/pins/{raw_dm_id}", headers=ORIGIN)
        assert pin_resp.status_code == 200
        pin_data = pin_resp.json()
        assert pin_data["conversation_type"] == "dm"
        assert pin_data["message_id"] == raw_dm_id
        assert pin_data["pinned_by"]["username"] == "bob"

        # Alice queries pins using partner user ID
        list_resp = client_alice.get(f"/api/conversations/dm/{user_bob['id']}/pins")
        assert list_resp.status_code == 200
        pins = list_resp.json()["pins"]
        assert len(pins) == 1
        assert pins[0]["message"]["content"] == "비밀 프로젝트 링크입니다"
        assert pins[0]["message"]["is_pinned"] is True

        # Third party (Charlie) cannot pin or unpin Alice & Bob's DM
        charlie_pin = client_charlie.post(f"/api/conversations/dm/alice/pins/{raw_dm_id}", headers=ORIGIN)
        assert charlie_pin.status_code in (403, 404)

        charlie_unpin = client_charlie.delete(f"/api/conversations/dm/alice/pins/{raw_dm_id}", headers=ORIGIN)
        assert charlie_unpin.status_code in (403, 404)

        # Alice unpins the DM
        unpin_resp = client_alice.delete(f"/api/conversations/dm/bob/pins/{raw_dm_id}", headers=ORIGIN)
        assert unpin_resp.status_code == 200
        assert unpin_resp.json()["success"] is True

        # Verify Bob also sees 0 pins
        list_resp_bob = client_bob.get(f"/api/conversations/dm/alice/pins")
        assert list_resp_bob.json()["pins"] == []


class TestPinWebSocketSync:
    def test_channel_pin_broadcasts_websocket_event(self):
        client_alice, user_alice = session_client("alice")
        client_bob, user_bob = session_client("bob")

        msg = database.save_message("alice", "핀 테스트 공지", user_id=user_alice["id"], channel_id=1)
        raw_id = int(msg["message_id"].replace("public:", ""))

        with client_bob.websocket_connect("/ws", headers=ORIGIN) as ws_bob:
            while True:
                evt = ws_bob.receive_json()
                if evt.get("type") == "history_ready":
                    break

            pin_resp = client_alice.post(f"/api/conversations/channel/1/pins/{raw_id}", headers=ORIGIN)
            assert pin_resp.status_code == 200

            event = ws_bob.receive_json()
            assert event["type"] == "pin_updated"
            assert event["conversation_type"] == "channel"
            assert event["conversation_id"] == "1"
            assert event["message_id"] == raw_id
            assert event["is_pinned"] is True
            assert event["pin"]["pinned_by"]["username"] == "alice"

            unpin_resp = client_alice.delete(f"/api/conversations/channel/1/pins/{raw_id}", headers=ORIGIN)
            assert unpin_resp.status_code == 200

            event2 = ws_bob.receive_json()
            assert event2["type"] == "pin_updated"
            assert event2["is_pinned"] is False
            assert event2["message_id"] == raw_id

    def test_dm_pin_websocket_isolated_to_participants(self):
        client_alice, user_alice = session_client("alice")
        client_bob, user_bob = session_client("bob")
        client_charlie, user_charlie = session_client("charlie")

        dm = database.save_direct_message(user_alice, user_bob, "오직 앨리스와 밥만 보는 메시지")
        raw_dm_id = int(dm["message_id"].replace("dm:", ""))

        with client_bob.websocket_connect("/ws", headers=ORIGIN) as ws_bob:
            while True:
                if ws_bob.receive_json().get("type") == "history_ready":
                    break

            with client_charlie.websocket_connect("/ws", headers=ORIGIN) as ws_charlie:
                while True:
                    if ws_charlie.receive_json().get("type") == "history_ready":
                        break

                # Alice pins DM with Bob
                pin_resp = client_alice.post(f"/api/conversations/dm/bob/pins/{raw_dm_id}", headers=ORIGIN)
                assert pin_resp.status_code == 200

                # Bob receives pin_updated
                while True:
                    evt_bob = ws_bob.receive_json()
                    if evt_bob.get("type") in ("pin_updated", "chat"):
                        break
                assert evt_bob["type"] == "pin_updated"
                assert evt_bob["conversation_type"] == "dm"
                assert evt_bob["message_id"] == raw_dm_id
                assert evt_bob["is_pinned"] is True

                # Charlie sends a public chat message to produce an event on his socket
                ws_charlie.send_json({
                    "type": "chat",
                    "channel_id": 1,
                    "content": "Charlie msg",
                })

                # The next event Charlie receives MUST be the public message, NOT the DM pin
                while True:
                    evt_c = ws_charlie.receive_json()
                    if evt_c.get("type") in ("chat", "pin_updated"):
                        break
                assert evt_c["type"] == "chat"
                assert evt_c["content"] == "Charlie msg"

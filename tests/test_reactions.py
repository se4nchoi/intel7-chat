"""Tests for Iteration 5 — Message Reactions."""
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


class TestReactionsMigration:
    def test_schema_version_reaches_v5(self):
        with database.get_connection() as conn:
            version = database._get_schema_version(conn)
        assert version >= 5
        assert len(database._MIGRATIONS) >= 5

    def test_message_reactions_table_structure(self):
        with database.get_connection() as conn:
            info = conn.execute("PRAGMA table_info(message_reactions)").fetchall()
            cols = {col[1]: col[2] for col in info}
            assert "message_type" in cols
            assert "message_id" in cols
            assert "user_id" in cols
            assert "emoji" in cols
            assert "created_at" in cols


class TestChannelMessageReactions:
    def test_toggle_adds_and_removes_reaction(self):
        client, user = session_client("alice")
        msg = database.save_message("alice", "Hello channel", user_id=user["id"], channel_id=1)
        msg_id = int(msg["message_id"].split(":")[1])

        # 1. Toggle add
        res1 = client.post(f"/api/messages/channel/{msg_id}/reactions/toggle",
                           json={"emoji": "👍"}, headers=ORIGIN)
        assert res1.status_code == 200
        data1 = res1.json()
        assert data1["message_type"] == "channel"
        assert data1["message_id"] == msg_id
        assert len(data1["reactions"]) == 1
        assert data1["reactions"][0]["emoji"] == "👍"
        assert data1["reactions"][0]["count"] == 1
        assert data1["reactions"][0]["reacted_by_me"] is True
        assert data1["reactions"][0]["users"][0]["id"] == user["id"]
        assert data1["reactions"][0]["users"][0]["username"] == "alice"

        # 2. Toggle remove
        res2 = client.post(f"/api/messages/channel/{msg_id}/reactions/toggle",
                           json={"emoji": "👍"}, headers=ORIGIN)
        assert res2.status_code == 200
        data2 = res2.json()
        assert len(data2["reactions"]) == 0

    def test_multiple_users_and_aggregate_counts(self):
        client_alice, alice = session_client("alice")
        client_bob, bob = session_client("bob")
        client_charlie, charlie = session_client("charlie")

        msg = database.save_message("alice", "Team message", user_id=alice["id"], channel_id=1)
        msg_id = int(msg["message_id"].split(":")[1])

        # Alice reacts with 👍
        client_alice.post(f"/api/messages/channel/{msg_id}/reactions/toggle",
                          json={"emoji": "👍"}, headers=ORIGIN)
        # Bob reacts with 👍
        res_bob = client_bob.post(f"/api/messages/channel/{msg_id}/reactions/toggle",
                                  json={"emoji": "👍"}, headers=ORIGIN)
        assert res_bob.status_code == 200
        data_bob = res_bob.json()
        assert data_bob["reactions"][0]["count"] == 2
        assert data_bob["reactions"][0]["reacted_by_me"] is True

        # Charlie reacts with ❤️
        client_charlie.post(f"/api/messages/channel/{msg_id}/reactions/toggle",
                            json={"emoji": "❤️"}, headers=ORIGIN)

        # Retrieve channel history as Charlie
        hist_res = client_charlie.get("/api/channels/1/messages")
        assert hist_res.status_code == 200
        messages = hist_res.json()["messages"]
        target = next(m for m in messages if m["message_id"] == f"public:{msg_id}")
        assert len(target["reactions"]) == 2

        thumbs = next(r for r in target["reactions"] if r["emoji"] == "👍")
        heart = next(r for r in target["reactions"] if r["emoji"] == "❤️")
        assert thumbs["count"] == 2
        assert thumbs["reacted_by_me"] is False
        assert heart["count"] == 1
        assert heart["reacted_by_me"] is True

    def test_invalid_emoji_rejected(self):
        client, user = session_client("alice")
        msg = database.save_message("alice", "Test invalid emoji", user_id=user["id"], channel_id=1)
        msg_id = int(msg["message_id"].split(":")[1])

        res = client.post(f"/api/messages/channel/{msg_id}/reactions/toggle",
                          json={"emoji": "🔥"}, headers=ORIGIN)
        assert res.status_code == 400
        assert "유효하지 않은 이모지" in res.json()["detail"]

    def test_nonexistent_message_returns_404(self):
        client, _ = session_client("alice")
        res = client.post("/api/messages/channel/99999/reactions/toggle",
                          json={"emoji": "👍"}, headers=ORIGIN)
        assert res.status_code == 404

    def test_unauthenticated_request_rejected(self):
        client = TestClient(main.app)
        res = client.post("/api/messages/channel/1/reactions/toggle",
                          json={"emoji": "👍"}, headers=ORIGIN)
        assert res.status_code == 401

    def test_hidden_message_policy(self):
        client_student, student = session_client("student", role="student")
        client_admin, admin = session_client("admin", role="admin")

        msg = database.save_message("student", "Bad message", user_id=student["id"], channel_id=1)
        msg_id = int(msg["message_id"].split(":")[1])

        # Admin hides message
        client_admin.post(f"/api/messages/{msg_id}/hide", json={"hidden": True}, headers=ORIGIN)

        # Ordinary student cannot react to hidden message
        res_student = client_student.post(f"/api/messages/channel/{msg_id}/reactions/toggle",
                                          json={"emoji": "👍"}, headers=ORIGIN)
        assert res_student.status_code == 403

        # Admin can react to hidden message
        res_admin = client_admin.post(f"/api/messages/channel/{msg_id}/reactions/toggle",
                                      json={"emoji": "👍"}, headers=ORIGIN)
        assert res_admin.status_code == 200
        assert res_admin.json()["reactions"][0]["count"] == 1


class TestDirectMessageReactions:
    def test_dm_participants_can_react(self):
        client_alice, alice = session_client("alice")
        client_bob, bob = session_client("bob")

        dm = database.save_direct_message(alice, bob, "Secret DM")
        dm_id = int(dm["message_id"].split(":")[1])

        # Alice reacts to DM
        res_alice = client_alice.post(f"/api/messages/dm/{dm_id}/reactions/toggle",
                                      json={"emoji": "👏"}, headers=ORIGIN)
        assert res_alice.status_code == 200
        assert res_alice.json()["reactions"][0]["count"] == 1
        assert res_alice.json()["reactions"][0]["reacted_by_me"] is True

        # Bob reacts to DM
        res_bob = client_bob.post(f"/api/messages/dm/{dm_id}/reactions/toggle",
                                  json={"emoji": "👏"}, headers=ORIGIN)
        assert res_bob.status_code == 200
        assert res_bob.json()["reactions"][0]["count"] == 2
        assert res_bob.json()["reactions"][0]["reacted_by_me"] is True

        # Verify Bob's history endpoint contains reactions
        bob_hist = client_bob.get("/api/history/dm/alice")
        assert bob_hist.status_code == 200
        messages = bob_hist.json()["messages"]
        target = next(m for m in messages if m["message_id"] == f"dm:{dm_id}")
        assert target["reactions"][0]["count"] == 2
        assert target["reactions"][0]["reacted_by_me"] is True

    def test_dm_third_party_denied(self):
        _, alice = session_client("alice")
        _, bob = session_client("bob")
        client_charlie, _ = session_client("charlie")

        dm = database.save_direct_message(alice, bob, "Confidential DM")
        dm_id = int(dm["message_id"].split(":")[1])

        # Charlie attempts to react to Alice & Bob's DM
        res = client_charlie.post(f"/api/messages/dm/{dm_id}/reactions/toggle",
                                  json={"emoji": "👀"}, headers=ORIGIN)
        assert res.status_code == 403


class TestReactionsPersistenceAndLifecycle:
    def test_reactions_survive_message_edit(self):
        client, user = session_client("alice")
        msg = database.save_message("alice", "Original text", user_id=user["id"], channel_id=1)
        msg_id = int(msg["message_id"].split(":")[1])

        client.post(f"/api/messages/channel/{msg_id}/reactions/toggle",
                    json={"emoji": "✅"}, headers=ORIGIN)

        # Edit message
        edit_res = client.patch(f"/api/messages/{msg_id}",
                                json={"content": "Edited text"}, headers=ORIGIN)
        assert edit_res.status_code == 200
        assert edit_res.json()["reactions"][0]["emoji"] == "✅"
        assert edit_res.json()["reactions"][0]["count"] == 1

    def test_reactions_survive_message_move(self):
        client, admin = session_client("admin", role="admin")
        chan2 = database.create_channel("project", "프로젝트", created_by_user_id=admin["id"])
        msg = database.save_message("admin", "Move me", user_id=admin["id"], channel_id=1)
        msg_id = int(msg["message_id"].split(":")[1])

        client.post(f"/api/messages/channel/{msg_id}/reactions/toggle",
                    json={"emoji": "👀"}, headers=ORIGIN)

        # Move to channel 2
        move_res = client.post(f"/api/messages/{msg_id}/move",
                               json={"to_channel_id": chan2["id"]}, headers=ORIGIN)
        assert move_res.status_code == 200
        assert move_res.json()["reactions"][0]["emoji"] == "👀"

    def test_reactions_cleaned_up_on_channel_deletion(self):
        client, admin = session_client("admin", role="admin")
        chan = database.create_channel("temp", "임시", created_by_user_id=admin["id"])
        msg = database.save_message("admin", "Temp msg", user_id=admin["id"], channel_id=chan["id"])
        msg_id = int(msg["message_id"].split(":")[1])

        client.post(f"/api/messages/channel/{msg_id}/reactions/toggle",
                    json={"emoji": "👍"}, headers=ORIGIN)

        # Verify reaction exists in DB
        with database.get_connection() as conn:
            cnt = conn.execute("SELECT COUNT(*) FROM message_reactions WHERE message_id=?", (msg_id,)).fetchone()[0]
        assert cnt == 1

        # Delete channel permanently
        del_res = client.delete(f"/api/channels/{chan['id']}", headers=ORIGIN)
        assert del_res.status_code == 200

        # Verify reaction was deleted
        with database.get_connection() as conn:
            cnt_after = conn.execute("SELECT COUNT(*) FROM message_reactions WHERE message_id=?", (msg_id,)).fetchone()[0]
        assert cnt_after == 0

    def test_reactions_survive_channel_archive_and_unarchive(self):
        client, admin = session_client("admin", role="admin")
        chan = database.create_channel("team-proj", "팀 프로젝트", created_by_user_id=admin["id"])
        msg = database.save_message("admin", "Project launch", user_id=admin["id"], channel_id=chan["id"])
        msg_id = int(msg["message_id"].split(":")[1])

        # Add reaction
        client.post(f"/api/messages/channel/{msg_id}/reactions/toggle",
                    json={"emoji": "👏"}, headers=ORIGIN)

        # 1. Archive channel
        arc_res = client.post(f"/api/channels/{chan['id']}/archive", headers=ORIGIN)
        assert arc_res.status_code == 200

        # Verify reactions intact in archived channel history
        hist_arc = client.get(f"/api/channels/{chan['id']}/messages")
        assert hist_arc.status_code == 200
        msg_arc = next(m for m in hist_arc.json()["messages"] if m["message_id"] == f"public:{msg_id}")
        assert msg_arc["reactions"][0]["emoji"] == "👏"
        assert msg_arc["reactions"][0]["count"] == 1

        # 2. Unarchive channel
        unarc_res = client.post(f"/api/channels/{chan['id']}/unarchive", headers=ORIGIN)
        assert unarc_res.status_code == 200

        # Verify reactions intact in unarchived channel history
        hist_unarc = client.get(f"/api/channels/{chan['id']}/messages")
        assert hist_unarc.status_code == 200
        msg_unarc = next(m for m in hist_unarc.json()["messages"] if m["message_id"] == f"public:{msg_id}")
        assert msg_unarc["reactions"][0]["emoji"] == "👏"
        assert msg_unarc["reactions"][0]["count"] == 1


class TestRealtimeReactions:
    def test_channel_reaction_broadcast_over_websocket(self):
        client_alice, alice = session_client("alice")
        client_bob, bob = session_client("bob")

        msg = database.save_message("alice", "Broadcast test", user_id=alice["id"], channel_id=1)
        msg_id = int(msg["message_id"].split(":")[1])

        with client_bob.websocket_connect("/ws", headers=ORIGIN) as ws_bob:
            # Drain initial connection history
            while True:
                evt = ws_bob.receive_json()
                if evt.get("type") == "history_ready":
                    break

            # Alice toggles reaction
            resp = client_alice.post(f"/api/messages/channel/{msg_id}/reactions/toggle",
                                     json={"emoji": "👍"}, headers=ORIGIN)
            assert resp.status_code == 200

            # Bob receives real-time reaction_updated event
            event = ws_bob.receive_json()
            assert event["type"] == "reaction_updated"
            assert event["message_type"] == "channel"
            assert event["message_id"] == msg_id
            assert event["channel_id"] == 1
            assert len(event["reactions"]) == 1
            assert event["reactions"][0]["emoji"] == "👍"
            assert event["reactions"][0]["count"] == 1
            assert event["reactions"][0]["users"][0]["id"] == alice["id"]

    def test_dm_reaction_realtime_reaches_both_participants(self):
        client_alice, alice = session_client("alice")
        client_bob, bob = session_client("bob")

        dm = database.save_direct_message(alice, bob, "Realtime secret")
        dm_id = int(dm["message_id"].split(":")[1])

        with client_alice.websocket_connect("/ws", headers=ORIGIN) as ws_alice:
            while True:
                if ws_alice.receive_json().get("type") == "history_ready":
                    break

            with client_bob.websocket_connect("/ws", headers=ORIGIN) as ws_bob:
                while True:
                    if ws_bob.receive_json().get("type") == "history_ready":
                        break

                # Alice reacts to DM
                resp = client_alice.post(f"/api/messages/dm/{dm_id}/reactions/toggle",
                                         json={"emoji": "❤️"}, headers=ORIGIN)
                assert resp.status_code == 200

                # Alice receives real-time update
                while True:
                    evt_alice = ws_alice.receive_json()
                    if evt_alice.get("type") == "reaction_updated":
                        break
                assert evt_alice["type"] == "reaction_updated"
                assert evt_alice["message_type"] == "dm"
                assert evt_alice["message_id"] == dm_id
                assert evt_alice["reactions"][0]["emoji"] == "❤️"
                assert evt_alice["reactions"][0]["count"] == 1
                assert evt_alice["reactions"][0]["reacted_by_me"] is True

                # Bob receives real-time update
                while True:
                    evt_bob = ws_bob.receive_json()
                    if evt_bob.get("type") == "reaction_updated":
                        break
                assert evt_bob["type"] == "reaction_updated"
                assert evt_bob["message_type"] == "dm"
                assert evt_bob["message_id"] == dm_id
                assert evt_bob["reactions"][0]["emoji"] == "❤️"
                assert evt_bob["reactions"][0]["count"] == 1
                assert evt_bob["reactions"][0]["reacted_by_me"] is False

    def test_dm_reaction_realtime_not_delivered_to_third_party(self):
        client_alice, alice = session_client("alice")
        _, bob = session_client("bob")
        client_charlie, charlie = session_client("charlie")

        dm = database.save_direct_message(alice, bob, "Alice and Bob only")
        dm_id = int(dm["message_id"].split(":")[1])

        with client_charlie.websocket_connect("/ws", headers=ORIGIN) as ws_charlie:
            while True:
                if ws_charlie.receive_json().get("type") == "history_ready":
                    break

            # Alice reacts to DM with Bob
            resp = client_alice.post(f"/api/messages/dm/{dm_id}/reactions/toggle",
                                     json={"emoji": "👀"}, headers=ORIGIN)
            assert resp.status_code == 200

            # Charlie sends a public chat message to produce an event on his socket
            ws_charlie.send_json({
                "type": "chat",
                "channel_id": 1,
                "content": "Charlie msg",
            })

            # The next event Charlie receives MUST be the public message, NOT the DM reaction
            while True:
                evt = ws_charlie.receive_json()
                if evt.get("type") in ("chat", "reaction_updated"):
                    break
            assert evt["type"] == "chat"
            assert evt["content"] == "Charlie msg"


class TestMigrationIdempotency:
    def test_migrate_v5_is_idempotent(self):
        with database.get_connection() as conn:
            # Re-running _migrate_v5 on already upgraded DB should not raise error
            database._migrate_v5(conn)
            assert database._get_schema_version(conn) >= 5


"""Comprehensive tests for Group DMs (Multi-user private ad-hoc channels)."""
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


def session_client(username="student", role="student", display_name=None):
    user = database.create_user(username, "not-used-in-session-tests", role=role)
    if display_name:
        database.update_display_name(user["id"], display_name)
        user["display_name"] = display_name
    raw = f"session-token-for-user-{user['id']}"
    expires = "2999-01-01T00:00:00Z"
    database.create_session(token_hash(raw), user["id"], expires)
    client = TestClient(main.app)
    client.cookies.set(main.SESSION_COOKIE, raw)
    return client, user


def recv_until(ws, target_type, max_reads=15):
    for _ in range(max_reads):
        pkt = ws.receive_json()
        if pkt.get("type") == target_type:
            return pkt
    raise TimeoutError(f"Did not receive packet with type={target_type}")


# ==========================================================================
# 1. Database Schema & DB Functions
# ==========================================================================

class TestGroupDmDatabase:
    def test_schema_has_dm_group_column_and_table(self):
        with database.get_connection() as conn:
            version = database._get_schema_version(conn)
            assert version >= 29
            cols = {row[1] for row in conn.execute("PRAGMA table_info(channels)")}
            assert "is_dm_group" in cols
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            assert "group_dm_members" in tables

    def test_create_group_dm_success(self):
        _, u1 = session_client("alice", display_name="앨리스")
        _, u2 = session_client("bob", display_name="밥")
        _, u3 = session_client("charlie", display_name="찰리")

        gdm = database.create_group_dm(u1["id"], [u2["id"], u3["id"]], custom_name="알고리즘 스터디")
        assert gdm["id"] > 1
        assert gdm["is_dm_group"] is True
        assert gdm["display_name"] == "알고리즘 스터디"
        assert gdm["effective_name"] == "알고리즘 스터디"
        assert gdm["member_count"] == 3

        member_ids = database.get_group_dm_member_ids(gdm["id"])
        assert member_ids == {u1["id"], u2["id"], u3["id"]}

    def test_effective_name_fallback_to_members(self):
        _, u1 = session_client("alice", display_name="앨리스")
        _, u2 = session_client("bob", display_name="밥")
        _, u3 = session_client("charlie", display_name="찰리")

        # Without custom name
        gdm = database.create_group_dm(u1["id"], [u2["id"], u3["id"]])
        assert not gdm["display_name"]
        # From alice's perspective, effective name shows bob and charlie
        detail_alice = database.get_group_dm_detail(gdm["id"], u1["id"])
        assert "밥" in detail_alice["effective_name"]
        assert "찰리" in detail_alice["effective_name"]
        assert "앨리스" not in detail_alice["effective_name"]

        # From bob's perspective, effective name shows alice and charlie
        detail_bob = database.get_group_dm_detail(gdm["id"], u2["id"])
        assert "앨리스" in detail_bob["effective_name"]
        assert "찰리" in detail_bob["effective_name"]
        assert "밥" not in detail_bob["effective_name"]

    def test_create_group_dm_requires_members(self):
        _, u1 = session_client("alice")
        with pytest.raises(ValueError):
            database.create_group_dm(u1["id"], [])

    def test_list_channels_excludes_group_dms(self):
        _, u1 = session_client("alice")
        _, u2 = session_client("bob")

        gdm = database.create_group_dm(u1["id"], [u2["id"]], custom_name="비공개 그룹")
        public_channels = database.list_channels()
        channel_ids = [c["id"] for c in public_channels]
        assert gdm["id"] not in channel_ids

    def test_list_user_group_dms_isolated(self):
        _, u1 = session_client("alice")
        _, u2 = session_client("bob")
        _, u3 = session_client("charlie")

        gdm = database.create_group_dm(u1["id"], [u2["id"]], custom_name="Alice & Bob")

        gdms_alice = database.list_user_group_dms(u1["id"])
        assert any(g["id"] == gdm["id"] for g in gdms_alice)

        gdms_charlie = database.list_user_group_dms(u3["id"])
        assert not any(g["id"] == gdm["id"] for g in gdms_charlie)

    def test_add_and_leave_group_dm_members(self):
        _, u1 = session_client("alice")
        _, u2 = session_client("bob")
        _, u3 = session_client("charlie")

        gdm = database.create_group_dm(u1["id"], [u2["id"]])
        assert not database.is_group_dm_member(gdm["id"], u3["id"])

        # Non-member cannot add
        with pytest.raises(PermissionError):
            database.add_group_dm_members(gdm["id"], [u3["id"]], actor_user_id=u3["id"])

        # Member adds u3
        database.add_group_dm_members(gdm["id"], [u3["id"]], actor_user_id=u1["id"])
        assert database.is_group_dm_member(gdm["id"], u3["id"])

        # u3 leaves
        database.leave_group_dm(gdm["id"], u3["id"])
        assert not database.is_group_dm_member(gdm["id"], u3["id"])


# ==========================================================================
# 2. Group DM REST APIs
# ==========================================================================

class TestGroupDmApi:
    def test_create_and_get_group_dm(self):
        c1, u1 = session_client("alice")
        c2, u2 = session_client("bob")
        c3, u3 = session_client("charlie")

        # 1. Create group DM
        res = c1.post(
            "/api/group-dms",
            headers=ORIGIN,
            json={"member_ids": [u2["id"]], "name": "팀 프로젝트"},
        )
        assert res.status_code == 201
        data = res.json()
        assert data["display_name"] == "팀 프로젝트"
        gid = data["id"]

        # 2. Member can get detail
        res = c1.get(f"/api/group-dms/{gid}")
        assert res.status_code == 200
        assert res.json()["id"] == gid

        # 3. Another member can get detail
        res = c2.get(f"/api/group-dms/{gid}")
        assert res.status_code == 200

        # 4. Non-member gets 404
        res = c3.get(f"/api/group-dms/{gid}")
        assert res.status_code == 404

    def test_candidate_users_api(self):
        c1, u1 = session_client("alice")
        _, u2 = session_client("bob", display_name="밥")
        _, u3 = session_client("charlie", display_name="찰리")

        res = c1.get("/api/group-dms/users")
        assert res.status_code == 200
        users = res.json()
        user_ids = [u["id"] for u in users]
        assert u1["id"] not in user_ids
        assert u2["id"] in user_ids
        assert u3["id"] in user_ids

    def test_update_group_dm_name(self):
        c1, u1 = session_client("alice")
        c2, u2 = session_client("bob")
        c3, u3 = session_client("charlie")

        res = c1.post(
            "/api/group-dms",
            headers=ORIGIN,
            json={"member_ids": [u2["id"]]},
        )
        gid = res.json()["id"]

        # Non-member cannot rename
        res = c3.patch(f"/api/group-dms/{gid}", headers=ORIGIN, json={"name": "새 이름"})
        assert res.status_code == 403

        # Member renames
        res = c2.patch(f"/api/group-dms/{gid}", headers=ORIGIN, json={"name": "멋진 그룹"})
        assert res.status_code == 200
        assert res.json()["display_name"] == "멋진 그룹"

    def test_invite_and_leave_api(self):
        c1, u1 = session_client("alice")
        c2, u2 = session_client("bob")
        c3, u3 = session_client("charlie")

        res = c1.post(
            "/api/group-dms",
            headers=ORIGIN,
            json={"member_ids": [u2["id"]]},
        )
        gid = res.json()["id"]

        # Invite charlie
        res = c1.post(f"/api/group-dms/{gid}/members", headers=ORIGIN, json={"member_ids": [u3["id"]]})
        assert res.status_code == 200
        assert any(m["id"] == u3["id"] for m in res.json()["members"])

        # Charlie now has access
        res = c3.get(f"/api/group-dms/{gid}")
        assert res.status_code == 200

        # Charlie leaves
        res = c3.delete(f"/api/group-dms/{gid}/members/me", headers=ORIGIN)
        assert res.status_code == 200

        # Charlie no longer has access
        res = c3.get(f"/api/group-dms/{gid}")
        assert res.status_code == 404

    def test_channel_message_history_isolation(self):
        c1, u1 = session_client("alice")
        c2, u2 = session_client("bob")
        c3, u3 = session_client("charlie")

        res = c1.post(
            "/api/group-dms",
            headers=ORIGIN,
            json={"member_ids": [u2["id"]]},
        )
        gid = res.json()["id"]

        database.save_message("alice", "비밀 메시지입니다.", user_id=u1["id"], channel_id=gid)

        # Alice gets history
        res = c1.get(f"/api/channels/{gid}/messages")
        assert res.status_code == 200
        assert len(res.json()["messages"]) == 1

        # Bob gets history
        res = c2.get(f"/api/channels/{gid}/messages")
        assert res.status_code == 200

        # Charlie is forbidden (403)
        res = c3.get(f"/api/channels/{gid}/messages")
        assert res.status_code == 403

    def test_channel_update_forbidden_on_group_dm(self):
        admin_c, admin_u = session_client("admin", role="admin")
        c1, u1 = session_client("alice")
        c2, u2 = session_client("bob")

        res = c1.post(
            "/api/group-dms",
            headers=ORIGIN,
            json={"member_ids": [u2["id"]]},
        )
        gid = res.json()["id"]

        # Admin tries to update group DM via public channel router -> 400 Bad Request
        res = admin_c.patch(
            f"/api/channels/{gid}",
            headers=ORIGIN,
            json={"display_name": "해킹됨"},
        )
        assert res.status_code == 400
        assert "그룹 대화" in res.json()["detail"]


# ==========================================================================
# 3. Search & Unread Count Scoping
# ==========================================================================

class TestGroupDmSearchAndUnread:
    def test_search_history_scoped_to_members(self):
        c1, u1 = session_client("alice")
        c2, u2 = session_client("bob")
        c3, u3 = session_client("charlie")

        gdm = database.create_group_dm(u1["id"], [u2["id"]])
        database.save_message("alice", "극비 프로젝트 회의록", user_id=u1["id"], channel_id=gdm["id"])

        # Member alice searches
        res1 = database.search_conversation_history(u1["id"], "극비")
        assert any("극비" in (m.get("content") or "") for m in res1)

        # Member bob searches
        res2 = database.search_conversation_history(u2["id"], "극비")
        assert any("극비" in (m.get("content") or "") for m in res2)

        # Non-member charlie searches: 0 results
        res3 = database.search_conversation_history(u3["id"], "극비")
        assert not any("극비" in (m.get("content") or "") for m in res3)

    def test_unread_counts_for_group_dm(self):
        _, u1 = session_client("alice")
        _, u2 = session_client("bob")
        _, u3 = session_client("charlie")

        gdm = database.create_group_dm(u1["id"], [u2["id"]])
        msg = database.save_message("alice", "새 메시지", user_id=u1["id"], channel_id=gdm["id"])
        msg_int_id = int(str(msg["message_id"]).split(":")[1])

        # Bob has 1 unread in this group DM channel
        unreads_bob = database.get_user_unread_counts(u2["id"])
        assert unreads_bob.get(f"channel:{gdm['id']}") == 1

        # Alice (the author) has 0 unread
        unreads_alice = database.get_user_unread_counts(u1["id"])
        assert unreads_alice.get(f"channel:{gdm['id']}") == 0

        # Charlie (non-member) does not have this group DM in unreads
        unreads_charlie = database.get_user_unread_counts(u3["id"])
        assert f"channel:{gdm['id']}" not in unreads_charlie

        # Bob acknowledges reading the message
        database.update_user_read_state(u2["id"], "channel", str(gdm["id"]), last_read_id=msg_int_id)
        unreads_bob_after = database.get_user_unread_counts(u2["id"])
        assert unreads_bob_after.get(f"channel:{gdm['id']}") == 0


# ==========================================================================
# 4. WebSocket & Realtime Scoping
# ==========================================================================

class TestGroupDmWebSocket:
    def test_websocket_chat_in_group_dm(self):
        c1, u1 = session_client("alice")
        c2, u2 = session_client("bob")
        c3, u3 = session_client("charlie")

        gdm = database.create_group_dm(u1["id"], [u2["id"]])
        gid = gdm["id"]

        with c1.websocket_connect("/ws", headers=ORIGIN) as ws_alice, \
             c2.websocket_connect("/ws", headers=ORIGIN) as ws_bob, \
             c3.websocket_connect("/ws", headers=ORIGIN) as ws_charlie:

            # Alice sends message to group DM channel
            ws_alice.send_json({
                "type": "chat",
                "channel_id": gid,
                "content": "안녕하세요 그룹 멤버 여러분!",
            })

            # Alice receives chat echo
            msg_alice = recv_until(ws_alice, "chat")
            assert msg_alice["content"] == "안녕하세요 그룹 멤버 여러분!"
            assert msg_alice["channel_id"] == gid

            # Bob receives chat message
            msg_bob = recv_until(ws_bob, "chat")
            assert msg_bob["content"] == "안녕하세요 그룹 멤버 여러분!"
            assert msg_bob["channel_id"] == gid

            # Charlie (non-member) attempts to send to group DM -> receives error
            ws_charlie.send_json({
                "type": "chat",
                "channel_id": gid,
                "content": "해킹 시도!",
            })
            err = recv_until(ws_charlie, "error")
            assert "참여자" in err["message"]

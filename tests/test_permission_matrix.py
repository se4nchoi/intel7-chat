"""Permission matrix: who may read or change what.

Each case names an actor (anon, student, participant, admin) and a resource,
and states the expected outcome. Cases marked xfail(strict=True) record known
authorization gaps in the current code; fixing one makes its xfail fail, so
remove the marker in the same change.
"""
import json
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from app import database, main
from app.auth import token_hash
from app.config import GIB
from app.screenshare import screenshare_manager

ORIGIN = {"origin": "http://testserver"}
SECRET = "alice-to-bob-private-note"


@pytest.fixture(autouse=True)
def isolated_state(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", tmp_path / "chat.db")
    monkeypatch.setattr(database, "DB_MAX_BYTES", 3 * GIB)
    monkeypatch.setattr(main, "UPLOAD_DIR", tmp_path / "uploads")
    monkeypatch.setenv("BAMBOOCHAT_CONFIG", str(tmp_path / "bamboochat.json"))
    main.connected_clients.clear()
    main.user_registry.clear()
    main.message_timestamps.clear()
    main.upload_timestamps.clear()
    main.login_timestamps.clear()
    screenshare_manager.sessions.clear()
    screenshare_manager.viewers.clear()
    main.UPLOAD_DIR.mkdir(parents=True)
    database.init_db()
    yield
    screenshare_manager.sessions.clear()
    screenshare_manager.viewers.clear()


def session_client(username, role="student"):
    user = database.create_user(username, "not-used-in-session-tests", role=role)
    raw = f"session-token-for-user-{user['id']}"
    database.create_session(token_hash(raw), user["id"], "2999-01-01T00:00:00Z")
    client = TestClient(main.app)
    client.cookies.set(main.SESSION_COOKIE, raw)
    return client, user


@pytest.fixture
def world():
    """alice and bob share a DM with an attachment; carol is an unrelated student."""
    alice_client, alice = session_client("alice")
    bob_client, bob = session_client("bob")
    carol_client, carol = session_client("carol")
    admin_client, admin = session_client("teacher", role="admin")

    upload = alice_client.post("/api/files", content=b"private bytes",
        headers={**ORIGIN, "X-File-Name": quote("notes.txt"),
                 "Content-Type": "application/octet-stream"})
    assert upload.status_code == 201
    attachment_id = upload.json()["id"]
    dm = database.save_direct_message(alice, bob, SECRET, attachment_ids=[attachment_id])
    dm_id = int(dm["message_id"].removeprefix("dm:"))
    channel_msg = database.save_message("alice", "channel hello", user_id=alice["id"], channel_id=1)
    channel_msg_id = int(channel_msg["message_id"].removeprefix("public:"))

    return {
        "clients": {"anon": TestClient(main.app), "alice": alice_client, "bob": bob_client,
                    "carol": carol_client, "admin": admin_client},
        "users": {"alice": alice, "bob": bob, "carol": carol, "admin": admin},
        "attachment_id": attachment_id, "dm_id": dm_id, "channel_msg_id": channel_msg_id,
    }


def call(world, actor, method, path, **kwargs):
    path = path.format(**{k: v for k, v in world.items() if not isinstance(v, dict)})
    headers = {**ORIGIN, **kwargs.pop("headers", {})}
    return world["clients"][actor].request(method, path, headers=headers, **kwargs)


# (actor, method, path, json body, expected status)
HTTP_MATRIX = [
    # Logged-out visitors reach nothing behind login.
    ("anon", "GET", "/api/history/public", None, 401),
    ("anon", "GET", "/api/files/{attachment_id}", None, 401),
    ("anon", "GET", "/api/read-states", None, 401),
    ("anon", "GET", "/api/channels", None, 401),
    ("anon", "GET", "/api/admin/overview", None, 401),
    # DM attachments: only the two participants, not admins.
    ("alice", "GET", "/api/files/{attachment_id}", None, 200),
    ("bob", "GET", "/api/files/{attachment_id}", None, 200),
    ("carol", "GET", "/api/files/{attachment_id}", None, 404),
    ("admin", "GET", "/api/files/{attachment_id}", None, 404),
    # DM edits: author only.
    ("alice", "PATCH", "/api/dms/{dm_id}", {"content": "edit"}, 200),
    ("bob", "PATCH", "/api/dms/{dm_id}", {"content": "edit"}, 403),
    ("carol", "PATCH", "/api/dms/{dm_id}", {"content": "edit"}, 403),
    ("admin", "PATCH", "/api/dms/{dm_id}", {"content": "edit"}, 403),
    # DM reactions and pins: participants only.
    ("bob", "POST", "/api/messages/dm/{dm_id}/reactions/toggle", {"emoji": "👍"}, 200),
    ("carol", "POST", "/api/messages/dm/{dm_id}/reactions/toggle", {"emoji": "👍"}, 403),
    ("carol", "POST", "/api/conversations/dm/alice/pins/{dm_id}", None, 403),
    ("carol", "DELETE", "/api/conversations/dm/alice/pins/{dm_id}", None, 403),
    # Channel messages: author or admin may edit; moderation is admin-only.
    ("alice", "PATCH", "/api/messages/{channel_msg_id}", {"content": "edit"}, 200),
    ("carol", "PATCH", "/api/messages/{channel_msg_id}", {"content": "edit"}, 403),
    ("admin", "PATCH", "/api/messages/{channel_msg_id}", {"content": "edit"}, 200),
    ("carol", "POST", "/api/messages/{channel_msg_id}/hide", {"hidden": True}, 403),
    ("admin", "POST", "/api/messages/{channel_msg_id}/hide", {"hidden": True}, 200),
    ("carol", "POST", "/api/messages/{channel_msg_id}/move", {"to_channel_id": 1}, 403),
    # Channel and account administration: admin only.
    ("carol", "PATCH", "/api/channels/1", {"display_name": "x"}, 403),
    ("carol", "POST", "/api/channels/1/archive", None, 403),
    ("carol", "DELETE", "/api/channels/1", None, 403),
    ("carol", "GET", "/api/admin/overview", None, 403),
    ("carol", "POST", "/api/admin/registration", {"enabled": True}, 403),
    ("admin", "GET", "/api/admin/overview", None, 200),
]


@pytest.mark.parametrize("actor,method,path,body,expected", HTTP_MATRIX,
    ids=[f"{a}-{m}-{p}" for a, m, p, _, _ in HTTP_MATRIX])
def test_http_permission_matrix(world, actor, method, path, body, expected):
    kwargs = {"json": body} if body is not None else {}
    assert call(world, actor, method, path, **kwargs).status_code == expected


def test_dm_history_only_returns_the_callers_own_conversation(world):
    # carol asking for "bob" gets carol<->bob history, never alice<->bob.
    response = call(world, "carol", "GET", "/api/history/dm/bob")
    assert response.status_code == 200
    assert SECRET not in response.text


def test_global_search_excludes_other_peoples_dms(world):
    carol = call(world, "carol", "GET", f"/api/search?q={SECRET[:10]}&scope=global")
    assert carol.status_code == 200 and carol.json()["count"] == 0
    bob = call(world, "bob", "GET", f"/api/search?q={SECRET[:10]}&scope=global")
    assert bob.json()["count"] == 1


def test_deactivated_account_loses_http_access(world):
    database.set_user_active(world["users"]["carol"]["id"], False)
    assert call(world, "carol", "GET", "/api/history/public").status_code == 401


@pytest.mark.xfail(strict=True, reason="Hidden messages are sent to students with full content; hiding is client-side only.")
def test_hidden_channel_message_content_is_withheld_from_students(world):
    call(world, "admin", "POST", "/api/messages/{channel_msg_id}/hide", json={"hidden": True})
    response = call(world, "carol", "GET", "/api/history/public")
    assert "channel hello" not in response.text


@pytest.mark.xfail(strict=True, reason="/api/screenshare/status has no login check and lists DM share rooms.")
def test_screenshare_status_requires_login(world):
    assert call(world, "anon", "GET", "/api/screenshare/status").status_code == 401


# --- WebSocket cases -------------------------------------------------------

def drain_until(ws, wanted_type, limit=40):
    for _ in range(limit):
        message = json.loads(ws.receive_text())
        if message.get("type") == wanted_type:
            return message
    raise AssertionError(f"no {wanted_type} message received")


def test_websocket_rejects_anonymous_connections(world):
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect):
        with world["clients"]["anon"].websocket_connect("/ws", headers=ORIGIN) as ws:
            ws.receive_text()


@pytest.mark.xfail(strict=True, reason="Sessions are checked only at connect; a logged-out socket can still post.")
def test_open_socket_cannot_post_after_logout(world):
    carol = world["clients"]["carol"]
    with carol.websocket_connect("/ws", headers=ORIGIN) as ws:
        drain_until(ws, "history_ready")
        assert carol.post("/api/auth/logout", headers=ORIGIN).status_code == 204
        ws.send_text(json.dumps({"type": "chat", "channel_id": 1, "content": "after logout"}))
        reply = json.loads(ws.receive_text())
        assert reply.get("type") != "chat"
    saved = [m["content"] for m in database.get_recent_messages()]
    assert "after logout" not in saved


@pytest.mark.xfail(strict=True, reason="Any user can start a share in an occupied room and replace its presenter.")
def test_student_cannot_take_over_an_active_channel_share(world):
    admin_client, carol_client = world["clients"]["admin"], world["clients"]["carol"]
    with admin_client.websocket_connect("/ws", headers=ORIGIN) as admin_ws:
        drain_until(admin_ws, "history_ready")
        admin_ws.send_text(json.dumps({"type": "screenshare_start", "channel_id": 1}))
        drain_until(admin_ws, "screenshare_started")
        with carol_client.websocket_connect("/ws", headers=ORIGIN) as carol_ws:
            drain_until(carol_ws, "history_ready")
            carol_ws.send_text(json.dumps({"type": "screenshare_start", "channel_id": 1}))
            carol_ws.send_text(json.dumps({"type": "screenshare_status", "channel_id": 1}))
            status = drain_until(carol_ws, "screenshare_status")
    assert status["session"]["user_id"] == world["users"]["admin"]["id"]


@pytest.mark.xfail(strict=True, reason="Non-participants can join a DM share room; the presenter's client then streams to them.")
def test_outsider_cannot_join_a_dm_screen_share(world):
    alice_client, carol_client = world["clients"]["alice"], world["clients"]["carol"]
    with alice_client.websocket_connect("/ws", headers=ORIGIN) as alice_ws:
        drain_until(alice_ws, "history_ready")
        alice_ws.send_text(json.dumps({"type": "screenshare_start", "channel_id": "dm:alice:bob"}))
        drain_until(alice_ws, "screenshare_started")
        with carol_client.websocket_connect("/ws", headers=ORIGIN) as carol_ws:
            drain_until(carol_ws, "history_ready")
            carol_ws.send_text(json.dumps({"type": "screenshare_join", "channel_id": "dm:alice:bob"}))
            carol_ws.send_text(json.dumps({"type": "screenshare_status", "channel_id": "dm:alice:bob"}))
            drain_until(carol_ws, "screenshare_status")
            viewers = set(screenshare_manager.viewers.get("dm:alice:bob", set()))
    assert world["users"]["carol"]["id"] not in viewers

import json

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import auth, database, main
from app.realtime import ManagedSocket

ORIGIN = {"origin": "http://testserver"}
PATHS = ["/ws", "/ws/chess", "/ws/janggi", "/ws/omok", "/ws/othello"]
pytestmark = pytest.mark.usefixtures("shared_application_loop")


def client_for(user, token):
    database.create_session(auth.token_hash(token), user["id"], "2999-01-01T00:00:00Z")
    client = TestClient(main.app)
    client.cookies.set(main.SESSION_COOKIE, token)
    return client


def frame(ws):
    future = ws.portal.start_task_soon(ws._send_rx.receive)
    try:
        result = future.result(timeout=3)
    except TimeoutError:
        future.cancel()
        pytest.fail("WebSocket did not respond/close within three seconds")
    ws._raise_on_close(result)
    return json.loads(result["text"])


def ready(ws, path):
    expected = "history_ready" if path == "/ws" else "lobby_update"
    for _ in range(100):
        if frame(ws).get("type") == expected:
            return
    pytest.fail("Missing initial socket state")


def assert_revoked(ws):
    with pytest.raises(WebSocketDisconnect) as error:
        for _ in range(100):
            frame(ws)
        pytest.fail("Revoked socket remained connected")
    assert error.value.code == 1008


@pytest.mark.parametrize("path", PATHS)
def test_logout_closes_chat_and_game_sockets(path):
    user = database.create_user("logout-client", "unused")
    client = client_for(user, "logout-token")
    with client.websocket_connect(path, headers=ORIGIN) as ws:
        ready(ws, path)
        assert client.post("/api/auth/logout", headers=ORIGIN).status_code == 204
        assert_revoked(ws)


@pytest.mark.parametrize("path", PATHS)
def test_idle_expiry_closes_chat_and_game_sockets(monkeypatch, path):
    monkeypatch.setattr(ManagedSocket, "SESSION_CHECK_INTERVAL", .02)
    user = database.create_user("expiry-client", "unused")
    client = client_for(user, "expiry-token")
    with client.websocket_connect(path, headers=ORIGIN) as ws:
        ready(ws, path)
        with database.get_connection() as conn:
            conn.execute("UPDATE sessions SET expires_at='2000-01-01T00:00:00Z'")
            conn.commit()
        assert_revoked(ws)


def test_logging_out_one_session_preserves_other_users_session():
    first_user = database.create_user("first-user", "unused")
    second_user = database.create_user("second-user", "unused")
    first = client_for(first_user, "first-session")
    second = client_for(second_user, "second-session")
    with first.websocket_connect("/ws", headers=ORIGIN) as old, \
            second.websocket_connect("/ws", headers=ORIGIN) as current:
        ready(old, "/ws")
        ready(current, "/ws")
        assert first.post("/api/auth/logout", headers=ORIGIN).status_code == 204
        assert_revoked(old)
        current.send_json({"type": "chat", "channel_id": 1, "content": "still authorized"})
        for _ in range(100):
            message = frame(current)
            if message.get("type") == "chat" and message.get("content") == "still authorized":
                break
        else:
            pytest.fail("Other session lost access")


def test_revoked_session_cannot_save_chat():
    user = database.create_user("revoked-sender", "unused")
    client = client_for(user, "revoked-token")
    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        ready(ws, "/ws")
        database.delete_session(auth.token_hash("revoked-token"))
        ws.send_json({"type": "chat", "channel_id": 1, "content": "must not persist"})
        assert_revoked(ws)
    assert not any(m["content"] == "must not persist" for m in database.get_recent_messages())


def test_logout_closes_all_tabs_including_game_for_the_session():
    user = database.create_user("multi-tab", "unused")
    client = client_for(user, "multi-tab-token")
    with client.websocket_connect("/ws", headers=ORIGIN) as chat, \
            client.websocket_connect("/ws/chess", headers=ORIGIN) as game:
        ready(chat, "/ws")
        ready(game, "/ws/chess")
        assert client.post("/api/auth/logout", headers=ORIGIN).status_code == 204
        assert_revoked(chat)
        assert_revoked(game)


def test_admin_disconnect_closes_chat_and_game_connections():
    user = database.create_user("admin-revoked", "unused")
    client = client_for(user, "admin-revoked-token")
    with client.websocket_connect("/ws", headers=ORIGIN) as chat, \
            client.websocket_connect("/ws/omok", headers=ORIGIN) as game:
        ready(chat, "/ws")
        ready(game, "/ws/omok")
        chat.portal.call(main.disconnect_user, user["id"], "Account changed")
        assert_revoked(chat)
        assert_revoked(game)

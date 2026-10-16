import json

from fastapi.testclient import TestClient

from app import auth, database, main


def test_full_history_reconnect_does_not_overflow_live_delivery_queue():
    """Real classroom history exceeds 128 frames across public chat and DMs."""
    viewer = database.create_user("history-owner", "unused")
    partners = [database.create_user(f"history-peer-{i}", "unused") for i in range(4)]
    for i in range(50):
        database.save_message(viewer["username"], f"public-{i}", user_id=viewer["id"])
    for partner in partners:
        for i in range(30):
            database.save_direct_message(viewer, partner, f"private-{i}")
    token = "full-history-token"
    database.create_session(auth.token_hash(token), viewer["id"], "2999-01-01T00:00:00Z")
    client = TestClient(main.app)
    client.cookies.set(main.SESSION_COOKIE, token)
    with client.websocket_connect("/ws", headers={"origin": "http://testserver"}) as ws:
        received = []
        for _ in range(250):
            pending = ws.portal.start_task_soon(ws._send_rx.receive)
            try:
                frame = pending.result(timeout=5)
            except TimeoutError:
                pending.cancel()
                raise AssertionError("Initial history delivery stalled") from None
            ws._raise_on_close(frame)
            message = json.loads(frame["text"])
            received.append(message)
            if message["type"] == "history_ready":
                break
        else:
            raise AssertionError("Missing history_ready")
        assert any(message["type"] == "users" for message in received)
        assert sum(message["type"] == "chat" for message in received) == 50
        assert sum(message["type"] == "dm" for message in received) == 120
        ws.send_json({"type": "screenshare_start", "channel_id": 1})
        while True:
            message = ws.receive_json()
            if message["type"] == "screenshare_started":
                break

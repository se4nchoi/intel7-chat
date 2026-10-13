"""Unit tests for multi-channel real-time LAN Screen Sharing manager and endpoints."""
from __future__ import annotations

from pathlib import Path
import anyio
import json
import pytest
from app import database, auth, main, screenshare
from app.config import GIB
from app.screenshare import ScreenShareManager


def _authenticated_client(username):
    from fastapi.testclient import TestClient
    user = database.create_user(username, "unused_test_hash")
    token = f"screenshare-test-token-{user['id']}"
    database.create_session(auth.token_hash(token), user["id"], "2999-01-01T00:00:00Z")
    client = TestClient(main.app)
    client.cookies.set(main.SESSION_COOKIE, token)
    return client, user


def _receive_event(ws, event_type):
    for _ in range(100):
        future = ws.portal.start_task_soon(ws._send_rx.receive)
        try:
            frame = future.result(timeout=5)
        except TimeoutError:
            future.cancel()
            raise AssertionError(f"Timed out waiting for WebSocket event: {event_type}") from None
        ws._raise_on_close(frame)
        message = json.loads(frame["text"])
        if message.get("type") == event_type:
            return message
        if message.get("type") == "error":
            raise AssertionError(f"Expected {event_type}, received error: {message}")
    raise AssertionError(f"Missing WebSocket event: {event_type}")


def test_classroom_signaling_burst_preserves_share_and_chat_budget():
    """49 handshakes worth of signaling must not close the presenter's socket."""
    from starlette.websockets import WebSocketDisconnect
    presenter, presenter_user = _authenticated_client("burst_presenter")
    viewer, viewer_user = _authenticated_client("burst_viewer")
    origin = {"origin": "http://testserver"}
    with presenter.websocket_connect("/ws", headers=origin) as sender, \
         viewer.websocket_connect("/ws", headers=origin) as receiver:
        _receive_event(sender, "history_ready")
        _receive_event(receiver, "history_ready")
        sender.send_json({"type": "screenshare_start", "channel_id": 2})
        _receive_event(sender, "screenshare_started")
        _receive_event(receiver, "screenshare_started")
        receiver.send_json({"type": "screenshare_join", "channel_id": 2})
        _receive_event(sender, "screenshare_viewer_joined")
        # A connected receiver is a sink for the volume of a full classroom's
        # offers/candidates; the signaling handler forwards their contents unchanged.
        for peer in range(main.MAX_CONNECTIONS_TOTAL - 1):
            for index in range(7):
                signal = {"type": "offer", "sdp": f"offer-{peer}"} if index == 0 else {
                    "type": "candidate", "candidate": {"candidate": f"candidate-{peer}-{index}"}}
                sender.send_json({"type": "screenshare_signal", "channel_id": 2,
                                  "target_user_id": viewer_user["id"], "signal": signal})
                forwarded = _receive_event(receiver, "screenshare_signal")
                assert forwarded["signal"] == signal
        assert not main.message_timestamps[str(presenter_user["id"])]
        sender.send_json({"type": "screenshare_status", "channel_id": 2})
        assert _receive_event(sender, "screenshare_status")["is_active"]

        # Screen sharing must leave the existing chat allowance intact.
        for index in range(main.RATE_LIMIT_MESSAGES):
            sender.send_json({"type": "chat", "channel_id": 1, "content": f"chat-{index}"})
            assert _receive_event(sender, "chat")["content"] == f"chat-{index}"
        sender.send_json({"type": "screenshare_status", "channel_id": 2})
        assert _receive_event(sender, "screenshare_status")["is_active"]
        sender.send_json({"type": "chat", "channel_id": 1, "content": "over chat limit"})
        assert _receive_event(sender, "error")["code"] == "message_rate_limited"
        with pytest.raises(WebSocketDisconnect) as closed:
            sender.receive_json()
        assert closed.value.code == 1008


def test_screenshare_limit_is_bounded_and_shared_across_account_sockets(monkeypatch):
    from starlette.websockets import WebSocketDisconnect
    monkeypatch.setattr(main, "SCREENSHARE_RATE_LIMIT_MESSAGES", 5)
    client, _ = _authenticated_client("bounded_presenter")
    origin = {"origin": "http://testserver"}
    with client.websocket_connect("/ws", headers=origin) as first, \
         client.websocket_connect("/ws", headers=origin) as second:
        _receive_event(first, "history_ready")
        _receive_event(second, "history_ready")
        for ws in (first, second, first, second, first):
            ws.send_json({"type": "screenshare_status", "channel_id": 2})
            assert _receive_event(ws, "screenshare_status")["is_active"] is False
        second.send_json({"type": "screenshare_status", "channel_id": 2})
        assert _receive_event(second, "error")["code"] == "screenshare_rate_limited"
        with pytest.raises(WebSocketDisconnect) as closed:
            second.receive_json()
        assert closed.value.code == 1008


@pytest.mark.parametrize("raw", ["invalid json", "[]", '{"type": ["screenshare_signal"]}'])
def test_malformed_frames_still_use_normal_rate_limit(raw, monkeypatch):
    from starlette.websockets import WebSocketDisconnect
    monkeypatch.setattr(main, "RATE_LIMIT_MESSAGES", 2)
    client, _ = _authenticated_client("malformed_sender")
    with client.websocket_connect("/ws", headers={"origin": "http://testserver"}) as ws:
        _receive_event(ws, "history_ready")
        for _ in range(3):
            ws.send_text(raw)
        assert _receive_event(ws, "error")["code"] == "message_rate_limited"
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
        assert closed.value.code == 1008


@pytest.fixture(autouse=True)
def isolated_state(tmp_path: Path, monkeypatch, shared_application_loop):
    monkeypatch.setattr(database, "DB_PATH", tmp_path / "chat.db")
    monkeypatch.setattr(database, "DB_MAX_BYTES", 3 * GIB)
    monkeypatch.setattr(main, "UPLOAD_DIR", tmp_path / "uploads")
    main.connected_clients.clear()
    main.user_registry.clear()
    main.message_timestamps.clear()
    main.screenshare_timestamps.clear()
    main.upload_timestamps.clear()
    main.login_timestamps.clear()
    screenshare.screenshare_manager.sessions.clear()
    screenshare.screenshare_manager.viewers.clear()
    screenshare.screenshare_manager.viewer_clients.clear()
    database.init_db()
    yield
    main.connected_clients.clear()
    main.user_registry.clear()
    screenshare.screenshare_manager.sessions.clear()
    screenshare.screenshare_manager.viewers.clear()


@pytest.mark.anyio
async def test_screenshare_manager_multi_channel_lifecycle():
    manager = ScreenShareManager()

    # Initial state
    all_sess = await manager.get_all_sessions()
    assert len(all_sess) == 0
    status_ch2 = await manager.get_channel_status(2)
    assert status_ch2["is_active"] is False
    assert manager.is_presenter(101) is False

    # 1. Start stream in channel 2 (e.g. Professor in Lecture channel)
    s1 = await manager.start_session(
        user_id=101,
        username="prof_kim",
        display_name="김교수",
        channel_id=2,
        title="PLC 특강 화면"
    )
    assert s1["channel_id"] == 2
    assert s1["user_id"] == 101
    assert manager.is_presenter(101) is True
    assert manager.is_presenter(101, channel_id=2) is True
    assert manager.is_presenter(101, channel_id=3) is False

    # 2. Concurrently start stream in channel 3 (e.g. Student in Team channel)
    s2 = await manager.start_session(
        user_id=102,
        username="student_lee",
        display_name="이학생",
        channel_id=3,
        title="1조 프로젝트 회의"
    )
    assert s2["channel_id"] == 3
    assert s2["user_id"] == 102

    # Both channels are concurrently active!
    all_sess = await manager.get_all_sessions()
    assert len(all_sess) == 2
    assert "2" in all_sess and "3" in all_sess

    # Viewers in channel 2 vs channel 3
    c2_count = await manager.add_viewer(2, 201)
    assert c2_count == 2  # presenter + viewer
    c3_count = await manager.add_viewer(3, 202)
    assert c3_count == 2

    st2 = await manager.get_channel_status(2)
    assert st2["is_active"] is True
    assert st2["viewer_count"] == 2

    st3 = await manager.get_channel_status(3)
    assert st3["is_active"] is True
    assert st3["viewer_count"] == 2

    # If presenter 101 switches and starts in channel 4, channel 2 is auto-stopped
    s1_new = await manager.start_session(
        user_id=101,
        username="prof_kim",
        display_name="김교수",
        channel_id=4,
        title="연구실 화면"
    )
    assert s1_new["channel_id"] == 4
    all_sess = await manager.get_all_sessions()
    assert "2" not in all_sess
    assert "4" in all_sess
    assert "3" in all_sess

    # Stop channel 4
    stopped = await manager.stop_session(channel_id=4, user_id=101)
    assert len(stopped) == 1
    assert stopped[0]["channel_id"] == 4

    # Channel 3 is still active!
    st3_after = await manager.get_channel_status(3)
    assert st3_after["is_active"] is True

    # Stop user 102 (channel 3)
    stopped_user = await manager.stop_session(user_id=102)
    assert len(stopped_user) == 1
    assert stopped_user[0]["channel_id"] == 3

    assert len(await manager.get_all_sessions()) == 0


def test_screenshare_channel_seeded():
    """Verify that _migrate_v24 creates the screenshare channel as default."""
    channels = database.list_channels()
    screenshare_chan = next((c for c in channels if c["name"] == "screenshare"), None)
    assert screenshare_chan is not None
    assert screenshare_chan["display_name"] == "🖥️ 화면 공유"
    assert screenshare_chan["is_default"] is True

    # General channel should be first, screenshare should be present
    assert channels[0]["name"] == "general"
    assert any(c["name"] == "screenshare" for c in channels)


def test_screenshare_api_and_websocket():
    from fastapi.testclient import TestClient
    from app import main

    client = TestClient(main.app)
    # Screen-share status requires authentication, including room metadata.
    res = client.get("/api/screenshare/status")
    assert res.status_code == 401

    # Check REST status (specific channel)
    res_ch = client.get("/api/screenshare/status?channel_id=2")
    assert res_ch.status_code == 401

    import uuid
    uid = uuid.uuid4().hex[:6]
    u1 = database.create_user(f"presenter_{uid}", "pass123")
    u2 = database.create_user(f"viewer_{uid}", "pass123")
    t1 = f"token-for-{u1['id']}"
    t2 = f"token-for-{u2['id']}"
    database.create_session(auth.token_hash(t1), u1["id"], "2999-01-01T00:00:00Z")
    database.create_session(auth.token_hash(t2), u2["id"], "2999-01-01T00:00:00Z")

    c1 = TestClient(main.app)
    c1.cookies.set(main.SESSION_COOKIE, t1)
    c2 = TestClient(main.app)
    c2.cookies.set(main.SESSION_COOKIE, t2)

    origin = {"origin": "http://testserver"}
    with c1.websocket_connect("/ws", headers=origin) as ws1, c2.websocket_connect("/ws", headers=origin) as ws2:
        def wait_for_event(ws, event_type, max_messages=100):
            return _receive_event(ws, event_type)

        # Drain initial connection messages
        wait_for_event(ws1, "history_ready")
        wait_for_event(ws2, "history_ready")

        # Presenter starts screen share in channel 2
        ws1.send_json({"type": "screenshare_start", "channel_id": 2, "title": "데모 화면"})
        # Viewer receives screenshare_started broadcast with channel_id
        evt1 = wait_for_event(ws2, "screenshare_started")
        assert evt1["channel_id"] == 2
        assert evt1["user_id"] == u1["id"]
        assert evt1["title"] == "데모 화면"

        # Viewer joins channel 2's screen share
        ws2.send_json({"type": "screenshare_join", "channel_id": 2})
        # Presenter receives notification that viewer joined channel 2
        evt2 = wait_for_event(ws1, "screenshare_viewer_joined")
        assert evt2["channel_id"] == 2
        assert evt2["viewer_user_id"] == u2["id"]
        assert c1.get("/api/screenshare/status").status_code == 200

        # Presenter sends WebRTC signal (e.g. offer) to viewer in channel 2
        ws1.send_json({
            "type": "screenshare_signal",
            "channel_id": 2,
            "target_user_id": u2["id"],
            "signal": {"type": "offer", "sdp": "fake_sdp_test"}
        })
        # Viewer receives signal
        evt3 = wait_for_event(ws2, "screenshare_signal")
        assert evt3["channel_id"] == 2
        assert evt3["from_user_id"] == u1["id"]
        assert evt3["signal"]["sdp"] == "fake_sdp_test"

        # Presenter stops sharing in channel 2
        ws1.send_json({"type": "screenshare_stop", "channel_id": 2})
        evt4 = wait_for_event(ws2, "screenshare_stopped")
        assert evt4["channel_id"] == 2
        assert evt4["user_id"] == u1["id"]


def test_screenshare_dm_workflow_and_privacy():
    """Verify that DM screensharing works 1:1 and remains private from 3rd-party users."""
    from fastapi.testclient import TestClient
    from app import main, screenshare
    import uuid

    uid = uuid.uuid4().hex[:6]
    name_a = f"alice_{uid}"
    name_b = f"bob_{uid}"
    name_c = f"charlie_{uid}"

    u_a = database.create_user(name_a, "pass123")
    u_b = database.create_user(name_b, "pass123")
    u_c = database.create_user(name_c, "pass123")

    t_a = f"token-for-{u_a['id']}"
    t_b = f"token-for-{u_b['id']}"
    database.create_session(auth.token_hash(t_a), u_a["id"], "2999-01-01T00:00:00Z")
    database.create_session(auth.token_hash(t_b), u_b["id"], "2999-01-01T00:00:00Z")

    c_a = TestClient(main.app)
    c_a.cookies.set(main.SESSION_COOKIE, t_a)
    c_b = TestClient(main.app)
    c_b.cookies.set(main.SESSION_COOKIE, t_b)

    origin = {"origin": "http://testserver"}
    with c_a.websocket_connect("/ws", headers=origin) as ws_a, \
         c_b.websocket_connect("/ws", headers=origin) as ws_b:

        def wait_for_event(ws, event_type, max_messages=100):
            return _receive_event(ws, event_type)

        # Drain history_ready
        wait_for_event(ws_a, "history_ready")
        wait_for_event(ws_b, "history_ready")

        dm_room = f"dm:{min(name_a, name_b)}:{max(name_a, name_b)}"

        # Alice starts screensharing in DM with Bob
        ws_a.send_json({"type": "screenshare_start", "channel_id": dm_room, "title": "Alice's code"})

        # Bob receives screenshare_started
        evt_b = wait_for_event(ws_b, "screenshare_started")
        assert evt_b["channel_id"] == dm_room
        assert evt_b["user_id"] == u_a["id"]
        assert evt_b["room_type"] == "dm"

        # Bob joins Alice's DM screenshare
        ws_b.send_json({"type": "screenshare_join", "channel_id": dm_room})
        evt_joined = wait_for_event(ws_a, "screenshare_viewer_joined")
        assert evt_joined["channel_id"] == dm_room
        assert evt_joined["viewer_user_id"] == u_b["id"]

        # Alice sends WebRTC signal to Bob in DM
        ws_a.send_json({
            "type": "screenshare_signal",
            "channel_id": dm_room,
            "target_user_id": u_b["id"],
            "signal": {"type": "offer", "sdp": "dm_offer_sdp"}
        })
        evt_sig = wait_for_event(ws_b, "screenshare_signal")
        assert evt_sig["channel_id"] == dm_room
        assert evt_sig["from_user_id"] == u_a["id"]
        assert evt_sig["signal"]["sdp"] == "dm_offer_sdp"

        # Check REST status for the DM room
        res_dm = c_a.get(f"/api/screenshare/status?channel_id={dm_room}")
        assert res_dm.status_code == 200
        assert res_dm.json()["is_active"] is True
        assert res_dm.json()["viewer_count"] == 2

        # Verify privacy: charlie does NOT see alice & bob's private DM stream in session list
        all_for_charlie = anyio.run(screenshare.screenshare_manager.get_all_sessions, name_c)
        assert dm_room not in all_for_charlie

        # But alice and bob DO see their DM session
        all_for_alice = anyio.run(screenshare.screenshare_manager.get_all_sessions, name_a)
        assert dm_room in all_for_alice

        # Alice stops sharing
        ws_a.send_json({"type": "screenshare_stop", "channel_id": dm_room})
        evt_stopped = wait_for_event(ws_b, "screenshare_stopped")
        assert evt_stopped["channel_id"] == dm_room


def test_private_status_and_signals_reject_outsiders():
    alice, _ = _authenticated_client("private_alice")
    _, bob_user = _authenticated_client("private_bob")
    outsider, _ = _authenticated_client("private_outsider")
    room = "dm:private_alice:private_bob"
    origin = {"origin": "http://testserver"}
    with alice.websocket_connect("/ws", headers=origin) as sender, \
         outsider.websocket_connect("/ws", headers=origin) as stranger:
        _receive_event(sender, "history_ready")
        _receive_event(stranger, "history_ready")
        sender.send_json({"type": "screenshare_start", "channel_id": room})
        _receive_event(sender, "screenshare_started")
        assert room not in outsider.get("/api/screenshare/status").json()["sessions"]
        assert outsider.get("/api/screenshare/status", params={"channel_id": room}).status_code == 403
        for kind in ("screenshare_status", "screenshare_join", "screenshare_signal"):
            stranger.send_json({"type": kind, "channel_id": room,
                               "target_user_id": bob_user["id"],
                               "signal": {"type": "offer", "sdp": "untrusted"}})
            assert _receive_event(stranger, "error")["code"] == "screenshare_forbidden"


def test_room_switch_broadcasts_stop_and_occupied_room_is_preserved():
    presenter, presenter_user = _authenticated_client("switch_presenter")
    other, _ = _authenticated_client("switch_other")
    origin = {"origin": "http://testserver"}
    with presenter.websocket_connect("/ws", headers=origin) as sender, \
         other.websocket_connect("/ws", headers=origin) as receiver:
        _receive_event(sender, "history_ready")
        _receive_event(receiver, "history_ready")
        sender.send_json({"type": "screenshare_start", "channel_id": 1})
        _receive_event(receiver, "screenshare_started")
        sender.send_json({"type": "screenshare_start", "channel_id": 2})
        assert _receive_event(receiver, "screenshare_stopped")["channel_id"] == 1
        _receive_event(receiver, "screenshare_started")
        receiver.send_json({"type": "screenshare_start", "channel_id": 2})
        assert _receive_event(receiver, "error")["code"] == "screenshare_busy"
        assert screenshare.screenshare_manager.sessions[2]["user_id"] == presenter_user["id"]


def test_signals_target_individual_tabs_and_reject_unjoined_or_stale_signals():
    presenter, _ = _authenticated_client("tabs_presenter")
    viewer, viewer_user = _authenticated_client("tabs_viewer")
    origin = {"origin": "http://testserver"}
    with presenter.websocket_connect("/ws", headers=origin) as sender, \
         viewer.websocket_connect("/ws", headers=origin) as tab_one, \
         viewer.websocket_connect("/ws", headers=origin) as tab_two:
        _receive_event(sender, "history_ready")
        first_id = _receive_event(tab_one, "history_ready")["client_id"]
        second_id = _receive_event(tab_two, "history_ready")["client_id"]
        sender.send_json({"type": "screenshare_start", "channel_id": 1})
        session = _receive_event(sender, "screenshare_started")
        _receive_event(tab_one, "screenshare_started")
        _receive_event(tab_two, "screenshare_started")
        signal = {"type": "screenshare_signal", "channel_id": 1,
                  "target_user_id": viewer_user["id"], "target_client_id": first_id,
                  "session_id": session["session_id"], "connection_id": "attempt-one",
                  "signal": {"type": "offer", "sdp": "test-offer"}}
        sender.send_json(signal)
        assert _receive_event(sender, "error")["code"] == "screenshare_signal_forbidden"

        for tab in (tab_one, tab_two):
            tab.send_json({"type": "screenshare_join", "channel_id": 1})
            _receive_event(sender, "screenshare_viewer_joined")
        sender.send_json(signal)
        assert _receive_event(tab_one, "screenshare_signal")["connection_id"] == "attempt-one"
        tab_two.send_json({"type": "screenshare_status", "channel_id": 1})
        while True:
            message = tab_two.receive_json()
            assert message["type"] != "screenshare_signal"
            if message["type"] == "screenshare_status":
                break
        tab_one.send_json({"type": "screenshare_leave", "channel_id": 1})
        _receive_event(sender, "screenshare_viewer_left")
        assert screenshare.screenshare_manager.is_viewer(1, viewer_user["id"], second_id)
        assert not screenshare.screenshare_manager.is_viewer(1, viewer_user["id"], first_id)
        sender.send_json({**signal, "target_client_id": second_id, "session_id": "stale-session"})
        assert _receive_event(sender, "error")["code"] == "screenshare_signal_forbidden"



def test_presenter_disconnect_releases_share_and_reconnect_can_restore_it():
    presenter, _ = _authenticated_client("reconnect_presenter")
    viewer, _ = _authenticated_client("reconnect_viewer")
    origin = {"origin": "http://testserver"}
    with viewer.websocket_connect("/ws", headers=origin) as receiver:
        _receive_event(receiver, "history_ready")
        with presenter.websocket_connect("/ws", headers=origin) as sender:
            _receive_event(sender, "history_ready")
            sender.send_json({"type": "screenshare_start", "channel_id": 1})
            first = _receive_event(receiver, "screenshare_started")
        assert _receive_event(receiver, "screenshare_stopped")["session_id"] == first["session_id"]
        with presenter.websocket_connect("/ws", headers=origin) as sender:
            assert not _receive_event(sender, "history_ready")["screenshares"]
            sender.send_json({"type": "screenshare_start", "channel_id": 1})
            second = _receive_event(receiver, "screenshare_started")
            assert second["session_id"] != first["session_id"]
            receiver.send_json({"type": "screenshare_join", "channel_id": 1})
            assert _receive_event(sender, "screenshare_viewer_joined")["session_id"] == second["session_id"]

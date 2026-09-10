"""Unit tests for multi-channel real-time LAN Screen Sharing manager and endpoints."""
from __future__ import annotations

import anyio
import pytest
from app import database, auth
from app.screenshare import ScreenShareManager


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
    # Check REST status (all channels)
    res = client.get("/api/screenshare/status")
    assert res.status_code == 200
    assert "sessions" in res.json()

    # Check REST status (specific channel)
    res_ch = client.get("/api/screenshare/status?channel_id=2")
    assert res_ch.status_code == 200
    assert res_ch.json()["is_active"] is False

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
        def wait_for_event(ws, event_type):
            while True:
                msg = ws.receive_json()
                if msg.get("type") == event_type:
                    return msg

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

        def wait_for_event(ws, event_type):
            while True:
                msg = ws.receive_json()
                if msg.get("type") == event_type:
                    return msg

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


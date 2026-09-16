import asyncio
from pathlib import Path
import pytest
from app import database
from app.omok_manager import OmokManager

@pytest.fixture(autouse=True)
def isolated_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(database, "DB_PATH", tmp_path / "chat.db")
    monkeypatch.setattr(database, "DB_MAX_BYTES", 100 * 1024 * 1024)
    database.init_db()
    yield

class DummyWebSocket:
    def __init__(self):
        self.sent = []

    async def send_text(self, data: str):
        self.sent.append(data)

def test_omok_manager_room_lifecycle():
    mgr = OmokManager()

    async def run_scenario():
        user1 = database.create_user("black_player", "hash")
        user2 = database.create_user("white_player", "hash")

        ws1 = DummyWebSocket()
        mgr.register_client(ws1, user1)

        room = await mgr.create_room(ws1, user1, "오목 한판", 5)
        assert room["id"].startswith("omok-")
        assert room["black"]["id"] == user1["id"]
        assert room["white"] is None

        ws2 = DummyWebSocket()
        mgr.register_client(ws2, user2)

        await mgr.join_room(ws2, user2, room["id"], "w")
        assert room["white"]["id"] == user2["id"]

        # Toggle ready
        await mgr.toggle_ready(user1, room["id"])
        await mgr.toggle_ready(user2, room["id"])

        # Start game
        await mgr.start_game(user1, room["id"])
        assert room["game_started"] is True
        assert room["active_turn"] == "b"

        # Make moves
        await mgr.make_move(user1, room["id"], {"col": 7, "row": 7})
        assert room["active_turn"] == "w"
        assert room["last_move"] == (7, 7)

        # Resign test
        await mgr.resign(user2, room["id"])
        assert room["result"]["type"] == "resign"
        assert room["result"]["winner"] == "b"

        # Verify DB stats
        stats1 = database.get_omok_stats(user1["id"])
        stats2 = database.get_omok_stats(user2["id"])
        assert stats1["wins"] == 1
        assert stats2["losses"] == 1

    asyncio.run(run_scenario())


def test_omok_ready_and_owner_constraints():
    mgr = OmokManager()

    async def run():
        ub = database.create_user("om_owner", "hash")
        uw = database.create_user("om_guest", "hash")
        wsb, wsw = DummyWebSocket(), DummyWebSocket()
        mgr.register_client(wsb, ub)
        mgr.register_client(wsw, uw)

        room = await mgr.create_room(wsb, ub, "ReadyOmok", 10)
        room_id = room["id"]
        await mgr.join_room(wsw, uw, room_id, "w")

        # 1. 0 ready -> cannot start
        await mgr.start_game(ub, room_id)
        assert room["game_started"] is False

        # 2. only black ready -> cannot start
        await mgr.toggle_ready(ub, room_id)
        assert room["black_ready"] is True
        assert room["white_ready"] is False
        await mgr.start_game(ub, room_id)
        assert room["game_started"] is False

        # 3. Ready both
        await mgr.toggle_ready(uw, room_id)
        assert room["black_ready"] is True
        assert room["white_ready"] is True

        # 4. Non-owner cannot start
        await mgr.start_game(uw, room_id)
        assert room["game_started"] is False

        # 5. Owner starts -> success!
        await mgr.start_game(ub, room_id)
        assert room["game_started"] is True

    asyncio.run(run())



def test_omok_manager_33_foul_loss():
    mgr = OmokManager()

    async def run_scenario():
        user_b = database.create_user("player_b", "hash")
        user_w = database.create_user("player_w", "hash")

        ws_b = DummyWebSocket()
        ws_w = DummyWebSocket()
        mgr.register_client(ws_b, user_b)
        mgr.register_client(ws_w, user_w)

        room = await mgr.create_room(ws_b, user_b, "33테스트", 5)
        await mgr.join_room(ws_w, user_w, room["id"], "w")
        await mgr.toggle_ready(user_b, room["id"])
        await mgr.toggle_ready(user_w, room["id"])
        await mgr.start_game(user_b, room["id"])

        # Setup Black 3-3 at (7, 7)
        # Black: (6, 7), (8, 7), (7, 6), (7, 8)
        # White scattered moves: (0, 0), (0, 2), (0, 4), (0, 6)
        moves = [
            (user_b, 6, 7), (user_w, 0, 0),
            (user_b, 8, 7), (user_w, 0, 2),
            (user_b, 7, 6), (user_w, 0, 4),
            (user_b, 7, 8), (user_w, 0, 6),
        ]
        for u, c, r in moves:
            await mgr.make_move(u, room["id"], {"col": c, "row": r})

        # Black plays on forbidden (7, 7) -> Triggers foul_loss!
        await mgr.make_move(user_b, room["id"], {"col": 7, "row": 7})

        assert room["result"] is not None
        assert room["result"]["type"] == "foul_loss"
        assert room["result"]["winner"] == "w"
        assert room["result"]["foul"] == "33"
        assert "금수" in room["result"]["desc"]

        # White wins
        stats_w = database.get_omok_stats(user_w["id"])
        stats_b = database.get_omok_stats(user_b["id"])
        assert stats_w["wins"] == 1
        assert stats_b["losses"] == 1

    asyncio.run(run_scenario())


def test_omok_owner_transfer_on_spectator_and_sit():
    mgr = OmokManager()
    ws1, ws2, ws3 = DummyWebSocket(), DummyWebSocket(), DummyWebSocket()

    async def run():
        u1 = database.create_user("om_p1", "hash")
        u2 = database.create_user("om_p2", "hash")
        u3 = database.create_user("om_p3", "hash")
        mgr.register_client(ws1, u1)
        mgr.register_client(ws2, u2)
        mgr.register_client(ws3, u3)

        room = await mgr.create_room(ws1, u1, "OmTransferTest", 10)
        room_id = room["id"]
        assert room["owner_id"] == u1["id"]

        await mgr.join_room(ws2, u2, room_id, "w")
        await mgr.join_room(ws3, u3, room_id, "spectator")
        assert room["owner_id"] == u1["id"]

        # Case 1: Owner u1 moves to spectator -> transfers to seated white (u2)
        await mgr.pick_role(u1, room_id, "spectator")
        assert room["black"] is None
        assert room["owner_id"] == u2["id"]

        # Case 2: Owner u2 moves to spectator, now no players seated -> owner held (None), NOT u3
        await mgr.pick_role(u2, room_id, "spectator")
        assert room["white"] is None
        assert room["owner_id"] is None

        # Case 3: Spectator u3 sits down as black -> delegated to u3
        await mgr.pick_role(u3, room_id, "b")
        assert room["black"]["id"] == u3["id"]
        assert room["owner_id"] == u3["id"]

    asyncio.run(run())


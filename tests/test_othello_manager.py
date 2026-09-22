import asyncio
from pathlib import Path
import pytest
from app import database
from app.othello_manager import OthelloManager

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

def test_othello_manager_room_lifecycle():
    mgr = OthelloManager()

    async def run_scenario():
        user1 = database.create_user("black_player", "hash")
        user2 = database.create_user("white_player", "hash")

        ws1 = DummyWebSocket()
        mgr.register_client(ws1, user1)

        room = await mgr.create_room(ws1, user1, "오셀로 한판", 5)
        assert room["id"].startswith("othello-")
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

        # Initial discs: 2 black, 2 white
        counts = room["board"].get_counts()
        assert counts["black"] == 2
        assert counts["white"] == 2

        # Black plays (col 2, row 3 -> c4)
        # Flipping d4 (3, 3) from White to Black
        await mgr.make_move(user1, room["id"], {"col": 2, "row": 3})
        assert room["active_turn"] == "w"
        assert room["last_move"] == (2, 3)

        counts2 = room["board"].get_counts()
        assert counts2["black"] == 4
        assert counts2["white"] == 1

        # Resign test
        await mgr.resign(user2, room["id"])
        assert room["result"]["type"] == "resign"
        assert room["result"]["winner"] == "b"

        # Verify DB stats
        stats1 = database.get_othello_stats(user1["id"])
        stats2 = database.get_othello_stats(user2["id"])
        assert stats1["wins"] == 1
        assert stats2["losses"] == 1

    asyncio.run(run_scenario())


def test_othello_ready_and_owner_constraints():
    mgr = OthelloManager()

    async def run():
        ub = database.create_user("oth_owner", "hash")
        uw = database.create_user("oth_guest", "hash")
        wsb, wsw = DummyWebSocket(), DummyWebSocket()
        mgr.register_client(wsb, ub)
        mgr.register_client(wsw, uw)

        room = await mgr.create_room(wsb, ub, "ReadyOthello", 10)
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


def test_othello_owner_transfer_and_role_change():
    mgr = OthelloManager()
    ws1, ws2, ws3 = DummyWebSocket(), DummyWebSocket(), DummyWebSocket()

    async def run():
        u1 = database.create_user("oth_p1", "hash")
        u2 = database.create_user("oth_p2", "hash")
        u3 = database.create_user("oth_p3", "hash")
        mgr.register_client(ws1, u1)
        mgr.register_client(ws2, u2)
        mgr.register_client(ws3, u3)

        room = await mgr.create_room(ws1, u1, "OthTransferTest", 10)
        room_id = room["id"]
        assert room["owner_id"] == u1["id"]

        await mgr.join_room(ws2, u2, room_id, "w")
        await mgr.join_room(ws3, u3, room_id, "spectator")
        assert room["owner_id"] == u1["id"]

        # Owner u1 moves to spectator -> transfers to seated white (u2)
        await mgr.pick_role(u1, room_id, "spectator")
        assert room["black"] is None
        assert room["owner_id"] == u2["id"]

        # Owner u2 moves to spectator -> owner held (None)
        await mgr.pick_role(u2, room_id, "spectator")
        assert room["white"] is None
        assert room["owner_id"] is None

        # Spectator u3 sits down as black -> owner delegated to u3
        await mgr.pick_role(u3, room_id, "b")
        assert room["black"]["id"] == u3["id"]
        assert room["owner_id"] == u3["id"]

    asyncio.run(run())

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


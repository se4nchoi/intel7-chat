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

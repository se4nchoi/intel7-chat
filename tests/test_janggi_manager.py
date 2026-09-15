import asyncio
from pathlib import Path
import pytest
from app import database
from app.janggi_manager import JanggiManager

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

def test_janggi_manager_room_lifecycle():
    mgr = JanggiManager()

    async def run_scenario():
        user1 = database.create_user("cho_player", "hash")
        user2 = database.create_user("han_player", "hash")

        ws1 = DummyWebSocket()
        mgr.register_client(ws1, user1)

        room = await mgr.create_room(ws1, user1, "즐거운 장기", 10)
        assert room["id"].startswith("janggi-")
        assert room["cho"]["id"] == user1["id"]
        assert room["han"] is None

        ws2 = DummyWebSocket()
        mgr.register_client(ws2, user2)

        await mgr.join_room(ws2, user2, room["id"], "han")
        assert room["han"]["id"] == user2["id"]

        # Set formation
        await mgr.set_formation(user1, room["id"], "yangwima")
        assert room["cho_formation"] == "yangwima"

        # Start game
        await mgr.start_game(user1, room["id"])
        assert room["game_started"] is True
        assert room["board"] is not None
        assert room["active_turn"] == "cho"

        # Resign test
        await mgr.resign(user2, room["id"])
        assert room["result"]["type"] == "resign"
        assert room["result"]["winner"] == "cho"

        # Verify DB stats
        stats1 = database.get_janggi_stats(user1["id"])
        stats2 = database.get_janggi_stats(user2["id"])
        assert stats1["wins"] == 1
        assert stats2["losses"] == 1

    asyncio.run(run_scenario())

"""Unit tests for Othello rankings, stats, badges, and API route."""
from __future__ import annotations

import time
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from app import database, main
from app.auth import token_hash


@pytest.fixture
def temp_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(database, "DB_PATH", tmp_path / "chat.db")
    monkeypatch.setattr(database, "DB_MAX_BYTES", 100 * 1024 * 1024)
    database.init_db()
    yield tmp_path


def test_othello_rankings_and_tie_breaking(temp_db):
    u1 = database.create_user("oth_player1", "hash")
    u2 = database.create_user("oth_player2", "hash")
    u3 = database.create_user("oth_player3", "hash")
    u4 = database.create_user("oth_player4", "hash")

    # u1 wins against u4 (1 win)
    database.record_othello_result(u1["id"], u4["id"], "b")
    time.sleep(0.01)

    # u2 wins against u4 (1 win)
    database.record_othello_result(u2["id"], u4["id"], "b")
    time.sleep(0.01)

    # u1 wins again against u4 (2 wins) - reached 2 wins first!
    database.record_othello_result(u1["id"], u4["id"], "b")
    time.sleep(0.02)

    # u2 wins against u4 (2 wins) - reached 2 wins later!
    database.record_othello_result(u2["id"], u4["id"], "b")
    time.sleep(0.01)

    # u3 wins against u4 (1 win)
    database.record_othello_result(u3["id"], u4["id"], "b")

    rankings = database.get_othello_rankings(limit=10)
    assert len(rankings) == 3

    # Rank 1: u1 (2 wins, first)
    assert rankings[0]["user_id"] == u1["id"]
    assert rankings[0]["rank"] == 1
    assert rankings[0]["wins"] == 2

    # Rank 2: u2 (2 wins, second)
    assert rankings[1]["user_id"] == u2["id"]
    assert rankings[1]["rank"] == 2
    assert rankings[1]["wins"] == 2

    # Rank 3: u3 (1 win)
    assert rankings[2]["user_id"] == u3["id"]
    assert rankings[2]["rank"] == 3
    assert rankings[2]["wins"] == 1


def test_othello_leaderboard_and_badges(temp_db):
    u1 = database.create_user("oth_champ", "hash")
    u2 = database.create_user("oth_runner", "hash")

    database.record_othello_result(u1["id"], u2["id"], "b")
    board = database.get_othello_leaderboard(limit=10)
    assert len(board) == 1
    first = board[0]
    assert first["user_id"] == u1["id"]
    assert first["rank"] == 1
    assert first["wins"] == 1
    assert first["win_rate"] == 100.0
    assert first["badge"] is not None
    assert first["badge"]["label"] == "오셀로의 신"
    assert first["badge"]["icon"] == "👑"


def test_othello_rankings_api(temp_db):
    u1 = database.create_user("api_oth_user", "hash")
    raw_token = "test-token-oth"
    database.create_session(token_hash(raw_token), u1["id"], "2999-01-01T00:00:00Z")

    client = TestClient(main.app)
    client.cookies.set(main.SESSION_COOKIE, raw_token)

    response = client.get("/api/othello/rankings")
    assert response.status_code == 200
    data = response.json()
    assert "leaderboard" in data
    assert "rankings" in data
    assert isinstance(data["leaderboard"], list)

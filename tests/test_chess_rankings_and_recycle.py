"""Unit tests for chess rankings, tie-break by time, titles, and daily quiz set recycling."""
from __future__ import annotations

import time
from pathlib import Path
import pytest
from app import database


@pytest.fixture
def temp_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(database, "DB_PATH", tmp_path / "chat.db")
    monkeypatch.setattr(database, "DB_MAX_BYTES", 100 * 1024 * 1024)
    database.init_db()
    yield tmp_path


def test_chess_rankings_and_tie_breaking(temp_db):
    u1 = database.create_user("player1", "hash")
    u2 = database.create_user("player2", "hash")
    u3 = database.create_user("player3", "hash")
    u4 = database.create_user("player4", "hash")

    # u1 wins against u4 (1 win)
    database.record_chess_result(u1["id"], u4["id"], "w")
    time.sleep(0.01)

    # u2 wins against u4 (1 win)
    database.record_chess_result(u2["id"], u4["id"], "w")
    time.sleep(0.01)

    # u1 wins again against u4 (2 wins) - reached 2 wins first!
    database.record_chess_result(u1["id"], u4["id"], "w")
    time.sleep(0.02)

    # u2 wins against u4 (2 wins) - reached 2 wins later!
    database.record_chess_result(u2["id"], u4["id"], "w")
    time.sleep(0.01)

    # u3 wins against u4 (1 win)
    database.record_chess_result(u3["id"], u4["id"], "w")

    rankings = database.get_chess_rankings(limit=10)
    assert len(rankings) == 3

    # Rank 1 must be u1 (2 wins, achieved first)
    assert rankings[0]["user_id"] == u1["id"]
    assert rankings[0]["rank"] == 1
    assert rankings[0]["wins"] == 2

    # Rank 2 must be u2 (2 wins, achieved second)
    assert rankings[1]["user_id"] == u2["id"]
    assert rankings[1]["rank"] == 2
    assert rankings[1]["wins"] == 2

    # Rank 3 must be u3 (1 win)
    assert rankings[2]["user_id"] == u3["id"]
    assert rankings[2]["rank"] == 3
    assert rankings[2]["wins"] == 1

    # Check title options for Rank 1 (체스의 신)
    u1_titles = database.get_user_quiz_title_options(u1["id"])
    chess_title_1 = next((t for t in u1_titles if t["selection"] == "chess"), None)
    assert chess_title_1 is not None
    assert chess_title_1["label"] == "체스의 신"
    assert chess_title_1["icon"] == "👑"
    assert chess_title_1["rank"] == 1

    # Check title options for Rank 2 (체스킹)
    u2_titles = database.get_user_quiz_title_options(u2["id"])
    chess_title_2 = next((t for t in u2_titles if t["selection"] == "chess"), None)
    assert chess_title_2 is not None
    assert chess_title_2["label"] == "체스킹"
    assert chess_title_2["icon"] == "♟️"
    assert chess_title_2["rank"] == 2

    # Check title options for Rank 3 (체스고인물)
    u3_titles = database.get_user_quiz_title_options(u3["id"])
    chess_title_3 = next((t for t in u3_titles if t["selection"] == "chess"), None)
    assert chess_title_3 is not None
    assert chess_title_3["label"] == "체스고인물"
    assert chess_title_3["icon"] == "♟️"
    assert chess_title_3["rank"] == 3

    # Badge map check when selection is 'chess'
    database.update_quiz_badge_selection(u1["id"], "chess")
    badges = database.get_user_quiz_badges_map([u1["id"], u2["id"]])
    assert badges[u1["id"]]["label"] == "체스의 신"
    assert badges[u1["id"]]["icon"] == "👑"

    # Test dedicated get_chess_leaderboard
    leaderboard = database.get_chess_leaderboard(limit=10)
    assert len(leaderboard) == 3
    assert leaderboard[0]["badge"]["label"] == "체스의 신"
    assert leaderboard[0]["wins"] == 2

    # Test reset_chess_records
    database.reset_chess_records()
    assert len(database.get_chess_rankings()) == 0
    assert len(database.get_chess_leaderboard()) == 0
    u1_fresh = database.get_user_by_id(u1["id"])
    assert u1_fresh["quiz_badge_selection"] == "score"


def test_record_chess_result_black_wins_and_white_wins(temp_db):
    white_player = database.create_user("white_user", "hash")
    black_player = database.create_user("black_user", "hash")

    # Black wins (e.g. White resigned or Black checkmated)
    database.record_chess_result(white_player["id"], black_player["id"], "b")

    rankings = database.get_chess_rankings()
    assert len(rankings) == 1
    assert rankings[0]["user_id"] == black_player["id"]
    assert rankings[0]["wins"] == 1
    assert rankings[0]["losses"] == 0

    with database.get_connection() as conn:
        white_stats = conn.execute("SELECT wins, losses FROM chess_player_stats WHERE user_id = ?", (white_player["id"],)).fetchone()
        black_stats = conn.execute("SELECT wins, losses FROM chess_player_stats WHERE user_id = ?", (black_player["id"],)).fetchone()
        assert white_stats["wins"] == 0
        assert white_stats["losses"] == 1
        assert black_stats["wins"] == 1
        assert black_stats["losses"] == 0

    # White wins next game
    database.record_chess_result(white_player["id"], black_player["id"], "w")
    with database.get_connection() as conn:
        white_stats = conn.execute("SELECT wins, losses FROM chess_player_stats WHERE user_id = ?", (white_player["id"],)).fetchone()
        black_stats = conn.execute("SELECT wins, losses FROM chess_player_stats WHERE user_id = ?", (black_player["id"],)).fetchone()
        assert white_stats["wins"] == 1
        assert white_stats["losses"] == 1
        assert black_stats["wins"] == 1
        assert black_stats["losses"] == 1


def test_ensure_daily_quiz_set_recycling(temp_db):
    # Only 3 sample quizzes created
    database.create_quiz_batch([
        {"category": "PLC", "difficulty": "easy", "question_type": "multiple_choice",
         "question": f"Q{i}", "options": ["A", "B", "C", "D"], "correct_answers": ["1"],
         "hint": "", "explanation": "", "source_ref": ""}
        for i in range(1, 4)
    ])

    # Day 1: requests 2 quizzes -> should use Q1, Q2
    set1_id = database.ensure_daily_quiz_set("2026-09-01", count=2)
    assert set1_id > 0

    # Day 2: requests 2 quizzes -> Q3 is unused, plus 1 recycled quiz (Q1) -> total 2 quizzes!
    set2_id = database.ensure_daily_quiz_set("2026-09-02", count=2)
    assert set2_id > 0

    # Day 3: requests 2 quizzes -> all quizzes have been used, recycling works!
    set3_id = database.ensure_daily_quiz_set("2026-09-03", count=2)
    assert set3_id > 0

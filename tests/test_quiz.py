"""Tests for educational quizzes, ladder logic evaluation, streaks, and leaderboard."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path
import pytest
from app import auth, database, quiz_ai


@pytest.fixture
def temp_db(tmp_path: Path):
    db_file = tmp_path / "test_chat.db"
    database.configure_storage(tmp_path, 100 * 1024 * 1024)
    database.init_db()
    return tmp_path


def test_quiz_normalization():
    assert quiz_ai.normalize_quiz_answer("  x0  ") == "X0"
    assert quiz_ai.normalize_quiz_answer("정답: 1번") == "1"
    assert quiz_ai.normalize_quiz_answer("ans: LD X0") == "LD X0"
    assert quiz_ai.normalize_quiz_answer("LD   X00") == "LD X00"

    # PLC device matching
    assert quiz_ai.check_quiz_answer(["X0", "X00", "LD X0"], "x0") is True
    assert quiz_ai.check_quiz_answer(["X0"], "X000") is True
    assert quiz_ai.check_quiz_answer(["1. AND", "AND"], "1") is True
    assert quiz_ai.check_quiz_answer(["1. AND", "AND"], "AND") is True
    assert quiz_ai.check_quiz_answer(["인터록", "인터록 회로"], "인터록") is True
    assert quiz_ai.check_quiz_answer(["인터록", "인터록 회로"], "틀린답") is False


def test_quiz_seeding_and_retrieval(temp_db):
    u1 = database.create_user("student1", auth.hash_secret("pass123"))
    quizzes = database.get_daily_quizzes(u1["id"], count=10)
    assert len(quizzes) >= 7

    q1 = quizzes[0]
    assert q1["is_solved"] is False
    assert "correct_answers" not in q1  # Hidden before solving to prevent cheating
    assert "explanation" not in q1


def test_quiz_submission_and_streak(temp_db):
    u1 = database.create_user("student1", auth.hash_secret("pass123"))
    quizzes = database.get_daily_quizzes(u1["id"], count=5)
    q1 = quizzes[0]

    # Submit correct answer for PLC ladder question
    result = database.submit_quiz_answer(u1["id"], q1["id"], "Y0")
    assert result["is_correct"] is True
    assert result["score_earned"] > 0
    assert "correct_answers" in result
    assert "explanation" in result
    assert result["user_stats"]["current_streak"] == 1
    assert result["user_stats"]["total_score"] == result["score_earned"]

    # Re-submission should raise ValueError
    with pytest.raises(ValueError, match="이미 제출 완료된"):
        database.submit_quiz_answer(u1["id"], q1["id"], "Y0")

    # get_daily_quizzes should now reflect solved status and show answers
    updated_quizzes = database.get_daily_quizzes(u1["id"], count=5)
    solved_q = next(q for q in updated_quizzes if q["id"] == q1["id"])
    assert solved_q["is_solved"] is True
    assert solved_q["is_correct"] is True
    assert solved_q["user_answer"] == "Y0"
    assert "correct_answers" in solved_q


def test_quiz_leaderboard_and_badges(temp_db):
    u1 = database.create_user("student1", auth.hash_secret("pass123"))
    u2 = database.create_user("student2", auth.hash_secret("pass123"))

    quizzes = database.get_daily_quizzes(u1["id"], count=5)
    q1 = quizzes[0]
    q2 = quizzes[1]

    # Student 1 gets q1 correct
    database.submit_quiz_answer(u1["id"], q1["id"], "Y0")
    # Student 2 gets q1 wrong
    database.submit_quiz_answer(u2["id"], q1["id"], "X99")
    # Student 1 gets q2 correct
    database.submit_quiz_answer(u1["id"], q2["id"], "1")

    # Daily leaderboard
    daily_lb = database.get_quiz_leaderboard(period="daily")
    assert len(daily_lb) == 2
    assert daily_lb[0]["user_id"] == u1["id"]
    assert daily_lb[0]["rank"] == 1
    assert daily_lb[0]["score"] > daily_lb[1]["score"]

    # Weekly leaderboard
    weekly_lb = database.get_quiz_leaderboard(period="weekly")
    assert len(weekly_lb) >= 1
    assert weekly_lb[0]["user_id"] == u1["id"]

    # Badge for u1 should be 1st rank
    badge1 = database.get_user_quiz_badge(u1["id"])
    assert badge1 is not None
    assert badge1["type"] == "rank"

    # User stats
    stats1 = database.get_user_quiz_stats(u1["id"])
    assert stats1["total_solved"] == 2
    assert stats1["total_correct"] == 2
    assert stats1["accuracy"] == 100.0


def test_batch_creation_and_admin_view(temp_db):
    u_admin = database.create_user("admin", auth.hash_secret("admin123"), role="admin")

    # Save source doc
    doc_id = database.save_quiz_source_document(
        filename="lecture_05.pdf",
        stored_filename="stored_lec05.pdf",
        file_type="pdf",
        sha256="fakehash123",
        size=1024,
        uploaded_by_user_id=u_admin["id"],
    )
    assert doc_id > 0

    batch = [
        {
            "category": "CBT",
            "difficulty": "easy",
            "question_type": "multiple_choice",
            "question": "테스트 문제 1번",
            "options": ["1. 보기A", "2. 보기B"],
            "correct_answers": ["1", "보기A"],
            "explanation": "테스트 해설",
            "source_ref": "5강 p.10"
        }
    ]

    ids = database.create_quiz_batch(batch, source_doc_id=doc_id)
    assert len(ids) == 1

    docs = database.get_quiz_source_documents()
    assert len(docs) == 1
    assert docs[0]["generated_quizzes_count"] == 1

    admin_quizzes = database.get_all_quizzes_admin()
    assert any(q["id"] == ids[0] for q in admin_quizzes)


def test_quiz_bookmarks_and_hints(temp_db):
    u1 = database.create_user("student_bm", auth.hash_secret("pass123"))
    quizzes = database.get_daily_quizzes(u1["id"], count=5)
    q1 = quizzes[0]

    # Hints check
    assert "hint" in q1
    assert len(q1["hint"]) > 0

    # Initial bookmark state is False
    assert q1["is_starred"] is False

    # Toggle bookmark ON
    is_starred = database.toggle_quiz_bookmark(u1["id"], q1["id"])
    assert is_starred is True
    assert q1["id"] in database.get_user_quiz_bookmarks_set(u1["id"])

    # Starred review list should contain q1
    starred_list = database.get_quiz_review_list(u1["id"], mode="starred")
    assert len(starred_list) == 1
    assert starred_list[0]["id"] == q1["id"]

    # Toggle bookmark OFF
    is_starred = database.toggle_quiz_bookmark(u1["id"], q1["id"])
    assert is_starred is False
    assert len(database.get_quiz_review_list(u1["id"], mode="starred")) == 0


def test_quiz_review_and_retry(temp_db):
    u1 = database.create_user("student_retry", auth.hash_secret("pass123"))
    quizzes = database.get_daily_quizzes(u1["id"], count=5)
    q1 = quizzes[0]
    q2 = quizzes[1]

    # Student submits q1 wrong, q2 correct
    database.submit_quiz_answer(u1["id"], q1["id"], "wrong_answer_xyz")
    database.submit_quiz_answer(u1["id"], q2["id"], "1")

    # Wrong list should have q1
    wrong_list = database.get_quiz_review_list(u1["id"], mode="wrong")
    assert len(wrong_list) == 1
    assert wrong_list[0]["id"] == q1["id"]
    assert wrong_list[0]["is_correct"] is False

    # History list should have both
    hist_list = database.get_quiz_review_list(u1["id"], mode="history")
    assert len(hist_list) == 2

    # Practice retry for q1
    retry_res = database.retry_quiz_answer(u1["id"], q1["id"], "Y0")
    assert retry_res["is_correct"] is True

    # Now q1 remains in wrong review list with is_correct = True (retained as mastered)
    wrong_after = database.get_quiz_review_list(u1["id"], mode="wrong")
    assert len(wrong_after) == 1
    assert wrong_after[0]["id"] == q1["id"]
    assert wrong_after[0]["is_correct"] is True



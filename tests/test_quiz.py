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


def test_all_first_attempts_score_but_only_daily_quizzes_extend_streak(temp_db):
    user = database.create_user("daily_only", "hash")
    daily = database.get_daily_quizzes(user["id"], count=1)[0]
    extra_id = database.create_quiz_batch([{
        "category": "PLC", "difficulty": "hard", "question_type": "short_answer",
        "question": "연습 문제", "correct_answers": ["CORRECT"], "options": None,
        "hint": "", "explanation": "", "source_ref": "",
    }])[0]

    practice = database.submit_quiz_answer(user["id"], extra_id, "CORRECT")
    assert practice["score_earned"] == 30
    assert practice["user_stats"]["current_streak"] == 0
    assert database.get_quiz_leaderboard("daily")[0]["score"] == 30

    retry = database.retry_quiz_answer(user["id"], extra_id, "CORRECT")
    assert retry["score_earned"] == 0

    answer = daily.get("correct_answers", ["Y0"])[0]
    scored = database.submit_quiz_answer(user["id"], daily["id"], answer)
    assert scored["score_earned"] in {0, 20}
    assert scored["user_stats"]["current_streak"] == 1
    assert database.get_quiz_leaderboard("daily")[0]["user_id"] == user["id"]


def test_random_prefers_unsolved_and_subjects_page_in_fives(temp_db):
    user = database.create_user("explorer", "hash")
    first = database.get_daily_quizzes(user["id"], count=5, category="random")
    assert len(first) == 5
    solved_id = first[0]["id"]
    database.submit_quiz_answer(user["id"], solved_id, "definitely-wrong")
    second = database.get_daily_quizzes(user["id"], count=5, category="random", exclude_ids=[item["id"] for item in first])
    assert len(second) == 5
    assert solved_id not in {item["id"] for item in second}

    plc_first = database.get_daily_quizzes(user["id"], count=5, category="PLC", offset=0)
    plc_next = database.get_daily_quizzes(user["id"], count=5, category="PLC", offset=5)
    assert plc_first and plc_next
    assert {item["id"] for item in plc_first}.isdisjoint({item["id"] for item in plc_next})


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

    assert database.get_user_quiz_badge(u1["id"]) is None

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

    # Until the user explicitly chooses a title, the nickname badge shows score.
    badge1 = database.get_user_quiz_badge(u1["id"])
    assert badge1 is not None
    assert badge1["type"] == "score"

    with database.get_connection() as conn:
        conn.execute("UPDATE user_quiz_stats SET current_streak=3 WHERE user_id=?", (u1["id"],))
        conn.commit()
    assert "streak" in {item["selection"] for item in database.get_user_quiz_title_options(u1["id"])}
    database.update_quiz_badge_selection(u1["id"], "streak")
    assert database.get_user_quiz_badge(u1["id"])["type"] == "streak"

    # User stats
    stats1 = database.get_user_quiz_stats(u1["id"])
    assert stats1["total_solved"] == 2
    assert stats1["total_correct"] == 2
    assert stats1["accuracy"] == 100.0


def test_quiz_leaderboard_equal_scores_rank_earliest_first(temp_db):
    later_user = database.create_user("later-user", auth.hash_secret("pass123"))
    earlier_user = database.create_user("earlier-user", auth.hash_secret("pass123"))
    quiz = database.get_daily_quizzes(later_user["id"], count=1)[0]

    correct_answer = quiz["correct_answers"][0] if quiz.get("correct_answers") else "Y0"
    database.submit_quiz_answer(later_user["id"], quiz["id"], correct_answer)
    database.submit_quiz_answer(earlier_user["id"], quiz["id"], correct_answer)
    with database.get_connection() as conn:
        conn.execute("UPDATE quiz_submissions SET submitted_at=? WHERE user_id=?",
                     ("2026-09-01T10:00:00Z", later_user["id"]))
        conn.execute("UPDATE quiz_submissions SET submitted_at=? WHERE user_id=?",
                     ("2026-09-01T09:00:00Z", earlier_user["id"]))
        conn.commit()

    for period in ("daily", "weekly", "all"):
        leaderboard = database.get_quiz_leaderboard(period=period)
        assert leaderboard[0]["user_id"] == earlier_user["id"]
        assert leaderboard[0]["score"] == leaderboard[1]["score"]
    assert database.get_user_quiz_badge(earlier_user["id"])["type"] == "score"
    assert database.get_user_quiz_title_options(earlier_user["id"])[0]["rank"] == 1
    assert database.get_user_quiz_title_options(later_user["id"])[0]["rank"] == 2


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



"""API tests for educational quiz, leaderboard, and admin endpoints."""
from __future__ import annotations

import json
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from app import database, main
from app.auth import token_hash
from app.config import GIB

ORIGIN = {"origin": "http://testserver"}


@pytest.fixture(autouse=True)
def isolated_state(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", tmp_path / "chat.db")
    monkeypatch.setattr(database, "DB_MAX_BYTES", 3 * GIB)
    monkeypatch.setattr(main, "UPLOAD_DIR", tmp_path / "uploads")
    monkeypatch.setattr(main, "QUIZ_SOURCES_DIR", tmp_path / "quiz_sources")
    monkeypatch.setattr(main, "QUIZ_IMAGES_DIR", tmp_path / "quiz_images")
    monkeypatch.setenv("BAMBOOCHAT_CONFIG", str(tmp_path / "bamboochat.json"))
    monkeypatch.setattr(main.CONFIG, "registration_enabled", True)
    monkeypatch.setattr(main.CONFIG, "enrollment_code_hash", "")
    main.connected_clients.clear()
    main.user_registry.clear()
    main.message_timestamps.clear()
    main.upload_timestamps.clear()
    main.login_timestamps.clear()
    main.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    main.QUIZ_SOURCES_DIR.mkdir(parents=True, exist_ok=True)
    main.QUIZ_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    database.init_db()
    yield


def session_client(username: str = "student", role: str = "student"):
    user = database.create_user(username, "hash-not-used-in-session-tests", role=role)
    raw = f"session-token-for-user-{user['id']}"
    expires = "2999-01-01T00:00:00Z"
    database.create_session(token_hash(raw), user["id"], expires)
    client = TestClient(main.app)
    client.cookies.set(main.SESSION_COOKIE, raw)
    return client, user


def test_quiz_today_unauthenticated():
    client = TestClient(main.app)
    resp = client.get("/api/quiz/today")
    assert resp.status_code == 401


def test_quiz_today_and_submit_flow():
    client, user = session_client("alice", role="student")

    # 1. Get today's quizzes
    resp = client.get("/api/quiz/today")
    assert resp.status_code == 200
    data = resp.json()
    assert "quizzes" in data
    assert "stats" in data
    quizzes = data["quizzes"]
    assert len(quizzes) > 0

    first_q = quizzes[0]
    assert first_q["is_solved"] is False

    # 2. Submit answer
    submit_resp = client.post(
        "/api/quiz/submit",
        json={"quiz_id": first_q["id"], "answer": "Y0"},
        headers=ORIGIN,
    )
    assert submit_resp.status_code == 200
    sub_data = submit_resp.json()
    assert sub_data["quiz_id"] == first_q["id"]
    assert sub_data["is_correct"] is True
    assert sub_data["score_earned"] > 0
    assert sub_data["user_stats"]["current_streak"] == 1

    # 3. Duplicate submit should fail with 400
    dup_resp = client.post(
        "/api/quiz/submit",
        json={"quiz_id": first_q["id"], "answer": "Y0"},
        headers=ORIGIN,
    )
    assert dup_resp.status_code == 400

    # 4. Check leaderboard
    lb_resp = client.get("/api/quiz/leaderboard?period=daily")
    assert lb_resp.status_code == 200
    lb_data = lb_resp.json()
    assert len(lb_data["leaderboard"]) >= 1
    assert lb_data["leaderboard"][0]["user_id"] == user["id"]

    # 5. Check stats
    stats_resp = client.get("/api/quiz/stats")
    assert stats_resp.status_code == 200
    st_data = stats_resp.json()
    assert st_data["total_solved"] == 1
    assert st_data["total_correct"] == 1


def test_admin_quiz_import_and_management():
    student_client, student_user = session_client("bob", role="student")
    admin_client, admin_user = session_client("admin_user", role="admin")

    new_quiz_json = [
        {
            "category": "PLC/시퀀스",
            "difficulty": "easy",
            "question_type": "short_answer",
            "question": "PLC에서 내부 보조 릴레이로 사용하는 대표적인 디바이스 기호는?",
            "options": None,
            "correct_answers": ["M", "M0", "M릴레이"],
            "explanation": "내부 보조 릴레이는 M 디바이스를 사용합니다.",
            "source_ref": "교재 2강 p.5"
        }
    ]

    # Student forbidden to import
    resp_forbidden = student_client.post(
        "/api/admin/quiz/import-json",
        json={"quizzes": new_quiz_json},
        headers=ORIGIN,
    )
    assert resp_forbidden.status_code == 403

    # Admin successfully imports
    resp_ok = admin_client.post(
        "/api/admin/quiz/import-json",
        json={"quizzes": new_quiz_json},
        headers=ORIGIN,
    )
    assert resp_ok.status_code == 200
    assert resp_ok.json()["created_count"] == 1
    created_id = resp_ok.json()["ids"][0]

    # Admin lists quizzes
    list_resp = admin_client.get("/api/admin/quiz/list")
    assert list_resp.status_code == 200
    items = list_resp.json()["quizzes"]
    assert any(q["id"] == created_id for q in items)

    # Admin deletes quiz
    del_resp = admin_client.delete(f"/api/admin/quiz/{created_id}", headers=ORIGIN)
    assert del_resp.status_code == 200

    # Verify deletion
    list_after = admin_client.get("/api/admin/quiz/list").json()["quizzes"]
    assert not any(q["id"] == created_id for q in list_after)

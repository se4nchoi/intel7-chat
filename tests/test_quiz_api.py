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


def test_community_quiz_review_and_daily_publish_flow():
    student, _ = session_client("author", role="student")
    admin, _ = session_client("reviewer", role="admin")
    payload = {
        "title": "PLC 인터록 문제집",
        "expertise": "PLC",
        "quizzes": [{
            "difficulty": "medium", "question_type": "multiple_choice",
            "question": "인터록의 목적은?\n```\nX0 --| |--(Y0)\n```",
            "options": ["1. 동시 투입 방지", "2. 승압", "3. 접지 제거", "4. 과속"],
            "correct_answers": ["1", "1. 동시 투입 방지"],
            "hint": "상반 동작", "explanation": "동시 투입을 막습니다.", "source_ref": "노트 1장",
        }],
    }
    created = student.post("/api/quiz/my-sets", json=payload, headers=ORIGIN)
    assert created.status_code == 201
    set_id = created.json()["id"]
    assert student.get("/api/admin/quiz/submissions").status_code == 403
    assert student.post(f"/api/quiz/my-sets/{set_id}/submit", headers=ORIGIN).status_code == 200

    pending = admin.get("/api/admin/quiz/submissions").json()["sets"]
    assert [item["id"] for item in pending] == [set_id]
    reviewed = admin.post(
        f"/api/admin/quiz/submissions/{set_id}/review",
        json={"approve": True, "note": "검토 완료"}, headers=ORIGIN,
    )
    assert reviewed.status_code == 200
    quiz_ids = reviewed.json()["created_ids"]
    assert len(quiz_ids) == 1

    published = admin.post(
        "/api/admin/quiz/daily-sets",
        json={"assigned_date": "2099-01-01", "quiz_ids": quiz_ids}, headers=ORIGIN,
    )
    assert published.status_code == 200
    duplicate = admin.post(
        "/api/admin/quiz/daily-sets",
        json={"assigned_date": "2099-01-01", "quiz_ids": quiz_ids}, headers=ORIGIN,
    )
    assert duplicate.status_code == 400


def test_admin_approval_uses_current_editor_payload_and_tracks_source():
    student, _ = session_client("atomic_author", role="student")
    admin, _ = session_client("atomic_reviewer", role="admin")
    payload = {
        "title": "검토 전 문제집", "expertise": "PLC", "quizzes": [{
            "difficulty": "easy", "question_type": "short_answer",
            "question": "수정 전 질문", "options": None, "correct_answers": ["전"],
            "hint": "", "explanation": "", "source_ref": "",
        }],
    }
    created = student.post("/api/quiz/my-sets", json=payload, headers=ORIGIN)
    set_id = created.json()["id"]
    student.post(f"/api/quiz/my-sets/{set_id}/submit", headers=ORIGIN)

    edited_quizzes = [{**payload["quizzes"][0], "question": "관리자가 수정한 질문", "correct_answers": ["후"]}]
    reviewed = admin.post(
        f"/api/admin/quiz/submissions/{set_id}/review", headers=ORIGIN,
        json={"approve": True, "note": "수정 후 승인", "title": payload["title"],
              "expertise": payload["expertise"], "quizzes": edited_quizzes},
    )
    assert reviewed.status_code == 200
    quiz_id = reviewed.json()["created_ids"][0]
    with database.get_connection() as conn:
        row = conn.execute(
            "SELECT question, source_submission_set_id FROM quizzes WHERE id=?", (quiz_id,)
        ).fetchone()
    assert row["question"] == "관리자가 수정한 질문"
    assert row["source_submission_set_id"] == set_id


@pytest.mark.parametrize("options,answers", [
    (["A", "A", "C", "D"], ["1"]),
    (["A", "", "C", "D"], ["1"]),
    (["A", "B", "C", "D"], ["outside option"]),
])
def test_community_multiple_choice_validation(options, answers):
    student, _ = session_client(f"invalid_mc_{abs(hash(str(options) + str(answers)))}", role="student")
    response = student.post("/api/quiz/my-sets", headers=ORIGIN, json={
        "title": "검증할 문제집", "expertise": "PLC", "quizzes": [{
            "difficulty": "easy", "question_type": "multiple_choice", "question": "검증 질문",
            "options": options, "correct_answers": answers, "hint": "", "explanation": "", "source_ref": "",
        }],
    })
    assert response.status_code == 400


def test_community_quiz_import_rejects_uncontrolled_fields():
    student, _ = session_client("invalid_author", role="student")
    bad = student.post("/api/quiz/my-sets", json={
        "title": "잘못된 문제집", "expertise": "임의 분야",
        "quizzes": [{"question": "문제", "correct_answers": ["답"], "image_filename": "remote.png"}],
    }, headers=ORIGIN)
    assert bad.status_code == 400


def test_owner_can_correct_draft_expertise_but_not_approved_set():
    student, _ = session_client("editor", role="student")
    payload = {"title": "잘못 분류된 문제집", "expertise": "PLC", "quizzes": [{
        "difficulty": "easy", "question_type": "short_answer", "question": "2진수 10은?",
        "options": None, "correct_answers": ["2"], "hint": "", "explanation": "", "source_ref": "",
    }]}
    created = student.post("/api/quiz/my-sets", json=payload, headers=ORIGIN)
    set_id = created.json()["id"]
    edited = student.patch(f"/api/quiz/my-sets/{set_id}", json={**payload, "title": "전자 기초 문제집", "expertise": "전자"}, headers=ORIGIN)
    assert edited.status_code == 200
    assert edited.json()["expertise"] == "전자"
    assert edited.json()["status"] == "draft"
    custom = student.patch(
        f"/api/quiz/my-sets/{set_id}",
        json={**payload, "expertise": "  협동로봇   비전  "}, headers=ORIGIN,
    )
    assert custom.status_code == 200
    assert custom.json()["expertise"] == "협동로봇 비전"


@pytest.mark.parametrize("expertise", ["", "A", "x" * 41, "로봇\x00제어"])
def test_custom_quiz_expertise_validation(expertise):
    student, _ = session_client(f"custom_topic_{abs(hash(expertise))}", role="student")
    response = student.post("/api/quiz/my-sets", headers=ORIGIN, json={
        "title": "새 주제 문제집", "expertise": expertise, "quizzes": [{
            "difficulty": "easy", "question_type": "short_answer", "question": "테스트 질문",
            "options": None, "correct_answers": ["정답"], "hint": "", "explanation": "", "source_ref": "",
        }],
    })
    assert response.status_code == 400


def test_quiz_set_validation_reports_db_similarity_and_answer_bias():
    student, _ = session_client("quiz_validator", role="student")
    with database.get_connection() as conn:
        existing = conn.execute("SELECT question FROM quizzes WHERE is_active=1 LIMIT 1").fetchone()["question"]
    quizzes = []
    for index in range(4):
        quizzes.append({
            "difficulty": "easy", "question_type": "multiple_choice",
            "question": existing if index == 0 else f"편향 검사 문항 {index}",
            "options": ["A", "B", "C", "D"], "correct_answers": ["1", "A"],
            "hint": "", "explanation": "", "source_ref": "테스트",
        })
    response = student.post("/api/quiz/my-sets/validate", headers=ORIGIN, json={
        "expertise": "새로운 로봇 분야", "quizzes": quizzes,
    })
    assert response.status_code == 200
    result = response.json()
    assert result["similarities"][0]["similarity"] == 100.0
    assert result["answer_bias"]["warning"] is True
    assert result["answer_bias"]["counts"]["1"] == 4


def test_quiz_today_and_submit_flow(monkeypatch):
    client, user = session_client("alice", role="student")
    broadcast_events = []

    async def capture_broadcast(payload):
        broadcast_events.append(payload)

    monkeypatch.setattr(main, "broadcast", capture_broadcast)

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
    assert {
        "type": "quiz_leaderboard_updated",
        "user_id": user["id"],
    } in broadcast_events

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
            "category": "PLC",
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


def test_quiz_bookmark_and_review_api():
    client, user = session_client("charlie", role="student")

    today_resp = client.get("/api/quiz/today")
    quizzes = today_resp.json()["quizzes"]
    q1 = quizzes[0]

    # 1. Bookmark toggle
    bm_resp = client.post(f"/api/quiz/bookmark/{q1['id']}", headers=ORIGIN)
    assert bm_resp.status_code == 200
    assert bm_resp.json()["is_starred"] is True

    # 2. Get review starred
    starred_resp = client.get("/api/quiz/review?mode=starred")
    assert starred_resp.status_code == 200
    assert starred_resp.json()["count"] == 1
    assert starred_resp.json()["quizzes"][0]["id"] == q1["id"]

    # 3. Submit wrong answer in daily
    client.post(
        "/api/quiz/submit",
        json={"quiz_id": q1["id"], "answer": "totally_wrong"},
        headers=ORIGIN,
    )

    # 4. Get review wrong
    wrong_resp = client.get("/api/quiz/review?mode=wrong")
    assert wrong_resp.status_code == 200
    assert wrong_resp.json()["count"] == 1

    # 5. Retry in practice mode (solve correctly)
    retry_resp = client.post(
        "/api/quiz/retry",
        json={"quiz_id": q1["id"], "answer": "Y0"},
        headers=ORIGIN,
    )
    assert retry_resp.status_code == 200
    assert retry_resp.json()["is_correct"] is True

    # 6. Verify quiz remains in wrong list (retained for future review)
    wrong_after_retry = client.get("/api/quiz/review?mode=wrong")
    assert wrong_after_retry.status_code == 200
    assert wrong_after_retry.json()["count"] == 1
    assert wrong_after_retry.json()["quizzes"][0]["is_correct"] is True
    assert wrong_after_retry.json()["quizzes"][0]["had_wrong"] is True

    # 7. Check review history ("내가 푼 문제")
    history_resp = client.get("/api/quiz/review?mode=history")
    assert history_resp.status_code == 200
    assert history_resp.json()["count"] >= 1
    assert any(q["id"] == q1["id"] for q in history_resp.json()["quizzes"])



def test_quiz_categories_and_sidebar_counts():
    client, user = session_client("david", role="student")

    # 1. Categories endpoint
    cat_resp = client.get("/api/quiz/categories")
    assert cat_resp.status_code == 200
    cats = cat_resp.json()["categories"]
    assert len(cats) > 0
    assert any(c["category"] == "PLC" for c in cats)

    # 2. Sidebar counts before any action
    count_resp = client.get("/api/quiz/sidebar-counts")
    assert count_resp.status_code == 200
    counts = count_resp.json()
    assert counts["wrong"] == 0
    assert counts["starred"] == 0
    assert counts["history"] == 0

    # 3. Category filtering in /api/quiz/today
    plc_resp = client.get("/api/quiz/today?category=PLC")
    assert plc_resp.status_code == 200
    plc_quizzes = plc_resp.json()["quizzes"]
    assert len(plc_quizzes) > 0
    assert all(q["category"] == "PLC" for q in plc_quizzes)

    # 4. Random mode
    rnd_resp = client.get("/api/quiz/today?category=random")
    assert rnd_resp.status_code == 200
    assert len(rnd_resp.json()["quizzes"]) > 0


def test_quiz_author_api_flow():
    admin, admin_user = session_client("master_admin", role="admin")
    student, student_user = session_client("quiz_taker", role="student")

    # 1. Check default seed quizzes have author_name in /api/quiz/today
    today_resp = student.get("/api/quiz/today")
    assert today_resp.status_code == 200
    quizzes = today_resp.json()["quizzes"]
    assert len(quizzes) > 0
    assert all("author_name" in q and q["author_name"] for q in quizzes)

    # 2. Admin creates a quiz with explicit author_name
    create_resp = admin.post(
        "/api/admin/quiz",
        json={
            "category": "로봇",
            "difficulty": "easy",
            "question_type": "short_answer",
            "question": "로봇 관절의 자유도를 뜻하는 약어는?",
            "correct_answers": ["DOF", "Degree of Freedom"],
            "author_name": "김로봇",
        },
        headers=ORIGIN,
    )
    assert create_resp.status_code == 200
    new_id = create_resp.json()["quiz_id"]

    # 3. Verify in admin quiz list
    admin_list_resp = admin.get(f"/api/admin/quiz/list?search={new_id}")
    assert admin_list_resp.status_code == 200
    admin_quizzes = admin_list_resp.json()["quizzes"]
    created_item = next(q for q in admin_quizzes if q["id"] == new_id)
    assert created_item["author_name"] == "김로봇"

    # 4. Student sees author_name in today / category query
    robot_resp = student.get("/api/quiz/today?category=로봇")
    assert robot_resp.status_code == 200
    robot_quizzes = robot_resp.json()["quizzes"]
    target_in_today = next(q for q in robot_quizzes if q["id"] == new_id)
    assert target_in_today["author_name"] == "김로봇"


def test_category_quiz_api_pagination_with_exclude():
    ORIGIN = {"Origin": "http://testserver"}
    admin, _ = session_client("admin_user", role="admin")
    student, _ = session_client("student_user", role="student")

    # Create 10 quizzes under '넌센스'
    for i in range(10):
        resp = admin.post(
            "/api/admin/quiz",
            json={
                "category": "넌센스",
                "difficulty": "easy",
                "question_type": "short_answer",
                "question": f"넌센스 퀴즈 {i + 1}",
                "correct_answers": ["정답"],
                "author_name": "센스쟁이",
            },
            headers=ORIGIN,
        )
        assert resp.status_code == 200

    # Student fetches first 5
    r1 = student.get("/api/quiz/today?category=넌센스&count=5")
    assert r1.status_code == 200
    b1 = r1.json()["quizzes"]
    assert len(b1) == 5
    b1_ids = [q["id"] for q in b1]

    # Student solves all 5
    for qid in b1_ids:
        sub = student.post("/api/quiz/submit", json={"quiz_id": qid, "answer": "정답"}, headers=ORIGIN)
        assert sub.status_code == 200

    # Student fetches next 5 with exclude
    exclude_str = ",".join(str(i) for i in b1_ids)
    r2 = student.get(f"/api/quiz/today?category=넌센스&count=5&exclude={exclude_str}")
    assert r2.status_code == 200
    b2 = r2.json()["quizzes"]
    assert len(b2) == 5
    b2_ids = [q["id"] for q in b2]

    # Verify no overlap and all are unsolved
    assert set(b1_ids).isdisjoint(set(b2_ids))
    assert all(q["is_solved"] is False for q in b2)


def test_subject_titles_api_and_custom_titles_flow():
    admin, _ = session_client("admin_user", role="admin")
    student, student_user = session_client("student_user", role="student")

    # 1. Check GET /api/quiz/subject-titles
    all_titles_res = student.get("/api/quiz/subject-titles")
    assert all_titles_res.status_code == 200
    titles_map = all_titles_res.json()["titles"]
    assert "PLC" in titles_map
    assert titles_map["PLC"]["rank1_title"] == "PLC의 신"
    assert titles_map["PLC"]["icon"] == "⚡"

    # 2. Check GET /api/quiz/subject-titles/{category}
    plc_res = student.get("/api/quiz/subject-titles/PLC")
    assert plc_res.status_code == 200
    assert plc_res.json()["rank1_title"] == "PLC의 신"

    # 3. Non-admin cannot POST /api/admin/quiz/subject-titles
    forbidden_res = student.post(
        "/api/admin/quiz/subject-titles",
        json={"category": "인공지능", "icon": "🧠", "rank1_title": "튜링의 후예", "rank2_title": "신경망 마스터", "rank3_title": "프롬프트 입문"},
        headers=ORIGIN,
    )
    assert forbidden_res.status_code == 403

    # 4. Admin saves subject titles directly
    admin_save_res = admin.post(
        "/api/admin/quiz/subject-titles",
        json={"category": "인공지능", "icon": "🧠", "rank1_title": "튜링의 후예", "rank2_title": "신경망 마스터", "rank3_title": "프롬프트 입문"},
        headers=ORIGIN,
    )
    assert admin_save_res.status_code == 200
    ai_titles = student.get("/api/quiz/subject-titles/인공지능").json()
    assert ai_titles["rank1_title"] == "튜링의 후예"
    assert ai_titles["icon"] == "🧠"

    # 5. Student submits a set with custom rank titles
    set_payload = {
        "title": "임베디드 기초",
        "expertise": "임베디드",
        "rank1_title": "펌웨어의 신",
        "rank2_title": "납땜 장인",
        "rank3_title": "회로 분석가",
        "icon": "💻",
        "quizzes": [{
            "difficulty": "easy",
            "question_type": "short_answer",
            "question": "GPIO는 무엇의 약자인가?",
            "correct_answers": ["General Purpose Input Output", "일반 목적 입출력"],
            "hint": "입출력 핀",
            "explanation": "GPIO 설명",
        }],
    }
    create_res = student.post("/api/quiz/my-sets", json=set_payload, headers=ORIGIN)
    assert create_res.status_code == 201
    set_id = create_res.json()["id"]

    # Verify student my-sets contains the titles
    my_sets = student.get("/api/quiz/my-sets").json()["sets"]
    created_set = next(s for s in my_sets if s["id"] == set_id)
    assert created_set["rank1_title"] == "펌웨어의 신"
    assert created_set["icon"] == "💻"

    # Student updates set with modified rank2 title
    update_res = student.patch(
        f"/api/quiz/my-sets/{set_id}",
        json={**set_payload, "rank2_title": "오실로스코프 고수"},
        headers=ORIGIN,
    )
    assert update_res.status_code == 200

    # Student requests review
    assert student.post(f"/api/quiz/my-sets/{set_id}/submit", headers=ORIGIN).status_code == 200

    # Admin reviews and approves
    admin_review_res = admin.post(
        f"/api/admin/quiz/submissions/{set_id}/review",
        json={"approve": True, "note": "승인합니다", "expertise": "임베디드", "rank1_title": "펌웨어의 신", "rank2_title": "오실로스코프 고수", "rank3_title": "회로 분석가", "icon": "💻"},
        headers=ORIGIN,
    )
    assert admin_review_res.status_code == 200
    created_quiz_id = admin_review_res.json()["created_ids"][0]

    # Check that 임베디드 subject titles were registered
    embedded_titles = student.get("/api/quiz/subject-titles/임베디드").json()
    assert embedded_titles["rank1_title"] == "펌웨어의 신"
    assert embedded_titles["rank2_title"] == "오실로스코프 고수"
    assert embedded_titles["rank3_title"] == "회로 분석가"
    assert embedded_titles["icon"] == "💻"

    # Check categories summary has rank titles
    cats_summary = student.get("/api/quiz/categories").json()["categories"]
    emb_cat = next((c for c in cats_summary if c["category"] == "임베디드"), None)
    assert emb_cat is not None
    assert emb_cat["rank1_title"] == "펌웨어의 신"
    assert emb_cat["icon"] == "💻"

    # Student solves the quiz and checks leaderboard
    solve_res = student.post(
        "/api/quiz/submit",
        json={"quiz_id": created_quiz_id, "answer": "General Purpose Input Output"},
        headers=ORIGIN,
    )
    assert solve_res.status_code == 200

    lb_res = student.get("/api/quiz/leaderboard?category=임베디드")
    assert lb_res.status_code == 200
    lb = lb_res.json()["leaderboard"]
    assert len(lb) >= 1
    assert lb[0]["rank"] == 1
    assert lb[0]["badge"] is not None
    assert lb[0]["badge"]["label"] == "펌웨어의 신"
    assert lb[0]["badge"]["icon"] == "💻"


def test_admin_quiz_creation_with_subject_titles():
    admin, _ = session_client("admin_user", role="admin")
    student, _ = session_client("student_user", role="student")

    res = admin.post(
        "/api/admin/quiz",
        json={
            "category": "반도체",
            "icon": "🔬",
            "rank1_title": "웨이퍼 마스터",
            "rank2_title": "공정 장인",
            "rank3_title": "수율 분석가",
            "difficulty": "medium",
            "question_type": "short_answer",
            "question": "반도체 8대 공정 중 포토공정이란?",
            "correct_answers": ["빛을 이용해 회로 패턴을 형성하는 공정"],
        },
        headers=ORIGIN,
    )
    assert res.status_code == 200

    semi_titles = student.get("/api/quiz/subject-titles/반도체").json()
    assert semi_titles["rank1_title"] == "웨이퍼 마스터"
    assert semi_titles["rank2_title"] == "공정 장인"
    assert semi_titles["rank3_title"] == "수율 분석가"
    assert semi_titles["icon"] == "🔬"


def test_quiz_expertises_and_categories_dynamic():
    student, _ = session_client("learner_cat", role="student")
    admin, _ = session_client("admin_cat", role="admin")

    # 1. Base expertises should contain default categories
    res1 = student.get("/api/quiz/expertises")
    assert res1.status_code == 200
    base_expertises = res1.json()["expertises"]
    assert "PLC" in base_expertises
    assert "시퀀스 심화" not in base_expertises

    # 2. User creates a quiz set with a new custom topic
    create_res = student.post(
        "/api/quiz/my-sets",
        json={
            "title": "시퀀스 마스터 모음집",
            "expertise": "시퀀스 심화",
            "rank1_title": "시퀀스 달인",
            "rank2_title": "시퀀스 중수",
            "rank3_title": "시퀀스 입문",
            "icon": "⚡",
            "quizzes": [
                {
                    "difficulty": "medium",
                    "question_type": "multiple_choice",
                    "question": "자기유지 회로를 해제하는 접점은?",
                    "options": ["1. b접점", "2. a접점", "3. c접점", "4. 없음"],
                    "correct_answers": ["1", "1. b접점"],
                    "hint": "회로 차단",
                    "explanation": "b접점을 열어 회로를 차단합니다.",
                }
            ],
        },
        headers=ORIGIN,
    )
    assert create_res.status_code == 201

    # 3. GET /api/quiz/expertises must immediately include the user-made topic
    res2 = student.get("/api/quiz/expertises")
    assert res2.status_code == 200
    expertises2 = res2.json()["expertises"]
    assert "시퀀스 심화" in expertises2

    # 4. Admin creates a quiz with category "양자컴퓨팅"
    admin_res = admin.post(
        "/api/admin/quiz",
        json={
            "category": "양자컴퓨팅",
            "difficulty": "hard",
            "question_type": "short_answer",
            "question": "큐비트의 기본 성질 중 두 상태의 겹침을 무엇이라 하는가?",
            "correct_answers": ["중첩"],
        },
        headers=ORIGIN,
    )
    assert admin_res.status_code == 200

    # 5. GET /api/admin/quiz/list must include both new categories
    admin_list_res = admin.get("/api/admin/quiz/list")
    assert admin_list_res.status_code == 200
    admin_cats = admin_list_res.json()["categories"]
    assert "시퀀스 심화" in admin_cats
    assert "양자컴퓨팅" in admin_cats

    # 6. GET /api/quiz/categories all_categories must include both
    cats_res = student.get("/api/quiz/categories")
    assert cats_res.status_code == 200
    all_cats = cats_res.json().get("all_categories", [])
    assert "시퀀스 심화" in all_cats
    assert "양자컴퓨팅" in all_cats







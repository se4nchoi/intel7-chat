"""Hub API additions for the Discord/Piazza UI: author roles, members, endorsement.

These tests need a disposable PostgreSQL database. Set
BAMBOOCHAT_HUB_TEST_DATABASE_URL (e.g. postgresql://hub@127.0.0.1:55432/hub_test);
all hub_* tables in it are dropped and recreated.
"""
import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

TEST_URL = os.environ.get("BAMBOOCHAT_HUB_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not TEST_URL, reason="BAMBOOCHAT_HUB_TEST_DATABASE_URL not set")

PASSWORD = "test-pass-1234"
ORIGIN = {"origin": "https://testserver"}


@pytest.fixture
def hub(monkeypatch):
    from app.hub import db, routes
    monkeypatch.setenv("BAMBOOCHAT_HUB_DATABASE_URL", TEST_URL)
    with db.connect() as conn:
        conn.execute("""DROP TABLE IF EXISTS hub_files, hub_answers, hub_questions, hub_messages,
                        hub_channels, hub_memberships, hub_cohorts, hub_sessions, hub_accounts CASCADE""")
    db.initialize_schema()
    admin = db.create_account("admin_user", "Admin", PASSWORD)
    with db.connect() as conn:
        conn.execute("UPDATE hub_accounts SET is_admin=TRUE WHERE id=%s", (admin["id"],))
    db.create_account("teacher", "Teacher Kim", PASSWORD)
    db.create_account("student", "Student Lee", PASSWORD)
    cohort = db.create_cohort("demo-2026", "Demo")
    db.add_membership(cohort["id"], "teacher", "instructor")
    db.add_membership(cohort["id"], "student", "student")
    channel = db.create_channel(cohort["id"], "general", "General")
    app = FastAPI()
    app.include_router(routes.router)
    return app, cohort["id"], channel["id"]


def login(app, username):
    client = TestClient(app, base_url="https://testserver")
    response = client.post("/hub/api/login", json={"username": username, "password": PASSWORD}, headers=ORIGIN)
    assert response.status_code == 200
    return client


def test_members_list_roles(hub):
    app, cohort_id, _ = hub
    members = login(app, "student").get(f"/hub/api/cohorts/{cohort_id}/members").json()
    assert {(m["username"], m["role"]) for m in members} == {("teacher", "instructor"), ("student", "student")}


def test_messages_include_author_role(hub):
    app, cohort_id, channel_id = hub
    url = f"/hub/api/cohorts/{cohort_id}/channels/{channel_id}/messages"
    sent = login(app, "teacher").post(url, json={"body": "hello"}, headers=ORIGIN).json()
    assert sent["role"] == "instructor"
    login(app, "admin_user").post(url, json={"body": "hi"}, headers=ORIGIN)
    roles = [m["role"] for m in login(app, "student").get(url).json()]
    assert roles == ["instructor", "admin"]


def test_question_summary_and_endorsement(hub):
    app, cohort_id, _ = hub
    student, teacher = login(app, "student"), login(app, "teacher")
    base = f"/hub/api/cohorts/{cohort_id}/questions"
    qid = student.post(base, json={"title": "Q", "body": "why?"}, headers=ORIGIN).json()["id"]
    summary = student.get(base).json()[0]
    assert (summary["answer_count"], summary["instructor_answered"], summary["endorsed"], summary["role"]) == (0, False, False, "student")

    aid = student.post(f"{base}/{qid}/answers", json={"body": "because"}, headers=ORIGIN).json()["id"]
    teacher.post(f"{base}/{qid}/answers", json={"body": "official"}, headers=ORIGIN)
    summary = student.get(base).json()[0]
    assert (summary["answer_count"], summary["instructor_answered"], summary["endorsed"]) == (2, True, False)

    endorse = f"{base}/{qid}/answers/{aid}/endorse"
    assert student.post(endorse, json={"endorsed": True}, headers=ORIGIN).status_code == 403
    assert teacher.post(endorse, json={"endorsed": True}, headers=ORIGIN).json() == {"id": aid, "endorsed": True}
    answers = student.get(f"{base}/{qid}/answers").json()
    assert [(a["role"], a["endorsed"]) for a in answers] == [("student", True), ("instructor", False)]
    assert student.get(base).json()[0]["endorsed"] is True
    assert teacher.post(f"{base}/{qid}/answers/999999/endorse", json={"endorsed": True}, headers=ORIGIN).status_code == 404

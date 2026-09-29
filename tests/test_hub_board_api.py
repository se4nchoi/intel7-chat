"""Hub API additions for the Discord/Piazza UI: author roles, members, endorsement.

These tests need a disposable PostgreSQL database. Set
MADI_TEST_DATABASE_URL (e.g. postgresql://hub@127.0.0.1:55432/hub_test);
all hub_* tables in it are dropped and recreated.
"""
import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

TEST_URL = os.environ.get("MADI_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not TEST_URL, reason="MADI_TEST_DATABASE_URL not set")

PASSWORD = "test-pass-1234"
ORIGIN = {"origin": "https://testserver"}


@pytest.fixture
def hub(monkeypatch):
    from app.hub import db, routes
    monkeypatch.setenv("MADI_DATABASE_URL", TEST_URL)
    routes.login_attempts.clear()
    with db.connect() as conn:
        conn.execute("""DROP TABLE IF EXISTS hub_schema_migrations, hub_files, hub_answers, hub_questions, hub_messages,
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


# --- Chat socket revocation (audit 2026-09-28, finding 1) ---

from starlette.websockets import WebSocketDisconnect  # noqa: E402


def open_socket(client, cohort_id, channel_id):
    from app.hub.routes import COOKIE
    return client.websocket_connect(
        f"/hub/ws/cohorts/{cohort_id}/channels/{channel_id}",
        headers={"origin": "https://testserver", "cookie": f"{COOKIE}={client.cookies[COOKIE]}"},
    )


def post(client, cohort_id, channel_id, body):
    url = f"/hub/api/cohorts/{cohort_id}/channels/{channel_id}/messages"
    assert client.post(url, json={"body": body}, headers=ORIGIN).status_code == 201


def assert_revoked(ws):
    with pytest.raises(WebSocketDisconnect) as closed:
        ws.receive_json()
    assert closed.value.code == 1008


def test_socket_delivers_while_session_valid(hub):
    app, cohort_id, channel_id = hub
    student, teacher = login(app, "student"), login(app, "teacher")
    with open_socket(student, cohort_id, channel_id) as ws:
        post(teacher, cohort_id, channel_id, "hello")
        assert ws.receive_json()["message"]["body"] == "hello"


def test_logout_closes_open_socket(hub):
    app, cohort_id, channel_id = hub
    student, teacher = login(app, "student"), login(app, "teacher")
    with open_socket(student, cohort_id, channel_id) as ws:
        assert student.post("/hub/api/logout", headers=ORIGIN).status_code == 204
        post(teacher, cohort_id, channel_id, "after logout")  # a leak would arrive here instead of the close
        assert_revoked(ws)


def test_revoked_session_is_dropped_before_delivery(hub):
    from app.hub import db
    app, cohort_id, channel_id = hub
    student, teacher = login(app, "student"), login(app, "teacher")
    with open_socket(student, cohort_id, channel_id) as ws:
        with db.connect() as conn:  # e.g. expiry or an admin revoking sessions
            conn.execute("UPDATE hub_sessions SET expires_at=now() - interval '1 minute' "
                         "WHERE account_id=(SELECT id FROM hub_accounts WHERE username='student')")
        post(teacher, cohort_id, channel_id, "secret")
        assert_revoked(ws)


def test_removed_membership_is_dropped_before_delivery(hub):
    from app.hub import db
    app, cohort_id, channel_id = hub
    student, teacher = login(app, "student"), login(app, "teacher")
    with open_socket(student, cohort_id, channel_id) as ws:
        with db.connect() as conn:
            conn.execute("UPDATE hub_memberships SET active=FALSE WHERE cohort_id=%s AND account_id="
                         "(SELECT id FROM hub_accounts WHERE username='student')", (cohort_id,))
        post(teacher, cohort_id, channel_id, "secret")
        assert_revoked(ws)


def test_other_sessions_keep_receiving_after_one_logout(hub):
    app, cohort_id, channel_id = hub
    phone, laptop, teacher = login(app, "student"), login(app, "student"), login(app, "teacher")
    with open_socket(phone, cohort_id, channel_id) as phone_ws, open_socket(laptop, cohort_id, channel_id) as laptop_ws:
        phone.post("/hub/api/logout", headers=ORIGIN)
        post(teacher, cohort_id, channel_id, "still here")
        assert_revoked(phone_ws)
        assert laptop_ws.receive_json()["message"]["body"] == "still here"


# --- Pre-deployment hardening: pooled connections, login throttling ---

def test_connections_are_reused_from_pool(hub):
    from app.hub import db
    pids = set()
    for _ in range(20):
        with db.connect() as conn:
            pids.add(conn.execute("SELECT pg_backend_pid() AS pid").fetchone()["pid"])
    assert len(pids) <= db._pool().max_size < 20


def test_failed_query_does_not_poison_pooled_connection(hub):
    from app.hub import db
    with pytest.raises(Exception):
        with db.connect() as conn:
            conn.execute("SELECT * FROM no_such_table")
    with db.connect() as conn:
        assert conn.execute("SELECT 1 AS ok").fetchone()["ok"] == 1


def test_login_is_throttled_per_username(hub):
    from app.hub.routes import LOGIN_LIMIT
    app, _, _ = hub
    client = TestClient(app, base_url="https://testserver")
    for _ in range(LOGIN_LIMIT):
        wrong = client.post("/hub/api/login", json={"username": "student", "password": "wrong-pass-1234"}, headers=ORIGIN)
        assert wrong.status_code == 401
    blocked = client.post("/hub/api/login", json={"username": "student", "password": PASSWORD}, headers=ORIGIN)
    assert blocked.status_code == 429
    assert blocked.json()["detail"] == "Too many login attempts; try again later"
    # Case variants of the same username share the limit; other accounts don't.
    assert client.post("/hub/api/login", json={"username": "STUDENT", "password": PASSWORD}, headers=ORIGIN).status_code == 429
    login(app, "teacher")


def test_messages_after_returns_only_newer_in_order(hub):
    app, cohort_id, channel_id = hub
    teacher = login(app, "teacher")
    url = f"/hub/api/cohorts/{cohort_id}/channels/{channel_id}/messages"
    ids = [teacher.post(url, json={"body": f"m{i}"}, headers=ORIGIN).json()["id"] for i in range(4)]
    newer = teacher.get(url, params={"after": ids[1]}).json()
    assert [m["body"] for m in newer] == ["m2", "m3"]
    assert newer[0]["role"] == "instructor"
    assert teacher.get(url, params={"after": ids[-1]}).json() == []
    assert teacher.get(url, params={"after": -1}).status_code == 422


def test_upload_and_download_use_configured_file_dir(hub, monkeypatch, tmp_path):
    app, cohort_id, _ = hub
    monkeypatch.setenv("MADI_FILE_DIR", str(tmp_path / "madi-files"))
    student = login(app, "student")
    url = f"/hub/api/cohorts/{cohort_id}/files"
    uploaded = student.post(url, files={"upload": ("notes.txt", b"hello madi", "text/plain")}, headers=ORIGIN)
    assert uploaded.status_code == 201
    file_id = uploaded.json()["id"]
    assert (tmp_path / "madi-files" / file_id).read_bytes() == b"hello madi"
    download = student.get(f"{url}/{file_id}")
    assert download.content == b"hello madi"
    assert "notes.txt" in download.headers["content-disposition"]


def test_session_lifetime_follows_setting(hub, monkeypatch):
    from app.hub import db
    app, _, _ = hub
    monkeypatch.setenv("MADI_SESSION_HOURS", "2")
    client = login(app, "student")
    assert "Max-Age=7200" in client.post("/hub/api/login", json={"username": "student", "password": PASSWORD},
                                         headers=ORIGIN).headers["set-cookie"]
    with db.connect() as conn:
        hours = conn.execute("SELECT extract(epoch FROM max(expires_at) - now()) / 3600 AS h FROM hub_sessions").fetchone()["h"]
    assert 1.9 < float(hours) <= 2.0


# --- Event log ---

def madi_lines(caplog):
    return [r.getMessage() for r in caplog.records if r.name == "madi"]


def test_login_events_are_logged_without_secrets(hub, caplog):
    import logging
    from app.hub.routes import COOKIE
    caplog.set_level(logging.INFO, logger="madi")
    app, _, _ = hub
    client = TestClient(app, base_url="https://testserver")
    client.post("/hub/api/login", json={"username": "student", "password": "wrong-pass-1234"}, headers=ORIGIN)
    injected = "evil\n2026-01-01T00:00:00Z INFO madi login ok user='admin_user'"
    client.post("/hub/api/login", json={"username": injected, "password": "x"}, headers=ORIGIN)
    ok = login(app, "student")
    ok.post("/hub/api/logout", headers=ORIGIN)
    lines = madi_lines(caplog)
    assert any(l.startswith("login failed user='student'") for l in lines)
    assert any(l.startswith("login ok user='student'") for l in lines)
    assert any(l.startswith("logout user='student'") for l in lines)
    assert all("\n" not in l for l in lines)  # the injected newline stays escaped
    text = "\n".join(lines)
    assert "wrong-pass-1234" not in text and PASSWORD not in text
    assert ok.cookies.get(COOKIE) is None or ok.cookies[COOKIE] not in text


def test_admin_actions_and_denials_are_logged(hub, caplog):
    import logging
    caplog.set_level(logging.INFO, logger="madi")
    app, cohort_id, _ = hub
    admin, student = login(app, "admin_user"), login(app, "student")
    admin.post("/hub/api/accounts", json={"username": "newbie", "display_name": "New", "password": "test-pass-1234"}, headers=ORIGIN)
    admin.post(f"/hub/api/cohorts/{cohort_id}/memberships", json={"username": "newbie", "role": "student"}, headers=ORIGIN)
    student.post("/hub/api/cohorts", json={"slug": "sneaky", "name": "Sneaky"}, headers=ORIGIN)
    other = admin.post("/hub/api/cohorts", json={"slug": "other-2026", "name": "Other"}, headers=ORIGIN).json()
    student.get(f"/hub/api/cohorts/{other['id']}/channels")
    lines = madi_lines(caplog)
    assert any(l.startswith("account created by='admin_user'") and "user='newbie'" in l for l in lines)
    assert any(l.startswith("membership set by='admin_user'") and "role=student" in l for l in lines)
    assert any(l.startswith("admin denied user='student'") for l in lines)
    assert any(l.startswith("cohort created by='admin_user'") for l in lines)
    assert any(l.startswith("access denied user='student'") and f"cohort={other['id']}" in l for l in lines)


def test_configure_writes_rotating_file(tmp_path):
    import logging
    from app.hub.logs import configure, log
    try:
        configure(tmp_path / "logs" / "madi.log", "INFO")
        log.info("hello user=%r", "x")
        log.debug("hidden")
        content = (tmp_path / "logs" / "madi.log").read_text(encoding="utf-8")
        assert "INFO madi hello user='x'" in content and "hidden" not in content
    finally:
        for handler in log.handlers[:]:
            log.removeHandler(handler)
            handler.close()
        log.propagate = True
        log.setLevel(logging.NOTSET)

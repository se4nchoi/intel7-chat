"""Hub API additions for the Discord/Piazza UI: author roles, members, endorsement.

These tests need a disposable PostgreSQL database. Set
MADI_TEST_DATABASE_URL (e.g. postgresql://hub@127.0.0.1:55432/hub_test);
all hub_* tables in it are dropped and recreated.
"""
import os

import pytest

from tests.hub_reset import drop_hub_tables
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
    drop_hub_tables(db)
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


def open_socket(client, cohort_id, channel_id=None):
    """The cohort socket; channel_id is accepted for readability at call sites."""
    from app.hub.routes import COOKIE
    return client.websocket_connect(
        f"/hub/ws/cohorts/{cohort_id}",
        headers={"origin": "https://testserver", "cookie": f"{COOKIE}={client.cookies[COOKIE]}"},
    )


def receive(ws):
    """Next event other than presence updates."""
    while True:
        event = ws.receive_json()
        if event["type"] != "presence":
            return event


def post(client, cohort_id, channel_id, body):
    url = f"/hub/api/cohorts/{cohort_id}/channels/{channel_id}/messages"
    assert client.post(url, json={"body": body}, headers=ORIGIN).status_code == 201


def assert_revoked(ws):
    with pytest.raises(WebSocketDisconnect) as closed:
        receive(ws)
    assert closed.value.code == 1008


def test_socket_delivers_while_session_valid(hub):
    app, cohort_id, channel_id = hub
    student, teacher = login(app, "student"), login(app, "teacher")
    with open_socket(student, cohort_id, channel_id) as ws:
        post(teacher, cohort_id, channel_id, "hello")
        assert receive(ws)["message"]["body"] == "hello"


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
        assert receive(laptop_ws)["message"]["body"] == "still here"


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


def test_question_resolution_author_instructor_and_scope(hub):
    from app.hub import db
    app, cohort_id, _ = hub
    student, teacher = login(app, 'student'), login(app, 'teacher')
    base = f'/hub/api/cohorts/{cohort_id}/questions'
    qid = student.post(base, json={'title': 'Help', 'body': 'Question'}, headers=ORIGIN).json()['id']
    db.create_account('peer', 'Peer', PASSWORD)
    db.add_membership(cohort_id, 'peer', 'student')
    endpoint = f'{base}/{qid}/resolution'
    assert login(app, 'peer').post(endpoint, json={'resolved': True}, headers=ORIGIN).status_code == 403
    assert student.post(endpoint, json={'resolved': True}, headers=ORIGIN).json() == {'id': qid, 'resolved': True}
    assert student.get(base).json()[0]['resolved'] is True
    assert teacher.post(endpoint, json={'resolved': False}, headers=ORIGIN).json()['resolved'] is False
    other = db.create_cohort('other-lab', 'Other lab')
    assert teacher.post(f'/hub/api/cohorts/{other["id"]}/questions/{qid}/resolution', json={'resolved': True}, headers=ORIGIN).status_code == 403
    assert student.post(endpoint, json={'resolved': True}, headers={'origin': 'https://wrong.test'}).status_code == 403
    with db.connect() as conn:
        conn.execute('UPDATE hub_cohorts SET archived=TRUE WHERE id=%s', (cohort_id,))
    assert student.post(endpoint, json={'resolved': True}, headers=ORIGIN).status_code == 403


def test_question_attachments_validate_owner_cohort_and_count(hub, monkeypatch, tmp_path):
    from app.hub import db
    app, cohort_id, _ = hub
    monkeypatch.setenv('MADI_FILE_DIR', str(tmp_path))
    student, teacher = login(app, 'student'), login(app, 'teacher')
    files_url = f'/hub/api/cohorts/{cohort_id}/files'
    base = f'/hub/api/cohorts/{cohort_id}/questions'
    uploaded = student.post(files_url, files={'upload': ('error.txt', b'Example error', 'text/plain')}, headers=ORIGIN)
    assert uploaded.status_code == 201
    fid = uploaded.json()['id']
    data = {'title': 'Help with error', 'body': 'See attached', 'attachments': [fid]}
    qid = student.post(base, json=data, headers=ORIGIN).json()['id']
    summary = student.get(base).json()[0]
    assert summary['attachments'] == [{'id': fid, 'name': 'error.txt'}]
    assert teacher.get(files_url + '/' + fid).content == b'Example error'
    assert teacher.post(base, json=data, headers=ORIGIN).status_code == 400
    other = db.create_cohort('other-class', 'Other')
    db.add_membership(other['id'], 'student', 'student')
    other_url = f'/hub/api/cohorts/{other["id"]}/questions'
    assert student.post(other_url, json=data, headers=ORIGIN).status_code == 400
    assert student.post(base, json={**data, 'attachments': ['missing']}, headers=ORIGIN).status_code == 400
    assert student.post(base, json={**data, 'attachments': [fid] * 6}, headers=ORIGIN).status_code == 422
    assert len(student.get(base).json()) == 1  # invalid attachments never leave a partial question
    assert teacher.delete(f'{base}/{qid}', headers=ORIGIN).status_code == 204
    assert student.get(base).json() == []


def test_instructors_cannot_demote_themselves_or_other_instructors(hub):
    from app.hub import db
    app, cid, _ = hub
    teacher, admin = login(app, 'teacher'), login(app, 'admin_user')
    db.create_account('second_teacher', 'Second', PASSWORD)
    db.add_membership(cid, 'second_teacher', 'instructor')
    endpoint = f'/hub/api/cohorts/{cid}/memberships'
    for username in ('teacher', 'second_teacher'):
        assert teacher.post(endpoint, json={'username': username, 'role': 'student'}, headers=ORIGIN).status_code == 403
    roles = {m['username']: m['role'] for m in db.members(cid)}
    assert roles['teacher'] == roles['second_teacher'] == 'instructor'
    assert admin.post(endpoint, json={'username': 'second_teacher', 'role': 'student'}, headers=ORIGIN).status_code == 201
    assert db.membership(cid, db.authenticate('second_teacher', PASSWORD)['id'])['role'] == 'student'


def test_questions_page_search_totals_and_old_direct_links(hub):
    from app.hub import db
    app, cid, _ = hub
    student = login(app, 'student')
    with db.connect() as conn:
        aid = conn.execute("SELECT id FROM hub_accounts WHERE username='student'").fetchone()['id']
        ids = [r['id'] for r in conn.execute("""INSERT INTO hub_questions(cohort_id,author_id,title,body)
            SELECT %s,%s,'Question ' || n,'Body' FROM generate_series(1,105) n RETURNING id""", (cid, aid))]
    base = f'/hub/api/cohorts/{cid}/questions'
    page = student.get(base + '/page').json()
    assert page['total'] == page['stats']['total'] == 105
    assert page['stats']['unanswered'] == 105
    seen = []
    while True:
        seen += [q['id'] for q in page['items']]
        if not page['has_more']:
            break
        page = student.get(base + '/page', params={'before': page['next_before']}).json()
    assert len(seen) == len(set(seen)) == 105
    assert student.get(base + f'/{ids[0]}').json()['title'] == 'Question 1'
    found = student.get(base + '/page', params={'search': 'Question 1'}).json()
    assert any(q['id'] == ids[0] for q in found['items'])
    assert student.get(base + '/page', params={'filter': 'resolved'}).json()['total'] == 0
    other = db.create_cohort('private-audit', 'Private')
    assert student.get(f'/hub/api/cohorts/{other["id"]}/questions/{ids[0]}').status_code == 403
    assert student.get(base + '/page', params={'filter': 'unknown'}).status_code == 422


def test_instructor_queue_oldest_cursor_covers_equal_timestamps_and_new_posts(hub):
    from app.hub import db
    app, cid, _ = hub
    teacher = login(app, 'teacher')
    with db.connect() as conn:
        aid = conn.execute("SELECT id FROM hub_accounts WHERE username='student'").fetchone()['id']
        ids = [row['id'] for row in conn.execute("""INSERT INTO hub_questions(cohort_id,author_id,title,body,created_at)
            SELECT %s,%s,'Queue ' || n,'Body',timestamp '2026-01-01 09:00:00+00'
            FROM generate_series(1,70) n RETURNING id""", (cid, aid))]
    url = f'/hub/api/cohorts/{cid}/questions/page'
    page = teacher.get(url, params={'filter': 'no-instructor', 'sort': 'oldest'}).json()
    assert [row['id'] for row in page['items']] == sorted(ids)[:30]
    seen = [row['id'] for row in page['items']]
    with db.connect() as conn:
        new_id = conn.execute("""INSERT INTO hub_questions(cohort_id,author_id,title,body)
            VALUES (%s,%s,'New queue item','Body') RETURNING id""", (cid, aid)).fetchone()['id']
    while page['has_more']:
        page = teacher.get(url, params={'filter': 'no-instructor', 'sort': 'oldest', 'before': page['next_before']}).json()
        seen.extend(row['id'] for row in page['items'])
    assert seen == sorted([*ids, new_id])
    assert teacher.get(url, params={'sort': 'random'}).status_code == 422


def test_file_cursor_covers_equal_timestamps_without_duplicates(hub):
    from app.hub import db
    app, cid, _ = hub
    student = login(app, 'student')
    with db.connect() as conn:
        aid = conn.execute("SELECT id FROM hub_accounts WHERE username='student'").fetchone()['id']
        for n in range(105):
            conn.execute("INSERT INTO hub_files(id,cohort_id,uploader_id,original_name,content_type,size_bytes)VALUES(%s,%s,%s,%s,'text/plain',1)", (f'{n:032x}', cid, aid, f'file-{n}.txt'))
    url = f'/hub/api/cohorts/{cid}/files/page'
    page, seen = student.get(url).json(), []
    assert page['total'] == 105
    while True:
        seen += [f['id'] for f in page['items']]
        if not page['has_more']:
            break
        page = student.get(url, params={'before': page['next_before']}).json()
    assert len(seen) == len(set(seen)) == 105
    assert student.get(url, params={'search': 'file-104.txt'}).json()['total'] == 1
    assert student.get(url, params={'before': 'f' * 32}).status_code == 400


def test_message_history_before_and_pin_context_preserve_channel_scope(hub):
    from app.hub import db
    app, cid, channel = hub
    student = login(app, 'student')
    with db.connect() as conn:
        aid = conn.execute("SELECT id FROM hub_accounts WHERE username='student'").fetchone()['id']
        ids = [r['id'] for r in conn.execute("INSERT INTO hub_messages(channel_id,author_id,body) SELECT %s,%s,n::text FROM generate_series(1,151)n RETURNING id", (channel, aid))]
    url = f'/hub/api/cohorts/{cid}/channels/{channel}/messages'
    latest = student.get(url).json()
    older = student.get(url, params={'before': latest[0]['id']}).json()
    assert len(latest) == 100 and len(older) == 51
    context = student.get(url, params={'around': ids[0]}).json()
    assert context[0]['id'] == ids[0]
    assert all(m['channel_id'] == channel for m in context)
    assert student.get(url, params={'after': 0, 'before': ids[0]}).status_code == 400


def test_membership_search_is_manager_only_and_scoped(hub):
    from app.hub import db
    app, cid, _ = hub
    teacher, student = login(app, 'teacher'), login(app, 'student')
    db.create_account('waiting_student', 'Waiting learner', PASSWORD)
    db.create_account('other_student', 'Other learner', PASSWORD)
    other = db.create_cohort('other-audit', 'Other')
    db.add_membership(other['id'], 'other_student', 'student')
    endpoint = f'/hub/api/cohorts/{cid}/members/candidates'
    assert student.get(endpoint, params={'q': 'student'}).status_code == 403
    candidates = teacher.get(endpoint, params={'q': 'student'}).json()
    assert {a['username'] for a in candidates} == {'student', 'waiting_student'}
    assert teacher.get(endpoint).json() == []


def test_board_changes_reach_cohort_socket(hub):
    app, cid, _ = hub
    student, teacher = login(app, 'student'), login(app, 'teacher')
    with open_socket(student, cid) as socket:
        assert socket.receive_json()['type'] == 'presence'
        created = teacher.post(f'/hub/api/cohorts/{cid}/questions', json={'title': 'Live', 'body': 'Question'}, headers=ORIGIN).json()
        assert socket.receive_json() == {'type': 'board_changed', 'question_id': created['id']}
        teacher.post(f'/hub/api/cohorts/{cid}/questions/{created["id"]}/answers', json={'body': 'Live answer'}, headers=ORIGIN)
        assert socket.receive_json()['type'] == 'board_changed'

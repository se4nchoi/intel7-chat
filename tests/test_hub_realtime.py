"""Cohort sockets, presence and unread counts."""
import pytest

from tests.test_hub_board_api import ORIGIN, PASSWORD, TEST_URL, hub, login, open_socket, post, receive  # noqa: F401

pytestmark = pytest.mark.skipif(not TEST_URL, reason="MADI_TEST_DATABASE_URL not set")


def second_channel(app, cohort_id):
    teacher = login(app, "teacher")
    return teacher.post(f"/hub/api/cohorts/{cohort_id}/channels", json={"slug": "homework", "name": "Homework"}, headers=ORIGIN).json()["id"]


def test_one_socket_receives_every_channel(hub):
    app, cohort_id, general = hub
    homework = second_channel(app, cohort_id)
    student, teacher = login(app, "student"), login(app, "teacher")
    with open_socket(student, cohort_id) as ws:
        post(teacher, cohort_id, general, "in general")
        post(teacher, cohort_id, homework, "in homework")
        first, second = receive(ws), receive(ws)
    assert (first["channel_id"], first["message"]["body"]) == (general, "in general")
    assert (second["channel_id"], second["message"]["channel_id"]) == (homework, homework)


def test_presence_lists_online_accounts(hub):
    # Each TestClient socket runs on its own event loop, so events sent across
    # clients can't wake a waiting receive; check what each newcomer is told
    # and the server's list instead. Cross-client delivery is checked in a browser.
    from app.hub.routes import _online
    app, cohort_id, _ = hub
    student, teacher = login(app, "student"), login(app, "teacher")
    ids = {a["username"]: a["id"] for a in login(app, "admin_user").get("/hub/api/accounts").json()}
    with open_socket(student, cohort_id) as student_ws:
        assert student_ws.receive_json() == {"type": "presence", "online": [ids["student"]]}
        with open_socket(teacher, cohort_id) as teacher_ws:
            both = sorted([ids["student"], ids["teacher"]])
            assert teacher_ws.receive_json() == {"type": "presence", "online": both}
            assert _online(cohort_id) == both
        assert _online(cohort_id) == [ids["student"]]
    assert _online(cohort_id) == []


def test_unread_counts_mentions_and_marking_read(hub):
    app, cohort_id, general = hub
    homework = second_channel(app, cohort_id)
    student, teacher = login(app, "student"), login(app, "teacher")
    url = f"/hub/api/cohorts/{cohort_id}/unread"
    post(teacher, cohort_id, general, "hello all")
    post(teacher, cohort_id, general, "@student please check")
    last = teacher.post(f"/hub/api/cohorts/{cohort_id}/channels/{homework}/messages", json={"body": "hw posted"}, headers=ORIGIN).json()["id"]
    post(student, cohort_id, general, "my own message doesn't count")
    counts = {c["channel_id"]: (c["unread"], c["mentions"]) for c in student.get(url).json()}
    assert counts == {general: (2, 1), homework: (1, 0)}

    assert student.post(f"/hub/api/cohorts/{cohort_id}/channels/{homework}/read", json={"message_id": last}, headers=ORIGIN).status_code == 204
    # Marking an older message later never moves the marker backwards.
    student.post(f"/hub/api/cohorts/{cohort_id}/channels/{homework}/read", json={"message_id": 0}, headers=ORIGIN)
    rows = {c["channel_id"]: c for c in student.get(url).json()}
    assert {k: v["unread"] for k, v in rows.items()} == {general: 2, homework: 0}
    assert (rows[homework]["last_read_id"], rows[general]["last_read_id"]) == (last, 0)


def test_mention_match_is_literal(hub):
    """An underscore in a username is not a LIKE wildcard."""
    app, cohort_id, general = hub
    admin, teacher = login(app, "admin_user"), login(app, "teacher")
    admin.post("/hub/api/accounts", json={"username": "kim_a", "display_name": "Kim A", "password": PASSWORD}, headers=ORIGIN)
    admin.post(f"/hub/api/cohorts/{cohort_id}/memberships", json={"username": "kim_a", "role": "student"}, headers=ORIGIN)
    post(teacher, cohort_id, general, "@kimXa is someone else")
    post(teacher, cohort_id, general, "@kim_a this one is you")
    counts = login(app, "kim_a").get(f"/hub/api/cohorts/{cohort_id}/unread").json()
    assert (counts[0]["unread"], counts[0]["mentions"]) == (2, 1)


def test_read_marker_needs_cohort_access(hub):
    app, cohort_id, general = hub
    admin = login(app, "admin_user")
    other = admin.post("/hub/api/cohorts", json={"slug": "other-2026", "name": "Other"}, headers=ORIGIN).json()["id"]
    student = login(app, "student")
    assert student.get(f"/hub/api/cohorts/{other}/unread").status_code == 403
    assert student.post(f"/hub/api/cohorts/{other}/channels/{general}/read", json={"message_id": 1}, headers=ORIGIN).status_code == 403
    assert student.post(f"/hub/api/cohorts/{cohort_id}/channels/999999/read", json={"message_id": 1}, headers=ORIGIN).status_code == 404

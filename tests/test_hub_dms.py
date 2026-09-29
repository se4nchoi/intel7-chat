"""Direct messages: private to their two members, scoped to a cohort."""
import pytest

from tests.test_hub_board_api import ORIGIN, PASSWORD, TEST_URL, hub, login, open_socket, receive  # noqa: F401

pytestmark = pytest.mark.skipif(not TEST_URL, reason="MADI_TEST_DATABASE_URL not set")


def ids(app):
    return {a["username"]: a["id"] for a in login(app, "admin_user").get("/hub/api/accounts").json()}


def open_dm(client, cohort_id, account_id):
    return client.post(f"/hub/api/cohorts/{cohort_id}/dms", json={"account_id": account_id}, headers=ORIGIN)


def test_dm_is_private_and_reused(hub):
    app, cohort_id, _ = hub
    who = ids(app)
    student, teacher, admin = login(app, "student"), login(app, "teacher"), login(app, "admin_user")
    dm = open_dm(student, cohort_id, who["teacher"]).json()
    assert dm["other_username"] == "teacher"
    assert open_dm(teacher, cohort_id, who["student"]).json()["id"] == dm["id"]  # same conversation both ways
    url = f"/hub/api/cohorts/{cohort_id}/channels/{dm['id']}/messages"
    assert student.post(url, json={"body": "선생님 질문 있어요"}, headers=ORIGIN).status_code == 201
    assert [m["body"] for m in teacher.get(url).json()] == ["선생님 질문 있어요"]
    # Not a channel, and invisible to everyone else, admins included.
    assert dm["id"] not in [c["id"] for c in student.get(f"/hub/api/cohorts/{cohort_id}/channels").json()]
    assert admin.get(url).status_code == 404
    admin.post("/hub/api/accounts", json={"username": "other", "display_name": "O", "password": PASSWORD}, headers=ORIGIN)
    admin.post(f"/hub/api/cohorts/{cohort_id}/memberships", json={"username": "other", "role": "student"}, headers=ORIGIN)
    other = login(app, "other")
    assert other.get(url).status_code == 404
    assert other.post(url, json={"body": "끼어들기"}, headers=ORIGIN).status_code == 404
    listed = teacher.get(f"/hub/api/cohorts/{cohort_id}/dms").json()
    assert [(d["id"], d["other_username"]) for d in listed] == [(dm["id"], "student")]
    assert other.get(f"/hub/api/cohorts/{cohort_id}/dms").json() == []


def test_dm_events_reach_only_members(hub):
    from app.hub import routes
    app, cohort_id, general = hub
    who = ids(app)
    student, teacher = login(app, "student"), login(app, "teacher")
    dm = open_dm(student, cohort_id, who["teacher"]).json()["id"]
    sent = []
    original = routes.WebSocket.send_json

    async def spy(self, data, mode="text"):
        sent.append((routes.connections[cohort_id].get(self), data))
        return await original(self, data, mode=mode)
    routes.WebSocket.send_json = spy
    try:
        with open_socket(student, cohort_id) as s_ws, open_socket(teacher, cohort_id):
            student.post(f"/hub/api/cohorts/{cohort_id}/channels/{dm}/messages", json={"body": "private"}, headers=ORIGIN)
            assert receive(s_ws)["channel_id"] == dm
    finally:
        routes.WebSocket.send_json = original
    receivers = {listener.account_id for listener, data in sent if data.get("type") == "message"}
    assert receivers == {who["student"], who["teacher"]}
    admin = login(app, "admin_user")
    with open_socket(admin, cohort_id):
        pass
    counts = {c["channel_id"] for c in admin.get(f"/hub/api/cohorts/{cohort_id}/unread").json()}
    assert dm not in counts and general in counts


def test_dm_rules(hub):
    app, cohort_id, general = hub
    who = ids(app)
    student, teacher, admin = login(app, "student"), login(app, "teacher"), login(app, "admin_user")
    assert open_dm(student, cohort_id, who["student"]).status_code == 400
    admin.post("/hub/api/accounts", json={"username": "outsider", "display_name": "X", "password": PASSWORD}, headers=ORIGIN)
    assert open_dm(student, cohort_id, ids(app)["outsider"]).status_code == 404  # not in this cohort
    dm = open_dm(student, cohort_id, who["teacher"]).json()["id"]
    url = f"/hub/api/cohorts/{cohort_id}/channels/{dm}/messages"
    mid = student.post(url, json={"body": "mine"}, headers=ORIGIN).json()["id"]
    # Instructors moderate channels, not private conversations.
    assert teacher.delete(f"{url}/{mid}", headers=ORIGIN).status_code == 403
    # Either member can pin in a DM; screen sharing is for channels only.
    assert student.post(f"{url}/{mid}/pin", json={"pinned": True}, headers=ORIGIN).status_code == 200
    assert student.post(f"/hub/api/cohorts/{cohort_id}/channels/{dm}/media-token", headers=ORIGIN).status_code == 404
    # Removed members lose the DM with the cohort.
    teacher.delete(f"/hub/api/cohorts/{cohort_id}/memberships/{who['student']}", headers=ORIGIN)
    assert student.get(url).status_code == 403
    # dm- slugs are reserved for DMs.
    assert teacher.post(f"/hub/api/cohorts/{cohort_id}/channels", json={"slug": "dm-1-2", "name": "Fake"}, headers=ORIGIN).status_code == 400


def test_dm_unread_counts_for_members(hub):
    app, cohort_id, _ = hub
    who = ids(app)
    student, teacher = login(app, "student"), login(app, "teacher")
    dm = open_dm(teacher, cohort_id, who["student"]).json()["id"]
    teacher.post(f"/hub/api/cohorts/{cohort_id}/channels/{dm}/messages", json={"body": "숙제 확인했어요"}, headers=ORIGIN)
    counts = {c["channel_id"]: c["unread"] for c in student.get(f"/hub/api/cohorts/{cohort_id}/unread").json()}
    assert counts[dm] == 1

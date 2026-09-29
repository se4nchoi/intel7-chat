"""마디 administration: accounts, passwords, cohort archive, membership removal."""

import pytest
from starlette.websockets import WebSocketDisconnect

from tests.test_hub_board_api import ORIGIN, PASSWORD, TEST_URL, hub, login, open_socket, post, receive  # noqa: F401

pytestmark = pytest.mark.skipif(not TEST_URL, reason="MADI_TEST_DATABASE_URL not set")


def account_id(app, username):
    admin = login(app, "admin_user")
    return next(a["id"] for a in admin.get("/hub/api/accounts").json() if a["username"] == username)


def assert_closed(ws):
    with pytest.raises(WebSocketDisconnect) as closed:
        receive(ws)
    assert closed.value.code == 1008


def test_only_admin_lists_accounts(hub):
    app, cohort_id, _ = hub
    assert login(app, "teacher").get("/hub/api/accounts").status_code == 403
    accounts = login(app, "admin_user").get("/hub/api/accounts").json()
    student = next(a for a in accounts if a["username"] == "student")
    assert student["active"] is True and student["memberships"] == [{"cohort_id": cohort_id, "role": "student"}]
    assert "password_hash" not in student


def test_disabling_account_ends_sessions_and_sockets(hub):
    app, cohort_id, channel_id = hub
    student, admin = login(app, "student"), login(app, "admin_user")
    sid = account_id(app, "student")
    with open_socket(student, cohort_id, channel_id) as ws:
        assert admin.patch(f"/hub/api/accounts/{sid}", json={"active": False}, headers=ORIGIN).json()["active"] is False
        assert_closed(ws)
    assert student.get("/hub/api/me").status_code == 401
    assert login_status(app, "student", PASSWORD) == 401
    admin.patch(f"/hub/api/accounts/{sid}", json={"active": True}, headers=ORIGIN)
    assert login_status(app, "student", PASSWORD) == 200


def test_admin_cannot_disable_self_and_others_cannot_disable(hub):
    app, _, _ = hub
    admin = login(app, "admin_user")
    assert admin.patch(f"/hub/api/accounts/{account_id(app, 'admin_user')}", json={"active": False}, headers=ORIGIN).status_code == 400
    teacher = login(app, "teacher")
    assert teacher.patch(f"/hub/api/accounts/{account_id(app, 'student')}", json={"active": False}, headers=ORIGIN).status_code == 403


def login_status(app, username, password):
    from fastapi.testclient import TestClient
    client = TestClient(app, base_url="https://testserver")
    return client.post("/hub/api/login", json={"username": username, "password": password}, headers=ORIGIN).status_code


def test_admin_password_reset_returns_temporary_password_once(hub):
    app, cohort_id, channel_id = hub
    student, admin = login(app, "student"), login(app, "admin_user")
    with open_socket(student, cohort_id, channel_id) as ws:
        reset = admin.post(f"/hub/api/accounts/{account_id(app, 'student')}/password", headers=ORIGIN).json()
        assert_closed(ws)
    temporary = reset["temporary_password"]
    assert len(temporary) == 12 and reset["username"] == "student"
    assert student.get("/hub/api/me").status_code == 401
    assert login_status(app, "student", PASSWORD) == 401
    assert login_status(app, "student", temporary) == 200
    assert admin.post(f"/hub/api/accounts/{account_id(app, 'admin_user')}/password", headers=ORIGIN).status_code == 400
    assert login(app, "teacher").post(f"/hub/api/accounts/{account_id(app, 'student')}/password", headers=ORIGIN).status_code == 403


def test_change_own_password_keeps_this_session_only(hub):
    app, cohort_id, channel_id = hub
    phone, laptop, teacher = login(app, "student"), login(app, "student"), login(app, "teacher")
    url = "/hub/api/me/password"
    assert laptop.post(url, json={"current_password": "wrong", "new_password": "brand-new-1"}, headers=ORIGIN).status_code == 400
    assert laptop.post(url, json={"current_password": PASSWORD, "new_password": "abc"}, headers=ORIGIN).status_code == 400
    with open_socket(phone, cohort_id, channel_id) as phone_ws, open_socket(laptop, cohort_id, channel_id) as laptop_ws:
        assert laptop.post(url, json={"current_password": PASSWORD, "new_password": "brand-new-1"}, headers=ORIGIN).status_code == 204
        assert_closed(phone_ws)
        post(teacher, cohort_id, channel_id, "still here")
        assert receive(laptop_ws)["message"]["body"] == "still here"
    assert laptop.get("/hub/api/me").status_code == 200
    assert phone.get("/hub/api/me").status_code == 401
    assert login_status(app, "student", "brand-new-1") == 200


def test_archive_and_reopen_cohort(hub):
    app, cohort_id, channel_id = hub
    admin, teacher = login(app, "admin_user"), login(app, "teacher")
    assert teacher.patch(f"/hub/api/cohorts/{cohort_id}", json={"archived": True}, headers=ORIGIN).status_code == 403
    assert admin.patch(f"/hub/api/cohorts/{cohort_id}", json={"archived": True}, headers=ORIGIN).json()["archived"] is True
    url = f"/hub/api/cohorts/{cohort_id}/channels/{channel_id}/messages"
    assert teacher.post(url, json={"body": "closed?"}, headers=ORIGIN).status_code == 403
    assert teacher.get(url).status_code == 200  # history stays readable
    assert admin.patch(f"/hub/api/cohorts/{cohort_id}", json={"archived": False}, headers=ORIGIN).json()["archived"] is False
    assert teacher.post(url, json={"body": "open again"}, headers=ORIGIN).status_code == 201
    assert admin.patch("/hub/api/cohorts/999999", json={"archived": True}, headers=ORIGIN).status_code == 404


def test_instructor_removes_student_immediately(hub):
    app, cohort_id, channel_id = hub
    student, teacher = login(app, "student"), login(app, "teacher")
    sid = account_id(app, "student")
    with open_socket(student, cohort_id, channel_id) as ws:
        assert teacher.delete(f"/hub/api/cohorts/{cohort_id}/memberships/{sid}", headers=ORIGIN).status_code == 204
        assert_closed(ws)
    assert student.get(f"/hub/api/cohorts/{cohort_id}/channels").status_code == 403
    assert student.get("/hub/api/me").status_code == 200  # still logged in, just not in this cohort
    members = teacher.get(f"/hub/api/cohorts/{cohort_id}/members").json()
    assert "student" not in [m["username"] for m in members]
    assert teacher.delete(f"/hub/api/cohorts/{cohort_id}/memberships/{sid}", headers=ORIGIN).status_code == 404


def test_membership_removal_permissions(hub):
    app, cohort_id, _ = hub
    teacher, student, admin = login(app, "teacher"), login(app, "student"), login(app, "admin_user")
    tid, sid = account_id(app, "teacher"), account_id(app, "student")
    assert student.delete(f"/hub/api/cohorts/{cohort_id}/memberships/{tid}", headers=ORIGIN).status_code == 403
    assert teacher.delete(f"/hub/api/cohorts/{cohort_id}/memberships/{tid}", headers=ORIGIN).status_code == 400
    admin.post("/hub/api/accounts", json={"username": "teacher2", "display_name": "T2", "password": PASSWORD}, headers=ORIGIN)
    admin.post(f"/hub/api/cohorts/{cohort_id}/memberships", json={"username": "teacher2", "role": "instructor"}, headers=ORIGIN)
    t2 = account_id(app, "teacher2")
    assert teacher.delete(f"/hub/api/cohorts/{cohort_id}/memberships/{t2}", headers=ORIGIN).status_code == 403
    assert admin.delete(f"/hub/api/cohorts/{cohort_id}/memberships/{t2}", headers=ORIGIN).status_code == 204
    # Re-adding restores access.
    assert teacher.delete(f"/hub/api/cohorts/{cohort_id}/memberships/{sid}", headers=ORIGIN).status_code == 204
    teacher.post(f"/hub/api/cohorts/{cohort_id}/memberships", json={"username": "student", "role": "student"}, headers=ORIGIN)
    assert student.get(f"/hub/api/cohorts/{cohort_id}/channels").status_code == 200

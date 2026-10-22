"""Permission-scoped, paginated search of channel and DM messages."""
import pytest

from tests.test_hub_board_api import ORIGIN, TEST_URL, hub, login  # noqa: F401

pytestmark = pytest.mark.skipif(not TEST_URL, reason="MADI_TEST_DATABASE_URL not set")


def search_url(cohort_id, channel_id):
    return f"/hub/api/cohorts/{cohort_id}/channels/{channel_id}/messages/search"


def message_url(cohort_id, channel_id):
    return f"/hub/api/cohorts/{cohort_id}/channels/{channel_id}/messages"


def test_channel_search_is_literal_paginated_and_excludes_deleted(hub):
    app, cohort_id, channel_id = hub
    student, teacher = login(app, "student"), login(app, "teacher")
    messages = message_url(cohort_id, channel_id)
    search = search_url(cohort_id, channel_id)
    for number in range(34):
        response = teacher.post(messages, json={"body": f"PLC step {number:02d}"}, headers=ORIGIN)
        assert response.status_code == 201
    unrelated = teacher.post(messages, json={"body": "PLC_step underscore"}, headers=ORIGIN).json()
    first = student.get(search, params={"q": "PLC step"})
    assert first.status_code == 200
    page = first.json()
    assert len(page["items"]) == 30 and page["has_more"]
    assert page["next_before"] == page["items"][-1]["id"]
    assert [item["body"] for item in page["items"][:2]] == ["PLC step 33", "PLC step 32"]
    second = student.get(search, params={"q": "PLC step", "before": page["next_before"]}).json()
    assert len(second["items"]) == 4 and not second["has_more"] and second["next_before"] is None
    assert {item["id"] for item in page["items"]}.isdisjoint(item["id"] for item in second["items"])
    assert [item["id"] for item in student.get(search, params={"q": "PLC_step"}).json()["items"]] == [unrelated["id"]]
    assert student.get(search, params={"q": "%"}).status_code == 400
    assert [item["id"] for item in student.get(search, params={"q": "_%"}).json()["items"]] == []
    deleted = page["items"][0]["id"]
    assert teacher.delete(f"{messages}/{deleted}", headers=ORIGIN).status_code == 204
    assert deleted not in {item["id"] for item in student.get(search, params={"q": "PLC step"}).json()["items"]}


def test_search_is_scoped_to_channel_dm_and_active_membership(hub):
    app, cohort_id, general = hub
    admin, student, teacher = login(app, "admin_user"), login(app, "student"), login(app, "teacher")
    accounts = {account["username"]: account["id"] for account in admin.get("/hub/api/accounts").json()}
    other = teacher.post(f"/hub/api/cohorts/{cohort_id}/channels", json={"slug": "other", "name": "Other"}, headers=ORIGIN).json()["id"]
    dm = student.post(f"/hub/api/cohorts/{cohort_id}/dms", json={"account_id": accounts["teacher"]}, headers=ORIGIN).json()["id"]
    for channel_id in (general, other, dm):
        assert student.post(message_url(cohort_id, channel_id), json={"body": f"lesson {channel_id}"}, headers=ORIGIN).status_code == 201
    for channel_id in (general, other, dm):
        own = student.get(search_url(cohort_id, channel_id), params={"q": "lesson"}).json()["items"]
        assert [item["body"] for item in own] == [f"lesson {channel_id}"]
    assert teacher.get(search_url(cohort_id, dm), params={"q": "lesson"}).status_code == 200
    assert admin.get(search_url(cohort_id, dm), params={"q": "lesson"}).status_code == 404
    assert student.get(search_url(cohort_id, general), params={"q": " "}).status_code == 400
    assert student.get(search_url(cohort_id, general), params={"q": "lesson", "before": 0}).status_code == 422
    assert teacher.delete(f"/hub/api/cohorts/{cohort_id}/memberships/{accounts['student']}", headers=ORIGIN).status_code == 204
    assert student.get(search_url(cohort_id, general), params={"q": "lesson"}).status_code == 403
    assert student.get(search_url(cohort_id, dm), params={"q": "lesson"}).status_code == 403

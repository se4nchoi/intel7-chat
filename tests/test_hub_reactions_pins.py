"""Emoji reactions and pinned messages."""
import pytest

from tests.test_hub_board_api import ORIGIN, TEST_URL, hub, login, open_socket, post, receive  # noqa: F401

pytestmark = pytest.mark.skipif(not TEST_URL, reason="MADI_TEST_DATABASE_URL not set")


def setup(hub):
    app, cohort_id, channel_id = hub
    student, teacher = login(app, "student"), login(app, "teacher")
    url = f"/hub/api/cohorts/{cohort_id}/channels/{channel_id}/messages"
    mid = teacher.post(url, json={"body": "시험은 금요일"}, headers=ORIGIN).json()["id"]
    return app, cohort_id, channel_id, student, teacher, url, mid


def test_reactions_toggle_and_broadcast(hub):
    app, cohort_id, channel_id, student, teacher, url, mid = setup(hub)
    ids = {a["username"]: a["id"] for a in login(app, "admin_user").get("/hub/api/accounts").json()}
    with open_socket(teacher, cohort_id) as ws:
        reactions = student.post(f"{url}/{mid}/reactions", json={"emoji": "👍"}, headers=ORIGIN).json()
        event = receive(ws)
    assert reactions == [{"emoji": "👍", "accounts": [ids["student"]]}]
    assert event == {"type": "reactions", "channel_id": channel_id, "message_id": mid, "reactions": reactions}
    teacher.post(f"{url}/{mid}/reactions", json={"emoji": "👍"}, headers=ORIGIN)
    teacher.post(f"{url}/{mid}/reactions", json={"emoji": "✅"}, headers=ORIGIN)
    listed = next(m for m in student.get(url).json() if m["id"] == mid)["reactions"]
    assert listed == [{"emoji": "👍", "accounts": [ids["student"], ids["teacher"]]}, {"emoji": "✅", "accounts": [ids["teacher"]]}]
    # Toggling again removes only your own reaction.
    assert student.post(f"{url}/{mid}/reactions", json={"emoji": "👍"}, headers=ORIGIN).json()[0] == {"emoji": "👍", "accounts": [ids["teacher"]]}


def test_reaction_validation(hub):
    app, cohort_id, channel_id, student, teacher, url, mid = setup(hub)
    assert student.post(f"{url}/{mid}/reactions", json={"emoji": "<script>"}, headers=ORIGIN).status_code == 400
    assert student.post(f"{url}/999999/reactions", json={"emoji": "👍"}, headers=ORIGIN).status_code == 404
    teacher.delete(f"{url}/{mid}", headers=ORIGIN)
    assert student.post(f"{url}/{mid}/reactions", json={"emoji": "👍"}, headers=ORIGIN).status_code == 404


def test_only_managers_pin_and_pins_are_listed(hub):
    app, cohort_id, channel_id, student, teacher, url, mid = setup(hub)
    pins = f"/hub/api/cohorts/{cohort_id}/channels/{channel_id}/pins"
    assert student.post(f"{url}/{mid}/pin", json={"pinned": True}, headers=ORIGIN).status_code == 403
    with open_socket(student, cohort_id) as ws:
        pinned = teacher.post(f"{url}/{mid}/pin", json={"pinned": True}, headers=ORIGIN).json()
        event = receive(ws)
    assert pinned["pinned_at"] and event["type"] == "message_pinned" and event["message"]["id"] == mid
    assert [m["id"] for m in student.get(pins).json()] == [mid]
    teacher.post(f"{url}/{mid}/pin", json={"pinned": False}, headers=ORIGIN)
    assert student.get(pins).json() == []
    teacher.post(f"{url}/{mid}/pin", json={"pinned": True}, headers=ORIGIN)
    teacher.delete(f"{url}/{mid}", headers=ORIGIN)
    assert student.get(pins).json() == []  # deleted messages drop off the pin list

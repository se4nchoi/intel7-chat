"""Editing posts: authors only, live update for chat, previous versions kept."""
import pytest

from tests.test_hub_board_api import ORIGIN, TEST_URL, hub, login, open_socket, receive  # noqa: F401

pytestmark = pytest.mark.skipif(not TEST_URL, reason="MADI_TEST_DATABASE_URL not set")


def history(db, kind, item_id):
    with db.connect() as conn:
        return conn.execute("""SELECT previous_title, previous_body FROM hub_edit_history
                               WHERE kind=%s AND item_id=%s ORDER BY id""", (kind, item_id)).fetchall()


def test_author_edits_message_and_listeners_see_it(hub):
    from app.hub import db
    app, cohort_id, channel_id = hub
    student, teacher = login(app, "student"), login(app, "teacher")
    url = f"/hub/api/cohorts/{cohort_id}/channels/{channel_id}/messages"
    mid = student.post(url, json={"body": "teh answer"}, headers=ORIGIN).json()["id"]
    with open_socket(teacher, cohort_id) as ws:
        edited = student.patch(f"{url}/{mid}", json={"body": "the answer"}, headers=ORIGIN).json()
        event = receive(ws)
    assert edited["body"] == "the answer" and edited["edited_at"]
    assert event == {"type": "message_edited", "channel_id": channel_id, "message": edited}
    assert teacher.get(url).json()[-1]["edited_at"]
    assert history(db, "message", mid) == [{"previous_title": None, "previous_body": "teh answer"}]


def test_only_author_can_edit_even_instructors_cannot(hub):
    app, cohort_id, channel_id = hub
    student, teacher = login(app, "student"), login(app, "teacher")
    url = f"/hub/api/cohorts/{cohort_id}/channels/{channel_id}/messages"
    mid = student.post(url, json={"body": "mine"}, headers=ORIGIN).json()["id"]
    assert teacher.patch(f"{url}/{mid}", json={"body": "rewritten"}, headers=ORIGIN).status_code == 403
    assert student.patch(f"{url}/{mid}", json={"body": "   "}, headers=ORIGIN).status_code == 400
    student.delete(f"{url}/{mid}", headers=ORIGIN)
    assert student.patch(f"{url}/{mid}", json={"body": "back?"}, headers=ORIGIN).status_code == 404


def test_edit_question_and_answer_keep_history(hub):
    from app.hub import db
    app, cohort_id, _ = hub
    student, teacher = login(app, "student"), login(app, "teacher")
    base = f"/hub/api/cohorts/{cohort_id}/questions"
    qid = student.post(base, json={"title": "Q?", "body": "first"}, headers=ORIGIN).json()["id"]
    assert student.patch(f"{base}/{qid}", json={"title": "Q!", "body": "second"}, headers=ORIGIN).status_code == 204
    assert teacher.patch(f"{base}/{qid}", json={"title": "x", "body": "y"}, headers=ORIGIN).status_code == 403
    q = student.get(base).json()[0]
    assert (q["title"], q["body"], bool(q["edited_at"])) == ("Q!", "second", True)
    assert history(db, "question", qid) == [{"previous_title": "Q?", "previous_body": "first"}]

    aid = teacher.post(f"{base}/{qid}/answers", json={"body": "v1"}, headers=ORIGIN).json()["id"]
    assert teacher.patch(f"{base}/{qid}/answers/{aid}", json={"body": "v2"}, headers=ORIGIN).status_code == 204
    assert student.patch(f"{base}/{qid}/answers/{aid}", json={"body": "hijack"}, headers=ORIGIN).status_code == 403
    answer = student.get(f"{base}/{qid}/answers").json()[0]
    assert (answer["body"], bool(answer["edited_at"])) == ("v2", True)


def test_archived_cohort_blocks_editing(hub):
    app, cohort_id, channel_id = hub
    student, admin = login(app, "student"), login(app, "admin_user")
    url = f"/hub/api/cohorts/{cohort_id}/channels/{channel_id}/messages"
    mid = student.post(url, json={"body": "before"}, headers=ORIGIN).json()["id"]
    admin.patch(f"/hub/api/cohorts/{cohort_id}", json={"archived": True}, headers=ORIGIN)
    assert student.patch(f"{url}/{mid}", json={"body": "after"}, headers=ORIGIN).status_code == 403

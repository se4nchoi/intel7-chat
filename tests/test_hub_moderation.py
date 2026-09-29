"""마디 moderation: soft-deleting messages, questions and answers."""
import pytest

from tests.test_hub_board_api import ORIGIN, TEST_URL, hub, login, open_socket, post, receive  # noqa: F401

pytestmark = pytest.mark.skipif(not TEST_URL, reason="MADI_TEST_DATABASE_URL not set")


def messages_url(cohort_id, channel_id):
    return f"/hub/api/cohorts/{cohort_id}/channels/{channel_id}/messages"


def test_author_deletes_own_message_and_listeners_are_told(hub):
    app, cohort_id, channel_id = hub
    student, teacher = login(app, "student"), login(app, "teacher")
    url = messages_url(cohort_id, channel_id)
    mine = student.post(url, json={"body": "oops"}, headers=ORIGIN).json()["id"]
    kept = student.post(url, json={"body": "keep"}, headers=ORIGIN).json()["id"]
    with open_socket(teacher, cohort_id, channel_id) as ws:
        assert student.delete(f"{url}/{mine}", headers=ORIGIN).status_code == 204
        assert receive(ws) == {"type": "message_deleted", "channel_id": channel_id, "id": mine}
    assert [m["id"] for m in teacher.get(url).json()] == [kept]
    assert teacher.get(url, params={"after": 0}).json()[0]["id"] == kept
    assert student.delete(f"{url}/{mine}", headers=ORIGIN).status_code == 404  # already gone


def test_students_cannot_delete_others_but_instructors_can(hub):
    app, cohort_id, channel_id = hub
    student, teacher = login(app, "student"), login(app, "teacher")
    url = messages_url(cohort_id, channel_id)
    theirs = teacher.post(url, json={"body": "teacher says"}, headers=ORIGIN).json()["id"]
    rude = student.post(url, json={"body": "rude"}, headers=ORIGIN).json()["id"]
    assert student.delete(f"{url}/{theirs}", headers=ORIGIN).status_code == 403
    assert teacher.delete(f"{url}/{rude}", headers=ORIGIN).status_code == 204
    assert login(app, "admin_user").delete(f"{url}/{theirs}", headers=ORIGIN).status_code == 204
    assert teacher.get(url).json() == []


def test_deleted_text_is_kept_for_the_record(hub):
    from app.hub import db
    app, cohort_id, channel_id = hub
    teacher = login(app, "teacher")
    url = messages_url(cohort_id, channel_id)
    mid = login(app, "student").post(url, json={"body": "evidence"}, headers=ORIGIN).json()["id"]
    teacher.delete(f"{url}/{mid}", headers=ORIGIN)
    with db.connect() as conn:
        row = conn.execute("""SELECT m.body, a.username AS deleted_by FROM hub_messages m
                              JOIN hub_accounts a ON a.id=m.deleted_by WHERE m.id=%s""", (mid,)).fetchone()
    assert row == {"body": "evidence", "deleted_by": "teacher"}


def test_question_and_answer_deletion(hub):
    app, cohort_id, _ = hub
    student, teacher = login(app, "student"), login(app, "teacher")
    base = f"/hub/api/cohorts/{cohort_id}/questions"
    qid = student.post(base, json={"title": "Q", "body": "why?"}, headers=ORIGIN).json()["id"]
    mine = student.post(f"{base}/{qid}/answers", json={"body": "maybe"}, headers=ORIGIN).json()["id"]
    official = teacher.post(f"{base}/{qid}/answers", json={"body": "because"}, headers=ORIGIN).json()["id"]
    teacher.post(f"{base}/{qid}/answers/{official}/endorse", json={"endorsed": True}, headers=ORIGIN)

    assert student.delete(f"{base}/{qid}/answers/{official}", headers=ORIGIN).status_code == 403
    assert student.delete(f"{base}/{qid}/answers/{mine}", headers=ORIGIN).status_code == 204
    summary = student.get(base).json()[0]
    assert (summary["answer_count"], summary["endorsed"]) == (1, True)
    assert teacher.delete(f"{base}/{qid}/answers/{official}", headers=ORIGIN).status_code == 204
    summary = student.get(base).json()[0]
    assert (summary["answer_count"], summary["endorsed"], summary["instructor_answered"]) == (0, False, False)
    assert teacher.post(f"{base}/{qid}/answers/{official}/endorse", json={"endorsed": True}, headers=ORIGIN).status_code == 404

    other = teacher.post(base, json={"title": "T", "body": "notice"}, headers=ORIGIN).json()["id"]
    assert student.delete(f"{base}/{other}", headers=ORIGIN).status_code == 403
    assert student.delete(f"{base}/{qid}", headers=ORIGIN).status_code == 204
    assert [q["id"] for q in student.get(base).json()] == [other]
    assert student.get(f"{base}/{qid}/answers").status_code == 404
    assert student.post(f"{base}/{qid}/answers", json={"body": "late"}, headers=ORIGIN).status_code == 404


def test_archived_cohort_blocks_deletion(hub):
    app, cohort_id, channel_id = hub
    teacher, admin = login(app, "teacher"), login(app, "admin_user")
    url = messages_url(cohort_id, channel_id)
    mid = teacher.post(url, json={"body": "archived"}, headers=ORIGIN).json()["id"]
    admin.patch(f"/hub/api/cohorts/{cohort_id}", json={"archived": True}, headers=ORIGIN)
    assert teacher.delete(f"{url}/{mid}", headers=ORIGIN).status_code == 403

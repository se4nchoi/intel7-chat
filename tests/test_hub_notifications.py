"""Notification durability, target privacy, follow opt-outs and read isolation."""
import os

import pytest

from tests.test_hub_board_api import hub, login, ORIGIN, PASSWORD, open_socket, receive

pytestmark = pytest.mark.skipif(not os.environ.get('MADI_TEST_DATABASE_URL'), reason='MADI_TEST_DATABASE_URL not set')


def question(client, cid):
    response = client.post(f'/hub/api/cohorts/{cid}/questions', json={'title': 'Help with loops', 'body': 'Example question'}, headers=ORIGIN)
    assert response.status_code == 201, response.text
    return response.json()['id']


def answer(client, cid, qid, body='An answer'):
    response = client.post(f'/hub/api/cohorts/{cid}/questions/{qid}/answers', json={'body': body}, headers=ORIGIN)
    assert response.status_code == 201, response.text
    return response.json()['id']


def message(client, cid, channel, body):
    response = client.post(f'/hub/api/cohorts/{cid}/channels/{channel}/messages', json={'body': body}, headers=ORIGIN)
    assert response.status_code == 201, response.text
    return response.json()['id']


def follow(client, cid, qid, following):
    return client.put(f'/hub/api/cohorts/{cid}/questions/{qid}/follow', json={'following': following}, headers=ORIGIN)


def alerts(client, **params):
    response = client.get('/hub/api/notifications', params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_authors_and_answer_participants_follow_without_self_notifications(hub):
    app, cid, _ = hub
    student, teacher = login(app, 'student'), login(app, 'teacher')
    qid = question(student, cid)
    assert student.get(f'/hub/api/cohorts/{cid}/questions/{qid}/follow').json() == {'following': True}
    assert teacher.get(f'/hub/api/cohorts/{cid}/questions/{qid}/follow').json() == {'following': False}
    answer(student, cid, qid)
    assert alerts(student)['unread_total'] == 0
    aid = answer(teacher, cid, qid, 'Teacher response')
    notification = alerts(student)['items'][0]
    assert notification['kind'] == 'answer' and notification['question_id'] == qid
    assert notification['answer_id'] == aid and notification['excerpt'] == 'Teacher response'
    assert notification['question_title'] == 'Help with loops'
    assert alerts(teacher)['unread_total'] == 0
    answer(student, cid, qid, 'Follow up')
    assert alerts(teacher)['unread_total'] == 1
    assert alerts(student)['unread_total'] == 1


def test_unfollow_persists_when_author_replies_and_can_be_reenabled(hub):
    app, cid, _ = hub
    student, teacher = login(app, 'student'), login(app, 'teacher')
    qid = question(student, cid)
    assert follow(student, cid, qid, False).json() == {'following': False}
    answer(student, cid, qid)
    answer(teacher, cid, qid)
    assert alerts(student)['unread_total'] == 0
    assert follow(student, cid, qid, True).status_code == 200
    answer(teacher, cid, qid)
    assert alerts(student)['unread_total'] == 1


def test_other_members_can_follow_but_wrong_cohort_origin_and_archive_are_blocked(hub):
    from app.hub import db
    app, cid, _ = hub
    student, teacher = login(app, 'student'), login(app, 'teacher')
    qid = question(student, cid)
    assert follow(teacher, cid, qid, True).status_code == 200
    answer(student, cid, qid)
    assert alerts(teacher)['total'] == 1
    assert teacher.put(f'/hub/api/cohorts/{cid}/questions/{qid}/follow', json={'following': False}, headers={'origin': 'https://wrong.test'}).status_code == 403
    other = db.create_cohort('private-notices', 'Private')
    assert student.get(f'/hub/api/cohorts/{other["id"]}/questions/{qid}/follow').status_code == 403
    with db.connect() as conn:
        conn.execute('UPDATE hub_cohorts SET archived=TRUE WHERE id=%s', (cid,))
    assert follow(teacher, cid, qid, False).status_code == 403
    assert teacher.get(f'/hub/api/cohorts/{cid}/questions/{qid}/follow').json()['following'] is True


def test_mentions_are_exact_normalized_deduplicated_and_ignore_code_links_and_email(hub):
    from app.hub import db, notifications
    app, cid, channel = hub
    teacher, student = login(app, 'teacher'), login(app, 'student')
    for body in ['@student_long', 'email@student', '`@student`', '```python\n@student\n```', 'https://example.test/@student']:
        message(teacher, cid, channel, body)
    assert alerts(student)['total'] == 0
    mid = message(teacher, cid, channel, '@STUDENT @ＳＴＵＤＥＮＴ @student, come here!')
    notices = alerts(student)
    assert notices['total'] == 1 and notices['items'][0]['message_id'] == mid
    message(student, cid, channel, '@student self')
    assert alerts(student)['total'] == 1
    assert notifications.mentioned_usernames('@김학생 @kim_a @kim-a @kim.a') == {'김학생', 'kim_a', 'kim-a', 'kim.a'}
    new = db.create_account('김학생', '김학생', PASSWORD)
    db.add_membership(cid, '김학생', 'student')
    message(teacher, cid, channel, '@김학생 확인해 주세요')
    assert alerts(login(app, '김학생'))['total'] == 1


def test_dm_mentions_do_not_leak_to_admins_or_nonparticipants(hub):
    from app.hub import db
    app, cid, _ = hub
    teacher, student, admin = login(app, 'teacher'), login(app, 'student'), login(app, 'admin_user')
    tid = db.authenticate('teacher', PASSWORD)['id']
    dm = student.post(f'/hub/api/cohorts/{cid}/dms', json={'account_id': tid}, headers=ORIGIN).json()['id']
    message(student, cid, dm, '@teacher @admin_user hello')
    assert alerts(teacher)['total'] == 1
    assert alerts(admin)['total'] == 0
    item = alerts(teacher)['items'][0]
    assert item['channel_id'] == dm and item['channel_kind'] == 'dm'
    assert admin.post(f'/hub/api/notifications/{item["id"]}/read', json={'read': True}, headers=ORIGIN).status_code == 404


def test_lost_access_inactive_recipients_and_deleted_targets_hide_alerts_and_counts(hub):
    from app.hub import db
    app, cid, channel = hub
    teacher, student = login(app, 'teacher'), login(app, 'student')
    qid = question(student, cid)
    aid = answer(teacher, cid, qid)
    mid = message(teacher, cid, channel, '@student check')
    assert alerts(student)['unread_total'] == 2
    with db.connect() as conn:
        conn.execute('UPDATE hub_answers SET deleted_at=now() WHERE id=%s', (aid,))
        conn.execute('UPDATE hub_messages SET deleted_at=now() WHERE id=%s', (mid,))
    assert alerts(student)['total'] == 0
    answer(teacher, cid, qid)
    item = alerts(student)['items'][0]
    sid = db.authenticate('student', PASSWORD)['id']
    with db.connect() as conn:
        conn.execute('UPDATE hub_memberships SET active=FALSE WHERE account_id=%s AND cohort_id=%s', (sid, cid))
    assert alerts(student)['unread_total'] == 0
    assert student.get('/hub/api/notifications/unread').json() == {'unread_total': 0}
    assert student.post(f'/hub/api/notifications/{item["id"]}/read', json={'read': True}, headers=ORIGIN).status_code == 404
    answer(teacher, cid, qid)
    with db.connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM hub_notifications WHERE account_id=%s', (sid,)).fetchone()['n'] == 3


def test_reads_are_personal_persistent_and_separate_from_chat_read_markers(hub):
    app, cid, channel = hub
    teacher, student = login(app, 'teacher'), login(app, 'student')
    mid = message(teacher, cid, channel, '@student check')
    notice = alerts(student)['items'][0]
    endpoint = f'/hub/api/notifications/{notice["id"]}/read'
    assert teacher.post(endpoint, json={'read': True}, headers=ORIGIN).status_code == 404
    student.post(f'/hub/api/cohorts/{cid}/channels/{channel}/read', json={'message_id': mid}, headers=ORIGIN)
    assert alerts(student)['unread_total'] == 1
    assert student.post(endpoint, json={'read': True}, headers=ORIGIN).status_code == 204
    assert alerts(student, unread_only=True)['items'] == []
    assert alerts(login(app, 'student'))['items'][0]['read_at'] is not None
    assert student.post(endpoint, json={'read': False}, headers=ORIGIN).status_code == 204
    assert alerts(student)['unread_total'] == 1
    assert student.post(endpoint, json={'read': True}, headers={'origin': 'https://wrong.test'}).status_code == 403


def test_notification_pages_and_read_all_cutoff_do_not_swallow_new_alerts(hub):
    from app.hub import db
    app, cid, channel = hub
    teacher, student = login(app, 'teacher'), login(app, 'student')
    tid = db.authenticate('teacher', PASSWORD)['id']
    for n in range(65):
        db.add_message(channel, tid, f'@student message {n}')
    page, ids = alerts(student), []
    cutoff = page['items'][0]['id']
    while True:
        ids.extend(n['id'] for n in page['items'])
        if not page['has_more']:
            break
        page = alerts(student, before=page['next_before'])
    assert len(ids) == len(set(ids)) == 65
    message(teacher, cid, channel, '@student arrived later')
    assert student.post('/hub/api/notifications/read-all', json={'through_id': cutoff}, headers=ORIGIN).status_code == 204
    remaining = alerts(student, unread_only=True)
    assert remaining['total'] == remaining['unread_total'] == 1
    assert remaining['items'][0]['id'] > cutoff


def test_read_changes_refresh_only_the_readers_other_sockets(hub):
    from app.hub import routes
    app, cid, channel = hub
    teacher, student = login(app, 'teacher'), login(app, 'student')
    message(teacher, cid, channel, '@student check')
    notice = alerts(student)['items'][0]
    sent = []
    original = routes.WebSocket.send_json
    async def spy(self, data, mode='text'):
        sent.append((routes.connections[cid].get(self), data))
        return await original(self, data, mode=mode)
    routes.WebSocket.send_json = spy
    try:
        with open_socket(student, cid) as ws, open_socket(teacher, cid):
            sent.clear()
            assert student.post(f'/hub/api/notifications/{notice["id"]}/read', json={'read': True}, headers=ORIGIN).status_code == 204
            assert receive(ws)['type'] == 'notifications_changed'
            deliveries = [(listener, data) for listener, data in sent if data['type'] == 'notifications_changed']
            assert len(deliveries) == 1
    finally:
        routes.WebSocket.send_json = original


def test_notifications_and_posts_commit_or_rollback_together(hub, monkeypatch):
    from app.hub import db, notifications
    app, cid, channel = hub
    teacher = login(app, 'teacher')
    def fail(*args):
        raise RuntimeError('simulated notification failure')
    monkeypatch.setattr(notifications, 'message_created', fail)
    with pytest.raises(RuntimeError, match='simulated'):
        message(teacher, cid, channel, '@student rollback')
    assert db.messages(channel) == []


def test_inactive_and_nonmember_recipients_receive_nothing_and_question_deletion_hides_alerts(hub):
    from app.hub import db
    app, cid, channel = hub
    student, teacher = login(app, 'student'), login(app, 'teacher')
    waiting = db.create_account('unassigned_user', 'Waiting', PASSWORD)
    inactive = db.create_account('inactive_user', 'Inactive', PASSWORD)
    db.add_membership(cid, 'inactive_user', 'student')
    db.set_account_active(inactive['id'], False)
    message(teacher, cid, channel, '@unassigned_user @inactive_user check')
    with db.connect() as conn:
        assert conn.execute('SELECT count(*) AS n FROM hub_notifications WHERE account_id=ANY(%s)', ([waiting['id'], inactive['id']],)).fetchone()['n'] == 0
    qid = question(student, cid)
    answer(teacher, cid, qid)
    assert alerts(student)['unread_total'] == 1
    assert teacher.delete(f'/hub/api/cohorts/{cid}/questions/{qid}', headers=ORIGIN).status_code == 204
    assert alerts(student)['total'] == alerts(student)['unread_total'] == 0


def test_migration_follows_existing_questions_and_answers_without_historical_alerts(hub):
    from app.hub import db, notifications
    from tests.hub_reset import drop_hub_tables
    drop_hub_tables(db)
    migrations = db.available_migrations()
    db.migrate(migrations[:10])
    author = db.create_account('old_author', 'Author', PASSWORD)
    participant = db.create_account('old_participant', 'Participant', PASSWORD)
    cohort = db.create_cohort('old-class', 'Existing class')
    db.add_membership(cohort['id'], 'old_author', 'student')
    db.add_membership(cohort['id'], 'old_participant', 'student')
    with db.connect() as conn:
        qid = conn.execute('INSERT INTO hub_questions(cohort_id,author_id,title,body) VALUES(%s,%s,%s,%s) RETURNING id', (cohort['id'], author['id'], 'Existing', 'Body')).fetchone()['id']
        conn.execute('INSERT INTO hub_answers(question_id,author_id,body) VALUES(%s,%s,%s)', (qid, participant['id'], 'Earlier answer'))
    assert db.migrate() == [11]
    assert notifications.following(qid, author['id'])['following'] is True
    assert notifications.following(qid, participant['id'])['following'] is True
    assert notifications.page(db.authenticate('old_author', PASSWORD))['total'] == 0

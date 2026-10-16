"""Student consent queue, tab-scoped approval and isolated presenter handoffs."""
from concurrent.futures import ThreadPoolExecutor

import jwt
import pytest

from app.hub import db
from tests.test_hub_classroom_media import hub, setup, SECRET1


@pytest.fixture
def session(hub):
    client, actor, teacher, student, other, cohort, channel, path = setup(hub)
    second = db.create_account('student_two', 'Student Two', 'test-pass-1234')
    second['is_admin'] = False
    db.add_membership(cohort['id'], second['username'], 'student')
    lease = client.post(path+'/media-session', json={'classroom_id':'lab-1'}).json()
    base = path+'/media-session/'+lease['session']['id']
    return client, actor, teacher, student, second, other, path, base, lease


def token(client, path, **credentials):
    response = client.post(path+'/media-token', json=credentials)
    assert response.status_code == 200
    data = response.json()
    payload = jwt.decode(data['token'], SECRET1, algorithms=['HS256'])
    assert payload['video']['canPublish'] is data['can_publish']
    if data['can_publish']: assert payload['video']['canPublishSources'] == ['screen_share']
    return data


def request(client, actor, student, base):
    actor['current'] = student
    response = client.post(base+'/requests')
    assert response.status_code == 201
    return response.json()


def decide(client, actor, teacher, base, lease, requested, action='approve'):
    actor['current'] = teacher
    return client.post(base+'/requests/'+str(requested['request']['id']), json={
        'action':action, 'control_token':lease['control_token'],
    })


def test_multiple_requests_approval_handoff_and_revoke_rotate_the_room(session):
    client, actor, teacher, student, second, other, path, base, lease = session
    initial = token(client, path, control_token=lease['control_token'])
    one = request(client, actor, student, base)
    assert not token(client, path, request_token=one['request_token'])['can_publish']
    assert client.post(base+'/requests').status_code == 409
    two = request(client, actor, second, base)
    state = client.get(path+'/media-session').json()
    assert len(state['requests']) == 1 and state['requests'][0]['account_id'] == second['id']
    assert one['request_token'] not in str(state)
    actor['current'] = teacher
    assert len(client.get(path+'/media-session').json()['requests']) == 2
    assert decide(client, actor, teacher, base, lease, one).status_code == 200
    assert not token(client, path, control_token=lease['control_token'])['can_publish']
    actor['current'] = student
    approved = token(client, path, request_token=one['request_token'])
    assert approved['can_publish'] and approved['room'] != initial['room']
    assert not token(client, path)['can_publish']  # Another tab of the same student.
    actor['current'] = second
    assert not token(client, path, request_token=one['request_token'])['can_publish']
    assert decide(client, actor, teacher, base, lease, two).status_code == 200
    actor['current'] = student
    assert not token(client, path, request_token=one['request_token'])['can_publish']
    actor['current'] = second
    next_presenter = token(client, path, request_token=two['request_token'])
    assert next_presenter['can_publish'] and next_presenter['room'] != approved['room']
    assert decide(client, actor, teacher, base, lease, two, 'revoke').status_code == 200
    returned = token(client, path, control_token=lease['control_token'])
    assert returned['can_publish'] and returned['room'] != next_presenter['room']
    assert returned['session']['id'] == initial['session']['id']


def test_only_owning_instructor_tab_may_decide_and_removed_students_cannot_be_approved(session):
    client, actor, teacher, student, second, other, path, base, lease = session
    one = request(client, actor, student, base)
    target = base+'/requests/'+str(one['request']['id'])
    data = {'action':'approve','control_token':lease['control_token']}
    assert client.post(target, json=data).status_code == 403
    actor['current'] = other
    assert client.post(target, json=data).status_code == 409
    actor['current'] = teacher
    assert client.post(target, json={'action':'approve','control_token':'wrong'}).status_code == 409
    assert client.post(target, json=data, headers={'origin':'https://foreign'}).status_code == 403
    with db.connect() as conn:
        conn.execute('UPDATE hub_memberships SET active=false WHERE account_id=%s', (student['id'],))
    assert client.post(target, json=data).status_code == 409
    actor['current'] = student
    assert client.post(path+'/media-token',json={'request_token':one['request_token']}).status_code == 403
    actor['current'] = teacher
    assert client.post(target, json={**data,'action':'deny'}).status_code == 200


def test_student_cancel_is_private_and_approved_cancel_restores_teacher(session):
    client, actor, teacher, student, second, other, path, base, lease = session
    one = request(client, actor, student, base)
    actor['current'] = second
    assert client.request('DELETE',base+'/requests',json={'request_token':one['request_token']}).status_code == 409
    assert decide(client, actor, teacher, base, lease, one, 'deny').status_code == 200
    old = one
    one = request(client, actor, student, base)
    assert old['request']['id'] != one['request']['id']
    assert decide(client, actor, teacher, base, lease, old).status_code == 409
    assert decide(client, actor, teacher, base, lease, one).status_code == 200
    actor['current'] = student
    previous = token(client,path,request_token=one['request_token'])
    assert client.request('DELETE',base+'/requests',json={'request_token':one['request_token']}).status_code == 204
    assert not token(client,path,request_token=one['request_token'])['can_publish']
    actor['current'] = teacher
    current = token(client,path,control_token=lease['control_token'])
    assert current['can_publish'] and current['room'] != previous['room']
    assert decide(client, actor, teacher, base, lease, one).status_code == 409


def test_expired_or_cross_channel_requests_cannot_be_used(session):
    client, actor, teacher, student, second, other, path, base, lease = session
    actor['current'] = student
    assert client.post(base.replace('/channels/'+str(lease['session']['channel_id'])+'/', '/channels/999999/')+'/requests').status_code == 404
    with db.connect() as conn:
        conn.execute("UPDATE hub_media_sessions SET expires_at=now()-interval '1 second'")
    assert client.post(base+'/requests').status_code == 409
    assert client.post(path+'/media-token').status_code == 409


def test_concurrent_approvals_leave_exactly_one_presenter(session):
    client, actor, teacher, student, second, other, path, base, lease = session
    one = request(client, actor, student, base)
    two = request(client, actor, second, base)
    sid=lease['session']['id'];cohort=lease['session']['cohort_id'];channel=lease['session']['channel_id']
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda r: db.presentation_action(cohort,channel,sid,teacher['id'],'approve',lease['control_token'],r['request']['id']),[one,two]))
    assert all(results)
    rows=db.presentation_requests(sid,teacher['id'],manage=True)
    assert sum(r['status']=='approved' for r in rows)==1
    assert db.media_session(cohort,channel)['revision']==2

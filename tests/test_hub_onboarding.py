"""Roster changes are previewed, atomic, admin-only and require a first-login password."""
import os

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tests.test_hub_board_api import hub, login, ORIGIN, PASSWORD

pytestmark = pytest.mark.skipif(not os.environ.get('MADI_TEST_DATABASE_URL'), reason='MADI_TEST_DATABASE_URL not set')


def roster(cid, *rows):
    return {'cohort_id': cid, 'rows': list(rows) or [row('new_student')]}


def row(username, role='student', name='New learner'):
    return {'username': username, 'display_name': name, 'role': role}


def preview(admin, data):
    response = admin.post('/hub/api/accounts/import/preview', json=data, headers=ORIGIN)
    assert response.status_code == 200, response.text
    return response.json()


def apply(admin, data, plan):
    return admin.post('/hub/api/accounts/import', json={**data, 'revision': plan['revision']}, headers=ORIGIN)


def test_import_preview_is_read_only_and_apply_preserves_existing_accounts(hub):
    from app.hub import db
    app, cid, _ = hub
    existing = db.create_account('existing_account', 'Existing name', PASSWORD)
    admin = login(app, 'admin_user')
    data = roster(cid, row('new_student'), row('new_instructor', 'instructor'), row('existing_account', name='Ignored name'), row('student'))
    plan = preview(admin, data)
    assert plan['valid'] and plan['counts'] == {'create': 2, 'enroll': 1, 'unchanged': 1}
    assert db.authenticate('new_student', PASSWORD) is None
    assert 'credentials' not in plan and 'password' not in str(plan)
    response = apply(admin, data, plan)
    assert response.status_code == 201, response.text
    assert response.headers['Cache-Control'] == 'no-store'
    credentials = response.json()['credentials']
    assert {c['username'] for c in credentials} == {'new_student', 'new_instructor'}
    assert len({c['temporary_password'] for c in credentials}) == 2
    assert all(c['temporary_password'].startswith('madi-') for c in credentials)
    assert db.authenticate('existing_account', PASSWORD)['display_name'] == 'Existing name'
    assert db.membership(cid, existing['id'])['role'] == 'student'
    assert {m['username']: m['role'] for m in db.members(cid)}['new_instructor'] == 'instructor'
    assert apply(admin, data, plan).status_code == 409  # no second creation or new credentials
    repeat = preview(admin, data)
    assert repeat['counts']['unchanged'] == 4
    assert apply(admin, data, repeat).json()['credentials'] == []


def test_invalid_rows_block_entire_import_and_report_each_error(hub):
    from app.hub import db
    app, cid, _ = hub
    disabled = db.create_account('disabled_account', 'Disabled', PASSWORD)
    db.set_account_active(disabled['id'], False)
    admin = login(app, 'admin_user')
    data = roster(cid, row('valid_new'), row('VALID_NEW'), row('bad name'), row('teacher'), row('disabled_account'), row('admin_user'), row('wrong_role', 'admin'), row('blank_name', name='   '))
    plan = preview(admin, data)
    assert not plan['valid']
    assert plan['counts'] == {'create': 1, 'enroll': 0, 'unchanged': 0}
    assert plan['total_rows'] == 8 and plan['invalid_rows'] == 7
    assert all(r['errors'] for r in plan['rows'][1:])
    assert apply(admin, data, plan).status_code == 400
    with db.connect() as conn:
        assert conn.execute("SELECT 1 FROM hub_accounts WHERE username='valid_new'").fetchone() is None
    assert db.membership(cid, db.authenticate('teacher', PASSWORD)['id'])['role'] == 'instructor'


def test_import_rejects_stale_preview_archived_cohort_and_missing_revision(hub):
    from app.hub import db
    app, cid, _ = hub
    admin = login(app, 'admin_user')
    data = roster(cid)
    plan = preview(admin, data)
    assert admin.post('/hub/api/accounts/import', json=data, headers=ORIGIN).status_code == 409
    db.create_account('new_student', 'Someone else', PASSWORD)
    assert apply(admin, data, plan).status_code == 409
    assert db.membership(cid, db.authenticate('new_student', PASSWORD)['id']) is None
    with db.connect() as conn:
        conn.execute('UPDATE hub_cohorts SET archived=TRUE WHERE id=%s', (cid,))
    assert admin.post('/hub/api/accounts/import/preview', json=data, headers=ORIGIN).status_code == 400
    assert apply(admin, data, plan).status_code == 400


def test_import_requires_admin_origin_and_bounded_batch(hub):
    app, cid, _ = hub
    data = roster(cid)
    for user in ('student', 'teacher'):
        client = login(app, user)
        for endpoint in ('/hub/api/accounts/import', '/hub/api/accounts/import/preview'):
            assert client.post(endpoint, json=data, headers=ORIGIN).status_code == 403
    admin = login(app, 'admin_user')
    for endpoint in ('/hub/api/accounts/import', '/hub/api/accounts/import/preview'):
        assert admin.post(endpoint, json=data, headers={'origin': 'https://other.test'}).status_code == 403
    for rows in ([], [row(f'user_{n}') for n in range(101)]):
        assert admin.post('/hub/api/accounts/import/preview', json={'cohort_id': cid, 'rows': rows}, headers=ORIGIN).status_code == 422


@pytest.mark.parametrize('source', ['manual', 'import'])
@pytest.mark.parametrize('role', ['student', 'instructor'])
def test_new_account_cannot_access_class_before_changing_temporary_password(hub, source, role):
    app, cid, channel = hub
    admin = login(app, 'admin_user')
    if source == 'manual':
        password = PASSWORD
        response = admin.post('/hub/api/accounts', json={
            'username': 'new_student', 'display_name': 'New learner', 'password': password,
            'must_change_password': False,  # The server owns the onboarding policy.
        }, headers=ORIGIN)
        assert response.status_code == 201, response.text
        assert response.json()['must_change_password'] is True
        assert admin.post(f'/hub/api/cohorts/{cid}/memberships', json={
            'username': 'new_student', 'role': role,
        }, headers=ORIGIN).status_code == 201
    else:
        data = roster(cid, row('new_student', role))
        password = apply(admin, data, preview(admin, data)).json()['credentials'][0]['temporary_password']
    listed = lambda: next(a for a in admin.get('/hub/api/accounts').json() if a['username'] == 'new_student')
    assert listed()['must_change_password'] is True
    client = TestClient(app, base_url='https://testserver')
    assert client.post('/hub/api/login', json={'username': 'new_student', 'password': password}, headers=ORIGIN).status_code == 200
    assert client.get('/hub/api/me').json()['must_change_password'] is True
    # A fresh browser session still enters onboarding rather than bypassing it.
    refreshed = TestClient(app, base_url='https://testserver')
    assert refreshed.post('/hub/api/login', json={'username': 'new_student', 'password': password}, headers=ORIGIN).status_code == 200
    assert refreshed.get('/hub/api/me').json()['must_change_password'] is True
    assert refreshed.get('/hub/api/cohorts').status_code == 403
    for url in ('/hub/api/cohorts', f'/hub/api/cohorts/{cid}/members', f'/hub/api/cohorts/{cid}/channels/{channel}/messages'):
        assert client.get(url).status_code == 403
    assert client.post(f'/hub/api/cohorts/{cid}/channels/{channel}/messages', json={'body': 'bypass'}, headers=ORIGIN).status_code == 403
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f'/hub/ws/cohorts/{cid}', headers=ORIGIN):
            pass
    endpoint = '/hub/api/me/password'
    assert client.post(endpoint, json={'current_password': password, 'new_password': password}, headers=ORIGIN).status_code == 400
    assert client.post(endpoint, json={'current_password': 'incorrect', 'new_password': 'new-pass'}, headers=ORIGIN).status_code == 400
    assert client.post(endpoint, json={'current_password': password, 'new_password': 'new-pass'}, headers=ORIGIN).status_code == 204
    assert client.get('/hub/api/me').json()['must_change_password'] is False
    assert listed()['must_change_password'] is False
    assert refreshed.get('/hub/api/me').status_code == 401  # Other sessions are revoked.
    assert client.get(f'/hub/api/cohorts/{cid}/members').status_code == 200
    client.post('/hub/api/logout', headers=ORIGIN)
    assert client.post('/hub/api/login', json={'username': 'new_student', 'password': password}, headers=ORIGIN).status_code == 401
    assert client.post('/hub/api/login', json={'username': 'new_student', 'password': 'new-pass'}, headers=ORIGIN).status_code == 200


def test_failure_mid_import_rolls_back_accounts_and_memberships(hub, monkeypatch):
    from app.hub import db, onboarding
    app, cid, _ = hub
    admin = login(app, 'admin_user')
    data = roster(cid, row('first_new'), row('second_new'))
    plan = preview(admin, data)
    original = onboarding.hash_secret
    calls = 0
    def fail_second(password):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError('simulated hashing failure')
        return original(password)
    monkeypatch.setattr(onboarding, 'hash_secret', fail_second)
    with pytest.raises(RuntimeError, match='simulated'):
        apply(admin, data, plan)
    with db.connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM hub_accounts WHERE username IN ('first_new','second_new')").fetchone()['n'] == 0


def test_concurrent_confirmations_only_create_one_batch(hub):
    from concurrent.futures import ThreadPoolExecutor
    from app.hub import db, onboarding
    app, cid, _ = hub
    admin = db.authenticate('admin_user', PASSWORD)
    data = roster(cid)
    plan = onboarding.preview(cid, data['rows'])
    def confirm():
        try:
            return onboarding.apply(admin['id'], cid, data['rows'], plan['revision'])
        except onboarding.StaleImport:
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: confirm(), range(2)))
    assert sum(result is not None for result in results) == 1
    with db.connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM hub_accounts WHERE username='new_student'").fetchone()['n'] == 1


def test_admin_password_reset_preserves_pending_first_login(hub):
    from app.hub import db
    app, cid, _ = hub
    admin = login(app, 'admin_user')
    data = roster(cid)
    credential = apply(admin, data, preview(admin, data)).json()['credentials'][0]
    account = db.authenticate(credential['username'], credential['temporary_password'])
    response = admin.post(f'/hub/api/accounts/{account["id"]}/password', headers=ORIGIN)
    assert response.status_code == 200
    changed = db.authenticate(credential['username'], response.json()['temporary_password'])
    assert changed['must_change_password'] is True


def test_preview_counts_only_valid_actions_and_does_not_partially_apply(hub):
    from app.hub import db
    app, cid, _ = hub
    admin = login(app, 'admin_user')
    data = roster(cid, row('student'), row('new_learner'), row('NEW_LEARNER'))
    plan = preview(admin, data)
    assert plan['counts'] == {'create': 1, 'enroll': 0, 'unchanged': 1}
    assert plan['total_rows'] == 3 and plan['invalid_rows'] == 1
    assert [r['row'] for r in plan['rows']] == [1, 2, 3]
    assert not plan['valid'] and plan['rows'][2]['errors']
    assert apply(admin, data, plan).status_code == 400
    assert db.authenticate('new_learner', PASSWORD) is None
    corrected = roster(cid, row('student'), row('new_learner'))
    valid = preview(admin, corrected)
    assert valid['total_rows'] == 2 and valid['invalid_rows'] == 0 and valid['valid']
    applied = apply(admin, corrected, valid)
    assert applied.status_code == 201
    assert applied.json()['counts'] == valid['counts']

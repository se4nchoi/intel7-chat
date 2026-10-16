"""Classroom routing against the disposable PostgreSQL database."""
import json
import os
from concurrent.futures import ThreadPoolExecutor

import jwt
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.hub import db, routes
from app.hub.settings import classrooms
from tests.hub_reset import drop_hub_tables

TEST_URL = os.environ.get('MADI_TEST_DATABASE_URL')
SECRET1 = 'lab-one-independent-signing-secret-long-enough'
SECRET3 = 'lab-three-independent-signing-secret-long-enough'


def registry(monkeypatch, tmp_path):
    path = tmp_path / 'classrooms.json'
    path.write_text(json.dumps([
        dict(id='lab-1', name='Lab 1', url='wss://academy.local/media/lab-1', api_key='one', api_secret=SECRET1),
        dict(id='lab-3', name='Lab 3', url='wss://academy.local/media/lab-3', api_key='three', api_secret=SECRET3),
    ]))
    monkeypatch.setenv('MADI_CLASSROOMS_FILE', str(path))
    return path


def test_registry_fails_closed_without_leaking_secrets(monkeypatch, tmp_path):
    path = registry(monkeypatch, tmp_path)
    assert set(classrooms()) == {'lab-1', 'lab-3'}
    records = json.loads(path.read_text())
    for bad in ['ws://10.10.1.2', 'wss://user:password@host', 'wss://host/?secret=x', 'wss://host:99999']:
        records[0]['url'] = bad
        path.write_text(json.dumps(records))
        with pytest.raises(RuntimeError) as error:
            classrooms()
        assert SECRET1 not in str(error.value) and bad not in str(error.value)
    path.write_text('{}')
    with pytest.raises(RuntimeError): classrooms()


@pytest.fixture
def hub(monkeypatch, tmp_path):
    if not TEST_URL: pytest.skip('MADI_TEST_DATABASE_URL not set')
    registry(monkeypatch, tmp_path)
    monkeypatch.setenv('MADI_DATABASE_URL', TEST_URL)
    drop_hub_tables(db); db.initialize_schema()
    teacher = db.create_account('teacher', 'Teacher', 'test-pass-1234')
    student = db.create_account('student', 'Student', 'test-pass-1234')
    other = db.create_account('other_teacher', 'Other', 'test-pass-1234')
    for actor in (teacher, student, other): actor['is_admin'] = False
    cohort = db.create_cohort('class-one', 'Class One')
    for name, role in [('teacher', 'instructor'), ('student', 'student'), ('other_teacher', 'instructor')]:
        db.add_membership(cohort['id'], name, role)
    channel = db.create_channel(cohort['id'], 'general', 'General')
    app = FastAPI(); app.include_router(routes.router)
    account = {'current': teacher}
    monkeypatch.setattr(db, 'session_account', lambda _: account['current'])
    client = TestClient(app, base_url='https://academy.local')
    yield client, account, teacher, student, other, cohort, channel
    db.close_pools()


def setup(hub):
    client, account, teacher, student, other, cohort, channel = hub
    path = f"/hub/api/cohorts/{cohort['id']}/channels/{channel['id']}"
    return client, account, teacher, student, other, cohort, channel, path


def test_move_labs_retains_content_and_uses_new_endpoint_key_and_room(hub):
    client, account, teacher, student, other, cohort, channel, path = setup(hub)
    message = db.add_message(channel['id'], teacher['id'], 'retained across labs')
    assert client.post(path+'/media-token').status_code == 409
    started = client.post(path+'/media-session', json={'classroom_id':'lab-1'})
    assert started.status_code == 201
    lease = started.json(); control = {'control_token':lease['control_token']}
    first = client.post(path+'/media-token', json=control).json()
    assert first['url'].endswith('/lab-1') and first['can_publish']
    assert jwt.decode(first['token'], SECRET1, algorithms=['HS256'])['iss'] == 'one'
    account['current'] = student
    viewer = client.post(path+'/media-token').json()
    assert not viewer['can_publish'] and viewer['room'] == first['room']
    assert 'control_token' not in client.get(path+'/media-session').text
    assert SECRET1 not in client.get(path+'/media-session').text
    account['current'] = teacher
    sid = lease['session']['id']
    assert client.request("DELETE", path+'/media-session/'+sid, json=control).status_code == 204
    moved = client.post(path+'/media-session', json={'classroom_id':'lab-3'}).json()
    second = client.post(path+'/media-token', json={'control_token':moved['control_token']}).json()
    assert second['url'].endswith('/lab-3') and second['room'] != first['room']
    assert jwt.decode(second['token'], SECRET3, algorithms=['HS256'])['iss'] == 'three'
    assert any(m['id']==message['id'] for m in db.messages(channel['id']))
    assert db.access(student, cohort['id'])['role'] == 'student'


def test_permissions_owner_tab_control_and_origin(hub):
    client, account, teacher, student, other, cohort, channel, path = setup(hub)
    account['current'] = student
    assert client.post(path+'/media-session', json={'classroom_id':'lab-1'}).status_code == 403
    account['current'] = teacher
    assert client.post(path+'/media-session', json={'classroom_id':'unknown'}).status_code == 404
    assert client.post(path+'/media-session', json={'classroom_id':'lab-1'}, headers={'origin':'https://foreign'}).status_code == 403
    lease = client.post(path+'/media-session', json={'classroom_id':'lab-1'}).json()
    base = path+'/media-session/'+lease['session']['id']
    assert client.post(base+'/heartbeat', json={'control_token':'wrong'}).status_code == 409
    assert not client.post(path+'/media-token').json()['can_publish']
    account['current'] = other
    assert client.post(base+'/heartbeat', json={'control_token':lease['control_token']}).status_code == 409
    assert client.request("DELETE", base, json={'control_token':lease['control_token']}).status_code == 409
    account['current'] = teacher
    assert client.post(base+'/heartbeat', json={'control_token':lease['control_token']}).status_code == 200
    listed = client.get(f"/hub/api/cohorts/{cohort['id']}/classrooms")
    assert listed.json() == [{'id':'lab-1','name':'Lab 1'}, {'id':'lab-3','name':'Lab 3'}]
    with db.connect() as conn:
        conn.execute('UPDATE hub_memberships SET active=false WHERE cohort_id=%s AND account_id=%s', (cohort['id'],teacher['id']))
    assert client.post(base+'/heartbeat', json={'control_token':lease['control_token']}).status_code == 403


def test_lab_reservation_concurrency_expiry_and_session_isolation(hub):
    client, account, teacher, student, other, cohort, channel, path = setup(hub)
    second = db.create_channel(cohort['id'], 'another', 'Another')
    def start(cid):
        try:
            return db.start_media_session(cohort['id'], cid, 'lab-1', teacher['id'], 'control')
        except Exception as error:
            from psycopg.errors import UniqueViolation
            assert isinstance(error, UniqueViolation)
            return None
    with ThreadPoolExecutor(max_workers=2) as pool:
        leases = list(pool.map(start, [channel['id'], second['id']]))
    assert sum(lease is not None for lease in leases) == 1
    lease = next(l for l in leases if l)
    with db.connect() as conn: conn.execute("UPDATE hub_media_sessions SET expires_at=now()-interval '1 second'")
    assert db.media_session(cohort['id'], lease['channel_id']) is None
    fresh = db.start_media_session(cohort['id'], channel['id'], 'lab-1', teacher['id'], 'fresh')
    assert fresh['id'] != lease['id']
    assert not db.control_media_session(cohort['id'], channel['id'], lease['id'], teacher['id'], 'control', end=True)
    assert not db.control_media_session(cohort['id']+1, channel['id'], fresh['id'], teacher['id'], 'fresh')

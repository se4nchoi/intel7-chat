"""Preview and atomically apply a class roster; plaintext credentials only leave once."""
import hashlib
import json
import secrets

from app.auth import hash_secret, normalize_username, validate_username
from app.hub import db


class StaleImport(ValueError):
    pass


def _plan(conn, cohort_id, rows, *, lock=False):
    cohort = conn.execute('SELECT id,name,archived FROM hub_cohorts WHERE id=%s' + (' FOR UPDATE' if lock else ''), (cohort_id,)).fetchone()
    if not cohort:
        raise ValueError('수강반을 선택해 주세요.')
    if cohort['archived']:
        raise ValueError('종료된 수강반에는 계정을 가져올 수 없습니다.')
    usernames = [normalize_username(row['username']) for row in rows]
    accounts = conn.execute('SELECT id,username,normalized_username,display_name,active,is_admin FROM hub_accounts WHERE normalized_username=ANY(%s) ORDER BY id' + (' FOR UPDATE' if lock else ''), (usernames,)).fetchall()
    by_name = {a['normalized_username']: a for a in accounts}
    memberships = {m['account_id']: m for m in conn.execute('SELECT account_id,role,active FROM hub_memberships WHERE cohort_id=%s ORDER BY account_id' + (' FOR UPDATE' if lock else ''), (cohort_id,))}
    planned, seen = [], set()
    for number, row in enumerate(rows, 1):
        errors, username = [], row['username'].strip()
        try:
            username = validate_username(username)
        except ValueError as exc:
            errors.append(str(exc))
        normalized = normalize_username(username)
        if normalized in seen:
            errors.append('목록에 중복된 아이디가 있습니다.')
        seen.add(normalized)
        name, role = row['display_name'].strip(), row.get('role', 'student')
        if not 1 <= len(name) <= 100:
            errors.append('표시 이름은 1~100자로 입력해 주세요.')
        if role not in ('student', 'instructor'):
            errors.append('역할은 student 또는 instructor로 입력해 주세요.')
        existing = by_name.get(normalized)
        membership = memberships.get(existing['id']) if existing else None
        if existing and (not existing['active'] or existing['is_admin']):
            errors.append('비활성 계정과 관리자 계정은 가져올 수 없습니다.')
        if membership and membership['active'] and membership['role'] != role:
            errors.append('기존 수강반 역할과 다릅니다. 역할 변경은 수강반 관리에서 진행하세요.')
        action = 'create' if not existing else 'unchanged' if membership and membership['active'] else 'enroll'
        planned.append({'row': number, 'username': existing['username'] if existing else username,
                        'display_name': existing['display_name'] if existing else name,
                        'role': role, 'action': action, 'errors': errors})
    revision = hashlib.sha256(json.dumps([cohort, rows, accounts, sorted(memberships.values(), key=lambda m: m['account_id'])], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    counts = {action: sum(p['action'] == action for p in planned) for action in ('create', 'enroll', 'unchanged')}
    return {'cohort': cohort, 'rows': planned, 'counts': counts, 'valid': not any(p['errors'] for p in planned), 'revision': revision}


def preview(cohort_id, rows):
    with db.connect() as conn:
        return _plan(conn, cohort_id, rows)


def apply(admin_id, cohort_id, rows, revision):
    with db.connect() as conn:
        plan = _plan(conn, cohort_id, rows, lock=True)
        admin = conn.execute('SELECT is_admin,active FROM hub_accounts WHERE id=%s FOR SHARE', (admin_id,)).fetchone()
        if not admin or not admin['active'] or not admin['is_admin']:
            raise PermissionError('Administrator access required')
        if not plan['valid']:
            raise ValueError('오류가 있는 행을 수정한 뒤 다시 미리 확인해 주세요.')
        if not secrets.compare_digest(plan['revision'], revision):
            raise StaleImport('계정 또는 수강반 정보가 변경되었습니다. 다시 미리 확인해 주세요.')
        credentials = []
        for row in plan['rows']:
            if row['action'] == 'unchanged':
                continue
            if row['action'] == 'create':
                password = 'madi-' + secrets.token_urlsafe(12)
                account_id = conn.execute('''INSERT INTO hub_accounts(username,normalized_username,display_name,password_hash,must_change_password)
                    VALUES(%s,%s,%s,%s,TRUE) RETURNING id''', (row['username'], normalize_username(row['username']), row['display_name'], hash_secret(password))).fetchone()['id']
                credentials.append({'username': row['username'], 'display_name': row['display_name'], 'temporary_password': password})
            else:
                account_id = conn.execute('SELECT id FROM hub_accounts WHERE normalized_username=%s', (normalize_username(row['username']),)).fetchone()['id']
            conn.execute('''INSERT INTO hub_memberships(cohort_id,account_id,role) VALUES(%s,%s,%s)
                ON CONFLICT(cohort_id,account_id) DO UPDATE SET active=TRUE,role=EXCLUDED.role''', (cohort_id, account_id, row['role']))
        return {'counts': plan['counts'], 'credentials': credentials, 'cohort': plan['cohort']}

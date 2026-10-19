"""Persistent, per-account alerts. Recheck target access on every read and delivery."""
import re

from app.auth import normalize_username
from app.hub import db


def mentioned_usernames(body):
    # Code examples and links do not ping people; emails and username prefixes do not match.
    text = re.sub(r'```[\s\S]*?```|`[^`\n]*`|https?://[^\s]+', ' ', body)
    return {normalize_username(name) for name in re.findall(r'(?<![\w.@])@([\w.-]+)', text)
            if 2 <= len(normalize_username(name)) <= 30}


def message_created(conn, message_id, channel_id, actor_id, body):
    names = list(mentioned_usernames(body))
    if not names:
        return
    conn.execute('''INSERT INTO hub_notifications(account_id,actor_id,cohort_id,kind,message_id)
        SELECT a.id,%s,c.cohort_id,'mention',%s FROM hub_accounts a CROSS JOIN hub_channels c
        WHERE c.id=%s AND a.active AND a.id<>%s AND a.normalized_username=ANY(%s)
          AND (a.is_admin OR EXISTS(SELECT 1 FROM hub_memberships mb WHERE mb.account_id=a.id AND mb.cohort_id=c.cohort_id AND mb.active))
          AND (c.kind='channel' OR EXISTS(SELECT 1 FROM hub_dm_members dm WHERE dm.channel_id=c.id AND dm.account_id=a.id))
        ON CONFLICT DO NOTHING''', (actor_id, message_id, channel_id, actor_id, names))


def answer_created(conn, answer_id, question_id, actor_id):
    conn.execute('''INSERT INTO hub_question_follows(question_id,account_id) VALUES(%s,%s)
        ON CONFLICT DO NOTHING''', (question_id, actor_id))
    conn.execute('''INSERT INTO hub_notifications(account_id,actor_id,cohort_id,kind,question_id,answer_id)
        SELECT a.id,%s,q.cohort_id,'answer',q.id,%s
        FROM hub_question_follows f JOIN hub_accounts a ON a.id=f.account_id JOIN hub_questions q ON q.id=f.question_id
        WHERE q.id=%s AND q.deleted_at IS NULL AND f.following AND a.active AND a.id<>%s
          AND (a.is_admin OR EXISTS(SELECT 1 FROM hub_memberships mb WHERE mb.account_id=a.id AND mb.cohort_id=q.cohort_id AND mb.active))
        ON CONFLICT DO NOTHING''', (actor_id, answer_id, question_id, actor_id))


def following(question_id, account_id):
    with db.connect() as conn:
        row = conn.execute('SELECT following FROM hub_question_follows WHERE question_id=%s AND account_id=%s', (question_id, account_id)).fetchone()
        return {'following': bool(row and row['following'])}


def set_following(question_id, account_id, value):
    with db.connect() as conn:
        return conn.execute('''INSERT INTO hub_question_follows(question_id,account_id,following) VALUES(%s,%s,%s)
            ON CONFLICT(question_id,account_id) DO UPDATE SET following=EXCLUDED.following RETURNING following''', (question_id, account_id, value)).fetchone()


# Every query, including counts and mark-read, hides deleted targets and lost access.
VISIBLE = '''FROM hub_notifications n
    JOIN hub_cohorts c ON c.id=n.cohort_id
    JOIN hub_accounts actor ON actor.id=n.actor_id
    LEFT JOIN hub_questions q ON q.id=n.question_id
    LEFT JOIN hub_answers a ON a.id=n.answer_id
    LEFT JOIN hub_messages m ON m.id=n.message_id
    LEFT JOIN hub_channels ch ON ch.id=m.channel_id
    WHERE n.account_id=%(me)s
      AND (%(admin)s OR EXISTS(SELECT 1 FROM hub_memberships mb WHERE mb.account_id=%(me)s AND mb.cohort_id=c.id AND mb.active))
      AND ((n.kind='answer' AND q.cohort_id=c.id AND q.deleted_at IS NULL AND a.question_id=q.id AND a.deleted_at IS NULL)
        OR (n.kind='mention' AND ch.cohort_id=c.id AND m.deleted_at IS NULL
          AND (ch.kind='channel' OR EXISTS(SELECT 1 FROM hub_dm_members dm WHERE dm.channel_id=ch.id AND dm.account_id=%(me)s))))
'''


def _params(account):
    return {'me': account['id'], 'admin': account['is_admin']}


def page(account, unread_only=False, before=None):
    params = {**_params(account), 'before': before}
    filtered = VISIBLE + (' AND n.read_at IS NULL' if unread_only else '')
    with db.connect() as conn:
        unread = conn.execute('SELECT count(*) AS n ' + VISIBLE + ' AND n.read_at IS NULL', params).fetchone()['n']
        total = conn.execute('SELECT count(*) AS n ' + filtered, params).fetchone()['n']
        rows = conn.execute('''SELECT n.id,n.kind,n.created_at,n.read_at,n.question_id,n.answer_id,n.message_id,
            c.id AS cohort_id,c.slug AS cohort_slug,c.name AS cohort_name,
            ch.id AS channel_id,ch.kind AS channel_kind,ch.name AS channel_name,
            actor.display_name AS actor_name,q.title AS question_title,left(coalesce(a.body,m.body),180) AS excerpt
            ''' + filtered + ' AND (%(before)s::bigint IS NULL OR n.id<%(before)s) ORDER BY n.id DESC LIMIT 31', params).fetchall()
    items = rows[:30]
    return {'items': items, 'unread_total': unread, 'total': total, 'has_more': len(rows) > 30,
            'next_before': items[-1]['id'] if len(rows) > 30 else None}


def unread_count(account):
    with db.connect() as conn:
        return {'unread_total': conn.execute('SELECT count(*) AS n ' + VISIBLE + ' AND n.read_at IS NULL', _params(account)).fetchone()['n']}


def mark_read(account, notification_id, read=True):
    with db.connect() as conn:
        return bool(conn.execute('''UPDATE hub_notifications SET read_at=CASE WHEN %(read)s THEN now() ELSE NULL END
            WHERE id IN (SELECT n.id ''' + VISIBLE + ' AND n.id=%(id)s) RETURNING id',
            {**_params(account), 'id': notification_id, 'read': read}).fetchone())


def mark_all_read(account, through_id):
    with db.connect() as conn:
        conn.execute('UPDATE hub_notifications SET read_at=now() WHERE id IN (SELECT n.id ' + VISIBLE +
                     ' AND n.id<=%(through)s AND n.read_at IS NULL)', {**_params(account), 'through': through_id})

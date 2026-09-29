"""PostgreSQL persistence for 마디 (Madi), the cohort-scoped hub."""
from __future__ import annotations

import os
import secrets
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from app.auth import hash_secret, normalize_username, token_hash, verify_secret

# One pool per database URL, reused across requests. Opening a fresh
# connection per query costs a TCP and auth round trip, which chat delivery
# pays once per listening session. Keep max_size at or below the default
# asyncio.to_thread worker count so waiting threads don't pile up.
_pools: dict[str, ConnectionPool] = {}
_pools_lock = threading.Lock()


def _pool() -> ConnectionPool:
    url = os.environ.get("MADI_DATABASE_URL")
    if not url:
        raise RuntimeError("Prototype PostgreSQL URL is not configured")
    with _pools_lock:
        pool = _pools.get(url)
        if pool is None:
            pool = ConnectionPool(
                url, min_size=1, max_size=int(os.environ.get("MADI_DB_POOL_SIZE", "10")),
                kwargs={"row_factory": dict_row}, check=ConnectionPool.check_connection,
                timeout=10, open=True, name="hub",
            )
            _pools[url] = pool
    return pool


def connect():
    """Borrow a pooled connection; commits on success, rolls back on error."""
    return _pool().connection()


def close_pools() -> None:
    with _pools_lock:
        for pool in _pools.values():
            pool.close()
        _pools.clear()


MIGRATIONS_DIR = Path(__file__).with_name("migrations")
MIGRATION_LOCK = 7_265_341  # arbitrary pg_advisory_xact_lock key for this app


def available_migrations() -> list[tuple[int, str, str]]:
    """(version, name, sql) for each NNNN_name.sql file, in order."""
    found = []
    for path in sorted(MIGRATIONS_DIR.glob("[0-9][0-9][0-9][0-9]_*.sql")):
        version, _, name = path.stem.partition("_")
        found.append((int(version), name, path.read_text(encoding="utf-8")))
    versions = [v for v, _, _ in found]
    if versions != list(range(1, len(versions) + 1)):
        raise RuntimeError(f"Hub migrations must be numbered 1..n without gaps, found {versions}")
    return found


def migrate(migrations: list[tuple[int, str, str]] | None = None) -> list[int]:
    """Apply pending migrations, each in its own transaction; returns the versions applied."""
    migrations = available_migrations() if migrations is None else migrations
    applied_now = []
    with connect() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS hub_schema_migrations (
                            version INTEGER PRIMARY KEY,
                            name TEXT NOT NULL,
                            applied_at TIMESTAMPTZ NOT NULL DEFAULT now())""")
    for version, name, sql in migrations:
        with connect() as conn:
            # Serialize concurrent starts; the lock is released when this transaction ends.
            conn.execute("SELECT pg_advisory_xact_lock(%s)", (MIGRATION_LOCK,))
            if conn.execute("SELECT 1 FROM hub_schema_migrations WHERE version=%s", (version,)).fetchone():
                continue
            conn.execute(sql)
            conn.execute("INSERT INTO hub_schema_migrations (version, name) VALUES (%s, %s)", (version, name))
            applied_now.append(version)
    with connect() as conn:
        newest = conn.execute("SELECT max(version) AS v FROM hub_schema_migrations").fetchone()["v"] or 0
    known = migrations[-1][0] if migrations else 0
    if newest > known:
        raise RuntimeError(f"Hub database is at schema version {newest}, newer than this code ({known}); "
                           "update the code before starting it against this database")
    return applied_now


def schema_version() -> int:
    with connect() as conn:
        return conn.execute("SELECT coalesce(max(version), 0) AS v FROM hub_schema_migrations").fetchone()["v"]


def initialize_schema() -> None:
    migrate()


def seed_demo(data_dir: Path) -> bool:
    """Seed once with separate admin, instructor, and student identities."""
    admin_file = data_dir / "prototype-admin.txt"
    admin_password = next(line.partition(": ")[2] for line in admin_file.read_text(encoding="utf-8").splitlines() if line.startswith("Password: "))
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    instructor_password = "".join(secrets.choice(alphabet) for _ in range(12))
    student_password = "".join(secrets.choice(alphabet) for _ in range(12))
    with connect() as conn:
        if conn.execute("SELECT 1 FROM hub_accounts LIMIT 1").fetchone():
            return False
        ids = {}
        for username, password, is_admin in (
            ("prototype_admin", admin_password, True),
            ("demo_instructor", instructor_password, False),
            ("demo_student", student_password, False),
        ):
            ids[username] = conn.execute(
                """INSERT INTO hub_accounts (username, normalized_username, display_name, password_hash, is_admin)
                   VALUES (%s, %s, %s, %s, %s) RETURNING id""",
                (username, normalize_username(username), username, hash_secret(password), is_admin),
            ).fetchone()["id"]
        cohort_id = conn.execute(
            "INSERT INTO hub_cohorts (slug, name) VALUES (%s, %s) RETURNING id",
            ("demo-2026", "Demo cohort 2026"),
        ).fetchone()["id"]
        for username, role in (("demo_instructor", "instructor"), ("demo_student", "student")):
            conn.execute("INSERT INTO hub_memberships (cohort_id, account_id, role) VALUES (%s, %s, %s)",
                         (cohort_id, ids[username], role))
        conn.execute("INSERT INTO hub_channels (cohort_id, slug, name) VALUES (%s, %s, %s)",
                     (cohort_id, "general", "General"))
    (data_dir / "hub-demo-users.txt").write_text(
        f"Hub: https://127.0.0.1:8443/hub\nCohort: demo-2026\n"
        f"Instructor: demo_instructor / {instructor_password}\n"
        f"Student: demo_student / {student_password}\n"
        "Administrator: prototype_admin / see prototype-admin.txt\n", encoding="utf-8")
    return True


_dummy_hash: str | None = None


def authenticate(username: str, password: str):
    global _dummy_hash
    with connect() as conn:
        row = conn.execute("SELECT * FROM hub_accounts WHERE normalized_username=%s AND active",
                           (normalize_username(username),)).fetchone()
    if not row:
        # Verify against a throwaway hash so unknown usernames take as long
        # as wrong passwords and can't be discovered by timing.
        if _dummy_hash is None:
            _dummy_hash = hash_secret(secrets.token_urlsafe(16))
        verify_secret(_dummy_hash, password)
        return None
    return row if verify_secret(row["password_hash"], password) else None


def create_session(account_id: int) -> str:
    raw = secrets.token_urlsafe(32)
    with connect() as conn:
        conn.execute("DELETE FROM hub_sessions WHERE expires_at < now()")
        conn.execute("INSERT INTO hub_sessions (token_hash, account_id, expires_at) VALUES (%s, %s, %s)",
                     (token_hash(raw), account_id, datetime.now(timezone.utc) + timedelta(hours=12)))
    return raw


def session_account(raw: str):
    if not raw:
        return None
    with connect() as conn:
        return conn.execute(
            """SELECT a.id, a.username, a.display_name, a.is_admin FROM hub_sessions s
               JOIN hub_accounts a ON a.id=s.account_id
               WHERE s.token_hash=%s AND s.expires_at>now() AND a.active""",
            (token_hash(raw),),
        ).fetchone()


def delete_session(raw: str) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM hub_sessions WHERE token_hash=%s", (token_hash(raw),))


def access(account: dict, cohort_id: int):
    with connect() as conn:
        cohort = conn.execute("SELECT id, slug, name, archived FROM hub_cohorts WHERE id=%s", (cohort_id,)).fetchone()
        if not cohort:
            return None
        if account["is_admin"]:
            return {**cohort, "role": "admin"}
        membership = conn.execute(
            "SELECT role FROM hub_memberships WHERE cohort_id=%s AND account_id=%s AND active",
            (cohort_id, account["id"]),
        ).fetchone()
        return {**cohort, "role": membership["role"]} if membership else None


def cohorts_for(account: dict):
    with connect() as conn:
        if account["is_admin"]:
            return conn.execute("SELECT id, slug, name, archived, 'admin' AS role FROM hub_cohorts ORDER BY id").fetchall()
        return conn.execute(
            """SELECT c.id, c.slug, c.name, c.archived, m.role FROM hub_memberships m
               JOIN hub_cohorts c ON c.id=m.cohort_id WHERE m.account_id=%s AND m.active ORDER BY c.id""",
            (account["id"],),
        ).fetchall()


def channel(cohort_id: int, channel_id: int):
    with connect() as conn:
        return conn.execute("SELECT id, name, slug FROM hub_channels WHERE id=%s AND cohort_id=%s",
                            (channel_id, cohort_id)).fetchone()


def channels(cohort_id: int):
    with connect() as conn:
        return conn.execute("SELECT id, name, slug FROM hub_channels WHERE cohort_id=%s ORDER BY id", (cohort_id,)).fetchall()


# Cohort role of an author, as shown next to their name. Admins without a
# membership show as "admin"; former (inactive) members show as "member".
AUTHOR_ROLE = "COALESCE(mb.role, CASE WHEN a.is_admin THEN 'admin' END, 'member')"


MESSAGE_SELECT = f"""SELECT m.id, m.body, m.created_at, a.username, a.display_name, {AUTHOR_ROLE} AS role
               FROM hub_messages m JOIN hub_accounts a ON a.id=m.author_id
               JOIN hub_channels c ON c.id=m.channel_id
               LEFT JOIN hub_memberships mb ON mb.account_id=a.id AND mb.cohort_id=c.cohort_id AND mb.active"""
CATCH_UP_LIMIT = 500


def messages(channel_id: int, after: int | None = None):
    """The latest 100 messages, or (after=id) up to 500 newer ones for a reconnecting client."""
    with connect() as conn:
        if after is not None:
            return conn.execute(f"{MESSAGE_SELECT} WHERE m.channel_id=%s AND m.id>%s ORDER BY m.id LIMIT %s",
                                (channel_id, after, CATCH_UP_LIMIT)).fetchall()
        return conn.execute(f"{MESSAGE_SELECT} WHERE m.channel_id=%s ORDER BY m.id DESC LIMIT 100",
                            (channel_id,)).fetchall()[::-1]


def add_message(channel_id: int, account_id: int, body: str):
    with connect() as conn:
        return conn.execute(
            f"""WITH new_message AS (
                 INSERT INTO hub_messages (channel_id, author_id, body) VALUES (%s,%s,%s)
                 RETURNING id, channel_id, author_id, body, created_at)
               SELECT m.id, m.body, m.created_at, a.username, a.display_name, {AUTHOR_ROLE} AS role
               FROM new_message m JOIN hub_accounts a ON a.id=m.author_id
               JOIN hub_channels c ON c.id=m.channel_id
               LEFT JOIN hub_memberships mb ON mb.account_id=a.id AND mb.cohort_id=c.cohort_id AND mb.active""",
            (channel_id, account_id, body),
        ).fetchone()


def members(cohort_id: int):
    with connect() as conn:
        return conn.execute(
            """SELECT a.id, a.username, a.display_name, m.role FROM hub_memberships m
               JOIN hub_accounts a ON a.id=m.account_id
               WHERE m.cohort_id=%s AND m.active AND a.active
               ORDER BY m.role, a.display_name""",
            (cohort_id,),
        ).fetchall()


def questions(cohort_id: int):
    with connect() as conn:
        return conn.execute(
            f"""SELECT q.id,q.title,q.body,q.created_at,a.username,a.display_name,{AUTHOR_ROLE} AS role,
                      count(x.id) AS answer_count,
                      coalesce(bool_or(xm.role='instructor' OR xa.is_admin), FALSE) AS instructor_answered,
                      coalesce(bool_or(x.endorsed), FALSE) AS endorsed,
                      greatest(q.created_at, max(x.created_at)) AS last_activity
               FROM hub_questions q JOIN hub_accounts a ON a.id=q.author_id
               LEFT JOIN hub_memberships mb ON mb.account_id=a.id AND mb.cohort_id=q.cohort_id AND mb.active
               LEFT JOIN hub_answers x ON x.question_id=q.id
               LEFT JOIN hub_accounts xa ON xa.id=x.author_id
               LEFT JOIN hub_memberships xm ON xm.account_id=x.author_id AND xm.cohort_id=q.cohort_id AND xm.active
               WHERE q.cohort_id=%s
               GROUP BY q.id, a.id, mb.role
               ORDER BY q.id DESC LIMIT 100""", (cohort_id,),
        ).fetchall()


def add_question(cohort_id: int, account_id: int, title: str, body: str):
    with connect() as conn:
        return conn.execute("""INSERT INTO hub_questions (cohort_id,author_id,title,body)
                               VALUES (%s,%s,%s,%s) RETURNING id""",
                            (cohort_id, account_id, title, body)).fetchone()["id"]


def question(cohort_id: int, question_id: int):
    with connect() as conn:
        return conn.execute("SELECT id FROM hub_questions WHERE id=%s AND cohort_id=%s",
                            (question_id, cohort_id)).fetchone()


def answers(question_id: int):
    with connect() as conn:
        return conn.execute(
            f"""SELECT x.id,x.body,x.endorsed,x.created_at,a.username,a.display_name,{AUTHOR_ROLE} AS role
               FROM hub_answers x JOIN hub_accounts a ON a.id=x.author_id
               JOIN hub_questions q ON q.id=x.question_id
               LEFT JOIN hub_memberships mb ON mb.account_id=a.id AND mb.cohort_id=q.cohort_id AND mb.active
               WHERE x.question_id=%s ORDER BY x.id""",
            (question_id,),
        ).fetchall()


def set_endorsed(question_id: int, answer_id: int, endorsed: bool):
    with connect() as conn:
        return conn.execute(
            "UPDATE hub_answers SET endorsed=%s WHERE id=%s AND question_id=%s RETURNING id, endorsed",
            (endorsed, answer_id, question_id),
        ).fetchone()


def add_answer(question_id: int, account_id: int, body: str):
    with connect() as conn:
        return conn.execute("INSERT INTO hub_answers (question_id,author_id,body) VALUES (%s,%s,%s) RETURNING id",
                            (question_id, account_id, body)).fetchone()["id"]


def files(cohort_id: int):
    with connect() as conn:
        return conn.execute(
            """SELECT f.id,f.original_name,f.content_type,f.size_bytes,f.created_at,a.username
               FROM hub_files f JOIN hub_accounts a ON a.id=f.uploader_id
               WHERE f.cohort_id=%s ORDER BY f.created_at DESC LIMIT 100""",
            (cohort_id,),
        ).fetchall()


def add_file(file_id: str, cohort_id: int, account_id: int, name: str, content_type: str, size: int):
    with connect() as conn:
        conn.execute("""INSERT INTO hub_files (id,cohort_id,uploader_id,original_name,content_type,size_bytes)
                        VALUES (%s,%s,%s,%s,%s,%s)""",
                     (file_id, cohort_id, account_id, name, content_type, size))


def file(cohort_id: int, file_id: str):
    with connect() as conn:
        return conn.execute("SELECT * FROM hub_files WHERE id=%s AND cohort_id=%s", (file_id, cohort_id)).fetchone()


def create_cohort(slug: str, name: str):
    with connect() as conn:
        return conn.execute("INSERT INTO hub_cohorts (slug,name) VALUES (%s,%s) RETURNING id,slug,name,archived",
                            (slug, name)).fetchone()


def create_account(username: str, display_name: str, password: str):
    with connect() as conn:
        return conn.execute(
            """INSERT INTO hub_accounts (username,normalized_username,display_name,password_hash)
               VALUES (%s,%s,%s,%s) RETURNING id,username,display_name""",
            (username, normalize_username(username), display_name, hash_secret(password)),
        ).fetchone()


def add_membership(cohort_id: int, username: str, role: str):
    with connect() as conn:
        return conn.execute(
            """INSERT INTO hub_memberships (cohort_id,account_id,role)
               SELECT %s,id,%s FROM hub_accounts WHERE normalized_username=%s
               ON CONFLICT (cohort_id,account_id) DO UPDATE SET role=EXCLUDED.role,active=TRUE
               RETURNING cohort_id,account_id,role""",
            (cohort_id, role, normalize_username(username)),
        ).fetchone()


def create_channel(cohort_id: int, slug: str, name: str):
    with connect() as conn:
        return conn.execute("INSERT INTO hub_channels (cohort_id,slug,name) VALUES (%s,%s,%s) RETURNING id,slug,name",
                            (cohort_id, slug, name)).fetchone()

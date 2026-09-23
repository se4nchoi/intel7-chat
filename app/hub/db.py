"""PostgreSQL persistence for the new cohort-scoped hub."""
from __future__ import annotations

import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from app.auth import hash_secret, normalize_username, token_hash, verify_secret


def connect():
    url = os.environ.get("BAMBOOCHAT_HUB_DATABASE_URL")
    if not url:
        raise RuntimeError("Prototype PostgreSQL URL is not configured")
    return psycopg.connect(url, row_factory=dict_row)


SCHEMA = """
CREATE TABLE IF NOT EXISTS hub_accounts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username TEXT NOT NULL,
    normalized_username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hub_sessions (
    token_hash TEXT PRIMARY KEY,
    account_id BIGINT NOT NULL REFERENCES hub_accounts(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hub_sessions_expires ON hub_sessions(expires_at);
CREATE TABLE IF NOT EXISTS hub_cohorts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hub_memberships (
    cohort_id BIGINT NOT NULL REFERENCES hub_cohorts(id) ON DELETE CASCADE,
    account_id BIGINT NOT NULL REFERENCES hub_accounts(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('instructor', 'student')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (cohort_id, account_id)
);
CREATE TABLE IF NOT EXISTS hub_channels (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cohort_id BIGINT NOT NULL REFERENCES hub_cohorts(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    UNIQUE (cohort_id, slug),
    UNIQUE (id, cohort_id)
);
CREATE TABLE IF NOT EXISTS hub_messages (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id BIGINT NOT NULL REFERENCES hub_channels(id) ON DELETE CASCADE,
    author_id BIGINT NOT NULL REFERENCES hub_accounts(id),
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hub_messages_channel ON hub_messages(channel_id, id);
CREATE TABLE IF NOT EXISTS hub_questions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cohort_id BIGINT NOT NULL REFERENCES hub_cohorts(id) ON DELETE CASCADE,
    author_id BIGINT NOT NULL REFERENCES hub_accounts(id),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hub_questions_cohort ON hub_questions(cohort_id, id);
CREATE TABLE IF NOT EXISTS hub_answers (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    question_id BIGINT NOT NULL REFERENCES hub_questions(id) ON DELETE CASCADE,
    author_id BIGINT NOT NULL REFERENCES hub_accounts(id),
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
    endorsed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hub_files (
    id TEXT PRIMARY KEY,
    cohort_id BIGINT NOT NULL REFERENCES hub_cohorts(id) ON DELETE CASCADE,
    uploader_id BIGINT NOT NULL REFERENCES hub_accounts(id),
    original_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hub_files_cohort ON hub_files(cohort_id, created_at DESC);
"""


def initialize_schema() -> None:
    with connect() as conn:
        conn.execute(SCHEMA)


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


def authenticate(username: str, password: str):
    with connect() as conn:
        row = conn.execute("SELECT * FROM hub_accounts WHERE normalized_username=%s AND active",
                           (normalize_username(username),)).fetchone()
    return row if row and verify_secret(row["password_hash"], password) else None


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


def messages(channel_id: int):
    with connect() as conn:
        return conn.execute(
            """SELECT m.id, m.body, m.created_at, a.username, a.display_name
               FROM hub_messages m JOIN hub_accounts a ON a.id=m.author_id
               WHERE m.channel_id=%s ORDER BY m.id DESC LIMIT 100""",
            (channel_id,),
        ).fetchall()[::-1]


def add_message(channel_id: int, account_id: int, body: str):
    with connect() as conn:
        return conn.execute(
            """WITH new_message AS (
                 INSERT INTO hub_messages (channel_id, author_id, body) VALUES (%s,%s,%s)
                 RETURNING id, author_id, body, created_at)
               SELECT m.id, m.body, m.created_at, a.username, a.display_name
               FROM new_message m JOIN hub_accounts a ON a.id=m.author_id""",
            (channel_id, account_id, body),
        ).fetchone()


def questions(cohort_id: int):
    with connect() as conn:
        return conn.execute(
            """SELECT q.id,q.title,q.body,q.created_at,a.username,
                      (SELECT count(*) FROM hub_answers x WHERE x.question_id=q.id) AS answer_count
               FROM hub_questions q JOIN hub_accounts a ON a.id=q.author_id
               WHERE q.cohort_id=%s ORDER BY q.id DESC LIMIT 100""", (cohort_id,),
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
            """SELECT x.id,x.body,x.endorsed,x.created_at,a.username FROM hub_answers x
               JOIN hub_accounts a ON a.id=x.author_id WHERE x.question_id=%s ORDER BY x.id""",
            (question_id,),
        ).fetchall()


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

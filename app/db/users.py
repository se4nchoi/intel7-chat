"""User authentication and session database operations."""
from __future__ import annotations

import uuid as _uuid
from typing import Any, Dict, List, Optional

from app.db.connection import get_connection, utc_now


def create_user(username: str, password_hash: str, role: str = "student") -> Dict[str, Any]:
    from app.auth import normalize_username
    now = utc_now()
    user_uuid = _uuid.uuid4().hex
    with get_connection() as conn:
        cur = conn.execute("""INSERT INTO users
            (username, normalized_username, password_hash, role, created_at,
             display_name, uuid)
            VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (username, normalize_username(username), password_hash, role, now,
             username, user_uuid))
        conn.commit()
        return get_user_by_id(cur.lastrowid)


def get_user_by_id(user_id: int) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    return dict(row) if row else None


def get_user_by_username(username: str) -> Optional[Dict[str, Any]]:
    from app.auth import normalize_username
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM users WHERE normalized_username=?",
                           (normalize_username(username),)).fetchone()
    return dict(row) if row else None


def update_password_hash(user_id: int, password_hash: str) -> None:
    with get_connection() as conn:
        conn.execute("UPDATE users SET password_hash=? WHERE id=?", (password_hash, user_id))
        conn.commit()


def update_display_name(user_id: int, display_name: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        conn.execute("UPDATE users SET display_name=? WHERE id=?", (display_name, user_id))
        conn.commit()
    return get_user_by_id(user_id)


def update_quiz_badge_selection(user_id: int, selection: str) -> Optional[Dict[str, Any]]:
    """Persist score/none or an earned subject title selection."""
    from app.db.games import get_user_quiz_title_options
    clean = selection.strip()
    if clean not in {"score", "none"}:
        earned = {item["selection"] for item in get_user_quiz_title_options(user_id)}
        if clean not in earned:
            raise ValueError("현재 획득한 칭호만 선택할 수 있습니다.")
    with get_connection() as conn:
        cur = conn.execute(
            "UPDATE users SET quiz_badge_selection=? WHERE id=?", (clean, user_id)
        )
        conn.commit()
    return get_user_by_id(user_id) if cur.rowcount else None


def list_users() -> List[Dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute("""SELECT u.id, u.username, u.display_name, u.uuid,
            u.role, u.active, u.created_at, u.last_login, u.last_login_ip,
            (SELECT COUNT(*) FROM messages m WHERE m.user_id=u.id) AS message_count,
            (SELECT COALESCE(SUM(a.size), 0) FROM attachments a
             WHERE a.uploader_user_id=u.id) AS attachment_bytes
            FROM users u
            ORDER BY u.role='admin' DESC, u.normalized_username""").fetchall()
        return [dict(row) for row in rows]


def list_mentionable_users() -> List[Dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT id, username, display_name FROM users WHERE active=1 ORDER BY normalized_username"
        ).fetchall()
        return [dict(row) for row in rows]


def count_active_admins() -> int:
    with get_connection() as conn:
        return int(conn.execute(
            "SELECT COUNT(*) FROM users WHERE role='admin' AND active=1"
        ).fetchone()[0])


def set_user_active(user_id: int, active: bool) -> None:
    with get_connection() as conn:
        conn.execute("UPDATE users SET active=? WHERE id=?", (int(active), user_id))
        if not active:
            conn.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
        conn.commit()


def set_user_role(user_id: int, role: str) -> None:
    with get_connection() as conn:
        conn.execute("UPDATE users SET role=? WHERE id=?", (role, user_id))
        conn.commit()


def delete_user_sessions(user_id: int) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
        conn.commit()


def create_session(session_hash: str, user_id: int, expires_at: str, client_ip: Optional[str] = None) -> None:
    now = utc_now()
    with get_connection() as conn:
        conn.execute("DELETE FROM sessions WHERE user_id=? OR expires_at<=?", (user_id, now))
        conn.execute("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)",
                     (session_hash, user_id, now, expires_at))
        if client_ip is not None:
            conn.execute("UPDATE users SET last_login=?, last_login_ip=? WHERE id=?", (now, client_ip, user_id))
        else:
            conn.execute("UPDATE users SET last_login=? WHERE id=?", (now, user_id))
        conn.commit()


def get_session_user(session_hash: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("""SELECT u.*, s.expires_at AS session_expires_at
            FROM sessions s JOIN users u ON u.id=s.user_id
            WHERE s.token_hash=? AND s.expires_at>? AND u.active=1""",
            (session_hash, utc_now())).fetchone()
    return dict(row) if row else None


def delete_session(session_hash: str) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM sessions WHERE token_hash=?", (session_hash,))
        conn.commit()


def prune_expired_sessions() -> int:
    with get_connection() as conn:
        cur = conn.execute("DELETE FROM sessions WHERE expires_at<=?", (utc_now(),))
        conn.commit()
        return cur.rowcount

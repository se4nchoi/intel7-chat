"""SQLite persistence for users, sessions, messages, and attachments."""
from __future__ import annotations

import os
import sqlite3
import uuid as _uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

_DEFAULT_DATA = Path(__file__).resolve().parent.parent / "data"
DB_PATH = _DEFAULT_DATA / "chat.db"
DB_MAX_BYTES = 3 * 1024**3

def configure_storage(data_dir: Path | str, max_db_bytes: int) -> None:
    global DB_PATH, DB_MAX_BYTES
    root = Path(data_dir).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    DB_PATH = root / "chat.db"
    DB_MAX_BYTES = int(max_db_bytes)

def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def get_connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn

def _add_column_if_missing(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

def init_db() -> None:
    with get_connection() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        page_size = int(conn.execute("PRAGMA page_size").fetchone()[0])
        max_pages = max(1024, DB_MAX_BYTES // page_size)
        conn.execute(f"PRAGMA max_page_count={max_pages}")
        conn.execute("""CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            normalized_username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'student',
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            last_login TEXT
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nickname TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            ip TEXT NOT NULL DEFAULT '',
            reply_nickname TEXT,
            reply_content TEXT,
            attachment_id TEXT,
            user_id INTEGER
        )""")
        for column, definition in (
            ("ip", "TEXT NOT NULL DEFAULT ''"),
            ("reply_nickname", "TEXT"),
            ("reply_content", "TEXT"),
            ("attachment_id", "TEXT"),
            ("user_id", "INTEGER"),
        ):
            _add_column_if_missing(conn, "messages", column, definition)
        conn.execute("""CREATE TABLE IF NOT EXISTS attachments (
            id TEXT PRIMARY KEY,
            original_name TEXT NOT NULL,
            stored_name TEXT NOT NULL UNIQUE,
            size INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            content_type TEXT NOT NULL,
            previewable INTEGER NOT NULL DEFAULT 0,
            uploader_nickname TEXT NOT NULL,
            ip TEXT NOT NULL,
            owner_token_hash TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            claimed INTEGER NOT NULL DEFAULT 0,
            uploader_user_id INTEGER
        )""")
        _add_column_if_missing(conn, "attachments", "owner_token_hash", "TEXT NOT NULL DEFAULT ''")
        _add_column_if_missing(conn, "attachments", "uploader_user_id", "INTEGER")
        conn.execute("""CREATE TABLE IF NOT EXISTS message_attachments (
            message_id INTEGER NOT NULL,
            attachment_id TEXT NOT NULL,
            original_name TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (message_id, attachment_id)
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS direct_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_user_id INTEGER NOT NULL,
            recipient_user_id INTEGER NOT NULL,
            sender_nickname TEXT NOT NULL,
            recipient_nickname TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            reply_nickname TEXT,
            reply_content TEXT,
            FOREIGN KEY(sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY(recipient_user_id) REFERENCES users(id) ON DELETE CASCADE
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS direct_message_attachments (
            direct_message_id INTEGER NOT NULL,
            attachment_id TEXT NOT NULL,
            original_name TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (direct_message_id, attachment_id),
            FOREIGN KEY(direct_message_id) REFERENCES direct_messages(id) ON DELETE CASCADE
        )""")
        conn.execute("""INSERT OR IGNORE INTO message_attachments
            (message_id, attachment_id, original_name, position)
            SELECT m.id, m.attachment_id, COALESCE(a.original_name, '파일'), 0
            FROM messages m LEFT JOIN attachments a ON a.id=m.attachment_id
            WHERE m.attachment_id IS NOT NULL AND m.attachment_id != ''""")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_dm_sender ON direct_messages(sender_user_id, id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_dm_recipient ON direct_messages(recipient_user_id, id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_dm_attachments_file ON direct_message_attachments(attachment_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(uploader_user_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)")
        conn.execute("""CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER NOT NULL
        )""")
        conn.commit()
        _run_migrations(conn)

def _get_schema_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT MAX(version) FROM schema_version").fetchone()
    return int(row[0]) if row and row[0] is not None else 0

def _set_schema_version(conn: sqlite3.Connection, version: int) -> None:
    conn.execute("DELETE FROM schema_version")
    conn.execute("INSERT INTO schema_version (version) VALUES (?)", (version,))

def _migrate_v1(conn: sqlite3.Connection) -> None:
    """Add display_name and uuid columns to users."""
    _add_column_if_missing(conn, "users", "display_name", "TEXT NOT NULL DEFAULT ''")
    _add_column_if_missing(conn, "users", "uuid", "TEXT NOT NULL DEFAULT ''")
    conn.execute("UPDATE users SET display_name = username WHERE display_name = ''")
    rows = conn.execute("SELECT id FROM users WHERE uuid = ''").fetchall()
    for row in rows:
        conn.execute("UPDATE users SET uuid = ? WHERE id = ?", (_uuid.uuid4().hex, row[0]))
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uuid ON users(uuid)")

_MIGRATIONS = [
    _migrate_v1,
]

def _run_migrations(conn: sqlite3.Connection) -> None:
    current = _get_schema_version(conn)
    for index, migrate in enumerate(_MIGRATIONS, start=1):
        if index <= current:
            continue
        try:
            conn.execute("BEGIN IMMEDIATE")
            migrate(conn)
            _set_schema_version(conn, index)
            conn.commit()
        except Exception:
            conn.rollback()
            raise

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

def list_users() -> List[Dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute("""SELECT u.id, u.username, u.display_name, u.uuid,
            u.role, u.active, u.created_at, u.last_login,
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

def create_session(session_hash: str, user_id: int, expires_at: str) -> None:
    now = utc_now()
    with get_connection() as conn:
        conn.execute("DELETE FROM sessions WHERE user_id=? OR expires_at<=?", (user_id, now))
        conn.execute("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)",
                     (session_hash, user_id, now, expires_at))
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

def _attachment_public(row: sqlite3.Row | Dict[str, Any] | None) -> Optional[Dict[str, Any]]:
    if not row:
        return None
    return {
        "id": row["id"], "name": row["original_name"], "size": row["size"],
        "sha256": row["sha256"], "content_type": row["content_type"],
        "previewable": bool(row["previewable"]), "url": f"/api/files/{row['id']}",
        "removed": False, "owner_id": row["uploader_user_id"],
    }

def _message_attachments(conn: sqlite3.Connection, ids: List[int]) -> Dict[int, List[Dict[str, Any]]]:
    result = {message_id: [] for message_id in ids}
    if not ids:
        return result
    marks = ",".join("?" for _ in ids)
    rows = conn.execute(f"""SELECT ma.*, a.id AS live_id, a.size, a.sha256,
        a.content_type, a.previewable, a.uploader_user_id
        FROM message_attachments ma LEFT JOIN attachments a ON a.id=ma.attachment_id
        WHERE ma.message_id IN ({marks}) ORDER BY ma.message_id, ma.position""", ids).fetchall()
    for row in rows:
        if row["live_id"]:
            item = {"id": row["attachment_id"], "name": row["original_name"], "size": row["size"],
                    "sha256": row["sha256"], "content_type": row["content_type"],
                    "previewable": bool(row["previewable"]), "url": f"/api/files/{row['attachment_id']}",
                    "removed": False, "owner_id": row["uploader_user_id"]}
        else:
            item = {"id": row["attachment_id"], "name": row["original_name"], "removed": True}
        result[row["message_id"]].append(item)
    return result

def _message_public(row: sqlite3.Row, attachments: List[Dict[str, Any]]) -> Dict[str, Any]:
    reply = None
    if row["reply_nickname"] or row["reply_content"]:
        reply = {"nickname": row["reply_nickname"] or "", "content": row["reply_content"] or ""}
    live = next((item for item in attachments if not item.get("removed")), None)
    return {"message_id": f"public:{row['id']}", "nickname": row["nickname"],
            "author_id": row["user_id"], "content": row["content"],
            "created_at": row["created_at"], "reply": reply, "attachment": live,
            "attachments": attachments, "attachment_removed": bool(attachments and not live)}

def save_message(nickname: str, content: str, ip: str = "", reply: Optional[Dict[str,str]] = None,
                 attachment_id: Optional[str] = None, attachment_ids: Optional[List[str]] = None,
                 user_id: Optional[int] = None) -> Dict[str, Any]:
    selected = list(dict.fromkeys(attachment_ids or ([] if not attachment_id else [attachment_id])))
    now = utc_now()
    with get_connection() as conn:
        cur = conn.execute("""INSERT INTO messages
            (nickname,content,created_at,ip,reply_nickname,reply_content,attachment_id,user_id)
            VALUES(?,?,?,?,?,?,?,?)""",
            (nickname, content, now, ip, reply.get("nickname","") if reply else None,
             reply.get("content","") if reply else None, selected[0] if selected else None, user_id))
        message_id = cur.lastrowid
        if selected:
            marks = ",".join("?" for _ in selected)
            names = {r["id"]: r["original_name"] for r in conn.execute(
                f"SELECT id,original_name FROM attachments WHERE id IN ({marks})", selected)}
            conn.executemany("""INSERT INTO message_attachments
                (message_id,attachment_id,original_name,position) VALUES(?,?,?,?)""",
                [(message_id, item, names.get(item, "파일"), pos) for pos,item in enumerate(selected)])
        row = conn.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        items = _message_attachments(conn, [message_id])[message_id]
        conn.commit()
    result = _message_public(row, items)
    result["ip"] = ip
    return result

def get_recent_messages(limit: int = 100, before_id: Optional[int] = None) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        if before_id is None:
            rows = conn.execute("""SELECT * FROM
                (SELECT * FROM messages ORDER BY id DESC LIMIT ?) ORDER BY id ASC""",
                (limit,)).fetchall()
        else:
            rows = conn.execute("""SELECT * FROM
                (SELECT * FROM messages WHERE id<? ORDER BY id DESC LIMIT ?)
                ORDER BY id ASC""", (before_id, limit)).fetchall()
        items = _message_attachments(conn, [row["id"] for row in rows])
    return [_message_public(row, items[row["id"]]) for row in rows]

def _direct_message_attachments(conn: sqlite3.Connection,
                                ids: List[int]) -> Dict[int, List[Dict[str, Any]]]:
    result = {message_id: [] for message_id in ids}
    if not ids:
        return result
    marks = ",".join("?" for _ in ids)
    rows = conn.execute(f"""SELECT dma.*, a.id AS live_id, a.size, a.sha256,
        a.content_type, a.previewable, a.uploader_user_id
        FROM direct_message_attachments dma
        LEFT JOIN attachments a ON a.id=dma.attachment_id
        WHERE dma.direct_message_id IN ({marks})
        ORDER BY dma.direct_message_id, dma.position""", ids).fetchall()
    for row in rows:
        if row["live_id"]:
            item = {"id": row["attachment_id"], "name": row["original_name"],
                    "size": row["size"], "sha256": row["sha256"],
                    "content_type": row["content_type"],
                    "previewable": bool(row["previewable"]),
                    "url": f"/api/files/{row['attachment_id']}", "removed": False,
                    "owner_id": row["uploader_user_id"]}
        else:
            item = {"id": row["attachment_id"], "name": row["original_name"],
                    "removed": True}
        result[row["direct_message_id"]].append(item)
    return result

def _direct_message_public(row: sqlite3.Row,
                           attachments: List[Dict[str, Any]]) -> Dict[str, Any]:
    reply = None
    if row["reply_nickname"] or row["reply_content"]:
        reply = {"nickname": row["reply_nickname"] or "",
                 "content": row["reply_content"] or ""}
    live = next((item for item in attachments if not item.get("removed")), None)
    return {"message_id": f"dm:{row['id']}", "from_nick": row["sender_nickname"],
            "from_user_id": row["sender_user_id"], "to_nick": row["recipient_nickname"],
            "to_user_id": row["recipient_user_id"], "content": row["content"],
            "created_at": row["created_at"], "reply": reply, "attachment": live,
            "attachments": attachments,
            "attachment_removed": bool(attachments and not live)}

def save_direct_message(sender: Dict[str, Any], recipient: Dict[str, Any], content: str,
                        reply: Optional[Dict[str, str]] = None,
                        attachment_ids: Optional[List[str]] = None) -> Dict[str, Any]:
    selected = list(dict.fromkeys(attachment_ids or []))
    with get_connection() as conn:
        cur = conn.execute("""INSERT INTO direct_messages
            (sender_user_id,recipient_user_id,sender_nickname,recipient_nickname,content,
             created_at,reply_nickname,reply_content) VALUES(?,?,?,?,?,?,?,?)""",
            (sender["id"], recipient["id"], sender["username"], recipient["username"],
             content, utc_now(), reply.get("nickname", "") if reply else None,
             reply.get("content", "") if reply else None))
        message_id = cur.lastrowid
        if selected:
            marks = ",".join("?" for _ in selected)
            names = {row["id"]: row["original_name"] for row in conn.execute(
                f"SELECT id,original_name FROM attachments WHERE id IN ({marks})", selected)}
            conn.executemany("""INSERT INTO direct_message_attachments
                (direct_message_id,attachment_id,original_name,position) VALUES(?,?,?,?)""",
                [(message_id, item, names.get(item, "파일"), position)
                 for position, item in enumerate(selected)])
        row = conn.execute("SELECT * FROM direct_messages WHERE id=?", (message_id,)).fetchone()
        items = _direct_message_attachments(conn, [message_id])[message_id]
        conn.commit()
    return _direct_message_public(row, items)

def get_recent_direct_messages(user_id: int, limit: int = 30) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute("""SELECT * FROM (
            SELECT dm.*, ROW_NUMBER() OVER (
                PARTITION BY CASE WHEN sender_user_id=? THEN recipient_user_id ELSE sender_user_id END
                ORDER BY id DESC
            ) AS conversation_row
            FROM direct_messages dm
            WHERE sender_user_id=? OR recipient_user_id=?
        ) WHERE conversation_row<=? ORDER BY id ASC""",
            (user_id, user_id, user_id, limit)).fetchall()
        items = _direct_message_attachments(conn, [row["id"] for row in rows])
    return [_direct_message_public(row, items[row["id"]]) for row in rows]

def get_direct_messages_between(user_id: int, partner_user_id: int, limit: int = 50,
                                before_id: Optional[int] = None) -> List[Dict[str, Any]]:
    params: List[Any] = [user_id, partner_user_id, partner_user_id, user_id]
    before_clause = ""
    if before_id is not None:
        before_clause = "AND id<?"
        params.append(before_id)
    params.append(limit)
    with get_connection() as conn:
        rows = conn.execute(f"""SELECT * FROM (
            SELECT * FROM direct_messages WHERE
            ((sender_user_id=? AND recipient_user_id=?) OR
             (sender_user_id=? AND recipient_user_id=?))
            {before_clause} ORDER BY id DESC LIMIT ?
        ) ORDER BY id ASC""", params).fetchall()
        items = _direct_message_attachments(conn, [row["id"] for row in rows])
    return [_direct_message_public(row, items[row["id"]]) for row in rows]

def attachment_is_visible_to_user(attachment_id: str, user_id: int) -> bool:
    with get_connection() as conn:
        dm_rows = conn.execute("""SELECT dm.sender_user_id, dm.recipient_user_id
            FROM direct_message_attachments dma
            JOIN direct_messages dm ON dm.id=dma.direct_message_id
            WHERE dma.attachment_id=?""", (attachment_id,)).fetchall()
    if not dm_rows:
        return True
    return any(user_id in {row["sender_user_id"], row["recipient_user_id"]}
               for row in dm_rows)

def save_attachment(metadata: Dict[str, Any]) -> Dict[str, Any]:
    with get_connection() as conn:
        conn.execute("""INSERT INTO attachments
            (id,original_name,stored_name,size,sha256,content_type,previewable,
             uploader_nickname,ip,owner_token_hash,created_at,claimed,uploader_user_id)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)""",
            (metadata["id"], metadata["original_name"], metadata["stored_name"], metadata["size"],
             metadata["sha256"], metadata["content_type"], int(metadata["previewable"]),
             metadata["uploader_nickname"], metadata["ip"], "", metadata.get("created_at", utc_now()),
             metadata["uploader_user_id"]))
        conn.commit()
    return get_attachment_public(metadata["id"])

def get_attachment_record(attachment_id: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM attachments WHERE id=?", (attachment_id,)).fetchone()
    return dict(row) if row else None

def get_attachment_public(attachment_id: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM attachments WHERE id=?", (attachment_id,)).fetchone()
    return _attachment_public(row)

def claim_attachments(attachment_ids: List[str], user_id: int) -> Optional[List[Dict[str, Any]]]:
    selected = list(dict.fromkeys(attachment_ids))
    if not selected:
        return []
    marks = ",".join("?" for _ in selected)
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        rows = conn.execute(f"""SELECT * FROM attachments WHERE id IN ({marks})
            AND uploader_user_id=? AND claimed=0""", [*selected, user_id]).fetchall()
        by_id = {row["id"]: row for row in rows}
        if len(rows) != len(selected) or any(item not in by_id for item in selected):
            conn.rollback()
            return None
        conn.executemany("UPDATE attachments SET claimed=1 WHERE id=? AND claimed=0",
                         [(item,) for item in selected])
        conn.commit()
    return [_attachment_public(by_id[item]) for item in selected]

def delete_owned_attachment(attachment_id: str, user_id: int, is_admin: bool = False) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        if is_admin:
            row = conn.execute("SELECT stored_name,claimed FROM attachments WHERE id=?",
                               (attachment_id,)).fetchone()
        else:
            row = conn.execute("""SELECT stored_name,claimed FROM attachments
                WHERE id=? AND uploader_user_id=?""", (attachment_id, user_id)).fetchone()
        if not row:
            return None
        conn.execute("DELETE FROM attachments WHERE id=?", (attachment_id,))
        conn.commit()
    return dict(row)

def get_upload_usage(user_id: int) -> Tuple[int, int]:
    with get_connection() as conn:
        mine = conn.execute("SELECT COALESCE(SUM(size),0) FROM attachments WHERE uploader_user_id=?",
                            (user_id,)).fetchone()[0]
        total = conn.execute("SELECT COALESCE(SUM(size),0) FROM attachments").fetchone()[0]
    return int(mine), int(total)

def get_storage_status() -> Dict[str, int]:
    db_bytes = sum(path.stat().st_size for path in (
        DB_PATH, Path(str(DB_PATH)+"-wal"), Path(str(DB_PATH)+"-shm")) if path.exists())
    with get_connection() as conn:
        attachment_bytes = int(conn.execute("SELECT COALESCE(SUM(size),0) FROM attachments").fetchone()[0])
    return {"database_bytes": db_bytes, "database_limit_bytes": DB_MAX_BYTES,
            "attachment_bytes": attachment_bytes}

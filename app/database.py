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
            ("edited_at", "TEXT"),
            ("is_hidden", "INTEGER NOT NULL DEFAULT 0"),
            ("moved_from_channel_id", "INTEGER"),
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

def _migrate_v2(conn: sqlite3.Connection) -> None:
    """Create channels table, seed default permanent general channel, and add channel_id to messages."""
    conn.execute("""CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        uuid TEXT NOT NULL UNIQUE,
        created_by_user_id INTEGER,
        is_default INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY(created_by_user_id) REFERENCES users(id)
    )""")
    _add_column_if_missing(conn, "channels", "archived", "INTEGER NOT NULL DEFAULT 0")
    now = utc_now()
    default_uuid = _uuid.uuid4().hex
    conn.execute("""INSERT OR IGNORE INTO channels
        (id, name, display_name, description, uuid, is_default, archived, created_at)
        VALUES (1, 'general', '전체 채팅', '기본 전체 공개 대화방', ?, 1, 0, ?)""",
        (default_uuid, now))
    _add_column_if_missing(conn, "messages", "channel_id", "INTEGER NOT NULL DEFAULT 1")
    conn.execute("UPDATE messages SET channel_id = 1 WHERE channel_id IS NULL OR channel_id = 0")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, id)")

def _migrate_v3(conn: sqlite3.Connection) -> None:
    """Add archived column to channels; add edited_at, is_hidden, moved_from_channel_id to messages."""
    _add_column_if_missing(conn, "channels", "archived", "INTEGER NOT NULL DEFAULT 0")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_channels_archived ON channels(archived)")
    _add_column_if_missing(conn, "messages", "edited_at", "TEXT")
    _add_column_if_missing(conn, "messages", "is_hidden", "INTEGER NOT NULL DEFAULT 0")
    _add_column_if_missing(conn, "messages", "moved_from_channel_id", "INTEGER")

ALLOWED_REACTION_EMOJIS = {"👍", "❤️", "😂", "😮", "😢", "👏", "✅", "❌", "👀"}

def _migrate_v4(conn: sqlite3.Connection) -> None:
    """Create user_conversation_state table for read tracking and notification muting."""
    conn.execute("""CREATE TABLE IF NOT EXISTS user_conversation_state (
        user_id INTEGER NOT NULL,
        conversation_type TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        last_read_message_id INTEGER NOT NULL DEFAULT 0,
        muted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, conversation_type, conversation_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ucs_user ON user_conversation_state(user_id)")

def _migrate_v5(conn: sqlite3.Connection) -> None:
    """Create message_reactions table for channel and DM message reactions."""
    conn.execute("""CREATE TABLE IF NOT EXISTS message_reactions (
        message_type TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_type, message_id, user_id, emoji),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reactions_target ON message_reactions(message_type, message_id)")

def _migrate_v6(conn: sqlite3.Connection) -> None:
    """Add edited_at column to direct_messages."""
    _add_column_if_missing(conn, "direct_messages", "edited_at", "TEXT")

_MIGRATIONS = [
    _migrate_v1,
    _migrate_v2,
    _migrate_v3,
    _migrate_v4,
    _migrate_v5,
    _migrate_v6,
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

def create_channel(name: str, display_name: str, description: str = "",
                   created_by_user_id: Optional[int] = None) -> Dict[str, Any]:
    from app.auth import validate_channel_description, validate_channel_display_name, validate_channel_name
    clean_name = validate_channel_name(name)
    clean_display = validate_channel_display_name(display_name)
    clean_desc = validate_channel_description(description)
    now = utc_now()
    chan_uuid = _uuid.uuid4().hex
    with get_connection() as conn:
        cur = conn.execute("""INSERT INTO channels
            (name, display_name, description, uuid, created_by_user_id, is_default, created_at)
            VALUES (?, ?, ?, ?, ?, 0, ?)""",
            (clean_name, clean_display, clean_desc, chan_uuid, created_by_user_id, now))
        conn.commit()
        return get_channel_by_id(cur.lastrowid)

def get_channel_by_id(channel_id: int) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM channels WHERE id=?", (channel_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["is_default"] = bool(d.get("is_default"))
    d["archived"] = bool(d.get("archived"))
    return d

def get_channel_by_name(name: str) -> Optional[Dict[str, Any]]:
    clean_name = name.strip().casefold()
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM channels WHERE name=?", (clean_name,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["is_default"] = bool(d.get("is_default"))
    d["archived"] = bool(d.get("archived"))
    return d

def list_channels(include_archived: bool = False) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        where_clause = "" if include_archived else "WHERE c.archived = 0"
        rows = conn.execute(f"""SELECT c.*,
            (SELECT COUNT(*) FROM messages m WHERE m.channel_id=c.id) AS message_count
            FROM channels c
            {where_clause}
            ORDER BY c.is_default DESC, c.id ASC""").fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["is_default"] = bool(d.get("is_default"))
            d["archived"] = bool(d.get("archived"))
            result.append(d)
        return result

def channel_exists(channel_id: int) -> bool:
    with get_connection() as conn:
        row = conn.execute("SELECT 1 FROM channels WHERE id=?", (channel_id,)).fetchone()
        return bool(row)

def update_channel(channel_id: int, name: Optional[str] = None,
                   display_name: Optional[str] = None,
                   description: Optional[str] = None) -> Optional[Dict[str, Any]]:
    from app.auth import validate_channel_description, validate_channel_display_name, validate_channel_name
    current = get_channel_by_id(channel_id)
    if not current:
        return None
    new_name = validate_channel_name(name) if name is not None else current["name"]
    new_display = validate_channel_display_name(display_name) if display_name is not None else current["display_name"]
    new_desc = validate_channel_description(description) if description is not None else current["description"]
    with get_connection() as conn:
        conn.execute("""UPDATE channels
            SET name=?, display_name=?, description=?
            WHERE id=?""",
            (new_name, new_display, new_desc, channel_id))
        conn.commit()
    return get_channel_by_id(channel_id)

def archive_channel(channel_id: int, unarchive: bool = False) -> Optional[Dict[str, Any]]:
    current = get_channel_by_id(channel_id)
    if not current:
        return None
    if current.get("is_default") and not unarchive:
        raise ValueError("기본 채널은 보관할 수 없습니다.")
    val = 0 if unarchive else 1
    with get_connection() as conn:
        conn.execute("UPDATE channels SET archived=? WHERE id=?", (val, channel_id))
        conn.commit()
    return get_channel_by_id(channel_id)

def delete_channel(channel_id: int) -> Optional[List[str]]:
    current = get_channel_by_id(channel_id)
    if not current:
        return None
    if current.get("is_default"):
        raise ValueError("기본 채널은 삭제할 수 없습니다.")
    stored_files_to_remove: List[str] = []
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        msg_rows = conn.execute("SELECT id FROM messages WHERE channel_id=?", (channel_id,)).fetchall()
        msg_ids = [r[0] for r in msg_rows]
        if msg_ids:
            marks = ",".join("?" for _ in msg_ids)
            att_rows = conn.execute(f"SELECT DISTINCT attachment_id FROM message_attachments WHERE message_id IN ({marks})", msg_ids).fetchall()
            att_ids = [r[0] for r in att_rows if r[0]]
            conn.execute(f"DELETE FROM message_attachments WHERE message_id IN ({marks})", msg_ids)
            conn.execute(f"DELETE FROM message_reactions WHERE message_type='channel' AND message_id IN ({marks})", msg_ids)
            for att_id in att_ids:
                in_msgs = conn.execute("SELECT 1 FROM message_attachments WHERE attachment_id=?", (att_id,)).fetchone()
                in_dms = conn.execute("SELECT 1 FROM direct_message_attachments WHERE attachment_id=?", (att_id,)).fetchone()
                if not in_msgs and not in_dms:
                    rec = conn.execute("SELECT stored_name FROM attachments WHERE id=?", (att_id,)).fetchone()
                    if rec:
                        stored_files_to_remove.append(rec["stored_name"])
                        conn.execute("DELETE FROM attachments WHERE id=?", (att_id,))
            conn.execute(f"DELETE FROM messages WHERE id IN ({marks})", msg_ids)
        conn.execute("DELETE FROM user_conversation_state WHERE conversation_type='channel' AND conversation_id=?", (str(channel_id),))
        conn.execute("DELETE FROM channels WHERE id=?", (channel_id,))
        conn.commit()
    return stored_files_to_remove

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

def get_reactions_for_messages(
    conn: sqlite3.Connection,
    message_type: str,
    message_ids: List[int],
    current_user_id: Optional[int] = None,
) -> Dict[int, List[Dict[str, Any]]]:
    result: Dict[int, List[Dict[str, Any]]] = {mid: [] for mid in message_ids}
    if not message_ids:
        return result
    marks = ",".join("?" for _ in message_ids)
    rows = conn.execute(f"""
        SELECT mr.message_id, mr.emoji, mr.user_id, mr.created_at,
               u.username, u.display_name
        FROM message_reactions mr
        JOIN users u ON u.id = mr.user_id
        WHERE mr.message_type = ? AND mr.message_id IN ({marks})
        ORDER BY mr.created_at ASC, mr.rowid ASC
    """, [message_type, *message_ids]).fetchall()

    grouped: Dict[int, Dict[str, Dict[str, Any]]] = {mid: {} for mid in message_ids}
    for row in rows:
        mid = row["message_id"]
        emoji = row["emoji"]
        uid = row["user_id"]
        user_info = {
            "id": uid,
            "username": row["username"],
            "display_name": row["display_name"] or row["username"],
        }
        if emoji not in grouped[mid]:
            grouped[mid][emoji] = {
                "emoji": emoji,
                "count": 0,
                "reacted_by_me": False,
                "users": [],
            }
        grouped[mid][emoji]["count"] += 1
        grouped[mid][emoji]["users"].append(user_info)
        if current_user_id is not None and uid == current_user_id:
            grouped[mid][emoji]["reacted_by_me"] = True

    for mid in message_ids:
        result[mid] = list(grouped[mid].values())
    return result

def toggle_message_reaction(
    message_type: str,
    message_id: int,
    user_id: int,
    emoji: str,
) -> bool:
    """Toggles reaction on a message. Returns True if added, False if removed."""
    if emoji not in ALLOWED_REACTION_EMOJIS:
        raise ValueError(f"Invalid reaction emoji: {emoji}")
    with get_connection() as conn:
        existing = conn.execute("""
            SELECT 1 FROM message_reactions
            WHERE message_type = ? AND message_id = ? AND user_id = ? AND emoji = ?
        """, (message_type, message_id, user_id, emoji)).fetchone()
        if existing:
            conn.execute("""
                DELETE FROM message_reactions
                WHERE message_type = ? AND message_id = ? AND user_id = ? AND emoji = ?
            """, (message_type, message_id, user_id, emoji))
            conn.commit()
            return False
        else:
            conn.execute("""
                INSERT INTO message_reactions (message_type, message_id, user_id, emoji, created_at)
                VALUES (?, ?, ?, ?, ?)
            """, (message_type, message_id, user_id, emoji, utc_now()))
            conn.commit()
            return True

def get_message_reactions(
    message_type: str,
    message_id: int,
    current_user_id: Optional[int] = None,
) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        res = get_reactions_for_messages(conn, message_type, [message_id], current_user_id)
        return res.get(message_id, [])

def _message_public(row: sqlite3.Row, attachments: List[Dict[str, Any]], reactions: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    reply = None
    if row["reply_nickname"] or row["reply_content"]:
        reply = {"nickname": row["reply_nickname"] or "", "content": row["reply_content"] or ""}
    live = next((item for item in attachments if not item.get("removed")), None)
    keys = row.keys() if hasattr(row, 'keys') else row
    channel_id = row["channel_id"] if "channel_id" in keys else 1
    edited_at = row["edited_at"] if "edited_at" in keys else None
    is_hidden = bool(row["is_hidden"]) if "is_hidden" in keys else False
    moved_from = row["moved_from_channel_id"] if "moved_from_channel_id" in keys else None
    return {"message_id": f"public:{row['id']}", "nickname": row["nickname"],
            "author_id": row["user_id"], "channel_id": channel_id, "content": row["content"],
            "created_at": row["created_at"], "edited_at": edited_at, "is_hidden": is_hidden,
            "moved_from_channel_id": moved_from, "reply": reply, "attachment": live,
            "attachments": attachments, "attachment_removed": bool(attachments and not live),
            "reactions": reactions if reactions is not None else []}

def get_message_by_id(message_id: int, current_user_id: Optional[int] = None) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        if not row:
            return None
        attachments = _message_attachments(conn, [message_id]).get(message_id, [])
        reactions = get_reactions_for_messages(conn, "channel", [message_id], current_user_id).get(message_id, [])
        return _message_public(row, attachments, reactions)

def update_message_content(message_id: int, new_content: str, user_id: int, is_admin: bool = False) -> Optional[Dict[str, Any]]:
    now = utc_now()
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        if not row:
            return None
        if not is_admin and row["user_id"] != user_id:
            raise PermissionError("본인이 작성한 메시지만 수정할 수 있습니다.")
        conn.execute("UPDATE messages SET content=?, edited_at=? WHERE id=?",
                     (new_content, now, message_id))
        conn.commit()
    return get_message_by_id(message_id, user_id)

def set_message_hidden(message_id: int, is_hidden: bool) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        if not row:
            return None
        conn.execute("UPDATE messages SET is_hidden=? WHERE id=?",
                     (1 if is_hidden else 0, message_id))
        conn.commit()
    return get_message_by_id(message_id)

def move_message_channel(message_id: int, to_channel_id: int) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        if not row:
            return None
        from_channel_id = row["channel_id"] if "channel_id" in row.keys() else 1
        conn.execute("UPDATE messages SET channel_id=?, moved_from_channel_id=? WHERE id=?",
                     (to_channel_id, from_channel_id, message_id))
        conn.commit()
    return get_message_by_id(message_id)

def save_message(nickname: str, content: str, ip: str = "", reply: Optional[Dict[str,str]] = None,
                 attachment_id: Optional[str] = None, attachment_ids: Optional[List[str]] = None,
                 user_id: Optional[int] = None, channel_id: int = 1) -> Dict[str, Any]:
    selected = list(dict.fromkeys(attachment_ids or ([] if not attachment_id else [attachment_id])))
    now = utc_now()
    with get_connection() as conn:
        cur = conn.execute("""INSERT INTO messages
            (nickname,content,created_at,ip,reply_nickname,reply_content,attachment_id,user_id,channel_id)
            VALUES(?,?,?,?,?,?,?,?,?)""",
            (nickname, content, now, ip, reply.get("nickname","") if reply else None,
             reply.get("content","") if reply else None, selected[0] if selected else None,
             user_id, channel_id))
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
    result = _message_public(row, items, [])
    result["ip"] = ip
    return result

def get_recent_messages(limit: int = 100, before_id: Optional[int] = None,
                        channel_id: int = 1, current_user_id: Optional[int] = None) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        if before_id is None:
            rows = conn.execute("""SELECT * FROM
                (SELECT * FROM messages WHERE channel_id=? ORDER BY id DESC LIMIT ?) ORDER BY id ASC""",
                (channel_id, limit)).fetchall()
        else:
            rows = conn.execute("""SELECT * FROM
                (SELECT * FROM messages WHERE channel_id=? AND id<? ORDER BY id DESC LIMIT ?)
                ORDER BY id ASC""", (channel_id, before_id, limit)).fetchall()
        msg_ids = [row["id"] for row in rows]
        items = _message_attachments(conn, msg_ids)
        reactions = get_reactions_for_messages(conn, "channel", msg_ids, current_user_id)
    return [_message_public(row, items[row["id"]], reactions.get(row["id"], [])) for row in rows]

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
                           attachments: List[Dict[str, Any]],
                           reactions: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    reply = None
    if row["reply_nickname"] or row["reply_content"]:
        reply = {"nickname": row["reply_nickname"] or "",
                 "content": row["reply_content"] or ""}
    live = next((item for item in attachments if not item.get("removed")), None)
    keys = row.keys() if hasattr(row, 'keys') else row
    edited_at = row["edited_at"] if "edited_at" in keys else None
    return {"message_id": f"dm:{row['id']}", "from_nick": row["sender_nickname"],
            "from_user_id": row["sender_user_id"], "to_nick": row["recipient_nickname"],
            "to_user_id": row["recipient_user_id"], "content": row["content"],
            "created_at": row["created_at"], "edited_at": edited_at, "reply": reply, "attachment": live,
            "attachments": attachments,
            "attachment_removed": bool(attachments and not live),
            "reactions": reactions if reactions is not None else []}

def get_direct_message_by_id(dm_id: int, current_user_id: Optional[int] = None) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM direct_messages WHERE id=?", (dm_id,)).fetchone()
        if not row:
            return None
        items = _direct_message_attachments(conn, [dm_id]).get(dm_id, [])
        reactions = get_reactions_for_messages(conn, "dm", [dm_id], current_user_id).get(dm_id, [])
        return _direct_message_public(row, items, reactions)

def update_direct_message_content(dm_id: int, new_content: str, user_id: int) -> Optional[Dict[str, Any]]:
    now = utc_now()
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM direct_messages WHERE id=?", (dm_id,)).fetchone()
        if not row:
            return None
        if row["sender_user_id"] != user_id:
            raise PermissionError("본인이 작성한 1:1 메시지만 수정할 수 있습니다.")
        conn.execute("UPDATE direct_messages SET content=?, edited_at=? WHERE id=?",
                     (new_content, now, dm_id))
        conn.commit()
    return get_direct_message_by_id(dm_id, user_id)

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
    return _direct_message_public(row, items, [])

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
        msg_ids = [row["id"] for row in rows]
        items = _direct_message_attachments(conn, msg_ids)
        reactions = get_reactions_for_messages(conn, "dm", msg_ids, user_id)
    return [_direct_message_public(row, items[row["id"]], reactions.get(row["id"], [])) for row in rows]

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
        msg_ids = [row["id"] for row in rows]
        items = _direct_message_attachments(conn, msg_ids)
        reactions = get_reactions_for_messages(conn, "dm", msg_ids, user_id)
    return [_direct_message_public(row, items[row["id"]], reactions.get(row["id"], [])) for row in rows]

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

def get_user_conversation_states(user_id: int) -> Dict[str, Dict[str, Any]]:
    """Returns mapping of 'type:id' -> {last_read_message_id, muted, updated_at}."""
    with get_connection() as conn:
        rows = conn.execute("""SELECT conversation_type, conversation_id, last_read_message_id, muted, updated_at
            FROM user_conversation_state WHERE user_id = ?""", (user_id,)).fetchall()
        states = {}
        for row in rows:
            key = f"{row[0]}:{row[1]}"
            states[key] = {
                "conversation_type": row[0],
                "conversation_id": row[1],
                "last_read_message_id": int(row[2]),
                "muted": bool(row[3]),
                "updated_at": row[4]
            }
        return states

def update_user_read_state(user_id: int, conv_type: str, conv_id: str, last_read_id: int) -> Dict[str, Any]:
    """Updates last_read_message_id for a conversation, advancing it forward."""
    conv_id = str(conv_id)
    last_read_id = int(last_read_id)
    now = utc_now()
    with get_connection() as conn:
        row = conn.execute("""SELECT last_read_message_id, muted FROM user_conversation_state
            WHERE user_id = ? AND conversation_type = ? AND conversation_id = ?""",
            (user_id, conv_type, conv_id)).fetchone()
        if row:
            curr_last_read = int(row[0])
            muted = int(row[1])
            new_last_read = max(curr_last_read, last_read_id)
            conn.execute("""UPDATE user_conversation_state
                SET last_read_message_id = ?, updated_at = ?
                WHERE user_id = ? AND conversation_type = ? AND conversation_id = ?""",
                (new_last_read, now, user_id, conv_type, conv_id))
            conn.commit()
            return {
                "conversation_type": conv_type,
                "conversation_id": conv_id,
                "last_read_message_id": new_last_read,
                "muted": bool(muted),
                "updated_at": now
            }
        else:
            conn.execute("""INSERT INTO user_conversation_state
                (user_id, conversation_type, conversation_id, last_read_message_id, muted, updated_at)
                VALUES (?, ?, ?, ?, 0, ?)""",
                (user_id, conv_type, conv_id, last_read_id, now))
            conn.commit()
            return {
                "conversation_type": conv_type,
                "conversation_id": conv_id,
                "last_read_message_id": last_read_id,
                "muted": False,
                "updated_at": now
            }

def set_conversation_muted(user_id: int, conv_type: str, conv_id: str, muted: bool) -> Dict[str, Any]:
    """Sets muted flag for a conversation."""
    conv_id = str(conv_id)
    muted_int = 1 if muted else 0
    now = utc_now()
    with get_connection() as conn:
        row = conn.execute("""SELECT last_read_message_id FROM user_conversation_state
            WHERE user_id = ? AND conversation_type = ? AND conversation_id = ?""",
            (user_id, conv_type, conv_id)).fetchone()
        if row:
            last_read_id = int(row[0])
            conn.execute("""UPDATE user_conversation_state
                SET muted = ?, updated_at = ?
                WHERE user_id = ? AND conversation_type = ? AND conversation_id = ?""",
                (muted_int, now, user_id, conv_type, conv_id))
        else:
            last_read_id = 0
            conn.execute("""INSERT INTO user_conversation_state
                (user_id, conversation_type, conversation_id, last_read_message_id, muted, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)""",
                (user_id, conv_type, conv_id, 0, muted_int, now))
        conn.commit()
        return {
            "conversation_type": conv_type,
            "conversation_id": conv_id,
            "last_read_message_id": last_read_id,
            "muted": bool(muted),
            "updated_at": now
        }

def get_user_unread_counts(user_id: int) -> Dict[str, int]:
    """Calculates unread message count for each channel and DM conversation of user."""
    unread_counts = {}
    with get_connection() as conn:
        states = {}
        for r in conn.execute("""SELECT conversation_type, conversation_id, last_read_message_id
            FROM user_conversation_state WHERE user_id = ?""", (user_id,)).fetchall():
            states[f"{r[0]}:{r[1]}"] = int(r[2])
        
        # Channels (exclude messages authored by user_id)
        chans = conn.execute("SELECT id FROM channels WHERE archived = 0").fetchall()
        for chan in chans:
            cid = chan[0]
            key = f"channel:{cid}"
            last_read = states.get(key, 0)
            cnt = conn.execute("""SELECT COUNT(*) FROM messages
                WHERE channel_id = ? AND id > ? AND (user_id IS NULL OR user_id != ?)""",
                (cid, last_read, user_id)).fetchone()[0]
            unread_counts[key] = cnt
            
        # DMs (conversations where this user is recipient and message is unread from sender_id)
        dm_rows = conn.execute("""SELECT sender_user_id, id FROM direct_messages
            WHERE recipient_user_id = ? AND sender_user_id != ? ORDER BY id ASC""", (user_id, user_id)).fetchall()
        
        # Group by partner (sender)
        for sender_id, msg_id in dm_rows:
            key = f"dm:{sender_id}"
            last_read = states.get(key, 0)
            if msg_id > last_read:
                unread_counts[key] = unread_counts.get(key, 0) + 1
        
    return unread_counts

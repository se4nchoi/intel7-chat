"""
database.py - SQLite persistence for public messages and short-lived attachments.
"""

import ipaddress
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

# ----- 설정 -----
DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "chat.db")
MESSAGE_RETENTION_HOURS = 10
# ----------------


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def retention_cutoff() -> str:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=MESSAGE_RETENTION_HOURS)
    return cutoff.strftime("%Y-%m-%dT%H:%M:%SZ")


def get_ip_suffix(ip: str) -> str:
    """Return the final two IPv4 octets (or IPv6 groups) for display."""
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return ""
    if isinstance(address, ipaddress.IPv4Address):
        return ".".join(str(address).split(".")[-2:])
    return ":".join(address.exploded.split(":")[-2:])


def get_connection() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _add_column_if_missing(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def init_db() -> None:
    with get_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                nickname       TEXT NOT NULL,
                content        TEXT NOT NULL,
                created_at     TEXT NOT NULL,
                ip             TEXT NOT NULL DEFAULT '',
                reply_nickname TEXT,
                reply_content  TEXT,
                attachment_id  TEXT
            )
            """
        )
        _add_column_if_missing(conn, "messages", "ip", "TEXT NOT NULL DEFAULT ''")
        _add_column_if_missing(conn, "messages", "reply_nickname", "TEXT")
        _add_column_if_missing(conn, "messages", "reply_content", "TEXT")
        _add_column_if_missing(conn, "messages", "attachment_id", "TEXT")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS attachments (
                id                TEXT PRIMARY KEY,
                original_name     TEXT NOT NULL,
                stored_name       TEXT NOT NULL UNIQUE,
                size              INTEGER NOT NULL,
                sha256            TEXT NOT NULL,
                content_type      TEXT NOT NULL,
                previewable       INTEGER NOT NULL DEFAULT 0,
                uploader_nickname TEXT NOT NULL,
                ip                TEXT NOT NULL,
                created_at        TEXT NOT NULL,
                claimed           INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_attachments_created_at ON attachments(created_at)")
        conn.commit()


def _attachment_from_row(row: sqlite3.Row, prefix: str = "") -> Optional[Dict[str, Any]]:
    attachment_id = row[f"{prefix}attachment_id"] if f"{prefix}attachment_id" in row.keys() else row["id"]
    if not attachment_id:
        return None
    return {
        "id": attachment_id,
        "name": row[f"{prefix}original_name"],
        "size": row[f"{prefix}size"],
        "sha256": row[f"{prefix}sha256"],
        "content_type": row[f"{prefix}content_type"],
        "previewable": bool(row[f"{prefix}previewable"]),
        "url": f"/api/files/{attachment_id}",
    }


def _message_from_row(row: sqlite3.Row, include_ip: bool = False) -> Dict[str, Any]:
    reply = None
    if row["reply_nickname"] or row["reply_content"]:
        reply = {
            "nickname": row["reply_nickname"] or "",
            "content": row["reply_content"] or "",
        }
    result: Dict[str, Any] = {
        "message_id": f"public:{row['id']}",
        "nickname": row["nickname"],
        "content": row["content"],
        "created_at": row["created_at"],
        "ip_suffix": get_ip_suffix(row["ip"]),
        "reply": reply,
        "attachment": _attachment_from_row(row, "a_"),
    }
    if include_ip:
        result["ip"] = row["ip"]
    return result


def save_message(
    nickname: str,
    content: str,
    ip: str = "",
    reply: Optional[Dict[str, str]] = None,
    attachment_id: Optional[str] = None,
) -> Dict[str, Any]:
    now = utc_now()
    reply_nickname = reply.get("nickname", "") if reply else None
    reply_content = reply.get("content", "") if reply else None
    with get_connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO messages (
                nickname, content, created_at, ip, reply_nickname, reply_content, attachment_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (nickname, content, now, ip, reply_nickname, reply_content, attachment_id),
        )
        row_id = cursor.lastrowid
        row = conn.execute(
            """
            SELECT m.*, a.id AS a_attachment_id, a.original_name AS a_original_name,
                   a.size AS a_size, a.sha256 AS a_sha256,
                   a.content_type AS a_content_type, a.previewable AS a_previewable
            FROM messages m
            LEFT JOIN attachments a ON a.id = m.attachment_id
            WHERE m.id = ?
            """,
            (row_id,),
        ).fetchone()
        conn.commit()
    return _message_from_row(row, include_ip=True)


def get_recent_messages(limit: int = 100) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT m.*, a.id AS a_attachment_id, a.original_name AS a_original_name,
                   a.size AS a_size, a.sha256 AS a_sha256,
                   a.content_type AS a_content_type, a.previewable AS a_previewable
            FROM (
                SELECT * FROM messages
                WHERE created_at >= ?
                ORDER BY id DESC
                LIMIT ?
            ) AS m
            LEFT JOIN attachments a ON a.id = m.attachment_id
            ORDER BY m.id ASC
            """,
            (retention_cutoff(), limit),
        ).fetchall()
    return [_message_from_row(row) for row in rows]


def save_attachment(metadata: Dict[str, Any]) -> Dict[str, Any]:
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO attachments (
                id, original_name, stored_name, size, sha256, content_type,
                previewable, uploader_nickname, ip, created_at, claimed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            """,
            (
                metadata["id"],
                metadata["original_name"],
                metadata["stored_name"],
                metadata["size"],
                metadata["sha256"],
                metadata["content_type"],
                int(metadata["previewable"]),
                metadata["uploader_nickname"],
                metadata["ip"],
                metadata.get("created_at", utc_now()),
            ),
        )
        conn.commit()
    return get_attachment_public(metadata["id"])


def get_attachment_record(attachment_id: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM attachments WHERE id = ?", (attachment_id,)).fetchone()
    return dict(row) if row else None


def get_attachment_public(attachment_id: str) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute(
            """
            SELECT id AS attachment_id, original_name, size, sha256,
                   content_type, previewable
            FROM attachments WHERE id = ?
            """,
            (attachment_id,),
        ).fetchone()
    return _attachment_from_row(row) if row else None


def claim_attachment(
    attachment_id: str,
    nickname: str,
    ip: str,
) -> Optional[Dict[str, Any]]:
    """Claim an uploaded file once, for a message from the same active client."""
    with get_connection() as conn:
        row = conn.execute(
            """
            SELECT * FROM attachments
            WHERE id = ? AND uploader_nickname = ? AND ip = ? AND claimed = 0
              AND created_at >= ?
            """,
            (attachment_id, nickname, ip, retention_cutoff()),
        ).fetchone()
        if not row:
            return None
        conn.execute("UPDATE attachments SET claimed = 1 WHERE id = ?", (attachment_id,))
        conn.commit()
    return get_attachment_public(attachment_id)


def delete_unclaimed_attachment(attachment_id: str, nickname: str, ip: str) -> Optional[str]:
    with get_connection() as conn:
        row = conn.execute(
            """
            SELECT stored_name FROM attachments
            WHERE id = ? AND uploader_nickname = ? AND ip = ? AND claimed = 0
            """,
            (attachment_id, nickname, ip),
        ).fetchone()
        if not row:
            return None
        conn.execute("DELETE FROM attachments WHERE id = ?", (attachment_id,))
        conn.commit()
    return row["stored_name"]


def get_upload_usage(ip: str) -> Tuple[int, int]:
    cutoff = retention_cutoff()
    with get_connection() as conn:
        per_ip = conn.execute(
            "SELECT COALESCE(SUM(size), 0) FROM attachments WHERE ip = ? AND created_at >= ?",
            (ip, cutoff),
        ).fetchone()[0]
        total = conn.execute(
            "SELECT COALESCE(SUM(size), 0) FROM attachments WHERE created_at >= ?",
            (cutoff,),
        ).fetchone()[0]
    return int(per_ip), int(total)


def delete_expired_records() -> Tuple[int, List[str]]:
    cutoff = retention_cutoff()
    with get_connection() as conn:
        message_cursor = conn.execute("DELETE FROM messages WHERE created_at < ?", (cutoff,))
        expired = conn.execute(
            "SELECT stored_name FROM attachments WHERE created_at < ?", (cutoff,)
        ).fetchall()
        conn.execute("DELETE FROM attachments WHERE created_at < ?", (cutoff,))
        conn.commit()
    return message_cursor.rowcount, [row["stored_name"] for row in expired]


def delete_expired_messages() -> int:
    """Backward-compatible helper used by older tooling/tests."""
    deleted, _ = delete_expired_records()
    return deleted

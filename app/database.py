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
                owner_token_hash  TEXT NOT NULL DEFAULT '',
                created_at        TEXT NOT NULL,
                claimed           INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        _add_column_if_missing(
            conn,
            "attachments",
            "owner_token_hash",
            "TEXT NOT NULL DEFAULT ''",
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS message_attachments (
                message_id    INTEGER NOT NULL,
                attachment_id TEXT NOT NULL,
                original_name TEXT NOT NULL,
                position      INTEGER NOT NULL,
                PRIMARY KEY (message_id, attachment_id)
            )
            """
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO message_attachments (
                message_id, attachment_id, original_name, position
            )
            SELECT m.id, m.attachment_id, COALESCE(a.original_name, '파일'), 0
            FROM messages m
            LEFT JOIN attachments a ON a.id = m.attachment_id
            WHERE m.attachment_id IS NOT NULL AND m.attachment_id != ''
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_attachments_created_at ON attachments(created_at)")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_message_attachments_message "
            "ON message_attachments(message_id, position)"
        )
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
        "removed": False,
    }


def _get_message_attachments(
    conn: sqlite3.Connection,
    message_ids: List[int],
) -> Dict[int, List[Dict[str, Any]]]:
    result: Dict[int, List[Dict[str, Any]]] = {message_id: [] for message_id in message_ids}
    if not message_ids:
        return result
    placeholders = ",".join("?" for _ in message_ids)
    rows = conn.execute(
        f"""
        SELECT ma.message_id, ma.attachment_id, ma.original_name AS saved_original_name,
               ma.position, a.id AS live_attachment_id,
               a.original_name, a.size, a.sha256, a.content_type, a.previewable
        FROM message_attachments ma
        LEFT JOIN attachments a ON a.id = ma.attachment_id
        WHERE ma.message_id IN ({placeholders})
        ORDER BY ma.message_id, ma.position
        """,
        message_ids,
    ).fetchall()
    for row in rows:
        if row["live_attachment_id"]:
            attachment = {
                "id": row["attachment_id"],
                "name": row["original_name"],
                "size": row["size"],
                "sha256": row["sha256"],
                "content_type": row["content_type"],
                "previewable": bool(row["previewable"]),
                "url": f"/api/files/{row['attachment_id']}",
                "removed": False,
            }
        else:
            attachment = {
                "id": row["attachment_id"],
                "name": row["saved_original_name"],
                "removed": True,
            }
        result[row["message_id"]].append(attachment)
    return result


def _message_from_row(
    row: sqlite3.Row,
    include_ip: bool = False,
    attachments: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    if attachments is None:
        legacy = _attachment_from_row(row, "a_")
        attachments = [legacy] if legacy else []
        if row["attachment_id"] and not legacy:
            attachments = [{"id": row["attachment_id"], "name": "파일", "removed": True}]
    live_attachment = next(
        (attachment for attachment in attachments if not attachment.get("removed")),
        None,
    )
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
        "attachment": live_attachment,
        "attachments": attachments,
        "attachment_removed": bool(attachments and not live_attachment),
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
    attachment_ids: Optional[List[str]] = None,
) -> Dict[str, Any]:
    selected_ids = list(dict.fromkeys(attachment_ids or ([] if not attachment_id else [attachment_id])))
    legacy_attachment_id = selected_ids[0] if selected_ids else None
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
            (
                nickname,
                content,
                now,
                ip,
                reply_nickname,
                reply_content,
                legacy_attachment_id,
            ),
        )
        row_id = cursor.lastrowid
        if selected_ids:
            placeholders = ",".join("?" for _ in selected_ids)
            name_rows = conn.execute(
                f"SELECT id, original_name FROM attachments WHERE id IN ({placeholders})",
                selected_ids,
            ).fetchall()
            names = {name_row["id"]: name_row["original_name"] for name_row in name_rows}
            conn.executemany(
                """
                INSERT INTO message_attachments (
                    message_id, attachment_id, original_name, position
                ) VALUES (?, ?, ?, ?)
                """,
                [
                    (row_id, item_id, names.get(item_id, "파일"), position)
                    for position, item_id in enumerate(selected_ids)
                ],
            )
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
        attachment_map = _get_message_attachments(conn, [row_id])
        conn.commit()
    return _message_from_row(
        row,
        include_ip=True,
        attachments=attachment_map.get(row_id, []),
    )


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
        attachment_map = _get_message_attachments(conn, [row["id"] for row in rows])
    return [
        _message_from_row(row, attachments=attachment_map.get(row["id"], []))
        for row in rows
    ]


def save_attachment(metadata: Dict[str, Any]) -> Dict[str, Any]:
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO attachments (
                id, original_name, stored_name, size, sha256, content_type,
                previewable, uploader_nickname, ip, owner_token_hash, created_at, claimed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
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
                metadata.get("owner_token_hash", ""),
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


def claim_attachments(
    attachment_ids: List[str],
    nickname: str,
    ip: str,
) -> Optional[List[Dict[str, Any]]]:
    """Atomically claim an ordered batch of uploaded files from one active client."""
    selected_ids = list(dict.fromkeys(attachment_ids))
    if not selected_ids:
        return []
    placeholders = ",".join("?" for _ in selected_ids)
    with get_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        rows = conn.execute(
            f"""
            SELECT * FROM attachments
            WHERE id IN ({placeholders}) AND uploader_nickname = ? AND ip = ?
              AND claimed = 0 AND created_at >= ?
            """,
            [*selected_ids, nickname, ip, retention_cutoff()],
        ).fetchall()
        if len(rows) != len(selected_ids):
            conn.rollback()
            return None
        by_id = {row["id"]: row for row in rows}
        if any(attachment_id not in by_id for attachment_id in selected_ids):
            conn.rollback()
            return None
        conn.executemany(
            "UPDATE attachments SET claimed = 1 WHERE id = ? AND claimed = 0",
            [(attachment_id,) for attachment_id in selected_ids],
        )
        conn.commit()
    return [_attachment_from_row(by_id[attachment_id]) for attachment_id in selected_ids]


def claim_attachment(
    attachment_id: str,
    nickname: str,
    ip: str,
) -> Optional[Dict[str, Any]]:
    """Backward-compatible single-file claim helper."""
    claimed = claim_attachments([attachment_id], nickname, ip)
    return claimed[0] if claimed else None


def delete_owned_attachment(
    attachment_id: str,
    owner_token_hash: str,
) -> Optional[Dict[str, Any]]:
    """Delete a pending or sent attachment using its private browser ownership token."""
    with get_connection() as conn:
        row = conn.execute(
            """
            SELECT stored_name, claimed FROM attachments
            WHERE id = ? AND owner_token_hash = ? AND created_at >= ?
            """,
            (attachment_id, owner_token_hash, retention_cutoff()),
        ).fetchone()
        if not row:
            return None
        conn.execute("DELETE FROM attachments WHERE id = ?", (attachment_id,))
        conn.commit()
    return dict(row)


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
        conn.execute(
            "DELETE FROM message_attachments WHERE message_id NOT IN (SELECT id FROM messages)"
        )
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

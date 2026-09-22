"""Attachment storage and file management database operations."""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app.db.connection import DB_MAX_BYTES, DB_PATH, get_connection, utc_now


def _attachment_public(row: sqlite3.Row | Dict[str, Any] | None) -> Optional[Dict[str, Any]]:
    if not row:
        return None
    return {
        "id": row["id"],
        "name": row["original_name"],
        "size": row["size"],
        "sha256": row["sha256"],
        "content_type": row["content_type"],
        "previewable": bool(row["previewable"]),
        "url": f"/api/files/{row['id']}",
        "removed": False,
        "owner_id": row["uploader_user_id"],
    }


def attachment_is_visible_to_user(attachment_id: str, user_id: int) -> bool:
    with get_connection() as conn:
        dm_rows = conn.execute(
            """SELECT dm.sender_user_id, dm.recipient_user_id
            FROM direct_message_attachments dma
            JOIN direct_messages dm ON dm.id=dma.direct_message_id
            WHERE dma.attachment_id=?""",
            (attachment_id,),
        ).fetchall()
    if not dm_rows:
        return True
    return any(user_id in {row["sender_user_id"], row["recipient_user_id"]} for row in dm_rows)


def save_attachment(metadata: Dict[str, Any]) -> Dict[str, Any]:
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO attachments
            (id,original_name,stored_name,size,sha256,content_type,previewable,
             uploader_nickname,ip,owner_token_hash,created_at,claimed,uploader_user_id)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)""",
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
                "",
                metadata.get("created_at", utc_now()),
                metadata["uploader_user_id"],
            ),
        )
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
        rows = conn.execute(
            f"""SELECT * FROM attachments WHERE id IN ({marks})
            AND uploader_user_id=? AND claimed=0""",
            [*selected, user_id],
        ).fetchall()
        by_id = {row["id"]: row for row in rows}
        if len(rows) != len(selected) or any(item not in by_id for item in selected):
            conn.rollback()
            return None
        conn.executemany(
            "UPDATE attachments SET claimed=1 WHERE id=? AND claimed=0",
            [(item,) for item in selected],
        )
        conn.commit()
    return [_attachment_public(by_id[item]) for item in selected]


def delete_owned_attachment(
    attachment_id: str, user_id: int, is_admin: bool = False
) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        if is_admin:
            row = conn.execute(
                "SELECT stored_name,claimed FROM attachments WHERE id=?", (attachment_id,)
            ).fetchone()
        else:
            row = conn.execute(
                """SELECT stored_name,claimed FROM attachments
                WHERE id=? AND uploader_user_id=?""",
                (attachment_id, user_id),
            ).fetchone()
        if not row:
            return None
        conn.execute("DELETE FROM attachments WHERE id=?", (attachment_id,))
        conn.commit()
    return dict(row)


def get_upload_usage(user_id: int) -> Tuple[int, int]:
    with get_connection() as conn:
        mine = conn.execute(
            "SELECT COALESCE(SUM(size),0) FROM attachments WHERE uploader_user_id=?",
            (user_id,),
        ).fetchone()[0]
        total = conn.execute("SELECT COALESCE(SUM(size),0) FROM attachments").fetchone()[0]
    return int(mine), int(total)


def get_storage_status() -> Dict[str, int]:
    db_bytes = sum(
        path.stat().st_size
        for path in (DB_PATH, Path(str(DB_PATH) + "-wal"), Path(str(DB_PATH) + "-shm"))
        if path.exists()
    )
    with get_connection() as conn:
        attachment_bytes = int(
            conn.execute("SELECT COALESCE(SUM(size),0) FROM attachments").fetchone()[0]
        )
    return {
        "database_bytes": db_bytes,
        "database_limit_bytes": DB_MAX_BYTES,
        "attachment_bytes": attachment_bytes,
    }

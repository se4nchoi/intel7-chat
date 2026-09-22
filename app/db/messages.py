"""Channel, message, direct message, reaction, and read-state database operations."""
from __future__ import annotations

import sqlite3
import uuid as _uuid
from typing import Any, Dict, List, Optional, Set

from app.db.connection import get_connection, utc_now

ALLOWED_REACTION_EMOJIS: Set[str] = {"👍", "❤️", "😂", "😮", "😢", "👏", "✅", "❌", "👀"}


def create_channel(
    name: str,
    display_name: str,
    description: str = "",
    created_by_user_id: Optional[int] = None,
) -> Dict[str, Any]:
    from app.auth import validate_channel_description, validate_channel_display_name, validate_channel_name

    clean_name = validate_channel_name(name)
    clean_display = validate_channel_display_name(display_name)
    clean_desc = validate_channel_description(description)
    now = utc_now()
    chan_uuid = _uuid.uuid4().hex
    with get_connection() as conn:
        cur = conn.execute(
            """INSERT INTO channels
            (name, display_name, description, uuid, created_by_user_id, is_default, created_at)
            VALUES (?, ?, ?, ?, ?, 0, ?)""",
            (clean_name, clean_display, clean_desc, chan_uuid, created_by_user_id, now),
        )
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
        rows = conn.execute(
            f"""SELECT c.*,
            (SELECT COUNT(*) FROM messages m WHERE m.channel_id=c.id) AS message_count
            FROM channels c
            {where_clause}
            ORDER BY c.is_default DESC, c.id ASC"""
        ).fetchall()
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


def update_channel(
    channel_id: int,
    name: Optional[str] = None,
    display_name: Optional[str] = None,
    description: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    from app.auth import validate_channel_description, validate_channel_display_name, validate_channel_name

    current = get_channel_by_id(channel_id)
    if not current:
        return None
    new_name = validate_channel_name(name) if name is not None else current["name"]
    new_display = (
        validate_channel_display_name(display_name)
        if display_name is not None
        else current["display_name"]
    )
    new_desc = (
        validate_channel_description(description)
        if description is not None
        else current["description"]
    )
    with get_connection() as conn:
        conn.execute(
            """UPDATE channels
            SET name=?, display_name=?, description=?
            WHERE id=?""",
            (new_name, new_display, new_desc, channel_id),
        )
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
            att_rows = conn.execute(
                f"SELECT DISTINCT attachment_id FROM message_attachments WHERE message_id IN ({marks})",
                msg_ids,
            ).fetchall()
            att_ids = [r[0] for r in att_rows if r[0]]
            conn.execute(f"DELETE FROM message_attachments WHERE message_id IN ({marks})", msg_ids)
            conn.execute(
                f"DELETE FROM message_reactions WHERE message_type='channel' AND message_id IN ({marks})",
                msg_ids,
            )
            for att_id in att_ids:
                in_msgs = conn.execute(
                    "SELECT 1 FROM message_attachments WHERE attachment_id=?", (att_id,)
                ).fetchone()
                in_dms = conn.execute(
                    "SELECT 1 FROM direct_message_attachments WHERE attachment_id=?", (att_id,)
                ).fetchone()
                if not in_msgs and not in_dms:
                    rec = conn.execute(
                        "SELECT stored_name FROM attachments WHERE id=?", (att_id,)
                    ).fetchone()
                    if rec:
                        stored_files_to_remove.append(rec["stored_name"])
                        conn.execute("DELETE FROM attachments WHERE id=?", (att_id,))
            conn.execute(f"DELETE FROM messages WHERE id IN ({marks})", msg_ids)
        conn.execute(
            "DELETE FROM user_conversation_state WHERE conversation_type='channel' AND conversation_id=?",
            (str(channel_id),),
        )
        conn.execute(
            "DELETE FROM pinned_messages WHERE conversation_type='channel' AND conversation_id=?",
            (str(channel_id),),
        )
        conn.execute("DELETE FROM channels WHERE id=?", (channel_id,))
        conn.commit()
    return stored_files_to_remove


def _message_attachments(conn: sqlite3.Connection, ids: List[int]) -> Dict[int, List[Dict[str, Any]]]:
    result = {message_id: [] for message_id in ids}
    if not ids:
        return result
    marks = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"""SELECT ma.*, a.id AS live_id, a.size, a.sha256,
        a.content_type, a.previewable, a.uploader_user_id
        FROM message_attachments ma LEFT JOIN attachments a ON a.id=ma.attachment_id
        WHERE ma.message_id IN ({marks}) ORDER BY ma.message_id, ma.position""",
        ids,
    ).fetchall()
    for row in rows:
        if row["live_id"]:
            item = {
                "id": row["attachment_id"],
                "name": row["original_name"],
                "size": row["size"],
                "sha256": row["sha256"],
                "content_type": row["content_type"],
                "previewable": bool(row["previewable"]),
                "url": f"/api/files/{row['attachment_id']}",
                "removed": False,
                "owner_id": row["uploader_user_id"],
            }
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
    rows = conn.execute(
        f"""
        SELECT mr.message_id, mr.emoji, mr.user_id, mr.created_at,
               u.username, u.display_name
        FROM message_reactions mr
        JOIN users u ON u.id = mr.user_id
        WHERE mr.message_type = ? AND mr.message_id IN ({marks})
        ORDER BY mr.created_at ASC, mr.rowid ASC
    """,
        [message_type, *message_ids],
    ).fetchall()

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
        existing = conn.execute(
            """
            SELECT 1 FROM message_reactions
            WHERE message_type = ? AND message_id = ? AND user_id = ? AND emoji = ?
        """,
            (message_type, message_id, user_id, emoji),
        ).fetchone()
        if existing:
            conn.execute(
                """
                DELETE FROM message_reactions
                WHERE message_type = ? AND message_id = ? AND user_id = ? AND emoji = ?
            """,
                (message_type, message_id, user_id, emoji),
            )
            conn.commit()
            return False
        else:
            conn.execute(
                """
                INSERT INTO message_reactions (message_type, message_id, user_id, emoji, created_at)
                VALUES (?, ?, ?, ?, ?)
            """,
                (message_type, message_id, user_id, emoji, utc_now()),
            )
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


def _message_public(
    row: sqlite3.Row,
    attachments: List[Dict[str, Any]],
    reactions: Optional[List[Dict[str, Any]]] = None,
    is_pinned: bool = False,
) -> Dict[str, Any]:
    reply = None
    if row["reply_nickname"] or row["reply_content"]:
        reply = {"nickname": row["reply_nickname"] or "", "content": row["reply_content"] or ""}
    live = next((item for item in attachments if not item.get("removed")), None)
    keys = row.keys() if hasattr(row, "keys") else row
    channel_id = row["channel_id"] if "channel_id" in keys else 1
    edited_at = row["edited_at"] if "edited_at" in keys else None
    is_hidden = bool(row["is_hidden"]) if "is_hidden" in keys else False
    moved_from = row["moved_from_channel_id"] if "moved_from_channel_id" in keys else None
    return {
        "message_id": f"public:{row['id']}",
        "nickname": row["nickname"],
        "author_id": row["user_id"],
        "channel_id": channel_id,
        "content": row["content"],
        "created_at": row["created_at"],
        "edited_at": edited_at,
        "is_hidden": is_hidden,
        "moved_from_channel_id": moved_from,
        "reply": reply,
        "attachment": live,
        "attachments": attachments,
        "attachment_removed": bool(attachments and not live),
        "reactions": reactions if reactions is not None else [],
        "is_pinned": bool(is_pinned),
    }


def get_message_by_id(
    message_id: int, current_user_id: Optional[int] = None
) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        if not row:
            return None
        attachments = _message_attachments(conn, [message_id]).get(message_id, [])
        reactions = get_reactions_for_messages(conn, "channel", [message_id], current_user_id).get(
            message_id, []
        )
        pinned = (
            conn.execute(
                "SELECT 1 FROM pinned_messages WHERE conversation_type='channel' AND message_id=?",
                (message_id,),
            ).fetchone()
            is not None
        )
        return _message_public(row, attachments, reactions, is_pinned=pinned)


def update_message_content(
    message_id: int, new_content: str, user_id: int, is_admin: bool = False
) -> Optional[Dict[str, Any]]:
    now = utc_now()
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        if not row:
            return None
        if not is_admin and row["user_id"] != user_id:
            raise PermissionError("본인이 작성한 메시지만 수정할 수 있습니다.")
        conn.execute(
            "UPDATE messages SET content=?, edited_at=? WHERE id=?",
            (new_content, now, message_id),
        )
        conn.commit()
    return get_message_by_id(message_id, user_id)


def set_message_hidden(message_id: int, is_hidden: bool) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        if not row:
            return None
        conn.execute("UPDATE messages SET is_hidden=? WHERE id=?", (1 if is_hidden else 0, message_id))
        conn.commit()
    return get_message_by_id(message_id)


def move_message_channel(message_id: int, to_channel_id: int) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        if not row:
            return None
        from_channel_id = row["channel_id"] if "channel_id" in row.keys() else 1
        conn.execute(
            "UPDATE messages SET channel_id=?, moved_from_channel_id=? WHERE id=?",
            (to_channel_id, from_channel_id, message_id),
        )
        conn.commit()
    return get_message_by_id(message_id)


def save_message(
    nickname: str,
    content: str,
    ip: str = "",
    reply: Optional[Dict[str, str]] = None,
    attachment_id: Optional[str] = None,
    attachment_ids: Optional[List[str]] = None,
    user_id: Optional[int] = None,
    channel_id: int = 1,
) -> Dict[str, Any]:
    selected = list(dict.fromkeys(attachment_ids or ([] if not attachment_id else [attachment_id])))
    now = utc_now()
    with get_connection() as conn:
        cur = conn.execute(
            """INSERT INTO messages
            (nickname,content,created_at,ip,reply_nickname,reply_content,attachment_id,user_id,channel_id)
            VALUES(?,?,?,?,?,?,?,?,?)""",
            (
                nickname,
                content,
                now,
                ip,
                reply.get("nickname", "") if reply else None,
                reply.get("content", "") if reply else None,
                selected[0] if selected else None,
                user_id,
                channel_id,
            ),
        )
        message_id = cur.lastrowid
        if selected:
            marks = ",".join("?" for _ in selected)
            names = {
                r["id"]: r["original_name"]
                for r in conn.execute(
                    f"SELECT id,original_name FROM attachments WHERE id IN ({marks})", selected
                )
            }
            conn.executemany(
                """INSERT INTO message_attachments
                (message_id,attachment_id,original_name,position) VALUES(?,?,?,?)""",
                [
                    (message_id, item, names.get(item, "파일"), pos)
                    for pos, item in enumerate(selected)
                ],
            )
        row = conn.execute("SELECT * FROM messages WHERE id=?", (message_id,)).fetchone()
        items = _message_attachments(conn, [message_id])[message_id]
        conn.commit()
    result = _message_public(row, items, [])
    result["ip"] = ip
    return result


def get_recent_messages(
    limit: int = 100,
    before_id: Optional[int] = None,
    channel_id: int = 1,
    current_user_id: Optional[int] = None,
) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        if before_id is None:
            rows = conn.execute(
                """SELECT * FROM
                (SELECT * FROM messages WHERE channel_id=? ORDER BY id DESC LIMIT ?) ORDER BY id ASC""",
                (channel_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT * FROM
                (SELECT * FROM messages WHERE channel_id=? AND id<? ORDER BY id DESC LIMIT ?)
                ORDER BY id ASC""",
                (channel_id, before_id, limit),
            ).fetchall()
        msg_ids = [row["id"] for row in rows]
        items = _message_attachments(conn, msg_ids)
        reactions = get_reactions_for_messages(conn, "channel", msg_ids, current_user_id)
        pinned_ids = {
            r[0]
            for r in conn.execute(
                "SELECT message_id FROM pinned_messages WHERE conversation_type='channel' AND conversation_id=?",
                (str(channel_id),),
            ).fetchall()
        }
    return [
        _message_public(
            row,
            items[row["id"]],
            reactions.get(row["id"], []),
            is_pinned=(row["id"] in pinned_ids),
        )
        for row in rows
    ]


def _direct_message_attachments(
    conn: sqlite3.Connection, ids: List[int]
) -> Dict[int, List[Dict[str, Any]]]:
    result = {message_id: [] for message_id in ids}
    if not ids:
        return result
    marks = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"""SELECT dma.*, a.id AS live_id, a.size, a.sha256,
        a.content_type, a.previewable, a.uploader_user_id
        FROM direct_message_attachments dma
        LEFT JOIN attachments a ON a.id=dma.attachment_id
        WHERE dma.direct_message_id IN ({marks})
        ORDER BY dma.direct_message_id, dma.position""",
        ids,
    ).fetchall()
    for row in rows:
        if row["live_id"]:
            item = {
                "id": row["attachment_id"],
                "name": row["original_name"],
                "size": row["size"],
                "sha256": row["sha256"],
                "content_type": row["content_type"],
                "previewable": bool(row["previewable"]),
                "url": f"/api/files/{row['attachment_id']}",
                "removed": False,
                "owner_id": row["uploader_user_id"],
            }
        else:
            item = {"id": row["attachment_id"], "name": row["original_name"], "removed": True}
        result[row["direct_message_id"]].append(item)
    return result


def _direct_message_public(
    row: sqlite3.Row,
    attachments: List[Dict[str, Any]],
    reactions: Optional[List[Dict[str, Any]]] = None,
    is_pinned: bool = False,
) -> Dict[str, Any]:
    reply = None
    if row["reply_nickname"] or row["reply_content"]:
        reply = {
            "nickname": row["reply_nickname"] or "",
            "content": row["reply_content"] or "",
        }
    live = next((item for item in attachments if not item.get("removed")), None)
    keys = row.keys() if hasattr(row, "keys") else row
    edited_at = row["edited_at"] if "edited_at" in keys else None
    return {
        "message_id": f"dm:{row['id']}",
        "from_nick": row["sender_nickname"],
        "from_user_id": row["sender_user_id"],
        "to_nick": row["recipient_nickname"],
        "to_user_id": row["recipient_user_id"],
        "content": row["content"],
        "created_at": row["created_at"],
        "edited_at": edited_at,
        "reply": reply,
        "attachment": live,
        "attachments": attachments,
        "attachment_removed": bool(attachments and not live),
        "reactions": reactions if reactions is not None else [],
        "is_pinned": bool(is_pinned),
    }


def get_direct_message_by_id(
    dm_id: int, current_user_id: Optional[int] = None
) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM direct_messages WHERE id=?", (dm_id,)).fetchone()
        if not row:
            return None
        items = _direct_message_attachments(conn, [dm_id]).get(dm_id, [])
        reactions = get_reactions_for_messages(conn, "dm", [dm_id], current_user_id).get(dm_id, [])
        pinned = (
            conn.execute(
                "SELECT 1 FROM pinned_messages WHERE conversation_type='dm' AND message_id=?",
                (dm_id,),
            ).fetchone()
            is not None
        )
        return _direct_message_public(row, items, reactions, is_pinned=pinned)


def update_direct_message_content(
    dm_id: int, new_content: str, user_id: int
) -> Optional[Dict[str, Any]]:
    now = utc_now()
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM direct_messages WHERE id=?", (dm_id,)).fetchone()
        if not row:
            return None
        if row["sender_user_id"] != user_id:
            raise PermissionError("본인이 작성한 1:1 메시지만 수정할 수 있습니다.")
        conn.execute(
            "UPDATE direct_messages SET content=?, edited_at=? WHERE id=?",
            (new_content, now, dm_id),
        )
        conn.commit()
    return get_direct_message_by_id(dm_id, user_id)


def save_direct_message(
    sender: Dict[str, Any],
    recipient: Dict[str, Any],
    content: str,
    reply: Optional[Dict[str, str]] = None,
    attachment_ids: Optional[List[str]] = None,
) -> Dict[str, Any]:
    selected = list(dict.fromkeys(attachment_ids or []))
    with get_connection() as conn:
        cur = conn.execute(
            """INSERT INTO direct_messages
            (sender_user_id,recipient_user_id,sender_nickname,recipient_nickname,content,
             created_at,reply_nickname,reply_content) VALUES(?,?,?,?,?,?,?,?)""",
            (
                sender["id"],
                recipient["id"],
                sender["username"],
                recipient["username"],
                content,
                utc_now(),
                reply.get("nickname", "") if reply else None,
                reply.get("content", "") if reply else None,
            ),
        )
        message_id = cur.lastrowid
        if selected:
            marks = ",".join("?" for _ in selected)
            names = {
                row["id"]: row["original_name"]
                for row in conn.execute(
                    f"SELECT id,original_name FROM attachments WHERE id IN ({marks})", selected
                )
            }
            conn.executemany(
                """INSERT INTO direct_message_attachments
                (direct_message_id,attachment_id,original_name,position) VALUES(?,?,?,?)""",
                [
                    (message_id, item, names.get(item, "파일"), position)
                    for position, item in enumerate(selected)
                ],
            )
        row = conn.execute("SELECT * FROM direct_messages WHERE id=?", (message_id,)).fetchone()
        items = _direct_message_attachments(conn, [message_id])[message_id]
        conn.commit()
    return _direct_message_public(row, items, [])


def get_recent_direct_messages(user_id: int, limit: int = 30) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT * FROM (
            SELECT dm.*, ROW_NUMBER() OVER (
                PARTITION BY CASE WHEN sender_user_id=? THEN recipient_user_id ELSE sender_user_id END
                ORDER BY id DESC
            ) AS conversation_row
            FROM direct_messages dm
            WHERE sender_user_id=? OR recipient_user_id=?
        ) WHERE conversation_row<=? ORDER BY id ASC""",
            (user_id, user_id, user_id, limit),
        ).fetchall()
        msg_ids = [row["id"] for row in rows]
        items = _direct_message_attachments(conn, msg_ids)
        reactions = get_reactions_for_messages(conn, "dm", msg_ids, user_id)
    return [_direct_message_public(row, items[row["id"]], reactions.get(row["id"], [])) for row in rows]


def get_direct_messages_between(
    user_id: int,
    partner_user_id: int,
    limit: int = 50,
    before_id: Optional[int] = None,
) -> List[Dict[str, Any]]:
    params: List[Any] = [user_id, partner_user_id, partner_user_id, user_id]
    before_clause = ""
    if before_id is not None:
        before_clause = "AND id<?"
        params.append(before_id)
    params.append(limit)
    with get_connection() as conn:
        rows = conn.execute(
            f"""SELECT * FROM (
            SELECT * FROM direct_messages WHERE
            ((sender_user_id=? AND recipient_user_id=?) OR
             (sender_user_id=? AND recipient_user_id=?))
            {before_clause} ORDER BY id DESC LIMIT ?
        ) ORDER BY id ASC""",
            params,
        ).fetchall()
        msg_ids = [row["id"] for row in rows]
        items = _direct_message_attachments(conn, msg_ids)
        reactions = get_reactions_for_messages(conn, "dm", msg_ids, user_id)
        norm_id = normalize_dm_conversation_id(user_id, partner_user_id)
        pinned_ids = {
            r[0]
            for r in conn.execute(
                "SELECT message_id FROM pinned_messages WHERE conversation_type='dm' AND conversation_id=?",
                (norm_id,),
            ).fetchall()
        }
    return [
        _direct_message_public(
            row,
            items[row["id"]],
            reactions.get(row["id"], []),
            is_pinned=(row["id"] in pinned_ids),
        )
        for row in rows
    ]


def search_conversation_history(
    user_id: int,
    query: str,
    *,
    is_admin: bool = False,
    conversation_type: Optional[str] = None,
    conversation_id: Optional[str] = None,
    limit: int = 50,
) -> List[Dict[str, Any]]:
    """Search accessible message text and attachment filenames."""
    escaped = query.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    needle = f"%{escaped}%"
    limit = max(1, min(int(limit), 100))
    results: List[Dict[str, Any]] = []
    with get_connection() as conn:
        if conversation_type in (None, "channel"):
            params: List[Any] = [needle, needle]
            clauses = [
                "(m.content LIKE ? ESCAPE '\\' COLLATE NOCASE OR EXISTS (SELECT 1 FROM message_attachments ma JOIN attachments a ON a.id=ma.attachment_id WHERE ma.message_id=m.id AND ma.original_name LIKE ? ESCAPE '\\' COLLATE NOCASE))"
            ]
            if not is_admin:
                clauses.append("m.is_hidden=0")
            if conversation_type == "channel":
                clauses.append("m.channel_id=?")
                params.append(int(conversation_id or 0))
            params.append(limit)
            rows = conn.execute(
                f"""SELECT m.*, c.display_name AS channel_display_name
                FROM messages m JOIN channels c ON c.id=m.channel_id
                WHERE {' AND '.join(clauses)} ORDER BY m.id DESC LIMIT ?""",
                params,
            ).fetchall()
            attachment_map = _message_attachments(conn, [row["id"] for row in rows])
            for row in rows:
                results.append(
                    {
                        "message_type": "channel",
                        "message_id": f"public:{row['id']}",
                        "conversation_id": str(row["channel_id"]),
                        "conversation_name": row["channel_display_name"],
                        "author": row["nickname"],
                        "content": row["content"],
                        "created_at": row["created_at"],
                        "attachments": attachment_map.get(row["id"], []),
                    }
                )

        if conversation_type in (None, "dm"):
            params = [user_id, user_id, needle, needle]
            clauses = [
                "(dm.sender_user_id=? OR dm.recipient_user_id=?)",
                "(dm.content LIKE ? ESCAPE '\\' COLLATE NOCASE OR EXISTS (SELECT 1 FROM direct_message_attachments dma JOIN attachments a ON a.id=dma.attachment_id WHERE dma.direct_message_id=dm.id AND dma.original_name LIKE ? ESCAPE '\\' COLLATE NOCASE))",
            ]
            if conversation_type == "dm":
                partner_id = int(conversation_id or 0)
                clauses.append(
                    "((dm.sender_user_id=? AND dm.recipient_user_id=?) OR (dm.sender_user_id=? AND dm.recipient_user_id=?))"
                )
                params.extend([user_id, partner_id, partner_id, user_id])
            params.append(limit)
            rows = conn.execute(
                f"SELECT dm.* FROM direct_messages dm WHERE {' AND '.join(clauses)} ORDER BY dm.id DESC LIMIT ?",
                params,
            ).fetchall()
            attachment_map = _direct_message_attachments(conn, [row["id"] for row in rows])
            for row in rows:
                partner = (
                    row["recipient_nickname"]
                    if row["sender_user_id"] == user_id
                    else row["sender_nickname"]
                )
                results.append(
                    {
                        "message_type": "dm",
                        "message_id": f"dm:{row['id']}",
                        "conversation_id": partner,
                        "conversation_name": partner,
                        "author": row["sender_nickname"],
                        "content": row["content"],
                        "created_at": row["created_at"],
                        "attachments": attachment_map.get(row["id"], []),
                    }
                )
    results.sort(key=lambda item: (item["created_at"], item["message_id"]), reverse=True)
    return results[:limit]


def get_user_conversation_states(user_id: int) -> Dict[str, Dict[str, Any]]:
    """Returns mapping of 'type:id' -> {last_read_message_id, muted, updated_at}."""
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT conversation_type, conversation_id, last_read_message_id, muted, updated_at
            FROM user_conversation_state WHERE user_id = ?""",
            (user_id,),
        ).fetchall()
        states = {}
        for row in rows:
            key = f"{row[0]}:{row[1]}"
            states[key] = {
                "conversation_type": row[0],
                "conversation_id": row[1],
                "last_read_message_id": int(row[2]),
                "muted": bool(row[3]),
                "updated_at": row[4],
            }
        return states


def update_user_read_state(
    user_id: int, conv_type: str, conv_id: str, last_read_id: int
) -> Dict[str, Any]:
    """Updates last_read_message_id for a conversation, advancing it forward."""
    conv_id = str(conv_id)
    last_read_id = int(last_read_id)
    now = utc_now()
    with get_connection() as conn:
        row = conn.execute(
            """SELECT last_read_message_id, muted FROM user_conversation_state
            WHERE user_id = ? AND conversation_type = ? AND conversation_id = ?""",
            (user_id, conv_type, conv_id),
        ).fetchone()
        if row:
            curr_last_read = int(row[0])
            muted = int(row[1])
            new_last_read = max(curr_last_read, last_read_id)
            conn.execute(
                """UPDATE user_conversation_state
                SET last_read_message_id = ?, updated_at = ?
                WHERE user_id = ? AND conversation_type = ? AND conversation_id = ?""",
                (new_last_read, now, user_id, conv_type, conv_id),
            )
            conn.commit()
            return {
                "conversation_type": conv_type,
                "conversation_id": conv_id,
                "last_read_message_id": new_last_read,
                "muted": bool(muted),
                "updated_at": now,
            }
        else:
            conn.execute(
                """INSERT INTO user_conversation_state
                (user_id, conversation_type, conversation_id, last_read_message_id, muted, updated_at)
                VALUES (?, ?, ?, ?, 0, ?)""",
                (user_id, conv_type, conv_id, last_read_id, now),
            )
            conn.commit()
            return {
                "conversation_type": conv_type,
                "conversation_id": conv_id,
                "last_read_message_id": last_read_id,
                "muted": False,
                "updated_at": now,
            }


def set_conversation_muted(
    user_id: int, conv_type: str, conv_id: str, muted: bool
) -> Dict[str, Any]:
    """Sets muted flag for a conversation."""
    conv_id = str(conv_id)
    muted_int = 1 if muted else 0
    now = utc_now()
    with get_connection() as conn:
        row = conn.execute(
            """SELECT last_read_message_id FROM user_conversation_state
            WHERE user_id = ? AND conversation_type = ? AND conversation_id = ?""",
            (user_id, conv_type, conv_id),
        ).fetchone()
        if row:
            last_read_id = int(row[0])
            conn.execute(
                """UPDATE user_conversation_state
                SET muted = ?, updated_at = ?
                WHERE user_id = ? AND conversation_type = ? AND conversation_id = ?""",
                (muted_int, now, user_id, conv_type, conv_id),
            )
        else:
            last_read_id = 0
            conn.execute(
                """INSERT INTO user_conversation_state
                (user_id, conversation_type, conversation_id, last_read_message_id, muted, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)""",
                (user_id, conv_type, conv_id, 0, muted_int, now),
            )
        conn.commit()
        return {
            "conversation_type": conv_type,
            "conversation_id": conv_id,
            "last_read_message_id": last_read_id,
            "muted": bool(muted),
            "updated_at": now,
        }


def get_user_unread_counts(user_id: int) -> Dict[str, int]:
    """Calculates unread message count for each channel and DM conversation of user."""
    unread_counts = {}
    with get_connection() as conn:
        states = {}
        for r in conn.execute(
            """SELECT conversation_type, conversation_id, last_read_message_id
            FROM user_conversation_state WHERE user_id = ?""",
            (user_id,),
        ).fetchall():
            states[f"{r[0]}:{r[1]}"] = int(r[2])

        # Channels (exclude messages authored by user_id)
        chans = conn.execute("SELECT id FROM channels WHERE archived = 0").fetchall()
        for chan in chans:
            cid = chan[0]
            key = f"channel:{cid}"
            last_read = states.get(key, 0)
            cnt = conn.execute(
                """SELECT COUNT(*) FROM messages
                WHERE channel_id = ? AND id > ? AND (user_id IS NULL OR user_id != ?)""",
                (cid, last_read, user_id),
            ).fetchone()[0]
            unread_counts[key] = cnt

        # DMs (conversations where this user is recipient and message is unread from sender_id)
        dm_rows = conn.execute(
            """SELECT sender_user_id, id FROM direct_messages
            WHERE recipient_user_id = ? AND sender_user_id != ? ORDER BY id ASC""",
            (user_id, user_id),
        ).fetchall()

        # Group by partner (sender)
        for sender_id, msg_id in dm_rows:
            key = f"dm:{sender_id}"
            last_read = states.get(key, 0)
            if msg_id > last_read:
                unread_counts[key] = unread_counts.get(key, 0) + 1

    return unread_counts


def normalize_dm_conversation_id(user_id_1: int, user_id_2: int) -> str:
    """Normalizes DM conversation key by sorting user IDs (e.g. '1:2')."""
    return f"{min(user_id_1, user_id_2)}:{max(user_id_1, user_id_2)}"


def pin_message(
    conversation_type: str,
    conversation_id: str,
    message_id: int,
    pinned_by_user_id: int,
) -> Dict[str, Any]:
    """Pins a channel or DM message. Returns pinned message details."""
    now = utc_now()
    with get_connection() as conn:
        if conversation_type == "channel":
            chan_id = int(conversation_id)
            row = conn.execute(
                "SELECT * FROM messages WHERE id = ? AND channel_id = ? AND is_hidden = 0",
                (message_id, chan_id),
            ).fetchone()
            if not row:
                raise ValueError("고정할 메시지를 찾을 수 없습니다.")
        elif conversation_type == "dm":
            row = conn.execute(
                "SELECT * FROM direct_messages WHERE id = ?", (message_id,)
            ).fetchone()
            if not row:
                raise ValueError("고정할 DM 메시지를 찾을 수 없습니다.")
            if (
                row["sender_user_id"] != pinned_by_user_id
                and row["recipient_user_id"] != pinned_by_user_id
            ):
                raise PermissionError("본인이 참여한 1:1 대화의 메시지만 고정할 수 있습니다.")
            norm_id = normalize_dm_conversation_id(row["sender_user_id"], row["recipient_user_id"])
            conversation_id = norm_id
        else:
            raise ValueError(f"Invalid conversation_type: {conversation_type}")

        conn.execute(
            """
            INSERT OR REPLACE INTO pinned_messages
            (conversation_type, conversation_id, message_id, pinned_by_user_id, pinned_at)
            VALUES (?, ?, ?, ?, ?)
        """,
            (conversation_type, str(conversation_id), message_id, pinned_by_user_id, now),
        )
        conn.commit()

        p_user = conn.execute(
            "SELECT id, username, display_name FROM users WHERE id = ?",
            (pinned_by_user_id,),
        ).fetchone()
        pinned_by_info = (
            {
                "id": p_user["id"],
                "username": p_user["username"],
                "display_name": p_user["display_name"] or p_user["username"],
            }
            if p_user
            else {"id": pinned_by_user_id, "username": "unknown", "display_name": "unknown"}
        )

        if conversation_type == "channel":
            atts = _message_attachments(conn, [message_id]).get(message_id, [])
            reactions = get_reactions_for_messages(conn, "channel", [message_id], pinned_by_user_id).get(
                message_id, []
            )
            msg_obj = _message_public(row, atts, reactions, is_pinned=True)
        else:
            atts = _direct_message_attachments(conn, [message_id]).get(message_id, [])
            reactions = get_reactions_for_messages(conn, "dm", [message_id], pinned_by_user_id).get(
                message_id, []
            )
            msg_obj = _direct_message_public(row, atts, reactions, is_pinned=True)

        return {
            "conversation_type": conversation_type,
            "conversation_id": str(conversation_id),
            "message_id": message_id,
            "pinned_at": now,
            "pinned_by": pinned_by_info,
            "message": msg_obj,
        }


def unpin_message(
    conversation_type: str,
    conversation_id: str,
    message_id: int,
    user_id: int,
) -> bool:
    """Unpins a channel or DM message."""
    with get_connection() as conn:
        if conversation_type == "dm":
            row = conn.execute(
                "SELECT * FROM direct_messages WHERE id = ?", (message_id,)
            ).fetchone()
            if not row:
                return False
            if row["sender_user_id"] != user_id and row["recipient_user_id"] != user_id:
                raise PermissionError("본인이 참여한 1:1 대화의 메시지만 고정 해제할 수 있습니다.")
            conversation_id = normalize_dm_conversation_id(
                row["sender_user_id"], row["recipient_user_id"]
            )

        cur = conn.execute(
            """
            DELETE FROM pinned_messages
            WHERE conversation_type = ? AND conversation_id = ? AND message_id = ?
        """,
            (conversation_type, str(conversation_id), message_id),
        )
        conn.commit()
        return cur.rowcount > 0


def get_pinned_messages(
    conversation_type: str,
    conversation_id: str,
    current_user_id: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Lists all pinned messages in a channel or DM."""
    results = []
    with get_connection() as conn:
        if conversation_type == "channel":
            rows = conn.execute(
                """
                SELECT pm.message_id, pm.pinned_at, pm.pinned_by_user_id,
                       u.username as p_username, u.display_name as p_display_name,
                       m.*
                FROM pinned_messages pm
                JOIN messages m ON pm.message_id = m.id
                LEFT JOIN users u ON pm.pinned_by_user_id = u.id
                WHERE pm.conversation_type = 'channel' AND pm.conversation_id = ? AND m.is_hidden = 0
                ORDER BY pm.pinned_at DESC
            """,
                (str(conversation_id),),
            ).fetchall()

            if not rows:
                return []

            msg_ids = [r["message_id"] for r in rows]
            atts_map = _message_attachments(conn, msg_ids)
            reactions_map = get_reactions_for_messages(conn, "channel", msg_ids, current_user_id)

            for r in rows:
                mid = r["message_id"]
                msg_atts = atts_map.get(mid, [])
                msg_reactions = reactions_map.get(mid, [])
                msg_obj = _message_public(r, msg_atts, msg_reactions, is_pinned=True)
                pinned_by = {
                    "id": r["pinned_by_user_id"],
                    "username": r["p_username"] or "unknown",
                    "display_name": r["p_display_name"] or r["p_username"] or "unknown",
                }
                results.append(
                    {
                        "conversation_type": "channel",
                        "conversation_id": str(conversation_id),
                        "message_id": mid,
                        "pinned_at": r["pinned_at"],
                        "pinned_by": pinned_by,
                        "message": msg_obj,
                    }
                )
        elif conversation_type == "dm":
            rows = conn.execute(
                """
                SELECT pm.message_id, pm.pinned_at, pm.pinned_by_user_id,
                       u.username as p_username, u.display_name as p_display_name,
                       dm.*
                FROM pinned_messages pm
                JOIN direct_messages dm ON pm.message_id = dm.id
                LEFT JOIN users u ON pm.pinned_by_user_id = u.id
                WHERE pm.conversation_type = 'dm' AND pm.conversation_id = ?
                ORDER BY pm.pinned_at DESC
            """,
                (str(conversation_id),),
            ).fetchall()

            if not rows:
                return []

            msg_ids = [r["message_id"] for r in rows]
            atts_map = _direct_message_attachments(conn, msg_ids)
            reactions_map = get_reactions_for_messages(conn, "dm", msg_ids, current_user_id)

            for r in rows:
                mid = r["message_id"]
                msg_atts = atts_map.get(mid, [])
                msg_reactions = reactions_map.get(mid, [])
                msg_obj = _direct_message_public(r, msg_atts, msg_reactions, is_pinned=True)
                pinned_by = {
                    "id": r["pinned_by_user_id"],
                    "username": r["p_username"] or "unknown",
                    "display_name": r["p_display_name"] or r["p_username"] or "unknown",
                }
                results.append(
                    {
                        "conversation_type": "dm",
                        "conversation_id": str(conversation_id),
                        "message_id": mid,
                        "pinned_at": r["pinned_at"],
                        "pinned_by": pinned_by,
                        "message": msg_obj,
                    }
                )
    return results


def get_pinned_message_ids(
    conversation_type: str,
    conversation_id: str,
) -> Set[int]:
    """Returns set of pinned message IDs for a conversation."""
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT message_id FROM pinned_messages
            WHERE conversation_type = ? AND conversation_id = ?
        """,
            (conversation_type, str(conversation_id)),
        ).fetchall()
        return {r[0] for r in rows}

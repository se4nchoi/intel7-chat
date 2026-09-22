"""Message editing, hiding, reactions, pins, read states, search, and history routes."""
from __future__ import annotations
import asyncio
import json
from typing import Any, Dict, Optional
from fastapi import APIRouter, HTTPException, Request

from app.database import (
    ALLOWED_REACTION_EMOJIS, get_channel_by_id, get_direct_message_by_id,
    get_direct_messages_between, get_message_by_id, get_message_reactions,
    get_pinned_messages, get_recent_messages, get_user_by_id, get_user_by_username,
    get_user_conversation_states, get_user_unread_counts, list_mentionable_users,
    move_message_channel, normalize_dm_conversation_id, pin_message,
    search_conversation_history, set_conversation_muted, set_message_hidden,
    toggle_message_reaction, unpin_message, update_direct_message_content,
    update_message_content, update_user_read_state
)
from app import main

router = APIRouter(tags=["messages"])


def resolve_dm_partner(conv_id: str) -> Optional[Dict[str, Any]]:
    """Resolve a DM partner from either username (including purely numeric student IDs) or user ID."""
    clean = str(conv_id).strip().removeprefix("dm:")
    partner = get_user_by_username(clean)
    if partner:
        return partner
    if clean.isdigit():
        return get_user_by_id(int(clean))
    return None


@router.patch("/api/messages/{message_id}")
async def api_update_message(message_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    data = await main.read_json_body(request)
    content = str(data.get("content", "")).strip()
    if not content:
        raise HTTPException(400, "메시지 내용을 입력하세요.")
    if len(content) > main.MAX_CONTENT_LEN:
        raise HTTPException(400, f"메시지는 {main.MAX_CONTENT_LEN}자 이하여야 합니다.")
    try:
        updated = await asyncio.to_thread(update_message_content, message_id, content, user["id"], is_admin=user["role"] == "admin")
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    if not updated:
        raise HTTPException(404, "메시지를 찾을 수 없습니다.")
    users = await asyncio.to_thread(list_mentionable_users)
    enriched = main.with_mentions(updated, users)
    await main.broadcast({"type": "message_edited", "message": enriched})
    return enriched


@router.patch("/api/dms/{dm_id}")
async def api_update_direct_message(dm_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    data = await main.read_json_body(request)
    content = str(data.get("content", "")).strip()
    if not content:
        raise HTTPException(400, "메시지 내용을 입력하세요.")
    if len(content) > main.MAX_CONTENT_LEN:
        raise HTTPException(400, f"메시지는 {main.MAX_CONTENT_LEN}자 이하여야 합니다.")
    try:
        updated = update_direct_message_content(dm_id, content, user["id"])
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    if not updated:
        raise HTTPException(404, "1:1 메시지를 찾을 수 없습니다.")

    payload = {"type": "dm_edited", "message": updated}
    encoded = json.dumps(payload, ensure_ascii=False)

    sender_targets = list(main.user_registry.get(updated["from_nick"], set()))
    recipient_targets = list(main.user_registry.get(updated["to_nick"], set()))
    for target_ws in set(sender_targets + recipient_targets):
        try:
            await target_ws.send_text(encoded)
        except Exception:
            pass

    return updated


@router.post("/api/messages/{message_id}/hide")
async def api_hide_message(message_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    main.require_admin(request)
    data = await main.read_json_body(request) if request.headers.get("content-type", "").startswith("application/json") else {}
    hidden = bool(data.get("hidden", True))
    updated = set_message_hidden(message_id, hidden)
    if not updated:
        raise HTTPException(404, "메시지를 찾을 수 없습니다.")
    users = list_mentionable_users()
    enriched = main.with_mentions(updated, users)
    await main.broadcast({"type": "message_hidden", "message": enriched, "is_hidden": hidden})
    return enriched


@router.post("/api/messages/{message_id}/move")
async def api_move_message(message_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    main.require_admin(request)
    data = await main.read_json_body(request)
    to_channel_id = data.get("to_channel_id")
    if not to_channel_id:
        raise HTTPException(400, "이동할 채널을 지정하세요.")
    try:
        to_channel_id = int(to_channel_id)
    except (ValueError, TypeError):
        raise HTTPException(400, "유효한 채널 ID가 아닙니다.")
    target_chan = get_channel_by_id(to_channel_id)
    if not target_chan:
        raise HTTPException(404, "대상 채널을 찾을 수 없습니다.")
    if target_chan.get("archived"):
        raise HTTPException(400, "보관된 채널로는 메시지를 이동할 수 없습니다.")
    current_msg = get_message_by_id(message_id)
    if not current_msg:
        raise HTTPException(404, "메시지를 찾을 수 없습니다.")
    from_channel_id = current_msg["channel_id"]
    if from_channel_id == to_channel_id:
        raise HTTPException(400, "이미 해당 채널에 위치한 메시지입니다.")
    updated = move_message_channel(message_id, to_channel_id)
    if not updated:
        raise HTTPException(404, "메시지를 찾을 수 없습니다.")
    users = list_mentionable_users()
    enriched = main.with_mentions(updated, users)
    await main.broadcast({
        "type": "message_moved",
        "message_id": enriched["message_id"],
        "from_channel_id": from_channel_id,
        "to_channel_id": to_channel_id,
        "message": enriched
    })
    return enriched


@router.post("/api/messages/{message_type}/{message_id}/reactions/toggle")
async def api_toggle_reaction(message_type: str, message_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    if message_type not in ("channel", "dm"):
        raise HTTPException(400, "유효하지 않은 메시지 유형입니다.")

    data = await main.read_json_body(request)
    emoji = str(data.get("emoji", "")).strip()
    if not emoji or emoji not in ALLOWED_REACTION_EMOJIS:
        raise HTTPException(400, "유효하지 않은 이모지입니다.")

    if message_type == "channel":
        msg = get_message_by_id(message_id, current_user_id=user["id"])
        if not msg:
            raise HTTPException(404, "메시지를 찾을 수 없습니다.")
        if msg.get("is_hidden") and user["role"] != "admin":
            raise HTTPException(403, "숨겨진 메시지에는 반응할 수 없습니다.")

        toggle_message_reaction("channel", message_id, user["id"], emoji)
        updated_reactions = get_message_reactions("channel", message_id, current_user_id=user["id"])

        all_reactions = get_message_reactions("channel", message_id, current_user_id=None)
        await main.broadcast({
            "type": "reaction_updated",
            "message_type": "channel",
            "message_id": message_id,
            "channel_id": msg["channel_id"],
            "reactions": all_reactions,
        })
        return {
            "message_type": "channel",
            "message_id": message_id,
            "reactions": updated_reactions,
        }
    else:  # dm
        dm = get_direct_message_by_id(message_id, current_user_id=user["id"])
        if not dm:
            raise HTTPException(404, "대화 메시지를 찾을 수 없습니다.")
        if user["id"] not in (dm["from_user_id"], dm["to_user_id"]):
            raise HTTPException(403, "대화 참여자만 반응할 수 있습니다.")

        toggle_message_reaction("dm", message_id, user["id"], emoji)
        user_reactions = get_message_reactions("dm", message_id, current_user_id=user["id"])

        partner_id = dm["to_user_id"] if dm["from_user_id"] == user["id"] else dm["from_user_id"]

        user_event = {
            "type": "reaction_updated",
            "message_type": "dm",
            "message_id": message_id,
            "reactions": user_reactions,
        }
        await main.send_to_user_id(user["id"], user_event)

        partner_reactions = get_message_reactions("dm", message_id, current_user_id=partner_id)
        partner_event = {
            "type": "reaction_updated",
            "message_type": "dm",
            "message_id": message_id,
            "reactions": partner_reactions,
        }
        await main.send_to_user_id(partner_id, partner_event)

        return {
            "message_type": "dm",
            "message_id": message_id,
            "reactions": user_reactions,
        }


@router.get("/api/read-states")
async def api_get_read_states(request: Request):
    user = main.request_user(request)
    states = get_user_conversation_states(user["id"])
    unread_counts = get_user_unread_counts(user["id"])
    return {"states": states, "unread_counts": unread_counts}


@router.post("/api/read-states/ack")
async def api_ack_read_state(request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    data = await main.read_json_body(request)
    conv_type = str(data.get("conversation_type", "")).strip()
    conv_id = str(data.get("conversation_id", "")).strip().removeprefix("dm:").removeprefix("channel:")
    last_read_id = data.get("last_read_message_id")
    if conv_type not in ("channel", "dm") or not conv_id or last_read_id is None:
        raise HTTPException(400, "유효한 대화 정보와 메시지 ID가 필요합니다.")
    try:
        last_read_id = int(last_read_id)
    except (ValueError, TypeError):
        raise HTTPException(400, "유효한 메시지 ID가 아닙니다.")

    if conv_type == "dm":
        partner = await asyncio.to_thread(resolve_dm_partner, conv_id)
        if not partner:
            raise HTTPException(404, "대화 상대를 찾을 수 없습니다.")
        conv_id = str(partner["id"])

    updated = await asyncio.to_thread(update_user_read_state, user["id"], conv_type, conv_id, last_read_id)
    unread_counts = await asyncio.to_thread(get_user_unread_counts, user["id"])
    payload = {
        "type": "read_state_updated",
        "state": updated,
        "unread_counts": unread_counts
    }
    await main.send_to_user_id(user["id"], payload)
    return {"state": updated, "unread_counts": unread_counts}


@router.post("/api/read-states/mute")
async def api_set_muted(request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    data = await main.read_json_body(request)
    conv_type = str(data.get("conversation_type", "")).strip()
    conv_id = str(data.get("conversation_id", "")).strip().removeprefix("dm:").removeprefix("channel:")
    muted = bool(data.get("muted", True))
    if conv_type not in ("channel", "dm") or not conv_id:
        raise HTTPException(400, "유효한 대화 정보가 필요합니다.")

    if conv_type == "dm":
        partner = resolve_dm_partner(conv_id)
        if not partner:
            raise HTTPException(404, "대화 상대를 찾을 수 없습니다.")
        conv_id = str(partner["id"])

    updated = set_conversation_muted(user["id"], conv_type, conv_id, muted)
    payload = {
        "type": "conversation_muted_updated",
        "state": updated
    }
    await main.send_to_user_id(user["id"], payload)
    return {"state": updated}


@router.get("/api/conversations/{conv_type}/{conv_id}/pins")
async def api_get_pins(conv_type: str, conv_id: str, request: Request):
    user = main.request_user(request)
    if conv_type not in ("channel", "dm"):
        raise HTTPException(400, "유효하지 않은 대화 유형입니다.")

    if conv_type == "channel":
        try:
            cid = int(conv_id)
        except (ValueError, TypeError):
            raise HTTPException(400, "유효하지 않은 채널 ID입니다.")
        chan = get_channel_by_id(cid)
        if not chan:
            raise HTTPException(404, "채널을 찾을 수 없습니다.")
        pins = get_pinned_messages("channel", str(cid), current_user_id=user["id"])
    else:
        partner = resolve_dm_partner(conv_id)
        if not partner or partner["id"] == user["id"]:
            raise HTTPException(404, "대화 상대를 찾을 수 없습니다.")
        norm_id = normalize_dm_conversation_id(user["id"], partner["id"])
        pins = get_pinned_messages("dm", norm_id, current_user_id=user["id"])

    users = list_mentionable_users()
    enriched_pins = []
    for pin in pins:
        p = dict(pin)
        p["message"] = main.with_mentions(p["message"], users)
        enriched_pins.append(p)
    return {"pins": enriched_pins}


@router.post("/api/conversations/{conv_type}/{conv_id}/pins/{message_id}")
async def api_pin_message(conv_type: str, conv_id: str, message_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    if conv_type not in ("channel", "dm"):
        raise HTTPException(400, "유효하지 않은 대화 유형입니다.")

    if conv_type == "channel":
        try:
            cid = int(conv_id)
        except (ValueError, TypeError):
            raise HTTPException(400, "유효하지 않은 채널 ID입니다.")
        chan = get_channel_by_id(cid)
        if not chan:
            raise HTTPException(404, "채널을 찾을 수 없습니다.")
        try:
            pin = pin_message("channel", str(cid), message_id, user["id"])
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc

        users = list_mentionable_users()
        pin["message"] = main.with_mentions(pin["message"], users)

        await main.broadcast({
            "type": "pin_updated",
            "conversation_type": "channel",
            "conversation_id": str(cid),
            "message_id": message_id,
            "is_pinned": True,
            "pin": pin,
        })
        return pin
    else:
        partner = resolve_dm_partner(conv_id)
        if not partner or partner["id"] == user["id"]:
            raise HTTPException(404, "대화 상대를 찾을 수 없습니다.")
        norm_id = normalize_dm_conversation_id(user["id"], partner["id"])
        try:
            pin = pin_message("dm", norm_id, message_id, user["id"])
        except ValueError as exc:
            raise HTTPException(404, str(exc)) from exc
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc

        users = list_mentionable_users()
        pin["message"] = main.with_mentions(pin["message"], users)

        payload = {
            "type": "pin_updated",
            "conversation_type": "dm",
            "conversation_id": norm_id,
            "partner_id": partner["id"],
            "partner_username": partner["username"],
            "sender_id": user["id"],
            "sender_username": user["username"],
            "message_id": message_id,
            "is_pinned": True,
            "pin": pin,
        }
        encoded = json.dumps(payload, ensure_ascii=False)
        targets = set(main.user_registry.get(user["username"], set()) | main.user_registry.get(partner["username"], set()))
        for target_ws in targets:
            try:
                await target_ws.send_text(encoded)
            except Exception:
                pass
        return pin


@router.delete("/api/conversations/{conv_type}/{conv_id}/pins/{message_id}")
async def api_unpin_message(conv_type: str, conv_id: str, message_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    if conv_type not in ("channel", "dm"):
        raise HTTPException(400, "유효하지 않은 대화 유형입니다.")

    if conv_type == "channel":
        try:
            cid = int(conv_id)
        except (ValueError, TypeError):
            raise HTTPException(400, "유효하지 않은 채널 ID입니다.")
        chan = get_channel_by_id(cid)
        if not chan:
            raise HTTPException(404, "채널을 찾을 수 없습니다.")
        unpinned = unpin_message("channel", str(cid), message_id, user["id"])
        await main.broadcast({
            "type": "pin_updated",
            "conversation_type": "channel",
            "conversation_id": str(cid),
            "message_id": message_id,
            "is_pinned": False,
            "pin": None,
        })
        return {"success": unpinned}
    else:
        partner = resolve_dm_partner(conv_id)
        if not partner or partner["id"] == user["id"]:
            raise HTTPException(404, "대화 상대를 찾을 수 없습니다.")
        norm_id = normalize_dm_conversation_id(user["id"], partner["id"])
        try:
            unpinned = unpin_message("dm", norm_id, message_id, user["id"])
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc

        payload = {
            "type": "pin_updated",
            "conversation_type": "dm",
            "conversation_id": norm_id,
            "partner_id": partner["id"],
            "partner_username": partner["username"],
            "sender_id": user["id"],
            "sender_username": user["username"],
            "message_id": message_id,
            "is_pinned": False,
            "pin": None,
        }
        encoded = json.dumps(payload, ensure_ascii=False)
        targets = set(main.user_registry.get(user["username"], set()) | main.user_registry.get(partner["username"], set()))
        for target_ws in targets:
            try:
                await target_ws.send_text(encoded)
            except Exception:
                pass
        return {"success": unpinned}


@router.get("/api/messages")
async def api_messages(request: Request):
    main.request_user(request)
    users = list_mentionable_users()
    return [main.with_mentions(message, users) for message in get_recent_messages()]


@router.get("/api/search")
async def api_search_messages(request: Request, q: str, scope: str = "current",
                              conversation_type: Optional[str] = None,
                              conversation_id: Optional[str] = None, limit: int = 50):
    user = main.request_user(request)
    query = q.strip()
    if len(query) < 2:
        raise HTTPException(400, "검색어는 두 글자 이상 입력하세요.")
    if scope not in {"current", "global"}:
        raise HTTPException(400, "유효하지 않은 검색 범위입니다.")
    if scope == "current":
        if conversation_type not in {"channel", "dm"} or not conversation_id:
            raise HTTPException(400, "현재 대화 정보가 필요합니다.")
        if conversation_type == "dm":
            partner = get_user_by_username(conversation_id)
            if not partner or partner["id"] == user["id"]:
                raise HTTPException(404, "대화 상대를 찾을 수 없습니다.")
            conversation_id = str(partner["id"])
    else:
        conversation_type = None
        conversation_id = None
    results = search_conversation_history(user["id"], query,
        is_admin=user["role"] == "admin", conversation_type=conversation_type,
        conversation_id=conversation_id, limit=limit)
    return {"query": query, "scope": scope, "results": results, "count": len(results)}


@router.get("/api/history/public")
async def public_message_history(request: Request, before_id: Optional[int] = None):
    user = main.request_user(request)
    messages = await asyncio.to_thread(get_recent_messages, main.PUBLIC_HISTORY_PAGE_SIZE + 1, before_id, current_user_id=user["id"])
    has_more = len(messages) > main.PUBLIC_HISTORY_PAGE_SIZE
    messages = messages[-main.PUBLIC_HISTORY_PAGE_SIZE:]
    users = await asyncio.to_thread(list_mentionable_users)
    return {"messages": [main.with_mentions(message, users) for message in messages],
            "has_more": has_more}


@router.get("/api/history/dm/{partner_username}")
async def direct_message_history(partner_username: str, request: Request,
                                 before_id: Optional[int] = None):
    user = main.request_user(request)
    partner = await asyncio.to_thread(resolve_dm_partner, partner_username)
    if not partner or partner["id"] == user["id"]:
        raise HTTPException(404, "대화 상대를 찾을 수 없습니다.")
    messages = await asyncio.to_thread(
        get_direct_messages_between, user["id"], partner["id"], main.PUBLIC_HISTORY_PAGE_SIZE + 1, before_id
    )
    has_more = len(messages) > main.PUBLIC_HISTORY_PAGE_SIZE
    return {"messages": messages[-main.PUBLIC_HISTORY_PAGE_SIZE:], "has_more": has_more}

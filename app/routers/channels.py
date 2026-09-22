"""Channel management and channel message history routes."""
from __future__ import annotations
import asyncio
from typing import Optional
from fastapi import APIRouter, HTTPException, Request

from app.auth import (
    validate_channel_description, validate_channel_display_name, validate_channel_name
)
from app.database import (
    archive_channel, channel_exists, create_channel, delete_channel,
    get_channel_by_id, get_channel_by_name, get_recent_messages,
    list_channels, list_mentionable_users, update_channel
)
from app import main

router = APIRouter(prefix="/api/channels", tags=["channels"])


@router.get("")
async def api_channels_list(request: Request, include_archived: bool = False):
    user = main.request_user(request)
    if include_archived and user["role"] != "admin":
        raise HTTPException(403, "관리자 권한이 필요합니다.")
    return list_channels(include_archived=include_archived)


@router.post("", status_code=201)
async def api_create_channel(request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    data = await main.read_json_body(request)
    name = str(data.get("name", ""))
    display_name = str(data.get("display_name", ""))
    description = str(data.get("description", ""))
    try:
        clean_name = validate_channel_name(name)
        clean_display = validate_channel_display_name(display_name)
        clean_desc = validate_channel_description(description)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if get_channel_by_name(clean_name):
        raise HTTPException(409, "이미 존재하는 채널 이름입니다.")
    channel = create_channel(clean_name, clean_display, clean_desc, user["id"])
    await main.broadcast({"type": "channel_created", "channel": channel})
    return channel


@router.get("/{channel_id}")
async def api_get_channel(channel_id: int, request: Request):
    main.request_user(request)
    channel = get_channel_by_id(channel_id)
    if not channel:
        raise HTTPException(404, "채널을 찾을 수 없습니다.")
    return channel


@router.patch("/{channel_id}")
async def api_update_channel(channel_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    main.require_admin(request)
    current = get_channel_by_id(channel_id)
    if not current:
        raise HTTPException(404, "채널을 찾을 수 없습니다.")
    data = await main.read_json_body(request)
    name = data.get("name")
    display_name = data.get("display_name")
    description = data.get("description")

    if name is not None:
        try:
            clean_name = validate_channel_name(str(name))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        existing = get_channel_by_name(clean_name)
        if existing and existing["id"] != channel_id:
            raise HTTPException(409, "이미 존재하는 채널 이름입니다.")
        name = clean_name

    if display_name is not None:
        try:
            display_name = validate_channel_display_name(str(display_name))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    if description is not None:
        try:
            description = validate_channel_description(str(description))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    updated = update_channel(channel_id, name=name, display_name=display_name, description=description)
    if not updated:
        raise HTTPException(404, "채널을 찾을 수 없습니다.")
    await main.broadcast({"type": "channel_updated", "channel": updated})
    return updated


@router.post("/{channel_id}/archive")
@router.post("/{channel_id}/unarchive")
async def api_archive_channel(channel_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    main.require_admin(request)
    current = get_channel_by_id(channel_id)
    if not current:
        raise HTTPException(404, "채널을 찾을 수 없습니다.")
    if current.get("is_default"):
        raise HTTPException(400, "기본 채널은 보관할 수 없습니다.")
    data = await main.read_json_body(request) if request.headers.get("content-type", "").startswith("application/json") else {}
    unarchive = bool(data.get("unarchive", False)) or request.url.path.endswith("/unarchive")
    try:
        updated = archive_channel(channel_id, unarchive=unarchive)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not updated:
        raise HTTPException(404, "채널을 찾을 수 없습니다.")
    event_type = "channel_unarchived" if unarchive else "channel_archived"
    await main.broadcast({"type": event_type, "channel_id": channel_id, "channel": updated})
    return updated


@router.delete("/{channel_id}")
async def api_delete_channel(channel_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    main.require_admin(request)
    current = get_channel_by_id(channel_id)
    if not current:
        raise HTTPException(404, "채널을 찾을 수 없습니다.")
    if current.get("is_default"):
        raise HTTPException(400, "기본 채널은 삭제할 수 없습니다.")
    try:
        deleted_files = delete_channel(channel_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if deleted_files is None:
        raise HTTPException(404, "채널을 찾을 수 없습니다.")
    for stored_name in deleted_files:
        main.remove_stored_file(stored_name)
    await main.broadcast({"type": "channel_deleted", "channel_id": channel_id})
    return {"status": "ok", "deleted_channel_id": channel_id}


@router.get("/{channel_id}/messages")
async def channel_message_history(channel_id: int, request: Request, before_id: Optional[int] = None):
    user = main.request_user(request)
    if not await asyncio.to_thread(channel_exists, channel_id):
        raise HTTPException(404, "채널을 찾을 수 없습니다.")
    messages = await asyncio.to_thread(get_recent_messages, main.PUBLIC_HISTORY_PAGE_SIZE + 1, before_id, channel_id=channel_id, current_user_id=user["id"])
    has_more = len(messages) > main.PUBLIC_HISTORY_PAGE_SIZE
    messages = messages[-main.PUBLIC_HISTORY_PAGE_SIZE:]
    users = await asyncio.to_thread(list_mentionable_users)
    return {"messages": [main.with_mentions(message, users) for message in messages],
            "has_more": has_more}

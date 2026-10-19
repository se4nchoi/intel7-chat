"""Group DM (multi-user private ad-hoc channel) management routes."""
from __future__ import annotations
import asyncio
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Request

from app.database import (
    create_group_dm,
    get_channel_by_id,
    get_group_dm_detail,
    get_group_dm_member_ids,
    get_group_dm_members,
    is_group_dm_member,
    list_user_group_dms,
    add_group_dm_members,
    leave_group_dm,
    update_group_dm_name,
)
from app import main

router = APIRouter(prefix="/api/group-dms", tags=["group_dms"])


@router.get("")
async def api_list_my_group_dms(request: Request):
    user = main.request_user(request)
    gdms = await asyncio.to_thread(list_user_group_dms, user["id"])
    unread_counts = await asyncio.to_thread(main.get_user_unread_counts, user["id"])
    for g in gdms:
        g["unread_count"] = unread_counts.get(f"channel:{g['id']}", 0)
    return gdms


@router.get("/users")
async def api_list_group_dm_candidate_users(request: Request):
    user = main.request_user(request)
    users = await asyncio.to_thread(main.list_mentionable_users)
    online_user_ids = {info.user_id for info in main.connected_clients.values()}
    return [
        {
            "id": u["id"],
            "username": u["username"],
            "display_name": u.get("display_name") or u["username"],
            "online": u["id"] in online_user_ids,
        }
        for u in users
        if u["id"] != user["id"]
    ]


@router.post("", status_code=201)
async def api_create_group_dm(request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    data = await main.read_json_body(request)
    member_ids = data.get("member_ids", [])
    if not isinstance(member_ids, list) or not member_ids:
        raise HTTPException(400, "초대할 참여자를 1명 이상 선택하세요.")
    name = data.get("name")
    if name is not None:
        name = str(name).strip()[:50]
    try:
        group_dm = await asyncio.to_thread(
            create_group_dm, user["id"], member_ids, custom_name=name
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    member_ids_set = await asyncio.to_thread(get_group_dm_member_ids, group_dm["id"])
    await main.send_to_user_ids(member_ids_set, {
        "type": "group_dm_created",
        "group_dm": group_dm,
    })
    return group_dm


@router.get("/{channel_id:int}")
async def api_get_group_dm(channel_id: int, request: Request):
    user = main.request_user(request)
    detail = await asyncio.to_thread(get_group_dm_detail, channel_id, user["id"])
    if not detail:
        raise HTTPException(404, "그룹 대화를 찾을 수 없거나 접근 권한이 없습니다.")
    return detail


@router.patch("/{channel_id:int}")
async def api_update_group_dm_name(channel_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    data = await main.read_json_body(request)
    name = str(data.get("name", "")).strip()
    try:
        updated = await asyncio.to_thread(update_group_dm_name, channel_id, name, user["id"])
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc

    member_ids = await asyncio.to_thread(get_group_dm_member_ids, channel_id)
    await main.send_to_user_ids(member_ids, {
        "type": "group_dm_updated",
        "channel_id": channel_id,
        "group_dm": updated,
    })
    return updated


@router.post("/{channel_id:int}/members")
async def api_add_group_dm_members(channel_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    data = await main.read_json_body(request)
    new_member_ids = data.get("member_ids", [])
    if not isinstance(new_member_ids, list) or not new_member_ids:
        raise HTTPException(400, "추가할 참여자를 선택하세요.")
    try:
        await asyncio.to_thread(add_group_dm_members, channel_id, new_member_ids, user["id"])
        detail = await asyncio.to_thread(get_group_dm_detail, channel_id, user["id"])
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(400, str(exc)) from exc

    member_ids = await asyncio.to_thread(get_group_dm_member_ids, channel_id)
    await main.send_to_user_ids(member_ids, {
        "type": "group_dm_updated",
        "channel_id": channel_id,
        "group_dm": detail,
    })
    return detail


@router.delete("/{channel_id:int}/members/me")
async def api_leave_group_dm(channel_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    try:
        await asyncio.to_thread(leave_group_dm, channel_id, user["id"])
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc

    remaining_ids = await asyncio.to_thread(get_group_dm_member_ids, channel_id)
    if remaining_ids:
        await main.send_to_user_ids(remaining_ids, {
            "type": "group_dm_member_left",
            "channel_id": channel_id,
            "user_id": user["id"],
            "username": user["username"],
            "display_name": user.get("display_name") or user["username"],
        })
    return {"ok": True}

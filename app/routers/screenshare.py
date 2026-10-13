"""Screenshare status API routes."""
from __future__ import annotations
from typing import Optional
from fastapi import APIRouter, Request

from app.screenshare import screenshare_manager

router = APIRouter(prefix="/api/screenshare", tags=["screenshare"])


@router.get("/status")
async def api_screenshare_status(request: Request, channel_id: Optional[str] = None):
    from app import main
    user = main.require_user(request)
    if channel_id is not None:
        room = main.screenshare_room_for_user(channel_id, user)
        return await screenshare_manager.get_channel_status(room)
    return {"sessions": await screenshare_manager.get_all_sessions(for_username=user["username"])}

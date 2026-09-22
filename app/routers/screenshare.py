"""Screenshare status API routes."""
from __future__ import annotations
from typing import Optional
from fastapi import APIRouter

from app.screenshare import screenshare_manager

router = APIRouter(prefix="/api/screenshare", tags=["screenshare"])


@router.get("/status")
async def api_screenshare_status(channel_id: Optional[str] = None):
    if channel_id is not None:
        return await screenshare_manager.get_channel_status(channel_id)
    return {"sessions": await screenshare_manager.get_all_sessions()}

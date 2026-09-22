"""Turn-based games rankings and leaderboards routes."""
from __future__ import annotations
from fastapi import APIRouter, Request

from app.database import (
    get_chess_leaderboard, get_janggi_leaderboard, get_omok_leaderboard
)
from app import main

router = APIRouter(tags=["games"])


@router.get("/api/chess/rankings")
async def api_chess_rankings(request: Request, limit: int = 20):
    main.request_user(request)
    leaderboard = get_chess_leaderboard(limit=limit)
    return {
        "leaderboard": leaderboard,
        "rankings": leaderboard,
    }


@router.get("/api/janggi/rankings")
async def api_janggi_rankings(request: Request, limit: int = 20):
    main.request_user(request)
    leaderboard = get_janggi_leaderboard(limit=limit)
    return {
        "leaderboard": leaderboard,
        "rankings": leaderboard,
    }


@router.get("/api/omok/rankings")
async def api_omok_rankings(request: Request, limit: int = 20):
    main.request_user(request)
    leaderboard = get_omok_leaderboard(limit=limit)
    return {
        "leaderboard": leaderboard,
        "rankings": leaderboard,
    }

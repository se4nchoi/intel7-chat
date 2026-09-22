"""Authentication and user session routes."""
from __future__ import annotations
import asyncio
from datetime import datetime, timedelta, timezone
import sqlite3
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from app.auth import (
    hash_secret, new_session_token, normalize_username, secret_needs_rehash,
    token_hash, validate_display_name, validate_password, validate_username, verify_secret
)
from app.database import (
    create_session, create_user, delete_session, get_session_user, get_user_by_username,
    get_user_quiz_badge, get_user_quiz_title_options, update_display_name,
    update_password_hash, update_quiz_badge_selection
)
from app import main

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register")
async def register(request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    if not main.CONFIG.registration_enabled or not main.CONFIG.enrollment_code_hash:
        raise HTTPException(403, "현재 신규 가입이 닫혀 있습니다.")
    ip = main.get_client_ip(request)
    if not main.sliding_window_allowed(main.login_timestamps, f"register:{ip}", main.LOGIN_RATE_LIMIT, main.LOGIN_RATE_WINDOW_SECONDS):
        raise HTTPException(429, "요청이 너무 많습니다. 잠시 후 다시 시도하세요.")
    data = await main.read_json_body(request)
    try:
        username = validate_username(str(data.get("username", "")))
        password = str(data.get("password", ""))
        validate_password(password)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    enrollment = str(data.get("enrollment_code", ""))
    if not await asyncio.to_thread(verify_secret, main.CONFIG.enrollment_code_hash, enrollment):
        raise HTTPException(403, "가입 코드가 올바르지 않습니다.")
    password_hash = await asyncio.to_thread(hash_secret, password)
    try:
        user = create_user(username, password_hash)
    except sqlite3.IntegrityError as exc:
        raise HTTPException(409, "이미 사용 중인 아이디입니다.") from exc
    raw = new_session_token()
    expiry = (datetime.now(timezone.utc) + timedelta(hours=main.CONFIG.session_hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    ip = main.get_client_ip(request)
    create_session(token_hash(raw), user["id"], expiry, client_ip=ip)
    user = get_session_user(token_hash(raw))
    response = JSONResponse(main.public_user(user), status_code=201)
    main.set_session_cookie(response, raw, request)
    return response


@router.post("/login")
async def login(request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    data = await main.read_json_body(request)
    username = str(data.get("username", ""))
    password = str(data.get("password", ""))
    ip = main.get_client_ip(request)
    key = f"{ip}:{normalize_username(username)[:50]}"
    if not main.sliding_window_allowed(main.login_timestamps, key, main.LOGIN_RATE_LIMIT, main.LOGIN_RATE_WINDOW_SECONDS):
        raise HTTPException(429, "로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.")
    user = get_user_by_username(username)
    candidate_hash = user["password_hash"] if user else main.DUMMY_LOGIN_HASH
    password_ok = await asyncio.to_thread(verify_secret, candidate_hash, password)
    if user and password_ok and not user["active"]:
        raise HTTPException(401, "이 아이디는 비활성화되어 있습니다. 관리자에게 문의하세요.")
    valid = bool(user and user["active"] and password_ok)
    if not valid:
        raise HTTPException(401, "아이디 또는 비밀번호가 올바르지 않습니다.")
    if secret_needs_rehash(user["password_hash"]):
        update_password_hash(user["id"], await asyncio.to_thread(hash_secret, password))
    raw = new_session_token()
    expiry = (datetime.now(timezone.utc) + timedelta(hours=main.CONFIG.session_hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    create_session(token_hash(raw), user["id"], expiry, client_ip=ip)
    user = get_session_user(token_hash(raw))
    response = JSONResponse(main.public_user(user))
    main.set_session_cookie(response, raw, request)
    return response


@router.post("/logout", status_code=204)
async def logout(request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    raw = request.cookies.get(main.SESSION_COOKIE, "")
    if raw:
        delete_session(token_hash(raw))
    response = Response(status_code=204)
    response.delete_cookie(main.SESSION_COOKIE, path="/", samesite="strict")
    return response


@router.get("/me")
async def auth_me(request: Request):
    return main.public_user(main.request_user(request))


@router.post("/display-name")
async def change_display_name(request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    data = await main.read_json_body(request)
    raw_name = str(data.get("display_name", ""))
    try:
        display_name = validate_display_name(raw_name)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    updated = update_display_name(user["id"], display_name)
    if not updated:
        raise HTTPException(404, "사용자를 찾을 수 없습니다.")
    await main.broadcast_users()
    return main.public_user(updated)


@router.get("/quiz-titles")
async def get_my_quiz_titles(request: Request):
    user = main.request_user(request)
    titles = get_user_quiz_title_options(user["id"])
    selected = user.get("quiz_badge_selection") or "score"
    if selected not in {"score", "none"} and selected not in {item["selection"] for item in titles}:
        selected = "score"
    return {
        "selected": selected,
        "titles": titles,
    }


@router.post("/quiz-title")
async def change_quiz_title(request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    data = await main.read_json_body(request)
    try:
        updated = update_quiz_badge_selection(user["id"], str(data.get("selection", "score")))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not updated:
        raise HTTPException(404, "사용자를 찾을 수 없습니다.")
    await main.broadcast_users()
    return {
        "selected": updated.get("quiz_badge_selection") or "score",
        "quiz_badge": get_user_quiz_badge(user["id"]),
    }

"""FastAPI server for a persistent authenticated classroom LAN chat."""
from __future__ import annotations
import asyncio
import hashlib
import ipaddress
import json
import logging
import os
import re
import sqlite3
import time
import uuid
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Deque, Dict, Optional, Set
from urllib.parse import unquote, urlsplit

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.auth import (hash_secret, new_session_token, normalize_username, secret_needs_rehash,
                        token_hash, validate_channel_description, validate_channel_display_name,
                        validate_channel_name, validate_display_name, validate_password,
                        validate_username, verify_secret)
from app.config import load_config, save_config
from app.database import (attachment_is_visible_to_user, channel_exists, claim_attachments, configure_storage, count_active_admins,
    create_channel, create_session, create_user, delete_owned_attachment, delete_session,
    delete_user_sessions, get_attachment_record, get_channel_by_id, get_channel_by_name,
    get_direct_messages_between, get_recent_direct_messages, get_recent_messages, get_session_user,
    get_storage_status, get_upload_usage, get_user_by_id, get_user_by_username, init_db,
    list_channels, list_mentionable_users, list_users, prune_expired_sessions, save_attachment,
    save_direct_message, save_message, set_user_active,
    set_user_role, update_channel, archive_channel, delete_channel,
    get_message_by_id, update_message_content, set_message_hidden, move_message_channel,
    get_user_conversation_states, update_user_read_state, set_conversation_muted, get_user_unread_counts,
    update_display_name, update_password_hash,
    ALLOWED_REACTION_EMOJIS, toggle_message_reaction, get_message_reactions, get_direct_message_by_id,
    update_direct_message_content,
    normalize_dm_conversation_id, pin_message, unpin_message, get_pinned_messages, get_pinned_message_ids,
    get_daily_quizzes, submit_quiz_answer, get_user_quiz_stats, get_quiz_leaderboard,
    get_quiz_subject_leaderboard, get_chess_leaderboard,
    get_janggi_leaderboard, get_omok_leaderboard,
    get_user_quiz_badge, get_user_quiz_badges_map, get_user_quiz_title_options,
    update_quiz_badge_selection, create_quiz, create_quiz_batch,
    get_all_quizzes_admin, delete_quiz, update_quiz, save_quiz_source_document, get_quiz_source_documents,
    flag_quiz_question, get_quiz_flags, resolve_quiz_flag, get_quiz_by_id_admin,
    toggle_quiz_bookmark, get_quiz_review_list, retry_quiz_answer,
    get_quiz_categories_summary, get_quiz_sidebar_counts, search_conversation_history,
    QUIZ_EXPERTISES, normalize_quiz_import, analyze_quiz_set, create_user_quiz_set, update_user_quiz_set, list_user_quiz_sets, submit_user_quiz_set,
    review_user_quiz_set, update_pending_user_quiz_set, assign_daily_quizzes,
    save_quiz_subject_titles, get_quiz_subject_titles, get_all_quiz_subject_titles)
from app.quiz_ai import generate_quizzes_with_gemini, check_quiz_answer, normalize_quiz_answer
from app.chess_manager import chess_manager
from app.janggi_manager import janggi_manager
from app.omok_manager import omok_manager
from app.othello_manager import othello_manager
from app.screenshare import screenshare_manager, normalize_room_id

CONFIG = load_config()
configure_storage(CONFIG.data_path, CONFIG.database_limit_bytes)
SERVICE_NAME = CONFIG.server_name
MAX_CONTENT_LEN = 2000
MAX_ATTACHMENTS_PER_MESSAGE = 5
MAX_REPLY_CONTENT_LEN = 180
MAX_RAW_MESSAGE_LEN = 65536
MAX_CONNECTIONS_TOTAL = 50
MAX_CONNECTIONS_PER_IP = 4
RATE_LIMIT_MESSAGES = 30
RATE_LIMIT_WINDOW_SECONDS = 10
UPLOAD_RATE_LIMIT = 8
UPLOAD_RATE_WINDOW_SECONDS = 60
LOGIN_RATE_LIMIT = 12
LOGIN_RATE_WINDOW_SECONDS = 300
MAX_AUTH_BODY_BYTES = 16 * 1024
PUBLIC_HISTORY_PAGE_SIZE = 50
DM_HISTORY_PAGE_SIZE = 30
MAX_UPLOAD_BYTES = int(os.getenv("CLASSROOM_MAX_FILE_MB", "50")) * 1024 * 1024
MAX_UPLOAD_BYTES_PER_USER = CONFIG.per_user_attachment_limit_bytes
MAX_TOTAL_UPLOAD_BYTES = CONFIG.attachment_limit_bytes
SESSION_COOKIE = "bamboochat_session"
BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = CONFIG.data_path / "uploads"
QUIZ_SOURCES_DIR = CONFIG.data_path / "quiz_sources"
QUIZ_IMAGES_DIR = CONFIG.data_path / "quiz_images"
EXPLICIT_ALLOWED_HOSTS = {h.strip().casefold() for h in
    os.getenv("CLASSROOM_ALLOWED_HOSTS", "").split(",") if h.strip()}
BLOCKED_UPLOAD_SUFFIXES = {".app",".bat",".cmd",".com",".cpl",".dll",".dmg",".exe",".hta",
    ".htm",".html",".jar",".js",".jse",".lnk",".mjs",".msi",".msp",".pif",".ps1",".reg",
    ".scr",".svg",".vbe",".vbs",".wsf",".wsh"}

DUMMY_LOGIN_HASH = hash_secret("bamboochat-dummy-login-value")
logger = logging.getLogger("bamboochat")
upload_lock = asyncio.Lock()

@dataclass(frozen=True)
class ClientInfo:
    user_id: int
    username: str
    role: str
    ip: str

connected_clients: Dict[WebSocket, ClientInfo] = {}
user_registry: Dict[str, Set[WebSocket]] = defaultdict(set)
message_timestamps: Dict[str, Deque[float]] = defaultdict(deque)
upload_timestamps: Dict[str, Deque[float]] = defaultdict(deque)
login_timestamps: Dict[str, Deque[float]] = defaultdict(deque)

def get_client_ip(connection) -> str:
    try:
        return connection.client.host or ""
    except Exception:
        return ""

def host_is_allowed(host_header: str) -> bool:
    try:
        hostname = urlsplit(f"//{host_header}").hostname
    except ValueError:
        return False
    if not hostname:
        return False
    hostname = hostname.casefold().rstrip(".")
    if hostname in EXPLICIT_ALLOWED_HOSTS or hostname == "localhost":
        return True
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return "." not in hostname or hostname.endswith(".local")
    return address.is_private or address.is_loopback or address.is_link_local

def origin_matches_host(origin: str, host: str) -> bool:
    if not origin or not host or not host_is_allowed(host):
        return False
    try:
        parsed = urlsplit(origin)
    except ValueError:
        return False
    return parsed.scheme in {"http","https"} and parsed.netloc.casefold() == host.casefold()

def request_origin_is_allowed(request: Request) -> bool:
    return origin_matches_host(request.headers.get("origin",""), request.headers.get("host",""))

def websocket_origin_is_allowed(ws: WebSocket) -> bool:
    return origin_matches_host(ws.headers.get("origin",""), ws.headers.get("host",""))

def sliding_window_allowed(registry: Dict[str,Deque[float]], key: str, limit: int,
                            window: int, now: Optional[float]=None) -> bool:
    current = time.monotonic() if now is None else now
    values = registry[key]
    cutoff = current-window
    while values and values[0] <= cutoff:
        values.popleft()
    if len(values) >= limit:
        return False
    values.append(current)
    return True

def clean_reply(value) -> Optional[dict]:
    if not isinstance(value, dict):
        return None
    nickname = str(value.get("nickname","")).strip()[:30]
    content = str(value.get("content","")).strip()[:MAX_REPLY_CONTENT_LEN]
    return {"nickname":nickname,"content":content} if nickname or content else None

def clean_original_filename(encoded_name: str) -> str:
    decoded = unquote(encoded_name).replace("\\","/").split("/")[-1]
    decoded = "".join(c for c in decoded if ord(c)>=32 and c not in '<>:"|?*').strip(" .")
    if not decoded:
        raise HTTPException(400, "파일 이름이 필요합니다.")
    if len(decoded)>180:
        suffix=Path(decoded).suffix[:20]
        decoded=decoded[:180-len(suffix)]+suffix
    return decoded

def upload_is_blocked(filename: str) -> bool:
    return any(filename.casefold().endswith(s) for s in BLOCKED_UPLOAD_SUFFIXES)

def detect_preview_type(header: bytes) -> Optional[str]:
    if header.startswith(b"\x89PNG\r\n\x1a\n"): return "image/png"
    if header.startswith(b"\xff\xd8\xff"): return "image/jpeg"
    if header.startswith((b"GIF87a",b"GIF89a")): return "image/gif"
    if len(header)>=12 and header[:4]==b"RIFF" and header[8:12]==b"WEBP": return "image/webp"
    return None

def attachment_path(stored_name: str) -> Path:
    return UPLOAD_DIR/stored_name

def remove_stored_file(stored_name: str) -> None:
    try:
        attachment_path(stored_name).unlink(missing_ok=True)
    except OSError:
        logger.exception("Failed to remove attachment %s", stored_name)

def session_user_from_token(raw_token: str) -> Optional[dict]:
    return get_session_user(token_hash(raw_token)) if raw_token else None

def request_user(request: Request) -> dict:
    user = session_user_from_token(request.cookies.get(SESSION_COOKIE,""))
    if not user:
        raise HTTPException(401, "로그인이 필요합니다.")
    return user

require_user = request_user


def public_user(user: dict) -> dict:
    return {"id":user["id"],"username":user["username"],
            "display_name":user.get("display_name") or user["username"],
            "role":user["role"],
            "session_expires_at":user.get("session_expires_at")}

def require_admin(request: Request) -> dict:
    user = request_user(request)
    if user["role"] != "admin":
        raise HTTPException(403, "관리자 권한이 필요합니다.")
    return user

async def read_json_body(request: Request) -> dict:
    content_length = request.headers.get("content-length", "")
    if content_length.isdigit() and int(content_length) > MAX_AUTH_BODY_BYTES:
        raise HTTPException(413, "요청 본문이 너무 큽니다.")
    body = await request.body()
    if len(body) > MAX_AUTH_BODY_BYTES:
        raise HTTPException(413, "요청 본문이 너무 큽니다.")
    try:
        data = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(400, "올바른 JSON 요청이 필요합니다.") from exc
    if not isinstance(data, dict):
        raise HTTPException(400, "올바른 JSON 객체가 필요합니다.")
    return data

def current_user_ip(user_id: int) -> Optional[str]:
    ips = sorted({info.ip for info in connected_clients.values()
                  if info.user_id == user_id and info.ip})
    return ", ".join(ips) if ips else None

def find_mentions(content: str, users: Optional[list[dict]] = None,
                  exclude_user_id: Optional[int] = None) -> list[dict]:
    matches = []
    for user in users if users is not None else list_mentionable_users():
        if exclude_user_id is not None and user["id"] == exclude_user_id:
            continue
        username = user["username"]
        display_name = user.get("display_name") or username
        # Match on @username
        pattern = rf"(?<![\w.@-])@{re.escape(username)}(?![\w.-])"
        if re.search(pattern, content, flags=re.IGNORECASE):
            matches.append({"user_id": user["id"], "username": username,
                            "display_name": display_name})
            continue
        # Also match on @display_name if it differs from username
        if display_name != username:
            display_pattern = rf"(?<![\w.@-])@{re.escape(display_name)}(?![\w.-])"
            if re.search(display_pattern, content, flags=re.IGNORECASE):
                matches.append({"user_id": user["id"], "username": username,
                                "display_name": display_name})
    return matches

def with_mentions(message: dict, users: Optional[list[dict]] = None) -> dict:
    result = dict(message)
    mentions = find_mentions(result.get("content", ""), users, result.get("author_id"))
    result["mentions"] = mentions
    result["mentioned_user_ids"] = [mention["user_id"] for mention in mentions]
    if result.get("author_id") and "quiz_badge" not in result:
        result["quiz_badge"] = get_user_quiz_badge(result["author_id"])
    return result

def account_public(user: dict) -> dict:
    return {"id": user["id"], "username": user["username"],
            "display_name": user.get("display_name") or user["username"],
            "role": user["role"],
            "active": bool(user["active"]), "created_at": user["created_at"],
            "last_login": user.get("last_login"),
            "last_login_ip": user.get("last_login_ip"),
            "message_count": user.get("message_count", 0),
            "attachment_bytes": user.get("attachment_bytes", 0),
            "current_ip": current_user_ip(user["id"])}

async def disconnect_user(user_id: int, reason: str) -> None:
    targets = [ws for ws, info in connected_clients.items() if info.user_id == user_id]
    for ws in targets:
        try:
            await ws.close(code=1008, reason=reason)
        except Exception:
            pass

def set_session_cookie(response: Response, raw_token: str, request: Request) -> None:
    response.set_cookie(SESSION_COOKIE, raw_token, max_age=CONFIG.session_hours*3600,
        httponly=True, samesite="strict", secure=request.url.scheme=="https", path="/")

def connection_limit_reason(ip: str) -> str:
    if len(connected_clients)>=MAX_CONNECTIONS_TOTAL:
        return "서버의 최대 접속 인원에 도달했습니다."
    if sum(info.ip==ip for info in connected_clients.values())>=MAX_CONNECTIONS_PER_IP:
        return "같은 기기에서 너무 많은 연결이 열려 있습니다."
    return ""

async def broadcast(payload: dict) -> None:
    encoded=json.dumps(payload,ensure_ascii=False)
    dead=set()
    for ws in list(connected_clients):
        try: await ws.send_text(encoded)
        except Exception: dead.add(ws)
    for ws in dead: _remove_client(ws)

async def send_to_user_id(user_id: int, payload: dict) -> None:
    encoded = json.dumps(payload, ensure_ascii=False)
    dead = set()
    for ws, info in list(connected_clients.items()):
        if info.user_id == user_id:
            try:
                await ws.send_text(encoded)
            except Exception:
                dead.add(ws)
    for ws in dead:
        _remove_client(ws)

async def send_to_username(username: str, payload: dict) -> None:
    encoded = json.dumps(payload, ensure_ascii=False)
    dead = set()
    for ws in list(user_registry.get(username, set())):
        try:
            await ws.send_text(encoded)
        except Exception:
            dead.add(ws)
    for ws in dead:
        _remove_client(ws)

async def notify_screenshare_event(room_id: Union[int, str], payload: dict) -> None:
    """Notify relevant clients about a screenshare event.

    If room_id is a DM (e.g. "dm:alice:bob"), only notify the two DM participants.
    Otherwise, broadcast to all clients.
    """
    room_str = str(room_id)
    if room_str.startswith("dm:"):
        parts = room_str.split(":")
        if len(parts) >= 3:
            await send_to_username(parts[1], payload)
            await send_to_username(parts[2], payload)
            return
    await broadcast(payload)

def _remove_client(ws: WebSocket) -> None:
    info=connected_clients.pop(ws,None)
    if info:
        sockets=user_registry.get(info.username,set())
        sockets.discard(ws)
        if not sockets: user_registry.pop(info.username,None)

async def broadcast_presence() -> None:
    await broadcast({"type":"presence","count":len(user_registry)})

async def broadcast_users() -> None:
    online_user_ids = {info.user_id for info in connected_clients.values()}
    raw_list = list_mentionable_users()
    uids = [u["id"] for u in raw_list]
    badges_map = get_user_quiz_badges_map(uids)
    mention_list = [
        {**user, "online": user["id"] in online_user_ids, "quiz_badge": badges_map.get(user["id"])}
        for user in raw_list
    ]
    await broadcast({
        "type":"users",
        "list":[{"nickname":name, "display_name":
                 next((u.get("display_name") or name for u in mention_list if u.get("username")==name), name)}
                for name in sorted(user_registry)],
        "mention_list":mention_list,
    })

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    UPLOAD_DIR.mkdir(parents=True,exist_ok=True)
    QUIZ_SOURCES_DIR.mkdir(parents=True,exist_ok=True)
    QUIZ_IMAGES_DIR.mkdir(parents=True,exist_ok=True)
    prune_expired_sessions()
    logger.info("Persistent storage initialized at %s", CONFIG.data_path)
    yield

app=FastAPI(title=SERVICE_NAME,lifespan=lifespan,docs_url=None,redoc_url=None,openapi_url=None)

@app.middleware("http")
async def security_headers(request: Request, call_next):
    if not host_is_allowed(request.headers.get("host","")):
        return PlainTextResponse("Invalid host",status_code=400)
    response=await call_next(request)
    response.headers["Content-Security-Policy"]=("default-src 'self'; base-uri 'none'; frame-ancestors 'none'; "
        "form-action 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; "
        "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; connect-src 'self' ws: wss:")
    response.headers["Referrer-Policy"]="no-referrer"
    response.headers["X-Content-Type-Options"]="nosniff"
    response.headers["X-Frame-Options"]="DENY"
    response.headers["Cache-Control"]="no-store"
    return response

app.mount("/static",StaticFiles(directory=BASE_DIR/"static"),name="static")
templates=Jinja2Templates(directory=BASE_DIR/"templates")

@app.get("/",response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request=request,name="index.html",context={
        "service_name":SERVICE_NAME,"max_message_len":MAX_CONTENT_LEN,
        "max_file_mb":MAX_UPLOAD_BYTES//(1024*1024),"max_files":MAX_ATTACHMENTS_PER_MESSAGE,
        "registration_enabled":CONFIG.registration_enabled})


# ==========================================
# Include Modular Routers
# ==========================================
from app.routers.auth import router as auth_router
from app.routers.channels import router as channels_router
from app.routers.messages import router as messages_router, resolve_dm_partner
from app.routers.files import router as files_router
from app.routers.admin import router as admin_router
from app.routers.quiz import router as quiz_router
from app.routers.games import router as games_router
from app.routers.screenshare import router as screenshare_router

app.include_router(auth_router)
app.include_router(channels_router)
app.include_router(messages_router)
app.include_router(files_router)
app.include_router(admin_router)
app.include_router(quiz_router)
app.include_router(games_router)
app.include_router(screenshare_router)



@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    ip=get_client_ip(ws)
    if not websocket_origin_is_allowed(ws):
        await ws.close(code=1008,reason="허용되지 않은 WebSocket origin입니다."); return
    user=session_user_from_token(ws.cookies.get(SESSION_COOKIE,""))
    if not user:
        await ws.close(code=1008,reason="로그인이 필요합니다."); return
    reason=connection_limit_reason(ip)
    if reason:
        await ws.close(code=1013,reason=reason); return
    await ws.accept()
    info=ClientInfo(user["id"],user["username"],user["role"],ip)
    connected_clients[ws]=info; user_registry[info.username].add(ws)
    logger.info("Connected user=%s ip=%s",info.user_id,ip)
    await broadcast_presence(); await broadcast_users()
    users = list_mentionable_users()
    public_candidates = get_recent_messages(PUBLIC_HISTORY_PAGE_SIZE + 1)
    public_history = public_candidates[-PUBLIC_HISTORY_PAGE_SIZE:]
    for message in public_history:
        await ws.send_text(json.dumps(
            {"type":"chat", "history":True, **with_mentions(message, users)}, ensure_ascii=False
        ))
    dm_candidates = get_recent_direct_messages(info.user_id, DM_HISTORY_PAGE_SIZE + 1)
    dm_groups: Dict[str, list[dict]] = defaultdict(list)
    for message in dm_candidates:
        partner = message["to_nick"] if message["from_user_id"] == info.user_id else message["from_nick"]
        dm_groups[partner].append(message)
    selected_dm_ids = {
        message["message_id"]
        for messages in dm_groups.values()
        for message in messages[-DM_HISTORY_PAGE_SIZE:]
    }
    dm_history = [message for message in dm_candidates
                  if message["message_id"] in selected_dm_ids]
    for message in dm_history:
        await ws.send_text(json.dumps({"type":"dm", "history":True, **message}, ensure_ascii=False))
    states = get_user_conversation_states(info.user_id)
    unread_counts = get_user_unread_counts(info.user_id)
    ss_sessions = await screenshare_manager.get_all_sessions(for_username=info.username)
    await ws.send_text(json.dumps({
        "type":"history_ready",
        "public_has_older":len(public_candidates) > PUBLIC_HISTORY_PAGE_SIZE,
        "dm_has_older":{partner: len(messages) > DM_HISTORY_PAGE_SIZE
                        for partner, messages in dm_groups.items()},
        "read_states": states,
        "unread_counts": unread_counts,
        "screenshare": ss_sessions,
        "screenshares": ss_sessions,
    },ensure_ascii=False))
    try:
        while True:
            raw=await ws.receive_text()
            if len(raw)>MAX_RAW_MESSAGE_LEN:
                await ws.close(code=1009,reason="메시지 프레임이 너무 큽니다."); break
            if not sliding_window_allowed(message_timestamps,str(info.user_id),RATE_LIMIT_MESSAGES,RATE_LIMIT_WINDOW_SECONDS):
                await ws.send_text(json.dumps({"type":"error","message":"메시지를 너무 빠르게 보내고 있습니다."},ensure_ascii=False))
                await ws.close(code=1008); break
            try: data=json.loads(raw)
            except json.JSONDecodeError: continue
            if not isinstance(data,dict): continue

            msg_type = data.get("type")

            # --- Multi-Channel & DM Screen Sharing Handlers ---
            if msg_type == "screenshare_start":
                raw_chan_id = data.get("channel_id")
                chan_id = normalize_room_id(raw_chan_id)
                title = str(data.get("title", "")).strip()[:100]
                session = await screenshare_manager.start_session(
                    info.user_id, info.username, user.get("display_name") or info.username, chan_id, title
                )
                await notify_screenshare_event(chan_id, {
                    "type": "screenshare_started",
                    "channel_id": chan_id,
                    **session,
                    "viewer_count": 1,
                })
                continue

            if msg_type == "screenshare_stop":
                raw_chan_id = data.get("channel_id")
                chan_id = normalize_room_id(raw_chan_id) if raw_chan_id else None
                stopped_list = await screenshare_manager.stop_session(channel_id=chan_id, user_id=info.user_id)
                for s in stopped_list:
                    await notify_screenshare_event(s["channel_id"], {
                        "type": "screenshare_stopped",
                        "channel_id": s["channel_id"],
                        "user_id": s["user_id"],
                    })
                continue

            if msg_type == "screenshare_status":
                raw_chan_id = data.get("channel_id")
                if raw_chan_id:
                    cid = normalize_room_id(raw_chan_id)
                    status = await screenshare_manager.get_channel_status(cid)
                else:
                    status = {"sessions": await screenshare_manager.get_all_sessions(for_username=info.username)}
                await ws.send_text(json.dumps({"type": "screenshare_status", **status}, ensure_ascii=False))
                continue

            if msg_type == "screenshare_join":
                raw_chan_id = data.get("channel_id")
                chan_id = normalize_room_id(raw_chan_id)
                count = await screenshare_manager.add_viewer(chan_id, info.user_id)
                status = await screenshare_manager.get_channel_status(chan_id)
                if status["is_active"] and status["session"]:
                    presenter_id = status["session"]["user_id"]
                    if presenter_id != info.user_id:
                        await send_to_user_id(presenter_id, {
                            "type": "screenshare_viewer_joined",
                            "channel_id": chan_id,
                            "viewer_user_id": info.user_id,
                            "viewer_username": info.username,
                            "viewer_display_name": user.get("display_name") or info.username,
                        })
                    await notify_screenshare_event(chan_id, {
                        "type": "screenshare_viewers_update",
                        "channel_id": chan_id,
                        "viewer_count": count,
                    })
                continue

            if msg_type == "screenshare_leave":
                raw_chan_id = data.get("channel_id")
                chan_id = normalize_room_id(raw_chan_id)
                count = await screenshare_manager.remove_viewer(chan_id, info.user_id)
                status = await screenshare_manager.get_channel_status(chan_id)
                if status["is_active"] and status["session"]:
                    presenter_id = status["session"]["user_id"]
                    if presenter_id != info.user_id:
                        await send_to_user_id(presenter_id, {
                            "type": "screenshare_viewer_left",
                            "channel_id": chan_id,
                            "viewer_user_id": info.user_id,
                        })
                    await notify_screenshare_event(chan_id, {
                        "type": "screenshare_viewers_update",
                        "channel_id": chan_id,
                        "viewer_count": count,
                    })
                continue

            if msg_type == "screenshare_signal":
                target_user_id = data.get("target_user_id")
                raw_chan_id = data.get("channel_id")
                signal = data.get("signal")
                if target_user_id and signal is not None:
                    try:
                        target_id = int(target_user_id)
                        chan_id = normalize_room_id(raw_chan_id)
                        await send_to_user_id(target_id, {
                            "type": "screenshare_signal",
                            "channel_id": chan_id,
                            "from_user_id": info.user_id,
                            "signal": signal,
                        })
                    except (ValueError, TypeError):
                        pass
                continue

            content=str(data.get("content","")).strip()
            values=data.get("attachment_ids",[])
            if not isinstance(values,list): values=[data.get("attachment_id","")]
            attachment_ids=[]
            for value in values:
                item=str(value).strip()
                if item and item not in attachment_ids: attachment_ids.append(item)
            if len(attachment_ids)>MAX_ATTACHMENTS_PER_MESSAGE:
                await ws.send_text(json.dumps({"type":"error","message":f"파일은 최대 {MAX_ATTACHMENTS_PER_MESSAGE}개까지 첨부할 수 있습니다."},ensure_ascii=False)); continue
            if not content and not attachment_ids: continue
            if len(content)>MAX_CONTENT_LEN:
                await ws.send_text(json.dumps({"type":"error","message":f"메시지는 {MAX_CONTENT_LEN}자 이하여야 합니다."},ensure_ascii=False)); continue
            if msg_type not in {"chat", "dm"}:
                continue
            target_user=None; targets=[]
            if msg_type=="dm":
                target_user=get_user_by_username(str(data.get("to","")).strip())
                if not target_user or not target_user["active"] or target_user["id"]==info.user_id:
                    await ws.send_text(json.dumps({"type":"error","message":"DM 대상을 찾을 수 없습니다."},ensure_ascii=False)); continue
                targets=list(user_registry.get(target_user["username"],set()))
            attachments=claim_attachments(attachment_ids,info.user_id)
            if attachments is None:
                await ws.send_text(json.dumps({"type":"error","message":"첨부 파일을 사용할 수 없거나 이미 전송했습니다."},ensure_ascii=False)); continue
            reply=clean_reply(data.get("reply"))
            if msg_type=="chat":
                raw_channel_id = data.get("channel_id", 1)
                try:
                    channel_id = int(raw_channel_id)
                except (ValueError, TypeError):
                    channel_id = 1
                chan = get_channel_by_id(channel_id)
                if not chan:
                    await ws.send_text(json.dumps({"type":"error","message":"채널을 찾을 수 없습니다."},ensure_ascii=False))
                    continue
                if chan.get("archived"):
                    await ws.send_text(json.dumps({"type":"error","message":"보관된 채널에는 메시지를 작성할 수 없습니다."},ensure_ascii=False))
                    continue
                saved=save_message(info.username,content,ip=ip,reply=reply,
                    attachment_ids=[a["id"] for a in attachments],user_id=info.user_id,
                    channel_id=channel_id)
                saved.pop("ip",None)
                saved=with_mentions(saved)
                await broadcast({"type":"chat",**saved})
            elif msg_type=="dm":
                dm_res = save_direct_message(
                    user,target_user,content,reply=reply,
                    attachment_ids=[a["id"] for a in attachments])
                dm_res["quiz_badge"] = get_user_quiz_badge(info.user_id)
                payload={"type":"dm",**dm_res}
                encoded=json.dumps(payload,ensure_ascii=False)
                sender_targets=list(user_registry.get(info.username,set()))
                for target_ws in set(targets+sender_targets):
                    try: await target_ws.send_text(encoded)
                    except Exception: pass
                await send_to_user_id(target_user["id"], {
                    "type": "read_state_updated",
                    "unread_counts": get_user_unread_counts(target_user["id"]),
                })
    except WebSocketDisconnect:
        pass
    finally:
        _remove_client(ws)
        user_has_other_sockets = any(c.user_id == info.user_id for c in connected_clients.values())
        if not user_has_other_sockets:
            stopped_list = await screenshare_manager.stop_session(user_id=info.user_id)
            for s in stopped_list:
                await notify_screenshare_event(s["channel_id"], {
                    "type": "screenshare_stopped",
                    "channel_id": s["channel_id"],
                    "user_id": s["user_id"],
                })
            affected = await screenshare_manager.remove_viewer_from_all(info.user_id)
            for cid, count in affected.items():
                await notify_screenshare_event(cid, {
                    "type": "screenshare_viewers_update",
                    "channel_id": cid,
                    "viewer_count": count,
                })
        await broadcast_presence(); await broadcast_users()
        logger.info("Disconnected user=%s ip=%s",info.user_id,ip)

@app.websocket("/ws/chess")
async def chess_websocket_endpoint(ws: WebSocket):
    ip = get_client_ip(ws)
    if not websocket_origin_is_allowed(ws):
        await ws.close(code=1008, reason="허용되지 않은 WebSocket origin입니다.")
        return
    user = session_user_from_token(ws.cookies.get(SESSION_COOKIE, ""))
    if not user:
        await ws.close(code=1008, reason="로그인이 필요합니다.")
        return
    await ws.accept()
    chess_manager.register_client(ws, user)
    chess_manager.start_clock_monitor()
    await ws.send_text(json.dumps({"type": "lobby_update", "rooms": chess_manager.get_lobby_summary()}, ensure_ascii=False))

    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > MAX_RAW_MESSAGE_LEN:
                await ws.close(code=1009, reason="메시지 프레임이 너무 큽니다.")
                break
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(data, dict):
                continue

            action = data.get("action")
            room_id = data.get("room_id")

            if action == "list_rooms":
                await ws.send_text(json.dumps({"type": "lobby_update", "rooms": chess_manager.get_lobby_summary()}, ensure_ascii=False))
            elif action == "create_room":
                await chess_manager.create_room(ws, user, data.get("title", ""), data.get("time_minutes", 10))
            elif action == "join_room" and room_id:
                await chess_manager.join_room(ws, user, room_id, data.get("role_pref"))
            elif action == "leave_room" and room_id:
                await chess_manager.leave_room(ws, user, room_id)
            elif action == "pick_role" and room_id:
                await chess_manager.pick_role(user, room_id, data.get("role", "spectator"))
            elif action == "toggle_ready" and room_id:
                await chess_manager.toggle_ready(user, room_id)
            elif action == "start_game" and room_id:
                await chess_manager.start_game(user, room_id)
            elif action == "move" and room_id:
                await chess_manager.make_move(user, room_id, data)
            elif action == "timeout" and room_id:
                await chess_manager.claim_timeout(user, room_id)
            elif action == "offer_draw" and room_id:
                await chess_manager.offer_draw(user, room_id)
            elif action == "respond_draw" and room_id:
                await chess_manager.respond_draw(user, room_id, bool(data.get("accept")))
            elif action == "resign" and room_id:
                await chess_manager.resign(user, room_id)
            elif action == "join_queue" and room_id:
                await chess_manager.join_match_queue(user, room_id)
            elif action == "chat" and room_id:
                text = str(data.get("text", "")).strip()
                if text:
                    await chess_manager.send_room_chat(user, room_id, text)
            elif action == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        pass
    finally:
        await chess_manager.unregister_client(ws)


@app.websocket("/ws/janggi")
async def janggi_websocket_endpoint(ws: WebSocket):
    ip = get_client_ip(ws)
    if not websocket_origin_is_allowed(ws):
        await ws.close(code=1008, reason="허용되지 않은 WebSocket origin입니다.")
        return
    user = session_user_from_token(ws.cookies.get(SESSION_COOKIE, ""))
    if not user:
        await ws.close(code=1008, reason="로그인이 필요합니다.")
        return
    await ws.accept()
    janggi_manager.register_client(ws, user)
    janggi_manager.start_clock_monitor()
    await ws.send_text(json.dumps({"type": "lobby_update", "rooms": janggi_manager.get_lobby_summary()}, ensure_ascii=False))

    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > MAX_RAW_MESSAGE_LEN:
                await ws.close(code=1009, reason="메시지 프레임이 너무 큽니다.")
                break
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(data, dict):
                continue

            action = data.get("action")
            room_id = data.get("room_id")

            if action == "list_rooms":
                await ws.send_text(json.dumps({"type": "lobby_update", "rooms": janggi_manager.get_lobby_summary()}, ensure_ascii=False))
            elif action == "create_room":
                await janggi_manager.create_room(ws, user, data.get("title", ""), data.get("time_minutes", 10))
            elif action == "join_room" and room_id:
                await janggi_manager.join_room(ws, user, room_id, data.get("role_pref"))
            elif action == "leave_room" and room_id:
                await janggi_manager.leave_room(ws, user, room_id)
            elif action == "pick_role" and room_id:
                await janggi_manager.pick_role(user, room_id, data.get("role", "spectator"))
            elif action == "set_formation" and room_id:
                await janggi_manager.set_formation(user, room_id, str(data.get("formation", "wonangma")))
            elif action == "toggle_ready" and room_id:
                await janggi_manager.toggle_ready(user, room_id)
            elif action == "start_game" and room_id:
                await janggi_manager.start_game(user, room_id)
            elif action == "move" and room_id:
                await janggi_manager.make_move(user, room_id, data)
            elif action == "pass_turn" and room_id:
                await janggi_manager.pass_turn(user, room_id)
            elif action == "request_score_judge" and room_id:
                await janggi_manager.request_score_judge(user, room_id)
            elif action == "resign" and room_id:
                await janggi_manager.resign(user, room_id)
            elif action == "chat" and room_id:
                text = str(data.get("text", "")).strip()
                if text:
                    await janggi_manager.send_room_chat(user, room_id, text)
            elif action == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        pass
    finally:
        await janggi_manager.unregister_client(ws)


@app.websocket("/ws/omok")
async def omok_websocket_endpoint(ws: WebSocket):
    ip = get_client_ip(ws)
    if not websocket_origin_is_allowed(ws):
        await ws.close(code=1008, reason="허용되지 않은 WebSocket origin입니다.")
        return
    user = session_user_from_token(ws.cookies.get(SESSION_COOKIE, ""))
    if not user:
        await ws.close(code=1008, reason="로그인이 필요합니다.")
        return
    await ws.accept()
    omok_manager.register_client(ws, user)
    omok_manager.start_clock_monitor()
    await ws.send_text(json.dumps({"type": "lobby_update", "rooms": omok_manager.get_lobby_summary()}, ensure_ascii=False))

    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > MAX_RAW_MESSAGE_LEN:
                await ws.close(code=1009, reason="메시지 프레임이 너무 큽니다.")
                break
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(data, dict):
                continue

            action = data.get("action")
            room_id = data.get("room_id")

            if action == "list_rooms":
                await ws.send_text(json.dumps({"type": "lobby_update", "rooms": omok_manager.get_lobby_summary()}, ensure_ascii=False))
            elif action == "create_room":
                await omok_manager.create_room(ws, user, data.get("title", ""), data.get("time_minutes", 10))
            elif action == "join_room" and room_id:
                await omok_manager.join_room(ws, user, room_id, data.get("role_pref"))
            elif action == "leave_room" and room_id:
                await omok_manager.leave_room(ws, user, room_id)
            elif action == "pick_role" and room_id:
                await omok_manager.pick_role(user, room_id, data.get("role", "spectator"))
            elif action == "toggle_ready" and room_id:
                await omok_manager.toggle_ready(user, room_id)
            elif action == "start_game" and room_id:
                await omok_manager.start_game(user, room_id)
            elif action == "move" and room_id:
                await omok_manager.make_move(user, room_id, data)
            elif action == "resign" and room_id:
                await omok_manager.resign(user, room_id)
            elif action == "chat" and room_id:
                text = str(data.get("text", "")).strip()
                if text:
                    await omok_manager.send_room_chat(user, room_id, text)
            elif action == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        pass
    finally:
        await omok_manager.unregister_client(ws)


@app.websocket("/ws/othello")
async def othello_websocket_endpoint(ws: WebSocket):
    ip = get_client_ip(ws)
    if not websocket_origin_is_allowed(ws):
        await ws.close(code=1008, reason="허용되지 않은 WebSocket origin입니다.")
        return
    user = session_user_from_token(ws.cookies.get(SESSION_COOKIE, ""))
    if not user:
        await ws.close(code=1008, reason="로그인이 필요합니다.")
        return
    await ws.accept()
    othello_manager.register_client(ws, user)
    othello_manager.start_clock_monitor()
    await ws.send_text(json.dumps({"type": "lobby_update", "rooms": othello_manager.get_lobby_summary()}, ensure_ascii=False))

    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > MAX_RAW_MESSAGE_LEN:
                await ws.close(code=1009, reason="메시지 프레임이 너무 큽니다.")
                break
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(data, dict):
                continue

            action = data.get("action")
            room_id = data.get("room_id")

            if action == "list_rooms":
                await ws.send_text(json.dumps({"type": "lobby_update", "rooms": othello_manager.get_lobby_summary()}, ensure_ascii=False))
            elif action == "create_room":
                await othello_manager.create_room(ws, user, data.get("title", ""), data.get("time_minutes", 10))
            elif action == "join_room" and room_id:
                await othello_manager.join_room(ws, user, room_id, data.get("role_pref"))
            elif action == "leave_room" and room_id:
                await othello_manager.leave_room(ws, user, room_id)
            elif action == "pick_role" and room_id:
                await othello_manager.pick_role(user, room_id, data.get("role", "spectator"))
            elif action == "toggle_ready" and room_id:
                await othello_manager.toggle_ready(user, room_id)
            elif action == "start_game" and room_id:
                await othello_manager.start_game(user, room_id)
            elif action == "move" and room_id:
                await othello_manager.make_move(user, room_id, data)
            elif action == "pass_turn" and room_id:
                await othello_manager.pass_turn(user, room_id)
            elif action == "resign" and room_id:
                await othello_manager.resign(user, room_id)
            elif action == "chat" and room_id:
                text = str(data.get("text", "")).strip()
                if text:
                    await othello_manager.send_room_chat(user, room_id, text)
            elif action == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        pass
    finally:
        await othello_manager.unregister_client(ws)



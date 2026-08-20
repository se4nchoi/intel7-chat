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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Deque, Dict, Optional, Set
from urllib.parse import unquote, urlsplit

from fastapi import FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.auth import (hash_secret, new_session_token, normalize_username, secret_needs_rehash,
                        token_hash, validate_display_name, validate_password,
                        validate_username, verify_secret)
from app.config import load_config, save_config
from app.database import (attachment_is_visible_to_user, claim_attachments, configure_storage, count_active_admins,
    create_session, create_user, delete_owned_attachment, delete_session,
    delete_user_sessions, get_attachment_record, get_direct_messages_between,
    get_recent_direct_messages, get_recent_messages, get_session_user,
    get_storage_status, get_upload_usage, get_user_by_id, get_user_by_username, init_db,
    list_mentionable_users, list_users, prune_expired_sessions, save_attachment,
    save_direct_message, save_message, set_user_active,
    set_user_role, update_display_name, update_password_hash)

CONFIG = load_config()
configure_storage(CONFIG.data_path, CONFIG.database_limit_bytes)
SERVICE_NAME = CONFIG.server_name
MAX_CONTENT_LEN = 2000
MAX_ATTACHMENTS_PER_MESSAGE = 5
MAX_REPLY_CONTENT_LEN = 180
MAX_RAW_MESSAGE_LEN = 8192
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
    return result

def account_public(user: dict) -> dict:
    return {"id": user["id"], "username": user["username"],
            "display_name": user.get("display_name") or user["username"],
            "role": user["role"],
            "active": bool(user["active"]), "created_at": user["created_at"],
            "last_login": user.get("last_login"), "message_count": user.get("message_count", 0),
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
    mention_list = [
        {**user, "online": user["id"] in online_user_ids}
        for user in list_mentionable_users()
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
        "form-action 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self' ws: wss:")
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

@app.post("/api/auth/register")
async def register(request: Request):
    if not request_origin_is_allowed(request): raise HTTPException(403,"허용되지 않은 요청입니다.")
    if not CONFIG.registration_enabled or not CONFIG.enrollment_code_hash:
        raise HTTPException(403,"현재 신규 가입이 닫혀 있습니다.")
    ip=get_client_ip(request)
    if not sliding_window_allowed(login_timestamps,f"register:{ip}",LOGIN_RATE_LIMIT,LOGIN_RATE_WINDOW_SECONDS):
        raise HTTPException(429,"요청이 너무 많습니다. 잠시 후 다시 시도하세요.")
    data=await read_json_body(request)
    try:
        username=validate_username(str(data.get("username","")))
        password=str(data.get("password",""))
        validate_password(password)
    except ValueError as exc:
        raise HTTPException(400,str(exc)) from exc
    enrollment=str(data.get("enrollment_code",""))
    if not await asyncio.to_thread(verify_secret,CONFIG.enrollment_code_hash,enrollment):
        raise HTTPException(403,"가입 코드가 올바르지 않습니다.")
    password_hash=await asyncio.to_thread(hash_secret,password)
    try:
        user=create_user(username,password_hash)
    except sqlite3.IntegrityError as exc:
        raise HTTPException(409,"이미 사용 중인 아이디입니다.") from exc
    raw=new_session_token()
    expiry=(datetime.now(timezone.utc)+timedelta(hours=CONFIG.session_hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    create_session(token_hash(raw),user["id"],expiry)
    user=get_session_user(token_hash(raw))
    response=JSONResponse(public_user(user),status_code=201)
    set_session_cookie(response,raw,request)
    return response

@app.post("/api/auth/login")
async def login(request: Request):
    if not request_origin_is_allowed(request): raise HTTPException(403,"허용되지 않은 요청입니다.")
    data=await read_json_body(request)
    username=str(data.get("username",""))
    password=str(data.get("password",""))
    ip=get_client_ip(request)
    key=f"{ip}:{normalize_username(username)[:50]}"
    if not sliding_window_allowed(login_timestamps,key,LOGIN_RATE_LIMIT,LOGIN_RATE_WINDOW_SECONDS):
        raise HTTPException(429,"로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.")
    user=get_user_by_username(username)
    candidate_hash = user["password_hash"] if user else DUMMY_LOGIN_HASH
    password_ok = await asyncio.to_thread(verify_secret, candidate_hash, password)
    if user and password_ok and not user["active"]:
        raise HTTPException(401, "이 아이디는 비활성화되어 있습니다. 관리자에게 문의하세요.")
    valid=bool(user and user["active"] and password_ok)
    if not valid:
        raise HTTPException(401,"아이디 또는 비밀번호가 올바르지 않습니다.")
    if secret_needs_rehash(user["password_hash"]):
        update_password_hash(user["id"],await asyncio.to_thread(hash_secret,password))
    raw=new_session_token()
    expiry=(datetime.now(timezone.utc)+timedelta(hours=CONFIG.session_hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    create_session(token_hash(raw),user["id"],expiry)
    user=get_session_user(token_hash(raw))
    response=JSONResponse(public_user(user))
    set_session_cookie(response,raw,request)
    return response

@app.post("/api/auth/logout",status_code=204)
async def logout(request: Request):
    if not request_origin_is_allowed(request): raise HTTPException(403,"허용되지 않은 요청입니다.")
    raw=request.cookies.get(SESSION_COOKIE,"")
    if raw: delete_session(token_hash(raw))
    response=Response(status_code=204)
    response.delete_cookie(SESSION_COOKIE,path="/",samesite="strict")
    return response

@app.get("/api/auth/me")
async def auth_me(request: Request):
    return public_user(request_user(request))

@app.post("/api/auth/display-name")
async def change_display_name(request: Request):
    if not request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = request_user(request)
    data = await read_json_body(request)
    raw_name = str(data.get("display_name", ""))
    try:
        display_name = validate_display_name(raw_name)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    updated = update_display_name(user["id"], display_name)
    if not updated:
        raise HTTPException(404, "사용자를 찾을 수 없습니다.")
    await broadcast_users()
    return public_user(updated)

@app.get("/api/messages")
async def api_messages(request: Request):
    request_user(request)
    users = list_mentionable_users()
    return [with_mentions(message, users) for message in get_recent_messages()]

@app.get("/api/history/public")
async def public_message_history(request: Request, before_id: Optional[int] = None):
    request_user(request)
    messages = get_recent_messages(PUBLIC_HISTORY_PAGE_SIZE + 1, before_id)
    has_more = len(messages) > PUBLIC_HISTORY_PAGE_SIZE
    messages = messages[-PUBLIC_HISTORY_PAGE_SIZE:]
    users = list_mentionable_users()
    return {"messages": [with_mentions(message, users) for message in messages],
            "has_more": has_more}

@app.get("/api/history/dm/{partner_username}")
async def direct_message_history(partner_username: str, request: Request,
                                 before_id: Optional[int] = None):
    user = request_user(request)
    partner = get_user_by_username(partner_username)
    if not partner or partner["id"] == user["id"]:
        raise HTTPException(404, "대화 상대를 찾을 수 없습니다.")
    messages = get_direct_messages_between(
        user["id"], partner["id"], PUBLIC_HISTORY_PAGE_SIZE + 1, before_id
    )
    has_more = len(messages) > PUBLIC_HISTORY_PAGE_SIZE
    return {"messages": messages[-PUBLIC_HISTORY_PAGE_SIZE:], "has_more": has_more}

@app.get("/api/storage")
async def storage_status(request: Request):
    user=request_user(request)
    status=get_storage_status()
    mine,_=get_upload_usage(user["id"])
    status.update({"attachment_limit_bytes":MAX_TOTAL_UPLOAD_BYTES,
        "user_attachment_bytes":mine,"user_attachment_limit_bytes":MAX_UPLOAD_BYTES_PER_USER})
    ratios = [
        status["database_bytes"] / max(1, status["database_limit_bytes"]),
        status["attachment_bytes"] / max(1, status["attachment_limit_bytes"]),
        status["user_attachment_bytes"] / max(1, status["user_attachment_limit_bytes"]),
    ]
    usage = max(ratios)
    status["warning_level"] = 95 if usage >= .95 else 85 if usage >= .85 else 70 if usage >= .70 else 0
    return status

@app.get("/api/admin/overview")
async def admin_overview(request: Request):
    require_admin(request)
    status = get_storage_status()
    status["attachment_limit_bytes"] = MAX_TOTAL_UPLOAD_BYTES
    status["database_limit_bytes"] = CONFIG.database_limit_bytes
    return {
        "registration_enabled": CONFIG.registration_enabled,
        "storage": status,
        "users": [account_public(user) for user in list_users()],
    }

@app.post("/api/admin/registration")
async def admin_registration(request: Request):
    require_admin(request)
    if not request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    data = await read_json_body(request)
    if not isinstance(data.get("enabled"), bool):
        raise HTTPException(400, "enabled 값은 true 또는 false여야 합니다.")
    CONFIG.registration_enabled = data["enabled"]
    save_config(CONFIG)
    return {"registration_enabled": CONFIG.registration_enabled}

@app.post("/api/admin/enrollment-code", status_code=204)
async def admin_enrollment_code(request: Request):
    require_admin(request)
    if not request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    data = await read_json_body(request)
    code = str(data.get("enrollment_code", ""))
    try:
        validate_password(code)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    CONFIG.enrollment_code_hash = await asyncio.to_thread(hash_secret, code)
    save_config(CONFIG)
    return Response(status_code=204)

@app.post("/api/admin/users/{user_id}")
async def admin_update_user(user_id: int, request: Request):
    admin = require_admin(request)
    if not request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    data = await read_json_body(request)
    target = get_user_by_id(user_id)
    if not target:
        raise HTTPException(404, "사용자를 찾을 수 없습니다.")

    requested_role = data.get("role", target["role"])
    requested_active = data.get("active", bool(target["active"]))
    new_password = data.get("new_password")
    if requested_role not in {"student", "admin"}:
        raise HTTPException(400, "올바른 역할이 아닙니다.")
    if not isinstance(requested_active, bool):
        raise HTTPException(400, "active 값은 true 또는 false여야 합니다.")
    if user_id == admin["id"] and (
        requested_role != target["role"] or requested_active != bool(target["active"])
    ):
        raise HTTPException(400, "현재 로그인한 관리자 자신의 역할이나 상태는 변경할 수 없습니다.")
    removes_active_admin = (
        target["role"] == "admin" and bool(target["active"])
        and (requested_role != "admin" or not requested_active)
    )
    if removes_active_admin and count_active_admins() <= 1:
        raise HTTPException(400, "마지막 활성 관리자는 비활성화하거나 강등할 수 없습니다.")

    password_changed = new_password is not None and str(new_password) != ""
    if password_changed:
        try:
            validate_password(str(new_password))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    if requested_role != target["role"]:
        set_user_role(user_id, requested_role)
    if requested_active != bool(target["active"]):
        set_user_active(user_id, requested_active)
    if password_changed:
        update_password_hash(user_id, await asyncio.to_thread(hash_secret, str(new_password)))
        delete_user_sessions(user_id)

    new_display_name = data.get("display_name")
    if new_display_name is not None and str(new_display_name).strip():
        try:
            validated_name = validate_display_name(str(new_display_name))
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        update_display_name(user_id, validated_name)

    if not requested_active or password_changed:
        await disconnect_user(user_id, "계정 설정이 변경되었습니다. 다시 로그인해 주세요.")
    if requested_active != bool(target["active"]):
        await broadcast_users()
    updated = get_user_by_id(user_id)
    return account_public(updated)

@app.post("/api/files",status_code=201)
async def upload_file(request: Request,x_file_name: str=Header("",alias="X-File-Name")):
    if not request_origin_is_allowed(request): raise HTTPException(403,"허용되지 않은 요청입니다.")
    user=request_user(request)
    ip=get_client_ip(request)
    if not sliding_window_allowed(upload_timestamps,str(user["id"]),UPLOAD_RATE_LIMIT,UPLOAD_RATE_WINDOW_SECONDS):
        raise HTTPException(429,"업로드가 너무 빠릅니다.")
    name=clean_original_filename(x_file_name)
    if upload_is_blocked(name): raise HTTPException(415,"실행 파일 또는 활성 웹 파일은 공유할 수 없습니다.")
    length=request.headers.get("content-length","")
    if length.isdigit() and int(length)>MAX_UPLOAD_BYTES: raise HTTPException(413,"파일 크기 제한을 초과했습니다.")
    async with upload_lock:
        mine,total=get_upload_usage(user["id"])
        if mine>=MAX_UPLOAD_BYTES_PER_USER: raise HTTPException(413,"개인 파일 보관 한도를 초과했습니다.")
        if total>=MAX_TOTAL_UPLOAD_BYTES: raise HTTPException(507,"서버 파일 보관 공간이 가득 찼습니다.")
        attachment_id=uuid.uuid4().hex
        stored_name=f"{attachment_id}.upload"
        destination=attachment_path(stored_name)
        digest=hashlib.sha256(); size=0; header=bytearray()
        try:
            with destination.open("xb") as output:
                async for chunk in request.stream():
                    if not chunk: continue
                    size+=len(chunk)
                    if size>MAX_UPLOAD_BYTES: raise HTTPException(413,"파일 크기 제한을 초과했습니다.")
                    if len(header)<16: header.extend(chunk[:16-len(header)])
                    digest.update(chunk); output.write(chunk)
            if not size: raise HTTPException(400,"빈 파일은 공유할 수 없습니다.")
            if mine+size>MAX_UPLOAD_BYTES_PER_USER: raise HTTPException(413,"개인 파일 보관 한도를 초과했습니다.")
            if total+size>MAX_TOTAL_UPLOAD_BYTES: raise HTTPException(507,"서버 파일 보관 공간이 가득 찼습니다.")
            preview=detect_preview_type(bytes(header))
            attachment=save_attachment({"id":attachment_id,"original_name":name,"stored_name":stored_name,
                "size":size,"sha256":digest.hexdigest(),"content_type":preview or "application/octet-stream",
                "previewable":bool(preview),"uploader_nickname":user["username"],"uploader_user_id":user["id"],"ip":ip})
        except Exception:
            destination.unlink(missing_ok=True)
            raise
    logger.info("Upload id=%s user=%s ip=%s size=%s",attachment_id,user["id"],ip,size)
    return attachment

@app.delete("/api/files/{attachment_id}",status_code=204)
async def discard_file(attachment_id: str,request: Request):
    if not request_origin_is_allowed(request): raise HTTPException(403,"허용되지 않은 요청입니다.")
    user=request_user(request)
    deleted=delete_owned_attachment(attachment_id,user["id"],user["role"]=="admin")
    if not deleted: raise HTTPException(404,"삭제할 수 있는 파일이 없습니다.")
    remove_stored_file(deleted["stored_name"])
    await broadcast({"type":"attachment_deleted","attachment_id":attachment_id})

@app.get("/api/files/{attachment_id}")
async def download_file(attachment_id: str,request: Request):
    user=request_user(request)
    record=get_attachment_record(attachment_id)
    if not record: raise HTTPException(404,"파일을 찾을 수 없습니다.")
    if not attachment_is_visible_to_user(attachment_id,user["id"]):
        raise HTTPException(404,"파일을 찾을 수 없습니다.")
    path=attachment_path(record["stored_name"])
    if not path.is_file(): raise HTTPException(404,"파일을 찾을 수 없습니다.")
    preview=bool(record["previewable"])
    return FileResponse(path,media_type=record["content_type"] if preview else "application/octet-stream",
        filename=record["original_name"],content_disposition_type="inline" if preview else "attachment",
        headers={"Cache-Control":"private, no-store"})

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
    await ws.send_text(json.dumps({
        "type":"history_ready",
        "public_has_older":len(public_candidates) > PUBLIC_HISTORY_PAGE_SIZE,
        "dm_has_older":{partner: len(messages) > DM_HISTORY_PAGE_SIZE
                        for partner, messages in dm_groups.items()},
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
            msg_type = data.get("type")
            if msg_type not in {"chat", "dm"}:
                continue
            target_user=None; targets=[]
            if msg_type=="dm":
                target_user=get_user_by_username(str(data.get("to","")).strip())
                if not target_user or not target_user["active"] or target_user["id"]==info.user_id:
                    await ws.send_text(json.dumps({"type":"error","message":"DM 대상을 찾을 수 없습니다."},ensure_ascii=False)); continue
                targets=list(user_registry.get(target_user["username"],set()))
                if not targets:
                    await ws.send_text(json.dumps({"type":"error","message":f"'{target_user['username']}'님이 오프라인 상태입니다."},ensure_ascii=False)); continue
            attachments=claim_attachments(attachment_ids,info.user_id)
            if attachments is None:
                await ws.send_text(json.dumps({"type":"error","message":"첨부 파일을 사용할 수 없거나 이미 전송했습니다."},ensure_ascii=False)); continue
            reply=clean_reply(data.get("reply"))
            if msg_type=="chat":
                saved=save_message(info.username,content,ip=ip,reply=reply,
                    attachment_ids=[a["id"] for a in attachments],user_id=info.user_id)
                saved.pop("ip",None)
                saved=with_mentions(saved)
                await broadcast({"type":"chat",**saved})
            elif msg_type=="dm":
                payload={"type":"dm",**save_direct_message(
                    user,target_user,content,reply=reply,
                    attachment_ids=[a["id"] for a in attachments])}
                encoded=json.dumps(payload,ensure_ascii=False)
                sender_targets=list(user_registry.get(info.username,set()))
                for target_ws in set(targets+sender_targets):
                    try: await target_ws.send_text(encoded)
                    except Exception: pass
    except WebSocketDisconnect:
        pass
    finally:
        _remove_client(ws)
        await broadcast_presence(); await broadcast_users()
        logger.info("Disconnected user=%s ip=%s",info.user_id,ip)

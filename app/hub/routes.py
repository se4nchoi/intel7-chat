"""HTTPS and WSS entry points for 마디 (Madi), the PostgreSQL-backed hub."""
from __future__ import annotations

import asyncio
import re
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
from fastapi import APIRouter, File, HTTPException, Query, Request, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, Field
from psycopg.errors import UniqueViolation

from app.auth import normalize_username, validate_password, validate_username
from app.hub import db
from app.hub.logs import log
from app.hub.settings import settings

router = APIRouter(prefix="/hub", tags=["madi"])
COOKIE = "madi_session"
FRONTEND_BUILD_DIR = Path(__file__).resolve().parents[2] / "frontend" / "dist"
ALLOWED_FILE_SUFFIXES = {".txt", ".md", ".pdf", ".csv", ".png", ".jpg", ".jpeg", ".docx", ".pptx", ".xlsx"}
# Open chat sockets per (cohort, channel), mapped to the session cookie that
# opened them. Access is re-checked before every delivery, so a revoked or
# expired session, or a removed membership, stops receiving immediately.
connections: dict[tuple[int, int], dict[WebSocket, str]] = defaultdict(dict)
REVOKED = 1008
# Failed and successful login attempts per (client IP, username), same limit
# as the legacy app. Behind a reverse proxy the IP is the proxy's until
# forwarded headers are trusted.
LOGIN_LIMIT = 12
LOGIN_WINDOW_SECONDS = 300
login_attempts: dict[str, deque[float]] = {}


def _login_allowed(key: str, now: float | None = None) -> bool:
    now = time.monotonic() if now is None else now
    attempts = login_attempts.setdefault(key, deque())
    while attempts and attempts[0] <= now - LOGIN_WINDOW_SECONDS:
        attempts.popleft()
    if len(attempts) >= LOGIN_LIMIT:
        return False
    attempts.append(now)
    # Forget stale keys so the table doesn't grow with every username tried.
    for stale in [k for k, v in login_attempts.items() if v and v[-1] <= now - LOGIN_WINDOW_SECONDS]:
        del login_attempts[stale]
    return True


def _same_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin and origin != str(request.base_url).rstrip("/"):
        raise HTTPException(403, "Invalid origin")


def _ip(conn: Request | WebSocket) -> str:
    return conn.client.host if conn.client else "-"


async def _account(request: Request) -> dict:
    account = await asyncio.to_thread(db.session_account, request.cookies.get(COOKIE, ""))
    if not account:
        raise HTTPException(401, "Log in to the prototype hub")
    return account


async def _cohort(request: Request, cohort_id: int, *, manage: bool = False):
    account = await _account(request)
    cohort = await asyncio.to_thread(db.access, account, cohort_id)
    if not cohort:
        log.warning("access denied user=%r id=%s cohort=%s path=%s ip=%s",
                    account["username"], account["id"], cohort_id, request.url.path, _ip(request))
        raise HTTPException(403, "No access to this cohort")
    if manage and cohort["role"] not in {"admin", "instructor"}:
        log.warning("manage denied user=%r id=%s cohort=%s path=%s ip=%s",
                    account["username"], account["id"], cohort_id, request.url.path, _ip(request))
        raise HTTPException(403, "Instructor access required")
    if cohort["archived"] and request.method not in {"GET", "HEAD"}:
        raise HTTPException(403, "This cohort is archived")
    return account, cohort


class Login(BaseModel):
    username: str
    password: str


class Message(BaseModel):
    body: str = Field(min_length=1, max_length=2000)


class Question(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=5000)


class Answer(BaseModel):
    body: str = Field(min_length=1, max_length=5000)


class Endorsement(BaseModel):
    endorsed: bool


class NewCohort(BaseModel):
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{2,39}$")
    name: str = Field(min_length=2, max_length=100)


class NewAccount(BaseModel):
    username: str
    display_name: str = Field(min_length=1, max_length=100)
    password: str


class Membership(BaseModel):
    username: str
    role: str = Field(pattern=r"^(instructor|student)$")


class AccountUpdate(BaseModel):
    active: bool


class PasswordChange(BaseModel):
    current_password: str
    new_password: str


class CohortUpdate(BaseModel):
    archived: bool


class NewChannel(BaseModel):
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,39}$")
    name: str = Field(min_length=2, max_length=100)


@router.get("")
@router.get("/cohorts/{slug}/chat")
@router.get("/cohorts/{slug}/board")
async def hub_page():
    page = FRONTEND_BUILD_DIR / "index.html"
    if not page.is_file():
        raise HTTPException(503, "Hub frontend is not built; run npm ci and npm run build in frontend/")
    return FileResponse(page)


@router.get("/api/health")
async def health():
    def check():
        with db.connect() as conn:
            return conn.execute("SELECT 1 AS ready").fetchone()["ready"] == 1
    try:
        return {"postgresql": await asyncio.to_thread(check), "sfu_configured": settings().sfu_configured}
    except Exception:
        raise HTTPException(503, "PostgreSQL unavailable")


@router.post("/api/login")
async def login(body: Login, request: Request, response: Response):
    _same_origin(request)
    ip = _ip(request)
    if not _login_allowed(f"{ip}:{normalize_username(body.username)[:50]}"):
        log.warning("login throttled user=%r ip=%s", body.username[:50], ip)
        raise HTTPException(429, "Too many login attempts; try again later")
    account = await asyncio.to_thread(db.authenticate, body.username, body.password)
    if not account:
        log.warning("login failed user=%r ip=%s", body.username[:50], ip)
        raise HTTPException(401, "Incorrect username or password")
    raw = await asyncio.to_thread(db.create_session, account["id"])
    log.info("login ok user=%r id=%s admin=%s ip=%s", account["username"], account["id"], account["is_admin"], ip)
    response.set_cookie(COOKIE, raw, max_age=settings().session_hours * 3600, httponly=True, secure=True, samesite="strict", path="/hub")
    return {"id": account["id"], "username": account["username"], "is_admin": account["is_admin"]}


@router.post("/api/logout", status_code=204)
async def logout(request: Request, response: Response):
    _same_origin(request)
    raw = request.cookies.get(COOKIE, "")
    if raw:
        account = await asyncio.to_thread(db.session_account, raw)
        await asyncio.to_thread(db.delete_session, raw)
        closed = await _close_session_sockets(raw)
        if account:
            log.info("logout user=%r id=%s sockets_closed=%s ip=%s",
                     account["username"], account["id"], closed, _ip(request))
    response.delete_cookie(COOKIE, path="/hub")


async def _drop_socket(key: tuple[int, int], ws: WebSocket) -> None:
    connections[key].pop(ws, None)
    try:
        await ws.close(code=REVOKED)
    except Exception:
        pass  # already closed by the client


async def _close_session_sockets(raw: str) -> int:
    closed = 0
    for key, sockets in list(connections.items()):
        for ws, session in list(sockets.items()):
            if session == raw:
                await _drop_socket(key, ws)
                closed += 1
    return closed


def _socket_allowed(raw: str, cohort_id: int) -> bool:
    account = db.session_account(raw)
    return bool(account and db.access(account, cohort_id))


async def _require_admin(request: Request) -> dict:
    account = await _account(request)
    if not account["is_admin"]:
        log.warning("admin denied user=%r id=%s path=%s ip=%s", account["username"], account["id"], request.url.path, _ip(request))
        raise HTTPException(403, "Administrator access required")
    return account


@router.get("/api/me")
async def me(request: Request):
    return await _account(request)


@router.get("/api/cohorts")
async def list_cohorts(request: Request):
    return await asyncio.to_thread(db.cohorts_for, await _account(request))


@router.post("/api/cohorts", status_code=201)
async def create_cohort(body: NewCohort, request: Request):
    _same_origin(request)
    admin = await _require_admin(request)
    try:
        cohort = await asyncio.to_thread(db.create_cohort, body.slug, body.name.strip())
    except UniqueViolation:
        raise HTTPException(409, "Cohort slug already exists")
    log.info("cohort created by=%r cohort=%s slug=%r", admin["username"], cohort["id"], cohort["slug"])
    return cohort


@router.post("/api/accounts", status_code=201)
async def create_account(body: NewAccount, request: Request):
    _same_origin(request)
    admin = await _require_admin(request)
    try:
        username = validate_username(body.username)
        validate_password(body.password)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    try:
        created = await asyncio.to_thread(db.create_account, username, body.display_name.strip(), body.password)
    except UniqueViolation:
        raise HTTPException(409, "Username already exists")
    log.info("account created by=%r account=%s user=%r", admin["username"], created["id"], created["username"])
    return created


@router.post("/api/cohorts/{cohort_id}/memberships", status_code=201)
async def add_membership(cohort_id: int, body: Membership, request: Request):
    _same_origin(request)
    actor, cohort = await _cohort(request, cohort_id, manage=True)
    if body.role == "instructor" and cohort["role"] != "admin":
        log.warning("instructor assignment denied by=%r cohort=%s ip=%s", actor["username"], cohort_id, _ip(request))
        raise HTTPException(403, "Only an administrator can assign instructors")
    record = await asyncio.to_thread(db.add_membership, cohort_id, body.username, body.role)
    if not record:
        raise HTTPException(404, "Account not found")
    log.info("membership set by=%r cohort=%s account=%s role=%s",
             actor["username"], cohort_id, record["account_id"], record["role"])
    return record


@router.get("/api/cohorts/{cohort_id}/members")
async def members(cohort_id: int, request: Request):
    await _cohort(request, cohort_id)
    return await asyncio.to_thread(db.members, cohort_id)


@router.get("/api/cohorts/{cohort_id}/channels")
async def channels(cohort_id: int, request: Request):
    await _cohort(request, cohort_id)
    return await asyncio.to_thread(db.channels, cohort_id)


@router.post("/api/cohorts/{cohort_id}/channels", status_code=201)
async def create_channel(cohort_id: int, body: NewChannel, request: Request):
    _same_origin(request)
    actor, _ = await _cohort(request, cohort_id, manage=True)
    try:
        channel = await asyncio.to_thread(db.create_channel, cohort_id, body.slug, body.name.strip())
    except UniqueViolation:
        raise HTTPException(409, "Channel slug already exists")
    log.info("channel created by=%r cohort=%s channel=%s slug=%r", actor["username"], cohort_id, channel["id"], channel["slug"])
    return channel


@router.get("/api/cohorts/{cohort_id}/channels/{channel_id}/messages")
async def messages(cohort_id: int, channel_id: int, request: Request, after: int | None = Query(None, ge=0)):
    await _cohort(request, cohort_id)
    if not await asyncio.to_thread(db.channel, cohort_id, channel_id):
        raise HTTPException(404, "Channel not found")
    return await asyncio.to_thread(db.messages, channel_id, after)


@router.post("/api/cohorts/{cohort_id}/channels/{channel_id}/media-token")
async def media_token(cohort_id: int, channel_id: int, request: Request):
    _same_origin(request)
    account, cohort = await _cohort(request, cohort_id)
    if not await asyncio.to_thread(db.channel, cohort_id, channel_id):
        raise HTTPException(404, "Channel not found")
    config = settings()
    url, api_key, api_secret = config.sfu_url, config.livekit_api_key, config.livekit_api_secret
    if not config.sfu_configured:
        raise HTTPException(503, "Local SFU is not configured")
    now = datetime.now(timezone.utc)
    room = f"hub-{cohort_id}-{channel_id}"
    can_publish = cohort["role"] in {"admin", "instructor"}
    grants = {
        "roomJoin": True, "room": room, "canSubscribe": True,
        "canPublish": can_publish, "canPublishData": False,
    }
    if can_publish:
        grants["canPublishSources"] = ["screen_share"]
    payload = {
        "iss": api_key, "sub": f"hub-user-{account['id']}", "name": account["display_name"],
        "iat": int(now.timestamp()), "nbf": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=5)).timestamp()), "video": grants,
    }
    log.info("media token user=%r id=%s room=%s publish=%s", account["username"], account["id"], room, can_publish)
    return {"url": url, "room": room, "can_publish": can_publish,
            "token": jwt.encode(payload, api_secret, algorithm="HS256")}


@router.post("/api/cohorts/{cohort_id}/channels/{channel_id}/messages", status_code=201)
async def add_message(cohort_id: int, channel_id: int, body: Message, request: Request):
    _same_origin(request)
    account, _ = await _cohort(request, cohort_id)
    if not await asyncio.to_thread(db.channel, cohort_id, channel_id):
        raise HTTPException(404, "Channel not found")
    clean = body.body.strip()
    if not clean:
        raise HTTPException(400, "Message cannot be empty")
    message = await asyncio.to_thread(db.add_message, channel_id, account["id"], clean)
    await _broadcast(cohort_id, channel_id, {"type": "message", "message": jsonable_encoder(message)})
    return message


async def _broadcast(cohort_id: int, channel_id: int, payload: dict) -> None:
    key = (cohort_id, channel_id)
    allowed: dict[str, bool] = {}  # one access check per session per delivery
    for ws, raw in list(connections[key].items()):
        if raw not in allowed:
            allowed[raw] = await asyncio.to_thread(_socket_allowed, raw, cohort_id)
        if not allowed[raw]:
            log.info("chat socket revoked cohort=%s channel=%s reason=session-or-membership", cohort_id, channel_id)
            await _drop_socket(key, ws)
            continue
        try:
            await ws.send_json(payload, mode="text")
        except Exception:
            connections[key].pop(ws, None)


@router.websocket("/ws/cohorts/{cohort_id}/channels/{channel_id}")
async def chat_socket(ws: WebSocket, cohort_id: int, channel_id: int):
    origin = ws.headers.get("origin")
    if origin != f"https://{ws.headers.get('host', '')}":
        await ws.close(code=1008)
        return
    raw = ws.cookies.get(COOKIE, "")
    account = await asyncio.to_thread(db.session_account, raw)
    if not account or not await asyncio.to_thread(db.access, account, cohort_id) or not await asyncio.to_thread(db.channel, cohort_id, channel_id):
        await ws.close(code=1008)
        return
    await ws.accept()
    key = (cohort_id, channel_id)
    connections[key][ws] = raw
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        connections[key].pop(ws, None)


@router.get("/api/cohorts/{cohort_id}/questions")
async def questions(cohort_id: int, request: Request):
    await _cohort(request, cohort_id)
    return await asyncio.to_thread(db.questions, cohort_id)


@router.post("/api/cohorts/{cohort_id}/questions", status_code=201)
async def add_question(cohort_id: int, body: Question, request: Request):
    _same_origin(request)
    account, _ = await _cohort(request, cohort_id)
    if not body.title.strip() or not body.body.strip():
        raise HTTPException(400, "Question title and body are required")
    qid = await asyncio.to_thread(db.add_question, cohort_id, account["id"], body.title.strip(), body.body.strip())
    return {"id": qid}


@router.get("/api/cohorts/{cohort_id}/questions/{question_id}/answers")
async def answers(cohort_id: int, question_id: int, request: Request):
    await _cohort(request, cohort_id)
    if not await asyncio.to_thread(db.question, cohort_id, question_id):
        raise HTTPException(404, "Question not found")
    return await asyncio.to_thread(db.answers, question_id)


@router.post("/api/cohorts/{cohort_id}/questions/{question_id}/answers", status_code=201)
async def add_answer(cohort_id: int, question_id: int, body: Answer, request: Request):
    _same_origin(request)
    account, _ = await _cohort(request, cohort_id)
    if not await asyncio.to_thread(db.question, cohort_id, question_id):
        raise HTTPException(404, "Question not found")
    if not body.body.strip():
        raise HTTPException(400, "Answer cannot be empty")
    answer_id = await asyncio.to_thread(db.add_answer, question_id, account["id"], body.body.strip())
    return {"id": answer_id}


@router.post("/api/cohorts/{cohort_id}/questions/{question_id}/answers/{answer_id}/endorse")
async def endorse_answer(cohort_id: int, question_id: int, answer_id: int, body: Endorsement, request: Request):
    _same_origin(request)
    actor, _ = await _cohort(request, cohort_id, manage=True)
    if not await asyncio.to_thread(db.question, cohort_id, question_id):
        raise HTTPException(404, "Question not found")
    record = await asyncio.to_thread(db.set_endorsed, question_id, answer_id, body.endorsed)
    if not record:
        raise HTTPException(404, "Answer not found")
    log.info("answer endorsement by=%r cohort=%s answer=%s endorsed=%s", actor["username"], cohort_id, answer_id, body.endorsed)
    return record


@router.get("/api/cohorts/{cohort_id}/files")
async def files(cohort_id: int, request: Request):
    await _cohort(request, cohort_id)
    return await asyncio.to_thread(db.files, cohort_id)


@router.post("/api/cohorts/{cohort_id}/files", status_code=201)
async def upload_file(cohort_id: int, request: Request, upload: UploadFile = File(...)):
    _same_origin(request)
    account, _ = await _cohort(request, cohort_id)
    name = Path(upload.filename or "").name
    if not name or Path(name).suffix.lower() not in ALLOWED_FILE_SUFFIXES:
        raise HTTPException(400, "Unsupported file type")
    content = await upload.read(10485761)
    if not 0 < len(content) <= 10485760:
        raise HTTPException(413, "Files must be between 1 byte and 10 MB")
    file_dir = settings().file_dir
    file_dir.mkdir(parents=True, exist_ok=True)
    file_id = secrets.token_hex(16)
    target = file_dir / file_id
    await asyncio.to_thread(target.write_bytes, content)  # keep the event loop (and chat) responsive
    try:
        await asyncio.to_thread(db.add_file, file_id, cohort_id, account["id"], name,
                                upload.content_type or "application/octet-stream", len(content))
    except Exception:
        target.unlink(missing_ok=True)
        raise
    log.info("file uploaded user=%r cohort=%s file=%s name=%r bytes=%s", account["username"], cohort_id, file_id, name, len(content))
    return {"id": file_id, "name": name, "size_bytes": len(content)}


@router.get("/api/cohorts/{cohort_id}/files/{file_id}")
async def download_file(cohort_id: int, file_id: str, request: Request):
    await _cohort(request, cohort_id)
    if not re.fullmatch(r"[a-f0-9]{32}", file_id):
        raise HTTPException(404, "File not found")
    record = await asyncio.to_thread(db.file, cohort_id, file_id)
    path = settings().file_dir / file_id
    if not record or not path.is_file():
        raise HTTPException(404, "File not found")
    return FileResponse(path, filename=record["original_name"], media_type="application/octet-stream")


# --- Administration ---

async def _prune_sockets(cohort_id: int | None = None) -> int:
    """Close open chat sockets whose session or membership no longer grants access."""
    checked: dict[tuple[str, int], bool] = {}
    dropped = 0
    for key, sockets in list(connections.items()):
        if cohort_id is not None and key[0] != cohort_id:
            continue
        for ws, raw in list(sockets.items()):
            if (raw, key[0]) not in checked:
                checked[(raw, key[0])] = await asyncio.to_thread(_socket_allowed, raw, key[0])
            if not checked[(raw, key[0])]:
                await _drop_socket(key, ws)
                dropped += 1
    return dropped


def _temporary_password() -> str:
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"  # no look-alike characters
    return "".join(secrets.choice(alphabet) for _ in range(12))


@router.get("/api/accounts")
async def list_accounts(request: Request):
    await _require_admin(request)
    return await asyncio.to_thread(db.list_accounts)


@router.patch("/api/accounts/{account_id}")
async def update_account(account_id: int, body: AccountUpdate, request: Request):
    _same_origin(request)
    admin = await _require_admin(request)
    if account_id == admin["id"] and not body.active:
        raise HTTPException(400, "You cannot deactivate your own account")
    record = await asyncio.to_thread(db.set_account_active, account_id, body.active)
    if not record:
        raise HTTPException(404, "Account not found")
    closed = 0 if body.active else await _prune_sockets()
    log.info("account %s by=%r account=%s user=%r sockets_closed=%s", "enabled" if body.active else "disabled",
             admin["username"], account_id, record["username"], closed)
    return record


@router.post("/api/accounts/{account_id}/password")
async def reset_password(account_id: int, request: Request):
    """Set a new temporary password, shown once to the administrator, and sign the account out everywhere."""
    _same_origin(request)
    admin = await _require_admin(request)
    if account_id == admin["id"]:
        raise HTTPException(400, "Change your own password from your account menu")
    target = await asyncio.to_thread(db.account, account_id)
    if not target:
        raise HTTPException(404, "Account not found")
    password = _temporary_password()
    await asyncio.to_thread(db.set_password, account_id, password)
    closed = await _prune_sockets()
    log.info("password reset by=%r account=%s user=%r sockets_closed=%s", admin["username"], account_id, target["username"], closed)
    return {"id": account_id, "username": target["username"], "temporary_password": password}


@router.post("/api/me/password", status_code=204)
async def change_own_password(body: PasswordChange, request: Request):
    _same_origin(request)
    account = await _account(request)
    ip = _ip(request)
    if not _login_allowed(f"password:{account['id']}"):
        log.warning("password change throttled user=%r id=%s ip=%s", account["username"], account["id"], ip)
        raise HTTPException(429, "Too many login attempts; try again later")
    if not await asyncio.to_thread(db.password_matches, account["id"], body.current_password):
        log.warning("password change failed user=%r id=%s ip=%s", account["username"], account["id"], ip)
        raise HTTPException(400, "Current password is incorrect")
    try:
        validate_password(body.new_password)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    await asyncio.to_thread(db.set_password, account["id"], body.new_password, request.cookies.get(COOKIE, ""))
    closed = await _prune_sockets()
    log.info("password changed user=%r id=%s other_sockets_closed=%s ip=%s", account["username"], account["id"], closed, ip)


@router.patch("/api/cohorts/{cohort_id}")
async def update_cohort(cohort_id: int, body: CohortUpdate, request: Request):
    # Not via _cohort(): that refuses every write to an archived cohort, including reopening it.
    _same_origin(request)
    admin = await _require_admin(request)
    record = await asyncio.to_thread(db.set_cohort_archived, cohort_id, body.archived)
    if not record:
        raise HTTPException(404, "Cohort not found")
    log.info("cohort %s by=%r cohort=%s slug=%r", "archived" if body.archived else "reopened",
             admin["username"], cohort_id, record["slug"])
    return record


@router.delete("/api/cohorts/{cohort_id}/memberships/{account_id}", status_code=204)
async def remove_member(cohort_id: int, account_id: int, request: Request):
    _same_origin(request)
    actor, cohort = await _cohort(request, cohort_id, manage=True)
    if account_id == actor["id"]:
        raise HTTPException(400, "You cannot remove yourself from a cohort")
    current = await asyncio.to_thread(db.membership, cohort_id, account_id)
    if not current:
        raise HTTPException(404, "Member not found")
    if current["role"] == "instructor" and cohort["role"] != "admin":
        log.warning("instructor removal denied by=%r cohort=%s account=%s ip=%s", actor["username"], cohort_id, account_id, _ip(request))
        raise HTTPException(403, "Only an administrator can remove instructors")
    await asyncio.to_thread(db.remove_membership, cohort_id, account_id)
    closed = await _prune_sockets(cohort_id)
    log.info("member removed by=%r cohort=%s account=%s role=%s sockets_closed=%s",
             actor["username"], cohort_id, account_id, current["role"], closed)


# --- Moderation: authors delete their own posts; instructors and admins any in their cohort ---

def _may_delete(account: dict, cohort: dict, author_id: int) -> bool:
    return author_id == account["id"] or cohort["role"] in {"admin", "instructor"}


@router.delete("/api/cohorts/{cohort_id}/channels/{channel_id}/messages/{message_id}", status_code=204)
async def delete_message(cohort_id: int, channel_id: int, message_id: int, request: Request):
    _same_origin(request)
    account, cohort = await _cohort(request, cohort_id)
    if not await asyncio.to_thread(db.channel, cohort_id, channel_id):
        raise HTTPException(404, "Channel not found")
    found = await asyncio.to_thread(db.message_author, channel_id, message_id)
    if not found:
        raise HTTPException(404, "Message not found")
    if not _may_delete(account, cohort, found["author_id"]):
        raise HTTPException(403, "You can only delete your own posts")
    await asyncio.to_thread(db.soft_delete, "message", message_id, account["id"])
    await _broadcast(cohort_id, channel_id, {"type": "message_deleted", "id": message_id})
    log.info("message deleted by=%r cohort=%s channel=%s message=%s own=%s", account["username"], cohort_id,
             channel_id, message_id, found["author_id"] == account["id"])


@router.delete("/api/cohorts/{cohort_id}/questions/{question_id}", status_code=204)
async def delete_question(cohort_id: int, question_id: int, request: Request):
    _same_origin(request)
    account, cohort = await _cohort(request, cohort_id)
    found = await asyncio.to_thread(db.question, cohort_id, question_id)
    if not found:
        raise HTTPException(404, "Question not found")
    if not _may_delete(account, cohort, found["author_id"]):
        raise HTTPException(403, "You can only delete your own posts")
    await asyncio.to_thread(db.soft_delete, "question", question_id, account["id"])
    log.info("question deleted by=%r cohort=%s question=%s own=%s", account["username"], cohort_id,
             question_id, found["author_id"] == account["id"])


@router.delete("/api/cohorts/{cohort_id}/questions/{question_id}/answers/{answer_id}", status_code=204)
async def delete_answer(cohort_id: int, question_id: int, answer_id: int, request: Request):
    _same_origin(request)
    account, cohort = await _cohort(request, cohort_id)
    if not await asyncio.to_thread(db.question, cohort_id, question_id):
        raise HTTPException(404, "Question not found")
    found = await asyncio.to_thread(db.answer_author, question_id, answer_id)
    if not found:
        raise HTTPException(404, "Answer not found")
    if not _may_delete(account, cohort, found["author_id"]):
        raise HTTPException(403, "You can only delete your own posts")
    await asyncio.to_thread(db.soft_delete, "answer", answer_id, account["id"])
    log.info("answer deleted by=%r cohort=%s question=%s answer=%s own=%s", account["username"], cohort_id,
             question_id, answer_id, found["author_id"] == account["id"])

"""HTTPS and WSS entry points for the PostgreSQL-backed prototype hub."""
from __future__ import annotations

import asyncio
import os
import re
import secrets
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, Field
from psycopg.errors import UniqueViolation

from app.auth import validate_password, validate_username
from app.hub import db

router = APIRouter(prefix="/hub", tags=["prototype-hub"])
COOKIE = "bamboochat_hub_session"
DATA_DIR = Path(__file__).resolve().parents[2] / "data_dev"
FILE_DIR = DATA_DIR / "hub-files"
ALLOWED_FILE_SUFFIXES = {".txt", ".md", ".pdf", ".csv", ".png", ".jpg", ".jpeg", ".docx", ".pptx", ".xlsx"}
connections: dict[tuple[int, int], set[WebSocket]] = defaultdict(set)


def _same_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin and origin != str(request.base_url).rstrip("/"):
        raise HTTPException(403, "Invalid origin")


async def _account(request: Request) -> dict:
    account = await asyncio.to_thread(db.session_account, request.cookies.get(COOKIE, ""))
    if not account:
        raise HTTPException(401, "Log in to the prototype hub")
    return account


async def _cohort(request: Request, cohort_id: int, *, manage: bool = False):
    account = await _account(request)
    cohort = await asyncio.to_thread(db.access, account, cohort_id)
    if not cohort:
        raise HTTPException(403, "No access to this cohort")
    if manage and cohort["role"] not in {"admin", "instructor"}:
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


class NewChannel(BaseModel):
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,39}$")
    name: str = Field(min_length=2, max_length=100)


@router.get("")
async def hub_page():
    return FileResponse(Path(__file__).resolve().parents[1] / "static" / "hub.html")


@router.get("/api/health")
async def health():
    def check():
        with db.connect() as conn:
            return conn.execute("SELECT 1 AS ready").fetchone()["ready"] == 1
    try:
        return {"postgresql": await asyncio.to_thread(check), "sfu_configured": bool(os.environ.get("BAMBOOCHAT_HUB_SFU_URL"))}
    except Exception:
        raise HTTPException(503, "PostgreSQL unavailable")


@router.post("/api/login")
async def login(body: Login, request: Request, response: Response):
    _same_origin(request)
    account = await asyncio.to_thread(db.authenticate, body.username, body.password)
    if not account:
        raise HTTPException(401, "Incorrect username or password")
    raw = await asyncio.to_thread(db.create_session, account["id"])
    response.set_cookie(COOKIE, raw, max_age=43200, httponly=True, secure=True, samesite="strict", path="/hub")
    return {"id": account["id"], "username": account["username"], "is_admin": account["is_admin"]}


@router.post("/api/logout", status_code=204)
async def logout(request: Request, response: Response):
    _same_origin(request)
    raw = request.cookies.get(COOKIE, "")
    if raw:
        await asyncio.to_thread(db.delete_session, raw)
    response.delete_cookie(COOKIE, path="/hub")


@router.get("/api/me")
async def me(request: Request):
    return await _account(request)


@router.get("/api/cohorts")
async def list_cohorts(request: Request):
    return await asyncio.to_thread(db.cohorts_for, await _account(request))


@router.post("/api/cohorts", status_code=201)
async def create_cohort(body: NewCohort, request: Request):
    _same_origin(request)
    if not (await _account(request))["is_admin"]:
        raise HTTPException(403, "Administrator access required")
    try:
        return await asyncio.to_thread(db.create_cohort, body.slug, body.name.strip())
    except UniqueViolation:
        raise HTTPException(409, "Cohort slug already exists")


@router.post("/api/accounts", status_code=201)
async def create_account(body: NewAccount, request: Request):
    _same_origin(request)
    if not (await _account(request))["is_admin"]:
        raise HTTPException(403, "Administrator access required")
    try:
        username = validate_username(body.username)
        validate_password(body.password)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    try:
        return await asyncio.to_thread(db.create_account, username, body.display_name.strip(), body.password)
    except UniqueViolation:
        raise HTTPException(409, "Username already exists")


@router.post("/api/cohorts/{cohort_id}/memberships", status_code=201)
async def add_membership(cohort_id: int, body: Membership, request: Request):
    _same_origin(request)
    _, cohort = await _cohort(request, cohort_id, manage=True)
    if body.role == "instructor" and cohort["role"] != "admin":
        raise HTTPException(403, "Only an administrator can assign instructors")
    record = await asyncio.to_thread(db.add_membership, cohort_id, body.username, body.role)
    if not record:
        raise HTTPException(404, "Account not found")
    return record


@router.get("/api/cohorts/{cohort_id}/channels")
async def channels(cohort_id: int, request: Request):
    await _cohort(request, cohort_id)
    return await asyncio.to_thread(db.channels, cohort_id)


@router.post("/api/cohorts/{cohort_id}/channels", status_code=201)
async def create_channel(cohort_id: int, body: NewChannel, request: Request):
    _same_origin(request)
    await _cohort(request, cohort_id, manage=True)
    try:
        return await asyncio.to_thread(db.create_channel, cohort_id, body.slug, body.name.strip())
    except UniqueViolation:
        raise HTTPException(409, "Channel slug already exists")


@router.get("/api/cohorts/{cohort_id}/channels/{channel_id}/messages")
async def messages(cohort_id: int, channel_id: int, request: Request):
    await _cohort(request, cohort_id)
    if not await asyncio.to_thread(db.channel, cohort_id, channel_id):
        raise HTTPException(404, "Channel not found")
    return await asyncio.to_thread(db.messages, channel_id)


@router.post("/api/cohorts/{cohort_id}/channels/{channel_id}/media-token")
async def media_token(cohort_id: int, channel_id: int, request: Request):
    _same_origin(request)
    account, cohort = await _cohort(request, cohort_id)
    if not await asyncio.to_thread(db.channel, cohort_id, channel_id):
        raise HTTPException(404, "Channel not found")
    url = os.environ.get("BAMBOOCHAT_HUB_SFU_URL")
    api_key = os.environ.get("LIVEKIT_API_KEY")
    api_secret = os.environ.get("LIVEKIT_API_SECRET")
    if not url or not api_key or not api_secret:
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
    for ws in list(connections[(cohort_id, channel_id)]):
        try:
            await ws.send_json({"type": "message", "message": jsonable_encoder(message)}, mode="text")
        except Exception:
            connections[(cohort_id, channel_id)].discard(ws)
    return message


@router.websocket("/ws/cohorts/{cohort_id}/channels/{channel_id}")
async def chat_socket(ws: WebSocket, cohort_id: int, channel_id: int):
    origin = ws.headers.get("origin")
    if origin != f"https://{ws.headers.get('host', '')}":
        await ws.close(code=1008)
        return
    account = await asyncio.to_thread(db.session_account, ws.cookies.get(COOKIE, ""))
    if not account or not await asyncio.to_thread(db.access, account, cohort_id) or not await asyncio.to_thread(db.channel, cohort_id, channel_id):
        await ws.close(code=1008)
        return
    await ws.accept()
    key = (cohort_id, channel_id)
    connections[key].add(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        connections[key].discard(ws)


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
    FILE_DIR.mkdir(parents=True, exist_ok=True)
    file_id = secrets.token_hex(16)
    target = FILE_DIR / file_id
    target.write_bytes(content)
    try:
        await asyncio.to_thread(db.add_file, file_id, cohort_id, account["id"], name,
                                upload.content_type or "application/octet-stream", len(content))
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return {"id": file_id, "name": name, "size_bytes": len(content)}


@router.get("/api/cohorts/{cohort_id}/files/{file_id}")
async def download_file(cohort_id: int, file_id: str, request: Request):
    await _cohort(request, cohort_id)
    if not re.fullmatch(r"[a-f0-9]{32}", file_id):
        raise HTTPException(404, "File not found")
    record = await asyncio.to_thread(db.file, cohort_id, file_id)
    if not record or not (FILE_DIR / file_id).is_file():
        raise HTTPException(404, "File not found")
    return FileResponse(FILE_DIR / file_id, filename=record["original_name"], media_type="application/octet-stream")

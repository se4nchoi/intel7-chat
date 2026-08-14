"""
main.py - FastAPI server for classroom WebSocket chat and short-lived files.
"""

import asyncio
import hashlib
import ipaddress
import json
import logging
import os
import time
import uuid
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Deque, Dict, Optional, Set
from urllib.parse import unquote, urlsplit

from fastapi import FastAPI, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.database import (
    claim_attachment,
    delete_expired_records,
    delete_unclaimed_attachment,
    get_attachment_record,
    get_ip_suffix,
    get_recent_messages,
    get_upload_usage,
    init_db,
    save_attachment,
    save_message,
)

# --------- 설정 ---------
SERVICE_NAME = "인텔7기 대나무숲"
MAX_NICKNAME_LEN = 30
MAX_CONTENT_LEN = 2000
MAX_REPLY_CONTENT_LEN = 180
CLEANUP_INTERVAL_SECONDS = 3600
MAX_RAW_MESSAGE_LEN = 8192
MAX_CONNECTIONS_TOTAL = 50
MAX_CONNECTIONS_PER_IP = 3
RATE_LIMIT_MESSAGES = 30
RATE_LIMIT_WINDOW_SECONDS = 10
UPLOAD_RATE_LIMIT = 8
UPLOAD_RATE_WINDOW_SECONDS = 60
MAX_UPLOAD_BYTES = int(os.getenv("CLASSROOM_MAX_FILE_MB", "50")) * 1024 * 1024
MAX_UPLOAD_BYTES_PER_IP = int(os.getenv("CLASSROOM_MAX_IP_STORAGE_MB", "100")) * 1024 * 1024
MAX_TOTAL_UPLOAD_BYTES = int(os.getenv("CLASSROOM_MAX_TOTAL_STORAGE_MB", "2048")) * 1024 * 1024
BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = Path(os.getenv("CLASSROOM_UPLOAD_DIR", str(BASE_DIR.parent / "data" / "uploads"))).resolve()
EXPLICIT_ALLOWED_HOSTS = {
    host.strip().casefold()
    for host in os.getenv("CLASSROOM_ALLOWED_HOSTS", "").split(",")
    if host.strip()
}
BLOCKED_UPLOAD_SUFFIXES = {
    ".app", ".bat", ".cmd", ".com", ".cpl", ".dll", ".dmg", ".exe",
    ".hta", ".htm", ".html", ".jar", ".js", ".jse", ".lnk", ".mjs",
    ".msi", ".msp", ".pif", ".ps1", ".reg", ".scr", ".svg", ".vbe",
    ".vbs", ".wsf", ".wsh",
}
# ------------------------

logger = logging.getLogger("classroom_chat")
upload_lock = asyncio.Lock()


@dataclass(frozen=True)
class ClientInfo:
    nickname: str
    ip: str


connected_clients: Dict[WebSocket, ClientInfo] = {}
nickname_registry: Dict[str, WebSocket] = {}
message_timestamps: Dict[str, Deque[float]] = defaultdict(deque)
upload_timestamps: Dict[str, Deque[float]] = defaultdict(deque)


def get_client_ip(connection) -> str:
    try:
        return connection.client.host or ""
    except Exception:
        return ""


def suggest_nickname(ip: str) -> str:
    if not ip:
        return "사용자"
    last = ip.split(".")[-1] if "." in ip else ip.split(":")[-1]
    return f"사용자{last}"


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
    return parsed.scheme in {"http", "https"} and parsed.netloc.casefold() == host.casefold()


def websocket_origin_is_allowed(ws: WebSocket) -> bool:
    return origin_matches_host(ws.headers.get("origin", ""), ws.headers.get("host", ""))


def request_origin_is_allowed(request: Request) -> bool:
    return origin_matches_host(request.headers.get("origin", ""), request.headers.get("host", ""))


def connection_limit_reason(client_ip: str) -> str:
    if len(connected_clients) >= MAX_CONNECTIONS_TOTAL:
        return "서버의 최대 접속 인원에 도달했습니다. 잠시 후 다시 시도하세요."
    per_ip = sum(info.ip == client_ip for info in connected_clients.values())
    if per_ip >= MAX_CONNECTIONS_PER_IP:
        return "같은 기기에서 너무 많은 연결이 열려 있습니다. 다른 탭을 닫고 다시 시도하세요."
    return ""


def sliding_window_allowed(
    registry: Dict[str, Deque[float]],
    key: str,
    limit: int,
    window_seconds: int,
    now: Optional[float] = None,
) -> bool:
    current = time.monotonic() if now is None else now
    timestamps = registry[key]
    cutoff = current - window_seconds
    while timestamps and timestamps[0] <= cutoff:
        timestamps.popleft()
    if len(timestamps) >= limit:
        return False
    timestamps.append(current)
    return True


def message_rate_allowed(client_ip: str, now: Optional[float] = None) -> bool:
    return sliding_window_allowed(
        message_timestamps,
        client_ip,
        RATE_LIMIT_MESSAGES,
        RATE_LIMIT_WINDOW_SECONDS,
        now,
    )


def upload_rate_allowed(client_ip: str, now: Optional[float] = None) -> bool:
    return sliding_window_allowed(
        upload_timestamps,
        client_ip,
        UPLOAD_RATE_LIMIT,
        UPLOAD_RATE_WINDOW_SECONDS,
        now,
    )


def active_client_matches(nickname: str, ip: str) -> bool:
    ws = nickname_registry.get(nickname)
    info = connected_clients.get(ws) if ws else None
    return bool(info and info.ip == ip)


def clean_reply(value) -> Optional[dict]:
    if not isinstance(value, dict):
        return None
    nickname = str(value.get("nickname", "")).strip()[:MAX_NICKNAME_LEN]
    content = str(value.get("content", "")).strip()[:MAX_REPLY_CONTENT_LEN]
    if not nickname and not content:
        return None
    return {"nickname": nickname, "content": content}


def clean_original_filename(encoded_name: str) -> str:
    try:
        decoded = unquote(encoded_name)
    except Exception:
        decoded = encoded_name
    decoded = decoded.replace("\\", "/").split("/")[-1]
    decoded = "".join(char for char in decoded if ord(char) >= 32 and char not in {'<', '>', ':', '"', '|', '?', '*'})
    decoded = decoded.strip(" .")
    if not decoded:
        raise HTTPException(status_code=400, detail="파일 이름이 필요합니다.")
    if len(decoded) > 180:
        suffix = Path(decoded).suffix[:20]
        decoded = decoded[: 180 - len(suffix)] + suffix
    return decoded


def upload_is_blocked(filename: str) -> bool:
    lower = filename.casefold()
    return any(lower.endswith(suffix) for suffix in BLOCKED_UPLOAD_SUFFIXES)


def detect_preview_type(header: bytes) -> Optional[str]:
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if header.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "image/webp"
    return None


def attachment_path(stored_name: str) -> Path:
    return UPLOAD_DIR / stored_name


def remove_stored_file(stored_name: str) -> None:
    try:
        attachment_path(stored_name).unlink(missing_ok=True)
    except OSError:
        logger.exception("Failed to remove attachment stored_name=%s", stored_name)


def cleanup_expired_content() -> None:
    deleted_messages, expired_files = delete_expired_records()
    for stored_name in expired_files:
        remove_stored_file(stored_name)
    if deleted_messages or expired_files:
        logger.info(
            "Cleanup deleted_messages=%s deleted_files=%s",
            deleted_messages,
            len(expired_files),
        )


async def broadcast(payload: dict) -> None:
    message = json.dumps(payload, ensure_ascii=False)
    dead: Set[WebSocket] = set()
    for ws in list(connected_clients.keys()):
        try:
            await ws.send_text(message)
        except Exception:
            dead.add(ws)
    for ws in dead:
        _remove_client(ws)


def _remove_client(ws: WebSocket) -> None:
    info = connected_clients.pop(ws, None)
    if info and nickname_registry.get(info.nickname) is ws:
        del nickname_registry[info.nickname]


async def broadcast_presence() -> None:
    await broadcast({"type": "presence", "count": len(connected_clients)})


async def broadcast_users() -> None:
    users = [
        {"nickname": info.nickname, "ip_suffix": get_ip_suffix(info.ip)}
        for info in connected_clients.values()
    ]
    await broadcast({"type": "users", "list": users})


async def _cleanup_loop() -> None:
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
        cleanup_expired_content()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    cleanup_expired_content()
    logger.info("Database and attachment storage initialized")
    task = asyncio.create_task(_cleanup_loop())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


app = FastAPI(
    title=SERVICE_NAME,
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    if not host_is_allowed(request.headers.get("host", "")):
        logger.warning("Rejected HTTP host=%r ip=%s", request.headers.get("host"), get_client_ip(request))
        return PlainTextResponse("Invalid host", status_code=400)
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; "
        "form-action 'self'; img-src 'self'; style-src 'self'; "
        "script-src 'self'; connect-src 'self' ws: wss:"
    )
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    return response


app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "service_name": SERVICE_NAME,
            "max_message_len": MAX_CONTENT_LEN,
            "max_file_mb": MAX_UPLOAD_BYTES // (1024 * 1024),
        },
    )


@app.get("/api/client-info")
async def client_info(request: Request):
    ip = get_client_ip(request)
    return {
        "suggested_nickname": suggest_nickname(ip),
        "ip_last_octet": ip.split(".")[-1] if "." in ip else "",
    }


@app.get("/api/messages")
async def api_messages():
    return get_recent_messages()


@app.post("/api/files", status_code=201)
async def upload_file(
    request: Request,
    x_chat_nickname: str = Header("", alias="X-Chat-Nickname"),
    x_file_name: str = Header("", alias="X-File-Name"),
):
    client_ip = get_client_ip(request)
    nickname = x_chat_nickname.strip()
    if not request_origin_is_allowed(request):
        raise HTTPException(status_code=403, detail="허용되지 않은 업로드 origin입니다.")
    if not active_client_matches(nickname, client_ip):
        raise HTTPException(status_code=403, detail="활성 채팅 연결이 필요합니다.")
    if not upload_rate_allowed(client_ip):
        raise HTTPException(status_code=429, detail="업로드가 너무 빠릅니다. 잠시 후 다시 시도하세요.")

    original_name = clean_original_filename(x_file_name)
    if upload_is_blocked(original_name):
        raise HTTPException(status_code=415, detail="실행 파일 또는 활성 웹 파일은 공유할 수 없습니다.")
    content_length = request.headers.get("content-length")
    if content_length and content_length.isdigit() and int(content_length) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="파일 크기 제한을 초과했습니다.")

    async with upload_lock:
        per_ip_usage, total_usage = get_upload_usage(client_ip)
        if per_ip_usage >= MAX_UPLOAD_BYTES_PER_IP:
            raise HTTPException(status_code=413, detail="이 기기의 활성 파일 보관 한도를 초과했습니다.")
        if total_usage >= MAX_TOTAL_UPLOAD_BYTES:
            raise HTTPException(status_code=507, detail="서버 파일 보관 공간이 가득 찼습니다.")

        attachment_id = uuid.uuid4().hex
        stored_name = f"{attachment_id}.upload"
        destination = attachment_path(stored_name)
        digest = hashlib.sha256()
        size = 0
        header = bytearray()
        try:
            with destination.open("xb") as output:
                async for chunk in request.stream():
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise HTTPException(status_code=413, detail="파일 크기 제한을 초과했습니다.")
                    if len(header) < 16:
                        header.extend(chunk[: 16 - len(header)])
                    digest.update(chunk)
                    output.write(chunk)
            if size == 0:
                raise HTTPException(status_code=400, detail="빈 파일은 공유할 수 없습니다.")
            if per_ip_usage + size > MAX_UPLOAD_BYTES_PER_IP:
                raise HTTPException(status_code=413, detail="이 기기의 활성 파일 보관 한도를 초과했습니다.")
            if total_usage + size > MAX_TOTAL_UPLOAD_BYTES:
                raise HTTPException(status_code=507, detail="서버 파일 보관 공간이 가득 찼습니다.")

            preview_type = detect_preview_type(bytes(header))
            attachment = save_attachment({
                "id": attachment_id,
                "original_name": original_name,
                "stored_name": stored_name,
                "size": size,
                "sha256": digest.hexdigest(),
                "content_type": preview_type or "application/octet-stream",
                "previewable": bool(preview_type),
                "uploader_nickname": nickname,
                "ip": client_ip,
            })
        except Exception:
            destination.unlink(missing_ok=True)
            raise

    logger.info("Uploaded attachment id=%s nickname=%r ip=%s size=%s", attachment_id, nickname, client_ip, size)
    return attachment


@app.delete("/api/files/{attachment_id}", status_code=204)
async def discard_file(
    attachment_id: str,
    request: Request,
    x_chat_nickname: str = Header("", alias="X-Chat-Nickname"),
):
    client_ip = get_client_ip(request)
    nickname = x_chat_nickname.strip()
    if not request_origin_is_allowed(request):
        raise HTTPException(status_code=403, detail="허용되지 않은 요청 origin입니다.")
    stored_name = delete_unclaimed_attachment(attachment_id, nickname, client_ip)
    if not stored_name:
        raise HTTPException(status_code=404, detail="삭제할 대기 파일이 없습니다.")
    remove_stored_file(stored_name)


@app.get("/api/files/{attachment_id}")
async def download_file(attachment_id: str):
    record = get_attachment_record(attachment_id)
    if not record:
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
    path = attachment_path(record["stored_name"])
    if not path.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
    previewable = bool(record["previewable"])
    return FileResponse(
        path,
        media_type=record["content_type"] if previewable else "application/octet-stream",
        filename=record["original_name"],
        content_disposition_type="inline" if previewable else "attachment",
        headers={"Cache-Control": "private, no-store"},
    )


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, nickname: str = Query("")):
    nickname = nickname.strip()
    client_ip = get_client_ip(ws)

    if not websocket_origin_is_allowed(ws):
        logger.warning("Rejected WebSocket origin ip=%s origin=%r", client_ip, ws.headers.get("origin"))
        await ws.close(code=1008, reason="허용되지 않은 WebSocket origin입니다.")
        return

    await ws.accept()
    limit_reason = connection_limit_reason(client_ip)
    if limit_reason:
        logger.warning("Rejected connection limit ip=%s", client_ip)
        await ws.send_text(json.dumps({"type": "error", "message": limit_reason}, ensure_ascii=False))
        await ws.close(code=1013)
        return

    if not nickname or len(nickname) > MAX_NICKNAME_LEN:
        await ws.send_text(json.dumps({
            "type": "error_nickname",
            "message": f"닉네임이 비어 있거나 {MAX_NICKNAME_LEN}자를 초과합니다.",
        }, ensure_ascii=False))
        await ws.close(code=1008)
        return

    if nickname in nickname_registry:
        await ws.send_text(json.dumps({
            "type": "error_nickname",
            "message": f"'{nickname}' 닉네임은 이미 사용 중입니다. 다른 닉네임을 사용하세요.",
        }, ensure_ascii=False))
        await ws.close(code=1008)
        return

    connected_clients[ws] = ClientInfo(nickname=nickname, ip=client_ip)
    nickname_registry[nickname] = ws
    logger.info("Connected nickname=%r ip=%s", nickname, client_ip)
    await broadcast_presence()
    await broadcast_users()

    for message in get_recent_messages():
        await ws.send_text(json.dumps({"type": "chat", **message}, ensure_ascii=False))

    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > MAX_RAW_MESSAGE_LEN:
                logger.warning("Oversized WebSocket message nickname=%r ip=%s length=%s", nickname, client_ip, len(raw))
                await ws.close(code=1009, reason="메시지 프레임이 너무 큽니다.")
                break
            if not message_rate_allowed(client_ip):
                logger.warning("Rate limit exceeded nickname=%r ip=%s", nickname, client_ip)
                await ws.send_text(json.dumps({
                    "type": "error",
                    "message": "메시지를 너무 빠르게 보내고 있습니다. 잠시 후 다시 접속하세요.",
                }, ensure_ascii=False))
                await ws.close(code=1008)
                break
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(data, dict):
                continue

            msg_type = data.get("type")
            content = str(data.get("content", "")).strip()
            attachment_id = str(data.get("attachment_id", "")).strip() or None
            reply = clean_reply(data.get("reply"))
            if not content and not attachment_id:
                continue
            if len(content) > MAX_CONTENT_LEN:
                await ws.send_text(json.dumps({
                    "type": "error",
                    "message": f"메시지는 {MAX_CONTENT_LEN}자 이하여야 합니다.",
                }, ensure_ascii=False))
                continue

            if msg_type == "chat":
                attachment = None
                if attachment_id:
                    attachment = claim_attachment(attachment_id, nickname, client_ip)
                    if not attachment:
                        await ws.send_text(json.dumps({
                            "type": "error",
                            "message": "첨부 파일이 만료되었거나 이미 사용되었습니다.",
                        }, ensure_ascii=False))
                        continue
                saved = save_message(
                    nickname,
                    content,
                    ip=client_ip,
                    reply=reply,
                    attachment_id=attachment["id"] if attachment else None,
                )
                saved.pop("ip", None)
                await broadcast({"type": "chat", **saved})

            elif msg_type == "dm":
                to_nick = str(data.get("to", "")).strip()
                target_ws = nickname_registry.get(to_nick)
                if not to_nick or not target_ws:
                    await ws.send_text(json.dumps({
                        "type": "error",
                        "message": f"'{to_nick}'님이 오프라인 상태입니다.",
                    }, ensure_ascii=False))
                    continue
                attachment = None
                if attachment_id:
                    attachment = claim_attachment(attachment_id, nickname, client_ip)
                    if not attachment:
                        await ws.send_text(json.dumps({
                            "type": "error",
                            "message": "첨부 파일이 만료되었거나 이미 사용되었습니다.",
                        }, ensure_ascii=False))
                        continue
                target_info = connected_clients.get(target_ws)
                payload = {
                    "type": "dm",
                    "message_id": f"dm:{uuid.uuid4().hex}",
                    "from_nick": nickname,
                    "to_nick": to_nick,
                    "from_ip_suffix": get_ip_suffix(client_ip),
                    "to_ip_suffix": get_ip_suffix(target_info.ip if target_info else ""),
                    "content": content,
                    "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "reply": reply,
                    "attachment": attachment,
                }
                encoded = json.dumps(payload, ensure_ascii=False)
                try:
                    await target_ws.send_text(encoded)
                except Exception:
                    pass
                await ws.send_text(encoded)

    except WebSocketDisconnect:
        pass
    finally:
        _remove_client(ws)
        logger.info("Disconnected nickname=%r ip=%s", nickname, client_ip)
        await broadcast_presence()
        await broadcast_users()

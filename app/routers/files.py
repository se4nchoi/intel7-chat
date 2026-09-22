"""File upload, download, and storage tracking routes."""
from __future__ import annotations
import hashlib
import uuid
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import FileResponse

from app.database import (
    attachment_is_visible_to_user, delete_owned_attachment, get_attachment_record,
    get_storage_status, get_upload_usage, save_attachment
)
from app import main

router = APIRouter(tags=["files"])


@router.get("/api/storage")
async def storage_status(request: Request):
    user = main.request_user(request)
    status = get_storage_status()
    mine, _ = get_upload_usage(user["id"])
    status.update({
        "attachment_limit_bytes": main.MAX_TOTAL_UPLOAD_BYTES,
        "user_attachment_bytes": mine,
        "user_attachment_limit_bytes": main.MAX_UPLOAD_BYTES_PER_USER
    })
    ratios = [
        status["database_bytes"] / max(1, status["database_limit_bytes"]),
        status["attachment_bytes"] / max(1, status["attachment_limit_bytes"]),
        status["user_attachment_bytes"] / max(1, status["user_attachment_limit_bytes"]),
    ]
    usage = max(ratios)
    status["warning_level"] = 95 if usage >= .95 else 85 if usage >= .85 else 70 if usage >= .70 else 0
    return status


@router.post("/api/files", status_code=201)
async def upload_file(request: Request, x_file_name: str = Header("", alias="X-File-Name")):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    ip = main.get_client_ip(request)
    if not main.sliding_window_allowed(main.upload_timestamps, str(user["id"]), main.UPLOAD_RATE_LIMIT, main.UPLOAD_RATE_WINDOW_SECONDS):
        raise HTTPException(429, "업로드가 너무 빠릅니다.")
    name = main.clean_original_filename(x_file_name)
    if main.upload_is_blocked(name):
        raise HTTPException(415, "실행 파일 또는 활성 웹 파일은 공유할 수 없습니다.")
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > main.MAX_UPLOAD_BYTES:
        raise HTTPException(413, "파일 크기 제한을 초과했습니다.")
    async with main.upload_lock:
        mine, total = get_upload_usage(user["id"])
        if mine >= main.MAX_UPLOAD_BYTES_PER_USER:
            raise HTTPException(413, "개인 파일 보관 한도를 초과했습니다.")
        if total >= main.MAX_TOTAL_UPLOAD_BYTES:
            raise HTTPException(507, "서버 파일 보관 공간이 가득 찼습니다.")
        attachment_id = uuid.uuid4().hex
        stored_name = f"{attachment_id}.upload"
        destination = main.attachment_path(stored_name)
        digest = hashlib.sha256()
        size = 0
        header = bytearray()
        try:
            with destination.open("xb") as output:
                async for chunk in request.stream():
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > main.MAX_UPLOAD_BYTES:
                        raise HTTPException(413, "파일 크기 제한을 초과했습니다.")
                    if len(header) < 16:
                        header.extend(chunk[:16 - len(header)])
                    digest.update(chunk)
                    output.write(chunk)
            if not size:
                raise HTTPException(400, "빈 파일은 공유할 수 없습니다.")
            if mine + size > main.MAX_UPLOAD_BYTES_PER_USER:
                raise HTTPException(413, "개인 파일 보관 한도를 초과했습니다.")
            if total + size > main.MAX_TOTAL_UPLOAD_BYTES:
                raise HTTPException(507, "서버 파일 보관 공간이 가득 찼습니다.")
            preview = main.detect_preview_type(bytes(header))
            attachment = save_attachment({
                "id": attachment_id, "original_name": name, "stored_name": stored_name,
                "size": size, "sha256": digest.hexdigest(),
                "content_type": preview or "application/octet-stream",
                "previewable": bool(preview), "uploader_nickname": user["username"],
                "uploader_user_id": user["id"], "ip": ip
            })
        except Exception:
            destination.unlink(missing_ok=True)
            raise
    main.logger.info("Upload id=%s user=%s ip=%s size=%s", attachment_id, user["id"], ip, size)
    return attachment


@router.delete("/api/files/{attachment_id}", status_code=204)
async def discard_file(attachment_id: str, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    deleted = delete_owned_attachment(attachment_id, user["id"], user["role"] == "admin")
    if not deleted:
        raise HTTPException(404, "삭제할 수 있는 파일이 없습니다.")
    main.remove_stored_file(deleted["stored_name"])
    await main.broadcast({"type": "attachment_deleted", "attachment_id": attachment_id})


@router.get("/api/files/{attachment_id}")
async def download_file(attachment_id: str, request: Request):
    user = main.request_user(request)
    record = get_attachment_record(attachment_id)
    if not record:
        raise HTTPException(404, "파일을 찾을 수 없습니다.")
    if not attachment_is_visible_to_user(attachment_id, user["id"]):
        raise HTTPException(404, "파일을 찾을 수 없습니다.")
    path = main.attachment_path(record["stored_name"])
    if not path.is_file():
        raise HTTPException(404, "파일을 찾을 수 없습니다.")
    preview = bool(record["previewable"])
    return FileResponse(
        path,
        media_type=record["content_type"] if preview else "application/octet-stream",
        filename=record["original_name"],
        content_disposition_type="inline" if preview else "attachment",
        headers={"Cache-Control": "private, no-store"}
    )

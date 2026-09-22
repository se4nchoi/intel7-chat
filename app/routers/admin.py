"""System administration and user management routes."""
from __future__ import annotations
import asyncio
from fastapi import APIRouter, HTTPException, Request, Response

from app.auth import hash_secret, validate_display_name, validate_password
from app.config import save_config
from app.database import (
    count_active_admins, delete_user_sessions, get_storage_status,
    get_user_by_id, list_users, set_user_active, set_user_role,
    update_display_name, update_password_hash
)
from app import main

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/overview")
async def admin_overview(request: Request):
    main.require_admin(request)
    status = get_storage_status()
    status["attachment_limit_bytes"] = main.MAX_TOTAL_UPLOAD_BYTES
    status["database_limit_bytes"] = main.CONFIG.database_limit_bytes
    return {
        "registration_enabled": main.CONFIG.registration_enabled,
        "storage": status,
        "users": [main.account_public(user) for user in list_users()],
    }


@router.post("/registration")
async def admin_registration(request: Request):
    main.require_admin(request)
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    data = await main.read_json_body(request)
    if not isinstance(data.get("enabled"), bool):
        raise HTTPException(400, "enabled 값은 true 또는 false여야 합니다.")
    main.CONFIG.registration_enabled = data["enabled"]
    save_config(main.CONFIG)
    return {"registration_enabled": main.CONFIG.registration_enabled}


@router.post("/enrollment-code", status_code=204)
async def admin_enrollment_code(request: Request):
    main.require_admin(request)
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    data = await main.read_json_body(request)
    code = str(data.get("enrollment_code", ""))
    try:
        validate_password(code)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    main.CONFIG.enrollment_code_hash = await asyncio.to_thread(hash_secret, code)
    save_config(main.CONFIG)
    return Response(status_code=204)


@router.post("/users/{user_id}")
async def admin_update_user(user_id: int, request: Request):
    admin = main.require_admin(request)
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    data = await main.read_json_body(request)
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
        await main.disconnect_user(user_id, "계정 설정이 변경되었습니다. 다시 로그인해 주세요.")
    if requested_active != bool(target["active"]):
        await main.broadcast_users()
    updated = get_user_by_id(user_id)
    return main.account_public(updated)

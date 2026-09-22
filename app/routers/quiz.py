"""Educational quiz, submission, review, and AI generation routes."""
from __future__ import annotations
import asyncio
from datetime import date
import hashlib
import json
import os
from pathlib import Path
from typing import Optional
import uuid
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from app.database import (
    QUIZ_EXPERTISES, analyze_quiz_set, assign_daily_quizzes, create_quiz_batch,
    create_user_quiz_set, delete_quiz, flag_quiz_question, get_all_quiz_categories,
    get_all_quiz_subject_titles, get_all_quizzes_admin, get_daily_quizzes,
    get_quiz_categories_summary, get_quiz_flags,
    get_quiz_leaderboard, get_quiz_review_list, get_quiz_sidebar_counts,
    get_quiz_source_documents, get_quiz_subject_leaderboard, get_quiz_subject_titles,
    get_user_quiz_stats, list_user_quiz_sets, normalize_quiz_import, resolve_quiz_flag,
    retry_quiz_answer, review_user_quiz_set, save_quiz_source_document,
    save_quiz_subject_titles, submit_quiz_answer, submit_user_quiz_set,
    toggle_quiz_bookmark, update_pending_user_quiz_set, update_quiz, update_user_quiz_set
)
from app.quiz_ai import generate_quizzes_with_gemini
from app import main

router = APIRouter(tags=["quiz"])


@router.get("/api/quiz/today")
async def api_quiz_today(
    request: Request,
    category: Optional[str] = None,
    count: int = 5,
    offset: int = 0,
    exclude: Optional[str] = None,
):
    user = main.request_user(request)
    count = max(1, min(int(count), 200))
    offset = max(0, int(offset))
    exclude_ids = []
    if exclude:
        try:
            exclude_ids = [int(value) for value in exclude.split(",") if value.strip()]
        except ValueError:
            raise HTTPException(400, "exclude 문항 ID 형식이 올바르지 않습니다.")
    quizzes = get_daily_quizzes(user["id"], count=count, category=category, offset=offset, exclude_ids=exclude_ids)
    stats = get_user_quiz_stats(user["id"])
    return {
        "quizzes": quizzes,
        "stats": stats,
        "category": category or "daily",
    }


@router.get("/api/quiz/categories")
async def api_quiz_categories(request: Request):
    main.request_user(request)
    return {
        "categories": get_quiz_categories_summary(),
        "all_categories": get_all_quiz_categories(),
    }


@router.get("/api/quiz/sidebar-counts")
async def api_quiz_sidebar_counts(request: Request):
    user = main.request_user(request)
    return get_quiz_sidebar_counts(user["id"])


@router.post("/api/quiz/submit")
async def api_quiz_submit(request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    data = await main.read_json_body(request)
    try:
        quiz_id = int(data.get("quiz_id", 0))
    except (ValueError, TypeError):
        raise HTTPException(400, "올바른 퀴즈 ID가 필요합니다.")
    user_answer = str(data.get("answer", "")).strip()
    if not user_answer:
        raise HTTPException(400, "답안을 입력하세요.")
    try:
        result = submit_quiz_answer(user["id"], quiz_id, user_answer)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    await main.broadcast_users()
    await main.broadcast({
        "type": "quiz_leaderboard_updated",
        "user_id": user["id"],
    })
    return result


@router.post("/api/quiz/retry")
async def api_quiz_retry(request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    data = await main.read_json_body(request)
    try:
        quiz_id = int(data.get("quiz_id", 0))
    except (ValueError, TypeError):
        raise HTTPException(400, "올바른 퀴즈 ID가 필요합니다.")
    user_answer = str(data.get("answer", "")).strip()
    if not user_answer:
        raise HTTPException(400, "답안을 입력하세요.")
    try:
        result = retry_quiz_answer(user["id"], quiz_id, user_answer)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return result


@router.post("/api/quiz/bookmark/{quiz_id}")
async def api_quiz_bookmark(quiz_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    is_starred = toggle_quiz_bookmark(user["id"], quiz_id)
    return {"status": "ok", "quiz_id": quiz_id, "is_starred": is_starred}


@router.get("/api/quiz/review")
async def api_quiz_review(request: Request, mode: str = "wrong"):
    user = main.request_user(request)
    if mode not in {"wrong", "starred", "history"}:
        mode = "wrong"
    quizzes = get_quiz_review_list(user["id"], mode=mode)
    return {"mode": mode, "quizzes": quizzes, "count": len(quizzes)}


@router.get("/api/quiz/leaderboard")
async def api_quiz_leaderboard(request: Request, period: str = "weekly", category: Optional[str] = None):
    main.request_user(request)
    if category:
        leaderboard = get_quiz_subject_leaderboard(category)
        return {
            "period": "subject",
            "category": category,
            "leaderboard": leaderboard,
        }
    if period not in {"daily", "weekly", "all", "streak"}:
        period = "weekly"
    leaderboard = get_quiz_leaderboard(period)
    return {
        "period": period,
        "leaderboard": leaderboard,
    }


@router.get("/api/quiz/stats")
async def api_quiz_stats(request: Request):
    user = main.request_user(request)
    return get_user_quiz_stats(user["id"])


@router.get("/api/quiz/expertises")
async def api_quiz_expertises(request: Request):
    main.request_user(request)
    return {"expertises": get_all_quiz_categories()}


@router.get("/api/quiz/subject-titles")
async def api_quiz_subject_titles(request: Request):
    main.request_user(request)
    return {"titles": get_all_quiz_subject_titles()}


@router.get("/api/quiz/subject-titles/{category}")
async def api_quiz_subject_title_detail(category: str, request: Request):
    main.request_user(request)
    titles = get_quiz_subject_titles(category)
    if not titles:
        raise HTTPException(404, "해당 주제의 칭호를 찾을 수 없습니다.")
    return titles


@router.post("/api/admin/quiz/subject-titles")
async def api_admin_save_subject_titles(request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    main.require_admin(request)
    data = await main.read_json_body(request)
    category = str(data.get("category", "")).strip()
    if not category:
        raise HTTPException(400, "과목명을 입력하세요.")
    res = save_quiz_subject_titles(
        category=category,
        rank1_title=str(data.get("rank1_title", "")).strip(),
        rank2_title=str(data.get("rank2_title", "")).strip(),
        rank3_title=str(data.get("rank3_title", "")).strip(),
        icon=str(data.get("icon", "")).strip() or "📚",
    )
    return {"status": "ok", **res}


@router.get("/api/quiz/my-sets")
async def api_my_quiz_sets(request: Request):
    user = main.request_user(request)
    return {"sets": list_user_quiz_sets(owner_user_id=user["id"])}


@router.post("/api/quiz/my-sets/validate")
async def api_validate_my_quiz_set(request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    main.request_user(request)
    data = await main.read_json_body(request)
    try:
        return analyze_quiz_set(data.get("quizzes"), str(data.get("expertise", "")))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/api/quiz/my-sets", status_code=201)
async def api_create_my_quiz_set(request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    data = await main.read_json_body(request)
    try:
        created = create_user_quiz_set(
            user["id"], str(data.get("expertise", "")), str(data.get("title", "")), data.get("quizzes"),
            rank1_title=str(data.get("rank1_title", "")),
            rank2_title=str(data.get("rank2_title", "")),
            rank3_title=str(data.get("rank3_title", "")),
            icon=str(data.get("icon", "")),
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return created


@router.patch("/api/quiz/my-sets/{set_id}")
async def api_update_my_quiz_set(set_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    data = await main.read_json_body(request)
    try:
        updated = update_user_quiz_set(
            set_id, user["id"], str(data.get("expertise", "")), str(data.get("title", "")), data.get("quizzes"),
            rank1_title=str(data.get("rank1_title", "")) if "rank1_title" in data else None,
            rank2_title=str(data.get("rank2_title", "")) if "rank2_title" in data else None,
            rank3_title=str(data.get("rank3_title", "")) if "rank3_title" in data else None,
            icon=str(data.get("icon", "")) if "icon" in data else None,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not updated:
        raise HTTPException(409, "초안 또는 반려된 문제집만 수정할 수 있습니다.")
    return updated


@router.post("/api/quiz/my-sets/{set_id}/submit")
async def api_submit_my_quiz_set(set_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    if not submit_user_quiz_set(set_id, user["id"]):
        raise HTTPException(409, "제출할 수 없는 문제집입니다.")
    return {"status": "pending_review", "set_id": set_id}


@router.get("/api/admin/quiz/submissions")
async def api_admin_quiz_submissions(request: Request):
    main.require_admin(request)
    return {"sets": list_user_quiz_sets(status="pending_review")}


@router.post("/api/admin/quiz/submissions/{set_id}/review")
async def api_admin_review_quiz_submission(set_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    admin = main.require_admin(request)
    data = await main.read_json_body(request)
    approve = data.get("approve")
    note = str(data.get("note", ""))
    if not isinstance(approve, bool):
        raise HTTPException(400, "approve는 true 또는 false여야 합니다.")
    try:
        created_ids = review_user_quiz_set(
            set_id, admin["id"], approve, note,
            items=data.get("quizzes"), expertise=data.get("expertise"), title=data.get("title"),
            rank1_title=str(data.get("rank1_title", "")) if "rank1_title" in data else None,
            rank2_title=str(data.get("rank2_title", "")) if "rank2_title" in data else None,
            rank3_title=str(data.get("rank3_title", "")) if "rank3_title" in data else None,
            icon=str(data.get("icon", "")) if "icon" in data else None,
        )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"status": "approved" if approve else "rejected", "created_ids": created_ids}


@router.patch("/api/admin/quiz/submissions/{set_id}")
async def api_admin_update_quiz_submission(set_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    main.require_admin(request)
    data = await main.read_json_body(request)
    try:
        updated = update_pending_user_quiz_set(
            set_id, str(data.get("expertise", "")), str(data.get("title", "")), data.get("quizzes"),
            rank1_title=str(data.get("rank1_title", "")) if "rank1_title" in data else None,
            rank2_title=str(data.get("rank2_title", "")) if "rank2_title" in data else None,
            rank3_title=str(data.get("rank3_title", "")) if "rank3_title" in data else None,
            icon=str(data.get("icon", "")) if "icon" in data else None,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"status": "ok", "set": updated}


@router.post("/api/admin/quiz/daily-sets")
async def api_admin_assign_daily_set(request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    admin = main.require_admin(request)
    data = await main.read_json_body(request)
    assigned_date = str(data.get("assigned_date", "")).strip()
    quiz_ids = data.get("quiz_ids", [])
    try:
        if not isinstance(quiz_ids, list):
            raise ValueError("quiz_ids는 배열이어야 합니다.")
        date.fromisoformat(assigned_date)
        ids = [int(value) for value in quiz_ids]
        set_id = assign_daily_quizzes(assigned_date, ids, admin["id"])
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"status": "published", "set_id": set_id, "assigned_date": assigned_date}


@router.post("/api/admin/quiz/ai-generate")
async def api_admin_quiz_ai_generate(request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    admin = main.require_admin(request)
    api_key = os.getenv("GEMINI_API_KEY", "") or getattr(main.CONFIG, "gemini_api_key", "")
    if not api_key:
        raise HTTPException(400, "GEMINI_API_KEY 환경변수 또는 설정에 Gemini API 키가 등록되지 않았습니다.")

    content_type = request.headers.get("content-type", "")
    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        category = str(form.get("category", "PLC")).strip()
        count = int(form.get("count", 5))
        file_obj = form.get("file")
        text_content = str(form.get("text_content", "")).strip()

        if file_obj and hasattr(file_obj, "read"):
            filename = getattr(file_obj, "filename", "document.pdf")
            file_bytes = await file_obj.read()
            is_pdf = filename.lower().endswith(".pdf")
        elif text_content:
            filename = "notes.txt"
            file_bytes = text_content.encode("utf-8")
            is_pdf = False
        else:
            raise HTTPException(400, "파일 또는 텍스트 내용을 입력하세요.")
    else:
        data = await main.read_json_body(request)
        category = str(data.get("category", "PLC")).strip()
        count = int(data.get("count", 5))
        text_content = str(data.get("text_content", "")).strip()
        if not text_content:
            raise HTTPException(400, "텍스트 내용을 입력하세요.")
        filename = "notes.txt"
        file_bytes = text_content.encode("utf-8")
        is_pdf = False

    sha256 = hashlib.sha256(file_bytes).hexdigest()
    stored_name = f"doc_{uuid.uuid4().hex}_{filename}"
    doc_path = main.QUIZ_SOURCES_DIR / stored_name
    doc_path.write_bytes(file_bytes)
    doc_id = save_quiz_source_document(
        filename=filename,
        stored_filename=stored_name,
        file_type="pdf" if is_pdf else "txt",
        sha256=sha256,
        size=len(file_bytes),
        uploaded_by_user_id=admin["id"]
    )

    try:
        quizzes = await asyncio.to_thread(
            generate_quizzes_with_gemini,
            api_key,
            file_bytes,
            is_pdf=is_pdf,
            count=count,
            category=category,
        )
    except Exception as exc:
        raise HTTPException(500, f"AI 퀴즈 생성 중 오류 발생: {exc}") from exc

    admin_name = admin.get("display_name") or admin.get("username") or "관리자"
    created_ids = create_quiz_batch(quizzes, source_doc_id=doc_id, author_id=admin["id"], author_name=f"{admin_name} (AI)")
    r1 = str(form.get("rank1_title", "") if "form" in locals() else (data.get("rank1_title", "") if "data" in locals() else "")).strip()
    r2 = str(form.get("rank2_title", "") if "form" in locals() else (data.get("rank2_title", "") if "data" in locals() else "")).strip()
    r3 = str(form.get("rank3_title", "") if "form" in locals() else (data.get("rank3_title", "") if "data" in locals() else "")).strip()
    ic = str(form.get("icon", "") if "form" in locals() else (data.get("icon", "") if "data" in locals() else "")).strip()
    if category and (r1 or r2 or r3 or ic):
        save_quiz_subject_titles(category, rank1_title=r1, rank2_title=r2, rank3_title=r3, icon=ic)
    return {
        "status": "ok",
        "created_count": len(created_ids),
        "source_doc_id": doc_id,
        "quizzes": quizzes,
    }


@router.post("/api/admin/quiz/import-json")
async def api_admin_quiz_import_json(request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    admin = main.require_admin(request)
    admin_name = admin.get("display_name") or admin.get("username") or "관리자"
    data = await main.read_json_body(request)
    raw_quizzes = data.get("quizzes", [])
    if isinstance(raw_quizzes, str):
        try:
            raw_quizzes = json.loads(raw_quizzes)
        except json.JSONDecodeError as exc:
            raise HTTPException(400, "올바른 JSON 배열 형식이어야 합니다.") from exc
    if not isinstance(raw_quizzes, list) or not raw_quizzes:
        raise HTTPException(400, "퀴즈 목록(배열)이 비어 있거나 올바르지 않습니다.")

    created_ids = create_quiz_batch(raw_quizzes, author_id=admin["id"], author_name=admin_name)
    cat = str(data.get("category") or (raw_quizzes[0].get("category") if raw_quizzes and isinstance(raw_quizzes[0], dict) else "") or "").strip()
    r1 = str(data.get("rank1_title") or "").strip()
    r2 = str(data.get("rank2_title") or "").strip()
    r3 = str(data.get("rank3_title") or "").strip()
    ic = str(data.get("icon") or "").strip()
    if cat and (r1 or r2 or r3 or ic):
        save_quiz_subject_titles(cat, rank1_title=r1, rank2_title=r2, rank3_title=r3, icon=ic)
    return {"status": "ok", "created_count": len(created_ids), "ids": created_ids}


@router.get("/api/admin/quiz/list")
async def api_admin_quiz_list(
    request: Request,
    search: str = "",
    category: str = "",
    flagged_only: bool = False,
    limit: int = 200,
    offset: int = 0
):
    main.require_admin(request)
    return {
        "quizzes": get_all_quizzes_admin(
            search=search,
            category=category,
            flagged_only=flagged_only,
            limit=min(limit, 500),
            offset=max(0, offset)
        ),
        "source_documents": get_quiz_source_documents(),
        "categories": get_all_quiz_categories(),
    }


@router.post("/api/quiz/{quiz_id}/flag")
async def api_quiz_flag(quiz_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    user = main.request_user(request)
    data = await main.read_json_body(request)
    reason_type = str(data.get("reason_type", "wrong_answer")).strip()
    comment = str(data.get("comment", "")).strip()
    try:
        res = flag_quiz_question(quiz_id, user["id"], reason_type, comment)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"status": "ok", **res}


@router.get("/api/admin/quiz/flags")
async def api_admin_quiz_flags(request: Request, quiz_id: Optional[int] = None, status: str = "open"):
    main.require_admin(request)
    return {"flags": get_quiz_flags(quiz_id=quiz_id, status=status)}


@router.post("/api/admin/quiz/flags/{flag_id}/resolve")
async def api_admin_quiz_flag_resolve(flag_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    admin = main.require_admin(request)
    ok = resolve_quiz_flag(flag_id, admin["id"])
    if not ok:
        raise HTTPException(404, "신고 내역을 찾을 수 없습니다.")
    return {"status": "ok", "resolved_flag_id": flag_id}


@router.post("/api/admin/quiz")
async def api_admin_quiz_create(request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    admin = main.require_admin(request)
    admin_name = admin.get("display_name") or admin.get("username") or "관리자"
    data = await main.read_json_body(request)
    category = str(data.get("category", "")).strip()
    author_name = str(data.get("author_name") or "").strip() or admin_name
    if not category or len(category) > 80:
        raise HTTPException(400, "과목은 1~80자여야 합니다.")
    try:
        normalized = normalize_quiz_import([data], "PLC")[0]
        normalized["category"] = category
        normalized["author_name"] = author_name
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    created_ids = create_quiz_batch([normalized], author_id=admin["id"], author_name=author_name)
    r1 = str(data.get("rank1_title") or "").strip()
    r2 = str(data.get("rank2_title") or "").strip()
    r3 = str(data.get("rank3_title") or "").strip()
    ic = str(data.get("icon") or "").strip()
    if r1 or r2 or r3 or ic:
        save_quiz_subject_titles(category, rank1_title=r1, rank2_title=r2, rank3_title=r3, icon=ic)
    return {"status": "ok", "quiz_id": created_ids[0]}


@router.patch("/api/admin/quiz/{quiz_id}")
async def api_admin_quiz_update(quiz_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    main.require_admin(request)
    data = await main.read_json_body(request)
    try:
        updated = update_quiz(quiz_id, data)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not updated:
        raise HTTPException(404, "퀴즈를 찾을 수 없습니다.")
    category = str(data.get("category") or updated.get("category") or "").strip()
    r1 = str(data.get("rank1_title") or "").strip()
    r2 = str(data.get("rank2_title") or "").strip()
    r3 = str(data.get("rank3_title") or "").strip()
    ic = str(data.get("icon") or "").strip()
    if category and (r1 or r2 or r3 or ic):
        save_quiz_subject_titles(category, rank1_title=r1, rank2_title=r2, rank3_title=r3, icon=ic)
    return {"status": "ok", "quiz": updated}


@router.delete("/api/admin/quiz/{quiz_id}")
async def api_admin_quiz_delete(quiz_id: int, request: Request):
    if not main.request_origin_is_allowed(request):
        raise HTTPException(403, "허용되지 않은 요청입니다.")
    main.require_admin(request)
    success = delete_quiz(quiz_id)
    if not success:
        raise HTTPException(404, "퀴즈를 찾을 수 없습니다.")
    return {"status": "ok", "deleted_quiz_id": quiz_id}


@router.get("/api/quiz/images/{filename}")
async def api_quiz_image(filename: str, request: Request):
    main.request_user(request)
    safe_name = Path(filename).name
    img_path = main.QUIZ_IMAGES_DIR / safe_name
    if not img_path.exists() or not img_path.is_file():
        raise HTTPException(404, "이미지를 찾을 수 없습니다.")
    return FileResponse(img_path)

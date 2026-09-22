"""Educational quiz database operations and queries."""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional, Set

from app.db.connection import get_connection, utc_now
from app.db.quiz_data import (
    DEFAULT_SAMPLE_QUIZZES,
    QUIZ_EXPERTISES,
    QUIZ_SUBJECT_TITLES,
    normalize_quiz_expertise,
)
from app.db.streak import (
    get_active_streak_cutoff_date,
    is_streak_active,
    should_continue_streak,
)


def save_quiz_subject_titles(
    category: str,
    rank1_title: str = "",
    rank2_title: str = "",
    rank3_title: str = "",
    icon: Optional[str] = None,
    conn: Optional[sqlite3.Connection] = None,
) -> Dict[str, Any]:
    """Save or update custom 1st, 2nd, 3rd place titles and icon for a quiz subject/category."""
    cat = normalize_quiz_expertise(category)
    r1 = str(rank1_title or "").strip()
    r2 = str(rank2_title or "").strip()
    r3 = str(rank3_title or "").strip()
    if not r1:
        r1 = f"{cat}의 신"
    if not r2:
        r2 = f"{cat} 고인물"
    if not r3:
        r3 = f"{cat} 조교"
    ic = str(icon or "").strip() or "📚"
    now = utc_now()
    if conn is not None:
        conn.execute(
            """
            INSERT INTO quiz_subject_titles
            (category, icon, rank1_title, rank2_title, rank3_title, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(category) DO UPDATE SET
                icon = excluded.icon,
                rank1_title = excluded.rank1_title,
                rank2_title = excluded.rank2_title,
                rank3_title = excluded.rank3_title,
                updated_at = excluded.updated_at
        """,
            (cat, ic, r1, r2, r3, now, now),
        )
    else:
        with get_connection() as local_conn:
            local_conn.execute(
                """
                INSERT INTO quiz_subject_titles
                (category, icon, rank1_title, rank2_title, rank3_title, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(category) DO UPDATE SET
                    icon = excluded.icon,
                    rank1_title = excluded.rank1_title,
                    rank2_title = excluded.rank2_title,
                    rank3_title = excluded.rank3_title,
                    updated_at = excluded.updated_at
            """,
                (cat, ic, r1, r2, r3, now, now),
            )
            local_conn.commit()
    return {
        "category": cat,
        "icon": ic,
        "rank1_title": r1,
        "rank2_title": r2,
        "rank3_title": r3,
    }


def get_quiz_subject_titles(category: str) -> Optional[Dict[str, Any]]:
    """Retrieve custom titles for a category from DB, fallback to QUIZ_SUBJECT_TITLES."""
    if not category:
        return None
    try:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT category, icon, rank1_title, rank2_title, rank3_title FROM quiz_subject_titles WHERE category = ?",
                (category,),
            ).fetchone()
            if row:
                return dict(row)
    except Exception:
        pass
    if category in QUIZ_SUBJECT_TITLES:
        ic, r3, r2, r1 = QUIZ_SUBJECT_TITLES[category]
        return {
            "category": category,
            "icon": ic,
            "rank1_title": r1,
            "rank2_title": r2,
            "rank3_title": r3,
        }
    return {
        "category": category,
        "icon": "📚",
        "rank1_title": f"{category} 고인물",
        "rank2_title": f"{category} 좀 함",
        "rank3_title": f"{category} 찍먹",
    }


def get_all_quiz_subject_titles() -> Dict[str, Dict[str, Any]]:
    """Return dictionary of all registered quiz subject titles keyed by category."""
    results: Dict[str, Dict[str, Any]] = {}
    for cat, (ic, r3, r2, r1) in QUIZ_SUBJECT_TITLES.items():
        results[cat] = {
            "category": cat,
            "icon": ic,
            "rank1_title": r1,
            "rank2_title": r2,
            "rank3_title": r3,
        }
    try:
        with get_connection() as conn:
            rows = conn.execute(
                "SELECT category, icon, rank1_title, rank2_title, rank3_title FROM quiz_subject_titles"
            ).fetchall()
            for r in rows:
                results[r["category"]] = dict(r)

            try:
                set_rows = conn.execute(
                    """SELECT expertise as category, icon, rank1_title, rank2_title, rank3_title
                       FROM user_quiz_sets
                       WHERE expertise IS NOT NULL AND trim(expertise) != ''
                       ORDER BY updated_at ASC"""
                ).fetchall()
                for r in set_rows:
                    cat = (r["category"] or "").strip()
                    if not cat:
                        continue
                    if cat not in results:
                        results[cat] = {
                            "category": cat,
                            "icon": (r["icon"] or "").strip() or "📚",
                            "rank1_title": (r["rank1_title"] or "").strip() or f"{cat}의 신",
                            "rank2_title": (r["rank2_title"] or "").strip() or f"{cat} 고인물",
                            "rank3_title": (r["rank3_title"] or "").strip() or f"{cat} 조교",
                        }
                    else:
                        if (r["icon"] or "").strip():
                            results[cat]["icon"] = r["icon"].strip()
                        if (r["rank1_title"] or "").strip():
                            results[cat]["rank1_title"] = r["rank1_title"].strip()
                        if (r["rank2_title"] or "").strip():
                            results[cat]["rank2_title"] = r["rank2_title"].strip()
                        if (r["rank3_title"] or "").strip():
                            results[cat]["rank3_title"] = r["rank3_title"].strip()
            except Exception:
                pass
    except Exception:
        pass
    return results


def get_all_quiz_categories() -> List[str]:
    """Returns an ordered, deduplicated list of all quiz categories/expertises.
    Preserves default base topics (QUIZ_EXPERTISES) first, then appends custom
    categories from quizzes, user_quiz_sets, and quiz_subject_titles.
    """
    base = [c.strip() for c in QUIZ_EXPERTISES if c and c.strip()]
    seen = set(base)
    custom: List[str] = []

    try:
        with get_connection() as conn:
            # 1. From quizzes
            rows = conn.execute(
                "SELECT DISTINCT category FROM quizzes WHERE category IS NOT NULL AND trim(category) != ''"
            ).fetchall()
            for r in rows:
                cat = (r["category"] or "").strip()
                if cat and cat not in seen:
                    seen.add(cat)
                    custom.append(cat)

            # 2. From user_quiz_sets
            try:
                rows = conn.execute(
                    "SELECT DISTINCT expertise FROM user_quiz_sets WHERE expertise IS NOT NULL AND trim(expertise) != ''"
                ).fetchall()
                for r in rows:
                    cat = (r["expertise"] or "").strip()
                    if cat and cat not in seen:
                        seen.add(cat)
                        custom.append(cat)
            except Exception:
                pass

            # 3. From quiz_subject_titles
            try:
                rows = conn.execute(
                    "SELECT DISTINCT category FROM quiz_subject_titles WHERE category IS NOT NULL AND trim(category) != ''"
                ).fetchall()
                for r in rows:
                    cat = (r["category"] or "").strip()
                    if cat and cat not in seen:
                        seen.add(cat)
                        custom.append(cat)
            except Exception:
                pass
    except Exception:
        pass

    custom.sort()
    return base + custom


def _subject_quiz_badge(
    category: Optional[str], subject_rank: int, subject_score: int
) -> Optional[Dict[str, Any]]:
    if not category or subject_rank not in {1, 2, 3}:
        return None
    info = get_quiz_subject_titles(category)
    icon = info.get("icon", "📚") if info else "📚"
    if subject_rank == 1:
        label = info.get("rank1_title", f"{category} 고인물") if info else f"{category} 고인물"
    elif subject_rank == 2:
        label = info.get("rank2_title", f"{category} 좀 함") if info else f"{category} 좀 함"
    else:
        label = info.get("rank3_title", f"{category} 찍먹") if info else f"{category} 찍먹"
    return {
        "type": "subject",
        "icon": icon,
        "label": label,
        "title": f"{category} {subject_rank}위 · {subject_score}점",
    }


def normalize_quiz_import(items: Any, expertise: str) -> List[Dict[str, Any]]:
    expertise = normalize_quiz_expertise(expertise)
    if not isinstance(items, list) or not 1 <= len(items) <= 50:
        raise ValueError("퀴즈는 1~50문항의 JSON 배열이어야 합니다.")
    normalized = []
    seen_questions = set()
    for index, raw in enumerate(items, start=1):
        if not isinstance(raw, dict):
            raise ValueError(f"{index}번 문항은 JSON 객체여야 합니다.")
        question = str(raw.get("question", "")).strip()
        difficulty = str(raw.get("difficulty", "medium"))
        question_type = str(raw.get("question_type", "multiple_choice"))
        answers = raw.get("correct_answers")
        options = raw.get("options")
        if not question or len(question) > 4000:
            raise ValueError(f"{index}번 문항의 문제 본문이 비어 있거나 너무 깁니다.")
        question_key = " ".join(question.casefold().split())
        if question_key in seen_questions:
            raise ValueError(f"{index}번 문항은 문제집 안의 다른 문항과 중복됩니다.")
        seen_questions.add(question_key)
        if raw.get("image_filename") or raw.get("image_url") or "![" in question:
            raise ValueError(
                f"{index}번 문항은 이미지를 사용할 수 없습니다. ASCII 도면을 코드 블록으로 넣어 주세요."
            )
        if difficulty not in {"easy", "medium", "hard"}:
            raise ValueError(f"{index}번 문항의 난이도가 올바르지 않습니다.")
        if question_type not in {"multiple_choice", "short_answer", "ladder_input"}:
            raise ValueError(f"{index}번 문항의 유형이 올바르지 않습니다.")
        if not isinstance(answers, list) or not answers or any(not str(answer).strip() for answer in answers):
            raise ValueError(f"{index}번 문항에는 correct_answers 배열이 필요합니다.")
        clean_answers = [str(answer).strip() for answer in answers]
        clean_options = [str(option).strip() for option in options] if isinstance(options, list) else None
        if question_type == "multiple_choice":
            if not clean_options or len(clean_options) != 4:
                raise ValueError(f"{index}번 객관식 문항은 정확히 보기 4개가 필요합니다.")
            if any(not option for option in clean_options):
                raise ValueError(f"{index}번 객관식 문항에는 빈 보기가 없어야 합니다.")
            if len({option.casefold() for option in clean_options}) != 4:
                raise ValueError(f"{index}번 객관식 문항의 보기는 서로 달라야 합니다.")
            valid_answers = {str(number) for number in range(1, 5)} | {
                option.casefold() for option in clean_options
            }
            if not any(answer.casefold() in valid_answers for answer in clean_answers):
                raise ValueError(f"{index}번 객관식 문항의 정답이 보기 1~4 또는 보기 본문과 일치해야 합니다.")
        normalized.append(
            {
                "category": expertise,
                "difficulty": difficulty,
                "question_type": question_type,
                "question": question,
                "options": clean_options,
                "correct_answers": clean_answers,
                "hint": str(raw.get("hint", "")).strip()[:1000],
                "explanation": str(raw.get("explanation", "")).strip()[:4000],
                "source_ref": str(raw.get("source_ref", "")).strip()[:500],
                "author_name": str(raw.get("author_name") or raw.get("author") or "").strip()[:80],
            }
        )
    return normalized


def analyze_quiz_set(items: Any, expertise: str) -> Dict[str, Any]:
    """Run advisory duplicate-similarity and multiple-choice answer-bias checks."""
    quizzes = normalize_quiz_import(items, expertise)

    def similarity_text(value: str) -> str:
        value = re.sub(r"```[\s\S]*?```", " ", value.casefold())
        return re.sub(r"[^0-9a-z가-힣]+", "", value)

    with get_connection() as conn:
        existing_rows = conn.execute(
            "SELECT id, category, question FROM quizzes WHERE is_active=1"
        ).fetchall()
    existing = [
        (row["id"], row["category"], row["question"], similarity_text(row["question"]))
        for row in existing_rows
    ]
    similarities = []
    for index, quiz in enumerate(quizzes, start=1):
        candidate = similarity_text(quiz["question"])
        if not candidate:
            continue
        best = None
        for quiz_id, category, question, normalized in existing:
            if not normalized:
                continue
            ratio = SequenceMatcher(None, candidate, normalized).ratio()
            if best is None or ratio > best["similarity"]:
                best = {
                    "candidate_index": index,
                    "existing_quiz_id": quiz_id,
                    "existing_category": category,
                    "existing_question": question[:160],
                    "similarity": ratio,
                }
        if best and best["similarity"] >= 0.65:
            best["similarity"] = round(best["similarity"] * 100, 1)
            similarities.append(best)

    answer_counts = {str(number): 0 for number in range(1, 5)}
    multiple_choice_count = 0
    for quiz in quizzes:
        if quiz["question_type"] != "multiple_choice":
            continue
        multiple_choice_count += 1
        answer_number = None
        for answer in quiz["correct_answers"]:
            match = re.match(r"^([1-4])(?:번|[.)\s]|$)", answer)
            if match:
                answer_number = match.group(1)
                break
            for option_index, option in enumerate(quiz["options"] or [], start=1):
                if answer.casefold() == option.casefold():
                    answer_number = str(option_index)
                    break
            if answer_number:
                break
        if answer_number:
            answer_counts[answer_number] += 1

    dominant_option = max(answer_counts, key=answer_counts.get) if multiple_choice_count else None
    dominant_count = answer_counts.get(dominant_option, 0) if dominant_option else 0
    dominant_ratio = dominant_count / multiple_choice_count if multiple_choice_count else 0
    bias_warning = multiple_choice_count >= 4 and dominant_ratio >= 0.6
    warnings = []
    if similarities:
        warnings.append(f"기존 DB와 65% 이상 유사한 문항이 {len(similarities)}개 있습니다.")
    if bias_warning:
        warnings.append(f"객관식 정답의 {round(dominant_ratio * 100)}%가 {dominant_option}번에 몰려 있습니다.")
    return {
        "valid": True,
        "question_count": len(quizzes),
        "similarities": similarities,
        "answer_bias": {
            "multiple_choice_count": multiple_choice_count,
            "counts": answer_counts,
            "dominant_option": dominant_option,
            "dominant_ratio": round(dominant_ratio * 100, 1),
            "warning": bias_warning,
        },
        "warnings": warnings,
    }


def create_user_quiz_set(
    owner_user_id: int,
    expertise: str,
    title: str,
    items: Any,
    rank1_title: str = "",
    rank2_title: str = "",
    rank3_title: str = "",
    icon: str = "",
) -> Dict[str, Any]:
    title = title.strip()
    if not 2 <= len(title) <= 80:
        raise ValueError("문제집 제목은 2~80자여야 합니다.")
    quizzes = normalize_quiz_import(items, expertise)
    expertise = quizzes[0]["category"]
    now = utc_now()
    r1 = rank1_title.strip()
    r2 = rank2_title.strip()
    r3 = rank3_title.strip()
    ic = icon.strip()
    with get_connection() as conn:
        cur = conn.execute(
            """INSERT INTO user_quiz_sets
            (owner_user_id, expertise, title, status, quizzes_json, rank1_title, rank2_title, rank3_title, icon, created_at, updated_at)
            VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)""",
            (
                owner_user_id,
                expertise,
                title,
                json.dumps(quizzes, ensure_ascii=False),
                r1,
                r2,
                r3,
                ic,
                now,
                now,
            ),
        )
        conn.commit()
        return get_user_quiz_set(int(cur.lastrowid), owner_user_id)


def update_user_quiz_set(
    set_id: int,
    owner_user_id: int,
    expertise: str,
    title: str,
    items: Any,
    rank1_title: Optional[str] = None,
    rank2_title: Optional[str] = None,
    rank3_title: Optional[str] = None,
    icon: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    title = title.strip()
    if not 2 <= len(title) <= 80:
        raise ValueError("문제집 제목은 2~80자여야 합니다.")
    quizzes = normalize_quiz_import(items, expertise)
    expertise = quizzes[0]["category"]
    now = utc_now()
    with get_connection() as conn:
        row = conn.execute(
            "SELECT rank1_title, rank2_title, rank3_title, icon FROM user_quiz_sets WHERE id=? AND owner_user_id=?",
            (set_id, owner_user_id),
        ).fetchone()
        r1 = rank1_title.strip() if rank1_title is not None else ((row["rank1_title"] or "") if row else "")
        r2 = rank2_title.strip() if rank2_title is not None else ((row["rank2_title"] or "") if row else "")
        r3 = rank3_title.strip() if rank3_title is not None else ((row["rank3_title"] or "") if row else "")
        ic = icon.strip() if icon is not None else ((row["icon"] or "") if row else "")
        cur = conn.execute(
            """UPDATE user_quiz_sets
            SET expertise=?, title=?, quizzes_json=?, rank1_title=?, rank2_title=?, rank3_title=?, icon=?, status='draft', review_note='',
                submitted_at=NULL, updated_at=?
            WHERE id=? AND owner_user_id=? AND status IN ('draft','rejected')""",
            (
                expertise,
                title,
                json.dumps(quizzes, ensure_ascii=False),
                r1,
                r2,
                r3,
                ic,
                now,
                set_id,
                owner_user_id,
            ),
        )
        conn.commit()
        return get_user_quiz_set(set_id, owner_user_id) if cur.rowcount else None


def get_user_quiz_set(set_id: int, owner_user_id: Optional[int] = None) -> Optional[Dict[str, Any]]:
    with get_connection() as conn:
        params: List[Any] = [set_id]
        where = "id=?"
        if owner_user_id is not None:
            where += " AND owner_user_id=?"
            params.append(owner_user_id)
        row = conn.execute(f"SELECT * FROM user_quiz_sets WHERE {where}", params).fetchone()
        if not row:
            return None
        data = dict(row)
        data["quizzes"] = json.loads(data.pop("quizzes_json"))
        return data


def list_user_quiz_sets(
    owner_user_id: Optional[int] = None, status: Optional[str] = None
) -> List[Dict[str, Any]]:
    with get_connection() as conn:
        clauses, params = [], []
        if owner_user_id is not None:
            clauses.append("s.owner_user_id=?")
            params.append(owner_user_id)
        if status:
            clauses.append("s.status=?")
            params.append(status)
        where = "WHERE " + " AND ".join(clauses) if clauses else ""
        rows = conn.execute(
            f"""SELECT s.*, u.username, u.display_name FROM user_quiz_sets s
            JOIN users u ON u.id=s.owner_user_id {where} ORDER BY s.id DESC""",
            params,
        ).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["quizzes"] = json.loads(item.pop("quizzes_json"))
            result.append(item)
        return result


def submit_user_quiz_set(set_id: int, owner_user_id: int) -> bool:
    now = utc_now()
    with get_connection() as conn:
        cur = conn.execute(
            """UPDATE user_quiz_sets SET status='pending_review', submitted_at=?, updated_at=?
            WHERE id=? AND owner_user_id=? AND status IN ('draft','rejected')""",
            (now, now, set_id, owner_user_id),
        )
        conn.commit()
        return cur.rowcount > 0


def review_user_quiz_set(
    set_id: int,
    admin_user_id: int,
    approve: bool,
    note: str = "",
    items: Any = None,
    expertise: Optional[str] = None,
    title: Optional[str] = None,
    rank1_title: Optional[str] = None,
    rank2_title: Optional[str] = None,
    rank3_title: Optional[str] = None,
    icon: Optional[str] = None,
) -> List[int]:
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM user_quiz_sets WHERE id=?", (set_id,)).fetchone()
        if not row or row["status"] != "pending_review":
            raise ValueError("검토 대기 중인 문제집이 아닙니다.")
        quizzes = json.loads(row["quizzes_json"])
        if approve and items is not None:
            clean_title = str(title if title is not None else row["title"]).strip()
            if not 2 <= len(clean_title) <= 80:
                raise ValueError("문제집 제목은 2~80자여야 합니다.")
            clean_expertise = str(expertise if expertise is not None else row["expertise"])
            quizzes = normalize_quiz_import(items, clean_expertise)
            clean_expertise = quizzes[0]["category"]
            conn.execute(
                "UPDATE user_quiz_sets SET expertise=?, title=?, quizzes_json=?, updated_at=? WHERE id=?",
                (
                    clean_expertise,
                    clean_title,
                    json.dumps(quizzes, ensure_ascii=False),
                    utc_now(),
                    set_id,
                ),
            )
        created_ids: List[int] = []
        now = utc_now()
        status = "approved" if approve else "rejected"
        if approve:
            owner_row = conn.execute(
                "SELECT id, username, display_name FROM users WHERE id=?", (row["owner_user_id"],)
            ).fetchone()
            owner_name = (
                (owner_row["display_name"] or owner_row["username"]) if owner_row else "대나무숲 회원"
            )
            for quiz in quizzes:
                duplicate = conn.execute(
                    "SELECT 1 FROM quizzes WHERE category=? AND lower(trim(question))=lower(trim(?)) LIMIT 1",
                    (quiz["category"], quiz["question"]),
                ).fetchone()
                if duplicate:
                    raise ValueError(f"공용 풀에 이미 존재하는 문항입니다: {quiz['question'][:80]}")
                item_author = quiz.get("author_name") or owner_name
                cur = conn.execute(
                    """INSERT INTO quizzes
                    (category,difficulty,question_type,question,image_filename,options_json,
                     correct_answers_json,hint,explanation,source_ref,is_active,created_at,source_submission_set_id,
                     author_id, author_name)
                    VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)""",
                    (
                        quiz["category"],
                        quiz["difficulty"],
                        quiz["question_type"],
                        quiz["question"],
                        "",
                        json.dumps(quiz.get("options"), ensure_ascii=False) if quiz.get("options") else None,
                        json.dumps(quiz["correct_answers"], ensure_ascii=False),
                        quiz.get("hint", ""),
                        quiz.get("explanation", ""),
                        quiz.get("source_ref", ""),
                        now,
                        set_id,
                        row["owner_user_id"],
                        item_author,
                    ),
                )
                created_ids.append(int(cur.lastrowid))

            # Register category custom titles if present in submission
            row_keys = row.keys() if hasattr(row, "keys") else []
            r1 = (
                rank1_title.strip()
                if rank1_title is not None
                else ((row["rank1_title"] or "").strip() if "rank1_title" in row_keys else "")
            )
            r2 = (
                rank2_title.strip()
                if rank2_title is not None
                else ((row["rank2_title"] or "").strip() if "rank2_title" in row_keys else "")
            )
            r3 = (
                rank3_title.strip()
                if rank3_title is not None
                else ((row["rank3_title"] or "").strip() if "rank3_title" in row_keys else "")
            )
            ic = (
                icon.strip()
                if icon is not None
                else ((row["icon"] or "").strip() if "icon" in row_keys else "")
            )
            if r1 or r2 or r3 or ic:
                save_quiz_subject_titles(quizzes[0]["category"], r1, r2, r3, ic, conn=conn)

        conn.execute(
            """UPDATE user_quiz_sets
            SET status=?, review_note=?, approved_by_user_id=?, approved_at=?, updated_at=? WHERE id=?""",
            (status, note[:1000], admin_user_id, now if approve else None, now, set_id),
        )
        conn.commit()
    return created_ids


def update_pending_user_quiz_set(
    set_id: int,
    expertise: str,
    title: str,
    items: Any,
    rank1_title: Optional[str] = None,
    rank2_title: Optional[str] = None,
    rank3_title: Optional[str] = None,
    icon: Optional[str] = None,
) -> Dict[str, Any]:
    """Allow an administrator to correct a submission before making a review decision."""
    title = title.strip()
    if not 2 <= len(title) <= 80:
        raise ValueError("문제집 제목은 2~80자여야 합니다.")
    quizzes = normalize_quiz_import(items, expertise)
    expertise = quizzes[0]["category"]
    with get_connection() as conn:
        row = conn.execute(
            "SELECT rank1_title, rank2_title, rank3_title, icon FROM user_quiz_sets WHERE id=?",
            (set_id,),
        ).fetchone()
        r1 = rank1_title.strip() if rank1_title is not None else ((row["rank1_title"] or "") if row else "")
        r2 = rank2_title.strip() if rank2_title is not None else ((row["rank2_title"] or "") if row else "")
        r3 = rank3_title.strip() if rank3_title is not None else ((row["rank3_title"] or "") if row else "")
        ic = icon.strip() if icon is not None else ((row["icon"] or "") if row else "")
        cur = conn.execute(
            """UPDATE user_quiz_sets
            SET expertise=?, title=?, quizzes_json=?, rank1_title=?, rank2_title=?, rank3_title=?, icon=?, updated_at=?
            WHERE id=? AND status='pending_review'""",
            (
                expertise,
                title,
                json.dumps(quizzes, ensure_ascii=False),
                r1,
                r2,
                r3,
                ic,
                utc_now(),
                set_id,
            ),
        )
        conn.commit()
        if not cur.rowcount:
            raise ValueError("검토 대기 중인 문제집이 아닙니다.")
    updated = get_user_quiz_set(set_id)
    if not updated:
        raise ValueError("문제집을 찾을 수 없습니다.")
    return updated


def ensure_daily_quiz_set(
    assigned_date: str, count: int = 5, created_by_user_id: Optional[int] = None
) -> int:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT id FROM daily_quiz_sets WHERE assigned_date=?", (assigned_date,)
        ).fetchone()
        if row:
            return int(row["id"])

        # 1. Prefer active quizzes never used in any daily set
        unused_rows = conn.execute(
            """
            SELECT q.id FROM quizzes q
            WHERE q.is_active = 1 AND NOT EXISTS (
                SELECT 1 FROM daily_quiz_set_items used WHERE used.quiz_id = q.id
            ) ORDER BY q.id ASC LIMIT ?
        """,
            (count,),
        ).fetchall()

        selected_ids = [int(r["id"]) for r in unused_rows]

        # 2. If fewer than count unused quizzes exist, fill up with least-frequently / oldest assigned quizzes
        if len(selected_ids) < count:
            needed = count - len(selected_ids)
            placeholders = ",".join("?" for _ in selected_ids) if selected_ids else "0"
            recycled_rows = conn.execute(
                f"""
                SELECT q.id, COUNT(dqi.set_id) as times_used, MAX(dqs.assigned_date) as last_assigned
                FROM quizzes q
                LEFT JOIN daily_quiz_set_items dqi ON dqi.quiz_id = q.id
                LEFT JOIN daily_quiz_sets dqs ON dqs.id = dqi.set_id
                WHERE q.is_active = 1 AND q.id NOT IN ({placeholders})
                GROUP BY q.id
                ORDER BY times_used ASC, last_assigned ASC, q.id ASC
                LIMIT ?
            """,
                (*selected_ids, needed) if selected_ids else (needed,),
            ).fetchall()
            selected_ids.extend([int(r["id"]) for r in recycled_rows])

        if not selected_ids:
            return 0

        now = utc_now()
        cur = conn.execute(
            "INSERT INTO daily_quiz_sets (assigned_date, status, created_by_user_id, created_at) VALUES (?,'published',?,?)",
            (assigned_date, created_by_user_id, now),
        )
        set_id = int(cur.lastrowid)
        conn.executemany(
            "INSERT INTO daily_quiz_set_items (set_id, quiz_id, position, points) VALUES (?,?,?,20)",
            [(set_id, qid, index) for index, qid in enumerate(selected_ids, start=1)],
        )
        conn.commit()
        return set_id


def assign_daily_quizzes(assigned_date: str, quiz_ids: List[int], admin_user_id: int) -> int:
    if not quiz_ids or len(quiz_ids) > 20:
        raise ValueError("1~20개의 문제를 배정하세요.")
    if assigned_date < datetime.now().strftime("%Y-%m-%d"):
        raise ValueError("과거 날짜에는 퀴즈를 게시할 수 없습니다.")
    with get_connection() as conn:
        if conn.execute(
            "SELECT 1 FROM daily_quiz_sets WHERE assigned_date=?", (assigned_date,)
        ).fetchone():
            raise ValueError("해당 날짜의 퀴즈 세트가 이미 게시되었습니다.")
    with get_connection() as conn:
        valid = {
            r["id"]
            for r in conn.execute(
                f"""SELECT q.id FROM quizzes q
            WHERE q.is_active=1 AND q.id IN ({','.join('?' for _ in quiz_ids)})
              AND NOT EXISTS (SELECT 1 FROM daily_quiz_set_items used WHERE used.quiz_id=q.id)""",
                quiz_ids,
            )
        }
        if len(valid) != len(set(quiz_ids)):
            raise ValueError("유효하지 않은 퀴즈가 포함되어 있습니다.")
        now = utc_now()
        cur = conn.execute(
            "INSERT INTO daily_quiz_sets (assigned_date,status,created_by_user_id,created_at) VALUES (?,'published',?,?)",
            (assigned_date, admin_user_id, now),
        )
        set_id = int(cur.lastrowid)
        conn.executemany(
            "INSERT INTO daily_quiz_set_items (set_id,quiz_id,position,points) VALUES (?,?,?,20)",
            [(set_id, qid, i) for i, qid in enumerate(quiz_ids, 1)],
        )
        conn.commit()
        return set_id


def seed_default_quizzes(conn: Optional[sqlite3.Connection] = None) -> None:
    """Seeds default educational quizzes if the quizzes table is empty."""

    def _seed(c: sqlite3.Connection) -> None:
        count = c.execute("SELECT COUNT(*) FROM quizzes").fetchone()[0]
        if count > 0:
            return
        now = utc_now()
        for q in DEFAULT_SAMPLE_QUIZZES:
            opts = json.dumps(q.get("options"), ensure_ascii=False) if q.get("options") else None
            corrects = json.dumps(q.get("correct_answers", []), ensure_ascii=False)
            c.execute(
                """INSERT INTO quizzes
                (category, difficulty, question_type, question, image_filename,
                 options_json, correct_answers_json, hint, explanation, source_ref,
                 is_active, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)""",
                (
                    q.get("category", "PLC"),
                    q.get("difficulty", "medium"),
                    q.get("question_type", "multiple_choice"),
                    q["question"],
                    q.get("image_filename", ""),
                    opts,
                    corrects,
                    q.get("hint", ""),
                    q.get("explanation", ""),
                    q.get("source_ref", ""),
                    now,
                ),
            )

    if conn is not None:
        _seed(conn)
    else:
        with get_connection() as c:
            _seed(c)


def save_quiz_source_document(
    filename: str,
    stored_filename: str,
    file_type: str,
    sha256: str,
    size: int,
    uploaded_by_user_id: Optional[int] = None,
) -> int:
    """Saves metadata for an uploaded lecture PDF or question document."""
    now = utc_now()
    with get_connection() as conn:
        cur = conn.execute(
            """INSERT INTO quiz_source_documents
            (filename, stored_filename, file_type, sha256, size, uploaded_by_user_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (filename, stored_filename, file_type, sha256, size, uploaded_by_user_id, now),
        )
        return int(cur.lastrowid)


def get_quiz_source_documents() -> List[Dict[str, Any]]:
    """Returns a list of all uploaded quiz source documents."""
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT d.*, u.username as uploader_username, u.display_name as uploader_display_name,
                   (SELECT COUNT(*) FROM quizzes q WHERE q.source_doc_id = d.id) as generated_quizzes_count
            FROM quiz_source_documents d
            LEFT JOIN users u ON d.uploaded_by_user_id = u.id
            ORDER BY d.id DESC
        """
        ).fetchall()
        return [dict(r) for r in rows]


def create_quiz(
    category: str,
    difficulty: str,
    question_type: str,
    question: str,
    correct_answers: List[str],
    options: Optional[List[str]] = None,
    image_filename: Optional[str] = None,
    hint: str = "",
    explanation: str = "",
    source_doc_id: Optional[int] = None,
    source_ref: str = "",
    daily_date: Optional[str] = None,
    author_id: Optional[int] = None,
    author_name: str = "대나무숲 공식",
) -> int:
    """Creates a new quiz item."""
    now = utc_now()
    opts_json = json.dumps(options, ensure_ascii=False) if options else None
    corrects_json = json.dumps(correct_answers, ensure_ascii=False)
    with get_connection() as conn:
        cur = conn.execute(
            """INSERT INTO quizzes
            (category, difficulty, question_type, question, image_filename,
             options_json, correct_answers_json, hint, explanation, source_doc_id,
             source_ref, daily_date, is_active, created_at, author_id, author_name)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)""",
            (
                category,
                difficulty,
                question_type,
                question,
                image_filename or "",
                opts_json,
                corrects_json,
                hint,
                explanation,
                source_doc_id,
                source_ref,
                daily_date,
                now,
                author_id,
                author_name or "대나무숲 공식",
            ),
        )
        return int(cur.lastrowid)


def create_quiz_batch(
    quizzes_data: List[Dict[str, Any]],
    source_doc_id: Optional[int] = None,
    author_id: Optional[int] = None,
    author_name: str = "",
) -> List[int]:
    """Bulk creates multiple quizzes from AI or JSON import."""
    now = utc_now()
    created_ids: List[int] = []
    with get_connection() as conn:
        for q in quizzes_data:
            opts = q.get("options")
            opts_json = json.dumps(opts, ensure_ascii=False) if opts else None
            corrects = q.get("correct_answers") or [q.get("answer", "")]
            if isinstance(corrects, str):
                corrects = [corrects]
            corrects_json = json.dumps(corrects, ensure_ascii=False)
            item_author = q.get("author_name") or author_name or "대나무숲 공식"
            item_author_id = q.get("author_id") or author_id
            cur = conn.execute(
                """INSERT INTO quizzes
                (category, difficulty, question_type, question, image_filename,
                 options_json, correct_answers_json, hint, explanation, source_doc_id,
                 source_ref, daily_date, is_active, created_at, author_id, author_name)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)""",
                (
                    q.get("category", "PLC"),
                    q.get("difficulty", "medium"),
                    q.get("question_type", "multiple_choice"),
                    q.get("question", ""),
                    q.get("image_filename", "") or q.get("image_url", ""),
                    opts_json,
                    corrects_json,
                    q.get("hint", ""),
                    q.get("explanation", ""),
                    source_doc_id,
                    q.get("source_ref", ""),
                    q.get("daily_date"),
                    now,
                    item_author_id,
                    item_author,
                ),
            )
            created_ids.append(int(cur.lastrowid))
    return created_ids


def update_quiz(quiz_id: int, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Update an existing quiz while retaining its identity, attempts, and set membership."""
    category = str(data.get("category", "")).strip()
    if not category or len(category) > 80:
        raise ValueError("과목은 1~80자여야 합니다.")
    normalized = normalize_quiz_import([data], "PLC")[0]
    normalized["category"] = category
    image_filename = str(data.get("image_filename", "")).strip()[:500]
    is_active = 1 if data.get("is_active", True) else 0
    author_name = str(data.get("author_name") or normalized.get("author_name") or "").strip()[:80]
    with get_connection() as conn:
        update_author_sql = ", author_name=?" if author_name else ""
        params = [
            normalized["category"],
            normalized["difficulty"],
            normalized["question_type"],
            normalized["question"],
            image_filename,
            json.dumps(normalized.get("options"), ensure_ascii=False) if normalized.get("options") else None,
            json.dumps(normalized["correct_answers"], ensure_ascii=False),
            normalized.get("hint", ""),
            normalized.get("explanation", ""),
            normalized.get("source_ref", ""),
            is_active,
        ]
        if author_name:
            params.append(author_name)
        params.append(quiz_id)
        cur = conn.execute(
            f"""UPDATE quizzes SET
            category=?, difficulty=?, question_type=?, question=?, image_filename=?,
            options_json=?, correct_answers_json=?, hint=?, explanation=?, source_ref=?, is_active=?{update_author_sql}
            WHERE id=?""",
            params,
        )
        conn.commit()
        if not cur.rowcount:
            return None
    return get_quiz_by_id_admin(quiz_id)


def get_quiz_by_id_admin(quiz_id: int) -> Optional[Dict[str, Any]]:
    """Returns a single quiz with options, correct answers, and flag count."""
    with get_connection() as conn:
        r = conn.execute(
            """
            SELECT q.*, d.filename as source_doc_filename,
                   (SELECT COUNT(*) FROM quiz_flags f WHERE f.quiz_id = q.id AND f.status = 'open') as open_flags_count
            FROM quizzes q
            LEFT JOIN quiz_source_documents d ON q.source_doc_id = d.id
            WHERE q.id = ?
        """,
            (quiz_id,),
        ).fetchone()
        if not r:
            return None
        d = dict(r)
        d["options"] = json.loads(d["options_json"]) if d["options_json"] else None
        d["correct_answers"] = json.loads(d["correct_answers_json"]) if d["correct_answers_json"] else []
        d["open_flags_count"] = d.get("open_flags_count", 0) or 0
        return d


def get_all_quizzes_admin(
    search: str = "",
    category: str = "",
    flagged_only: bool = False,
    limit: int = 200,
    offset: int = 0,
) -> List[Dict[str, Any]]:
    """Returns quizzes for management view with search, category filtering, and open flag counts."""
    with get_connection() as conn:
        conditions = ["q.is_active = 1"]
        params: List[Any] = []

        if category and category.strip():
            conditions.append("q.category = ?")
            params.append(category.strip())

        if search and search.strip():
            kw = f"%{search.strip()}%"
            conditions.append(
                "(q.question LIKE ? OR q.correct_answers_json LIKE ? OR q.explanation LIKE ? OR CAST(q.id AS TEXT) = ?)"
            )
            params.extend([kw, kw, kw, search.strip()])

        where_clause = " AND ".join(conditions)
        having_clause = "HAVING open_flags_count > 0" if flagged_only else ""

        sql = f"""
            SELECT q.*, d.filename as source_doc_filename,
                   COUNT(CASE WHEN f.status = 'open' THEN 1 END) as open_flags_count,
                   GROUP_CONCAT(CASE WHEN f.status = 'open' THEN f.reason_type || ': ' || f.comment END, ' || ') as flag_summaries
            FROM quizzes q
            LEFT JOIN quiz_source_documents d ON q.source_doc_id = d.id
            LEFT JOIN quiz_flags f ON q.id = f.quiz_id
            WHERE {where_clause}
            GROUP BY q.id
            {having_clause}
            ORDER BY open_flags_count DESC, q.id DESC
            LIMIT ? OFFSET ?
        """
        params.extend([limit, offset])
        rows = conn.execute(sql, params).fetchall()
        results = []
        for r in rows:
            d = dict(r)
            d["options"] = json.loads(d["options_json"]) if d["options_json"] else None
            d["correct_answers"] = json.loads(d["correct_answers_json"]) if d["correct_answers_json"] else []
            d["open_flags_count"] = d.get("open_flags_count", 0) or 0
            d["author_name"] = d.get("author_name") or "대나무숲 공식"
            results.append(d)
        return results


def flag_quiz_question(
    quiz_id: int, user_id: int, reason_type: str, comment: str = ""
) -> Dict[str, Any]:
    """Records a question error/dispute flag submitted by a student."""
    now = utc_now()
    reason = str(reason_type or "other").strip()[:50]
    note = str(comment or "").strip()[:500]
    with get_connection() as conn:
        quiz = conn.execute("SELECT id FROM quizzes WHERE id = ?", (quiz_id,)).fetchone()
        if not quiz:
            raise ValueError(f"Quiz #{quiz_id} not found.")

        existing = conn.execute(
            "SELECT id FROM quiz_flags WHERE quiz_id = ? AND user_id = ? AND status = 'open'",
            (quiz_id, user_id),
        ).fetchone()

        if existing:
            conn.execute(
                "UPDATE quiz_flags SET reason_type = ?, comment = ?, created_at = ? WHERE id = ?",
                (reason, note, now, existing["id"]),
            )
            flag_id = existing["id"]
        else:
            cur = conn.execute(
                "INSERT INTO quiz_flags (quiz_id, user_id, reason_type, comment, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)",
                (quiz_id, user_id, reason, note, now),
            )
            flag_id = cur.lastrowid
        conn.commit()
        return {"flag_id": flag_id, "quiz_id": quiz_id, "status": "open"}


def get_quiz_flags(
    quiz_id: Optional[int] = None, status: Optional[str] = "open"
) -> List[Dict[str, Any]]:
    """Fetches question error reports."""
    with get_connection() as conn:
        conditions = []
        params: List[Any] = []
        if quiz_id is not None:
            conditions.append("f.quiz_id = ?")
            params.append(quiz_id)
        if status:
            conditions.append("f.status = ?")
            params.append(status)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        rows = conn.execute(
            f"""
            SELECT f.*, u.username, u.display_name, q.category, q.question
            FROM quiz_flags f
            JOIN users u ON f.user_id = u.id
            JOIN quizzes q ON f.quiz_id = q.id
            {where}
            ORDER BY f.id DESC
        """,
            params,
        ).fetchall()
        return [dict(r) for r in rows]


def resolve_quiz_flag(flag_id: int, resolved_by_user_id: int) -> bool:
    """Marks a reported issue as resolved."""
    now = utc_now()
    with get_connection() as conn:
        cur = conn.execute(
            "UPDATE quiz_flags SET status = 'resolved', resolved_at = ?, resolved_by_user_id = ? WHERE id = ?",
            (now, resolved_by_user_id, flag_id),
        )
        conn.commit()
        return cur.rowcount > 0


def delete_quiz(quiz_id: int) -> bool:
    """Deletes or archives a quiz."""
    with get_connection() as conn:
        if conn.execute("SELECT 1 FROM daily_quiz_set_items WHERE quiz_id=?", (quiz_id,)).fetchone():
            return False
        cur = conn.execute("DELETE FROM quizzes WHERE id = ?", (quiz_id,))
        return cur.rowcount > 0


def toggle_quiz_bookmark(user_id: int, quiz_id: int) -> bool:
    """Toggles a bookmark/star for a quiz by the given user. Returns True if now bookmarked."""
    now = utc_now()
    with get_connection() as conn:
        existing = conn.execute(
            "SELECT id FROM quiz_bookmarks WHERE user_id = ? AND quiz_id = ?",
            (user_id, quiz_id),
        ).fetchone()
        if existing:
            conn.execute("DELETE FROM quiz_bookmarks WHERE id = ?", (existing["id"],))
            return False
        else:
            conn.execute(
                "INSERT INTO quiz_bookmarks (user_id, quiz_id, created_at) VALUES (?, ?, ?)",
                (user_id, quiz_id, now),
            )
            return True


def get_user_quiz_bookmarks_set(user_id: int) -> Set[int]:
    """Returns the set of quiz IDs bookmarked by the user."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT quiz_id FROM quiz_bookmarks WHERE user_id = ?", (user_id,)
        ).fetchall()
        return {r["quiz_id"] for r in rows}


def get_quiz_categories_summary() -> List[Dict[str, Any]]:
    """Returns unique categories and their active quiz counts with title information."""
    titles_map = get_all_quiz_subject_titles()
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT category, COUNT(*) as count
            FROM quizzes
            WHERE is_active = 1
            GROUP BY category
            ORDER BY count DESC, category ASC
        """
        ).fetchall()
        results = []
        for r in rows:
            item = dict(r)
            cat = item["category"]
            t = titles_map.get(cat) or get_quiz_subject_titles(cat) or {}
            item["icon"] = t.get("icon") or "📚"
            item["rank1_title"] = t.get("rank1_title") or f"{cat}의 신"
            item["rank2_title"] = t.get("rank2_title") or f"{cat} 고인물"
            item["rank3_title"] = t.get("rank3_title") or f"{cat} 조교"
            results.append(item)
        return results


def get_quiz_sidebar_counts(user_id: int) -> Dict[str, int]:
    """Returns count stats for sidebar badges (wrong, starred, history/solved)."""
    with get_connection() as conn:
        total_quizzes = conn.execute("SELECT COUNT(*) FROM quizzes WHERE is_active = 1").fetchone()[0]
        wrong_count = conn.execute(
            """
            SELECT COUNT(DISTINCT q.id)
            FROM quizzes q
            JOIN quiz_submissions qs ON q.id = qs.quiz_id
            WHERE qs.user_id = ? AND (qs.is_correct = 0 OR qs.had_wrong_attempt = 1) AND q.is_active = 1
        """,
            (user_id,),
        ).fetchone()[0]
        starred_count = conn.execute(
            """
            SELECT COUNT(DISTINCT q.id)
            FROM quizzes q
            JOIN quiz_bookmarks qb ON q.id = qb.quiz_id
            WHERE qb.user_id = ? AND q.is_active = 1
        """,
            (user_id,),
        ).fetchone()[0]
        history_count = conn.execute(
            """
            SELECT COUNT(DISTINCT q.id)
            FROM quizzes q
            JOIN quiz_submissions qs ON q.id = qs.quiz_id
            WHERE qs.user_id = ? AND q.is_active = 1
        """,
            (user_id,),
        ).fetchone()[0]
        return {
            "total_quizzes": total_quizzes,
            "wrong": wrong_count,
            "starred": starred_count,
            "history": history_count,
        }


def get_daily_quizzes(
    user_id: int,
    count: int = 5,
    category: Optional[str] = None,
    offset: int = 0,
    exclude_ids: Optional[List[int]] = None,
) -> List[Dict[str, Any]]:
    """Returns active educational quizzes with the current user's submission & bookmark state.
    Supports topic category filtering or 'random'/'all' modes.
    """
    daily_set_id = (
        ensure_daily_quiz_set(datetime.now().strftime("%Y-%m-%d"), count=count)
        if not category or category == "daily"
        else None
    )
    with get_connection() as conn:
        starred_set = get_user_quiz_bookmarks_set(user_id)
        where_clause = "WHERE q.is_active = 1"
        params: List[Any] = [user_id]

        is_random = category in ("random", "all_random", "all")

        if category and category not in ("all", "random", "all_random", "daily"):
            where_clause += " AND q.category = ?"
            params.append(category)

        excluded = sorted({int(value) for value in (exclude_ids or []) if int(value) > 0})
        if excluded:
            where_clause += f" AND q.id NOT IN ({','.join('?' for _ in excluded)})"
            params.extend(excluded)

        daily_join = ""
        if daily_set_id is not None:
            daily_join = "JOIN daily_quiz_set_items dqi ON dqi.quiz_id=q.id"
            where_clause += " AND dqi.set_id = ?"
            params.append(daily_set_id)
            order_by = "ORDER BY dqi.position ASC"
        else:
            if is_random:
                order_by = "ORDER BY CASE WHEN qs.id IS NULL THEN 0 ELSE 1 END, RANDOM()"
            else:
                order_by = "ORDER BY CASE WHEN qs.id IS NULL THEN 0 ELSE 1 END, CASE q.difficulty WHEN 'easy' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, q.id ASC"

        actual_offset = max(0, int(offset))
        if excluded and actual_offset == len(excluded):
            actual_offset = 0
        params.extend([count, actual_offset])

        query = f"""
            SELECT q.id, q.category, q.difficulty, q.question_type, q.question,
                   q.image_filename, q.options_json, q.correct_answers_json,
                   q.hint, q.explanation, q.source_ref, q.daily_date,
                   q.author_name, q.author_id,
                   qs.id as submission_id, qs.user_answer, qs.is_correct,
                   qs.score_earned, qs.submitted_at
            FROM quizzes q
            {daily_join}
            LEFT JOIN quiz_submissions qs ON q.id = qs.quiz_id AND qs.user_id = ?
            {where_clause}
            {order_by}
            LIMIT ? OFFSET ?
        """
        rows = conn.execute(query, tuple(params)).fetchall()

        quizzes = []
        for r in rows:
            is_solved = r["submission_id"] is not None
            options = json.loads(r["options_json"]) if r["options_json"] else None
            item: Dict[str, Any] = {
                "id": r["id"],
                "category": r["category"],
                "difficulty": r["difficulty"],
                "question_type": r["question_type"],
                "question": r["question"],
                "image_filename": r["image_filename"] or "",
                "options": options,
                "hint": r["hint"] or "",
                "source_ref": r["source_ref"] or "",
                "author_name": r["author_name"] or "대나무숲 공식",
                "author_id": r["author_id"],
                "is_solved": is_solved,
                "is_starred": r["id"] in starred_set,
            }
            if is_solved:
                item["user_answer"] = r["user_answer"]
                item["is_correct"] = bool(r["is_correct"])
                item["score_earned"] = r["score_earned"]
                item["submitted_at"] = r["submitted_at"]
                item["correct_answers"] = json.loads(r["correct_answers_json"])
                item["explanation"] = r["explanation"]
            else:
                item["user_answer"] = None
                item["is_correct"] = None
                item["score_earned"] = 0
            quizzes.append(item)
        return quizzes


def get_quiz_review_list(user_id: int, mode: str = "wrong") -> List[Dict[str, Any]]:
    """Returns quizzes for review: 'wrong' (quizzes ever attempted incorrectly), 'starred' (bookmarks), or 'history' (all solved)."""
    with get_connection() as conn:
        starred_set = get_user_quiz_bookmarks_set(user_id)
        if mode == "wrong":
            rows = conn.execute(
                """
                SELECT q.id, q.category, q.difficulty, q.question_type, q.question,
                       q.image_filename, q.options_json, q.correct_answers_json,
                       q.hint, q.explanation, q.source_ref, q.author_name, q.author_id,
                       qs.id as submission_id, qs.user_answer, qs.is_correct,
                       qs.score_earned, qs.submitted_at, qs.had_wrong_attempt
                FROM quiz_submissions qs
                JOIN quizzes q ON qs.quiz_id = q.id
                WHERE qs.user_id = ? AND (qs.is_correct = 0 OR qs.had_wrong_attempt = 1)
                ORDER BY qs.id DESC
            """,
                (user_id,),
            ).fetchall()
        elif mode == "starred":
            rows = conn.execute(
                """
                SELECT q.id, q.category, q.difficulty, q.question_type, q.question,
                       q.image_filename, q.options_json, q.correct_answers_json,
                       q.hint, q.explanation, q.source_ref, q.author_name, q.author_id,
                       qs.id as submission_id, qs.user_answer, qs.is_correct,
                       qs.score_earned, qs.submitted_at, qs.had_wrong_attempt
                FROM quiz_bookmarks qb
                JOIN quizzes q ON qb.quiz_id = q.id
                LEFT JOIN quiz_submissions qs ON q.id = qs.quiz_id AND qs.user_id = ?
                WHERE qb.user_id = ?
                ORDER BY qb.id DESC
            """,
                (user_id, user_id),
            ).fetchall()
        else:  # 'history' / all
            rows = conn.execute(
                """
                SELECT q.id, q.category, q.difficulty, q.question_type, q.question,
                       q.image_filename, q.options_json, q.correct_answers_json,
                       q.hint, q.explanation, q.source_ref, q.author_name, q.author_id,
                       qs.id as submission_id, qs.user_answer, qs.is_correct,
                       qs.score_earned, qs.submitted_at, qs.had_wrong_attempt
                FROM quiz_submissions qs
                JOIN quizzes q ON qs.quiz_id = q.id
                WHERE qs.user_id = ?
                ORDER BY qs.id DESC
            """,
                (user_id,),
            ).fetchall()

        results = []
        for r in rows:
            is_solved = r["submission_id"] is not None
            options = json.loads(r["options_json"]) if r["options_json"] else None
            had_wrong = (
                bool(r["had_wrong_attempt"])
                if "had_wrong_attempt" in r.keys() and r["had_wrong_attempt"] is not None
                else False
            )
            item: Dict[str, Any] = {
                "id": r["id"],
                "category": r["category"],
                "difficulty": r["difficulty"],
                "question_type": r["question_type"],
                "question": r["question"],
                "image_filename": r["image_filename"] or "",
                "options": options,
                "hint": r["hint"] or "",
                "source_ref": r["source_ref"] or "",
                "author_name": r["author_name"] or "대나무숲 공식",
                "author_id": r["author_id"],
                "is_solved": is_solved,
                "is_starred": r["id"] in starred_set,
                "had_wrong": had_wrong,
                "is_mastered": bool(r["is_correct"]) if is_solved and had_wrong else False,
                "user_answer": r["user_answer"] if is_solved else None,
                "is_correct": bool(r["is_correct"]) if is_solved else None,
                "score_earned": r["score_earned"] if is_solved else 0,
                "submitted_at": r["submitted_at"] if is_solved else None,
                "correct_answers": json.loads(r["correct_answers_json"]) if is_solved else [],
                "explanation": r["explanation"] if is_solved else "",
            }
            results.append(item)
        return results


def retry_quiz_answer(user_id: int, quiz_id: int, user_answer: str) -> Dict[str, Any]:
    """Allows repeating a wrong or saved quiz in practice mode and updates review state while preserving wrong history."""
    from app.quiz_ai import check_quiz_answer

    today_str = datetime.now().strftime("%Y-%m-%d")
    now = utc_now()

    with get_connection() as conn:
        quiz_row = conn.execute("SELECT * FROM quizzes WHERE id = ?", (quiz_id,)).fetchone()
        if not quiz_row:
            raise ValueError("존재하지 않는 퀴즈입니다.")

        correct_answers: List[str] = json.loads(quiz_row["correct_answers_json"])
        is_correct = 1 if check_quiz_answer(correct_answers, user_answer) else 0

        # Update or insert practice submission while preserving had_wrong_attempt
        existing = conn.execute(
            "SELECT id, had_wrong_attempt, is_correct FROM quiz_submissions WHERE quiz_id = ? AND user_id = ?",
            (quiz_id, user_id),
        ).fetchone()

        if existing:
            had_wrong = 1 if (existing["had_wrong_attempt"] or existing["is_correct"] == 0 or is_correct == 0) else 0
            conn.execute(
                """UPDATE quiz_submissions SET
                user_answer = ?, is_correct = ?, submitted_at = ?, had_wrong_attempt = ?
                WHERE id = ?""",
                (user_answer, is_correct, now, had_wrong, existing["id"]),
            )
        else:
            conn.execute(
                """INSERT INTO quiz_submissions
                (quiz_id, user_id, user_answer, is_correct, score_earned, submitted_at, submitted_date, had_wrong_attempt)
                VALUES (?, ?, ?, ?, 0, ?, ?, ?)""",
                (quiz_id, user_id, user_answer, is_correct, now, today_str, 1 if is_correct == 0 else 0),
            )

        stats = get_user_quiz_stats(user_id)
        return {
            "is_correct": bool(is_correct),
            "score_earned": 0,
            "correct_answers": correct_answers,
            "explanation": quiz_row["explanation"] or "",
            "source_ref": quiz_row["source_ref"] or "",
            "user_stats": stats,
        }


def submit_quiz_answer(user_id: int, quiz_id: int, user_answer: str) -> Dict[str, Any]:
    """Evaluates the submitted answer, updates streaks/scores, and returns detailed results."""
    from app.quiz_ai import check_quiz_answer

    today_str = datetime.now().strftime("%Y-%m-%d")
    now = utc_now()

    with get_connection() as conn:
        quiz_row = conn.execute(
            "SELECT * FROM quizzes WHERE id = ? AND is_active = 1", (quiz_id,)
        ).fetchone()
        if not quiz_row:
            raise ValueError("존재하지 않거나 비활성화된 퀴즈입니다.")

        today_set = conn.execute(
            "SELECT id FROM daily_quiz_sets WHERE assigned_date=? AND status='published'", (today_str,)
        ).fetchone()
        assigned = (
            today_set
            and conn.execute(
                "SELECT 1 FROM daily_quiz_set_items WHERE set_id=? AND quiz_id=?",
                (today_set["id"], quiz_id),
            ).fetchone()
        )
        is_daily_quiz = bool(assigned)

        # Check existing submission
        existing = conn.execute(
            "SELECT id FROM quiz_submissions WHERE quiz_id = ? AND user_id = ?",
            (quiz_id, user_id),
        ).fetchone()
        if existing:
            raise ValueError("이미 제출 완료된 문제입니다.")

        correct_answers: List[str] = json.loads(quiz_row["correct_answers_json"])
        is_correct = 1 if check_quiz_answer(correct_answers, user_answer) else 0

        # Score calculation
        score_earned = (
            {"easy": 10, "medium": 20, "hard": 30}.get(quiz_row["difficulty"], 20)
            if is_correct
            else 0
        )

        # Insert submission
        conn.execute(
            """INSERT INTO quiz_submissions
            (quiz_id, user_id, user_answer, is_correct, score_earned, submitted_at, submitted_date, had_wrong_attempt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                quiz_id,
                user_id,
                user_answer,
                is_correct,
                score_earned,
                now,
                today_str,
                1 if is_correct == 0 else 0,
            ),
        )

        # Update or create user stats
        stats_row = conn.execute(
            "SELECT * FROM user_quiz_stats WHERE user_id = ?", (user_id,)
        ).fetchone()

        if stats_row:
            last_date = stats_row["last_solved_date"]
            curr_streak = stats_row["current_streak"]
            max_streak = stats_row["max_streak"]

            streak = curr_streak
            next_last_date = last_date
            if is_daily_quiz:
                if last_date == today_str:
                    streak = curr_streak
                elif should_continue_streak(last_date, today_str):
                    streak = curr_streak + 1
                else:
                    streak = 1
                max_streak = max(max_streak, streak)
                next_last_date = today_str
            total_score = stats_row["total_score"] + score_earned
            weekly_score = stats_row["weekly_score"] + score_earned
            total_solved = stats_row["total_solved"] + 1
            total_correct = stats_row["total_correct"] + is_correct

            conn.execute(
                """UPDATE user_quiz_stats SET
                total_score = ?, total_solved = ?, total_correct = ?,
                current_streak = ?, max_streak = ?, weekly_score = ?,
                last_solved_date = ?
                WHERE user_id = ?""",
                (
                    total_score,
                    total_solved,
                    total_correct,
                    streak,
                    max_streak,
                    weekly_score,
                    next_last_date,
                    user_id,
                ),
            )
        else:
            streak = 1 if is_daily_quiz else 0
            max_streak = streak
            total_score = score_earned
            weekly_score = score_earned
            total_solved = 1
            total_correct = is_correct

            conn.execute(
                """INSERT INTO user_quiz_stats
                (user_id, total_score, total_solved, total_correct,
                 current_streak, max_streak, weekly_score, last_solved_date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    user_id,
                    total_score,
                    total_solved,
                    total_correct,
                    streak,
                    max_streak,
                    weekly_score,
                    today_str if is_daily_quiz else None,
                ),
            )

        return {
            "quiz_id": quiz_id,
            "is_correct": bool(is_correct),
            "score_earned": score_earned,
            "correct_answers": correct_answers,
            "explanation": quiz_row["explanation"],
            "source_ref": quiz_row["source_ref"],
            "user_stats": {
                "current_streak": streak,
                "max_streak": max_streak,
                "total_score": total_score,
                "weekly_score": weekly_score,
                "total_solved": total_solved,
                "total_correct": total_correct,
            },
        }


def get_user_quiz_stats(user_id: int) -> Dict[str, Any]:
    """Returns user quiz performance summary and rank."""
    from app.db.games import get_user_quiz_badge

    with get_connection() as conn:
        row = conn.execute("SELECT * FROM user_quiz_stats WHERE user_id = ?", (user_id,)).fetchone()

        if not row:
            return {
                "user_id": user_id,
                "total_score": 0,
                "weekly_score": 0,
                "current_streak": 0,
                "max_streak": 0,
                "total_solved": 0,
                "total_correct": 0,
                "accuracy": 0.0,
                "badge": None,
            }

        data = dict(row)
        solved = data.get("total_solved", 0)
        correct = data.get("total_correct", 0)
        data["accuracy"] = round((correct / solved * 100), 1) if solved > 0 else 0.0
        data["badge"] = get_user_quiz_badge(user_id)
        return data


def get_quiz_subject_leaderboard(category: str, limit: int = 20) -> List[Dict[str, Any]]:
    """Return ranking for a specific quiz subject."""
    with get_connection() as conn:
        rows = conn.execute(
            """
            WITH subject_scores AS (
                SELECT qs.user_id,
                       SUM(qs.score_earned) AS score,
                       SUM(CASE WHEN qs.score_earned > 0 THEN 1 ELSE 0 END) as correct_count,
                       COUNT(qs.id) as solved_count,
                       MAX(qs.submitted_at) AS score_reached_at
                FROM quiz_submissions qs
                JOIN quizzes q ON q.id = qs.quiz_id
                WHERE q.category = ? AND qs.score_earned > 0
                GROUP BY qs.user_id
            ), ranked AS (
                SELECT ss.user_id, u.username, u.display_name,
                       ss.score, ss.correct_count, ss.solved_count, ss.score_reached_at,
                       COALESCE(st.current_streak, 0) as current_streak,
                       ROW_NUMBER() OVER (
                           ORDER BY ss.score DESC, ss.score_reached_at ASC, ss.user_id ASC
                       ) AS rank
                FROM subject_scores ss
                JOIN users u ON u.id = ss.user_id
                LEFT JOIN user_quiz_stats st ON st.user_id = ss.user_id
            )
            SELECT user_id, username, display_name, score, correct_count,
                   solved_count, current_streak, score_reached_at, rank
            FROM ranked
            ORDER BY rank ASC
            LIMIT ?
        """,
            (category, limit),
        ).fetchall()

    results = []
    for r in rows:
        item = dict(r)
        item["badge"] = _subject_quiz_badge(category, item["rank"], item["score"])
        results.append(item)
    return results


def get_quiz_leaderboard(period: str = "weekly", limit: int = 20) -> List[Dict[str, Any]]:
    """Returns top ranked users for daily, weekly, or all-time educational quizzes."""
    today_str = datetime.now().strftime("%Y-%m-%d")
    week_start = (datetime.now() - timedelta(days=datetime.now().weekday())).strftime("%Y-%m-%d")
    if period == "streak":
        cutoff_date = get_active_streak_cutoff_date()
        with get_connection() as conn:
            rows = conn.execute(
                """SELECT st.user_id, u.username, u.display_name,
                       st.total_score AS score, st.total_correct AS correct_count,
                       st.total_solved AS solved_count, st.current_streak,
                       st.last_solved_date AS score_reached_at
                FROM user_quiz_stats st JOIN users u ON u.id=st.user_id
                WHERE st.current_streak >= 3 AND st.last_solved_date >= ?
                ORDER BY st.current_streak DESC, st.last_solved_date ASC, st.user_id ASC LIMIT ?""",
                (cutoff_date, limit),
            ).fetchall()
        filtered = [r for r in rows if is_streak_active(r["score_reached_at"], today_str)]
        return [{**dict(row), "rank": rank} for rank, row in enumerate(filtered, start=1)]
    with get_connection() as conn:
        date_clause, params = "", []
        if period == "daily":
            date_clause = "AND qs.submitted_date = ?"
            params.append(today_str)
        elif period != "all":
            date_clause = "AND qs.submitted_date >= ?"
            params.append(week_start)
        params.append(limit)
        rows = conn.execute(
            f"""
            SELECT qs.user_id, u.username, u.display_name,
                   SUM(qs.score_earned) as score,
                   SUM(CASE WHEN qs.score_earned > 0 THEN 1 ELSE 0 END) as correct_count,
                   COUNT(qs.id) as solved_count, COALESCE(st.current_streak,0) as current_streak,
                   COALESCE(MAX(CASE WHEN qs.score_earned > 0 THEN qs.submitted_at END), MIN(qs.submitted_at)) as score_reached_at
            FROM quiz_submissions qs
            JOIN users u ON u.id=qs.user_id
            LEFT JOIN user_quiz_stats st ON st.user_id=qs.user_id
            WHERE 1=1 {date_clause}
            GROUP BY qs.user_id
            ORDER BY score DESC, score_reached_at ASC, qs.user_id ASC LIMIT ?
        """,
            params,
        ).fetchall()

        results = []
        for rank, r in enumerate(rows, start=1):
            item = dict(r)
            item["rank"] = rank
            results.append(item)
        return results

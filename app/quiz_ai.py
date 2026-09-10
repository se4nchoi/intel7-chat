"""Educational Quiz AI generation and answer normalization for BambooChat.

Supports Gemini 2.5/1.5 Flash API with PDF/text inputs and structured outputs,
as well as fallback mock generation and answer tolerance checking.
"""
from __future__ import annotations

import base64
import json
import os
import re
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple


def normalize_quiz_answer(ans: str) -> str:
    """Normalizes an answer string for robust comparison (handles whitespace, casing, prefixes, PLC addresses)."""
    if not ans:
        return ""
    text = str(ans).strip().upper()
    # Strip surrounding quotes and backticks
    text = re.sub(r"^[\"\'`“”‘’]+|[\"\'`“”‘’]+$", "", text)
    # Strip common answer prefixes like '답:', '정답:', '답변:'
    text = re.sub(r"^(정답|답|답변|ANS|ANSWER)\s*[:：]?\s*", "", text, flags=re.IGNORECASE)
    # Strip trailing punctuation (.,;!?)
    text = text.rstrip(".,;!? ")
    # Handle option numbers like '1번' -> '1'
    m = re.match(r"^(\d+)\s*번$", text)
    if m:
        text = m.group(1)
    # Collapse internal whitespace
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _extract_candidates(cand: str) -> List[str]:
    """Splits candidates with commas/slashes and extracts parenthetical aliases."""
    results = [cand]
    # Split on commas or slashes if not a pure number or date
    parts = re.split(r"[,/]", cand)
    if len(parts) > 1:
        for p in parts:
            p_strip = p.strip()
            if p_strip:
                results.append(p_strip)
    # Extract parenthetical synonyms: e.g. "릴레이 (Relay)" -> ["릴레이", "Relay"]
    for item in list(results):
        paren_match = re.search(r"^(.*?)\s*[\(\（](.*?)[\)\）]\s*$", item)
        if paren_match:
            base = paren_match.group(1).strip()
            inside = paren_match.group(2).strip()
            if base:
                results.append(base)
            if inside:
                results.append(inside)
    # Deduplicate while preserving order
    seen = set()
    deduped = []
    for r in results:
        if r not in seen:
            seen.add(r)
            deduped.append(r)
    return deduped


def check_quiz_answer(correct_answers: List[str], user_answer: str) -> bool:
    """Checks if user's answer matches any accepted correct answers with smart tolerance."""
    norm_user = normalize_quiz_answer(user_answer)
    if not norm_user:
        return False
    user_no_space = norm_user.replace(" ", "")

    COMMON_SUFFIXES = ("회로", "방식", "제어", "센서", "스위치", "모듈", "소자", "게이트")

    # Expand candidates (handling commas, slashes, parenthetical aliases)
    all_candidates: List[str] = []
    for c in correct_answers:
        for sub in _extract_candidates(c):
            all_candidates.append(normalize_quiz_answer(sub))

    for norm_cand in all_candidates:
        if not norm_cand:
            continue
        cand_no_space = norm_cand.replace(" ", "")

        # 1. Exact match or space-collapsed match (e.g. "자기유지회로" == "자기 유지 회로")
        if norm_user == norm_cand or user_no_space == cand_no_space:
            return True

        # 2. Option prefix matching: '1. AND' matches '1' or 'AND'
        opt_match = re.match(r"^(\d+)[\.\)]\s*(.+)$", norm_cand)
        if opt_match:
            num, body = opt_match.group(1), opt_match.group(2).strip()
            if norm_user == num or user_no_space == body.replace(" ", ""):
                return True

        # 3. PLC addresses: X0 matches X000 / X00
        plc_m1 = re.match(r"^([XYZMKDT])0*(\d+)$", norm_user)
        plc_m2 = re.match(r"^([XYZMKDT])0*(\d+)$", norm_cand)
        if plc_m1 and plc_m2:
            if plc_m1.group(1) == plc_m2.group(1) and plc_m1.group(2) == plc_m2.group(2):
                return True

        # 4. Korean technical term suffix tolerance (e.g. "인터록" <-> "인터록 회로")
        for sfx in COMMON_SUFFIXES:
            if cand_no_space.endswith(sfx) and len(cand_no_space) > len(sfx):
                stem = cand_no_space[:-len(sfx)]
                if user_no_space == stem:
                    return True
            if user_no_space.endswith(sfx) and len(user_no_space) > len(sfx):
                stem = user_no_space[:-len(sfx)]
                if cand_no_space == stem:
                    return True

        # 5. Korean particle ending on user input (e.g. "인터록은", "인터록이다", "인터록임")
        if len(user_no_space) > 2:
            user_stem = re.sub(r"(은|는|이|가|을|를|이다|임|에)$", "", user_no_space)
            if user_stem == cand_no_space:
                return True

        # 6. Unit tolerance: 100V == 100, 5S == 5초
        UNIT_MAP = {
            "S": "SEC", "SEC": "SEC", "초": "SEC",
            "MS": "MS", "밀리초": "MS",
            "V": "V", "볼트": "V",
            "A": "A", "암페어": "A",
            "W": "W", "와트": "W",
            "옴": "OHM", "OHM": "OHM",
            "HZ": "HZ", "헤르츠": "HZ",
            "%": "%", "프로": "%", "퍼센트": "%",
        }
        unit_m_cand = re.match(r"^(\d+(?:\.\d+)?)\s*(V|A|W|옴|OHM|초|S|SEC|MS|HZ|%|K|볼트|암페어|와트|헤르츠|밀리초|프로|퍼센트)?$", cand_no_space)
        unit_m_user = re.match(r"^(\d+(?:\.\d+)?)\s*(V|A|W|옴|OHM|초|S|SEC|MS|HZ|%|K|볼트|암페어|와트|헤르츠|밀리초|프로|퍼센트)?$", user_no_space)
        if unit_m_cand and unit_m_user:
            if unit_m_cand.group(1) == unit_m_user.group(1):
                u_cand = UNIT_MAP.get(unit_m_cand.group(2) or "", unit_m_cand.group(2) or "")
                u_user = UNIT_MAP.get(unit_m_user.group(2) or "", unit_m_user.group(2) or "")
                if not u_cand or not u_user or u_cand == u_user:
                    return True

    return False




QUIZ_SYSTEM_PROMPT = """당신은 직업훈련 및 공학 교육(PLC, 시퀀스 제어, 전기/전자, CBT 자격증) 전문 AI 교육자입니다.
제공된 강의 자료(PDF, 텍스트, 교재 문서)에 엄격히 근거(Grounding)하여 학생들의 복습과 평가를 위한 고품질 퀴즈를 출제합니다.

[출제 가이드라인]
1. 교재에 언급되지 않은 외부 내용은 절대 추측하거나 날조하지 마십시오 (Zero Hallucination).
2. PLC 래더 다이어그램(Ladder Logic), 시퀀스 명령어, 기출문제 용어는 표준 표기법(X, Y, M, T, C 등)을 준수하십시오.
3. 문제는 객관식(multiple_choice), 단답형(short_answer), 래더 명령어 입력형(ladder_input)을 골고루 섞어 출제하십시오.
4. 객관식의 경우 보기(options)는 4지선다형으로 '1. ...', '2. ...' 형태로 제공하십시오.
5. 정답(correct_answers)은 학생이 입력할 수 있는 유효한 동의어(예: ['X0', 'X000', 'LD X0'])를 배열에 모두 포함하십시오.
6. 해설(explanation)과 출처(source_ref, 예: '4강 시퀀스 기초 p.12')를 상세히 작성하십시오.
"""

QUIZ_JSON_SCHEMA = {
    "type": "ARRAY",
    "items": {
        "type": "OBJECT",
        "properties": {
            "category": {"type": "STRING"},
            "difficulty": {"type": "STRING", "enum": ["easy", "medium", "hard"]},
            "question_type": {"type": "STRING", "enum": ["multiple_choice", "short_answer", "ladder_input"]},
            "question": {"type": "STRING"},
            "options": {
                "type": "ARRAY",
                "items": {"type": "STRING"},
                "description": "객관식 보기 목록 (단답형인 경우 빈 배열 또는 null)"
            },
            "correct_answers": {
                "type": "ARRAY",
                "items": {"type": "STRING"},
                "description": "정답 및 허용 가능한 동의어 목록"
            },
            "hint": {"type": "STRING", "description": "문제 해결의 실마리를 잡을 수 있는 간결한 핵심 힌트"},
            "explanation": {"type": "STRING", "description": "상세한 풀이 및 해설"},
            "source_ref": {"type": "STRING", "description": "강의자료 출처 및 페이지"}
        },
        "required": ["category", "difficulty", "question_type", "question", "correct_answers", "explanation", "source_ref"]
    }
}


def generate_quizzes_with_gemini(
    api_key: str,
    raw_content: bytes | str,
    is_pdf: bool = False,
    count: int = 5,
    category: str = "PLC",
    model: str = "gemini-2.5-flash",
) -> List[Dict[str, Any]]:
    """Calls the Google Gemini API to generate structured educational quizzes from PDF or text."""
    if not api_key:
        raise ValueError("Gemini API 키가 설정되지 않았습니다.")

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"

    parts: List[Dict[str, Any]] = []

    prompt_text = (
        f"{QUIZ_SYSTEM_PROMPT}\n\n"
        f"첨부된 자료를 바탕으로 카테고리 '{category}' 관련 문제 {count}문항을 생성해 주세요."
    )
    parts.append({"text": prompt_text})

    if is_pdf:
        if isinstance(raw_content, str):
            pdf_bytes = raw_content.encode("utf-8")
        else:
            pdf_bytes = raw_content
        b64_data = base64.b64encode(pdf_bytes).decode("ascii")
        parts.append({
            "inline_data": {
                "mime_type": "application/pdf",
                "data": b64_data,
            }
        })
    else:
        text_data = raw_content.decode("utf-8", errors="ignore") if isinstance(raw_content, bytes) else str(raw_content)
        parts.append({
            "text": f"--- [강의자료 본문] ---\n{text_data}\n--- [강의자료 끝] ---"
        })

    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "response_mime_type": "application/json",
            "response_schema": QUIZ_JSON_SCHEMA,
            "temperature": 0.2,
        }
    }

    req_data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=req_data,
        headers={"Content-Type": "application/json"},
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            resp_body = resp.read().decode("utf-8")
            result = json.loads(resp_body)
            candidates = result.get("candidates", [])
            if not candidates:
                raise ValueError("Gemini API로부터 응답을 받지 못했습니다.")
            content_part = candidates[0].get("content", {}).get("parts", [{}])[0].get("text", "[]")
            quizzes = json.loads(content_part)
            if not isinstance(quizzes, list):
                quizzes = [quizzes]
            return quizzes
    except urllib.error.HTTPError as err:
        err_msg = err.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Gemini API 호출 실패 (HTTP {err.code}): {err_msg}")
    except Exception as exc:
        raise RuntimeError(f"퀴즈 생성 중 오류 발생: {exc}")

"""School day and streak calculation logic."""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Optional, Set, Union

# South Korean Statutory Holidays & Substitute Holidays (2025-2028)
KOREAN_PUBLIC_HOLIDAYS: Set[str] = {
    # 2025
    "2025-01-01",  # 신정
    "2025-01-27", "2025-01-28", "2025-01-29", "2025-01-30",  # 설날 연휴 및 대체공휴일
    "2025-03-01", "2025-03-03",  # 삼일절 및 대체공휴일
    "2025-05-05", "2025-05-06",  # 어린이날 및 부처님오신날 대체공휴일
    "2025-06-06",  # 현충일
    "2025-08-15",  # 광복절
    "2025-10-03",  # 개천절
    "2025-10-05", "2025-10-06", "2025-10-07", "2025-10-08",  # 추석 연휴 및 대체공휴일
    "2025-10-09",  # 한글날
    "2025-12-25",  # 성탄절

    # 2026
    "2026-01-01",  # 신정
    "2026-02-16", "2026-02-17", "2026-02-18",  # 설날 연휴
    "2026-03-01", "2026-03-02",  # 삼일절 및 대체공휴일
    "2026-05-05",  # 어린이날
    "2026-05-24", "2026-05-25",  # 부처님오신날 및 대체공휴일
    "2026-06-06",  # 현충일
    "2026-08-15", "2026-08-17",  # 광복절 및 대체공휴일
    "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27",  # 추석 연휴
    "2026-10-03", "2026-10-05",  # 개천절 및 대체공휴일
    "2026-10-09",  # 한글날
    "2026-12-25",  # 성탄절

    # 2027
    "2027-01-01",  # 신정
    "2027-02-06", "2027-02-07", "2027-02-08", "2027-02-09",  # 설날 연휴 및 대체공휴일
    "2027-03-01",  # 삼일절
    "2027-05-05",  # 어린이날
    "2027-05-13",  # 부처님오신날
    "2027-06-06",  # 현충일
    "2027-08-15", "2027-08-16",  # 광복절 및 대체공휴일
    "2027-09-14", "2027-09-15", "2027-09-16",  # 추석 연휴
    "2027-10-03", "2027-10-04",  # 개천절 및 대체공휴일
    "2027-10-09", "2027-10-11",  # 한글날 및 대체공휴일
    "2027-12-25", "2027-12-27",  # 성탄절 및 대체공휴일

    # 2028
    "2028-01-01",  # 신정
    "2028-01-26", "2028-01-27", "2028-01-28",  # 설날 연휴
    "2028-03-01",  # 삼일절
    "2028-05-02",  # 부처님오신날
    "2028-05-05",  # 어린이날
    "2028-06-06",  # 현충일
    "2028-08-15",  # 광복절
    "2028-10-02", "2028-10-03", "2028-10-04", "2028-10-05",  # 추석 연휴 및 개천절
    "2028-10-09",  # 한글날
    "2028-12-25",  # 성탄절
}

_SOLAR_FIXED_HOLIDAYS = {(1, 1), (3, 1), (5, 5), (6, 6), (8, 15), (10, 3), (10, 9), (12, 25)}


def is_school_day(d: Union[date, str]) -> bool:
    """Returns True if the date is a regular classroom attendance day (weekday and not a public holiday)."""
    if isinstance(d, str):
        d = date.fromisoformat(d)
    if d.weekday() >= 5:  # Saturday (5) or Sunday (6)
        return False
    d_str = d.strftime("%Y-%m-%d")
    if d_str in KOREAN_PUBLIC_HOLIDAYS:
        return False
    if (d.month, d.day) in _SOLAR_FIXED_HOLIDAYS:
        return False
    return True


def should_continue_streak(last_date_str: str, today_str: str) -> bool:
    """Returns True if all days strictly between last_date and today are non-school days
    (weekends or public holidays), meaning today is the next required attendance day."""
    if not last_date_str:
        return False
    try:
        last_d = date.fromisoformat(last_date_str)
        today_d = date.fromisoformat(today_str)
    except ValueError:
        return False

    if today_d <= last_d:
        return True

    curr = last_d + timedelta(days=1)
    while curr < today_d:
        if is_school_day(curr):
            return False
        curr += timedelta(days=1)
    return True


def is_streak_active(last_date_str: Optional[str], today_str: Optional[str] = None) -> bool:
    """Returns True if user's streak is still alive for today (not expired by a missed school day)."""
    if not last_date_str:
        return False
    if today_str is None:
        today_str = datetime.now().strftime("%Y-%m-%d")
    if last_date_str == today_str:
        return True
    return should_continue_streak(last_date_str, today_str)


def get_active_streak_cutoff_date(reference_date: Optional[date] = None) -> str:
    """Calculates the earliest acceptable last_solved_date for a streak to be considered active.
    Walks backwards from today over weekends and holidays to find the previous required attendance day."""
    ref = reference_date or date.today()
    curr = ref - timedelta(days=1)
    while curr > ref - timedelta(days=14):
        if is_school_day(curr):
            return curr.strftime("%Y-%m-%d")
        curr -= timedelta(days=1)
    return (ref - timedelta(days=3)).strftime("%Y-%m-%d")

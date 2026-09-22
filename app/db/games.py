"""Chess, Janggi, Omok, and user game badge database operations."""
from __future__ import annotations

import sqlite3
from typing import Any, Dict, List, Optional

from app.db.connection import get_connection, utc_now
from app.db.streak import is_streak_active

CHESS_TITLES = {
    1: ("👑", "체스의 신"),
    2: ("♟️", "체스킹"),
    3: ("♟️", "체스고인물"),
}


def _chess_badge(rank: int, wins: int) -> Optional[Dict[str, Any]]:
    if rank not in CHESS_TITLES:
        return None
    icon, label = CHESS_TITLES[rank]
    return {
        "type": "chess",
        "icon": icon,
        "label": label,
        "title": f"체스 {rank}위 · {wins}승",
    }


JANGGI_TITLES = {
    1: ("👑", "장기의 신"),
    2: ("🀄", "장기의 왕"),
    3: ("🀄", "장기고인물"),
}


def _janggi_badge(rank: int, wins: int) -> Optional[Dict[str, Any]]:
    if rank not in JANGGI_TITLES:
        return None
    icon, label = JANGGI_TITLES[rank]
    return {
        "type": "janggi",
        "icon": icon,
        "label": label,
        "title": f"장기 {rank}위 · {wins}승",
    }


OMOK_TITLES = {
    1: ("👑", "오목의 신"),
    2: ("⚫", "오목의 왕"),
    3: ("⚪", "오목고인물"),
}


def _omok_badge(rank: int, wins: int) -> Optional[Dict[str, Any]]:
    if rank not in OMOK_TITLES:
        return None
    icon, label = OMOK_TITLES[rank]
    return {
        "type": "omok",
        "icon": icon,
        "label": label,
        "title": f"오목 {rank}위 · {wins}승",
    }


OTHELLO_TITLES = {
    1: ("👑", "오셀로 신"),
    2: ("🟢", "오셀로 왕"),
    3: ("🟢", "오셀로고인물"),
}


def _othello_badge(rank: int, wins: int) -> Optional[Dict[str, Any]]:
    if rank not in OTHELLO_TITLES:
        return None
    icon, label = OTHELLO_TITLES[rank]
    return {
        "type": "othello",
        "icon": icon,
        "label": label,
        "title": f"오셀로 {rank}위 · {wins}승",
    }


PLAY_GOD_TITLE = ("👑", "놀이의 신")


def _play_god_badge(first_count: int) -> Dict[str, Any]:
    icon, label = PLAY_GOD_TITLE
    return {
        "type": "play_god",
        "icon": icon,
        "label": label,
        "title": f"놀이의 신 · {first_count}개 종목 1위",
    }


def get_play_god_qualifications(
    conn: sqlite3.Connection, user_ids: List[int]
) -> Dict[int, Dict[str, Any]]:
    """Determine which users qualify as '놀이의 신' across play disciplines.
    Condition: 1st place in all disciplines, or 1st in >= 3 disciplines (with tie-breaking by first_count).
    """
    if not user_ids:
        return {}
    disciplines = [
        ("chess", "chess_player_stats"),
        ("janggi", "janggi_player_stats"),
        ("omok", "omok_player_stats"),
        ("othello", "othello_player_stats"),
    ]
    total_disciplines = len(disciplines)
    results = {uid: {"first_count": 0, "disciplines": [], "is_god": False} for uid in user_ids}
    placeholders = ",".join("?" for _ in user_ids)
    for name, table in disciplines:
        row = conn.execute(
            f"""
            WITH ranked AS (
                SELECT user_id, wins,
                       ROW_NUMBER() OVER (ORDER BY wins DESC, last_win_at ASC, user_id ASC) AS rnk
                FROM {table}
                WHERE wins > 0
            )
            SELECT user_id FROM ranked WHERE rnk = 1 AND user_id IN ({placeholders})
        """,
            user_ids,
        ).fetchone()
        if row:
            uid = row["user_id"]
            if uid in results:
                results[uid]["first_count"] += 1
                results[uid]["disciplines"].append(name)
    for uid, data in results.items():
        fc = data["first_count"]
        if (total_disciplines >= 2 and fc >= total_disciplines) or fc >= 3:
            data["is_god"] = True
    return results


def record_chess_result(white_id: int, black_id: int, winner: Optional[str]) -> None:
    """Persist one completed chess result for both players."""
    now = utc_now()
    with get_connection() as conn:
        for user_id in (white_id, black_id):
            conn.execute("INSERT OR IGNORE INTO chess_player_stats (user_id) VALUES (?)", (user_id,))
        if winner in ("w", "b"):
            winner_id = white_id if winner == "w" else black_id
            loser_id = black_id if winner == "w" else white_id
            conn.execute(
                "UPDATE chess_player_stats SET wins = wins + 1, last_win_at = ? WHERE user_id = ?",
                (now, winner_id),
            )
            conn.execute(
                "UPDATE chess_player_stats SET losses = losses + 1 WHERE user_id = ?",
                (loser_id,),
            )
        else:
            conn.execute(
                "UPDATE chess_player_stats SET draws = draws + 1 WHERE user_id IN (?, ?)",
                (white_id, black_id),
            )


def get_chess_stats(user_id: int) -> Dict[str, int]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT wins, draws, losses FROM chess_player_stats WHERE user_id = ?", (user_id,)
        ).fetchone()
    return dict(row) if row else {"wins": 0, "draws": 0, "losses": 0}


def get_chess_rankings(limit: int = 20) -> List[Dict[str, Any]]:
    """Return top chess players sorted by wins (desc) and time achieved (asc)."""
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT ps.user_id, u.username, u.display_name,
                   ps.wins, ps.draws, ps.losses, ps.last_win_at,
                   ROW_NUMBER() OVER (
                       ORDER BY ps.wins DESC, ps.last_win_at ASC, ps.user_id ASC
                   ) AS rank
            FROM chess_player_stats ps
            JOIN users u ON u.id = ps.user_id
            WHERE ps.wins > 0
            ORDER BY rank ASC
            LIMIT ?
        """,
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def reset_chess_records() -> None:
    """Resets all chess player stats and clears existing chess win/loss/draw records."""
    with get_connection() as conn:
        conn.execute("DELETE FROM chess_player_stats")
        conn.execute("UPDATE users SET quiz_badge_selection = 'score' WHERE quiz_badge_selection = 'chess'")


def get_chess_leaderboard(limit: int = 20) -> List[Dict[str, Any]]:
    """Return enriched chess rankings with win rates and badges."""
    rankings = get_chess_rankings(limit=limit)
    results = []
    for r in rankings:
        rank = int(r["rank"])
        badge = _chess_badge(rank, int(r["wins"]))
        total = r["wins"] + r.get("draws", 0) + r.get("losses", 0)
        win_rate = round((r["wins"] / total * 100), 1) if total > 0 else 0.0
        results.append(
            {
                "user_id": r["user_id"],
                "username": r["username"],
                "display_name": r["display_name"],
                "rank": rank,
                "score": r["wins"],
                "wins": r["wins"],
                "draws": r.get("draws", 0),
                "losses": r.get("losses", 0),
                "win_rate": win_rate,
                "badge": badge,
                "last_win_at": r.get("last_win_at"),
            }
        )
    return results


def record_janggi_result(cho_id: int, han_id: int, winner: Optional[str]) -> None:
    """Persist one completed janggi result for both players. Winner: 'cho', 'han', or None."""
    now = utc_now()
    with get_connection() as conn:
        for user_id in (cho_id, han_id):
            conn.execute("INSERT OR IGNORE INTO janggi_player_stats (user_id) VALUES (?)", (user_id,))
        if winner in ("cho", "han", "w", "b"):
            winner_id = cho_id if winner in ("cho", "w") else han_id
            loser_id = han_id if winner in ("cho", "w") else cho_id
            conn.execute(
                "UPDATE janggi_player_stats SET wins = wins + 1, last_win_at = ? WHERE user_id = ?",
                (now, winner_id),
            )
            conn.execute(
                "UPDATE janggi_player_stats SET losses = losses + 1 WHERE user_id = ?",
                (loser_id,),
            )
        else:
            conn.execute(
                "UPDATE janggi_player_stats SET draws = draws + 1 WHERE user_id IN (?, ?)",
                (cho_id, han_id),
            )


def get_janggi_stats(user_id: int) -> Dict[str, int]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT wins, draws, losses FROM janggi_player_stats WHERE user_id = ?", (user_id,)
        ).fetchone()
    return dict(row) if row else {"wins": 0, "draws": 0, "losses": 0}


def get_janggi_rankings(limit: int = 20) -> List[Dict[str, Any]]:
    """Return top janggi players sorted by wins (desc) and time achieved (asc)."""
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT ps.user_id, u.username, u.display_name,
                   ps.wins, ps.draws, ps.losses, ps.last_win_at,
                   ROW_NUMBER() OVER (
                       ORDER BY ps.wins DESC, ps.last_win_at ASC, ps.user_id ASC
                   ) AS rank
            FROM janggi_player_stats ps
            JOIN users u ON u.id = ps.user_id
            WHERE ps.wins > 0
            ORDER BY rank ASC
            LIMIT ?
        """,
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def reset_janggi_records() -> None:
    """Resets all janggi player stats."""
    with get_connection() as conn:
        conn.execute("DELETE FROM janggi_player_stats")


def get_janggi_leaderboard(limit: int = 20) -> List[Dict[str, Any]]:
    """Return enriched janggi rankings with win rates and badges."""
    rankings = get_janggi_rankings(limit=limit)
    results = []
    for r in rankings:
        rank = int(r["rank"])
        badge = _janggi_badge(rank, int(r["wins"]))
        total = r["wins"] + r.get("draws", 0) + r.get("losses", 0)
        win_rate = round((r["wins"] / total * 100), 1) if total > 0 else 0.0
        results.append(
            {
                "user_id": r["user_id"],
                "username": r["username"],
                "display_name": r["display_name"],
                "rank": rank,
                "score": r["wins"],
                "wins": r["wins"],
                "draws": r.get("draws", 0),
                "losses": r.get("losses", 0),
                "win_rate": win_rate,
                "badge": badge,
                "last_win_at": r.get("last_win_at"),
            }
        )
    return results


def record_omok_result(black_id: int, white_id: int, winner: Optional[str]) -> None:
    """Persist one completed omok result for both players. Winner: 'b', 'w', 'black', 'white', or None."""
    now = utc_now()
    with get_connection() as conn:
        for user_id in (black_id, white_id):
            conn.execute("INSERT OR IGNORE INTO omok_player_stats (user_id) VALUES (?)", (user_id,))
        if winner in ("b", "w", "black", "white"):
            winner_id = black_id if winner in ("b", "black") else white_id
            loser_id = white_id if winner in ("b", "black") else black_id
            conn.execute(
                "UPDATE omok_player_stats SET wins = wins + 1, last_win_at = ? WHERE user_id = ?",
                (now, winner_id),
            )
            conn.execute(
                "UPDATE omok_player_stats SET losses = losses + 1 WHERE user_id = ?",
                (loser_id,),
            )
        else:
            conn.execute(
                "UPDATE omok_player_stats SET draws = draws + 1 WHERE user_id IN (?, ?)",
                (black_id, white_id),
            )


def get_omok_stats(user_id: int) -> Dict[str, int]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT wins, draws, losses FROM omok_player_stats WHERE user_id = ?", (user_id,)
        ).fetchone()
    return dict(row) if row else {"wins": 0, "draws": 0, "losses": 0}


def get_omok_rankings(limit: int = 20) -> List[Dict[str, Any]]:
    """Return top omok players sorted by wins (desc) and time achieved (asc)."""
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT ps.user_id, u.username, u.display_name,
                   ps.wins, ps.draws, ps.losses, ps.last_win_at,
                   ROW_NUMBER() OVER (
                       ORDER BY ps.wins DESC, ps.last_win_at ASC, ps.user_id ASC
                   ) AS rank
            FROM omok_player_stats ps
            JOIN users u ON u.id = ps.user_id
            WHERE ps.wins > 0
            ORDER BY rank ASC
            LIMIT ?
        """,
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def reset_omok_records() -> None:
    """Resets all omok player stats."""
    with get_connection() as conn:
        conn.execute("DELETE FROM omok_player_stats")


def get_omok_leaderboard(limit: int = 20) -> List[Dict[str, Any]]:
    """Return enriched omok rankings with win rates and badges."""
    rankings = get_omok_rankings(limit=limit)
    results = []
    for r in rankings:
        rank = int(r["rank"])
        badge = _omok_badge(rank, int(r["wins"]))
        total = r["wins"] + r.get("draws", 0) + r.get("losses", 0)
        win_rate = round((r["wins"] / total * 100), 1) if total > 0 else 0.0
        results.append(
            {
                "user_id": r["user_id"],
                "username": r["username"],
                "display_name": r["display_name"],
                "rank": rank,
                "score": r["wins"],
                "wins": r["wins"],
                "draws": r.get("draws", 0),
                "losses": r.get("losses", 0),
                "win_rate": win_rate,
                "badge": badge,
                "last_win_at": r.get("last_win_at"),
            }
        )
    return results


def record_othello_result(black_id: int, white_id: int, winner: Optional[str]) -> None:
    """Persist one completed othello result for both players. Winner: 'b', 'w', 'black', 'white', or None."""
    now = utc_now()
    with get_connection() as conn:
        for user_id in (black_id, white_id):
            conn.execute("INSERT OR IGNORE INTO othello_player_stats (user_id) VALUES (?)", (user_id,))
        if winner in ("b", "w", "black", "white"):
            winner_id = black_id if winner in ("b", "black") else white_id
            loser_id = white_id if winner in ("b", "black") else black_id
            conn.execute(
                "UPDATE othello_player_stats SET wins = wins + 1, last_win_at = ? WHERE user_id = ?",
                (now, winner_id),
            )
            conn.execute(
                "UPDATE othello_player_stats SET losses = losses + 1 WHERE user_id = ?",
                (loser_id,),
            )
        else:
            conn.execute(
                "UPDATE othello_player_stats SET draws = draws + 1 WHERE user_id IN (?, ?)",
                (black_id, white_id),
            )


def get_othello_stats(user_id: int) -> Dict[str, int]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT wins, draws, losses FROM othello_player_stats WHERE user_id = ?", (user_id,)
        ).fetchone()
    return dict(row) if row else {"wins": 0, "draws": 0, "losses": 0}


def get_othello_rankings(limit: int = 20) -> List[Dict[str, Any]]:
    """Return top othello players sorted by wins (desc) and time achieved (asc)."""
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT ps.user_id, u.username, u.display_name,
                   ps.wins, ps.draws, ps.losses, ps.last_win_at,
                   ROW_NUMBER() OVER (
                       ORDER BY ps.wins DESC, ps.last_win_at ASC, ps.user_id ASC
                   ) AS rank
            FROM othello_player_stats ps
            JOIN users u ON u.id = ps.user_id
            WHERE ps.wins > 0
            ORDER BY rank ASC
            LIMIT ?
        """,
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]


def reset_othello_records() -> None:
    """Resets all othello player stats."""
    with get_connection() as conn:
        conn.execute("DELETE FROM othello_player_stats")


def get_othello_leaderboard(limit: int = 20) -> List[Dict[str, Any]]:
    """Return enriched othello rankings with win rates and badges."""
    rankings = get_othello_rankings(limit=limit)
    results = []
    for r in rankings:
        rank = int(r["rank"])
        badge = _othello_badge(rank, int(r["wins"]))
        total = r["wins"] + r.get("draws", 0) + r.get("losses", 0)
        win_rate = round((r["wins"] / total * 100), 1) if total > 0 else 0.0
        results.append(
            {
                "user_id": r["user_id"],
                "username": r["username"],
                "display_name": r["display_name"],
                "rank": rank,
                "score": r["wins"],
                "wins": r["wins"],
                "draws": r.get("draws", 0),
                "losses": r.get("losses", 0),
                "win_rate": win_rate,
                "badge": badge,
                "last_win_at": r.get("last_win_at"),
            }
        )
    return results


def get_user_quiz_title_options(user_id: int) -> List[Dict[str, Any]]:
    """Return every subject title the user currently holds (top three by score or chess wins)."""
    from app.db.quiz import _subject_quiz_badge

    with get_connection() as conn:
        rows = conn.execute(
            """
            WITH subject_scores AS (
                SELECT qs.user_id, q.category,
                       SUM(qs.score_earned) AS subject_score,
                       MAX(qs.submitted_at) AS score_reached_at
                FROM quiz_submissions qs
                JOIN quizzes q ON q.id = qs.quiz_id
                WHERE qs.score_earned > 0
                GROUP BY qs.user_id, q.category
            ), ranked AS (
                SELECT user_id, category, subject_score, score_reached_at,
                       ROW_NUMBER() OVER (
                           PARTITION BY category
                           ORDER BY subject_score DESC, score_reached_at ASC, user_id ASC
                       ) AS subject_rank
                FROM subject_scores
            )
            SELECT category, subject_score, subject_rank
            FROM ranked
            WHERE user_id = ? AND subject_rank <= 3
            ORDER BY subject_rank ASC, subject_score DESC, category ASC
        """,
            (user_id,),
        ).fetchall()
    options = []
    for row in rows:
        badge = _subject_quiz_badge(
            row["category"], int(row["subject_rank"]), int(row["subject_score"])
        )
        if badge:
            options.append(
                {
                    **badge,
                    "category": row["category"],
                    "selection": f"subject:{row['category']}",
                    "rank": int(row["subject_rank"]),
                    "score": int(row["subject_score"]),
                }
            )
    with get_connection() as conn:
        chess_row = conn.execute(
            """
            WITH ranked_chess AS (
                SELECT user_id, wins,
                       ROW_NUMBER() OVER (
                           ORDER BY wins DESC, last_win_at ASC, user_id ASC
                       ) AS chess_rank
                FROM chess_player_stats
                WHERE wins > 0
            )
            SELECT chess_rank, wins
            FROM ranked_chess
            WHERE user_id = ? AND chess_rank <= 3
        """,
            (user_id,),
        ).fetchone()
    if chess_row:
        rank = int(chess_row["chess_rank"])
        wins = int(chess_row["wins"])
        badge = _chess_badge(rank, wins)
        if badge:
            options.append(
                {
                    **badge,
                    "category": "체스",
                    "selection": "chess",
                    "rank": rank,
                    "score": wins,
                }
            )
    with get_connection() as conn:
        jg_row = conn.execute(
            """
            WITH ranked_janggi AS (
                SELECT user_id, wins,
                       ROW_NUMBER() OVER (
                           ORDER BY wins DESC, last_win_at ASC, user_id ASC
                       ) AS jg_rank
                FROM janggi_player_stats
                WHERE wins > 0
            )
            SELECT jg_rank, wins
            FROM ranked_janggi
            WHERE user_id = ? AND jg_rank <= 3
        """,
            (user_id,),
        ).fetchone()
    if jg_row:
        rank = int(jg_row["jg_rank"])
        wins = int(jg_row["wins"])
        badge = _janggi_badge(rank, wins)
        if badge:
            options.append(
                {
                    **badge,
                    "category": "장기",
                    "selection": "janggi",
                    "rank": rank,
                    "score": wins,
                }
            )
    with get_connection() as conn:
        om_row = conn.execute(
            """
            WITH ranked_omok AS (
                SELECT user_id, wins,
                       ROW_NUMBER() OVER (
                           ORDER BY wins DESC, last_win_at ASC, user_id ASC
                       ) AS om_rank
                FROM omok_player_stats
                WHERE wins > 0
            )
            SELECT om_rank, wins
            FROM ranked_omok
            WHERE user_id = ? AND om_rank <= 3
        """,
            (user_id,),
        ).fetchone()
    if om_row:
        rank = int(om_row["om_rank"])
        wins = int(om_row["wins"])
        badge = _omok_badge(rank, wins)
        if badge:
            options.append(
                {
                    **badge,
                    "category": "오목",
                    "selection": "omok",
                    "rank": rank,
                    "score": wins,
                }
            )
    with get_connection() as conn:
        oth_row = conn.execute(
            """
            WITH ranked_othello AS (
                SELECT user_id, wins,
                       ROW_NUMBER() OVER (
                           ORDER BY wins DESC, last_win_at ASC, user_id ASC
                       ) AS oth_rank
                FROM othello_player_stats
                WHERE wins > 0
            )
            SELECT oth_rank, wins
            FROM ranked_othello
            WHERE user_id = ? AND oth_rank <= 3
        """,
            (user_id,),
        ).fetchone()
    if oth_row:
        rank = int(oth_row["oth_rank"])
        wins = int(oth_row["wins"])
        badge = _othello_badge(rank, wins)
        if badge:
            options.append(
                {
                    **badge,
                    "category": "오셀로",
                    "selection": "othello",
                    "rank": rank,
                    "score": wins,
                }
            )
    with get_connection() as conn:
        stats = conn.execute(
            "SELECT current_streak, last_solved_date FROM user_quiz_stats WHERE user_id=?", (user_id,)
        ).fetchone()
    streak = int(stats["current_streak"]) if stats else 0
    last_solved = stats["last_solved_date"] if stats else None
    if streak >= 3 and is_streak_active(last_solved):
        options.append(
            {
                "type": "streak",
                "icon": "🔥",
                "label": "꾸준러",
                "title": f"오늘의 퀴즈 {streak}일 연속",
                "category": "연속 학습",
                "selection": "streak",
                "rank": None,
                "score": None,
            }
        )
    with get_connection() as conn:
        god_info = get_play_god_qualifications(conn, [user_id]).get(user_id)
    if god_info and god_info["is_god"]:
        fc = god_info["first_count"]
        options.insert(
            0,
            {
                **_play_god_badge(fc),
                "category": "놀이마당",
                "selection": "play_god",
                "rank": 1,
                "score": fc,
            },
        )
    return options


def get_user_quiz_badge(user_id: int) -> Optional[Dict[str, Any]]:
    """Calculates user badge to display beside nickname in chat."""
    with get_connection() as conn:
        row = conn.execute(
            """SELECT u.id AS user_id,
                      COALESCE(st.total_score, 0) AS total_score,
                      COALESCE(st.current_streak, 0) AS current_streak,
                      COALESCE(u.quiz_badge_selection, 'score') AS badge_selection
               FROM users u LEFT JOIN user_quiz_stats st ON st.user_id=u.id
               WHERE u.id = ?""",
            (user_id,),
        ).fetchone()
        if not row:
            return None

        selection = row["badge_selection"]
        if selection == "none":
            return None
        if selection == "score":
            if row["total_score"] <= 0:
                return None
            return {
                "type": "score",
                "icon": "⚡",
                "label": f"{row['total_score']}점",
                "title": f"퀴즈 누적 {row['total_score']}점",
            }
        title_options = get_user_quiz_title_options(user_id)
        selected_badge = next((item for item in title_options if item["selection"] == selection), None)
        if selected_badge:
            return {key: selected_badge[key] for key in ("type", "icon", "label", "title")}
        if selection not in {"score", "none"}:
            if row["total_score"] <= 0:
                return None
            return {
                "type": "score",
                "icon": "⚡",
                "label": f"{row['total_score']}점",
                "title": f"퀴즈 누적 {row['total_score']}점",
            }

        return None


def get_user_quiz_badges_map(user_ids: List[int]) -> Dict[int, Optional[Dict[str, Any]]]:
    """Bulk calculates badges for multiple users to optimize message rendering."""
    from app.db.quiz import _subject_quiz_badge

    if not user_ids:
        return {}
    badges: Dict[int, Optional[Dict[str, Any]]] = {}
    with get_connection() as conn:
        placeholders = ",".join("?" for _ in user_ids)
        rows = conn.execute(
            f"""SELECT u.id AS user_id,
                       COALESCE(st.total_score, 0) AS total_score,
                       COALESCE(st.current_streak, 0) AS current_streak,
                       COALESCE(u.quiz_badge_selection, 'score') AS badge_selection
                FROM users u LEFT JOIN user_quiz_stats st ON st.user_id=u.id
                WHERE u.id IN ({placeholders})""",
            user_ids,
        ).fetchall()
        stats_map = {r["user_id"]: dict(r) for r in rows}
        subject_rows = conn.execute(
            f"""
            WITH subject_scores AS (
                SELECT qs.user_id, q.category,
                       SUM(qs.score_earned) AS subject_score,
                       MAX(qs.submitted_at) AS score_reached_at
                FROM quiz_submissions qs
                JOIN quizzes q ON q.id = qs.quiz_id
                WHERE qs.score_earned > 0
                GROUP BY qs.user_id, q.category
            ), ranked AS (
                SELECT user_id, category, subject_score, score_reached_at,
                       ROW_NUMBER() OVER (
                           PARTITION BY category
                           ORDER BY subject_score DESC, score_reached_at ASC, user_id ASC
                       ) AS subject_rank
                FROM subject_scores
            )
            SELECT user_id, category, subject_score, subject_rank
            FROM ranked
            WHERE user_id IN ({placeholders}) AND subject_rank <= 3
            ORDER BY user_id, subject_rank ASC, subject_score DESC, category ASC
        """,
            user_ids,
        ).fetchall()
        subject_map: Dict[int, Dict[str, Dict[str, Any]]] = {}
        for subject_row in subject_rows:
            subject_map.setdefault(subject_row["user_id"], {})[subject_row["category"]] = dict(
                subject_row
            )

        chess_rows = conn.execute(
            f"""
            WITH ranked_chess AS (
                SELECT user_id, wins,
                       ROW_NUMBER() OVER (
                           ORDER BY wins DESC, last_win_at ASC, user_id ASC
                       ) AS chess_rank
                FROM chess_player_stats
                WHERE wins > 0
            )
            SELECT user_id, wins, chess_rank
            FROM ranked_chess
            WHERE user_id IN ({placeholders}) AND chess_rank <= 3
        """,
            user_ids,
        ).fetchall()
        chess_map = {r["user_id"]: dict(r) for r in chess_rows}

        janggi_rows = conn.execute(
            f"""
            WITH ranked_jg AS (
                SELECT user_id, wins,
                       ROW_NUMBER() OVER (
                           ORDER BY wins DESC, last_win_at ASC, user_id ASC
                       ) AS jg_rank
                FROM janggi_player_stats
                WHERE wins > 0
            )
            SELECT user_id, wins, jg_rank
            FROM ranked_jg
            WHERE user_id IN ({placeholders}) AND jg_rank <= 3
        """,
            user_ids,
        ).fetchall()
        janggi_map = {r["user_id"]: dict(r) for r in janggi_rows}

        omok_rows = conn.execute(
            f"""
            WITH ranked_om AS (
                SELECT user_id, wins,
                       ROW_NUMBER() OVER (
                           ORDER BY wins DESC, last_win_at ASC, user_id ASC
                       ) AS om_rank
                FROM omok_player_stats
                WHERE wins > 0
            )
            SELECT user_id, wins, om_rank
            FROM ranked_om
            WHERE user_id IN ({placeholders}) AND om_rank <= 3
        """,
            user_ids,
        ).fetchall()
        omok_map = {r["user_id"]: dict(r) for r in omok_rows}

        othello_rows = conn.execute(
            f"""
            WITH ranked_oth AS (
                SELECT user_id, wins,
                       ROW_NUMBER() OVER (
                           ORDER BY wins DESC, last_win_at ASC, user_id ASC
                       ) AS oth_rank
                FROM othello_player_stats
                WHERE wins > 0
            )
            SELECT user_id, wins, oth_rank
            FROM ranked_oth
            WHERE user_id IN ({placeholders}) AND oth_rank <= 3
        """,
            user_ids,
        ).fetchall()
        othello_map = {r["user_id"]: dict(r) for r in othello_rows}
        god_map = get_play_god_qualifications(conn, user_ids)

        for uid in user_ids:
            st = stats_map.get(uid)
            if not st:
                badges[uid] = None
                continue
            selection = st.get("badge_selection", "score")
            subjects = subject_map.get(uid, {})
            subject = None
            if selection.startswith("subject:"):
                subject = subjects.get(selection.removeprefix("subject:"))
            if selection == "none":
                badges[uid] = None
            elif selection == "play_god" and uid in god_map and god_map[uid]["is_god"]:
                badges[uid] = _play_god_badge(god_map[uid]["first_count"])
            elif selection == "chess" and uid in chess_map:
                badges[uid] = _chess_badge(
                    int(chess_map[uid]["chess_rank"]), int(chess_map[uid]["wins"])
                )
            elif selection == "janggi" and uid in janggi_map:
                badges[uid] = _janggi_badge(
                    int(janggi_map[uid]["jg_rank"]), int(janggi_map[uid]["wins"])
                )
            elif selection == "omok" and uid in omok_map:
                badges[uid] = _omok_badge(
                    int(omok_map[uid]["om_rank"]), int(omok_map[uid]["wins"])
                )
            elif selection == "othello" and uid in othello_map:
                badges[uid] = _othello_badge(
                    int(othello_map[uid]["oth_rank"]), int(othello_map[uid]["wins"])
                )
            elif (
                selection == "streak"
                and st.get("current_streak", 0) >= 3
                and is_streak_active(st.get("last_solved_date"))
            ):
                badges[uid] = {
                    "type": "streak",
                    "icon": "🔥",
                    "label": "꾸준러",
                    "title": f"오늘의 퀴즈 {st['current_streak']}일 연속",
                }
            elif selection.startswith("subject:") and subject:
                badges[uid] = _subject_quiz_badge(
                    subject["category"],
                    int(subject["subject_rank"]),
                    int(subject["subject_score"]),
                )
            elif selection == "score" or not subject:
                badges[uid] = (
                    None
                    if st["total_score"] <= 0
                    else {
                        "type": "score",
                        "icon": "⚡",
                        "label": f"{st['total_score']}점",
                        "title": f"퀴즈 누적 {st['total_score']}점",
                    }
                )
            else:
                badges[uid] = (
                    None
                    if st["total_score"] <= 0
                    else {
                        "type": "score",
                        "icon": "⚡",
                        "label": f"{st['total_score']}점",
                        "title": f"퀴즈 누적 {st['total_score']}점",
                    }
                )

    return badges

"""SQLite database schema initialization and migrations."""
from __future__ import annotations

import json
import sqlite3
import uuid as _uuid
from typing import Optional

from app.db.connection import DB_MAX_BYTES, get_connection, utc_now
from app.db.quiz_data import DEFAULT_SAMPLE_QUIZZES, POSITION_MODULE_SAMPLE_QUIZZES, QUIZ_SUBJECT_TITLES


def _add_column_if_missing(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


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
            c.execute("""INSERT INTO quizzes
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
                ))

    if conn is not None:
        _seed(conn)
    else:
        with get_connection() as c:
            _seed(c)
            c.commit()


def init_db() -> None:
    with get_connection() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        page_size = int(conn.execute("PRAGMA page_size").fetchone()[0])
        max_pages = max(1024, DB_MAX_BYTES // page_size)
        conn.execute(f"PRAGMA max_page_count={max_pages}")
        conn.execute("""CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            normalized_username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'student',
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            last_login TEXT
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nickname TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            ip TEXT NOT NULL DEFAULT '',
            reply_nickname TEXT,
            reply_content TEXT,
            attachment_id TEXT,
            user_id INTEGER
        )""")
        for column, definition in (
            ("ip", "TEXT NOT NULL DEFAULT ''"),
            ("reply_nickname", "TEXT"),
            ("reply_content", "TEXT"),
            ("attachment_id", "TEXT"),
            ("user_id", "INTEGER"),
            ("edited_at", "TEXT"),
            ("is_hidden", "INTEGER NOT NULL DEFAULT 0"),
            ("moved_from_channel_id", "INTEGER"),
        ):
            _add_column_if_missing(conn, "messages", column, definition)
        conn.execute("""CREATE TABLE IF NOT EXISTS attachments (
            id TEXT PRIMARY KEY,
            original_name TEXT NOT NULL,
            stored_name TEXT NOT NULL UNIQUE,
            size INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            content_type TEXT NOT NULL,
            previewable INTEGER NOT NULL DEFAULT 0,
            uploader_nickname TEXT NOT NULL,
            ip TEXT NOT NULL,
            owner_token_hash TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            claimed INTEGER NOT NULL DEFAULT 0,
            uploader_user_id INTEGER
        )""")
        _add_column_if_missing(conn, "attachments", "owner_token_hash", "TEXT NOT NULL DEFAULT ''")
        _add_column_if_missing(conn, "attachments", "uploader_user_id", "INTEGER")
        conn.execute("""CREATE TABLE IF NOT EXISTS message_attachments (
            message_id INTEGER NOT NULL,
            attachment_id TEXT NOT NULL,
            original_name TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (message_id, attachment_id)
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS direct_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_user_id INTEGER NOT NULL,
            recipient_user_id INTEGER NOT NULL,
            sender_nickname TEXT NOT NULL,
            recipient_nickname TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            reply_nickname TEXT,
            reply_content TEXT,
            FOREIGN KEY(sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY(recipient_user_id) REFERENCES users(id) ON DELETE CASCADE
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS direct_message_attachments (
            direct_message_id INTEGER NOT NULL,
            attachment_id TEXT NOT NULL,
            original_name TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (direct_message_id, attachment_id),
            FOREIGN KEY(direct_message_id) REFERENCES direct_messages(id) ON DELETE CASCADE
        )""")
        conn.execute("""INSERT OR IGNORE INTO message_attachments
            (message_id, attachment_id, original_name, position)
            SELECT m.id, m.attachment_id, COALESCE(a.original_name, '파일'), 0
            FROM messages m LEFT JOIN attachments a ON a.id=m.attachment_id
            WHERE m.attachment_id IS NOT NULL AND m.attachment_id != ''""")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_dm_sender ON direct_messages(sender_user_id, id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_dm_recipient ON direct_messages(recipient_user_id, id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_dm_attachments_file ON direct_message_attachments(attachment_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(uploader_user_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)")
        conn.execute("""CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER NOT NULL
        )""")
        conn.commit()
        _run_migrations(conn)
        seed_default_quizzes(conn)
        # Community/reference samples are added after the empty-database seed so
        # they do not suppress the original PLC/electrical sample set.
        _migrate_v15(conn)
        conn.commit()


def _get_schema_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT MAX(version) FROM schema_version").fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def _set_schema_version(conn: sqlite3.Connection, version: int) -> None:
    conn.execute("DELETE FROM schema_version")
    conn.execute("INSERT INTO schema_version (version) VALUES (?)", (version,))


def _migrate_v1(conn: sqlite3.Connection) -> None:
    """Add display_name and uuid columns to users."""
    _add_column_if_missing(conn, "users", "display_name", "TEXT NOT NULL DEFAULT ''")
    _add_column_if_missing(conn, "users", "uuid", "TEXT NOT NULL DEFAULT ''")
    conn.execute("UPDATE users SET display_name = username WHERE display_name = ''")
    rows = conn.execute("SELECT id FROM users WHERE uuid = ''").fetchall()
    for row in rows:
        conn.execute("UPDATE users SET uuid = ? WHERE id = ?", (_uuid.uuid4().hex, row[0]))
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uuid ON users(uuid)")


def _migrate_v2(conn: sqlite3.Connection) -> None:
    """Create channels table, seed default permanent general channel, and add channel_id to messages."""
    conn.execute("""CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        uuid TEXT NOT NULL UNIQUE,
        created_by_user_id INTEGER,
        is_default INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY(created_by_user_id) REFERENCES users(id)
    )""")
    _add_column_if_missing(conn, "channels", "archived", "INTEGER NOT NULL DEFAULT 0")
    now = utc_now()
    default_uuid = _uuid.uuid4().hex
    conn.execute("""INSERT OR IGNORE INTO channels
        (id, name, display_name, description, uuid, is_default, archived, created_at)
        VALUES (1, 'general', '전체 채팅', '기본 전체 공개 대화방', ?, 1, 0, ?)""",
        (default_uuid, now))
    _add_column_if_missing(conn, "messages", "channel_id", "INTEGER NOT NULL DEFAULT 1")
    conn.execute("UPDATE messages SET channel_id = 1 WHERE channel_id IS NULL OR channel_id = 0")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, id)")


def _migrate_v3(conn: sqlite3.Connection) -> None:
    """Add archived column to channels; add edited_at, is_hidden, moved_from_channel_id to messages."""
    _add_column_if_missing(conn, "channels", "archived", "INTEGER NOT NULL DEFAULT 0")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_channels_archived ON channels(archived)")
    _add_column_if_missing(conn, "messages", "edited_at", "TEXT")
    _add_column_if_missing(conn, "messages", "is_hidden", "INTEGER NOT NULL DEFAULT 0")
    _add_column_if_missing(conn, "messages", "moved_from_channel_id", "INTEGER")


def _migrate_v4(conn: sqlite3.Connection) -> None:
    """Create user_conversation_state table for read tracking and notification muting."""
    conn.execute("""CREATE TABLE IF NOT EXISTS user_conversation_state (
        user_id INTEGER NOT NULL,
        conversation_type TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        last_read_message_id INTEGER NOT NULL DEFAULT 0,
        muted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, conversation_type, conversation_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ucs_user ON user_conversation_state(user_id)")


def _migrate_v5(conn: sqlite3.Connection) -> None:
    """Create message_reactions table for channel and DM message reactions."""
    conn.execute("""CREATE TABLE IF NOT EXISTS message_reactions (
        message_type TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_type, message_id, user_id, emoji),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reactions_target ON message_reactions(message_type, message_id)")


def _migrate_v6(conn: sqlite3.Connection) -> None:
    """Add edited_at column to direct_messages."""
    _add_column_if_missing(conn, "direct_messages", "edited_at", "TEXT")


def _migrate_v7(conn: sqlite3.Connection) -> None:
    """Create pinned_messages table for channel and DM message pins."""
    conn.execute("""CREATE TABLE IF NOT EXISTS pinned_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_type TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        pinned_by_user_id INTEGER NOT NULL,
        pinned_at TEXT NOT NULL,
        UNIQUE(conversation_type, conversation_id, message_id),
        FOREIGN KEY(pinned_by_user_id) REFERENCES users(id) ON DELETE CASCADE
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pinned_conv ON pinned_messages(conversation_type, conversation_id)")


def _migrate_v8(conn: sqlite3.Connection) -> None:
    """Add last_login_ip column to users table."""
    _add_column_if_missing(conn, "users", "last_login_ip", "TEXT")


def _migrate_v9(conn: sqlite3.Connection) -> None:
    """Create tables for educational quizzes, submissions, stats/streaks, and source documents."""
    conn.execute("""CREATE TABLE IF NOT EXISTS quiz_source_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        stored_filename TEXT NOT NULL UNIQUE,
        file_type TEXT NOT NULL DEFAULT 'pdf',
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        uploaded_by_user_id INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY(uploaded_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS quizzes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL DEFAULT 'PLC',
        difficulty TEXT NOT NULL DEFAULT 'medium',
        question_type TEXT NOT NULL DEFAULT 'multiple_choice',
        question TEXT NOT NULL,
        image_filename TEXT,
        options_json TEXT,
        correct_answers_json TEXT NOT NULL,
        explanation TEXT NOT NULL DEFAULT '',
        source_doc_id INTEGER,
        source_ref TEXT NOT NULL DEFAULT '',
        daily_date TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        FOREIGN KEY(source_doc_id) REFERENCES quiz_source_documents(id) ON DELETE SET NULL
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS quiz_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        quiz_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        user_answer TEXT NOT NULL,
        is_correct INTEGER NOT NULL,
        score_earned INTEGER NOT NULL DEFAULT 0,
        submitted_at TEXT NOT NULL,
        submitted_date TEXT NOT NULL,
        UNIQUE(quiz_id, user_id),
        FOREIGN KEY(quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS user_quiz_stats (
        user_id INTEGER PRIMARY KEY,
        total_score INTEGER NOT NULL DEFAULT 0,
        total_solved INTEGER NOT NULL DEFAULT 0,
        total_correct INTEGER NOT NULL DEFAULT 0,
        current_streak INTEGER NOT NULL DEFAULT 0,
        max_streak INTEGER NOT NULL DEFAULT 0,
        weekly_score INTEGER NOT NULL DEFAULT 0,
        last_solved_date TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_quizzes_active ON quizzes(is_active, id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_quizzes_daily ON quizzes(daily_date)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_quiz_sub_user ON quiz_submissions(user_id, quiz_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_quiz_sub_date ON quiz_submissions(submitted_date)")


def _migrate_v10(conn: sqlite3.Connection) -> None:
    """Add hint to quizzes and create quiz_bookmarks table."""
    _add_column_if_missing(conn, "quizzes", "hint", "TEXT DEFAULT ''")
    conn.execute("""CREATE TABLE IF NOT EXISTS quiz_bookmarks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        quiz_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(user_id, quiz_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_quiz_bm_user ON quiz_bookmarks(user_id, quiz_id)")


def _migrate_v11(conn: sqlite3.Connection) -> None:
    """Add had_wrong_attempt column to quiz_submissions to retain quizzes in wrong list even after retry success."""
    _add_column_if_missing(conn, "quiz_submissions", "had_wrong_attempt", "INTEGER NOT NULL DEFAULT 0")
    conn.execute("UPDATE quiz_submissions SET had_wrong_attempt = 1 WHERE is_correct = 0")


def _migrate_v12(conn: sqlite3.Connection) -> None:
    """Add personal quiz-set review workflow and immutable daily assignments."""
    conn.execute("""CREATE TABLE IF NOT EXISTS user_quiz_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_user_id INTEGER NOT NULL,
        expertise TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        quizzes_json TEXT NOT NULL,
        review_note TEXT NOT NULL DEFAULT '',
        approved_by_user_id INTEGER,
        submitted_at TEXT,
        approved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(approved_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_user_quiz_sets_owner ON user_quiz_sets(owner_user_id, status)")
    conn.execute("""CREATE TABLE IF NOT EXISTS daily_quiz_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assigned_date TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'published',
        created_by_user_id INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY(created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS daily_quiz_set_items (
        set_id INTEGER NOT NULL,
        quiz_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        points INTEGER NOT NULL DEFAULT 20,
        PRIMARY KEY(set_id, quiz_id),
        UNIQUE(set_id, position),
        FOREIGN KEY(set_id) REFERENCES daily_quiz_sets(id) ON DELETE CASCADE,
        FOREIGN KEY(quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE
    )""")


def _migrate_v13(conn: sqlite3.Connection) -> None:
    """Normalize seeded quiz categories to the user-facing subject names."""
    conn.execute("UPDATE quizzes SET category='PLC' WHERE category='PLC/시퀀스'")
    conn.execute("UPDATE quizzes SET category='전기' WHERE category='CBT/전기기초'")
    conn.execute("UPDATE quizzes SET category='전자' WHERE category='CBT/디지털공학'")
    conn.execute("UPDATE quizzes SET category='자동화설비' WHERE category IN ('공압/유압', '생산자동화')")


def _migrate_v14(conn: sqlite3.Connection) -> None:
    """Apply subject-name normalization to databases seeded before v13."""
    conn.execute("UPDATE quizzes SET category='PLC' WHERE category='PLC/시퀀스'")
    conn.execute("UPDATE quizzes SET category='전기' WHERE category='CBT/전기기초'")
    conn.execute("UPDATE quizzes SET category='전자' WHERE category='CBT/디지털공학'")


def _migrate_v15(conn: sqlite3.Connection) -> None:
    """Seed beginner position-module error-code questions once."""
    if conn.execute("SELECT COUNT(*) FROM quizzes").fetchone()[0] == 0:
        return
    for quiz in POSITION_MODULE_SAMPLE_QUIZZES:
        exists = conn.execute(
            "SELECT 1 FROM quizzes WHERE category=? AND question=?",
            (quiz["category"], quiz["question"]),
        ).fetchone()
        if exists:
            continue
        conn.execute("""INSERT INTO quizzes
            (category,difficulty,question_type,question,image_filename,options_json,
             correct_answers_json,hint,explanation,source_ref,is_active,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,1,?)""", (
            quiz["category"], quiz["difficulty"], quiz["question_type"], quiz["question"], "",
            json.dumps(quiz["options"], ensure_ascii=False), json.dumps(quiz["correct_answers"], ensure_ascii=False),
            quiz["hint"], quiz["explanation"], quiz["source_ref"], utc_now(),
        ))


def _migrate_v16(conn: sqlite3.Connection) -> None:
    """Keep approved pool questions traceable to their community submission."""
    _add_column_if_missing(conn, "quizzes", "source_submission_set_id",
                           "INTEGER REFERENCES user_quiz_sets(id) ON DELETE SET NULL")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_quizzes_submission_source ON quizzes(source_submission_set_id)")


def _migrate_v17(conn: sqlite3.Connection) -> None:
    """Allow users to choose which earned quiz title appears by their nickname."""
    _add_column_if_missing(conn, "users", "quiz_badge_selection", "TEXT NOT NULL DEFAULT 'score'")


def _migrate_v18(conn: sqlite3.Connection) -> None:
    """Use accumulated score until a user explicitly selects an earned title."""
    conn.execute("UPDATE users SET quiz_badge_selection='score' WHERE quiz_badge_selection='auto'")


def _migrate_v19(conn: sqlite3.Connection) -> None:
    """Create persistent chess win/draw/loss totals."""
    conn.execute("""CREATE TABLE IF NOT EXISTS chess_player_stats (
        user_id INTEGER PRIMARY KEY,
        wins INTEGER NOT NULL DEFAULT 0,
        draws INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )""")


def _migrate_v20(conn: sqlite3.Connection) -> None:
    """Add last_win_at timestamp to chess_player_stats for tie-breaking rankings."""
    _add_column_if_missing(conn, "chess_player_stats", "last_win_at", "TEXT")


def _migrate_v21(conn: sqlite3.Connection) -> None:
    """Reset historical chess records and associated user badge selection."""
    conn.execute("DELETE FROM chess_player_stats")
    conn.execute("UPDATE users SET quiz_badge_selection = 'score' WHERE quiz_badge_selection = 'chess'")


def _migrate_v22(conn: sqlite3.Connection) -> None:
    """Normalize user_conversation_state DM conversation_ids to user IDs."""
    rows = conn.execute("SELECT id, username FROM users").fetchall()
    for row in rows:
        uid = str(row[0])
        uname = str(row[1])
        if uname != uid:
            uname_rows = conn.execute(
                "SELECT user_id, last_read_message_id, muted, updated_at FROM user_conversation_state WHERE conversation_type='dm' AND conversation_id=?",
                (uname,)
            ).fetchall()
            for urow in uname_rows:
                target_user_id = urow[0]
                uname_last_read = urow[1]
                uname_muted = urow[2]
                uname_updated = urow[3]
                existing = conn.execute(
                    "SELECT last_read_message_id, muted FROM user_conversation_state WHERE user_id=? AND conversation_type='dm' AND conversation_id=?",
                    (target_user_id, uid)
                ).fetchone()
                if existing:
                    new_last_read = max(existing[0], uname_last_read)
                    new_muted = existing[1] or uname_muted
                    conn.execute(
                        "UPDATE user_conversation_state SET last_read_message_id=?, muted=?, updated_at=? WHERE user_id=? AND conversation_type='dm' AND conversation_id=?",
                        (new_last_read, new_muted, uname_updated, target_user_id, uid)
                    )
                else:
                    conn.execute(
                        "INSERT INTO user_conversation_state (user_id, conversation_type, conversation_id, last_read_message_id, muted, updated_at) VALUES (?, 'dm', ?, ?, ?, ?)",
                        (target_user_id, uid, uname_last_read, uname_muted, uname_updated)
                    )
            conn.execute("DELETE FROM user_conversation_state WHERE conversation_type='dm' AND conversation_id=?", (uname,))


def _migrate_v23(conn: sqlite3.Connection) -> None:
    """Create quiz_flags table for reporting question errors and typos."""
    conn.execute("""CREATE TABLE IF NOT EXISTS quiz_flags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        quiz_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        reason_type TEXT NOT NULL,
        comment TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by_user_id INTEGER,
        FOREIGN KEY (quiz_id) REFERENCES quizzes(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (resolved_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_quiz_flags_status ON quiz_flags(status, quiz_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_quiz_flags_quiz ON quiz_flags(quiz_id)")


def _migrate_v24(conn: sqlite3.Connection) -> None:
    """Create and seed the permanent screen sharing channel."""
    existing = conn.execute("SELECT id FROM channels WHERE name = 'screenshare'").fetchone()
    if not existing:
        now = utc_now()
        chan_uuid = _uuid.uuid4().hex
        conn.execute("""INSERT INTO channels
            (name, display_name, description, uuid, is_default, archived, created_at)
            VALUES ('screenshare', '🖥️ 화면 공유', '실시간 LAN 화면 공유 및 질의응답 채널', ?, 1, 0, ?)""",
            (chan_uuid, now))


def _migrate_v25(conn: sqlite3.Connection) -> None:
    """Add author_id and author_name columns to quizzes table and backfill existing questions."""
    _add_column_if_missing(conn, "quizzes", "author_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL")
    _add_column_if_missing(conn, "quizzes", "author_name", "TEXT NOT NULL DEFAULT ''")

    # 1. Backfill community approved questions from user_quiz_sets
    conn.execute("""
        UPDATE quizzes SET
            author_id = (SELECT s.owner_user_id FROM user_quiz_sets s WHERE s.id = quizzes.source_submission_set_id),
            author_name = COALESCE(
                (SELECT NULLIF(u.display_name, '') FROM user_quiz_sets s JOIN users u ON u.id = s.owner_user_id WHERE s.id = quizzes.source_submission_set_id),
                (SELECT u.username FROM user_quiz_sets s JOIN users u ON u.id = s.owner_user_id WHERE s.id = quizzes.source_submission_set_id),
                '대나무숲 회원'
            )
        WHERE source_submission_set_id IS NOT NULL AND (author_name = '' OR author_name IS NULL)
    """)

    # 2. Backfill questions generated from source documents
    conn.execute("""
        UPDATE quizzes SET
            author_id = (SELECT d.uploaded_by_user_id FROM quiz_source_documents d WHERE d.id = quizzes.source_doc_id),
            author_name = COALESCE(
                (SELECT COALESCE(NULLIF(u.display_name, ''), u.username) || ' (AI 생성)' FROM quiz_source_documents d JOIN users u ON u.id = d.uploaded_by_user_id WHERE d.id = quizzes.source_doc_id),
                '교재 기반 AI'
            )
        WHERE source_doc_id IS NOT NULL AND (author_name = '' OR author_name IS NULL)
    """)

    # 3. Default fallback for official seeded quizzes
    conn.execute("UPDATE quizzes SET author_name = '대나무숲 공식' WHERE author_name = '' OR author_name IS NULL")


def _migrate_v26(conn: sqlite3.Connection) -> None:
    """Create janggi_player_stats and omok_player_stats tables for Korean Chess and Gomoku."""
    conn.execute("""CREATE TABLE IF NOT EXISTS janggi_player_stats (
        user_id INTEGER PRIMARY KEY,
        wins INTEGER NOT NULL DEFAULT 0,
        draws INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        last_win_at TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )""")
    conn.execute("""CREATE TABLE IF NOT EXISTS omok_player_stats (
        user_id INTEGER PRIMARY KEY,
        wins INTEGER NOT NULL DEFAULT 0,
        draws INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        last_win_at TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )""")


def _migrate_v27(conn: sqlite3.Connection) -> None:
    """Create quiz_subject_titles table and add custom title columns to user_quiz_sets."""
    conn.execute("""CREATE TABLE IF NOT EXISTS quiz_subject_titles (
        category TEXT PRIMARY KEY,
        icon TEXT NOT NULL DEFAULT '📚',
        rank3_title TEXT NOT NULL DEFAULT '',
        rank2_title TEXT NOT NULL DEFAULT '',
        rank1_title TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )""")
    now = utc_now()
    for cat, (icon, r3, r2, r1) in QUIZ_SUBJECT_TITLES.items():
        conn.execute("""
            INSERT OR IGNORE INTO quiz_subject_titles
            (category, icon, rank3_title, rank2_title, rank1_title, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (cat, icon, r3, r2, r1, now, now))

    _add_column_if_missing(conn, "user_quiz_sets", "rank1_title", "TEXT NOT NULL DEFAULT ''")
    _add_column_if_missing(conn, "user_quiz_sets", "rank2_title", "TEXT NOT NULL DEFAULT ''")
    _add_column_if_missing(conn, "user_quiz_sets", "rank3_title", "TEXT NOT NULL DEFAULT ''")
    _add_column_if_missing(conn, "user_quiz_sets", "icon", "TEXT NOT NULL DEFAULT ''")


_MIGRATIONS = [
    _migrate_v1,
    _migrate_v2,
    _migrate_v3,
    _migrate_v4,
    _migrate_v5,
    _migrate_v6,
    _migrate_v7,
    _migrate_v8,
    _migrate_v9,
    _migrate_v10,
    _migrate_v11,
    _migrate_v12,
    _migrate_v13,
    _migrate_v14,
    _migrate_v15,
    _migrate_v16,
    _migrate_v17,
    _migrate_v18,
    _migrate_v19,
    _migrate_v20,
    _migrate_v21,
    _migrate_v22,
    _migrate_v23,
    _migrate_v24,
    _migrate_v25,
    _migrate_v26,
    _migrate_v27,
]


import sys


def _run_migrations(conn: sqlite3.Connection) -> None:
    db_mod = sys.modules.get("app.database")
    migrations = getattr(db_mod, "_MIGRATIONS", _MIGRATIONS) if db_mod else _MIGRATIONS
    current = _get_schema_version(conn)
    for index, migrate in enumerate(migrations, start=1):
        if index <= current:
            continue
        try:
            conn.execute("BEGIN IMMEDIATE")
            migrate(conn)
            _set_schema_version(conn, index)
            conn.commit()
        except Exception:
            conn.rollback()
            raise

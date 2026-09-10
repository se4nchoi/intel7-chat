"""Utility script to inspect and clean test suite residues from BambooChat SQLite databases."""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path


def find_default_db_path() -> Path:
    config_env = os.getenv("BAMBOOCHAT_CONFIG", "bamboochat.json")
    cfg_file = Path(config_env).resolve()
    if cfg_file.exists():
        try:
            data = json.loads(cfg_file.read_text(encoding="utf-8"))
            if "data_dir" in data:
                return Path(data["data_dir"]).expanduser().resolve() / "chat.db"
        except Exception:
            pass
    fallback = Path.home() / "BambooChatData" / "chat.db"
    if fallback.exists():
        return fallback
    return Path("data") / "chat.db"


def inspect_and_clean(db_path: Path, apply: bool = False, reset_user: str | None = None) -> int:
    if not db_path.exists():
        print(f"[ERROR] Database file not found: {db_path}")
        return 1

    print(f"=== BambooChat Database Test Residue Inspector ===")
    print(f"Target DB: {db_path}")
    print(f"Mode: {'APPLY (changes will be committed)' if apply else 'DRY RUN (no changes)'}\n")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    cursor = conn.cursor()
    tables = [r[0] for r in cursor.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]

    if "chess_player_stats" not in tables:
        print("[OK] Table 'chess_player_stats' does not exist in this database.")
        conn.close()
        return 0

    has_users_table = "users" in tables

    # 1. Find orphan chess stats (user_id not present in users table)
    if has_users_table:
        orphan_rows = cursor.execute("""
            SELECT ps.*
            FROM chess_player_stats ps
            WHERE ps.user_id NOT IN (SELECT id FROM users)
               OR ps.user_id IN (8801, 8802)
        """).fetchall()
    else:
        orphan_rows = cursor.execute("""
            SELECT * FROM chess_player_stats WHERE user_id IN (8801, 8802)
        """).fetchall()

    print(f"[*] Found {len(orphan_rows)} orphan/test chess stat residue(s):")
    for r in orphan_rows:
        print(f"    - User ID {r['user_id']}: {r['wins']}W / {r['draws']}D / {r['losses']}L (last_win: {r['last_win_at']})")

    # 2. Display all current chess stats
    all_stats = cursor.execute("""
        SELECT ps.user_id,
               CASE WHEN u.username IS NOT NULL THEN u.username ELSE '[UNKNOWN / TEST]' END AS username,
               ps.wins, ps.draws, ps.losses, ps.last_win_at
        FROM chess_player_stats ps
        LEFT JOIN users u ON u.id = ps.user_id
        ORDER BY ps.wins DESC, ps.user_id ASC
    """).fetchall()

    print(f"\n[*] Current chess stats ({len(all_stats)} total):")
    for s in all_stats:
        print(f"    - [{s['username']}] (ID {s['user_id']}): {s['wins']}W / {s['draws']}D / {s['losses']}L")

    # 3. Optional reset for specific user
    user_to_reset = None
    if reset_user and has_users_table:
        user_row = cursor.execute(
            "SELECT id, username FROM users WHERE username = ? OR id = ?",
            (reset_user, reset_user),
        ).fetchone()
        if user_row:
            user_to_reset = user_row
            print(f"\n[*] User targeted for stats reset: {user_row['username']} (ID {user_row['id']})")
        else:
            print(f"\n[WARNING] Targeted user '{reset_user}' not found in users table.")

    # 4. Perform deletions/updates if apply is True
    if apply:
        deleted_count = 0
        if orphan_rows:
            orphan_ids = [r["user_id"] for r in orphan_rows]
            placeholders = ",".join("?" for _ in orphan_ids)
            cursor.execute(f"DELETE FROM chess_player_stats WHERE user_id IN ({placeholders})", orphan_ids)
            deleted_count = len(orphan_ids)
            print(f"\n[APPLIED] Deleted {deleted_count} orphan chess residue(s).")

        if user_to_reset:
            cursor.execute(
                "UPDATE chess_player_stats SET wins = 0, draws = 0, losses = 0, last_win_at = NULL WHERE user_id = ?",
                (user_to_reset["id"],),
            )
            print(f"[APPLIED] Reset chess stats for user {user_to_reset['username']} (ID {user_to_reset['id']}).")

        conn.commit()
        print("\n[SUCCESS] Changes committed successfully.")
    else:
        if orphan_rows or user_to_reset:
            print("\n[INFO] Re-run with --apply to commit these cleanup actions.")
        else:
            print("\n[OK] No orphan test residues found.")

    conn.close()
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="BambooChat test database residue inspector & cleaner")
    parser.add_argument("--db", type=Path, default=None, help="Path to chat.db SQLite database")
    parser.add_argument("--apply", action="store_true", help="Apply cleanup deletions and updates")
    parser.add_argument("--reset-user", type=str, default=None, help="Reset stats (wins=0, draws=0, losses=0) for a specific user ID or username")

    args = parser.parse_args()
    target_db = args.db if args.db is not None else find_default_db_path()
    sys.exit(inspect_and_clean(target_db, apply=args.apply, reset_user=args.reset_user))


if __name__ == "__main__":
    main()

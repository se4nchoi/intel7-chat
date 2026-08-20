"""Tests for Iteration 1 — Identity Foundation: display name, UUID, migrations."""
import json
import re
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from app import database, main
from app.auth import hash_secret, token_hash, validate_display_name
from app.config import GIB

ORIGIN = {"origin": "http://testserver"}


@pytest.fixture(autouse=True)
def isolated_state(tmp_path, monkeypatch):
    monkeypatch.setattr(database, "DB_PATH", tmp_path / "chat.db")
    monkeypatch.setattr(database, "DB_MAX_BYTES", 3 * GIB)
    monkeypatch.setattr(main, "UPLOAD_DIR", tmp_path / "uploads")
    monkeypatch.setenv("BAMBOOCHAT_CONFIG", str(tmp_path / "bamboochat.json"))
    monkeypatch.setattr(main.CONFIG, "registration_enabled", True)
    monkeypatch.setattr(main.CONFIG, "enrollment_code_hash", "")
    main.connected_clients.clear()
    main.user_registry.clear()
    main.message_timestamps.clear()
    main.upload_timestamps.clear()
    main.login_timestamps.clear()
    main.UPLOAD_DIR.mkdir(parents=True)
    database.init_db()
    yield


def session_client(username="student", role="student"):
    user = database.create_user(username, "not-used-in-session-tests", role=role)
    raw = f"session-token-for-user-{user['id']}"
    expires = "2999-01-01T00:00:00Z"
    database.create_session(token_hash(raw), user["id"], expires)
    client = TestClient(main.app)
    client.cookies.set(main.SESSION_COOKIE, raw)
    return client, user


import sqlite3
import uuid as _uuid

def create_legacy_v0_database(db_path: Path):
    """Create a database with the exact pre-Iteration-1 schema (no schema_version, no display_name, no uuid)."""
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("""CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        normalized_username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'student',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_login TEXT
    )""")
    conn.execute("""CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )""")
    conn.execute("""CREATE TABLE messages (
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
    conn.execute("""CREATE TABLE attachments (
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
    conn.execute("""CREATE TABLE message_attachments (
        message_id INTEGER NOT NULL,
        attachment_id TEXT NOT NULL,
        original_name TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (message_id, attachment_id)
    )""")
    conn.execute("""CREATE TABLE direct_messages (
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
    conn.execute("""CREATE TABLE direct_message_attachments (
        direct_message_id INTEGER NOT NULL,
        attachment_id TEXT NOT NULL,
        original_name TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (direct_message_id, attachment_id),
        FOREIGN KEY(direct_message_id) REFERENCES direct_messages(id) ON DELETE CASCADE
    )""")

    conn.execute(
        "INSERT INTO users (username, normalized_username, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ("alice", "alice", "hash_alice", "admin", 1, "2026-08-01T00:00:00Z"),
    )
    conn.execute(
        "INSERT INTO users (username, normalized_username, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ("bob", "bob", "hash_bob", "student", 1, "2026-08-02T00:00:00Z"),
    )
    conn.execute(
        "INSERT INTO users (username, normalized_username, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ("charlie", "charlie", "hash_charlie", "student", 0, "2026-08-03T00:00:00Z"),
    )
    conn.execute(
        "INSERT INTO messages (nickname, content, created_at, user_id) VALUES (?, ?, ?, ?)",
        ("alice", "Legacy hello", "2026-08-01T01:00:00Z", 1),
    )
    conn.execute(
        "INSERT INTO direct_messages (sender_user_id, recipient_user_id, sender_nickname, recipient_nickname, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (1, 2, "alice", "bob", "Legacy DM", "2026-08-01T02:00:00Z"),
    )

    conn.commit()
    conn.close()


# ==========================================================================
# Migration infrastructure
# ==========================================================================

class TestMigrations:
    def test_fresh_db_reaches_latest_version(self):
        with database.get_connection() as conn:
            version = database._get_schema_version(conn)
        assert version == len(database._MIGRATIONS)

    def test_migration_is_idempotent(self):
        """Running init_db again does not fail or change version."""
        database.init_db()
        with database.get_connection() as conn:
            version = database._get_schema_version(conn)
        assert version == len(database._MIGRATIONS)

    def test_upgrade_from_legacy_pre_migration_database(self, tmp_path, monkeypatch):
        """Build an exact pre-Iteration-1 legacy DB and verify lossless upgrade."""
        legacy_db = tmp_path / "legacy_chat.db"
        create_legacy_v0_database(legacy_db)
        monkeypatch.setattr(database, "DB_PATH", legacy_db)

        # Before upgrade: table users has no display_name or uuid column
        with sqlite3.connect(legacy_db) as conn:
            cols = {row[1] for row in conn.execute("PRAGMA table_info(users)")}
            assert "display_name" not in cols
            assert "uuid" not in cols
            assert conn.execute("SELECT COUNT(*) FROM sqlite_master WHERE name='schema_version'").fetchone()[0] == 0

        # Execute init_db which runs migrations
        database.init_db()

        # After upgrade: schema version is at latest
        with database.get_connection() as conn:
            assert database._get_schema_version(conn) == len(database._MIGRATIONS)
            cols = {row[1] for row in conn.execute("PRAGMA table_info(users)")}
            assert "display_name" in cols
            assert "uuid" in cols

        # Check existing users received display_name = username and unique UUIDs
        alice = database.get_user_by_username("alice")
        bob = database.get_user_by_username("bob")
        charlie = database.get_user_by_username("charlie")

        assert alice["display_name"] == "alice"
        assert bob["display_name"] == "bob"
        assert charlie["display_name"] == "charlie"

        assert len(alice["uuid"]) == 32
        assert len(bob["uuid"]) == 32
        assert len(charlie["uuid"]) == 32
        assert len({alice["uuid"], bob["uuid"], charlie["uuid"]}) == 3

        # Check existing messages & DMs remain intact
        recent_messages = database.get_recent_messages()
        assert len(recent_messages) >= 1
        assert recent_messages[0]["content"] == "Legacy hello"
        assert recent_messages[0]["nickname"] == "alice"

        recent_dms = database.get_recent_direct_messages(alice["id"])
        assert len(recent_dms) >= 1
        assert recent_dms[0]["content"] == "Legacy DM"
        assert recent_dms[0]["from_nick"] == "alice"

        # Check new users can be created after upgrade
        newbie = database.create_user("newbie", hash_secret("newpass"))
        assert newbie["display_name"] == "newbie"
        assert len(newbie["uuid"]) == 32

    def test_migration_failure_rolls_back_transaction(self, tmp_path, monkeypatch):
        """Simulate a failing migration step and verify rollback & version safety."""
        test_db = tmp_path / "failing_mig.db"
        monkeypatch.setattr(database, "DB_PATH", test_db)
        database.init_db()

        initial_version = database._get_schema_version(database.get_connection())

        def failing_migration(conn: sqlite3.Connection):
            conn.execute("CREATE TABLE test_partial (id INTEGER PRIMARY KEY)")
            raise RuntimeError("Simulated migration explosion!")

        monkeypatch.setattr(database, "_MIGRATIONS", [*database._MIGRATIONS, failing_migration])

        with pytest.raises(RuntimeError, match="Simulated migration explosion!"):
            with database.get_connection() as conn:
                database._run_migrations(conn)

        # Verify schema version was NOT incremented
        with database.get_connection() as conn:
            assert database._get_schema_version(conn) == initial_version
            # Verify test_partial table was rolled back
            assert conn.execute("SELECT COUNT(*) FROM sqlite_master WHERE name='test_partial'").fetchone()[0] == 0

    def test_schema_version_table_exists(self):
        with database.get_connection() as conn:
            row = conn.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_version'"
            ).fetchone()
        assert row[0] == 1


# ==========================================================================
# Display name validation
# ==========================================================================

class TestDisplayNameValidation:
    def test_valid_korean_name(self):
        assert validate_display_name("예현") == "예현"

    def test_valid_english_name(self):
        assert validate_display_name("Sean") == "Sean"

    def test_valid_mixed_name(self):
        assert validate_display_name("예현 Sean") == "예현 Sean"

    def test_whitespace_collapsed(self):
        assert validate_display_name("  예현   Sean  ") == "예현 Sean"

    def test_empty_name_rejected(self):
        with pytest.raises(ValueError, match="닉네임"):
            validate_display_name("")

    def test_whitespace_only_rejected(self):
        with pytest.raises(ValueError, match="닉네임"):
            validate_display_name("   ")

    def test_too_long_rejected(self):
        with pytest.raises(ValueError, match="30자"):
            validate_display_name("a" * 31)

    def test_max_length_accepted(self):
        assert validate_display_name("a" * 30) == "a" * 30

    def test_control_characters_rejected(self):
        with pytest.raises(ValueError, match="제어 문자"):
            validate_display_name("hello\x00world")


# ==========================================================================
# API: display name endpoint
# ==========================================================================

class TestDisplayNameApi:
    def test_change_display_name(self):
        client, user = session_client("se4nchoi")
        response = client.post("/api/auth/display-name", headers=ORIGIN,
                               json={"display_name": "예현"})
        assert response.status_code == 200
        data = response.json()
        assert data["display_name"] == "예현"
        assert data["username"] == "se4nchoi"

    def test_display_name_appears_in_me(self):
        client, user = session_client("se4nchoi")
        client.post("/api/auth/display-name", headers=ORIGIN,
                     json={"display_name": "예현"})
        me = client.get("/api/auth/me").json()
        assert me["display_name"] == "예현"
        assert me["username"] == "se4nchoi"

    def test_empty_display_name_rejected(self):
        client, _ = session_client("se4nchoi")
        response = client.post("/api/auth/display-name", headers=ORIGIN,
                               json={"display_name": ""})
        assert response.status_code == 400

    def test_too_long_display_name_rejected(self):
        client, _ = session_client("se4nchoi")
        response = client.post("/api/auth/display-name", headers=ORIGIN,
                               json={"display_name": "a" * 31})
        assert response.status_code == 400

    def test_requires_login(self):
        client = TestClient(main.app)
        response = client.post("/api/auth/display-name", headers=ORIGIN,
                               json={"display_name": "test"})
        assert response.status_code == 401


# ==========================================================================
# Identity preservation
# ==========================================================================

class TestIdentityPreservation:
    def test_login_uses_username_not_display_name(self):
        """After changing display name, login still uses original username."""
        database.create_user("mylogin", hash_secret("mypassword"))
        database.update_display_name(
            database.get_user_by_username("mylogin")["id"], "Pretty Name"
        )
        client = TestClient(main.app)
        response = client.post("/api/auth/login", headers=ORIGIN,
                               json={"username": "mylogin", "password": "mypassword"})
        assert response.status_code == 200
        assert response.json()["username"] == "mylogin"
        assert response.json()["display_name"] == "Pretty Name"

    def test_display_name_change_does_not_alter_username(self):
        user = database.create_user("immutable_user", hash_secret("pass123"))
        database.update_display_name(user["id"], "New Display Name")
        updated = database.get_user_by_id(user["id"])
        assert updated["username"] == "immutable_user"
        assert updated["display_name"] == "New Display Name"

    def test_display_name_change_does_not_alter_password(self):
        original_hash = hash_secret("pass123")
        user = database.create_user("passtest", original_hash)
        database.update_display_name(user["id"], "Changed Name")
        updated = database.get_user_by_id(user["id"])
        assert updated["password_hash"] == original_hash

    def test_message_nickname_stays_username(self):
        """Message.nickname should be the username, not the display name."""
        user = database.create_user("msguser", hash_secret("pass123"))
        database.update_display_name(user["id"], "Pretty Display")
        msg = database.save_message("msguser", "hello", user_id=user["id"])
        assert msg["nickname"] == "msguser"

    def test_dm_uses_user_id_for_routing(self):
        """DMs are routed by user_id, not display name."""
        sender = database.create_user("sender1", hash_secret("pass123"))
        recipient = database.create_user("recipient1", hash_secret("pass123"))
        database.update_display_name(sender["id"], "Fancy Sender")
        dm = database.save_direct_message(sender, recipient, "hello DM")
        assert dm["from_nick"] == "sender1"  # stored nickname is username
        assert dm["from_user_id"] == sender["id"]

    def test_file_ownership_unaffected(self):
        """Changing display name must not affect file ownership."""
        user = database.create_user("uploader", hash_secret("pass123"))
        database.update_display_name(user["id"], "New Uploader Name")
        mine, _ = database.get_upload_usage(user["id"])
        assert mine == 0  # No files uploaded, but the query uses user_id


# ==========================================================================
# UUID generation
# ==========================================================================

class TestUuidGeneration:
    def test_new_user_gets_uuid(self):
        user = database.create_user("uuiduser", hash_secret("pass123"))
        assert "uuid" in user
        assert len(user["uuid"]) == 32

    def test_uuids_are_unique(self):
        user1 = database.create_user("user1", hash_secret("pass123"))
        user2 = database.create_user("user2", hash_secret("pass123"))
        assert user1["uuid"] != user2["uuid"]


# ==========================================================================
# Mention system with display names
# ==========================================================================

class TestMentionsWithDisplayName:
    def test_mention_by_username(self):
        database.create_user("jisu", hash_secret("pass123"))
        mentions = main.find_mentions("hello @jisu!")
        assert len(mentions) == 1
        assert mentions[0]["username"] == "jisu"

    def test_mention_by_display_name(self):
        user = database.create_user("se4nchoi", hash_secret("pass123"))
        database.update_display_name(user["id"], "예현")
        mentions = main.find_mentions("안녕 @예현!")
        assert len(mentions) == 1
        assert mentions[0]["username"] == "se4nchoi"
        assert mentions[0]["display_name"] == "예현"

    def test_mention_username_takes_priority_over_display_name(self):
        user = database.create_user("se4nchoi", hash_secret("pass123"))
        database.update_display_name(user["id"], "예현")
        mentions = main.find_mentions("hello @se4nchoi")
        assert len(mentions) == 1
        assert mentions[0]["username"] == "se4nchoi"

    def test_duplicate_display_name_mention_matches_all_sharing_accounts(self):
        """When multiple accounts share a display name, @display_name matches all of them, while @username matches specifically."""
        user1 = database.create_user("student_a", hash_secret("pass123"))
        user2 = database.create_user("student_b", hash_secret("pass123"))
        database.update_display_name(user1["id"], "민수")
        database.update_display_name(user2["id"], "민수")

        # Mentioning by shared display name matches both
        mentions = main.find_mentions("과제 제출했나요 @민수?")
        assert len(mentions) == 2
        matched_usernames = {m["username"] for m in mentions}
        assert matched_usernames == {"student_a", "student_b"}

        # Mentioning by canonical username matches only that user
        mentions_a = main.find_mentions("과제 제출했나요 @student_a?")
        assert len(mentions_a) == 1
        assert mentions_a[0]["username"] == "student_a"


# ==========================================================================
# Admin display name management
# ==========================================================================

class TestAdminDisplayName:
    def test_admin_can_set_display_name(self):
        admin_client, admin_user = session_client("adminuser", role="admin")
        target = database.create_user("target", hash_secret("pass123"))
        response = admin_client.post(f"/api/admin/users/{target['id']}",
                                     headers={**ORIGIN, "Content-Type": "application/json"},
                                     json={"display_name": "관리자설정이름"})
        assert response.status_code == 200
        updated = database.get_user_by_id(target["id"])
        assert updated["display_name"] == "관리자설정이름"

    def test_admin_overview_includes_display_name(self):
        admin_client, _ = session_client("adminuser", role="admin")
        target = database.create_user("user2", hash_secret("pass123"))
        database.update_display_name(target["id"], "보이는이름")
        overview = admin_client.get("/api/admin/overview", headers=ORIGIN).json()
        users = {u["username"]: u for u in overview["users"]}
        assert users["user2"]["display_name"] == "보이는이름"


# ==========================================================================
# Public user / account public includes display_name
# ==========================================================================

class TestPublicUserShape:
    def test_public_user_has_display_name(self):
        user = database.create_user("shapeuser", hash_secret("pass123"))
        pub = main.public_user(user)
        assert "display_name" in pub
        assert pub["display_name"] == "shapeuser"  # default = username

    def test_account_public_has_display_name(self):
        user = database.create_user("accuser", hash_secret("pass123"))
        database.update_display_name(user["id"], "멋진이름")
        updated = database.get_user_by_id(user["id"])
        pub = main.account_public(updated)
        assert pub["display_name"] == "멋진이름"


# ==========================================================================
# list_mentionable_users includes display_name
# ==========================================================================

class TestMentionableUsers:
    def test_mentionable_users_include_display_name(self):
        user = database.create_user("mentionable1", hash_secret("pass123"))
        database.update_display_name(user["id"], "표시이름")
        users = database.list_mentionable_users()
        found = [u for u in users if u["username"] == "mentionable1"]
        assert len(found) == 1
        assert found[0]["display_name"] == "표시이름"

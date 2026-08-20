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

    def test_existing_users_receive_display_name_and_uuid(self):
        """Users created after migration should have display_name=username and a uuid."""
        user = database.create_user("testuser", hash_secret("pass123"))
        assert user["display_name"] == "testuser"
        assert user["uuid"]
        assert len(user["uuid"]) == 32  # hex UUID without dashes

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

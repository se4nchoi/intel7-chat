"""Versioned hub schema migrations. Needs the disposable MADI_TEST_DATABASE_URL database."""
import os

import pytest

TEST_URL = os.environ.get("MADI_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not TEST_URL, reason="MADI_TEST_DATABASE_URL not set")

HUB_TABLES = ("hub_schema_migrations, hub_files, hub_answers, hub_questions, hub_messages, hub_channels, "
              "hub_memberships, hub_cohorts, hub_sessions, hub_accounts, hub_test_extra")


@pytest.fixture
def db(monkeypatch):
    from app.hub import db
    monkeypatch.setenv("MADI_DATABASE_URL", TEST_URL)
    with db.connect() as conn:
        conn.execute(f"DROP TABLE IF EXISTS {HUB_TABLES} CASCADE")
    yield db
    # Don't leave fake future versions behind for the next user of this database.
    with db.connect() as conn:
        conn.execute(f"DROP TABLE IF EXISTS {HUB_TABLES} CASCADE")
    db.migrate()


def versions(db):
    with db.connect() as conn:
        return [r["version"] for r in conn.execute("SELECT version FROM hub_schema_migrations ORDER BY version")]


def test_fresh_database_gets_every_migration(db):
    latest = db.available_migrations()[-1][0]
    assert db.migrate() == list(range(1, latest + 1))
    assert db.schema_version() == latest
    assert db.create_account("fresh", "Fresh", "test-pass-1234")["username"] == "fresh"


def test_migrate_twice_is_a_no_op(db):
    db.migrate()
    assert db.migrate() == []


def test_pre_migration_database_is_adopted_without_data_loss(db):
    baseline = db.available_migrations()[0][2]
    with db.connect() as conn:  # a database created by the old CREATE TABLE IF NOT EXISTS startup
        conn.execute(baseline)
    db.create_account("existing", "Existing", "test-pass-1234")
    assert db.migrate()[0] == 1
    with db.connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM hub_accounts WHERE username='existing'").fetchone()["n"] == 1


def test_new_migration_applies_once_and_failed_one_rolls_back(db):
    base = db.available_migrations()
    db.migrate(base)
    extra = base + [(len(base) + 1, "extra", "CREATE TABLE hub_test_extra (id int)")]
    assert db.migrate(extra) == [len(base) + 1]
    broken = extra + [(len(base) + 2, "broken", "ALTER TABLE hub_test_extra ADD COLUMN ok int; SELECT * FROM nope")]
    with pytest.raises(Exception):
        db.migrate(broken)
    assert versions(db)[-1] == len(base) + 1
    with db.connect() as conn:  # the half-applied ALTER was rolled back with it
        cols = {r["column_name"] for r in conn.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name='hub_test_extra'")}
    assert cols == {"id"}


def test_refuses_database_newer_than_code(db):
    base = db.available_migrations()
    db.migrate(base + [(len(base) + 1, "future", "CREATE TABLE hub_test_extra (id int)")])
    with pytest.raises(RuntimeError, match="newer than this code"):
        db.migrate(base)


def test_migration_files_are_numbered_without_gaps(monkeypatch, tmp_path):
    from app.hub import db
    (tmp_path / "0001_a.sql").write_text("SELECT 1")
    (tmp_path / "0003_c.sql").write_text("SELECT 1")
    monkeypatch.setattr(db, "MIGRATIONS_DIR", tmp_path)
    with pytest.raises(RuntimeError, match="without gaps"):
        db.available_migrations()

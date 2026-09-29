"""Backup/restore rehearsal. Needs MADI_TEST_DATABASE_URL and pg_dump/pg_restore on PATH."""
import json
import os
import shutil
import stat

from pathlib import Path

import psycopg
import pytest

TEST_URL = os.environ.get("MADI_TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.skipif(not TEST_URL, reason="MADI_TEST_DATABASE_URL not set"),
    pytest.mark.skipif(not shutil.which("pg_dump"), reason="pg_dump not on PATH"),
]


@pytest.fixture
def madi(monkeypatch, tmp_path):
    from app.hub import backup, db
    monkeypatch.setenv("MADI_DATABASE_URL", TEST_URL)
    monkeypatch.setenv("MADI_FILE_DIR", str(tmp_path / "files"))
    monkeypatch.delenv("MADI_PG_BIN", raising=False)
    monkeypatch.setattr(backup, "PORTABLE_BIN", tmp_path / "no-portable")
    with db.connect() as conn:
        conn.execute("DROP TABLE IF EXISTS hub_schema_migrations, hub_files, hub_answers, hub_questions, hub_messages, "
                     "hub_channels, hub_memberships, hub_cohorts, hub_sessions, hub_accounts CASCADE")
    db.migrate()
    account = db.create_account("keeper", "Keeper", "test-pass-1234")
    cohort = db.create_cohort("backup-2026", "Backup")
    channel = db.create_channel(cohort["id"], "general", "General")
    db.add_message(channel["id"], account["id"], "before backup")
    (tmp_path / "files").mkdir()
    (tmp_path / "files" / ("f" * 32)).write_bytes(b"original bytes")
    yield backup, db, tmp_path, channel["id"]
    db.close_pools()


def state(db, tmp_path):
    with db.connect() as conn:
        users = sorted(r["username"] for r in conn.execute("SELECT username FROM hub_accounts"))
        bodies = sorted(r["body"] for r in conn.execute("SELECT body FROM hub_messages"))
    files = sorted((p.name, p.read_bytes()) for p in (tmp_path / "files").iterdir())
    return users, bodies, files


def test_backup_restore_round_trip(madi):
    backup, db, tmp_path, channel_id = madi
    before = state(db, tmp_path)
    path = backup.backup(tmp_path / "out")
    assert path.name.startswith("madi-") and backup.verify(path)["schema_version"] == db.schema_version()

    db.create_account("intruder", "Later", "test-pass-1234")
    with db.connect() as conn:
        conn.execute("DELETE FROM hub_messages")
    (tmp_path / "files" / ("f" * 32)).unlink()
    (tmp_path / "files" / ("e" * 32)).write_bytes(b"added after backup")

    with pytest.raises(backup.BackupError, match="--replace"):
        backup.restore(path)
    manifest = backup.restore(path, replace=True)
    assert state(db, tmp_path) == before
    moved = manifest["previous_files_moved_to"]
    assert sorted(p.name for p in Path(moved).iterdir()) == ["e" * 32]
    # The restored database is usable, e.g. new rows get fresh ids.
    assert db.add_message(channel_id, db.authenticate("keeper", "test-pass-1234")["id"], "after restore")


def test_restore_into_fresh_empty_database_needs_no_replace(madi):
    backup, db, tmp_path, _ = madi
    path = backup.backup(tmp_path / "out")
    with db.connect() as conn:
        conn.execute("TRUNCATE hub_accounts CASCADE")
    backup.restore(path)
    assert state(db, tmp_path)[0] == ["keeper"]


def test_tampered_backup_fails_verification(madi):
    backup, _, tmp_path, _ = madi
    path = backup.backup(tmp_path / "out")
    (path / "files" / ("f" * 32)).write_bytes(b"changed")
    with pytest.raises(backup.BackupError, match="files/f+ is missing or changed"):
        backup.verify(path)


def test_restore_refuses_while_app_is_connected(madi):
    backup, _, tmp_path, _ = madi
    path = backup.backup(tmp_path / "out")
    with psycopg.connect(TEST_URL):
        with pytest.raises(backup.BackupError, match="stop the app first"):
            backup.restore(path, replace=True)


def test_restore_refuses_backup_newer_than_code(madi):
    backup, _, tmp_path, _ = madi
    path = backup.backup(tmp_path / "out")
    manifest = json.loads((path / "manifest.json").read_text())
    manifest["schema_version"] = 999
    (path / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(backup.BackupError, match="newer than this code"):
        backup.restore(path, replace=True)


@pytest.mark.skipif(os.name == "nt", reason="fake pg_dump is a shell script")
def test_failed_dump_leaves_no_backup_behind(madi):
    backup, _, tmp_path, _ = madi
    fake = tmp_path / "fakebin"
    fake.mkdir()
    (fake / "pg_dump").write_text("#!/bin/sh\necho boom >&2\nexit 1\n")
    (fake / "pg_dump").chmod(stat.S_IRWXU)
    with pytest.raises(backup.BackupError, match="boom"):
        backup.backup(tmp_path / "out", pg_bin=str(fake))
    assert list((tmp_path / "out").iterdir()) == []


def test_keep_prunes_oldest(madi, monkeypatch):
    backup, _, tmp_path, _ = madi
    out = tmp_path / "out"
    out.mkdir()
    for stamp in ("20260101-000000", "20260102-000000"):
        (out / f"madi-{stamp}").mkdir()
    newest = backup.backup(out, keep=2)
    assert sorted(p.name for p in out.iterdir()) == ["madi-20260102-000000", newest.name]


def test_cli_backup_and_verify(madi, capsys):
    backup, _, tmp_path, _ = madi
    assert backup.main(["backup", "--out", str(tmp_path / "out")]) == 0
    written = capsys.readouterr().out
    assert "Backup written" in written and "1 files" in written
    path = next((tmp_path / "out").iterdir())
    assert backup.main(["verify", str(path)]) == 0
    assert backup.main(["restore", str(path)]) == 1  # refuses without --replace
    assert "--replace" in capsys.readouterr().err

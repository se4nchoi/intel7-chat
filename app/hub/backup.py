"""Back up and restore 마디 (Madi): the PostgreSQL database plus uploaded files.

    uv run python -m app.hub.backup backup [--out DIR] [--keep N]
    uv run python -m app.hub.backup verify BACKUP_DIR
    uv run python -m app.hub.backup restore BACKUP_DIR [--replace]

The database URL and file directory come from the MADI_* settings, falling
back to data_dev/pg-app.env like prototype_run.py. pg_dump/pg_restore are
taken from --pg-bin, MADI_PG_BIN, data_dev/pg-portable/pgsql/bin, then PATH;
they must be at least the server's major version.

A backup is a folder holding db.dump (pg_dump custom format), files/ and
manifest.json with checksums. Stop the app before restoring.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import dict_row

from app.hub import db
from app.hub.settings import REPO_ROOT, settings

DATA_DEV = REPO_ROOT / "data_dev"
DEFAULT_OUT = DATA_DEV / "backups"
PORTABLE_BIN = DATA_DEV / "pg-portable" / "pgsql" / "bin"
FORMAT = 1


class BackupError(RuntimeError):
    pass


def _database_url() -> str:
    url = settings().database_url
    if url:
        return url
    env_file = DATA_DEV / "pg-app.env"
    if env_file.is_file():
        line = env_file.read_text(encoding="utf-8").strip()
        if line.startswith("DATABASE_URL="):
            os.environ["MADI_DATABASE_URL"] = url = line.partition("=")[2]
            return url
    raise BackupError("Set MADI_DATABASE_URL or create data_dev/pg-app.env")


def _pg_tool(name: str, pg_bin: str | None) -> str:
    exe = name + (".exe" if os.name == "nt" else "")
    for directory in (pg_bin, os.environ.get("MADI_PG_BIN"), PORTABLE_BIN):
        if directory and (Path(directory) / exe).is_file():
            return str(Path(directory) / exe)
    found = shutil.which(name)
    if not found:
        raise BackupError(f"{name} not found; pass --pg-bin or set MADI_PG_BIN")
    return found


def _pg_env(url: str) -> dict[str, str]:
    """libpq environment for url, so the password never appears on a command line."""
    parts = conninfo_to_dict(url)
    mapping = {"host": "PGHOST", "port": "PGPORT", "user": "PGUSER", "password": "PGPASSWORD",
               "dbname": "PGDATABASE", "sslmode": "PGSSLMODE"}
    env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
    env.update({mapping[k]: str(v) for k, v in parts.items() if k in mapping and v is not None})
    return env


def _run(args: list[str], env: dict[str, str]) -> None:
    result = subprocess.run(args, env=env, capture_output=True, text=True)
    if result.returncode != 0:
        raise BackupError(f"{Path(args[0]).name} failed: {result.stderr.strip() or result.stdout.strip()}")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def backup(out_dir: Path = DEFAULT_OUT, pg_bin: str | None = None, keep: int | None = None) -> Path:
    url = _database_url()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)
    final = out_dir / f"madi-{stamp}"
    partial = out_dir / f".partial-madi-{stamp}"
    if final.exists():
        raise BackupError(f"{final} already exists")
    shutil.rmtree(partial, ignore_errors=True)
    (partial / "files").mkdir(parents=True)
    try:
        _run([_pg_tool("pg_dump", pg_bin), "--format=custom", "--no-owner", "--no-privileges",
              "--file", str(partial / "db.dump")], _pg_env(url))
        files = {}
        source = settings().file_dir
        if source.is_dir():
            for path in sorted(source.iterdir()):
                if path.is_file():
                    shutil.copy2(path, partial / "files" / path.name)
                    files[path.name] = _sha256(partial / "files" / path.name)
        manifest = {
            "format": FORMAT, "app": "madi", "created_at": datetime.now(timezone.utc).isoformat(),
            "schema_version": db.schema_version(), "db_sha256": _sha256(partial / "db.dump"), "files": files,
        }
        (partial / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        partial.rename(final)  # only complete backups get the madi- name
    except BaseException:
        shutil.rmtree(partial, ignore_errors=True)
        raise
    if keep:
        for old in sorted(out_dir.glob("madi-*"))[:-keep]:
            shutil.rmtree(old)
    return final


def verify(backup_dir: Path) -> dict:
    manifest_path = backup_dir / "manifest.json"
    if not manifest_path.is_file():
        raise BackupError(f"{backup_dir} has no manifest.json; not a complete 마디 backup")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("app") != "madi" or manifest.get("format") != FORMAT:
        raise BackupError("Unrecognized backup format")
    problems = []
    if not (backup_dir / "db.dump").is_file() or _sha256(backup_dir / "db.dump") != manifest["db_sha256"]:
        problems.append("db.dump is missing or changed")
    for name, digest in manifest["files"].items():
        path = backup_dir / "files" / name
        if not path.is_file() or _sha256(path) != digest:
            problems.append(f"files/{name} is missing or changed")
    if problems:
        raise BackupError("Backup failed verification: " + "; ".join(problems))
    return manifest


def restore(backup_dir: Path, replace: bool = False, pg_bin: str | None = None) -> dict:
    manifest = verify(backup_dir)
    url = _database_url()
    known = db.available_migrations()[-1][0]
    if manifest["schema_version"] > known:
        raise BackupError(f"Backup is at schema version {manifest['schema_version']}, newer than this code ({known})")
    db.close_pools()
    # A plain connection, not the pool, so only connections from elsewhere are counted.
    with psycopg.connect(url, row_factory=dict_row) as conn:
        others = conn.execute("SELECT count(*) AS n FROM pg_stat_activity "
                              "WHERE datname=current_database() AND pid<>pg_backend_pid()").fetchone()["n"]
        has_data = (conn.execute("SELECT to_regclass('hub_accounts') IS NOT NULL AS t").fetchone()["t"]
                    and conn.execute("SELECT EXISTS (SELECT 1 FROM hub_accounts) AS t").fetchone()["t"])
    if others:
        raise BackupError(f"{others} other connection(s) to the database; stop the app first")
    if has_data and not replace:
        raise BackupError("The database already has 마디 data; pass --replace to overwrite it")
    db.close_pools()  # pg_restore --clean needs the tables free
    parts = conninfo_to_dict(url)
    dbname = parts.get("dbname") or parts.get("user") or os.environ.get("PGDATABASE")
    if not dbname:
        raise BackupError("MADI_DATABASE_URL must name the database to restore into")
    _run([_pg_tool("pg_restore", pg_bin), "--clean", "--if-exists", "--no-owner", "--no-privileges",
          "--single-transaction", "--exit-on-error", "--dbname", dbname,
          str(backup_dir / "db.dump")], _pg_env(url))
    target = settings().file_dir
    if target.exists() and any(target.iterdir()):
        aside = target.with_name(f"{target.name}.before-restore-{datetime.now():%Y%m%d-%H%M%S}")
        target.rename(aside)
        manifest["previous_files_moved_to"] = str(aside)
    target.mkdir(parents=True, exist_ok=True)
    for name in manifest["files"]:
        shutil.copy2(backup_dir / "files" / name, target / name)
    manifest["migrations_applied"] = db.migrate()
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.hub.backup", description=__doc__.split("\n\n")[0])
    parser.add_argument("--pg-bin", help="directory containing pg_dump/pg_restore")
    sub = parser.add_subparsers(dest="command", required=True)
    b = sub.add_parser("backup", help="write a new backup folder")
    b.add_argument("--out", type=Path, default=DEFAULT_OUT)
    b.add_argument("--keep", type=int, help="keep only the newest N backups in --out")
    v = sub.add_parser("verify", help="check a backup's checksums")
    v.add_argument("backup_dir", type=Path)
    r = sub.add_parser("restore", help="restore a backup (stop the app first)")
    r.add_argument("backup_dir", type=Path)
    r.add_argument("--replace", action="store_true", help="overwrite an existing 마디 database")
    args = parser.parse_args(argv)
    try:
        if args.command == "backup":
            path = backup(args.out, args.pg_bin, args.keep)
            manifest = json.loads((path / "manifest.json").read_text(encoding="utf-8"))
            print(f"Backup written: {path} (schema v{manifest['schema_version']}, {len(manifest['files'])} files)")
        elif args.command == "verify":
            manifest = verify(args.backup_dir)
            print(f"OK: {args.backup_dir} (schema v{manifest['schema_version']}, {len(manifest['files'])} files)")
        else:
            manifest = restore(args.backup_dir, args.replace, args.pg_bin)
            print(f"Restored {args.backup_dir} ({len(manifest['files'])} files)")
            if manifest.get("previous_files_moved_to"):
                print(f"Previous files kept at {manifest['previous_files_moved_to']}")
            if manifest["migrations_applied"]:
                print(f"Upgraded schema with migrations {manifest['migrations_applied']}")
    except BackupError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    finally:
        db.close_pools()
    return 0


if __name__ == "__main__":
    sys.exit(main())

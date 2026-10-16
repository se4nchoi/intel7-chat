"""Run the academy hub behind a local HTTPS proxy, without community state.

Environment is supplied by the operator/systemd. --check performs only local
configuration checks; --create-admin initializes the schema and prompts securely
for the first administrator (never creates demo accounts).
"""
from __future__ import annotations

import argparse
import getpass
import os

from app.auth import validate_display_name, validate_password, validate_username
from app.hub import db
from app.hub.application import validate_runtime
from app.hub.logs import configure
from app.hub.settings import settings


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--check", action="store_true", help="Validate local settings/build; does not contact PostgreSQL or LiveKit")
    action.add_argument("--create-admin", action="store_true", help="Create the first administrator interactively")
    args = parser.parse_args(argv)
    try:
        validate_runtime()
        port = int(os.environ.get("MADI_PORT", "8000"))
        if not 1 <= port <= 65535:
            raise ValueError("MADI_PORT must be between 1 and 65535")
        if args.check:
            print("Academy configuration and frontend build OK. Database/media connectivity has not been checked.")
            return 0
        config = settings()
        configure(config.log_file, config.log_level)
        if args.create_admin:
            username = validate_username(input("Administrator username: "))
            display_name = validate_display_name(input("Display name: "))
            password = getpass.getpass("Password: ")
            validate_password(password)
            if password != getpass.getpass("Confirm password: "):
                raise ValueError("Passwords do not match")
            try:
                db.initialize_schema()
                db.bootstrap_admin(username, display_name, password)
            finally:
                db.close_pools()
            print("Administrator created. Sign in to create cohorts and accounts.")
            return 0
        import uvicorn
        # Cohort socket registries are process-local: keep one application worker.
        # Only the local proxy may supply forwarded scheme/client headers.
        uvicorn.run("app.hub.application:create_app", factory=True,
                    host=os.environ.get("MADI_HOST", "127.0.0.1"), port=port,
                    workers=1, proxy_headers=True, forwarded_allow_ips="127.0.0.1,::1",
                    ws_max_size=65536, ws_max_queue=16, ws_per_message_deflate=False)
        return 0
    except (ValueError, RuntimeError) as error:
        parser.exit(2, f"{error}\n")


if __name__ == "__main__":
    raise SystemExit(main())

"""마디 (Madi) server log: one key=value line per security-relevant event.

Events go to the "madi" logger. configure() (called by the launcher) sends
them to stderr and a rotating file; without it, as in tests, they propagate
to the root logger. Values are passed through %r where they come from users,
so a crafted username can't forge extra log lines. Passwords and session
tokens are never logged.
"""
from __future__ import annotations

import logging
import logging.handlers
import time
from pathlib import Path

log = logging.getLogger("madi")

FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"


def configure(log_file: Path | None, level: str = "INFO") -> None:
    formatter = logging.Formatter(FORMAT, datefmt="%Y-%m-%dT%H:%M:%SZ")
    formatter.converter = time.gmtime  # UTC, matching the database timestamps
    handlers: list[logging.Handler] = [logging.StreamHandler()]
    if log_file:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.handlers.RotatingFileHandler(
            log_file, maxBytes=5 * 1024 * 1024, backupCount=10, encoding="utf-8"))
    for handler in log.handlers[:]:
        log.removeHandler(handler)
        handler.close()
    for handler in handlers:
        handler.setFormatter(formatter)
        log.addHandler(handler)
    log.setLevel(level.upper())
    log.propagate = False

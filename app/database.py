"""Database facade maintaining 100% backward compatibility with the modular app.db package."""
from __future__ import annotations

from app.db import *
from app.db import __all__ as _all_exports

__all__ = list(_all_exports)

"""Hub checks that need no database: login throttle window, timing-safe login."""
from contextlib import contextmanager

from app.hub import db, routes


def test_login_window_expires(monkeypatch):
    monkeypatch.setattr(routes, "login_attempts", {})
    for i in range(routes.LOGIN_LIMIT):
        assert routes._login_allowed("ip:user", now=100.0 + i)
    assert not routes._login_allowed("ip:user", now=150.0)
    assert routes._login_allowed("ip:other", now=150.0)
    # Once the oldest attempt leaves the window, one more is allowed.
    assert routes._login_allowed("ip:user", now=100.0 + routes.LOGIN_WINDOW_SECONDS + 0.5)


def test_login_window_forgets_stale_keys(monkeypatch):
    monkeypatch.setattr(routes, "login_attempts", {})
    routes._login_allowed("ip:typo-1", now=0.0)
    routes._login_allowed("ip:typo-2", now=0.0)
    routes._login_allowed("ip:user", now=routes.LOGIN_WINDOW_SECONDS + 1.0)
    assert set(routes.login_attempts) == {"ip:user"}


def test_unknown_username_still_verifies_a_hash(monkeypatch):
    class NoRows:
        def execute(self, *args):
            return self

        def fetchone(self):
            return None

    @contextmanager
    def fake_connect():
        yield NoRows()

    checked = []
    monkeypatch.setattr(db, "connect", fake_connect)
    monkeypatch.setattr(db, "verify_secret", lambda stored, password: checked.append(password) or False)
    assert db.authenticate("nobody", "guess-1234") is None
    assert checked == ["guess-1234"]

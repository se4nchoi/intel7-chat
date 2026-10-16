import asyncio
from types import SimpleNamespace

import pytest

from app import asyncio_errors


def callback():
    pass


callback.__module__ = "asyncio.proactor_events"
callback.__qualname__ = "_ProactorBasePipeTransport._call_connection_lost"


@pytest.mark.parametrize("platform,code,known_callback,suppressed", [
    ("win32", 10054, True, True),
    ("win32", 10053, True, False),
    ("win32", 10054, False, False),
    ("linux", 10054, True, False),
])
def test_only_known_windows_teardown_reset_is_filtered(monkeypatch, platform, code,
                                                       known_callback, suppressed):
    monkeypatch.setattr(asyncio_errors.sys, "platform", platform)
    loop = asyncio.new_event_loop()
    received = []
    previous = lambda active, context: received.append(context)
    loop.set_exception_handler(previous)
    try:
        assert asyncio_errors.install_disconnect_handler(loop) is previous
        error = ConnectionResetError("peer reset")
        error.winerror = code
        context = {"exception": error,
                   "handle": SimpleNamespace(_callback=callback if known_callback else None)}
        loop.call_exception_handler(context)
        assert received == ([] if suppressed else [context])
    finally:
        loop.close()


def test_unrelated_errors_use_default_handler(monkeypatch):
    loop = asyncio.new_event_loop()
    received = []
    monkeypatch.setattr(loop, "default_exception_handler", received.append)
    try:
        assert asyncio_errors.install_disconnect_handler(loop) is None
        context = {"exception": RuntimeError("real application failure")}
        loop.call_exception_handler(context)
        assert received == [context]
    finally:
        loop.close()

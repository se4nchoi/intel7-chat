import asyncio
from collections import deque
import threading

import pytest

from app import main


@pytest.fixture
def isolated_limits(monkeypatch):
    for name in ("message_timestamps", "screenshare_timestamps", "upload_timestamps", "login_timestamps"):
        monkeypatch.setattr(main, name, {})


def test_rate_limit_cleanup_respects_each_window_and_active_budgets(isolated_limits):
    now = 1000
    for registry, window in (
        (main.message_timestamps, main.RATE_LIMIT_WINDOW_SECONDS),
        (main.screenshare_timestamps, main.RATE_LIMIT_WINDOW_SECONDS),
        (main.upload_timestamps, main.UPLOAD_RATE_WINDOW_SECONDS),
        (main.login_timestamps, main.LOGIN_RATE_WINDOW_SECONDS),
    ):
        registry["expired"] = deque([now - window])
        registry["empty"] = deque()
        registry["active"] = deque([now - window, now - 1, now])
    assert main.prune_rate_limits(now) == 8
    for registry in (main.message_timestamps, main.screenshare_timestamps,
                     main.upload_timestamps, main.login_timestamps):
        assert list(registry) == ["active"]
        assert list(registry["active"]) == [now - 1, now]
        assert not main.sliding_window_allowed(registry, "active", 2, 10, now=now)
    assert main.prune_rate_limits(now + 301) == 4


def test_same_ip_can_use_multiple_tabs_but_total_connection_ceiling_remains(monkeypatch):
    clients = {object(): main.ClientInfo(i, f"student{i}", "student", "192.168.1.20")
               for i in range(23)}
    monkeypatch.setattr(main, "connected_clients", clients)
    assert main.connection_limit_reason("192.168.1.20") == ""
    for i in range(23, main.MAX_CONNECTIONS_TOTAL):
        clients[object()] = main.ClientInfo(i, f"student{i}", "student", "192.168.1.20")
    assert main.connection_limit_reason("192.168.1.20")
    assert main.connection_limit_reason("192.168.1.21")


def test_rate_limit_maintenance_runs_and_can_be_stopped(monkeypatch):
    async def run():
        cleaned = asyncio.Event()
        monkeypatch.setattr(main, "RATE_LIMIT_CLEANUP_INTERVAL", .01)
        monkeypatch.setattr(main, "prune_rate_limits", lambda: cleaned.set())
        task = asyncio.create_task(main.maintain_rate_limits())
        try:
            await asyncio.wait_for(cleaned.wait(), 1)
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        assert task.cancelled()
    asyncio.run(run())


def test_password_burst_waits_for_capacity_instead_of_rejecting(monkeypatch):
    async def run():
        monkeypatch.setattr(main, "password_work_slots", asyncio.Semaphore(2))
        gate = threading.Event()
        started = 0
        lock = threading.Lock()
        both_started = asyncio.Event()
        loop = asyncio.get_running_loop()

        def work(value):
            nonlocal started
            with lock:
                started += 1
                if started == 2:
                    loop.call_soon_threadsafe(both_started.set)
            assert gate.wait(2)
            return value

        tasks = [asyncio.create_task(main.run_password_work(work, i)) for i in range(6)]
        try:
            await asyncio.wait_for(both_started.wait(), 1)
            assert started == 2
        finally:
            gate.set()
            results = await asyncio.gather(*tasks)
        assert results == list(range(6))
    asyncio.run(run())


def test_canceled_password_work_keeps_slot_until_thread_finishes(monkeypatch):
    async def run():
        monkeypatch.setattr(main, "password_work_slots", asyncio.Semaphore(1))
        gate = threading.Event()
        started = asyncio.Event()
        loop = asyncio.get_running_loop()

        def work():
            loop.call_soon_threadsafe(started.set)
            assert gate.wait(2)

        first = asyncio.create_task(main.run_password_work(work))
        await asyncio.wait_for(started.wait(), 1)
        first.cancel()
        second = asyncio.create_task(main.run_password_work(lambda: "done"))
        try:
            await asyncio.sleep(0)
            assert main.password_work_slots.locked()
            assert not second.done()
        finally:
            gate.set()
            results = await asyncio.gather(first, second, return_exceptions=True)
        assert isinstance(results[0], asyncio.CancelledError)
        assert results[1] == "done"
    asyncio.run(run())

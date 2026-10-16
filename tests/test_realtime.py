import asyncio

import pytest
from starlette.websockets import WebSocketDisconnect

from app.realtime import ManagedSocket


class Socket:
    def __init__(self, blocked=False):
        self.gate = asyncio.Event()
        if not blocked:
            self.gate.set()
        self.delivered = asyncio.Event()
        self.sent = []
        self.code = None

    async def send_text(self, text):
        await self.gate.wait()
        self.sent.append(text)
        self.delivered.set()

    async def receive_text(self):
        await asyncio.Event().wait()

    async def close(self, code, reason=None):
        self.code = code


def connection(socket):
    return ManagedSocket(socket, "session", 1, lambda _: {"id": 1})


def test_slow_client_does_not_block_healthy_client_and_preserves_order():
    async def run():
        slow, fast = connection(Socket(blocked=True)), connection(Socket())
        try:
            for client in (slow, fast):
                await client.send_text("first")
                await client.send_text("second")
            await asyncio.wait_for(fast.queue.join(), 1)
            assert fast.socket.sent == ["first", "second"]
            assert slow.socket.sent == []
        finally:
            await asyncio.gather(slow.shutdown(), fast.shutdown())
        assert slow.writer.done() and fast.writer.done()
    asyncio.run(run())


@pytest.mark.parametrize("limit", ["events", "bytes"])
def test_queue_limits_disconnect_instead_of_silently_dropping(monkeypatch, limit):
    monkeypatch.setattr(ManagedSocket, "MAX_EVENTS", 2)
    monkeypatch.setattr(ManagedSocket, "MAX_BYTES", 5 if limit == "bytes" else 1024)

    async def run():
        client = connection(Socket(blocked=True))
        try:
            await client.send_text("가" if limit == "bytes" else "one")
            if limit == "events":
                await client.send_text("two")
            with pytest.raises(WebSocketDisconnect) as error:
                await client.send_text("가" if limit == "bytes" else "three")
            assert error.value.code == 1013
            await asyncio.wait_for(client.closed.wait(), 1)
            assert client.queued_bytes == 0
            assert client.socket.sent == []
        finally:
            await client.shutdown()
        assert client not in ManagedSocket.active
    asyncio.run(run())


def test_send_timeout_disconnects_only_slow_socket(monkeypatch):
    monkeypatch.setattr(ManagedSocket, "SEND_TIMEOUT", .02)

    async def run():
        client = connection(Socket(blocked=True))
        try:
            await client.send_text("hello")
            await asyncio.wait_for(client.closed.wait(), 1)
            assert client.socket.code == 1013
        finally:
            await client.shutdown()
    asyncio.run(run())


def test_idle_session_expiry_wakes_receiver_and_stops_delivery(monkeypatch):
    monkeypatch.setattr(ManagedSocket, "SESSION_CHECK_INTERVAL", .02)

    async def run():
        client = ManagedSocket(Socket(), "expired", 1, lambda _: None)
        try:
            with pytest.raises(WebSocketDisconnect) as error:
                await asyncio.wait_for(client.receive_text(), 1)
            assert error.value.code == 1008
            assert client.socket.sent == []
        finally:
            await client.shutdown()
    asyncio.run(run())


def test_revoked_session_cannot_receive_queued_frames():
    async def run():
        client = ManagedSocket(Socket(), "expired", 1, lambda _: None)
        try:
            await client.send_text("private event")
            await asyncio.wait_for(client.closed.wait(), 1)
            assert client.socket.sent == []
            assert client.socket.code == 1008
        finally:
            await client.shutdown()
    asyncio.run(run())


def test_application_close_flushes_final_error_before_close():
    async def run():
        client = connection(Socket())
        await client.send_text("rate limit error")
        await client.close(1008, "rate limit")
        assert client.socket.sent == ["rate limit error"]
        assert client.socket.code == 1008
    asyncio.run(run())


def test_endpoint_cleanup_preserves_pending_slow_client_close_code(monkeypatch):
    monkeypatch.setattr(ManagedSocket, "MAX_EVENTS", 1)

    async def run():
        client = connection(Socket(blocked=True))
        await client.send_text("one")
        with pytest.raises(WebSocketDisconnect):
            await client.send_text("two")
        # Cleanup can run before the scheduled close task gets a turn.
        await client.shutdown()
        assert client.socket.code == 1013
        assert client.writer.done()
    asyncio.run(run())

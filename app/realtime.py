"""Bounded, ordered WebSocket delivery and session lifetime enforcement."""
from __future__ import annotations

import asyncio
from contextlib import suppress
import json
import logging
import anyio

from starlette.websockets import WebSocketDisconnect

logger = logging.getLogger(__name__)


class ManagedSocket:
    """One writer per accepted socket; broadcasts only enqueue bounded work.

    Session validation happens before delivery, after receive, and while idle.
    Overflow disconnects the client so it can fetch authoritative history again.
    """

    active: set[ManagedSocket] = set()
    MAX_EVENTS = 128
    MAX_BYTES = 1024 * 1024
    SEND_TIMEOUT = 5.0
    SESSION_CHECK_INTERVAL = 10.0

    def __init__(self, socket, session_hash: str, user_id: int, session_lookup):
        self.socket = socket
        self.session_hash = session_hash
        self.user_id = user_id
        self.session_lookup = session_lookup
        self.queue = asyncio.Queue(maxsize=self.MAX_EVENTS)
        self.queued_bytes = 0
        self.accepting = True
        self.closed = asyncio.Event()
        self.close_lock = asyncio.Lock()
        self.close_code = 1000
        self.closer = None
        self.active.add(self)
        self.writer = asyncio.create_task(self._write(), name="websocket-writer")

    def __getattr__(self, name):
        return getattr(self.socket, name)

    async def _authorized(self):
        user = await asyncio.to_thread(self.session_lookup, self.session_hash)
        return bool(user and user["id"] == self.user_id)

    def _schedule_close(self, code, reason):
        self.accepting = False
        self.close_code = code
        if self.closer is None:
            self.closer = asyncio.create_task(self.close(code, reason, drain=False))

    async def send_text(self, text):
        if not self.accepting:
            raise WebSocketDisconnect(self.close_code)
        size = len(text.encode("utf-8"))
        if self.queue.full() or self.queued_bytes + size > self.MAX_BYTES:
            logger.warning("WebSocket outbound queue full user=%s events=%s bytes=%s",
                           self.user_id, self.queue.qsize(), self.queued_bytes)
            self._schedule_close(1013, "Slow connection; reconnect to synchronize")
            raise WebSocketDisconnect(1013)
        self.queued_bytes += size
        self.queue.put_nowait((text, size))

    async def send_initial_text(self, text):
        """Pace server-produced history without blocking broadcasts to peers.

        Unlike live fan-out, a snapshot can legitimately exceed the queue's
        capacity even with a healthy receiver. Drain each history frame before
        producing the next one. All writes still go through the same writer.
        """
        await self.send_text(text)
        try:
            await asyncio.wait_for(self.queue.join(), timeout=self.SEND_TIMEOUT)
        except asyncio.TimeoutError:
            await self.close(1013, "History delivery timed out; reconnect", drain=False)
            raise WebSocketDisconnect(1013) from None
        if not self.accepting:
            raise WebSocketDisconnect(self.close_code)

    async def send_json(self, data, mode="text"):
        if mode != "text":
            raise ValueError("Only text JSON frames are supported")
        await self.send_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))

    async def _write(self):
        try:
            while True:
                try:
                    text, size = await asyncio.wait_for(
                        self.queue.get(), timeout=self.SESSION_CHECK_INTERVAL)
                except asyncio.TimeoutError:
                    if not await self._authorized():
                        self._schedule_close(1008, "Session expired")
                        return
                    continue
                try:
                    if not await self._authorized():
                        self._schedule_close(1008, "Session expired")
                        return
                    await asyncio.wait_for(self.socket.send_text(text), timeout=self.SEND_TIMEOUT)
                finally:
                    self.queued_bytes -= size
                    self.queue.task_done()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("WebSocket delivery failed user=%s", self.user_id, exc_info=True)
            self._schedule_close(1013, "Connection interrupted; reconnect to synchronize")

    async def receive_text(self):
        receive = asyncio.create_task(self.socket.receive_text())
        closing = asyncio.create_task(self.closed.wait())
        try:
            done, _ = await asyncio.wait((receive, closing), return_when=asyncio.FIRST_COMPLETED)
            if closing in done:
                raise WebSocketDisconnect(self.close_code)
            text = receive.result()
            if not await self._authorized():
                await self.close(1008, "Session expired", drain=False)
                raise WebSocketDisconnect(1008)
            return text
        finally:
            with anyio.CancelScope(shield=True):
                for task in (receive, closing):
                    task.cancel()
                await asyncio.gather(receive, closing, return_exceptions=True)

    async def close(self, code=1000, reason=None, *, drain=True):
        async with self.close_lock:
            if self.closed.is_set():
                return
            self.accepting = False
            self.close_code = code
            # Preserve queued error/ack frames on ordinary application closes.
            # Revocation and slow-client closes always discard queued frames.
            if drain:
                with suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self.queue.join(), timeout=1.0)
            self.writer.cancel()
            await asyncio.gather(self.writer, return_exceptions=True)
            while not self.queue.empty():
                _, size = self.queue.get_nowait()
                self.queued_bytes -= size
                self.queue.task_done()
            self.active.discard(self)
            self.closed.set()
            with suppress(Exception):
                await asyncio.wait_for(self.socket.close(code=code, reason=reason), timeout=1.0)

    async def shutdown(self):
        if self.closer is not None:
            await asyncio.gather(self.closer, return_exceptions=True)
        else:
            await self.close(drain=False)

    @classmethod
    async def disconnect(cls, *, user_id=None, session_hash=None, reason="Session expired"):
        targets = [socket for socket in list(cls.active)
                   if (user_id is None or socket.user_id == user_id)
                   and (session_hash is None or socket.session_hash == session_hash)]
        await asyncio.gather(*(socket.close(1008, reason, drain=False) for socket in targets))

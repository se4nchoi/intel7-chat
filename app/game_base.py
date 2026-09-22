"""Base class for turn-based multiplayer game managers (Chess, Janggi, Omok)."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import ClassVar, Dict, List, Optional, Set, Tuple
from fastapi import WebSocket
from app.database import get_user_by_id


class BaseTurnBasedGameManager:
    """Shared infrastructure for turn-based games (lobbies, sockets, clocks, disconnect grace)."""

    player_roles: ClassVar[Tuple[str, str]] = ("player1", "player2")
    logger: logging.Logger = logging.getLogger("bamboochat.game")

    def __init__(self) -> None:
        self.rooms: Dict[str, dict] = {}
        self.lobby_sockets: Set[WebSocket] = set()
        self.room_sockets: Dict[str, Set[WebSocket]] = {}
        self.socket_user: Dict[WebSocket, dict] = {}
        self.socket_room: Dict[WebSocket, str] = {}
        self.clock_task: Optional[asyncio.Task] = None
        self.result_reset_tasks: Dict[str, asyncio.Task] = {}
        self.result_display_seconds: float = 3.0
        self.disconnect_tasks: Dict[Tuple[str, str], asyncio.Task] = {}
        self.disconnect_grace_seconds: float = 30.0

    def start_clock_monitor(self) -> None:
        if self.clock_task is None or self.clock_task.done():
            self.clock_task = asyncio.create_task(self._clock_monitor())

    def _timeout_winner_and_desc(self, expected_color: str) -> Tuple[str, str]:
        """Return (winner_role, description) when expected_color runs out of time."""
        raise NotImplementedError

    async def _clock_monitor(self) -> None:
        role1, role2 = self.player_roles
        while True:
            try:
                await asyncio.sleep(0.2)
                for room_id in list(self.rooms):
                    room = self.rooms.get(room_id)
                    if not room or not room.get("game_started") or room.get("result"):
                        continue
                    if not room.get(role1) or not room.get(role2) or room.get("draw_offer"):
                        continue
                    now = time.time()
                    self._refresh_clock(room, now)
                    turn_key = f"{room['active_turn']}_remain"
                    if room["clock"][turn_key] <= 0:
                        winner, desc = self._timeout_winner_and_desc(room["active_turn"])
                        self._complete_game(room, {"type": "timeout", "winner": winner, "desc": desc})
                        await self.broadcast_room(room_id)
                    elif now - room["clock"].get("last_broadcast_at", 0) >= 5.0:
                        room["clock"]["last_broadcast_at"] = now
                        await self.broadcast_room(room_id)
            except asyncio.CancelledError:
                break
            except Exception:
                self.logger.exception("Unexpected error in %s _clock_monitor", self.__class__.__name__)
                await asyncio.sleep(1.0)

    def register_client(self, ws: WebSocket, user: dict) -> None:
        self.socket_user[ws] = user
        self.lobby_sockets.add(ws)

    @staticmethod
    def _player_for(user: dict) -> dict:
        current = None
        try:
            current = get_user_by_id(int(user["id"]))
        except Exception:
            current = None
        display_name = (current or user).get("display_name") or user.get("username", "")
        return {"id": user["id"], "username": user.get("username", ""), "name": display_name}

    async def unregister_client(self, ws: WebSocket) -> None:
        user = self.socket_user.pop(ws, None)
        self.lobby_sockets.discard(ws)
        room_id = self.socket_room.pop(ws, None)
        if room_id and room_id in self.room_sockets:
            self.room_sockets[room_id].discard(ws)
            if user:
                self._schedule_disconnect(user, room_id)

    def _schedule_disconnect(self, user: dict, room_id: str) -> None:
        key = (room_id, str(user["id"]))
        previous = self.disconnect_tasks.pop(key, None)
        if previous and not previous.done():
            previous.cancel()
        self.disconnect_tasks[key] = asyncio.create_task(
            self._handle_disconnect_after_grace(user, room_id, key)
        )

    async def _handle_disconnect_after_grace(
        self, user: dict, room_id: str, key: Tuple[str, str]
    ) -> None:
        try:
            await asyncio.sleep(self.disconnect_grace_seconds)
            room = self.rooms.get(room_id)
            if not room:
                return
            if any(
                str(self.socket_user.get(ws, {}).get("id")) == key[1]
                for ws in self.room_sockets.get(room_id, set())
            ):
                return
            await self.handle_disconnect_from_room(user, room_id)
        except asyncio.CancelledError:
            return
        finally:
            if self.disconnect_tasks.get(key) is asyncio.current_task():
                self.disconnect_tasks.pop(key, None)

    def _cancel_disconnect_timer(self, user_id: int, room_id: str) -> None:
        key = (room_id, str(user_id))
        t = self.disconnect_tasks.pop(key, None)
        if t and not t.done():
            t.cancel()

    def _cancel_result_reset(self, room_id: str) -> None:
        t = self.result_reset_tasks.pop(room_id, None)
        if t and not t.done():
            t.cancel()

    def get_lobby_summary(self) -> List[dict]:
        """Return serialized list of all active rooms in lobby."""
        raise NotImplementedError

    async def broadcast_lobby(self) -> None:
        payload = json.dumps(
            {"type": "lobby_update", "rooms": self.get_lobby_summary()}, ensure_ascii=False
        )
        stale = []
        for ws in list(self.lobby_sockets):
            try:
                await ws.send_text(payload)
            except Exception:
                stale.append(ws)
        for ws in stale:
            self.lobby_sockets.discard(ws)

    def _sync_room_owner(self, room: dict, leaving_owner_id: Optional[int] = None) -> None:
        role1, role2 = self.player_roles
        p1 = room.get(role1)
        p2 = room.get(role2)
        owner_id = room.get("owner_id")

        if leaving_owner_id is not None and owner_id == leaving_owner_id:
            if p1 and p1["id"] != leaving_owner_id:
                room["owner_id"] = p1["id"]
                room["created_by"] = p1["name"]
            elif p2 and p2["id"] != leaving_owner_id:
                room["owner_id"] = p2["id"]
                room["created_by"] = p2["name"]
            else:
                room["owner_id"] = None
                room["created_by"] = None
            return

        seated = [p for p in (p1, p2) if p]
        seated_ids = [p["id"] for p in seated]
        if not seated:
            room["owner_id"] = None
            room["created_by"] = None
        elif owner_id is None or owner_id not in seated_ids:
            first = seated[0]
            room["owner_id"] = first["id"]
            room["created_by"] = first["name"]

    def _refresh_clock(self, room: dict, now: float) -> None:
        role1, role2 = self.player_roles
        if (
            room.get("game_started")
            and not room.get("result")
            and room.get(role1)
            and room.get(role2)
            and not room.get("draw_offer")
        ):
            turn = room["active_turn"]
            deadline_key = f"{turn}_deadline"
            deadline = room["clock"].get(deadline_key)
            if deadline is None:
                deadline = now + room["clock"][f"{turn}_remain"]
                room["clock"][deadline_key] = deadline
            room["clock"][f"{turn}_remain"] = max(0.0, deadline - now)
        room["clock"]["last_tick_at"] = now

    async def send_room_chat(self, user: dict, room_id: str, text: str) -> None:
        room = self.rooms.get(room_id)
        if not room:
            return
        clean = text.strip()[:200]
        if not clean:
            return
        now = time.time()
        p = self._player_for(user)
        msg = {
            "id": f"c_{int(now * 1000)}",
            "user_id": p["id"],
            "username": p["username"],
            "name": p["name"],
            "text": clean,
            "time": now,
        }
        room.setdefault("chat", []).append(msg)
        if len(room["chat"]) > 100:
            room["chat"] = room["chat"][-100:]
        payload = json.dumps({"type": "room_chat", "message": msg}, ensure_ascii=False)
        for ws in list(self.room_sockets.get(room_id, set())):
            try:
                await ws.send_text(payload)
            except Exception:
                pass

    async def _send_error(self, user: dict, message: str) -> None:
        payload = json.dumps({"type": "error", "message": message}, ensure_ascii=False)
        for ws, u in list(self.socket_user.items()):
            if u.get("id") == user.get("id"):
                try:
                    await ws.send_text(payload)
                except Exception:
                    pass

    async def handle_disconnect_from_room(self, user: dict, room_id: str) -> None:
        """Game-specific handling when a player's grace period expires."""
        raise NotImplementedError

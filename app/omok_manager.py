"""In-memory Omok (Gomoku) Room and Multiplayer Game State Manager."""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Dict, List, Optional, Set
from fastapi import WebSocket
from app.omok_engine import OmokBoard
from app.database import get_omok_stats, get_user_by_id, record_omok_result

logger = logging.getLogger("bamboochat.omok")


class OmokManager:
    def __init__(self) -> None:
        self.rooms: Dict[str, dict] = {}
        self.lobby_sockets: Set[WebSocket] = set()
        self.room_sockets: Dict[str, Set[WebSocket]] = {}
        self.socket_user: Dict[WebSocket, dict] = {}
        self.socket_room: Dict[WebSocket, str] = {}
        self.clock_task: Optional[asyncio.Task] = None
        self.result_reset_tasks: Dict[str, asyncio.Task] = {}
        self.result_display_seconds = 3.0
        self.disconnect_tasks: Dict[tuple[str, str], asyncio.Task] = {}
        self.disconnect_grace_seconds = 30.0

    def start_clock_monitor(self) -> None:
        if self.clock_task is None or self.clock_task.done():
            self.clock_task = asyncio.create_task(self._clock_monitor())

    async def _clock_monitor(self) -> None:
        while True:
            try:
                await asyncio.sleep(0.2)
                for room_id in list(self.rooms):
                    room = self.rooms.get(room_id)
                    if not room or not room["game_started"] or room["result"]:
                        continue
                    if not room["black"] or not room["white"] or room["draw_offer"]:
                        continue
                    now = time.time()
                    self._refresh_clock(room, now)
                    turn_key = f"{room['active_turn']}_remain"
                    if room["clock"][turn_key] <= 0:
                        expected = room["active_turn"]
                        winner = "w" if expected == "b" else "b"
                        self._complete_game(room, {
                            "type": "timeout",
                            "winner": winner,
                            "desc": f"{'백(白)' if winner == 'w' else '흑(黑)'} 시간승"
                        })
                        await self.broadcast_room(room_id)
                    elif now - room["clock"].get("last_broadcast_at", 0) >= 5.0:
                        room["clock"]["last_broadcast_at"] = now
                        await self.broadcast_room(room_id)
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("Unexpected error in omok _clock_monitor")
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

    async def _handle_disconnect_after_grace(self, user: dict, room_id: str, key: tuple[str, str]) -> None:
        try:
            await asyncio.sleep(self.disconnect_grace_seconds)
            room = self.rooms.get(room_id)
            if not room:
                return
            if any(str(self.socket_user.get(ws, {}).get("id")) == key[1]
                   for ws in self.room_sockets.get(room_id, set())):
                return
            await self.handle_disconnect_from_room(user, room_id)
        except asyncio.CancelledError:
            return
        finally:
            if self.disconnect_tasks.get(key) is asyncio.current_task():
                self.disconnect_tasks.pop(key, None)

    def get_lobby_summary(self) -> List[dict]:
        summary = []
        for r_id, room in self.rooms.items():
            summary.append({
                "id": r_id,
                "title": room["title"],
                "created_by": room["created_by"],
                "time_minutes": room["time_minutes"],
                "black": room["black"]["name"] if room["black"] else None,
                "white": room["white"]["name"] if room["white"] else None,
                "spectator_count": len(room["spectators"]),
                "game_started": room["game_started"],
                "result": room["result"],
                "created_at": room["created_at"],
            })
        summary.sort(key=lambda x: x["created_at"], reverse=True)
        return summary

    async def broadcast_lobby(self) -> None:
        payload = json.dumps({"type": "lobby_update", "rooms": self.get_lobby_summary()}, ensure_ascii=False)
        stale = []
        for ws in list(self.lobby_sockets):
            try:
                await ws.send_text(payload)
            except Exception:
                stale.append(ws)
        for ws in stale:
            self.lobby_sockets.discard(ws)

    async def broadcast_room(self, room_id: str) -> None:
        room = self.rooms.get(room_id)
        if not room:
            return
        now = time.time()
        self._refresh_clock(room, now)
        self._refresh_player_stats(room)
        clock = dict(room["clock"])

        payload = json.dumps({
            "type": "room_state",
            "server_now": now,
            "room": {
                "id": room["id"],
                "title": room["title"],
                "time_minutes": room["time_minutes"],
                "black": room["black"],
                "white": room["white"],
                "spectators": room["spectators"],
                "match_queue": room["match_queue"],
                "board": room["board"].to_dict() if room["board"] else None,
                "active_turn": room["active_turn"],
                "move_history": room["move_history"],
                "last_move": room["last_move"],
                "game_started": room["game_started"],
                "result": room["result"],
                "draw_offer": room["draw_offer"],
                "clock": {
                    "b_remain": round(clock["b_remain"], 1),
                    "w_remain": round(clock["w_remain"], 1),
                    "b_deadline": clock.get("b_deadline"),
                    "w_deadline": clock.get("w_deadline"),
                    "last_tick_at": now,
                },
                "stats": room["stats"],
            }
        }, ensure_ascii=False)

        stale = []
        for ws in list(self.room_sockets.get(room_id, set())):
            try:
                await ws.send_text(payload)
            except Exception:
                stale.append(ws)
        for ws in stale:
            self.room_sockets[room_id].discard(ws)

    async def create_room(self, ws: WebSocket, user: dict, title: str, time_minutes: int) -> dict:
        room_id = f"omok-{uuid.uuid4().hex[:6]}"
        title = (title or f"{user.get('display_name') or user['username']}의 오목방").strip()[:30]
        try:
            time_minutes = max(1, min(180, int(time_minutes or 10)))
        except (ValueError, TypeError):
            time_minutes = 10

        player = self._player_for(user)
        room = {
            "id": room_id,
            "title": title,
            "created_by": player["name"],
            "time_minutes": time_minutes,
            "black": player,
            "white": None,
            "spectators": [],
            "match_queue": [],
            "board": None,
            "active_turn": "b",
            "move_history": [],
            "last_move": None,
            "game_started": False,
            "result": None,
            "draw_offer": None,
            "clock": {
                "b_remain": float(time_minutes * 60),
                "w_remain": float(time_minutes * 60),
                "b_deadline": None,
                "w_deadline": None,
                "last_tick_at": time.time(),
            },
            "stats": {},
            "created_at": time.time(),
        }

        self.rooms[room_id] = room
        if room_id not in self.room_sockets:
            self.room_sockets[room_id] = set()

        self.lobby_sockets.discard(ws)
        self.room_sockets[room_id].add(ws)
        self.socket_room[ws] = room_id

        await self.broadcast_lobby()
        await self.broadcast_room(room_id)
        return room

    async def join_room(self, ws: WebSocket, user: dict, room_id: str, role_pref: Optional[str] = None) -> Optional[dict]:
        room = self.rooms.get(room_id)
        if not room:
            await ws.send_text(json.dumps({"type": "error", "message": "방이 존재하지 않습니다."}, ensure_ascii=False))
            return None

        pending = self.disconnect_tasks.pop((room_id, str(user["id"])), None)
        if pending and not pending.done():
            pending.cancel()

        player = self._player_for(user)
        user_id = str(user["id"])

        if room.get("black") and str(room["black"]["id"]) == user_id:
            room["black"] = player
        elif room.get("white") and str(room["white"]["id"]) == user_id:
            room["white"] = player
        else:
            room["spectators"] = [s for s in room["spectators"] if str(s["id"]) != user_id]
            if role_pref == "b" and not room["black"] and not room["game_started"]:
                room["black"] = player
            elif role_pref == "w" and not room["white"] and not room["game_started"]:
                room["white"] = player
            elif not room["black"] and not room["game_started"]:
                room["black"] = player
            elif not room["white"] and not room["game_started"]:
                room["white"] = player
            else:
                room["spectators"].append(player)

        if room_id not in self.room_sockets:
            self.room_sockets[room_id] = set()
        self.lobby_sockets.discard(ws)
        self.room_sockets[room_id].add(ws)
        self.socket_room[ws] = room_id

        await self.broadcast_room(room_id)
        await self.broadcast_lobby()
        return room

    async def leave_room(self, ws: WebSocket, user: dict, room_id: str) -> None:
        self.socket_room.pop(ws, None)
        if room_id in self.room_sockets:
            self.room_sockets[room_id].discard(ws)
        self.lobby_sockets.add(ws)
        await self.handle_disconnect_from_room(user, room_id)
        await self.broadcast_lobby()

    async def handle_disconnect_from_room(self, user: dict, room_id: str) -> None:
        room = self.rooms.get(room_id)
        if not room:
            return

        user_id = user["id"]
        has_other_connection = any(
            self.socket_user.get(client_ws, {}).get("id") == user_id
            for client_ws in self.room_sockets.get(room_id, set())
        )
        if has_other_connection:
            return

        if room["game_started"] and not room["result"]:
            if room["black"] and room["black"]["id"] == user_id:
                room["black"] = None
                self._complete_game(room, {"type": "disconnect", "winner": "w", "desc": "흑 플레이어 이탈로 인한 백 부전승"})
            elif room["white"] and room["white"]["id"] == user_id:
                room["white"] = None
                self._complete_game(room, {"type": "disconnect", "winner": "b", "desc": "백 플레이어 이탈로 인한 흑 부전승"})
        else:
            if room["black"] and room["black"]["id"] == user_id:
                room["black"] = None
            if room["white"] and room["white"]["id"] == user_id:
                room["white"] = None

        room["spectators"] = [s for s in room["spectators"] if s["id"] != user_id]
        if not room["black"] and not room["white"] and not room["spectators"]:
            self.rooms.pop(room_id, None)
            self.room_sockets.pop(room_id, None)
            await self.broadcast_lobby()
            return

        await self.broadcast_room(room_id)
        await self.broadcast_lobby()

    async def pick_role(self, user: dict, room_id: str, role: str) -> None:
        room = self.rooms.get(room_id)
        if not room or room["game_started"]:
            return

        user_id = user["id"]
        player = self._player_for(user)

        if room["black"] and str(room["black"]["id"]) == str(user_id):
            room["black"] = None
        if room["white"] and str(room["white"]["id"]) == str(user_id):
            room["white"] = None
        room["spectators"] = [s for s in room["spectators"] if s["id"] != user_id]

        if role == "b" and not room["black"]:
            room["black"] = player
        elif role == "w" and not room["white"]:
            room["white"] = player
        else:
            room["spectators"].append(player)

        await self.broadcast_room(room_id)
        await self.broadcast_lobby()

    async def start_game(self, user: dict, room_id: str) -> None:
        room = self.rooms.get(room_id)
        if not room or not room["black"] or not room["white"]:
            return

        user_id = user["id"]
        if room["black"]["id"] != user_id and room["white"]["id"] != user_id:
            return

        board = OmokBoard(15)
        mins = room["time_minutes"]

        room["board"] = board
        room["active_turn"] = "b"
        room["move_history"] = []
        room["last_move"] = None
        room["game_started"] = True
        room["result"] = None
        room["draw_offer"] = None
        room["clock"] = {
            "b_remain": float(mins * 60),
            "w_remain": float(mins * 60),
            "b_deadline": time.time() + mins * 60,
            "w_deadline": None,
            "last_tick_at": time.time(),
        }

        await self.broadcast_room(room_id)
        await self.broadcast_lobby()

    def _complete_game(self, room: dict, result: dict) -> None:
        room["result"] = result
        if room["black"] and room["white"]:
            record_omok_result(int(room["black"]["id"]), int(room["white"]["id"]), result.get("winner"))

        room_id = room["id"]
        previous = self.result_reset_tasks.pop(room_id, None)
        if previous and not previous.done():
            previous.cancel()
        try:
            loop = asyncio.get_running_loop()
            self.result_reset_tasks[room_id] = loop.create_task(self._reset_after_result(room_id))
        except RuntimeError:
            pass

    async def _reset_after_result(self, room_id: str) -> None:
        try:
            await asyncio.sleep(self.result_display_seconds)
            room = self.rooms.get(room_id)
            if not room or not room["result"]:
                return
            for player in (room["black"], room["white"]):
                if player:
                    room["spectators"] = [s for s in room["spectators"] if str(s["id"]) != str(player["id"])]
                    room["spectators"].append(player)
            room["black"] = None
            room["white"] = None
            room["game_started"] = False
            room["result"] = None
            room["draw_offer"] = None
            room["board"] = None
            room["active_turn"] = "b"
            await self.broadcast_room(room_id)
            await self.broadcast_lobby()
        finally:
            self.result_reset_tasks.pop(room_id, None)

    def _refresh_clock(self, room: dict, now: float) -> None:
        if room["game_started"] and not room["result"] and room["black"] and room["white"] and not room["draw_offer"]:
            turn = room["active_turn"]
            deadline_key = f"{turn}_deadline"
            deadline = room["clock"].get(deadline_key)
            if deadline is None:
                deadline = now + room["clock"][f"{turn}_remain"]
                room["clock"][deadline_key] = deadline
            room["clock"][f"{turn}_remain"] = max(0.0, deadline - now)
        room["clock"]["last_tick_at"] = now

    def _refresh_player_stats(self, room: dict) -> None:
        for player in (room.get("black"), room.get("white"), *room.get("spectators", [])):
            if player:
                player_id = str(player["id"])
                if player_id not in room["stats"]:
                    try:
                        room["stats"][player_id] = get_omok_stats(int(player_id))
                    except Exception:
                        room["stats"][player_id] = {"wins": 0, "draws": 0, "losses": 0}

    async def make_move(self, user: dict, room_id: str, data: dict) -> None:
        room = self.rooms.get(room_id)
        if not room or not room["game_started"] or room["result"]:
            return

        user_id = str(user["id"])
        is_black = bool(room["black"] and str(room["black"]["id"]) == user_id)
        is_white = bool(room["white"] and str(room["white"]["id"]) == user_id)

        expected = room["active_turn"]
        if (expected == "b" and not is_black) or (expected == "w" and not is_white):
            return

        col = data.get("col")
        row = data.get("row")
        if col is None or row is None:
            return

        board: OmokBoard = room["board"]
        try:
            move_res = board.push_move(int(col), int(row), expected)
        except ValueError as e:
            await self._send_error(user, str(e))
            return

        now = time.time()
        self._refresh_clock(room, now)

        if room["clock"][f"{expected}_remain"] <= 0:
            winner = "w" if expected == "b" else "b"
            self._complete_game(room, {"type": "timeout", "winner": winner, "desc": f"{'백(白)' if winner == 'w' else '흑(黑)'} 시간승"})
            await self.broadcast_room(room_id)
            return

        next_turn = "w" if expected == "b" else "b"
        room["active_turn"] = next_turn
        room["clock"][f"{expected}_deadline"] = None
        room["clock"][f"{next_turn}_deadline"] = now + room["clock"][f"{next_turn}_remain"]
        room["last_move"] = (col, row)

        room["move_history"].append({
            "col": col,
            "row": row,
            "player": expected,
            "move_number": move_res["move_number"],
        })

        if move_res.get("winner"):
            if move_res.get("foul"):
                self._complete_game(room, {
                    "type": "foul_loss",
                    "winner": move_res["winner"],
                    "foul": move_res["foul"],
                    "foul_player": move_res.get("foul_player"),
                    "desc": move_res.get("foul_desc") or "금수 착수로 인한 반칙패",
                    "foul_move": (col, row),
                })
            else:
                self._complete_game(room, {
                    "type": "win",
                    "winner": move_res["winner"],
                    "desc": f"{'흑(黑)' if move_res['winner'] == 'b' else '백(白)'} 5목 승리!",
                    "winning_line": move_res.get("winning_line"),
                })
        elif move_res.get("is_draw"):
            self._complete_game(room, {"type": "draw", "winner": None, "desc": "무승부 (판 가득 참)"})

        room["draw_offer"] = None
        await self.broadcast_room(room_id)

    async def resign(self, user: dict, room_id: str) -> None:
        room = self.rooms.get(room_id)
        if not room or not room["game_started"] or room["result"]:
            return

        user_id = str(user["id"])
        if room["black"] and str(room["black"]["id"]) == user_id:
            self._complete_game(room, {"type": "resign", "winner": "w", "desc": "흑(黑) 기권으로 인한 백(白) 승리"})
        elif room["white"] and str(room["white"]["id"]) == user_id:
            self._complete_game(room, {"type": "resign", "winner": "b", "desc": "백(白) 기권으로 인한 흑(黑) 승리"})
        await self.broadcast_room(room_id)

    async def send_room_chat(self, user: dict, room_id: str, text: str) -> None:
        room = self.rooms.get(room_id)
        if not room:
            return
        player = self._player_for(user)
        payload = json.dumps({
            "type": "chat",
            "sender": player["name"],
            "text": text[:300],
            "time": time.strftime("%H:%M"),
        }, ensure_ascii=False)
        for ws in list(self.room_sockets.get(room_id, set())):
            try:
                await ws.send_text(payload)
            except Exception:
                pass

    async def _send_error(self, user: dict, message: str) -> None:
        for ws, socket_user in list(self.socket_user.items()):
            if socket_user.get("id") == user.get("id"):
                try:
                    await ws.send_text(json.dumps({"type": "error", "message": message}, ensure_ascii=False))
                except Exception:
                    pass
                return

omok_manager = OmokManager()


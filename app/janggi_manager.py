"""In-memory Janggi (Korean Chess) Room and Multiplayer Game State Manager."""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Dict, List, Optional, Set
from fastapi import WebSocket
from app.janggi_engine import JanggiBoard
from app.database import get_janggi_stats, get_user_by_id, record_janggi_result

logger = logging.getLogger("bamboochat.janggi")


class JanggiManager:
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
                    if not room["cho"] or not room["han"] or room["draw_offer"]:
                        continue
                    now = time.time()
                    self._refresh_clock(room, now)
                    turn_key = f"{room['active_turn']}_remain"
                    if room["clock"][turn_key] <= 0:
                        expected = room["active_turn"]
                        winner = "han" if expected == "cho" else "cho"
                        self._complete_game(room, {
                            "type": "timeout",
                            "winner": winner,
                            "desc": f"{'한(漢)' if winner == 'han' else '초(楚)'} 시간승"
                        })
                        await self.broadcast_room(room_id)
                    elif now - room["clock"].get("last_broadcast_at", 0) >= 5.0:
                        room["clock"]["last_broadcast_at"] = now
                        await self.broadcast_room(room_id)
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("Unexpected error in janggi _clock_monitor")
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
                "cho": room["cho"]["name"] if room["cho"] else None,
                "han": room["han"]["name"] if room["han"] else None,
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
                "cho": room["cho"],
                "han": room["han"],
                "cho_formation": room["cho_formation"],
                "han_formation": room["han_formation"],
                "spectators": room["spectators"],
                "match_queue": room["match_queue"],
                "board": room["board"].to_dict() if room["board"] else None,
                "active_turn": room["active_turn"],
                "move_history": room["move_history"],
                "last_from": room["last_from"],
                "last_to": room["last_to"],
                "game_started": room["game_started"],
                "result": room["result"],
                "draw_offer": room["draw_offer"],
                "clock": {
                    "cho_remain": round(clock["cho_remain"], 1),
                    "han_remain": round(clock["han_remain"], 1),
                    "cho_deadline": clock.get("cho_deadline"),
                    "han_deadline": clock.get("han_deadline"),
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
        room_id = f"janggi-{uuid.uuid4().hex[:6]}"
        title = (title or f"{user.get('display_name') or user['username']}의 장기방").strip()[:30]
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
            "cho": player,
            "han": None,
            "cho_formation": "wonangma",
            "han_formation": "wonangma",
            "spectators": [],
            "match_queue": [],
            "board": None,
            "active_turn": "cho",
            "move_history": [],
            "last_from": None,
            "last_to": None,
            "game_started": False,
            "result": None,
            "draw_offer": None,
            "clock": {
                "cho_remain": float(time_minutes * 60),
                "han_remain": float(time_minutes * 60),
                "cho_deadline": None,
                "han_deadline": None,
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

        if room.get("cho") and str(room["cho"]["id"]) == user_id:
            room["cho"] = player
        elif room.get("han") and str(room["han"]["id"]) == user_id:
            room["han"] = player
        else:
            room["spectators"] = [s for s in room["spectators"] if str(s["id"]) != user_id]
            if role_pref == "cho" and not room["cho"] and not room["game_started"]:
                room["cho"] = player
            elif role_pref == "han" and not room["han"] and not room["game_started"]:
                room["han"] = player
            elif not room["cho"] and not room["game_started"]:
                room["cho"] = player
            elif not room["han"] and not room["game_started"]:
                room["han"] = player
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
            if room["cho"] and room["cho"]["id"] == user_id:
                room["cho"] = None
                self._complete_game(room, {"type": "disconnect", "winner": "han", "desc": "초 플레이어 이탈로 인한 한 부전승"})
            elif room["han"] and room["han"]["id"] == user_id:
                room["han"] = None
                self._complete_game(room, {"type": "disconnect", "winner": "cho", "desc": "한 플레이어 이탈로 인한 초 부전승"})
        else:
            if room["cho"] and room["cho"]["id"] == user_id:
                room["cho"] = None
            if room["han"] and room["han"]["id"] == user_id:
                room["han"] = None

        room["spectators"] = [s for s in room["spectators"] if s["id"] != user_id]
        if not room["cho"] and not room["han"] and not room["spectators"]:
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

        if room["cho"] and str(room["cho"]["id"]) == str(user_id):
            room["cho"] = None
        if room["han"] and str(room["han"]["id"]) == str(user_id):
            room["han"] = None
        room["spectators"] = [s for s in room["spectators"] if s["id"] != user_id]

        if role == "cho" and not room["cho"]:
            room["cho"] = player
        elif role == "han" and not room["han"]:
            room["han"] = player
        else:
            room["spectators"].append(player)

        await self.broadcast_room(room_id)
        await self.broadcast_lobby()

    async def set_formation(self, user: dict, room_id: str, formation: str) -> None:
        room = self.rooms.get(room_id)
        if not room or room["game_started"]:
            return

        valid = ("wonangma", "yangwima", "oenma", "oreunma")
        if formation not in valid:
            return

        user_id = str(user["id"])
        if room["cho"] and str(room["cho"]["id"]) == user_id:
            room["cho_formation"] = formation
        elif room["han"] and str(room["han"]["id"]) == user_id:
            room["han_formation"] = formation

        await self.broadcast_room(room_id)

    async def start_game(self, user: dict, room_id: str) -> None:
        room = self.rooms.get(room_id)
        if not room or not room["cho"] or not room["han"]:
            return

        user_id = user["id"]
        if room["cho"]["id"] != user_id and room["han"]["id"] != user_id:
            return

        board = JanggiBoard(room["cho_formation"], room["han_formation"])
        mins = room["time_minutes"]

        room["board"] = board
        room["active_turn"] = "cho"
        room["move_history"] = [{
            "move": "대국 시작",
            "board": board.to_dict()
        }]
        room["last_from"] = None
        room["last_to"] = None
        room["game_started"] = True
        room["result"] = None
        room["draw_offer"] = None
        room["clock"] = {
            "cho_remain": float(mins * 60),
            "han_remain": float(mins * 60),
            "cho_deadline": time.time() + mins * 60,
            "han_deadline": None,
            "last_tick_at": time.time(),
        }

        await self.broadcast_room(room_id)
        await self.broadcast_lobby()

    def _complete_game(self, room: dict, result: dict) -> None:
        room["result"] = result
        if room["cho"] and room["han"]:
            record_janggi_result(int(room["cho"]["id"]), int(room["han"]["id"]), result.get("winner"))

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
            for player in (room["cho"], room["han"]):
                if player:
                    room["spectators"] = [s for s in room["spectators"] if str(s["id"]) != str(player["id"])]
                    room["spectators"].append(player)
            room["cho"] = None
            room["han"] = None
            room["game_started"] = False
            room["result"] = None
            room["draw_offer"] = None
            room["board"] = None
            room["active_turn"] = "cho"
            await self.broadcast_room(room_id)
            await self.broadcast_lobby()
        finally:
            self.result_reset_tasks.pop(room_id, None)

    def _refresh_clock(self, room: dict, now: float) -> None:
        if room["game_started"] and not room["result"] and room["cho"] and room["han"] and not room["draw_offer"]:
            turn = room["active_turn"]
            deadline_key = f"{turn}_deadline"
            deadline = room["clock"].get(deadline_key)
            if deadline is None:
                deadline = now + room["clock"][f"{turn}_remain"]
                room["clock"][deadline_key] = deadline
            room["clock"][f"{turn}_remain"] = max(0.0, deadline - now)
        room["clock"]["last_tick_at"] = now

    def _refresh_player_stats(self, room: dict) -> None:
        for player in (room.get("cho"), room.get("han"), *room.get("spectators", [])):
            if player:
                player_id = str(player["id"])
                if player_id not in room["stats"]:
                    try:
                        room["stats"][player_id] = get_janggi_stats(int(player_id))
                    except Exception:
                        room["stats"][player_id] = {"wins": 0, "draws": 0, "losses": 0}

    async def make_move(self, user: dict, room_id: str, data: dict) -> None:
        room = self.rooms.get(room_id)
        if not room or not room["game_started"] or room["result"]:
            return

        user_id = str(user["id"])
        is_cho = bool(room["cho"] and str(room["cho"]["id"]) == user_id)
        is_han = bool(room["han"] and str(room["han"]["id"]) == user_id)

        expected = room["active_turn"]
        if (expected == "cho" and not is_cho) or (expected == "han" and not is_han):
            return

        from_pos = (data.get("from_col"), data.get("from_row"))
        to_pos = (data.get("to_col"), data.get("to_row"))
        if None in from_pos or None in to_pos:
            return

        board: JanggiBoard = room["board"]
        try:
            move_res = board.push_move(from_pos, to_pos)
        except ValueError as e:
            await self._send_error(user, str(e))
            return

        now = time.time()
        self._refresh_clock(room, now)

        if room["clock"][f"{expected}_remain"] <= 0:
            winner = "han" if expected == "cho" else "cho"
            self._complete_game(room, {"type": "timeout", "winner": winner, "desc": f"{'한(漢)' if winner == 'han' else '초(楚)'} 시간승"})
            await self.broadcast_room(room_id)
            return

        next_turn = "han" if expected == "cho" else "cho"
        room["active_turn"] = next_turn
        room["clock"][f"{expected}_deadline"] = None
        room["clock"][f"{next_turn}_deadline"] = now + room["clock"][f"{next_turn}_remain"]
        room["last_from"] = from_pos
        room["last_to"] = to_pos

        room["move_history"].append({
            "move": move_res["notation"],
            "from": from_pos,
            "to": to_pos,
            "board": board.to_dict(),
        })

        if move_res.get("is_mate"):
            self._complete_game(room, {"type": "checkmate", "winner": expected, "desc": f"{'초(楚)' if expected == 'cho' else '한(漢)'} 외통승"})
        elif board.move_count >= 200:
            score = board.calculate_score()
            winner = score["leading"]
            desc = f"200수 만료 점수판정: 초 {score['cho']}점 vs 한 {score['han']}점 ({'초' if winner == 'cho' else '한'} 승)"
            self._complete_game(room, {"type": "score", "winner": winner, "desc": desc})

        room["draw_offer"] = None
        await self.broadcast_room(room_id)

    async def pass_turn(self, user: dict, room_id: str) -> None:
        room = self.rooms.get(room_id)
        if not room or not room["game_started"] or room["result"]:
            return

        user_id = str(user["id"])
        expected = room["active_turn"]
        is_turn_player = ((expected == "cho" and room["cho"] and str(room["cho"]["id"]) == user_id) or
                          (expected == "han" and room["han"] and str(room["han"]["id"]) == user_id))
        if not is_turn_player:
            return

        board: JanggiBoard = room["board"]
        try:
            pass_res = board.pass_turn()
        except ValueError as e:
            await self._send_error(user, str(e))
            return

        now = time.time()
        self._refresh_clock(room, now)
        next_turn = "han" if expected == "cho" else "cho"
        room["active_turn"] = next_turn
        room["clock"][f"{expected}_deadline"] = None
        room["clock"][f"{next_turn}_deadline"] = now + room["clock"][f"{next_turn}_remain"]

        room["move_history"].append({
            "move": pass_res["notation"],
            "board": board.to_dict(),
        })

        if pass_res.get("double_pass"):
            score = board.calculate_score()
            winner = score["leading"]
            desc = f"양자 연속 한수쉼 점수판정: 초 {score['cho']}점 vs 한 {score['han']}점 ({'초' if winner == 'cho' else '한'} 승)"
            self._complete_game(room, {"type": "score", "winner": winner, "desc": desc})

        await self.broadcast_room(room_id)

    async def request_score_judge(self, user: dict, room_id: str) -> None:
        """Adjudicate the game by material points."""
        room = self.rooms.get(room_id)
        if not room or not room["game_started"] or room["result"]:
            return

        board: JanggiBoard = room["board"]
        score = board.calculate_score()
        winner = score["leading"]
        desc = f"점수판정: 초 {score['cho']}점 vs 한 {score['han']}점 ({'초' if winner == 'cho' else '한'} 판정승)"
        self._complete_game(room, {"type": "score", "winner": winner, "desc": desc})
        await self.broadcast_room(room_id)

    async def resign(self, user: dict, room_id: str) -> None:
        room = self.rooms.get(room_id)
        if not room or not room["game_started"] or room["result"]:
            return

        user_id = str(user["id"])
        if room["cho"] and str(room["cho"]["id"]) == user_id:
            self._complete_game(room, {"type": "resign", "winner": "han", "desc": "초(楚) 기권으로 인한 한(漢) 승리"})
        elif room["han"] and str(room["han"]["id"]) == user_id:
            self._complete_game(room, {"type": "resign", "winner": "cho", "desc": "한(漢) 기권으로 인한 초(楚) 승리"})
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

janggi_manager = JanggiManager()


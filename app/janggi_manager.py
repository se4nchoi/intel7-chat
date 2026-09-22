"""In-memory Janggi (Korean Chess) Room and Multiplayer Game State Manager."""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Dict, List, Optional, Set
from fastapi import WebSocket
from app.game_base import BaseTurnBasedGameManager
from app.engines.janggi import JanggiBoard
from app.database import get_janggi_stats, get_user_by_id, record_janggi_result

logger = logging.getLogger("bamboochat.janggi")


class JanggiManager(BaseTurnBasedGameManager):
    player_roles = ("cho", "han")
    logger = logger

    def _timeout_winner_and_desc(self, expected_color: str) -> tuple[str, str]:
        winner = "han" if expected_color == "cho" else "cho"
        return winner, f"{'한(漢)' if winner == 'han' else '초(楚)'} 시간승"

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
                "last_from": room.get("last_from"),
                "last_to": room.get("last_to"),
                "owner_id": room.get("owner_id"),
                "cho_ready": bool(room.get("cho_ready", False)),
                "han_ready": bool(room.get("han_ready", False)),
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
            "owner_id": player["id"],
            "time_minutes": time_minutes,
            "cho": player,
            "han": None,
            "cho_ready": False,
            "han_ready": False,
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
        was_owner = (room.get("owner_id") == user["id"])

        if room.get("cho") and str(room["cho"]["id"]) == user_id:
            if role_pref == "spectator" and not room["game_started"]:
                room["cho"] = None
                room["spectators"] = [s for s in room["spectators"] if str(s["id"]) != user_id]
                room["spectators"].append(player)
                if was_owner:
                    self._sync_room_owner(room, leaving_owner_id=user["id"])
            else:
                room["cho"] = player
        elif room.get("han") and str(room["han"]["id"]) == user_id:
            if role_pref == "spectator" and not room["game_started"]:
                room["han"] = None
                room["spectators"] = [s for s in room["spectators"] if str(s["id"]) != user_id]
                room["spectators"].append(player)
                if was_owner:
                    self._sync_room_owner(room, leaving_owner_id=user["id"])
            else:
                room["han"] = player
        else:
            room["spectators"] = [s for s in room["spectators"] if str(s["id"]) != user_id]
            if role_pref == "spectator":
                room["spectators"].append(player)
            elif role_pref == "cho" and not room["cho"] and not room["game_started"]:
                room["cho"] = player
            elif role_pref == "han" and not room["han"] and not room["game_started"]:
                room["han"] = player
            elif not room["cho"] and not room["game_started"]:
                room["cho"] = player
            elif not room["han"] and not room["game_started"]:
                room["han"] = player
            else:
                room["spectators"].append(player)

        self._sync_room_owner(room)

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
                room["cho_ready"] = False
            if room["han"] and room["han"]["id"] == user_id:
                room["han"] = None
                room["han_ready"] = False

            if room.get("owner_id") == user_id:
                self._sync_room_owner(room, leaving_owner_id=user_id)

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
        was_owner = (room.get("owner_id") == user_id)

        if room["cho"] and str(room["cho"]["id"]) == str(user_id):
            room["cho"] = None
        if room["han"] and str(room["han"]["id"]) == str(user_id):
            room["han"] = None
        room["spectators"] = [s for s in room["spectators"] if s["id"] != user_id]

        if role == "cho" and not room["cho"]:
            room["cho"] = player
            room["cho_ready"] = False
        elif role == "han" and not room["han"]:
            room["han"] = player
            room["han_ready"] = False
        else:
            room["spectators"].append(player)
            room["cho_ready"] = False
            room["han_ready"] = False

        is_spectator = any(s["id"] == user_id for s in room["spectators"])
        if was_owner and is_spectator:
            self._sync_room_owner(room, leaving_owner_id=user_id)
        else:
            self._sync_room_owner(room)

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
            room["cho_ready"] = False
        elif room["han"] and str(room["han"]["id"]) == user_id:
            room["han_formation"] = formation
            room["han_ready"] = False

        await self.broadcast_room(room_id)

    async def toggle_ready(self, user: dict, room_id: str) -> None:
        room = self.rooms.get(room_id)
        if not room or room["game_started"] or room.get("result"):
            return
        uid = str(user["id"])
        if room["cho"] and str(room["cho"]["id"]) == uid:
            room["cho_ready"] = not room.get("cho_ready", False)
        elif room["han"] and str(room["han"]["id"]) == uid:
            room["han_ready"] = not room.get("han_ready", False)
        else:
            return
        await self.broadcast_room(room_id)

    async def start_game(self, user: dict, room_id: str) -> None:
        room = self.rooms.get(room_id)
        if not room or not room["cho"] or not room["han"]:
            return

        user_id = user["id"]
        owner_id = room.get("owner_id")
        if owner_id is not None and user_id != owner_id:
            return
        if owner_id is None and room["cho"]["id"] != user_id and room["han"]["id"] != user_id:
            return

        if not (room.get("cho_ready") and room.get("han_ready")):
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
            try:
                room["stats"][str(room["cho"]["id"])] = get_janggi_stats(int(room["cho"]["id"]))
                room["stats"][str(room["han"]["id"])] = get_janggi_stats(int(room["han"]["id"]))
            except Exception:
                pass

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
            room["cho_ready"] = False
            room["han_ready"] = False
            room["game_started"] = False
            room["result"] = None
            room["draw_offer"] = None
            room["board"] = None
            room["active_turn"] = "cho"
            self._sync_room_owner(room)
            await self.broadcast_room(room_id)
            await self.broadcast_lobby()
        finally:
            self.result_reset_tasks.pop(room_id, None)

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
        room["last_from"] = None
        room["last_to"] = None

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


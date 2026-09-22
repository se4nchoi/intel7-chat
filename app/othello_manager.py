"""In-memory Othello (Reversi) Room and Multiplayer Game State Manager."""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Dict, List, Optional, Set
from fastapi import WebSocket
from app.game_base import BaseTurnBasedGameManager
from app.engines.othello import OthelloBoard, coord_to_notation
from app.database import get_othello_stats, get_user_by_id, record_othello_result

logger = logging.getLogger("bamboochat.othello")


class OthelloManager(BaseTurnBasedGameManager):
    player_roles = ("black", "white")
    logger = logger

    def _timeout_winner_and_desc(self, expected_color: str) -> tuple[str, str]:
        winner = "w" if expected_color == "b" else "b"
        return winner, f"{'백(白)' if winner == 'w' else '흑(黑)'} 시간승"

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
                "owner_id": room.get("owner_id"),
                "black_ready": bool(room.get("black_ready", False)),
                "white_ready": bool(room.get("white_ready", False)),
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
        room_id = f"othello-{uuid.uuid4().hex[:6]}"
        title = (title or f"{user.get('display_name') or user['username']}의 오셀로방").strip()[:30]
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
            "black": player,
            "white": None,
            "black_ready": False,
            "white_ready": False,
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
        was_owner = (room.get("owner_id") == user["id"])

        if room.get("black") and str(room["black"]["id"]) == user_id:
            if role_pref == "spectator" and not room["game_started"]:
                room["black"] = None
                room["spectators"] = [s for s in room["spectators"] if str(s["id"]) != user_id]
                room["spectators"].append(player)
                if was_owner:
                    self._sync_room_owner(room, leaving_owner_id=user["id"])
            else:
                room["black"] = player
        elif room.get("white") and str(room["white"]["id"]) == user_id:
            if role_pref == "spectator" and not room["game_started"]:
                room["white"] = None
                room["spectators"] = [s for s in room["spectators"] if str(s["id"]) != user_id]
                room["spectators"].append(player)
                if was_owner:
                    self._sync_room_owner(room, leaving_owner_id=user["id"])
            else:
                room["white"] = player
        else:
            room["spectators"] = [s for s in room["spectators"] if str(s["id"]) != user_id]
            if role_pref == "spectator":
                room["spectators"].append(player)
            elif role_pref == "b" and not room["black"] and not room["game_started"]:
                room["black"] = player
            elif role_pref == "w" and not room["white"] and not room["game_started"]:
                room["white"] = player
            elif not room["black"] and not room["game_started"]:
                room["black"] = player
            elif not room["white"] and not room["game_started"]:
                room["white"] = player
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
            if room["black"] and room["black"]["id"] == user_id:
                room["black"] = None
                self._complete_game(room, {"type": "disconnect", "winner": "w", "desc": "흑 플레이어 이탈로 인한 백 부전승"})
            elif room["white"] and room["white"]["id"] == user_id:
                room["white"] = None
                self._complete_game(room, {"type": "disconnect", "winner": "b", "desc": "백 플레이어 이탈로 인한 흑 부전승"})
        else:
            if room["black"] and room["black"]["id"] == user_id:
                room["black"] = None
                room["black_ready"] = False
            if room["white"] and room["white"]["id"] == user_id:
                room["white"] = None
                room["white_ready"] = False

            if room.get("owner_id") == user_id:
                self._sync_room_owner(room, leaving_owner_id=user_id)

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
        was_owner = (room.get("owner_id") == user_id)

        if room["black"] and str(room["black"]["id"]) == str(user_id):
            room["black"] = None
        if room["white"] and str(room["white"]["id"]) == str(user_id):
            room["white"] = None
        room["spectators"] = [s for s in room["spectators"] if s["id"] != user_id]

        if role == "b" and not room["black"]:
            room["black"] = player
            room["black_ready"] = False
        elif role == "w" and not room["white"]:
            room["white"] = player
            room["white_ready"] = False
        else:
            room["spectators"].append(player)
            room["black_ready"] = False
            room["white_ready"] = False

        is_spectator = any(s["id"] == user_id for s in room["spectators"])
        if was_owner and is_spectator:
            self._sync_room_owner(room, leaving_owner_id=user_id)
        else:
            self._sync_room_owner(room)

        await self.broadcast_room(room_id)
        await self.broadcast_lobby()

    async def toggle_ready(self, user: dict, room_id: str) -> None:
        room = self.rooms.get(room_id)
        if not room or room["game_started"] or room.get("result"):
            return
        uid = str(user["id"])
        if room["black"] and str(room["black"]["id"]) == uid:
            room["black_ready"] = not room.get("black_ready", False)
        elif room["white"] and str(room["white"]["id"]) == uid:
            room["white_ready"] = not room.get("white_ready", False)
        else:
            return
        await self.broadcast_room(room_id)

    async def start_game(self, user: dict, room_id: str) -> None:
        room = self.rooms.get(room_id)
        if not room or not room["black"] or not room["white"]:
            return

        user_id = user["id"]
        owner_id = room.get("owner_id")
        if owner_id is not None and user_id != owner_id:
            return
        if owner_id is None and room["black"]["id"] != user_id and room["white"]["id"] != user_id:
            return

        if not (room.get("black_ready") and room.get("white_ready")):
            return

        board = OthelloBoard(8)
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
            record_othello_result(int(room["black"]["id"]), int(room["white"]["id"]), result.get("winner"))
            try:
                room["stats"][str(room["black"]["id"])] = get_othello_stats(int(room["black"]["id"]))
                room["stats"][str(room["white"]["id"])] = get_othello_stats(int(room["white"]["id"]))
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
            for player in (room["black"], room["white"]):
                if player:
                    room["spectators"] = [s for s in room["spectators"] if str(s["id"]) != str(player["id"])]
                    room["spectators"].append(player)
            room["black"] = None
            room["white"] = None
            room["black_ready"] = False
            room["white_ready"] = False
            room["game_started"] = False
            room["result"] = None
            room["draw_offer"] = None
            room["board"] = None
            room["active_turn"] = "b"
            self._sync_room_owner(room)
            await self.broadcast_room(room_id)
            await self.broadcast_lobby()
        finally:
            self.result_reset_tasks.pop(room_id, None)

    def _refresh_player_stats(self, room: dict) -> None:
        for player in (room.get("black"), room.get("white"), *room.get("spectators", [])):
            if player:
                player_id = str(player["id"])
                if player_id not in room["stats"]:
                    try:
                        room["stats"][player_id] = get_othello_stats(int(player_id))
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

        board: OthelloBoard = room["board"]
        try:
            move_res = board.make_move(int(col), int(row), expected)
        except ValueError as e:
            await self._send_error(user, str(e))
            return

        now = time.time()
        self._refresh_clock(room, now)

        if room["clock"][f"{expected}_remain"] <= 0:
            winner = "w" if expected == "b" else "b"
            self._complete_game(room, {
                "type": "timeout",
                "winner": winner,
                "desc": f"{'백(白)' if winner == 'w' else '흑(黑)'} 시간승",
            })
            await self.broadcast_room(room_id)
            return

        next_turn = board.turn
        room["active_turn"] = next_turn
        room["clock"][f"{expected}_deadline"] = None
        room["clock"][f"{next_turn}_deadline"] = now + room["clock"][f"{next_turn}_remain"]
        room["last_move"] = (int(col), int(row))

        room["move_history"].append({
            "col": int(col),
            "row": int(row),
            "player": expected,
            "notation": move_res["notation"],
            "flipped": move_res["flipped"],
            "passed": move_res.get("passed", False),
            "counts": move_res["counts"],
            "move_number": len(room["move_history"]) + 1,
        })

        if move_res.get("passed"):
            passed_player_name = "백" if expected == "b" else "흑"
            next_player_name = "흑" if next_turn == "b" else "백"
            await self._broadcast_system_message(
                room_id,
                f"[{passed_player_name}] 둘 수 있는 자리가 없어 패스되었습니다. {next_player_name} 차례가 이어집니다."
            )

        if move_res.get("game_over"):
            counts = move_res["counts"]
            b_cnt = counts["black"]
            w_cnt = counts["white"]
            raw_winner = move_res.get("winner")

            if raw_winner == "draw" or b_cnt == w_cnt:
                self._complete_game(room, {
                    "type": "game_over",
                    "winner": None,
                    "desc": f"무승부 (흑 {b_cnt} : 백 {w_cnt})",
                    "counts": counts,
                })
            else:
                win_color = raw_winner if raw_winner in ("b", "w") else ("b" if b_cnt > w_cnt else "w")
                win_name = "흑(黑)" if win_color == "b" else "백(白)"
                self._complete_game(room, {
                    "type": "game_over",
                    "winner": win_color,
                    "desc": f"{win_name} 승리! (흑 {b_cnt} : 백 {w_cnt})",
                    "counts": counts,
                })

        room["draw_offer"] = None
        await self.broadcast_room(room_id)

    async def pass_turn(self, user: dict, room_id: str) -> None:
        """Manual pass endpoint when player has no legal moves."""
        room = self.rooms.get(room_id)
        if not room or not room["game_started"] or room["result"]:
            return

        user_id = str(user["id"])
        is_black = bool(room["black"] and str(room["black"]["id"]) == user_id)
        is_white = bool(room["white"] and str(room["white"]["id"]) == user_id)

        expected = room["active_turn"]
        if (expected == "b" and not is_black) or (expected == "w" and not is_white):
            return

        board: OthelloBoard = room["board"]
        try:
            pass_res = board.pass_turn(expected)
        except ValueError as e:
            await self._send_error(user, str(e))
            return

        now = time.time()
        self._refresh_clock(room, now)

        next_turn = board.turn
        room["active_turn"] = next_turn
        room["clock"][f"{expected}_deadline"] = None
        room["clock"][f"{next_turn}_deadline"] = now + room["clock"][f"{next_turn}_remain"]

        room["move_history"].append({
            "col": -1,
            "row": -1,
            "player": expected,
            "notation": pass_res["notation"],
            "flipped": [],
            "passed": True,
            "counts": pass_res["counts"],
            "move_number": len(room["move_history"]) + 1,
        })

        passed_player_name = "흑" if expected == "b" else "백"
        next_player_name = "흑" if next_turn == "b" else "백"
        await self._broadcast_system_message(
            room_id,
            f"[{passed_player_name}] 패스하였습니다. {next_player_name} 차례입니다."
        )

        if pass_res.get("game_over"):
            counts = pass_res["counts"]
            b_cnt = counts["black"]
            w_cnt = counts["white"]
            raw_winner = pass_res.get("winner")

            if raw_winner == "draw" or b_cnt == w_cnt:
                self._complete_game(room, {
                    "type": "game_over",
                    "winner": None,
                    "desc": f"무승부 (흑 {b_cnt} : 백 {w_cnt})",
                    "counts": counts,
                })
            else:
                win_color = raw_winner if raw_winner in ("b", "w") else ("b" if b_cnt > w_cnt else "w")
                win_name = "흑(黑)" if win_color == "b" else "백(白)"
                self._complete_game(room, {
                    "type": "game_over",
                    "winner": win_color,
                    "desc": f"{win_name} 승리! (흑 {b_cnt} : 백 {w_cnt})",
                    "counts": counts,
                })

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

    async def _broadcast_system_message(self, room_id: str, text: str) -> None:
        payload = json.dumps({
            "type": "chat",
            "sender": "시스템",
            "text": text,
            "time": time.strftime("%H:%M"),
            "system": True,
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


othello_manager = OthelloManager()

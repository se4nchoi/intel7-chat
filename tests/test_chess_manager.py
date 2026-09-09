import asyncio
import json
import time

import chess

from app.chess_manager import ChessManager, START_FEN


class FakeWebSocket:
    def __init__(self):
        self.messages = []

    async def send_text(self, payload):
        self.messages.append(json.loads(payload))


def make_room():
    manager = ChessManager()
    white_ws = FakeWebSocket()
    black_ws = FakeWebSocket()
    white = {"id": 1, "username": "white", "display_name": "White"}
    black = {"id": 2, "username": "black", "display_name": "Black"}

    async def setup():
        manager.register_client(white_ws, white)
        room = await manager.create_room(white_ws, white, "Test", 10)
        manager.register_client(black_ws, black)
        await manager.join_room(black_ws, black, room["id"])
        await manager.start_game(white, room["id"])
        return room["id"], white, white_ws

    return manager, asyncio.run(setup())


def test_server_ignores_client_fen_san_and_result():
    manager, (room_id, white, white_ws) = make_room()

    asyncio.run(manager.make_move(white, room_id, {
        "from": "e2",
        "to": "e4",
        "fen": "8/8/8/8/8/8/8/8 b - - 0 1",
        "san": "not-real",
        "result": {"type": "checkmate", "winner": "w"},
    }))

    room = manager.rooms[room_id]
    board = chess.Board(START_FEN)
    board.push_uci("e2e4")
    assert room["fen"] == board.fen()
    assert room["move_history"][-1]["move"] == "e4"
    assert room["result"] is None
    assert room["active_turn"] == "b"
    assert white_ws.messages[-1]["type"] == "room_state"


def test_illegal_move_is_rejected_without_changing_room():
    manager, (room_id, white, white_ws) = make_room()
    room = manager.rooms[room_id]

    asyncio.run(manager.make_move(white, room_id, {"from": "e2", "to": "e5"}))

    assert room["fen"] == START_FEN
    assert room["move_history"] == [{"fen": START_FEN, "move": "Start"}]
    assert room["active_turn"] == "w"
    assert white_ws.messages[-1] == {"type": "error", "message": "둘 수 없는 수입니다."}


def test_move_accepts_string_user_id_from_browser_session():
    manager, (room_id, _white, _white_ws) = make_room()
    string_id_user = {"id": "1", "username": "white", "display_name": "White"}

    asyncio.run(manager.make_move(string_id_user, room_id, {"from": "e2", "to": "e4"}))

    assert manager.rooms[room_id]["active_turn"] == "b"


def test_timeout_is_calculated_by_server_clock():
    manager, (room_id, white, _white_ws) = make_room()
    room = manager.rooms[room_id]
    room["clock"]["w_remain"] = 0.1
    room["clock"]["w_deadline"] = time.time() - 1

    asyncio.run(manager.claim_timeout(white, room_id))

    assert room["result"] == {"type": "timeout", "winner": "b", "desc": "흑 시간승"}
    assert room["white"]["id"] == 1
    assert room["black"]["id"] == 2


def test_spectator_join_stays_spectator_until_picking_a_seat():
    manager = ChessManager()
    white_ws = FakeWebSocket()
    black_ws = FakeWebSocket()
    white = {"id": 9901, "username": "white", "display_name": "White"}
    black = {"id": 9902, "username": "black", "display_name": "Black"}

    async def setup():
        manager.register_client(white_ws, white)
        room = await manager.create_room(white_ws, white, "Test", 10)
        manager.register_client(black_ws, black)
        await manager.join_room(black_ws, black, room["id"], "spectator")
        return room["id"]

    room_id = asyncio.run(setup())
    room = manager.rooms[room_id]
    assert room["white"]["id"] == 9901
    assert room["black"] is None
    assert room["spectators"] == [{"id": 9902, "username": "black", "name": "Black"}]

    asyncio.run(manager.pick_role(black, room_id, "b"))
    assert manager.rooms[room_id]["white"]["id"] == 9901
    assert manager.rooms[room_id]["black"]["id"] == 9902
    assert manager.rooms[room_id]["spectators"] == []


def test_finished_game_automatically_moves_players_to_spectators():
    manager, (room_id, white, _white_ws) = make_room()
    room = manager.rooms[room_id]
    original_history = list(room["move_history"])

    manager._complete_game(room, {"type": "checkmate", "winner": "w", "desc": "백 체크메이트 승리"})

    assert room["white"]["id"] == 1
    assert room["black"]["id"] == 2
    assert room["game_started"] is True
    assert room["result"]["type"] == "checkmate"
    assert room["move_history"] == original_history
    assert len(room["completed_games"]) == 1
    assert room["completed_games"][0]["result"]["type"] == "checkmate"

    async def reset():
        await manager._reset_after_result(room_id)

    asyncio.run(reset())
    assert room["white"] is None
    assert room["black"] is None
    assert room["game_started"] is False
    assert room["result"] is None
    assert {player["id"] for player in room["spectators"]} == {1, 2}


def test_server_draw_rules_cover_insufficient_material_fifty_moves_and_repetition():
    insufficient = chess.Board("8/8/8/8/8/8/2k5/7K w - - 0 1")
    assert ChessManager._get_game_result(insufficient, [{"fen": insufficient.fen()}])["type"] == "draw"

    fifty_move = chess.Board("8/8/8/8/8/8/2k5/7K w - - 100 51")
    assert ChessManager._get_game_result(fifty_move, [{"fen": fifty_move.fen()}])["type"] == "draw"

    repetition = chess.Board(START_FEN)
    repetition_history = [{"fen": repetition.fen()}]
    for uci in ("g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"):
        repetition.push_uci(uci)
        repetition_history.append({"fen": repetition.fen()})
    assert ChessManager._get_game_result(repetition, repetition_history)["type"] == "draw"


def test_disconnect_grace_preserves_player_during_refresh_reconnect():
    manager, (room_id, white, white_ws) = make_room()
    replacement_ws = FakeWebSocket()

    async def refresh_reconnect():
        manager.register_client(replacement_ws, white)
        await manager.unregister_client(white_ws)
        assert manager.rooms[room_id]["white"]["id"] == white["id"]
        await manager.join_room(replacement_ws, white, room_id, "spectator")
        await asyncio.sleep(0)

    asyncio.run(refresh_reconnect())
    room = manager.rooms[room_id]
    assert room["white"]["id"] == white["id"]
    assert room["result"] is None


def test_send_room_chat():
    manager = ChessManager()
    white_ws = FakeWebSocket()
    black_ws = FakeWebSocket()
    spec_ws = FakeWebSocket()

    white = {"id": 9981, "username": "w_user", "display_name": "WhitePlayer"}
    black = {"id": 9982, "username": "b_user", "display_name": "BlackPlayer"}
    spec = {"id": 9983, "username": "s_user", "display_name": "Spectator"}

    async def run_chat():
        manager.register_client(white_ws, white)
        room = await manager.create_room(white_ws, white, "ChatRoom", 10)
        room_id = room["id"]
        manager.register_client(black_ws, black)
        await manager.join_room(black_ws, black, room_id, "black")
        manager.register_client(spec_ws, spec)
        await manager.join_room(spec_ws, spec, room_id, "spectator")

        await manager.send_room_chat(white, room_id, "Hello from White")
        await manager.send_room_chat(black, room_id, "Hello from Black")
        await manager.send_room_chat(spec, room_id, "Hello from Spectator")

        return room_id

    room_id = asyncio.run(run_chat())

    chats = [msg for msg in white_ws.messages if msg.get("type") == "room_chat"]
    assert len(chats) == 3

    assert chats[0]["message"]["name"] == "WhitePlayer"
    assert chats[0]["message"]["role"] == "백"
    assert chats[0]["message"]["text"] == "Hello from White"

    assert chats[1]["message"]["name"] == "BlackPlayer"
    assert chats[1]["message"]["role"] == "흑"
    assert chats[1]["message"]["text"] == "Hello from Black"

    assert chats[2]["message"]["name"] == "Spectator"
    assert chats[2]["message"]["role"] == "관전자"
    assert chats[2]["message"]["text"] == "Hello from Spectator"


def test_resign_records_winner_and_loser_correctly():
    manager = ChessManager()
    white_ws = FakeWebSocket()
    black_ws = FakeWebSocket()

    white = {"id": 8801, "username": "w_user", "display_name": "WhitePlayer"}
    black = {"id": 8802, "username": "b_user", "display_name": "BlackPlayer"}

    async def run_resignation():
        manager.register_client(white_ws, white)
        room = await manager.create_room(white_ws, white, "ResignRoom", 10)
        room_id = room["id"]
        manager.register_client(black_ws, black)
        await manager.join_room(black_ws, black, room_id, "black")
        await manager.start_game(white, room_id)

        # White resigns -> Black should WIN, White should LOSE!
        await manager.resign(white, room_id)
        return room

    room = asyncio.run(run_resignation())
    assert room["result"]["winner"] == "b"
    assert room["result"]["type"] == "resign"

    # Check room in-memory stats
    assert room["stats"]["8801"]["losses"] == 1
    assert room["stats"]["8801"]["wins"] == 0
    assert room["stats"]["8802"]["wins"] == 1
    assert room["stats"]["8802"]["losses"] == 0


def test_make_move_stores_from_and_to_in_history():
    manager = ChessManager()
    white_ws = FakeWebSocket()
    black_ws = FakeWebSocket()

    white = {"id": 9901, "username": "w99", "display_name": "White99"}
    black = {"id": 9902, "username": "b99", "display_name": "Black99"}

    async def run():
        manager.register_client(white_ws, white)
        room = await manager.create_room(white_ws, white, "HistoryRoom", 10)
        room_id = room["id"]
        manager.register_client(black_ws, black)
        await manager.join_room(black_ws, black, room_id, "black")
        await manager.start_game(white, room_id)

        # White plays e2 -> e4
        await manager.make_move(white, room_id, {"from": "e2", "to": "e4"})
        return room

    room = asyncio.run(run())
    history = room["move_history"]
    assert len(history) == 2
    assert history[0]["move"] == "Start"
    assert history[1]["move"] == "e4"
    assert history[1]["from"] == "e2"
    assert history[1]["to"] == "e4"
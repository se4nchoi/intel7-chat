import pytest
from app.janggi_engine import JanggiBoard

def test_initial_board_and_formations():
    b_wonang = JanggiBoard("wonangma", "wonangma")
    assert b_wonang.get_piece((1, 0)) == "N"
    assert b_wonang.get_piece((2, 0)) == "B"
    assert b_wonang.get_piece((6, 0)) == "B"
    assert b_wonang.get_piece((7, 0)) == "N"

    b_yangwima = JanggiBoard("yangwima", "yangwima")
    assert b_yangwima.get_piece((1, 0)) == "B"
    assert b_yangwima.get_piece((2, 0)) == "N"
    assert b_yangwima.get_piece((6, 0)) == "N"
    assert b_yangwima.get_piece((7, 0)) == "B"

    b_oenma = JanggiBoard("oenma", "oreunma")
    assert b_oenma.get_piece((1, 0)) == "N"
    assert b_oenma.get_piece((2, 0)) == "B"
    assert b_oenma.get_piece((6, 0)) == "N"
    assert b_oenma.get_piece((7, 0)) == "B"

    # Han piece casing
    assert b_oenma.get_piece((1, 9)) == "b"
    assert b_oenma.get_piece((2, 9)) == "n"


def test_initial_material_scores():
    board = JanggiBoard()
    score = board.calculate_score()
    # Cho = 72.0, Han = 72.0 + 1.5 = 73.5
    assert score["cho"] == 72.0
    assert score["han"] == 73.5
    assert score["diff"] == 1.5
    assert score["leading"] == "han"


def test_horse_myeok_blocking():
    board = JanggiBoard("wonangma", "wonangma")
    # Cho Horse is at (1, 0).
    # Forward myeok is (1, 1). If (1, 1) is empty:
    assert board.get_piece((1, 1)) is None
    # Destination (0, 2) is occupied by nothing, (2, 2) is occupied by nothing
    legal_moves = board.get_legal_moves("cho")
    assert ((1, 0), (0, 2)) in legal_moves
    assert ((1, 0), (2, 2)) in legal_moves

    # Now place an obstacle on myeok (1, 1)
    board.grid[(1, 1)] = "P"
    blocked_moves = board.get_legal_moves("cho")
    assert ((1, 0), (0, 2)) not in blocked_moves
    assert ((1, 0), (2, 2)) not in blocked_moves


def test_cannon_jumping_rules():
    board = JanggiBoard("wonangma", "wonangma")
    # Cho Cannon is at (1, 2).
    # Directly in front is empty (1, 3), then empty until (1, 7) which is Han Cannon.
    # Cannon cannot jump over another cannon!
    board.grid[(1, 3)] = None
    board.grid[(1, 4)] = "p"  # Bridge piece (non-cannon)
    # Target (1, 5) empty -> legal jump landing
    legal = board.get_legal_moves("cho")
    assert ((1, 2), (1, 5)) in legal

    # Now make bridge a cannon
    board.grid[(1, 4)] = "c"  # Cannon as bridge
    legal2 = board.get_legal_moves("cho")
    assert ((1, 2), (1, 5)) not in legal2

    # Cannot capture another cannon
    board.grid[(1, 4)] = "P"  # Bridge is friendly soldier
    board.grid[(1, 5)] = "c"  # Enemy cannon as target
    legal3 = board.get_legal_moves("cho")
    assert ((1, 2), (1, 5)) not in legal3


def test_soldier_palace_diagonal():
    board = JanggiBoard("wonangma", "wonangma")
    # Place Cho Soldier inside enemy palace at (3, 7)
    board.grid[(3, 7)] = "P"
    moves = board._generate_pseudo_moves((3, 7))
    # Can move forward (3, 8), sideways (2, 7) or (4, 7), and diagonal (4, 8)
    assert (4, 8) in moves
    assert (3, 8) in moves


def test_pass_turn_and_consecutive_passes():
    board = JanggiBoard()
    assert board.turn == "cho"
    res1 = board.pass_turn()
    assert res1["turn"] == "han"
    assert not res1["double_pass"]
    assert board.consecutive_passes == 1

    res2 = board.pass_turn()
    assert res2["turn"] == "cho"
    assert res2["double_pass"]
    assert board.consecutive_passes == 2


def test_bikjang_detection():
    board = JanggiBoard()
    # Clear line between Kings at col 4
    for r in range(2, 8):
        board.grid[(4, r)] = None
    assert board.is_bikjang()

    # Block line
    board.grid[(4, 4)] = "P"
    assert not board.is_bikjang()

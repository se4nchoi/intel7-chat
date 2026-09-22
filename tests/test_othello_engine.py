"""Unit tests for the Pure Python Othello (Reversi) Rules Engine."""
import pytest
from app.engines.othello import OthelloBoard, coord_to_notation, notation_to_coord


def test_othello_initial_state():
    board = OthelloBoard()
    assert board.size == 8
    assert board.turn == "b"
    assert not board.game_over
    assert board.winner is None

    counts = board.get_counts()
    assert counts["black"] == 2
    assert counts["white"] == 2
    assert counts["empty"] == 60

    # Check center pieces per WOF standard:
    # d4 (3, 3) = w, e5 (4, 4) = w
    # d5 (3, 4) = b, e4 (4, 3) = b
    assert board.get_piece(3, 3) == "w"
    assert board.get_piece(4, 4) == "w"
    assert board.get_piece(3, 4) == "b"
    assert board.get_piece(4, 3) == "b"


def test_othello_initial_legal_moves():
    board = OthelloBoard()
    legal = board.get_legal_moves("b")

    # The 4 classic opening moves for Black:
    # c4 (2, 3), d3 (3, 2), e6 (4, 5), f5 (5, 4)
    expected_moves = {(2, 3), (3, 2), (4, 5), (5, 4)}
    assert set(legal.keys()) == expected_moves

    # Check that c4 flips d4 (3, 3)
    assert (3, 3) in legal[(2, 3)]


def test_othello_first_move_execution():
    board = OthelloBoard()
    # Black plays c4 (2, 3)
    res = board.make_move(2, 3, "b")

    assert res["player"] == "b"
    assert res["notation"] == "c4"
    assert [3, 3] in res["flipped"]

    # Now d4 (3, 3) should be black
    assert board.get_piece(3, 3) == "b"
    assert board.get_piece(2, 3) == "b"

    counts = board.get_counts()
    assert counts["black"] == 4
    assert counts["white"] == 1
    assert counts["empty"] == 59

    # Turn should advance to White
    assert board.turn == "w"
    assert not board.game_over


def test_othello_multi_directional_flip():
    board = OthelloBoard()
    # Set up a position where placing a black disc at (3, 2) flips in multiple directions
    board.grid.clear()
    # Friendly black discs:
    board.grid[(3, 5)] = "b"
    board.grid[(6, 2)] = "b"
    # Opponent white discs trapped:
    board.grid[(3, 3)] = "w"
    board.grid[(3, 4)] = "w"
    board.grid[(4, 2)] = "w"
    board.grid[(5, 2)] = "w"

    board.turn = "b"
    # Placing at (3, 2) should flip downwards (3, 3), (3, 4) and rightwards (4, 2), (5, 2)
    flips = board.get_flips(3, 2, "b")
    expected_flips = {(3, 3), (3, 4), (4, 2), (5, 2)}
    assert set(flips) == expected_flips

    res = board.make_move(3, 2, "b")
    assert len(res["flipped"]) == 4
    assert board.get_piece(3, 2) == "b"
    assert board.get_piece(3, 3) == "b"
    assert board.get_piece(3, 4) == "b"
    assert board.get_piece(4, 2) == "b"
    assert board.get_piece(5, 2) == "b"


def test_othello_invalid_moves():
    board = OthelloBoard()

    # Move out of turn
    with pytest.raises(ValueError, match="현재 차례가 아닙니다"):
        board.make_move(2, 3, "w")

    # Already occupied square
    with pytest.raises(ValueError, match="이미 돌이 놓여 있는"):
        board.make_move(3, 3, "b")

    # No flips possible (invalid square)
    with pytest.raises(ValueError, match="상대방 돌을 하나 이상 뒤집을 수 있는"):
        board.make_move(0, 0, "b")

    # Off-board coordinates
    with pytest.raises(ValueError, match="잘못된 좌표"):
        board.make_move(8, 8, "b")


def test_othello_pass_and_game_over():
    board = OthelloBoard()
    board.grid.clear()
    # Setup position where Black has a move but White has none
    board.grid[(0, 0)] = "b"
    board.grid[(0, 1)] = "w"
    board.turn = "b"

    # Black places at (0, 2), flipping (0, 1) to black
    res = board.make_move(0, 2, "b")
    # All discs are now black (0, 0), (0, 1), (0, 2)
    # White has 0 discs, so game is over immediately by wipeout!
    assert res["game_over"]
    assert res["winner"] == "b"
    assert board.get_counts()["white"] == 0


def test_othello_notation_helpers():
    assert coord_to_notation(0, 0) == "a1"
    assert coord_to_notation(7, 7) == "h8"
    assert coord_to_notation(2, 3) == "c4"

    assert notation_to_coord("a1") == (0, 0)
    assert notation_to_coord("h8") == (7, 7)
    assert notation_to_coord("c4") == (2, 3)
    assert notation_to_coord("invalid") is None

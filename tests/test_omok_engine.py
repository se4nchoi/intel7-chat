import pytest
from app.omok_engine import OmokBoard

def test_omok_basic_moves():
    board = OmokBoard(15)
    assert board.turn == "b"
    res1 = board.push_move(7, 7, "b")
    assert res1["turn"] == "w"
    assert res1["winner"] is None

    res2 = board.push_move(7, 8, "w")
    assert res2["turn"] == "b"
    assert res2["winner"] is None


def test_omok_horizontal_win():
    board = OmokBoard(15)
    # Black: (3,7), (4,7), (5,7), (6,7), (7,7)
    # White: (3,8), (4,8), (5,8), (6,8)
    moves = [
        (3, 7, "b"), (3, 8, "w"),
        (4, 7, "b"), (4, 8, "w"),
        (5, 7, "b"), (5, 8, "w"),
        (6, 7, "b"), (6, 8, "w"),
        (7, 7, "b"),
    ]
    for c, r, p in moves:
        res = board.push_move(c, r, p)

    assert res["winner"] == "b"
    assert len(res["winning_line"]) == 5
    assert (3, 7) in res["winning_line"]
    assert (7, 7) in res["winning_line"]


def test_omok_diagonal_win():
    board = OmokBoard(15)
    # Black diagonal: (2,2), (3,3), (4,4), (5,5), (6,6)
    moves = [
        (2, 2, "b"), (0, 1, "w"),
        (3, 3, "b"), (0, 2, "w"),
        (4, 4, "b"), (0, 3, "w"),
        (5, 5, "b"), (0, 4, "w"),
        (6, 6, "b"),
    ]
    for c, r, p in moves:
        res = board.push_move(c, r, p)

    assert res["winner"] == "b"
    assert len(res["winning_line"]) == 5


def test_omok_occupied_square_error():
    board = OmokBoard(15)
    board.push_move(7, 7, "b")
    with pytest.raises(ValueError, match="이미 돌이 놓여 있는 자리입니다"):
        board.push_move(7, 7, "w")

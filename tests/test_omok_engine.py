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
    # White scattered dummy moves
    moves = [
        (3, 7, "b"), (0, 0, "w"),
        (4, 7, "b"), (0, 2, "w"),
        (5, 7, "b"), (0, 4, "w"),
        (6, 7, "b"), (0, 6, "w"),
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
        (2, 2, "b"), (0, 0, "w"),
        (3, 3, "b"), (0, 2, "w"),
        (4, 4, "b"), (0, 4, "w"),
        (5, 5, "b"), (0, 6, "w"),
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


def test_renju_black_33_auto_loss():
    """Test Renju: Black playing 3-3 immediately results in White win (auto-loss)."""
    board = OmokBoard(15)
    # Setup Black stones that will form 3-3 at (7, 7):
    # Horizontal: (6, 7), (8, 7)
    # Vertical: (7, 6), (7, 8)
    moves = [
        (6, 7, "b"), (0, 0, "w"),
        (8, 7, "b"), (0, 2, "w"),
        (7, 6, "b"), (0, 4, "w"),
        (7, 8, "b"), (0, 6, "w"),
    ]
    for c, r, p in moves:
        board.push_move(c, r, p)

    # (7, 7) should be detected as a 3-3 forbidden point
    forbidden = board.get_forbidden_points()
    assert (7, 7) in forbidden
    assert forbidden[(7, 7)] == "33"

    # Black places at (7, 7) -> Instant Auto-Loss (White wins)
    res = board.push_move(7, 7, "b")
    assert res["winner"] == "w"
    assert res["foul"] == "33"
    assert res["foul_player"] == "b"
    assert "3-3" in res["foul_desc"]


def test_renju_black_44_auto_loss():
    """Test Renju: Black playing 4-4 immediately results in White win (auto-loss)."""
    board = OmokBoard(15)
    # Setup Black stones:
    # Horizontal 4: (5, 7), (6, 7), (8, 7) with (7, 7)
    # Vertical 4: (7, 5), (7, 6), (7, 8) with (7, 7)
    moves = [
        (5, 7, "b"), (0, 0, "w"),
        (6, 7, "b"), (0, 2, "w"),
        (8, 7, "b"), (0, 4, "w"),
        (7, 5, "b"), (0, 6, "w"),
        (7, 6, "b"), (0, 8, "w"),
        (7, 8, "b"), (0, 10, "w"),
    ]
    for c, r, p in moves:
        board.push_move(c, r, p)

    forbidden = board.get_forbidden_points()
    assert (7, 7) in forbidden
    assert forbidden[(7, 7)] == "44"

    res = board.push_move(7, 7, "b")
    assert res["winner"] == "w"
    assert res["foul"] == "44"
    assert res["foul_player"] == "b"
    assert "4-4" in res["foul_desc"]


def test_renju_black_overline_auto_loss():
    """Test Renju: Black connecting 6 or more in a row results in overline foul loss."""
    board = OmokBoard(15)
    # Segment A: (2,7), (3,7), (4,7)
    # Segment B: (6,7), (7,7)
    # Playing at (5,7) connects them to 6 in a row!
    moves = [
        (2, 7, "b"), (0, 0, "w"),
        (3, 7, "b"), (0, 2, "w"),
        (4, 7, "b"), (0, 4, "w"),
        (6, 7, "b"), (0, 6, "w"),
        (7, 7, "b"), (0, 8, "w"),
    ]
    for c, r, p in moves:
        board.push_move(c, r, p)

    forbidden = board.get_forbidden_points()
    assert (5, 7) in forbidden
    assert forbidden[(5, 7)] == "overline"

    res = board.push_move(5, 7, "b")
    assert res["winner"] == "w"
    assert res["foul"] == "overline"
    assert res["foul_player"] == "b"


def test_renju_white_overline_win():
    """Test Renju: White is allowed overline and WINS with 6 or more."""
    board = OmokBoard(15)
    # White has (2,8), (3,8), (4,8) and (6,8), (7,8)
    # White plays (5,8) to connect all 6 stones
    moves = [
        (0, 0, "b"), (2, 8, "w"),
        (0, 2, "b"), (3, 8, "w"),
        (0, 4, "b"), (4, 8, "w"),
        (0, 6, "b"), (6, 8, "w"),
        (0, 8, "b"), (7, 8, "w"),
        (0, 10, "b"), (5, 8, "w"),
    ]
    for c, r, p in moves:
        res = board.push_move(c, r, p)

    assert res["winner"] == "w"
    assert res["foul"] is None
    assert len(res["winning_line"]) == 6


def test_renju_white_33_allowed():
    """Test Renju: White has no 3-3 foul and can play 3-3 freely."""
    board = OmokBoard(15)
    # White creates 3-3 at (7, 7)
    moves = [
        (0, 0, "b"), (6, 7, "w"),
        (0, 2, "b"), (8, 7, "w"),
        (0, 4, "b"), (7, 6, "w"),
        (0, 6, "b"), (7, 8, "w"),
        (0, 8, "b"),
    ]
    for c, r, p in moves:
        board.push_move(c, r, p)

    # White plays at (7, 7) -> perfectly legal, no foul!
    res = board.push_move(7, 7, "w")
    assert res["winner"] is None
    assert res["foul"] is None
    assert res["turn"] == "b"


def test_renju_black_exact_5_overrides_four():
    """Test Renju: Exact 5 takes precedence over four/three."""
    board = OmokBoard(15)
    # Black forms 5 along horizontal (3,7) to (7,7)
    # while (7,7) also intersects (7,5), (7,6)
    moves = [
        (3, 7, "b"), (0, 0, "w"),
        (4, 7, "b"), (0, 2, "w"),
        (5, 7, "b"), (0, 4, "w"),
        (6, 7, "b"), (0, 6, "w"),
        (7, 5, "b"), (0, 8, "w"),
        (7, 6, "b"), (0, 10, "w"),
    ]
    for c, r, p in moves:
        board.push_move(c, r, p)

    # (7, 7) forms horizontal 5, so it is NOT forbidden
    forbidden = board.get_forbidden_points()
    assert (7, 7) not in forbidden

    res = board.push_move(7, 7, "b")
    assert res["winner"] == "b"
    assert res["foul"] is None
    assert len(res["winning_line"]) == 5

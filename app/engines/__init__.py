"""Game engines for turn-based games (Omok, Janggi, Othello)."""
from app.engines.omok import OmokBoard, BOARD_SIZE as OMOK_BOARD_SIZE
from app.engines.janggi import (
    JanggiBoard,
    PIECE_POINTS,
    PIECE_NAMES_KR,
    CHO_PALACE_COORDS,
    HAN_PALACE_COORDS,
)
from app.engines.othello import OthelloBoard, BOARD_SIZE as OTHELLO_BOARD_SIZE

__all__ = [
    "OmokBoard",
    "OMOK_BOARD_SIZE",
    "JanggiBoard",
    "PIECE_POINTS",
    "PIECE_NAMES_KR",
    "CHO_PALACE_COORDS",
    "HAN_PALACE_COORDS",
    "OthelloBoard",
    "OTHELLO_BOARD_SIZE",
]

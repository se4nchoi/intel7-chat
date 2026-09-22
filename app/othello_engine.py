"""Backward-compatible facade for Othello game engine."""
from app.engines.othello import OthelloBoard, coord_to_notation, notation_to_coord, BOARD_SIZE, DIRECTIONS, FILES, RANKS

__all__ = [
    "OthelloBoard",
    "coord_to_notation",
    "notation_to_coord",
    "BOARD_SIZE",
    "DIRECTIONS",
    "FILES",
    "RANKS",
]

"""Pure Python Omok (Gomoku - 오목) Rules Engine.

- 15x15 intersections (0..14, 0..14) = 225 points.
- Black ('b', 흑) moves first, White ('w', 백) moves second.
- 5-in-a-row victory detection across horizontal, vertical, and both diagonals.
- Winning line coordinate tracing for highlighting.
- Draw detection upon full board.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Tuple

BOARD_SIZE = 15


class OmokBoard:
    def __init__(self, size: int = BOARD_SIZE) -> None:
        self.size = size
        self.turn: str = "b"  # "b" (Black / 흑) or "w" (White / 백)
        self.grid: Dict[Tuple[int, int], str] = {}
        self.move_history: List[Tuple[Tuple[int, int], str]] = []
        self.winner: Optional[str] = None
        self.winning_line: Optional[List[Tuple[int, int]]] = None

    def clone(self) -> "OmokBoard":
        new_b = OmokBoard(self.size)
        new_b.turn = self.turn
        new_b.grid = dict(self.grid)
        new_b.move_history = list(self.move_history)
        new_b.winner = self.winner
        new_b.winning_line = list(self.winning_line) if self.winning_line else None
        return new_b

    def is_valid_coord(self, c: int, r: int) -> bool:
        return 0 <= c < self.size and 0 <= r < self.size

    def get_piece(self, c: int, r: int) -> Optional[str]:
        return self.grid.get((c, r))

    def get_legal_moves(self) -> List[Tuple[int, int]]:
        if self.winner:
            return []
        moves = []
        for c in range(self.size):
            for r in range(self.size):
                if (c, r) not in self.grid:
                    moves.append((c, r))
        return moves

    def push_move(self, col: int, row: int, expected_player: Optional[str] = None) -> Dict[str, any]:
        if self.winner:
            raise ValueError("이미 종료된 대국입니다.")
        if not self.is_valid_coord(col, row):
            raise ValueError("보드 바깥 좌표입니다.")
        if (col, row) in self.grid:
            raise ValueError("이미 돌이 놓여 있는 자리입니다.")
        if expected_player and expected_player != self.turn:
            raise ValueError("자신의 턴에만 착수할 수 있습니다.")

        player = self.turn
        self.grid[(col, row)] = player
        self.move_history.append(((col, row), player))

        # Check win condition
        win_line = self._check_win_from(col, row, player)
        if win_line:
            self.winner = player
            self.winning_line = win_line

        # Check draw condition
        is_draw = False
        if not self.winner and len(self.grid) >= self.size * self.size:
            is_draw = True

        next_turn = "w" if player == "b" else "b"
        self.turn = next_turn

        return {
            "col": col,
            "row": row,
            "player": player,
            "turn": self.turn,
            "winner": self.winner,
            "winning_line": self.winning_line,
            "is_draw": is_draw,
            "move_number": len(self.move_history),
        }

    def _check_win_from(self, col: int, row: int, player: str) -> Optional[List[Tuple[int, int]]]:
        directions = [
            (1, 0),   # Horizontal
            (0, 1),   # Vertical
            (1, 1),   # Diagonal \ (or / depending on coordinate direction)
            (1, -1),  # Diagonal /
        ]

        for dc, dr in directions:
            line = [(col, row)]

            # Forward ray
            step = 1
            while True:
                c, r = col + dc * step, row + dr * step
                if self.is_valid_coord(c, r) and self.grid.get((c, r)) == player:
                    line.append((c, r))
                    step += 1
                else:
                    break

            # Backward ray
            step = 1
            while True:
                c, r = col - dc * step, row - dr * step
                if self.is_valid_coord(c, r) and self.grid.get((c, r)) == player:
                    line.append((c, r))
                    step += 1
                else:
                    break

            if len(line) >= 5:
                # Sort line along direction
                line.sort(key=lambda pt: (pt[0] * dc + pt[1] * dr))
                return line

        return None

    def to_dict(self) -> Dict[str, any]:
        stones = []
        for (c, r), color in self.grid.items():
            stones.append({"col": c, "row": r, "color": color})
        return {
            "size": self.size,
            "turn": self.turn,
            "stones": stones,
            "last_move": self.move_history[-1] if self.move_history else None,
            "move_count": len(self.move_history),
            "winner": self.winner,
            "winning_line": self.winning_line,
        }

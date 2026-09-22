"""Pure Python Othello (Reversi) Rules Engine.
Complies strictly with the official World Othello Federation (WOF) rules:
- 8x8 board (files a-h, ranks 1-8).
- Initial setup: Black on d5, e4; White on d4, e5. Black moves first.
- 8-directional outflanking and disc flipping.
- Mandatory play: If legal moves exist, player must move.
- Mandatory pass: If player has no legal moves, turn automatically passes.
- Game termination: Neither player has legal moves (or board full / wipeout).
"""
from __future__ import annotations

from typing import Dict, List, Optional, Set, Tuple

BOARD_SIZE = 8

DIRECTIONS = [
    (-1, -1), (-1, 0), (-1, 1),
    (0, -1),           (0, 1),
    (1, -1),  (1, 0),  (1, 1),
]

FILES = ["a", "b", "c", "d", "e", "f", "g", "h"]
RANKS = ["1", "2", "3", "4", "5", "6", "7", "8"]


def coord_to_notation(col: int, row: int) -> str:
    """Convert (col, row) (0..7, 0..7) to algebraic notation (e.g. 2, 3 -> 'c4')."""
    if 0 <= col < 8 and 0 <= row < 8:
        return f"{FILES[col]}{RANKS[row]}"
    return f"?{col},{row}"


def notation_to_coord(sq: str) -> Optional[Tuple[int, int]]:
    """Convert notation e.g. 'c4' to (col, row)."""
    sq = sq.strip().lower()
    if len(sq) == 2 and sq[0] in FILES and sq[1] in RANKS:
        return FILES.index(sq[0]), RANKS.index(sq[1])
    return None


class OthelloBoard:
    def __init__(self, size: int = BOARD_SIZE) -> None:
        self.size = size
        self.turn: str = "b"  # "b" (Black / 흑) or "w" (White / 백)
        self.grid: Dict[Tuple[int, int], str] = {}
        self.move_history: List[dict] = []
        self.game_over: bool = False
        self.winner: Optional[str] = None  # "b", "w", "draw", or None
        self.consecutive_passes: int = 0

        # WOF Standard setup:
        # d4 (3, 3) = White, e5 (4, 4) = White
        # d5 (3, 4) = Black, e4 (4, 3) = Black
        self.grid[(3, 3)] = "w"
        self.grid[(4, 4)] = "w"
        self.grid[(3, 4)] = "b"
        self.grid[(4, 3)] = "b"

    def clone(self) -> "OthelloBoard":
        new_b = OthelloBoard(self.size)
        new_b.turn = self.turn
        new_b.grid = dict(self.grid)
        new_b.move_history = [dict(m) for m in self.move_history]
        new_b.game_over = self.game_over
        new_b.winner = self.winner
        new_b.consecutive_passes = self.consecutive_passes
        return new_b

    def is_valid_coord(self, c: int, r: int) -> bool:
        return 0 <= c < self.size and 0 <= r < self.size

    def get_piece(self, c: int, r: int) -> Optional[str]:
        return self.grid.get((c, r))

    def get_counts(self) -> Dict[str, int]:
        """Count Black and White discs on the board."""
        black = sum(1 for v in self.grid.values() if v == "b")
        white = sum(1 for v in self.grid.values() if v == "w")
        empty = (self.size * self.size) - (black + white)
        return {"black": black, "white": white, "empty": empty}

    def calculate_score(self) -> Dict[str, any]:
        counts = self.get_counts()
        b, w = counts["black"], counts["white"]
        leading = "b" if b > w else ("w" if w > b else "draw")
        diff = abs(b - w)
        return {
            "black": b,
            "white": w,
            "empty": counts["empty"],
            "leading": leading,
            "diff": diff,
        }

    def _get_flips_in_dir(self, c: int, r: int, dc: int, dr: int, player: str) -> List[Tuple[int, int]]:
        """Return list of opponent coordinates flipped in direction (dc, dr)."""
        opponent = "w" if player == "b" else "b"
        flips: List[Tuple[int, int]] = []
        curr_c, curr_r = c + dc, r + dr

        while self.is_valid_coord(curr_c, curr_r):
            piece = self.grid.get((curr_c, curr_r))
            if piece == opponent:
                flips.append((curr_c, curr_r))
                curr_c += dc
                curr_r += dr
            elif piece == player:
                # Trapped opponent discs between newly placed and this friendly disc!
                return flips
            else:
                # Empty square encountered, no outflanking in this direction
                return []
        return []

    def get_flips(self, c: int, r: int, player: Optional[str] = None) -> List[Tuple[int, int]]:
        """Get all opponent discs that would be flipped by placing at (c, r)."""
        if not self.is_valid_coord(c, r) or (c, r) in self.grid:
            return []
        p = player or self.turn
        total_flips: List[Tuple[int, int]] = []
        for dc, dr in DIRECTIONS:
            dir_flips = self._get_flips_in_dir(c, r, dc, dr, p)
            if dir_flips:
                total_flips.extend(dir_flips)
        return total_flips

    def get_legal_moves(self, player: Optional[str] = None) -> Dict[Tuple[int, int], List[Tuple[int, int]]]:
        """Return mapping of (c, r) -> list of flipped coordinates for all legal moves."""
        if self.game_over:
            return {}
        p = player or self.turn
        legal: Dict[Tuple[int, int], List[Tuple[int, int]]] = {}
        for c in range(self.size):
            for r in range(self.size):
                if (c, r) not in self.grid:
                    flips = self.get_flips(c, r, p)
                    if flips:
                        legal[(c, r)] = flips
        return legal

    def has_legal_moves(self, player: Optional[str] = None) -> bool:
        """Quickly check if player has at least one legal move."""
        p = player or self.turn
        for c in range(self.size):
            for r in range(self.size):
                if (c, r) not in self.grid:
                    if self.get_flips(c, r, p):
                        return True
        return False

    def make_move(self, col: int, row: int, player: Optional[str] = None) -> dict:
        """Place a disc at (col, row) for player. Flips outflanked discs and advances turn."""
        if self.game_over:
            raise ValueError("대국이 이미 종료되었습니다.")

        p = player or self.turn
        if p != self.turn:
            raise ValueError(f"현재 차례가 아닙니다 (현재 차례: {'흑' if self.turn == 'b' else '백'}).")

        if not self.is_valid_coord(col, row):
            raise ValueError(f"잘못된 좌표입니다: ({col}, {row})")

        if (col, row) in self.grid:
            raise ValueError("이미 돌이 놓여 있는 위치입니다.")

        flips = self.get_flips(col, row, p)
        if not flips:
            raise ValueError("상대방 돌을 하나 이상 뒤집을 수 있는 위치에만 놓을 수 있습니다.")

        # 1. Place disc and flip opponent discs
        self.grid[(col, row)] = p
        for fc, fr in flips:
            self.grid[(fc, fr)] = p

        notation = coord_to_notation(col, row)
        counts = self.get_counts()
        self.consecutive_passes = 0

        # 2. Determine next turn per WOF rules
        opponent = "w" if p == "b" else "b"
        opponent_has_moves = self.has_legal_moves(opponent)

        passed = False
        if opponent_has_moves:
            self.turn = opponent
        else:
            # Opponent has NO moves! Opponent must pass.
            player_has_moves = self.has_legal_moves(p)
            if player_has_moves:
                # Player moves again (opponent passed)
                self.turn = p
                passed = True
                self.consecutive_passes = 1
            else:
                # Neither player has moves! Game over.
                self.game_over = True
                self.turn = opponent
                score = self.calculate_score()
                self.winner = score["leading"]

        # Check full board or wipeout
        if counts["empty"] == 0 or counts["black"] == 0 or counts["white"] == 0:
            self.game_over = True
            score = self.calculate_score()
            self.winner = score["leading"]

        move_record = {
            "col": col,
            "row": row,
            "player": p,
            "notation": notation,
            "flips_count": len(flips),
            "flipped": [[fc, fr] for fc, fr in flips],
            "passed": passed,
            "counts": counts,
        }
        self.move_history.append(move_record)

        return {
            "col": col,
            "row": row,
            "player": p,
            "notation": notation,
            "flipped": [[fc, fr] for fc, fr in flips],
            "passed": passed,
            "game_over": self.game_over,
            "winner": self.winner,
            "counts": counts,
        }

    def pass_turn(self, player: Optional[str] = None) -> dict:
        """Voluntary/manual pass check (valid only if player has NO legal moves)."""
        if self.game_over:
            raise ValueError("대국이 이미 종료되었습니다.")

        p = player or self.turn
        if p != self.turn:
            raise ValueError("현재 차례가 아닙니다.")

        if self.has_legal_moves(p):
            raise ValueError("둘 수 있는 자리가 있으므로 패스할 수 없습니다 (착수 의무 규칙).")

        opponent = "w" if p == "b" else "b"
        self.consecutive_passes += 1
        opponent_has_moves = self.has_legal_moves(opponent)

        double_pass = self.consecutive_passes >= 2 or not opponent_has_moves
        if double_pass:
            self.game_over = True
            score = self.calculate_score()
            self.winner = score["leading"]

        self.turn = opponent
        counts = self.get_counts()
        notation = f"{'흑' if p == 'b' else '백'} 패스"

        record = {
            "col": -1,
            "row": -1,
            "player": p,
            "notation": notation,
            "flips_count": 0,
            "flipped": [],
            "passed": True,
            "counts": counts,
        }
        self.move_history.append(record)

        return {
            "player": p,
            "notation": notation,
            "double_pass": double_pass,
            "game_over": self.game_over,
            "winner": self.winner,
            "counts": counts,
        }

    def to_dict(self) -> dict:
        """Serialize board state for client transmission."""
        legal = self.get_legal_moves()
        legal_list = [
            {"col": c, "row": r, "flips": len(flips)}
            for (c, r), flips in legal.items()
        ]
        discs = [
            {"col": c, "row": r, "color": color}
            for (c, r), color in self.grid.items()
        ]
        return {
            "size": self.size,
            "turn": self.turn,
            "discs": discs,
            "counts": self.get_counts(),
            "legal_moves": legal_list,
            "game_over": self.game_over,
            "winner": self.winner,
            "move_count": len(self.move_history),
        }

"""Pure Python Omok (Renju Rules - 렌주룰 오목) Rules Engine.

Features:
- 15x15 intersections (0..14, 0..14) = 225 points.
- Black ('b', 흑) moves first, White ('w', 백) moves second.
- International Renju Rules (국제 공인 렌주룰):
  - Black (흑):
    - 3-3 (Double Three / 삼삼) 금수: 착수 시 즉시 백 승리 (금수 자동패).
    - 4-4 (Double Four / 사사) 금수: 착수 시 즉시 백 승리 (금수 자동패).
    - Overline (장목 / 6목 이상) 금수: 착수 시 즉시 백 승리 (금수 자동패).
    - Exact 5 (오목 / 정확히 5목): 흑 승리! (5목 완성 시 3-3/4-4 금수보다 승리가 절대 우선).
  - White (백):
    - 금수 일체 없음 (3-3, 4-4, 장목 모두 허용).
    - 5목 이상(5, 6, 7목 등) 완성 시 백 승리.
- Full board inspection to provide real-time forbidden points for Black.
- Coordinate tracing for winning lines and foul moves.
- Draw detection upon full board.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Set, Tuple

BOARD_SIZE = 15

DIRECTIONS = [
    (1, 0),   # Horizontal -
    (0, 1),   # Vertical |
    (1, 1),   # Diagonal \
    (1, -1),  # Diagonal /
]


class OmokBoard:
    def __init__(self, size: int = BOARD_SIZE) -> None:
        self.size = size
        self.turn: str = "b"  # "b" (Black / 흑) or "w" (White / 백)
        self.grid: Dict[Tuple[int, int], str] = {}
        self.move_history: List[Tuple[Tuple[int, int], str]] = []
        self.winner: Optional[str] = None
        self.winning_line: Optional[List[Tuple[int, int]]] = None
        self.foul: Optional[str] = None  # '33', '44', 'overline', or None
        self.foul_player: Optional[str] = None
        self.foul_desc: Optional[str] = None

    def clone(self) -> "OmokBoard":
        new_b = OmokBoard(self.size)
        new_b.turn = self.turn
        new_b.grid = dict(self.grid)
        new_b.move_history = list(self.move_history)
        new_b.winner = self.winner
        new_b.winning_line = list(self.winning_line) if self.winning_line else None
        new_b.foul = self.foul
        new_b.foul_player = self.foul_player
        new_b.foul_desc = self.foul_desc
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

    def _get_contiguous_line(self, col: int, row: int, dc: int, dr: int, player: str) -> List[Tuple[int, int]]:
        line = [(col, row)]
        step = 1
        while True:
            c, r = col + dc * step, row + dr * step
            if self.is_valid_coord(c, r) and self.grid.get((c, r)) == player:
                line.append((c, r))
                step += 1
            else:
                break

        step = 1
        while True:
            c, r = col - dc * step, row - dr * step
            if self.is_valid_coord(c, r) and self.grid.get((c, r)) == player:
                line.append((c, r))
                step += 1
            else:
                break

        line.sort(key=lambda pt: (pt[0] * dc + pt[1] * dr))
        return line

    def check_foul_at(self, col: int, row: int, player: str = "b") -> Optional[str]:
        """Check if placing a stone at (col, row) would be a Renju foul for Black.
        Returns 'overline', '44', '33', or None.
        White never commits fouls.
        """
        if player != "b":
            return None
        if not self.is_valid_coord(col, row) or (col, row) in self.grid:
            return None

        self.grid[(col, row)] = "b"
        try:
            has_overline = False
            has_exact_five = False
            for dc, dr in DIRECTIONS:
                line = self._get_contiguous_line(col, row, dc, dr, "b")
                if len(line) > 5:
                    has_overline = True
                elif len(line) == 5:
                    has_exact_five = True

            # In Renju, 6+ is an overline foul for Black
            if has_overline:
                return "overline"

            # Exact 5 takes absolute precedence over 3-3 and 4-4 (never a foul)
            if has_exact_five:
                return None

            # Check 4-4 (Double Four)
            found_fours: Set[frozenset] = set()
            for dc, dr in DIRECTIONS:
                for offset in range(-4, 1):
                    window = [(col + (offset + i) * dc, row + (offset + i) * dr) for i in range(5)]
                    if not all(self.is_valid_coord(c, r) for c, r in window):
                        continue
                    blacks = [pt for pt in window if self.grid.get(pt) == "b"]
                    empties = [pt for pt in window if pt not in self.grid]
                    whites = [pt for pt in window if self.grid.get(pt) == "w"]
                    if len(blacks) == 4 and len(empties) == 1 and len(whites) == 0:
                        e_pt = empties[0]
                        # Filling e_pt must create an exact 5 (not overline)
                        self.grid[e_pt] = "b"
                        run_len = len(self._get_contiguous_line(e_pt[0], e_pt[1], dc, dr, "b"))
                        del self.grid[e_pt]
                        if run_len == 5:
                            four_core = frozenset(blacks)
                            found_fours.add(four_core)

            if len(found_fours) >= 2:
                return "44"

            # Check 3-3 (Double Three / Open Threes)
            found_threes: Set[frozenset] = set()
            for dc, dr in DIRECTIONS:
                for offset in range(-4, 0):
                    w6 = [(col + (offset + i) * dc, row + (offset + i) * dr) for i in range(6)]
                    if not all(self.is_valid_coord(c, r) for c, r in w6):
                        continue
                    # Ends p0 and p5 must both be empty
                    if w6[0] in self.grid or w6[5] in self.grid:
                        continue
                    mid4 = w6[1:5]
                    blacks = [pt for pt in mid4 if self.grid.get(pt) == "b"]
                    empties = [pt for pt in mid4 if pt not in self.grid]
                    whites = [pt for pt in mid4 if self.grid.get(pt) == "w"]
                    if len(blacks) == 3 and len(empties) == 1 and len(whites) == 0:
                        e_pt = empties[0]
                        # Verify that completing the open four does not immediately cause an overline at ends
                        p_before = (w6[0][0] - dc, w6[0][1] - dr)
                        p_after = (w6[5][0] + dc, w6[5][1] + dr)
                        left_no_overline = self.grid.get(p_before) != "b"
                        right_no_overline = self.grid.get(p_after) != "b"
                        if left_no_overline and right_no_overline:
                            three_core = frozenset(blacks)
                            found_threes.add(three_core)

            if len(found_threes) >= 2:
                return "33"

            return None
        finally:
            del self.grid[(col, row)]

    def get_forbidden_points(self) -> Dict[Tuple[int, int], str]:
        """Returns map of {(col, row): foul_type} for all empty cells when it's Black's turn."""
        if self.turn != "b" or self.winner:
            return {}
        forbidden = {}
        for c in range(self.size):
            for r in range(self.size):
                if (c, r) not in self.grid:
                    foul = self.check_foul_at(c, r, "b")
                    if foul:
                        forbidden[(c, r)] = foul
        return forbidden

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

        is_draw = False

        if player == "w":
            # White victory condition: 5 or more stones in a row (no fouls)
            for dc, dr in DIRECTIONS:
                line = self._get_contiguous_line(col, row, dc, dr, "w")
                if len(line) >= 5:
                    self.winner = "w"
                    self.winning_line = line
                    break
        else:
            # Black Renju judge
            has_overline = False
            best_win_line: Optional[List[Tuple[int, int]]] = None

            for dc, dr in DIRECTIONS:
                line = self._get_contiguous_line(col, row, dc, dr, "b")
                if len(line) > 5:
                    has_overline = True
                elif len(line) == 5 and not best_win_line:
                    best_win_line = line

            if has_overline:
                # Black Overline Foul Loss (장목 금수패)
                self.winner = "w"
                self.foul = "overline"
                self.foul_player = "b"
                self.foul_desc = "흑(黑) 장목(6목 이상) 금수 착수로 인한 백(白) 승리 (금수패)"
            elif best_win_line:
                # Black exact 5 victory (takes precedence over 3-3 and 4-4)
                self.winner = "b"
                self.winning_line = best_win_line
            else:
                # Check 4-4 Foul
                found_fours: Set[frozenset] = set()
                for dc, dr in DIRECTIONS:
                    for offset in range(-4, 1):
                        window = [(col + (offset + i) * dc, row + (offset + i) * dr) for i in range(5)]
                        if not all(self.is_valid_coord(c, r) for c, r in window):
                            continue
                        blacks = [pt for pt in window if self.grid.get(pt) == "b"]
                        empties = [pt for pt in window if pt not in self.grid]
                        whites = [pt for pt in window if self.grid.get(pt) == "w"]
                        if len(blacks) == 4 and len(empties) == 1 and len(whites) == 0:
                            e_pt = empties[0]
                            self.grid[e_pt] = "b"
                            run_len = len(self._get_contiguous_line(e_pt[0], e_pt[1], dc, dr, "b"))
                            del self.grid[e_pt]
                            if run_len == 5:
                                found_fours.add(frozenset(blacks))

                if len(found_fours) >= 2:
                    # Black 4-4 Foul Loss (사사 금수패)
                    self.winner = "w"
                    self.foul = "44"
                    self.foul_player = "b"
                    self.foul_desc = "흑(黑) 4-4(사사) 금수 착수로 인한 백(白) 승리 (금수패)"
                else:
                    # Check 3-3 Foul
                    found_threes: Set[frozenset] = set()
                    for dc, dr in DIRECTIONS:
                        for offset in range(-4, 0):
                            w6 = [(col + (offset + i) * dc, row + (offset + i) * dr) for i in range(6)]
                            if not all(self.is_valid_coord(c, r) for c, r in w6):
                                continue
                            if w6[0] in self.grid or w6[5] in self.grid:
                                continue
                            mid4 = w6[1:5]
                            blacks = [pt for pt in mid4 if self.grid.get(pt) == "b"]
                            empties = [pt for pt in mid4 if pt not in self.grid]
                            whites = [pt for pt in mid4 if self.grid.get(pt) == "w"]
                            if len(blacks) == 3 and len(empties) == 1 and len(whites) == 0:
                                p_before = (w6[0][0] - dc, w6[0][1] - dr)
                                p_after = (w6[5][0] + dc, w6[5][1] + dr)
                                left_no_overline = self.grid.get(p_before) != "b"
                                right_no_overline = self.grid.get(p_after) != "b"
                                if left_no_overline and right_no_overline:
                                    found_threes.add(frozenset(blacks))

                    if len(found_threes) >= 2:
                        # Black 3-3 Foul Loss (삼삼 금수패)
                        self.winner = "w"
                        self.foul = "33"
                        self.foul_player = "b"
                        self.foul_desc = "흑(黑) 3-3(삼삼) 금수 착수로 인한 백(白) 승리 (금수패)"

        # Draw condition
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
            "foul": self.foul,
            "foul_player": self.foul_player,
            "foul_desc": self.foul_desc,
            "is_draw": is_draw,
            "move_number": len(self.move_history),
        }

    def to_dict(self) -> Dict[str, any]:
        stones = []
        for (c, r), color in self.grid.items():
            stones.append({"col": c, "row": r, "color": color})

        forbidden_points = []
        if not self.winner and self.turn == "b":
            for (c, r), f_type in self.get_forbidden_points().items():
                forbidden_points.append({"col": c, "row": r, "type": f_type})

        return {
            "size": self.size,
            "turn": self.turn,
            "stones": stones,
            "last_move": self.move_history[-1] if self.move_history else None,
            "move_count": len(self.move_history),
            "winner": self.winner,
            "winning_line": self.winning_line,
            "foul": self.foul,
            "foul_player": self.foul_player,
            "foul_desc": self.foul_desc,
            "forbidden_points": forbidden_points,
        }

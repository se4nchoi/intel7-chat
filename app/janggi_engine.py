"""Pure Python Korean Chess (Janggi - 장기) Rules Engine.

Compliant with Korea Janggi Association (대한장기협회) rules:
- 9 files (0..8) x 10 ranks (0..9) = 90 intersections.
- 4 Starting Formations: wonangma, yangwima, oenma, oreunma.
- Myeok (멱) path obstruction for Horse (馬) and Elephant (象).
- Cannon (包) jump & capture restrictions (cannot bridge or capture cannon).
- Palace diagonals for King, Guard, Chariot, and Soldiers.
- Check (장군), Checkmate (외통수), Pass turn (한수 쉼), Bikjang (빅장).
- Material scoring with Han (漢) 1.5 komi (덤).
"""
from __future__ import annotations

from typing import Dict, List, Optional, Set, Tuple

PIECE_POINTS = {
    "R": 13.0, "r": 13.0,  # 차 (Chariot)
    "C": 7.0,  "c": 7.0,   # 포 (Cannon)
    "N": 5.0,  "n": 5.0,   # 마 (Horse)
    "B": 3.0,  "b": 3.0,   # 상 (Elephant)
    "A": 3.0,  "a": 3.0,   # 사 (Guard)
    "P": 2.0,  "p": 2.0,   # 졸 / 병 (Soldier)
    "K": 0.0,  "k": 0.0,   # 궁 (King)
}

PIECE_NAMES_KR = {
    "K": "楚(궁)", "R": "車(차)", "C": "包(포)", "N": "馬(마)", "B": "象(상)", "A": "士(사)", "P": "卒(졸)",
    "k": "漢(궁)", "r": "車(차)", "c": "包(포)", "n": "馬(마)", "b": "象(상)", "a": "士(사)", "p": "兵(병)",
}

CHO_PALACE_COORDS = {(c, r) for c in range(3, 6) for r in range(0, 3)}
HAN_PALACE_COORDS = {(c, r) for c in range(3, 6) for r in range(7, 10)}

# Diagonal segment connections inside palaces
# (c1, r1) -> set of (c2, r2)
CHO_DIAGONALS: Dict[Tuple[int, int], List[Tuple[int, int]]] = {
    (3, 0): [(4, 1)],
    (5, 0): [(4, 1)],
    (3, 2): [(4, 1)],
    (5, 2): [(4, 1)],
    (4, 1): [(3, 0), (5, 0), (3, 2), (5, 2)],
}

HAN_DIAGONALS: Dict[Tuple[int, int], List[Tuple[int, int]]] = {
    (3, 7): [(4, 8)],
    (5, 7): [(4, 8)],
    (3, 9): [(4, 8)],
    (5, 9): [(4, 8)],
    (4, 8): [(3, 7), (5, 7), (3, 9), (5, 9)],
}


class JanggiBoard:
    def __init__(self, cho_formation: str = "wonangma", han_formation: str = "wonangma") -> None:
        self.cho_formation = cho_formation
        self.han_formation = han_formation
        self.turn: str = "cho"  # "cho" (moves first) or "han"
        self.grid: Dict[Tuple[int, int], Optional[str]] = {}
        self.move_count = 0
        self.consecutive_passes = 0
        self._setup_initial_board(cho_formation, han_formation)

    def _setup_initial_board(self, cho_f: str, han_f: str) -> None:
        self.grid.clear()
        for c in range(9):
            for r in range(10):
                self.grid[(c, r)] = None

        # Formation layouts for files 1, 2, 6, 7
        formations = {
            "wonangma": ("N", "B", "B", "N"),
            "yangwima": ("B", "N", "N", "B"),
            "oenma":    ("N", "B", "N", "B"),
            "oreunma":  ("B", "N", "B", "N"),
        }

        cho_layout = formations.get(cho_f, formations["wonangma"])
        han_layout = formations.get(han_f, formations["wonangma"])

        # Cho pieces (ranks 0..3)
        self.grid[(0, 0)] = "R"
        self.grid[(1, 0)] = cho_layout[0]
        self.grid[(2, 0)] = cho_layout[1]
        self.grid[(3, 0)] = "A"
        self.grid[(5, 0)] = "A"
        self.grid[(6, 0)] = cho_layout[2]
        self.grid[(7, 0)] = cho_layout[3]
        self.grid[(8, 0)] = "R"

        self.grid[(4, 1)] = "K"
        self.grid[(1, 2)] = "C"
        self.grid[(7, 2)] = "C"

        for c in (0, 2, 4, 6, 8):
            self.grid[(c, 3)] = "P"

        # Han pieces (ranks 6..9)
        self.grid[(0, 9)] = "r"
        self.grid[(1, 9)] = han_layout[0].lower()
        self.grid[(2, 9)] = han_layout[1].lower()
        self.grid[(3, 9)] = "a"
        self.grid[(5, 9)] = "a"
        self.grid[(6, 9)] = han_layout[2].lower()
        self.grid[(7, 9)] = han_layout[3].lower()
        self.grid[(8, 9)] = "r"

        self.grid[(4, 8)] = "k"
        self.grid[(1, 7)] = "c"
        self.grid[(7, 7)] = "c"

        for c in (0, 2, 4, 6, 8):
            self.grid[(c, 6)] = "p"

    def clone(self) -> "JanggiBoard":
        new_board = JanggiBoard(self.cho_formation, self.han_formation)
        new_board.turn = self.turn
        new_board.move_count = self.move_count
        new_board.consecutive_passes = self.consecutive_passes
        new_board.grid = dict(self.grid)
        return new_board

    @staticmethod
    def is_cho(piece: str) -> bool:
        return piece.isupper()

    @staticmethod
    def is_han(piece: str) -> bool:
        return piece.islower()

    def get_piece(self, pos: Tuple[int, int]) -> Optional[str]:
        return self.grid.get(pos)

    def find_king(self, color: str) -> Optional[Tuple[int, int]]:
        target = "K" if color == "cho" else "k"
        for pos, piece in self.grid.items():
            if piece == target:
                return pos
        return None

    def _generate_pseudo_moves(self, pos: Tuple[int, int]) -> List[Tuple[int, int]]:
        piece = self.grid.get(pos)
        if not piece:
            return []

        color = "cho" if self.is_cho(piece) else "han"
        p_type = piece.upper()
        c, r = pos
        moves: List[Tuple[int, int]] = []

        def can_land(dest: Tuple[int, int]) -> bool:
            if not (0 <= dest[0] < 9 and 0 <= dest[1] < 10):
                return False
            dest_piece = self.grid.get(dest)
            if dest_piece is None:
                return True
            return (self.is_han(dest_piece) if color == "cho" else self.is_cho(dest_piece))

        # -------------------------------------------------------------
        # 1. King (K) and Guard (A): 1 step within palace
        # -------------------------------------------------------------
        if p_type in ("K", "A"):
            palace = CHO_PALACE_COORDS if color == "cho" else HAN_PALACE_COORDS
            diagonals = CHO_DIAGONALS if color == "cho" else HAN_DIAGONALS

            # Orthogonal steps
            for dc, dr in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                dest = (c + dc, r + dr)
                if dest in palace and can_land(dest):
                    moves.append(dest)

            # Diagonal steps
            for dest in diagonals.get((c, r), []):
                if dest in palace and can_land(dest):
                    moves.append(dest)

        # -------------------------------------------------------------
        # 2. Soldier (P): forward & sideways 1 step, forward diagonals in enemy palace
        # -------------------------------------------------------------
        elif p_type == "P":
            fwd = 1 if color == "cho" else -1
            # Forward
            dest = (c, r + fwd)
            if can_land(dest):
                moves.append(dest)
            # Sideways
            for dc in (-1, 1):
                dest = (c + dc, r)
                if can_land(dest):
                    moves.append(dest)

            # Enemy palace forward diagonal movement
            if color == "cho":
                if (c, r) in ((3, 7), (5, 7)):
                    if can_land((4, 8)):
                        moves.append((4, 8))
                elif (c, r) == (4, 8):
                    for dest in ((3, 9), (5, 9)):
                        if can_land(dest):
                            moves.append(dest)
            else:
                if (c, r) in ((3, 2), (5, 2)):
                    if can_land((4, 1)):
                        moves.append((4, 1))
                elif (c, r) == (4, 1):
                    for dest in ((3, 0), (5, 0)):
                        if can_land(dest):
                            moves.append(dest)

        # -------------------------------------------------------------
        # 3. Chariot (R): orthogonal rays, plus palace diagonals
        # -------------------------------------------------------------
        elif p_type == "R":
            # Orthogonal rays
            for dc, dr in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                curr_c, curr_r = c + dc, r + dr
                while 0 <= curr_c < 9 and 0 <= curr_r < 10:
                    dest = (curr_c, curr_r)
                    dest_p = self.grid.get(dest)
                    if dest_p is None:
                        moves.append(dest)
                    else:
                        if (self.is_han(dest_p) if color == "cho" else self.is_cho(dest_p)):
                            moves.append(dest)
                        break
                    curr_c += dc
                    curr_r += dr

            # Palace diagonal slides
            for palace, diagonals, center in (
                (CHO_PALACE_COORDS, CHO_DIAGONALS, (4, 1)),
                (HAN_PALACE_COORDS, HAN_DIAGONALS, (4, 8))
            ):
                if (c, r) in palace:
                    if (c, r) == center:
                        for corner in diagonals[center]:
                            if can_land(corner):
                                moves.append(corner)
                    elif (c, r) in diagonals:
                        # Corner moving to center
                        if can_land(center):
                            moves.append(center)
                        # Corner moving through center to opposite corner
                        opposite = (c + (center[0] - c) * 2, r + (center[1] - r) * 2)
                        if self.grid.get(center) is None and can_land(opposite):
                            moves.append(opposite)

        # -------------------------------------------------------------
        # 4. Cannon (C): ray jumps over exactly 1 non-cannon bridge
        # -------------------------------------------------------------
        elif p_type == "C":
            # Orthogonal jumps
            for dc, dr in ((0, 1), (0, -1), (1, 0), (-1, 0)):
                bridge_found = False
                curr_c, curr_r = c + dc, r + dr
                while 0 <= curr_c < 9 and 0 <= curr_r < 10:
                    dest = (curr_c, curr_r)
                    dest_p = self.grid.get(dest)
                    if not bridge_found:
                        if dest_p is not None:
                            # Cannons cannot jump over another cannon!
                            if dest_p.upper() == "C":
                                break
                            bridge_found = True
                    else:
                        if dest_p is None:
                            moves.append(dest)
                        else:
                            # Cannons cannot capture another cannon!
                            if dest_p.upper() != "C":
                                if (self.is_han(dest_p) if color == "cho" else self.is_cho(dest_p)):
                                    moves.append(dest)
                            break
                    curr_c += dc
                    curr_r += dr

            # Palace diagonal jumps (Corner over Center to Opposite Corner)
            for palace, diagonals, center in (
                (CHO_PALACE_COORDS, CHO_DIAGONALS, (4, 1)),
                (HAN_PALACE_COORDS, HAN_DIAGONALS, (4, 8))
            ):
                if (c, r) in diagonals and (c, r) != center:
                    center_p = self.grid.get(center)
                    if center_p and center_p.upper() != "C":
                        opposite = (c + (center[0] - c) * 2, r + (center[1] - r) * 2)
                        opp_p = self.grid.get(opposite)
                        if opp_p is None:
                            moves.append(opposite)
                        elif opp_p.upper() != "C":
                            if (self.is_han(opp_p) if color == "cho" else self.is_cho(opp_p)):
                                moves.append(opposite)

        # -------------------------------------------------------------
        # 5. Horse (N): 1 orthogonal + 1 diagonal outward (1-step myeok)
        # -------------------------------------------------------------
        elif p_type == "N":
            patterns = [
                ((0, 1), [(-1, 1), (1, 1)]),    # Up
                ((0, -1), [(-1, -1), (1, -1)]), # Down
                ((-1, 0), [(-1, -1), (-1, 1)]), # Left
                ((1, 0), [(1, -1), (1, 1)]),    # Right
            ]
            for (step_c, step_r), diagonals in patterns:
                myeok = (c + step_c, r + step_r)
                if not (0 <= myeok[0] < 9 and 0 <= myeok[1] < 10):
                    continue
                if self.grid.get(myeok) is None:  # Myeok is open
                    for diag_c, diag_r in diagonals:
                        dest = (myeok[0] + diag_c, myeok[1] + diag_r)
                        if can_land(dest):
                            moves.append(dest)

        # -------------------------------------------------------------
        # 6. Elephant (B): 1 orthogonal + 2 diagonal outward (2-step myeok)
        # -------------------------------------------------------------
        elif p_type == "B":
            patterns = [
                ((0, 1), [(-1, 1), (1, 1)]),    # Up
                ((0, -1), [(-1, -1), (1, -1)]), # Down
                ((-1, 0), [(-1, -1), (-1, 1)]), # Left
                ((1, 0), [(1, -1), (1, 1)]),    # Right
            ]
            for (step_c, step_r), diagonals in patterns:
                myeok1 = (c + step_c, r + step_r)
                if not (0 <= myeok1[0] < 9 and 0 <= myeok1[1] < 10):
                    continue
                if self.grid.get(myeok1) is None:  # 1st myeok open
                    for diag_c, diag_r in diagonals:
                        myeok2 = (myeok1[0] + diag_c, myeok1[1] + diag_r)
                        if not (0 <= myeok2[0] < 9 and 0 <= myeok2[1] < 10):
                            continue
                        if self.grid.get(myeok2) is None:  # 2nd myeok open
                            dest = (myeok2[0] + diag_c, myeok2[1] + diag_r)
                            if can_land(dest):
                                moves.append(dest)

        return moves

    def is_in_check(self, color: str) -> bool:
        king_pos = self.find_king(color)
        if not king_pos:
            return False

        opp_color = "han" if color == "cho" else "cho"
        for pos, piece in self.grid.items():
            if piece and ((self.is_cho(piece) if opp_color == "cho" else self.is_han(piece))):
                if king_pos in self._generate_pseudo_moves(pos):
                    return True
        return False

    def get_legal_moves(self, color: Optional[str] = None) -> List[Tuple[Tuple[int, int], Tuple[int, int]]]:
        if color is None:
            color = self.turn

        legal: List[Tuple[Tuple[int, int], Tuple[int, int]]] = []
        for pos, piece in self.grid.items():
            if not piece:
                continue
            if (self.is_cho(piece) if color == "cho" else self.is_han(piece)):
                for dest in self._generate_pseudo_moves(pos):
                    # Test move on a temporary board to ensure King is not in check
                    temp = self.clone()
                    temp._execute_raw_move(pos, dest)
                    if not temp.is_in_check(color):
                        legal.append((pos, dest))
        return legal

    def _execute_raw_move(self, from_pos: Tuple[int, int], to_pos: Tuple[int, int]) -> Optional[str]:
        captured = self.grid.get(to_pos)
        self.grid[to_pos] = self.grid.get(from_pos)
        self.grid[from_pos] = None
        return captured

    def push_move(self, from_pos: Tuple[int, int], to_pos: Tuple[int, int]) -> Dict[str, any]:
        """Execute a move for the current turn player. Raises ValueError if illegal."""
        piece = self.grid.get(from_pos)
        if not piece:
            raise ValueError("출발 위치에 기물이 없습니다.")

        expected_cho = (self.turn == "cho")
        if self.is_cho(piece) != expected_cho:
            raise ValueError("자신의 턴 기물만 움직일 수 있습니다.")

        legal_moves = self.get_legal_moves(self.turn)
        if (from_pos, to_pos) not in legal_moves:
            raise ValueError("둘 수 없는 수입니다.")

        captured = self._execute_raw_move(from_pos, to_pos)
        self.consecutive_passes = 0
        self.move_count += 1
        prev_turn = self.turn
        self.turn = "han" if self.turn == "cho" else "cho"

        in_check = self.is_in_check(self.turn)
        is_mate = in_check and len(self.get_legal_moves(self.turn)) == 0

        notation = f"{piece} {from_pos[0]}{from_pos[1]}→{to_pos[0]}{to_pos[1]}"
        if captured:
            notation += f" 잡음:{captured}"
        if is_mate:
            notation += " (외통)"
        elif in_check:
            notation += " (장군)"

        return {
            "piece": piece,
            "from": from_pos,
            "to": to_pos,
            "captured": captured,
            "in_check": in_check,
            "is_mate": is_mate,
            "notation": notation,
            "turn": self.turn,
        }

    def pass_turn(self) -> Dict[str, any]:
        """Player passes turn (한수 쉼). Allowed if not currently in check."""
        if self.is_in_check(self.turn):
            raise ValueError("장군(Check) 상태에서는 한수 쉼을 할 수 없습니다.")

        self.consecutive_passes += 1
        self.move_count += 1
        prev_turn = self.turn
        self.turn = "han" if self.turn == "cho" else "cho"

        double_pass = (self.consecutive_passes >= 2)
        return {
            "pass": True,
            "player": prev_turn,
            "double_pass": double_pass,
            "turn": self.turn,
            "notation": f"{'초' if prev_turn == 'cho' else '한'} 한수 쉼",
        }

    def is_bikjang(self) -> bool:
        """Check if both Kings directly face each other along the same column with no pieces in between."""
        cho_k = self.find_king("cho")
        han_k = self.find_king("han")
        if not cho_k or not han_k:
            return False
        if cho_k[0] != han_k[0]:
            return False

        col = cho_k[0]
        min_r = min(cho_k[1], han_k[1])
        max_r = max(cho_k[1], han_k[1])
        for r in range(min_r + 1, max_r):
            if self.grid.get((col, r)) is not None:
                return False
        return True

    def calculate_score(self) -> Dict[str, float]:
        """Calculates material score for Cho and Han (Han receives 1.5 komi / 덤)."""
        cho_pts = 0.0
        han_pts = 1.5  # 덤 (Komi)

        for pos, piece in self.grid.items():
            if not piece:
                continue
            pts = PIECE_POINTS.get(piece, 0.0)
            if self.is_cho(piece):
                cho_pts += pts
            else:
                han_pts += pts

        return {
            "cho": round(cho_pts, 1),
            "han": round(han_pts, 1),
            "diff": round(abs(cho_pts - han_pts), 1),
            "leading": "cho" if cho_pts > han_pts else "han",
        }

    def to_fen(self) -> str:
        """Compact string representation of the board."""
        rows = []
        for r in range(9, -1, -1):
            empty_count = 0
            row_str = ""
            for c in range(9):
                piece = self.grid.get((c, r))
                if piece is None:
                    empty_count += 1
                else:
                    if empty_count > 0:
                        row_str += str(empty_count)
                        empty_count = 0
                    row_str += piece
            if empty_count > 0:
                row_str += str(empty_count)
            rows.append(row_str)
        return f"{'/'.join(rows)} {self.turn[0]} {self.move_count}"

    def to_dict(self) -> Dict[str, any]:
        """JSON-serializable representation of board."""
        pieces = []
        for (c, r), piece in self.grid.items():
            if piece:
                pieces.append({
                    "col": c,
                    "row": r,
                    "piece": piece,
                    "color": "cho" if self.is_cho(piece) else "han",
                    "name": PIECE_NAMES_KR.get(piece, piece),
                })
        legal_moves = self.get_legal_moves(self.turn)
        return {
            "turn": self.turn,
            "move_count": self.move_count,
            "pieces": pieces,
            "score": self.calculate_score(),
            "in_check": self.is_in_check(self.turn),
            "bikjang": self.is_bikjang(),
            "consecutive_passes": self.consecutive_passes,
            "legal_moves": [[[f[0], f[1]], [t[0], t[1]]] for f, t in legal_moves],
        }

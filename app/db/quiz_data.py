"""Default educational quiz seed datasets and subject metadata."""
from __future__ import annotations

from typing import Any, Dict, List

DEFAULT_SAMPLE_QUIZZES: List[Dict[str, Any]] = [
    {
        "category": "PLC",
        "difficulty": "medium",
        "question_type": "ladder_input",
        "question": "자기유지(Self-holding) 회로에서 출력 코일 Y0이 ON된 후 기동 스위치 X0을 떼어도 계속 전원이 공급되도록 X0과 병렬(OR)로 연결해야 하는 접점 디바이스 번호는 무엇인가?",
        "image_filename": "",
        "options": None,
        "correct_answers": ["Y0", "Y00", "Y0 a접점", "Y0 A접점", "Y000", "LD Y0", "OR Y0"],
        "hint": "출력 코일과 동일한 디바이스 번호의 a접점을 병렬로 연결합니다.",
        "explanation": "기동 스위치(X0)와 출력 릴레이의 a접점(Y0)을 병렬 연결하면, 스위치가 복귀해도 출력 Y0의 a접점이 닫혀 있어 전원이 유지됩니다.",
        "source_ref": "PLC 시퀀스 실습 4강 - 자기유지 회로 p.12"
    },
    {
        "category": "PLC",
        "difficulty": "easy",
        "question_type": "multiple_choice",
        "question": "PLC 래더 다이어그램에서 두 개 이상의 a접점을 직렬로 연결할 때 사용하는 기본 명령어는 무엇인가?",
        "options": ["1. AND", "2. OR", "3. OUT", "4. SET"],
        "correct_answers": ["1", "1번", "AND", "1. AND"],
        "hint": "직렬 접속에는 논리곱(Logical AND) 연산 명령어를 사용합니다.",
        "explanation": "직렬 접속에는 AND(a접점 직렬) 또는 ANI/AND NOT(b접점 직렬) 명령어를 사용합니다.",
        "source_ref": "PLC 기초 명령어 편람 p.5"
    },
    {
        "category": "PLC",
        "difficulty": "medium",
        "question_type": "short_answer",
        "question": "기본 단위가 100ms인 PLC 타이머(Timer)에서 3초를 지연 동작시키기 위해 입력해야 하는 설정값(K값)은 얼마인가?",
        "image_filename": "",
        "options": None,
        "correct_answers": ["30", "K30", "K 30"],
        "hint": "100ms는 0.1초입니다. 목표 시간(3초)을 0.1초로 나누어 보세요.",
        "explanation": "100ms(0.1초) 단위 타이머에서 3초는 3.0 / 0.1 = 30이므로 K30을 설정합니다.",
        "source_ref": "PLC 타이머/카운터 응용 p.23"
    },
    {
        "category": "전기",
        "difficulty": "medium",
        "question_type": "multiple_choice",
        "question": "3상 유도전동기의 회전 방향을 역회전으로 바꾸기 위한 가장 올바른 결선 변경 방법은?",
        "options": ["1. 3상 중 임의의 2선의 접속을 서로 바꾼다", "2. 3선의 접속을 모두 일제히 바꾼다", "3. 접지선(E)의 위치를 전원선으로 바꾼다", "4. 공급 전압을 2배로 승압한다"],
        "correct_answers": ["1", "1번", "1. 3상 중 임의의 2선의 접속을 서로 바꾼다"],
        "hint": "3개 선 중 임의의 2개 선 위치를 맞바꾸면 회전자계 방향이 반전됩니다.",
        "explanation": "3상 교류 전동기(R, S, T)는 3상 중 임의의 두 선의 접속을 서로 바꾸면 회전자계의 방향이 반대가 되어 전동기가 역회전합니다.",
        "source_ref": "Q-Net 전기 분야 출제범위 참고 재작성"
    },
    {
        "category": "PLC",
        "difficulty": "hard",
        "question_type": "short_answer",
        "question": "정회전 코일과 역회전 코일이 동시에 투입되어 선간 단락 사고가 발생하는 것을 막기 위해, 상대방 코일 전단에 자신의 b접점을 직렬 연결하는 제어 회로의 명칭은?",
        "image_filename": "",
        "options": None,
        "correct_answers": ["인터록", "인터록 회로", "인터록회로", "INTERLOCK", "Interlock"],
        "hint": "상대방의 동작을 서로 잠근다는 의미의 영단어(Inter-lock)입니다.",
        "explanation": "두 개의 상반된 동작이 동시에 일어나는 것을 방지하기 위해 상대 회로를 잠그는 회로를 인터록(Interlock) 회로라고 합니다.",
        "source_ref": "시퀀스 제어 핵심이론 p.31"
    },
    {
        "category": "전자",
        "difficulty": "easy",
        "question_type": "multiple_choice",
        "question": "2진수 10110(2)을 10진수로 올바르게 변환한 값은?",
        "options": ["1. 18", "2. 20", "3. 22", "4. 24"],
        "correct_answers": ["3", "3번", "22", "3. 22"],
        "hint": "각 자리수의 가중치(16, 8, 4, 2, 1) 중 1인 자리만 더해보세요: 16 + 4 + 2",
        "explanation": "16*1 + 8*0 + 4*1 + 2*1 + 1*0 = 16 + 4 + 2 = 22 입니다.",
        "source_ref": "Q-Net 전자·디지털공학 출제범위 참고 재작성"
    },
    {
        "category": "PLC",
        "difficulty": "medium",
        "question_type": "ladder_input",
        "question": "미쓰비시(MELSEC) PLC 래더 프로그래밍에서 모선(Bus bar)에서 b접점을 시작할 때 사용하는 니모닉(Mnemonic) 명령어는 무엇인가?",
        "image_filename": "",
        "options": None,
        "correct_answers": ["LDI", "LD NOT", "LDNOT", "LD I"],
        "hint": "Load Inverse의 약자 3글자입니다.",
        "explanation": "모선에서 a접점 시작은 LD(Load), b접점 시작은 LDI(Load Inverse) 명령어를 사용합니다.",
        "source_ref": "MELSEC 명령어 일람표"
    },
    {
        "category": "자동화설비",
        "difficulty": "medium",
        "question_type": "multiple_choice",
        "question": "공압 회로에서 방향제어밸브의 주된 역할은 무엇인가?",
        "options": ["1. 압축공기의 흐름 방향을 전환한다", "2. 전압을 정류한다", "3. 회전수를 측정한다", "4. 절연저항을 높인다"],
        "correct_answers": ["1", "1번", "압축공기의 흐름 방향을 전환한다"],
        "hint": "실린더의 전진·후진을 제어합니다.",
        "explanation": "방향제어밸브는 공급·배기 경로를 바꿔 공압 액추에이터의 움직임을 제어합니다.",
        "source_ref": "Q-Net 자동화설비산업기사 공개문제(공압) 범위 참고 재작성"
    },
    {
        "category": "자동화설비",
        "difficulty": "hard",
        "question_type": "multiple_choice",
        "question": "비상정지 회로에서 단선이 발생해도 안전 정지가 되도록 일반적으로 사용하는 접점은?",
        "options": ["1. 정상 시 닫힌 b접점", "2. 정상 시 열린 a접점", "3. 아날로그 출력", "4. 타이머 출력만 사용"],
        "correct_answers": ["1", "1번", "정상 시 닫힌 b접점"],
        "hint": "정상 상태에서 닫혀 있어야 단선 시 회로가 열립니다.",
        "explanation": "정상 시 닫힌 접점을 직렬로 사용하면 비상 입력이나 단선 때 회로가 열려 안전 정지합니다.",
        "source_ref": "Q-Net 자동화설비산업기사 공개문제(안전제어) 범위 참고 재작성"
    }
]


def _position_mc(code: str, question: str, answer: str, distractors: List[str], explanation: str) -> Dict[str, Any]:
    values = [answer, *distractors[:3]]
    offset = int(code) % 4
    options = values[offset:] + values[:offset]
    correct_no = options.index(answer) + 1
    return {
        "category": "PLC",
        "difficulty": "easy",
        "question_type": "multiple_choice",
        "question": question,
        "options": [f"{i}. {value}" for i, value in enumerate(options, 1)],
        "correct_answers": [str(correct_no), answer, f"{correct_no}. {answer}"],
        "hint": f"위치결정 모듈 오류 코드 {code}의 명칭을 확인하세요.",
        "explanation": explanation,
        "source_ref": "위치결정모듈 사용자 매뉴얼 MR-J2S/QD75, 부록 오류 코드 및 버퍼 메모리 표 참고 재작성",
    }


POSITION_MODULE_SAMPLE_QUIZZES: List[Dict[str, Any]] = [
    _position_mc("507", "위치결정 모듈 오류 코드 507의 의미는?", "소프트웨어 스트로크 리미트(+)", ["소프트웨어 스트로크 리미트(-)", "지령속도 없음", "원점복귀 방식 에러"], "정방향(+) 소프트웨어 스트로크 리미트 초과를 나타냅니다."),
    _position_mc("508", "오류 코드 508이 발생했을 때 가장 가까운 설명은?", "소프트웨어 스트로크 리미트(-)", ["소프트웨어 스트로크 리미트(+)", "PLC CPU 에러", "반경범위 외"], "역방향(-) 소프트웨어 스트로크 리미트 초과입니다."),
    _position_mc("502", "오류 코드 502는 무엇을 의미하는가?", "데이터 No. 부정", ["축 Busy", "JOG 속도 제한값 에러", "원점 어드레스 설정 에러"], "위치결정 데이터 번호가 허용 범위를 벗어난 경우입니다."),
    _position_mc("503", "오류 코드 503의 원인은?", "지령속도 없음", ["직선 이동량 범위 외", "중심점 설정 에러", "M코드 On 신호 On기동"], "위치결정 기동에 필요한 지령속도가 설정되지 않은 상태입니다."),
    _position_mc("504", "오류 코드 504가 나타내는 것은?", "직선 이동량 범위 외", ["원호보간 불가", "단위그룹 불일치", "축 에러 리셋"], "직선 이동량이 모듈에서 허용하는 범위를 벗어난 경우입니다."),
    _position_mc("514", "오류 코드 514의 의미는?", "현재값 변경범위 외", ["현재값 변경불가", "속도 제한값 범위 외", "조건 데이터 에러"], "현재값 변경에 사용한 어드레스가 허용 범위를 벗어난 경우입니다."),
    _position_mc("518", "오류 코드 518은 어떤 설정과 관련되는가?", "운전패턴 범위 외", ["회전방향 설정 에러", "원점복귀 속도 에러", "보간모드 에러"], "설정한 운전 패턴 값이 허용 범위 밖일 때 발생합니다."),
    _position_mc("519", "오류 코드 519는 어떤 상태에서 발생하는가?", "상대축 Busy 보간", ["PLC Ready Off", "플래시 ROM 쓰기 에러", "반경범위 외"], "상대축이 운전 중인데 보간 기동을 지령한 경우입니다."),
    _position_mc("520", "오류 코드 520의 설명으로 옳은 것은?", "단위그룹 불일치", ["데이터 No. 부정", "원점복귀 방향 에러", "M코드 On 타이밍 에러"], "보간 속도 지정 방법과 합성 속도 등의 단위 그룹 설정이 맞지 않습니다."),
    _position_mc("521", "오류 코드 521은 무엇을 뜻하는가?", "보간기술 명령부정", ["지령속도 설정 에러", "PLC Ready Off 기동", "현재값 갱신요구 에러"], "보간 제어에 사용한 명령 조합이 올바르지 않은 경우입니다."),
    _position_mc("522", "오류 코드 522의 의미는?", "지령속도 설정 에러", ["보간모드 에러", "직선 이동량 범위 외", "JOG가속시간 선택 에러"], "보간 또는 위치결정에 지정한 지령속도 설정이 올바르지 않습니다."),
    _position_mc("523", "오류 코드 523은 어떤 에러인가?", "보간모드 에러", ["단위 설정 범위 외", "축 에러 번호 부정", "원호보간 오차 허용범위 외"], "보간 모드와 관련된 설정 또는 운전 조건이 맞지 않습니다."),
    _position_mc("530", "오류 코드 530의 의미는?", "어드레스 범위 외", ["속도 제한값 범위 외", "원점복귀 리트라이 에러", "데이터 No. 부정"], "이동 목표 어드레스가 허용 범위를 벗어난 경우입니다."),
    _position_mc("536", "오류 코드 536이 발생하는 조건은?", "M코드 On 신호 On기동", ["PLC Ready Off 기동", "준비완료 Off 기동", "동시기동 불가"], "M코드 On 신호가 이미 On인 상태에서 위치결정을 기동한 경우입니다."),
    _position_mc("538", "오류 코드 538의 의미는?", "준비완료 Off 기동", ["PLC Ready Off 기동", "M코드 On 신호 On기동", "원점복귀 방식 에러"], "QD75의 준비완료 신호가 Off인 상태에서 기동한 경우입니다."),
    _position_mc("1517", "1축 버퍼 메모리 K1517이 나타내는 데이터는?", "인칭 이동량", ["JOG 속도", "JOG 가속시간", "축 에러 번호"], "K1517(축별 1517)은 인칭 이동량을 설정·전달하는 버퍼 메모리입니다."),
]

QUIZ_EXPERTISES = (
    "PLC", "전기", "전자",
    "전기기능사", "전기기사", "산업안전기사", "로봇 Python",
)


def normalize_quiz_expertise(value: Any) -> str:
    """Validate a suggested or user-defined quiz subject name."""
    expertise = " ".join(str(value or "").split())
    if not 2 <= len(expertise) <= 40:
        raise ValueError("주제는 2~40자로 입력해 주세요.")
    if any(ord(char) < 32 or ord(char) == 127 for char in expertise):
        raise ValueError("주제에는 제어문자를 사용할 수 없습니다.")
    return expertise


QUIZ_SUBJECT_TITLES = {
    "PLC": ("⚡", "PLC조교", "래더고인물", "PLC의 신"),
    "전기": ("🔌", "전기조교", "전기고인물", "전기의 신"),
    "전자": ("🔋", "전자조교", "전자고인물", "전자의 신"),
    "전기기사": ("📐", "기사필기합격기원", "기사실기한방퍄수", "전기기사"),
    "산업안전기사": ("⛑️", "안전한사람", "산업안전고인물", "산업안전의 신"),
    "로봇 Python": ("🤖", "로봇조교", "파이썬고인물", "로봇의 신"),
    "상식": ("🌏", "몰상식하진않음", "상식적인사람", "상식의 신"),
    "넌센스퀴즈": ("💡", "센스있는사람", "틀을깨는자", "센스의 신"),
    "영어": ("💯", "영어초보", "일타강사가능", "원어민"),
}

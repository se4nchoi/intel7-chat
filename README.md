# Classroom Chat

교실 내부 LAN 전용 실시간 채팅 웹 애플리케이션입니다. 공개 채팅, 접속자 목록, 1:1 DM, Markdown 메시지와 파일 공유를 지원합니다.

## 1. 설치

### 사전 조건

- Python 3.10 이상
- 호스트와 학생 PC가 같은 신뢰할 수 있는 LAN에 연결되어 있어야 합니다.
- 이 프로젝트는 공개 인터넷에 배포하지 않습니다.

```powershell
cd C:\path\to\intel7-chat
python -m venv .venv
.venv\Scripts\activate
python -m pip install --upgrade pip
pip install -r requirements.txt
```

Linux/WSL에서는 가상환경 활성화 명령이 `source .venv/bin/activate`입니다.

## 2. 안전 설정으로 실행

저장소에 포함된 실행 파일을 사용합니다.

```powershell
python run.py
```

`run.py`는 다음 제한을 Uvicorn에 적용합니다.

- 모든 IPv4 인터페이스의 TCP 8000 포트에서 수신
- WebSocket 원본 프레임 최대 8 KiB
- WebSocket 대기열 최대 16개
- WebSocket 압축 비활성화
- HTTP/WebSocket 동시 작업 최대 60개
- 서버 버전 헤더 비활성화

호스트 PC에서는 `http://localhost:8000`으로 접속합니다.

## 3. 다른 PC에서 접속

호스트의 IPv4 주소를 확인합니다.

```powershell
ipconfig
```

예를 들어 주소가 `192.168.1.42`이면 같은 LAN의 학생 PC에서 다음 주소를 엽니다.

```text
http://192.168.1.42:8000
```

### IP 대신 PC 이름 사용

호스트에서 다음 명령으로 컴퓨터 이름을 확인합니다.

```powershell
hostname
```

결과가 `CLASSROOM-PC`이면 학생 PC에서 다음 주소를 먼저 시도합니다.

```text
http://CLASSROOM-PC:8000
```

학생 PC에서 `ping CLASSROOM-PC`가 실패하면 이름 확인이 지원되지 않는 네트워크입니다. 안정적인 순서는 다음과 같습니다.

1. 공유기/DHCP에서 호스트 IP를 예약합니다.
2. 학교 또는 공유기의 로컬 DNS에 `chat.example.internal` 같은 이름을 등록합니다. 점(`.`)이 포함된 사용자 지정 이름은 실행 전에 허용 목록에 추가합니다.

```powershell
$env:CLASSROOM_ALLOWED_HOSTS="chat.example.internal"
python run.py
```

여러 이름은 쉼표로 구분합니다. 사설 IP, `CLASSROOM-PC` 같은 단일 이름, `localhost`, `*.local` 이름은 자동으로 허용됩니다.

3. DNS를 변경할 수 없고 PC 수가 적으면 각 학생 PC의 관리자 권한 hosts 파일에 아래처럼 추가합니다.

```text
192.168.1.42  classchat
```

그 후 `http://classchat:8000`으로 접속할 수 있습니다. hosts 방식을 사용할 경우 호스트 IP가 바뀌면 모든 PC의 항목도 수정해야 합니다.

### WSL2에서 실행하는 경우

가장 단순한 교실 운영 방법은 Windows Python에서 `python run.py`를 실행하는 것입니다. WSL2에서 실행한다면 Windows 11 22H2 이상의 mirrored networking을 사용하거나 WSL 포트 전달을 별도로 구성해야 LAN PC에서 접근할 수 있습니다. 실제 수업 전에 반드시 다른 물리 PC에서 접속을 시험합니다.

## 4. Windows Defender 방화벽

관리자 PowerShell에서 Private 네트워크와 로컬 서브넷에만 8000 포트를 허용합니다.

```powershell
New-NetFirewallRule `
  -DisplayName "Classroom Chat" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 8000 `
  -Action Allow `
  -Profile Private `
  -RemoteAddress LocalSubnet
```

Windows 네트워크 프로필이 `Private`인지도 확인합니다. 포트 포워딩이나 Public 프로필 허용 규칙은 만들지 않습니다.

## 5. 적용된 안전장치

- WebSocket `Origin`이 접속한 페이지의 호스트와 정확히 일치해야 합니다.
- 최대 50명의 WebSocket 클라이언트와 IP당 최대 3개 연결을 허용합니다.
- IP당 10초에 최대 30개 WebSocket 메시지를 허용합니다.
- 앱 내부에서도 원본 메시지를 8 KiB로 제한하고 채팅 내용은 2,000자로 제한합니다.
- 파일은 기본적으로 개당 50 MB, IP당 보관 중 100 MB, 서버 전체 2 GB로 제한하고 IP당 업로드 속도를 제한합니다.
- 실행 또는 브라우저 활성 콘텐츠 형식은 차단합니다. 그 외 `.gxw`, `.gwx`, `.gwz`, PDF, PPTX 및 알려지지 않은 수업용 형식은 허용합니다.
- 이미지 미리 보기는 실제 파일 시그니처가 확인된 PNG, JPEG, GIF, WebP에만 제공하며 다른 파일은 다운로드로 처리합니다.
- API 문서(`/docs`, `/redoc`, `/openapi.json`)는 비활성화되어 있습니다.
- CSP, clickjacking 방지, MIME sniffing 방지 및 referrer 제한 헤더를 보냅니다.
- SQL은 parameterized query를 사용하고, 브라우저는 메시지를 HTML이 아닌 텍스트로 표시합니다.
- 제한 거부, 비정상 크기, 연결/해제 이벤트는 서버 로그에 남지만 DM 내용은 기록하지 않습니다.

이 앱은 의도적으로 계정 인증을 제공하지 않습니다. 닉네임은 신원이 아니며 다른 사람이 같은 이름을 나중에 사용할 수 있습니다.

## 6. IP 표시와 보관

공개 메시지, DM, DM 제목, 접속자 목록에는 IPv4의 마지막 두 옥텟만 표시됩니다.

```text
Ronaldo (72.50)
```

전체 IP, 공개 메시지, 파일 메타데이터는 호스트의 `data/chat.db`에 저장되고 파일 본문은 `data/uploads/`에 보관됩니다. 메시지와 파일은 10시간 뒤 삭제됩니다. DM 내용은 데이터베이스에 저장하지 않습니다. IP는 수업 중 문제 사용을 조사하기 위한 단서일 뿐 확정적인 신원 증명은 아닙니다.

## 7. 채팅과 파일 공유

- 입력창은 내용에 맞춰 자동으로 늘어나며 `Shift+Enter`로 줄바꿈하고 `Enter`로 전송합니다.
- 안전한 Markdown(강조, 취소선, 코드, 링크, 목록, 인용문)을 지원합니다. HTML과 외부 이미지는 렌더링하지 않습니다.
- 메시지 답장, 텍스트 복사, 대화별 임시 초안 저장을 지원합니다.
- 클립 버튼, 드래그 앤 드롭 또는 클립보드 붙여넣기로 파일을 추가할 수 있습니다.
- `.gxw` 같은 비표준 수업 파일도 공유할 수 있지만 프로그램 파일과 HTML/스크립트 계열은 거부됩니다.
- 파일은 서버에서 실행하거나 압축 해제하지 않습니다. 신뢰할 수 없는 파일은 열지 말고, 수업에 필요한 자료만 공유합니다.

## 8. 테스트와 의존성 감사

개발 및 감사 도구를 설치합니다.

```powershell
pip install -r requirements-dev.txt
```

테스트를 실행합니다.

```powershell
python -m pytest -q
```

설치된 의존성의 알려진 취약점을 확인합니다. 이 명령은 인터넷 접속이 필요합니다.

```powershell
python -m pip_audit -r requirements.txt
```

수업 전에는 다음을 추가로 확인합니다.

1. 다른 물리 PC에서 호스트 이름과 IP 주소로 접속
2. 22명 이상 동시 접속
3. 공개 채팅과 DM 전송
4. 서버를 재시작한 뒤 최근 공개 메시지 복원
5. 수업 종료 후 서버 프로세스 종료

## 9. 주요 설정

| 항목 | 파일 | 변수 |
|------|------|------|
| 서비스 이름 | `app/main.py` | `SERVICE_NAME` |
| 메시지/IP 보관 시간 | `app/database.py` | `MESSAGE_RETENTION_HOURS` |
| 닉네임 최대 길이 | `app/main.py` | `MAX_NICKNAME_LEN` |
| 메시지 최대 길이 | `app/main.py` | `MAX_CONTENT_LEN` |
| 총 접속 제한 | `app/main.py` | `MAX_CONNECTIONS_TOTAL` |
| IP당 접속 제한 | `app/main.py` | `MAX_CONNECTIONS_PER_IP` |
| 메시지 속도 제한 | `app/main.py` | `RATE_LIMIT_MESSAGES`, `RATE_LIMIT_WINDOW_SECONDS` |
| 파일당 최대 크기(MB) | 환경 변수 | `CLASSROOM_MAX_FILE_MB` |
| IP당 보관 한도(MB) | 환경 변수 | `CLASSROOM_MAX_IP_STORAGE_MB` |
| 전체 파일 보관 한도(MB) | 환경 변수 | `CLASSROOM_MAX_TOTAL_STORAGE_MB` |
| 파일 저장 위치 | 환경 변수 | `CLASSROOM_UPLOAD_DIR` |
| 서버 전송 계층 제한 | `run.py` | `uvicorn.run(...)` |

## 10. 프로젝트 구조

```text
intel7-chat/
├─ app/
│  ├─ main.py
│  ├─ database.py
│  ├─ templates/index.html
│  └─ static/
├─ tests/test_security.py
├─ run.py
├─ requirements.txt
├─ requirements-dev.txt
└─ README.md
```

## 보안 주의사항

- 교실 내부 LAN에서 교사가 함께 있을 때만 실행합니다.
- 공개 인터넷에 직접 노출하거나 라우터 포트 포워딩을 설정하지 않습니다.
- HTTP/WebSocket 트래픽은 암호화되지 않으므로 민감한 개인정보, 비밀번호, 비밀 자료를 입력하지 않습니다.
- 수업이 끝나면 서버를 종료합니다.

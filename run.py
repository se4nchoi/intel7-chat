"""BambooChat first-run setup and hardened server entry point."""
from __future__ import annotations
import argparse
import getpass
import os
import socket
from pathlib import Path
import uvicorn
from app.auth import hash_secret, validate_password, validate_username
from app.config import GIB, RoomConfig, load_config, save_config

def detect_lan_ip() -> str:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("192.0.2.1", 80))
        return sock.getsockname()[0]
    except OSError:
        return "0.0.0.0"
    finally:
        sock.close()

def prompt(label: str, default: str) -> str:
    return input(f"{label} [{default}]: ").strip() or default

def first_run(config_path: Path) -> RoomConfig:
    from app.database import configure_storage, create_user, init_db
    print("\nBambooChat 최초 설정")
    print("설정 파일에는 비밀번호 원문이 저장되지 않습니다.\n")
    room_name = prompt("채팅방 이름", "인텔7기 대나무숲")
    data_dir = Path(prompt("데이터 저장 폴더", str(Path.home() / "BambooChatData"))).expanduser().resolve()
    bind_host = prompt("교실 LAN IP (0.0.0.0 = 모든 로컬 인터페이스)", detect_lan_ip())
    while True:
        try:
            admin_name = validate_username(prompt("관리자 아이디", "admin"))
            break
        except ValueError as exc:
            print(exc)
    while True:
        password = getpass.getpass("관리자 비밀번호 (5자 이상): ")
        confirmation = getpass.getpass("관리자 비밀번호 확인: ")
        try:
            validate_password(password)
            if password != confirmation:
                raise ValueError("비밀번호가 일치하지 않습니다.")
            break
        except ValueError as exc:
            print(exc)
    while True:
        enrollment_code = getpass.getpass("학생 가입 코드 (5자 이상): ")
        try:
            validate_password(enrollment_code)
            break
        except ValueError as exc:
            print(exc)
    config = RoomConfig(server_name=room_name, data_dir=str(data_dir), bind_host=bind_host,
        attachment_limit_bytes=10 * GIB, database_limit_bytes=3 * GIB,
        per_user_attachment_limit_bytes=2 * GIB, enrollment_code_hash=hash_secret(enrollment_code))
    data_dir.mkdir(parents=True, exist_ok=True)
    save_config(config, config_path)
    configure_storage(data_dir, config.database_limit_bytes)
    init_db()
    create_user(admin_name, hash_secret(password), role="admin")
    print(f"\n설정 저장: {config_path}")
    print(f"데이터 저장: {data_dir}")
    return config

def main() -> None:
    parser = argparse.ArgumentParser(description="BambooChat classroom LAN server")
    parser.add_argument("--config", type=Path, default=Path("bamboochat.json"))
    registration = parser.add_mutually_exclusive_group()
    registration.add_argument("--open-registration", action="store_true",
                              help="학생 계정 신규 가입을 허용합니다.")
    registration.add_argument("--close-registration", action="store_true",
                              help="학생 계정 신규 가입을 닫습니다.")
    parser.add_argument("--reset-user-password", metavar="USER",
                        help="서버를 시작하지 않고 지정 사용자의 비밀번호를 재설정합니다.")
    args = parser.parse_args()
    config_path = args.config.resolve()
    config = load_config(config_path) if config_path.exists() else first_run(config_path)
    if args.open_registration or args.close_registration:
        config.registration_enabled = args.open_registration
        save_config(config, config_path)
        state = "열림" if config.registration_enabled else "닫힘"
        print(f"학생 신규 가입: {state}")
    os.environ["BAMBOOCHAT_CONFIG"] = str(config_path)
    if args.reset_user_password:
        from app.database import (configure_storage, delete_user_sessions,
                                  get_user_by_username, init_db, update_password_hash)
        configure_storage(config.data_path, config.database_limit_bytes)
        init_db()
        user = get_user_by_username(args.reset_user_password)
        if not user:
            parser.error(f"사용자를 찾을 수 없습니다: {args.reset_user_password}")
        while True:
            password = getpass.getpass(f"{user['username']} 새 비밀번호 (5자 이상): ")
            confirmation = getpass.getpass("새 비밀번호 확인: ")
            try:
                validate_password(password)
                if password != confirmation:
                    raise ValueError("비밀번호가 일치하지 않습니다.")
                break
            except ValueError as exc:
                print(exc)
        update_password_hash(user["id"], hash_secret(password))
        delete_user_sessions(user["id"])
        print(f"{user['username']} 비밀번호를 재설정했습니다. 기존 세션은 종료되었습니다.")
        return
    print(f"\n{config.server_name}")
    print(f"접속 주소: http://{config.bind_host}:{config.port}")
    print("주의: HTTP LAN 서비스입니다. 비밀번호를 재사용하거나 민감정보를 공유하지 마세요.\n")
    uvicorn.run("app.main:app", host=config.bind_host, port=config.port, ws_max_size=8192,
        ws_max_queue=16, ws_per_message_deflate=False, limit_concurrency=60, server_header=False)

if __name__ == "__main__":
    main()

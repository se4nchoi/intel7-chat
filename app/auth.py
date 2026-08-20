"""Password, enrollment-code, and session-token helpers."""
from __future__ import annotations
import hashlib
import secrets
import unicodedata
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

PASSWORD_HASHER = PasswordHasher(time_cost=2, memory_cost=19_456, parallelism=1)

def normalize_username(username: str) -> str:
    return unicodedata.normalize("NFKC", username).strip().casefold()

def validate_username(username: str) -> str:
    display = unicodedata.normalize("NFKC", username).strip()
    if not 2 <= len(display) <= 30:
        raise ValueError("아이디는 2~30자로 입력해 주세요.")
    if not all(char.isalnum() or char in "._-" for char in display):
        raise ValueError("아이디에는 문자, 숫자, ., _, -만 사용할 수 있습니다.")
    return display

def validate_display_name(name: str) -> str:
    """Validate and normalise a user-facing display name."""
    display = unicodedata.normalize("NFKC", name).strip()
    # Collapse internal whitespace runs
    display = " ".join(display.split())
    if not display:
        raise ValueError("닉네임을 입력해 주세요.")
    if len(display) > 30:
        raise ValueError("닉네임은 30자 이하로 입력해 주세요.")
    if any(unicodedata.category(ch).startswith("C") for ch in display):
        raise ValueError("닉네임에 제어 문자를 포함할 수 없습니다.")
    return display

def validate_password(password: str) -> None:
    if len(password) < 5:
        raise ValueError("비밀번호는 5자 이상으로 입력해 주세요.")

def hash_secret(secret: str) -> str:
    return PASSWORD_HASHER.hash(secret)

def verify_secret(stored_hash: str, secret: str) -> bool:
    if not stored_hash:
        return False
    try:
        return PASSWORD_HASHER.verify(stored_hash, secret)
    except (InvalidHashError, VerificationError, VerifyMismatchError):
        return False

def secret_needs_rehash(stored_hash: str) -> bool:
    try:
        return PASSWORD_HASHER.check_needs_rehash(stored_hash)
    except InvalidHashError:
        return False

def new_session_token() -> str:
    return secrets.token_urlsafe(32)

def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()

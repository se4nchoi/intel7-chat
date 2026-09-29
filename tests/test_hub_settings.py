"""마디 settings from MADI_* environment variables."""
import pytest

from app.hub import settings as madi


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ("MADI_DATABASE_URL", "MADI_DB_POOL_SIZE", "MADI_FILE_DIR", "MADI_SESSION_HOURS",
                 "MADI_SFU_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "MADI_ALLOWED_HOSTS"):
        monkeypatch.delenv(name, raising=False)


def test_defaults_match_the_prototype():
    s = madi.settings()
    assert (s.database_url, s.db_pool_size, s.session_hours, s.sfu_configured) == (None, 10, 12, False)
    assert s.file_dir == madi.REPO_ROOT / "data_dev" / "hub-files"


def test_overrides(monkeypatch, tmp_path):
    monkeypatch.setenv("MADI_DB_POOL_SIZE", "4")
    monkeypatch.setenv("MADI_SESSION_HOURS", "8")
    monkeypatch.setenv("MADI_FILE_DIR", str(tmp_path / "files"))
    monkeypatch.setenv("MADI_SFU_URL", "wss://sfu.example")
    monkeypatch.setenv("LIVEKIT_API_KEY", "k")
    monkeypatch.setenv("LIVEKIT_API_SECRET", "s")
    s = madi.settings()
    assert (s.db_pool_size, s.session_hours, s.file_dir, s.sfu_configured) == (4, 8, tmp_path / "files", True)


@pytest.mark.parametrize("value", ["ten", "0", "-3"])
def test_bad_numbers_fail_with_the_variable_name(monkeypatch, value):
    monkeypatch.setenv("MADI_DB_POOL_SIZE", value)
    with pytest.raises(RuntimeError, match="MADI_DB_POOL_SIZE"):
        madi.settings()


def test_sfu_needs_url_key_and_secret(monkeypatch):
    monkeypatch.setenv("MADI_SFU_URL", "wss://sfu.example")
    monkeypatch.setenv("LIVEKIT_API_KEY", "k")
    assert not madi.settings().sfu_configured


def test_allowed_hosts_extend_the_app_host_check(monkeypatch):
    monkeypatch.setenv("MADI_ALLOWED_HOSTS", " Madi.Example.kr , other.example ")
    assert madi.allowed_hosts() == {"madi.example.kr", "other.example"}

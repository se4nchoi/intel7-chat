"""TLS startup validation and certificate issuance checks."""
from pathlib import Path
import shutil
import ssl

import pytest

from app.config import RoomConfig, load_config, save_config
from app.tls import tls_options
from scripts.create_local_certificate import create_certificate, subject_alt_name


@pytest.fixture(scope="module")
def certificates(tmp_path_factory):
    openssl = shutil.which("openssl")
    if not openssl:
        pytest.skip("OpenSSL is required for certificate integration tests")
    directory = tmp_path_factory.mktemp("tls")
    create_certificate(directory, ["localhost", "127.0.0.1", "10.10.21.23"], openssl)
    return directory


def test_tls_config_round_trip_and_relative_paths(certificates, tmp_path):
    config_path = tmp_path / "room.json"
    config = RoomConfig(ssl_certfile=str(certificates / "server.crt"),
                        ssl_keyfile=str(certificates / "server-key.pem"))
    save_config(config, config_path)
    options = tls_options(load_config(config_path), config_path)
    assert options["ssl_certfile"] == str(certificates / "server.crt")
    # Configuration is relative to its own file, independent of the working directory.
    config.ssl_certfile = "server.crt"
    config.ssl_keyfile = "server-key.pem"
    assert tls_options(config, certificates / "room.json") == options
    # Validate the public CA can be loaded without its private key.
    ssl.create_default_context(cafile=str(certificates / "classroom-ca.crt"))


def test_tls_cli_overrides_configuration(certificates, tmp_path):
    config = RoomConfig(ssl_certfile="nonexistent.crt", ssl_keyfile="nonexistent.key")
    options = tls_options(config, tmp_path / "room.json",
                          certfile=certificates / "server.crt",
                          keyfile=certificates / "server-key.pem")
    assert options["ssl_certfile"] == str(certificates / "server.crt")


def test_tls_never_silently_falls_back_to_http(tmp_path, certificates):
    path = tmp_path / "room.json"
    assert tls_options(RoomConfig(), path) == {}
    with pytest.raises(ValueError, match="both"):
        tls_options(RoomConfig(ssl_certfile="server.crt"), path)
    with pytest.raises(ValueError, match="not found"):
        tls_options(RoomConfig(ssl_certfile="missing.crt", ssl_keyfile="missing.key"), path)
    # A CA private key cannot serve as the leaf certificate's private key.
    with pytest.raises(ValueError, match="Cannot load"):
        tls_options(RoomConfig(), path, certfile=certificates / "server.crt",
                    keyfile=certificates / "classroom-ca-key.pem")


@pytest.mark.parametrize("module_name", ["run", "dev_run"])
@pytest.mark.parametrize("https", [False, True])
def test_launchers_pass_tls_and_print_matching_scheme(module_name, https, certificates,
                                                      tmp_path, monkeypatch, capsys):
    import importlib
    launcher = importlib.import_module(module_name)
    config_path = tmp_path / "room.json"
    save_config(RoomConfig(data_dir=str(tmp_path / "data")), config_path)
    argv = [f"{module_name}.py", "--config", str(config_path)]
    if https:
        argv += ["--ssl-certfile", str(certificates / "server.crt"),
                 "--ssl-keyfile", str(certificates / "server-key.pem")]
    monkeypatch.setattr("sys.argv", argv)
    monkeypatch.setattr(launcher, "get_all_lan_ips", lambda: ["10.10.21.23"])
    calls = []
    monkeypatch.setattr(launcher.uvicorn, "run", lambda *args, **kwargs: calls.append(kwargs))
    launcher.main()
    assert len(calls) == 1
    assert bool(calls[0].get("ssl_certfile")) == https
    assert f"{'https' if https else 'http'}://10.10.21.23:8000" in capsys.readouterr().out


def test_generator_rejects_injection_and_overwrite(certificates):
    assert subject_alt_name("10.10.21.23") == "IP:10.10.21.23"
    assert subject_alt_name("classroom-pc") == "DNS:classroom-pc"
    with pytest.raises(ValueError, match="Invalid"):
        subject_alt_name("localhost\nCA:TRUE")
    original_key = (certificates / "server-key.pem").read_bytes()
    with pytest.raises(ValueError, match="already exists"):
        create_certificate(certificates, ["localhost"], shutil.which("openssl"))
    assert (certificates / "server-key.pem").read_bytes() == original_key

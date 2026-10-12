"""Shared TLS configuration for the production and development launchers."""
from __future__ import annotations

import argparse
from pathlib import Path
import ssl

from app.config import RoomConfig


def add_tls_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--ssl-certfile", type=Path,
                        help="PEM server certificate (overrides configuration)")
    parser.add_argument("--ssl-keyfile", type=Path,
                        help="PEM private key (overrides configuration)")


def tls_options(config: RoomConfig, config_path: Path, *,
                certfile: Path | None = None, keyfile: Path | None = None) -> dict:
    """Validate TLS before startup; config paths are relative to the config file."""
    def resolve(override: Path | None, configured: str) -> Path | None:
        if override is not None:
            return override.expanduser().resolve()
        if not configured:
            return None
        path = Path(configured).expanduser()
        return (config_path.parent / path).resolve()

    cert = resolve(certfile, config.ssl_certfile)
    key = resolve(keyfile, config.ssl_keyfile)
    if cert is None and key is None:
        return {}
    if cert is None or key is None:
        raise ValueError("HTTPS requires both ssl_certfile and ssl_keyfile.")
    for path in (cert, key):
        if not path.is_file():
            raise ValueError(f"TLS file not found: {path}")
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    try:
        # Never prompt for encrypted keys during server startup.
        context.load_cert_chain(str(cert), str(key), password=lambda: "")
    except (OSError, ssl.SSLError) as exc:
        raise ValueError(f"Cannot load TLS certificate/key: {exc}") from exc
    return {"ssl_certfile": str(cert), "ssl_keyfile": str(key),
            "ssl_version": ssl.PROTOCOL_TLS_SERVER}

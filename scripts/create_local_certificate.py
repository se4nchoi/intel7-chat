"""Create a classroom CA and server certificate using an installed OpenSSL."""
from __future__ import annotations

import argparse
import ipaddress
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def subject_alt_name(host: str) -> str:
    try:
        return f"IP:{ipaddress.ip_address(host)}"
    except ValueError:
        if len(host) > 253 or not all(
            re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
            for label in host.split(".")
        ):
            raise ValueError(f"Invalid IP address or DNS hostname: {host}")
        return f"DNS:{host}"


def create_certificate(output: Path, hosts: list[str], openssl: str) -> None:
    sans = ",".join(subject_alt_name(host) for host in dict.fromkeys(hosts))
    output = output.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    ca_cert, ca_key = output / "classroom-ca.crt", output / "classroom-ca-key.pem"
    cert, key = output / "server.crt", output / "server-key.pem"
    if cert.exists() or key.exists():
        raise ValueError("Server certificate/key already exists. Use a new output directory.")
    if ca_cert.exists() != ca_key.exists():
        raise ValueError("Existing CA is incomplete: both CA certificate and private key are required.")

    def run(*args: str) -> None:
        subprocess.run([openssl, *args], check=True, capture_output=True, text=True)

    with tempfile.TemporaryDirectory(prefix="bamboochat_tls_") as work:
        temp = Path(work)
        request_config = temp / "openssl.cnf"
        request_config.write_text("[req]\ndistinguished_name=dn\n[dn]\n", encoding="ascii")
        # Stage every generated file so failures don't leave a partial CA/key pair.
        signing_cert, signing_key = ca_cert, ca_key
        new_ca = not ca_cert.exists()
        if new_ca:
            signing_cert, signing_key = temp / ca_cert.name, temp / ca_key.name
            run("req", "-config", str(request_config), "-x509", "-newkey", "rsa:3072", "-sha256", "-nodes",
                "-days", "3650", "-subj", "/CN=BambooChat Classroom CA",
                "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
                "-addext", "keyUsage=critical,keyCertSign,cRLSign",
                "-keyout", str(signing_key), "-out", str(signing_cert))
        staged_key, staged_cert = temp / key.name, temp / cert.name
        csr = temp / "server.csr"
        run("req", "-config", str(request_config), "-new", "-newkey", "rsa:2048", "-sha256", "-nodes",
            "-subj", "/CN=BambooChat LAN Server", "-keyout", str(staged_key), "-out", str(csr))
        extensions = temp / "server.ext"
        extensions.write_text(
            "basicConstraints=critical,CA:FALSE\n"
            "keyUsage=critical,digitalSignature,keyEncipherment\n"
            "extendedKeyUsage=serverAuth\n"
            f"subjectAltName={sans}\n", encoding="ascii")
        # A random serial avoids modifying the CA directory during issuance.
        import secrets
        run("x509", "-req", "-in", str(csr), "-CA", str(signing_cert),
            "-CAkey", str(signing_key), "-set_serial", "0x" + secrets.token_hex(16),
            "-days", "365", "-sha256", "-extfile", str(extensions), "-out", str(staged_cert))
        pairs = [(staged_cert, cert), (staged_key, key)]
        if new_ca:
            pairs += [(signing_cert, ca_cert), (signing_key, ca_key)]
        for source, destination in pairs:
            shutil.copyfile(source, destination)
        # POSIX permissions; on Windows protect this directory using NTFS ACLs.
        for private_key in (key, ca_key):
            private_key.chmod(0o600)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", action="append", required=True,
                        help="Server IP or hostname; repeat for each address")
    parser.add_argument("--output", type=Path, default=Path("certs"))
    parser.add_argument("--openssl", default=shutil.which("openssl"),
                        help="Path to OpenSSL executable (default: PATH)")
    args = parser.parse_args()
    if not args.openssl:
        parser.error("OpenSSL is required. Install it or pass --openssl PATH.")
    try:
        create_certificate(args.output, [*args.host, "localhost", "127.0.0.1"], args.openssl)
    except subprocess.CalledProcessError as exc:
        parser.error(f"OpenSSL failed: {exc.stderr.strip()}")
    except (ValueError, OSError) as exc:
        parser.error(str(exc))
    print(f"Created certificates in {args.output.resolve()}")
    print("Clients can accept the HTTPS warning without installing a certificate.")
    print("Optional: trust classroom-ca.crt to remove warnings. Keep both *-key.pem files private.")
    print("See docs/local-https.md for Windows trust and server startup instructions.")


if __name__ == "__main__":
    main()

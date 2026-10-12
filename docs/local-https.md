# HTTPS for classroom screen sharing

Local HTTPS enables screen capture without Chrome's insecure-origin flag and
encrypts HTTP and WebSocket traffic. For this lab, clients can accept the browser's
certificate warning instead of installing certificates. HTTPS itself does not fix
blocked peer-to-peer WebRTC media paths or change server capacity.

The server applies separate account-wide limits: chat and other ordinary frames
allow 30 messages per 10 seconds; screen-share offers, ICE candidates, and session
controls allow 1,000 per 10 seconds. Screen sharing does not consume the chat
allowance. Both budgets are shared across an account's browser tabs, and exceeding
either budget closes that socket with code 1008 and logs the limit category.
Connection/concurrency limits remain unchanged. Restart the server after updating
the code to apply the new signaling limit.

## Use HTTPS without installing anything on client PCs

The server certificate can stay on the server. At the next planned restart, use
the HTTPS startup command below and open `https://10.10.21.23:8000` on client PCs.
At the certificate warning, choose **Advanced → Proceed** (wording varies by
browser). No certificate file needs to be copied or imported on client PCs.

This was verified in a fresh Edge profile against the LAN IP: after accepting the
warning, `window.isSecureContext` was `true`, `getDisplayMedia` was available, and
authenticated `wss://` worked, with no certificate import or browser bypass flag.
The address bar can still display **Not secure** because the certificate is
untrusted. API secure-context eligibility and the address-bar trust indicator are
different checks. Actual screen capture still requires the browser's screen picker.

Warnings can recur, and managed browsers may disable the Proceed option. The
server cannot suppress those browser decisions. CA installation below is optional
and removes the warning; it is not required for the tested lab workflow.

## Create a certificate

Use Python from this project's environment and an installed OpenSSL 1.1.1 or newer:

```powershell
uv run --locked python scripts/create_local_certificate.py --host 10.10.21.23
```

Repeat `--host` to include a stable hostname or other server addresses. Include the
**server's** address, not the professor's client address (`10.10.21.49`). Localhost
and `127.0.0.1` are included automatically. If OpenSSL is not on PATH, supply
`--openssl 'C:\path\to\openssl.exe'`.

The script creates these files in the gitignored `certs/` directory:

- `classroom-ca.crt`: public CA certificate for optional client trust installation.
- `classroom-ca-key.pem`: private CA signing key; never distribute to clients.
- `server.crt`: server certificate, valid for one year.
- `server-key.pem`: private server key; never distribute to clients.

On Windows, restrict the certificate directory's NTFS permissions to the server
operator, administrators and SYSTEM. Keep a protected backup of the CA; anyone
with its private key can issue certificates trusted by these PCs. For school PCs,
coordinate any optional CA installation with the lab administrator, or use the school's CA.

The script refuses to overwrite certificates. To renew or change IPs while keeping
the same trusted CA, copy only the CA certificate and CA key into a new protected
directory and run the script with `--output` pointing there. Do not commit keys.

## Optional: trust the CA on Windows to remove warnings

Copy **only `classroom-ca.crt`** to the professor PC and each other client PC.
After verifying it came from the server operator, run this on each PC to trust
it for the current Windows user (usually no administrator privileges required):

```powershell
Import-Certificate -FilePath .\classroom-ca.crt -CertStoreLocation Cert:\CurrentUser\Root
```

Restart Chrome/Edge after import. Other Windows users need their own import;
school-managed browser policies may require administrator deployment. Firefox
may need the CA imported into its own Authorities store. Import the CA on the
server PC too if you want to remove localhost warnings there. Remove the
insecure-origin flag once HTTPS capture works; the no-install workflow can still
show certificate warnings.

## Start HTTPS

At the next planned server restart:

```powershell
uv run --locked python run.py --ssl-certfile certs/server.crt --ssl-keyfile certs/server-key.pem
```

Then open `https://10.10.21.23:8000` on client PCs, or
`https://localhost:8000` on the server PC. Existing HTTP bookmarks must be changed;
this listener serves HTTPS only and does not redirect HTTP. Log in again on the
HTTPS origin. WebSocket connections automatically use `wss://`.

For persistent configuration, add these fields to `bamboochat.json`:

```json
{
  "ssl_certfile": "certs/server.crt",
  "ssl_keyfile": "certs/server-key.pem"
}
```

Merge these fields into the existing configuration; do not replace the file.
Configuration paths resolve relative to the configuration file's directory.
CLI paths resolve relative to the current working directory and override their
respective configuration fields. Both files are required; invalid files or a
mismatched certificate/key abort startup instead of falling back to HTTP.
Leaving both configuration fields empty preserves HTTP mode.

`dev_run.py` accepts the same TLS flags, including with `--reload`. Startup lists
available network addresses; only addresses included in the certificate are valid.
For a hostname, configure classroom DNS and `CLASSROOM_ALLOWED_HOSTS` as described
in the README. Prefer a stable hostname when moving rooms; an IP certificate must
be reissued when the server IP changes.

To confirm capture is available, run this in the professor browser's DevTools:

```javascript
({ secure: window.isSecureContext,
   capture: typeof navigator.mediaDevices?.getDisplayMedia })
```

Expect `secure: true` and `capture: "function"`. A real capture still requires the
user to click the share button and approve the browser's screen picker.

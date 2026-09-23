# Local prototype

This is an isolated development instance in the `edu/prototype` worktree.
The new hub is at `https://127.0.0.1:8443/hub`. PostgreSQL, the SFU, TLS
proxy, credentials, and uploads are all kept in ignored `data_dev/`. The live
LAN chat remains in its own checkout on port `8000`.

The hub frontend now lives in `frontend/` (Vite and browser code). FastAPI in
`app/` serves its built files at `/hub` and `/hub/assets`, and owns `/hub/api`
and `/hub/ws`. The browser does not connect to PostgreSQL. Both halves use the
same HTTPS origin, so the existing hub session cookie and origin checks apply.

The older chat page at `/` still uses the prototype's isolated SQLite database.
The `/hub` page is the PostgreSQL-backed rework: accounts, cohort memberships,
channels, chat, Q&A, file metadata, and login sessions are in PostgreSQL.
Uploaded file bytes are in `data_dev/hub-files/`. The two pages have separate
accounts and cookies while the older code is being replaced.

## Restart on this host

On this host, the binaries and credentials are already present. After a reboot,
run this from a normal PowerShell window under the same Windows account that
opens Chrome:

```powershell
& .\scripts\start_prototype_stack.ps1
```

Build the frontend once after a fresh checkout or after editing its source:

```powershell
cd frontend
npm ci
npm run build
cd ..
```

The build is written to ignored `frontend/dist/`; the startup script requires
its `index.html`. For ongoing UI work, `npm run watch` rebuilds on source
changes while FastAPI continues to serve the same HTTPS address. The pinned
Vite version requires Node.js `^20.19.0 || >=22.12.0`. The older `/` UI still lives
under `app/static` and has not been moved to this frontend project.

The hub demo instructor and student credentials are in
`data_dev/hub-demo-users.txt`. The hub administrator uses the credential in
`data_dev/prototype-admin.txt`. These files are local and ignored by Git.

| Component | Local address | Storage |
| --- | --- | --- |
| HTTPS app and hub | `https://127.0.0.1:8443/` and `/hub` | `data_dev/`, PostgreSQL |
| PostgreSQL 18.6 | `127.0.0.1:55432` | `data_dev/pgdata/` |
| LiveKit 1.13.7 signal | `127.0.0.1:7880` | ephemeral media sessions |
| Caddy 2.11.4 TLS proxy | `https://127.0.0.1:7882` | `data_dev/Caddyfile` |
| LiveKit media UDP | `127.0.0.1:55000` | ephemeral media sessions |

The PostgreSQL role is `prototype_app` and the database is
`bamboochat_prototype`. Its random password is in `data_dev/pg-app.env`.
LiveKit uses a separate random API key and secret in `data_dev/livekit.env`.
The app issues short-lived media tokens after checking cohort and channel
membership. Instructor and administrator tokens can publish a screen track;
student tokens can only subscribe. The SFU and proxy are local only. Port
`7882` uses the same local certificate as the app. The locally bundled
LiveKit browser client avoids a CDN dependency.

The current host has official portable PostgreSQL binaries and official
LiveKit/Caddy Windows binaries in `data_dev/`. Their downloaded archives were
checked against the release SHA-256 digests. These binaries are ignored by Git;
a fresh checkout needs its own local setup. The Python dependencies are pinned
in `uv.lock`. The browser bundle was built from `livekit-client@2.22.3` with
Vite; its dependencies are pinned in `frontend/package-lock.json`. Built files
are local outputs and are not tracked by Git.

The TLS certificate is self-signed for `localhost` and `127.0.0.1` and is valid
for 30 days. The generator does not install it in a trust store. On this host,
the current certificate was installed in the **current user's** Windows trusted
root store for browser testing (thumbprint
`68BBAAB6D5285F97E40B7D2322720E413D7B7E16`). It expires on
2026-10-23. Other users/devices do not inherit that trust. Future prototype
certificates need to be trusted again; remove the old certificate from the
current user's root store when it is no longer needed.

For a longer development setup or a classroom-device test, use a managed test
certificate or a local CA tool such as mkcert and distribute trust deliberately.
Avoid bypassing browser certificate warnings as a substitute for trust.

## Verified locally

- PostgreSQL accepts app credentials on loopback; the hub reads and writes
  accounts, chat, Q&A, and file metadata there.
- Student login, HTTPS chat writes, WSS chat delivery, Q&A, file upload and
  download, and cohort access denial work through the app.
- Two headless Chrome clients connected through Caddy to the local LiveKit
  SFU. An instructor published a screen-type video track and a student
  subscribed to it. Browser-native screen picker interaction still needs a
  manual check in the visible Chrome window.
- Existing repository checks passed (`273 passed`).

## Limits and next checks

- Use the visible Chrome hub page with the demo instructor and student accounts
  to confirm the screen picker, share, view, and stop controls.
- The older `/` page has not been migrated from SQLite. Its `NaN` channel issue
  was fixed by starting on numeric channel `1` and refusing invalid room IDs.
- This is a single-host architecture proof, not a deployable service. The
  database, app, and SFU stop when this PC is off. Cross-floor routing,
  classroom Wi-Fi capacity, certificate trust on other devices, backups,
  home access, and production uptime remain untested.

No domain or paid cloud service is needed for this local proof.

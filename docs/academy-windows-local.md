# Academy development on this Windows PC

This is a loopback-only development profile for `edu/madi`.
It uses PostgreSQL 17 at `127.0.0.1:55432` and HTTPS at
`https://localhost:8443/hub`. The community chat on port 8000 and its
`BambooChatData` are separate. No Caddy or LiveKit process is started.
Media configuration is cleared in the launcher's shell; screen sharing is unavailable.

## Prepared local state

- Python dependencies installed from `uv.lock`.
- Frontend installed from `frontend/package-lock.json` and built in `frontend/dist/`.
- Private `data_dev/academy-local.json` contains local PostgreSQL binary/data paths,
  `database_url`, `test_database_url`, and the cluster's `admin_url`.
- PostgreSQL cluster: `data_dev/academy-pgdata/`; application database: `madi_local`;
  disposable integration-test database: `madi_test`. Each uses a separate
  non-superuser role, random password, and SCRAM authentication.
- Application uploads: `data_dev/academy-files/`.
- HTTPS uses the existing ignored `certs/server.crt` and `certs/server-key.pem`.

The credentials, database cluster, uploads, and certificates are local files;
Git does not transfer them. This profile was provisioned on this PC, and the
launcher is not a database installer. A fresh host needs its own cluster,
roles/databases, private JSON configuration, and certificate before launching.
Keep `data_dev/` restricted to the operator, Administrators, and SYSTEM.
Never paste its JSON credentials into issues or commit them.

## Commands

Run from the project folder in PowerShell:

```powershell
# Check local configuration and frontend build (not media connectivity).
.\scripts\start_academy_local.ps1 -Check

# Choose your first administrator's username, display name, and password.
.\scripts\start_academy_local.ps1 -CreateAdmin

# Start the academy app with local HTTPS.
.\scripts\start_academy_local.ps1

# Run Python tests, including PostgreSQL integrations, on the disposable DB.
.\scripts\start_academy_local.ps1 -Test

# After stopping the app with Ctrl+C, stop the local database if desired.
.\scripts\start_academy_local.ps1 -Stop
```

The launcher starts only this profile's PostgreSQL cluster when needed.
`-CreateAdmin` refuses to create a second administrator. Existing community
accounts are not imported. If Windows blocks local scripts, invoke with
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start_academy_local.ps1`.

The certificate must cover localhost. Browser trust is separate from these
local build/database checks. This setup does not install a root certificate,
validate classroom network access, or test real media forwarding.

To rebuild the frontend after changes:

```powershell
cd frontend
npm ci
npm run build
npm test
cd ..
```

For the academy deployment target and later media/network acceptance checks,
see [academy LAN deployment](academy-lan-deployment.md).

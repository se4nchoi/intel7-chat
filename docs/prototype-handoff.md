# Prototype handoff (2026-09-23)

Start here when continuing BambooChat on another PC or in another Codex task.
The working branch is `edu/prototype`. The earlier conversation on the user's
home PC is not available here; confirm any requirements that are missing from
these documents with the user.

## Product direction

- Keep one central hub for durable identities, cohort memberships, history,
  chat, Q&A, and files. Administrators configure and oversee the service;
  instructors manage their cohorts; students use their assigned cohorts.
  Enforce scope in the backend, including WebSockets, files, and SFU tokens.
- Support classrooms on floors 3 and 9, with floor 8 planned. The building's
  routing, DNS, Wi-Fi, firewall, and available server/NAS equipment have not
  been confirmed. Cross-floor access has not been tested.
- An eventual deployment should be available without a classroom PC being on
  and should support access from home. Cloud or academy-operated equipment
  remains open pending funding and infrastructure information. Do not treat
  this classroom-PC proof as a production deployment.
- PostgreSQL is the planned central database. Screen sharing should use an
  SFU at classroom scale. See [architecture-rework.md](architecture-rework.md)
  for decisions and open policy questions.

## Branch and running services

| Checkout | Branch | Purpose |
| --- | --- | --- |
| Original `intel7-chat` checkout on this PC | `main` | Running classroom LAN service on port `8000`; leave it alone. |
| Separate `intel7-chat-prototype` worktree | `edu/prototype` | Isolated rework on `https://127.0.0.1:8443/hub`. |

The current worktree has an unrelated, **uncommitted** deletion of
`robot_python_question_set.json`. It was deliberately excluded from prototype
commits and is not part of this handoff.

The prototype's current topology is:

```text
Browser -- HTTPS :8443 /hub, /hub/api, /hub/ws --> FastAPI
   |                                             |-- PostgreSQL :55432
   |                                             `-- local uploaded file bytes
   |-- WSS :7882 --> Caddy TLS proxy --> LiveKit signaling :7880
   `-- WebRTC media UDP :55000 -------------> LiveKit SFU
```

All these addresses are bound to loopback on the prototype host. Caddy only
provides TLS for LiveKit signaling; FastAPI serves the UI and API over HTTPS
directly. The browser never connects to PostgreSQL. The older `/` page still
uses an isolated SQLite database and has separate accounts and cookies.

## Code map

| Area | Location |
| --- | --- |
| New hub browser app | `frontend/index.html`, `frontend/src/main.js`, `frontend/src/api.js` |
| Vite build and pinned browser dependencies | `frontend/package.json`, `frontend/package-lock.json`, `frontend/vite.config.js` |
| Hub HTTP/WebSocket API, auth checks, media tokens | `app/hub/routes.py` |
| Hub PostgreSQL schema and queries | `app/hub/db.py` |
| FastAPI application and built-asset mount | `app/main.py` |
| Isolated HTTPS launcher and stack restart | `prototype_run.py`, `scripts/start_prototype_stack.ps1` |
| Host-specific setup and verification details | [prototype-local.md](prototype-local.md) |

The Vite output is served by FastAPI at `/hub` and `/hub/assets`. API and
WebSocket routes remain `/hub/api` and `/hub/ws`. The browser code and backend
are separate projects within one repository and use the same HTTPS origin.
The old UI is still under `app/static` while its features are migrated.

## What works and what has been checked

- Local PostgreSQL holds hub accounts, cohort memberships, channels, chat,
  Q&A, file metadata, and sessions. File bytes are stored on the prototype
  host. Cohort access is checked server-side.
- Administrator, instructor, and student demo roles exist. Instructor and
  administrator media tokens can publish a screen track; student tokens can
  subscribe. A two-client headless Chrome probe published a synthetic
  screen-type track and subscribed through LiveKit.
- After the frontend split, Vite built successfully; the rebuilt hub HTML and
  JavaScript returned `200` over HTTPS; headless Chrome ran the bundle and
  displayed the login prompt; a demo account logged in through the API and
  fetched its cohort. The existing Python suite passed: `273 passed`.
- The user confirmed only that the login flow was possible before the split.
  **No UI audit has been done.** The native browser screen picker, share/stop
  controls, and full instructor/student workflow still need hands-on checks.
- No cross-floor, second-device certificate, capacity, backup/restore, home
  access, or production uptime test has been done.

## Continuing on another PC

1. Fetch and check out `edu/prototype`. Keep the original LAN service checkout
   separate if it is running on that PC.
2. Install the Python environment with `uv sync --locked`. Install a Node.js
   version accepted by Vite (`^20.19.0 || >=22.12.0`), then run `npm ci` and
   `npm run build` inside `frontend/`. Built files in `frontend/dist/` are
   ignored by Git.
3. Recreate the local runtime independently: PostgreSQL, LiveKit, Caddy, TLS
   certificate and trust, credentials, and prototype data under `data_dev/`.
   These are **not** pushed. `scripts/start_prototype_stack.ps1` restarts an
   already provisioned host; it is not a fresh-machine installer. Read
   [prototype-local.md](prototype-local.md) before attempting startup.
4. Use fresh local secrets. Do not commit `data_dev/`, certificates, database
   files, demo passwords, or upload contents. This PC's local demo credentials
   do not travel with the branch.
5. On the provisioned host, build the frontend, run the stack script, then
   check `/hub/api/health` and the login screen. Run the Python tests with
   `.venv\Scripts\python.exe -m pytest -q` on Windows. On this PC, pytest's
   default Windows temp directory was inaccessible, so the successful run used
   `--basetemp` pointing inside ignored `data_dev/`.

## Suggested next work

1. Audit the hub UI with administrator, instructor, and student accounts;
   fix workflow and accessibility problems before migrating more legacy UI.
2. Manually verify Chrome's native screen picker, publication, viewing,
   stopping, and role denial. The synthetic two-browser probe is not this test.
3. Continue moving required legacy chat and screen-share features to the new
   hub without making the live `main` service depend on prototype data.
4. Add migration and backup/restore rehearsals using a copy of live data.
5. When possible, survey the academy network and hosting options. Validate
   HTTPS trust, app/database reachability, and SFU media from representative
   rooms on each floor before choosing a deployment topology.

The central architectural decisions and unresolved product questions are in
[architecture-rework.md](architecture-rework.md). Treat them as working
decisions, not as confirmation of anything discussed only on the home PC.

# Classroom SFUs and portable cohorts

The central hub owns accounts, cohort membership, channels, files and Q&A.
Each classroom instructor PC runs LiveKit as an independent boot service.
The instructor browser captures/encodes one screen track and its local SFU
forwards it to the classroom. Neither an Electron app nor a browser-launched
server is required. LiveKit must be installed ahead of time.

A classroom has a stable operator-defined ID (`lab-1`), not a cohort ID or IP.
A temporary channel session selects that classroom. Cohorts moving between
labs retain the same database IDs and all their content. A new media session
uses a fresh room name even when it reuses the same channel or classroom.
Each presenter handoff also changes the room revision so older tokens cannot
publish into the new broadcast.

## Configuration

1. On each instructor PC, install a pinned LiveKit version (development uses
   1.13.7). Use `deploy/academy/livekit.yaml`, replacing node IP with that PC's
   reserved academy address. Give each PC a different random API key/secret.
   Install `deploy/academy/madi-media.service` on Linux and enable it at boot;
   only this service and its YAML are needed on classroom hosts. Windows hosts
   require an operator-managed Windows service or startup task with restart
   handling; no Windows installer is included here.
2. On the hub, copy `deploy/academy/classrooms.example.json` to a private
   operator-owned file (for example `/etc/madi/classrooms.json`, mode 0640).
   Replace every placeholder and set `MADI_CLASSROOMS_FILE` to its absolute
   path in the hub environment. Fields are `id`, `name`, `url`, `api_key` and
   `api_secret`. URL must be browser-reachable WSS. Never commit the filled
   file or expose signing secrets through HTTP. The list must be nonempty;
   malformed configuration fails startup rather than using a fallback SFU.
3. Use `deploy/academy/Caddyfile.classrooms` on the hub. Each public signaling
   prefix maps to one classroom PC's LiveKit HTTP port. LiveKit appends `/rtc`
   and related paths below each prefix. Classroom PCs need no TLS certificates
   with this topology: Caddy terminates HTTPS/WSS centrally. Restrict each
   classroom's 7880 signaling port to the hub, while students must directly
   reach classroom UDP 55000 and TCP 7881. HTTP proxying does not carry media.
4. Trust the hub internal CA on all classroom browsers. Reserve classroom IPs
   or use resolvable internal DNS. A PC address change updates the proxy
   upstream (and LiveKit node IP), not cohort data or classroom ID. Restart
   the hub after registry changes so its CSP includes all configured origins.
5. Restart the hub and build `frontend/` with `npm ci && npm run build`.
   Migrations apply on application startup. Existing single-SFU installations
   continue to use `MADI_SFU_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` when
   `MADI_CLASSROOMS_FILE` is unset. Configuring a registry selects distributed
   mode exclusively; it never silently falls back to the global endpoint.

The registry is operator-managed, not automatically registered by arbitrary
browsers/PCs. Configuration does not establish network reachability. Classroom
SFU availability is established when the browser connects; failed connections
show an error and release the reservation. There is no background SFU health
agent or automatic failover. Retry after repairing the classroom service.

## Browser workflow

An instructor opens the cohort's normal channel, selects the current classroom
in the screen-sharing panel, connects, then starts screen capture. Students
click Connect in the same cohort/channel without selecting a lab. Another
instructor can choose viewing-only mode. Only the instructor tab holding the
session control token can manage the session and approve presenter requests.
Students receive subscribe-only tokens until that instructor approves their
request; only the requesting student tab can then obtain a publish token. Token signing uses the
selected classroom's credentials, never credentials supplied by a client.

Disconnect to end/release the session before moving to another classroom;
select the new lab and connect again. Stopping screen capture alone leaves the
session connected for another share. Switching channel/cohort disconnects and
releases an owned session. Reloaded or crashed tabs lose their control token;
abandoned reservations become available after at most 120 seconds.

PostgreSQL enforces one live reservation per channel and classroom. A second
instructor gets a conflict instead of silently moving an ongoing class. The
owner renews every 15 seconds. Viewers check session identity every 15 seconds
and disconnect if it changes, expires, or the hub cannot be reached. After a
network failure, repair and reconnect. Existing cohort access and archive
checks apply to start, heartbeat, token and end operations.

## Lifecycle and security limits

Lease expiry/end stops issuing tokens for that session; a new session has a
new room ID. It does not forcibly delete the old room on the SFU or instantly
revoke issued JWTs. Tokens expire after five minutes, but expiration does not
itself disconnect an already connected LiveKit participant. Normal clients
stop promptly through polling; an uncooperative client may stay in the old
room until disconnected or the SFU is restarted. Do not treat ending a lease
as immediate server-side media eviction. A LiveKit room-deletion/revocation
controller is a separate future capability.

The hub remains a single application worker because chat registries are
process-local. No Redis or additional central video server is required.
For 30 viewers, a 4 Mbps ceiling means approximately 120 Mbps outbound from
each classroom PC, not the central hub. Test real instructor hardware, wired
links and Wi-Fi/VLAN routing; this does not establish 15-class capacity.

## API

All paths below are under `/hub/api`, use normal session cookies and require
cohort membership; mutations enforce same-origin and non-archived cohorts.

- `GET /cohorts/{id}/classrooms`: instructor/admin list of IDs/names only.
- `GET /cohorts/{id}/channels/{id}/media-session`: mode and current public lease.
- `POST .../media-session` with `classroom_id`: instructor reserves lab; returns
  public session and private per-tab `control_token`.
- `POST .../media-session/{session_id}/heartbeat` with `control_token`: owner renews.
- `DELETE .../media-session/{session_id}` with `control_token`: owner releases.
- `POST .../media-token` with optional `control_token`: active classroom URL,
  session/revision-specific room and short-lived role-scoped token. Supply the
  owning instructor control_token or approved student request_token. While a
  student is approved, the instructor is a subscriber. No active session returns 409.

Clients must not log either control tokens or signed LiveKit tokens.

## Student presenter requests

This flow requires the classroom registry (including a one-entry registry for
single-lab installations). Legacy global-SFU mode remains instructor-only.

1. The instructor connects to a classroom session as its owner.
2. Connected students press **화면 공유 요청** (Request screen sharing). Requests
   appear in the instructor's panel, with a badge and notification. Multiple
   students can wait in the queue. Requests carry a private per-tab token;
   another tab or student cannot reuse an approval.
3. The owning instructor clicks **허용** (Allow) or **거절** (Deny). Only one
   student can be approved at a time. Allowing a new student replaces the
   previous presenter and pauses instructor publication.
4. Everyone reconnects to the same new room revision. The approved student
   clicks **화면 선택하고 공유** (Choose screen and share) to open the browser's
   native picker. Approval cannot open the picker automatically because the
   browser requires a user gesture. Cancelling the picker leaves permission
   available for another attempt.
5. The instructor can select **발표 종료 / 강사로 전환** to revoke approval and
   regain publication. The student can withdraw the request or finish sharing;
   leaving cancels their request, and normal screen-share stop returns control
   to the instructor. Other queued requests remain pending until explicitly
   allowed or denied; approval is never automatic.

Queue changes notify cohort sockets immediately and recover through periodic
session polling (15 seconds). Requests are scoped to the active session;
expired/ended sessions discard the queue. Reloading a student's tab loses its
private request token: the instructor should deny/revoke the old request so
that tab can request again. A request is not a grant of instructor privileges.
If the instructor removes a student from the cohort or disables their account,
stale requests cannot be approved and further token requests are denied.

Presenter changes increment a room revision under the same PostgreSQL session
lock as approval. All normal clients disconnect the previous room and obtain
fresh scoped tokens. Already issued tokens cannot join the new room; they
may still work in the isolated old room until expiry. Existing connections to
old rooms are subject to the lifecycle limit above. This implementation does
not remotely mute or forcibly evict arbitrary modified clients from an old SFU
room, and does not claim immediate JWT revocation at the SFU.

## Test from the academy lab

The cloud's `.cloud/edu` helpers and credentials are local environment state,
not repository files. Set up the lab using the checked-in templates; do not
expect those cloud-specific paths or credentials to exist on the lab PC.

1. Obtain the updated `edu/discord-piazza-ui` branch. Install Python, uv, a
   Node version supported by Vite (Node 24 works), PostgreSQL and LiveKit.
   Follow [the Linux academy setup](academy-lan-deployment.md) for services,
   directories, TLS trust and firewall rules. For an initial test, all services
   can run on one lab PC; the registry must still contain one classroom entry.
2. Run `uv sync --locked --dev`; in `frontend/` run `npm ci` and `npm run build`.
   Configure the app environment and private registry, matching the installed
   SFU's key/secret. Configure Caddy's classroom signaling prefix and trust its
   root CA on every test browser. Media node IP must be reachable by student
   devices; a loopback address works only for same-PC tests.
3. Load the app environment, then run `uv run --locked python madi_run.py --check`
   and `uv run --locked python madi_run.py --create-admin` for a fresh database.
   Startup automatically applies migrations 0007 and 0008; back up existing
   database/uploads before upgrading. `--check` validates settings/build only.
4. Start the services. In the admin UI create a cohort, a normal channel, an
   instructor, and two students with cohort memberships. Use separate browser
   profiles/private sessions for each account, or three physical machines.
   Ensure HTTPS `/health/live` and `/hub/api/health` respond. The SFU configured
   flag alone does not demonstrate media connectivity.
5. Instructor: open cohort/channel, open screen sharing, select the classroom,
   click Connect. Students: open the same channel and click Connect.
6. Both students request sharing. Instructor should see two distinct names
   and a pending count of two. Neither student should be able to publish yet.
7. Allow student one. They click Choose screen and share and select a window.
   Verify actual video on instructor/student two. Student two remains pending;
   the instructor cannot publish while student one is approved.
8. Allow student two. Verify student one's share stops, all normal clients
   rejoin, and only student two can choose/share. Revoke student two and verify
   instructor sharing is available again. Test Deny, request cancellation,
   native picker cancellation, and the browser's own Stop sharing control.
9. Disconnect/reconnect and move the same cohort to another configured lab.
   Verify files, Q&A, messages and memberships persist. Test with students on
   each intended VLAN/Wi-Fi network; this proves actual reachability.

Automated checks from the repository root:

```sh
uv run --locked python -m pytest -q
node scripts/check_js_syntax.mjs
cd frontend
npm test
npm run build
cd ..
node scripts/test_academy_browser.mjs
node scripts/test_presenter_browser.mjs
```

Set `MADI_TEST_DATABASE_URL` to a **separate disposable database** before pytest
so PostgreSQL presenter/session/backup tests actually run; those tests reset
hub tables. The browser scripts require Playwright and an installed compatible
browser, as described in the academy guide. They test built UI and contracts
with mocked APIs (and a mocked SFU for presenter UI), not real video capture.
The live SFU/real device steps above are still necessary on academy hardware.

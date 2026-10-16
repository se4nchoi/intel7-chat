# Academy LAN deployment: one PC, separate services

This is the deployment target for `edu/discord-piazza-ui`. Use a dedicated Linux
PC on the academy network, with PostgreSQL, the Madi application, Caddy, and
LiveKit as separate services. Students only need a browser. No home access or
public internet dependency is intended for classroom operation. Dependency
installation and version updates can use internet access during maintenance.

`madi_run.py` starts the academy application only. It does not load the
community SQLite database, games, or the prototype's demo accounts. The old
`prototype_run.py` remains available for its existing local demo environment.

## Traffic and capacity

```
Academy browser -- HTTPS 443 --> Caddy --> Madi 127.0.0.1:8000 --> PostgreSQL 127.0.0.1:5432
                                 |
                  WSS /media/* --+--> LiveKit :7880 (signalling)
Instructor ---- one video upload ----> LiveKit ----> 20–30 viewers per classroom
                            media: UDP 55000, direct TCP 7881 fallback
```

Each cohort/channel has its own media room and membership check. Instructors
can publish screens; students subscribe. Each join gets its own participant
identity, so a second tab/device does not evict the first viewer. STUN discovers addresses; LiveKit is
the SFU forwarding the instructor's stream to the viewers. A separate public
STUN server is unnecessary for this directly reachable LAN topology.

The screen-share policy requests up to 1920×1080 at 15 fps, detail content,
maintain-resolution encoding, a 4 Mbps ceiling, and the highest receiving
quality regardless of pane size. Lower-resolution sources cannot become 1080p;
browser, CPU and network constraints still apply. Simulcast is disabled to keep
one encoded stream on the instructor PC. LiveKit forwards that stream without
transcoding. Allow roughly **120 Mbps outgoing per 30-viewer class** at the
configured ceiling, plus protocol overhead; actual slide traffic may be lower.
This is a planning calculation, not a measured capacity guarantee.

Use wired gigabit Ethernet on the always-on PC, disable sleep, reserve its IP
in DHCP or configure a static address with the network administrator. A gigabit
port alone does not establish how many classrooms the PC can serve: measure
NIC throughput, packet loss, CPU, memory, and instructor-to-viewer delay with
real classes. Start with one classroom, then add concurrent rooms. No arbitrary
per-IP student/tab cap is introduced by this deployment.

## Prepare the host

Templates are in `deploy/academy/`. They contain `CHANGE_ME` placeholders;
they are not ready to start until the academy IP/DNS and secrets are filled in.
The unit files assume Ubuntu/Debian-style `postgresql.service`; adjust that
dependency for another Linux distribution.

1. Install Python supported by `pyproject.toml`, uv, Node supported by the pinned
   Vite version, PostgreSQL, Caddy, and a tested/pinned LiveKit server binary.
   Keep the installed versions in the host maintenance record; do not silently
   track a latest server image. Put the application checkout in `/opt/madi`.
2. Create dedicated `madi` and `livekit` service users. Give them read access
   to the application/configuration they need. Create `/var/lib/madi/files`
   and `/var/log/madi`, owned by `madi`. Keep uploads outside the checkout.
3. Create a PostgreSQL login `madi` and database `madi` owned by that login.
   Use an operator-chosen password, SCRAM authentication and loopback listening.
   The app applies versioned migrations on startup; do not use a superuser login.
4. In `/opt/madi`, run `uv sync --locked --no-dev`. In `frontend/`, run
   `npm ci` and `npm run build`. Node is used to build assets, not to serve users.
5. Copy `.env.example` to `/etc/madi/madi.env` and replace the placeholders.
   Generate separate database and media secrets. The LiveKit key/secret must
   match `/etc/madi/livekit.yaml`; never expose the secret to browsers. URL-encode
   reserved characters in the PostgreSQL password inside its connection URL.
   Set `MADI_ALLOWED_HOSTS` to the exact address students use, without a port.
6. Copy and fill in `livekit.yaml` and `Caddyfile`. Use the actual reachable
   `10.10.x.x` address for `rtc.node_ip`, never `127.0.0.1`. Keep
   `use_external_ip: false` so public STUN discovery does not replace it.
   Give `livekit` read access to its secret config; give `madi` read access to
   the environment file. Keep both files mode 0640 or more restrictive.
7. Load the environment in a private operator shell (the supplied template is
   compatible with `set -a; . /etc/madi/madi.env; set +a`). Run the following
   as `madi` before enabling the service:

   ```sh
   /opt/madi/.venv/bin/python /opt/madi/madi_run.py --check
   /opt/madi/.venv/bin/python /opt/madi/madi_run.py --create-admin
   ```

   `--check` validates configuration and the frontend build only. It does not
   claim database/media connectivity. `--create-admin` prompts for credentials,
   migrates PostgreSQL, and refuses to create another administrator if one
   already exists. Create instructor/student accounts and cohorts in the UI.
8. Install the two service units in `/etc/systemd/system`, reload systemd, and
   enable/start `madi`, `madi-media`, and Caddy. Configure Caddy with its normal
   system service and persistent data directory so its internal CA survives
   reboots. Validate its config with `caddy validate` before restarting it.

## Network and browser prerequisites

Restrict access using the host firewall and academy network ACLs to the actual
academy client subnets. A private IP does not itself enforce LAN-only access.
Allow client TCP 443 to Caddy, UDP 55000 and TCP 7881 directly to LiveKit. Keep
8000, 7880 and PostgreSQL unavailable to client PCs. LiveKit's signalling bind
address also affects media listeners, so the template uses a wildcard bind and
requires a firewall rule to protect 7880. Do not put ICE media behind Caddy's
HTTP proxy. See [LiveKit's port reference](https://docs.livekit.io/transport/self-hosting/ports-firewall/).

Caddy's `tls internal` creates a local CA. Distribute and trust its **root
certificate** on each classroom PC/browser before use; never distribute its
private key. HTTPS screen capture requires a trusted secure context; clicking
through certificate errors is insufficient preparation. An academy-managed
trusted certificate can replace `tls internal`. See [Caddy's HTTPS documentation](https://caddyserver.com/docs/automatic-https/).

Verify reachability from every classroom/floor/VLAN. Test TCP 443 and actual
UDP video traffic: a working login or ping does not prove media reachability.
The final IP, certificate distribution and cross-floor ACLs are still unknown.

## Verification and operation

- `/health/live` reports that the app is responding. `/hub/api/health` checks
  PostgreSQL. Its `sfu_configured` flag means credentials exist, not that a
  LiveKit connection has been tested.
- Test instructor publish, late join, cancellation during join, browser screen
  picker cancellation, switching cohorts/channels, and disconnect/reconnect.
  Confirm students cannot publish and cannot access another cohort's media token.
- Compare source and received slide text at normal/fullscreen sizes; measure
  actual resolution and delay from 20–30 simultaneous viewers before adding
  another concurrent classroom. Include a client on every intended subnet.
- Run **one Madi application worker**: its WebSocket registries are in memory.
  More app workers require shared event delivery first. Separate media rooms
  support concurrent classes, but do not imply unlimited hardware capacity.
- An application restart disconnects chat sockets; browsers reconnect. Media
  uses a separate service, so an app restart does not directly tear down an
  established SFU connection. Restarting LiveKit disconnects active broadcasts.
  Schedule upgrades during breaks and keep the previous release/build available.
- Use `python -m app.hub.backup --help` for existing backup/verify/restore tools.
  Back up PostgreSQL **and** uploads, plus secret configs and Caddy CA state.
  Copy backups to another device and test restoration to a disposable database.
  A second folder on the same PC is not protection from disk failure.

## Move media later

Install LiveKit on the second host with the same API credentials. Set its
`rtc.node_ip` to that host's academy address, permit its media ports from the
classroom subnets, and change Caddy's `/media/*` upstream to that host's 7880.
Allow that signalling port only from the Caddy host. The browser-facing
`MADI_SFU_URL` can remain unchanged. Existing rooms do not migrate between
single-node servers: perform this move during a break and have users reconnect.
Alternatively give the new host its own trusted HTTPS/WSS endpoint and change
`MADI_SFU_URL`; restart Madi to apply its CSP allowlist too.

This deployment has no Redis cluster, recording/transcoding service, or second
server requirement. Add distributed components when measured load requires them.

## Development verification (2026-10-16)

The Python regression suite passed (308 tests, 60 PostgreSQL integration tests
skipped because no disposable database was configured). The subsequent seven
media-token tests passed for room scope, publishing permissions and independent
tab identities. All eight media lifecycle tests (`cd frontend && npm test`) and
the frontend production build passed. The patched npm lockfile audit reported
zero vulnerabilities at that time.

The optional `node scripts/test_academy_browser.mjs` smoke test passed in Chrome
against the standalone application and built frontend, using mocked migrations,
API responses and chat sockets. It checked boot/channel loading, loading the
LiveKit SDK chunk under the CSP, cancelling a pending join, and a retryable media
failure state, with no JavaScript or CSP errors. Set `PLAYWRIGHT_MODULE_PATH` if
Playwright is supplied by an external runtime; `MADI_BROWSER_CHANNEL=chromium`
uses Playwright's installed browser instead of the default installed Chrome.

These checks did **not** run PostgreSQL migrations against a real database,
start Linux systemd/Caddy/LiveKit, or measure real 1080p forwarding to a class.
Those remain deployment acceptance checks on the target host/network.

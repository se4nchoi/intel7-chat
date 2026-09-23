# Classroom edition architecture

Status: historical classroom-local proposal. The current central-hub rework is
recorded in [architecture-rework.md](architecture-rework.md); its deployment and
data decisions supersede conflicting proposals here. No runtime changes were
implemented by this document.

## Scope and capacity contract

Each installation serves one classroom LAN. Installations share release packages,
not accounts, databases, storage, or availability dependencies. Repeating the
installation in another classroom requires configuration, not a source fork.
Internet access is optional for core operation; external AI is an explicit extension.

Initial engineering targets, to be verified on actual classroom equipment:

| Workload | Pilot target | Expansion test target |
| --- | --- | --- |
| Concurrent authenticated users | 40 | 100 |
| Chat WebSocket connections, including extra tabs | 100 | 250 |
| Screen presentation | 1 presenter, 40 viewers | 1 presenter, 100 viewers |
| Additional presentation scenario | Presenter handoff | 2 rooms with 50 viewers each |
| Chat load | 5 messages/s sustained; 50/s for 10 seconds | Same load under concurrent media and file transfers |
| Quiz submissions | 40 within 5 seconds | 100 within 5 seconds |
| Concurrent uploads | 4 per installation, 2 per user | Tuned from disk and network measurements |

These are acceptance workloads, not advertised capacity. They do not require
supporting all classes on a central installation. Multiple browser tabs count as
connections, not additional people.

## Deployment topology

Default: a modular FastAPI application, one application process, local SQLite WAL,
local SSD file storage, and an HTTPS reverse proxy. A supervised background worker
handles slow jobs. An optional local SFU handles classroom screen broadcasting.
All components can initially run on the same host.

```text
Classroom browsers
  |-- HTTPS / chat WSS --> HTTPS proxy --> FastAPI application
  |                                         |-- SQLite WAL (local disk)
  |                                         |-- private file storage
  |                                         |-- durable job records --> job worker
  |
  |-- media signaling / WebRTC --> optional local SFU
                                     |-- optional TURN fallback
```

Media bypasses the Python application. The application controls access and grants
presentation rights; the media server transports video. Large file transfer,
screen broadcast, and chat are separate workloads with separate limits.

For the pilot, preserve the current Windows host option. Validate SFU packaging
on a supported runtime before committing to a Windows installer; a dedicated
Linux host or Linux VM is the proposed appliance option for the media-enabled
edition. Container packaging simplifies updates but does not solve UDP routing,
VM networking, host sleep, certificate trust, or firewall configuration.

Use an institution-controlled hostname with DNS resolving to the host's LAN IP.
Certificates must be trusted by the actual browsers: an institution-managed CA
or an appropriate publicly trusted certificate. Certificate renewal must be part
of installation operations. Do not depend on insecure-origin browser flags.
Expose only the documented HTTPS and media ports to the intended LAN; PostgreSQL,
Redis, and application internals remain private if introduced later.

## Application boundaries

Use an application factory, explicit configuration, and injected services. Router
modules must stop importing `app.main` for shared globals and utilities.

```text
app/
  bootstrap.py           application factory and module registration
  core/                  configuration, identity, permissions, migrations
  modules/
    chat/                channels, DMs, messages, reactions, presence
    files/               upload sessions, quotas, attachment authorization
    screenshare/         presentation policy and media access
    learning/            courses, banks, revisions, assignments, attempts
    administration/      accounts, operations, backups, audit events
    recreation/          optional games and recreational titles
  infrastructure/
    database/            explicit repository implementations
    realtime/            socket registry, delivery queues, event adapters
    storage/             local storage adapter; remote adapter if required
    jobs/                durable job runner
  editions/              community and classroom manifests
```

Classroom and community builds come from one mainline. Use a temporary refactor
branch and versioned releases, rather than a permanent edition branch. Backend
module registration, frontend imports, templates, dependencies, and startup jobs
all follow the edition manifest. Frontend feature visibility is not authorization.

The classroom package must start without game dependencies installed. Quiz
identity and badges must not import game statistics. Existing community databases
retain their historical game tables; disabling a module never deletes user data.
Pilot deployments use fresh data directories unless an explicit migration is run.

## Durable data and access control

One installation is the classroom boundary. Do not introduce facility tenancy
yet. Use course/cohort membership to handle successive cohorts and instructor
assignments on the same installation.

- Global administrator: accounts, configuration, operations.
- Instructor: assigned courses, materials, quiz publication and results.
- Student: enrolled course participation and personal results.
- Every channel, material collection, and quiz assignment belongs to a course.
- Course membership checks apply to HTTP, WebSocket subscriptions, file access,
  search, exports, and media-token issuance.
- DMs retain participant-only authorization and can be disabled by policy.

Suggested learning entities: `courses`, `course_memberships`, `question_banks`,
`question_revisions`, `quiz_assignments`, `assignment_questions`, `attempts`, and
`attempt_answers`. Assignments reference immutable question revisions. Attempts
store the grading rule/version and awarded result; published edits create a new
revision rather than rewriting completed attempts. Role and membership changes
invalidate relevant cached access and active subscriptions.

Use explicit foreign keys and indexes for real access paths: conversation plus
message ID, course membership, assignment plus student, and upload status plus
expiry. Do not put a facility ID on every table for a hypothetical future service.

## Realtime delivery and process scaling

Current constraints found in source:

- `app/main.py`: 50 total chat connections and 4 per IP.
- `run.py`: Uvicorn concurrency limit of 60; audit this together with socket limits.
- `broadcast()` awaits each socket send sequentially.
- Socket registries, rate limits, and screen sessions are process-local.
- SQLite WAL is already initialized in `app/db/migrations.py`.

Replace direct fan-out with one bounded outbound queue and one writer task per
connection. Start with 128 events and a 1 MiB byte ceiling per connection, both
configurable. Coalesce disposable presence/typing events; when reliable events
cannot be queued, disconnect the slow client and require resynchronization.
Do not silently drop durable messages or allocate unlimited send tasks.

Message flow:

1. Authenticate and authorize the conversation; enforce account limits.
2. Accept a client request ID unique per sender to deduplicate retries.
3. Commit the message and its durable event/outbox entry together.
4. Acknowledge persistence with the server message ID.
5. Dispatch to authorized subscribers through bounded queues.

Delivery is at least once; clients deduplicate by event ID. A durable cursor API
supports reconnection and edits/deletions, not just new message history. Subscribe
and buffer live events before catch-up to a captured high-water mark, then dedupe
and drain. If a cursor has expired, return a full-resync instruction. Outbox
dispatch retries after process crashes; successful socket sends are not evidence
that a human read a message.

Keep ephemeral presence in memory for the single-process edition. Use connection
leases/timeouts, jittered reconnection, and per-account connection limits. Retain
IP limits as an abuse signal, not a count of people. Behind a reverse proxy, trust
forwarded addresses only from that proxy, otherwise every client may appear to
have the same IP or may spoof a forwarded identity.

Keep synchronous DB and disk work off the async event loop using bounded thread
execution or suitable asynchronous adapters. Keep transaction scope short. Slow
AI generation, imports, exports, checksums and backup work belong in the job runner.

Do not enable multiple application workers until shared state has been designed.
If measured application load requires them, introduce Redis for cross-process
fan-out, expiring presence, distributed limits, and presentation coordination.
Each process still owns its actual sockets. Redis Pub/Sub is only live transport;
the database event log remains the recovery source. Run migrations once per
deployment and supervise job claims to avoid duplicate startup jobs.

## Screen broadcast

Define a small application-facing media interface: create/end presentation,
grant presenter/viewer access, revoke participant, and inspect health.

Retain peer-to-peer sharing as the lightweight pilot backend, with a measured
viewer limit. Add a locally hosted SFU backend for larger audiences; LiveKit is
a candidate to validate, not a dependency adopted by this design. The frontend
will need the selected provider's client integration; this is more than replacing
the existing signaling URL.

For the SFU backend, the app grants short-lived tokens scoped to a room and role.
Viewers cannot publish; instructors may grant a student a presentation turn.
Serialize presenter changes with a lease/version so concurrent starts cannot
replace each other unpredictably. Revocation calls the media server to remove
access; token expiry alone does not terminate an existing connection. Provider
events must be authenticated and reconciled after restart.

Start quality testing with readable 1080p text at 10-15 fps; separately test moving
video or CAD content. Bitrate, codec and browser behavior determine actual load.
For illustration only, a single 3 Mbps stream sent to 40 viewers means about
120 Mbps aggregate SFU egress before overhead. The presenter's SFU upload is
approximately one stream (more if multiple encodings are enabled); direct
peer-to-peer sharing duplicates that traffic at the presenter. An SFU shifts the
fan-out but does not remove LAN or Wi-Fi airtime demand.

Prefer a wired server. Test the actual AP, client isolation and inter-device
reachability. TURN is an optional measured connectivity fallback; configure it
with bounded credentials and quotas. A normal HTTP reverse proxy does not carry
the WebRTC UDP media path. Core same-LAN operation should not require Google's
public STUN service or another external service.

## File transfer and background work

The existing upload handler streams bytes, but holds one global lock across the
entire transfer and writes files synchronously inside an async handler. Its default
per-file limit is 50 MiB. Remove whole-transfer serialization without removing
quota correctness.

Proposed upload protocol:

1. Create an authenticated upload session with declared total size.
2. Atomically reserve quota against committed bytes plus active reservations.
3. Transfer bounded chunks at verified offsets to a private temporary file.
4. Resume through a server-reported offset; retries cannot append duplicate bytes.
5. Verify total size and checksum, apply configured validation/scanning, then
   atomically move the file and finalize metadata.
6. Reconcile interrupted finalization; expire abandoned sessions and reservations.

Bound concurrent uploads by user and server, enforce actual streamed bytes, and
reserve disk headroom for the database. Database state and filesystem moves are
not one atomic transaction: use explicit states and a recovery job. Files remain
unavailable until ready. Downloads use range requests and recheck authorization;
never expose the uploads directory as a public static mount.

VM images belong in an optional instructor-managed materials library with larger
quotas. Local storage is the initial backend; NAS/object storage integration can
follow when needed. Keep the SQLite database on local disk, even when files move
to NAS. File throughput limits should leave bandwidth for live teaching.

Use durable `jobs` records with type, state, attempts, lease expiry, progress and
an idempotency key. One worker claims jobs with short transactions, renews leases,
and safely retries after failure. No transaction stays open while contacting an
AI service or processing a file. Start with one expensive job at a time.

## Scaling decisions and failure behavior

| Measured bottleneck | First response | Further upgrade |
| --- | --- | --- |
| Presenter upload/CPU or video loss | Lower fps/quality; check LAN | Local SFU |
| File traffic disrupts live teaching | Bound transfers and reserve disk space | Dedicated storage/network capacity |
| DB busy errors or write latency | Short transactions, indexes, bounded jobs | PostgreSQL repository implementation |
| Application event-loop lag | Remove blocking work and unbounded fan-out | Shared-state design, then multiple workers |
| Wi-Fi congestion | Wired presenter/server; AP/network changes | More appropriate network capacity |

There is no automatic database migration at a particular student count. SQLite
WAL supports concurrent readers and one writer; PostgreSQL is justified by measured
write contention or operational requirements. A storage adapter does not eliminate
SQL migration work: PostgreSQL support requires tested queries, constraints,
migrations and transaction behavior.

Chat and learning continue when the SFU fails. AI failures leave generation jobs
failed/retryable without affecting published quizzes. Storage exhaustion rejects
new uploads with a useful error before it prevents chat database writes. The
single-host edition has no high availability: a host outage interrupts service.
Automatic restart and tested restore improve recovery, not uninterrupted uptime.

Back up database, ready file blobs and required configuration as a consistent
generation, using SQLite's backup API and coordinated file retention. A database
copy alone is insufficient. Keep a second copy off the host and test restores.
Suggested pilot objectives: daily backup (up to 24-hour recovery point) and a
documented one-hour restore target, validated by a drill.

## Verification and rollout

First inventory actual class size, host hardware, network speed, browser versions,
and expected file sizes. A wired 4-core/8-GiB/SSD host is a benchmark starting point,
not a guarantee; media and file storage may require more resources.

Proposed acceptance goals under the combined pilot workload:

- p95 chat persistence acknowledgement below 300 ms on the LAN.
- p95 non-file API response below 500 ms; quiz submission below 1 second.
- p95 screen-share join below 5 seconds; readable course text and measured latency
  appropriate to the lesson, provisionally below 1 second.
- No lost acknowledged messages or duplicate attempts after reconnect/retry.
- No unbounded queue or memory growth during a two-hour teaching session.
- Recovery from one slow client, interrupted upload, SFU restart and app restart.

Use synthetic clients for chat, uploads and quizzes; use real browser media clients
for presentation quality tests. Test full-class simultaneous login, submission,
downloads, presenter handoff, and network reconnect. Record CPU, memory, event-loop
lag, DB busy events, queue occupancy, job delay, disk space, network throughput,
media loss/RTT and user-visible timings. Include the instructor's weakest expected
PC and actual classroom Wi-Fi in testing.

Implementation order:

1. Capture baseline measurements; extract app factory and shared services.
2. Introduce edition manifests and isolate recreation dependencies.
3. Add course-scoped instructor permissions and immutable quiz revisions.
4. Fix realtime queues/recovery, account limits and upload reservations.
5. Package HTTPS, service startup, backup/restore, jobs and basic health diagnostics.
6. Run the pilot acceptance workload; add the SFU if peer-to-peer misses targets.
7. Test expansion workloads and add PostgreSQL/Redis only for demonstrated needs.

## References

- Current implementation: `app/main.py`, `run.py`, `app/screenshare.py`,
  `app/static/js/screenshare.js`, `app/routers/files.py`, `app/db/migrations.py`.
- SQLite WAL concurrency and local-filesystem constraints:
  https://www.sqlite.org/wal.html
- FastAPI process memory and deployment model:
  https://fastapi.tiangolo.com/deployment/concepts/
- Candidate SFU deployment and network requirements:
  https://docs.livekit.io/transport/self-hosting/deployment/

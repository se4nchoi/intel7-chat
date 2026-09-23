# BambooChat rework: proposed architecture

Status: working decisions and open deployment questions, 2026-09-23. This
records the goals discussed for the `edu/prototype` worktree. It is not a
record of decisions made on the other PC.

## Goals

- Distinct administrator, instructor, and student experiences. The
  administrator performs initial setup and oversees the service.
- One hub for identities and durable data, with cohort-scoped entry and access.
- Reach classrooms across two or three floors on a private network.
- Keep identities and histories across cohorts and classroom changes.
- Combine live chat and screen sharing with persistent Q&A and file sharing.

## Proposed decisions

1. **One central application and data authority.** Browsers connect to a hub.
   Cohort-specific URLs and views select context, while the server enforces
   permissions on every HTTP, WebSocket, file, and search operation. Begin as a
   modular application rather than independent services for each floor or
   cohort. Classroom devices access data through the application over HTTPS;
   they do not connect directly to the database.
2. **Global identity, scoped membership.** A person has one durable account.
   `cohorts` and `cohort_memberships` relate that account to current or archived
   cohorts. Role is scoped to the cohort: an instructor may teach several
   cohorts; a student may have current and past memberships. Cohort membership,
   not URL choice, grants access.
3. **Three service roles with bounded authority.** The administrator handles
   first setup, system configuration, service health, audit/usage visibility,
   account recovery, and backup/restore. Instructors manage their cohorts,
   membership, moderation, Q&A, and teaching files, with no system-wide
   configuration rights. Students participate in their assigned cohorts. The
   administrator's visibility into private content needs an explicit policy and
   audit trail; service health and usage counts need not imply access to every
   private message.
4. **Cohort-owned content.** Channels, messages, Q&A threads, answers, and files
   belong to a cohort. Default access is limited to its members. Archive a
   cohort without deleting its history. Define a deliberate rule for cross-
   cohort direct messages and for access after a member leaves.
5. **Durable knowledge alongside live conversation.** Chat remains the quick
   timeline. Q&A has questions, answers, instructor endorsement or accepted
   answers, tags, and search. Files have stable records, owners, cohort scope,
   and links from chat or Q&A. Screen-share sessions and signaling are temporary;
   recording is a separate policy decision.
6. **PostgreSQL for the central store.** SQLite served the MVP well. Prototype
   the shared model on PostgreSQL. Keep its active data on storage local to its
   database server. A NAS may hold uploaded files and tested backups; do not
   put an SQLite database on an SMB/NFS share for multiple hosts to open. Keep
   prototype database and file storage separate from the live service.
7. **Portable deployment target.** A sellable deployment may run in a cloud
   environment or on academy-provided on-premises equipment. Keep the same
   application and data model for either, with deployment-specific configuration
   for DNS, certificates, storage, backup, and networking. A deployed product
   must remain available without an instructor starting a classroom PC, including
   for students looking up material from home. Cloud hosting is likely unless
   the academy provides and operates suitable on-premises equipment. Do not
   purchase or provision production hosting before funding and deployment
   requirements are established. PostgreSQL on the current classroom PC would
   not make that PC an always-available hub.
8. **Design for the building network and an SFU.** Floors 3 and 9 are in use;
   floor 8 is expected next year. First determine whether their lab networks
   can route to a common hub, what DNS and firewall rules exist, and whether
   they have usable internet access. Serve the browser app over HTTPS; browser
   screen capture requires a secure context. The current screen-share code
   makes one WebRTC peer connection per viewer and uses a public STUN server.
   Plan an SFU for classroom-scale streaming, but choose its host and any
   internal TURN service after the network survey and representative testing.
9. **Migrate in stages.** Build and validate the new permission model and
   persistent content in the separate prototype. Import a copy of live data
   into an isolated test database, preserving account and content mappings.
   Rehearse migration and rollback before any production cutover.

## Current code to reuse or revise

- Reuse: FastAPI/WebSocket app, account/session logic, persisted chat, upload
  controls, and browser screen sharing.
- Revise: global `admin`/`student` roles, global channels, SQLite storage,
  permission checks across routes and WebSockets, and peer-per-viewer screen
  sharing for large rooms.

## First milestone: isolated local architecture proof

Use the `edu/prototype` worktree and separate configuration, database, files,
ports, and media credentials. Leave the running LAN service and its data alone.
No paid hosting is needed for this stage.

As of 2026-09-23, the `/hub` prototype has local HTTPS, PostgreSQL-backed
accounts/cohorts/chat/Q&A/file metadata, and a local LiveKit SFU behind a WSS
proxy. A two-browser publish/subscribe probe passed. The older `/` UI still
uses isolated SQLite; this milestone proves the replacement architecture,
not a complete migration of every older feature. See `prototype-local.md`.

1. **HTTPS:** run the prototype through local TLS with a trusted development
   certificate. Verify page loading, secure cookies, WebSockets (`wss://`), and
   browser screen capture. Test on this PC first; a second LAN device needs
   its own certificate trust setup.
2. **PostgreSQL:** run a local instance and make the prototype's persistence
   layer, migrations, and tests use it. The current app calls SQLite directly,
   so installing PostgreSQL alone does not complete this step. Keep it bound to
   loopback during single-PC development.
3. **SFU:** run a local development SFU, connect the prototype's presenter and
   viewer clients, and issue role-scoped media tokens from the app. The current
   peer-per-viewer screen-share code needs integration changes. Use at least two
   browser clients to verify publish, view, stop, and authorization.
4. **Combined proof:** run HTTPS, app, PostgreSQL, and SFU together without port
   or storage overlap with the live service. Restart the components and verify
   that chat and files persist while an active screen share ends cleanly; add
   Q&A persistence to this check when that feature exists.

This proves software integration. It does not prove cross-floor routing,
classroom Wi-Fi capacity, certificate trust on unmanaged student devices, SFU
capacity, home access, or production uptime.

## Later milestone: cross-floor secure hub

1. Map the subnets/VLANs, routing, firewall rules, Wi-Fi capacity, DNS, and
   available server/NAS equipment on floors 3 and 9; include the planned floor
   8. Record who controls each network component and whether the academy can
   issue or install trusted certificates on student devices.
2. Establish one stable HTTPS application hostname reachable from each lab.
   If the academy controls a public domain and can automate DNS validation, a
   public certificate may work for an internal-only service. Otherwise assess
   an academy-managed CA and device trust deployment. Do not assume an HTTP
   private-IP address will permit screen capture in browsers.
3. Stand up an isolated PostgreSQL instance and an application instance.
   Allow database connections from application hosts only, with authenticated
   encrypted connections where the network crosses hosts. Students and
   instructors reach the application, not PostgreSQL.
4. Verify login, cohort isolation, chat/WebSocket delivery, file transfer, and
   one screen-share flow from representative devices on each floor. Measure
   latency, throughput, and simultaneous viewers before sizing the SFU.

### HTTPS address options

A purchased/public domain is not required for the prototype. The current host
can run an HTTPS proxy in front of the existing HTTP application, using an
internal hostname or a private IP address with a certificate issued by an
academy-managed CA. Every classroom device must trust that CA, and the
certificate must cover the exact name or IP address used in the browser. A
self-signed certificate with a browser warning is not a dependable solution for
screen capture.

If the academy already controls a public domain, a subdomain can resolve to a
private LAN address on the classroom network. DNS-01 validation can obtain a
publicly trusted certificate without exposing the application itself to the
internet. This is operationally simpler for devices that the academy cannot
manage, provided DNS and certificate renewal can be automated. Public CAs
cannot issue certificates for reserved/private IP addresses or internal names.

## Prototype checkpoints

1. Model account, cohort, membership, and scoped authorization. Demonstrate
   that a student cannot fetch another cohort's channel, file, Q&A, search
   result, or WebSocket event by guessing an ID or URL.
2. Add persistent Q&A and cohort-scoped files using a separate prototype store.
3. Test real classroom connectivity and SFU screen sharing with representative
   device and viewer counts across floors.
4. Rehearse import, backup/restore, and cohort archive/access behavior with a
   copy of data before considering production migration.

## Questions to settle

- How many cohorts, concurrent users, and screen-share viewers per classroom?
- Can students see past cohorts after leaving? Can instructors see all past
  cohorts? Are cross-cohort DMs allowed?
- Which administrator diagnostics are needed, and when may an administrator
  inspect private content? What instructor actions require approval?
- What server/NAS hardware, subnets, DNS, certificate management, and backup
  facilities are available? Must the system run with no internet at all?
- What downtime is acceptable during a host or power failure, and who will
  operate the eventual cloud or academy server and restore data?
- Should screen sharing be view-only, and should any session be recorded?

## References

- SQLite cautions against accessing one database over a network filesystem:
  https://www.sqlite.org/useovernet.html
- PostgreSQL client/server architecture:
  https://www.postgresql.org/docs/current/tutorial-arch.html
- Screen capture and secure contexts:
  https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
- WebRTC scaling and SFUs:
  https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Protocols
- DNS challenge for certificates on internal-only hosts with a public domain:
  https://letsencrypt.org/docs/challenge-types/
- PostgreSQL connection rules and encrypted connections:
  https://www.postgresql.org/docs/current/auth-pg-hba-conf.html
- Public certificate restrictions on internal names and private IP addresses:
  https://cabforum.org/working-groups/server/baseline-requirements/requirements/
- Local SFU development server:
  https://docs.livekit.io/transport/self-hosting/local/
- PostgreSQL Windows installer:
  https://www.postgresql.org/download/windows/

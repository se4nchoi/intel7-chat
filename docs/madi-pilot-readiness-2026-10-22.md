# Madi academy pilot readiness — 2026-10-22

This is an acceptance checklist for a small academy LAN pilot, not a claim that Madi is deployed. Keep the existing single-host FastAPI/PostgreSQL architecture and separate LiveKit service for the pilot. Do not move real class data into a test database.

## Verified in this checkout

- [x] `edu/madi` frontend: 40 unit tests and production build pass.
- [x] Windows Python unit suite: 329 passed, 101 skipped. The skips include PostgreSQL integration tests because this checkout has no `MADI_TEST_DATABASE_URL`.
- [x] Disposable loopback browser smokes (mocked API/database): academy boot/media failure, notification deep link and draft preservation, roster onboarding, presenter handoff, and Q&A queue/composer workflows pass. These are not real PostgreSQL, LAN, or LiveKit tests.
- [x] Read-only dependency checks: `npm audit` found 0 vulnerabilities; `pip-audit` found no known vulnerabilities in the isolated Windows test environment. The Python environment was resolved from `pyproject.toml`, so this is not a substitute for auditing the exact locked deployment build.
- [x] The validation job in [CI run 39793208838](https://github.com/se4nchoi/intel7-chat/actions/runs/39793208838) passed on `edu/madi`: 430 Python tests passed with no skips against disposable PostgreSQL, including backup/restore tests; the frontend tests/build and JavaScript syntax check also passed. The workflow runs on `edu/madi` and `main`.

## Gate 1 — database-backed release validation

- [x] Run `.github/workflows/ci.yml` against disposable PostgreSQL, including the equal-timestamp queue cursor test, role/DM authorization, migrations, and backup/restore round trip. Never point `MADI_TEST_DATABASE_URL` at an academy or personal database; integration fixtures drop all `hub_*` tables.
- [ ] Run a browser pass against a **separate disposable PostgreSQL database** with synthetic student, instructor, and admin accounts. Cover question/answer drafts, file selection and failed upload retry, notification-to-answer focus/read state, queue sort/pagination, roster review/apply, archived cohort read-only behavior, light/dark themes, and 390px/desktop layouts.
- [ ] Rehearse backup, verification, and restoration of both PostgreSQL and uploaded bytes into a fresh disposable target. Confirm the restored app can read a question, message, and file. Keep a copy of the backup on another device.

## Gate 2 — academy host and network

- [ ] Agree on the always-on host, operator, DNS/address, academy client subnets, firewall rules, and certificate trust with the academy network administrator. The current Windows checkout is development-only; the supplied academy service templates target Linux.
- [ ] From a client on every intended floor/lab, verify trusted HTTPS login and WSS chat. Check that PostgreSQL, FastAPI's internal port, and LiveKit signaling's internal port are not directly reachable from client PCs.
- [ ] With one real class first, test screen publishing, late join, presenter approval/revocation, reconnect, and readable PLC text at normal/fullscreen sizes. Record actual resolution, delay, packet loss, CPU, memory, and network use with the planned 20–30 viewers before adding concurrent classes. A successful login is not proof of UDP media reachability.
- [ ] Demonstrate restart and rollback during a break: chat reconnect, LiveKit session interruption behavior, previous release availability, and a verified backup. Name who will respond to a failed class-day startup.

## Pilot decision

Start with one instructor/cohort and a small group. Expand to other rooms only after Gates 1–2 and a short trial show that joining, asking, downloading, and screen viewing work from those rooms. Record any repeated classroom friction before adding quote replies, tags, or more infrastructure. Scoped chat search (U10) is the next feature increment; it is not a substitute for these release gates.

See [academy deployment](academy-lan-deployment.md), [classroom media](classroom-media.md), and the [UX/UI plan](madi-ux-ui-review-plan-2026-10-21.md) for detailed configuration and acceptance cases.

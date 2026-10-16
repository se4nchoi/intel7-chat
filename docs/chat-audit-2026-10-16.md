# Chat app audit — 2026-10-16

This is a source review with automated regression checks, covering screen sharing,
WebSocket delivery/reconnection, authentication, uploads, database access, message
rendering, and CI. It is not a classroom load test or a measured latency benchmark.

## Implemented

- Fixed a regression in the new delivery queue: reconnect history can contain more
  than 128 events across public chat and multiple DMs. Initial history now waits
  for the writer to drain each frame, instead of overflowing the live-event queue
  and disconnecting a healthy client before its user list or screen-share state
  arrives. A regression test reproduces 50 public messages plus 120 DMs, verifies
  full history and user-list delivery, then starts screen sharing on that socket.
  Queue overflow and delivery failures now produce warning logs with no payloads.

- Added an accessible Korean status overlay for connecting, waiting for the first
  frame, reconnecting, server disconnects, blocked playback, and exhausted retries.
  Failed connections have a persistent retry button; blocked playback has a play
  button that preserves the existing connection.
- Kept the first-frame watchdog running after WebRTC transport connects. Previously
  a connected transport canceled recovery even when no video had started playing.
- Limited capture to 15 fps for slide sharing, preferred H.264 where supported,
  and added a shared 20 Mbps presenter upload budget. Per-viewer ceilings range
  from 400 kbps to 1.5 Mbps as the audience changes, with balanced adaptation.
  These are encoding hints, not measured network utilization or a latency guarantee;
  full-class picture quality and delay still need validation on classroom PCs.
- Requested a 50 ms receive jitter-buffer target where supported. This is a browser
  hint, not a guaranteed end-to-end delay. Unsupported tuning falls back to the
  browser's defaults.
- Restored the original `stun:stun.l.google.com:19302` connectivity fallback after
  viewers reported remaining black/connecting following the host-only change.
  The host-only assumption was not validated on classroom PCs. Restoration is a
  compatibility rollback; the cause still needs confirmation on affected clients.
  Isolated Wi-Fi clients or blocked peer traffic may still require network changes
  or a configured TURN relay.
- Installed a lifespan-scoped asyncio handler for exactly Windows error 10054 in
  `asyncio.proactor_events._ProactorBasePipeTransport._call_connection_lost`.
  It logs that teardown reset at debug level and delegates all other errors to the
  previous/default handler. It mitigates traceback noise; it cannot prevent a
  browser, firewall, or network from resetting TCP connections. The original handler
  is restored at shutdown. No Python runtime files or global loop policies changed.
- Added connection/playback/retry regression coverage and enabled the screen-sharing
  lifecycle suite in CI.

## Findings and follow-up status

| Priority | Evidence | Effect and next improvement |
| --- | --- | --- |
| P1 | `app/static/js/screenshare.js`: one presenter `RTCPeerConnection` and sender per viewer | Presenter encoding and upload costs grow with the audience. At the configured ceiling, 20 viewers could require roughly 60 Mbps of media upload plus overhead. Measure CPU, actual bitrate, RTT, packet loss, and encode/decode delay at 1/5/20 viewers; use an SFU if direct fan-out exceeds classroom hardware/network capacity. |
| Fixed | `app/main.py`: `broadcast`, `send_to_user_id`, `send_to_username`, and screen-share signaling await socket writes sequentially | Accepted chat and game sockets now use one ordered writer with a 128-event / 1 MiB outbound queue. Overflow or a five-second send timeout disconnects that client with code 1013. No unbounded send tasks are created. Reconnection uses existing history synchronization; this does not add a durable event cursor or persistence acknowledgements. |
| Fixed | `app/main.py` chat/game sockets authenticate at connect; only screen-share messages explicitly revalidate the session in the chat receive loop. `app/routers/auth.py:logout` deletes the token without closing its sockets | Chat and all four game sockets now track the session hash, validate before outbound delivery and after inbound receive, and check idle sessions every ten seconds. Logout immediately closes the session's sockets; administrator disconnects include games. The existing one-session-per-account login policy is preserved. |
| P2 | `app/db/connection.py`: synchronous SQLite with a five-second busy timeout; async handlers call database functions directly. `app/routers/files.py:upload_file`: synchronous writes inside an async upload loop and one global upload lock | Database contention or slow disks can pause unrelated signaling/chat work; a slow upload holds the upload lock for its whole duration. Move complete database transactions and file I/O to bounded workers; preserve quota reservation/atomicity if uploads become concurrent. Password hashing and AI generation already use worker threads. |
| Fixed | `app/static/js/ws.js`: public and DM message handlers previously always set `scrollTop = scrollHeight` | Channel and DM traffic now follows the bottom only when within 80 px or after a live message from the current user. Readers away from the bottom get a counted jump-to-latest button. Own history replay does not force a jump. Read acknowledgements and active-room unread clearing also respect reading position. |
| Fixed | `app/static/js/ws.js`: `onopen`, `onclose`, and `onerror` guard against stale sockets; `onmessage` does not | Message dispatch now ignores replaced sockets. Explicit reconnect cancels pending reconnect timers; retries use exponential backoff with jitter. A synchronous send failure returns false so the composer retains its content. Game socket callbacks also ignore replaced connections and stop automatic retries on policy/session rejection. |
| Fixed for community scope | `app/main.py` limiter registries and connection admission; authentication routers | For the trusted 23-person LAN, removed the four-chat-connections-per-IP cap while retaining the 50-chat-connection server ceiling. Expired timestamp buckets are cleaned every minute, using each limiter's own window and preserving active budgets. Password hashing/verification is queued behind four server-wide slots, including registration and administrator changes. Request cancellation holds its slot until native work finishes. Existing attempt/message/upload limits remain; no aggregate IP throttle or per-account tab limit was added. |

Existing protections include same-origin mutation/WebSocket checks, authenticated
attachment visibility, escaped DOM-based Markdown rendering, Argon2 password
verification off the event loop, and tests for DM screen-share privacy and signaling
ownership. These do not replace the follow-ups above.

## Validation

- Python suite: **359 passed, 2 xfailed**.
- Screen-sharing JavaScript suite: **11 passed** (including classroom bitrate sharing, first-frame watchdog,
  visible connection status, recovery after retry exhaustion, autoplay recovery,
  per-viewer sender limits, and disconnect state).
- Chat reliability JavaScript suite: **7 passed** (reading position, own/history messages, indicator reset, stale socket events, reconnect timers, send failures, unread counts).
- JavaScript syntax: **24 modules passed**.
- `git diff --check`: passed.
- Automated peer tests use mocks; actual browser encoding, picture quality, ICE
  connectivity, and Windows socket resets were not reproduced across physical PCs.
  Socket lifetime and slow-client tests use both ASGI integration clients and controlled slow sockets; real classroom congestion was not load-tested.
  Dependency vulnerability scanning was not run as part of this review.

## Classroom acceptance check

1. Restart the server and reload presenter/viewer tabs. Open a share from a second
   physical PC on the classroom LAN; confirm the connection message appears
   immediately and disappears when playback starts. Test both channel and DM shares.
2. Advance numbered slides at a fixed cadence. Compare presenter/viewer screens
   in one phone recording to measure delay, first with one viewer, then five, then
   the class. Record browser/OS versions, selected capture surface, CPU usage, and
   Wi-Fi versus Ethernet. A persistent 1–3 second delay is a problem to measure,
   not a latency target for this app.
3. Check small text and animations for acceptable quality under the new limits.
   Inspect `chrome://webrtc-internals` or `edge://webrtc-internals` for selected
   candidate pairs, outbound bitrate, quality-limitation reason, RTT, packet loss,
   and receive jitter-buffer delay if lag persists.
4. Interrupt a viewer's network, restore it, switch rooms, and stop/restart the
   presenter. Confirm reconnect messages, cleanup, and retry behavior. A connection
   that never produces frames should eventually expose a retry button.
5. Close/reload browser tabs repeatedly on Windows. Confirm the known teardown
   callback no longer floods normal logs, ordinary disconnect cleanup still runs,
   and unrelated errors remain visible. If shares fail persistently, inspect the
   network/firewall rather than treating log filtering as a connection repair.

## Reference behavior

- [WebRTC peer configuration](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection): an empty ICE-server list limits connectivity to local peers.
- [Receive jitter-buffer target](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget): the user agent may adjust the actual buffering to network and resource conditions.
- [CPython Proactor implementation](https://github.com/python/cpython/blob/main/Lib/asyncio/proactor_events.py): connection-lost cleanup shuts down/closes the underlying socket.

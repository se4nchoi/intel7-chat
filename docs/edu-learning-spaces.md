# Edu learning spaces

The edu frontend has two cohort-scoped spaces:

- `/hub/cohorts/{slug}/chat`: channels, live messages, screen sharing.
- `/hub/cohorts/{slug}/board`: questions, answers, and shared files.

Both use the same account/session and cohort permissions. `/hub` opens the
first available cohort's Chat space. Direct links retain their space after
login. Normal navigation uses browser history; links also support opening
in separate browser tabs. Changing cohorts preserves the selected space.
An unavailable cohort does not silently select a different cohort.

## Stable boundary for deployment changes

These paths represent product navigation, not network topology. Keep them
when choosing academy/cloud hosting, DNS, certificates, database location,
or SFU networking. No host, IP, database connection, or credentials are
embedded in the new navigation/layout code.

`frontend/src/navigation.js` owns URL parsing/generation. `main.js` manages
space and cohort state. `style.css` and `index.html` own presentation.
`frontend/src/api.js` remains the API adapter using the existing same-origin
`/hub/api` and `/hub/ws` contracts. The media URL/token still comes from the
backend. If deployment later separates browser/API origins, adapt that
boundary and server cookie/origin policy rather than rewriting the spaces.

FastAPI serves the built shell at the two explicit UI routes so bookmarked
links and reloads work. This is the only backend code change in this UI pass.
Do not replace API/asset 404s with the UI shell when moving behind a proxy.
No schema, account model, storage path, or hosting configuration changed.

## Navigation behavior

- Only the selected space loads its content. Board navigation closes Chat's
  WebSocket and disconnects its media room, including an active share.
  Keep Chat in a separate browser tab to follow a share while using the board.
- Cohort changes clear previous messages, selected question/answers, and
  cohort-specific form drafts. Space changes preserve typed form drafts.
- Empty channels disable chat/media controls; archived cohorts disable writes.
- Stale content responses are ignored after navigation. Channel selection is
  remembered per cohort for the lifetime of the current page.
- Management is a separate expandable section available to authorized roles.

## Validation

- Vite production build passes (existing large LiveKit chunk warning remains).
- Six route tests cover both direct UI URLs and `/hub`, plus missing API,
  asset, and unknown-space paths that must remain 404.
- Browser checks: board direct-link refresh, Back/Forward, cohort switching,
  empty-cohort state, administrator/student views, logout/login, student chat,
  board question creation, existing answers/files, and SFU connection.

The earlier audit's server-side WebSocket revocation defect remains a
separate backend task. This change closes this page's socket on navigation
and logout; it does not claim to revoke other clients' open subscriptions.
Native screen capture and multi-device media delivery still need verification.

## Discord/Piazza layout (2026-09-28)

The shell is now three columns: a cohort rail (one icon per cohort, replaces
the cohort `<select>`), a sidebar that switches between chat channels and the
Q&A feed, and the content pane. Below 800px the rail and sidebar become a
drawer; below 1100px the member list is an overlay toggled from the top bar.
Light/dark follows the OS; the user panel toggle stores a per-browser choice.

Chat: grouped messages (same author within 5 minutes), day dividers, avatars,
role-coloured names and tags, Enter to send / Shift+Enter for a newline, and a
member list grouped by instructor/student. Screen share moved into a
collapsible stage above the messages ("화면 공유" in the top bar); the LiveKit
flow is unchanged, and "연결하기" now toggles to "연결 끊기".

Board: Piazza-style feed with search, filters (전체 / 미답변 / 강사 답변 대기 /
내 질문), date groups, and badges (i = instructor answered, s = any answer,
✓ = endorsed, red edge = unanswered). A post shows separate instructor and
student answer sections; instructors/admins can endorse student answers.
Files live under "자료실" at the bottom of the feed. `#post-{id}` in the board
URL opens that post, so posts can be linked.

Management moved into a dialog opened from the gear in the user panel (or the
`+` next to channels). Form IDs and API calls are unchanged.

### API additions

- `messages`, `questions`, `answers` rows include `role`
  (`admin`/`instructor`/`student`/`member`) and `display_name`.
- `questions` rows include `instructor_answered`, `endorsed`, `last_activity`.
- `GET /hub/api/cohorts/{id}/members` — active members with role.
- `POST /hub/api/cohorts/{id}/questions/{qid}/answers/{aid}/endorse`
  `{ "endorsed": bool }` — instructor/admin only; uses the existing
  `hub_answers.endorsed` column, so no schema change.

`tests/test_hub_board_api.py` covers these against a disposable PostgreSQL
database and skips unless `MADI_TEST_DATABASE_URL` is set.

### Not in this pass

DMs/group DMs, threads, reactions, message edit/delete, unread counts,
presence, attachments inside Q&A posts, follow-up discussions, and
question edit/resolve. Each needs schema work.

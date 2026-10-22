# Madi UX/UI review and implementation plan — 2026-10-21

Status (2026-10-22): Slice 1 / U01–U04 is complete. Slice 2 / U05 and U07 is implemented with frontend tests and a production build; browser verification remains. U06 and U08–U10 remain pending.
Reviewed branch: `edu/discord-piazza-ui`, based on `381b625`; continued as `edu/madi` with the local setup, dependency, and U01 changes.

## Recommendation

Keep the existing chat/Q&A structure and green theme. Fix onboarding consistency, roster preview accuracy, mobile control names, and notification targeting first. Then improve drafting and simplify board navigation. Larger administration and chat-discovery features follow those fixes.

The earlier 2026-10-19 audit records F01–F22 as fixed. This review does not reopen those findings wholesale. Target-scoped chat/answer drafts, server-backed question pagination, management tabs, scoped account permissions, and the first-login screen already exist.

## Review scope and evidence

Reviewed the current built app with synthetic student, instructor, administrator, and first-login accounts in a separate PostgreSQL database, `madi_ux_20261021`. The review app used loopback port 8765. No community backup, real roster, or normal academy accounts were edited. Roster preview was exercised without applying the import. Password changes were not submitted.

Browser checks covered student chat, Q&A index/detail/composer, notification navigation, instructor management, administrator management, invalid roster preview, an empty cohort, and the first-login screen. Verified CSS viewport sizes were 1440×960 and 390×844. Dark desktop, dark mobile question detail, light mobile administration, and light first-login views were inspected; this was not a complete role × theme × viewport matrix.

LiveKit, real screen capture, LAN reachability, and SFU capacity were excluded. The local review session encountered WebSocket reconnects while HTTP requests worked. The cause of that transport failure was not investigated. Only the observed placement and repetition of its UI notices is reported below.

Evidence labels: **B** = browser observed; **S** = source confirmed; **O** = feature/design opportunity inferred from the reviewed workflows. Priorities are proposed implementation order, not a count of security vulnerabilities.

Screenshots and the synthetic fixture server are in ignored `data_dev/ux-pass-20261021/`. Screenshot filenames below are copied from this chat's visualization folder. They contain synthetic data only.

## Findings

| ID | Priority / evidence | Current behavior and user impact | Proposed feature/fix |
| --- | --- | --- | --- |
| U01 | P1 / S | The manual account form calls its password temporary, but its creation path does not set `must_change_password`. CSV import does. New users receive different onboarding depending on how they were added. | Use the same first-login requirement for newly manually created accounts; expose pending onboarding to administrators. |
| U02 | P2 / B+S | A preview containing one existing member, one valid new row, and a duplicate new row reports “신규 2명” while showing an error. Import is correctly blocked, but the summary overstates actionable work. | Count valid actions separately from invalid rows; show an explicit blocking error total and an error-only view. |
| U03 | P2 / B+S | At 390px, chat header controls are exposed as emoji names such as “📌1”, “🖥”, and “👥”. CSS hides their text labels and there are no explicit accessible names. | Give compact controls persistent Korean accessible names and keep counts separate from the name. |
| U04 | P2 / B+S | Chat reconnect notices enter whichever modal is open. A class-management or roster task can display a large red chat error unrelated to its form, repeatedly consuming space. | Render service connection state in a stable application banner; reserve form/dialog errors for the active task. |
| U05 | P2 / B+S | Clicking a new-answer notification opens the question top, focuses the question heading, and marks the alert read. The route omits the known answer ID and answer rows have no stable IDs. Users must locate the new answer themselves. | Add answer-specific deep links, scroll/focus/highlight the answer, and mark the notification read after reaching the intended target. |
| U06 | P2 / B+O | Question composition has a textarea, native file picker, and per-tab text autosave, but no rendered preview, explicit discard action, or per-file removal/status. “취소” leaves a saved draft without explaining that choice. | Add a draft workspace with Write/Preview, explicit “목록으로 · 초안 유지” and “초안 삭제”, plus a selected-file list and submission progress. |
| U07 | P2 / B+S+O | Q&A repeats filters in sidebar links, clickable statistics, and filter pills. Feed previews show raw Markdown fences and code syntax as prose. Scanning the list is harder than reading detail. | Keep sidebar shortcuts for stable tasks, one main filter row, passive summary counts, and clean plain-text excerpts using the existing safe formatting pipeline. |
| U08 | P2 / B+S+O | Academy management combines single-account creation, cohort creation, roster import, and all accounts in one long modal. Several fields use placeholders without persistent visible labels. | Add task sections with direct entry links, persistent labels, explicit target-cohort context, and a guided cohort setup checklist. |
| U09 | P3 / B+S+O | “강사 답변 대기” already exists, but the list is newest-first. There is no dedicated oldest-waiting triage flow. | Add an instructor queue with oldest/newest sorting, waiting age, and next-question navigation. Preserve the existing definition of unresolved/no-instructor-answer. |
| U10 | P3 / S+O | Historical chat and pins are available, but there is no scoped message search UI or quote-reply workflow. Finding a past explanation and responding with context requires manual browsing/copying. | Add permission-scoped channel/DM search first; consider quote replies as a separate later increment. |

### Concrete source references

- **U01:** `frontend/index.html`, `#account-form`; `app/hub/routes.py`, `create_account`; `app/hub/db.py`, `create_account` and `set_password`; compare `app/hub/onboarding.py`, `apply`/new-account insertion and `0010_account_onboarding.sql`.
- **U02:** `app/hub/onboarding.py`, `_plan` counts all planned actions, including rows with errors; `frontend/src/main.js`, roster preview handler. Evidence: `madi-review-roster-invalid-desktop.jpg`.
- **U03:** `frontend/index.html:106–108`; `frontend/src/style.css:271`, `.topbar-actions .label { display: none; }`. Accessibility tree confirmed loss of the Korean control names.
- **U04:** `frontend/src/main.js`, `status` chooses `dialog[open]`; `connectChat` calls the same helper for reconnects. Evidence: `madi-review-instructor-management.jpg`, `madi-review-admin-mobile-light.jpg`.
- **U05:** `frontend/src/notification-links.js`, `notificationUrl`; `frontend/src/main.js`, `renderAnswers`, `selectQuestion`, `openNotification`. `app/hub/notifications.py` already returns `answer_id`. Evidence: `madi-review-answer-notification-mobile.jpg`.
- **U06:** `frontend/src/main.js`, `questionDraftKey`, `openQuestionComposer`, `#compose-cancel` and question submission handler; `frontend/index.html`, `#question-form`. Evidence: `madi-review-compose-desktop.jpg`.
- **U07:** `frontend/src/main.js`, `renderFeed`, `renderStats`, `syncFilterButtons`; `frontend/index.html`, `#board-nav`, `#board-stats`, `.filters`. Evidence: `madi-review-board-desktop.jpg`.
- **U08:** `frontend/index.html`, `#management`, `#account-form`, `#cohort-form`, `#roster-card`; `frontend/src/main.js`, `openManagement`, `setManagementTab`, `renderAccounts`. Five text/password inputs in the account/cohort forms had accessible names but no persistent associated visible labels.
- **U09:** `app/hub/db.py`, `questions_page`; `frontend/src/main.js`, `FILTERS`, `loadQuestions`.
- **U10:** `app/hub/routes.py`, message/history endpoints; `frontend/src/main.js`, channel/history/message rendering. Treat this as a proposed capability, not a broken existing search feature.

## Implementation sequence

Sizing: S = contained change; M = several UI/API states; L = new workflow with API and integration coverage. These are relative scope estimates, not delivery dates.

### Slice 1 — consistent and trustworthy core behavior

**1A. Consistent onboarding (U01, M)**

Add an explicit `require_change` option to account creation, preserving the current low-level default for fixtures/demo/bootstrap compatibility. Have the administrator-facing manual creation endpoint request first-login change. Keep the existing dedicated bootstrap-admin flow usable. Include the onboarding flag in the admin account list and render “첫 로그인 대기”. Existing accounts must not be retroactively locked into password change.

Acceptance:

- A newly manually created user and a CSV-created user both reach the dedicated first-login screen.
- Cohort APIs and sockets remain blocked until password change, including after refresh.
- Existing users and the initial administrator retain their current login behavior.
- For future administrator resets, explicitly decide whether to require a change; recommended default is yes for the reset action, with no mass update to existing accounts.

Reuse the existing `must_change_password` column; no new schema is needed for the creation fix. Extend onboarding/API tests to cover manual creation and reset policy independently.

**1B. Accurate roster preview (U02, S)**

Return valid action counts and an invalid-row count. Show “검토한 3행 · 신규 1 · 이미 배정 1 · 오류 1” for the observed example. Explain that any error blocks the entire batch. Keep the revision check and atomic application. Provide an error-only toggle and consistent data-row numbering; distinguish data rows from physical CSV lines when quoted multiline values exist.

Acceptance: duplicate usernames, invalid roles, inactive accounts, and role conflicts all contribute to error counts; an invalid batch never appears partially applicable. Counts match displayed row statuses and valid-batch results. Add backend preview-count tests and one browser error-recovery check.

**1C. Mobile control names and labels (U03, S)**

Add explicit Korean `aria-label` values to pins, screen-share panel, and member-panel toggles, with emoji marked decorative. Keep `aria-pressed` and `aria-controls` synchronized. Add visible labels to the account/cohort form fields. Aim for 44px touch targets where space allows; preserve a compact desktop variant.

Acceptance: at 390px the accessibility tree names the actions “고정 메시지”, “화면 공유”, and “구성원”; keyboard focus remains visible; a badge change does not replace the control's name. Test the labels at both desktop and mobile breakpoints. Opening a screen-share panel can be checked without starting any media connection.

**1D. Scoped service status (U04, M)**

Introduce a small connection-state presenter driven by the existing chat socket lifecycle. Render connected/reconnecting/offline state near the shell or chat heading; distinguish live-update availability from REST request failures. Give the status region one persistent message, a retry action, and a quiet recovery announcement. Route form errors to their owning form/dialog rather than the most recently opened modal. Avoid announcing every retry as a new alert.

Acceptance: a forced chat socket disconnect never inserts an error into roster/account forms; drafts and form errors survive reconnect; recovery clears the connection banner without clearing an unrelated validation error. Use a controlled local socket failure, without LiveKit or LAN checks.

### Slice 2 — reading and notification context

**2A. Exact-answer navigation (U05, M)**

Extend the current question URL compatibly, for example `?answer=42#post-14`. Preserve existing question-only links. Give rendered answer rows `answer-<id>` IDs and a focusable target; wait for the right question's answers to load, then scroll, focus and briefly highlight the target. Use the existing `answer_id` in notification payloads. Do not mark the notification read if the target cannot be reached. Validate that the answer belongs to the question; retain all cohort/DM permission checks.

Acceptance: long questions, multiple instructor/student answers, reload, Back, deletion, and lost access all produce the correct destination or a clear fallback. Respect reduced-motion preferences. Cover route parsing, late responses after switching questions, and mark-read sequencing.

**2B. One board navigation model and readable previews (U07, M)**

Keep the sidebar for “전체 질문 / 내 질문 / 자료실”. Consolidate status selection into a single filter row or a mobile select. Render summary counts as informational text. Use a safe text-excerpt helper that removes formatting delimiters and presents code examples deliberately; never inject raw HTML. Use that helper for notification excerpts too. Keep long titles readable and metadata secondary.

Acceptance: one active status filter, preserved search/filter/back-navigation state, and no raw fence markers in ordinary previews. Test code, links, mentions, Unicode, long titles, empty results and both themes. Server totals and pagination remain unchanged.

### Slice 3 — confident writing and administration

**3A. Draft workspace (U06, M)**

Add Write/Preview to question and answer forms using `renderRich`; include a small code-format helper. Keep the existing account/cohort/target scoping and per-tab storage. Offer explicit keep/discard actions; disclose that attachments are not restored after reload. Show file name, size, remove action, and per-file validation before upload. Show upload/posting progress, preserve text after failure, and reuse previously successful upload IDs during retry.

Acceptance: no cross-account/cohort/question draft leakage; preview output matches saved output; discard clears only that draft; storage failure has a memory fallback; typing during submission is preserved; duplicate submit/upload attempts do not duplicate attachments. Add focused composer tests rather than duplicating the existing DraftStore suite.

**3B. Task-oriented management (U08, M)**

Keep personal settings in a compact dialog. Within academy management, provide explicit Accounts / Cohorts / Roster tasks instead of one scrolling surface. Give the roster workflow persistent steps: target → input → review → apply → distribute credentials. Keep the selected target visible in review and result states, even when it differs from the background cohort. Keep account search and its results in the Accounts task. Add a cohort setup checklist with direct links to create a channel, add an instructor, and add/import students; readiness must come from saved state.

Acceptance: each task opens directly with a clear heading and focus target; typed fields retain visible labels; 390px preview uses readable row cards or a deliberately labeled table scroll region; closing the credential result removes plaintext credentials as today. Current permissions and all-or-nothing import behavior remain unchanged. UI changes must not add credential persistence or silently auto-enroll users.

### Slice 4 — workflow expansion after the fixes

**4A. Instructor response queue (U09, M)**

Reuse “강사 답변 대기”. Add explicit oldest/newest order, waiting-age text, and next-question navigation. Add a validated sort parameter and stable cursor ordering in the existing paged questions API. Do not infer urgency from arbitrary age thresholds or mark questions resolved simply because an instructor answered.

Acceptance: repeated timestamps and concurrent new posts do not duplicate/skip rows; archived cohorts remain read-only; switching between queue and ordinary board preserves the user's chosen scope. No schema required unless query measurements justify an index.

**4B. Scoped chat search (U10, L; separate increment)**

Add a search control for the current channel/DM, server pagination, and results that open the existing around-message history view. Server-side authorization must use the same channel/DM checks as history. Return an explicit “최신 대화로” action from a result. Start with PostgreSQL text matching on the selected conversation and measure before adding a full-text index.

Acceptance: administrators cannot search nonparticipant DMs; removed memberships and deleted messages disappear from results; older results remain reachable; live incoming messages do not move the user's reading position. Quote replies are a later, separately scoped change requiring reply-target storage and deleted-target behavior; they are not part of this search slice.

## Regression and release checks

- Use only a disposable PostgreSQL database for integration tests. The existing suite's table reset helpers are destructive by design.
- Baseline established earlier in this chat: 412 Python tests passed / 1 Windows-specific skip, 29 frontend tests passed, production build and dependency audits clean. Those counts are a pre-feature baseline, not verification of these proposed changes.
- For each implemented slice: run its meaningful unit/API tests, relevant existing browser regressions, `npm test`, and `npm run build`. Run the full PostgreSQL suite for changes to authentication, permissions, import transactions, or pagination.
- Final visual matrix: student/instructor/admin × light/dark × 320/390/768/1024/1440 CSS px, plus representative long names, zero state, long code and large lists. Verify the actual CSS viewport rather than relying on browser viewport override values alone.
- Keyboard: modal focus/return, hidden mobile navigation, named icon controls, form error focus, and notification target focus. Real screen-reader and phone-keyboard checks remain separate acceptance work; desktop emulation does not prove them.
- Exercise slow/failed HTTP requests and local chat reconnects. Keep draft/credential handling and read-state isolation as regression invariants.
- No SFU, LiveKit, firewall, certificate-distribution, or classroom capacity change is necessary for slices 1–4A. Media end-to-end acceptance remains outside this plan.

## Current completion state — 2026-10-22

Slice 1 (U01–U04) is implemented. U05–U08 are implemented in code with browser verification pending; U09–U10 remain planned.

- **U01:** manual account creation requires first-login password change; the administrator list exposes pending onboarding. Existing accounts, bootstrap-admin behavior, and reset policy are preserved.
- **U02:** preview action totals exclude invalid rows and return `total_rows` and `invalid_rows`. The UI shows blocking-row counts, an errors-only view, and data-record numbering (excluding header/blank records; quoted multiline cells remain one record). Any invalid row still blocks the entire atomic batch. Corrected previews must be reviewed again.
- **U03:** pins, sharing-panel and member controls retain explicit Korean accessible names when their visible text is hidden. Decorative emoji are hidden from accessibility names; pin totals are a separate description. Compact header controls have 44px minimum touch targets. Account/cohort creation fields now have persistent visible labels.
- **U04:** cohort socket state uses a persistent application banner with a retry action and a deduplicated polite announcement. Reconnects/recovery never use the currently open dialog's error region. Form validation errors target their owning dialog and have independent notification timers. Leaving a cohort clears the connection banner.

Verification: **416 Python tests passed / 1 Windows-specific skip; 33 frontend tests passed; production build and JavaScript syntax checks passed.** The full PostgreSQL suite ran only against the configured disposable test database. Added regressions cover valid-vs-invalid action totals, atomic rejection and corrected application, CSV data-record numbering, retry callback replacement, deduplicated announcements, and connection recovery state.

Browser checks used the existing synthetic review database (`madi_ux_20261021`) and loopback-only review app. Previewing one existing member, one valid new row and one duplicate showed `검토한 3행 · 신규 1명 · 이미 배정 1명 · 오류 1행`; errors-only retained row number 3. Correcting the duplicate exposed the apply action; no real roster was applied. A malformed roster's validation error and typed input remained through a forced disconnect and recovery, and the banner cleared after recovery without clearing that error. The HTTP review fixture substituted a controlled socket transport to exercise presentation independently of the production endpoint's HTTPS-only Origin policy; socket authorization remains covered by backend tests.

The browser viewport override did not apply, so targeted responsive checks used the actual built control/form markup and CSS inside isolated 390px frames in both themes. Accessible names remained Korean with visible labels hidden, and all three header controls measured 44×44px. This does not complete the full role/theme/viewport matrix, actual phone-keyboard checks, or real screen-reader acceptance.

Evidence: this chat's visualization folder contains `madi-roster-errors.jpg` and `madi-compact-controls.jpg`. The disposable fixture scripts are ignored under `.runtime-tmp/`. No real academy accounts, community data, certificate trust, SFU/LiveKit services, or classroom network settings were modified. No schema migration was needed.

### Slice 2 implementation note — 2026-10-22

- **U05:** Answer notifications now carry a validated answer ID in the board URL. The target is checked against the question's authorized answers, then its rendered row is focused and highlighted. A deleted/missing answer leaves the notification unread and shows a fallback rather than silently landing at the question top. Existing question-only links remain valid.
- **U07:** The board sidebar keeps stable shortcuts (all questions, my questions, files); the main filter row owns status selection. Summary cards are informational. Question and notification previews use text-only excerpts that remove formatting delimiters and label code examples without injecting HTML.
- **Related legacy parity:** Madi file uploads now permit PLC formats such as `.gwx` and `.gxw` and other teaching extensions, while rejecting executable/active-web suffixes. Files remain cohort-scoped and are downloaded as attachments; the existing 10 MB per-file limit is unchanged.

Verification for this pass: 36 frontend unit tests, 15 targeted Python upload/route/login-hardening tests, and the Vite production build passed. A live answer-notification browser flow and the PostgreSQL integration suite have not been run in this checkout; use a disposable database for those checks.

### Slice 3A implementation note — 2026-10-22

- **U06:** Question and answer composers now have Write/Preview modes using the same safe rich-text renderer as saved content, plus a code-block insertion action. Both drafts use account/cohort/target-scoped tab storage with the existing memory fallback; the old question draft key is migrated when opened. Explicit discard clears only the current draft, while closing the question composer keeps it.
- Question attachments have a visible selected-file list with size and remove controls, count/size/blocked-suffix checks before upload, and visible upload/post progress. Failed requests retain text and selected files. Successfully uploaded IDs are reused during a retry, and the submit guard prevents concurrent duplicate submissions.
- Files are intentionally not restored across reloads, and the UI says so. This does not guarantee idempotency if the server accepts a question but its response is lost; a future idempotency key would be needed for that edge case.

Verification: 38 frontend unit tests, Vite production build, and `git diff --check` passed. The browser role/theme/viewport matrix and slow/failing upload UX remain to be exercised before release.

### Slice 3B progress note — 2026-10-22

Academy management now separates Accounts, Cohorts, and Roster tasks inside the existing permission-gated dialog. The roster workflow shows its current step and target cohort during input, preview, and credential distribution; switching tasks is disabled while an import is applying. Account search remains with the Accounts task. The cohort setup checklist reads saved channels and memberships from the API and links directly to channel, instructor, and roster actions without enrolling anyone automatically. Password and channel setup fields now retain visible labels. Responsive and keyboard/browser verification remain open before considering U08 release-ready.

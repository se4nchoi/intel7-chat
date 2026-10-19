# Madi UX review — 2026-10-19

Reviewed the current working tree on `edu/discord-piazza-ui` at `2625c01`, including the uncommitted Q&A layout changes. Three independent Chrome browser contexts signed in as instructor (`inst`), administrator (`admin`), and student (`stu`). This was a role walkthrough, not three independent human reviewers.

Desktop viewport: 1440 × 960. Mobile viewport: 390 × 844, using desktop Chrome viewport emulation. Local service: `https://localhost:8080/hub`. No product code was changed during this review.

## What was exercised

| Role | Checks | Result |
| --- | --- | --- |
| Instructor | Chat, screen-share panel and connection failure, management/members/channel form, Q&A answer creation, endorsement of a student's answer, mobile navigation | Answer and endorsement worked; instructor controls were visible. Media returned the expected unconfigured-service error. |
| Administrator | Chat, cohort/account/member/channel management UI, Q&A moderation, mobile dialog/navigation | Account and cohort controls appeared; moderation deletion worked. Mobile management content overflowed horizontally. Destructive account/cohort actions were inspected but not executed. |
| Student | Chat, available settings, question and answer creation, own edit/delete affordances, board/files/compose navigation, mobile reading | Question and answer creation worked. Account/cohort administration was hidden; settings contained only password change. Mobile post metadata overlapped its actions. |

The chat/Q&A menu had identical position and dimensions for all roles and both spaces: x=72, y=52, width=259, height=47.5 px on desktop. Preserve this consistency.

Temporary review questions and their answers were soft-deleted through normal moderation after the checks. Their audit/history records may remain by design. No classroom service on port 8000 was changed.

## Findings, in suggested repair order

### 1. Mobile question actions overlap author metadata — high priority

**Student, reproduced visually.** On an owned question at 390 px, the timestamp/question number and “질문 수정 / 질문 삭제” occupy the same line and overlap. The same absolute action layout is used for other roles with moderation controls. The desktop layout has enough space and masks this problem.

`frontend/src/style.css:296` positions `.post-tools` absolutely without reserving metadata space. Let metadata and actions wrap in normal flow, or put secondary actions in an accessible menu.

Evidence: [student mobile post](../data_dev/ux-review/stu-mobile-post.png).

### 2. Administrator settings overflow horizontally on mobile — high priority

**Administrator, measured.** The dialog has a 352 px content viewport but 465 px scroll width. The document itself does not overflow, so a page-level overflow check alone misses it. The account rows keep identity, password-reset, and activation actions on a single flex row. Student and instructor dialogs measured 352/352 px.

Wrap account actions or stack them beneath the identity. Verify the bottom account list, not only the first screen of the dialog.

Evidence: `data_dev/ux-review/results.json`, `admin.mobileManagement`. Relevant layout: `frontend/src/style.css:279`.

### 3. Daily teaching and academy administration are buried in personal settings

**Instructor and administrator, observed.** A small gear beside the user's name opens “계정 및 관리”. Password change is the first section; instructor membership/channel tasks share this surface. For admins, accounts, cohorts, archive, membership, channels and the entire account list extend below the initial viewport. Common operational tasks lack a visible entry point of their own.

Keep the common navigation fixed, but add role-appropriate “수강반 관리” and “학원 관리” entry points. Separate personal account settings from operational pages. Do not move chat/Q&A when roles or spaces change.

Evidence: [instructor management](../data_dev/ux-review/inst-management.png), [administrator management](../data_dev/ux-review/admin-management.png).

### 4. Screen sharing looks available when it is not configured

**All roles, reproduced.** The panel displays an empty native video player and an enabled “연결하기” action. Clicking it returns HTTP 503 and “화면 공유 서비스가 아직 준비되지 않았습니다.” This is a local deployment limitation, not proof that the SFU implementation is broken. The UI nevertheless invites a dead-end action; on mobile the empty stage consumes substantial chat space.

Expose availability before inviting a connection. Students need a concise unavailable/no-presentation state; instructors/admins need a setup explanation appropriate to their role. Hide unused player controls until a track exists.

Evidence: [student share panel](../data_dev/ux-review/stu-share.png), [mobile chat](../data_dev/ux-review/stu-mobile-chat.png), role media results in `results.json`.

### 5. Media failure messages leak into unrelated board workflows

**All roles, reproduced.** After a failed screen-share connection, the red error toast remains over the Q&A home/article and management screens. It has no dismissal action; error toasts do not expire. It makes the next task look broken and can cover the answer/composer area.

Place connection errors in the media panel, or clear/dismiss task-specific messages on navigation. Reserve persistent global notices for service-wide problems. See `frontend/src/main.js:25`.

Evidence: [instructor article](../data_dev/ux-review/inst-post.png), [instructor board](../data_dev/ux-review/inst-board.png). Some home screenshots were captured while board data was loading; their empty counters are not reported as a defect.

### 6. Q&A now has a distinct body but leaves a mostly empty sidebar

**All roles, observed.** Keeping the common menu fixed is correct. However, Q&A leaves most of the 260 px sidebar blank while the main view also uses wide reading margins. This is especially conspicuous beside a long article.

Use the area below the fixed space selector for stable board navigation such as “전체 질문 / 내 질문 / 답변 대기 / 자료실”, or helpful cohort context. Preserve the article's comfortable reading width rather than stretching text to fill the screen.

Evidence: [instructor article](../data_dev/ux-review/inst-post.png).

### 7. The question index spends too much vertical space before actual questions

**All roles, observed layout; strongest on mobile.** The large heading, four counters, explanation, separate new-question row, search, and filters precede the list. At 390 px the counters become two rows. Frequent visitors must pass the introduction before reaching the primary content.

Use a compact heading with the new-question action, inline counts and a search/filter toolbar. For instructors, make “강사 답변 대기” a prominent task view; the existing filter works but the counter is not itself a shortcut.

Relevant markup: `frontend/index.html:132`; layout: `frontend/src/style.css:377`.

### 8. Shared files are difficult to discover during another task

**All roles, observed and source-confirmed.** “자료실” sits after the entire question list. It disappears when reading a question or composing one, requiring a return to the index first. More questions will push this entry farther down.

Give files a stable board-navigation position without changing the location of the chat/Q&A selector. See `frontend/index.html:145`.

### 9. Account creation and enrollment form a disconnected admin workflow

**Administrator, UI/source finding; no new account was created in this review.** New account creation and cohort membership are separate forms. Enrollment requires manually entering an existing username. The account list has no search/filter, and `handleForm('account-form')` does not reload it after creation; the admin must reopen the dialog to obtain a refreshed list.

Offer an existing-account picker and an optional cohort/role step during creation, refresh the list immediately, and separate searchable accounts from cohort membership. See `frontend/src/main.js:958` and `frontend/index.html:220`.

### 10. Q&A is missing completion and attachment affordances

**Student/instructor, current UI scope.** Questions accept title/body only; there is no attach-image/file action, save-draft indicator, question-level “해결됨” control, or follow/notify control. Instructor endorsement of an answer works, but does not let the question author explicitly close the question. These are missing product affordances, not failed implementations of existing controls.

Prioritize code/error screenshot attachments and a clear resolved state. Add richer discussion/following only after the core reading and answer workflows are stable.

## Recommended next pass

1. Fix mobile post metadata/actions and admin-dialog overflow.
2. Contain media errors and accurately represent unavailable media.
3. Keep common navigation fixed; add role/task-specific navigation beneath it.
4. Compact the Q&A index, keep files reachable, and separate management workflows.
5. Add question attachments/resolution after those layout fixes.

## Fixes implemented after review

- Common chat/Q&A navigation remains fixed. Board navigation below it now includes all/my/pending/resolved questions and files; managers have visible class/academy management entry points.
- Personal settings, cohort operations, and academy operations use separate dialog sections. The settings button now uses a toothed cog instead of sun-like spokes. Account rows wrap on mobile; account search, immediate list refresh, and optional enrollment during creation are implemented.
- The Q&A index uses a compact title/action row, inline count shortcuts and filters. Mobile post metadata and actions occupy separate rows. Uploaded question attachments are linked to questions with cohort/uploader checks; authors and managers can mark questions resolved or reopen them. Question title/body drafts are restored within the same tab; files must be selected again after reload.
- Unconfigured media is explained before connection; its connect button is disabled and an empty video player is hidden. Connection failures stay in the media panel. Global errors can be dismissed and expire; navigation clears contextual notices.
- A classroom-list refresh now preserves the instructor's selected room, fixing a race exposed by the presenter regression walkthrough.
- Migration `0009_question_workflow.sql` adds question resolution metadata and question/file links. The isolated local database was backed up before applying it. Other installations apply it at normal startup after their usual backup.

Validation: **386 Python tests passed, 1 skipped** against a separate disposable test database; **18 frontend tests passed**; Vite build, JavaScript syntax and diff checks passed. The classroom and presenter browser smoke checks passed with mocked media. Real local browser checks passed for student/instructor/admin login and navigation, mobile dialog widths (352/352 px for all roles), non-overlapping post actions, account search/create/enroll, draft restoration, attachment upload/download, and resolved filters. Evidence is in ignored `data_dev/ux-fixed/` and `data_dev/verify_ux_fixes.cjs`.

Tagged temporary questions were soft-deleted; test uploads and the disabled temporary account were removed after verification. Actual screen capture and multi-device SFU delivery remain unverified. Following questions/notifications and richer follow-up discussion remain future product work.

## Evidence and limits

Screenshots and machine-readable results are in ignored `data_dev/ux-review/`; the reusable local walkthrough is `data_dev/ux_roles.cjs`. The walkthrough completed with no uncaught browser JavaScript errors. Initial unauthenticated `/me` requests returned the expected 401; attempted media connections returned 503 because media is unconfigured.

This review did not validate real screen capture/SFU delivery, physical phones or virtual keyboards, full keyboard/screen-reader accessibility, dark-theme behavior, large account/question populations, archived/empty cohorts, or destructive account/registration workflows. No capacity or classroom-network claims follow from these checks.

# UX Walkthrough Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the P0 and P1 problems from the Nov 16 user's-eye walkthrough so a user is never dropped onto a stale draft, never starts a voice call by accident, sees consistent counts, and can find things.

**Architecture:** Eight small PRs, each independent, each cut from fresh `origin/main` (never stacked). Logic goes into small pure functions with pure smokes; UI changes get one Playwright check where layout matters. No new tables; one task (PR 7, Task 19) needs a DDL bump and is last on purpose.

**Tech Stack:** Next.js (breaking-change version, read `node_modules/next/dist/docs/` before touching routes), React, TypeScript, Drizzle on Neon/PGlite, smoke scripts under `scripts/` run by `scripts/run-smoke.ts`, Playwright in `e2e/`.

**Spec:** `docs/audits/2026-11-16-ux-walkthrough.md` (finding ids like C-1, G-3 refer to it).

## Code-map caveat (read first)

The paths below were mapped on the checkout at `bedd0dc63`, which is **303 commits behind `origin/main`** (main is at schema **247**; that checkout says 228). I diffed the mapped files against `origin/main`: these **changed** and must be re-read before editing: `dashboard/page.tsx`, `dashboard-sections.tsx`, `app-nav.ts`, `mobile-nav.tsx`, `notifications-panel.tsx`, `notification-panel.ts`, `gmail-import-panel.tsx`, `capture-jobs.ts` (cosmetic only), `review-reducer.ts`, `reminders.ts`, `reminders-page-query.ts`, `scripts/run-smoke.ts`. Line numbers are approximate everywhere. Every PR starts with `git fetch origin` and a worktree off `origin/main` (see Global Constraints). Main also now gives reminders a `priority` (critical/high/normal/low); Task 11 relies on it.

## Global Constraints

- Work in a fresh worktree off `origin/main`; `npm ci` there (never symlink `node_modules`); no `.env` means demo mode on PGlite.
- Stop any running `next dev` before `npm run build` or any PGlite smoke (single-writer).
- New smoke: file `scripts/smoke-<name>.ts`, registered in `MANIFEST` in `scripts/run-smoke.ts` with tier `pure` (no `../src/db` import) or `pglite` (first line `import "./smoke/_env"`); uses `checker()` from `./smoke/check` and ends with `t.done("<name>")`. `npm run test:check` fails if a script is unregistered.
- Run one smoke: `npx tsx scripts/run-smoke.ts --only smoke-<name>` (it may flake under load; rerun alone before debugging). Full suite: `npm test`. Gates before every commit: `npm run typecheck`, `npm run lint` (0 errors), `npm run test:check`.
- DDL change = bump `SCHEMA_VERSION` (`src/db/index.ts`, 247 on main today; re-read it, another merged PR may have taken the next number) and refresh `scripts/schema-ddl.lock.json`; `npm run db:check` must pass.
- Do not edit `src/app/(site)/(docs)/terms/page.tsx` or `privacy/page.tsx` in these PRs (it trips `smoke-legal-pages` and needs a TERMS bump). If copy here seems to need it, stop and ask.
- User-facing copy: plain words, no jargon, no trailing period on short labels (house voice; `smoke-toast-copy` enforces toasts). Errors go through `friendlyError`, never `err.message`.
- One commit per task. Commit message ends with the attribution line the session was given.

## Open decisions (Jason's calls; defaults used if not changed)

| # | Decision | Default in this plan |
|---|----------|----------------------|
| D1 | One closeness vocabulary (G-2): Close/Warm/Cool uses absolute cutoffs, Inner/Mid/Outer uses percentile cutoffs, and a code comment says the split is deliberate | Task 14 only explains and hides empties; no relabeling until you pick |
| D2 | Reminders backlog (R-1): auto-age old notes reminders, or offer a one-click cleanup | One-click "Snooze overdue from notes" with undo; **no automatic aging** |
| D3 | Voice confirm (G-1): every start, or first start only | First start per browser |
| D4 | "People to meet" (D-2): hide unless a goal or target company is set, or remove the section | Hide unless a goal or target company is set |
| D5 | Sort `(Maiden)` names under their real letter (CT-1) needs a DDL bump | Included as the last task; skip if you'd rather not bump |

## Review Focus

Inputs the audit implies but no task obviously covers; each has a test in the owning task:

1. A capture job in `saving` or `extracting` must never be treated as stale or discarded (Task 1).
2. A stale job that still has real items to review must stay resumable, not vanish (Task 1, Task 2).
3. Keyboard activation (Enter/Space) of the orb and the "N things due" chip must hit the same confirm as a click; mic-permission denial after confirming shows the existing error (Task 4).
4. Bulk snooze must not touch reminders the user wrote themselves, nor `critical`/`high` priority ones, must work past the 200-row bulk limit, and must be undoable (Task 11).
5. The non-person filter must not hide real contacts: names like "Mom", "Dad", "Priya Support", or a person with a company handle in their name (Task 18).

---

## PR 1 — Capture and Meetings stop opening on a stale draft (C-1, M-1)

### Task 1: Decide when a saved job auto-opens

**Files:**
- Create: `src/lib/capture/job-staleness.ts`
- Create: `scripts/smoke-capture-job-staleness.ts` (tier `pure`)
- Modify: `scripts/run-smoke.ts` (MANIFEST)

**Interfaces:**
- Produces: `shouldAutoOpenJob(job: { status: CaptureJobStatus; updatedAt: Date; itemCount: number }, opts: { explicitJobParam: boolean; now: Date }): boolean`. `CaptureJobStatus` is the existing union behind `ACTIVE_CAPTURE_JOB_STATUSES` in `src/lib/capture/types.ts`. Constant `STALE_DRAFT_MS = 2 * 60 * 60 * 1000`.

- [ ] **Step 1: Write the failing smoke.** Assertions: `explicitJobParam: true` → true for any age. In-flight statuses (`ingesting`, `transcribed`, `queued`, `extracting`, `saving`) → true even when 5 days old. `ready`/`reviewing` with `updatedAt` 10 minutes ago → true. `ready` with `itemCount: 0` and 4 days old (the Nov 12 meeting) → false. `reviewing` with `itemCount: 3` and 4 days old → **false** here too (the page shows it as a resume notice instead, Task 2).
- [ ] **Step 2:** Register the smoke; run it; expect FAIL (module missing).
- [ ] **Step 3:** Implement `shouldAutoOpenJob` in `job-staleness.ts`; pure, no imports from `@/db`.
- [ ] **Step 4:** Run the smoke; expect PASS. Commit.

### Task 2: Wire it into /capture and /meetings; show stale jobs as a notice

**Files:**
- Modify: `src/app/(clerk)/(app)/(main)/capture/page.tsx` (where `getActiveCaptureJob` becomes `initialJob`, ~line 89-175)
- Modify: `src/app/(clerk)/(app)/(main)/meetings/page.tsx:48-90` (`meetingJob`)
- Modify: `src/components/capture/capture-resume-notice.tsx` (currently only renders for `status:"ready"` with items)
- Test: `e2e/capture.spec.ts` (extend; Playwright, demo mode)

**Interfaces:**
- Consumes: `shouldAutoOpenJob` (Task 1); existing `discardCaptureJob(id)` in `src/actions/capture-jobs.ts`.
- Produces: `CaptureResumeNotice` accepts a job with `itemCount === 0` and shows "Unsaved meeting from <date>" with buttons **Resume** and **Discard**.

- [ ] **Step 1: Write the failing e2e.** Seed a `ready` meeting job with 0 items, `updatedAt` 4 days ago. Visit `/capture`: expect the input tabs/textarea visible and a notice containing "Unsaved meeting"; expect no "Ready to save" heading. Visit `/meetings`: expect "Past meetings" above the fold and the same notice. Click Resume: expect the summary view ("Ready to save"). Repeat with the job `updatedAt` 5 minutes ago: expect the summary view straight away (still auto-opens).
- [ ] **Step 2:** Run `npx playwright test e2e/capture.spec.ts -g stale`; expect FAIL.
- [ ] **Step 3:** In both pages, call `shouldAutoOpenJob` with `explicitJobParam = Boolean(params.job)`; when false, pass `initialJob={null}` to `CaptureFlowLazy` and pass the job to the notice instead.
- [ ] **Step 4:** Extend `CaptureResumeNotice` for the zero-item case (copy above; Resume re-navigates with `?job=<id>`, which sets `explicitJobParam`).
- [ ] **Step 5:** Run the e2e; expect PASS. Commit.

### Task 3: Bell row says something true

**Files:**
- Modify: `src/lib/notification-panel.ts` (capture row title, ~322-334 on the old checkout)
- Modify: the notification-panel smoke (find with `graphify_tests_for`); add a case

- [ ] **Step 1:** Failing assertion: a ready job with 0 items yields title "Finish saving your meeting" (not "0 people ready to review"); with 3 items still yields "3 people ready to review".
- [ ] **Step 2:** Run; expect FAIL. **Step 3:** implement the title branch. **Step 4:** run; expect PASS. Commit.

---

## PR 2 — The orb and chip stop starting calls on one click (G-1)

On main the orb is `CosmoOrb` / `CosmoRoot` (`src/components/cosmo/`). Both the orb and the "N things due" chip call `talk` (`cosmo-root.tsx` ~line 96), which calls `openVoice(...)` and starts the session immediately. The orb already has `aria-label="Talk to Cosmo"`; the problem is the immediate start, not a missing name.

### Task 4: First-call confirmation

**Files:**
- Create: `src/lib/cosmo/first-call.ts`
- Create: `src/components/cosmo/cosmo-first-call-confirm.tsx`
- Modify: `src/components/cosmo/cosmo-root.tsx` (`talk`, ~line 96)
- Create: `scripts/smoke-cosmo-first-call.ts` (tier `pure`); register it
- Test: `e2e/cosmo-first-call.spec.ts` (new)

**Interfaces:**
- Produces in `first-call.ts`: `FIRST_CALL_KEY = "orbit:cosmo-first-call"`; `hasStartedCall(storage: Pick<Storage,"getItem">): boolean`; `markCallStarted(storage: Pick<Storage,"setItem">): void`.
- Produces: `CosmoFirstCallConfirm({ open: boolean; onStart(): void; onCancel(): void })`. Copy: title "Talk to Cosmo?", body "Cosmo listens through your microphone. Calls use your voice minutes.", buttons **Start call** and **Not now**.

- [ ] **Step 1: Write the failing smoke** with a fake storage: `hasStartedCall` false when empty; true after `markCallStarted`; false when `getItem` throws (private mode).
- [ ] **Step 2:** Run; expect FAIL. **Step 3:** implement `first-call.ts`. **Step 4:** run; expect PASS.
- [ ] **Step 5: Write the failing e2e.** Fresh context, visit `/dashboard`: click the orb (`aria-label="Talk to Cosmo"`): expect the dialog and **no** request to `/api/voice`. Press Escape/Not now: still no request. Click the orb again, **Start call**: request fires and `localStorage["orbit:cosmo-first-call"]` is set. Reload, click the orb: no dialog. In a fresh context, focus the "N things due" chip and press Enter: same dialog, no request.
- [ ] **Step 6:** Run; expect FAIL. **Step 7:** in `talk`, open the dialog when `!hasStartedCall(localStorage)`; `onStart` marks and runs the original body. **Step 8:** run e2e; expect PASS. Commit.

---

## PR 3 — One definition of "due" (G-3)

Today: dashboard "Due follow-ups" = `getDashboardCounts` (`src/lib/dashboard-aggregates.ts`: met contacts with `next_follow_up_at <= now()`); dashboard "Reminders" = every pending reminder minus some duplicates (`loadDashboardReminders`, `src/lib/reminders.ts`); the Reminders page rail uses `dueDaySql(tz)` (`src/lib/reminders-page-query.ts`, the only one on the bucket rule); bell and chip count `dueCount` from `loadNotificationPanel` (instant-based, capped at 80 reminders). The chip count is `panel.dueCount` (`src/lib/cosmo/nudge.ts`). On main the bell badge also adds Radar "today" moments; leave that as is.

### Task 6: Pin the disagreement with a characterization smoke

**Files:**
- Create: `scripts/smoke-due-counts.ts` (tier `pglite`); register it

- [ ] **Step 1:** Seed one user with: 3 reminders due today, 2 overdue, 2 upcoming, 1 undated, 2 contacts with a due follow-up. Assert the **target** invariants: dashboard `dueReminders` = rail `today` count = 5; bell reminder part = 5; `followUps` = 2; bell `dueCount` = 7; chip text "7 things due".
- [ ] **Step 2:** Run; expect FAIL on at least the dashboard Reminders tile (it counts all 8). Do not fix yet; keep it uncommitted until Task 7 and commit together.

### Task 7: Shared counter

**Files:**
- Create: `src/lib/due-counts.ts`
- Modify: `src/lib/dashboard-aggregates.ts`, `src/lib/reminders.ts` (`loadDashboardReminders`), `src/lib/notification-panel.ts`, `src/lib/reminders-page-query.ts` (rail), only where they compute these numbers

**Interfaces:**
- Produces: `getDueCounts(userId: string, tz: string): Promise<{ reminders: number; followUps: number; total: number }>` built on `dueDaySql(tz)` and the existing alertable predicates; `total = reminders + followUps`.
- Consumes: the `reminder-due-bucket.ts` rule; `smoke-reminder-due-bucket` must stay green.

- [ ] **Step 1:** Implement `getDueCounts`. **Step 2:** make all four consumers read it for the numbers in Task 6 (lists keep their own queries; only counts unify). **Step 3:** Task 6 smoke passes; `smoke-reminder-due-bucket` and the notification-panel smoke still pass. Commit.

### Task 8: Say what each number is

**Files:**
- Modify: `src/components/dashboard/dashboard-sections.tsx` (tiles), `src/components/notifications/notifications-panel.tsx` (header)

- [ ] **Step 1:** Failing e2e or render check: dashboard tile label "Due reminders" (not "Reminders"); bell header shows "<reminders> reminders · <followUps> follow-ups" next to the total. **Step 2:** implement. **Step 3:** run; expect PASS. Commit.

---

## PR 4 — Floating bar and chip stop hiding the primary action (G-5)

The audit saw this at first paint without scrolling. `<main>` already has `pb-[calc(var(--orbit-bottom-nav)+5rem)] md:pb-24` (`src/components/layout/app-shell.tsx` ~330), so first confirm whether it is a real bug.

### Task 9: Measure it

**Files:**
- Create: `e2e/floating-overlap.spec.ts`

- [ ] **Step 1:** At viewports 1512×731 and 390×844, for `/radar` (Radar off), `/dashboard`, `/contacts/<seeded id>`: scroll to the bottom and assert the bounding box of the last interactive element lies above the ask bar's top edge and does not intersect the chip or orb. Also assert the Radar "Turn on Radar" button is not covered **at first paint** (1512×731, no scroll).
- [ ] **Step 2:** Run. Expect the first-paint Radar assertion to FAIL and the scrolled ones to pass. If a scrolled one also fails, record which page and fix it in Task 10.

### Task 10: Fix what Task 9 proves

**Jason's call (Nov 16, overrides the earlier "move the CTA" idea):** hide the floating Ask bar on `/radar` unless Radar is already turned on.

**Files:**
- Modify: `src/components/layout/app-shell.tsx` (`showAskBar`, ~118-130; it already hides the bar on chat, settings, constellation, reminders, knowledge) and whatever supplies the shell with Radar's on/off state (`fetchRadarActivation().on`, used by `src/app/(clerk)/(app)/(main)/radar/page.tsx`). Prefer passing a boolean down from the server layout over a client fetch.
- Only if a scrolled assertion in Task 9 failed: also adjust the bottom padding in `app-shell.tsx`.

- [ ] **Step 1:** Failing e2e addition to Task 9's spec: with Radar off, `/radar` has no Ask bar in the DOM; with Radar on, `/radar` shows it; every other page still shows it. **Step 2:** implement the `showAskBar` condition. **Step 3:** Task 9 passes at both sizes. Commit.

---

## PR 5 — Reminders backlog stops overwhelming a new user (R-1)

Notes reminders are created in `saveNoteBatch` (`src/lib/note-batch-save.ts`). `bulkReminderAction` (`src/actions/reminders.ts`) already supports done/snooze/delete with `BULK_LIMIT = 200` and undo, but "select all" only covers the loaded page of 50.

### Task 11: Snooze everything overdue from notes

**Files:**
- Modify: `src/actions/reminders.ts`
- Create: `scripts/smoke-reminders-snooze-backlog.ts` (tier `pglite`); register it

**Interfaces:**
- Produces: `snoozeOverdueFromNotes(input: { toYmd: string }): Promise<{ count: number; undoToken: string }>`. Reuses the existing undo mechanism (`undoBulkReminderAction`); do not invent a second one.

- [ ] **Step 1: Failing smoke.** Seed: 250 overdue notes reminders (priority `normal`/`low`), 3 overdue notes reminders with priority `critical`/`high`, 4 overdue reminders the user created, 5 future ones. After the action: 250 snoozed to `toYmd`; the 3 high/critical, 4 user-created and 5 future untouched; `count === 250`; applying the undo token restores all 250 original due dates; another user's reminders untouched.
- [ ] **Step 2:** Run; expect FAIL. **Step 3:** implement in batches of `BULK_LIMIT`, scoped by `userId`, source = notes (same predicate as the "From notes" filter in `reminders-page-query.ts`). **Step 4:** run; expect PASS. Commit.

### Task 12: Offer it on the Reminders page

**Files:**
- Modify: `src/components/reminders/reminders-stage.tsx` (new banner above the list), `src/lib/reminders-page-query.ts` (expose the overdue-from-notes count)

- [ ] **Step 1:** Failing e2e: with 30 overdue notes reminders seeded, `/reminders` shows "30 overdue reminders from your notes" with **Snooze them** and **Review**; clicking Snooze them shows a toast with **Undo**; the Today count drops by 30; Undo restores it. With 5 overdue it shows no banner (threshold 20).
- [ ] **Step 2:** Run; expect FAIL. **Step 3:** implement (default snooze target: next Monday). **Step 4:** run; expect PASS. Commit.

### Task 13: Stop duplicate reminders per person across notes

**Files:**
- Modify: `src/lib/note-batches.ts` (extend the `dropSupersededWindowDrafts` idea across batches) or the insert in `src/lib/note-batch-save.ts`
- Test: extend the note-batch smoke (find with `graphify_tests_for`)

**Interfaces:**
- Produces: `isNearDuplicateReminder(existingTitle: string, newTitle: string): boolean`, pure, normalizes case and punctuation and strips a leading "check in with <name>:".

- [ ] **Step 1:** Failing assertions: for the same contact with a pending reminder "Check in with Wes: chat", a new "chat" or "Check in with Wes: chat" draft is dropped; "Send contact info" is kept. **Step 2:** run; expect FAIL. **Step 3:** implement and apply at insert. **Step 4:** run; expect PASS. Commit.

---

## PR 6 — Closeness explained (G-2), without relabeling

### Task 14: Hide empty, explain numbers

**Files:**
- Modify: `src/components/contacts/contact-stat-pills.tsx` (Health chip, ~76-95), `src/components/contacts/contacts-list.tsx` (~1157, percent pill), `src/components/dashboard/network-depth-chart.tsx`

- [ ] **Step 1:** Failing render/e2e checks: the "Health —" chip is absent when health is empty; the row percent pill has a visible tooltip "Closeness: how close Orbit thinks you are, from how recently and how often you talk"; the dashboard Network depth caption says which orbit names each bucket maps to, using the real cutoffs from `src/lib/closeness.ts`.
- [ ] **Step 2:** Run; expect FAIL. **Step 3:** implement. **Step 4:** run; expect PASS. Commit.

(Relabeling to one vocabulary waits on D1. Do not start it from this plan.)

---

## PR 7 — Lists show people, not noise (K-1, D-2, CT-1)

### Task 16: Knowledge lists people with summaries first

**Files:**
- Modify: `src/lib/knowledge-people.ts` (`loadKnowledgePeople`, order-by clause)
- Test: extend the knowledge smoke (find with `graphify_tests_for`)

- [ ] **Step 1:** Failing assertion: given 3 contacts where only the least recently touched has `ai_summary`, the default order puts it first; ties keep `last_interaction_at DESC`. **Step 2:** run; expect FAIL. **Step 3:** order by `(ai_summary is null or ai_summary = '') asc` before the existing keys. **Step 4:** run; expect PASS. Commit.

### Task 17: "People to meet" needs a reason

**Files:**
- Modify: `src/lib/people-to-meet.ts` (`loadPeopleToMeet`)
- Create: `scripts/smoke-people-to-meet-gate.ts` (tier `pure`); register it

**Interfaces:**
- Produces: `hasMeetingSignal(input: { aim: string | null; targetCompanies: string[] }): boolean`.

- [ ] **Step 1:** Failing assertions: false when `aim` is empty and no target companies (only schools set, as on the audit account); true with a goal or one target company. **Step 2:** run; expect FAIL. **Step 3:** implement and make `loadPeopleToMeet` return `[]` when false. **Step 4:** run; expect PASS. Commit.

### Task 18: Not-a-person names

**Files:**
- Modify: `src/lib/non-person-participant.ts` (`nonPersonContactSql`, neighbors of `isNonPersonEmail`) and `src/lib/names/classify.ts`
- Test: extend the non-person smoke (find with `graphify_tests_for`)

**Interfaces:**
- Produces: `isNonPersonName(fullName: string): boolean`: true for names containing a no-reply handle (`donotreply`, `no-reply`, `noreply`) or that are a bare email address; false for "Mom", "Dad", "Jason Pereira", "Priya Support".

- [ ] **Step 1:** Failing assertions with those exact inputs ("ScoutBook @DoNotReply" → true, "essarr@gmail.com" → true, "Mom" → false). **Step 2:** run; expect FAIL. **Step 3:** implement; apply in the People list query only (no deletion). **Step 4:** run; expect PASS. Commit.

### Task 19 (DDL, optional per D5): maiden names sort by real surname

**Files:**
- Modify: `src/db/schema.ts` (`contacts.sort_key`), `src/db/index.ts` (DDL + `SCHEMA_VERSION`), `scripts/schema-ddl.lock.json`
- Test: `scripts/smoke-contacts-sort-key.ts` (tier `pglite`)

- [ ] **Step 1:** Failing assertion: "Briana (Simmons) Medley" → sort key starts with `m`, not `(`; "Kailee (Zeltner) Webb" → `w`. **Step 2:** run; expect FAIL. **Step 3:** strip parenthesised text before taking the last word; bump `SCHEMA_VERSION` to the next free number and refresh the lock. **Step 4:** smoke and `npm run db:check` pass. Commit.

---

## PR 8 — Wayfinding and copy (G-7, RC-1, RD-1, CT-4)

### Task 20: `/constellation` redirect

**Files:**
- Modify: `next.config.ts` (redirects, ~98-107)
- Test: `scripts/smoke-nav-parity.ts` or a new small check

- [ ] **Step 1:** Failing assertion: `next.config` redirects include `{ source: "/constellation", destination: "/graph", permanent: false }`. **Step 2:** run; expect FAIL. **Step 3:** add it. **Step 4:** run; expect PASS. Commit.

### Task 21: Reminders first in the phone More sheet

**Files:**
- Modify: `src/components/layout/app-nav.ts` (`MOBILE_MORE_NAV` order)
- Test: `scripts/smoke-nav-parity.ts` must stay green

- [ ] **Step 1:** Move Reminders to the first item of `MOBILE_MORE_NAV`; parity smoke passes. Commit.

### Task 22: Copy fixes

**Files and exact copy:**
- `src/components/recruiters/gmail-import-panel.tsx:77`: "Google is connected as ${email}, but Orbit can't read your mail yet. Allow mail access to find your recruiters." Same shape in `outlook-import-panel.tsx:80`.
- `src/components/radar/activation/radar-activation.tsx` (~88-106): add the line "It reads your notes and contacts inside Orbit, never your inbox. You can turn it off any time." (Confirm this is true against Radar's real inputs before shipping; if Radar reads mail, change the line to match.)
- Add-contact form (`/contacts/new`): placeholders for name, company, role and school become generic ("Full name", "Company", "Role", "School"), not a person's real values.
- Tooltips (`title` + `aria-label`) on icon-only contact row buttons; move delete behind the existing row menu if one exists, otherwise ask before moving it.

- [ ] **Step 1:** Failing render/e2e assertions for each string above. **Step 2:** run; expect FAIL. **Step 3:** edit. **Step 4:** run; expect PASS. Commit.

---

## Not in this plan (needs its own spec, then a plan)

- **D-1** Dashboard first-screen restructure into one ranked Today list.
- **G-4** Merging Chat, the Ask bar and the orb into one visible assistant.
- **G-7** Regrouping the sidebar by purpose.
- **First-run experience**: the audit account was fully populated; walk the demo account or a fresh user first.
- **Closeness relabeling** until D1 is decided.
- Mobile pass for contact page, Capture, Reminders, Chat.

## Self-review notes

- Coverage: C-1, M-1, G-1, G-3, G-5, R-1, G-2 (partial, by decision), K-1, D-2, CT-1, G-7 (redirect, mobile order), RC-1, RD-1, CT-4, G-6 (tooltips) each map to a task. D-1, G-4, sidebar regroup, closeness relabel are deferred above.
- Contract check: `shouldAutoOpenJob` is defined in Task 1 and consumed in Task 2; `getDueCounts` in Task 7 is what Task 6 asserts; `snoozeOverdueFromNotes` in Task 11 is what Task 12 calls.
- Task numbers are not contiguous (5 and 15 are unused); every reference in this file uses the numbers as written.
- Risk: Task 7 touches four count sites and is the likeliest to surface surprises; Task 6 exists to make that visible first.

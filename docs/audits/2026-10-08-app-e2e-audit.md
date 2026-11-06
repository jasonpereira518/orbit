# Orbit end-to-end audit — 8 Oct 2026

Branch audited: `main` at `ea6ea73a` (PR #410 merged), run as the local demo workspace (`orbit-demo` launch config, PGlite, no Clerk, no AI key, `orbit_preview_unreleased=1` so Radar / Events / Outreach were visible).

**How it was run**

- Hands-on in the browser pane: dashboard, contacts list + Sarah Chen profile, every Capture tab, a full LinkedIn-URL capture → save, Reminders (done / snooze / actions), Chat (send with no key, thread switch), Imports, Settings + Integrations dialog, Constellation, Radar (list, focus, draft, schedule), notification bell, ⌘K palette, and the full quick-setup onboarding on a second server with demo seeding off (`ORBIT_DEMO_DATA=off`).
- Headless Playwright crawl of 39 routes at 1440×900 and 390×844 (console errors, failed requests, overflow, screenshots). Screenshots are in the session scratchpad under `crawl/out` and `crawl/out-phone`.
- Six parallel read-only code traces (click-path audits) over Capture, Contacts, Dashboard/Reminders/Radar, Chat/Knowledge/Graph, Imports/Settings, Events/Outreach/Recruiters/Onboarding. Those findings are marked **[trace]** below and were not all reproduced in the browser; each cites `file:line` so they can be verified quickly.

Severity: **P0** data loss / wrong data / security · **P1** a core flow is broken or misleading · **P2** polish, copy, consistency.

---

## 1. Headline findings

1. **Follow-up state lives in two places and they drift.** Completing a reminder leaves the contact "overdue" on the dashboard, in the bell and in `/contacts?followUp=due`; "Remind in 3d/7d" creates both a reminder and a contact clock, so the bell double-counts; the bell's "Mark done" on a follow-up closes *every* pending reminder for that contact with no undo. Visible in the demo: Kai Novak "Overdue 16 days · Last touch 3d ago", Sarah Chen "Overdue 12 days · Last touch 9d ago". **P0**
2. **Stepping between interactions while editing writes the previous interaction's notes/date/type onto the new one.** No undo on that update. **P0 [trace]**
3. **Logging a note from a contact's profile overwrites the user's own 1–5 rating with the model's guess (or 2).** That rating is "the strongest closeness signal the app ever gets". **P0 [trace]**
4. **Every Events, Outreach and Radar server action is callable while the surface is "coming soon"**, including the ones that spend Orbit credits; five Events connector actions have no surface check at all. `requireVisibleSurface` checks `hidden`, never `comingSoon`. **P0 [trace]**
5. **Imports: a second file drop while a queue is previewing/running replaces the queue, and the parked loop then imports the new drop with nobody pressing Import.** **P0 [trace]**
6. **Capture loses the user's notes when extraction fails and the page reloads** (only "Dismiss" is offered, which deletes them); editing a suggested reminder's title in the summary is silently discarded at save. **P1 [trace]**
7. **Chat: switching or deleting a thread mid-stream drops or mis-attributes the answer**; "Ask again" on an older answer re-asks the newest question. **P1 [trace]**
8. **No-AI-key experience is inconsistent and dead-ends.** Chat bounces the question back into the composer with only a transient toast; Radar "Draft message" opens an empty sheet and immediately fires an error toast with no link and no manual compose; Knowledge "Refresh" says "Not found"; Constellation "Refresh" reports success when every embedding failed. For students (who will not have a key) this is the default experience. **P1**
9. **Header actions collide with the floating bell at desktop widths** (Contacts/Recruiters toggle, Outreach "New campaign", Recruiters toggle all sit under the bell at 1280–1440). **P1**
10. **Phone contacts list truncates names to a few characters** ("Kai Ac…", "Rachel Adeye…") because each row keeps the % badge, LinkedIn, follow-up and delete controls. **P1**
11. **Webhooks "contact added / interaction logged" only fire for records created through the REST API**, never for capture, import, manual add or MCP, so an "Active" webhook never delivers for a normal user. **P1 [trace]**
12. **Onboarding front-loads the two slowest things for a new grad**: a LinkedIn export (24-hour wait) as "Start this first", then an AI API key, before "Add your first people". The realistic student paths ("I don't use LinkedIn", "I'll add people later") are small text links. **P1 (audience)**

---

## 2. Bugs verified in the browser

### Dashboard
- Due follow-ups rows contradict themselves: "Overdue 16 days · Last touch 3d ago" (Kai Novak), "Overdue 12 days · Last touch 9d ago" (Sarah Chen). Root cause is item 1 above: an interaction never advances the contact's `nextFollowUpAt`.
- "Goal-aligned contacts" shows a flat **100% match** for all five people, including a Technical Artist at Epic Games against a pre-seed fundraising goal. The score saturates and is not discriminative.
- The "Your orbit in numbers" band rendered as an empty dark strip at the bottom of the dashboard in the pane (the copy is in the DOM). On Radar the same widget floats as a dark card over the page header and the bell.
- Suggested outreach shows a bare "Reply rate 33.3%" with nothing to say what it is a rate of (it is the Outreach account rate, a coming-soon surface).
- Seeded goals, lists and copy are founder-centric ("Raise a pre-seed round", "Hire a founding engineer", a "Fundraising" reminder list). See §5.

### Contacts
- Clicking a contact's **name** opens a hover-card preview instead of navigating; clicking elsewhere on the row navigates. Rows are `<li role="link">`, not anchors, so there is no middle-click / open-in-new-tab and no `href` in the accessibility tree.
- Letter headers E, F, G … O render as **empty sections** above "Load more" before those pages are loaded.
- Separator spacing differs by row state: `San Francisco, CA · Last touch 36d ago` vs `Chapel Hill, NC·Overdue 31 days·Last touch 200d ago`.
- The unlabeled percentage badge (20%, 46%, 93%) has no tooltip or legend on the list.
- Phone: name/title truncation (item 10).
- Profile shows three different numbers for one relationship with no explanation of how they differ: **Closeness 93%**, **Health 84**, **Your rating 80%**.
- Profile reminder reads "Due Sep 26" with no overdue styling although it is 12 days overdue; the dashboard card does say "Overdue 12 days".
- Avatars: `/api/avatars/*` returned 429 and 404 for several rows on first load (upstream rate limit), leaving silent silhouettes; Settings shows "Fetching LinkedIn photos (waiting on rate limit) 0 of 1 · 0%".

### Capture
- The LinkedIn-URL-only path works end to end (card → closeness → "Keep" → "Save 1 contact + 1 reminder" → "Jordan Rivera Test is in your orbit").
- The Save button shows **no pending state**: it stayed clickable and unchanged for ~10 s before the success state appeared (dev compile inflated the wait; the missing spinner is real, see capture K-LOW).
- A bare URL capture **creates a reminder the user never asked for**, and neither the summary nor the success card says what the reminder is.
- "Keep" and "Not now" are icon-only buttons with a 10px hint line (`← not now · → keep · ↓ later · drag the name to swipe`).
- Each capture logs `[orbit:job.embedding-backfill.kick] … TimeoutError` server-side in demo mode (no embeddings provider).
- Phone: the five tabs wrap into two rows ("Messy Notes / Notes Library / Structured Logging").

### Reminders
- Mark done (with Undo toast), snooze picker and the actions menu all work. Lists, counts and the "Suggested" queue render correctly.
- Everything in §3 Reminders [trace] stands on top of this.

### Chat
- With no key: send → "Starting…" for the request duration → the user bubble disappears and the question is put back in the composer. Only a transient toast explains why; the thread shows nothing.
- Suggestion chips are templated without grammar: "Could Jordan Rivera Test help me with Raise a pre-seed round from Triangle and developer-tools investors?"
- Clicking another thread while "Starting…" did nothing visible (the rail is meant to lock while busy; see chat H1 for the case where it does not).

### Radar
- List and Focus modes work; Focus has keyboard hints (`j/k`, `s`, `d`, `z`, `x`).
- "Draft message" with no key: the sheet opens with "Generate" and an empty body, an error toast "Add your AI API key in Settings to use this" fires immediately with no link, and there is no plain compose fallback. Tom Bennett also has no email, so "Add an email or LinkedIn URL to send" shows at the same time.
- The "Add an AI key for a one-line why and an opener" line appears on five of eight cards; the cards still give a usable reason without it, which is good.

### Notifications, palette, settings
- Bell alert says "Add your **Google Gemini** API key" while every other surface lists Gemini / OpenAI / Anthropic.
- The bell shows an "Admin console" button to the demo user (admin 404s in demo mode).
- ⌘K works: people + "Capture this: …". No pages or actions appear for a people query, which is fine; worth confirming "Go to Reminders"-style commands exist for a non-person query.
- Integrations dialog: provider cards, "Keep work history current" toggle, Advanced section all render. Settings page renders every group. Good.

### Marketing and system
- `/pricing` (3862 px tall) and `/contact` (6932 px tall) have **thousands of pixels of empty starfield** below the content on desktop and phone.
- `/pricing` says "Not on sale yet" on Pro/Max; `/upgrade` says "Subscription checkout is unavailable in this environment"; the dashboard banner says "Compare plans". Three different states for the same fact.
- Every landing-page load requests `/api/live/network` and `/api/live/snapshot` (404). Nothing in `src/` or `public/` references them; most likely the desktop preview tooling or an extension. Check production logs before chasing.
- **The dev server process died once** during the crawl, right after a 32 s `/api/chat` response, with repeated `uncaughtException: Error: aborted (ECONNRESET)`. There are no `process.on` handlers in `src`. A second chat send on a fresh server did not crash (245 ms, 200). Not deterministic; worth finding which handler writes after the client aborts (streaming chat, `after()` work, or the avatar-backfill/track POSTs that are aborted on every navigation).
- Onboarding on an empty account: the first pane visit to `/dashboard` landed on the empty dashboard, not `/onboarding` (curl got the 307 twice). Could not reproduce reliably; `needsOnboarding` treats "any contact or import" as onboarded, so check what the first dashboard render inserted. Low confidence.

---

## 3. Bugs found by code trace

Grouped by area. HIGH/MEDIUM in full; LOWs summarised at the end of each block.

### Reminders, dashboard, Radar
- **R1 [P0]** `completeReminder` (src/lib/reminders.ts:1487-1529) sets `reminders.status='done'` only; `contacts.nextFollowUpAt/followUpStatus` are untouched, so the contact stays due on the dashboard stat, the bell and `/contacts?followUp=due`. Fix: when the reminder has a `contactId` and matches the contact's due date (or is its only pending reminder), null the clock and carry the old values in `CompletionSnapshot` so Undo restores them.
- **R2 [P0]** `scheduleContactFollowUpForUser` (src/lib/reminder-writes.ts:160-184) inserts a `manual` reminder *and* sets the contact clock; the dashboard and bell dedupe only `generated`, so the bell badge counts the contacts the user acted on twice. Fix: write a `follow_up`/`generated` type and extend both dedupe predicates.
- **R3 [P0]** Bell "Mark done" on a follow-up row (notifications-panel.tsx:729-744 → `clearContactFollowUpForUser` reminder-writes.ts:194-212) completes **every** pending reminder for the contact, no confirm, no undo. The dashboard version is two-step for exactly this reason. Fix: same two-step, or only close the matching reminder and return snapshots for Undo.
- **R4 [P1]** Bell badge / "Due now" use an instant compare (`dueAt <= now`, notification-panel.ts:173-176) while `/reminders` Today uses the viewer-tz day rule, so a reminder for "tomorrow" is due from 7 pm ET the evening before and the badge disagrees with the view it links to. Fix: `dueDayOf(dueDate, tz)` with the `orbit-tz` cookie.
- **R5 [P1]** `followUpDueLabel` (due-follow-up-row.tsx:8-27) runs on the server in UTC with `max(1, floor)`: "Overdue 1 day" an hour after due, "Due today" by UTC date. The same bug `reminder-due-bucket.ts` was written to kill.
- **R6 [P1]** "Pending reminders" stat links to a view with a different count; the card's "See more (N)" uses the capped list length, not the total (dashboard-sections.tsx:284-286, reminders-dashboard-card.tsx:33-35).
- **R7 [P1]** Radar "Not for this person" dismisses every card for the contact; Undo restores only one (actions-core.ts:75-126).
- **R8 [P1]** Radar Schedule / dashboard presets **move an existing hand-written reminder's due date** if the contact has any pending reminder (reminder-writes.ts:139-158); Radar's schedule has no Undo.
- **R9 [P1]** Reminders queue optimistic exit restores a stale snapshot on failure, resurrecting rows another action already removed (reminders-stage.tsx:343-374).
- **R10 [P1]** Dashboard "Clear it?" has no catch → silent failure (easy-follow-up.tsx:176-210).
- LOW: no status guards on done/snooze (a dismissed reminder can come back as done); `scheduleContactFollowUpAt` accepts any date string ("2026-02-30" rolls over); double `router.refresh()` per queue action.

### Contacts
- **C1 [P0]** Interaction detail sheet: stepping Newer/Older while editing keeps the edit form and saves A's fields onto B (interaction-detail-sheet.tsx:159-177, 287-309). Fix: disable the chevrons while editing and reset `editing` on id change.
- **C2 [P0]** Logging a note from the profile resets `relationship_score` + `stated_closeness` to the model suggestion or 2 (log-interaction-sheet.tsx:211-223 → note-batch-save.ts:223-264 → contact-writes.ts:1022-1027).
- **C3 [P1]** A–Z rail letter becomes an invisible `letter=` filter carried by every later search/filter change (contacts-filters.tsx:116, contacts-page-query.ts:147-154); typing "Alice" after jumping to M finds nothing and the count excludes A–L.
- **C4 [P1]** `sort=relevance` leaks into the URL; clearing the search leaves a 50-row list with no Load more, no rail, and Sort reading "Name" (contacts-filters.tsx:87-140, contacts-page-query.ts:61,170).
- **C5 [P1]** "Keep in touch" presets never show the saved cadence; the page never passes `keepInTouchDays` (contact-follow-up-section.tsx:108; contacts/[id]/page.tsx:404-410). Always "Not set".
- **C6 [P1]** Manual "Create contact" toasts "Added to your orbit" and redirects even when it merged into an existing person and overwrote their company/title (contacts.ts:653-690; `createContactDetailed` exists with zero callers).
- **C7 [P1]** The "Closeness" filter filters on the 1–5 rating, not the closeness % the rows display (contacts-filters.tsx:415-447 → contacts-page-query.ts:97-98).
- **C8 [P1]** Filter bar state never resyncs with the URL (Back from a profile, `/contacts?followUp=due`), so the controls show one query and the list another (contacts-filters.tsx:81-88).
- **C9 [P1]** "Move earlier/later" fails for evening interactions outside UTC: client day key in browser tz, server rebuilds the day in UTC and throws "Invalid reorder payload" (contacts.ts:935-948). The update loop is also not transactional.
- **C10 [P1]** "Send email" re-enables after the first send with the draft intact → second click sends a duplicate (contact-follow-up-section.tsx:455-464).
- **C11 [P1]** Clearing a follow-up has no try/catch inside the transition → error boundary (contact-follow-up-section.tsx:320-343; easy-follow-up.tsx:193-205).
- **C12 [P1]** Merge toast promises "Undo any time from Contacts → Duplicates" but that button only renders when pairs are pending (contacts/page.tsx:155-157).
- **C13 [P2]** Brief card "Refresh" reads "Updating…" permanently on a stale brief and gives no feedback when clicked (contact-brief-card.tsx:45-51).
- LOW: search debounce races a filter click within 250 ms; a Load more in flight during a rail seek appends the old page; LinkedIn URL inputs are `type="url"` so "linkedin.com/in/x" is rejected at submit but accepted by paste-capture; clearing Strength stores 0 with no server clamp.

### Capture
- **K1 [P1]** Editing a reminder title in the summary is discarded at save: `CaptureReminderChoices` has no title field (suggested-reminders-review.tsx:122-126 → capture/types.ts:251-255 → capture-job-runner.ts:491).
- **K2 [P1]** Failed extraction + reload → notes box empty, banner offers only "Dismiss" which deletes the job (capture-flow.tsx:225-226, 451-465; review-reducer.ts:142-145). `onRetry` is never passed.
- **K3 [P1]** A merged multi-file review that lands mid-review is orphaned and silently discarded by the next Extract (capture-flow.tsx:119-125, 195-217; capture-jobs.ts:252-271).
- **K4 [P1]** Fast consecutive Keep/Not-now decisions regress to the previous card because stale replies `seedCaptureJob(..., {force:true})` (capture-flow.tsx:394-404; job-store.ts:84).
- **K5 [P1]** Voice "Clear" leaves the transcribed job server-side; the transcript comes back on reload (voice-capture.tsx:148-150; use-capture-ingest.ts:144, 350-357).
- **K6 [P1]** A failed save strands the review: phase drops to "input", decisions are locked, Dismiss discards with no confirm (capture-flow.tsx:455-462; capture-jobs.ts:660-664).
- **K7 [P1]** Structured "Save interaction" is two writes with one error path → duplicate interaction on retry (structured-capture-form.tsx:142-171).
- **K8 [P1]** Upload dialog "Extract people" on an already-captured file extracts whatever was already in the box (upload-files-dialog.tsx:225-232; messy-notes-capture.tsx:211-235, 298-302).
- **K9 [P1]** "Add as contact" for an unresolved mention links to Structured Logging, which can only pick an *existing* contact (note-batch-result.tsx:367-369; structured-capture-form.tsx:91-99).
- **K10 [P2]** "they're in Ignored people below" is false until the capture is saved (capture-summary.tsx:131-136).
- LOW: Save has no local pending state (what I saw in the browser); "Forget" in Ignored people is optimistic with no rollback; Voice tab lets you record with a key that cannot transcribe; "Capture deleted" toasts even when `deleted:false`; meeting hand-off failure leaves a stale `resumable` and burns a `capture` rate-limit token per status change.

### Chat, ask bar, Knowledge, Constellation
- **H1 [P1]** Thread rail: `disabled={busy && !active}` leaves the active row clickable and the phone History dropdown has no busy gate; the stream is never aborted, so the answer vanishes or lands under the wrong title (chat-history-rail.tsx:165-172; chat-panel.tsx:709-762, 1014-1041, 1439-1449).
- **H2 [P1]** Deleting the open chat mid-stream resurrects it in the rail or fails the answer with a Sentry-reported FK error (chat-panel.tsx:880-901; route.ts:280).
- **H3 [P1]** "Ask again" on an older answer sends `lastUserQuery`, i.e. the newest question (answer-actions.tsx:83-87; chat-panel.tsx:1340).
- **H4 [P1]** Ask bar "Remind me" swallows failures and creates duplicates on double-click; `ReminderButton` already fixes this for /chat (floating-ask-bar.tsx:985-1007; reminder-button.tsx:15-26).
- **H5 [P1]** Stop leaves the question persisted with no answer and feeds it back to the model; `discardUnansweredQuestion` sits below the `aborted` early return (route.ts:314-320).
- **H6 [P1]** Constellation "Refresh" reports "Constellation refreshed" even when every embedding failed; with no key this is the only outcome (network-graph.tsx:671-768; graph.ts:165-171).
- **H7 [P1]** Leaving /graph mid-refresh leaves a "Refreshing constellation" job running forever in the notification Tasks list (network-graph.tsx:697-708, 763-767).
- **H8 [P1]** Knowledge dossier "Refresh" turns every thrown error into 404 "Not found" (knowledge/refresh/route.ts:56-57; dossier-refresh.tsx:79).
- **H9 [P1]** `commitProposedAction` leaks raw `err.message` to the toast (chat-actions.ts:163-168) against the repo's `friendlyError` rule.
- **H10 [P1]** Source chip says "That note has been removed" on any network failure and never retries (source-chip.tsx:25-35).
- **H11 [P1]** Ask bar has no Stop; "Start over" mid-answer orphans the stream and can leave a question-less bubble (floating-ask-bar.tsx:415-458, 586-596).
- LOW: proposed-action card stays Confirm-able after `already_done`; finished answer remounts on `done` and loses draft edits; edit-older-turn 409 surfaces as the literal `confirm_discard`; Knowledge people search says "No one matches" beyond the first 300 rows.

### Imports, Settings, integrations
- **I1 [P0]** File drop / paste while previewing or running replaces the live queue; the parked `runQueue` loop then imports the new drop unreviewed (import-hub.tsx:438-555; use-import-queue.ts:220, 367-401; deterministic `q${i}` ids).
- **I2 [P1]** Webhook triggers only fire from `/api/v1/*` writes (api/v1/contacts/route.ts:203, api/v1/events/route.ts:64); `contact.updated` is accepted by the schema with no emitter anywhere.
- **I3 [P1]** "Clear key" deletes every contact embedding with one click and no confirm (provider-card.tsx:282-295 → settings.ts:268-308).
- **I4 [P1]** OAuth return to `/imports` is never acknowledged: no toast, `?google=connected` / `reason=plan_limit|missing_scope` stay in the URL; the only reader lives inside the Google/Outlook Contacts cards, which mount only while expanded (calendar-connections-card.tsx:65-134; use-provider-connection.ts:244-298).
- **I5 [P1]** Desktop-notification toggle: fire-and-forget write with an unconditional success toast; pulse/refresh reconciliation can snap the row back to the stale value (browser-notifications.ts:58-61; notification-settings.tsx:80-123).
- **I6 [P1]** "Import everything" while a standalone import is running marks every file "Didn't finish" without attempting any, then toasts it as success (import-queue-card.tsx:304-317; import-job-runner.ts:665-667).
- **I7 [P1]** Social links saved unvalidated and rendered as raw `href` on the sun panel: values are stored as typed (settings.ts:433-460; contact-inspect-panel.tsx:315-336).
- **I8 [P1]** Account-page Disconnect / "Disconnect and delete" runs while a Gmail scan is still writing recruiters; nothing cancels the scan (gmail.ts:228-256, 372).
- **I10 [P1]** Calendar subscription list prints the secret ICS URL in full and the raw provider error body; the sibling card masks both (calendar-subscribe-panel.tsx:150-179; calendar-sync.ts:353-359).
- **I11 [P1]** Cancel in both delete dialogs skips the reset, so reopening shows type-to-confirm already satisfied (delete-data-dialog.tsx:264-271; delete-account-dialog.tsx:76-78).
- **I12 [P1]** The import poll re-opens the running job's row every 1.5 s, closing whichever row the person opened; queued runs fire N success toasts (import-hub.tsx:559-563; import-job-watcher.tsx:25-59).
- **I13 [P1]** Outreach credentials can never be removed; blank fields keep old secrets while the UI shows "not configured" (settings.ts:400-426; outreach-settings.tsx:98-132).
- **I14 [P1]** LinkedIn cards and the drop queue admit files above the 32 MB Server Action body limit, which then fail as "couldn't read that file" (linkedin-connections-import.tsx:96-129; next.config.ts:143; import-constants.ts:32).
- **I15 [P1]** "Switch account" never requests an account chooser (`prompt:"consent"` only), the button has no busy state, and one state cookie per provider breaks two-tab connects (gmail.ts:150-161, 269; actions/gmail.ts:46, 181-187).
- LOW: "Custom model ID" silently swaps unknown ids for the default with a success toast; webhook create/delete/retry and calendar Pause/Resume/Remove have no catch; calendar-feed "Turn off" is irreversible with no confirm; "Take the tour again" deletes tour examples and resets onboarding with no confirm; Targets/Schools Enter bypasses the pending guard; dead `revertImportAction` + empty `import-revert-button.tsx`; raw `imports.error_message` reaches the client; theme action accepts any string; export toast fires on headers, not completion.

### Events, Outreach, Recruiters, Onboarding, pricing
- **E1 [P0]** Coming-soon gate missing on the action layer (item 4): make `requireVisibleSurface` call `isSurfaceLive`; add the surface check to `connectLuma`, `connectEventFeed`, `setGmailEventScan`, `startEventbriteOAuth`, `disconnectEventProvider` (events.ts:784-945); add a smoke check.
- **E2 [P0]** Outreach "Send selected (N)" re-sends messages already sent and awaiting reply; `sendOutreachMessageNow` has no status guard (campaign-workspace.tsx:122, 182; outreach.ts:1267-1286). "Copy all"/"Open all" also overwrite `sent` with `copied`/`opened`.
- **E3 [P1]** Quality warnings never gate a bulk send (`ignoreWarnings` set true in both branches) and the warning text renders behind the modal (bulk-action-bar.tsx:131-180, 248).
- **E4 [P1]** Recruiter compose: failed drafts vanish from the list until reload (compose-workspace.tsx:246-268).
- **E5 [P1]** Outreach wizard creates a campaign (and spends AI) on step 1, has a dead "Review" step, advances on zero search results, and leaves "Untitled campaign" orphans on abandon (outreach-wizard.tsx:31, 71, 124).
- **E6 [P1]** `OutreachReadinessStrip` (daily sends left, provider state) is dead code; the user first learns about the cap when a bulk send throws mid-way.
- LOW: roster paste toast counts parsed rows not inserted; swallowed errors in event companies panel, who-to-talk-to explain, onboarding `choosePath`/`leave`, recruiter Discard all, checkout; prospect table shares one `pending` flag; "Regenerate" overwrites unsaved edits; add-event date parsed as UTC midnight (edit path is correct); onboarding import branch resumes with the wrong Back/Continue after refresh; Highlights "Go to dashboard" not disabled while pending.

Verified sound by the traces (no findings): user scoping on every mutating action in all six areas; no BYOK key, OAuth token, API key or webhook secret is returned to the client; OAuth callbacks check `state.userId`; webhook delivery is https-only with DNS re-resolution; account deletion ordering; import undo confirm; chat body validation and attached-contact re-checks; `/scan/[token]` routes.

---

## 4. UI inconsistencies and polish

**Layout**
- Floating bell + feedback column overlaps right-aligned page header actions on Contacts, Recruiters and Outreach at 1280–1440 (verified). Either reserve the gutter in the app shell or move the bell into the header row.
- Phone contacts row: four trailing controls starve the name. Move LinkedIn/follow-up/delete into the row's overflow or a swipe action; keep one badge.
- Phone capture tabs wrap to two lines.
- Dashboard "orbit in numbers" band renders blank; Radar's floating copy of it overlaps the header.
- Marketing `/pricing` and `/contact`: pages are 3–7 k px tall with content in the top third (a min-height on the sky or a page-bottom Reveal that never fires, see the `orbit-reveal-page-bottom-trap` note).
- Events card image is a flat grey block when there is no image.

**Vocabulary (one concept, many words)**
- Relationship scales: Closeness %, Health, Your rating, Strength (1–5), Priority (0–3), Inner/Mid/Outer orbit, Close/Warm/Cool. The profile shows three of them side by side. Pick one user-facing scale (orbit tier + one number) and label the rest as inputs in Edit.
- Logging: sidebar "Log interaction", page "Capture", button "Extract people", tabs "Messy Notes / Voice / Meeting / Notes Library / Structured Logging". The target user thinks "I met someone" or "I had a call".
- Recruiter stages expose raw enum values `planned / contacted / active / archived`.
- Outreach copy mixes "ICP", "reply-optimized", "sender reputation" with job-seeker examples in the same flow.

**Feedback patterns**
- No-key messaging: banner with link (Capture, Chat page) vs toast with no link (Radar draft, ask bar) vs "Not found" (Knowledge) vs false success (Constellation). One shared `AiKeyNotice` + one shared failure toast with a deep link.
- Error toasts: some actions use `friendlyError`, several leak raw messages or swallow silently (listed above).
- Destructive actions: some two-step (dashboard Clear, meeting discard), some one-click (bell Mark done, Clear key, Start over in the capture deck, calendar feed Turn off, Take the tour again).
- Hover-only affordances (delete chat) are unreachable on touch.
- Icon-only primary actions on the capture deck vs labeled buttons everywhere else.

**Copy**
- "Add your Google Gemini API key" in the bell vs three providers elsewhere.
- "Reply rate 33.3%" with no subject; "Follow-up set for a week from now" with no date; "Due Sep 26" with no overdue state.
- Templated chat suggestions ("help me with Raise a pre-seed round…").
- Pricing/upgrade/dashboard disagree on plan availability.
- Separator spacing (`·` vs ` · `).
- Export copy says "everything" but photos, embeddings and credentials are excluded.

**Empty states**
- Dashboard empty state is good (three CTAs). Contacts list uses one "No contacts match these filters" state for both zero contacts and zero matches. Knowledge/Imports push "Import LinkedIn" first; the graph's "Add notes" first is the better default for a thin network.

---

## 5. Audience fit: early-career students and new graduates

What they are doing: career fairs, info sessions, coffee chats with alumni, recruiter screens, referral asks, application tracking. Thin network, no API key, phone-first, LinkedIn + Gmail + Google Calendar + Handshake.

**Blocks today**
- No-key mode is the default and it dead-ends (item 8). Options: a small managed allowance on Free (the `ai-access.ts` gate already supports managed keys, currently off), or a genuinely complete no-AI path: Structured Logging that can *create* a contact, a plain compose in Radar/profile, suggestion chips that work without a model.
- Onboarding order (item 12): put "Add your first people" first with Capture as the recommended card, make the LinkedIn export a background nudge ("we'll remind you when it lands"), move the AI key to the "What Orbit can do" step as an optional unlock.
- Demo/seed persona is a founder. Add a student seed (career fair, two recruiters, three alumni, a professor, lists "Recruiters / Alumni / Referrals") and use it for the tour and screenshots.

**Features that would land**
- **Recruiter pipeline, not recruiter list**: stages Applied → OA → Phone screen → Onsite → Offer / Rejected with dates, the posting link, and "last touched / next step" on the link; a Kanban or table view; move it out from behind the Contacts toggle for this persona.
- **Career-fair mode** (Events is coming soon but most pieces exist): paste the exhibitor list → "who to find" ranked by target companies and schools → booth notes via phone scan → auto follow-up due in 24–48 h. Radar's schedule presets are 3/7/14 days; add 1 and 2 days.
- **Follow-up templates with intent**: thank-you after a coffee chat, referral ask, informational-interview request, "keep me in mind" after a rejection. The `intent` field exists but only renders when already set.
- **Alumni lens**: "same school" is already an edge in the graph and an event-ranking signal; expose "alumni at my target companies" as a Contacts filter and a Radar reason.
- **Target role / graduation year / search status** on the profile (today: free-text "About you" + target companies + schools without years). Radar and Goals should read them.
- **Warm paths**: "who can intro me to X" is the single most valuable student question; `/intros` exists on another branch (see the warm-intro-finder note) and should be in the student spec.
- **Phone**: capture via the `/scan` hand-off is good; the contacts list and capture tabs need the fixes above; Later/Not-now on the deck needs a visible re-review entry ("3 for later").

## 6. Audience fit: later-career professionals

What they are doing: keeping a large network warm, conference follow-up, hiring, advisory/board relationships, warm intros for others, job moves of former colleagues.

**Blocks today**
- "Keep in touch" cadence never displays its saved value (C5) and a logged note silently rewrites the hand rating (C2). These are the two signals this user most relies on.
- Follow-up double counting and the bell's destructive Mark done (R1–R3) are worst at scale.
- Outlook/Exchange: contacts + calendar exist, Exchange on-prem and admin-consent tenants fail with a generic `missing_scope`; "Email activity" is Gmail-only.
- No bulk operations on contacts (tag, list, cadence by tier). Lists exist only for reminders.

**Features that would land**
- **Cadence by tier**: set monthly/quarterly/yearly per orbit tier once; Radar and Reminders follow it. Show the cadence on the list row and profile.
- **Job-change loop on the profile**: Career moves lists "Noticed Oct 2026" with no action; the congratulate-and-send flow that just shipped for Radar belongs there too, plus "former colleague moved → introduce to X" suggestions.
- **Relationship types**: advisor, investor, former report, board, client. Today everything is one contact with tags.
- **Meeting capture + calendar prefill** (on PR #411) and a post-meeting digest to the right contact are the daily surface for this user; make Meeting the first tab when a calendar is connected.
- **Give intros, not just get them**: "who should I connect to each other" from the mentions graph.
- **Compose / reply from Orbit** (coming soon) and the Monday digest with a frequency choice.

---

## 7. Integrations: what exists, what is planned but invisible, what is missing

**Live today**
- LinkedIn connections CSV/ZIP, LinkedIn messages, LinkedIn URL drop, Chrome extension (LinkedIn page capture), own-profile import (PR #411 branch).
- vCard / CSV contact files; Google Contacts; Gmail activity + recruiter scan; Outlook contacts; Google / Outlook calendar sync and ICS link/file (paid); Google Drive Docs/Slides (paid, Picker env only).
- Reminders ICS feed out; desktop notifications; Monday Radar email.
- Claude / ChatGPT via MCP (Clerk OAuth); REST API keys; webhooks (only fire from API writes, I2).
- Phone scan hand-off (`/scan/[token]`); voice; meeting capture (Chrome desktop, Deepgram).

**In the registry or code, no UI**
- Apple Contacts / Calendar / Reminders: server actions exist (`src/actions/apple.ts`), no caller. The integrations strategy note already calls iCloud DAV + Shortcuts the individuals-first path.
- HubSpot, Notion: `planned` in `connectors/registry.ts`, never rendered. Luma / Eventbrite / Apollo live behind coming-soon Events / Outreach. Zapier is a registry alias that appears nowhere in the dialog.
- `Chat messages` (WhatsApp / iMessage) is behind the `chat-imports` flag; iMessage needs the `imessage-exporter` CLI.

**Missing for the audiences**
- Students: Handshake (no export format detection; a generic CSV column-mapper would cover it and most career-services exports), Notion/Google Docs notes as a note source without the paid Drive picker, `.edu` tenant warning before the OAuth bounce, university calendar ICS guidance.
- Professionals: Slack (DM-based "I talked to X" capture), Calendly (meeting → contact + follow-up), Salesforce/HubSpot two-way, Zoom/Meet transcript import for non-Chrome users, Exchange on-prem (state the limit).
- Both: a visible Zapier/Make recipe page; webhooks that fire from in-app writes; a connected-assistants list for MCP.

**Where Orbit plugs into the existing workflow (highest leverage first)**
1. After a conversation: phone scan / voice / paste → contact + follow-up. Works; needs the no-key path and the save pending state.
2. Inbox: Gmail recruiter scan works; Outlook equivalent missing; "they messaged you N days ago" Radar reason is strong.
3. Calendar: meeting prefill + post-meeting capture (PR #411) and reminders feed out. Add "tomorrow's meetings → who am I seeing and what did we last say" on the dashboard.
4. LinkedIn: import, URL drop, extension, job-change detection all present; the follow-up loop back to LinkedIn is copy-only (no send), which is fine.
5. Assistants: MCP lets Claude/ChatGPT read and draft; needs scopes and a revoke list before promoting it.

---

## 8. Suggested order for the spec

**Sprint A — correctness (P0s, mostly small diffs)**
R1 R2 R3 (follow-up clock + dedupe + bell confirm), C1 (edit-step overwrite), C2 (rating overwrite), E1 (`isSurfaceLive` in `requireVisibleSurface`), E2 (send status guard), I1 (queue drop guard + nonce ids), K1 K2 (reminder title, failed-extraction retry), H1 H2 (`disabled={busy}` + abort), I3 I7 (confirm on Clear key; validate socials), header/bell overlap, phone contact row.

**Sprint B — the no-key and first-run experience**
Shared `AiKeyNotice` + failure toast with deep link; Radar/profile plain compose fallback; Structured Logging can create a contact; onboarding reorder (people first, LinkedIn as background nudge, key as optional unlock); student seed persona; capture Save pending state + "why a reminder" line.

**Sprint C — audience features**
Recruiter pipeline stages + dates; 1–2 day follow-up presets + intent templates; cadence display and by-tier defaults; alumni filter; target role / grad year / status fields; score vocabulary consolidation.

**Sprint D — integrations**
Webhooks from the shared write path; Zapier page; Apple UI over the existing actions; generic CSV mapper (Handshake); OAuth return handling on /imports; MCP scopes + revoke list.

---

## Appendix

**Routes crawled (all 200 at both widths, no React/page errors):** `/`, `/pricing`, `/contact`, `/privacy`, `/terms`, `/interest`, `/connect`, `/sign-in`, `/sign-up`, `/upgrade`, `/suspended`, `/dashboard`, `/radar`, `/contacts`, `/contacts/new`, `/contacts/duplicates`, `/contacts/[id]` ×2, `/capture`, `/capture/[batchId]` ×2, `/chat`, `/events`, `/events/[id]`, `/graph`, `/imports`, `/knowledge`, `/outreach`, `/outreach/new`, `/outreach/[id]`, `/recruiters`, `/recruiters/new`, `/recruiters/compose`, `/recruiters/[id]`, `/reminders`, `/settings`, `/settings/plan-activation-preview`, `/onboarding`, `/onboarding/wizard`, `/scan/[bad-token]` (expired page), `/nope-404` (404 page). No horizontal overflow on any route at 390 px.

**Not covered:** admin console (404 in demo mode), real OAuth connects, Deepgram, Stripe checkout, the guided-tour onboarding path, the Chrome extension, `/intros` and `/meetings` (uncommitted on other branches).

**Environment notes:** the demo seeds 85 contacts, 288 interactions, 9 reminders, 2 campaigns, 3 recruiters, 4 events, 3 chat threads. `preview_start orbit-demo` on 3001 is still running; a second copy on 3101 was used for the empty-account onboarding and has been stopped.
# Orbit UI & workflow audit — 16 Oct 2026

Branch: `claude/orbit-audit-standardize-mcv6rb` at `eb5d69d` (main). Read-only pass; no code changed.

**How it was run.** One direct read of the foundation (`globals.css`, `components/ui/*`, `layout/app-shell.tsx`, the four `*-header.tsx` files, `provider-marks.tsx`, `onboarding/provider-logo.tsx`, `lib/interaction.ts`), plus eight parallel read-only code traces: first run, integrations, ingestion, AI surfaces, contacts/graph/events, outreach/reminders/email, settings/billing/shell, and a quantified cross-cutting style sweep. Counts below are from `grep` and are approximate (±a few). Every claim cites a path; paths are relative to `src/` unless they start with `scripts/`, `docs/` or `public/`.

This complements, and does not repeat, the 8 Oct product audit (`docs/audits/2026-10-08-app-e2e-audit.md`). That document owns the correctness bugs (follow-up double counting, rating overwrite, queue drop, etc.). Where this audit found further *workflow* problems they are listed in §5 for you to decide on; Phase 2 will not change them.

**The short version.** Orbit already has a good token layer (semantic colours, a monotonic dark surface ladder, motion tokens, contrast-checked status colours) and a solid primitive set on `@base-ui/react`. The product does not *look* like one product because almost nobody uses the primitives: 279 hand-rolled card divs against 33 `<Card>`, 165 raw `<button>`s, 17 raw `<select>`s, nine hand-rolled switches, seven hand-rolled tablists, four near-identical page-header files plus 17 inline `h1`s, 255 `text-[10px|11px]` literals, ~590 raw-palette colour classes next to a `--success/--warning/--info` set that already exists, and 45 call sites overriding the primary button's hover. The same is true of flows: five OAuth-return handlers, six message editors on three send paths, three "review people" UIs, four delete-confirm patterns, and provider names that change mid-flow ("Microsoft" page, "Disconnect Outlook?" dialog).

---

## 1. Flow map

Conventions: **Entry** → route or trigger · **UI** → components · **Data** → how it is fetched · **State** → where it lives · **States** → loading / empty / error / success present (✓) or missing (✗) · **Sees** → copy the user reads.

### 1.1 First run (marketing → sign-up → onboarding → dashboard)

- **Entry.** `/` (`app/(site)/page.tsx`). Signed-out: "Sign in" / "Get Started" (`landing/landing-auth-controls.tsx:72`, the only Title-Case button in the app); finale "Create your free account" (`landing-scenes.tsx:301`). The landing card calls itself an "Interest list… not a waitlist" (`landing-scenes.tsx:176-190`) while the pill says "Join the waitlist →" (`landing/early-access-pill.tsx:24`).
- **Auth.** `/sign-up`, `/sign-in` render Clerk's card alone: no Orbit mark, no way back to `/` (`app/(clerk)/(auth)/sign-up/[[...sign-up]]/page.tsx:59-67`). Clerk titles use `text-primary` (`lib/clerk-appearance.ts:18`) where the app uses `text-ink`. Loading `AuthPageSkeleton` ✓, error `ErrorFallback` ✓.
- **Gate.** `app/(clerk)/(app)/layout.tsx:117-120` redirects to `/onboarding` when `needsOnboarding` (`lib/onboarding.ts:45-84`).
- **Onboarding.** `/onboarding` → `OnboardingFlowLazy` (ssr:false). Data: settings, entitlements, surface visibility, Gmail/Outlook status, LinkedIn import, active capture job (server). State: `useState` step+direction, `history.pushState`, server `saveOnboardingStep` / `startOnboardingPath` (`actions/onboarding.ts`). Steps from `lib/onboarding-steps.ts`: tour path welcome→connect→launch; quick path welcome→people→connect→overview. Progress labels: "Welcome / Your people / Your accounts / What Orbit does / The tour".
  - *welcome*: "Guided tour" → "Start the tour"; "Quick setup" → "Set up quickly". Pending ✗ (buttons only disable), error ✗ (`choosePath/leave/switchToTour` have no try/catch, `onboarding-flow.tsx:233-274`).
  - *connect*: eyebrow "Your contacts" (progress says "Your accounts"), "Connect Google" / "Connect Microsoft" / "Reconnect" / "Choose who to add". Calls `startGmailOAuth` directly and re-parses the OAuth query (`steps/connect-step.tsx:222-239, 292-306, 308-322`) although `settings/use-provider-connection.ts:112-123` is documented as "exactly one implementation of Connect". Return banner ✓. Dead end: Free allows one provider (`actions/gmail.ts:153-158`), yet "Connect Microsoft" stays visible and "Try again" is offered for `plan_limit` (`connect-step.tsx:326, 365, 419`).
  - *people*: three tiles; three different "Recommended" treatments across steps (`welcome-step.tsx:158`, `people-step.tsx:78`, `import-step.tsx:140`).
  - *triage*: the most complete step (delayed skeleton, error ≠ empty, per-row retry). Button says "Finish" but advances to overview (`triage-step.tsx:282`).
  - *launch*: working / done / failed with "Try again" and "Start the tour anyway" ✓.
- **Dashboard first run.** Coach rail (`tour/coach-rail.tsx`), `TourFinishCard`, `SetupChecklistCard` ("Finish setting up", dismissed per device via localStorage, `dashboard/setup-checklist-card.tsx:25,53-60`) — yet the tour exit copy tells users to resume from that card (`coach-rail.tsx:418-419`). Two "restart tour" behaviours: checklist → dashboard (`setup-checklist-card.tsx:73`); Settings → Help → welcome chooser (`settings/help-settings.tsx:47`).
- **Sees.** Six different "skip" labels ("Skip setup", "Skip for now", "I'll add people later", "Skip this step", "Skip this", "Skip to the dashboard"); "Go to dashboard" vs "Go to your dashboard" vs "Open app"; "Connect Google or Outlook" next to a row labelled "Microsoft" (`connect-step.tsx:154, 219`).

### 1.2 Connecting data sources (integrations) and sync

- **Inventory.** Google (one grant, purposes contacts / calendar / recruiter_scan / send / drive / drive_scan / event_mail), Microsoft (contacts / calendar / send / OneDrive), LinkedIn (file import only), Eventbrite (OAuth), Luma (API key + ICS), Partiful (ICS), ICS subscriptions, outbound reminders ICS feed, AI providers (Gemini / OpenAI / Anthropic; OpenRouter has a callback but no UI), MCP for Claude / ChatGPT, Apollo / Resend / Twilio keys, Stripe, Deepgram. Apple iCloud CalDAV has server actions (`actions/apple.ts`) and an alert that points at a Settings screen that does not exist (`notifications/account-alerts.ts:703-709`). HubSpot / Notion are `planned` in `lib/connectors/registry.ts:299-366` and never rendered. `public/` holds no brand assets; every logo is an inline SVG.
- **Entry points for Google alone (12).** `settings/integrations-overview.tsx:133`, `settings/account-page.tsx` (ConnectPrompt + per-feature "Allow"), `onboarding/steps/connect-step.tsx:238`, `imports/google-contacts-import.tsx:98`, `imports/calendar-connections-card.tsx:69`, `imports/import-hub.tsx:388`, `capture/drive-capture-button.tsx:85`, `capture/cloud-notes-picker.tsx:174`, `events/event-connections-card.tsx:137`, `email/connect-mailbox-button.tsx`, `chat/gmail-send-dialog.tsx:131`, `recruiters/gmail-import-panel.tsx` + `compose-workspace.tsx:413,450`. Nine component files call `startGmailOAuth` / `startOutlookOAuth` directly instead of the shared hooks.
- **Callback.** `app/api/gmail/callback` defaults to `/recruiters` and sets both `gmail=` and `google=`; `app/api/outlook/callback` defaults to `/imports` and sets only `outlook=`. Five return handlers: the shared hook (toast + strip, `use-provider-connection.ts:244-298`), `lib/oauth-return.ts` (banner, strip on first gesture), `/events` ad hoc (`event-connections-card.tsx:166-187`), chat reading only `?gmail=` (`chat/chat-panel.tsx:851-878`, so an Outlook connect from chat gets no feedback), and nothing at all for returns to `/capture`, collapsed `/imports` rows, `/settings#settings-email` (`settings/email-settings.tsx:104,117`), compose and `?openrouter=`.
- **Status UI.** `lib/integration-status.ts` and `lib/connection-status.ts` derive state, but the strings diverge: re-auth is "Session expired — reconnect" (`connection-status.ts:32`), "Sign in again" (`integration-status.ts:217,267,326`), "{name} signed Orbit out", "Needs you" (`calendar-connections-card.tsx:47-48`), "Reconnect needed" (`actions/integrations.ts:163`). `/imports` shows "Connected as X" even when re-auth is needed (`import-hub.tsx:790-794,820-824`). Connect labels: "Connect Google/Microsoft", "Connect Gmail/Outlook", "Allow", "Allow contacts access", "Allow mail access", "Sync your Outlook calendar", "Reconnect", "Sign in again", "Switch account".
- **Logos.** Two Google and two Microsoft marks with different geometry (`settings/provider-marks.tsx:35-67` vs `onboarding/provider-logo.tsx:4-27`). Containers: `size-10 rounded-xl border bg-white` (onboarding, hardcoded white in dark mode, `connect-step.tsx:202`), `size-8 rounded-lg bg-muted/70` (settings ×3), bare `size-4` (dialog nav), lucide `Contact`/`FileSpreadsheet` tiles on `/imports` (no brand marks at all). The `{gmail:"Gmail", outlook:"Outlook"}` name map is copied in seven files.
- **Sync.** `POST /api/sync/run` → `lib/sync-scheduler.ts`; results go to `cron_runs` only. Users see: "Checked X ago" (Google meetings row), calendar rows "Syncing… / Needs you", bell alerts, the overview attention strip, `layout/connectivity-banner.tsx` (offline / queued count), `jobs/global-job-progress-bar.tsx`. No "Sync now" for Google / Microsoft; ICS "Check now" gives no success feedback; contacts have no last-imported record (`settings/google-account-page.tsx:242-245`).

### 1.3 Ingestion: imports, capture, meetings, scan

- **`/imports`.** Server page (`listImports`, `getLatestFinishedImport`, calendar subscriptions, provider status, entitlements) → `imports/import-hub.tsx` (904 lines): window drop overlay, `ImportDropzone` ("Drop anything here" / "Choose files" / "Choose a folder" / "Choose from Google Drive"), progress, triage card, queue card, finish card; accordion `ImportSourceRow`s under "Your people / Your meetings / Past imports"; `import-history.tsx`. State: `useImportJob` singleton polling 1500 ms, `useImportQueue`, URL hash opens a row, localStorage `orbit.imports.finishDismissed`. Completion happens two ways: a drop shows `ImportFinishCard` ("Meet your N new people"); a row panel wipes itself on completed *or failed* and relies on a toast (`contacts-file-import.tsx:66-81`), so a failure loses the reviewed selection. Completion is announced twice (`import-job-watcher.tsx:39-50` toast + `lib/import-job-runner.ts:220` corner widget). Panels are cards inside the bordered row and repeat the row title as an `h2` with a duplicate `id` (`import-hub.tsx:786` vs `google-contacts-import.tsx:64`). "Past imports" sits directly above the card's own "Import history" heading.
- **`/capture`.** Server page → `capture/capture-flow.tsx` phase machine input → extracting → resume → review → summary → saving → saved. Tabs "Messy Notes / Voice / Meeting / Notes Library / Drive & OneDrive" (`capture-tabs.tsx`, roving tabindex but no arrow keys). `PersonDeck` swipe review (Keep / Not this person / Decide later), `CaptureSummary` "Ready to save", `CaptureSaved` "X is in your orbit" ("Capture more" / "Open contact" / "See everything created"). Below: "Recent captures" (empty "Nothing captured yet…"). `useCaptureJob` polls 1500 ms and pauses when hidden/offline; a second inline `setInterval(2500)` at `capture-flow.tsx:203-209` has no such guard. `?mode=library` is dropped (`capture/page.tsx:39-44`). Queue says "Failed" (`capture-queue-panel.tsx:36`), a word `lib/imports/import-copy.ts` bans; "Discard all" has no confirm. Four Drive entry points (imports card, capture button on two tabs, the Drive & OneDrive tab) with one label "From Google Drive".
- **Meetings.** `/meetings` list (next/form `?q=`, `LockedFeature`, "Unfinished meeting" banner, "Load more"); `/meetings/[id]` has no `loading.tsx` and uses "✓ / ○" text glyphs (`meetings/[id]/page.tsx:173`). Recording lives in capture (`meeting-capture-panel.tsx`, 862 lines). Links are one-way: meeting → batch, never batch → meeting.
- **Scan.** `/scan/[token]` (public): phone capture or "This link has expired"; "All sent" is a terminal screen with no action; no `loading.tsx` / `error.tsx`. Desktop `scan-controls.tsx` + QR hand-off polling 1500 ms.
- **Review-people UIs ×3.** `import-people-review.tsx` (checkbox table, "Already in orbit", lowercase brand), `capture/review/person-deck.tsx` (swipe), `capture-summary.tsx` ("Update / New"); related labels "Updated", "Already in Orbit", "Already in your network".
- **Dropzones ×6** with three highlight colours (`border-primary/50`, `border-primary`, `border-import-scan`) and three hidden-input techniques (only `import-dropzone.tsx:115-140` is correct).
- **Dead code.** `imports/import-revert-button.tsx` is 0 bytes; `revertImportAction` (`actions/imports.ts:1964`) has no callers; `chat/bulk-notes-panel.tsx` (1761 lines) is imported only for a type.

### 1.4 AI analysis and insights (dashboard, chat, ask bar, radar, knowledge, find)

- **Dashboard.** `fetchDashboard()` started once, awaited per `<Suspense>` section (`dashboard/dashboard-sections.tsx`); also radar briefing, outreach summary, pending agent sends, today's meetings. No per-section error UI; a rejected bundle falls to `(app)/error.tsx`; the briefing silently becomes null (`:328`). Empty states ✓ and context-aware. Two dark "night sky" cards (`network-stats-card.tsx:104-142` with `#03050c/#e8f3f1/#9aada8/#f2c14e`, `plan-launch-card.tsx:50-120` with 14 hex values, five glow shadows and inline gradients; `card-starfield.tsx` runs a rAF canvas) sit at the foot of an otherwise token-based page. `dashboard/loading.tsx:38-41` draws two cards where the page renders one.
- **Chat.** `/chat` → `ChatPanelLazy` → `chat-panel.tsx` (2410 lines, ~30 `useState`); SSE via `lib/chat-stream-protocol.ts`. Six "AI is thinking" treatments across the slice: `Loader2`, `OrbitMark`, spinning `RefreshCw`, plain text ("Generating…", "Updating…"), nothing (Radar's explain button only disables, `radar/recommendation-card.tsx:260`), skeleton + copy. The chat panel never runs `aiDenialFromMessage`, so a mid-session key/credit denial is a toast (`:1082`) while the ask bar turns the same error into `AiKeyNotice` (`layout/floating-ask-bar.tsx:491`). History empty copy differs between the dropdown and the rail (`chat-history-rail.tsx:151`). Names: nav "Chat", h1 "Chat with your network", empty state "Ask your network", button "Open in Chat".
- **Radar.** `fetchRadar` → `RadarView` (focus/list in localStorage). `AiKeyNotice` page-level and per-card ✓. Errors: toasts only. Dashboard "Suggested outreach" and Radar recommendations are the same idea with two chip palettes that collide (`dashboard/suggestion-row.tsx:22-29` vs `radar/kind-styles.ts`: violet means "Post-event" in one, "You owe them" in the other) and two schedule vocabularies ("Schedule 7d" vs 3d/1w/2w).
- **Knowledge.** `/knowledge` (`?view`, `?p`) → `DossierPane` (async server) with client refresh via `fetch('/api/knowledge/refresh')`. `dossier-pane.tsx:32` `.catch(() => null)` turns a DB error into "We couldn't find that person"; `:34` turns a transient failure into an AI-unavailable notice. h1 "Knowledge base", nav "Knowledge".
- **Find.** `find/find-people.tsx` fetches `/api/research`. Its AI-unavailable banner is hand-rolled amber (`:92-99`), always says "Add a key", and links to `/settings?section=ai` (`:96`), a parameter nothing reads — the canonical helper is `integrationHref("ai")` → `?integration=ai` (`settings/sections.ts:136`). **Dead link.**
- **Page headers.** `dashboard-header.tsx` (eyebrow + `text-4xl tracking-tight`), `radar-header.tsx` / `find-header.tsx` / `events-header.tsx` (identical 14-line files, `text-3xl`), chat and knowledge inline their own; only `admin/primitives.tsx:21` has a reusable header with props. Segmented controls come in four styles (`radar-view.tsx:151`, `knowledge/knowledge-view-switch.tsx:15-24`, `find-people.tsx:102`, `knowledge-base-view.tsx:146`).

### 1.5 Contact and relationship views (contacts, profile, duplicates, constellation, events)

- **`/contacts`.** `PeopleListShell` (h1 "Contacts", Contacts/Recruiters toggle), `ContactsFilters` (URL params `q, company, minScore, followUp, sort, quiet, letter, tag, school, importId`), `ContactsList` (A–Z rail, optimistic delete with restore). Only one empty state, the filter message (`contacts/contacts-list.tsx:423-436`): a brand-new user with zero contacts reads "No contacts match these filters. Clear search to see everyone…". **True empty state missing.** The active `tag` filter is preserved in the URL but has no chip and no way to clear (`contacts-filters.tsx:126`).
- **`/contacts/new`.** h1 "Add contact", button "Create contact", toast "Added to your orbit"; no back link.
- **`/contacts/[id]`.** ~12 promises each with `.catch` → every section fails silently. 14 sections; five `Suspense` fallbacks are `null`. Profile cards use `<Card className="border-border/70 shadow-none">` — both classes are no-ops because `Card` has no border width and no shadow (`ui/card.tsx:26`; 21 call sites). The "Reminders" section is a dead end ("No reminders.", raw `status`, note-only edit, `contact-reminders-section.tsx:76,91-93`). Section headings come in eight styles (CardTitle as h2 / as div / sans h2 with icon / display `text-xl` / `font-heading text-lg` / CardTitle as h3 / four eyebrow tracking values). Avatar sizes: primitive defines 6/8/10, call sites use 6, 7, 8, 9, 10, 14, 24/36 plus a raw `<img>` in the graph panel (`graph/contact-inspect-panel.tsx:442-458`). The LinkedIn glyph SVG is copied four times.
- **Relationship vocabulary.** The 1–5 rating is "Strength (1–5)" (`contacts/contact-form.tsx:506`), "strength" (`contact-edit-sheet.tsx:48`), "Your rating" as a % (`contact-profile-overview.tsx:166-170`), "Min strength (orbit)" (`graph/network-graph.tsx`), "Closeness 2+…5" (`contacts-filters.tsx:32-36,478`, whose comment says Strength was retired). List and profile use three tiers (Inner / Mid / Outer orbit, `lib/closeness.ts:144-146`); the graph uses five rings ("Core orbit … Deep space", `lib/graph-layout.ts:29-35`), so the same person reads differently in the two views. Interaction labels: "Last touch", "Last interaction", "No interactions logged", "No interactions yet", "Nothing logged yet", "Connected X" vs "In your network X".
- **"Log interaction" opens two flows.** Profile → `LogInteractionSheet` (`contact-timeline.tsx:692`); graph panel and sidebar → `/capture?contactId=` (`contact-inspect-panel.tsx:715-720`, `lib/surfaces.ts:95`).
- **Constellation.** Filters are local `useState` (not shareable, `network-graph.tsx:144-148`); two loading UIs; three desktop empty states but **none on the mobile canvas** (`graph-canvas-mobile.tsx`). Chrome colours `#080b12 / #0a0e16 / #05070c` repeated ~10× with no token; comet red `#c4452d / #ff6b4a` ×3.
- **Events.** List (tabs only, no search, dashed empty boxes) and detail (explicit roster error ✓, client-side roster search). Edit event / attendee are Dialogs while edit contact is a Sheet; add contact is a page while add event is a Dialog. Mutations return `{ok,error}` with a central `revalidateEvents()` (`actions/events.ts:96-99`) — the contacts actions throw and hand-write revalidation lists per action.
- **Delete confirmation ×4.** Contact Dialog (`delete-contact-button.tsx:83-110`), event inline "Keep it / Delete event" (`events/edit-event-dialog.tsx:225-239`), interaction Dialog-in-Sheet (`interaction-detail-sheet.tsx:632`), opportunity undo toast (`contact-opportunities-section.tsx:185`).

### 1.6 Outreach, follow-ups, reminders, recruiters, email

- **Reminders.** Best-built surface: three panes (rail / queue / detail), URL-held filters, optimistic exits restored on failure (`reminders/reminders-stage.tsx:343-470`), `runToastAction` with undo and an offline queue, load-more error, per-view empty copy. Create is a Popover, edit is a Dialog, the detail pane edits inline. "Email" is a `mailto:` link (`reminder-detail-pane.tsx:207`, `reminder-card.tsx:209`) and "Draft follow-up" offers only Copy (`:225`, `:312`), next to a full compose dialog elsewhere.
- **Follow-ups** are a *second* concept: the contact's `nextFollowUpAt` ("Due follow-ups" card → `EasyFollowUp` → `FollowUpDraftSheet`, body-only, no subject/recipient). Overdue is computed locally in two files instead of `lib/reminder-due-bucket` (`dashboard/due-follow-up-row.tsx:8-27`, `follow-up/easy-follow-up.tsx:63-79`) and coloured `text-chart-4` there vs `text-amber-700 dark:text-warning` elsewhere.
- **Six message editors, three send paths.** Follow-up sheet (body, outbox, undo), `ComposeDialog` (full, outbox, undo, localStorage draft), chat `gmail-send-dialog` (subject + read-only body, outbox, undo, its own connect `Blocker`), recruiter `compose-workspace` (outbox, Gmail only, **no undo**, "connect Gmail from the Recruiters page" with no button, `:361-362`), outreach `MessageEditorRow` (Resend/Twilio, "This cannot be undone"), `AgentDraftsCard` ("Send it", nothing). Two AI-draft endpoints for one contact (`draftComposeWithAi`, `draftContactFollowUp`). Mailbox-connect UI exists four times.
- **Outreach.** Layout gate repeated on every page; `OutreachWizard` declares a "Review" step that never renders (`outreach/outreach-wizard.tsx:31,149`), keeps step state locally (refresh after step 1 orphans the campaign), animates progress `width`. `ProspectTable` is a raw `<table md:min-w-[980px]>`; pipeline filters are local state; outcomes become read-only once logged (`outcome-controls.tsx:52`). 11 native `<select>`s with raw enum labels across outreach / recruiters / reminder-card.
- **Recruiters.** Gmail and Outlook import panels are near-duplicate files (175 / 178 lines) that show raw `scan.errorMessage` (`gmail-import-panel.tsx:170`) where the account pages use `friendlyError`. Page "Log a recruiter", button "Add recruiter" (`recruiter-log-form.tsx:199`). `LockedFeature` in `recruiters/compose/page.tsx:24-37` is unreachable (the layout gates first).
- **Vocabulary.** "Follow-up" means a contact clock, a reminder kind (`lib/reminder-action-kind.ts:15`), an outreach sequence step ("Generate due follow-ups", `campaign-workspace.tsx:307`) and the dashboard button ("Generate follow-ups", `dashboard-sections.tsx:488`). The 7-day deferral is "Snooze for a week", "Remind in 7d" and "Schedule 7d". Toasts: "Reminder added" vs `TOAST_COPY.reminderSet` "Reminder set"; "Copied to clipboard" vs `TOAST_COPY.copied`.

### 1.7 Settings, export, sharing, billing, app shell

- **Settings.** `settings/sections.ts` is a genuine single source of truth (page, rail, palette, dialog). `SettingsSection` is the house card (`rounded-2xl border border-border/70 bg-card p-6`). Nine hand-rolled `role="switch"` buttons (two byte-identical: `settings/account-page.tsx:262-279`, `ai-settings.tsx:214-244`) beside "Turn on / Turn off" buttons for other toggles. `withTimeout` / `LOAD_TIMEOUT_MS` / `TIMED_OUT` copy-pasted in four files with off-voice copy ("Could not load your keys.", `api-settings.tsx:86`). Appearance offers Light/Dark/System; the mobile `ThemeToggle` offers light/dark only and overwrites a "system" choice (`theme-toggle.tsx:42-45`).
- **Destructive confirmations ×4 patterns.** Typed dialogs (`delete-data-dialog.tsx`, `delete-account-dialog.tsx`, `<span onClick>` triggers, ghost sm Cancel), plain "?" dialogs (`disconnect-account-dialog.tsx:88`, `delete-contact-button.tsx:86`, `subscription-manager.tsx:280`), inline two-step with or without a reason (`api-settings.tsx:247`, `webhook-settings.tsx:266`, `calendar-feed-settings.tsx:264`), none (`target-companies-settings.tsx:75`), and two native `window.confirm` (`capture/note-batch-result.tsx:207`, `capture/meeting-engine.tsx:742`). Admin already has `ConfirmActionDialog` with typed confirmation; the user app does not use it.
- **Calendar feed built twice.** Settings: "Create calendar feed" / "Regenerate link" / "Yes, replace the link" (`calendar-feed-settings.tsx:145,86,268`); reminders popover: "Create calendar link" / "Make a new link" / "Calendar sync" (`reminders/reminder-calendar-sync.tsx:154-174,100`); nav "Reminders in calendar". "Subscription" means both inbound ICS and the outbound feed.
- **Export / sharing.** JSON export only (`settings/data-settings.tsx:38` → `/api/export`, toast "Export downloaded"); admin has CSV, users do not. Outbound ICS by token, MCP (OAuth + deprecated path token), REST v1 through `lib/api/http`, recruiter list sharing is a button not a switch, waitlist sharing is a fully hardcoded dark palette (~246 hex in `components/interest`).
- **Billing.** `/pricing` and `/upgrade` are dark-only with their own widths (`max-w-6xl px-6 md:px-10` and `max-w-4xl px-6 md:px-8`) and 81 hex literals; `HEADING` / `TRUST` copy is duplicated and has diverged (`pricing/page.tsx:47` vs `upgrade/page.tsx:46`). Four canvas engines (celebration 673 lines, liftoff 425, chrono 431, upgrade transition 598); every navigation into billing is animated. Plan naming: card "Pricing Plan", `PLAN_LABELS` "Free Plan / Orbit Pro", buttons "Switch to Pro / Upgrade to Max". Billing errors are inline in three buttons and toasts in two.
- **App shell.** `layout/app-shell.tsx` already fixes the content column (`mx-auto max-w-6xl px-4 py-6 md:px-10 md:py-8`) with route-specific bottom/right padding. Pages then narrow it inconsistently: 3xl ×14, 5xl ×6, 2xl ×5, 6xl ×1 (repeats the shell), none ×8; `/contacts/duplicates` adds `px-4 py-6` on top of the shell padding. Page-title classes: 22 identical `font-[family-name:var(--font-display)] text-3xl text-ink`, then `text-4xl tracking-tight` (dashboard), `text-2xl` (new/duplicates, one without `text-ink`), `text-2xl md:text-3xl` (graph), hero variants. The display font is spelled as an arbitrary class in 89 files although the `font-heading` utility exists (`app/globals.css:13`) and is used 17 times. Error screens: `ErrorFallback min-h-[50vh]` vs root 404 `[60vh]`; no `(app)`-level `not-found`. Back links in four styles.

---

## 2. Prioritised standardisation suggestions

Impact: **H** fixes something users see on most pages or that misleads them · **M** visible on several pages · **L** code health. Effort: **S** < ½ day · **M** 1–2 days · **L** > 2 days (with sub-agents in parallel). Items marked ⚙ touch workflow logic and are *recorded here, not done in Phase 2* unless you approve them.

### A. Foundation (tokens and primitives)

| # | Suggestion | Impact | Effort | Evidence |
|---|---|---|---|---|
| A1 | **One page header.** Add `PageHeader` (eyebrow, title, subtitle, actions, back link) + `PageShell` width variants; delete `dashboard-header.tsx`, `radar-header.tsx`, `find-header.tsx`, `events-header.tsx`; migrate 17 inline `h1`s. Make `PageHeaderSkeleton` public so `loading.tsx` matches. | H | M | `components/{dashboard,radar,find,events}/*-header.tsx`; `loading/page-skeletons.tsx:9`; `admin/primitives.tsx:21` (the model) |
| A2 | **Make `Card` the house card.** Align `ui/card.tsx` to the dominant hand-rolled look (hairline border, token radius, `p-5` default), add `size="lg"` and an `inset` variant for the `bg-muted/30` panels, then replace the ~279 `rounded-* border border-border/* bg-card` divs. Remove the 21 no-op `border-border/70 shadow-none` overrides. | H | L | 85× `rounded-2xl border border-border/70 bg-card`; 16× `rounded-xl border border-border/60 bg-muted/30 p-3`; `ui/card.tsx:26` |
| A3 | **Stop overriding the primary button.** Delete the 45 `bg-primary text-primary-foreground hover:bg-primary/90` overrides (the variant hovers at `/80`), and add a real `lg` size (`h-10 px-4`) since sites keep re-specifying it. | H | S | `ui/button.tsx:11`; e.g. `capture/capture-saved.tsx:104`, `contacts/contact-form.tsx:562`, `onboarding/steps/connect-step.tsx:452` |
| A4 | **Type scale tokens.** Add `--text-2xs` (11px) and `--text-3xs` (10px) to `@theme`; replace the 255 `text-[10px|11px]` literals. Adopt `font-heading` everywhere the arbitrary display-font class is used (89 files). Define one eyebrow style. | M | M | `globals.css:13`; 104× `text-[11px]`, 94× `text-[10px]`; 12 distinct eyebrow strings |
| A5 | **Status colours through tokens.** Add a `tone` map (`neutral / success / warning / info / destructive / accent`) producing bg/text/border from the existing `--success/--warning/--info/--destructive`, and remove ~240 raw `amber/emerald/sky/rose` classes and 68 `dark:` overrides. | H | M | `globals.css:39-43,143-146`; worst: `capture/note-batch-result.tsx` (48), `imports/folder-triage-card.tsx` (36), `dashboard/suggestion-row.tsx` (21), `dashboard/closeness-tier-badge.tsx` (12); 21× `text-amber-700 dark:text-warning` |
| A6 | **Badge variants.** Add `tone` and `size` to `badgeVariants`; migrate `plan-badge`, `closeness-tier-badge`, `capture/review/planet-badge`, `chat/source-chip`, event/roster pills, opportunity pills and the ~77 hand-rolled `rounded-full px-* text-xs` spans. Unify the closeness tier chip (list is coloured at `/15`, profile is neutral grey). | M | M | `ui/badge.tsx`; `lib/closeness.ts:495`; `contacts/contact-stat-pills.tsx:74-79`; `events/event-card.tsx:71,77` |
| A7 | **Missing primitives:** `Tabs`/`SegmentedControl` (replace 7 hand-rolled tablists and the two motion-pill tab files), `Switch` (9 `role="switch"`), `ConfirmDialog` with optional typed confirmation (absorb 6 bespoke dialogs + 2 `window.confirm`), `EmptyState`, `ErrorState` (inline retry), `FormField`, `Separator`, `Table`. | H | L | `capture/capture-tabs.tsx:76`, `events/events-tabs.tsx:55`, `contacts/people-list-shell.tsx:31`, `settings/integrations-dialog.tsx:503,545`; `admin/confirm-action-dialog.tsx`; `outreach/prospect-table.tsx:186` |
| A8 | **`IntegrationLogo` / `IntegrationBadge`.** One component, one asset set, one neutral tile at three sizes; delete `onboarding/provider-logo.tsx`; use on settings, onboarding, `/imports` rows, capture source card, mailbox select, source chips, event connections. (Asset sourcing: §3.3.) | H | M | `settings/provider-marks.tsx:35-67` vs `onboarding/provider-logo.tsx:4-27`; `onboarding/steps/connect-step.tsx:202` (`bg-white`); `imports/import-source-row.tsx:61-69` |
| A9 | **Hex and decorative surfaces inside the app.** Tokenise the graph chrome (`#080b12/#0a0e16/#05070c` → `--sky-*`), comet red, event fallback grey, the dashboard night-sky cards, the settings rail shadow, and the dark-sky skeletons' `bg-white/10`. Marketing, pricing, celebration and the OG route stay as they are (out of scope, flagged). | M | M | `graph/network-graph.tsx:803…1183`; `dashboard/network-stats-card.tsx:104-142`; `dashboard/plan-launch-card.tsx:50-120`; `settings/settings-section-nav.tsx:368`; `loading/page-skeletons.tsx:555` |
| A10 | **Raw controls → primitives.** 17 native `<select>` → `ui/select` with label maps (no raw enums), 165 raw `<button>` → `Button` (or an unstyled variant), ~11 text-like raw `<input>` → `Input`. | M | L | `outreach/outreach-wizard.tsx:259,364,380,395`; `recruiters/recruiter-log-form.tsx:161`; `chat/chat-panel.tsx` (10 raw buttons) |
| A11 | **Adopt `ui/relative-time`** (0 importers today) for the 24 direct `formatDistanceToNow` calls; delete `admin/relative-time.tsx`. | L | S | `ui/relative-time.tsx`; `outreach/outreach-campaign-card.tsx:48`; `graph/contact-inspect-panel.tsx:71` |
| A12 | **Shared helpers:** one `POLL_MS` + visibility-aware poll hook (`lib/capture/job-store.ts:24`, `lib/import-job-runner.ts:41`, `scan/scan-qr-handoff.tsx:20`, `capture/capture-flow.tsx:209`); one `withTimeout`; one provider-name map; one LinkedIn glyph; one `revealDelay`. | L | S | listed |

### B. States and feedback

| # | Suggestion | Impact | Effort | Evidence |
|---|---|---|---|---|
| B1 | **One "AI unavailable" surface.** `AiKeyNotice` + `aiDenialFromMessage` everywhere; fix Find's dead link to `integrationHref("ai")`; run denial detection in the chat panel; drop Knowledge's duplicate inline copy; keep the low-credits hint on `/chat` too. | H | S | `find/find-people.tsx:92-99`; `chat/chat-panel.tsx:1082,2147`; `knowledge/dossier-pane.tsx:191`; `settings/sections.ts:136` |
| B2 | **One "AI is working" language.** `OrbitMark`/`ChatActivity` for model work, `Loader2` for plain mutations, text label always present, `motion-safe:` on every spin. | M | S | `radar/recommendation-card.tsx:260`; `radar/radar-view.tsx:163`; `find/find-people.tsx:301,416,498`; `knowledge/dossier-refresh.tsx:105` |
| B3 | **EmptyState everywhere, with a copy rule** (title without period, one-line description with, one action). Add the missing ones: contacts list with zero contacts, mobile constellation, profile Reminders. | H | M | `contacts/contacts-list.tsx:423-436`; `graph/graph-canvas-mobile.tsx`; `contacts/contact-reminders-section.tsx:76`; 43 `border-dashed` boxes, ~147 "No…/Nothing…" strings |
| B4 | **Error ≠ empty.** Give streamed sections an inline `ErrorState` instead of `.catch(() => null)` (profile sections, dossier, dashboard briefing); add an `(app)`-level `not-found.tsx`; make `ErrorFallback` and 404 share one frame. | M | M | `knowledge/dossier-pane.tsx:32,34`; `contacts/[id]/page.tsx` (12 `.catch`); `dashboard-sections.tsx:328`; `error-fallback.tsx` vs `app/not-found.tsx` |
| B5 | **Skeletons that match.** Fix `dashboard/loading.tsx`, `ChatPageSkeleton` gap, `OnboardingPageSkeleton` mark size; move the four hand-rolled `loading.tsx` into `page-skeletons.tsx`; add `meetings/[id]` and `scan` loading/error files; put `data-slot="skeleton"` on `SuggestionCardsSkeleton`. | M | S | `dashboard/loading.tsx:38-44`; `loading/page-skeletons.tsx:452,513`; `chat/suggestion-cards.tsx:256` |
| B6 | **One confirm pattern.** Destructive = `ConfirmDialog` (typed for account/data), cheap deletions = undo toast; retire the inline two-step except where `useConfirmFocus` already keeps focus; replace `window.confirm`. | H | M | §1.7; `settings/use-confirm-focus.ts` |
| B7 | **Toasts.** Route the 7 direct `sonner` imports through `@/lib/toast`; replace the 47 literal `toast.error` strings and the 6 hardcoded "Couldn't save that" with `TOAST_COPY`; use `runToastAction` for undoable mutations beyond reminders. | L | S | `lib/toast.tsx:253,337`; `lib/toast-copy.ts`; `settings/subscription-manager.tsx:5` |
| B8 | **Loading labels on every pending primary button** ("Saving…", "Connecting…"), including onboarding welcome / Skip setup and capture Save. | M | S | `onboarding/steps/welcome-step.tsx`; prior audit "Capture Save pending state" |

### C. Layout and copy

| # | Suggestion | Impact | Effort | Evidence |
|---|---|---|---|---|
| C1 | **Three content widths, declared once.** `narrow` (forms, settings), `default` (reading pages), `wide` (grids, tables), `full` (chat, graph, reminders). Pages pick a variant on `PageShell`; nobody re-adds padding. | H | S | §1.7 width inventory; `contacts/duplicates/page.tsx` double padding |
| C2 | **One heading scale.** h1 `font-heading text-3xl text-ink` (dashboard drops `4xl`), section h2 `font-heading text-lg font-medium text-ink`, card title = `CardTitle as="h2"`, eyebrow `text-xs font-medium uppercase tracking-wider text-muted-foreground`. | M | S | 14 distinct h1 strings, 36 h2, 16 h3 |
| C3 | **One back-link style** (`ArrowLeft` + "Back to {parent}") inside `PageHeader`. | L | S | `contacts/contact-profile-hero.tsx:371-376`; `contacts/duplicates/page.tsx:43-49`; `events/[id]/page.tsx:131-136`; `outreach/[id]/page.tsx:56` |
| C4 | **Terminology table** (§3.4) applied across pages: provider names, status words, connect/import/capture/sync verbs, Contacts/people, Reminder vs Follow-up, Closeness, "Try again", "Snooze 7 days", curly apostrophes, no "Failed". | H | M | §1 throughout; `lib/imports/import-copy.ts:7` (the existing voice rule) |
| C5 | **Sheet vs Dialog rule:** Sheet for editing a record with many fields or a side-by-side context (contact, campaign, reminder detail); Dialog for a short decision or ≤ 5 fields (add event, confirm, reminder create). Apply to edit event (→ Sheet) or edit contact (→ Dialog) so similar actions match. | M | M | §1.5, §1.6 |
| C6 | **Icon rules:** lucide only; replace the six Unicode glyphs; `Sparkles` means "AI wrote this" and nothing else; icon sizing via `size-*`; one LinkedIn glyph. | L | S | `meetings/[id]/page.tsx:173`; `recruiters/recruiter-list.tsx:108`; `dashboard/generate-follow-ups-button.tsx:51` |

### D. Workflow items (⚙ decide, then schedule; not part of Phase 2)

| # | Item | Impact | Effort | Evidence |
|---|---|---|---|---|
| D1 | Route all 9 direct `startGmailOAuth`/`startOutlookOAuth` call sites through `useConnectGoogle`/`useConnectMicrosoft`; add the Outlook branch to chat; add return handlers for `/capture`, `/imports` rows, `/settings#settings-email`, compose; one default redirect per provider. | H | M | §1.2 |
| D2 | Pick one re-auth phrase and one connected phrase from `lib/connection-status.ts`; fix `/imports` "Connected as X" when re-auth is needed. | H | S | `imports/import-hub.tsx:790-794,820-824` |
| D3 | Onboarding: hide the second provider on Free, no "Try again" on `plan_limit`, pending labels, try/catch on path actions, "Finish" → "Continue", one restart-tour behaviour, resumable checklist. | H | M | §1.1 |
| D4 | One send path (outbox + undo + `DraftLinkWarning`) for recruiter compose, outreach email and agent drafts; reminders "Email" → `openCompose`. | H | L | §1.6 |
| D5 | Collapse the three review-people UIs toward `PersonDeck` + a table mode; single completion surface for imports (corner widget) and mirror `ImportFinishCard` in `CaptureSaved` with a "View meeting" link. | M | L | §1.3 |
| D6 | Dead ends: profile Reminders section, outreach outcomes immutable, scan "All sent", phone constellation empty, `tag` filter with no chip, Apple alert → nonexistent screen, privacy page promising OpenRouter. | M | M | §1.3–1.7 |
| D7 | Relationship vocabulary: one user-facing scale (closeness % + Inner/Mid/Outer) and label the 1–5 input as a rating everywhere; graph inspect panel shows the same tier as the list. | H | M | §1.5 |
| D8 | Dead code: `imports/import-revert-button.tsx` (0 bytes), `revertImportAction`, `chat/bulk-notes-panel.tsx` (type-only import), `OutreachReadinessStrip`, unreachable `LockedFeature` in recruiters compose, `ui/relative-time` (adopt, don't delete). | L | S | §1.3, §1.6 |
| D9 | Action contract: 108 `throw`, 180 `{ok:false}`, 14 bare `{error}` across 474 actions. Standardise on `ActionResult` + `asActionResult` + one revalidation helper per domain (`revalidateEvents` is the model). | M | L | `lib/errors.ts:361`; `actions/billing.ts:72,89`; `actions/events.ts:96-99` |

---

## 3. Proposed design system

Everything below extends the existing `globals.css` `@theme` and `src/components/ui`; nothing new is installed. Dark mode keeps the current surface ladder.

### 3.1 Tokens

**Colour** — keep every existing semantic token. Add:

| Token | Purpose | Light | Dark |
|---|---|---|---|
| `--surface-inset` | recessed panels inside cards (today `bg-muted/30`) | `color-mix(--muted 60%)` | same |
| `--border-subtle` | the hairline every card uses (today `border-border/70`) | `color-mix(--border 70%)` | same |
| `--sky-900 / --sky-950 / --sky-980` | constellation chrome (today `#0a0e16 / #080b12 / #05070c`) | fixed | fixed |
| `--signal` | comet / highlight red (today `#c4452d` / `#ff6b4a`) | `#c4452d` | `#ff6b4a` |
| tone map (TS, `lib/tone.ts`) | `neutral / success / warning / info / destructive / accent` → `{bg, text, border, dot}` built from `--success/--warning/--info/--destructive/--accent` at fixed alphas | — | — |

Rule: no `amber-*`, `emerald-*`, `sky-*`, `rose-*`, `violet-*` and no `#hex` in `src/components` outside `provider-marks`, the OG route, `global-error.tsx`, and the marketing/celebration folders.

**Typography**

| Role | Utility | Notes |
|---|---|---|
| Page title | `font-heading text-3xl text-ink` | one size; dashboard drops `4xl`, graph drops the responsive pair |
| Section heading (h2) | `font-heading text-lg font-medium text-ink` | |
| Card title | `CardTitle as="h2"` (`font-heading text-base font-medium`) | unchanged |
| Subsection (h3) | `text-sm font-medium text-ink` | |
| Eyebrow | `text-xs font-medium uppercase tracking-wider text-muted-foreground` | replaces 12 variants |
| Body / meta | `text-sm` / `text-sm text-muted-foreground` | |
| Fine print | `text-2xs` (11px) / `text-3xs` (10px) via `--text-2xs`, `--text-3xs` | replaces 255 arbitrary sizes; nothing below 10px |

`font-heading` is the only way to reach Fraunces in app code.

**Spacing** — page root `space-y-8`; section `space-y-4`; card padding via the existing `--card-spacing` (`4` sm, `5` default, `6` lg); list rows `px-4 py-3`; form fields `space-y-2`. Content widths: `narrow = max-w-2xl`, `default = max-w-3xl`, `wide = max-w-5xl`, `full = none` (shell's `max-w-6xl`).

**Radius** — `rounded-lg` controls, `rounded-xl` cards / dialogs / sheets, `rounded-full` pills and avatars. `rounded-2xl` is reserved for the liquid-glass nav. `rounded-md` only for `xs/sm` buttons (already in the variants).

**Shadow** — `shadow-xs` resting controls, `shadow-sm` popovers, `shadow-md` hover lift (`CARD_HOVER`), `shadow-lg` sheets/dialogs. No arbitrary glows in app surfaces.

**Motion** — unchanged (`--transition-duration-fast/base/slow`, `--ease-house`, `lib/motion.ts`). Rule: `motion-safe:` on every `animate-spin`; `motion/react` only for the chat/ask-bar choreography that already uses it.

### 3.2 Shared components

| Component | Replaces | Location |
|---|---|---|
| `PageShell` (`width`, `spacing`) + `PageHeader` (`eyebrow`, `title`, `description`, `actions`, `back`) + public `PageHeaderSkeleton` | 4 header files, 17 inline h1s, per-page `max-w-*` | `components/layout/page-shell.tsx`, `page-header.tsx` |
| `Card` (aligned: hairline border, `rounded-xl`, `size="sm|default|lg"`, `variant="default|inset"`) | ~279 hand-rolled divs, `SettingsSection` card mode | `ui/card.tsx` |
| `Button` (+ `size="lg"` = `h-10 px-4`) | 45 overrides | `ui/button.tsx` |
| `Badge` (+ `tone`, `size`) | 4 bespoke badges, ~77 pills | `ui/badge.tsx` |
| `EmptyState` (`icon`, `title`, `description`, `action`, `variant="dashed|plain"`) | 43 dashed boxes, 2 local copies | `ui/empty-state.tsx` |
| `ErrorState` (inline, `onRetry`) | `.catch(() => null)` fall-throughs | `ui/error-state.tsx` |
| `Tabs` / `SegmentedControl` (pill with the existing `SPRING_PILL`, link mode, arrow keys, `aria-controls`) | capture-tabs, events-tabs, people-list-shell toggle, knowledge-view-switch, find mode, radar mode, import-history, integrations-dialog nav | `ui/tabs.tsx` |
| `Switch` (base-ui `Switch`) | 9 `role="switch"` + "Turn on/off" buttons | `ui/switch.tsx` |
| `ConfirmDialog` (`tone`, `confirmLabel`, `typedConfirmation?`, `reason?`) | 6 bespoke dialogs, 2 `window.confirm`, admin's copy | `ui/confirm-dialog.tsx` |
| `FormField` (`label`, `hint`, `error`, `required`) | 3 label markups, toast-only validation | `ui/form-field.tsx` |
| `Separator`, `Table` (`Table/Th/Td/Tr`, reflow helper) | 72 `border-t` dividers, 5 raw tables | `ui/separator.tsx`, `ui/table.tsx` |
| `RelativeTime` (adopt existing) | 24 `formatDistanceToNow` calls | `ui/relative-time.tsx` |
| `IntegrationLogo` (`provider`, `size="sm|md|lg"`) + `IntegrationBadge` (logo + name + status dot) | `provider-marks.tsx` + `provider-logo.tsx`, 5 tile styles, lucide stand-ins | `components/integrations/integration-logo.tsx`, assets in `public/integrations/*.svg` |
| `FileDropzone` (from `ImportDropzone`) | 6 dropzone/picker variants | `ui/file-dropzone.tsx` |

### 3.3 Integration logos: scope and sourcing

Providers that appear in UI today: Google (Contacts, Calendar, Gmail, Drive), Microsoft (Outlook contacts/calendar/mail, OneDrive), LinkedIn, Eventbrite, Luma, Partiful, Gemini, OpenAI/ChatGPT, Anthropic/Claude, OpenRouter, Apple iCloud (actions only), Stripe (billing), Slack (**not** supported; the prior audit lists it as missing). HubSpot / Notion are registry-only.

Official assets already in the repo as inline SVG: Google "G", Microsoft squares, LinkedIn, Gemini, OpenAI, OpenRouter, Claude, ChatGPT (`settings/provider-marks.tsx`). Plan: move these to `public/integrations/` as the canonical files and render them through `IntegrationLogo`.

**Needs sourcing or licensing review before Phase 2 can add them:** product-level marks for Google Drive, Google Calendar, Gmail, Outlook, OneDrive, Eventbrite, Luma, Partiful, Apple. Google and Microsoft publish these under brand-use terms that forbid redrawing and gate downloads; I will not redraw or hotlink them. Proposed interim: render the *parent* brand mark (Google G, Microsoft squares) with the product name as the label ("Google Drive", "OneDrive"), which is exactly what the OAuth consent screens show, and use a neutral lucide `Plug` for Eventbrite / Luma / Partiful until you drop official SVGs into `public/integrations/`. The component takes the file by provider key, so swapping in the official file later is a one-line change.

### 3.4 Terminology table (copy pass)

| Concept | Use | Do not use |
|---|---|---|
| Account providers | **Google**, **Microsoft** (account), product names only when specific: Gmail, Outlook, Google Calendar, Outlook Calendar, Google Drive, OneDrive, Google Contacts | "Outlook" for the Microsoft account, "Microsoft 365", "Google Workspace" |
| Connection status | **Connected** (as x@y) · **Needs reconnecting** · **Not connected** · **Checking…** | "Session expired", "Sign in again", "Needs you", "Reconnect needed", "signed Orbit out" |
| Connection actions | **Connect {Provider}** · **Reconnect** · **Disconnect** · **Allow {feature}** (for scopes) | "Sync your Outlook calendar", "Allow access", "Link" |
| Verbs | **Connect** accounts · **Import** files · **Capture** notes · **Sync** automatic updates · **Export** downloads | "Upload" (except literal file picker buttons), "Extract", "Load" |
| People | **Contacts** (nav, counts), **people** in prose, "**in your orbit**" only on save success | "connections" (except the LinkedIn file name), "network" as a noun for contacts |
| Logged touchpoint | **Interaction**; "Last interaction {time}"; empty "No interactions yet" | "touch", "Nothing logged yet", "Connected {time}" |
| Dated task | **Reminder**; kinds: Follow up / Intro / … | "Task", "Nudge" |
| Contact next-touch date | **Follow-up** (due / overdue) — one meaning | "Generate follow-ups" for anything else |
| Relationship scale | **Closeness** (%, tiers Inner / Mid / Outer orbit); the 1–5 input is **Your rating** | "Strength", "Health" in user copy, five ring names outside the canvas |
| AI | **Chat** (nav and h1), "Ask your network" (placeholder only), **Radar** recommendations, **drafts** | "Assistant", "Suggestions" for Radar, "Nudges" |
| Deferral | **Snooze 7 days** (and 3 / 14) | "Remind in 7d", "Schedule 7d", "a week" |
| Retry / finish | **Try again** · **Done** | "Retry", "Finish" when it continues |
| Failure words | "Didn't finish", "Couldn't …" | "Failed", "Error", "Could not" |
| Punctuation | curly apostrophes, `…` not `...`, no trailing period on titles, period on descriptions | |
| Case | Sentence case everywhere, Title Case only for proper nouns | "Get Started", "Messy Notes" |

### 3.5 Accessibility rules carried into Phase 2

Every icon-only button keeps `aria-label` (all 77 do today). Tabs get `aria-controls` and arrow keys. Hidden file inputs follow `import-dropzone.tsx:115-140`. Every `outline-none` has a `focus-visible:` sibling or a `focus-within` wrapper. Contrast: new tone classes reuse the already-checked status tokens; `scripts/smoke-tier-contrast.ts` and `scripts/check-interaction-contrast.mjs` stay green.

---

## 4. Proposed implementation order (Phase 2)

Each step is one or two commits; typecheck, lint, build and the smoke subset run after each. Steps 3a–3e run as parallel sub-agents on separate folders, reviewed before commit.

1. **Tokens** — `--text-2xs/3xs`, `--surface-inset`, `--border-subtle`, sky/signal tokens, `lib/tone.ts`; `font-heading` codemod (89 files); `text-[10px|11px]` codemod; delete the 45 button overrides; add `Button size="lg"`. *(A3, A4, A5-tokens, A9-tokens)*
2. **Shared components** — `PageShell`, `PageHeader`, `Card` alignment, `Badge` variants, `EmptyState`, `ErrorState`, `Tabs`, `Switch`, `ConfirmDialog`, `FormField`, `Separator`, `Table`, `FileDropzone`, `IntegrationLogo`; adopt `RelativeTime`; make `PageHeaderSkeleton` public. *(A1, A2, A6, A7, A8, A11)*
3. **Page migration** (parallel):
   - 3a dashboard, radar, find, knowledge, chat shell *(A2, A5, B1, B2, B3, B5)*
   - 3b contacts list/new/profile/duplicates, constellation chrome, events *(A2, A6, A9, B3, B4, C3)*
   - 3c capture, imports, meetings, scan *(A2, A5, A7-tabs, B3, B5, FileDropzone)*
   - 3d reminders, outreach, recruiters, email dialogs *(A2, A7-select/table/switch, A10, B6)*
   - 3e settings, onboarding, integrations dialog *(A7-switch/confirm, B6, B7, C1)*
4. **Integration logos** — assets to `public/integrations/`, `IntegrationLogo` everywhere a provider appears; delete `provider-logo.tsx`. *(A8)*
5. **Copy pass** — terminology table, empty-state wording, retry/snooze labels, apostrophes, Title Case. *(C4, C6)*
6. **Verification** — `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` (PGlite smoke, sharded), `npm run test:e2e` (Playwright, demo mode); visual check of every route at 1440 and 390 with the Chromium that is pre-installed here, screenshots attached to the final report.

Not in Phase 2 (needs your call): everything in §2-D, the marketing / pricing / celebration surfaces, and any change to data models, API contracts, auth or business logic.

---

## 5. Workflow problems found that Phase 2 will not change

Beyond the 8 Oct audit's list, these are new or still-open findings. Each is a product decision or a logic change.

1. OAuth returns with no handler (`/capture`, collapsed `/imports` rows, `/settings#settings-email`, compose, `?openrouter=`); chat ignores `?outlook=`; onboarding's embedded import card double-toasts and `replaceState(null)`s the step history (`imports/google-contacts-import.tsx` via `use-provider-connection.ts:244-298` vs `connect-step.tsx:114`).
2. Free-plan second-provider dead end in onboarding (`connect-step.tsx:326,365,419`; `actions/gmail.ts:153-158`).
3. Import row panels wipe on failure (`imports/contacts-file-import.tsx:66-81`); imports announce completion twice; capture queue "Discard all" has no confirm.
4. `?mode=library` is unreachable (`capture/page.tsx:39-44`); meetings ↔ captures link one way; scan "All sent" is terminal.
5. Chat panel never detects AI denial mid-session (`chat/chat-panel.tsx:1082`); Find's AI banner links to a parameter nothing reads (`find/find-people.tsx:96`).
6. Dossier and profile sections swallow errors as "not found"/empty (`knowledge/dossier-pane.tsx:32-34`; `contacts/[id]/page.tsx`).
7. Contacts list has no zero-contacts state; `tag` filter has no chip; mobile constellation has no empty state; profile Reminders is a dead end.
8. Reminders "Email" opens `mailto:`; "Draft follow-up" only copies; recruiter compose sends without undo; outreach sends through Resend/Twilio with no undo; EasyFollowUp "Clear" has no error handling or undo (`follow-up/easy-follow-up.tsx:193-205`).
9. Outreach wizard's "Review" step never renders and loses the campaign on refresh (`outreach/outreach-wizard.tsx:31,149`); outcomes cannot be edited (`outreach/outcome-controls.tsx:52`).
10. Two "restart tour" behaviours; dismissible checklist contradicts the resume copy; triage "Finish" continues.
11. Mobile `ThemeToggle` overwrites a "system" preference (`theme-toggle.tsx:42-45`).
12. Possible on-mount hang for `SubscriptionManager` after settings' `replaceState` (`settings/page.tsx:132-134`, `subscription-manager.tsx:67`) — not reproduced.
13. Relationship scale shown three ways and graph tiers ≠ list tiers (`lib/graph-layout.ts:29-35` vs `lib/closeness.ts:144-146`).
14. Dead code and unreachable gates (§2-D8).
15. Apple iCloud alert and the privacy page promise screens that do not exist (`notifications/account-alerts.ts:703-709`; `app/(site)/(docs)/privacy/page.tsx:68`).

---

## Appendix — the numbers behind the suggestions

| Measure | Count |
|---|---|
| `<Card>` importers vs hand-rolled card divs | 23 files / ~279 divs (85 use the exact `rounded-2xl border border-border/70 bg-card` string) |
| Raw `<button>` / `<Button>` | 165 (108 files) / 613 |
| Raw `<select>` / `<input>` | 17 / 46 |
| `role="switch"` hand-rolled | 9 |
| `role="tablist"` hand-rolled | 7 (+2 motion-pill tab components) |
| Primary-button hover overrides | 45 |
| `text-[10px]` + `text-[11px]` | 255 |
| Display font as arbitrary class vs `font-heading` | 89 files / 17 uses |
| Raw palette colour classes (amber/emerald/sky/…) | ~590 (+68 `dark:` overrides) |
| Hex literals in `.tsx` | ~403 (302 in arbitrary classes; ~250 in marketing/pricing/interest) |
| Inline `style={{` | 247 (~32 static, 20 CSS-var-only) |
| Distinct h1 / h2 / h3 class strings | 14 / 36 / 16 |
| Distinct page `max-w-*` | 5 values + none |
| Direct `formatDistanceToNow` | 24 (while `ui/relative-time` has 0 importers) |
| Direct `startGmailOAuth`/`startOutlookOAuth` call sites | 9 component files |
| Server-action error styles | 108 `throw` / 180 `{ok:false}` / 14 `{error}` |
| `toast.error` literal strings | 47 of 380 |
| `loading.tsx` that hand-roll markup | 4 of 38 |
| Confirm dialogs | 6 bespoke + 2 `window.confirm` |

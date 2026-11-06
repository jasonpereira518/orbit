# Onboarding revision: Quick setup + Guided tour

## Context

**Why.** Today's onboarding is two disconnected things: an auto-playing tour of 10 mockup slides on a 7-second timer at `/onboarding`, and a real setup wizard at `/onboarding/wizard` that is reachable only from the tour's last slide or Settings. Nothing walks the real pages. The tour sells Outreach (coming soon) and Recruiters (paid). "Exit setup" counts as finishing the wizard in admin funnels. Jason wants two paths: a **Quick setup** (about a minute) that sets up the necessary things and gives an overview of each feature, and a **Guided tour** (recommended) that sets everything up while teaching each page on the real screens.

**Starting state (verified Sep 23 2026).**
- This worktree (`claude/onboarding-flow-revision-b7be62`) is 96 commits behind `origin/main` (schema 33 vs main's 86). Its one local commit is already on main. **Phase 0 resets it onto main.**
- The Sep 17 rewrite on local branch `claude/onboarding-flow-revision-42a96f` (LinkedIn-first unified flow, schema 63) never merged and conflicts with main in 14 files. Its LinkedIn export step, 24h reminder bundle, step-table pattern, UI primitives, and highlights carousel are cleanly liftable (list in Phase 1/2). Do not cherry-pick its commits.
- Main added a terms-of-service checkbox to the wizard intro (`acceptTerms` in `src/actions/onboarding-wizard.ts`, also imported by `src/components/legal/terms-update-notice.tsx`). The replacement must keep consent.
- SCHEMA_VERSION: main 86; 87–92 are claimed by other branches/worktrees. **93 is the lowest free number today; rescan at commit time** (commands in Phase 1).

**Feature status on main** (what the tour may teach, what each needs):

| Feature | Status | Needs |
|---|---|---|
| Dashboard, Contacts, Reminders, Knowledge, Imports (LinkedIn CSV/ZIP, messages, vCard) | Live, free | Contacts; LinkedIn export takes ~24h |
| Capture (notes, voice, meeting, scan, phone) | Live, free | Own AI key; a lone LinkedIn URL paste works without a key |
| Chat (grounded answers, source chips, actions) | Live, free | Own AI key; Gmail send paid |
| Constellation | Live, free | Contacts with notes/interactions, else "Nobody here yet" |
| Google/Microsoft contacts + calendar | Live, **paid** (`sync`); PR #257 will make connect free | OAuth |
| Recruiters | Live, paid | Gmail/Outlook |
| MCP connector | Live, free | User adds a connector in Claude/ChatGPT |
| Chrome extension | Paid, unpublished (PRs #246–#254 open) | Nothing to install yet |
| Outreach, Events | Coming soon (closed to admins too) | |
| Leads | Not on main (PR #264) | |
| AI | BYOK only: Gemini / OpenAI / Anthropic; managed AI off; no trial; key checked on save | Anthropic can't transcribe or embed |

## Decisions

**Jason's (Sep 23 2026, do not re-ask):**
1. Tour venue = **hybrid**: full-screen stage at `/onboarding` for setup, then a coach rail over the **real pages**.
2. Tour data = **seeded example people**, clearly labelled, **always removed when the tour finishes or is exited** (no keep option, no lingering rows).
3. Setup scope = AI key (guided, verified on save), LinkedIn export request + 24h reminder, Connect Google/Microsoft (locked row on free until #257). Not in scope: MCP connector step, notifications permission step.
4. Land as a **fresh PR on origin/main**, not stacked on #257. The connect step reads live entitlements so it lights up when #257 merges.
5. Quick flow overview = **paged highlights carousel**, one feature per page (lift the Sep 17 carousel, re-cut the chapters).
6. Phones get the **full tour with a bottom-sheet coach**.
7. Dashboard carries a **"Finish setting up" checklist card** until everything is done or dismissed.

**Mine (flag if wrong):**
- `onboarding_completed_at` keeps meaning "past the first-run gate" and is stamped at the **stage → app handoff** (and at quick-path finish). In-app progress lives in new `tour_*` columns. This keeps `needsOnboarding` trivial and makes a redirect loop impossible. The `ai.no_key` bell alert is additionally gated on "tour not active".
- The Capture stop pre-fills a note **about an example person** so the extraction attaches to her row and vanishes with it; removal also deletes any unmarked contact created after `tour_started_at` whose normalized name matches a cast member (covers a matcher miss). If the user rewrites the note about a real person, that person stays.
- Exit removes examples; Resume re-seeds (seeder is idempotent). The "Finish setting up" card is the resume door; no separate resume card.
- Checklist dismissal is per device (localStorage, same pattern as the LinkedIn nudge). No column.
- Time label: the tour card says "Three setup steps, then a three-minute tour of the real pages." The in-app half budgets ≤ 200 s; the stage adds 1–2 min mostly on the AI key.
- One branch, one PR, built in the phases below (each phase typechecks and passes smokes alone). Natural split if review size demands: A = Phase 1, B = Phases 2+5, C = Phase 3, D = Phase 4.

## Architecture

### Routes and shell
- Everything renders at exactly **`/onboarding`** (AppShell's bare shell is an exact-path match; the gate exempts `/onboarding*` and `/settings*`). Sub-steps are client state persisted to `user_settings.onboarding_step`, never sub-routes. Query params only for the OAuth return (`?google=connected|error&reason=…&purpose=…`, `?outlook=…`) and dev `?preview=`.
- `/onboarding/wizard/page.tsx` → `redirect("/onboarding")`; delete `wizard/loading.tsx`.
- `onboarding/page.tsx`: redirect to `/dashboard` iff `onboardingCompletedAt && !onboardingStep` (so "Take the tour again" from Settings works on a populated account: reset sets `onboarding_step='welcome'`); redirect to `/dashboard` if `tourStartedAt && !tourCompletedAt` (the runtime resumes there). Load in one `Promise.all`: `getSettings()` (`hasApiKey`, `aiProvider`), `getEntitlements`, `resolveSurfaceVisibility`, `getGmailConnectionStatus`, `getOutlookConnectionStatus`, `hasLinkedInImport`, `needsTermsAcceptance`.
- `onboarding-flow-lazy.tsx` stays `ssr:false`; the skeleton is the Sep 17 `OnboardingPageSkeleton` (mirrors the stage header + centred welcome). Stage root: `relative flex min-h-dvh flex-col overflow-x-clip` (mind `min-w-0` on grid children; a nowrap chip strip once pushed Next off-screen on a 375px phone). Header grid `[1fr_auto_1fr]`: logo · `OnboardingProgress` (prop-driven stages) · ghost "Skip setup". Add `StageJobLine` under the header rendering `useImportJob()` progress (the bare shell has no `GlobalJobProgressBar`).

### State model (`user_settings`)

New columns (all nullable; add to `schema.ts`, the `CREATE TABLE user_settings` block, `alters` ADD COLUMN IF NOT EXISTS, and `ensureColumn` in `migratePglite`; `smoke-schema-ddl` needs all of them):

| column | type | written by | meaning |
|---|---|---|---|
| `onboarding_path` | text `tour|quick` | `startOnboardingPath` | path chosen on welcome |
| `tour_started_at` | timestamptz | `startInAppTour` | handoff happened |
| `tour_stop` | text | runtime `saveTourStop` | current in-app stop id (null before handoff / after finish) |
| `tour_exited_at` | timestamptz | `exitTour`; cleared by `resumeTour`/`restartTour` | rail hidden, resumable |
| `tour_completed_at` | timestamptz | `finishTour` | done |
| `linkedin_export_requested_at` | timestamptz | LinkedIn step "I've requested it" (write-once) | from Sep 17 |
| `linkedin_reminder_shown_at` | timestamptz | atomic reminder claim | from Sep 17 |

Kept: `onboarding_completed_at` (gate flag), `onboarding_step` (validated against the new step table), `wizard_completed_at` (= "finished setup": quick "Go to dashboard" and tour finish; relabel admin "Finished wizard" → "Finished setup"), `wizard_offered_at` (repurposed write-once "chose a path"). `wizard_step` becomes dead; leave the column. None of the new columns join `PRESERVED_SETTINGS_COLUMNS` (`src/lib/user-data.ts`): delete-data returns the account to the stage.

Pure predicates in `src/lib/tour/tour-state.ts`: `tourInProgress = tourStartedAt && !tourCompletedAt`; `tourRailVisible = inProgress && !tourExitedAt`; `tourResumable = inProgress && !!tourExitedAt`; `gateDecision(settings, {hasRealContact, hasImport})` extracted from `needsOnboarding`.

`src/lib/onboarding.ts needsOnboarding`: unchanged shape; the contact probe adds `source IS DISTINCT FROM 'tour-example'`. `isOnboardingGatedPath` unchanged.

Other readers to update: `account-alerts.ts:213` (`ai.no_key` needs `onboardingCompletedAt !== null && !tourActive`; add `tourActive` to `HealthInput` in `account-health.ts`), `admin-product-health.ts getFunnelParking` (add `tour · <stop>` group; caption drops "auto-advances every 7 seconds"; `wizardParking` labelled legacy; group `onboarding_step` parking by `onboarding_path`), `admin-metrics.ts buildFunnel` label, comment blocks in `admin-analytics.ts:477`, `admin-trends.ts:531,697`, `admin-metrics.ts:378`; `admin-operations.ts resetOnboarding` (scope `onboarding` also nulls path + the three `tour_*`; scope `wizard` nulls `wizard_completed_at`/`wizard_offered_at`; caveat copy in `account-actions.tsx`); `api/admin/export/route.ts` + admin user page gain `tour_completed_at` (optional).

Actions:
- `src/actions/onboarding.ts`: move `acceptTerms` in (update `terms-update-notice.tsx` import; delete `onboarding-wizard.ts`); `startOnboardingPath(path)` (writes `onboarding_path`, `onboarding_step='linkedin'`, write-once `wizard_offered_at`); `saveOnboardingStep` validated by `isOnboardingStep`; `completeOnboarding({finished})` (stamps `onboarding_completed_at`, `onboarding_step=null`, and `wizard_completed_at` only when `finished`); `resetOnboarding({path})` (clears completed + tour columns, sets `onboarding_step='welcome'`, `onboarding_path`, removes examples, redirect `/onboarding`).
- `src/actions/tour.ts`: `startInAppTour()` = ONE action: `UPDATE user_settings SET onboarding_completed_at=now(), onboarding_step=null, onboarding_path='tour', tour_started_at=now(), tour_stop=<first>, tour_exited_at=null, tour_completed_at=null` **then** `seedTourExamples(userId)`; `saveTourStop(id)` (validated against `TOUR_STOP_IDS: Record<TourStopId, true>`); `exitTour()` (stamp exited, `removeTourExamples`); `resumeTour()` (clear exited, re-seed); `restartTour()` (stop=first, re-seed); `finishTour()` (stamp `tour_completed_at` + `wizard_completed_at`, null `tour_stop`/`tour_exited_at`, `removeTourExamples`, `revalidatePath` for /dashboard /contacts /reminders /chat /graph /capture /imports /settings).
- `src/actions/onboarding-examples.ts`: `removeOnboardingExamples()` (used by the finish card's failure retry and Settings).
- `src/actions/linkedin-export.ts` (lift): `markLinkedInExportRequested`, `claimLinkedInReminder`.

### The stage (both paths)

Step table `src/lib/onboarding-steps.ts` (pure, compile-checked `STEP_IDS: Record<OnboardingStep, true>`; fixes the class of bug where `"reminders"` was missing from `VALID_ONBOARDING_STEPS`):

```ts
export const ONBOARDING_STEPS = ["welcome","linkedin","import","ai-key","connect","people","capture","manual","triage","overview","launch"] as const;
export const PATH_STAGES = {
  tour:  ["welcome","linkedin","ai-key","connect","launch"],
  quick: ["welcome","linkedin","ai-key","connect","people","overview"],
} as const;
```
`nextStep(step, path, facts)` skips `ai-key` when `facts.hasApiKey` and `connect` when neither provider is configured; ids stay in the table so a stored step resumes. `stageOf(step)` maps `import → linkedin` (when reached from LinkedIn) and `capture|manual|import|triage → people`. `resumeStep(stored, path)` returns `welcome` for unknown or off-path ids. Order LinkedIn → AI key → Connect: the 24h item first and cheapest; the highest-friction step after an easy win; the often-locked step last.

Steps (`src/components/onboarding/steps/*-step.tsx`; primitives from lifted `onboarding-ui.tsx`: `Stagger`, `StepHeading`, `BackButton`, `ProTag` restyled to `--warning`):
- **welcome**: Orbit mark in its ring, h1, one line, consent checkbox row (only when `needsTermsAcceptance`; reuse the wizard's `Checkbox` row; both path buttons and Skip disabled until ticked; click runs `await acceptTerms()` then `await startOnboardingPath(path)` then `goTo`). Two cards, Guided tour visually primary with a "Recommended" pill; stacked on phones.
- **linkedin** (lift `linkedin-step.tsx` as-is): idle → opened → requested; only "I've requested it" stamps. "I already have my export" → **import** step (`import-step.tsx` from the branch's `wizard-import.tsx`: `LinkedInConnectionsImport` + `LinkedInMessagesImport` with ZIP support; keep the `useImportJob()` "did an import start" latch; footer "Continue"/"Skip for now"). "I don't use LinkedIn" → next.
- **ai-key** (rename + extend `wizard-ai-key.tsx`): provider buttons, password input, `saveAiSettings` (already runs `checkAiKey`; rejected/malformed → toast error; `unverified` saves with `keyNote`). Add `keyPageUrl` per provider in `src/lib/ai-providers.ts` (`https://aistudio.google.com/app/apikey`, `https://platform.openai.com/api-keys`, `https://console.anthropic.com/settings/keys`) and render "Create a key in …" links; Gemini free-tier note; Anthropic caveat in `--warning` only when selected; skip consequences under "Skip for now"; "More options in Settings" → `integrationHref("ai")`.
- **connect** (new `connect-step.tsx`): props `canUseSync`, `google`, `microsoft`, `returnTo="/onboarding"`; refetch both statuses on mount. Row states: not configured → omitted (both omitted → step skipped); connected → "Connected as {email}" (+ "Reconnect" on `needs_reauth`); allowed → "Connect Google/Microsoft"; locked → muted row, Pro tag, "Included with Orbit Pro", link "See plans" → `/upgrade`. Connect click: `await saveOnboardingStep("connect")` (awaited: we're leaving the origin) → `startGmailOAuth({purpose:"contacts", returnTo})` / `startOutlookOAuth(...)` → `window.location.href`. Catch `PaywallError` via `friendlyError`. Return: read `window.location.search` once on mount via `readOAuthReturn(...)`, show an inline status line; strip the query with `history.replaceState` only on the first `pointerdown`/`keydown`, **never in a mount effect** (replaceState-then-action drops the action). After connect: disclosure "Import contacts now" mounting the existing `<GoogleContactsImport returnTo="/onboarding"/>` (or Outlook). Dev: `?preview=connect-locked` forces the locked state (non-production only).
- **people** (quick only; lift `people-step.tsx`): Capture from notes → `capture` (`<BulkNotesPanel compact hasApiKey onSaved>`; with no key its own `AiKeyNotice` shows and LinkedIn-URL paste still works), Add by hand → `manual` (`<ContactForm redirectOnSuccess={false} onSuccess>`), Upload LinkedIn export → shared `import`. "I'll add people later" → overview. **triage** survives only here and only when `getTriageCandidates().length >= 8`; else skip to overview.
- **overview** (quick only): lift `highlights-step.tsx` + `highlights/chapters.ts` + `highlights/previews.tsx` (self-paced carousel, arrow keys, swipe, side rail, reduced motion). Re-cut to 7 chapters, each with a live tag computed from real facts: (1) Capture [Needs AI key], (2) Contacts + Knowledge, (3) Reminders + Dashboard, (4) Chat [Needs AI key], (5) Constellation, (6) Imports & connections (LinkedIn, Google, calendar) [Upload when your export arrives], (7) What's ahead: Recruiters [Pro], Outreach [Soon], Events [Soon], extension [Soon], MCP connector free. `visibleChapters` drops hidden surfaces; coming-soon items render with the amber Soon tag and no link. Last page's button "Go to dashboard" → `completeOnboarding({finished:true})` → `router.replace("/dashboard")` then `router.refresh()`. Secondary link "Take the guided tour instead" (cut candidate).
- **launch** (tour only): "Setting the stage" copy; calls `startInAppTour()`; on success `router.push("/dashboard")`; on failure "Couldn't add the example people — the tour still works with an empty orbit" with "Try again" / "Start the tour anyway" (which calls `startInAppTour({skipSeed:true})`).

Settings → Help (`help-settings.tsx`): replace "Replay tour"/"Run guided setup" with "Take the tour again" (`resetOnboarding({path:"tour"})`) and "Quick setup again" (`resetOnboarding({path:"quick"})`); plus "Resume tour" when `tourResumable`.

### Guided tour runtime (in-app)

Mount: `(app)/layout.tsx` already has the settings row → pass `tour = { active: tourRailVisible(settings), stop: settings.tourStop, hasApiKey }` to `AppShell`; in the full-shell branch render `{tour.active && <TourRuntime seed={tour} hidden={hiddenSet}/>}`; `showAskBar = … && !tour.active` (the ⌘J bar is chat and owns bottom-centre); add `data-app-sidebar` to the sidebar wrapper. Layout props are hydration seeds only; live state lives in the runtime; DB is for reload/other tab.

**Coach rail** (`src/components/tour/coach-rail.tsx`; render both variants, `md:hidden` / `hidden md:block`, never `useIsMobile`):
- Desktop: floating `.liquid-glass` card `fixed bottom-5 w-[20rem] z-[60]`, `left = sidebarWidth + 1.25rem` (ResizeObserver on `[data-app-sidebar]`). Bottom-left is the only uncontested corner (bell/feedback top-right, toasts/jobs bottom-right, ask bar hidden). If the anchor rect intersects the card, flip to `right-5` and claim corner clearance so toasts stack above; this makes `src/lib/corner-clearance.ts` the ref-counted `Math.max` store its own comment asks for (keep `useCornerClearance`/`useCornerClearanceAbove` as wrappers). Never push content: Tailwind breakpoints are viewport-based.
- Phone: non-modal fixed panel (not the Base UI `Sheet`, which traps focus) `fixed inset-x-3 bottom-[calc(4rem+env(safe-area-inset-bottom)+0.5rem)] z-[45]`, collapsible to a one-line pill ("3 of 11 · Log an interaction ▾"); `useCornerClearanceAbove` so toasts stack above.
- Contents: eyebrow "Stop N of M" (M = resolved list length), Fraunces title, 1–2 sentence body, "Try this →" line, a Done-when row for predicate stops (○ → gold tick "Logged — nice", auto-advance after 1.1 s, 0 under reduced motion), progress pips (no reuse of `tour-nav-pill`/`app-nav-pill` layoutIds), Back · Next (reads "Skip this" while a predicate is unmet, so nobody is stuck) · ✕ Exit with inline confirm ("Exit for now? The example people are removed; resume any time from your dashboard.").
- Off-route: spotlight off, rail shows "This stop lives on **Contacts** — Take me there"; nothing auto-redirects. Settings is a legitimate detour.
- Persistence: local `stopId` authoritative in-tab; `saveTourStop` fire-and-forget on every move.

**Spotlight + anchors** (`src/components/tour/tour-spotlight.tsx`, `src/lib/tour/tour-anchors.ts`, `src/lib/tour/use-anchor-rect.ts`):
- `TOUR_ANCHORS` const + `tourAnchor(id) => ({"data-tour": id})`; components spread it; a typo fails tsc.
- Overlay `fixed inset-0 z-[55] pointer-events-none` (never blocks, no focus trap): one SVG with a `<mask>` (full rect minus a `motion.rect rx=12` padded 6px that glides between anchors with `SPRING_SOFT`), scrim `color-mix(in oklab, var(--background) 55%, transparent)` light / `rgb(2 6 23 / .6)` dark, a 2px `var(--primary)` ring + halo with `tour-ring-pulse` disabled under reduced motion, a ≤5-word `aria-hidden` glass chip on desktop only. No `view-transition-name`, no backdrop-filter on the scrim.
- Measure: `querySelectorAll('[data-tour="id"]')` → first `checkVisibility()`; re-measure coalesced to one rAF on ResizeObserver, capture-phase `scroll`, body-subtree MutationObserver (catches Suspense/AnimatePresence/tab swaps), `pathname`, `visibilitychange`. No interval. Not mounted after 4 s → `missing` (scrim off, copy-only, Next enabled, "It isn't on this screen"). Inside a scroll container → `scrollIntoView` once per stop (`block:"nearest"` on viewport-locked /reminders /chat /graph, else `center`; `behavior` from `matchMedia` at call time). While `overlayOpen()` (move from `use-triage-keys.ts` to `src/lib/overlay-open.ts`) the scrim is removed and the desktop card drops below z-50.
- The old fake cursor (`tour-cursor.tsx`) is **not** reused; delete with `tour-sidebar.tsx`, `tour-config.ts`, `previews/*`.

**Events** (`src/lib/tour/tour-events.ts`): module bus read with `useSyncExternalStore` (snapshot `{seq, last}`); `emitTourEvent(name)` one-liners in real success paths, evaluated only while their stop is active:

| predicate | emitter |
|---|---|
| `contacts.searched` | `contacts-filters.tsx` when debounced `q` becomes non-empty |
| `route:contact-detail` | pure `usePathname` match `/contacts/[^/]+` excluding `new`/`duplicates` |
| `interaction.logged` | `log-interaction-sheet.tsx` beside `toast.success("Logged")` |
| `capture.extracted` / `capture.saved` | existing `useCaptureJob()` status `ready` / `saved` (no emitter) |
| `reminder.done` | `reminders-stage.tsx doneOne` and `reminder-done-snooze.tsx` |
| `chat.answered` | `chat-panel.tsx sendQuestion` when `askNetwork` resolves with an answer |
| `graph.star-selected` | `network-graph.tsx onSelect` non-null (mobile canvas calls the same) |

**Stop script** (`src/lib/tour/tour-stops.ts`, pure; `resolveTourStops({hasApiKey, hidden})`; copy interpolates `{{example.firstName}}` from the cast):

| # | id · route · s | anchor (component) | doneWhen / notes |
|---|---|---|---|
| 1 | `dashboard.home` /dashboard 12 | `dashboard.stats` stat grid (`dashboard-sections.tsx`), body names "Due follow-ups" | Next-only. Needs ≥1 example with an overdue follow-up so the due card is alive |
| 2 | `contacts.search` /contacts 15, `focusAnchor` | `contacts.search` input (`contacts-filters.tsx`, aria-label "Search contacts") | `contacts.searched`. "Type Maya" |
| 3 | `contacts.open` /contacts 12 | `contacts.row` first `<li role="link">` (`contacts-list.tsx`, index 0), body explains `ClosenessChip` | `route:contact-detail` |
| 4 | `contact.log` /contacts/:id 25 | `contact.log-interaction` "Log interaction" button (`contact-timeline.tsx` CardAction + empty-state button, same id) ; body points at "Where things stand" brief and closeness pill | `interaction.logged`. Scrim hides while the sheet is open |
| 5a | `capture.extract` /capture 20, requires `ai_key`, `onEnter: prefill-capture-note` | `capture.notes` textarea `#capture-notes` (`bulk-notes-panel.tsx`) | `capture.extracted`. Runtime calls `handOffToCapture(TOUR_EXAMPLE_NOTE)` (`src/lib/capture-handoff.ts`) before `router.push("/capture")`; the note is about Maya so extraction attaches to her |
| 5b | `capture.keep` /capture 15, requires `ai_key` | `capture.keep` "Keep this person" (`capture/review/person-deck.tsx`) | `capture.saved` |
| 5' | `capture.linkedin` /capture 15, requires `no_ai_key` | `capture.notes` | Next-only: "Paste a LinkedIn profile URL on its own — Orbit looks it up without a key" + link `/settings#settings-ai` |
| 6 | `reminders.done` /reminders 18 | `reminders.row-done` first row's done button (`reminder-row.tsx`); chip on `reminders.rail-today` (`reminder-rail.tsx`) | `reminder.done`. Needs ≥1 example reminder due today |
| 7 | `chat.ask` /chat 25, requires `ai_key` | `chat.suggestions` (`suggestion-cards.tsx` `data-slot="chat-suggestions"`) fallback `chat.composer` (`chat-panel.tsx` pill) | `chat.answered`. "Ask: who do I know at Lumen Labs?" |
| 7' | `chat.preview` /chat 10, requires `no_ai_key` | `chat.composer` | Next-only; describes source chips and proposed actions + key link |
| 8 | `graph.star` /graph 20 | `graph.stage` stage wrapper (`graph/page.tsx`); chip on `graph.show-all` (`constellation-scope-toggle.tsx`) | `graph.star-selected`. Needs ≥3 examples at one company with interactions |
| 9 | `imports.linkedin` /imports 10 | `imports.connections` section (`linkedin-connections-import.tsx`, default tab) | Next-only: "When LinkedIn's email lands (usually within 24 h), drop the ZIP here." Variant when export not requested |
| 10 | `finish` /dashboard 20 | none | Finish card |

Budget ≈ 192 s with a key, 157 s without. Fold 5b into 5a if it must be shorter.

**Navigation**: on stop enter, if `pathname !== route` run `onEnter` then `router.push(route)`; `router.prefetch(nextStop.route)`; pattern routes (`/contacts/:id`) are never pushed. Hide the spotlight between push and `pathname` change (view transitions give stale rects). Coexistence: ⌘K keep; ⌘J hidden; bell keep (`ai.no_key` deferred); LinkedIn reminder watcher gated on `!tourActive`; Capture/Import job watchers keep; `TermsUpdateNotice` won't appear (consent collected).

**Finish card** (`tour-finish-card.tsx`): calls `finishTour()` (removes examples). Shows what's set up (terms ✓, AI key ✓/—, LinkedIn requested ✓/—, Google/Microsoft ✓/—, contact logged ✓, reminder done ✓, chat asked ✓), one "What's ahead" card (Recruiters · Outreach · Events, Soon in `--warning`), copy "The six example people are gone, along with anything you logged on them. Your own entries stay." Button "Go to your dashboard": action first, then `router.replace("/dashboard")` + `router.refresh()`. Toast "Tour complete — replay it any time from Settings → Help".

**A11y + motion**: rail `role="complementary" aria-label="Guided tour"`, visually-hidden `aria-live="polite"` announcing "Stop N of M: {title}. Try this: {tryThis}" and "Done — {label}"; focus the rail heading once at handoff; ←/→ = Back/Next when target isn't editable and no overlay open; Esc → exit confirm only when focus is inside the rail; rail enter/exit opacity-only; cutout glide + pulse behind `prefers-reduced-motion: no-preference`; gold `--tier-lifetime` tick on `bg-tier-lifetime/10`.

### Example people (`src/lib/onboarding-examples/`)

Files: `marker.ts` (client-safe `TOUR_EXAMPLE_SOURCE = "tour-example"`, cast names), `cast.ts` (pure data + `TOUR_EXAMPLE_NOTE`), `seed.ts`, `remove.ts`, `status.ts` (`countTourExamples`).

Cast (6 people, 2 fictional companies, one 3-person cluster; emails on `example.com`, LinkedIn slugs `orbit-example-*` so identities never collide or merge with real people):

| Name | Role, company | Closeness | Touches (days ago) | Reminder |
|---|---|---|---|---|
| Maya Okonkwo-Reyes | Product Lead, Lumen Labs | 5 | note −4, meeting −31 | "Send Maya the onboarding deck" due −3d (overdue); `nextFollowUpAt` −3d |
| Daniel Achterberg | Founding Engineer, Lumen Labs | 3 | call −12 | "Call Daniel about the API pilot" due today |
| Aisha Rahman | Marketing Manager, Lumen Labs | 2 | in_person −45 | none; `nextFollowUpAt` +9d |
| Sofia Marchetti | Venture Associate, Northwind Capital | 2 | email −20 | "Share the traction update with Sofia" due +5d |
| Tomasz Wisniewski | PhD student, Redwood University | 3 | message −8 | none |
| Ben Castellanos | Independent developer | 4 | in_person −2, note −16 | none |

Per person: `howMet`, `metContext`, `dateMet` (−60..−90d), 1–2 `keyFacts`, short `notes`, static `aiSummary` (built like `summaryFor` in `demo-data/seed.ts`), `statedCloseness` + `relationshipScore`; interactions with `rawNotes`, `topics`, one `actionItems` on Maya and Daniel; a static `contact_briefs` row each (`model = "tour-example"`, `inputHash = null`). `TOUR_EXAMPLE_NOTE`: "Coffee with Maya Okonkwo-Reyes from Lumen Labs — she's moving to Berlin in March and wants an intro to a product designer. Send her the onboarding deck by Friday."

Seed: raw inserts like `demo-data/seed.ts` (not `createContactsBulkForUser`: no headroom, no embeddings, no brief generation, no per-row revalidate). Order: `createCompanyResolver` → `contacts` (`source="tour-example"`, `embeddingStaleAt: null` so the backfill never claims them) → `contactIdentities` via `identityKeysFor` (`source` marker, `onConflictDoNothing`) → `interactions` (`source` marker) → `actionItems` → `contactBriefs` → `reminders` (`listId = getInboxListId`, `createdBy:"user"`, `reminderType:"manual"`, every one with a `contactId`) → `markCohortDirty`. Idempotent: no-op when any `tour-example` contact exists. Chat finds them through the keyword arm of hybrid search (say so in `cast.ts`'s header).

Marker = `source = "tour-example"` on `contacts`, `contact_identities`, `interactions` only; everything else cascades from the contact FK (briefs, action items, mentions, reminders, chunks, embeddings, tags). No ledger table, no new purge category, no purge-smoke fixture changes.

`removeTourExamples(userId)`:
1. `ids` = example contacts that are not a `contact_merges.winner_contact_id` (a winner that absorbed a real contact has its `source` cleared instead).
2. Plus unmarked contacts with `created_at >= tour_started_at` whose normalized full name matches a cast name (the capture-created duplicate case).
3. Delete `suggested_reminders` with those `contact_id`s (FK is set-null); delete pending `ai_suggestions` whose `related_contact_ids ?| ids`.
4. Delete the contacts (cascade does the rest).
5. Delete the two cast companies when no contact references them.
6. `markCohortDirty`; caller revalidates /dashboard /contacts /reminders /graph. Returns `{removed}`.

Exclusions and guards (one commit, one smoke): the four "activated"/onboarded predicates (`admin-analytics.ts:483`, `admin-trends.ts:560,719`, `admin-metrics.ts isOnboarded` via `admin-roster.ts` contact counts) add `source IS DISTINCT FROM 'tour-example'`; the 500 cap (`contact-writes.ts contactHeadroomForUser`/`contactUsageForUser`, `account-health.ts plan.contact_cap_reached`) excludes examples; **merge guard**: `contact-merge.ts:210` `source = COALESCE(w.source, l.source)` becomes a CASE that never relabels a real winner as an example. Duplicates, dashboard suggestions, reminders digest, cohort, export: include as-is (they leave with removal). Contacts list and profile hero show a muted "Example" chip (`example-tag.tsx`; add `source` to the list projection in `contacts-page.ts`).

### Dashboard "Finish setting up" card
`src/components/dashboard/setup-checklist-card.tsx`, async server section in `dashboard-sections.tsx` mounted right after `AgentDraftsSection`. Shown when `onboardingCompletedAt` is set and at least one item is open and not dismissed. Items with live status: Add an AI key (`hasApiKey`) · Upload your LinkedIn export when it arrives (requested && !hasLinkedInImport; hidden if never requested) · Connect Google or Microsoft (hidden when locked on free, shows "Included with Pro" link instead) · Add your first people (real contacts = 0) · Resume the tour (`tourResumable`) / Take the guided tour (quick path, never toured) · Remove the example people (only if `countTourExamples > 0`, i.e. a crashed removal). Dismiss = localStorage key `orbit-setup-checklist-dismissed-v1` (nudge pattern, `useSyncExternalStore`). Disappears when every item is done.

## Phases (each typechecks + passes smokes alone; commit per phase)

### Phase 0: rebuild the worktree on main
- `git reset --hard origin/main` on `claude/onboarding-flow-revision-b7be62` (its commit 3c97587d is main's #155; parked at `backup/demo-account-pre-merge-3c97587d`). `npm ci` in the worktree. Confirm baseline: `npx tsc --noEmit`, `npm run lint` (0 errors), `npm test > /tmp/smoke.log; grep -c '^ *FAIL' /tmp/smoke.log` (never pipe through tail).
- Check no dev server is running against this worktree's `.next` before any `preview_start` later.

### Phase 1: schema + LinkedIn bundle
- Schema: the 7 columns (schema.ts, DDL template block, `alters`, `ensureColumn`), changelog paragraph with the rescan, bump to next free (rescan: `git grep -h "export const SCHEMA_VERSION = " $(git for-each-ref --format='%(refname)' refs/heads refs/remotes) -- src/db/index.ts | sort -t= -k2 -n | uniq | tail -3` AND `grep -h "export const SCHEMA_VERSION = " /Users/jasonpereira/Projects/orbit/src/db/index.ts /Users/jasonpereira/Projects/orbit/.claude/worktrees/*/src/db/index.ts | sort -t= -k2 -n | uniq | tail -3`; take max+1), then `npx tsx scripts/smoke-schema-ddl.ts --update` and commit the lock file. Do NOT introduce the branch's `theme:text(` typo.
- Lift from `claude/onboarding-flow-revision-42a96f` with `git checkout <branch> -- <paths>`: `src/lib/linkedin-export.ts`, `src/lib/linkedin-reminder.ts`, `src/lib/inbox-search.ts`, `src/actions/linkedin-export.ts`, `src/components/imports/linkedin-screenshot.tsx`, `src/components/linkedin-reminder/`, `src/components/dashboard/linkedin-export-nudge.tsx`, `scripts/smoke-inbox-search.ts`, `scripts/smoke-linkedin-reminder.ts`. Hand-port: `globals.css` `.onboarding-target-ping` keyframes; the ZIP hunks in `import-utils.tsx` (`readCsvOrZipConnections`) + `linkedin-connections-import.tsx` (`.zip` accept); `linkedin-export-guide.tsx` imports `LINKEDIN_DATA_URL` from the lib; `(app)/layout.tsx` feeds `getLinkedInReminderState`; `app-shell.tsx` mounts the watcher in the full shell (gated on `!tourActive` in Phase 4); dashboard `LinkedInExportNudgeSection`. Register the two smokes in `scripts/run-smoke.ts`.

### Phase 2: the stage, quick path, persistence, admin compat
- Lift `onboarding-ui.tsx`, `onboarding-progress.tsx` (make stages/labels props), `steps/linkedin-step.tsx`, `steps/people-step.tsx`, `steps/highlights-step.tsx` + `highlights/chapters.ts` + `highlights/previews.tsx` (re-cut chapters, add live tags), `src/lib/onboarding-steps.ts` + `scripts/smoke-onboarding-steps.ts` (rewrite to the new table), `page-skeletons.tsx OnboardingPageSkeleton`.
- New: `steps/welcome-step.tsx` (path chooser + consent), `ai-key-step.tsx` (from `wizard-ai-key.tsx`), `connect-step.tsx`, `import-step.tsx` (from `wizard-import.tsx`), `capture-step.tsx`, `manual-step.tsx`, `triage-step.tsx` (from `wizard-triage.tsx`), `overview-step.tsx`, `launch-step.tsx` (calls `startInAppTour` from Phase 4; until then it renders a placeholder that completes onboarding, replaced in Phase 4), rewrite `onboarding-flow.tsx` (controller: direction-aware slides, header, StageJobLine, Skip setup), `onboarding/page.tsx` facts, `wizard/page.tsx` redirect.
- `src/actions/onboarding.ts` as specified; delete `onboarding-wizard.ts`, `components/onboarding/wizard/*`, `previews/*`, `tour-config.ts`, `tour-cursor.tsx`, `tour-sidebar.tsx`; fix the `terms-update-notice.tsx` import; `ai-providers.ts keyPageUrl`; `help-settings.tsx`; admin label/caption/reset-scope changes; `plan-guards.ts` comment.
- e2e: rewrite `e2e/01-onboarding.spec.ts` as the quick path (`/dashboard` → `/onboarding`; heading "Welcome to Orbit"; tick consent; "Set up quickly"; "I don't use LinkedIn"; AI key + connect auto-skipped in e2e (stub key + demo entitlements); "I'll add people later"; overview heading "Here's what Orbit can do"; last page "Go to dashboard" → "Your orbit is empty"). `e2e/helpers.ts ensureOnboarded`: tick consent if present, click "Skip setup", await `/dashboard`.

### Phase 3: example people
- `src/lib/onboarding-examples/*`, `src/actions/onboarding-examples.ts`, `example-tag.tsx` + chip in `contacts-list.tsx` and `contact-profile-hero.tsx` (+ `source` in `contacts-page.ts` projection), merge guard in `contact-merge.ts`, cap + analytics exclusions (one commit), `needsOnboarding` probe filter, Settings → Data row "Example people" (shown when count > 0) as the safety net.
- Smokes: `smoke-onboarding-examples-cast.ts` (pure invariants: 6 people, unique identities, all touches in the past 60d, ≥3 share a company, exactly one overdue/one today/one upcoming reminder, every reminder has a contactId, emails on example.com, slugs `orbit-example-`), `smoke-onboarding-examples.ts` (PGlite via `scripts/smoke/_env`: seed → counts; headroom unchanged; log a user interaction + reminder on an example; merge real→example and example→real; capture-style duplicate created after `tour_started_at`; `removeTourExamples` removes all example rows + the duplicate, real contact survives both merges, unrelated rows intact; re-seed after removal is a no-op unless flags cleared; `purgeUserData` on a seeded account leaves zero rows). Extend `smoke-account-alerts.ts` with a `tourStartedAt` case (ai.no_key quiet).

### Phase 4: tour runtime
- `src/lib/tour/{tour-anchors,tour-stops,tour-state,tour-events,use-anchor-rect}.ts`, `src/lib/overlay-open.ts` (moved from `use-triage-keys.ts`), `src/components/tour/{tour-runtime,coach-rail,tour-spotlight,tour-finish-card}.tsx`, `src/actions/tour.ts`, `corner-clearance.ts` ref-counted store, AppShell/layout wiring (`tour` prop, hide ask bar, `data-app-sidebar`, LinkedIn watcher gate), `account-alerts.ts`/`account-health.ts` `tourActive`, `getFunnelParking` tour group, `resetOnboarding` tour columns, `launch-step.tsx` real handoff.
- Anchors + emitters in: `dashboard-sections.tsx`, `contacts-filters.tsx`, `contacts-list.tsx`, `contact-timeline.tsx`, `log-interaction-sheet.tsx`, `bulk-notes-panel.tsx`, `capture/review/person-deck.tsx`, `reminders-stage.tsx`, `reminder-row.tsx`, `reminder-rail.tsx`, `reminder-done-snooze.tsx`, `chat-panel.tsx`, `suggestion-cards.tsx`, `network-graph.tsx`, `constellation-scope-toggle.tsx`, `graph/page.tsx`, `linkedin-connections-import.tsx`.
- Smokes: `smoke-tour-stops.ts` (ids unique; every non-pattern route is in nav/surfaces and has a `loading.tsx`; every anchor ∈ `TOUR_ANCHORS` and appears as `tourAnchor("id")`/`data-tour="id"` in src; every predicate has an emitter or is store/route-derived; resolved lists with/without key end in `finish`, ≤ 12 stops, ≤ 200 s), `smoke-onboarding-gate.ts` (predicate matrix + `gateDecision` for fresh / completed / tour active / exited / finished / example-only-contacts). Register both.
- e2e `e2e/06-guided-tour.spec.ts` (last in order): Guided tour → stage skips → rail "Stop 1 of" → Next → /contacts → search → open example → log interaction via the sheet (reuse 03's steps) → rail shows "Logged" and advances → "Skip this" through to finish → "Go to your dashboard" → "Your orbit is empty" again.

### Phase 5: dashboard checklist + polish
- `setup-checklist-card.tsx` + section; Settings "Resume tour"; copy pass against `smoke-toast-copy`; delete the `42a96f` branch + its worktree after the lift; close PR #117 as superseded (note in PR description); update `docs/` changelog line for the schema number.

## Verification

- Every phase: `npx tsc --noEmit`, `npm run lint`, `npm test > /tmp/smoke.log 2>&1; grep '^ *FAIL' /tmp/smoke.log` (rerun admin-render/instrumentation alone if they time out under load), `npm run db:check` after Phase 1.
- Local run: `rm -rf .next` if a build ran; `ORBIT_DEMO_DATA=off ORBIT_DEMO_MANAGED_AI=off` in the worktree `.env.local` to see onboarding and the no-key states (localhost is otherwise a seeded demo account with every entitlement). Use `preview_start` on the worktree's own port (never kill the user's 3000). A hidden Browser-pane tab never hydrates; front it or drive with `scripts/dev/cdp.mjs`.
- Manual checklist (record in the PR): (1) fresh account: welcome + consent, both paths; AI key with a real Gemini key (accepted), garbage (rejected copy), smart-quoted (malformed); Anthropic caveat. (2) **Real Google connect round trip to `/onboarding`, never run live before**: consent → back on the connect step with "Google connected"; untick contacts scope → `missing_scope` message; "Import contacts now" runs; navigate away mid-import, toast lands from `ImportJobWatcher`. (3) Tour path end to end with and without a key: six examples appear, dashboard due card alive, Constellation shows the Lumen Labs cluster, Chat answers "who do I know at Lumen Labs" by keyword, Capture stop extracts Maya's note and attaches to her, finish removes everything (Contacts empty, no orphan reminders, no "Example" chips), exit mid-tour removes + dashboard card resumes and re-seeds. (4) Replay both ways from Settings on a populated account. (5) 375px light/dark for every stage step and every stop with a CDP geometry check (`getBoundingClientRect().right <= innerWidth` for every visible control; `overflow-x-clip` hides overflow silently), 820×1180 for the floating rail, `prefers-reduced-motion: reduce` pass (no snap on exits, no pulse, no auto-advance beat). (6) Preview deploy on a free non-demo account to see the locked connect row and the `ai.no_key` bell staying quiet during the tour. (7) Admin: user page shows path + "Finished setup"; funnel parking shows `tour · <stop>`.

## Risks (ranked)
1. Real Google OAuth return to `/onboarding` (redirect URI, `returnTo` through state, first-gesture query strip). Mitigation: manual step 2 on a preview before merge.
2. Example rows leaking: merge relabel (`COALESCE`), capture-created duplicates, analytics/cap counting them. Mitigation: merge guard + name-window rule + one-commit exclusions + the PGlite smoke.
3. Floating rail vs content at 768–1279px and anchor drift/absence (Suspense, tabs, breakpoints). Mitigation: collapse-to-pill, corner flip, `missing` fallback, source-level smoke, CDP walk.
4. `needsOnboarding` runs on every authenticated request; keep the change to the probe filter only.
5. SCHEMA_VERSION collision (92 appeared only in a worktree file at first). Rescan both ways right before push and before merge; renumber + `--update` on collision.
6. PR #257 touches `google-contacts-import.tsx` and the OAuth actions the connect step reuses; whichever lands second reconciles and re-runs manual step 2.
7. e2e cannot see the AI key step (stub key ⇒ `hasApiKey`) or the locked connect row (demo entitlements); do not let green e2e imply those states work.
8. Keyboard collisions with reminders triage keys and dialogs: scoped keys + `overlayOpen()`.

## Cut list if time is short (in order)
Spotlight chip/arrow → `chat.answered`/`graph.star-selected` predicates (make Next-only) → phone anchor overrides → triage step → "Take the guided tour instead" link → corner-flip logic → Microsoft row (omits itself when env is unset anyway) → the 24h reminder watcher into a follow-up PR (LinkedIn step stays).

## Copy (short, warm, no exclamation marks, no em-dashes in UI)
- **Welcome**: h1 "Welcome to Orbit"; sub "Orbit remembers the people you meet and tells you when to reach back out. Choose how you'd like to start."; consent "I agree to Orbit's Terms of Service and Privacy Policy."; **Guided tour** card: pill "Recommended", "Three setup steps, then a three-minute tour of the real pages.", list "Your AI key, checked as you save it" / "Your LinkedIn export, started now so it's ready tomorrow" / "Google or Microsoft contacts, when your plan includes sync" / "Every page, with a few example people already in place", button "Start the tour"; **Quick setup** card: "About a minute", "Just the essentials and a quick look at what Orbit can do. The tour is always in Settings if you want it later.", button "Set up quickly"; header "Skip setup".
- **AI key**: eyebrow "Your AI"; h1 "Add your AI key"; body "Orbit's AI runs on a key you own. You pay your provider directly, at cost, and nothing is marked up or shared. Pick a provider, create a key, and paste it here."; links "Create a key in Google AI Studio" / "Create a key on OpenAI's platform" / "Create a key in the Anthropic console"; Gemini note "Google's free tier covers a normal week of use."; Anthropic caveat "Anthropic keys can't transcribe voice notes or power semantic search. Chat still works with keyword search. Add a Gemini or OpenAI key later for those."; input label "{Provider} key", helper "Checked with {Provider} when you save, then stored encrypted with your account."; buttons "Save and continue" / "Skip for now"; skip line "Without a key, Capture from notes, Chat and profile briefs stay off until you add one in Settings. Imports, contacts and reminders work either way."
- **Connect**: eyebrow "Your contacts"; h1 "Connect your contacts"; body "Bring in the people you already email. Orbit reads only the contact details you choose to import."; rows "Connected as {email}" / "Session expired, reconnect" / "Connect Google" / "Connect Microsoft" / locked "Included with Orbit Pro" + "See plans"; after connect "Connected. Import your Google contacts now, or later from Imports." + disclosure "Import contacts now"; footer "Continue" / "Skip for now"; locked-only footnote "Sync unlocks on Orbit Pro. Everything else in Orbit works on the free plan."; return lines "Google connected" / "Google connection cancelled, connect any time from Imports" / `missingScopeMessage("contacts")`.
- **LinkedIn**: keep the Sep 17 copy verbatim. **People/Triage**: keep the Sep 17 / wizard copy. **Overview**: eyebrow "You're set up"; h1 "Here's what Orbit can do"; tags "Pro", "Soon", "Needs AI key", "Upload when your export arrives"; last button "Go to dashboard".
- **Launch**: eyebrow "Almost there"; h1 "Setting the stage"; body "Orbit is adding six example people so every page has something to show. They're clearly marked and disappear when the tour ends."
- **Rail**: exit confirm "Exit for now? The example people are removed; resume any time from your dashboard."; done beats "Logged, nice" / "Done" / "Answered" / "Found"; off-route "This stop lives on {Page}" + "Take me there"; missing "It isn't on this screen".
- **Finish**: h1 "You're in orbit"; "The six example people are gone, along with anything you logged on them. Your own entries stay."; button "Go to your dashboard"; toast "Tour complete, replay it any time from Settings → Help".
- **Checklist card**: title "Finish setting up"; items as listed; "Dismiss". **Help**: "Take the tour again" / "Quick setup again" / "Resume tour"; description "Walk through setup again, take the page-by-page tour, or tell us what isn't working." **Chip**: "Example". **Settings Data row**: "Example people" / "Remove example people"; toasts "Example people removed" / "No example people left to remove"; error `UserFacingError("Couldn’t remove the example people — try again?")`.

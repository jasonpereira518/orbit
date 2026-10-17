# Onboarding plan: first value in under two minutes

**Date:** 2026-10-17 · **Status:** Approved. The first batch is built on this branch; see [Implementation status](#implementation-status-first-batch) for what shipped and what is still open.

**Evidence:** [`ONBOARDING_AUDIT.md`](ONBOARDING_AUDIT.md). Finding IDs (F1–F19) and screenshot IDs (E01–E19) refer to it. Static mockups of the key screens are in [`onboarding/mockups.html`](onboarding/mockups.html).

---

## Implementation status: first batch

Measured the same way as the audit: `next dev`, a fresh PGlite, `ORBIT_DEMO_DATA=off`, `ORBIT_DEMO_MANAGED_AI=off`, and the Gemini stub at 4 s a call. "Paused" means `VERCEL_ENV=production` with a managed key set, which is production's default until `site_settings.managed_ai_paused` is cleared. After-screenshots A01–A15 are in [`onboarding/evidence/after/`](onboarding/evidence/after/).

| # | Status | What shipped | Still open |
|---|---|---|---|
| R1 | Done | One `managedOutage()` read in the app layout, built on the 30-second cached pool state, tells paused apart from pools spent (with the refill date when a monthly cap is what ran out). Every notice now uses it: the paused copy no longer promises a return, and each names all four key providers. The checklist, ask bar, Settings and the tour's no-AI stops all read the same status. The Radar fallback names the right reason. The credits card puts credits "on hold" and hides "Buy a pack" while AI is paused. The credit-email toggle is hidden for Free. The Chat composer is disabled with a reason, the same way Capture disables Extract | – |
| R2 | Done | When AI can't run, the onboarding capture step opens a by-hand form with "Follow up in: 3 days / 1 week / 2 weeks / Not now", which creates the reminder. /capture links to the same form at `/contacts/new?quick=1` | – |
| R3 | Done | A three-step "Use your own AI key" guide recommending Gemini (D2 default), with a note on free-tier data terms. Every card links to its provider's key page. A key pasted into the wrong card is routed by its prefix. OpenRouter moves under Advanced, and the decision model moves under "More AI options". Saved keys stay visible | – |
| R4 | Done | Welcome leads with "Add someone you met". The tour is the "Show me around with example people first" link, and "Skip for now" is new. The primary button sits above the fold on a phone (A06). Stages: Welcome → Your first person → All set | On a phone the capture step's notes box starts above the fold, but "Extract people" sits below it |
| R5 | Done | An account that reached onboarding and left counts as onboarded (`onboardingSeen`) for the checklist, LinkedIn card, imports and account health. Nothing is written on a read path. Checklist dismissal is stored per account | – |
| R6 | Partial | Settings is in the phone More sheet. On /capture and onboarding, the "ready to review" toast no longer appears over the review it points to | The phone Capture button still opens Voice. The code chose that on purpose ("walking out of the building" in `mobile-capture-button.tsx`), so I left it for you to decide |
| R7 | Partial | Welcome credit line for Free with hosted AI: "Free includes 50 AI credits a month plus 25 to start. Adding someone uses about one". The plan card's credit claim now quotes the paid plan's monthly credits | The first-win credit line |
| R8 | Partial | A first-win screen replaces the overview carousel after the first save in onboarding: who was added, their follow-up date, a picker for someone saved without a date, then "Go to my dashboard" or "Add someone else". It has one quiet animation, held still under reduced motion | The /capture hand-off; "Remind me by email" (needs R9); "Draft the message now" |
| R9 | Not started | – | Waits on D5 (emailing Free users) |
| R10 | Not started | – | Next batch. It needs a table and a `SCHEMA_VERSION` bump, which I kept out of a UI-only batch |
| R11 | Partial | "Generate follow-ups" hidden at zero people. Free plan card hidden until 400 contacts (D8 default). LinkedIn nudge moved below the stats. The preview says "Your 2 people are on the full map" when there are no clusters. The tour item is marked optional and drops off at 3 people | The "Up next" card and first-run order, hiding Goals, the stats naming (F9), the ask-bar overlap |
| R12 | Partial | Contacts zero vs. filtered, Reminders zero, the phone Constellation overlay | Chat zero-contact suggestions, "Re-engage" at zero, Cancel on contacts/new, an in-app 404, the "Pro" tag on Meetings |
| R13–R24 | Not started | – | – |

**Before and after, on the same setup:**

| Measure | Before (audit) | After |
|---|---|---|
| Hosted AI: clicks from welcome to a saved person with a follow-up | 6 for one person (7 for two, as measured), with a path choice and a method choice on the way | 5 for one person, plus the paste. No choices on the way, and a first-win screen instead of the mock-people carousel (A01–A05, A07) |
| Paused AI: adding a first person during onboarding | "Recommended" led to a disabled Extract. The by-hand form was behind Back, set no follow-up, and ended in the mock-people carousel | The by-hand form opens in place with "Follow up in", then the first win shows the follow-up date (A10, A11) |
| Paused AI: what Settings says | "Included AI" credits available (E04) | Credits on hold, plus the key guide (A08) |
| Paused AI: Chat | Accepts a message, then refuses (E06) | Composer disabled: "Chat needs AI, which can’t run right now" (A09) |
| Abandoned onboarding: dashboard | No checklist, no LinkedIn card, no AI alert, permanently | Checklist with the right AI line, the LinkedIn card below the stats, and the AI alert all return (A12) |
| Phone: where "Your orbit is empty" starts | y = 855 in a 664 px viewport (E15) | y = 666, at the fold, with the checklist above it |

**Defaults I chose where a decision is still open.** Each is a one-line change.

| Decision | Default | Where to change it |
|---|---|---|
| D2 | Gemini is the recommended key | `RECOMMENDED_KEY_PROVIDER` in `src/lib/ai-providers.ts` |
| D4 | Capture first, tour optional | `PATH_STAGES` in `src/lib/onboarding-steps.ts` |
| D8 | Free plan card hidden until 400 contacts | `FREE_PLAN_CARD_FROM` in `src/components/dashboard/dashboard-sections.tsx` |

**Checks run:**
- Typecheck is clean, and ESLint finds no errors in the changed files.
- 527 of 541 smokes pass. The other 14 fetch over the network (avatars, CalDAV, feeds, URL guards) and fail the same way on the base commit in this sandbox.
- Playwright: 10 pass, and 2 Stripe checkout specs are skipped without keys. The rewritten onboarding spec caught a race in which the first-win buttons stayed disabled in about 40% of runs. It is fixed: the step keeps its own flag, because AnimatePresence can hold a stale `pending` prop. The spec then passed 10 of 10 runs.

**Not verified:** a real Clerk sign-up, Neon, and production's actual pause flag. As in the audit, the walks ran in demo mode.

---

## 1. What "activated" should mean

### Today

An account counts as activated when `onboarding_completed_at IS NOT NULL OR` it has any real contact `OR` any import (`src/lib/admin-analytics.ts:641-644`). Pressing "Skip setup" counts. So does a LinkedIn import of people the user never acts on. It measures setup, not value (F16).

### Proposed

| Metric | Definition | Why |
|---|---|---|
| **First win** (the moment to design for) | The first time the account has a **real person with a dated follow-up**, created by the user's own action: a capture save, a manual add with a follow-up, "Schedule" on a suggestion, a chat-proposed reminder they confirmed, or an MCP `create_contact` plus reminder | It is Orbit's promise in one event: "remembers the people you meet and tells you when to reach back out" |
| **Activated** (north star) | First win within **7 days** of sign-up | Fits the seasonal intent: a job seeker either gets value in the first week or leaves |
| **Habit** (retention) | Activated, and by **day 14** acted on a follow-up (marked done, logged, drafted or snoozed it) on a day after the sign-up day | Proves the reminder loop reached them, which is the thing that brings people back |

Both can be **backfilled from today's tables**, before any event work ships:

```sql
-- Activated: a real contact with a reminder created within 7 days of sign-up
SELECT s.user_id
FROM user_settings s
JOIN reminders r ON r.user_id = s.user_id AND r.contact_id IS NOT NULL
JOIN contacts c ON c.id = r.contact_id AND c.source IS DISTINCT FROM 'tour-example'
WHERE r.created_at <= s.created_at + interval '7 days';
```

That gives a baseline for every account that already exists. It understates slightly, because a follow-up set only as `contacts.next_follow_up_at` has no timestamp.

**What to measure first, before setting targets:** two weeks of baseline on first-win rate, median time to first win, and the habit rate. There is no data today to justify a number, so the experiments in §7 compare cohorts against that baseline.

---

## 2. The intended first session

**Design rules**, each tied to a finding:
1. One job per screen.
2. The first screen asks for one real person, not a choice of paths (F3).
3. If AI can't run, the same screen still gets them to a person and a follow-up (F1).
4. Show the win back to them before anything else (F4).
5. Defer everything that waits on something: the LinkedIn export, OAuth, the tour (F4, F15).
6. Make sure the follow-up can reach them outside the app (F5).

### 2.1 Storyboard: invite, waitlist and public sign-up

| # | Screen | The user does | Then sees | Time | Copy |
|---|---|---|---|---|---|
| 0 | Clerk sign-up, with an Orbit header | creates the account | – | 30–60 s | C1 |
| 1 | **Welcome = first capture** (replaces the two-card welcome) | writes a line or two about one person, ticks terms if asked, presses **Add them** | "Reading your notes…" (existing) | 30–90 s typing, plus the model | C2 |
| 1′ | *If AI can't run:* the same screen shows a 3-field form (name, where you met, follow up in…) | fills it, presses **Add them** | – | ~20 s | C3 |
| 2 | Review cards (existing, unchanged) | Keep, once per person | "Ready to save" (existing) | 5–15 s | – |
| 3 | **First win** (new; replaces the overview carousel) | reads it. Optional: "Draft the message now", "Add someone else" | the person, the follow-up date, how the reminder will reach them | 10 s | C4 |
| 4 | **Dashboard, first-run mode** (until 3 real people or day 7) | – | "Up next" with their follow-up, then "Add more people" (write about someone, LinkedIn, Google/Outlook) | – | C5 |
| 5 | End-of-session prompt (once) | taps a chip, or dismisses it | "Thanks" | 5 s | §6 |

**Minimum steps:** 4 clicks (Add them → Keep → Save → Go to my dashboard) plus one text field. Today it is 7 clicks plus a choice, and the win isn't shown.

**What changes for the existing paths:**
- The **Guided tour** becomes a secondary link on the welcome screen ("Show me around with example people first") and stays in Settings → Help.
- **Quick setup's** overview carousel goes away. Its content is already one click away in the sidebar.
- The **Connect** step (Google/Outlook) moves off the main line. It becomes a choice on the first-win screen and the dashboard's "Add more people", with the existing pre-prompt copy from Settings (F12).
- The **LinkedIn export** card drops below "Up next" and becomes one of three "Add more people" options (F4, F15).

### 2.2 Variants by entry path

| Path | First session | Changes needed |
|---|---|---|
| **Invite** | "Board Orbit" → sign-up headed "Your seat on Orbit is ready" → welcome greets them by first name → as above | Orbit header on `/sign-up` with a ticket (F8). A held account (signed up with a different email) sees an explanation page with sign-out instead of a silent waitlist redirect (C11). Expired ticket: "This invite has expired" with "Ask for a new link". |
| **Waitlist** | Same as invite, once invited | Waitlist copy promises only what exists: no "waves" or referral perks unless they're built (D7). |
| **Public sign-up** | As above | – |
| **MCP connector first** | The assistant does the first capture. On an empty network the tools say so, and the server `instructions` tell the assistant how to add the first person (`create_contact` plus a reminder). No AI credits are involved: the MCP tools a new user can reach run no Orbit model calls. The research tools are Chat-only and sit behind the unreleased Find page. | Server `instructions` and an empty-network hint in tool results (C10). `entry_path = "mcp"` recorded on the first authenticated MCP call when the account is under an hour old. `/connect` shows the connector URL and stays open in stealth mode. First web visit: a "Connected from {assistant}" card above "Up next", plus terms acceptance (D6). |
| **Chrome extension** (when released) | Install opens `/sign-up?from=extension`, not `/dashboard` → sign-in. Welcome variant: "Open the LinkedIn profile of someone you've met and press Orbit — or write about them here" | Install target and panel button go to sign-up (F8). Welcome reads `from`. The first win can come from the panel's capture. |

### 2.3 Example data and the tour: handing off to real data

- **The tour stays as an opt-in.** It is the right tool for "show me what this does" and the wrong default for "get me started" (F3, E11).
- **The tour's last stop becomes "Now add someone real"** with the step-1 capture box inline. Saving there removes the examples and goes to the first-win screen. Skipping it ends the tour as today.
  - This replaces the finish card's five ticks, which in my walk read four "not yet" after a skip-through.
- **The capture stop** keeps its example note but says so: "This note is about an example person, so what you keep here goes when the tour ends". At the final stop, ask for a real person instead.
- **The "AI ready" tick and the AI-dependent stops** read the same accurate status as Capture (R1).
- **Removing the examples keeps working as today:** automatic on exit and finish, plus "Remove the example people" in the checklist.

### 2.4 Celebrating the first win, without being tacky

- **One moment, once:** the first-win screen.
- **Motion:** the new person's star slides into a small orbit around the user's sun, about 600 ms, reusing the constellation preview canvas. With `prefers-reduced-motion` it is a still image. No confetti, no sound by default.
- **The celebration is the information:** their name, the date Orbit will remind them, and what it will do then ("open the reminder and Orbit drafts the message").
- **Reinforcement comes later:**
  - when they complete the first follow-up, a toast: "Done. Priya's back in your orbit" (the one brand moment);
  - in the day-7 email recap.

### 2.5 Day-2 and day-7 nudges

All emails respect a per-category unsubscribe. At most one lifecycle email a day and three a week. Nudges stop after 14 days without activity. Follow-up-due emails continue, because the user asked for those reminders.

| When | Who | Channel | Message (copy in C9) |
|---|---|---|---|
| Right after the first win | everyone with one | email, transactional | "Your first follow-up is set": who, when, how it will reach them |
| On each due date, 8–9 am local | anyone with follow-up emails on (default on, stated on the first-win screen; D5) | email, plus the bell | "Today: email Priya your resume", with **Draft it** / **Done** / **Snooze a week** |
| Day 1 (about 24 h after sign-up) | no first win yet | email | "Who did you meet this week?", a one-tap link to capture |
| Day 1–2 | asked for the LinkedIn export ("I've requested it") | email, plus the existing in-app reminder | "Your LinkedIn export should be ready", with an upload link |
| Day 7 | activated | email | "Your first week in Orbit": people added, follow-ups done and coming up, one suggestion |
| Day 7 | not activated | email (last nudge) | "Still want a hand keeping track of people?", one tap to add someone, then silence |
| Throughout | everyone | in-app checklist (at most 3 items, clears itself) | "Get set up": turn on follow-up emails · add 3 people · take the tour (optional) |

---

## 3. Changes, in order of impact versus effort

**Effort:** S = about a day or less · M = 1–3 days · L = more than 3 days. Each change lists the findings it addresses.

### Wave 1: small changes with the most leverage (do first)

| # | Change | Fixes | Impact | Effort | Where |
|---|---|---|---|---|---|
| **R1** | **Make the AI-unavailable state truthful and consistent**, in four parts. **(a)** Separate copy for: paused by an admin (no promised return), pool spent with a known refill date, and out of credits (existing). **(b)** Hide the credits card's "Buy a pack" and the credit-email toggle while AI is paused, and for Free. **(c)** Feed the accurate status (pause, pools, credits) to the checklist, the ask bar, the tour's "AI ready" tick and the Radar fallback. One cached `managedAiPaused()` read in the layout keeps the page-budget smokes happy. **(d)** Disable the Chat composer the way Capture disables Extract. | F1 | High | S–M | `src/lib/ai-access-copy.ts`, `src/components/ai-key-notice.tsx`, `src/app/(clerk)/(app)/layout.tsx:158-197`, `dashboard-sections.tsx:142`, `credits-card.tsx`, `chat-panel.tsx` |
| **R2** | **A manual fallback that still creates a follow-up.** When AI can't run, the welcome capture and /capture offer "Type their details instead": name, where you met, follow up in (3 days / 1 week / 2 weeks). Reuse the compact contact form from the onboarding "manual" side-screen and add the follow-up select. | F1, F3 | High | S–M | `src/components/onboarding/steps/*`, `src/components/capture/messy-notes-capture.tsx` |
| **R3** | **A guided key panel.** Render the existing `keyPageUrl` and `keyPageLabel` links. Recommend one provider (D2) with three numbered steps. Detect the provider from the pasted key's prefix (`sk-ant-`, `sk-or-`, `AIza`, `sk-`) and save to the right card. Move OpenRouter, "Decision model" and "Custom model ID" under Advanced. Name all four providers in the notices. | F2 | High (when F1 hits) | S | `src/components/settings/ai-settings.tsx`, `provider-card.tsx`, `src/lib/ai-providers.ts:9-54` |
| **R4** | **A capture-first welcome.** Step 1 is "Who did you meet recently?" with the notes box. "Show me around with example people first" is a secondary link; the terms checkbox stays. On phones the box and primary button sit above the fold. | F3, F13 | High | S | `welcome-step.tsx`, `onboarding-steps.ts` (`PATH_STAGES`), `onboarding-flow.tsx` |
| **R5** | **Fix the abandoned-onboarding state.** If `onboarding_step` is set, `onboarding_completed_at` is null, and the user reaches any gated page, stamp completion (or treat the account as completed for the checklist, LinkedIn card and AI alert). Store the checklist dismissal per account, not per browser. | F5 | High | S | `src/lib/onboarding.ts:45-84`, `setup-checklist-card.tsx` |
| **R6** | **Small mobile fixes:** add Settings to the More sheet; move the review toast off the Name field; open the phone Capture button on notes, or a two-option chooser, rather than Voice. | F13 | Medium | S | `src/components/layout/app-nav.ts:160-170`, `mobile-capture-button.tsx:51` |
| **R7** | **Credit literacy for new sign-ups:** one line on the welcome capture ("Free includes 75 AI credits to start. This uses about one") and on the first-win screen. Stop showing the "with AI included" upsell copy to Free. | F1, F11 | Medium | S | `plan-launch-card.tsx:111-121`, new welcome copy |

### Wave 2: the first-win experience and the return loop

| # | Change | Fixes | Impact | Effort | Where |
|---|---|---|---|---|---|
| **R8** | **A first-win screen** after the first save (onboarding and /capture), replacing the overview carousel: person cards with the follow-up date, a "Remind me by email" line, "Draft the message now", "Add someone else", "Go to my dashboard", and the small orbit animation (§2.4). | F4 | High | M | new `src/components/onboarding/steps/first-win-step.tsx`; `capture-summary.tsx` hand-off |
| **R9** | **Follow-up-due email, plus the day-0 confirmation**, for every plan. A batched daily send in the user's timezone, signed one-tap links (Done, Snooze a week, Draft it), a per-category unsubscribe, and a toggle on the first-win screen and in Settings → Notifications. Resend and the `ops.yml` scheduler already exist. | F5 | High | M | new `src/lib/email/follow-up-due.ts`, ops route, `user_settings` preference (jsonb) |
| **R10** | **Product events and the activation metric** (§5): a `product_events` table, a `trackEvent()` helper, and a client action with an allowlist. Update the admin funnel to first win, activated and habit, and exclude tour examples from `/admin` counts. | F16 | High (it makes the rest measurable) | M | `src/db/index.ts` (with a `SCHEMA_VERSION` bump), `src/lib/product-events.ts`, `admin-analytics.ts`, `admin-metrics.ts:180-196` |
| **R11** | **Dashboard first-run mode**, until 3 real people or day 7. Order: "Up next" (follow-ups), "Add more people" (3 options), checklist (at most 3). Hide zero-value sections: zero stats, the empty preview, Goals, the Free plan card (show it again at 400 contacts), and "Generate follow-ups" at zero. Count reminders in "Due follow-ups", or rename the stats to match (F9). Stop the ask bar overlapping the empty-state buttons. When the preview has no clusters, say "Your 2 people are on the full map →" instead of "Your sky is empty". Remove the tour item from the checklist once the user has real people. | F4, F9, F11 | High | M | `dashboard/page.tsx:65-173`, `dashboard-sections.tsx`, `dashboard-graph-preview.tsx`, `src/lib/reminders.ts:1058-1081` |
| **R12** | **Empty-state pass:** Contacts (zero vs. filtered), Reminders (zero), Chat (zero contacts), phone Constellation overlay, "Re-engage" hidden at zero, Cancel on contacts/new, an in-app 404 that keeps the shell, and a "Pro" tag on Meetings for Free. | F10 | Medium | M (S each) | `contacts-list.tsx:423-436`, `reminders-stage.tsx:744`, `chat-suggestions.ts:205`, `graph-canvas-mobile.tsx`, `app-nav.ts`, new `(app)/not-found.tsx` |

### Wave 3: entry paths, imports and consent

| # | Change | Fixes | Impact | Effort | Where |
|---|---|---|---|---|---|
| **R13** | **Day-1 and day-7 lifecycle nudges**, with frequency caps (§2.5), plus an email version of the LinkedIn-ready reminder. | F5, F15 | Medium–High | M | email templates, ops route |
| **R14** | **Import against the Free cap.** The preview warns when the file exceeds the remaining room and lets the user choose which people to bring in (default: most recently connected). The toast states how many are waiting. Rows held by the plan import automatically after an upgrade. | F6 | Medium (High for LinkedIn-first users) | M | `src/actions/imports.ts:225-301`, `src/lib/import-job-runner.ts`, `import-engine.ts` |
| **R15** | **MCP first use:** server `instructions`, an empty-network hint in tool results, `/connect` showing the URL (and open in stealth), a held account returning a non-auth error rather than a 401 with `WWW-Authenticate`, and the `entry_path` record. | F7 | Medium | S–M | `src/lib/mcp/server.ts:117-168`, `src/lib/tools/definitions.ts`, `src/app/(site)/connect`, `waitlist-host.ts:279-286`, `mcp/handle.ts:142-152` |
| **R16** | **Invite handoff:** an Orbit header on sign-up, a held-account explanation page with sign-out, an expired-invite page with an admin "Resend", invite-email copy fixed ("everything included"), and waitlist copy cut to what exists. Count waitlist joins per email, not per IP, so shared campus Wi-Fi isn't silently dropped. | F8 | Medium | M | `sign-up/[[...sign-up]]/page.tsx`, `site-access.ts`, `interest/page.tsx`, `site-invite-email.ts`, `interest-list-join.ts:128-137` |
| **R17** | **Consent pre-prompts:** one line before the webcam or microphone opens. Ask for desktop-notification permission from the first-win screen with an explanation, not automatically after scheduling, and stop re-enabling the account preference. Partial or denied OAuth scopes must not count as "connected". Toasts for OAuth returns on /imports. Remove "Orbit never sends email from your account". | F12 | Medium | M | `scan-camera.tsx:56-86`, `voice-recorder.tsx`, `easy-follow-up.tsx:86`, `api/gmail/callback/route.ts:92-136`, `connect-step.tsx:269` |
| **R18** | **Naming pass** (D9). Glossary in §4.1. Covers the "Log interaction" button, follow-up versus reminder, orbit versus network, a one-line Constellation subtitle on phones, and the Knowledge label. | F9 | Medium | M | copy across `src/components/**` |
| **R19** | **LinkedIn export instructions.** If LinkedIn's smaller "specific files" export (Connections) arrives quickly, tell people to request that first (X5). | F15 | Medium | S | `linkedin-export-instructions.tsx`, `linkedin-export-guide.tsx` |

### Wave 4: hygiene

| # | Change | Fixes | Effort |
|---|---|---|---|
| R20 | **Onboarding mechanics:** a single terms prompt; the import side-screen's "Skip for now" moves forward; slide direction; try/catch on path actions; "Start the tour anyway" actually starts it; partial seed repaired; tour ticks persisted; a stale tab can't reopen onboarding | F14, F3 | S each |
| R21 | **Cost and abuse guards** (D3, D10): a Free sub-cap inside the shared pool; BotID or a rate limit on sign-up; Free background AI spend off by default ("Keep work history current") | F1 cost | M |
| R22 | **"Delete all data" keeps or re-issues credit grants** | F17 | S |
| R23 | **Docs drift:** `.env.example`, `docs/DEVELOPMENT.md` demo path, the Sprint B spec credit figure, stale comments | F18 | S |
| R24 | **Imports polish:** one import control, not two; reattach live progress after a reload; "duplicates in this file" copy; stale "Messages tab" copy; hide the paid calendar link from Free | F6 | S each |

**My recommended first batch:** R1, R2, R4, R5, R3 and R6 (all S), then R8, R9 and R10. These cover all three top drop-off risks and make the result measurable.

---

## 4. Copy for the key screens

### 4.1 Voice and glossary

**Voice.** Copy is calm and specific, written to "you", and says what happens next. These rules already apply in this codebase and stay:
- curly apostrophes;
- no trailing period on a single UI string;
- at most one " — " per string;
- never "failed";
- no blame.

New rules:
- Use real dates ("Thu, Oct 31"), not "in 14 days".
- Use real names from the user's own data.

**Glossary.** One name per concept in instructional copy. Brand flourishes are fine in headlines.

| Concept | Use | Avoid in instructions |
|---|---|---|
| Turning notes into people | **Capture** (nav, page), "Add someone" (buttons) | "Log interaction" for capture, "Extract people" (keep it on the review button only), "Messy Notes" |
| A dated thing to do about a person | **Follow-up**. The page can stay "Reminders"; the dashboard counts follow-ups and reminders together | Separate "Due follow-ups" and "Reminders" counts |
| The people someone knows | **Your network** | "Your orbit" outside brand moments ("You're in orbit", "back in your orbit") |
| The star map | **Constellation**, with the subtitle "Your network as a map" on every viewport | "Star chart", "graph" |
| Closeness | **Closeness** (1–5 in review, a % on the profile) | "Strong ties", "Close + warm" as stat labels; "Gone quiet" / "Dormant" / "drifting comets" together. Pick "Gone quiet" |
| Notes and summaries | **Knowledge** | "Knowledge base" in one place and "Knowledge" in another |
| AI allowance | **AI credits** | "included AI", "AI included" |

### 4.2 Copy deck

**C1 · Sign-up header** (above the Clerk card)
- Invite: **"Your seat on Orbit is ready"** · "Create your account with {invited email} and you’re in"
- Public: **"Create your Orbit account"** · "Free for your first 500 people. No card needed"

**C2 · Welcome = first capture** (E14 today → mockup frame 1)
- Eyebrow: "Welcome to Orbit" (with ", {first name}" when known)
- H1: **"Who did you meet recently?"**
- Body: "Write a line or two about one person — where you met and what you said you’d do. Orbit turns it into a contact and a follow-up"
- Field label: "About them"
- Placeholder: "Met Priya Shah at the career fair. Campus recruiter at Datadog. New grad applications open Nov 1, she said to email her my resume"
- Terms (only when not recorded by Clerk): "I agree to Orbit’s Terms of Service and Privacy Policy"
- Primary: **"Add them"**
- Under the primary, hosted AI only: "Free includes 75 AI credits to start. This uses about one"
- Secondary links: "Type their details instead" · "Show me around with example people first" · "Skip for now"
- Empty-submit hint: "Add a name and one detail, like where you met"

**C3 · When AI can't run** (replaces "Included AI comes back on its own")
- Notice title, admin pause: **"Orbit’s AI is paused right now"**
- Notice title, pools spent: **"Orbit’s AI is resting until {Nov 15}"**
- Body: "You can still add people and set follow-ups by hand. Want AI now? Use your own key — it takes about 3 minutes"
- Links: "Set up your own key"
- Manual form:
  - "Their name" (required)
  - "Where you met" (placeholder "Career fair, class, coffee chat…")
  - "What’s next" (placeholder "Email my resume")
  - "Follow up in" [3 days] [1 week] [2 weeks]
  - Primary "Add them"
- Chat composer, disabled: "Chat needs AI, which is paused right now. Your notes and people are all still here"

**C4 · First win** (new; mockup frame 2)
- H1, one person: **"Priya is in your network"** · several: **"{n} people are in your network"**
- Per person: "{Name} · {Role} at {Company}" / "Follow up by {Thu, Oct 31}: {Email her your resume}"
- Body: "Orbit will remind you on {Thu, Oct 31}. When it’s time, open the reminder and Orbit drafts the message"
- Email line (checkbox, on by default; D5): "Email me on the day a follow-up is due. One email that morning, nothing else"
- Buttons: Primary **"Go to my dashboard"** · Secondary "Add someone else" · Link "Draft the message now"
- No follow-up created (closeness under 3, no dated action): "{Name} is in your network. Want a nudge to stay in touch?" with [1 week] [2 weeks] [1 month] [Not now]

**C5 · Dashboard, first-run mode** (mockup frame 3)
- "Up next" card title: **"Up next"** · row: "{Email resume} · {Priya Shah} · {Thu, Oct 31}" with "Draft" and "Done"
- "Add more people" title: **"Add more people"** · options:
  - "Write about someone" — "Notes from a coffee chat, a class or an event"
  - "Bring in your LinkedIn connections" — "Ask LinkedIn for your export now, upload it when it arrives"
  - "Connect Google or Outlook" — "Pick who to add from your contacts"
- Checklist title: **"Get set up"** · items: "Turn on follow-up emails" · "Add 3 people ({n} of 3)" · "See every page with example people (optional)"
- Preview with no clusters yet: "Your {n} people are on the full map" with "Open Constellation"

**C6 · Empty states**
- Contacts, zero people: **"No one here yet"** · "Add someone you met recently and they’ll show up here with how you met and what’s next" · [Add someone] (secondary: "Import LinkedIn")
- Contacts, filtered to nothing: keep the existing "No contacts match these filters…"
- Reminders, zero: **"No follow-ups yet"** · "When you add someone, Orbit sets a follow-up for them. You can add one by hand too" · [Add someone] [New reminder]
- Reminders, none due today but some upcoming: keep "Nothing due today · You’re clear. Upcoming has what’s next"
- Chat, zero people: **"Ask about your network"** · "Add a few people first, then ask things like “Who do I know at Datadog?”" · [Add someone]
- Constellation, zero (desktop and phone): **"Your map starts with one person"** · "Everyone you add becomes a star, grouped by company and school" · [Add someone]

**C7 · Your own AI key** (R3)
- Header: **"Use your own AI key"**
- Body: "Orbit can run on an AI account of your own. You pay the provider directly and it never uses your Orbit credits"
- Recommended card (D2 decides which), e.g. Google Gemini, with a "Recommended" tag:
  1. "Open Google AI Studio and sign in with your Google account" [Create a key in Google AI Studio ↗]
  2. "Press Create API key and copy it"
  3. "Paste it below and press Save. Orbit checks it straight away"
- Caveat, if recommending a free tier: "Google’s free tier has usage limits and its own data terms. Check them before you use it for notes about other people"
- Other providers (collapsed): "Use OpenAI or Anthropic instead" with the existing `keyPageLabel` links
- Prefix detected: "That looks like an Anthropic key, so Orbit saved it there"
- Keep the existing validation copy: "{Provider} didn’t accept that key — check it and try again"

**C8 · Import over the Free cap** (R14)
- Preview banner: **"Your Free plan has room for {420} more people"** · "This file has {3,000}. Pick who to bring in, or upgrade to bring in everyone" · [Bring in the {420} most recent] [Choose people] [See plans]
- Toast: "Imported {420} people. {2,580} are waiting until you have more room"
- After an upgrade: "Bringing in the {2,580} people who were waiting"

**C9 · Emails** (sender name per D5)
- **Day 0, first win**
  - Subject: "Your first follow-up is set"
  - Preheader: "Orbit will remind you about Priya on Thu, Oct 31"
  - Body: "You added Priya Shah. On Thu, Oct 31 Orbit will remind you to email her your resume, and draft the message when you open it. Met anyone else at the career fair? Add them while it’s fresh"
  - CTA: "Add someone else"
- **Follow-up due**
  - Subject: "Today: email Priya your resume"
  - Preheader: "You met her at the career fair on Oct 17"
  - Body: "{Priya Shah} · {Campus Recruiter at Datadog}. Your note: “{she said to email her my resume}”"
  - Buttons: "Draft it" · "Done" · "Snooze a week"
  - Several due: subject "{3} follow-ups for today", with the list
- **Day 1, no first win**
  - Subject: "Who did you meet this week?"
  - Body: "Write a line about one person and Orbit sets the follow-up for you. It takes about a minute"
  - CTA: "Add someone"
- **Day 1–2, LinkedIn requested**
  - Subject: "Your LinkedIn export should be ready"
  - Body: "Look for “Your LinkedIn data archive is ready” in your inbox. The link lasts 72 hours. Upload the ZIP as it is"
  - CTA: "Upload it"
- **Day 7, activated**
  - Subject: "Your first week in Orbit"
  - Body: "{4} people added · {1} follow-up done · {2} coming up. Next: {Tom Becker, Thu, Oct 24}"
  - CTA: "Open Orbit"
- **Day 7, not activated (last)**
  - Subject: "Still want a hand keeping track of people?"
  - Body: "Add one person and Orbit will remind you when to reach back out. If now’s not the time, this is the last nudge"
  - CTA: "Add someone"

**C10 · MCP**
- Server `instructions`: "Orbit is the user’s personal network: people they’ve met, notes, and follow-ups. If a search returns no people, the user’s Orbit is new. Offer to add someone they met recently with create_contact, then set a follow-up with create_reminder. Never send messages without the user’s approval"
- Empty-network hint, added to empty tool results: `"hint": "This Orbit account has no people yet. Ask the user about someone they met recently and add them with create_contact."`
- First web visit card: **"Connected from {Claude}"** · "Everything you add there shows up here. Here’s what’s coming up"

**C11 · Invite edge pages**
- Held account: **"This account isn’t on the invite list yet"** · "You’re signed in as {email}. Your invite went to {p•••@school.edu}. Sign out and use that address, or reply to your invite email to have it moved" · [Sign out] [Back to the waitlist]
- Expired invite: **"This invite has expired"** · "Invites last 30 days. Reply to the invite email and we’ll send a fresh link" · [Join the waitlist]
- Invite email fix: replace "One seat, everything included" with "One seat on the Free Plan, AI included"

**C12 · Permission pre-prompts** (R17)
- Microphone: "Orbit needs your microphone to hear this note. It only listens while the button is held"
- Camera (desktop scan): "Orbit will open your camera to read a business card. Nothing is saved until you keep it"
- Desktop notifications (asked from first win): "Want a pop-up when a follow-up is due? Your browser will ask next" · [Turn on] [Not now]

---

## 5. Events to add

**There is no tracking plan or product-event mechanism today** (F16). Proposal:
- **Storage.** One server-side table, `product_events (id, user_id, name, props jsonb, created_at)`, with 180-day retention like `usage_events`. Demo and internal accounts are excluded via `src/lib/analytics-internal.ts`.
- **Writing.** A `trackEvent(userId, name, props)` server helper, and one allowlisted client server action for UI-only events.
- **Existing tables stay** for what they already measure: AI cost in `usage_events`, paywalls in `gate_events`, routes in `page_views`, emails in `email_sends`.
- **Common props:** `entry_path` (invite / waitlist / public / mcp / extension), `plan`, `ai_state` (hosted / own_key / paused / pool_spent / out_of_credits), `device` (phone / desktop), `onboarding_path`.

| Event | Props | Answers |
|---|---|---|
| `account_created` | entry_path, invited, email_matches_invite | Sign-ups by path |
| `invite_link_opened` | state: valid / expired / signed_in_other | Invite drop-off before sign-up |
| `account_held` | reason | Different-email strandings |
| `onboarding_step_viewed` | step, path | Step reach (URL doesn't change, so page_views can't do this) |
| `onboarding_step_completed` | step, path, ms_on_step, action | Per-step completion and time |
| `onboarding_skipped` | from_step | Where people bail |
| `onboarding_completed` | path, finished | Completion versus skip |
| `terms_accepted` | surface: clerk / welcome / banner | Double prompts |
| `capture_started` | surface: welcome / capture / phone / tour / extension, mode | Intent to add |
| `capture_extract_finished` | ok, people_count, ms, error_kind, ai_source | Model latency and failures at the aha step |
| `capture_saved` | people_new, people_updated, follow_ups_created | Saves |
| `contact_created` | source: capture / manual / import / mcp / extension / suggestion, is_first | First person |
| **`follow_up_scheduled`** | source: capture_auto / capture_action / manual / suggestion / chat / mcp, days_out, **is_first** | **First win (the activation event)** |
| `first_win_viewed` | people_count | The new screen is seen |
| `follow_up_acted` | action: done / logged / drafted / snoozed, days_from_due, channel: app / email | Habit |
| `ai_blocked_shown` | reason, surface | Exposure to F1 |
| `ai_key_save_attempted` | provider, result: ok / rejected / format / unchecked, detected_provider | Key panel success |
| `credits_exhausted` | plan, starter_left | Allowance sizing |
| `linkedin_export_requested` | surface | Started the 24 h path |
| `import_finished` | kind, rows, created, updated, blocked_by_plan, failed_rows, ms, ok | Import success and the cap |
| `oauth_connect_returned` | provider, purpose, result: granted / partial / denied / cancelled / plan_limit | Consent drop-off (today's error_events have no user id) |
| `permission_result` | kind: camera / microphone / notifications, pre_explained, granted | Prompt acceptance |
| `tour_stop_completed` | stop_id, via: did_it / skipped | Tour engagement (in memory only today) |
| `tour_ended` | how: finished / exited, stop_id, real_person_added | Tour hand-off |
| `checklist_item_clicked` / `checklist_dismissed` | item | Checklist use |
| `empty_state_cta_clicked` | page, cta | Which empty states move people |
| `paywall_shown` | feature, surface | Includes page-level `LockedFeature` paywalls, which gate_events misses |
| `email_clicked` | template, link | Nudge effectiveness (`email_sends` records the sends) |
| `mcp_first_result` | tool, empty | MCP path on empty accounts (first call per tool per account only) |
| `first_session_prompt_answered` | choice, text_len, activated | Intent (§6) |

**Derived funnel** for the admin page, from these events plus existing tables:

`account_created` → `onboarding_step_viewed(welcome)` → `capture_started` (or a manual add) → `contact_created(is_first)` → **`follow_up_scheduled(is_first)`** → returned on a later day (page_views by user_id) → `follow_up_acted` within 14 days.

Each step can be cut by entry_path, device and ai_state.

---

## 6. End-of-first-session prompt

- **What:** a small, non-modal card. Bottom-right on desktop, a sheet above the bottom nav on phones. Shown **once per account**, never during the tour or a capture.
- **When:**
  - Activated in session one: after the first-win screen is dismissed and they have spent about 60 s on the dashboard, or on their next page view.
  - Not activated: after 3 minutes of activity without a first win.
- **Copy, activated:** **"Quick question: what brought you to Orbit today?"** Chips:
  - "Following up after a career fair or event"
  - "Keeping track of recruiters and referrals"
  - "Staying in touch with people I already know"
  - "Just looking around"
  - "Something else" (opens a 140-character field)
- **Copy, not activated:** **"What were you hoping to do today?"** The same chips, plus "Anything get in the way?" (optional text).
- **Thanks:** "Thanks — that helps us shape Orbit around you"
- **Storage:** the existing `feedback` table with a new kind `first_session_intent`. It already supports kinds; `pmf` and `churn_reason` exist but are unused. Also an event, `first_session_prompt_answered`.
- **Use:** tailor the day-1 email ("career fair" → "Met anyone else from the fair?"), choose the tour cast, and read the not-activated answers weekly as the qualitative half of every experiment.

---

## 7. Experiments and before/after comparisons for a small user base

Classic A/B tests won't reach significance at tens or low hundreds of sign-ups a week. So:
- **Sequential cohorts.** Two weeks before, two weeks after, with the same measurement windows.
- **Absolute counts** next to rates.
- **A guardrail metric** per change.
- **5–8 moderated sessions** per wave with students on their own phones, think-aloud, recorded with consent.

The baseline for activation comes from the backfill query in §1.

| # | Change tested | Primary metric | Secondary and guardrail | Method |
|---|---|---|---|---|
| X1 | Capture-first welcome (R4) vs the two-card welcome | % of sign-ups with a first win within 24 h | Median time to first win; % who start the tour; skip rate | Before/after cohorts, 2 weeks each, plus sessions |
| X2 | First-win screen (R8) vs carousel | % who act on the first follow-up by its due date | Day-7 return; "Add someone else" clicks | Before/after |
| X3 | Follow-up-due email (R9) | % of due follow-ups acted on within 48 h | Day-14 habit rate; unsubscribe rate (guardrail at most 5%) | If volume allows, a 20% holdout by user-id hash; otherwise alternate weeks |
| X4 | Day-1 nudge for no first win (R13) | % who reach a first win within 48 h of the email | Unsubscribes | Holdout by user-id hash, or before/after |
| X5 | LinkedIn "specific files" export instructions (R19) | % who finish a LinkedIn import within 48 h of "I've requested it" | Import errors | First, request both export types from a test LinkedIn account and time the emails. Then before/after |
| X6 | AI-unavailable fallback (R1 + R2), whenever AI is paused or a pool is spent | % of users shown `ai_blocked_shown` who still reach a first win that day | `ai_key_save_attempted` success rate | Compare exposed vs unexposed users in the same weeks |
| X7 | Credit sizing (D3) | Distribution of week-1 credits used per new Free user; % who hit zero in week 1 | Orbit-paid cost per activated user | Observe; no variant needed |

**Before shipping, check against the walkthrough numbers:**
- Welcome to first win: 7 clicks today, 4 after R4 + R8.
- Phone: "Your orbit is empty" CTA at y=855 today; the capture box above the fold after R4.
- Empty dashboard: 10 suggested actions today, 3 after R11.

---

## 8. Decisions I need from you

**D1. Is hosted AI unpaused in production, and do you want it to be the default?**
- Production reads paused until `site_settings.managed_ai_paused` is set false (`src/lib/ai-access.ts:181`). I can't see production.
- If it is paused today, every Free user is in the F1 state right now.
- **Recommendation:** confirm the switch and the managed keys this week. Whatever the answer, ship R1 + R2, because pools can run out.

**D2. How to handle key friction: options and costs.** Costs use 1 credit = $0.01 of model spend (`src/lib/credits/grants.ts`).

| Option | What the user experiences | Orbit's cost | Risks |
|---|---|---|---|
| **A. Hosted credits for Free** (built: 25 starter + 50 a month) | No key, ever, for normal use | At most $0.25 once plus $0.50 a month per Free account. Typical is far lower. On measured Gemini prices a capture is about 0.86 credits and a chat 0.25–0.56 (`docs/ai-evals/2026-09-19-gemini-candidate`), so a busy first week (10 captures, 20 chats, 5 drafts) is about 19 credits, roughly $0.19. Managed AI runs Claude Haiku 5.5, which `ai-pricing.ts` prices at about 1/7 of Gemini 3.8 Flash. Unmeasured. | The **shared pools** (Anthropic $190 a month, OpenAI $950 once) cut AI for every plan at once when spent. A starter grant per new account invites farming, and sign-up has no BotID. Background jobs can spend up to half a Free account's monthly credits even on dormant accounts (D10) |
| **B. Defer the key until the first AI action** | Already the structure: nothing asks for a key up front | $0 | Only matters if A is off |
| **C. Sample-data mode first** (the tour) | Exists. Shows value without any key or AI call (the seed makes no AI calls) | $0 | Produces no real data (F3); good as an option, wrong as the default |
| **D. Guided bring-your-own-key** (R3), recommending one provider | 3–5 minutes in another product for a non-technical user | $0 | Many students won't finish it. If you recommend a free tier, its data terms may differ from paid ones; verify the current terms, since notes describe third parties |
| **E. Smaller trial** (starter only, no monthly) | Runs out right when a job search heats up | Lower | Hurts the seasonal user most |

**Recommendation:** keep **A** as the default. Make **D** the honest fallback (R1–R3). Add a Free sub-cap inside the pools so paid users keep AI when Free spend spikes. Gate the starter grant on a verified email plus BotID at sign-up.
- **Your call:** recommend Gemini (free tier, a Google account most students have, different data terms) or OpenAI/Anthropic (paid only, cleaner terms) in C7.

**D3. Pool policy.** When pools near empty, should Free degrade first? Today every plan fails together. What cap per month do you want for Free versus paid, and should I size the pools against expected sign-ups (each fully used Free month costs at most $0.50)?

**D4. Make capture the default and the tour optional** (R4)? This reverses the current "Recommended" tag on the tour. **Recommendation:** yes. The tour ends with zero real people (E11).

**D5. Lifecycle email for Free accounts.**
- Are you comfortable emailing Free users?
- Should the follow-up-due email default to on, stated plainly on the first-win screen?
- Sender: "Jason at Orbit" (personal, matching the waitlist emails) or "Orbit"?
- Legal check: due-follow-up and first-win emails are service emails the user triggered. Day-1 and day-7 nudges are closer to marketing and need an unsubscribe and, in some regions, consent.

**D6. MCP-first users and Terms.** Treat Clerk's consent as enough, or require Orbit's terms acceptance on the first web visit or in the first tool result? Today they never see Orbit's terms screen.

**D7. The invite model.**
- Should an invite be claimable by any address the recipient signs up with (a token-bound claim), or stay tied to the invited email with an explanation page (C11)?
- Should waitlist "waves" and referral perks be built or removed from the copy?

**D8. The Free plan card on day 0.** Hide it until 400 contacts? It sells before any value, and its "with AI included" copy is wrong for Free.

**D9. Naming.** Approve the glossary in §4.1, especially "Capture" over "Log interaction", one combined follow-up count, and "network" over "orbit" in instructions.

**D10. Background AI spend on Free.** "Keep work history current" is on by default and can spend Orbit credits on accounts that never come back (`work-history-sweep.ts`). Off by default for Free?

**D11. LinkedIn import over the cap** (R14). Choose-who-to-bring-in at the preview, or first-N-in-file as today? Should held rows import automatically after an upgrade?

---

## 9. Not proposing

- **A goal or persona question at sign-up.** The end-of-session prompt (§6) gets the same signal without adding a step before value. Sprint B also put it out of scope.
- **Forcing a key, or any setup, before the user can look around.** Every page stays reachable.
- **A longer guided tutorial, or more tour stops.** The tour is good as an opt-in, and it is already 11 stops.
- **Gamified streaks, confetti or badges.** One quiet celebration, then reinforcement through real follow-ups.

# Onboarding audit: how fast a new user gets real value from Orbit

**Date:** 2026-10-17 · **Branch:** `claude/upbeat-ramanujan-doqeks` (equal to `main` @ `bf1b4ae`) · **Scope:** Phase 1, audit only. No application code changed.

Companion: [`ONBOARDING_PLAN.md`](ONBOARDING_PLAN.md) holds the recommended design, copy, events and decisions. Screenshots referenced as `E##` are in [`onboarding/evidence/`](onboarding/evidence/).

---

## 0. Summary

### The premise has changed: a key is no longer required, unless hosted AI is paused in production

The brief assumes capture and chat do nothing until a user adds their own key. That was true before Sprint B. On this branch it is not:

- **Free accounts get hosted AI on Orbit's own provider keys:** 25 starter credits, then 50 credits a month. A key is optional.
  - `PLAN_CONFIG.free.monthlyCredits: 50`, `features.hostedAi: true`, `FREE_STARTER_CREDITS = 25` (`src/lib/plans/plan-config.ts:47,142,156`).
  - `MANAGED_AI_ENABLED = true` (`src/lib/managed-ai-policy.ts:35`).
- **I walked this end to end on a fresh account** with a stubbed provider. Paste a note → "Save 2 contacts + 2 reminders" → 49 of 50 credits left. No key was involved (E07, E08).
- **The catch: in production the runtime switch reads paused until an admin sets it.** The code says: "Unset reads as PAUSED on production — managed AI must not run before the legal text describing it ships" (`src/lib/ai-access.ts:167-182`, `managedAiPausedDefault()` returns `VERCEL_ENV === "production"`).
- **I cannot see production.** So whether a new user today gets hosted AI or a dead end depends on `site_settings.managed_ai_paused`. That is **decision D1** in the plan.
- **Even when unpaused, hosted AI can switch off for everyone at once.** It draws on two shared pools: Anthropic at $190 a month, and OpenAI at $950 prepaid that never refills (`managed-ai-policy.ts:53-56`). When both are spent, every account without its own key, on every plan, falls into the same "unavailable" state.

So the key is no longer the guaranteed hurdle, but it is a **latent cliff**. When the cliff hits, today's experience is worse than a plain "add a key" screen: the copy is false, the screens contradict each other, and the bring-your-own-key fallback has no guidance (F1, F2).

### The three biggest drop-off risks

1. **The AI-unavailable state is a dead end with contradictory, untrue copy** (F1, F2). This is the state production starts in, and the one every account lands in when the pools run dry:
   - Capture and Chat say "Included AI comes back on its own" (E03, E06).
   - In the same state, Settings shows "50 of 50 monthly credits left · 25 starter credits left", with Gemini marked "In use" (E04).
   - The checklist, the ask bar and the tour use a presence-only check, so in production they say nothing, or "AI ready ✓" (E11).
   - The key fallback has no recommended provider, no "get a key" link (the URLs exist in code but are never rendered), and no steps.
2. **Neither onboarding path ends with a real person and a follow-up, and the first win is buried** (F3, F4).
   - The recommended **Guided tour** finishes with zero real contacts. Four of its five finish ticks read "not yet" (E11).
   - **Quick setup** can produce a real capture (E08). Right after the save, though, it shows a seven-chapter feature carousel full of mock people (E09).
   - The dashboard that follows offers about 10 different next actions. It leads with a 24-hour LinkedIn chore (E01, E15) and says "Due follow-ups 0" beside the two follow-ups the user just made (E10).
   - On a phone, the "Your orbit is empty" call to action starts below the fold (y=855 in a 664px viewport, E15).
3. **Nothing brings a new user back, and leaving onboarding early silently disables the safety nets** (F5).
   - Free accounts get no email at all: no welcome, no day-2 or day-7 nudge, not even an email when a follow-up is due. For a networking tracker, the due follow-up *is* the product.
   - A user who opens onboarding and then goes to the dashboard (or closes the tab) never gets the setup checklist, the LinkedIn card or the AI alert again. I reproduced this.
   - There are no product events, so none of this drop-off is visible today (F16).

### The fastest realistic path to first value, today

**Quick setup → "Capture from notes" → paste one note → Extract people → keep each card → Save.**
- **Desktop:** 7 clicks plus 1 paste, from the welcome screen to "2 contacts + 2 reminders" saved. That took 18 s of clicking and waiting with a stubbed provider at 4 s per call.
- **Phone:** 5 taps plus typing, from /capture.
- **Realistic first session:** about 2–3 minutes, adding time to type a real note and real model latency (unmeasured).

It works only if hosted AI is running, and the user must pick the **non-recommended** path. The full path map is in §2.

### What I would change first

1. **Settle D1, and make the AI-unavailable state honest and non-blocking.**
   - Truthful copy, and a manual "add by name" fallback that still creates a follow-up.
   - Hide credits and pack purchases while AI is paused.
   - A guided key panel that recommends one provider.
2. **Make capture the default first step,** and replace the post-save carousel with a "first win" screen that shows the person and the follow-up date.
3. **Fix the abandon state,** and send the follow-up-due email and a day-0 confirmation, so the first follow-up actually reaches the user.

Details, effort and copy are in the plan.

---

## 1. How I tested

| | |
|---|---|
| **Environment** | `next dev` on `localhost:3000`, demo mode (no Clerk keys), a throwaway PGlite per scenario (`ORBIT_PGLITE_DIR`). Never production, never real user data. All people in the screenshots are synthetic. |
| **Fresh accounts** | Four separate empty databases, one per scenario: no-AI, first value, phone, tour. Each scenario started from an empty account with `ORBIT_DEMO_DATA=off`. |
| **Production-like AI** | `ORBIT_DEMO_MANAGED_AI=off`, so the account is treated as a real Free account (metered credits, not the developer's unmetered key). |
| **No-AI state** | No provider keys at all. This gives `managed_unavailable`, which is the same state production shows while paused or when pools are spent. |
| **Hosted-credit state** | A local Gemini stub (a copy of `e2e/ai-stub-server.mjs` extended to return two people with follow-ups) and a 4 s latency per call. The app's real provider code ran; only the network answer was canned. |
| **Viewports** | Desktop 1440×900, and iPhone 13 (390×664 CSS px, touch, 3× DPR) via Playwright. |
| **Slow connection** | Chrome DevTools throttling (400 ms latency, 500 kbps) on the phone profile. Dev bundles only, see §8. |
| **Large import** | A synthetic 3,000-row LinkedIn `Connections.csv` in LinkedIn's export format, uploaded on /imports. |
| **Code** | Six read-only code traces (entry paths, onboarding, AI access, empty states and navigation, imports and consent, analytics and lifecycle), with spot checks of the claims the top findings rest on. |

Tags used below: **[W]** seen in the walkthrough · **[C]** traced in code but not exercised.

**Not walkable here** (details in §8):
- Clerk-hosted screens (sign-up, the invite ticket, the OAuth consent used by MCP)
- Google and Microsoft OAuth (no client configured, so the connect step was skipped in every walk)
- the Chrome extension
- a real Claude or ChatGPT connector
- OS camera and microphone prompts
- Free-plan paywalls, which are lifted on localhost

---

## 2. First-run flow maps

### 2.1 The shared core: sign-up → onboarding → dashboard

Every web path ends up at `/onboarding`.
- `SignUp forceRedirectUrl="/onboarding"` (`src/app/(clerk)/(auth)/sign-up/[[...sign-up]]/page.tsx:53-66`).
- The app layout redirects any account with no contacts and no imports (`src/app/(clerk)/(app)/layout.tsx:111-114`, `src/lib/onboarding.ts:45-84`).

The welcome screen is the same for every path. Nothing tells onboarding how the user arrived (`onboarding/page.tsx` reads no params).

**Welcome** [W] (E14)
- Copy: "Welcome to Orbit" / "Orbit remembers the people you meet and tells you when to reach back out. Choose how you'd like to start."
- A terms checkbox, shown when Clerk didn't record consent.
- Two cards:
  - **Guided tour** — RECOMMENDED: "Connect your accounts, then a three-minute tour of the real pages." [Start the tour]
  - **Quick setup**: "About a minute." [Set up quickly]
- **On a phone, the Quick setup card is entirely below the fold.**

**Quick setup** (`PATH_STAGES.quick`: welcome → people → connect → overview; `src/lib/onboarding-steps.ts:68-71`). The connect step is skipped when no Google or Microsoft client is configured, as it was in my walks.

| # | Screen [W] | User action | Required input | Wait | Notes |
|---|---|---|---|---|---|
| 1 | Welcome | tick terms, "Set up quickly" | terms checkbox (if needed) | – | 2 clicks |
| 2 | "Add your first people" | "Capture from notes" (Recommended), "Add someone by hand", "Upload your LinkedIn export", or "I'll add people later" | – | – | 1 click |
| 2a | "Capture from notes" | paste notes → "Extract people" | 1 text area | 5.6 s on the stub ("Reading your notes…", "This keeps going if you leave the page") | real latency unknown |
| 2b | Review cards ("1 of 2 · Datadog · Campus Recruiter") | "Keep this person" per card | none; fields prefilled, closeness 1–5 | – | 1 click per person (E07) |
| 2c | "Ready to save" | "Save 2 contacts + 2 reminders" | – | ~1 s | the summary explains the reminders: "2 action items will also become reminders due Oct 31. Follow-ups are timed by how close you said you are." (E08) |
| 2d | Triage, "How close are you?" | rate people 1–5 | – | – | only with 8 or more candidates [C] |
| 3 | Connect, "Bring in the people you email" | Connect Google/Microsoft or "Skip for now" | OAuth | redirect | not walked (no OAuth client) [C] |
| 4 | Overview, "Here's what Orbit can do" | 7 chapters: Previous/Next, "Skip to the dashboard", "Take the guided tour instead" | – | – | mock data (E02, E09) |
| 5 | Dashboard | – | – | – | E01 (empty) / E10 (after a capture) |

**Measured** [W]:
- **Nothing added:** 4 clicks (terms, Set up quickly, I'll add people later, Skip to the dashboard). Clicking through all 7 overview chapters takes 38 s. "Skip setup" in the header gets out in 2 clicks.
- **First capture:** 7 clicks plus 1 paste, 18 s to saved, 29 s to the dashboard (stub latency included). Outcome: 2 contacts, 2 reminders due in about 2 weeks, 1 credit spent (49/50 left).
- **Phone:** the same capture from /capture takes 5 taps plus typing.

**Guided tour** (`PATH_STAGES.tour`: welcome → connect → launch, then 11 in-app stops):

| # | Screen [W] | Action | Wait |
|---|---|---|---|
| 1 | Welcome | terms, "Start the tour" | – |
| 2 | Connect | skipped here | – |
| 3 | Launch, "Setting the stage" | none; six example people are seeded | ~5.5 s (3.6 s minimum hold) |
| 4–14 | Rail stops on the real pages: Dashboard → Contacts (search) → open a person → log an interaction → Capture (prefilled with a note about the **example** Priya) → review → Reminders → Chat → Constellation → Imports → "You're in orbit" | "Next" / "Skip this", or do the task | each page compiles and loads |
| 15 | Dashboard | examples removed | – |

**Measured:** skipping every stop takes 11 clicks and 50 s. The finish card reads "AI ready ✓, Google or Microsoft connected —, Logged an interaction —, Cleared a reminder —, Asked your network —" (E11). The user ends with **0 real contacts**, and the dashboard returns to "Your orbit is empty" with one checklist line, "Add your first people".

### 2.2 Entry paths

| Path | Steps to "inside the app" | Typed fields | Decisions | Lands on | Path-specific context | Evidence |
|---|---|---|---|---|---|---|
| **Invite email** (admin sends from `/admin/access` or the waitlist row) | Email "Now boarding: your Orbit pass" → **"Board Orbit"** → Clerk ticket redirect → bare Clerk `<SignUp>` card (no Orbit headline) → `/onboarding` → 2–4 onboarding screens → dashboard. About 6–8 screens. | email prefilled; password/name per Clerk config | Google or password; tour or quick | `/onboarding` | none (the `foundingEligible` flag is invisible) | [C] `src/lib/site-invites.ts:83-150`, `site-invite-email.ts:92-258` |
| **Invite, existing account** | Email "Sign in to Orbit" → `/sign-in` → dashboard | password | 0 | `/dashboard` | none | [C] |
| **Waitlist** | `/interest`: email → first and last name → "You're in line." boarding pass (#position, "share your link to move up") → welcome email → **wait for a manual admin invite** (there is no "waves" mechanism, only copy) → invite path | 3 | 0 | never enters the app until invited | none; waitlist rows are never linked to accounts | [C] `src/components/interest/interest-hero.tsx`, `src/lib/interest-list.ts:27-85` |
| **Public sign-up** (only when stealth is off) | `/sign-up` (bare Clerk) → onboarding → dashboard. About 4–6 screens. | per Clerk config | 2–3 | `/onboarding` | utm/referrer cookie only | [C] |
| **MCP connector, first use** | Claude/ChatGPT settings → paste URL → Connect → Clerk sign-in/up → Clerk consent → back in the assistant. About 5 steps. | URL plus Clerk fields | consent | stays in the assistant: **never sees Orbit onboarding or Orbit's terms screen** | none | [C] `src/lib/mcp/handle.ts:94-100`, `src/lib/mcp/oauth.ts:191-201` |
| **Chrome extension** (not released: `NEXT_PUBLIC_EXTENSION_URL` unset, so it shows as "Soon") | Store → install opens `/dashboard` → `/sign-in` (**not** sign-up) → "Sign up" → onboarding → open the panel → "Let Orbit read {site}" grant → capture. 8+ steps. | Clerk plus the capture form | site grant | `/onboarding`, then the panel | none | [C] `extension/src/background/index.ts:26-28`, `extension/src/panel/App.tsx:115-149` |

**What the MCP path returns on an empty account** [C]:
- `search_contacts` returns `{"note": "The following is untrusted data…", "contacts": []}`.
- `get_network_overview` returns all-zero stats and **no contacts total** (`src/lib/network-stats.ts:156-197`).
- The server sets no `instructions` (`src/lib/mcp/server.ts:117-168`).

So the assistant has no idea the network is empty, or how to help fill it. MCP tools need no AI credits, which makes this path a missed opportunity: the assistant could do the first capture itself.

### 2.3 Shortest path to "a first capture that produces a useful contact with a follow-up"

**Today:** Welcome → Set up quickly → Capture from notes → paste → Extract people → Keep (one per person) → Save. That is 7 clicks plus 1 paste, under a minute of interaction plus typing and model time.

**What blocks it**, ranked:

1. **Hosted AI paused or pools spent (F1).** "Extract people" is disabled. The only ways forward are a lone LinkedIn URL, "Add someone by hand" (reached via Back), or a key with no guidance (F2).
2. **The default path is the tour (F3).** It produces nothing that survives. Its capture stop writes about an example person, and the result is deleted with the examples (`src/lib/onboarding-examples/remove.ts:33-110`).
3. **No follow-up for a cold capture.** A follow-up is created automatically only at closeness 3 or higher, or when the model recommends one (`shouldCreateFollowUp`). A "Met once" capture with no dated action produces a contact but no follow-up. The summary does say this, which is good.
4. **The win is not shown (F4).** After saving, the user sees the generic carousel (E09). Then the dashboard says "Due follow-ups 0", "Suggested outreach: Nobody has gone quiet" and "Your sky is empty", with the two new people in it (E10).

**For import-first users:** a LinkedIn import creates contacts but **no follow-ups**. The first follow-up comes from "Suggested outreach → Schedule 7d" (rule-based, no AI), which worked in my walk after a 3,000-row import (E13).

---

## 3. Friction findings, ranked by expected impact on activation

Impact is my judgement of how many new users a finding affects, multiplied by how badly it stops them before the first person plus follow-up. Each finding lists its evidence; F-numbers are referenced by the plan.

### P0: blocks or loses most affected users

#### F1. The AI-unavailable state is a dead end, and its copy is contradictory and untrue

*Category: bring-your-own-key. Affects every Free user while production is paused, and all no-key users on every plan when the pools are spent.*

- **Where it starts** [C]:
  - Production defaults to paused (`src/lib/ai-access.ts:181`).
  - The pools are shared and global (`managed-ai-policy.ts:53-56`). When every held provider is spent, `managedAiPaused()` turns true for everyone (`ai-access.ts:257-262`).
  - Anthropic's pool refills on the 15th. OpenAI's needs a redeploy.
- **Capture and Chat** [W] (E03, E06):
  - "Orbit's AI isn't available right now — Included AI comes back on its own. To keep going now, add your own Gemini, OpenAI, or Anthropic key. Keys live under Settings → Integrations → AI provider."
  - "Comes back on its own" is false while the admin pause is indefinite, and a pool funded once (OpenAI) never refills.
- **Settings → AI in the same state** [W] (E04):
  - "AI credits — 50 of 50 monthly credits left · resets November 1 · 25 starter credits left", plus a "Buy a pack ($5)" button.
  - The Gemini card says "In use" next to "No key yet — paste one to turn on AI features".
  - A user can pay for credits they cannot spend; checkout has no pause check (`src/actions/billing.ts:146-175`) [C].
- **Several surfaces use a presence-only check** that ignores the pause, pools and credits [C]: `aiDenialFromSettings`, at `layout.tsx:158-159` and `dashboard-sections.tsx:142` (verified). With managed keys configured in production:
  - the dashboard checklist's "Add your AI key" item is silent;
  - the `ai.no_key` bell alert is silent;
  - the ask bar lets you type and fails after send;
  - the tour finish card shows **"AI ready ✓"** (E11 shows the tick);
  - the tour's capture stop asks for an Extract that is disabled.
- **Chat lets the user type and send, then refuses** [W] (E06): "Orbit's AI isn't available right now — add your own API key in Settings to keep going. This turn wasn't saved — your question is back in the box to try again." The refused turn is labelled "4 steps · 72ms".
- **Onboarding marks "Capture from notes" as Recommended regardless** (`people-step.tsx:15-21`) [C]. It leads straight to a disabled "Extract people". The manual form is a separate choice behind "Back".
- **Credits are never introduced to new sign-ups** [C]:
  - The credits intro only shows to accounts created before 2026-10-13 (`src/lib/credits-intro.ts:20`).
  - The overview says "Uses AI credits" without amounts (E02).
  - The only places a new user can learn they have 75 credits are Settings → AI and an ask-bar line at 3 or fewer.

*Why it matters:* capture and chat are the two activation moments. In this state a non-technical student meets a disabled button, a false promise, and a settings page that says they have credits.

#### F2. The bring-your-own-key fallback has no guidance

*Category: bring-your-own-key.*

- **Four equal provider cards** [W] (E04): Google Gemini, OpenAI, Anthropic, OpenRouter.
  - No recommendation.
  - No "how to get a key" link: `keyPageUrl` and `keyPageLabel` exist ("Create a key in Google AI Studio", `src/lib/ai-providers.ts:9-12`) but nothing renders them.
  - No steps, no screenshots, no cost or free-tier explanation.
  - Jargon on the same panel: "Decision model (optional)", "Custom model ID", "Cheapest / Balanced / Most accurate".
- **Validation is good once you have a key** [W] (E05). It makes a live, read-only call. A bad key shows inline: "Google Gemini didn't accept that key — check it and try again".
- **Gaps** [C]:
  - No check that the key belongs to the card's provider: an `sk-ant-` key pasted into OpenAI gets OpenAI's rejection.
  - A key with no balance passes, then the first real call fails with "{p} says your account is out of credit".
  - Saving on a card that isn't active **switches the account's provider** (`ai-settings.tsx:100-104`).
  - The notices name three providers; the UI offers four.
- **No re-surfacing** [C]. A user who never adds a key gets nothing later in production: no checklist item (F1's presence check), no alert, no email. The Settings overview shows "AI · Not on yet" only if they open it.

*Why it matters:* this is the only fallback when F1 hits. Creating a provider account and API key takes a non-technical student several minutes in another product, with no help from Orbit.

#### F3. The recommended onboarding path ends with no real person

*Category: onboarding, example data.*

- **Welcome marks "Guided tour" RECOMMENDED** [W] (E14). On a phone the alternative is below the fold.
- **The tour never asks for a real person** [W] (E11):
  - 11 stops on six example people, then "You're in orbit".
  - Its capture stop is prefilled with a note about the *example* Priya (`TOUR_EXAMPLE_NOTE`, `cast.ts:248`). Anything extracted is a "twin" that removal deletes [C].
  - Anything logged on an example person is deleted with it, and the finish card warns about that.
- **Hand-off to real data is a single checklist line**, "Add your first people", on an otherwise empty dashboard [W].
- **The "brought in with one click" promise** for Google/Outlook is OAuth, then "Import contacts", then "Import N selected" [C]. It is also invisible when no OAuth client is configured.
- **Partial-state bugs** [C]:
  - "Start the tour anyway" after a seed failure only navigates (`launch-step.tsx:94-99`).
  - A partial seed is never repaired (`seed.ts:43-47`).
  - The finish-card ticks are held in memory and lost on reload (`tour-finish-card.tsx:51-54`).

*Why it matters:* the default path costs one to three minutes and leaves the user exactly where they started.

#### F4. The first-run dashboard has no single next action, and buries the first win

*Category: empty states.*

- **Empty dashboard** [W] (E01). About 25 clickable targets and 10 distinct suggested actions, in this order:
  1. "Start your LinkedIn export" (a 24-hour wait)
  2. "Finish setting up" (AI key / first people / tour)
  3. "Your orbit is empty", with 3 buttons
  4. four zero stats
  5. "Your sky is empty"
  6. empty Suggested outreach, Reminders and Due follow-ups, the last with an active **"Generate follow-ups"** button (on an empty account it toasts "Everyone eligible already has a follow-up coming up" [C])
  7. Recently updated, with 3 more buttons
  8. Goals
  9. the Free plan card "Your first 500 contacts are on us… with AI included" plus "Compare plans"
- **On desktop at 1440×900** the floating "Ask your network…" bar sits over the empty state's "Import LinkedIn" and "Capture notes" buttons [W] (E01).
- **On a phone** [W] (E15): the first screen is the title, the LinkedIn chore, and the top of the checklist under the bottom nav. "Your orbit is empty" starts at y=855 in a 664px viewport.
- **Right after the first real capture** [W]:
  - The quick path goes to the seven-chapter carousel with mock "Sarah Chen" and "Priya Nair" (E09). There is no confirmation of what was just made.
  - The dashboard then shows:
    - "Due follow-ups 0" next to "Reminders 2", for the same two follow-ups;
    - "Strong ties 2 · Close 100%" after one career-fair conversation;
    - "Suggested outreach: Nobody has gone quiet. Log an interaction and Orbit will keep watching.";
    - "Your sky is empty" (E10).
  - Only the Reminders card ("Email resume · Met Priya · Due Sat, Oct 31 · Draft follow-up") shows the win.
- **Why the dashboard says "Your sky is empty" with people in it** (`src/lib/reminders.ts:1058-1072`) [W+C]: the preview draws a contact only when another contact shares its company or school. It also filters to the "engaged" scope. So it is empty after a first capture (two people, two companies) **and** after a 3,000-person import with no interactions (E13).
- **"Finish setting up" never clears for quick-path users** [W]: after a real capture it still says "One thing left: Take the guided tour".

*Why it matters:* the aha moment, "Orbit will remind me to email Priya on the 31st", happens but is not reflected back. And the most prominent next step is a chore that takes a day.

#### F5. Nothing brings a new user back, and abandoning onboarding disables the safety nets

*Category: dead ends, lifecycle.*

- **No lifecycle email exists for Free accounts** [C]:
  - no welcome (the Clerk `user.created` webhook sends nothing);
  - no day-2 or day-7 email;
  - no "your follow-up is due" email.
  - The only account emails are the credit notices, which skip Free and Lifetime (`src/lib/credits/notices.ts:286-291`).
  - The Radar Monday digest stands down while Radar is "coming soon".
- **Due follow-ups reach a user only** through the in-app bell, an OS notification while an Orbit tab is open and the user opted in, or an opt-in ICS calendar feed [C].
- **Abandoning onboarding**, reproduced on the phone walk [W]:
  - Opening `/onboarding` saves `onboarding_step="welcome"` on mount (`onboarding-flow.tsx:112-114`). After that `needsOnboarding` returns false forever (`onboarding.ts:47`), and `onboarding_completed_at` is never stamped.
  - Going to `/dashboard` (or returning later) shows the empty dashboard **without** the "Finish setting up" checklist, the LinkedIn card or the AI alert, all of which require `onboarding_completed_at`.
  - The only way back is Settings → Help → "Quick setup again". An abandoned Settings replay recreates the same state (`actions/onboarding.ts:104-108`).
- **The checklist dismissal lives in localStorage**, keyed per browser rather than per account (`orbit-setup-checklist-dismissed-v1`) [C].

*Why it matters:* job seekers come in bursts. A follow-up that never leaves the app does not get done, and a user who wandered off during setup gets no second invitation.

### P1: significant friction for a large group

#### F6. LinkedIn import versus the Free plan: silent truncation, a size cliff, and no follow-ups

*Category: imports, plan limits.*

- **The 500-contact cap is never mentioned before the import** [C]. The preview offers "Import 3000 selected" (`src/actions/imports.ts:225-301`). Rows past the cap are skipped in file order.
- **The completion toast never mentions the cap** (`completionMessage`, `src/lib/import-job-runner.ts`, verified). The user sees "Imported: 500 created, 0 updated".
- **The cap shows only on the done card**, "2,500 more are waiting on your plan", and on a history chip [C]. Nothing re-queues those rows after an upgrade, although copy says "upgrading brings in the rest" (`import-errors.ts:62`).
- **Each CSV must be at most about 4 MB after unzipping, with no chunked upload** (`capture-limits.ts:45,87`) [C]. Heavy LinkedIn users' `messages.csv` is refused, and the advice to "import … on its own … or split the file" does not help someone who already did that.
- **Imported connections create no follow-ups** [W] (E13). Closeness is generous: after importing 3,000 synthetic connections the dashboard read "Strong ties 2,230 · Warm 75%".
- **What works** [W] (E12):
  - Progress: "Import in progress · 0 of 3,000 people · 0% · Estimating…", then "You added 2970 people · Meet your 2970 new people · Undo".
  - Undo is available for 7 days.
  - Wrong-file messages are specific.
- **Smaller issues:**
  - [W] Two import controls showed different counts at once: the drop-zone queue said "Ready to import… 3000 of 3000 selected" while the row below still said "Import 0 selected".
  - [W] "30 people were already in your orbit" for duplicates *inside the file*, on an account that had no contacts.
  - [C] Reloading mid-import loses the live progress; only a badge remains.
  - [C] The generic failure toast is "That import didn't finish — try again?".
- **The export instructions tell users to request LinkedIn's full archive** ("Within a day LinkedIn emails you…"). LinkedIn's smaller, specific-files export may arrive much faster. To verify (plan X5).

#### F7. The MCP connector's first use skips onboarding and terms, and the assistant doesn't know the network is empty

*Category: entry path.* [C]

- **No Orbit welcome or terms.** A brand-new user signs up inside Clerk's OAuth and goes straight back to Claude or ChatGPT. Only Clerk's own legal checkbox applies, if enabled.
- **Empty results carry no hint.** Tools return empty arrays (see §2.2).
- **`/connect` never shows the connector URL.** It sends people to a settings page behind sign-in, and in stealth mode it redirects signed-out visitors to the waitlist (missing from `STEALTH_OPEN_PREFIXES`, `waitlist-host.ts:279-286`).
- **Possible broken OAuth return** [Clerk config, unverified]. If Clerk's sign-in URL is the app's `/sign-in`, its hard-coded `forceRedirectUrl="/dashboard"` may override the OAuth return (`sign-in/page.tsx:96-99`).
- **Held accounts loop.** The 401 carries `WWW-Authenticate`, so clients re-run OAuth forever (`handle.ts:142-152`).
- **The front door is buried.** The connector is promoted only in "What's ahead — More on the way" on the quick-path overview (`chapters.ts:163-172`).

#### F8. The invite and waitlist handoff leaves people stranded with no explanation

*Category: entry paths, dead ends.* [C]

- **The sign-up page is a bare Clerk card.** There is no "your seat is ready" framing after "Board Orbit".
- **Signing up with a different email than the invite gets no explanation.** No allowlist exists; admission is the invite marker on the Clerk account. A Google sign-up under another address is silently held and redirected to the waitlist, while signed in, on a page with no navigation or sign-out (`site-access.ts:181-227`, `layout.tsx:100`, `interest/page.tsx:47-56`). In the extension the same account is told it is "signed out".
- **Expired invites** (30 days) show Clerk's own error, with no Orbit recovery. The admin row reads "Expired" with no resend button.
- **Copy promises things that don't exist:**
  - The invite email pairs "Class: Free Plan" with "One seat, everything included".
  - The waitlist promises "waves" and referral perks ("you'll be invited early") that nothing in code honours.
- **Shared Wi-Fi drops real sign-ups.** More than 10 joins from one IP in 10 minutes returns a fake pass with no row (`interest-list-join.ts:128-137`). Campus and event Wi-Fi is exactly where students join.

#### F9. Naming and jargon are inconsistent for the core concepts

*Category: jargon.* [W+C]

| Concept | Names a new user meets |
|---|---|
| Capture | Nav "Capture"; primary sidebar button **"Log interaction"** (also to /capture); "Log a note", "Capture notes", "Add notes", "AI capture"; tabs "Messy Notes", "Notes Library"; button "Extract people" |
| Follow-up | Dashboard counts "Due follow-ups" and "Reminders" **separately** for the same items (E10); nav says "Reminders"; card says "Capture notes to create follow-ups"; "Generate follow-ups" |
| Network | "your orbit" (36 uses) vs "your network" (77) on the same pages: "Your network" eyebrow above "Your orbit is empty"; "Network tracker" under the logo |
| Constellation | Nav "Constellation", URL `/graph`, eyebrow "Star chart", empty "Your sky is empty". The explanation ("You are the sun…") is desktop-only |
| Closeness | "Closeness 73%", "Inner/Mid/Outer orbit", "Close/Warm/Cool", "Strong ties: Close + warm", "Health", "Your rating" |
| Quiet contacts | "Gone quiet", "Dormant", "drifting comets" |
| Knowledge | Nav "Knowledge", h1 "Knowledge base", Settings "Knowledge and help" |
| Drafts | Dashboard card "Waiting for you to send" / "Your assistant wrote this…" ("assistant" means an MCP agent, explained nowhere) |
| Credits | "AI credits", "included AI", "Orbit's credits", "AI included" (the Free card says "with AI included", implying Free has none) |

"Front wave" does not appear anywhere in the code or docs, so it has not leaked into the UI.

#### F10. Empty states that mislead or dead-end

*Category: empty states, dead ends.*

| Page | Zero-data state [W unless noted] | Problem |
|---|---|---|
| Contacts | "0 people in your network · No contacts match these filters. Clear search to see everyone, or capture notes / import LinkedIn." | Reads as a filter problem; no filters are active. A "Refresh" (LinkedIn) button and the filter bar render on an empty list |
| Reminders | "Nothing due today · You're clear. Upcoming has what's next." | False when nothing exists; no create action in the body |
| Chat | Suggestions "Who should I reconnect with this week?" / "Who have I not followed up with recently?" | Unanswerable with 0 contacts; no "add people first" prompt; send allowed while AI can't run (F1) |
| Constellation (phone) | Dark canvas, the user's sun, "Clusters 0", a red **"Re-engage"** button, no copy (E17) | No empty state on the mobile renderer (`graph-canvas-mobile.tsx:496-570`) |
| Constellation (desktop) | "Showing 0 of 0 — the people you have engaged with. Show all 0 connections." then "Your sky is empty · Add a contact" | Awkward count line; the empty state itself is fine |
| Knowledge | "No one is in your orbit yet · Import LinkedIn / Log a note" | LinkedIn (a 24 h wait) is the primary action |
| Imports | 9 options plus the LinkedIn card first | No recommended first import |
| Meetings / Recruiters (Free) | Paywall [C] | Live in the nav with no Pro tag; the Recruiters paywall has no way back to Contacts |
| contacts/new | 21 fields, 1 required, no Cancel | Long for "quick manual entry" |
| 404 inside the app | Marketing 404, "Back to home" goes to the landing page [C] | Ejects the user from the app shell |
| Coming soon (Radar, Find, Events, Outreach) | "Back to dashboard" | Fine, but 4 of the 14 nav items are "Soon" and the command palette lists them [C] |

### P2: moderate friction

#### F11. Upgrade prompts in the first session

*Category: plan limits.*

- **The Free plan card is always on the first dashboard** [W]: "Your first 500 contacts are on us. Past that, Orbit Pro keeps every contact, follow-up, and warm intro in one place — with AI included." It sells before any value, and the copy is stale now that Free includes AI.
- **Paywalls reachable in session one** [C]: Meetings (nav), the Capture "Meeting" tab, the Recruiters toggle, and the Imports "Calendar sync" card, which the tour's Imports stop shows. None of them is recorded in `gate_events`.
- **Credit purchase UI shown when it can't help** [C]:
  - "Buy a pack ($5)" and the credits card show while AI is paused (F1).
  - The "Email me when I've used 80%…" toggle shows to Free accounts, which never get those emails (`credits-card.tsx:193`).

#### F12. Permission and consent prompts arrive without a reason

*Category: consent.* [C]

- **Webcam:** desktop scan opens `getUserMedia` the moment the dialog opens, with no explanation (`scan-camera.tsx:56-86`). On a phone it uses `<input capture>`, which is fine on iOS.
- **Microphone:** voice notes have no pre-explanation ("Hold to talk, or tap to start" → browser prompt). The denial copy is clear.
- **Desktop notifications:** permission is requested automatically right after the first "Follow up in Nd" (`easy-follow-up.tsx:86` → `browser-notifications.ts:306-310`). There is no explanation; Safari may refuse it after two awaits; and it re-enables the account-wide preference on every schedule.
- **Google and Microsoft:**
  - **Good:** the Settings account page pre-prompt ("Orbit will ask to: See your contacts, See your calendar… It never changes, sends or deletes anything").
  - **Missing:** the /imports cards and the Overview card redirect with almost no explanation, and the Overview names Gmail, which Connect doesn't request.
- **Scope denial** (`api/gmail/callback/route.ts:92-136`):
  - Saved as connected even when every scope is denied. The row shows ✓ "Connected" beside "Google didn't grant contacts access".
  - The checklist item disappears.
  - It counts as the Free plan's one connection.
- **The onboarding Connect step says** "Orbit never sends email from your account", which contradicts Orbit's Gmail send feature.
- **A Free user's second connection** is refused with a "Try again" that repeats the refusal (`connect-step.tsx:145,184-188`).

#### F13. Mobile in the first session

*Category: mobile.*

- [W] **Settings is missing from the phone nav** (E16). It is reachable only through Search → "Go to Settings".
- [W] **The Quick setup card is below the fold** on the welcome screen (E14).
- [W] **The LinkedIn card owns the first dashboard screen** (E15).
- [W] **The capture review's "2 people ready to review" toast covers the Name field** (E18).
- [W] **The tour rail takes about half the screen** (E19). It is usable.
- [C] **The phone's Capture button opens Voice, not notes** (`mobile-capture-button.tsx:51`). Voice then needs a microphone prompt before the user gets any value.
- [C] **Smaller issues:** "Choose a folder" shows on iOS; chat-history delete is hover-only; the dashboard hard-codes ⌘.
- **Slow connection** [W, dev build]:
  - Server-rendered headings and the capture form appear early on a throttled phone (E-slow, not committed). There is no blank screen.
  - Every main route has a `loading.tsx` skeleton.
  - The offline error state is friendly.
  - Full hydration on throttled dev bundles took 15–36 s; production bundles are smaller and were not measured (§8).

#### F14. Onboarding mechanics bugs

*Category: dead ends.* [C unless marked]

- **Terms asked twice** (unverified: needs Clerk without its consent checkbox). The shell's "We've updated our Terms and Privacy Policy" banner renders on `/onboarding` for a brand-new account, beside the welcome checkbox. It stays after the checkbox is ticked (`layout.tsx:118-122,214`, `src/lib/legal.ts:126-140`).
- **The import side-screen's "Skip for now" goes back** to People, not forward (`onboarding-flow.tsx:348`).
- **The slide animation runs backwards** from People to Connect (`onboarding-steps.ts:13-25`).
- **No error handling.** `choosePath`, `leave` and `switchToTour` have no try/catch, so a failed action lands on the error boundary.
- **A stale tab can reopen onboarding** on a completed account (`saveOnboardingStep` doesn't check completion).

#### F15. LinkedIn export guidance and the wait

*Category: imports.*

- **The export is pushed in two places.** It left onboarding (good, Sprint B), but now leads the dashboard and /imports.
- **It needs a separate 24-hour return trip:**
  - The full-screen reminder fires once, 24 h–14 d after sign-up [C].
  - The card's "I've requested it" state reads "Your export should be ready about {date}".
  - Neither reaches the user by email (F5).

#### F16. No product instrumentation

*Category: measurement.* [C]

- **No product event exists.** There are no `track()` calls, no events table and no tracking plan in `docs/`. Funnels are rebuilt from current table state, and onboarding steps leave only the latest `onboarding_step`.
- **"Activated" is defined loosely:** `onboarding_completed_at IS NOT NULL OR` any real contact `OR` any import (`src/lib/admin-analytics.ts:641-644`). Pressing "Skip setup" counts as activated.
- **The admin `/admin` overview counts the tour's example contacts and interactions** (`src/lib/admin-metrics.ts:180-196`).
- **`aiWillRun` false alarms.** It treats every Free account as unable to run AI, so the admin console warns "No gemini key configured" for every Free account (`admin-metrics.ts:462,503`).
- **Gaps:** OAuth denials are logged without a user id, and capture jobs are pruned after 30 days. The first-capture signal therefore decays.

### P3: low impact, or not first-run

- **F17. "Delete all data" (keeping the account) zeroes credits until the next period.** It anonymises `credit_grants` while their `grant_key` values stay taken, so neither the starter grant nor the allowance can be re-issued, and bought packs are revoked. It also resets onboarding (`src/lib/user-data.ts:885-907`, `credits/ledger.ts:157,216`) [C]. DEVELOPMENT.md recommends this action for resetting a local account.
- **F18. Docs drift from the code** [W]:
  - `.env.example:48-71` says "Managed AI is switched off in code" and "every Lifetime account".
  - `docs/DEVELOPMENT.md`'s demo path starts with "Settings → add an AI API key".
  - The Sprint B spec says 10 monthly credits; the code has 50.
  - Stale comments cite a deleted `wizard-ai-key.tsx`.
- **F19. Tour example avatars 404 locally** (`/api/avatars/<id>`, six per tour) [W]. Possibly local-only.

---

## 4. Edge cases

| Scenario | What happens | Evidence | Severity |
|---|---|---|---|
| **Returning user who abandoned onboarding** | Never redirected back. Lands on an empty dashboard with no checklist, LinkedIn card or AI alert, permanently (F5). `/onboarding` resumes the exact screen if they find it. | [W] phone walk; `onboarding.ts:47` | High |
| **User who skips everything** | No skip on the welcome screen, so they must choose a path first. Then "Skip setup" gives 2 clicks to an empty dashboard with the checklist (Connect, Add your first people, Take the tour; an AI item only if the presence check fails). | [W] [C] | Medium |
| **Signs up with a different email than the invite** | No allowlist; the new account has no invite marker. With stealth on it is held: silently redirected to the waitlist while signed in, no explanation, no sign-out; the extension says "signed out"; MCP loops on OAuth. The fix is an admin re-invite of that address. | [C] `site-access.ts:139-227` | High for invitees |
| **Invite expires** (30 days) | Clerk's own error on the bare sign-up card. The admin sees "Expired" with no resend button. | [C] `site-invites.ts:42` | Medium |
| **Wrong or comped plan** | Invitees start on Free (founding discount only, invisible). Comps never expire; a comped Pro user cannot buy Max ("There's no subscription on this account to manage"). A missed Stripe webhook is covered for 24 h by checkout confirmation; the admin alert copy still says "Clerk". Onboarding shows nothing plan-specific. | [C] `entitlements.ts:152-154`, `actions/billing.ts:48` | Low |
| **Connects an integration but denies scopes** | The connection is saved *before* the scope check. Partial denial = "connected" with a later "Allow"; full denial = "Google didn't grant contacts access — reconnect and allow it" while the row shows ✓ "Connected" and "Choose who to add". The checklist item disappears. It consumes the Free plan's single connection, so a later Microsoft connect is refused with `plan_limit`. /imports returns are silent until the matching row is opened. | [C] `api/gmail/callback/route.ts:92-136`, `onboarding-connect.ts:20` | Medium |
| **Imports before AI is available** | CSV and vCard imports are deterministic and complete. AI follow-on work (embeddings, relationship engine) pauses silently as `waiting_key`, which no UI shows. On hosted credits, background work stops at 50% of the monthly allowance and never touches starter credits. Search falls back to keywords. | [C] `relationship-engine/runner.ts:~203`, `managed-ai-policy.ts:188`; [W] 3,000-row import with hosted AI | Low–Medium |
| **Onboarding state conflicts across devices or tabs** | Step and path are server-side, so consistent; last write wins. A stale tab can set a step on a completed account and reopen onboarding. Checklist and LinkedIn-card dismissals are per-browser localStorage (the checklist key is also shared across accounts on that browser). Tour progress ticks are memory-only. | [C] `actions/onboarding.ts:52`, `tour-runtime.tsx:88` | Low |
| **User deletes the example people** | On exit or finish they're removed automatically, along with anything logged on them (warned). Deleting them one by one stalls tour stops ("Priya isn't in this list. Clear the search to find her.") and leaves orphaned example companies until a later removal. Chat threads from the tour keep evidence links to deleted contacts. After the tour, the dashboard returns cleanly to its empty state. | [W] post-tour dashboard; [C] `remove.ts:33-110` | Low–Medium |
| **MCP-first user later opens the web app** | If they created a contact via MCP, `needsOnboarding` is false: no welcome and no first-run guidance. Terms appear only as the shell banner. | [C] `onboarding.ts:45-84` | Medium |
| **Delete all data, then start over** | Onboarding restarts; credits are zero until next month (F17). | [C] | Low |
| **Deletes the account and signs up again with the same email** | A new Clerk id, so onboarding restarts and a fresh 25 starter credits are granted. Nothing prevents starter-credit farming per email. Sign-up has no BotID (only the waitlist does). | [C] `ledger.ts:115-120` | Cost risk |

---

## 5. Current instrumentation, in brief

Detail and the proposed events are in the plan, §5.

| Exists | Use for onboarding |
|---|---|
| `page_views` (first-party beacon via `/api/track`, cookieless, needs `ANALYTICS_SALT`) | Route-level only. Onboarding steps don't change the URL, so every step reads as `/onboarding` |
| `usage_events` (one row per AI call, 180 days) | Proxy for first capture (`capture.parse`), chat, drafts |
| `gate_events` (paywall refusals via `requireEntitlement`) | Misses page-level `LockedFeature` paywalls |
| `user_settings` "last state" columns (`onboarding_step`, `onboarding_path`, `wizard_offered_at`, `wizard_completed_at`, `tour_*`, `linkedin_export_requested_at`, `credits_intro_shown_at`, `terms_accepted_at`, `signup_*`) | Snapshot only; no history; restarting the tour overwrites `tour_started_at` |
| `feedback` (user-initiated "Send feedback"; `pmf` and `churn_reason` kinds exist but nothing writes them) | Usable for an end-of-session prompt |
| Tour events (`src/lib/tour/tour-events.ts`) | In-memory only, never persisted |
| Admin funnels (`/admin/analytics/funnel`, `/admin` overview, growth trends) | Rest on the loose "activated" rule (F16) |

---

## 6. What already works

- **Sprint B removed the hardest first-run wall in code.**
  - Hosted credits on Free.
  - The AI-key and LinkedIn steps left onboarding.
  - Quick setup is people-first.
  - When hosted AI runs, a new user can capture without ever seeing the word "key" (E07, E08).
- **Capture checks AI before the user invests effort** [W] (E03).
  - "Extract people" is disabled with the notice above it.
  - A lone LinkedIn URL still logs a person ("Look up profile").
  - The other surfaces should copy this pattern.
- **The capture review is strong** [W] (E07, E08, E18):
  - one card per person, editable fields, closeness 1–5;
  - keyboard and swipe;
  - an explicit "Save 2 contacts + 2 reminders" with the reason for the reminders;
  - "Saving…" from the click;
  - extraction keeps running if you leave the page;
  - it works on a phone, with docked actions.
- **Key validation is live and specific** [W] (E05): a read-only probe, an inline rejection message, and an honest "Saved — {Label} didn't answer, so the key isn't checked yet" on network failure [C].
- **Onboarding state is server-side.** It resumes the exact screen, including an open capture review, across devices [C].
- **The tour runs on the real pages** with clearly marked "Example" people [W], an exit confirmation, resume from the checklist or Settings, and automatic cleanup [C].
- **The import engine is robust** [W] (E12): background chunks, progress with a count and ETA, "Imports keep running if you leave this page", 7-day undo with an honest warning, and precise wrong-file messages [C].
- **The Settings pre-prompt for Google and Microsoft is a good model** [C]: it says exactly what Orbit will ask for and what it will never do. Scopes are incremental, per feature.
- **Mobile foundations** [W]: a dedicated bottom nav, a Canvas2D constellation on phones, docked review actions, and `<input capture>` for cards on iOS.
- **Resilient loading** [W]: server-rendered content arrives early on a throttled phone; every main route has a skeleton; there's a friendly offline fallback.
- **Trust signals are consistent.** Every import is undoable, nothing sends without approval, and "Hitting a limit only stops you adding new contacts. Orbit never hides or deletes your data" holds in code (`ContactQuotaNotice`) [C].
- **"Coming soon" pages have a way back** ("Back to dashboard") [W].

---

## 7. Evidence index

Screenshots are in `onboarding/evidence/`. All are fresh local test accounts with synthetic data. The round "N" in the bottom-left corner is the Next.js dev badge, not product UI.

| ID | File | Shows |
|---|---|---|
| E01 | `01-desktop-empty-dashboard.jpg` | Empty dashboard: LinkedIn card first, checklist, the ask bar covering the empty-state buttons |
| E02 | `02-desktop-quick-setup-overview-carousel.jpg` | Overview carousel with "Uses AI credits" tags |
| E03 | `03-desktop-capture-ai-unavailable.jpg` | Capture: "Orbit's AI isn't available right now… comes back on its own", Extract disabled |
| E04 | `04-desktop-ai-settings-says-credits-available.jpg` | Same state: "50 of 50 monthly credits left", Gemini "In use / No key yet", Buy a pack |
| E05 | `05-desktop-key-rejected-inline.jpg` | Inline key rejection |
| E06 | `06-desktop-chat-sent-then-refused.jpg` | Chat accepts a question, then refuses |
| E07 | `07-desktop-capture-review-card.jpg` | Review card (the "Met Priya" name is an artifact of my stub, not the product) |
| E08 | `08-desktop-capture-ready-to-save.jpg` | "Save 2 contacts + 2 reminders", with the follow-up explanation |
| E09 | `09-desktop-after-first-save-generic-carousel.jpg` | What follows the first save: a mock-data carousel |
| E10 | `10-desktop-dashboard-after-first-capture.jpg` | "Due follow-ups 0" next to "Reminders 2", "Strong ties 2", and further down the page "Your sky is empty" |
| E11 | `11-desktop-tour-finish-zero-real-people.jpg` | Tour finish: "AI ready ✓", four "not yet" |
| E12 | `12-desktop-import-progress.jpg` | 3,000-row import progress and done card |
| E13 | `13-desktop-dashboard-after-3000-import.jpg` | "Strong ties 2,230", "Schedule 7d" suggestions, "Your sky is empty" |
| E14 | `14-phone-welcome.jpg` | Phone welcome: tour recommended, Quick setup below the fold |
| E15 | `15-phone-empty-dashboard-above-fold.jpg` | Phone first screen: the LinkedIn chore |
| E16 | `16-phone-more-sheet-no-settings.jpg` | Phone "More" sheet without Settings |
| E17 | `17-phone-constellation-empty.jpg` | Phone constellation with no empty state |
| E18 | `18-phone-capture-review.jpg` | Phone review, the toast over the Name field |
| E19 | `19-phone-tour-rail.jpg` | Phone tour rail |

---

## 8. What I could not verify

- **Production AI state.** Whether `site_settings.managed_ai_paused` is false, which managed keys are set, current pool spend, and real latency and cost on Claude Haiku 5.5. My cost numbers come from `docs/ai-evals` (measured on Gemini) and the pricing table, not from Haiku traffic.
- **Clerk-hosted UI and its settings:**
  - sign-up fields and social providers;
  - whether Clerk's legal-consent checkbox is on (which decides whether the welcome checkbox and the "We've updated…" banner both appear);
  - the configured sign-in URL (which decides whether the MCP OAuth return works);
  - the expired-ticket screen.
- **Invite email rendering and delivery** through Resend.
- **Google and Microsoft OAuth.** No client was configured locally, so the onboarding Connect step was skipped in every walk. Scope-denial behaviour is code-traced only.
- **Free-plan gates.** Localhost lifts plan limits for every account, so the 500-contact cap during import, the Meetings and Recruiters paywalls, and the second-connection refusal are code-traced only.
- **A reload during a large import.** My 3,000-row import finished locally in under 15 s (PGlite, no network), so I couldn't watch a reload mid-run. Production will be slower.
- **A real LinkedIn export:** real file sizes (the 4 MB cap), real timing of LinkedIn's emails, and whether the smaller "specific files" export arrives in minutes.
- **The Chrome extension** (not built or loaded) and **a real Claude or ChatGPT MCP client.**
- **OS-level camera, microphone and notification prompts.** Headless Chromium doesn't show them; the behaviour is code-traced.
- **Production bundle performance on slow connections.** A production build can't sign in without Clerk keys unless application code is edited, which this phase rules out. The slow-connection observations come from dev bundles.
- **Email deliverability and lifecycle timing.** No account emails exist to test.
- **Real users.** No sessions, recordings or funnel data. With no product events, there is no baseline for any rate in this report.
